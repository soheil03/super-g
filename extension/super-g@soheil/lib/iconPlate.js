// SPDX-License-Identifier: GPL-3.0-or-later
// The plate an app icon sits on, drawn by the GPU as Apple draws its tiles: a
// continuous-corner squircle (not CSS's circular corners) with a faint vertical
// gradient, a stacked soft shadow (wide ambient plus a tight contact line,
// where St has one CPU-blurred layer that reads as a grey halo), and over the
// icon a specular rim: bright where the edge faces up, a weaker reflection
// along the bottom, a hairline outside it that holds the shape on white.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ShadowPainter, shadowTemplate, uniformLocation} from './softShadow.js';

const NAMES = ['p_w', 'p_h', 'p_r', 'p_n', 'p_aa', 'p_top_r', 'p_top_g', 'p_top_b', 'p_bot_r', 'p_bot_g', 'p_bot_b',
    'p_part', 'p_spec', 'p_hair', 'p_fade', 'p_fill'];

const DECLARATIONS = `
${NAMES.map(n => `uniform float ${n};`).join('\n')}
float plateBox(vec2 p, vec2 half_size, float r, float n) {
    vec2 q = abs(p) - half_size + r;
    vec2 c = max(q, 0.0);
    float corner = pow(pow(c.x, n) + pow(c.y, n), 1.0 / n);
    return corner + min(max(q.x, q.y), 0.0) - r;
}
`;

// With art: a tile's own pixels, drawn by the plate and cut to its shape, so
// the tile's edge (a lighter ring, its own corners) never shows inside ours.
const code = art => `
vec2 size = vec2(p_w, p_h);
vec2 px = cogl_tex_coord_in[0].st * size;
vec2 p = px - size * 0.5;
float d = plateBox(p, size * 0.5, p_r, p_n);
float inside = clamp(0.5 - d / p_aa, 0.0, 1.0);
if (p_part < 0.5) {
    // The plate: a gradient, a touch lighter at the very top, as lit from above.
    float y = px.y / size.y;
    vec3 rgb = mix(vec3(p_top_r, p_top_g, p_top_b), vec3(p_bot_r, p_bot_g, p_bot_b), y);
    rgb += (1.0 - smoothstep(0.0, 0.5, y)) * 0.025;
${art ? `    vec2 iuv = p / (size * p_fill) + 0.5;
    vec2 within = step(vec2(0.0), iuv) * step(iuv, vec2(1.0));
    vec4 pic = texture2D(cogl_sampler1, iuv) * within.x * within.y;
    rgb = rgb * (1.0 - pic.a) + pic.rgb;` : ''}
    cogl_color_out = vec4(rgb, 1.0) * inside * p_fade;
} else {
    // The rim, over the icon. Normal from the shape's gradient.
    vec2 e = vec2(0.5, 0.0);
    vec2 n = vec2(plateBox(p + e.xy, size * 0.5, p_r, p_n) - plateBox(p - e.xy, size * 0.5, p_r, p_n),
                  plateBox(p + e.yx, size * 0.5, p_r, p_n) - plateBox(p - e.yx, size * 0.5, p_r, p_n));
    n = length(n) > 0.0001 ? normalize(n) : vec2(0.0, -1.0);
    float inward = -d;
    float up = max(-n.y, 0.0);
    float down = max(n.y, 0.0);
    // The specular line: about a device pixel and a half, one in from the edge.
    float w = max(0.9, p_aa);
    float band = smoothstep(0.3 * p_aa, p_aa, inward) * (1.0 - smoothstep(p_aa + w * 0.5, p_aa + w, inward));
    float facing = 0.05 + 0.95 * pow(up, 3.0) + 0.2 * pow(down, 3.0);
    // A soft glow under the top edge, the glass picking up light.
    float glow = exp(-inward / max(size.y * 0.05, 1.5)) * pow(up, 3.0) * 0.22;
    float spec = clamp((band * facing + glow) * p_spec, 0.0, 1.0) * inside;
    float hair = (1.0 - smoothstep(0.0, p_aa, inward)) * inside * p_hair;
    float a = spec + hair * (1.0 - spec);
    cogl_color_out = vec4(vec3(spec), a) * p_fade;
}
`;

let template = null;
function plateTemplate(context) {
    if (template?.context !== context) {
        // Only for coordinates, and so Cogl blends: it can't see into a snippet.
        const pixel = Cogl.Texture2D.new_with_size(context, 1, 1);
        const make = art => {
            const pipeline = Cogl.Pipeline.new(context);
            pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, code(art)));
            pipeline.set_layer_texture(0, pixel);
            if (art) {
                pipeline.set_layer_texture(1, pixel);
                pipeline.set_layer_filters(1, Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR, Cogl.PipelineFilter.LINEAR);
                pipeline.set_layer_wrap_mode(1, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
                // The art is sampled by hand; the layer adds nothing by itself.
                pipeline.set_layer_combine(1, 'RGBA = REPLACE(PREVIOUS)');
            }
            return pipeline;
        };
        const shadow = shadowTemplate(context).copy();
        shadow.set_layer_texture(0, pixel);
        template = {context, pipeline: make(false), art: make(true), shadow};
    }
    return template;
}

function textureOf(context, pixbuf) {
    const px = pixbuf.get_has_alpha() ? pixbuf : pixbuf.add_alpha(false, 0, 0, 0);
    return Cogl.Texture2D.new_from_data(context, px.get_width(), px.get_height(),
        Cogl.PixelFormat.RGBA_8888, px.get_rowstride(), px.get_pixels());
}

class Painter {
    constructor(pipeline) {
        this.pipeline = pipeline;
        this._values = [];
    }

    paint(node, width, height, values) {
        values.forEach((v, i) => {
            if (this._values[i] !== v) {
                this._values[i] = v;
                this.pipeline.set_uniform_1f(uniformLocation(this.pipeline, NAMES[i]), v);
            }
        });
        const out = new Clutter.PipelineNode(this.pipeline);
        out.add_texture_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height}), 0, 0, 1, 1);
        node.add_child(out);
    }
}

// One device pixel in the plate's own units, whatever scale it is drawn at.
function aaOf(actor) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const [shown] = actor.get_transformed_size();
    return actor.width / Math.max(shown * scale, 1);
}

// look: {top, bottom: [r, g, b] 0-255, radius: part of the size, exponent,
// spec, hair: rim strengths, shadow: [drop, sigma, alpha] x3, drop and sigma
// as parts of the size}
const Rim = GObject.registerClass(
class SuperGIconRim extends St.Widget {
    _init(plate) {
        super._init({x_expand: true, y_expand: true, reactive: false});
        this._plate = plate;
    }

    vfunc_paint_node(node, paintContext) {
        const plate = this._plate;
        const {width, height} = this;
        if (!width || !height || !plate.look)
            return;
        this._painter ??= new Painter(plateTemplate(paintContext.get_framebuffer().get_context()).pipeline.copy());
        this._painter.paint(node, width, height, plate.values(1, aaOf(this), this.get_paint_opacity() / 255));
    }
});

export const IconPlate = GObject.registerClass(
class SuperGIconPlate extends St.Widget {
    _init(icon, size, look) {
        super._init({
            style_class: 'super-g-icon-plate',
            layout_manager: new Clutter.BinLayout(),
            width: size,
            height: size,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.look = look;
        this.icon = icon;
        this._art = null;
        icon.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
        this.add_child(icon);
        this.add_child(new Rim(this));
    }

    // A tile's pixels, drawn by the plate in place of the icon. Null gives
    // the icon back.
    setArt(pixbuf) {
        this._art = pixbuf;
        this._artPainter = null;
        this.icon.opacity = pixbuf ? 0 : 255;
        this.queue_redraw();
    }

    values(part, aa, fade) {
        const {width: w, height: h} = this;
        const l = this.look;
        const c = v => v / 255;
        return [w, h, Math.min(l.radius * w, w / 2), l.exponent, aa,
            ...l.top.map(c), ...l.bottom.map(c), part, l.spec, l.hair, fade, l.fill];
    }

    // The shadow reaches past the plate; parents cull by this.
    vfunc_get_paint_volume(volume) {
        if (!super.vfunc_get_paint_volume(volume))
            return false;
        const pad = Math.ceil(this.width * 0.3);
        const origin = volume.get_origin();
        origin.x -= pad;
        origin.y -= pad;
        volume.set_origin(origin);
        volume.set_width(volume.get_width() + 2 * pad);
        volume.set_height(volume.get_height() + 3 * pad);
        return true;
    }

    vfunc_paint_node(node, paintContext) {
        const {width: w, height: h} = this;
        if (!w || !h || !this.look)
            return;
        const context = paintContext.get_framebuffer().get_context();
        if (!this._fill) {
            const t = plateTemplate(context);
            this._fill = new Painter(t.pipeline.copy());
            this._shadow = new ShadowPainter(t.shadow.copy());
        }
        if (this._art && !this._artPainter) {
            const pipeline = plateTemplate(context).art.copy();
            pipeline.set_layer_texture(1, textureOf(context, this._art));
            this._artPainter = new Painter(pipeline);
        }
        const fade = this.get_paint_opacity() / 255;
        const aa = aaOf(this);
        const l = this.look;
        const r = Math.min(l.radius * w, w / 2);
        const pad = Math.ceil(w * 0.3);
        this._shadow.paint(node, {x: -pad, y: -pad, width: w + 2 * pad, height: h + 3 * pad,
            box: {x1: 0, y1: 0, x2: w, y2: h}, radius: r, exponent: l.exponent, aa, tuck: 1, fade,
            layers: l.shadow.map((v, i) => (i % 3 === 2 ? v : v * w))});
        (this._art ? this._artPainter : this._fill).paint(node, w, h, this.values(0, aa, fade));
    }
});
