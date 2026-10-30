// Test-only helper for tools/shell-test.sh. Takes screenshots of the
// headless shell in a few states, then writes <dir>/done.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => r() ?? GLib.SOURCE_REMOVE));

function shot(path) {
    return new Promise((resolve, reject) => {
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (o, res) => {
            try {
                o.screenshot_finish(res);
                stream.close(null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

export default class Camera extends Extension {
    enable() {
        const dir = GLib.getenv('SHOT_DIR');
        if (!dir)
            return;
        this._run(dir).catch(e => console.error('camera failed', e))
            .finally(() => GLib.file_set_contents(`${dir}/done`, 'done'));
    }

    async _run(dir) {
        await wait(2500);
        if (Main.overview.visible)
            Main.overview.hide();
        await wait(800);
        await shot(`${dir}/desktop.png`);
        const qs = Main.panel.statusArea.quickSettings.menu;
        qs.open(0);
        await wait(600);
        await shot(`${dir}/quick-settings.png`);
        qs.close(0);
        const dm = Main.panel.statusArea.dateMenu.menu;
        dm.open(0);
        await wait(600);
        await shot(`${dir}/calendar.png`);
        dm.close(0);
        Main.extensionManager.openExtensionPrefs('unified-shell@soheil', '', {});
        await wait(4000);
        await shot(`${dir}/prefs.png`);
    }

    disable() {}
}
