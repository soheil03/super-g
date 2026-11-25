// SPDX-License-Identifier: GPL-3.0-or-later
// Glass everywhere: the top bar, the dock, every popup menu (quick settings,
// calendar, app and context menus), dialogs, notifications, the switchers, the
// OSD and the overview backdrop get Super G glass (lib/glass.js). Replaces the
// Blur my Shell engine for all of these.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as OsdWindow from 'resource:///org/gnome/shell/ui/osdWindow.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import {Module} from '../lib/module.js';
import * as Files from '../lib/files.js';
import {resolve, LIGHT_CLASS} from '../lib/themeGen.js';
import {backdropLuma, warmBackdrop} from '../lib/backdrop.js';
import {GlassLayer, glassStyle, shellDark, adaptiveTone, darkGlassFace, wrapWithGlass, unwrap, trackPaintingView, untrackPaintingView, barOverFullscreen} from '../lib/glass.js';

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
const ISLAND_CHECK_MS = 100;
const PREWRAP_MS = 2000;
// The app grid behind an open folder: how far it blurs, and how fast.
const FOLDER_BLUR = 'super-g-folder-backdrop';
const FOLDER_BLUR_RADIUS = 28;
const FOLDER_BLUR_MS = 220;
// Adaptive tone: a surface turns light glass where white text on dark glass
// would fall under this contrast, and back once it clears the second.
const LIGHT_BELOW = 3;
const DARK_ABOVE = 3.6;
const BANNER_SETTLE_MS = 50;
const CLEAR_SURFACE = 'background-color: transparent; background-image: none; border: none; box-shadow: none;';

// The union of some top bar buttons, for a glass layer to follow.
class Island {
    constructor(actors) {
        this._actors = actors;
        this.opacity = 255;
    }

    update() {
        // Walking the buttons each frame adds up; they barely move.
        const now = Date.now();
        if (now - (this._checkedAt ?? 0) < ISLAND_CHECK_MS)
            return true;
        this._checkedAt = now;
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

// BoxPointer opens from 0.96 scale, `-arrow-rise` off its place: the copy
// held through that is taken at the start and must reach where it settles.
const OPEN_SCALE = 0.96;
function openRoom(box) {
    const [, width] = box.get_preferred_width(-1);
    const [, height] = box.get_preferred_height(width);
    const reach = Math.ceil(box.get_theme_node().get_length('-arrow-rise') + (1 - OPEN_SCALE) * Math.max(width, height));
    return {left: reach, right: reach, top: reach, bottom: reach};
}

export default class GlassModule extends Module {
    static needsDock = true;

    enable() {
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._tokens = JSON.parse(Files.readText(`${this.ext.path}/tokens.json`));
        this._menus = new Map();
        this._docks = new Map();
        trackPaintingView();
        // Glass layer -> the actor carrying LIGHT_CLASS, for light ones.
        this._light = new Map();
        this._watchedHolders = new WeakSet();
        this._goneHolders = new WeakSet();
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
            self.guard(() => {
                self._ensureBox(this);
                self._toneMenu(this);
                if (args[0])
                    self._menus.get(this)?.glass.holdFor(BoxPointer.POPUP_ANIMATION_TIME, openRoom(this));
            });
            return self._origPointerOpen.call(this, ...args);
        };
        this._origPointerClose = pointerProto.close;
        pointerProto.close = function (...args) {
            self.guard(() => {
                if (args[0])
                    self._menus.get(this)?.glass.holdFor(BoxPointer.POPUP_ANIMATION_TIME);
            });
            return self._origPointerClose.call(this, ...args);
        };
        // Wrapping reparents the menu's content, and a mapped one is restyled
        // whole: about 30 ms on the first quick settings click. Closed, it costs
        // under a millisecond, so give the top bar's menus glass ahead of time.
        this.later('prewrap', PREWRAP_MS, () => {
            if (adaptiveTone(this.settings))
                warmBackdrop(this._iface.get_string('color-scheme') === 'prefer-dark');
            for (const item of Object.values(Main.panel.statusArea)) {
                if (item?.menu?._boxPointer && !item.menu.isOpen) {
                    this._ensureMenu(item.menu);
                    this._toneMenu(item.menu._boxPointer);
                }
            }
        });

        this._panelGlass = new GlassLayer({style: this._style, shapeSource: Main.panel, track: Main.panel, smoothing: 0, shadow: false, guard: 0, chrome: true});
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

        this._surfaces = new Map();
        this._hooks = [];
        // Banners land over anything, a white window included, and carry text the
        // reader hasn't looked at yet: a little nearer the tinted end, so what's
        // behind frosts away.
        this.connect(Main.messageTray._bannerBin, 'child-added', (_bin, banner) => this.guard(() => {
            this._ensureTracked(Main.messageTray, banner, {thicken: 0.4});
            this._toneBanner(banner);
            // Where the banner really lands (a corner, by GNOME's setting) is
            // known once it's laid out.
            this.later('banner-tone', BANNER_SETTLE_MS, () => {
                if (banner.has_allocation() && this._surfaces.has(banner))
                    this._toneSurface(banner, Main.messageTray._bannerBin);
            });
        }));
        this._after(ModalDialog.ModalDialog.prototype, 'open', dialog => {
            this._ensureDialog(dialog);
            this._toneSurface(dialog.dialogLayout?._dialog);
        });
        this._after(OsdWindow.OsdWindow.prototype, 'show', osd => {
            this._ensureTracked(osd, osd._hbox);
            this._toneSurface(osd._hbox);
        });
        this._after(SwitcherPopup.SwitcherPopup.prototype, 'show', popup => {
            this._ensureSwitcher(popup);
            this._toneSurface(popup._switcherList);
        });
        this._after(WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype, 'display', popup => {
            for (const monitor of popup.get_children())
                this._ensureTracked(popup, monitor._list);
        });
        // The dock's app names: GNOME adds one hidden label per icon to uiGroup.
        // Thickened rather than toned: the class would have to go on uiGroup.
        const uiGroup = Main.layoutManager.uiGroup;
        // The dock raises a label to the top as it shows: raise it first, glass under it.
        const ensureLabel = actor => {
            if (!actor.has_style_class_name?.('dash-label') || this._surfaces.has(actor))
                return;
            this._ensureTracked(actor, actor, {thicken: 0.4});
            const glass = this._surfaces.get(actor);
            actor.connectObject('show', () => this.guard(() => {
                uiGroup.set_child_above_sibling(actor, null);
                uiGroup.set_child_below_sibling(glass, actor);
            }), glass);
        };
        uiGroup.get_children().forEach(actor => this.guard(() => ensureLabel(actor)));
        this.connect(uiGroup, 'child-added', (_g, actor) => ensureLabel(actor));
        this.connect(Main.overview, 'showing', () => this._overviewIn());
        this.connect(Main.overview, 'hidden', () => this._overviewOut());

        const syncFullscreen = () => this._syncPanelGlass();
        this.connect(global.display, 'in-fullscreen-changed', syncFullscreen);
        this.connect(Main.overview, 'showing', syncFullscreen);
        this.connect(Main.overview, 'hidden', syncFullscreen);

        this._attachDocks();
        this.attachLauncher();
    }

    // Superbar's surface is glass too. Either of the two modules can start last.
    attachLauncher() {
        const material = this.ext._active?.get('launcher')?.instance?._materialLayer;
        if (!material || this._launcherGlass)
            return;
        let style = material.style;
        material.style = CLEAR_SURFACE;
        const glass = this._launcherGlass = new GlassLayer({style: this._style, shapeSource: material});
        // It repaints its surface at every theme or session change, over the glass.
        material.connectObject('notify::style', () => {
            if (material.style !== CLEAR_SURFACE) {
                style = material.style;
                material.style = CLEAR_SURFACE;
            }
        }, glass);
        material.insert_child_at_index(glass, 0);
        glass.add_constraint(new Clutter.BindConstraint({
            source: material, coordinate: Clutter.BindCoordinate.SIZE,
        }));
        // Glass going away on its own hands the launcher its surface back.
        this._dropLauncherGlass = () => {
            glass.destroy();
            material.style = style;
        };
        glass.connect('destroy', () => (this._launcherGlass = this._dropLauncherGlass = null));
    }

    disable() {
        this.cleanup();
        for (const holder of new Set(this._light.values())) {
            if (!this._goneHolders.has(holder))
                holder.remove_style_class_name(LIGHT_CLASS);
        }
        this._light.clear();
        if (this._origOpen)
            PopupMenu.PopupMenu.prototype.open = this._origOpen;
        this._origOpen = null;
        if (this._origPointerOpen)
            BoxPointer.BoxPointer.prototype.open = this._origPointerOpen;
        this._origPointerOpen = null;
        if (this._origPointerClose)
            BoxPointer.BoxPointer.prototype.close = this._origPointerClose;
        this._origPointerClose = null;
        for (const [box, entry] of this._menus) {
            delete box._superGMenuActor;
            entry.child?.remove_style_class_name?.('super-g-glassed');
            unwrap(entry);
        }
        this._menus.clear();
        delete this._undimmed?._setDimmed;
        this._undimmed = null;
        for (const glass of this._docks.values())
            glass.destroy();
        this._docks.clear();
        for (const restore of this._hooks)
            restore();
        this._hooks = [];
        for (const [surface, glass] of this._surfaces) {
            surface.remove_style_class_name('super-g-glassed');
            glass.destroy();
        }
        this._surfaces.clear();
        if (this._origPopup)
            AppDisplay.AppFolderDialog.prototype.popup = this._origPopup;
        this._origPopup = null;
        for (const folder of [...this._folders.values()])
            folder.drop();
        this._folders.clear();
        if (this._dockReadyId)
            this._dockExt?.dockManager?.disconnect(this._dockReadyId);
        this._panelGlass?.destroy();
        this._panelGlass = null;
        this._dropLauncherGlass?.();
        this._islands.forEach(glass => glass.destroy());
        this._islands = [];
        this._overviewOut(true);
        untrackPaintingView();
    }

    _palette(dark) {
        return resolve(this._tokens, {
            palette: this.settings.get_string('palette'), accent: this.settings.get_string('accent'),
        }, dark);
    }

    _computeStyle() {
        this._styleLight = glassStyle(this._palette(false), this.settings);
        return glassStyle(this._palette(shellDark(this.settings, this._iface)), this.settings);
    }

    _restyle() {
        this._style = this._computeStyle();
        if (!adaptiveTone(this.settings)) {
            for (const [glass, holder] of this._light)
                this._setLight(glass, holder, false);
        }
        const folders = [...this._folders.values()];
        const all = [this._panelGlass, this._launcherGlass, ...this._islands, ...folders.map(f => f.glass), ...[...this._menus.values()].map(e => e.glass),
            ...this._docks.values(), ...this._surfaces.values(), ...(this._overview ?? [])];
        for (const glass of all.filter(Boolean))
            glass.setStyle(this._light.has(glass) ? this._styleLight : this._style);
        for (const folder of folders)
            folder.wash.style = this._washStyle();
        this._syncPanelGlass();
    }

    /* -------------------------------------------------------- top bar -- */

    // Islands style: no bar to speak of, each island is its own piece of glass.
    _syncPanelGlass() {
        const on = this.settings.get_boolean('panel-glass') && !barOverFullscreen();
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
                smoothing: 0, shadow: false, guard: 0, chrome: true});
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
        // Over the dim it goes a little towards tinted, as dialogs do.
        const glass = new GlassLayer({style: this._style, shapeSource: box, track: box, smoothing: 0.5, thicken: 0.3});
        dialog.get_parent().insert_child_below(glass, dialog);
        // GNOME's dim is the dialog's own background colour, eased when it opens,
        // and would lie over the glass; ours goes under, a soft wash of the theme.
        dialog.ease = params => {
            const {background_color: _shade, ...rest} = params;
            return Clutter.Actor.prototype.ease.call(dialog, rest);
        };
        const monitor = Main.layoutManager.primaryMonitor;
        const wash = new St.Widget({x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height, opacity: 0,
            style: this._washStyle()});
        dialog.get_parent().insert_child_below(wash, glass);
        const show = open => {
            wash.ease({opacity: open ? 255 : 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._blurGrid(open);
        };
        show(true);
        // The dialog outlives this module across a lock, and each start adds its
        // own wash: a stale one would darken the folder a little more every time.
        const signals = [dialog.connect('open-state-changed', (_d, open) => this.guard(() => show(open)))];
        const drop = () => {
            this._blurGrid(false, true);
            signals.forEach(id => dialog.disconnect(id));
            delete dialog.ease;
            this._folders.delete(dialog);
            glass.destroy();
            wash.destroy();
        };
        signals.push(dialog.connect('destroy', drop));
        this._folders.set(dialog, {glass, wash, drop});
    }

    // Glass on glass reads as clutter: the folder's lens refracted the grid's
    // tiles and labels into coloured blobs. As Apple does, what's under an open
    // folder blurs away, so its glass sits on a calm field. The effect is
    // removed once the grid is sharp again, so the grid costs nothing then.
    _blurGrid(open, now = false) {
        const view = Main.overview._overview?.controls?._appDisplay;
        if (!view)
            return;
        let effect = view.get_effect(FOLDER_BLUR);
        const to = open && this.settings.get_boolean('glass-folder-backdrop') ? FOLDER_BLUR_RADIUS : 0;
        if (!effect && !to)
            return;
        if (!effect) {
            effect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 0, brightness: 1});
            view.add_effect_with_name(FOLDER_BLUR, effect);
        }
        this._blurTimeline?.stop();
        this._blurTimeline = null;
        const finish = () => {
            effect.radius = to;
            if (!to)
                view.remove_effect(effect);
        };
        if (now)
            return finish();
        const from = effect.radius;
        // Bound to the stage, and referenced, or it freezes silently.
        const timeline = this._blurTimeline = new Clutter.Timeline({actor: global.stage,
            duration: FOLDER_BLUR_MS * St.Settings.get().slow_down_factor,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        timeline.connect('new-frame', () => (effect.radius = from + (to - from) * timeline.get_progress()));
        timeline.connect('stopped', (_t, complete) => {
            if (complete)
                finish();
            if (this._blurTimeline === timeline)
                this._blurTimeline = null;
        });
        timeline.start();
        return undefined;
    }

    _washStyle() {
        return `background-color: ${this._style.lightText ? 'rgba(0,0,0,0.38)' : 'rgba(255,255,255,0.28)'};`;
    }

    _after(proto, name, ensure) {
        const orig = proto[name];
        const self = this;
        proto[name] = function (...args) {
            const result = orig.apply(this, args);
            self.guard(() => ensure(this));
            return result;
        };
        this._hooks.push(() => (proto[name] = orig));
    }

    /* --------------------------------------------------- adaptive tone -- */

    // Light glass where dark glass would turn a bright backdrop into a grey
    // slab under its white text; the surface's parent carries the class, so the
    // shell sheet's light rules reach the surface and everything in it.
    _tone(glass, holder, rect) {
        let light = false;
        if (adaptiveTone(this.settings) && rect?.width > 0 && rect?.height > 0) {
            const y = backdropLuma(rect, this._iface.get_string('color-scheme') === 'prefer-dark');
            const face = darkGlassFace(y, this._palette(true), this.settings, Math.min(rect.width, rect.height)) ** 2.2;
            const contrast = 1.05 / (face + 0.05);
            light = contrast < (this._light.has(glass) ? DARK_ABOVE : LIGHT_BELOW);
        }
        this._setLight(glass, holder, light);
    }

    // Holders can outlive the glass and be shared (every banner's is the
    // banner bin): the class follows whether any light glass still uses it,
    // or a dark banner after a light one gets dark text on dark glass.
    _setLight(glass, holder, light) {
        const was = this._light.has(glass);
        if (light)
            this._light.set(glass, holder);
        else
            this._light.delete(glass);
        if (light && !glass._toneWatched) {
            glass._toneWatched = true;
            glass.connect('destroy', () => {
                const gone = this._light.get(glass);
                this._light.delete(glass);
                if (gone)
                    this._syncHolder(gone);
            });
        }
        this._syncHolder(holder);
        if (light !== was)
            glass.setStyle(light ? this._styleLight : this._style);
    }

    _syncHolder(holder) {
        if (this._goneHolders.has(holder))
            return;
        if (!this._watchedHolders.has(holder)) {
            this._watchedHolders.add(holder);
            holder.connect('destroy', () => this._goneHolders.add(holder));
        }
        const used = [...this._light.values()].includes(holder);
        if (used !== holder.has_style_class_name(LIGHT_CLASS)) {
            if (used)
                holder.add_style_class_name(LIGHT_CLASS);
            else
                holder.remove_style_class_name(LIGHT_CLASS);
        }
    }

    // Before it opens, a menu has no place yet: it will hang off its source.
    _toneMenu(box) {
        const entry = this._menus.get(box);
        const source = box._sourceActor;
        if (!entry || !source)
            return;
        const [sx, sy] = source.get_transformed_position();
        const [sw, sh] = source.get_transformed_size();
        const [, , w, h] = entry.child.get_preferred_size();
        const monitor = Main.layoutManager.findMonitorForActor(source) ?? Main.layoutManager.primaryMonitor;
        const clampX = x => Math.min(Math.max(x, monitor.x), monitor.x + monitor.width - w);
        const clampY = y => Math.min(Math.max(y, monitor.y), monitor.y + monitor.height - h);
        const side = box._arrowSide;
        const x = side === St.Side.LEFT ? sx + sw : side === St.Side.RIGHT ? sx - w : clampX(sx + sw / 2 - w / 2);
        const y = side === St.Side.BOTTOM ? sy - h : side === St.Side.TOP ? sy + sh : clampY(sy + sh / 2 - h / 2);
        // The menu's actor: quick settings' submenus sit beside its box.
        this._tone(entry.glass, box._superGMenuActor ?? box, {x, y, width: w, height: h});
    }

    // Where a surface shows: where it last was, or centred on its monitor.
    _toneSurface(surface, holder = surface?.get_parent()) {
        const glass = surface && this._surfaces.get(surface);
        if (!glass || !holder)
            return;
        let [x, y] = surface.get_transformed_position();
        let [w, h] = surface.get_transformed_size();
        if (!surface.has_allocation() || !w || !h) {
            [, , w, h] = surface.get_preferred_size();
            const monitor = Main.layoutManager.primaryMonitor;
            [x, y] = [monitor.x + (monitor.width - w) / 2, monitor.y + (monitor.height - h) / 2];
        }
        this._tone(glass, holder, {x, y, width: w, height: h});
    }

    // Banners drop in at the top of the primary monitor, under the bar.
    _toneBanner(banner) {
        const glass = this._surfaces.get(banner);
        if (!glass)
            return;
        const [, , w, h] = banner.get_preferred_size();
        const monitor = Main.layoutManager.primaryMonitor;
        this._tone(glass, Main.messageTray._bannerBin,
            {x: monitor.x + (monitor.width - w) / 2, y: monitor.y + Main.panel.height, width: w, height: h});
    }

    _addSurface(surface, glass) {
        this._surfaces.set(surface, glass);
        surface.add_style_class_name('super-g-glassed');
        // Tied to the glass: the surface can outlive it, as an open dialog does a lock.
        surface.connectObject('destroy', () => {
            this._surfaces.delete(surface);
            glass.destroy();
        }, glass);
    }

    // For owners that place their children by hand: the glass sits just below
    // the owner and follows the surface.
    _ensureTracked(owner, surface, {thicken = 0} = {}) {
        const parent = owner.get_parent();
        if (!surface || !parent || this._surfaces.has(surface))
            return;
        const glass = new GlassLayer({style: this._style, shapeSource: surface, track: surface, thicken});
        parent.insert_child_below(glass, owner);
        this._addSurface(surface, glass);
    }

    // Inside the dialog: below it, the dialog's own dim would lie over the glass.
    _ensureDialog(dialog) {
        const layout = dialog.dialogLayout;
        const surface = layout?._dialog;
        if (!surface || this._surfaces.has(surface))
            return;
        const glass = new GlassLayer({style: this._style, shapeSource: surface, thicken: 0.6});
        layout.insert_child_below(glass, surface);
        this._addSurface(surface, glass);
    }

    // Alt-Tab adds a second list, the app's windows, while it's open.
    _ensureSwitcher(popup) {
        this._ensureTracked(popup, popup._switcherList);
        if (popup._glassWatched)
            return;
        popup._glassWatched = true;
        popup.connect('child-added', (_p, child) => this.guard(() => {
            if (child.has_style_class_name?.('switcher-list'))
                this._ensureTracked(popup, child);
        }));
    }

    _ensureBox(box) {
        if (this._menus.has(box) || !box.bin)
            return;
        // Menus only, not other things that point at something.
        const content = box.bin.get_child();
        if (!content?.has_style_class_name?.('popup-menu-content') && !content?.has_style_class_name?.('candidate-popup-content'))
            return;
        const entry = wrapWithGlass(box.bin, this._style);
        if (!entry)
            return;
        content.add_style_class_name('super-g-glassed');
        this._menus.set(box, entry);
        box.connectObject('destroy', () => this._menus.delete(box), entry.glass);
    }

    // For what resizes a menu from outside, like a quick settings submenu.
    holdMenu(box, ms, room = null) {
        this._menus.get(box)?.glass.holdFor(ms, room);
    }

    _ensureMenu(menu) {
        if (menu._boxPointer) {
            this._ensureBox(menu._boxPointer);
            menu._boxPointer._superGMenuActor = menu.actor;
        }
        // Quick settings dims itself behind a submenu, redrawing all of itself and
        // its live glass through an offscreen pass, resized on every frame it grows.
        if (menu._setDimmed && menu._dimEffect) {
            menu._dimEffect.enabled = false;
            menu._setDimmed = () => {};
            this._undimmed = menu;
        }
    }

    /* ----------------------------------------------------------- dock -- */

    async _attachDocks() {
        const dockModule = this.ext._active?.get('dock');
        const path = dockModule?.instance?.path;
        if (!path)
            return;
        this._dockExt = await import(`file://${path}/extension.js`);
        if (this.stopped)
            return;
        const attach = () => {
            for (const glass of this._docks.values())
                glass.destroy();
            this._docks.clear();
            for (const dock of this._dockExt.dockManager?._allDocks ?? []) {
                const bg = dock.dash?._background;
                if (!bg)
                    continue;
                const glass = new GlassLayer({style: this._style, shapeSource: bg, smoothing: 0.25, guard: 0.35, chrome: true, shadow: false,
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
