// SPDX-License-Identifier: GPL-3.0-or-later
// Layered drop shadows the GPU draws from the shape's distance field, as Apple's
// are stacked: a wide ambient layer, a mid one and a tight contact line. A CSS
// box-shadow is one layer, blurred on the CPU again at every size or focus change,
// with circular corners under a squircle window and banding on smooth wallpapers.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';

// One location per uniform name in a Cogl context, and looking it up is a
// string search: too slow to repeat per surface and frame.
const locations = new Map();
export function uniformLocation(pipeline, name) {
    let location = locations.get(name);
    if (location === undefined) {
        location = pipeline.get_uniform_location(name);
        locations.set(name, location);
    }
    return location;
}

const NAMES = ['size_x', 'size_y', 'radius', 'exponent', 'aa', 'full_x', 'full_y', 'center_x', 'center_y',
    'd0', 's0', 'a0', 'd1', 's1', 'a1', 'd2', 's2', 'a2'];

const DECLARATIONS = `
${NAMES.map(name => `uniform float ${name};`).join('\n')}
float roundedBox(vec2 p, vec2 half_size, float r, float n) {
    vec2 q = abs(p) - half_size + r;
    vec2 c = max(q, 0.0);
    float corner = pow(pow(c.x, n) + pow(c.y, n), 1.0 / n);
    return corner + min(max(q.x, q.y), 0.0) - r;
}
// A blurred edge, with the logistic curve standing in for the Gaussian's integral.
float soft(vec2 p, vec2 half_size, float drop, float sigma) {
    return 1.0 / (1.0 + exp(roundedBox(p - vec2(0.0, drop), half_size, radius, exponent) / (0.55 * sigma)));
}
`;

const CODE = `
vec2 half_size = vec2(size_x, size_y) * 0.5;
vec2 p = cogl_tex_coord_in[0].st * vec2(full_x, full_y) - vec2(center_x, center_y);
float a = 1.0 - (1.0 - a0 * soft(p, half_size, d0, s0)) * (1.0 - a1 * soft(p, half_size, d1, s1)) * (1.0 - a2 * soft(p, half_size, d2, s2));
// Hollow: nothing under the surface itself.
a *= clamp(roundedBox(p, half_size, radius, exponent) / aa + 0.5, 0.0, 1.0);
// Under one 8-bit step of noise, a wide shadow doesn't band on a smooth backdrop.
float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
a = clamp(a + (noise - 0.5) / 255.0 * step(0.001, a), 0.0, 1.0);
// Deep blue-black rather than pure black, which reads as dirt on light surfaces.
cogl_color_out = vec4(vec3(0.02, 0.03, 0.07) * a, a);
`;

let template = null;
export function shadowTemplate(context) {
    if (template?.context !== context) {
        const pipeline = Cogl.Pipeline.new(context);
        pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE));
        template = {context, pipeline};
    }
    return template.pipeline;
}

// [drop, sigma, alpha] for the ambient, mid and contact layers.
const WINDOW_LAYERS = {
    subtle: {focused: [12, 18, 0.2, 3, 5, 0.09, 0.5, 1, 0.1], rest: [5, 10, 0.09, 1, 3, 0.05, 0.5, 1, 0.07]},
    standard: {focused: [22, 30, 0.34, 6, 9, 0.14, 1, 1.4, 0.14], rest: [10, 16, 0.14, 2, 5, 0.07, 0.5, 1, 0.08]},
    deep: {focused: [28, 34, 0.44, 8, 11, 0.17, 1, 1.6, 0.16], rest: [14, 20, 0.2, 3, 6, 0.09, 0.5, 1, 0.09]},
};
const SURFACE_LAYERS = {
    subtle: [6, 12, 0.16, 2, 4, 0.07, 0.5, 1, 0.06],
    standard: [10, 18, 0.24, 3, 6, 0.1, 0.5, 1, 0.08],
    deep: [14, 24, 0.32, 4, 7, 0.12, 0.5, 1.2, 0.1],
};
// A dark window on a dark desktop needs more to lift off it.
const darken = (layers, dark) => (dark ? layers.map((v, i) => (i % 3 === 2 ? Math.min(0.6, v * 1.35) : v)) : layers);

export function surfaceShadow(style, dark) {
    return SURFACE_LAYERS[style] ? darken(SURFACE_LAYERS[style], dark) : null;
}

// Sends only what changed, and skips the part under the surface.
export class ShadowPainter {
    constructor(pipeline) {
        this.pipeline = pipeline;
        this._values = [];
    }

    // x, y, width, height: the whole area, in the actor's coordinates. box: the
    // surface in it. layers: nine numbers, from above.
    paint(node, {x, y, width, height, box, radius, exponent, aa, layers}) {
        const w = box.x2 - box.x1, h = box.y2 - box.y1;
        const values = [w, h, radius, exponent, aa, width, height, (box.x1 + box.x2) / 2 - x, (box.y1 + box.y2) / 2 - y, ...layers];
        for (let i = 0; i < values.length; i++) {
            if (this._values[i] !== values[i]) {
                this._values[i] = values[i];
                this.pipeline.set_uniform_1f(uniformLocation(this.pipeline, NAMES[i]), values[i]);
            }
        }
        const out = new Clutter.PipelineNode(this.pipeline);
        const rect = (x1, y1, x2, y2) => {
            if (x2 > x1 && y2 > y1) {
                out.add_texture_rectangle(new Clutter.ActorBox({x1, y1, x2, y2}),
                    (x1 - x) / width, (y1 - y) / height, (x2 - x) / width, (y2 - y) / height);
            }
        };
        const inset = Math.min(radius / 2, w / 2, h / 2);
        const hole = {x1: box.x1 + inset, y1: box.y1 + inset, x2: box.x2 - inset, y2: box.y2 - inset};
        rect(x, y, x + width, hole.y1);
        rect(x, hole.y2, x + width, y + height);
        rect(x, hole.y1, hole.x1, hole.y2);
        rect(hole.x2, hole.y1, x + width, hole.y2);
        node.add_child(out);
    }
}

const FOCUS_MS = 160;
const shadows = new Set();
let windowStyle = WINDOW_LAYERS.standard;
let windowDark = false;

export function setWindowShadowStyle(style, dark) {
    windowStyle = WINDOW_LAYERS[style] ?? null;
    windowDark = dark;
    for (const shadow of shadows)
        shadow.restyle();
}

// The corners engine's window shadow: it keeps its actor bound to the window, we
// draw in it. Needs no offscreen buffer, and nothing to redo when the size changes.
export const WindowShadow = GObject.registerClass(
class SuperGWindowShadow extends St.Widget {
    _init(params) {
        super._init({...params, reactive: false});
        this._hidden = false;
        this._focused = false;
        shadows.add(this);
        this.connect('destroy', () => {
            shadows.delete(this);
            this._timeline?.stop();
            this._timeline = null;
        });
    }

    // inset: how far the window lies inside this actor, on each side.
    setWindow({hidden, focused, radius, smoothing, inset}) {
        // As the corners engine works out its squircle.
        this._exponent = smoothing * 10 + 2;
        this._radius = radius * 0.5 * this._exponent;
        this._inset = inset;
        this._hidden = hidden;
        this._focused = focused;
        this.restyle();
        this.queue_redraw();
    }

    restyle() {
        const set = windowStyle?.[this._focused ? 'focused' : 'rest'];
        const target = set ? darken(set, windowDark) : null;
        this._timeline?.stop();
        this._timeline = null;
        if (!target || !this._layers || this._layers.every((v, i) => v === target[i])) {
            this._layers = target;
            this.queue_redraw();
            return;
        }
        const from = this._layers;
        const timeline = new Clutter.Timeline({actor: global.stage, duration: FOCUS_MS});
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
        const step = progress => {
            this._layers = from.map((v, i) => v + (target[i] - v) * progress);
            this.queue_redraw();
        };
        timeline.connect('new-frame', () => step(timeline.get_progress()));
        timeline.connect('stopped', (_t, finished) => {
            if (finished)
                step(1);
        });
        this._timeline = timeline;
        timeline.start();
    }

    vfunc_paint_node(node, paintContext) {
        const {width, height} = this;
        if (this._hidden || !this._layers || !this._inset || !width || !height)
            return;
        if (!this._painter) {
            const context = paintContext.get_framebuffer().get_context();
            const pipeline = shadowTemplate(context).copy();
            // Only for its coordinates, and because Cogl blends only what it
            // knows has alpha: it can't see into a snippet.
            pipeline.set_layer_texture(0, Cogl.Texture2D.new_with_size(context, 1, 1));
            this._painter = new ShadowPainter(pipeline);
        }
        const {left, right, top, bottom} = this._inset;
        this._painter.paint(node, {x: 0, y: 0, width, height, radius: this._radius, exponent: this._exponent, aa: 1,
            layers: this._layers, box: {x1: left, y1: top, x2: width - right, y2: height - bottom}});
    }
});
