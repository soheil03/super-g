// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PALETTES = [['graphite', 'Graphite neutral'], ['catppuccin', 'Catppuccin-tuned'],
    ['stone', 'Warm stone'], ['slate', 'Cool slate']];
const ACCENTS = [['auto', 'Palette default'], ['blue', 'Blue'], ['lavender', 'Lavender'],
    ['slate', 'Slate'], ['teal', 'Teal'], ['sage', 'Sage'], ['peach', 'Peach'], ['rose', 'Rose']];
const BUTTONS = [['capsule', 'Capsule group'], ['mini-dots', 'Mini dots'], ['close-emphasized', 'Close emphasized']];
const SIDEBARS = [['floating-card', 'Floating card'], ['stock', 'Stock GNOME']];
const WEIGHTS = [[500, 'Medium'], [600, 'Semibold'], [700, 'Bold']];
const CURVES = [['snappy', 'Snappy spring'], ['soft', 'Soft spring']];
const MODULES = [['appearance', 'Appearance', 'Palette, GTK and shell theming, fonts and motion']];

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

export default class UnifiedShellPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(720, 760);
        window.search_enabled = true;

        window.add(page('Appearance', 'preferences-desktop-appearance-symbolic', [
            group('Colors', [
                comboRow(s, 'palette', 'Palette', PALETTES),
                comboRow(s, 'accent', 'Accent color', ACCENTS),
            ]),
            group('Windows', [
                comboRow(s, 'window-buttons', 'Window buttons', BUTTONS),
                spinRow(s, 'window-radius', 'Corner radius', {lower: 0, upper: 28, step: 1}),
                comboRow(s, 'sidebar-style', 'Sidebar', SIDEBARS),
                comboRow(s, 'title-weight', 'Title weight', WEIGHTS, {int: true}),
            ], 'Open apps pick up window changes after a restart.'),
            group('Apply to', [
                switchRow(s, 'theme-gtk', 'GTK apps', 'GTK4, libadwaita and GTK3 apps, including Flatpaks'),
                switchRow(s, 'theme-shell', 'Shell menus and popups', 'Quick settings, calendar, menus, dialogs, switchers'),
                switchRow(s, 'sync-system-accent', 'Match GNOME accent', 'For apps outside the theme, such as Chrome and Electron apps'),
            ]),
        ]));

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
