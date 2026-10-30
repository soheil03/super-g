// SPDX-License-Identifier: GPL-3.0-or-later
// Appearance: palette → GTK4/libadwaita CSS, a GTK3 theme on top of adw-gtk3,
// shell menu/popup CSS, fonts and animation speed. Replaces the old
// theme-sync script and Kiwi's GTK CSS.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Module} from '../lib/module.js';
import * as Files from '../lib/files.js';
import * as Gen from '../lib/themeGen.js';

const IFACE = 'org.gnome.desktop.interface';
const THEME = 'Ubuntu-Plus';
const THEME_DARK = 'Ubuntu-Plus-dark';
// Earlier versions wrote a separate file and @imported it; snaps copy only
// gtk.css, so the CSS now lives inline in gtk.css.
const GTK4_FILE = `${Files.CONFIG}/gtk-4.0/ubuntu-plus.css`;
const GTK4_MAIN = `${Files.CONFIG}/gtk-4.0/gtk.css`;
const ORIGINAL = `${Files.STATE}/original-settings.json`;
const SAVED_KEYS = [
    ['gtk-theme', 's'], ['accent-color', 's'], ['font-name', 's'],
    ['document-font-name', 's'], ['monospace-font-name', 's'], ['text-scaling-factor', 'd'],
];
// Closest GNOME accent for apps that only know the system accent enum.
const SYSTEM_ACCENT = {
    blue: 'blue', lavender: 'blue', slate: 'slate', teal: 'teal',
    sage: 'green', peach: 'orange', rose: 'pink',
};

export default class AppearanceModule extends Module {
    enable() {
        this._iface = new Gio.Settings({schema_id: IFACE});
        this._tokens = JSON.parse(Files.readText(`${this.ext.path}/tokens.json`));
        this._adwGtk3 = this._findAdwGtk3();
        this._shellSheet = null;
        this._shellSource = null;
        this._serial = 0;
        this._saveOriginal();

        this.connect(this.settings, 'changed', () => this.later('apply', 150, () => this._applyAll()));
        this.connect(this._iface, 'changed::color-scheme', () => this._applyAll());
        // Ubuntu's Appearance panel writes Yaru-* here; keep ours while active.
        this.connect(this._iface, 'changed::gtk-theme', () => {
            this.later('theme', 300, () => this._applyGtkTheme());
            // Other tools (Kiwi) rewrite gtk.css on theme changes too; if one
            // raced us and dropped our block, put it back.
            this.later('gtk-verify', 2000, () => this._applyGtk());
        });
        this.connect(St.ThemeContext.get_for_stage(global.stage), 'changed', () => {
            if (this._currentShellSource() !== this._shellSource)
                this.later('shell', 100, () => this._applyShell());
        });
        this._applyAll();
    }

    disable() {
        this.cleanup();
        this._unloadShell();
        Files.setManagedBlock(GTK4_MAIN, null);
        Files.remove(GTK4_FILE);
        St.Settings.get().slow_down_factor = 1.0;
        this._restoreOriginal();
        this._iface = null;
    }

    get _dark() {
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    _opts() {
        const s = this.settings;
        return {
            palette: s.get_string('palette'),
            accent: s.get_string('accent'),
            windowButtons: s.get_string('window-buttons'),
            windowRadius: s.get_int('window-radius'),
            sidebarStyle: s.get_string('sidebar-style'),
            titleWeight: s.get_int('title-weight'),
        };
    }

    _applyAll() {
        this._applyGtk();
        this._applyShell();
        this._applyFonts();
        this._applyMotion();
        this._applySystemAccent();
    }

    /* ---------------------------------------------------------- GTK -- */

    _applyGtk() {
        if (!this.settings.get_boolean('theme-gtk')) {
            Files.setManagedBlock(GTK4_MAIN, null);
            Files.remove(GTK4_FILE);
            this._setIface('gtk-theme', this._original()['gtk-theme'] ?? 'Adwaita');
            return;
        }
        const opts = this._opts();
        Files.remove(GTK4_FILE);
        Files.setManagedBlock(GTK4_MAIN, Gen.gtk4Css(this._tokens, opts, this._appFixes(4)).trim(), {atEnd: true});

        let gtk3Changed = false;
        if (this._adwGtk3) {
            for (const [name, dark] of [[THEME, false], [THEME_DARK, true]]) {
                const dir = `${Files.DATA}/themes/${name}`;
                const base = `${this._adwGtk3}${dark ? '-dark' : ''}/gtk-3.0/gtk.css`;
                const changed = Files.writeText(`${dir}/gtk-3.0/gtk.css`, Gen.gtk3Css(this._tokens, opts, dark, base, this._appFixes(3)));
                Files.writeText(`${dir}/index.theme`, Gen.gtkThemeIndex(name));
                gtk3Changed ||= changed && dark === this._dark;
            }
        }
        this._applyGtkTheme(gtk3Changed);
    }

    _applyGtkTheme(forceReload = false) {
        if (!this.settings.get_boolean('theme-gtk') || !this._adwGtk3)
            return;
        const wanted = this._dark ? THEME_DARK : THEME;
        if (forceReload && this._iface.get_string('gtk-theme') === wanted) {
            // GTK3 only re-reads a theme when its name changes.
            this._setIface('gtk-theme', this._dark ? THEME : THEME_DARK);
            this.later('theme-reload', 50, () => this._setIface('gtk-theme', wanted));
            return;
        }
        this._setIface('gtk-theme', wanted);
    }

    // Kiwi's per-app fix-ups (Nautilus, Geary, menus...), inlined so snaps
    // and Flatpaks see them; its window-button rules are ours to decide.
    _appFixes(version) {
        const css = Files.readText(`${this.ext.path}/vendor/windows/css/fixes${version}.css`);
        return css ? Gen.withoutRules(css, ['windowcontrols', 'titlebutton']) : '';
    }

    _findAdwGtk3() {
        for (const dir of [`${Files.DATA}/themes`, `${Files.HOME}/.themes`, '/usr/share/themes']) {
            if (GLib.file_test(`${dir}/adw-gtk3/gtk-3.0/gtk.css`, GLib.FileTest.EXISTS))
                return `${dir}/adw-gtk3`;
        }
        console.warn('ubuntu-plus: adw-gtk3 not found, GTK3 apps keep their theme');
        return null;
    }

    /* -------------------------------------------------------- Shell -- */

    // The session's theme (Yaru, Adwaita) is the default stylesheet; a
    // user-theme extension adds an application stylesheet on top; other
    // extensions add custom stylesheets. All of them may use the accent.
    _themeSheets() {
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        if (!theme)
            return [];
        const ours = this._shellSheet?.get_uri();
        const custom = (theme.get_custom_stylesheets() ?? []).filter(f => f.get_uri() !== ours);
        return [theme.default_stylesheet, theme.application_stylesheet, ...custom].filter(Boolean);
    }

    _currentShellSource() {
        return this._themeSheets().map(f => f.get_uri()).join(' ');
    }

    _applyShell() {
        this._unloadShell();
        if (!this.settings.get_boolean('theme-shell'))
            return;
        const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        const sheets = this._themeSheets();
        this._shellSource = this._currentShellSource();
        const css = Gen.shellCss(this._tokens, this._opts(), this._dark, sheets.map(f => Files.readFile(f)).join('\n'));
        // A fresh file name each time, so St never serves a cached sheet.
        const path = `${Files.CACHE}/shell-${GLib.get_monotonic_time()}-${this._serial++}.css`;
        Files.writeText(path, css);
        this._shellSheet = Gio.File.new_for_path(path);
        theme.load_stylesheet(this._shellSheet);
    }

    _unloadShell() {
        if (!this._shellSheet)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme()?.unload_stylesheet(this._shellSheet);
        Files.remove(this._shellSheet.get_path());
        this._shellSheet = null;
    }

    /* ------------------------------------------------ Fonts, motion -- */

    _applyFonts() {
        if (!this.settings.get_boolean('manage-fonts'))
            return;
        this._setIface('font-name', this.settings.get_string('font-interface'));
        this._setIface('document-font-name', this.settings.get_string('font-document'));
        this._setIface('monospace-font-name', this.settings.get_string('font-monospace'));
        const scale = this.settings.get_double('text-scaling');
        if (Math.abs(this._iface.get_double('text-scaling-factor') - scale) > 0.001)
            this._iface.set_double('text-scaling-factor', scale);
    }

    _applyMotion() {
        const speed = this.settings.get_double('animation-speed');
        // Reduced motion keeps animations short; modules swap movement for fades.
        St.Settings.get().slow_down_factor = this.settings.get_boolean('reduce-motion') ? Math.min(speed, 0.7) : speed;
    }

    _applySystemAccent() {
        if (!this.settings.get_boolean('sync-system-accent'))
            return;
        const pal = this._tokens.palettes[this.settings.get_string('palette')];
        let key = this.settings.get_string('accent');
        if (key === 'auto' || !this._tokens.accents[key])
            key = pal?.defaultAccent ?? 'blue';
        this._setIface('accent-color', SYSTEM_ACCENT[key] ?? 'blue');
    }

    /* ------------------------------------------------ Saved settings -- */

    _setIface(key, value) {
        if (this._iface.get_string(key) !== value)
            this._iface.set_string(key, value);
    }

    _original() {
        const text = Files.readText(ORIGINAL);
        return text ? JSON.parse(text) : {};
    }

    _saveOriginal() {
        if (Files.readText(ORIGINAL))
            return;
        const saved = {};
        for (const [key, type] of SAVED_KEYS)
            saved[key] = type === 'd' ? this._iface.get_double(key) : this._iface.get_string(key);
        Files.writeText(ORIGINAL, JSON.stringify(saved, null, 2));
    }

    _restoreOriginal() {
        const saved = this._original();
        for (const [key, type] of SAVED_KEYS) {
            if (!(key in saved))
                continue;
            if (type === 'd')
                this._iface.set_double(key, saved[key]);
            else
                this._iface.set_string(key, saved[key]);
        }
        Files.remove(ORIGINAL);
    }
}
