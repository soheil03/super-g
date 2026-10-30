// SPDX-License-Identifier: GPL-3.0-or-later
// Ubuntu Plus glass: GNOME's own GPU blur (Shell.BlurEffect) of the
// wallpaper, finished by one shader pass that does what the stock blur
// can't: an anti-aliased squircle outline, vibrancy (saturation and
// brightness lift), a palette tint, a specular rim that is brightest at the
// top edge, and a little grain against banding.
//
// A GlassLayer blurs the monitor's wallpaper (cached by the blur effect, so
// it costs nothing while the wallpaper is still) and shows the part under
// itself, following its own position on screen every frame.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DECLARATIONS = `
uniform vec2 size;
uniform float radius;
uniform float exponent;
uniform float aa;
uniform vec4 tint;
uniform float saturation;
uniform float brightness;
uniform float rim;
uniform float grain;

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

const CODE = `
vec2 uv = cogl_tex_coord_in[0].st;
vec2 px = uv * size;
float d = roundedBox(px - size * 0.5, size * 0.5, radius, exponent);
float inside = clamp(0.5 - d / aa, 0.0, 1.0);

vec3 rgb = cogl_color_out.rgb;
float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
rgb = mix(vec3(luma), rgb, saturation) * brightness;
rgb = mix(rgb, tint.rgb, tint.a);

// Specular rim: a hairline just inside the outline, strongest along the top.
float ring = clamp(1.0 - abs(d + 1.0) / 1.25, 0.0, 1.0);
rgb += ring * rim * mix(0.35, 1.0, 1.0 - uv.y);

rgb += (hash(px) - 0.5) * grain;
cogl_color_out = vec4(clamp(rgb, 0.0, 1.0), 1.0) * inside;
`;

const UNIFORMS = ['size', 'radius', 'exponent', 'aa', 'tint', 'saturation', 'brightness', 'rim', 'grain'];

export const GlassEffect = GObject.registerClass(
class UbuntuPlusGlassEffect extends Shell.GLSLEffect {
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
        f('radius', [u.radius]);
        f('exponent', [u.exponent]);
        f('aa', [u.aa]);
        f('tint', u.tint);
        f('saturation', [u.saturation]);
        f('brightness', [u.brightness]);
        f('rim', [u.rim]);
        f('grain', [u.grain]);
        this.queue_repaint();
    }
});

// style: {tint: [r,g,b,a], saturation, brightness, rim, grain, blur}
// smoothing: 0 = circular corners (matches CSS), up to 1 = squircle.
// shapeSource: actor whose CSS border-radius the glass follows (optional).
// track: actor whose on-screen box the glass copies (for layers that can't
// be its child, like the top bar's).
export const GlassLayer = GObject.registerClass(
class UbuntuPlusGlassLayer extends St.Widget {
    _init({style, shapeSource = null, radius = null, track = null, smoothing = 0.5}) {
        super._init({x_expand: true, y_expand: true, clip_to_allocation: true, reactive: false});
        this._style = style;
        this._shapeSource = shapeSource;
        this._fixedRadius = radius;
        this._track = track;
        this._smoothing = smoothing;
        this.active = true;
        this._monitor = -1;
        this._last = '';

        this._bgGroup = new Meta.BackgroundGroup();
        this.add_child(this._bgGroup);
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: style.blur, brightness: 1.0});
        this._bgGroup.add_effect_with_name('ubuntu-plus-blur', this._blur);
        this._effect = new GlassEffect();
        this.add_effect_with_name('ubuntu-plus-glass', this._effect);

        // Follow our on-screen position every frame while shown; cheap, and
        // it keeps the wallpaper still while menus and the dock move.
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (this.mapped || this._track)
                this._sync();
            return true;
        });
        this.connect('destroy', () => this._teardown());
    }

    // The layer holds a full-monitor wallpaper copy; it must never ask for
    // that much room, only fill what its parent gives it.
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    setStyle(style) {
        this._style = style;
        this._blur.radius = style.blur;
        this._last = '';
        this._sync();
    }

    _teardown() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
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
            const [tx, ty] = t.get_transformed_position();
            const [tw, th] = t.get_transformed_size();
            this.set_position(Math.round(tx), Math.round(ty));
            this.set_size(Math.round(tw), Math.round(th));
            this.visible = this.active && t.mapped && t.opacity > 0;
            this.opacity = t.opacity;
        }
        const monitor = Main.layoutManager.findIndexForActor(this._track ?? this);
        if (monitor < 0)
            return;
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

        const geo = Main.layoutManager.monitors[monitor];
        this._bgGroup.set_position(Math.round(geo.x - x), Math.round(geo.y - y));

        // Squircle corners: a higher exponent with a proportionally larger
        // radius keeps about the same visual size (as in the corners engine).
        const exponent = 2 + this._smoothing * 4;
        const r = Math.min(radius * exponent / 2, w / 2, h / 2);
        const s = this._style;
        this._effect.setUniforms({
            size: [w, h], radius: r, exponent, aa: 1 / scale,
            tint: s.tint, saturation: s.saturation, brightness: s.brightness, rim: s.rim, grain: s.grain,
        });
    }
});

// Glass parameters from the palette, light or dark.
export function glassStyle(c, settings) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.window.slice(i, i + 2), 16) / 255);
    const strength = settings.get_double('glass-tint');
    return {
        tint: [r, g, b, c.dark ? strength * 0.9 : strength],
        saturation: settings.get_double('glass-saturation'),
        brightness: c.dark ? 0.92 : 1.04,
        rim: c.dark ? 0.16 : 0.32,
        grain: 0.012,
        blur: settings.get_int('glass-blur'),
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
