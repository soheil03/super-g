// SPDX-License-Identifier: GPL-3.0-or-later
// Ubuntu Plus defaults for the blur engine (Blur my Shell). Its default
// pipeline darkens to 60% brightness, which turns palette-tinted glass grey;
// the top bar and overview use a clear pipeline instead, so the palette tint
// on top decides the colour.

import GLib from 'gi://GLib';

import * as Files from './files.js';
import {engineChildSettings} from './stylesheet.js';

export const CLEAR_PIPELINE = 'pipeline_ubuntu_plus_clear';
// The dock keeps Blur my Shell's refraction ("liquid glass") but at full
// brightness, without the dark colour wash of the stock dash pipeline.
export const DOCK_PIPELINE = 'pipeline_ubuntu_plus_dock';
const PIPELINES = {
    [CLEAR_PIPELINE]: "{'name': <'Ubuntu Plus clear'>, 'effects': <[<{'type': <'dual_kawase_blur'>, " +
        "'id': <'effect_ubuntu_plus_clear'>, 'params': <{'unscaled_radius': <36>, 'brightness': <1.0>}>}>]>}",
    [DOCK_PIPELINE]: "{'name': <'Ubuntu Plus dock'>, 'effects': <[<{'type': <'dual_kawase_blur'>, " +
        "'id': <'effect_ubuntu_plus_dock_blur'>, 'params': <{'unscaled_radius': <30>, 'brightness': <1.0>}>}>, " +
        "<{'type': <'refraction'>, 'id': <'effect_ubuntu_plus_dock_refraction'>, 'params': <@a{sv} {}>}>]>}",
};
const TUNED = `${Files.STATE}/tuned.json`;

export function ensureClearPipeline(rootSettings) {
    const current = rootSettings.get_value('pipelines');
    // Shallow unpack keeps each pipeline as a GLib.Variant, ready to re-pack.
    const pipelines = current.unpack();
    const missing = Object.keys(PIPELINES).filter(id => !pipelines[id]);
    if (!missing.length)
        return;
    for (const id of missing)
        pipelines[id] = GLib.Variant.parse(null, PIPELINES[id], null, null);
    rootSettings.set_value('pipelines', new GLib.Variant('a{sv}', pipelines));
}

export function configureBlur(module) {
    const root = module.instance.getSettings();
    ensureClearPipeline(root);
    const done = JSON.parse(Files.readText(TUNED) ?? '{}');
    if (done.blur)
        return;
    for (const child of ['panel', 'overview']) {
        const s = engineChildSettings(module.ext.path, 'blur', child);
        s?.set_string('pipeline', CLEAR_PIPELINE);
    }
    // Heavy glass: the overview and app grid sit on blurred wallpaper.
    engineChildSettings(module.ext.path, 'blur', 'overview')?.set_boolean('blur', true);
    const dock = engineChildSettings(module.ext.path, 'blur', 'dash-to-dock');
    dock?.set_string('pipeline', DOCK_PIPELINE);
    dock?.set_boolean('blur', true);
    done.blur = true;
    Files.writeText(TUNED, JSON.stringify(done, null, 2));
}
