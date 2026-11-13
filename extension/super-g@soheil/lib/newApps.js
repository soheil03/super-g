// SPDX-License-Identifier: GPL-3.0-or-later
// Newly installed apps: the dock lists them first for a few days. The first
// time an app is seen is recorded (not read from the .desktop file, whose
// mtime moves with updates); on the first run every installed app counts as
// old, so nothing floods the dock.

import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import * as Files from './files.js';

const FILE = `${Files.STATE}/new-apps.json`;
const DAY = 86400000;

export class NewApps {
    constructor(module, onChange) {
        this._module = module;
        this._onChange = onChange;
        this._seen = null;
        this._expiry = 0;
    }

    enable() {
        const system = Shell.AppSystem.get_default();
        const saved = Files.readText(FILE);
        this._seen = saved ? (JSON.parse(saved).seen ?? {}) : null;
        this._scan(true);
        this._id = system.connect('installed-changed', () => this._module.guard(() => this._scan(false)));
        this._system = system;
        globalThis.superGNewApps = () => this.apps();
        this._arm();
    }

    disable() {
        if (this._id)
            this._system.disconnect(this._id);
        this._id = 0;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        delete globalThis.superGNewApps;
    }

    _scan(initial) {
        const ids = Shell.AppSystem.get_default().get_installed()
            .filter(a => a.should_show()).map(a => a.get_id());
        const first = this._seen === null;
        this._seen ??= {};
        let changed = false;
        for (const id of ids) {
            if (id in this._seen)
                continue;
            this._seen[id] = first ? 0 : Date.now();
            changed = true;
        }
        if (changed) {
            Files.writeText(FILE, JSON.stringify({seen: this._seen}));
            if (!initial) {
                this._arm();
                this._onChange();
            }
        }
    }

    _days() {
        return this._module.settings.get_int('dock-new-apps-days');
    }

    apps() {
        const s = this._module.settings;
        if (!s.get_boolean('dock-new-apps') || !this._seen)
            return [];
        const limit = Date.now() - this._days() * DAY;
        const system = Shell.AppSystem.get_default();
        return Object.entries(this._seen)
            .filter(([, t]) => t > limit)
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => system.lookup_app(id))
            .filter(a => a);
    }

    // One timer for the next expiry, so the dock lets go of an app on time
    // without polling.
    _arm() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        const span = this._days() * DAY;
        const times = Object.values(this._seen ?? {}).filter(t => t > Date.now() - span);
        if (!times.length)
            return;
        const wait = Math.max(1000, Math.min(...times) + span - Date.now() + 1000);
        // GLib timers cap near 24 days; 3 days is far below, but a long span isn't.
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.min(wait, 2 ** 31 - 1), () => {
            this._timer = 0;
            this._module.guard(() => {
                this._onChange();
                this._arm();
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    refresh() {
        this._arm();
        this._onChange();
    }
}
