// SPDX-License-Identifier: GPL-3.0-or-later
// Base class for modules: tracks signals and timers so disable() can always
// clean up, and routes errors from callbacks to the extension's kill switch.

import GLib from 'gi://GLib';

export class Module {
    constructor(ext, name) {
        this.ext = ext;
        this.name = name;
        this.settings = ext.getSettings();
        this._signals = [];
        this._timers = new Map();
    }

    connect(obj, signal, fn) {
        const id = obj.connect(signal, (...args) => this.guard(() => fn(...args)));
        this._signals.push([obj, id]);
        return id;
    }

    guard(fn) {
        try {
            return fn();
        } catch (e) {
            this.ext.reportError(this.name, e);
            return undefined;
        }
    }

    // Run `fn` once after `ms`, restarting the wait if called again with the
    // same key (debounce).
    later(key, ms, fn) {
        if (this._timers.has(key))
            GLib.source_remove(this._timers.get(key));
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(key);
            this.guard(fn);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.set(key, id);
    }

    cleanup() {
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        for (const id of this._timers.values())
            GLib.source_remove(id);
        this._timers.clear();
    }
}
