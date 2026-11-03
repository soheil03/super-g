// SPDX-License-Identifier: GPL-3.0-or-later
// Keeps the corners engine (Rounded Window Corners) in step with Super G:
// the window radius comes from our setting, the border hugs the window (no
// padding gap, which drew a detached outline) and uses a soft hairline.

import GLib from 'gi://GLib';

const KEY = 'global-rounded-corner-settings';

export function configureCorners(module) {
    const engine = module.instance.getSettings();
    const apply = () => {
        let text = engine.get_value(KEY).print(true);
        const radius = module.settings.get_int('window-radius');
        text = text
            .replace(/'padding': <\{[^}]*\}>/, "'padding': <{'left': uint32 0, 'right': uint32 0, 'top': uint32 0, 'bottom': uint32 0}>")
            .replace(/'borderRadius': <uint32 \d+>/, `'borderRadius': <uint32 ${radius}>`)
            .replace(/'borderColor': <\([^)]*\)>/, "'borderColor': <(0.0, 0.0, 0.0, 0.10)>");
        const next = GLib.Variant.parse(engine.get_value(KEY).get_type(), text, null, null);
        if (!next.equal(engine.get_value(KEY)))
            engine.set_value(KEY, next);
    };
    module.connect(module.settings, 'changed::window-radius', apply);
    apply();

    // Chromium and Electron draw their own corners and shadow into the window,
    // at a radius of their own. Rounding them again leaves two curves on top of
    // each other, so they keep theirs unless the user wants them rounded anyway.
    const ours = new Set(module.settings.get_strv('corners-skipped-apps'));
    const syncList = () => {
        const skip = module.settings.get_boolean('corners-skip-chromium');
        const rest = engine.get_strv('blacklist').filter(name => !ours.has(name));
        const next = skip ? [...rest, ...ours] : rest;
        if (next.join() !== engine.get_strv('blacklist').join())
            engine.set_strv('blacklist', next);
    };
    const check = win => {
        const name = win.get_wm_class_instance();
        if (!name || ours.has(name) || !isChromium(win.get_pid()))
            return;
        ours.add(name);
        module.settings.set_strv('corners-skipped-apps', [...ours]);
        syncList();
    };
    // Its class and process are known only once it has a first frame.
    module.connect(global.display, 'window-created', (_d, win) => {
        module.later(`corners-check-${win.get_id()}`, 300, () => check(win));
    });
    module.connect(module.settings, 'changed::corners-skip-chromium', syncList);
    for (const actor of global.get_window_actors())
        check(actor.meta_window);
    syncList();
}

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
