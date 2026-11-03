// SPDX-License-Identifier: GPL-3.0-or-later
// Glass everywhere: the top bar, the dock, every popup menu (quick settings,
// calendar, app and context menus) and the overview backdrop get Super G
// glass (lib/glass.js). Replaces the Blur my Shell engine for all of these.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Module} from '../lib/module.js';
import * as Files from '../lib/files.js';
import {resolve} from '../lib/themeGen.js';
import {GlassLayer, glassStyle, wrapWithGlass, unwrap, trackPaintingView, untrackPaintingView} from '../lib/glass.js';

// A title button with nothing to title (no focused window) keeps its place.
function isBlank(actor) {
    const labels = [];
    const walk = a => a.get_children().forEach(child => {
        if (child instanceof St.Label)
            labels.push(child);
        walk(child);
    });
    walk(actor);
    return labels.length > 0 && labels.every(label => !label.text?.trim() || !label.visible);
}

// More than magnification can stretch the dock, at any setting.
const DOCK_REACH = 420;

// The union of some top bar buttons, for a glass layer to follow.
class Island {
    constructor(actors) {
        this._actors = actors;
        this.opacity = 255;
    }

    update() {
        // The app name fades out rather than hiding when no app is focused.
        const shown = this._actors.filter(a => a.mapped && a.width > 0 && a.opacity > 0 && !isBlank(a));
        this.mapped = shown.length > 0;
        this._x1 = this._y1 = Infinity;
        this._x2 = this._y2 = -Infinity;
        for (const actor of shown) {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            this._x1 = Math.min(this._x1, x);
            this._y1 = Math.min(this._y1, y);
            this._x2 = Math.max(this._x2, x + w);
            this._y2 = Math.max(this._y2, y + h);
        }
        return true;
    }

    get_transformed_position() {
        return this.mapped ? [this._x1, this._y1] : [0, 0];
    }

    get_transformed_size() {
        return this.mapped ? [this._x2 - this._x1, this._y2 - this._y1] : [1, 1];
    }
}

// Each item on the bar is an island, except the small ones between the status
// area and the app name (tray icons, keyboard), which share one.
function panelIslands() {
    const {quickSettings, dateMenu} = Main.panel.statusArea;
    const apart = [quickSettings?.container, dateMenu?.container];
    const islands = [];
    for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
        let run = null;
        for (const container of box.get_children()) {
            const button = container.get_first_child?.();
            if (!button)
                continue;
            if (box === Main.panel._rightBox && !apart.includes(container)) {
                if (!run)
                    islands.push(run = []);
                run.push(button);
            } else {
                run = null;
                islands.push([button]);
            }
        }
    }
    return islands;
}

export default class GlassModule extends Module {
    static needsDock = true;

    enable() {
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._tokens = JSON.parse(Files.readText(`${this.ext.path}/tokens.json`));
        this._menus = new Map();
        this._docks = new Map();
        this._style = this._computeStyle();

        this.connect(this._iface, 'changed::color-scheme', () => this._restyle());
        this.connect(this.settings, 'changed', () => this.later('glass-style', 120, () => this._restyle()));

        // Menus are built by GNOME and other modules at any time; give each
        // one glass the first time it opens.
        const proto = PopupMenu.PopupMenu.prototype;
        this._origOpen = proto.open;
        const self = this;
        proto.open = function (...args) {
            self.guard(() => self._ensureMenu(this));
            return self._origOpen.call(this, ...args);
        };
        // Not everything comes through there (Kiwi keeps its own reference to
        // the app menu's open); every menu does end up opening a BoxPointer.
        const pointerProto = BoxPointer.BoxPointer.prototype;
        this._origPointerOpen = pointerProto.open;
        pointerProto.open = function (...args) {
            self.guard(() => self._ensureBox(this));
            return self._origPointerOpen.call(this, ...args);
        };

        this._panelGlass = new GlassLayer({style: this._style, shapeSource: Main.panel, track: Main.panel, smoothing: 0, shadow: false, guard: 0});
        Main.layoutManager.uiGroup.insert_child_below(this._panelGlass, Main.layoutManager.panelBox);
        this._islands = [];
        this._syncPanelGlass();
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
            this.connect(box, 'child-added', () => this.later('islands', 100, () => this._syncPanelGlass()));
            this.connect(box, 'child-removed', () => this.later('islands', 100, () => this._syncPanelGlass()));
        }

        // App folders: a dialog per folder, built on first open.
        this._folders = new Map();
        const folderProto = AppDisplay.AppFolderDialog.prototype;
        this._origPopup = folderProto.popup;
        folderProto.popup = function (...args) {
            self.guard(() => self._ensureFolder(this));
            return self._origPopup.call(this, ...args);
        };

        this.connect(Main.overview, 'showing', () => this._overviewIn());
        this.connect(Main.overview, 'hidden', () => this._overviewOut());

        this._attachDocks();
        this.attachLauncher();
    }

    // Superbar's surface is glass too. Either of the two modules can start last.
    attachLauncher() {
        const material = this.ext._active?.get('launcher')?.instance?._materialLayer;
        if (!material || this._launcherGlass)
            return;
        material.style = 'background-color: transparent; background-image: none; border: none; box-shadow: none;';
        this._launcherGlass = new GlassLayer({style: this._style, shapeSource: material});
        material.insert_child_at_index(this._launcherGlass, 0);
        this._launcherGlass.add_constraint(new Clutter.BindConstraint({
            source: material, coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._launcherGlass.connect('destroy', () => (this._launcherGlass = null));
    }

    disable() {
        this.cleanup();
        if (this._origOpen)
            PopupMenu.PopupMenu.prototype.open = this._origOpen;
        this._origOpen = null;
        if (this._origPointerOpen)
            BoxPointer.BoxPointer.prototype.open = this._origPointerOpen;
        this._origPointerOpen = null;
        for (const entry of this._menus.values())
            unwrap(entry);
        this._menus.clear();
        for (const glass of this._docks.values())
            glass.destroy();
        this._docks.clear();
        if (this._origPopup)
            AppDisplay.AppFolderDialog.prototype.popup = this._origPopup;
        this._origPopup = null;
        for (const glass of this._folders.values())
            glass.destroy();
        this._folders.clear();
        if (this._dockReadyId)
            this._dockExt?.dockManager?.disconnect(this._dockReadyId);
        this._panelGlass?.destroy();
        this._panelGlass = null;
        this._launcherGlass?.destroy();
        this._islands.forEach(glass => glass.destroy());
        this._islands = [];
        this._overviewOut(true);
    }

    _computeStyle() {
        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        const c = resolve(this._tokens, {
            palette: this.settings.get_string('palette'), accent: this.settings.get_string('accent'),
        }, dark);
        return glassStyle(c, this.settings);
    }

    _restyle() {
        this._style = this._computeStyle();
        const all = [this._panelGlass, this._launcherGlass, ...this._islands, ...this._folders.values(), ...[...this._menus.values()].map(e => e.glass),
            ...this._docks.values(), ...(this._overview ?? [])];
        for (const glass of all.filter(Boolean))
            glass.setStyle(this._style);
        this._syncPanelGlass();
    }

    /* -------------------------------------------------------- top bar -- */

    // Islands style: no bar to speak of, each island is its own piece of glass.
    _syncPanelGlass() {
        const on = this.settings.get_boolean('panel-glass');
        const islands = this.settings.get_string('panel-style') === 'islands';
        if (this._panelGlass) {
            this._panelGlass.active = on && !islands;
            // Edge to edge, a rim would draw a box around the screen's top.
            const flush = this.settings.get_string('panel-style') === 'adaptive';
            this._panelGlass.setStyle(flush ? {...this._style, rim: 0, outline: 0} : this._style);
        }
        this._islands.forEach(glass => glass.destroy());
        this._islands = [];
        if (!on || !islands)
            return;
        for (const group of panelIslands()) {
            const glass = new GlassLayer({style: this._style, radius: 999, track: new Island(group),
                smoothing: 0, shadow: false, guard: 0});
            Main.layoutManager.uiGroup.insert_child_below(glass, Main.layoutManager.panelBox);
            this._islands.push(glass);
        }
    }

    // The dialog zooms out of the folder's icon, so its glass follows the box
    // on screen rather than sitting inside it.
    _ensureFolder(dialog) {
        if (this._folders.has(dialog))
            return;
        const box = dialog._viewBox;
        const glass = new GlassLayer({style: this._style, shapeSource: box, track: box, smoothing: 0.5});
        dialog.get_parent().insert_child_below(glass, dialog);
        this._folders.set(dialog, glass);
        // GNOME's dim is the dialog's own background colour, eased when it opens,
        // and would lie over the glass; ours goes under, a soft wash of the theme.
        dialog.ease = params => {
            const {background_color: _shade, ...rest} = params;
            return Clutter.Actor.prototype.ease.call(dialog, rest);
        };
        const monitor = Main.layoutManager.primaryMonitor;
        const wash = new St.Widget({x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, opacity: 0,
            style: `background-color: ${this._style.lightText ? 'rgba(0,0,0,0.38)' : 'rgba(255,255,255,0.28)'};`});
        dialog.get_parent().insert_child_below(wash, glass);
        const show = open => wash.ease({opacity: open ? 255 : 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        show(true);
        dialog.connect('open-state-changed', (_d, open) => show(open));
        dialog.connect('destroy', () => {
            this._folders.delete(dialog);
            glass.destroy();
            wash.destroy();
        });
    }

    _ensureBox(box) {
        if (this._menus.has(box) || !box.bin)
            return;
        // Menus only, not other things that point at something.
        if (!box.bin.get_child()?.has_style_class_name?.('popup-menu-content'))
            return;
        const entry = wrapWithGlass(box.bin, this._style);
        if (!entry)
            return;
        this._menus.set(box, entry);
        box.connect('destroy', () => this._menus.delete(box));
    }

    _ensureMenu(menu) {
        if (menu._boxPointer)
            this._ensureBox(menu._boxPointer);
        // Quick settings dims itself behind a submenu; full strength turns glass
        // to dull grey.
        if (menu._setDimmed && menu._dimEffect) {
            menu._setDimmed = dim => {
                const val = 127 * (dim ? 0.86 : 1);
                menu._boxPointer.ease_property('@effects.dim.brightness',
                    new Cogl.Color({red: val, green: val, blue: val, alpha: 255}), {
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD, duration: 200,
                        onStopped: () => (menu._dimEffect.enabled = dim),
                    });
                menu._dimEffect.enabled = true;
            };
        }
        menu.connect('destroy', () => this._menus.delete(menu));
    }

    /* ----------------------------------------------------------- dock -- */

    async _attachDocks() {
        const dockModule = this.ext._active?.get('dock');
        const path = dockModule?.instance?.path;
        if (!path)
            return;
        this._dockExt = await import(`file://${path}/extension.js`);
        const attach = () => {
            for (const glass of this._docks.values())
                glass.destroy();
            this._docks.clear();
            for (const dock of this._dockExt.dockManager?._allDocks ?? []) {
                const bg = dock.dash?._background;
                if (!bg)
                    continue;
                const glass = new GlassLayer({style: this._style, shapeSource: bg, smoothing: 0.25, guard: 0.35,
                    reach: {left: DOCK_REACH, right: DOCK_REACH, top: DOCK_REACH, bottom: DOCK_REACH}});
                bg.insert_child_at_index(glass, 0);
                glass.add_constraint(new Clutter.BindConstraint({
                    source: bg, coordinate: Clutter.BindCoordinate.SIZE,
                }));
                // The magnifier stretches the surface with the row of icons.
                bg._glassLayer = glass;
                glass.connect('destroy', () => delete bg._glassLayer);
                glass.connect('destroy', () => {
                    if (this._docks.get(dock) === glass)
                        this._docks.delete(dock);
                });
                this._docks.set(dock, glass);
            }
        };
        this._dockReadyId = this._dockExt.dockManager?.connect('docks-ready', () => this.guard(attach));
        attach();
    }

    /* ------------------------------------------------------- overview -- */

    _overviewIn() {
        if (this._overview || !this.settings.get_boolean('glass-overview'))
            return;
        const style = {...this._style, rim: 0, outline: 0, grain: 0.008, blur: Math.max(this._style.blur, 60)};
        this._overview = Main.layoutManager.monitors.map(m => {
            const glass = new GlassLayer({style, radius: 0, smoothing: 0, live: false});
            glass.set_position(m.x, m.y);
            glass.set_size(m.width, m.height);
            glass.opacity = 0;
            Main.layoutManager.overviewGroup.insert_child_at_index(glass, 0);
            glass.ease({opacity: 255, duration: 250});
            return glass;
        });
    }

    _overviewOut(now = false) {
        for (const glass of this._overview ?? []) {
            if (now)
                glass.destroy();
            else
                glass.ease({opacity: 0, duration: 200, onComplete: () => glass.destroy()});
        }
        this._overview = null;
    }
}
