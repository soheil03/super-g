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
        case 'drawer':
        case 'drawer-search': {
            const ext = Main.extensionManager.lookup('gnome-plus@soheil')?.stateObj;
            const drawer = ext?._active?.get('drawer');
            const path = ext?._active?.get('dock')?.instance?.path;
            if (!drawer || !path)
                return undefined;
            const {dockManager} = await import(`file://${path}/extension.js`);
            const dock = dockManager._allDocks[0];
            drawer.open(dock, dock.dash._showAppsIcon.toggleButton);
            await wait(900);
            if (scene === 'drawer-search') {
                drawer._entry.set_text('te');
                await wait(500);
            }
            await shot(`${dir}/${scene}.png`);
            drawer.close();
            return wait(500);
        }
        case 'notification':
            Main.notify('Screenshot captured', 'You can paste the image from the clipboard');
            await wait(1200);
            return shot(`${dir}/notification.png`);
        case 'menu-over-window': {
            // Live glass must show the window behind it, not the wallpaper.
            const app = Shell.AppSystem.get_default().lookup_app('org.gnome.Nautilus.desktop');
            app?.activate();
            for (let i = 0; i < 40 && app && app.get_windows().length === 0; i++)
                await wait(250);
            await wait(1500);
            const win = app?.get_windows()[0];
            win?.move_resize_frame(false, 700, 60, 900, 700);
            await wait(800);
            await menuScene(dir, 'menu-over-window', Main.panel.statusArea.dateMenu.menu);
            app?.request_quit();
            return wait(800);
        }
        case 'dock-hover': {
            // Hover the 3rd and 7th app icons in turn: magnification should
            // reach every icon, not only the first few.
            const ext = Main.extensionManager.lookup('gnome-plus@soheil')?.stateObj;
            const path = ext?._active?.get('dock')?.instance?.path;
            if (!path)
                return undefined;
            const {dockManager} = await import(`file://${path}/extension.js`);
            const box = dockManager?._allDocks?.[0]?.dash?._box;
            const items = box?.get_children() ?? [];
            const seat = Clutter.get_default_backend().get_default_seat();
            for (const i of [2, 6]) {
                const item = items[i];
                if (!item)
                    continue;
                const [x, y] = item.get_transformed_position();
                const [w, h] = item.get_transformed_size();
                const px = x + w / 2, py = y + h / 2;
                // The hover engine reads global.get_pointer(), so move the real pointer.
                seat.warp_pointer(px, py);
                // Headless stages get no pointer events; drive the magnifier directly.
                ext._active.get('dock')?.magnifier?._track(dockManager._allDocks[0], px, py);
                await wait(900);
                await shot(`${dir}/dock-hover-${i}.png`);
            }
            seat.warp_pointer(800, 300);
            return wait(500);
        }
        case 'lock-cycle': {
            // Locking stops the engines that don't run on the lock screen;
            // unlocking must bring them back whole.
            const ext = Main.extensionManager.lookup('gnome-plus@soheil')?.stateObj;
            Main.screenShield.lock(false);
            await wait(2500);
            const locked = [...ext._active.keys()];
            Main.screenShield.deactivate(false);
            const back = Date.now();
            while (!ext._active.get('dock')?.magnifier && Date.now() - back < 20000)
                await wait(100);
            const ms = Date.now() - back;
            await wait(1000);
            GLib.file_set_contents(`${dir}/lock-cycle.txt`, JSON.stringify({
                locked, ms, after: [...ext._active.keys()],
                broken: ext._settings.get_strv('broken-modules'),
                dock: !!ext._active.get('dock')?.instance,
            }));
            return shot(`${dir}/lock-cycle.png`);
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
            Main.extensionManager.openExtensionPrefs('gnome-plus@soheil', '', {});
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
