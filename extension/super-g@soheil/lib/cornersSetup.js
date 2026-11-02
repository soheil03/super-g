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
}
