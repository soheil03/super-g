// SPDX-License-Identifier: GPL-3.0-or-later
// App drawer: a glass popup that grows out of the dock's apps button.
// Search is the title (type to filter, Enter launches the first hit, Esc
// closes), category pills filter, "All" shows a row of most-used apps and
// then one section per category. Styles: dock-popup (default), fullscreen,
// or overview (GNOME's own app grid, untouched).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Module} from '../lib/module.js';
import * as Files from '../lib/files.js';
import {LiveStylesheet} from '../lib/stylesheet.js';
import {resolve} from '../lib/themeGen.js';
import {withAlpha} from '../lib/color.js';
import {GlassLayer, glassStyle} from '../lib/glass.js';

// Desktop-entry categories → drawer sections, first match wins.
const SECTIONS = [
    ['Internet', ['WebBrowser', 'Email', 'Chat', 'InstantMessaging', 'Network', 'P2P']],
    ['Productivity', ['Office', 'TextEditor', 'Calendar', 'ContactManagement', 'Finance', 'WordProcessor', 'Spreadsheet']],
    ['Creativity', ['Graphics', 'Photography', '2DGraphics', '3DGraphics', 'VectorGraphics', 'RasterGraphics']],
    ['Media', ['AudioVideo', 'Audio', 'Video', 'Player', 'Music', 'TV']],
    ['Development', ['Development', 'IDE', 'Debugger', 'RevisionControl']],
    ['Games', ['Game']],
    ['System', ['Settings', 'System', 'Monitor', 'PackageManager', 'HardwareSettings']],
    ['Utilities', ['Utility', 'Accessories', 'Archiving', 'FileManager', 'Calculator']],
];
const OTHER = 'Other';
// One tile's width, and the room between the drawer and the dock.
const SLOT = 108;
const GAP = 14;

function sectionOf(app) {
    const cats = (app.get_app_info()?.get_categories() ?? '').split(';');
    return SECTIONS.find(([, keys]) => keys.some(k => cats.includes(k)))?.[0] ?? OTHER;
}

export default class DrawerModule extends Module {
    static needsDock = true;

    enable() {
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._tokens = JSON.parse(Files.readText(`${this.ext.path}/tokens.json`));
        this._sheet = new LiveStylesheet('drawer');
        this._buttons = new Map();
        this._applyStyle();
        this.connect(this._iface, 'changed::color-scheme', () => this._applyStyle());
        this.connect(this.settings, 'changed', () => this.later('drawer-style', 120, () => this._applyStyle()));
        this.connect(Shell.AppSystem.get_default(), 'installed-changed', () => (this._apps = null));
        this._hookDocks();
    }

    disable() {
        this.cleanup();
        this.close(true);
        for (const [button, state] of this._buttons)
            this._unhookButton(button, state);
        this._buttons.clear();
        if (this._readyId)
            this._dockExt?.dockManager?.disconnect(this._readyId);
        this._sheet.clear();
    }

    /* --------------------------------------------- dock apps button -- */

    async _hookDocks() {
        const path = this.ext._active?.get('dock')?.instance?.path;
        if (!path)
            return;
        this._dockExt = await import(`file://${path}/extension.js`);
        const hook = () => {
            for (const dock of this._dockExt.dockManager?._allDocks ?? []) {
                const button = dock.dash?._showAppsIcon?.toggleButton;
                if (button && !this._buttons.has(button))
                    this._hookButton(button, dock);
            }
        };
        this._readyId = this._dockExt.dockManager?.connect('docks-ready', () => this.guard(hook));
        hook();
    }

    // The apps button normally toggles GNOME's app grid through its checked
    // state; in popup and fullscreen styles it opens the drawer instead.
    _hookButton(button, dock) {
        const state = {toggle: button.toggle_mode, id: 0};
        state.id = button.connect('clicked', () => {
            if (this._style() === 'overview')
                return;
            this.guard(() => (this._open ? this.close() : this.open(dock, button)));
        });
        const sync = () => {
            button.toggle_mode = this._style() === 'overview' ? state.toggle : false;
        };
        state.syncId = this.settings.connect('changed::app-drawer-style', sync);
        sync();
        this._buttons.set(button, state);
    }

    _unhookButton(button, state) {
        button.disconnect(state.id);
        this.settings.disconnect(state.syncId);
        button.toggle_mode = state.toggle;
    }

    _style() {
        return this.settings.get_string('app-drawer-style');
    }

    /* ------------------------------------------------------- styling -- */

    _colors() {
        const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
        return resolve(this._tokens, {
            palette: this.settings.get_string('palette'), accent: this.settings.get_string('accent'),
        }, dark);
    }

    _applyStyle() {
        const c = this._colors();
        const tile = withAlpha(c.fg, c.dark ? 0.1 : 0.07);
        const D = '#uiGroup .gnome-plus-drawer';
        this._sheet.set(`/* Generated by gnome-plus: app drawer. */
${D} { border-radius: 28px; color: ${c.fg}; }
${D} .drawer-search { background-color: transparent; border: none; box-shadow: none; color: ${c.fg};
  font-size: 20pt; font-weight: 500; padding: 0; caret-color: ${c.accent}; selection-background-color: ${withAlpha(c.accent, 0.35)}; }
${D} .drawer-search StLabel.hint-text { color: ${withAlpha(c.fg, 0.4)}; }
${D} .drawer-glyph { color: ${withAlpha(c.fg, 0.7)}; }
${D} .drawer-chip { border-radius: 999px; padding: 5px 11px; background-color: ${tile}; color: ${c.fg}; font-size: 10pt; }
${D} .drawer-chip:hover { background-color: ${withAlpha(c.fg, c.dark ? 0.16 : 0.12)}; }
${D} .drawer-chip:checked { background-color: ${c.accent}; color: ${c.accentFg}; font-weight: 600; }
${D} .drawer-section { color: ${withAlpha(c.fg, 0.72)}; font-size: 10pt; font-weight: 600; padding: 12px 22px 2px; }
${D} .drawer-rule { background-color: ${withAlpha(c.fg, 0.12)}; height: 1px; margin: 8px 22px 2px; }
${D} .drawer-app { border-radius: 16px; padding: 8px 2px 6px; color: ${c.fg}; font-size: 9.5pt; }
${D} .drawer-app:hover, ${D} .drawer-app:focus { background-color: ${tile}; }
${D} .drawer-app:active { background-color: ${withAlpha(c.fg, c.dark ? 0.16 : 0.12)}; }
${D} .drawer-empty { color: ${withAlpha(c.fg, 0.72)}; font-size: 11pt; padding: 48px; }
`);
    }

    /* ---------------------------------------------------------- apps -- */

    _allApps() {
        if (!this._apps) {
            const system = Shell.AppSystem.get_default();
            this._apps = system.get_installed()
                .filter(info => info.should_show())
                .map(info => system.lookup_app(info.get_id()))
                .filter(Boolean)
                .sort((a, b) => a.get_name().localeCompare(b.get_name()));
        }
        return this._apps;
    }

    _search(query) {
        const system = Shell.AppSystem.get_default();
        const ids = Shell.AppSystem.search(query).flat();
        const found = ids.map(id => system.lookup_app(id)).filter(Boolean);
        return found.filter(app => app.get_app_info()?.should_show?.() ?? true);
    }

    /* ---------------------------------------------------------- open -- */

    open(dock, button) {
        if (this._open)
            return;
        const fullscreen = this._style() === 'fullscreen';
        const monitor = Main.layoutManager.monitors[dock?._monitorIndex ?? Main.layoutManager.primaryIndex] ??
            Main.layoutManager.primaryMonitor;

        // Full-monitor catcher: a click outside closes, like any popup.
        const root = new St.Widget({reactive: true, x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height});
        root.connect('button-press-event', (_a, event) => {
            if (event.get_source() === root)
                this.close();
            return Clutter.EVENT_STOP;
        });
        root.connect('key-press-event', (_a, event) => this._onKey(event));
        Main.layoutManager.uiGroup.add_child(root);

        const columns = fullscreen ? 9 : this.settings.get_int('app-drawer-columns');
        const width = fullscreen ? Math.min(monitor.width - 160, 1280) : Math.min(columns * SLOT + 44, monitor.width - 48);
        const height = fullscreen ? monitor.height - 160 : Math.min(Math.round(monitor.height * 0.62), 620);

        const drawer = new St.Widget({style_class: 'gnome-plus-drawer', layout_manager: new Clutter.BinLayout(),
            width, height, reactive: true});
        const c = this._colors();
        drawer.add_child(new GlassLayer({style: glassStyle(c, this.settings), shapeSource: drawer, smoothing: 0.5}));
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        drawer.add_child(content);
        root.add_child(drawer);

        // Header: glyph + search (the title) .
        const header = new St.BoxLayout({style: 'padding: 18px 22px 10px; spacing: 12px;'});
        header.add_child(new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: 22,
            style_class: 'drawer-glyph', y_align: Clutter.ActorAlign.CENTER}));
        this._entry = new St.Entry({style_class: 'drawer-search', hint_text: 'Search apps',
            x_expand: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._entry.clutter_text.connect('text-changed', () => this._render());
        this._entry.clutter_text.connect('activate', () => this._launchFirst());
        header.add_child(this._entry);
        content.add_child(header);

        // One row; it scrolls when the pills outgrow a narrow drawer.
        this._chips = new St.BoxLayout({style: 'spacing: 5px;'});
        const chipRow = new St.ScrollView({style: 'padding: 0 20px 10px;', overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.EXTERNAL, vscrollbar_policy: St.PolicyType.NEVER});
        chipRow.set_child(this._chips);
        content.add_child(chipRow);

        this._scroll = new St.ScrollView({x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true});
        this._body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._scroll.set_child(this._body);
        content.add_child(this._scroll);

        this._columns = columns;
        this._slot = Math.floor((width - 44) / columns);
        this._section = 'All';
        this._renderChips();
        this._render();

        // Place it: beside the dock, centred on it, growing out of the apps
        // button; fullscreen: centred on the monitor.
        let x = Math.round((monitor.width - width) / 2);
        let y = Math.round((monitor.height - height) / 2);
        let pivot = [0.5, 0.5];
        const bg = dock?.dash?._background;
        if (!fullscreen && button && bg) {
            const [bx, by] = button.get_transformed_position();
            const [bw, bh] = button.get_transformed_size();
            const [dx, dy] = bg.get_transformed_position();
            const [dw, dh] = bg.get_transformed_size();
            const within = (v, size, room) => Math.round(Math.min(Math.max(v, 24), room - size - 24));
            x = within(dx + dw / 2 - monitor.x - width / 2, width, monitor.width);
            y = within(dy + dh / 2 - monitor.y - height / 2, height, monitor.height);
            switch (dock._position) {
            case St.Side.LEFT:
                x = dx + dw - monitor.x + GAP;
                break;
            case St.Side.RIGHT:
                x = dx - monitor.x - width - GAP;
                break;
            case St.Side.TOP:
                y = dy + dh - monitor.y + GAP;
                break;
            default:
                y = dy - monitor.y - height - GAP;
            }
            pivot = [(bx + bw / 2 - monitor.x - x) / width, (by + bh / 2 - monitor.y - y) / height];
        }
        drawer.set_position(x, y);
        drawer.set_pivot_point(...pivot);

        this._grab = Main.pushModal(root, {actionMode: Shell.ActionMode.POPUP});
        this._open = {root, drawer};
        global.stage.set_key_focus(this._entry.clutter_text);

        const speed = this.settings.get_double('animation-speed');
        drawer.set({opacity: 0, scale_x: 0.86, scale_y: 0.86});
        drawer.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: Math.round(280 * speed),
            mode: Clutter.AnimationMode.EASE_OUT_EXPO});
    }

    close(now = false) {
        const open = this._open;
        if (!open)
            return;
        this._open = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const finish = () => open.root.destroy();
        if (now) {
            finish();
            return;
        }
        open.drawer.ease({opacity: 0, scale_x: 0.9, scale_y: 0.9, duration: 160,
            mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: finish});
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            if (this._entry.get_text())
                this._entry.set_text('');
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _launch(app) {
        this.close();
        app.activate();
    }

    _launchFirst() {
        const first = this._visible?.[0];
        if (first)
            this._launch(first);
    }

    /* -------------------------------------------------------- render -- */

    _renderChips() {
        this._chips.destroy_all_children();
        const present = new Set(this._allApps().map(sectionOf));
        const names = ['All', ...SECTIONS.map(s => s[0]).filter(n => present.has(n)), ...(present.has(OTHER) ? [OTHER] : [])];
        for (const name of names) {
            const chip = new St.Button({label: name, style_class: 'drawer-chip', toggle_mode: true,
                checked: name === this._section, can_focus: true});
            chip.connect('clicked', () => {
                this._section = name;
                this._entry.set_text('');
                this._renderChips();
                this._render();
            });
            this._chips.add_child(chip);
        }
    }

    _tile(app) {
        const button = new St.Button({style_class: 'drawer-app', can_focus: true, width: this._slot,
            reactive: true, track_hover: true});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 6px;',
            x_align: Clutter.ActorAlign.CENTER});
        const icon = app.create_icon_texture(56);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        const label = new St.Label({text: app.get_name(), x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.set({ellipsize: Pango.EllipsizeMode.END, line_wrap: false});
        label.style = `max-width: ${this._slot - 12}px;`;
        box.add_child(label);
        button.set_child(box);
        button.connect('clicked', () => this._launch(app));
        return button;
    }

    _grid(apps) {
        const grid = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'padding: 4px 22px; spacing: 4px;'});
        for (let i = 0; i < apps.length; i += this._columns) {
            const row = new St.BoxLayout();
            apps.slice(i, i + this._columns).forEach(app => row.add_child(this._tile(app)));
            grid.add_child(row);
        }
        return grid;
    }

    _render() {
        this._body.destroy_all_children();
        const query = this._entry.get_text().trim();
        const all = this._allApps();
        this._visible = [];

        const add = (title, apps) => {
            if (!apps.length)
                return;
            if (title)
                this._body.add_child(new St.Label({text: title, style_class: 'drawer-section'}));
            this._body.add_child(this._grid(apps));
            this._visible.push(...apps);
        };

        if (query) {
            const hits = this._search(query);
            if (hits.length)
                add('', hits);
            else
                this._body.add_child(new St.Label({text: `No apps match "${query}"`, style_class: 'drawer-empty',
                    x_align: Clutter.ActorAlign.CENTER}));
        } else if (this._section === 'All') {
            if (this.settings.get_boolean('app-drawer-suggestions')) {
                const used = Shell.AppUsage.get_default().get_most_used()
                    .filter(app => all.includes(app)).slice(0, this._columns);
                if (used.length) {
                    add('', used);
                    this._body.add_child(new St.Widget({style_class: 'drawer-rule'}));
                }
            }
            for (const name of [...SECTIONS.map(s => s[0]), OTHER])
                add(name, all.filter(app => sectionOf(app) === name));
        } else {
            add(this._section, all.filter(app => sectionOf(app) === this._section));
        }
        this._scroll.vadjustment.value = 0;
    }
}
