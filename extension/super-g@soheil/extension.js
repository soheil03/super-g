// SPDX-License-Identifier: GPL-3.0-or-later
// Super G: one extension, many independent modules. Each module is
// started and stopped on its own; one that throws is switched off and
// reported, and the rest keep running. Modules start in the order listed
// (the dock comes before the engines that attach to it).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import AppearanceModule from './modules/appearance.js';
import PanelModule from './modules/panel.js';
import GlassModule from './modules/glass.js';
import DrawerModule from './modules/drawer.js';
import {engine} from './lib/engine.js';
import {configureDock, configureDockMotion, onceOnly} from './lib/dockStyle.js';
import {configureBlur} from './lib/blurSetup.js';
import {configureCorners} from './lib/cornersSetup.js';

export const HOT_CORNERS = {
    'monitor-0-bottom-left-0': {action: 'show-overview', 'barrier-size-h': 1, fullscreen: true},
    'monitor-0-bottom-left-6': {action: 'show-desktop-mon', ctrl: true},
};

const MODULES = {
    appearance: AppearanceModule,
    corners: engine('corners', 'rounded-window-corners@fxgn', ['rounded-window-corners@fxgn'], {
        configure() {
            configureCorners(this);
        },
    }),
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
    // Legacy: Super G glass replaces it, so turning it off never brings
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
    // WACK only exists on the lock screen, as upstream declares.
    lockscreen: Object.assign(engine('lockscreen', 'wack-lockscreen-clock@rinzler69-wastaken.github.com',
        ['wack-lockscreen-clock@rinzler69-wastaken.github.com']), {onlyWhenLocked: true}),
    panel: PanelModule,
    glass: GlassModule,
    drawer: DrawerModule,
    hotcorners: engine('hotcorners', 'custom-hot-corners-extended@G-dH.github.com', ['custom-hot-corners-extended@G-dH.github.com'], {
        configure() {
            // Corners live on paths of their own, so a schema can't give them defaults.
            onceOnly('hotcorners-defaults', () => {
                const source = Gio.SettingsSchemaSource.new_from_directory(`${this.ext.path}/schemas`,
                    Gio.SettingsSchemaSource.get_default(), false);
                const schema = source.lookup('org.gnome.shell.extensions.super-g.hotcorners.corner', false);
                for (const [corner, values] of Object.entries(HOT_CORNERS)) {
                    const settings = new Gio.Settings({settings_schema: schema,
                        path: `/org/gnome/shell/extensions/super-g/hotcorners/${corner}/`});
                    if (settings.get_user_value('action'))
                        continue;
                    for (const [key, value] of Object.entries(values))
                        settings.set_value(key, new GLib.Variant(settings.get_value(key).get_type_string(), value));
                }
            });
        },
    }),
    gestures: engine('gestures', 'touchpad-gesture-customization@coooolapps.com'),
    launcher: engine('launcher', 'superbar@Furkan-rgb.github.io', ['superbar@Furkan-rgb.github.io'], {
        configure() {
            this.ext._active.get('glass')?.attachLauncher();
            // Its shortcut clashes with one GNOME sets by default, and it asks
            // with a dialog at first login. Take it, as that dialog's default
            // does; its own preferences can put the old one back.
            onceOnly('launcher-shortcut', () => {
                const engineSettings = this.instance.getSettings();
                const [accel] = engineSettings.get_strv('toggle-shortcut');
                if (!engineSettings.get_string('conflict-prompt-accel') && accel) {
                    engineSettings.set_string('conflict-prompt-accel', accel);
                    this.instance._claimShortcut?.();
                }
            });
        },
    }),
};

// Extensions that clash with a module (null: clash with the desktop as a whole).
// One that a turned-off module would hand back is not a conflict.
const CONFLICTS = {
    'rounded-window-corners@fxgn': 'corners',
    'rounded-windows@marcosgt.github.io': 'corners',
    'dash-to-dock@micxgx.gmail.com': 'dock',
    'ubuntu-dock@ubuntu.com': 'dock',
    'dhruva@narkagni': 'dock',
    'flourish@orsso.github.io': 'dockmotion',
    'blur-my-shell@aunetx': 'glass',
    'kiwi@kemma': 'windows',
    'just-perfection-desktop@just-perfection': 'panel',
    'panel-corners@aunetx': 'panel',
    'vertical-workspaces@G-dH.github.com': null,
    'custom-hot-corners-extended@G-dH.github.com': 'hotcorners',
    'touchpad-gesture-customization@coooolapps.com': 'gestures',
    'superbar@Furkan-rgb.github.io': 'launcher',
    'wack-lockscreen-clock@rinzler69-wastaken.github.com': 'lockscreen',
};

export default class SuperG extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._active = new Map();
        this._queue = Promise.resolve();
        // The kill switch lasts one session: a failure in one login (a bad
        // lock cycle, say) must not silently cost the user a module for good.
        this._settings.reset('broken-modules');
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            if (key.startsWith('module-') || key === 'broken-modules')
                this._sync();
        });
        this._sessionId = Main.sessionMode.connect('updated', () => this._sync());
        this._conflictsId = global.settings.connect('changed::enabled-extensions', () => this._checkConflicts());
        this._sync();
        this._checkConflicts();
    }

    /* ----------------------------------------------------- conflicts -- */

    _conflicting() {
        const enabled = global.settings.get_strv('enabled-extensions');
        return Object.entries(CONFLICTS).filter(([uuid, module]) => {
            if (module && !this._settings.get_boolean(`module-${module}`))
                return false;
            return enabled.includes(uuid);
        }).map(([uuid]) => uuid);
    }

    _checkConflicts() {
        const uuids = this._conflicting();
        if (!uuids.length || this._checking)
            return;
        // Switching one off below changes the list we're watching.
        this._checking = true;
        const names = uuids.map(uuid => Main.extensionManager.lookup(uuid)?.metadata?.name ?? uuid);
        if (this._settings.get_boolean('conflicts-auto-off')) {
            this._switchOff(uuids);
            this._tell(`Switched off ${names.join(', ')}: they clash with this extension. Log out once to finish.`);
        } else if (!uuids.every(uuid => this._asked?.has(uuid))) {
            this._asked = new Set([...(this._asked ?? []), ...uuids]);
            this._tell(`${names.join(', ')} clash with this extension.`,
                ['Switch them off', () => {
                    this._switchOff(this._conflicting());
                    this._tell('Done. Log out once to finish.');
                }]);
        }
        this._checking = false;
    }

    _switchOff(uuids) {
        for (const uuid of uuids)
            Main.extensionManager.disableExtension(uuid);
    }

    _tell(body, action = null) {
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({source, title: 'Super G', body});
        if (action)
            notification.addAction(...action);
        source.addNotification(notification);
    }

    disable() {
        this._settings.disconnect(this._settingsId);
        Main.sessionMode.disconnect(this._sessionId);
        global.settings.disconnect(this._conflictsId);
        for (const name of [...this._active.keys()].reverse())
            this._stop(name);
        this._active = null;
        this._settings = null;
    }

    // Called by modules when something fails after start-up, e.g. in a
    // signal handler after a GNOME update changed an internal API.
    reportError(name, error) {
        console.error(`super-g: module "${name}" failed`, error);
        const module = this._active?.get(name);
        if (!module)
            return;
        module.crashed = true;
        this._stop(name);
        const broken = new Set(this._settings.get_strv('broken-modules'));
        broken.add(name);
        this._settings.set_strv('broken-modules', [...broken]);
        Main.notify('Super G',
            `The ${name} module hit an error and was switched off. It will be tried again at the next login.`);
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
        Main.notify('Super G',
            'Log out and back in once to finish switching from your old extensions to Super G.');
    }

    _wanted(name, Module) {
        if (!this._settings.get_boolean(`module-${name}`))
            return false;
        if (this._settings.get_strv('broken-modules').includes(name))
            return false;
        if (Main.sessionMode.isLocked && Module.runsWhenLocked && !Module.runsWhenLocked(this.path))
            return false;
        if (Module.onlyWhenLocked && !Main.sessionMode.isLocked)
            return false;
        // The dock stops on the lock screen; what attached to it goes first.
        if (Main.sessionMode.isLocked && Module.needsDock)
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
            // The dock is back (after a lock, say): whatever attached to the
            // old one restarts after it.
            if (!this._active.has('dock') && this._wanted('dock', MODULES.dock)) {
                for (const [name, Module] of entries) {
                    if (Module.needsDock && this._active.has(name))
                        this._stop(name);
                }
            }
            for (const [name, Module] of entries) {
                if (this._active && !this._active.has(name) && this._wanted(name, Module))
                    await this._start(name, Module);
            }
        }).catch(e => console.error('super-g: module sync failed', e));
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
            console.error(`super-g: module "${name}" failed to stop`, e);
        }
    }
}
