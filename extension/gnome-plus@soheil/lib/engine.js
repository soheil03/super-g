// SPDX-License-Identifier: GPL-3.0-or-later
// Runs a vendored upstream extension (vendor/<name>) as an GNOME Plus module.
//
// The engine is the upstream Extension class, constructed with its own
// metadata but pointing at vendor/<name> and at our renamed schema. While it
// runs, Main.extensionManager.lookup(<upstream uuid>) answers with a stand-in
// for it, so engines that look each other up (Flourish → Dash to Dock,
// Kiwi → Dash to Dock) still find one another. The original extension, if
// installed and enabled, is switched off while the engine runs and switched
// back on when the module is turned off.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {Module} from './module.js';
import * as Files from './files.js';

const HANDOVER = `${Files.STATE}/handover.json`;

/* ------------------------------------------------ lookup stand-ins -- */

const standIns = new Map();
let originalLookup = null;

function installLookup() {
    if (originalLookup)
        return;
    const manager = Main.extensionManager;
    originalLookup = manager.lookup;
    manager.lookup = function (uuid) {
        const real = originalLookup.call(this, uuid);
        if (real?.state === ExtensionState.ACTIVE)
            return real;
        return standIns.get(uuid) ?? real;
    };
}

function uninstallLookup() {
    if (!originalLookup || standIns.size)
        return;
    Main.extensionManager.lookup = originalLookup;
    originalLookup = null;
}

const LOADED = [ExtensionState.ACTIVE, ExtensionState.INACTIVE, ExtensionState.ERROR,
    ExtensionState.DEACTIVATING, ExtensionState.ACTIVATING].filter(s => s !== undefined);

function loadedThisSession(uuid) {
    const real = (originalLookup ?? Main.extensionManager.lookup).call(Main.extensionManager, uuid);
    return !!real && LOADED.includes(real.state);
}

/* ------------------------------------------------------- handover -- */

function readHandover() {
    const text = Files.readText(HANDOVER);
    return text ? JSON.parse(text) : {};
}

function writeHandover(data) {
    Files.writeText(HANDOVER, JSON.stringify(data, null, 2));
}

function run(argv, input = null) {
    return new Promise((resolve, reject) => {
        const flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE |
            (input === null ? 0 : Gio.SubprocessFlags.STDIN_PIPE);
        const proc = Gio.Subprocess.new(argv, flags);
        proc.communicate_utf8_async(input, null, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                resolve(out ?? '');
            } catch (e) {
                reject(e);
            }
        });
    });
}

/* --------------------------------------------------------- engine -- */

export class Engine extends Module {
    // Subclasses set: vendor (folder name), uuid (upstream uuid it stands in
    // for), replaces (upstream uuids to switch off while running).
    static vendor = '';
    static uuid = '';
    static replaces = [];

    // Upstream extensions that don't ask for the lock screen are stopped
    // while it is up, as GNOME would do for them.
    static runsWhenLocked(extPath) {
        const text = Files.readText(`${extPath}/vendor/${this.vendor}/upstream-metadata.json`);
        return (JSON.parse(text ?? '{}')['session-modes'] ?? []).includes('unlock-dialog');
    }

    async enable() {
        const {vendor, uuid, replaces} = this.constructor;
        const path = `${this.ext.path}/vendor/${vendor}`;
        const generation = this._generation = (this._generation ?? 0) + 1;

        this._handOver(replaces);
        await this._migrateSettings(path);
        if (generation !== this._generation)
            return;
        // An original that already ran in this session registered the same
        // GObject types the engine would; the engine can only start after
        // the next login, when the original no longer loads.
        if (replaces.some(loadedThisSession)) {
            this.ext.notePendingLogout?.(this.name);
            return;
        }

        const metadata = JSON.parse(Files.readText(`${path}/upstream-metadata.json`));
        Object.assign(metadata, {
            uuid,
            path,
            dir: Gio.File.new_for_path(path),
            'settings-schema': `org.gnome.shell.extensions.gnome-plus.${vendor}`,
        });

        const {default: UpstreamExtension} = await import(`file://${path}/extension.js`);
        if (generation !== this._generation)
            return; // disabled while importing

        this.instance = new UpstreamExtension(metadata);
        this._standIn = {
            uuid, path, metadata, dir: metadata.dir, type: 2,
            state: ExtensionState.ACTIVE, stateObj: this.instance, error: '', hasPrefs: false,
            sessionModes: metadata['session-modes'] ?? ['user'],
        };
        installLookup();
        standIns.set(uuid, this._standIn);

        this._loadStylesheet(`${path}/stylesheet.css`);
        this.instance.enable();
        this.configure?.();
    }

    disable() {
        this._generation = (this._generation ?? 0) + 1;
        this.cleanup();
        this.cleanupExtra?.();
        if (this.instance) {
            try {
                this.instance.disable();
            } finally {
                this.instance = null;
            }
        }
        this._unloadStylesheet();
        if (this._standIn) {
            this._standIn.state = ExtensionState.INACTIVE;
            standIns.delete(this.constructor.uuid);
            this._standIn = null;
        }
        uninstallLookup();
        // Engines whose job another GNOME Plus module took over (blur → glass)
        // must not bring the original back.
        // A crash doesn't either: the original can't load next to the engine's
        // types in this session, and the next login retries the module.
        if (!this.constructor.noHandBack && !this.crashed)
            this._handBack(this.constructor.replaces);
    }

    // First run: copy the original extension's settings (dconf tree) into
    // ours, so the engine starts with the user's existing tuning.
    async _migrateSettings(path) {
        const state = readHandover();
        state.migrated ??= {};
        if (state.migrated[this.constructor.vendor])
            return;
        const info = Files.readText(`${path}/UPSTREAM`) ?? '';
        const m = info.match(/^dconf: (\S+) -> (\S+)$/m);
        if (m) {
            const [, from, to] = m;
            const ours = await run(['dconf', 'dump', to]);
            if (!ours.trim()) {
                const theirs = await run(['dconf', 'dump', from]);
                if (theirs.trim())
                    await run(['dconf', 'load', to], theirs);
            }
        }
        state.migrated[this.constructor.vendor] = true;
        writeHandover(state);
    }

    _loadStylesheet(path) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return;
        this._sheet = Gio.File.new_for_path(path);
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._sheet);
    }

    _unloadStylesheet() {
        if (!this._sheet)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme()?.unload_stylesheet(this._sheet);
        this._sheet = null;
    }

    _handOver(uuids) {
        handOver(this.name, uuids);
    }

    _handBack(uuids) {
        handBack(this.name, uuids);
    }
}

// Switch off the originals a module replaces, remembering which ones were on.
export function handOver(moduleName, uuids) {
    const state = readHandover();
    const manager = Main.extensionManager;
    for (const uuid of uuids) {
        const real = (originalLookup ?? manager.lookup).call(manager, uuid);
        if (real && real.state === ExtensionState.ACTIVE) {
            manager.disableExtension(uuid);
            state[uuid] = moduleName;
        }
    }
    writeHandover(state);
}

// Turn originals back on, but only if we were the ones who turned them off.
export function handBack(moduleName, uuids) {
    if (Main.sessionMode.isLocked)
        return;
    const state = readHandover();
    for (const uuid of uuids) {
        if (state[uuid] !== moduleName)
            continue;
        delete state[uuid];
        Main.extensionManager.enableExtension(uuid);
    }
    writeHandover(state);
}

// Declare an engine module in one line.
export function engine(vendor, uuid, replaces = [uuid], extra = {}) {
    const cls = class extends Engine {};
    Object.assign(cls, {vendor, uuid, replaces});
    Object.assign(cls.prototype, extra);
    return cls;
}
