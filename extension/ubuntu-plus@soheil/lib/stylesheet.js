// SPDX-License-Identifier: GPL-3.0-or-later
// A shell stylesheet generated at runtime: set() swaps the old sheet for the
// new one, clear() removes it. Each version gets a fresh file name so St
// never serves a cached copy.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Files from './files.js';

let serial = 0;

export class LiveStylesheet {
    constructor(name) {
        this._name = name;
        this._file = null;
        this._css = null;
    }

    set(css) {
        if (css === this._css && this._file)
            return;
        this.clear();
        this._css = css;
        const path = `${Files.CACHE}/${this._name}-${GLib.get_monotonic_time()}-${serial++}.css`;
        Files.writeText(path, css);
        this._file = Gio.File.new_for_path(path);
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._file);
    }

    clear() {
        if (!this._file)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme()?.unload_stylesheet(this._file);
        Files.remove(this._file.get_path());
        this._file = null;
        this._css = null;
    }

    get uri() {
        return this._file?.get_uri() ?? null;
    }
}

// Settings of a vendored engine, which live in our own compiled schemas.
export function engineSettings(extPath, vendor) {
    const source = Gio.SettingsSchemaSource.new_from_directory(`${extPath}/schemas`,
        Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(`org.gnome.shell.extensions.ubuntu-plus.${vendor}`, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

export function engineChildSettings(extPath, vendor, child) {
    const source = Gio.SettingsSchemaSource.new_from_directory(`${extPath}/schemas`,
        Gio.SettingsSchemaSource.get_default(), false);
    const schema = source.lookup(`org.gnome.shell.extensions.ubuntu-plus.${vendor}.${child}`, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}
