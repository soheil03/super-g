// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Plus defaults for the blur engine (Blur my Shell). Its default
// pipeline darkens to 60% brightness, which turns palette-tinted glass grey;
// the top bar and overview use a clear pipeline instead, so the palette tint
// on top decides the colour.

import GLib from 'gi://GLib';

import * as Files from './files.js';
import {engineChildSettings} from './stylesheet.js';

export const CLEAR_PIPELINE = 'pipeline_gnome_plus_clear';
// The dock gets plain frosted glass: full-brightness blur, no colour wash and
// no refraction (refraction smears edges); the tint and rim come from CSS.
export const DOCK_PIPELINE = 'pipeline_gnome_plus_dock_v2';
const PIPELINES = {
    [CLEAR_PIPELINE]: "{'name': <'GNOME Plus clear'>, 'effects': <[<{'type': <'dual_kawase_blur'>, " +
        "'id': <'effect_gnome_plus_clear'>, 'params': <{'unscaled_radius': <36>, 'brightness': <1.0>}>}>]>}",
    [DOCK_PIPELINE]: "{'name': <'GNOME Plus dock'>, 'effects': <[<{'type': <'dual_kawase_blur'>, " +
        "'id': <'effect_gnome_plus_dock_blur'>, 'params': <{'unscaled_radius': <34>, 'brightness': <1.0>}>}>]>}",
};
const TUNED = `${Files.STATE}/tuned.json`;

export function ensureClearPipeline(rootSettings) {
    // 'pipelines' is a{sa{sv}}: unpack to {id: {key: Variant}} and back.
    const pipelines = {};
    for (const [id, v] of Object.entries(rootSettings.get_value('pipelines').unpack()))
        pipelines[id] = v.unpack();
    const missing = Object.keys(PIPELINES).filter(id => !pipelines[id]);
    if (!missing.length)
        return;
    for (const id of missing)
        pipelines[id] = GLib.Variant.parse(new GLib.VariantType('a{sv}'), PIPELINES[id], null, null).unpack();
    rootSettings.set_value('pipelines', new GLib.Variant('a{sa{sv}}', pipelines));
}

// Blur is drawn as a rectangle unless its corner radius matches the shape on
// top; these keep the panel and dock blur clipped to their rounded outlines.
export const PANEL_RADIUS = 12;
export const DOCK_RADIUS = 26;

export function configureBlur(module) {
    const root = module.instance.getSettings();
    ensureClearPipeline(root);
    const panel = engineChildSettings(module.ext.path, 'blur', 'panel');
    panel?.set_int('corner-radius', PANEL_RADIUS);
    panel?.set_int('rounded-corners', 0);
    const dash = engineChildSettings(module.ext.path, 'blur', 'dash-to-dock');
    if (dash?.settings_schema.has_key('corner-radius'))
        dash.set_int('corner-radius', DOCK_RADIUS);
    dash?.set_string('pipeline', DOCK_PIPELINE);
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
