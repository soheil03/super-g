// SPDX-License-Identifier: GPL-3.0-or-later
// Newly installed apps, shared by the drawer (a "New" section) and, when the
// user asks for it, the dock. The first time an app is seen is recorded (not
// read from the .desktop file, whose mtime moves with updates); on the first
// run every installed app counts as old, so nothing floods either.

import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import * as Files from './files.js';

const FILE = `${Files.STATE}/new-apps.json`;
const DAY = 86400000;
// GLib timers overflow past about 24 days.
const MAX_TIMER_MS = 2 ** 31 - 1;

let shared = null;

// One tracker for every user; it lives while anyone holds it.
export function holdNewApps(settings) {
    shared ??= new NewApps(settings);
    shared.users++;
    return shared;
}

export function releaseNewApps() {
    if (!shared || --shared.users > 0)
        return;
    shared.destroy();
    shared = null;
}

class NewApps {
    constructor(settings) {
        this.users = 0;
        this._settings = settings;
        this._listeners = new Set();
        const saved = Files.readText(FILE);
        try {
            this._seen = saved ? (JSON.parse(saved).seen ?? {}) : null;
        } catch {
            this._seen = null;
        }
        this._scan();
        this._system = Shell.AppSystem.get_default();
        this._installedId = this._system.connect('installed-changed', () => this._safely(() => this._scan()));
        this._daysId = settings.connect('changed::new-apps-days', () => this._safely(() => this._changed()));
        this._arm();
    }

    destroy() {
        this._system.disconnect(this._installedId);
        this._settings.disconnect(this._daysId);
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._listeners.clear();
    }

    // Called when the list changes: an install, an app ageing out, a new span.
    subscribe(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    // Newest first.
    apps() {
        if (!this._seen)
            return [];
        const since = Date.now() - this._span();
        const system = Shell.AppSystem.get_default();
        return Object.entries(this._seen)
            .filter(([, t]) => t > since)
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => system.lookup_app(id))
            .filter(app => app && (app.get_app_info()?.should_show?.() ?? true));
    }

    _safely(fn) {
        try {
            fn();
        } catch (e) {
            console.error('super-g: new apps', e);
        }
    }

    _span() {
        return this._settings.get_int('new-apps-days') * DAY;
    }

    _scan() {
        const ids = Shell.AppSystem.get_default().get_installed()
            .filter(info => info.should_show()).map(info => info.get_id());
        const first = this._seen === null;
        const seen = {...this._seen};
        const added = ids.filter(id => !(id in seen));
        for (const id of added)
            seen[id] = first ? 0 : Date.now();
        if (!added.length && !first)
            return;
        this._seen = seen;
        Files.writeText(FILE, JSON.stringify({seen}));
        if (!first && added.length)
            this._changed();
    }

    _changed() {
        this._arm();
        for (const fn of this._listeners)
            this._safely(fn);
    }

    // One timer for the next app to age out, so nothing polls.
    _arm() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        const span = this._span();
        const now = Date.now();
        const live = Object.values(this._seen ?? {}).filter(t => t > now - span);
        if (!live.length)
            return;
        const wait = Math.max(1000, Math.min(...live) + span - now + 1000);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.min(wait, MAX_TIMER_MS), () => {
            this._timer = 0;
            this._safely(() => this._changed());
            return GLib.SOURCE_REMOVE;
        });
    }
}
