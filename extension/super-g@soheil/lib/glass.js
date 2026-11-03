// SPDX-License-Identifier: GPL-3.0-or-later
// Super G glass: a blur of what is really behind the surface, finished by
// one shader pass that does what the stock blur can't: an anti-aliased
// squircle outline, vibrancy (saturation and brightness lift), a palette tint,
// a specular rim that is brightest at the top edge, a fine outline, a hollow
// drop shadow, and a little grain against banding.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Graphene from 'gi://Graphene';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The blur itself: Blur my Shell's dual Kawase passes (GPL-3.0), the method KWin
// and Hyprland use. Reused as they are; only the input and output are ours.
import {
    DOWNSAMPLE_CODE, DOWNSAMPLE_DECLARATIONS, UPSAMPLE_CODE, UPSAMPLE_DECLARATIONS,
    ORIGINAL_REGION, SOURCE_REGION, addPassNode, createPassPipeline, createRenderTarget,
    levelSize, projectRenderTarget, resizeRenderTarget, setFloat, setVector2,
} from '../vendor/blur/effects/blur/kawase_passes.js';
import {getKawaseConfiguration} from '../vendor/blur/effects/blur/kawase_sampling.js';
import {getTextureCapacity, largestViewSize, TextureRegion, textureFits} from '../vendor/blur/render/shader/texture_region.js';

const DECLARATIONS = `
uniform vec2 size;
uniform vec2 uv_origin;
uniform vec2 uv_size;
uniform float radius;
uniform float exponent;
uniform float aa;
uniform vec4 tint;
uniform float saturation;
uniform float brightness;
uniform float rim;
uniform float outline;
uniform float grain;
uniform float guard;
uniform float light_text;
uniform float lens;

// Signed distance to a rounded rectangle whose corners are superellipses
// (exponent 2 = circle, higher = smoother "continuous" corners).
float roundedBox(vec2 p, vec2 half_size, float r, float n) {
    vec2 q = abs(p) - half_size + r;
    vec2 c = max(q, 0.0);
    float corner = pow(pow(c.x, n) + pow(c.y, n), 1.0 / n);
    return corner + min(max(q.x, q.y), 0.0) - r;
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
`;

// The live pipeline sets uniforms one float at a time (array uniforms from
// JS are unreliable on some Mutter versions), so it declares scalars and
// rebuilds the vectors.
const LIVE_DECLARATIONS = DECLARATIONS
    .replace('uniform vec2 size;', 'uniform float size_x;\nuniform float size_y;\nvec2 size = vec2(0.0);')
    .replace('uniform vec2 uv_origin;', 'uniform float uv_x;\nuniform float uv_y;\nvec2 uv_origin = vec2(0.0);')
    .replace('uniform vec2 uv_size;', 'uniform float uv_w;\nuniform float uv_h;\nvec2 uv_size = vec2(1.0);')
    .replace('uniform vec4 tint;', 'uniform float tint_r;\nuniform float tint_g;\nuniform float tint_b;\nuniform float tint_a;\nvec4 tint = vec4(0.0);');

const CODE = `
vec2 uv = (cogl_tex_coord_in[0].st - uv_origin) / uv_size;
vec2 px = uv * size;
float d = roundedBox(px - size * 0.5, size * 0.5, radius, exponent);
float inside = clamp(0.5 - d / aa, 0.0, 1.0);

// Edge lens: towards the outline the rim bends what's behind, pulling it from
// further in, as a thick curved edge does. Follows the idea of Liquid Glass
// for GNOME Shell (ryohsuke1231, MIT).
vec3 rgb = cogl_color_out.rgb;
if (lens > 0.0) {
    vec2 p = px - size * 0.5;
    float band = min(18.0, min(size.x, size.y) * 0.3);
    // The direction from a rounder box than the surface, so it turns smoothly
    // through the corner instead of folding along the diagonal.
    vec2 q = max(abs(p) - size * 0.5 + band, vec2(0.0001));
    float t = clamp(1.0 + d / band, 0.0, 1.0);
    vec2 pull = -sign(p) * normalize(q) * lens * t * t * t;
    rgb = texture2D(cogl_sampler0, cogl_tex_coord_in[0].st + pull / size * uv_size).rgb;
}
float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
rgb = mix(vec3(luma), rgb, saturation) * brightness;
// Contrast guard: where what's behind fights the theme's text (a dark window
// under light glass), the tint thickens. Blurred input, so it stays smooth.
float clash = mix(1.0 - smoothstep(0.12, 0.5, luma), smoothstep(0.55, 0.9, luma), light_text);
rgb = mix(rgb, tint.rgb, mix(tint.a, max(tint.a, 0.8), clash * guard));

// A fine dark outline keeps the shape readable over light content; a specular
// rim just inside it, strongest along the top, gives the edge its light.
float ring = clamp(1.0 - abs(d + 1.5) / 0.9, 0.0, 1.0);
rgb += ring * rim * mix(0.35, 1.0, 1.0 - uv.y);
rgb = mix(rgb, vec3(0.0), clamp(1.0 - abs(d + 0.6) / 0.8, 0.0, 1.0) * outline);

rgb += (hash(px) - 0.5) * grain;
cogl_color_out = vec4(clamp(rgb, 0.0, 1.0), 1.0) * inside;
`;

// The shadow is drawn by the glass itself, after it copied what's behind: a
// CSS box-shadow also paints under the transparent middle, and the glass would
// blur its own shadow into a muddy tint. Hollow, a wide soft layer and a tight
// contact one.
const SHADOW_DECLARATIONS = `
uniform float size_x;
uniform float size_y;
uniform float radius;
uniform float exponent;
uniform float aa;
uniform float pad;
uniform float strength;
uniform float spread;
uniform float drop;
float roundedBox(vec2 p, vec2 half_size, float r, float n) {
    vec2 q = abs(p) - half_size + r;
    vec2 c = max(q, 0.0);
    float corner = pow(pow(c.x, n) + pow(c.y, n), 1.0 / n);
    return corner + min(max(q.x, q.y), 0.0) - r;
}
float falloff(float d, float reach) {
    float t = clamp(1.0 - d / reach, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
`;

const SHADOW_CODE = `
vec2 size = vec2(size_x, size_y);
vec2 px = cogl_tex_coord_in[0].st * (size + 2.0 * pad) - pad - size * 0.5;
float wide = roundedBox(px - vec2(0.0, drop), size * 0.5, radius, exponent);
float tight = roundedBox(px - vec2(0.0, drop * 0.2), size * 0.5, radius, exponent);
float shape = roundedBox(px, size * 0.5, radius, exponent);
float a = strength * (0.7 * falloff(wide, spread) + 0.3 * falloff(tight, spread * 0.22));
a *= clamp(shape / aa + 0.5, 0.0, 1.0);
cogl_color_out = vec4(0.0, 0.0, 0.0, a);
`;

// How far past the surface the blur reads real pixels, in blur sigmas.
const BLUR_REACH = 2.5;

const NO_ROOM = {left: 0, right: 0, top: 0, bottom: 0};

// Room around the actor the shadow can reach.
const SHADOW_PAD = 48;

const UNIFORMS = ['size', 'uv_origin', 'uv_size', 'radius', 'exponent', 'aa', 'tint', 'saturation', 'brightness', 'rim', 'outline', 'grain', 'guard', 'light_text', 'lens'];

export const GlassEffect = GObject.registerClass(
class SuperGGlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._loc = Object.fromEntries(UNIFORMS.map(u => [u, this.get_uniform_location(u)]));
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    setUniforms(u) {
        const f = (name, values) => this.set_uniform_float(this._loc[name], values.length, values);
        f('size', u.size);
        f('uv_origin', [0, 0]);
        f('uv_size', [1, 1]);
        f('radius', [u.radius]);
        f('exponent', [u.exponent]);
        f('aa', [u.aa]);
        f('tint', u.tint);
        f('saturation', [u.saturation]);
        f('brightness', [u.brightness]);
        f('rim', [u.rim]);
        f('outline', [u.outline]);
        f('guard', [u.guard]);
        f('light_text', [u.lightText]);
        f('lens', [0]);
        f('grain', [u.grain]);
        this.queue_repaint();
    }
});

/* ---------------------------------------------------------- live glass -- */

// Live glass: each frame, copy the stage pixels behind the actor, blur them
// with Clutter's native BlurNode and draw the result through the glass
// shader. Shows whatever is really behind (windows, video), not just the
// wallpaper. Built on the same paint-node path GNOME's own blur uses.
const blit = Cogl.Framebuffer.prototype.blit
    ? (src, ...args) => src.blit(...args)
    : Cogl.blit_framebuffer;

// One compiled shader per context: copies of a pipeline share it, while a new
// snippet on every surface (or size) compiles another.
let templates = null;

function shaderTemplates(context) {
    if (templates?.context === context)
        return templates;
    const glass = Cogl.Pipeline.new(context);
    glass.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
    glass.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    glass.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, LIVE_DECLARATIONS,
        `size = vec2(size_x, size_y);\nuv_origin = vec2(uv_x, uv_y);\nuv_size = vec2(uv_w, uv_h);\ntint = vec4(tint_r, tint_g, tint_b, tint_a);\n${CODE}`));
    const shadow = Cogl.Pipeline.new(context);
    shadow.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, SHADOW_DECLARATIONS, SHADOW_CODE));
    templates = {context, glass, shadow};
    return templates;
}

// Where the pixels behind the actor are, and how to map stage coordinates to
// them. A normal frame has a stage view: menus and the dock are drawn through
// offscreen buffers, so copy from the view's framebuffer, never the one we
// paint into. Screenshots repaint the whole stage into their own framebuffer
// without before-paint, and that framebuffer is the source.
let paintingView = null;
let viewHooks = 0;
let viewIds = [];

export function trackPaintingView() {
    if (viewHooks++ === 0) {
        viewIds = [
            global.stage.connect('before-paint', (_s, view) => (paintingView = view)),
            global.stage.connect('after-paint', () => (paintingView = null)),
        ];
    }
}

export function untrackPaintingView() {
    if (--viewHooks === 0) {
        viewIds.forEach(id => global.stage.disconnect(id));
        viewIds = [];
        paintingView = null;
    }
}

function paintSource(context) {
    if (paintingView) {
        const {x, y} = paintingView.layout;
        return {fb: paintingView.get_framebuffer(), x, y, scale: paintingView.get_scale()};
    }
    const fb = context.get_framebuffer();
    return {fb, x: 0, y: 0, scale: fb.get_width() / global.stage.width};
}

// What to copy: the actor's box grown by `room` and by `pad`, in the source
// framebuffer's pixels. The pad gives the blur real pixels past the edges
// instead of smearing the last row. Sized from the actor, not what's on screen:
// an opening menu or drawer is scaling, and blurred, the small difference in
// what's copied doesn't show. Aligned to the blur's coarsest grid, so a surface
// that moves doesn't shimmer.
function sourceBox(actor, {fb, x: ox, y: oy, scale}, room, pad, align) {
    const rect = actor.get_transformed_extents();
    const width = actor.width * scale, height = actor.height * scale;
    const left = (rect.get_x() + rect.get_width() / 2 - ox) * scale - width / 2;
    const top = (rect.get_y() + rect.get_height() / 2 - oy) * scale - height / 2;
    const down = v => Math.floor(v / align) * align;
    const up = v => Math.ceil(v / align) * align;
    const x1 = Math.max(0, down(left - room.left * scale - pad));
    const y1 = Math.max(0, down(top - room.top * scale - pad));
    const x2 = Math.min(fb.get_width(), up(left + width + room.right * scale + pad));
    const y2 = Math.min(fb.get_height(), up(top + height + room.bottom * scale + pad));
    return {
        x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1), scale,
        // The actor itself, inside that copy and on the framebuffer.
        ox: left - x1, oy: top - y1,
        ax1: Math.max(0, Math.floor(left)), ay1: Math.max(0, Math.floor(top)),
        ax2: Math.min(fb.get_width(), Math.ceil(left + width)),
        ay2: Math.min(fb.get_height(), Math.ceil(top + height)),
    };
}

export const LiveGlassEffect = GObject.registerClass({
    GTypeName: 'SuperGLiveGlassEffect',
}, class LiveGlassEffect extends Clutter.Effect {
    _init(layer) {
        super._init();
        this._layer = layer;
        this._capture = null;
        this._blurred = null;
        this._glass = null;
        this._uniforms = null;
    }

    // One target per blur level, kept while they still fit: copies change size
    // as surfaces move near the screen's edges.
    _ensure(context, width, height, passes) {
        if (this._context !== context || !textureFits(width, this._capW) || !textureFits(height, this._capH)) {
            const limit = largestViewSize();
            const sameContext = this._context === context;
            this._capW = sameContext ? getTextureCapacity(width, this._capW, limit.width) : width;
            this._capH = sameContext ? getTextureCapacity(height, this._capH, limit.height) : height;
            this._context = context;
            this._down = [];
            this._up = [];
            this._downPass = [];
            this._upPass = [];
            this._regions = new Map();
            this._glass = null;
            this._usedW = this._usedH = 0;
            this._applied = null;
        }
        const target = level => createRenderTarget(context, levelSize(this._capW, level), levelSize(this._capH, level));
        const fresh = this._down.length <= passes || this._usedW !== width || this._usedH !== height;
        for (let level = this._down.length; level <= passes; level++)
            this._down.push(target(level));
        for (let level = 1; level <= passes; level++) {
            this._downPass[level] ??= this._pass(context, this._down[level - 1], DOWNSAMPLE_DECLARATIONS, DOWNSAMPLE_CODE);
        }
        for (let level = 0; level < passes; level++) {
            this._up[level] ??= target(level);
            this._upPass[level] ??= this._pass(context, this._down[level + 1], UPSAMPLE_DECLARATIONS, UPSAMPLE_CODE, this._down[level]);
        }
        if (!this._glass) {
            const templates = shaderTemplates(context);
            this._glass = templates.glass.copy();
            this._glass.set_layer_texture(0, this._up[0].texture);
            this._shadow = templates.shadow.copy();
            this._shadow.set_layer_texture(0, this._up[0].texture);
            this._captured = false;
        }
        if (!fresh)
            return;
        const bounds = {x: 0, y: 0, width, height};
        for (const list of [this._down, this._up]) {
            list.forEach((t, level) => {
                resizeRenderTarget(t, level, width, height);
                projectRenderTarget(t, bounds);
            });
        }
        this._usedW = width;
        this._usedH = height;
        for (const [pipeline, {source, original, level, up}] of this._regions) {
            source.update(up ? this._down[level + 1] : this._down[level - 1]);
            original?.update(this._down[level]);
        }
    }

    _pass(context, source, declarations, code, original = null) {
        const pipeline = createPassPipeline(context, source.texture, declarations, code);
        const level = this._down.indexOf(source) + (original ? -1 : 1);
        this._regions.set(pipeline, {
            source: new TextureRegion(pipeline, SOURCE_REGION),
            original: original ? new TextureRegion(pipeline, ORIGINAL_REGION) : null,
            level, up: !!original,
        });
        setVector2(pipeline, 'halfpixel', 0.5 / source.width, 0.5 / source.height);
        if (original) {
            pipeline.set_layer_texture(1, original.texture);
            pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
            setFloat(pipeline, 'level_blend', 1);
        }
        return pipeline;
    }

    // The deepest upsample mixes towards its finer level, for radii in between.
    _sampling(passes, blend) {
        if (this._applied?.passes === passes && this._applied.blend === blend)
            return;
        for (let level = passes - 1; level >= 0; level--) {
            const source = level === passes - 1 ? this._down[level + 1] : this._up[level + 1];
            this._upPass[level].set_layer_texture(0, source.texture);
            setFloat(this._upPass[level], 'level_blend', level === passes - 1 ? blend : 1);
        }
        this._applied = {passes, blend};
    }

    // Constant for the layer's life: parents cache their volume from this, and
    // a stale one culls what grew past it (the dock's ends and shadow, cut off).
    vfunc_modify_paint_volume(volume) {
        const pad = this._layer.wantsShadow ? SHADOW_PAD : 0;
        const reach = this._layer.reach;
        const origin = volume.get_origin();
        origin.x -= reach.left + pad;
        origin.y -= reach.top + pad;
        volume.set_origin(origin);
        volume.set_width(volume.get_width() + reach.left + reach.right + 2 * pad);
        volume.set_height(volume.get_height() + reach.top + reach.bottom + 2 * pad);
        return true;
    }

    _setUniforms(u) {
        const p = this._glass;
        const set = (name, v) => p.set_uniform_1f(p.get_uniform_location(name), v);
        set('size_x', u.size[0]);
        set('size_y', u.size[1]);
        set('radius', u.radius);
        set('exponent', u.exponent);
        set('aa', u.aa);
        u.tint.forEach((v, i) => set(`tint_${'rgba'[i]}`, v));
        set('saturation', u.saturation);
        set('brightness', u.brightness);
        set('rim', u.rim);
        set('outline', u.outline);
        set('guard', u.guard);
        set('light_text', u.lightText);
        set('lens', u.lens);
        set('grain', u.grain);
    }

    vfunc_paint_node(node, paintContext, _flags) {
        const actor = this.get_actor();
        const u = this._layer.uniforms;
        // Clone paints (workspace thumbnails) have no stage pixels behind them.
        if (!u || actor.is_in_clone_paint() || !actor.width || !actor.height)
            return;
        const source = paintSource(paintContext);
        const fb = source.fb;
        const sigma = u.blur * source.scale;
        const {passes, blend} = getKawaseConfiguration(sigma * 4);
        const box = sourceBox(actor, source, this._layer.room, Math.ceil(sigma * BLUR_REACH), 2 ** passes);
        if (box.ax2 <= box.ax1 || box.ay2 <= box.ay1)
            return;
        this._ensure(fb.get_context(), box.width, box.height, passes);
        this._sampling(passes, blend);

        // A partial redraw would copy our own previous frame from the
        // undamaged part. Show the last clean blur and ask for a full redraw
        // of the glass, which is then copied clean.
        const clip = paintContext.get_redraw_clip?.();
        let clean = true;
        if (clip) {
            // Region rectangles don't overlap, so summed intersections tell
            // whether the redraw covers the whole glass.
            const {x: ox, y: oy, scale} = source;
            let covered = 0;
            const it = new Mtk.RegionIterator();
            for (it.init(clip); !it.at_end(); it.next()) {
                const r = it.rectangle;
                const x1 = Math.max(box.ax1, Math.floor((r.x - ox) * scale));
                const y1 = Math.max(box.ay1, Math.floor((r.y - oy) * scale));
                const x2 = Math.min(box.ax2, Math.ceil((r.x + r.width - ox) * scale));
                const y2 = Math.min(box.ay2, Math.ceil((r.y + r.height - oy) * scale));
                if (x2 > x1 && y2 > y1)
                    covered += (x2 - x1) * (y2 - y1);
            }
            clean = covered >= (box.ax2 - box.ax1) * (box.ay2 - box.ay1);
            // Damage only around the glass (its shadow) needs no new copy.
            if (!clean && covered > 0)
                this._layer.queueFullRedraw();
        }

        if (clean || !this._captured) {
            blit(fb, this._down[0].framebuffer, box.x, box.y, 0, 0, box.width, box.height);
            const bounds = {x: 0, y: 0, width: box.width, height: box.height};
            for (let level = 1; level <= passes; level++)
                addPassNode(node, this._down[level], this._downPass[level], bounds, `glass down ${level}`);
            for (let level = passes - 1; level >= 0; level--)
                addPassNode(node, this._up[level], this._upPass[level], bounds, `glass up ${level}`);
            this._captured = clean;
            this._drawn = box;
        }

        if (u.shadow) {
            const p = this._shadow;
            const set = (name, v) => p.set_uniform_1f(p.get_uniform_location(name), v);
            set('size_x', u.size[0]);
            set('size_y', u.size[1]);
            set('radius', u.radius);
            set('exponent', u.exponent);
            set('aa', u.aa);
            set('pad', SHADOW_PAD);
            set('strength', u.shadow);
            set('spread', u.shadowSpread);
            set('drop', u.shadowDrop);
            const shade = new Clutter.PipelineNode(p);
            const edge = this._layer.stretch;
            shade.add_rectangle(new Clutter.ActorBox({x1: -edge.left - SHADOW_PAD, y1: -edge.top - SHADOW_PAD,
                x2: actor.width + edge.right + SHADOW_PAD, y2: actor.height + edge.bottom + SHADOW_PAD}));
            node.add_child(shade);
        }

        // The shown part of the blurred copy: the actor, plus any stretch.
        const s = this._layer.stretch;
        const shown = this._drawn ?? box;
        const uvX1 = (shown.ox - s.left * box.scale) / this._capW;
        const uvY1 = (shown.oy - s.top * box.scale) / this._capH;
        const uvX2 = (shown.ox + (actor.width + s.right) * box.scale) / this._capW;
        const uvY2 = (shown.oy + (actor.height + s.bottom) * box.scale) / this._capH;
        this._setUniforms(u);
        const set = (name, v) => this._glass.set_uniform_1f(this._glass.get_uniform_location(name), v);
        set('uv_x', uvX1);
        set('uv_y', uvY1);
        set('uv_w', uvX2 - uvX1);
        set('uv_h', uvY2 - uvY1);
        const out = new Clutter.PipelineNode(this._glass);
        out.add_texture_rectangle(new Clutter.ActorBox({x1: -s.left, y1: -s.top,
            x2: actor.width + s.right, y2: actor.height + s.bottom}), uvX1, uvY1, uvX2, uvY2);
        node.add_child(out);
    }
});

// style: {tint: [r,g,b,a], saturation, brightness, rim, grain, blur}
// smoothing: 0 = circular corners (matches CSS), up to 1 = squircle.
// shapeSource: actor whose CSS border-radius the glass follows (optional).
// track: actor whose on-screen box the glass copies (for layers that can't
// be its child, like the top bar's).
export const GlassLayer = GObject.registerClass(
class SuperGGlassLayer extends St.Widget {
    // live: blur what is really behind (default); false: blur the wallpaper
    // only (cached, for full-screen backdrops where nothing else is behind).
    // shadow: draw the drop shadow (top bar and backdrops have none).
    // guard: how much the contrast guard may thicken the tint; surfaces whose
    // text picks its colour from the backdrop (the top bar) want none.
    // reach: the most setRoom will ever ask for.
    _init({style, shapeSource = null, radius = null, track = null, smoothing = 0.5, live = true, shadow = true, guard = 1,
        reach = NO_ROOM}) {
        // Only the wallpaper copy is larger than the layer and needs clipping.
        super._init({x_expand: true, y_expand: true, clip_to_allocation: !live, reactive: false});
        this._live = live;
        this.uniforms = null;
        this._style = style;
        this._shapeSource = shapeSource;
        this._fixedRadius = radius;
        this._track = track;
        this._smoothing = smoothing;
        this._shadowOn = shadow;
        this.wantsShadow = shadow;
        this.reach = {...NO_ROOM, ...reach};
        this._guard = guard;
        this.room = {...NO_ROOM};
        this.stretch = {...NO_ROOM};
        this.active = true;
        this._monitor = -1;
        this._last = '';

        if (live) {
            this.add_effect_with_name('super-g-glass', new LiveGlassEffect(this));
        } else {
            this._bgGroup = new Meta.BackgroundGroup();
            this.add_child(this._bgGroup);
            this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: style.blur, brightness: 1.0});
            this._bgGroup.add_effect_with_name('super-g-blur', this._blur);
            this._effect = new GlassEffect();
            this.add_effect_with_name('super-g-glass', this._effect);
        }

        // Follow our on-screen position every frame while shown; cheap, and
        // it keeps the wallpaper still while menus and the dock move.
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (this.mapped || this._track)
                this._sync();
            return true;
        });
        if (live)
            this.connect('notify::mapped', () => this.mapped && this._liftOffscreen());
        this.connect('destroy', () => this._teardown());
    }

    // A parent that always draws through an offscreen buffer (BoxPointer)
    // reuses its cached pixels until something inside it changes, which would
    // freeze the glass while the content behind moves. Automatic still uses
    // the buffer for fades.
    _liftOffscreen() {
        this._lifted ??= new Map();
        for (let a = this.get_parent(); a; a = a.get_parent()) {
            if (a.get_offscreen_redirect() === Clutter.OffscreenRedirect.ALWAYS) {
                this._lifted.set(a, Clutter.OffscreenRedirect.ALWAYS);
                a.set_offscreen_redirect(Clutter.OffscreenRedirect.AUTOMATIC);
            }
        }
    }

    // The layer holds a full-monitor wallpaper copy; it must never ask for
    // that much room, only fill what its parent gives it.
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    // Called by the live effect during paint; the redraw itself must wait.
    queueFullRedraw() {
        if (this._redrawId)
            return;
        this._redrawId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
            this._redrawId = 0;
            this.queue_redraw();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The surface can stretch past the actor with no layout work (the dock's
    // magnification, per frame). `room` is the most it will take: the copy of
    // what's behind keeps that size, so its textures are made only once.
    setRoom(room) {
        this.room = {...NO_ROOM, ...room};
        this.stretch = {...NO_ROOM};
        this._last = '';
        this._sync();
        this.queue_redraw();
    }

    setStretch(stretch) {
        this.stretch = {...NO_ROOM, ...stretch};
        this._last = '';
        this._sync();
    }

    setStyle(style) {
        this._style = style;
        if (this._blur)
            this._blur.radius = style.blur;
        this._last = '';
        this._sync();
    }

    _teardown() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        if (this._redrawId)
            GLib.source_remove(this._redrawId);
        this._redrawId = 0;
        for (const [actor, redirect] of this._lifted ?? [])
            actor.set_offscreen_redirect(redirect);
        this._lifted = null;
        this._bgManager?.destroy();
        this._bgManager = null;
    }

    _ensureBackground(monitor) {
        if (monitor === this._monitor && this._bgManager)
            return;
        this._bgManager?.destroy();
        this._monitor = monitor;
        this._bgManager = new Background.BackgroundManager({
            container: this._bgGroup,
            monitorIndex: monitor,
            controlPosition: false,
            vignette: false,
        });
        const geo = Main.layoutManager.monitors[monitor];
        this._bgManager.backgroundActor.set_size(geo.width, geo.height);
        this._bgManager.connect('changed', () => {
            this._bgManager?.backgroundActor.set_size(geo.width, geo.height);
            this._last = '';
        });
    }

    _sync() {
        if (this._track) {
            const t = this._track;
            if (t.update && !t.update())
                return;
            const [tx, ty] = t.get_transformed_position();
            const [tw, th] = t.get_transformed_size();
            this.set_position(Math.round(tx), Math.round(ty));
            this.set_size(Math.round(tw), Math.round(th));
            // What's fading may be a parent, as with a zooming dialog.
            const opacity = t.get_paint_opacity?.() ?? t.opacity;
            this.visible = this.active && t.mapped && opacity > 0;
            this.opacity = opacity;
        }
        const monitor = Main.layoutManager.findIndexForActor(this._track instanceof Clutter.Actor ? this._track : this);
        if (monitor < 0)
            return;
        if (!this._live)
            this._ensureBackground(monitor);

        const [x, y] = this.get_transformed_position();
        const w = this.width, h = this.height;
        const radius = this._fixedRadius ?? this._shapeSource?.get_theme_node?.()
            ?.get_border_radius(St.Corner.TOPLEFT) ?? 0;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const key = `${x}|${y}|${w}|${h}|${radius}|${monitor}`;
        if (key === this._last || !w || !h)
            return;
        this._last = key;
        const {left, right, top, bottom} = this.stretch;

        if (!this._live) {
            const geo = Main.layoutManager.monitors[monitor];
            this._bgGroup.set_position(Math.round(geo.x - x), Math.round(geo.y - y));
        }

        // Squircle corners: a higher exponent with a proportionally larger
        // radius keeps about the same visual size (as in the corners engine).
        const exponent = 2 + this._smoothing * 4;
        const r = Math.min(radius * exponent / 2, w / 2, h / 2);
        const s = this._style;
        this.uniforms = {
            size: [w + left + right, h + top + bottom], radius: r, exponent, aa: 1 / scale, blur: s.blur,
            tint: s.tint, saturation: s.saturation, brightness: s.brightness, rim: s.rim, outline: s.outline, grain: s.grain,
            guard: this._guard, lightText: s.lightText, lens: this._live ? s.lens : 0, shadow: this._shadowOn ? s.shadow : 0, shadowSpread: s.shadowSpread, shadowDrop: s.shadowDrop,
        };
        if (this._effect)
            this._effect.setUniforms(this.uniforms);
        else
            this.queue_redraw();
    }
});

// Thickness, as Apple names its materials: how much palette colour the glass
// carries, how far it blurs, how much colour it lets through.
const MATERIALS = {
    'ultra-thin': {tint: 0.18, blur: 26, saturation: 1.55},
    'thin': {tint: 0.34, blur: 32, saturation: 1.55},
    'regular': {tint: 0.5, blur: 40, saturation: 1.5},
    'thick': {tint: 0.68, blur: 48, saturation: 1.45},
    'ultra-thick': {tint: 0.84, blur: 56, saturation: 1.3},
};

function material(settings) {
    return MATERIALS[settings.get_string('glass-material')] ?? {
        tint: settings.get_double('glass-tint'),
        blur: settings.get_int('glass-blur'),
        saturation: settings.get_double('glass-saturation'),
    };
}

// How opaque the tint ends up. Dark text on light glass needs a calmer
// backdrop than the reverse.
export function glassAlpha(c, settings) {
    const {tint} = material(settings);
    return c.dark ? Math.max(tint * 0.95, 0.3) : Math.min(tint * 1.25, 0.92);
}

// Glass parameters from the palette, light or dark.
export function glassStyle(c, settings) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.window.slice(i, i + 2), 16) / 255);
    const {blur, saturation} = material(settings);
    return {
        tint: [r, g, b, glassAlpha(c, settings)],
        saturation,
        brightness: c.dark ? 0.92 : 1.04,
        rim: c.dark ? 0.12 : 0.26,
        outline: c.dark ? 0.26 : 0.1,
        lightText: c.dark ? 1 : 0,
        lens: settings.get_double('glass-refraction') * 12,
        shadow: c.dark ? 0.32 : 0.2,
        shadowSpread: 34,
        shadowDrop: 8,
        grain: 0.012,
        blur,
    };
}

// Lay a glass layer under every child of `parent` by wrapping them: the
// wrapper stacks the glass and the original child with a BinLayout, so the
// glass always matches the child's size and moves with it.
export function wrapWithGlass(bin, style) {
    const child = bin.get_child();
    if (!child)
        return null;
    const wrapper = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
    const glass = new GlassLayer({style, shapeSource: child});
    bin.set_child(null);
    wrapper.add_child(glass);
    wrapper.add_child(child);
    bin.set_child(wrapper);
    return {wrapper, glass, child, bin};
}

export function unwrap({wrapper, child, bin}) {
    if (bin.get_child() === wrapper) {
        bin.set_child(null);
        wrapper.remove_child(child);
        bin.set_child(child);
    }
    wrapper.destroy();
}
