// Test-only helper for tools/shell-test.sh. Walks through a list of scenes
// in the headless shell, screenshots each, then writes <dir>/done.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));

// The frame the stage really drew, partial redraw and all: Shell.Screenshot
// repaints everything, which hides culling and damage bugs. Copies the view at
// after-paint, then shoots an overlay showing that copy.
const FrameOverlay = GObject.registerClass(
class FrameOverlay extends Clutter.Effect {
    _init(pipeline, width, height) {
        super._init();
        this._args = [pipeline, width, height];
    }

    vfunc_paint_node(node) {
        const [pipeline, width, height] = this._args;
        const out = new Clutter.PipelineNode(pipeline);
        out.add_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height}));
        node.add_child(out);
    }
});

function frameShot(path) {
    return new Promise((resolve, reject) => {
        const id = global.stage.connect('after-paint', (_s, view) => {
            global.stage.disconnect(id);
            const fb = view.get_framebuffer();
            const [w, h] = [fb.get_width(), fb.get_height()];
            const context = fb.get_context();
            const texture = Cogl.Texture2D.new_with_size(context, w, h);
            texture.allocate();
            const target = Cogl.Offscreen.new_with_texture(texture);
            target.allocate();
            fb.blit(target, 0, 0, 0, 0, w, h);
            const pipeline = Cogl.Pipeline.new(context);
            pipeline.set_layer_texture(0, texture);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                const overlay = new Clutter.Actor({x: 0, y: 0, width: global.stage.width, height: global.stage.height});
                overlay.add_effect(new FrameOverlay(pipeline, global.stage.width, global.stage.height));
                Main.layoutManager.uiGroup.add_child(overlay);
                shot(path).then(resolve, reject).finally(() => overlay.destroy());
                return GLib.SOURCE_REMOVE;
            });
        });
    });
}

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

// A real pointer: its events reach the stage only on a frame, and an idle
// headless stage draws none, so this keeps frames coming until stop().
function makePointer() {
    const device = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    // A pixel's worth of damage, not a stage redraw: real frames are partial,
    // and many bugs (culling, stale regions) only exist there.
    const speck = new St.Widget({x: 0, y: 0, width: 1, height: 1, style: 'background-color: rgba(0,0,0,0.01)'});
    Main.layoutManager.uiGroup.add_child(speck);
    const pump = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        speck.queue_redraw();
        return GLib.SOURCE_CONTINUE;
    });
    const now = () => GLib.get_monotonic_time();
    const button = state => device.notify_button(now(), Clutter.BUTTON_PRIMARY, state);
    const pointer = {
        async move(x, y) {
            device.notify_absolute_motion(now(), x, y);
            await wait(60);
        },
        async glide(x0, y0, x1, y1, ms = 500) {
            const steps = Math.round(ms / 16);
            for (let i = 0; i <= steps; i++) {
                device.notify_absolute_motion(now(), x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
                await wait(16);
            }
        },
        async click(x, y) {
            await pointer.move(x, y);
            button(Clutter.ButtonState.PRESSED);
            await wait(60);
            button(Clutter.ButtonState.RELEASED);
            await wait(250);
        },
        stop: () => {
            if (pointer.stopped)
                return;
            pointer.stopped = true;
            GLib.source_remove(pump);
            speck.destroy();
        },
    };
    return pointer;
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
            const ext = Main.extensionManager.lookup('super-g@soheil')?.stateObj;
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
            // Glide across the dock with a real pointer and shoot on the way.
            const ext = Main.extensionManager.lookup('super-g@soheil')?.stateObj;
            const path = ext?._active?.get('dock')?.instance?.path;
            if (!path)
                return undefined;
            const {dockManager} = await import(`file://${path}/extension.js`);
            const bg = dockManager._allDocks[0].dash._background;
            const [x, y] = bg.get_transformed_position();
            const [w, h] = bg.get_transformed_size();
            const pointer = makePointer();
            await pointer.glide(x + 20, y + h / 2, x + w * 0.3, y + h / 2);
            await wait(400);
            await shot(`${dir}/dock-hover-2.png`);
            await pointer.glide(x + w * 0.3, y + h / 2, x + w * 0.7, y + h / 2);
            await wait(400);
            await shot(`${dir}/dock-hover-6.png`);
            await pointer.move(800, 300);
            await wait(600);
            pointer.stop();
            return undefined;
        }
        case 'lock-cycle': {
            // Locking stops the engines that don't run on the lock screen;
            // unlocking must bring them back whole.
            const ext = Main.extensionManager.lookup('super-g@soheil')?.stateObj;
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
                a11yHidden: !Main.panel.statusArea.a11y?.container.visible,
            }));
            return shot(`${dir}/lock-cycle.png`);
        }
        case 'eval': {
            // EVAL holds a JS function body; its JSON result goes to eval.txt.
            let out;
            try {
                const AsyncFunction = (async () => {}).constructor;
                const pointer = makePointer();
                out = JSON.stringify(await new AsyncFunction('Main', 'global', 'pointer', 'shot', 'wait', 'frame',
                    GLib.getenv('EVAL'))(Main, global, pointer, name => shot(`${dir}/${name}.png`), wait,
                    name => frameShot(`${dir}/${name}.png`)), null, 2);
                pointer.stop();
            } catch (e) {
                out = `${e}\n${e.stack}`;
            }
            GLib.file_set_contents(`${dir}/eval.txt`, out ?? 'undefined');
            return undefined;
        }
        case 'prefs':
            Main.extensionManager.openExtensionPrefs('super-g@soheil', '', {});
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
