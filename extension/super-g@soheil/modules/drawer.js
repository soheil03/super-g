// SPDX-License-Identifier: GPL-3.0-or-later
// App drawer: a glass popup that grows out of the dock's apps button.
// Search is the title (type to filter, Enter launches the first hit, Esc
// closes), category pills filter, "All" shows a row of most-used apps and
// then one section per category. Styles: dock-popup (default), fullscreen,
// or overview (GNOME's own app grid, untouched).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
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
// Share of the way to the scroll target covered per 60 Hz frame: a wheel glides,
// fingers on a touchpad stay close to their hand, a flick coasts out.
const SCROLL_WHEEL = 0.17;
const SCROLL_FINGER = 0.5;
const SCROLL_COAST = 0.075;
const WHEEL_STEP = 130;
const COAST_MS = 320;
const TOUCH_SLOP = 10;
// How long the Super key keeps a hidden dock out.
const SUPER_DOCK_MS = 2500;
const SUPER_POLL_MS = 80;
const SUPER_IDLE_MS = 3000;
const SUPER_HOLD_MS = 450;
const SUPER_DOUBLE_MS = 280;
const SUPER_SWALLOW_MS = 700;

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
        this._tiles = new Map();
        this._applyStyle();
        this.connect(this._iface, 'changed::color-scheme', () => this._applyStyle());
        this.connect(this.settings, 'changed', () => this.later('drawer-style', 120, () => this._applyStyle()));
        this.connect(Shell.AppSystem.get_default(), 'installed-changed', () => {
            this._apps = null;
            this._dropTiles();
        });
        this._hookDocks();
        this._superId = global.display.connect('overlay-key', () => this.guard(() => this._onSuper()));
        for (const key of ['super-key-action', 'super-double-action', 'super-hold-action'])
            this.connect(this.settings, `changed::${key}`, () => this._syncSuper());
        this._syncSuper();
    }

    /* ----------------------------------------------------- Super key -- */

    // GNOME's own handler toggles the overview. It's only held back while
    // something else is chosen, and gets the key straight back otherwise.
    _syncSuper() {
        const s = this.settings;
        const single = s.get_string('super-key-action');
        const stock = single === 'overview' && s.get_string('super-double-action') === 'none' &&
            s.get_string('super-hold-action') === 'overview';
        if (!stock && !this._overviewHandler) {
            const id = GObject.signal_handler_find(global.display, {signalId: 'overlay-key'});
            if (id && id !== this._superId) {
                GObject.signal_handler_block(global.display, id);
                this._overviewHandler = id;
            }
        } else if (stock && this._overviewHandler) {
            GObject.signal_handler_unblock(global.display, this._overviewHandler);
            this._overviewHandler = 0;
        }
        // The key's press isn't reported, only its release alone, so how long it
        // was held is read from the modifier state. Only while a hold matters,
        // and only while the user is active: an idle desktop gets no timer.
        const watch = s.get_string('super-hold-action') !== single;
        if (watch && !this._idleMonitor) {
            this._idleMonitor = global.backend.get_core_idle_monitor();
            this._idleWatch = this._idleMonitor.add_idle_watch(SUPER_IDLE_MS, () => this._stopSuperPoll());
            this._armActiveWatch();
            this._startSuperPoll();
        } else if (!watch && this._idleMonitor) {
            this._dropSuperWatch();
        }
    }

    _armActiveWatch() {
        this._activeWatch = this._idleMonitor.add_user_active_watch(() => {
            this._activeWatch = 0;
            this._startSuperPoll();
            this._armActiveWatch();
        });
    }

    _startSuperPoll() {
        if (this._superPoll)
            return;
        this._superPoll = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUPER_POLL_MS, () => {
            const down = (global.get_pointer()[2] & Clutter.ModifierType.MOD4_MASK) !== 0;
            if (down && !this._superDownAt)
                this._superDownAt = Date.now();
            else if (!down)
                this._superDownAt = 0;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSuperPoll() {
        if (this._superPoll)
            GLib.source_remove(this._superPoll);
        this._superPoll = 0;
    }

    _dropSuperWatch() {
        this._stopSuperPoll();
        if (this._idleWatch)
            this._idleMonitor.remove_watch(this._idleWatch);
        if (this._activeWatch)
            this._idleMonitor.remove_watch(this._activeWatch);
        this._idleWatch = this._activeWatch = 0;
        this._idleMonitor = null;
    }

    _onSuper() {
        // The press that closed the drawer; this is its release.
        if (this._superSwallow) {
            this._superSwallow = false;
            return;
        }
        if (!this._overviewHandler)
            return;
        const s = this.settings;
        const held = this._superDownAt ? Date.now() - this._superDownAt : 0;
        this._superDownAt = 0;
        if (held >= SUPER_HOLD_MS) {
            this._superAction(s.get_string('super-hold-action'));
            return;
        }
        const single = s.get_string('super-key-action');
        const double = s.get_string('super-double-action');
        if (double === 'none') {
            this._superAction(single);
        } else if (this._superFirst) {
            this._superFirst = false;
            this._superAction(double);
        } else {
            this._superFirst = true;
            this.later('super-double', SUPER_DOUBLE_MS, () => {
                if (!this._superFirst)
                    return;
                this._superFirst = false;
                this._superAction(single);
            });
        }
    }

    _superAction(action) {
        if (action === 'none')
            return;
        if (action === 'overview') {
            Main.overview.toggle();
            return;
        }
        if (Main.overview.visible) {
            Main.overview.hide();
            return;
        }
        if (action === 'apps') {
            Main.overview.showApps();
            return;
        }
        if (action === 'launcher') {
            this._launcher()?._toggleSearch();
            return;
        }
        const dock = this._dockExt?.dockManager?._allDocks?.[0];
        const button = dock?.dash?._showAppsIcon?.toggleButton;
        if (action === 'dock' && dock && !this._dockOnScreen(dock)) {
            for (const each of this._dockExt.dockManager._allDocks)
                each.showDock();
            this.later('super-dock', SUPER_DOCK_MS, () => {
                for (const each of this._dockExt.dockManager?._allDocks ?? [])
                    each.updateDashVisibility();
            });
            return;
        }
        // The dock is already there (or the drawer was asked for): one step on.
        if (this._style() === 'overview')
            Main.overview.showApps();
        else if (this._open)
            this.close();
        else
            this.open(dock, button);
    }

    _dockOnScreen(dock) {
        const bg = dock.dash?._background;
        if (!bg?.mapped)
            return false;
        const [x, y] = bg.get_transformed_position();
        const [w, h] = bg.get_transformed_size();
        const m = Main.layoutManager.monitors[dock._monitorIndex] ?? Main.layoutManager.primaryMonitor;
        return x >= m.x && y >= m.y && x + w <= m.x + m.width && y + h <= m.y + m.height;
    }

    disable() {
        this.cleanup();
        this.close(true);
        global.display.disconnect(this._superId);
        if (this._idleMonitor)
            this._dropSuperWatch();
        if (this._overviewHandler)
            GObject.signal_handler_unblock(global.display, this._overviewHandler);
        this._overviewHandler = 0;
        this._dropTiles();
        for (const [button, state] of this._buttons)
            this._unhookButton(button, state);
        this._buttons.clear();
        if (this._readyId)
            this._dockExt?.dockManager?.disconnect(this._readyId);
        this._sheet.clear();
    }

    _dropTiles() {
        for (const {button} of [...this._tiles.values()])
            button.destroy();
        this._tiles.clear();
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
        const D = '#uiGroup .super-g-drawer';
        this._sheet.set(`/* Generated by super-g: app drawer. */
${D} { border-radius: 28px; color: ${c.fg}; }
${D} .drawer-search { background-color: ${tile}; border: none; box-shadow: none; color: ${c.fg};
  border-radius: 999px; padding: 8px 16px; font-size: 12pt; caret-color: ${c.accent};
  selection-background-color: ${withAlpha(c.accent, 0.35)}; }
${D} .drawer-search:focus { box-shadow: inset 0 0 0 2px ${withAlpha(c.accent, 0.55)}; }
${D} .drawer-search StLabel.hint-text { color: ${withAlpha(c.fg, 0.55)}; }
${D} .drawer-search StIcon { color: ${withAlpha(c.fg, 0.7)}; icon-size: 16px; padding-right: 8px; }
${D} .drawer-chip { border-radius: 999px; padding: 5px 11px; background-color: ${tile}; color: ${c.fg}; font-size: 10pt; }
${D} .drawer-chip:hover { background-color: ${withAlpha(c.fg, c.dark ? 0.16 : 0.12)}; }
${D} .drawer-chip:checked { background-color: ${c.accent}; color: ${c.accentFg}; font-weight: 600; }
${D} .drawer-section { color: ${withAlpha(c.fg, 0.78)}; font-size: 10.5pt; font-weight: 600; padding: 14px 26px 4px; }
${D} .drawer-rule { background-color: ${withAlpha(c.fg, 0.12)}; height: 1px; margin: 8px 22px 2px; }
${D} .drawer-scroll { -st-vfade-offset: 28px; }
${D} .drawer-app { border-radius: 18px; padding: 10px 2px 8px; color: ${c.fg}; font-size: 10pt; transition-duration: 120ms; }
${D} .drawer-app:hover { background-color: ${tile}; }
${D} .drawer-app:focus, ${D} .drawer-app.first-hit { background-color: ${withAlpha(c.accent, 0.22)}; }
${D} .drawer-app:active { background-color: ${withAlpha(c.fg, c.dark ? 0.18 : 0.14)}; }
${D} .drawer-everywhere { margin: 10px 22px 14px; padding: 10px 14px; border-radius: 14px; background-color: ${tile}; color: ${c.fg}; font-size: 10.5pt; transition-duration: 120ms; }
${D} .drawer-everywhere:hover { background-color: ${withAlpha(c.fg, c.dark ? 0.16 : 0.12)}; }
${D} .drawer-everywhere:focus, ${D} .drawer-everywhere.first-hit { background-color: ${withAlpha(c.accent, 0.22)}; }
${D} .drawer-key { border-radius: 6px; padding: 1px 7px; font-size: 9pt; color: ${withAlpha(c.fg, 0.72)}; background-color: ${tile}; }
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

        // Full-monitor catcher: a press outside closes, like any popup. It runs
        // ahead of the buttons inside, whose gestures need their events intact.
        const root = new St.Widget({reactive: true, x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height});
        root.connect('captured-event', (_a, event) => this._onCaptured(event));
        Main.layoutManager.uiGroup.add_child(root);

        const columns = fullscreen ? 9 : this.settings.get_int('app-drawer-columns');
        const width = fullscreen ? Math.min(monitor.width - 160, 1280) : Math.min(columns * SLOT + 44, monitor.width - 48);
        const height = fullscreen ? monitor.height - 160 : Math.min(Math.round(monitor.height * 0.62), 620);

        const drawer = new St.Widget({style_class: 'super-g-drawer', layout_manager: new Clutter.BinLayout(),
            width, height, reactive: true});
        const c = this._colors();
        drawer.add_child(new GlassLayer({style: glassStyle(c, this.settings), shapeSource: drawer, smoothing: 0.5}));
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true});
        drawer.add_child(content);
        root.add_child(drawer);

        const header = new St.BoxLayout({style: 'padding: 16px 22px 10px;'});
        this._entry = new St.Entry({style_class: 'drawer-search', hint_text: 'Search',
            x_expand: true, can_focus: true, y_align: Clutter.ActorAlign.CENTER,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic'})});
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

        this._scroll = new St.ScrollView({style_class: 'drawer-scroll', x_expand: true, y_expand: true,
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
        drawer.set({opacity: 0, scale_x: 0.92, scale_y: 0.92});
        content.set({opacity: 0, translation_y: 10});
        content.ease({opacity: 255, translation_y: 0, duration: Math.round(340 * speed), delay: 40,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        drawer.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: Math.round(300 * speed),
            mode: Clutter.AnimationMode.EASE_OUT_QUINT});
    }

    close(now = false) {
        const open = this._open;
        if (!open)
            return;
        this._open = null;
        this._stopScrolling();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        const finish = () => {
            // The tiles outlive the drawer they were shown in.
            for (const {button} of this._tiles.values())
                button.get_parent()?.remove_child(button);
            open.root.destroy();
        };
        if (now) {
            finish();
            return;
        }
        open.drawer.ease({opacity: 0, scale_x: 0.94, scale_y: 0.94, duration: 130,
            mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: finish});
    }

    _onCaptured(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS)
            return this._onKey(event);
        if (type === Clutter.EventType.SCROLL)
            return this._onScroll(event);
        if (type === Clutter.EventType.TOUCH_UPDATE || type === Clutter.EventType.TOUCH_END)
            return this._onTouch(event, type);
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const drawer = this._open?.drawer;
        if (!drawer)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [dx, dy] = drawer.get_transformed_position();
        const [dw, dh] = drawer.get_transformed_size();
        if (x >= dx && x <= dx + dw && y >= dy && y <= dy + dh) {
            if (type === Clutter.EventType.TOUCH_BEGIN)
                this._touch = {startY: y, startValue: this._scroll.vadjustment.value, lastY: y, lastTime: Date.now(), speed: 0, dragging: false};
            return Clutter.EVENT_PROPAGATE;
        }
        this.close();
        return Clutter.EVENT_STOP;
    }

    /* ------------------------------------------------------ scrolling -- */

    // St's own scrolling jumps by whole steps. Here every input only moves a
    // target, and each frame the view eases towards it.
    _onScroll(event) {
        const [x, y] = event.get_coords();
        const [sx, sy] = this._scroll.get_transformed_position();
        const [sw, sh] = this._scroll.get_transformed_size();
        if (x < sx || x > sx + sw || y < sy || y > sy + sh)
            return Clutter.EVENT_PROPAGATE;
        const adjustment = this._scroll.vadjustment;
        const now = Date.now();
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.DOWN) {
            this._scrollBy(direction === Clutter.ScrollDirection.UP ? -WHEEL_STEP : WHEEL_STEP, SCROLL_WHEEL);
            return Clutter.EVENT_STOP;
        }
        if (direction !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;
        const [, dy] = event.get_scroll_delta();
        const fingers = event.get_scroll_source() === Clutter.ScrollSource.FINGER;
        // The same unit St scrolls by, so the speed is what the system's is.
        const moved = dy * adjustment.page_size ** (2 / 3);
        if (moved)
            this._scrollBy(moved, fingers ? SCROLL_FINGER : SCROLL_WHEEL);
        const elapsed = Math.max(1, now - (this._scrollTime ?? now - 16));
        this._scrollTime = now;
        this._scrollSpeed = 0.7 * (this._scrollSpeed ?? 0) + 0.3 * moved / elapsed;
        // Lifting the fingers carries on with the speed they had.
        if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE && fingers) {
            this._scrollBy(this._scrollSpeed * COAST_MS, SCROLL_COAST);
            this._scrollSpeed = 0;
        }
        return Clutter.EVENT_STOP;
    }

    _onTouch(event, type) {
        const touch = this._touch;
        if (!touch)
            return Clutter.EVENT_PROPAGATE;
        const [, y] = event.get_coords();
        if (type === Clutter.EventType.TOUCH_END) {
            this._touch = null;
            if (!touch.dragging)
                return Clutter.EVENT_PROPAGATE;
            this._dragged = true;
            this._scrollBy(touch.speed * COAST_MS, SCROLL_COAST);
            return Clutter.EVENT_STOP;
        }
        if (!touch.dragging && Math.abs(y - touch.startY) < TOUCH_SLOP)
            return Clutter.EVENT_PROPAGATE;
        touch.dragging = true;
        const now = Date.now();
        touch.speed = 0.7 * touch.speed + 0.3 * (touch.lastY - y) / Math.max(1, now - touch.lastTime);
        touch.lastY = y;
        touch.lastTime = now;
        this._scrollTo(touch.startValue + touch.startY - y, 1);
        return Clutter.EVENT_STOP;
    }

    _scrollBy(amount, follow) {
        const base = this._scrollTarget ?? this._scroll.vadjustment.value;
        this._scrollTo(base + amount, follow);
    }

    _scrollTo(value, follow) {
        const adjustment = this._scroll.vadjustment;
        const most = Math.max(0, adjustment.upper - adjustment.page_size);
        this._scrollTarget = Math.max(0, Math.min(most, value));
        this._scrollFollow = follow;
        this._scrollLast = Date.now();
        if (!this._scrollTimeline) {
            this._scrollTimeline = new Clutter.Timeline({actor: this._scroll, duration: 1000, repeat_count: -1});
            this._scrollTimeline.connect('new-frame', () => this._scrollFrame());
        }
        this._scrollTimeline.start();
    }

    _scrollFrame() {
        const adjustment = this._scroll.vadjustment;
        const now = Date.now();
        const dt = Math.max(1, Math.min(64, now - this._scrollLast));
        this._scrollLast = now;
        const left = this._scrollTarget - adjustment.value;
        if (Math.abs(left) < 0.5) {
            adjustment.value = this._scrollTarget;
            this._scrollTarget = null;
            this._scrollTimeline.stop();
            return;
        }
        adjustment.value += left * (1 - (1 - this._scrollFollow) ** (dt * 60 / 1000));
    }

    _stopScrolling() {
        this._scrollTimeline?.stop();
        this._scrollTimeline = null;
        this._scrollTarget = null;
        this._touch = null;
    }

    // Search keeps the keyboard until an arrow moves into the grid; typing
    // anywhere goes back to search.
    _onKey(event) {
        const key = event.get_key_symbol();
        // The drawer has the keyboard, so Super reaches it here. Closing on the
        // press leaves the release to arrive as a fresh press of the key, which
        // would open it right back up.
        if (key === Clutter.KEY_Super_L || key === Clutter.KEY_Super_R) {
            this._superSwallow = true;
            this.later('super-swallow', SUPER_SWALLOW_MS, () => (this._superSwallow = false));
            this.close();
            return Clutter.EVENT_STOP;
        }
        const text = this._entry.clutter_text;
        const inSearch = global.stage.key_focus === text;
        if (key === Clutter.KEY_Escape) {
            if (this._entry.get_text())
                this._entry.set_text('');
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Tab && this._entry.get_text().trim() && this._launcher()) {
            this._searchEverywhere();
            return Clutter.EVENT_STOP;
        }
        const dir = {
            [Clutter.KEY_Up]: St.DirectionType.UP,
            [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Left]: St.DirectionType.LEFT,
            [Clutter.KEY_Right]: St.DirectionType.RIGHT,
        }[key];
        if (dir !== undefined) {
            if (inSearch && dir !== St.DirectionType.DOWN)
                return Clutter.EVENT_PROPAGATE;
            const from = inSearch ? null : global.stage.key_focus;
            if (!this._body.navigate_focus(from, dir, false) && dir === St.DirectionType.UP)
                global.stage.set_key_focus(text);
            const focused = global.stage.key_focus;
            if (focused && this._body.contains(focused))
                this._reveal(focused);
            return Clutter.EVENT_STOP;
        }
        const unicode = event.get_key_unicode();
        if (!inSearch && unicode && unicode.charCodeAt(0) > 32 && unicode.charCodeAt(0) !== 127) {
            global.stage.set_key_focus(text);
            text.insert_text(unicode, text.get_cursor_position());
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _reveal(actor) {
        const [, y] = actor.get_transformed_position();
        const [, top] = this._scroll.get_transformed_position();
        const below = y + actor.height - (top + this._scroll.height);
        if (y < top)
            this._scrollBy(y - top - 16, SCROLL_WHEEL);
        else if (below > 0)
            this._scrollBy(below + 16, SCROLL_WHEEL);
    }

    _launch(app) {
        this.close();
        app.activate();
    }

    _launchFirst() {
        const first = this._visible?.[0];
        if (first)
            this._launch(first);
        else if (this._entry.get_text().trim())
            this._searchEverywhere();
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
                this._render({animate: true});
            });
            this._chips.add_child(chip);
        }
    }

    // Tiles live as long as the module, so opening and filtering only move
    // them around; building them on the fly is what made typing stutter.
    _tile(app) {
        const cached = this._tiles.get(app);
        if (cached?.slot === this._slot)
            return cached.button;
        cached?.button.destroy();
        const button = new St.Button({style_class: 'drawer-app', can_focus: true, width: this._slot,
            reactive: true, track_hover: true});
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 6px;',
            x_align: Clutter.ActorAlign.CENTER});
        const icon = app.create_icon_texture(64);
        icon.x_align = Clutter.ActorAlign.CENTER;
        icon.set_pivot_point(0.5, 0.5);
        box.add_child(icon);
        const label = new St.Label({text: app.get_name(), x_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.set({ellipsize: Pango.EllipsizeMode.END, line_wrap: false});
        label.style = `max-width: ${this._slot - 12}px;`;
        box.add_child(label);
        button.set_child(box);
        const react = () => {
            const scale = button.pressed ? 0.94 : button.hover ? 1.07 : 1;
            icon.ease({scale_x: scale, scale_y: scale, duration: button.pressed ? 70 : 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        button.connect('notify::hover', react);
        button.connect('notify::pressed', react);
        button.connect('clicked', () => {
            // The end of a touch drag isn't a tap.
            if (this._dragged)
                this._dragged = false;
            else
                this._launch(app);
        });
        button.connect('destroy', () => this._tiles.delete(app));
        this._tiles.set(app, {button, slot: this._slot});
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

    _render({animate = false} = {}) {
        for (const {button} of this._tiles.values()) {
            button.remove_style_class_name('first-hit');
            button.get_parent()?.remove_child(button);
        }
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
            if (hits.length) {
                add('', hits);
                // Enter launches this one.
                this._tile(hits[0]).add_style_class_name('first-hit');
            } else if (!this._launcher()) {
                this._body.add_child(new St.Label({text: `No apps match "${query}"`, style_class: 'drawer-empty',
                    x_align: Clutter.ActorAlign.CENTER}));
            }
            this._addEverywhere(query, !hits.length);
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
        this._scrollTimeline?.stop();
        this._scrollTarget = null;
        this._scroll.vadjustment.value = 0;
        if (animate) {
            this._body.remove_all_transitions();
            this._body.set({opacity: 0, translation_y: 8});
            this._body.ease({opacity: 255, translation_y: 0, duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
    }

    /* ------------------------------------------------------ Superbar -- */

    // The launcher engine searches what the drawer doesn't: files, windows,
    // calculations, the web, system actions.
    _launcher() {
        const instance = this.ext._active?.get('launcher')?.instance;
        return instance?._openSearch ? instance : null;
    }

    _addEverywhere(query, primary) {
        if (!this._launcher())
            return;
        const row = new St.Button({style_class: `drawer-everywhere${primary ? ' first-hit' : ''}`, can_focus: true, x_expand: true});
        const box = new St.BoxLayout({style: 'spacing: 10px;', x_expand: true, x_align: Clutter.ActorAlign.FILL});
        box.add_child(new St.Icon({icon_name: 'system-search-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text: `Search everything for \u201c${query}\u201d`, y_align: Clutter.ActorAlign.CENTER, x_expand: true}));
        box.add_child(new St.Label({text: 'Tab', style_class: 'drawer-key', y_align: Clutter.ActorAlign.CENTER}));
        row.set_child(box);
        row.connect('clicked', () => this._searchEverywhere());
        this._body.add_child(row);
    }

    _searchEverywhere() {
        const launcher = this._launcher();
        if (!launcher)
            return;
        const query = this._entry.get_text();
        this.close(true);
        launcher._openSearch();
        launcher._entry.set_text(query);
        launcher._entry.clutter_text.set_cursor_position(-1);
    }
}
