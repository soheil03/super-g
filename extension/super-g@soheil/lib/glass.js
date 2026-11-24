// SPDX-License-Identifier: GPL-3.0-or-later
// Super G glass: a blur of what is really behind the surface, finished by
// one shader pass that does what the stock blur can't: an anti-aliased
// squircle outline and a hollow drop shadow, plus, for frosted glass,
// vibrancy, a palette tint, a rim and a fine outline, and for liquid glass
// Apple's model (docs/LIQUID_GLASS.md): an edge lens, a luma band with a
// neutral fill, bleed from around the glass, a glint and a dark contour.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {ShadowPainter, shadowTemplate, surfaceShadow, uniformLocation} from './softShadow.js';
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
// The liquid face reads three more levels of the live copy: a half-frosted
// one (rim and lens), the unblurred copy (the dark contour) and a very wide
// one (bleed). The wallpaper backdrop has only its one, and never runs liquid.
#define HALF_TEX cogl_sampler0
#define SHARP_TEX cogl_sampler0
#define WIDE_TEX cogl_sampler0
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
uniform float liquid;
uniform float band_lo;
uniform float band_hi;
uniform float band_chroma;
uniform float bleed;
uniform float hold;
uniform float glint;
uniform float contour;
uniform float half_du;
uniform float half_dv;
uniform float wide_du;
uniform float wide_dv;
uniform float used_u;
uniform float used_v;
uniform float half_ku;
uniform float half_kv;
uniform float wide_ku;
uniform float wide_kv;
uniform float bleed_pull;

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

// Liquid glass is Apple's glass_background_lpf model (docs/LIQUID_GLASS.md),
// reimplemented: lens, frost, a luma band with a neutral fill, bleed, glint,
// contour. Lengths are in points (logical pixels).
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
// The bevel: 20 pt wide, pulling 3 times that at the outermost pixel along a
// quarter circle, so it shows a mirrored, compressed copy of what lies inside.
const float LIQ_BEVEL = 20.0;
const float LIQ_LENS_PULL = 3.0;
// Bleed: the wide sample's outer taps sit this many texels of its level away,
// so it spreads about twice that level's own blur.
const float LIQ_BLEED_TAPS = 1.5;
// The face is held under the rim, which keeps its full brightness, over the
// outer 1 to 2 pt.
const float LIQ_HOLD_EDGE = 1.0;
// The glint: a 1.1 pt band, two equal cosine lobes from the top left and the
// bottom right (AppKit's key and fill lights), coloured by what's behind.
const float LIQ_GLINT_WIDTH = 1.1;
const vec2 LIQ_KEY = vec2(-0.70710678, -0.70710678);
const float LIQ_GLINT_SAT = 1.3;
// The contour: the unblurred backdrop at half its brightness top and bottom,
// 36% on the side walls.
const float LIQ_CONTOUR_FLAT = 0.5;
const float LIQ_CONTOUR_SIDE = 0.36;
`;

// The live pipeline sets uniforms one float at a time (array uniforms from
// JS are unreliable on some Mutter versions), so it declares scalars and
// rebuilds the vectors.
const LIVE_DECLARATIONS = DECLARATIONS
    .replace('#define HALF_TEX cogl_sampler0', '#define HALF_TEX cogl_sampler1')
    .replace('#define SHARP_TEX cogl_sampler0', '#define SHARP_TEX cogl_sampler2')
    .replace('#define WIDE_TEX cogl_sampler0', '#define WIDE_TEX cogl_sampler3')
    .replace('uniform vec2 size;', 'uniform float size_x;\nuniform float size_y;\nvec2 size = vec2(0.0);')
    .replace('uniform vec2 uv_origin;', 'uniform float uv_x;\nuniform float uv_y;\nvec2 uv_origin = vec2(0.0);')
    .replace('uniform vec2 uv_size;', 'uniform float uv_w;\nuniform float uv_h;\nvec2 uv_size = vec2(1.0);')
    .replace('uniform vec4 tint;', 'uniform float tint_r;\nuniform float tint_g;\nuniform float tint_b;\nuniform float tint_a;\nvec4 tint = vec4(0.0);');

const CODE = `
vec2 uv = (cogl_tex_coord_in[0].st - uv_origin) / uv_size;
vec2 px = uv * size;
vec2 p = px - size * 0.5;
float d = roundedBox(p, size * 0.5, radius, exponent);
float inside = clamp(0.5 - d / aa, 0.0, 1.0);
vec3 rgb = cogl_color_out.rgb;

if (liquid > 0.5) {
    vec2 st = cogl_tex_coord_in[0].st;
    vec2 to_uv = uv_size / size;
    vec2 half_k = vec2(half_ku, half_kv);
    vec2 wide_k = vec2(wide_ku, wide_kv);
    float S = min(size.x, size.y);
    float depth = max(-d, 0.0);
    // Small glass shrinks the lens: at most a quarter of the short side.
    float h = min(LIQ_BEVEL, S * 0.25);
    // The outward normal, from a box at least as round as the bevel, so it
    // turns through the corners instead of folding along the diagonal.
    float rr = max(radius, h);
    vec2 e = vec2(0.5, 0.0);
    vec2 n = vec2(
        roundedBox(p + e.xy, size * 0.5, rr, exponent) - roundedBox(p - e.xy, size * 0.5, rr, exponent),
        roundedBox(p + e.yx, size * 0.5, rr, exponent) - roundedBox(p - e.yx, size * 0.5, rr, exponent));
    n = length(n) > 0.0001 ? normalize(n) : vec2(0.0, -1.0);

    // Lens: offset = 3h (1 - sqrt(s (2 - s))), never sampling past the centre line.
    float s = clamp(depth / h, 0.0, 1.0);
    float off = LIQ_LENS_PULL * h * (1.0 - sqrt(s * (2.0 - s))) * lens;
    off = min(off, max(S * 0.5 - depth, 0.0));
    vec2 at = st - n * to_uv * off;

    // Frost: full on the centre line, half at the rim, so the mirrored copy in
    // the bevel stays soft. The half level is smoothed with four taps. Past the
    // bevel the full level is the one Cogl already sampled.
    vec3 full = off > 0.0 ? texture2D(cogl_sampler0, at).rgb : cogl_color_out.rgb;
    float to_rim = clamp(1.0 - depth / (S * 0.5), 0.0, 1.0);
    vec3 b = full;
    if (to_rim > 0.0) {
        vec2 ha = at * half_k;
        vec2 hd = vec2(half_du, half_dv) * 0.5;
        vec3 half_frost = 0.25 * (texture2D(HALF_TEX, ha + hd).rgb + texture2D(HALF_TEX, ha - hd).rgb +
            texture2D(HALF_TEX, ha + vec2(hd.x, -hd.y)).rgb + texture2D(HALF_TEX, ha - vec2(hd.x, -hd.y)).rgb);
        b = mix(full, half_frost, to_rim);
    }

    // Tone: brightness into a fixed band, chroma scaled, a neutral fill (folded
    // into the band). Affine, so it commutes with the blur: Apple tones first.
    float y = dot(b, LUMA);
    vec3 face = vec3(band_lo + (band_hi - band_lo) * y) + band_chroma * (b - y);

    // Bleed: light from around the glass. A very wide sample pulled outwards
    // (along a smooth radial field: the normal flips along the diagonals),
    // toned into 0.9-1.0 at saturation 1.2 on light glass, 0-0.5 on dark, and
    // mixed in where the face is already bright (light) or dark (dark). The
    // pull stops where the copy does, so no samples pile up at its edge.
    float fy = clamp(dot(face, LUMA), 0.0, 1.0);
    float amount = mix(0.5 * pow(fy, 4.0), 0.8 * pow(1.0 - fy, 4.0), light_text) * bleed;
    if (amount > 0.5 / 255.0) {
        vec2 radial = p / max(size * 0.5, vec2(1.0));
        radial = length(radial) > 0.0001 ? normalize(radial) : vec2(0.0);
        vec2 wa = (st + radial * to_uv * bleed_pull * to_rim * to_rim) * wide_k;
        vec2 wd = vec2(wide_du, wide_dv) * LIQ_BLEED_TAPS;
        vec2 lo = vec2(wide_du, wide_dv) * 0.5;
        vec2 hi = max(vec2(used_u, used_v) * wide_k - lo, lo);
        vec3 wb = (2.0 * texture2D(WIDE_TEX, clamp(wa, lo, hi)).rgb +
            texture2D(WIDE_TEX, clamp(wa + wd, lo, hi)).rgb + texture2D(WIDE_TEX, clamp(wa - wd, lo, hi)).rgb +
            texture2D(WIDE_TEX, clamp(wa + vec2(wd.x, -wd.y), lo, hi)).rgb +
            texture2D(WIDE_TEX, clamp(wa - vec2(wd.x, -wd.y), lo, hi)).rgb) / 6.0;
        float wy = dot(wb, LUMA);
        vec3 lit = vec3(0.9 + 0.1 * wy) + 1.2 * (wb - wy);
        vec3 dim = vec3(0.5 * wy) + (wb - wy);
        face = mix(face, mix(lit, dim, light_text), amount);
    }

    // Under SDR the face is held below the rim.
    face *= mix(1.0, hold, smoothstep(LIQ_HOLD_EDGE, 2.0 * LIQ_HOLD_EDGE, depth));

    // Glint: screen-blended in the colour of what's behind, lighter and a
    // little more saturated, so over black there is none.
    float gw = max(LIQ_GLINT_WIDTH, aa);
    if (glint > 0.0 && depth < gw) {
        float gx = depth / gw;
        float band = sqrt(max(1.0 - gx * gx, 0.0));
        vec3 here = texture2D(HALF_TEX, st * half_k).rgb;
        float hy = dot(here, LUMA);
        vec3 shine = sqrt(clamp(vec3(hy) + (here - hy) * LIQ_GLINT_SAT, 0.0, 1.0));
        face = 1.0 - (1.0 - face) * (1.0 - glint * abs(dot(n, LIQ_KEY)) * band * shine);
    }
    rgb = face + (hash(px) - 0.5) * grain;

    // Contour: a line just outside the silhouette (the drawn rectangle reaches
    // past the actor for it), the unblurred backdrop darkened, on light and
    // dark glass alike. Never mixed with the face, so over near-black it
    // stays darker than what's behind.
    if (contour > 0.0 && d > -aa) {
        float line = clamp(0.5 - (d - contour) / aa, 0.0, 1.0);
        vec3 dark_edge = texture2D(SHARP_TEX, st).rgb * mix(LIQ_CONTOUR_SIDE, LIQ_CONTOUR_FLAT, n.y * n.y);
        rgb = mix(dark_edge, clamp(rgb, 0.0, 1.0), inside / max(line, 0.0001));
        inside = line;
    }
} else {
    // Edge lens: towards the outline the rim bends what's behind, pulling it from
    // further in, as a thick curved edge does. Follows the idea of Liquid Glass
    // for GNOME Shell (ryohsuke1231, MIT).
    if (lens > 0.0) {
        float band = min(18.0, min(size.x, size.y) * 0.3);
        // The direction from a rounder box than the surface, so it turns smoothly
        // through the corner instead of folding along the diagonal.
        vec2 q = max(abs(p) - size * 0.5 + band, vec2(0.0001));
        float t = clamp(1.0 + d / band, 0.0, 1.0);
        // Under a third of the band, so the pull never folds what's behind over
        // (refraction at 1 mirrored text along the edge).
        vec2 pull = -sign(p) * normalize(q) * min(lens, band * 0.3) * t * t * t;
        rgb = texture2D(cogl_sampler0, cogl_tex_coord_in[0].st + pull / size * uv_size).rgb;
    }
    float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb = mix(vec3(luma), rgb, saturation) * brightness;
    // Contrast guard: where what's behind fights the theme's text (a dark window
    // under light glass), the tint thickens. Blurred input, so it stays smooth.
    float clash = mix(1.0 - smoothstep(0.12, 0.5, luma), smoothstep(0.42, 0.7, luma), light_text);
    rgb = mix(rgb, tint.rgb, mix(tint.a, max(tint.a, 0.8), clash * guard));
    // A fine dark outline keeps the shape readable over light content; a
    // specular rim just inside it, strongest along the top, gives the edge its light.
    float ring = clamp(1.0 - abs(d + 1.5) / 0.9, 0.0, 1.0);
    rgb += ring * rim * mix(0.35, 1.0, 1.0 - uv.y);
    rgb = mix(rgb, vec3(0.0), clamp(1.0 - abs(d + 0.6) / 0.8, 0.0, 1.0) * outline);
    rgb += (hash(px) - 0.5) * grain;
}
cogl_color_out = vec4(clamp(rgb, 0.0, 1.0), 1.0) * inside;
`;

// The shadow is drawn by the glass itself, after it copied what's behind: a
// CSS box-shadow also paints under the transparent middle, and the glass would
// blur its own shadow into a muddy tint.

// How far past the surface the blur reads real pixels, in blur sigmas.
const BLUR_REACH = 2.5;

const NO_ROOM = {left: 0, right: 0, top: 0, bottom: 0};

// Room around the actor the shadow can reach.
const SHADOW_PAD = 80;
// Liquid glass's contour lies just outside the actor: the glass draws this far
// past it on every side.
const EDGE_ROOM = 2;

const UNIFORMS = ['size', 'uv_origin', 'uv_size', 'radius', 'exponent', 'aa', 'tint', 'saturation', 'brightness', 'rim', 'outline', 'grain', 'guard', 'light_text', 'lens', 'liquid'];

// GNOME 51 removed Shell.GLSLEffect. Until the shaders are ported, the modules
// that need them stay off there (extension.js checks this) instead of the whole
// extension failing to load.
export const SHADERS_OK = typeof Shell.GLSLEffect === 'function';

// Whether the shell's glass surfaces use the dark palette. Apple's floating
// panels (apps panel, widgets, Control Center) are the wallpaper dimmed with
// white text in light mode too; 'wallpaper' tone does that while apps stay
// light, 'theme' follows light and dark.
export function shellDark(settings, iface) {
    return iface.get_string('color-scheme') === 'prefer-dark' ||
        (settings.get_boolean('module-glass') && SHADERS_OK && settings.get_string('glass-tone') === 'wallpaper');
}

export const GlassEffect = GObject.registerClass(
class SuperGGlassEffect extends (SHADERS_OK ? Shell.GLSLEffect : Clutter.OffscreenEffect) {
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
        f('liquid', [0]);
        f('grain', [u.grain]);
        this.queue_repaint();
    }
});

/* ---------------------------------------------------------- live glass -- */

// The fewest milliseconds between full copies when only part of a surface changed.
const PARTIAL_COPY_MS = 50;
const HOLD_MARGIN_MS = 30;

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
    // Liquid glass's other levels of the copy, sampled by hand: half frost,
    // the unblurred copy and the wide bleed level (HALF_TEX, SHARP_TEX, WIDE_TEX).
    for (const layer of [1, 2, 3]) {
        glass.set_layer_filters(layer, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        glass.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        glass.set_layer_combine(layer, 'RGBA = REPLACE(PREVIOUS)');
    }
    glass.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, LIVE_DECLARATIONS,
        `size = vec2(size_x, size_y);\nuv_origin = vec2(uv_x, uv_y);\nuv_size = vec2(uv_w, uv_h);\ntint = vec4(tint_r, tint_g, tint_b, tint_a);\n${CODE}`));
    templates = {context, glass, shadow: shadowTemplate(context), passes: new Map()};
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

// Layers follow their surfaces on every stage update. Not with a repeating
// BEFORE_REDRAW later: mutter 18 schedules a new update for one that stays,
// so the stage spun through empty updates (tens of thousands a second, a
// whole core) whenever nothing drew.
const followers = new Set();
let followId = 0;

function follow(layer) {
    followers.add(layer);
    followId ||= global.stage.connect('before-update', () => {
        for (const l of followers) {
            if (l.mapped || l._track)
                l._sync();
        }
    });
}

function unfollow(layer) {
    followers.delete(layer);
    if (!followers.size && followId) {
        global.stage.disconnect(followId);
        followId = 0;
    }
}

function paintSource(context) {
    if (paintingView) {
        const {x, y} = paintingView.layout;
        return {fb: paintingView.get_framebuffer(), x, y, scale: paintingView.get_scale()};
    }
    const fb = context.get_framebuffer();
    // A screenshot's framebuffer has the stage's shape. Anything else is an
    // offscreen pass of a parent, with nothing behind us in it.
    const stage = global.stage;
    const borrowed = Math.abs(fb.get_height() / fb.get_width() - stage.height / stage.width) > 0.01;
    return {fb, x: 0, y: 0, scale: fb.get_width() / stage.width, borrowed};
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

// Per-frame uniforms: where the shown part lies in the copy, the texel steps of
// the half-frost and bleed levels, and how much of the copy is real pixels.
// half_k and wide_k take a level-0 coordinate to those levels: level L holds the
// copy in ceil(used / 2^L) of its ceil(capacity / 2^L) texels, a slightly
// different share than level 0 has.
const UV_UNIFORMS = ['uv_x', 'uv_y', 'uv_w', 'uv_h', 'half_du', 'half_dv', 'wide_du', 'wide_dv', 'used_u', 'used_v',
    'half_ku', 'half_kv', 'wide_ku', 'wide_kv'];

// How a level-0 coordinate scales to level L of a copy `used` texels wide in
// targets of `cap`.
const levelScale = (used, cap, level) => (levelSize(used, level) / levelSize(cap, level)) / (used / cap);

// The down chain's level L, sampled bilinearly, is blurred by about this many
// device pixels times 2^L.
const LEVEL_SIGMA = 0.65;
// Bleed: a level blurred by about a quarter of the short side (its wide taps
// double that, about Apple's 0.56 S), no coarser than 64 pt a texel (its taps
// then reach about Apple's 128 pt cap), and at least 2 texels across the
// glass. Real pixels around the glass for 0.3 of the short side (at most
// 64 pt): the outward pull, 0.35 S at most, stops there.
const BLEED_SIGMA = 0.25;
const BLEED_MAX_TEXEL = 64;
const BLEED_PAD = 0.3;
const BLEED_PAD_MAX = 64;
const BLEED_PULL = 0.35;

const bleedPad = small => Math.min(BLEED_PAD * small, BLEED_PAD_MAX);

const levelFor = sigma => Math.round(Math.log2(Math.max(sigma, LEVEL_SIGMA) / LEVEL_SIGMA));

// Which levels of the copy liquid glass reads, how far past the actor it
// copies, and the grid the copy aligns to. Frosted glass keeps its own chain.
function liquidLevels(u, sigma, passes, actor, scale) {
    if (!u.liquid)
        return {half: 1, deep: passes, pad: 0, align: passes};
    const half = Math.min(passes, levelFor(sigma / 2));
    const small = Math.min(actor.width, actor.height);
    let deep = passes;
    if (u.tone.bleed > 0) {
        const most = Math.floor(Math.log2(BLEED_MAX_TEXEL * scale));
        deep = Math.min(Math.max(levelFor(BLEED_SIGMA * small * scale), passes), Math.max(most, passes));
        while (deep > passes && small * scale / 2 ** deep < 2)
            deep--;
    }
    const pad = u.tone.bleed > 0 ? Math.ceil(bleedPad(small) * scale) : 0;
    // The coarsest levels only feed the bleed, which is wide enough not to
    // shimmer on a moving surface: aligning to them would copy far more.
    return {half, deep, pad, align: Math.min(deep, passes + 2)};
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

    // Closed menus shouldn't sit on GPU memory; the next open makes them again.
    release() {
        this._context = null;
        this._down = this._up = this._downPass = this._upPass = [];
        this._regions = null;
        this._glass = this._shadow = this._shadowPipeline = null;
        this._levels = null;
        this._applied = this._sampled = null;
        this._drawn = null;
    }

    // One target per blur level, kept while they still fit: copies change size
    // as surfaces move near the screen's edges.
    // deep: the deepest down level, past `passes` for liquid glass's bleed.
    _ensure(context, width, height, passes, deep) {
        if (this._context !== context || !textureFits(width, this._capW) || !textureFits(height, this._capH)) {
            const limit = largestViewSize();
            const sameContext = this._context === context;
            // A surface that outgrew its copy may still be growing: leave
            // headroom, not the whole screen. Full-view targets for a calendar
            // whose weather row loaded cost a long first frame and memory.
            this._capW = !sameContext ? width : getTextureCapacity(width, this._capW, limit.width);
            this._capH = !sameContext ? height : getTextureCapacity(height, this._capH, limit.height);
            this._context = context;
            this._down = [];
            this._up = [];
            this._downPass = [];
            this._upPass = [];
            this._regions = new Map();
            this._glass = null;
            this._usedW = this._usedH = 0;
            this._applied = this._sampled = null;
        }
        const target = level => createRenderTarget(context, levelSize(this._capW, level), levelSize(this._capH, level));
        const fresh = this._down.length <= deep || this._usedW !== width || this._usedH !== height;
        for (let level = this._down.length; level <= deep; level++)
            this._down.push(target(level));
        for (let level = 1; level <= deep; level++) {
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
            this._glass.set_layer_texture(2, this._down[0].texture);
            this._shadowPipeline = templates.shadow.copy();
            this._shadow = new ShadowPainter(this._shadowPipeline);
            this._levels = null;
            this._applied = null;
            this._uv = [];
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

    // Which levels the liquid face reads: half frost for the rim and lens, the
    // deepest for bleed (and the vibrant shadow's colour).
    _bindLevels(half, deep) {
        if (this._levels?.half === half && this._levels.deep === deep)
            return;
        this._glass.set_layer_texture(1, this._down[half].texture);
        this._glass.set_layer_texture(3, this._down[deep].texture);
        this._shadowPipeline.set_layer_texture(0, this._down[deep].texture);
        this._levels = {half, deep};
        this._uv = [];
    }

    _pass(context, source, declarations, code, original = null) {
        // A snippet of its own would compile again, a frame's stall on a real GPU,
        // each time a surface grows or a menu reopens.
        const {passes} = shaderTemplates(context);
        if (!passes.has(code))
            passes.set(code, createPassPipeline(context, source.texture, declarations, code));
        const pipeline = passes.get(code).copy();
        pipeline.set_layer_texture(0, source.texture);
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
        if (this._sampled?.passes === passes && this._sampled.blend === blend)
            return;
        for (let level = passes - 1; level >= 0; level--) {
            const source = level === passes - 1 ? this._down[level + 1] : this._up[level + 1];
            this._upPass[level].set_layer_texture(0, source.texture);
            setFloat(this._upPass[level], 'level_blend', level === passes - 1 ? blend : 1);
        }
        this._sampled = {passes, blend};
    }

    // Constant for the layer's life: parents cache their volume from this, and
    // a stale one culls what grew past it (the dock's ends and shadow, cut off).
    vfunc_modify_paint_volume(volume) {
        const pad = (this._layer.wantsShadow ? SHADOW_PAD : 0) + EDGE_ROOM;
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
        const set = (name, v) => p.set_uniform_1f(uniformLocation(p, name), v);
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
        set('liquid', u.liquid ? 1 : 0);
        set('grain', u.grain);
        const t = u.tone;
        set('band_lo', t?.lo ?? 0);
        set('band_hi', t?.hi ?? 0);
        set('band_chroma', t?.chroma ?? 0);
        set('bleed', t?.bleed ?? 0);
        set('hold', t?.hold ?? 1);
        set('glint', t?.glint ?? 0);
        set('contour', t?.contour ?? 0);
        set('bleed_pull', t?.pull ?? 0);
    }

    vfunc_paint_node(node, paintContext, _flags) {
        const actor = this.get_actor();
        const u = this._layer.uniforms;
        // Clone paints (workspace thumbnails) have no stage pixels behind them.
        if (!u || actor.is_in_clone_paint() || !actor.width || !actor.height)
            return;
        const source = paintSource(paintContext);
        const box = source.borrowed ? this._drawn : this._refresh(node, paintContext, source, actor, u);
        if (!box)
            return;

        // The shown part of the blurred copy: the actor, plus any stretch.
        const s = this._layer.stretch;
        const shown = this._drawn ?? box;
        const used = [shown.width / this._capW, shown.height / this._capH];
        const {half, deep} = this._levels;
        const k = level => [levelScale(shown.width, this._capW, level), levelScale(shown.height, this._capH, level)];
        const [halfKu, halfKv] = k(half), [wideKu, wideKv] = k(deep);

        if (u.shadow) {
            const x = -s.left - SHADOW_PAD, y = -s.top - SHADOW_PAD;
            const width = actor.width + s.left + s.right + 2 * SHADOW_PAD, height = actor.height + s.top + s.bottom + 2 * SHADOW_PAD;
            // A vibrant shadow takes its colour from the copy's widest level.
            this._shadow.paint(node, {x, y, width, height,
                box: {x1: -s.left, y1: -s.top, x2: actor.width + s.right, y2: actor.height + s.bottom},
                radius: u.radius, exponent: u.exponent, aa: u.aa, layers: u.shadow, vibrant: u.vibrant ?? 0,
                map: [(shown.ox + x * box.scale) / this._capW * wideKu, (shown.oy + y * box.scale) / this._capH * wideKv,
                    width * box.scale / this._capW * wideKu, height * box.scale / this._capH * wideKv,
                    used[0] * wideKu, used[1] * wideKv]});
        }

        const uvX1 = (shown.ox - s.left * box.scale) / this._capW;
        const uvY1 = (shown.oy - s.top * box.scale) / this._capH;
        const uvX2 = (shown.ox + (actor.width + s.right) * box.scale) / this._capW;
        const uvY2 = (shown.oy + (actor.height + s.bottom) * box.scale) / this._capH;
        // Between changes these stay on the pipeline; only a moving surface resends them.
        if (this._applied !== u) {
            this._setUniforms(u);
            this._applied = u;
        }
        const uv = [uvX1, uvY1, uvX2 - uvX1, uvY2 - uvY1,
            2 ** half / this._capW, 2 ** half / this._capH, 2 ** deep / this._capW, 2 ** deep / this._capH, ...used,
            halfKu, halfKv, wideKu, wideKv];
        UV_UNIFORMS.forEach((name, i) => {
            if (this._uv[i] !== uv[i]) {
                this._uv[i] = uv[i];
                this._glass.set_uniform_1f(uniformLocation(this._glass, name), uv[i]);
            }
        });
        // Past the actor by EDGE_ROOM, for the contour; the shader still maps
        // the actor's own box through uv_*.
        const ex = EDGE_ROOM * box.scale / this._capW, ey = EDGE_ROOM * box.scale / this._capH;
        const out = new Clutter.PipelineNode(this._glass);
        out.add_texture_rectangle(new Clutter.ActorBox({x1: -s.left - EDGE_ROOM, y1: -s.top - EDGE_ROOM,
            x2: actor.width + s.right + EDGE_ROOM, y2: actor.height + s.bottom + EDGE_ROOM}),
        uvX1 - ex, uvY1 - ey, uvX2 + ex, uvY2 + ey);
        node.add_child(out);
    }

    // A new copy of what's behind, blurred. Returns its box, or null off screen.
    _refresh(node, paintContext, source, actor, u) {
        if (this._layer.holding && this.holdReady && this._drawn)
            return this._drawn;
        const fb = source.fb;
        const sigma = u.blur * source.scale;
        const {passes, blend} = getKawaseConfiguration(sigma * 4);
        const {half, deep, pad, align} = liquidLevels(u, sigma, passes, actor, source.scale);
        const box = sourceBox(actor, source, this._layer.room, Math.max(Math.ceil(sigma * BLUR_REACH), pad), 2 ** align);
        if (box.ax2 <= box.ax1 || box.ay2 <= box.ay1)
            return null;
        this._ensure(fb.get_context(), box.width, box.height, passes, deep);
        this._sampling(passes, blend);
        this._bindLevels(half, deep);

        // A partial redraw would copy our own previous frame from the
        // undamaged part. Show the last clean blur and ask for a full redraw
        // of the glass, which is then copied clean.
        const clip = paintContext.get_redraw_clip?.();
        let clean = true;
        if (clip) {
            // The glass, in stage coordinates and rounded outwards, must lie
            // wholly inside the redraw: the rest of the buffer still holds an
            // older frame, our own glass included, and copying that froze the
            // glass on its own past output. Summing rectangles scaled to device
            // pixels counted their rounded overlaps twice at 133% and passed.
            // Liquid glass's bleed and vibrant shadow read the ring around it
            // too, as far as a full redraw of the layer reaches.
            const {x: ox, y: oy, scale} = source;
            const reach = this._layer.reach, shade = this._layer.wantsShadow ? SHADOW_PAD : 0;
            // Never past the copy, which stops at the framebuffer's edge.
            const ring = side => Math.min(pad / scale, reach[side] + shade);
            const x1 = Math.floor(ox + Math.max(box.ax1 / scale - ring('left'), box.x / scale));
            const y1 = Math.floor(oy + Math.max(box.ay1 / scale - ring('top'), box.y / scale));
            const x2 = Math.ceil(ox + Math.min(box.ax2 / scale + ring('right'), (box.x + box.width) / scale));
            const y2 = Math.ceil(oy + Math.min(box.ay2 / scale + ring('bottom'), (box.y + box.height) / scale));
            const overlap = clip.contains_rectangle(new Mtk.Rectangle({x: x1, y: y1, width: x2 - x1, height: y2 - y1}));
            clean = overlap === Mtk.RegionOverlap.IN;
            // Damage only around the glass (its shadow) needs no new copy.
            if (overlap === Mtk.RegionOverlap.PART)
                this._layer.queueFullRedraw();
        }

        if (clean || !this._captured) {
            blit(fb, this._down[0].framebuffer, box.x, box.y, 0, 0, box.width, box.height);
            const bounds = {x: 0, y: 0, width: box.width, height: box.height};
            for (let level = 1; level <= deep; level++)
                addPassNode(node, this._down[level], this._downPass[level], bounds, `glass down ${level}`);
            for (let level = passes - 1; level >= 0; level--)
                addPassNode(node, this._up[level], this._upPass[level], bounds, `glass up ${level}`);
            this._captured = clean;
            this._drawn = box;
            this.holdReady ||= clean;
            this._layer.lastCopy = GLib.get_monotonic_time();
        }
        return box;
    }
});

// style: {tint: [r,g,b,a], saturation, brightness, rim, grain, blur}
// smoothing: 0 = circular corners (matches CSS), up to 1 = squircle.
// shapeSource: actor whose CSS border-radius the glass follows (optional).
// The top bar slid out over a full-screen window. It's solid there: tracked glass
// trails a moving bar by a frame.
export const barOverFullscreen = () => !Main.overview.visible && !!Main.layoutManager.primaryMonitor?.inFullscreen;

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
    // thicken: 0-1, how far the tint goes towards solid, for what sits over a dim.
    // chrome: the dock and the top bar, which carry icons or text that adapts
    // to the backdrop. They stay clear; everything else carries text in the
    // theme's colour and gets liquid glass's reading treatment at any size.
    _init({style, shapeSource = null, radius = null, track = null, smoothing = 0.5, live = true, shadow = true, guard = 1,
        reach = NO_ROOM, thicken = 0, chrome = false}) {
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
        this._thicken = thicken;
        this._chrome = chrome;
        this.room = {...NO_ROOM};
        this.stretch = {...NO_ROOM};
        this.active = true;
        this._monitor = -1;
        this._stale = true;

        if (live) {
            this._liveEffect = new LiveGlassEffect(this);
            this.add_effect_with_name('super-g-glass', this._liveEffect);
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
        follow(this);
        if (live)
            this.connect('notify::mapped', () => {
                if (this.mapped)
                    this._liftOffscreen();
                else
                    this._liveEffect?.release();
            });
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

    // Called by the live effect during paint; the redraw itself must wait. Something
    // small moving on the surface (a spinner, a hover) asks for this every frame,
    // and redoing the whole blur that often is the most expensive thing glass does.
    queueFullRedraw() {
        if (this._redrawId)
            return;
        const run = () => {
            this._redrawId = 0;
            this.queue_redraw();
            return GLib.SOURCE_REMOVE;
        };
        const wait = Math.ceil(PARTIAL_COPY_MS - (GLib.get_monotonic_time() - (this.lastCopy ?? 0)) / 1000);
        this._redrawId = wait > 0
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, run)
            : GLib.idle_add(GLib.PRIORITY_HIGH, run);
    }

    // While a surface moves or changes size, what's behind it doesn't: blur once
    // and show that copy for `ms`, so an animation costs only the final pass.
    // room: how far it will grow, for that one copy. Without it, the last copy
    // is good enough (a surface about to shrink or leave).
    holdFor(ms, room = null) {
        if (!this._liveEffect)
            return;
        this.holding = true;
        if (room) {
            this.room = {...NO_ROOM, ...room};
            this._liveEffect.holdReady = false;
        } else {
            this._liveEffect.holdReady = true;
        }
        if (this._holdId)
            GLib.source_remove(this._holdId);
        this._holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms * St.Settings.get().slow_down_factor + HOLD_MARGIN_MS, () => {
            this._holdId = 0;
            this.holding = false;
            this.room = {...NO_ROOM};
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
        this._stale = true;
        this._sync();
        this.queue_redraw();
    }

    setStretch(stretch) {
        this.stretch = {...NO_ROOM, ...stretch};
        this._stale = true;
        this._sync();
    }

    setStyle(style) {
        this._style = style;
        if (this._blur)
            this._blur.radius = style.blur;
        this._stale = true;
        this._sync();
    }

    _teardown() {
        unfollow(this);
        if (this._redrawId)
            GLib.source_remove(this._redrawId);
        this._redrawId = 0;
        if (this._holdId)
            GLib.source_remove(this._holdId);
        this._holdId = 0;
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
            this._stale = true;
        });
    }

    _shapeRadius() {
        if (this._fixedRadius !== null)
            return this._fixedRadius;
        const source = this._shapeSource;
        if (!source?.get_theme_node || !source.mapped)
            return this._cachedRadius ?? 0;
        if (this._cachedRadius === undefined) {
            this._cachedRadius = source.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
            if (!this._radiusWatched) {
                this._radiusWatched = true;
                source.connectObject('style-changed', () => (this._cachedRadius = undefined), this);
            }
        }
        return this._cachedRadius;
    }

    // Runs before every redraw, for every layer: it stays out of the way unless
    // something really moved.
    _sync() {
        if (this._track) {
            const t = this._track;
            if (t.update && !t.update())
                return;
            // What's fading may be a parent, as with a zooming dialog.
            const opacity = t.get_paint_opacity?.() ?? t.opacity;
            const shown = this.active && t.mapped && opacity > 0;
            if (this.visible !== shown)
                this.visible = shown;
            if (!shown)
                return;
            // Forces any pending layout. Before it, a resizing actor reports its
            // preferred size, margins included.
            t.get_allocation_box?.();
            const [tx, ty] = t.get_transformed_position();
            const [tw, th] = t.get_transformed_size();
            const [rx, ry, rw, rh] = [Math.round(tx), Math.round(ty), Math.round(tw), Math.round(th)];
            if (rx !== this._tx || ry !== this._ty) {
                this.set_position(rx, ry);
                [this._tx, this._ty] = [rx, ry];
            }
            if (rw !== this._tw || rh !== this._th) {
                this.set_size(rw, rh);
                [this._tw, this._th] = [rw, rh];
            }
            if (this.opacity !== opacity)
                this.opacity = opacity;
        }
        const [x, y] = this.get_transformed_position();
        // Not placed yet: a parent has no usable transform this frame (the overview's
        // first one). Passing that on would allocate the wallpaper copy at NaN.
        if (Number.isNaN(x) || Number.isNaN(y))
            return;
        const w = this.width, h = this.height;
        const radius = this._shapeRadius();
        if (!this._stale && x === this._lx && y === this._ly && w === this._lw && h === this._lh && radius === this._lr)
            return;
        const monitor = Main.layoutManager.findIndexForActor(this._track instanceof Clutter.Actor ? this._track : this);
        if (monitor < 0)
            return;
        if (!this._live)
            this._ensureBackground(monitor);
        if (!w || !h)
            return;
        [this._lx, this._ly, this._lw, this._lh, this._lr] = [x, y, w, h, radius];
        this._stale = false;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const {left, right, top, bottom} = this.stretch;

        if (!this._live) {
            const geo = Main.layoutManager.monitors[monitor];
            this._bgGroup.set_position(Math.round(geo.x - x), Math.round(geo.y - y));
        }

        const s = this._style;
        const size = [w + left + right, h + top + bottom];
        const liquid = this._live && s.liquid;
        // Squircle corners: a higher exponent with a proportionally larger
        // radius keeps about the same visual size (as in the corners engine).
        // Liquid glass fits Apple's continuous corners instead.
        const {exponent, r} = liquid ? liquidCorners(radius, size)
            : {exponent: 2 + this._smoothing * 4, r: Math.min(radius * (2 + this._smoothing * 4) / 2, w / 2, h / 2)};
        const shadow = this._shadowOn ? s.shadow : null;
        this.uniforms = {
            size, radius: r, exponent, aa: 1 / scale, blur: s.blur,
            tint: layerTint(this, s), saturation: s.saturation, brightness: s.brightness, rim: s.rim, outline: s.outline, grain: s.grain,
            guard: this._guard, lightText: s.lightText, lens: this._live ? s.lens : 0, liquid, shadow, tone: null, vibrant: 0,
        };
        if (liquid) {
            const small = Math.min(...size);
            const tone = liquidTone(s.lightText > 0.5, s.clarity, small, this._thicken, this._chrome);
            Object.assign(this.uniforms, {
                blur: liquidFrost(s.clarity, small, this._thicken), grain: LIQ_DITHER,
                // The flush top bar runs edge to edge: no rim, no contour, or
                // they'd draw a box round the top of the screen.
                tone: {...tone, hold: LIQ_HOLD, glint: s.rim > 0 ? LIQ_GLINT : 0, contour: s.outline > 0 ? LIQ_CONTOUR : 0,
                    pull: Math.min(BLEED_PULL * small, bleedPad(small))},
                shadow: shadow ? liquidShadow(s.shadowStyle, small) : null,
                vibrant: smooth(LIQ_SMALL, LIQ_BIG, small) * LIQ_SHADOW_VIBRANT,
            });
        } else if (s.liquid) {
            // The overview's wallpaper backdrop keeps the static glass it had.
            Object.assign(this.uniforms, {blur: Math.max(s.blur * 1.6, 11), rim: 1,
                tint: [...s.tint.slice(0, 3), Math.max(this.uniforms.tint[3], s.lightText ? 0.06 : 0.15)]});
        }
        if (this._effect)
            this._effect.setUniforms(this.uniforms);
        else
            this.queue_redraw();
    }
});

// Tint with the thickening for what sits over a dim (frosted glass).
function layerTint(layer, s) {
    let a = s.tint[3];
    if (layer._thicken)
        a += (1 - a) * layer._thicken;
    return [s.tint[0], s.tint[1], s.tint[2], a];
}

/* ------------------------------------------------------ liquid glass -- */

// Apple's glass, after docs/LIQUID_GLASS.md. S is the short side in points.
const smooth = (a, b, x) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAll = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));

// Small controls and big glass, as AppKit sizes its inputs.
const LIQ_SMALL = 64;
const LIQ_BIG = 160;
// Bleed fades in from S = 64 to S = 160.
const LIQ_BLEED_FROM = 64;
const LIQ_BLEED_OVER = 96;
const LIQ_HOLD = 0.97;
const LIQ_GLINT = 0.5;
// Points: just outside the face.
const LIQ_CONTOUR = 0.75;
const LIQ_DITHER = 1 / 255;
// Where the clarity slider sits on Apple's regular glass: the schema's
// default. Below it the glass goes towards clear, above towards tinted.
const LIQ_REGULAR_AT = 0.3;

// [black, white, chroma]: what a flat backdrop of luma 0 and 1 shows as, and
// how much of its colour stays (docs/LIQUID_GLASS.md, "Tone"). Totals, bleed
// included: liquidTone solves the band under it.
// The clear end goes most of the way to Apple's Clear material (0.075 -> 1.15),
// which is for media: at 0.53 over white it still read as a grey slab. Dark
// glass now reaches 0.7 over white (white text about 2.3:1 there, and only
// over a white window), light glass 0.42 over black. The band stays on the
// text's side; anyone who reads over bright windows moves the slider up.
const LIQ_BANDS = {
    light: {clear: [0.42, 1.0, 0.92], regular: [0.70, 1.0, 0.6], tinted: [0.85, 1.0, 0.4], small: [0.89, 1.0, 0.75]},
    // macOS 27.2's lighter dark glass, the wash more opaque towards tinted.
    dark: {clear: [0.03, 0.7, 0.92], regular: [0.08, 0.49, 0.6], tinted: [0.08, 0.42, 0.8]},
};

// Frost in points: chrome 4.5, big panels 8.5 at regular; clear 0.35 of
// that (0.65 still frosted text behind past reading), tinted 2.2 times
// (about 18.7 on a big panel), as macOS 27's slider.
const LIQ_FROST = {chrome: 4.5, panel: 8.5, clear: 0.35, tinted: 2.2};

// What sits over a dim (a folder dialog) goes half way towards tinted.
const clarityWith = (clarity, thicken) => clarity + (1 - clarity) * thicken * 0.5;

function liquidFrost(clarity, small, thicken = 0) {
    const t = clarityWith(clarity, thicken);
    const regular = lerp(LIQ_FROST.chrome, LIQ_FROST.panel, smooth(48, 320, small));
    return t <= LIQ_REGULAR_AT ? regular * lerp(LIQ_FROST.clear, 1, t / LIQ_REGULAR_AT)
        : regular * lerp(1, LIQ_FROST.tinted, (t - LIQ_REGULAR_AT) / (1 - LIQ_REGULAR_AT));
}

// The bleed over a flat backdrop of luma y, for a face of luma f: its toned
// colour and how much of it the shader mixes in.
function bleedOver(y, f, dark, fade) {
    const c = Math.min(Math.max(f, 0), 1);
    return dark ? {tone: 0.5 * y, amount: 0.8 * (1 - c) ** 4 * fade}
        : {tone: 0.9 + 0.1 * y, amount: 0.5 * c ** 4 * fade};
}

// The face's luma that, with the bleed mixed in, shows `target` over a flat
// backdrop of luma y. Monotonic over the range, so bisection finds it.
function faceFor(target, y, dark, fade) {
    let lo = -0.2, hi = 1.3;
    for (let i = 0; i < 32; i++) {
        const f = (lo + hi) / 2;
        const {tone, amount} = bleedOver(y, f, dark, fade);
        if (f + (tone - f) * amount < target)
            lo = f;
        else
            hi = f;
    }
    return (lo + hi) / 2;
}

// The band for a surface: lo and hi are the face at backdrop luma 0 and 1,
// chroma its colour factor, bleed the bleed's fade with size.
// dark: dark glass (light text); clarity 0-1; small: the short side.
// chrome: the dock, the top bar and its islands take the surface band
// whatever their height: Apple's small-control band is for buttons.
export function liquidTone(dark, clarity, small, thicken = 0, chrome = false) {
    const bands = LIQ_BANDS[dark ? 'dark' : 'light'];
    const sm = dark || chrome ? 0 : 1 - smooth(48, LIQ_SMALL, small);
    const regular = bands.small ? lerpAll(bands.regular, bands.small, sm) : bands.regular;
    const tinted = bands.small ? lerpAll(bands.tinted, bands.small, sm) : bands.tinted;
    const t = clarityWith(clarity, thicken);
    const [black, white, chroma] = t <= LIQ_REGULAR_AT ? lerpAll(bands.clear, regular, t / LIQ_REGULAR_AT)
        : lerpAll(regular, tinted, (t - LIQ_REGULAR_AT) / (1 - LIQ_REGULAR_AT));
    const bleed = Math.min(Math.max((small - LIQ_BLEED_FROM) / LIQ_BLEED_OVER, 0), 1);
    // Brightness is fitted to the totals (macOS 27.2's dark band was measured
    // over flat colours, bleed and all); chroma is the face's own factor, as
    // Apple's inputs give it, and the bleed brings the surroundings' on top.
    return {lo: faceFor(black, 0, dark, bleed), hi: faceFor(white, 1, dark, bleed), chroma, bleed};
}

// Continuous corners: an exponent-3 superellipse at 1.375 times the radius.
// A capsule stays round: over the last tenth before the radius reaches half
// the short side, the exponent eases to 2, so the outline never jumps as a
// surface grows through it.
const LIQ_CAPSULE_EASE = 0.9;

function liquidCorners(radius, [w, h]) {
    const cap = Math.min(w, h) / 2;
    const r = radius * 1.375;
    const round = smooth(LIQ_CAPSULE_EASE * cap, cap, r);
    return {exponent: 3 - round, r: Math.min(r, cap)};
}

// [drop, sigma, alpha] x 3. Big glass: about 25% at most, 8 pt down, fading
// over about 48 pt, with a tight contact layer at the edge; small glass: up to
// about 45%, tighter and darker.
const LIQ_SHADOW = {
    big: [8, 20, 0.3, 2, 4, 0.14, 0, 1, 0],
    small: [3, 6, 0.32, 1, 2, 0.2, 0, 1, 0],
};
// How much of big glass's shadow colour is the vibrant backdrop. Apple's is
// all of it, which over a white window darkens by 3% and leaves a panel with
// no edge against it; 40% plain shade keeps one (about 12% at the edge).
const LIQ_SHADOW_VIBRANT = 0.6;
const LIQ_SHADOW_SCALE = {subtle: 0.6, standard: 1, deep: 1.4};

function liquidShadow(style, small) {
    const scale = LIQ_SHADOW_SCALE[style];
    if (!scale)
        return null;
    const layers = lerpAll(LIQ_SHADOW.small, LIQ_SHADOW.big, smooth(LIQ_SMALL, LIQ_BIG, small));
    return layers.map((v, i) => (i % 3 === 2 ? Math.min(v * scale, 0.6) : v));
}

// What the top bar's liquid glass shows over a wallpaper of linear luminance
// `wall`, as linear luminance; null when the bar isn't liquid glass.
export function liquidBarLuminance(wall, settings, iface, height) {
    if (!isLiquid(settings) || !SHADERS_OK)
        return null;
    const {lo, hi} = liquidTone(shellDark(settings, iface), settings.get_double('glass-clarity'), height, 0, true);
    return Math.min(Math.max(lo + (hi - lo) * wall ** (1 / 2.2), 0), 1) ** 2.2;
}

// Thickness, as Apple names its materials: how much palette colour the glass
// carries, how far it blurs, how much colour it lets through.
const MATERIALS = {
    'ultra-thin': {tint: 0.18, blur: 26, saturation: 1.55},
    'thin': {tint: 0.34, blur: 32, saturation: 1.55},
    'regular': {tint: 0.5, blur: 40, saturation: 1.5},
    'thick': {tint: 0.68, blur: 48, saturation: 1.45},
    'ultra-thick': {tint: 0.84, blur: 56, saturation: 1.3},
};

const isLiquid = settings => settings.get_string('glass-style') === 'liquid';

// Liquid glass has one control, as on Apple's: clarity, from clear (the bevel
// and what's behind carry it) to tinted (calmer, for reading). Live liquid
// glass takes its band and frost from liquidTone and liquidFrost; this only
// feeds the overview's static wallpaper backdrop.
function liquidMaterial(settings) {
    const t = settings.get_double('glass-clarity');
    // Clear is nearly water: Apple's clear glass shows the pixels behind almost
    // as they are, and the bevel does the work. The floor used to be a 12 px blur
    // with a 1.6 saturation boost, which read as frosted.
    const eased = Math.pow(t, 1.3);
    const lerp = (a, b) => a + (b - a) * eased;
    return {tint: lerp(0.02, 0.62), blur: Math.round(lerp(2, 30) * 10) / 10, saturation: lerp(1.12, 1.35)};
}

function material(settings) {
    if (isLiquid(settings))
        return liquidMaterial(settings);
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
    if (isLiquid(settings))
        return c.dark ? tint * 0.75 : Math.min(tint * 1.3, 0.9);
    return c.dark ? Math.max(tint * 0.95, 0.3) : Math.min(tint * 1.25, 0.92);
}

// Glass parameters from the palette, light or dark.
export function glassStyle(c, settings) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.window.slice(i, i + 2), 16) / 255);
    const {blur, saturation} = material(settings);
    return {
        tint: [r, g, b, glassAlpha(c, settings)],
        saturation,
        // Apple's dark glass dims what's behind by about a third and keeps its
        // colour; ours did neither, so white text sat on bright orange.
        brightness: isLiquid(settings) ? (c.dark ? 0.62 : 1.02) : c.dark ? 0.92 : 1.04,
        rim: c.dark ? 0.12 : 0.26,
        outline: c.dark ? 0.26 : 0.1,
        lightText: c.dark ? 1 : 0,
        lens: isLiquid(settings) ? 1 : settings.get_double('glass-refraction') * 12,
        liquid: isLiquid(settings),
        shadow: surfaceShadow(settings.get_string('shadow-style'), c.dark),
        shadowStyle: settings.get_string('shadow-style'),
        clarity: settings.get_double('glass-clarity'),
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
