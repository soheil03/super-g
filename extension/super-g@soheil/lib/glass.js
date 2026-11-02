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

vec3 rgb = cogl_color_out.rgb;
float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
rgb = mix(vec3(luma), rgb, saturation) * brightness;
// Contrast guard: where what's behind fights the theme's text (a dark window
// under light glass), the tint thickens. Blurred input, so it stays smooth.
float clash = mix(1.0 - smoothstep(0.12, 0.5, luma), smoothstep(0.55, 0.9, luma), light_text);
rgb = mix(rgb, tint.rgb, mix(tint.a, max(tint.a, 0.8), clash * guard));

// A fine dark outline keeps the shape readable over light content; a specular
// rim just inside it, strongest along the top, gives the edge its light.
float ring = clamp(1.0 - abs(d + 1.9) / 1.0, 0.0, 1.0);
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

const NO_ROOM = {left: 0, right: 0, top: 0, bottom: 0};

// Room around the actor the shadow can reach.
const SHADOW_PAD = 48;

const UNIFORMS = ['size', 'uv_origin', 'uv_size', 'radius', 'exponent', 'aa', 'tint', 'saturation', 'brightness', 'rim', 'outline', 'grain', 'guard', 'light_text'];

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

function renderTarget(context, width, height) {
    const texture = Cogl.Texture2D.new_with_size(context, width, height);
    texture.set_components(Cogl.TextureComponents.RGBA);
    texture.allocate();
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    framebuffer.allocate();
    framebuffer.orthographic(0, 0, width, height, -1, 1);
    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_layer_texture(0, texture);
    pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    return {texture, framebuffer, pipeline, width, height};
}

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

// The actor's box, grown by `room`, in the source framebuffer's pixels.
function sourceBox(actor, {fb, x: ox, y: oy, scale}, room) {
    const rect = actor.get_transformed_extents();
    const x = Math.floor((rect.get_x() - room.left - ox) * scale);
    const y = Math.floor((rect.get_y() - room.top - oy) * scale);
    const width = Math.max(1, Math.ceil((rect.get_width() + room.left + room.right) * scale));
    const height = Math.max(1, Math.ceil((rect.get_height() + room.top + room.bottom) * scale));
    const sx = Math.max(0, x), sy = Math.max(0, y);
    return {
        width, height, sx, sy, dx: sx - x, dy: sy - y, scale,
        cw: Math.max(0, Math.min(width - (sx - x), fb.get_width() - sx)),
        ch: Math.max(0, Math.min(height - (sy - y), fb.get_height() - sy)),
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

    _ensure(context, w, h) {
        if (this._capture?.width !== w || this._capture?.height !== h || this._context !== context) {
            this._context = context;
            this._capture = renderTarget(context, w, h);
            this._blurred = renderTarget(context, w, h);
            const templates = shaderTemplates(context);
            this._glass = templates.glass.copy();
            this._glass.set_layer_texture(0, this._blurred.texture);
            this._shadow = templates.shadow.copy();
            this._shadow.set_layer_texture(0, this._blurred.texture);
            this._uniforms = null;
            this._captured = false;
        }
    }

    vfunc_modify_paint_volume(volume) {
        const pad = this._layer.uniforms?.shadow ? SHADOW_PAD : 0;
        const room = this._layer.room;
        const origin = volume.get_origin();
        origin.x -= room.left + pad;
        origin.y -= room.top + pad;
        volume.set_origin(origin);
        volume.set_width(volume.get_width() + room.left + room.right + 2 * pad);
        volume.set_height(volume.get_height() + room.top + room.bottom + 2 * pad);
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
        const room = this._layer.room;
        const box = sourceBox(actor, source, room);
        if (!box.cw || !box.ch)
            return;
        this._ensure(fb.get_context(), box.width, box.height);

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
                const x1 = Math.max(box.sx, Math.floor((r.x - ox) * scale));
                const y1 = Math.max(box.sy, Math.floor((r.y - oy) * scale));
                const x2 = Math.min(box.sx + box.cw, Math.ceil((r.x + r.width - ox) * scale));
                const y2 = Math.min(box.sy + box.ch, Math.ceil((r.y + r.height - oy) * scale));
                if (x2 > x1 && y2 > y1)
                    covered += (x2 - x1) * (y2 - y1);
            }
            clean = covered >= box.cw * box.ch;
            if (!clean)
                this._layer.queueFullRedraw();
        }

        if (clean || !this._captured) {
            this._capture.framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);
            blit(fb, this._capture.framebuffer, box.sx, box.sy, box.dx, box.dy, box.cw, box.ch);
            const blurred = Clutter.LayerNode.new_to_framebuffer(this._blurred.framebuffer, this._blurred.pipeline);
            const blur = Clutter.BlurNode.new(box.width, box.height, Math.max(1, u.blur * box.scale / 2));
            blur.add_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: box.width, y2: box.height}));
            const pixels = new Clutter.PipelineNode(this._capture.pipeline);
            pixels.add_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: box.width, y2: box.height}));
            blur.add_child(pixels);
            blurred.add_child(blur);
            node.add_child(blurred);
            this._captured = clean;
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
        const uvX1 = (room.left - s.left) * box.scale / box.width;
        const uvY1 = (room.top - s.top) * box.scale / box.height;
        const uvX2 = (room.left + actor.width + s.right) * box.scale / box.width;
        const uvY2 = (room.top + actor.height + s.bottom) * box.scale / box.height;
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
    _init({style, shapeSource = null, radius = null, track = null, smoothing = 0.5, live = true, shadow = true, guard = 1}) {
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
            this.visible = this.active && t.mapped && t.opacity > 0;
            this.opacity = t.opacity;
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
            guard: this._guard, lightText: s.lightText, shadow: this._shadowOn ? s.shadow : 0, shadowSpread: s.shadowSpread, shadowDrop: s.shadowDrop,
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
    'ultra-thin': {tint: 0.18, blur: 22, saturation: 1.7},
    'thin': {tint: 0.34, blur: 30, saturation: 1.6},
    'regular': {tint: 0.5, blur: 40, saturation: 1.5},
    'thick': {tint: 0.68, blur: 52, saturation: 1.4},
    'ultra-thick': {tint: 0.84, blur: 64, saturation: 1.3},
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
    return c.dark ? tint * 0.9 : Math.min(tint * 1.25, 0.92);
}

// Glass parameters from the palette, light or dark.
export function glassStyle(c, settings) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.window.slice(i, i + 2), 16) / 255);
    const {blur, saturation} = material(settings);
    return {
        tint: [r, g, b, glassAlpha(c, settings)],
        saturation,
        brightness: c.dark ? 0.92 : 1.04,
        rim: c.dark ? 0.16 : 0.32,
        outline: c.dark ? 0.32 : 0.14,
        lightText: c.dark ? 1 : 0,
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
