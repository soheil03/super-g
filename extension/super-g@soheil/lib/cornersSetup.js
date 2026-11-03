// SPDX-License-Identifier: GPL-3.0-or-later
// Keeps the corners engine (Rounded Window Corners) in step with Super G:
// the window radius comes from our setting, the border hugs the window (no
// padding gap, which drew a detached outline) and uses a soft hairline.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const KEY = 'global-rounded-corner-settings';
const CUSTOM_KEY = 'custom-rounded-corner-settings';
// Left, right, top, bottom, measured against the engine's own bounds.
const CHROMIUM_INSET = [1, 2, 0, 2];

export function configureCorners(module) {
    const engine = module.instance.getSettings();
    // Chromium and Electron apps on Wayland report a frame slightly larger than
    // what they draw. Rounding the frame leaves a thin arc past the real corner,
    // so their shape is pulled in to hug the content. (As X11 windows they get a
    // frame from the compositor, which fits.)
    const known = new Set(module.settings.get_strv('corners-chromium-apps'));
    const apply = () => {
        let text = engine.get_value(KEY).print(true);
        const radius = module.settings.get_int('window-radius');
        text = text
            .replace(/'padding': <\{[^}]*\}>/, padding(0, 0, 0, 0))
            .replace(/'borderRadius': <uint32 \d+>/, `'borderRadius': <uint32 ${radius}>`)
            .replace(/'borderColor': <\([^)]*\)>/, "'borderColor': <(0.0, 0.0, 0.0, 0.10)>");
        const next = GLib.Variant.parse(engine.get_value(KEY).get_type(), text, null, null);
        if (!next.equal(engine.get_value(KEY)))
            engine.set_value(KEY, next);

        const hugging = text.replace(/'padding': <\{[^}]*\}>/, padding(...CHROMIUM_INSET))
            .replace(/'enabled': <(true|false)>/, "'enabled': <true>");
        const body = [...known].map(name => `${GLib.shell_quote(name)}: <${hugging}>`).join(', ');
        const custom = GLib.Variant.parse(new GLib.VariantType('a{sv}'), `{${body}}`, null, null);
        if (!custom.equal(engine.get_value(CUSTOM_KEY)))
            engine.set_value(CUSTOM_KEY, custom);
    };
    const check = win => {
        const name = win.get_wm_class_instance();
        if (!name || known.has(name) || win.get_client_type() !== Meta.WindowClientType.WAYLAND || !isChromium(win.get_pid()))
            return;
        known.add(name);
        module.settings.set_strv('corners-chromium-apps', [...known]);
        apply();
    };
    module.connect(module.settings, 'changed::window-radius', apply);
    // Its class and process are known only once it has a first frame.
    module.connect(global.display, 'window-created', (_d, win) => {
        module.later(`corners-check-${win.get_id()}`, 300, () => check(win));
    });
    for (const actor of global.get_window_actors())
        check(actor.meta_window);
    apply();
}

const padding = (left, right, top, bottom) =>
    `'padding': <{'left': uint32 ${left}, 'right': uint32 ${right}, 'top': uint32 ${top}, 'bottom': uint32 ${bottom}}>`;

function isChromium(pid) {
    if (pid <= 0)
        return false;
    try {
        const dir = GLib.path_get_dirname(GLib.file_read_link(`/proc/${pid}/exe`));
        return ['chrome_100_percent.pak', 'resources.pak'].some(f => GLib.file_test(`${dir}/${f}`, GLib.FileTest.EXISTS));
    } catch {
        return false;
    }
}
