// Test-only helper for tools/shell-test.sh. Walks through a list of scenes
// in the headless shell, screenshots each, then writes <dir>/done.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

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

const APPS = {
    'files': 'org.gnome.Nautilus.desktop',
    'text-editor': 'org.gnome.TextEditor.desktop',
    'settings': 'org.gnome.Settings.desktop',
    'calculator': 'org.gnome.Calculator.desktop',
    'disks-gtk3': 'org.gnome.DiskUtility.desktop',
    'dconf-gtk3': 'ca.desrt.dconf-editor.desktop',
};

async function menuScene(dir, name, menu) {
    menu.open(0);
    await wait(700);
    await shot(`${dir}/${name}.png`);
    menu.close(0);
    await wait(300);
}

async function appScene(dir, name, id) {
    const app = Shell.AppSystem.get_default().lookup_app(id);
    if (!app)
        return;
    app.activate();
    for (let i = 0; i < 40 && app.get_windows().length === 0; i++)
        await wait(250);
    await wait(2500);
    await shot(`${dir}/${name}.png`);
    app.request_quit();
    await wait(800);
}

export default class Camera extends Extension {
    enable() {
        const dir = GLib.getenv('SHOT_DIR');
        if (!dir)
            return;
        const all = ['desktop', 'quick-settings', 'calendar', 'overview', 'app-grid', ...Object.keys(APPS), 'prefs'];
        const want = (GLib.getenv('SHOTS') || '').split(/\s+/).filter(Boolean);
        this._run(dir, want.length ? want : all)
            .catch(e => console.error('camera failed', e))
            .finally(() => GLib.file_set_contents(`${dir}/done`, 'done'));
    }

    async _run(dir, scenes) {
        await wait(3000);
        Main.overview.hide();
        await wait(800);
        for (const scene of scenes) {
            try {
                await this._scene(dir, scene);
            } catch (e) {
                console.error(`camera scene ${scene} failed`, e);
            }
        }
    }

    async _scene(dir, scene) {
        switch (scene) {
        case 'desktop':
            return shot(`${dir}/desktop.png`);
        case 'quick-settings':
            return menuScene(dir, scene, Main.panel.statusArea.quickSettings.menu);
        case 'calendar':
            return menuScene(dir, scene, Main.panel.statusArea.dateMenu.menu);
        case 'overview':
        case 'app-grid':
            if (scene === 'overview')
                Main.overview.show();
            else
                Main.overview.showApps();
            await wait(1500);
            await shot(`${dir}/${scene}.png`);
            Main.overview.hide();
            return wait(800);
        case 'dock-hover': {
            // Point at the 2nd and 6th dock icons in turn: hover motion
            // should reach every icon, not only the first few.
            const pointer = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            const dock = global.stage.find_child_by_name?.('dashtodockContainer') ??
                Main.uiGroup.get_children().find(a => a.name === 'dashtodockContainer');
            if (!dock)
                return undefined;
            const [x, y] = dock.get_transformed_position();
            const [w, h] = dock.get_transformed_size();
            for (const [i, frac] of [[2, 0.22], [6, 0.62]]) {
                pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + w * frac, y + h - 30);
                // Headless stages get no motion events from virtual pointers;
                // feed the dock motion engine directly.
                Main.extensionManager.lookup('ubuntu-plus@soheil')?.stateObj?._active?.get('dockmotion')
                    ?.instance?._dockIntegration?.onPointerMotion(x + w * frac, y + h - 30);
                await wait(900);
                await shot(`${dir}/dock-hover-${i}.png`);
            }
            pointer.notify_absolute_motion(GLib.get_monotonic_time(), 800, 300);
            return wait(500);
        }
        case 'eval': {
            // EVAL holds a JS function body; its JSON result goes to eval.txt.
            let out;
            try {
                const AsyncFunction = (async () => {}).constructor;
                out = JSON.stringify(await new AsyncFunction('Main', 'global', GLib.getenv('EVAL'))(Main, global), null, 2);
            } catch (e) {
                out = `${e}\n${e.stack}`;
            }
            GLib.file_set_contents(`${dir}/eval.txt`, out ?? 'undefined');
            return undefined;
        }
        case 'prefs':
            Main.extensionManager.openExtensionPrefs('ubuntu-plus@soheil', '', {});
            await wait(4000);
            return shot(`${dir}/prefs.png`);
        default:
            if (APPS[scene])
                return appScene(dir, scene, APPS[scene]);
        }
        return undefined;
    }

    disable() {}
}
