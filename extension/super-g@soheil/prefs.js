// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gtk4Css} from './lib/themeGen.js';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const GLASS_MATERIALS = [['ultra-thin', 'Ultra thin'], ['thin', 'Thin'], ['regular', 'Regular'],
    ['thick', 'Thick'], ['ultra-thick', 'Ultra thick'], ['custom', 'Custom']];
const PALETTES = [['graphite', 'Graphite neutral'], ['catppuccin', 'Catppuccin-tuned'],
    ['stone', 'Warm stone'], ['slate', 'Cool slate']];
const ACCENTS = [['auto', 'Palette default'], ['blue', 'Blue'], ['lavender', 'Lavender'],
    ['slate', 'Slate'], ['teal', 'Teal'], ['sage', 'Sage'], ['peach', 'Peach'], ['rose', 'Rose']];
const BUTTONS = [['capsule', 'Capsule group'], ['mini-dots', 'Mini dots'], ['close-emphasized', 'Close emphasized']];
const SIDEBARS = [['floating-card', 'Floating card'], ['stock', 'Stock GNOME']];
const WEIGHTS = [[500, 'Medium'], [600, 'Semibold'], [700, 'Bold']];
const CURVES = [['snappy', 'Snappy spring'], ['soft', 'Soft spring']];
const PANEL_STYLES = [['floating', 'Floating bar'], ['islands', 'Islands'], ['adaptive', 'Adaptive']];
const PANEL_HEIGHTS = [[24, 'Compact (24 px)'], [28, 'Default (28 px)'], [32, 'Comfortable (32 px)'],
    [36, 'Large (36 px)'], [40, 'Extra large (40 px)']];
const STATUS_STYLES = [['grouped', 'Grouped pill'], ['bare', 'Bare icons']];
const DRAWER_STYLES = [['dock-popup', 'Popup from the dock'], ['fullscreen', 'Full screen'], ['overview', 'GNOME app grid']];
const DOCK_POSITIONS = [['BOTTOM', 'Bottom'], ['LEFT', 'Left'], ['RIGHT', 'Right']];
const INDICATORS = [['DOT', 'Small dot'], ['DOTS', 'Dots per window'], ['DASHES', 'Dashes'], ['DEFAULT', 'GNOME default']];

// Settings of a vendored engine; they live in our own compiled schemas.
function engineSettings(path, name) {
    const source = Gio.SettingsSchemaSource.new_from_directory(`${path}/schemas`,
        Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(`org.gnome.shell.extensions.super-g.${name}`, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

function invertedSwitch(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);
    return row;
}

const MODULES = [
    ['appearance', 'Appearance', 'Palette, GTK and shell theming, fonts and motion'],
    ['panel', 'Top bar', 'Floating, islands or adaptive bar, clock, status pill'],
    ['corners', 'Window corners', 'Rounded corners, borders and shadows'],
    ['drawer', 'App drawer', 'Glass popup from the dock: search, categories, most-used apps'],
    ['glass', 'Glass', 'Super G glass for the top bar, dock, menus, popups and overview'],
    ['blur', 'Classic blur', 'Blur my Shell engine (legacy; off by default)'],
    ['dock', 'Dock', 'Autohide, intellihide, previews, trash and mounts'],
    ['dockmotion', 'Dock motion', 'Hover, press, launch and attention motion'],
    ['windows', 'Window extras', 'App title in the top bar, minimize to dock and more'],
    ['hotcorners', 'Hot corners', 'Actions for corners and edges'],
    ['gestures', 'Touchpad gestures', 'Custom touchpad gestures'],
    ['launcher', 'Launcher', 'Keyboard command bar'],
    ['lockscreen', 'Lock screen', 'WACK clock and unlock prompt'],
];

function comboRow(settings, key, title, items, {subtitle = '', int = false} = {}) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(items.map(i => i[1]))});
    const get = () => (int ? settings.get_int(key) : settings.get_string(key));
    const sync = () => {
        const i = items.findIndex(([id]) => id === get());
        row.selected = Math.max(0, i);
    };
    sync();
    row.connect('notify::selected', () => {
        const id = items[row.selected][0];
        if (id !== get())
            int ? settings.set_int(key, id) : settings.set_string(key, id);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, {lower, upper, step, digits = 0, subtitle = ''}) {
    const row = Adw.SpinRow.new_with_range(lower, upper, step);
    row.set({title, subtitle, digits});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function fontRow(settings, key, title) {
    const button = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog(),
        valign: Gtk.Align.CENTER,
        use_font: true,
        font_desc: Pango.FontDescription.from_string(settings.get_string(key)),
    });
    button.connect('notify::font-desc', () => {
        const value = button.font_desc.to_string();
        if (value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    const row = new Adw.ActionRow({title});
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function installedThemes() {
    const names = new Set();
    for (const dir of [`${GLib.get_user_data_dir()}/themes`, `${GLib.get_home_dir()}/.themes`,
        ...GLib.get_system_data_dirs().map(d => `${d}/themes`)]) {
        const file = Gio.File.new_for_path(dir);
        if (!file.query_exists(null))
            continue;
        const it = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = it.next_file(null); info; info = it.next_file(null)) {
            const name = info.get_name();
            if (!name.startsWith('Super-G') && GLib.file_test(`${dir}/${name}/gtk-3.0`, GLib.FileTest.IS_DIR))
                names.add(name);
        }
    }
    return [['super-g', 'Super G'], ...[...names].sort().map(n => [n, n])];
}

// Tint, vibrancy and blur apply to the Custom thickness only.
function customGlass(settings, rows) {
    const sync = () => rows.forEach(r => (r.sensitive = settings.get_string('glass-material') === 'custom'));
    settings.connect('changed::glass-material', sync);
    sync();
    return rows;
}

function group(title, rows, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    rows.forEach(r => g.add(r));
    return g;
}

function page(title, icon, groups) {
    const p = new Adw.PreferencesPage({title, icon_name: icon});
    groups.forEach(g => p.add(g));
    return p;
}

export default class SuperGPrefs extends ExtensionPreferences {
    // This window shows the palette as soon as it's picked, like the shell;
    // other open GTK4 apps read their colours when they start.
    _liveColors(window, s) {
        const tokens = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(`${this.path}/tokens.json`)[1]));
        const provider = new Gtk.CssProvider();
        const display = Gdk.Display.get_default();
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_USER + 1);
        const apply = () => provider.load_from_string(gtk4Css(tokens, {
            palette: s.get_string('palette'), accent: s.get_string('accent'),
            windowButtons: s.get_string('window-buttons'), windowRadius: s.get_int('window-radius'),
            sidebarStyle: s.get_string('sidebar-style'), titleWeight: s.get_int('title-weight'),
        }));
        // A provider of our own doesn't follow the session's light or dark on
        // its own, unlike the user's gtk.css.
        const style = Adw.StyleManager.get_default();
        const scheme = () => {
            if ('prefers_color_scheme' in provider) {
                provider.prefers_color_scheme = style.dark
                    ? Gtk.InterfaceColorScheme.DARK : Gtk.InterfaceColorScheme.LIGHT;
            }
        };
        const styleId = style.connect('notify::dark', scheme);
        scheme();
        const id = s.connect('changed', apply);
        apply();
        window.connect('close-request', () => {
            s.disconnect(id);
            style.disconnect(styleId);
            Gtk.StyleContext.remove_provider_for_display(display, provider);
            return false;
        });
    }

    fillPreferencesWindow(window) {
        const s = this.getSettings();
        this._liveColors(window, s);
        window.set_default_size(720, 760);
        window.search_enabled = true;

        window.add(page('Appearance', 'preferences-desktop-appearance-symbolic', [
            group('Colors', [
                comboRow(s, 'palette', 'Palette', PALETTES),
                comboRow(s, 'accent', 'Accent color', ACCENTS),
            ]),
            group('Apps', [
                comboRow(s, 'gtk-theme-choice', 'GTK theme', installedThemes(),
                    {subtitle: 'Super G follows the palette. Any other installed theme replaces its colors and window buttons'}),
            ]),
            group('Windows', [
                comboRow(s, 'window-buttons', 'Window buttons', BUTTONS),
                spinRow(s, 'window-radius', 'Corner radius', {lower: 0, upper: 28, step: 1}),
                comboRow(s, 'sidebar-style', 'Sidebar', SIDEBARS),
                comboRow(s, 'title-weight', 'Title weight', WEIGHTS, {int: true}),
            ], 'Open apps pick up window changes after a restart.'),
            group('Glass', [
                comboRow(s, 'glass-material', 'Thickness', GLASS_MATERIALS, {subtitle: 'How much the glass hides what is behind it'}),
                spinRow(s, 'glass-refraction', 'Edge refraction', {lower: 0, upper: 1, step: 0.05, digits: 2,
                    subtitle: 'How much the rim bends what is behind it'}),
                ...customGlass(s, [
                spinRow(s, 'glass-tint', 'Tint', {lower: 0, upper: 0.95, step: 0.05, digits: 2,
                    subtitle: 'How much palette colour the glass carries'}),
                spinRow(s, 'glass-saturation', 'Vibrancy', {lower: 0.5, upper: 2.5, step: 0.05, digits: 2}),
                spinRow(s, 'glass-blur', 'Blur', {lower: 8, upper: 120, step: 2}),
                ]),
                switchRow(s, 'glass-overview', 'Blurred overview background'),
            ]),
            group('Apply to', [
                switchRow(s, 'theme-gtk', 'GTK apps', 'GTK4, libadwaita and GTK3 apps, including Flatpaks'),
                switchRow(s, 'theme-shell', 'Shell menus and popups', 'Quick settings, calendar, menus, dialogs, switchers'),
                switchRow(s, 'sync-system-accent', 'Match GNOME accent', 'For apps outside the theme, such as Chrome and Electron apps'),
            ]),
        ]));

        window.add(page('Top bar', 'view-continuous-symbolic', [
            group('Bar', [
                comboRow(s, 'panel-style', 'Style', PANEL_STYLES),
                comboRow(s, 'panel-height', 'Height', PANEL_HEIGHTS, {int: true}),
                switchRow(s, 'panel-glass', 'Glass', 'Live blur behind the bar'),
                switchRow(s, 'panel-adaptive-solid', 'Color over windows', 'Adaptive style: take the window color while a window touches the bar. Off stays see-through'),
                comboRow(s, 'panel-status-style', 'Status icons', STATUS_STYLES),
                switchRow(s, 'hide-accessibility', 'Hide accessibility icon'),
            ]),
            group('Clock', [
                switchRow(s, 'clock-weekday', 'Weekday'),
                switchRow(s, 'clock-date', 'Date'),
                switchRow(s, 'clock-24h', '24-hour'),
            ]),
            group('Start-up', [
                switchRow(s, 'startup-desktop', 'Start on the desktop', 'Instead of the overview'),
            ]),
        ]));

        const lock = engineSettings(this.path, 'lockscreen');
        const dock = engineSettings(this.path, 'dock');
        const motion = engineSettings(this.path, 'dockmotion');
        if (dock && motion) {
            window.add(page('Dock', 'user-desktop-symbolic', [
                group('Icons', [
                    spinRow(dock, 'dash-max-icon-size', 'Icon size', {lower: 24, upper: 96, step: 1}),
                    switchRow(s, 'dock-magnify', 'Magnification', 'Icons grow under the pointer'),
                    switchRow(s, 'dock-launch-bounce', 'Bounce on launch', 'The icon hops while its app starts'),
                    spinRow(s, 'dock-magnify-scale', 'Magnification size', {lower: 1.1, upper: 2.5, step: 0.05, digits: 2}),
                    spinRow(s, 'dock-magnify-reach', 'Magnification reach', {lower: 1, upper: 5, step: 0.1, digits: 1,
                        subtitle: 'Icons to each side that grow with the pointer'}),
                    invertedSwitch(dock, 'hide-tooltip', 'Labels', 'App name above the icon on hover'),
                    comboRow(dock, 'running-indicator-style', 'Running apps', INDICATORS),
                ]),
                group('App drawer', [
                    comboRow(s, 'app-drawer-style', 'Apps button opens', DRAWER_STYLES),
                    spinRow(s, 'app-drawer-columns', 'Columns', {lower: 4, upper: 10, step: 1}),
                    switchRow(s, 'app-drawer-suggestions', 'Most-used apps first'),
                ]),
                group('Behaviour', [
                    comboRow(dock, 'dock-position', 'Position', DOCK_POSITIONS),
                    invertedSwitch(dock, 'dock-fixed', 'Auto-hide'),
                    switchRow(dock, 'intellihide', 'Hide only when a window overlaps'),
                    switchRow(dock, 'show-show-apps-button', 'Apps button'),
                    switchRow(dock, 'show-trash', 'Trash'),
                    switchRow(dock, 'show-mounts', 'Drives and mounts'),
                ]),
                group('Motion', [
                    switchRow(motion, 'custom-launch-enabled', 'Launch animation'),
                    switchRow(motion, 'custom-press-enabled', 'Press animation'),
                    switchRow(motion, 'custom-attention-enabled', 'Attention animation', 'When an app needs you'),
                ]),
            ]));
        }

        window.add(page('Fonts', 'font-x-generic-symbolic', [
            group('Fonts', [
                switchRow(s, 'manage-fonts', 'Manage system fonts'),
                fontRow(s, 'font-interface', 'Interface'),
                fontRow(s, 'font-document', 'Documents'),
                fontRow(s, 'font-monospace', 'Monospace'),
                spinRow(s, 'text-scaling', 'Text scaling', {lower: 0.5, upper: 3, step: 0.01, digits: 2}),
            ]),
        ]));

        window.add(page('Motion', 'media-playlist-repeat-symbolic', [
            group('Animations', [
                comboRow(s, 'motion-curve', 'Feel', CURVES),
                spinRow(s, 'animation-speed', 'Duration', {
                    lower: 0.5, upper: 2, step: 0.05, digits: 2,
                    subtitle: '1.00 is GNOME’s normal speed; higher is slower',
                }),
                switchRow(s, 'reduce-motion', 'Reduce motion', 'Shorter animations, fades instead of movement'),
            ]),
        ]));

        window.add(page('Lock screen', 'system-lock-screen-symbolic', [
            group('Style', [
                comboRow(lock, 'lockscreen-mode', 'Style', [['cupertino', 'Sonoma'], ['wack', 'WACK classic']]),
                switchRow(lock, 'cupertino-always-show-user', 'Always show the user'),
                switchRow(lock, 'cursor-blink', 'Blinking cursor in the password field'),
            ]),
        ]));
        window.add(this._modulesPage(s));
    }

    _modulesPage(s) {
        const modules = new Adw.PreferencesGroup({title: 'Modules',
            description: 'Each module runs on its own. One that fails after a GNOME update is switched off without affecting the others.'});
        for (const [id, title, subtitle] of MODULES)
            modules.add(switchRow(s, `module-${id}`, title, subtitle));

        const broken = new Adw.PreferencesGroup({title: 'Switched off after an error'});
        const rows = [];
        const refresh = () => {
            rows.splice(0).forEach(r => broken.remove(r));
            const list = s.get_strv('broken-modules');
            broken.visible = list.length > 0;
            for (const id of list) {
                const row = new Adw.ActionRow({title: MODULES.find(m => m[0] === id)?.[1] ?? id,
                    subtitle: 'Check the system log for details'});
                const retry = new Gtk.Button({label: 'Turn back on', valign: Gtk.Align.CENTER});
                retry.connect('clicked', () => s.set_strv('broken-modules', s.get_strv('broken-modules').filter(m => m !== id)));
                row.add_suffix(retry);
                broken.add(row);
                rows.push(row);
            }
        };
        s.connect('changed::broken-modules', refresh);
        refresh();
        return page('Modules', 'application-x-addon-symbolic', [modules, broken]);
    }
}
