// SPDX-License-Identifier: GPL-3.0-or-later
// Ubuntu Plus: one extension, many independent modules. Each module is
// started and stopped on its own; one that throws is switched off and
// reported, and the rest keep running. Modules start in the order listed
// (the dock comes before the engines that attach to it).

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import AppearanceModule from './modules/appearance.js';
import PanelModule from './modules/panel.js';
import GlassModule from './modules/glass.js';
import {engine} from './lib/engine.js';
import {configureDock, configureDockMotion} from './lib/dockStyle.js';
import {configureBlur} from './lib/blurSetup.js';

export const MODULES = {
    appearance: AppearanceModule,
    corners: engine('corners', 'rounded-window-corners@fxgn'),
    dock: engine('dock', 'dash-to-dock@micxgx.gmail.com', ['dash-to-dock@micxgx.gmail.com', 'ubuntu-dock@ubuntu.com'], {
        configure() {
            configureDock(this);
        },
    }),
    dockmotion: engine('dockmotion', 'flourish@orsso.github.io', ['flourish@orsso.github.io'], {
        configure() {
            configureDockMotion(this);
        },
    }),
    // Legacy: Ubuntu Plus glass replaces it, so turning it off never brings
    // Blur my Shell back.
    blur: Object.assign(engine('blur', 'blur-my-shell@aunetx', ['blur-my-shell@aunetx'], {
        configure() {
            configureBlur(this);
        },
    }), {noHandBack: true}),
    // Window buttons belong to the appearance module, so Kiwi's own
    // (traffic-light) button CSS stays off.
    windows: engine('windows', 'kiwi@kemma', ['kiwi@kemma'], {
        configure() {
            const s = this.instance.getSettings();
            // popup-menu-styling also imports Kiwi's GTK fix-ups from inside
            // the extension folder, which snaps and Flatpaks can't read; the
            // appearance module inlines those fix-ups instead.
            for (const key of ['enable-app-window-buttons', 'show-window-controls', 'popup-menu-styling'])
                if (s.get_boolean(key))
                    s.set_boolean(key, false);
        },
    }),
    panel: PanelModule,
    glass: GlassModule,
    hotcorners: engine('hotcorners', 'custom-hot-corners-extended@G-dH.github.com'),
    gestures: engine('gestures', 'touchpad-gesture-customization@coooolapps.com'),
    launcher: engine('launcher', 'superbar@Furkan-rgb.github.io'),
};

export default class UbuntuPlus extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._active = new Map();
        this._queue = Promise.resolve();
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key.startsWith('module-') || key === 'broken-modules')
                this._sync();
        });
        this._sessionId = Main.sessionMode.connect('updated', () => this._sync());
        this._sync();
    }

    disable() {
        this._settings.disconnect(this._settingsId);
        Main.sessionMode.disconnect(this._sessionId);
        for (const name of [...this._active.keys()].reverse())
            this._stop(name);
        this._active = null;
        this._settings = null;
    }

    // Called by modules when something fails after start-up, e.g. in a
    // signal handler after a GNOME update changed an internal API.
    reportError(name, error) {
        console.error(`ubuntu-plus: module "${name}" failed`, error);
        if (!this._active?.has(name))
            return;
        this._stop(name);
        const broken = new Set(this._settings.get_strv('broken-modules'));
        broken.add(name);
        this._settings.set_strv('broken-modules', [...broken]);
        Main.notify('Ubuntu Plus',
            `The ${name} module hit an error and was switched off. Turn it back on in Ubuntu Plus settings.`);
    }

    // Engines whose original extension ran earlier in this session wait for
    // the next login; tell the user once.
    notePendingLogout(name) {
        this._pending ??= new Set();
        if (this._pending.has(name))
            return;
        this._pending.add(name);
        if (this._pendingNotified)
            return;
        this._pendingNotified = true;
        Main.notify('Ubuntu Plus',
            'Log out and back in once to finish switching from your old extensions to Ubuntu Plus.');
    }

    _wanted(name, Module) {
        if (!this._settings.get_boolean(`module-${name}`))
            return false;
        if (this._settings.get_strv('broken-modules').includes(name))
            return false;
        if (Main.sessionMode.isLocked && Module.runsWhenLocked && !Module.runsWhenLocked(this.path))
            return false;
        return true;
    }

    // Starts and stops run one after another: engines import code
    // asynchronously, and later modules depend on earlier ones.
    _sync() {
        this._queue = this._queue.then(async () => {
            if (!this._active)
                return;
            const entries = Object.entries(MODULES);
            for (const [name, Module] of [...entries].reverse()) {
                if (this._active.has(name) && !this._wanted(name, Module))
                    this._stop(name);
            }
            for (const [name, Module] of entries) {
                if (this._active && !this._active.has(name) && this._wanted(name, Module))
                    await this._start(name, Module);
            }
        }).catch(e => console.error('ubuntu-plus: module sync failed', e));
    }

    async _start(name, Module) {
        const module = new Module(this, name);
        this._active.set(name, module);
        try {
            await module.enable();
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
            console.error(`ubuntu-plus: module "${name}" failed to stop`, e);
        }
    }
}
