// SPDX-License-Identifier: GPL-3.0-or-later
// Unified Shell: one extension, many independent modules. Each module is
// started and stopped on its own; one that throws is switched off and
// reported, and the rest keep running.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import AppearanceModule from './modules/appearance.js';

const MODULES = {
    appearance: AppearanceModule,
};

export default class UnifiedShell extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._active = new Map();
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key.startsWith('module-') || key === 'broken-modules')
                this._sync();
        });
        this._sync();
    }

    disable() {
        this._settings.disconnect(this._settingsId);
        for (const name of [...this._active.keys()].reverse())
            this._stop(name);
        this._active = null;
        this._settings = null;
    }

    // Called by modules when something fails after start-up, e.g. in a
    // signal handler after a GNOME update changed an internal API.
    reportError(name, error) {
        console.error(`unified-shell: module "${name}" failed`, error);
        if (!this._active?.has(name))
            return;
        this._stop(name);
        const broken = new Set(this._settings.get_strv('broken-modules'));
        broken.add(name);
        this._settings.set_strv('broken-modules', [...broken]);
        Main.notify('Unified Shell',
            `The ${name} module hit an error and was switched off. Turn it back on in Unified Shell settings.`);
    }

    _sync() {
        const broken = new Set(this._settings.get_strv('broken-modules'));
        for (const [name, Module] of Object.entries(MODULES)) {
            const wanted = this._settings.get_boolean(`module-${name}`) && !broken.has(name);
            if (wanted && !this._active.has(name))
                this._start(name, Module);
            else if (!wanted && this._active.has(name))
                this._stop(name);
        }
    }

    _start(name, Module) {
        const module = new Module(this, name);
        this._active.set(name, module);
        try {
            module.enable();
        } catch (e) {
            this.reportError(name, e);
        }
    }

    _stop(name) {
        const module = this._active.get(name);
        this._active.delete(name);
        try {
            module.disable();
        } catch (e) {
            console.error(`unified-shell: module "${name}" failed to stop`, e);
        }
    }
}
