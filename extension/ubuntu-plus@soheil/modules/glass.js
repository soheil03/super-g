// SPDX-License-Identifier: GPL-3.0-or-later
// Glass everywhere: the top bar, the dock, every popup menu (quick settings,
// calendar, app and context menus) and the overview backdrop get Ubuntu Plus
// glass (lib/glass.js). Replaces the Blur my Shell engine for all of these.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Module} from '../lib/module.js';
import * as Files from '../lib/files.js';
import {resolve} from '../lib/themeGen.js';
import {GlassLayer, glassStyle, wrapWithGlass, unwrap} from '../lib/glass.js';

export default class GlassModule extends Module {
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

        this._panelGlass = new GlassLayer({style: this._style, shapeSource: Main.panel, track: Main.panel, smoothing: 0});
        Main.layoutManager.uiGroup.insert_child_below(this._panelGlass, Main.layoutManager.panelBox);
        this._panelGlass.active = this.settings.get_boolean('panel-glass');

        this.connect(Main.overview, 'showing', () => this._overviewIn());
        this.connect(Main.overview, 'hidden', () => this._overviewOut());

        this._attachDocks();
    }

    disable() {
        this.cleanup();
        if (this._origOpen)
            PopupMenu.PopupMenu.prototype.open = this._origOpen;
        this._origOpen = null;
        for (const entry of this._menus.values())
            unwrap(entry);
        this._menus.clear();
        for (const glass of this._docks.values())
            glass.destroy();
        this._docks.clear();
        if (this._dockReadyId)
            this._dockExt?.dockManager?.disconnect(this._dockReadyId);
        this._panelGlass?.destroy();
        this._panelGlass = null;
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
        const all = [this._panelGlass, ...[...this._menus.values()].map(e => e.glass),
            ...this._docks.values(), ...(this._overview ?? [])];
        for (const glass of all.filter(Boolean))
            glass.setStyle(this._style);
        if (this._panelGlass)
            this._panelGlass.active = this.settings.get_boolean('panel-glass');
    }

    _ensureMenu(menu) {
        if (this._menus.has(menu) || !menu._boxPointer?.bin)
            return;
        const entry = wrapWithGlass(menu._boxPointer.bin, this._style);
        if (!entry)
            return;
        this._menus.set(menu, entry);
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
                const glass = new GlassLayer({style: this._style, shapeSource: bg, smoothing: 0.25});
                bg.insert_child_at_index(glass, 0);
                glass.add_constraint(new Clutter.BindConstraint({
                    source: bg, coordinate: Clutter.BindCoordinate.SIZE,
                }));
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
        const style = {...this._style, rim: 0, grain: 0.008, blur: Math.max(this._style.blur, 60)};
        this._overview = Main.layoutManager.monitors.map(m => {
            const glass = new GlassLayer({style, radius: 0, smoothing: 0});
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
