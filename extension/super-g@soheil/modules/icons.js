// SPDX-License-Identifier: GPL-3.0-or-later
// Unified app icons, as Android's adaptive icons: every app icon sits on a
// plate of one shape (squircle, circle or rounded square), whatever the icon
// pack draws. One hook, Shell.App.create_icon_texture, so the dock, the drawer,
// the overview grid and the switchers all agree. No shader: plain St, which
// also keeps this working on GNOME 51.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Module} from '../lib/module.js';

// Corner radius as a part of the plate.
const SHAPES = {
    squircle: 0.30,
    circle: 0.5,
    rounded: 0.2,
};
const SAMPLE = 48;
const OPAQUE = 200;
const NEUTRAL = {light: [244, 244, 247], dark: [58, 58, 64]};

const saturation = ([r, g, b]) => {
    const max = Math.max(r, g, b);
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
};

// What the icon looks like, from a small render: whether it fills its square
// (then its own colour is the plate, so the corners dissolve) and its
// strongest colour otherwise.
function analyse(pixbuf) {
    const w = pixbuf.get_width();
    const h = pixbuf.get_height();
    const n = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const px = pixbuf.get_pixels();
    const at = (x, y) => {
        const i = y * stride + x * n;
        return [px[i], px[i + 1], px[i + 2], n === 4 ? px[i + 3] : 255];
    };
    const corners = [at(1, 1), at(w - 2, 1), at(1, h - 2), at(w - 2, h - 2)];
    const full = corners.every(c => c[3] >= OPAQUE);
    let sum = [0, 0, 0];
    let weight = 0;
    for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
            const c = at(x, y);
            if (c[3] < OPAQUE)
                continue;
            // Vivid pixels speak for a glyph; greys and near blacks barely.
            const s = saturation(c);
            const k = full ? 1 : 0.05 + s * s * (Math.max(c[0], c[1], c[2]) / 255);
            sum = sum.map((t, j) => t + c[j] * k);
            weight += k;
        }
    }
    if (!weight)
        return {full, rgb: null, vivid: 0};
    const rgb = sum.map(t => Math.round(t / weight));
    return {full, rgb, vivid: saturation(rgb)};
}

export default class IconsModule extends Module {
    enable() {
        this._theme = new St.IconTheme();
        this._looks = new Map();
        this._proto = Shell.App.prototype;
        this._original = this._proto.create_icon_texture;
        const self = this;
        this._proto.create_icon_texture = function (size) {
            const icon = self._original.call(this, size);
            try {
                return self._wrap(this, icon, size);
            } catch (e) {
                console.error('super-g: icon shape failed', e);
                return icon;
            }
        };
        for (const key of ['icon-shape', 'icon-scale', 'icon-plate'])
            this.connect(this.settings, `changed::${key}`, () => this.later('icons', 100, () => this._refresh()));
        this.connect(St.Settings.get(), 'notify::color-scheme', () => this.later('icons', 100, () => this._refresh()));
        this._refresh();
    }

    disable() {
        this.cleanup();
        this._proto.create_icon_texture = this._original;
        this._looks.clear();
        this._refresh();
    }

    get _dark() {
        return St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;
    }

    // The plate's colour for an app, remembered per icon.
    _look(app, gicon) {
        const key = app.get_id();
        if (this._looks.has(key))
            return this._looks.get(key);
        let look = {full: false, rgb: null, vivid: 0};
        try {
            const pixbuf = this._theme.lookup_by_gicon(gicon, SAMPLE, 0)?.load_icon();
            if (pixbuf) {
                const small = pixbuf.get_width() === SAMPLE ? pixbuf
                    : pixbuf.scale_simple(SAMPLE, SAMPLE, GdkPixbuf.InterpType.BILINEAR);
                look = analyse(small);
            }
        } catch {
            // An icon we can't read gets the neutral plate.
        }
        this._looks.set(key, look);
        return look;
    }

    // The plate's colour as [top, bottom] of a soft gradient, Apple style: a
    // full-bleed icon keeps its own colour (so its corners dissolve), a glyph
    // gets a calm plate in which it stands out, never its own colour (an orange
    // glyph on orange vanishes).
    _plateColours(look) {
        const dark = this._dark;
        const shade = (c, k) => c.map(v => Math.max(0, Math.min(255, Math.round(v + (k > 0 ? (255 - v) * k : v * k)))));
        const mix = (a, c, t) => a.map((v, i) => Math.round(v + (c[i] - v) * t));
        const lumaOf = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
        let base;
        if (look.full && look.rgb && this.settings.get_string('icon-plate') !== 'neutral') {
            return [shade(look.rgb, 0.05), shade(look.rgb, -0.05)];
        } else if (look.rgb && look.vivid >= 0.25 && this.settings.get_string('icon-plate') !== 'neutral') {
            base = dark ? mix([44, 44, 50], look.rgb, 0.22) : mix([252, 252, 254], look.rgb, 0.1);
        } else {
            // A dark glyph needs a light plate even in dark mode, or it is lost.
            const glyphDark = look.rgb && lumaOf(look.rgb) < 0.35;
            base = dark && !glyphDark ? NEUTRAL.dark : NEUTRAL.light;
        }
        return [shade(base, dark ? 0.06 : 0.0), shade(base, dark ? -0.1 : -0.05)];
    }

    _wrap(app, icon, size) {
        const radius = SHAPES[this.settings.get_string('icon-shape')];
        if (!radius || !icon || size < 16)
            return icon;
        const look = this._look(app, icon.gicon ?? app.get_icon());
        // A full-bleed icon already is a plate: it can fill more of this one.
        const fill = Math.min(this.settings.get_double('icon-scale') * (look.full ? 1.08 : 1), 1);
        const [top, bottom] = this._plateColours(look);
        icon.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const plate = new St.Bin({
            style_class: 'super-g-icon-plate',
            width: size,
            height: size,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: icon,
        });
        // Radius and icon follow the size the plate really has: callers resize it.
        let shown = 0;
        const fit = () => {
            const w = Math.round(plate.width);
            if (!w || w === shown)
                return;
            shown = w;
            icon.icon_size = Math.round(w * fill);
            // A fine light edge would need a second shadow, which St lacks: the
            // gradient and one soft drop shadow carry the depth, as on Apple's.
            plate.set_style(`background-gradient-direction: vertical; background-gradient-start: rgb(${top.join(', ')}); `
                + `background-gradient-end: rgb(${bottom.join(', ')}); border-radius: ${Math.round(w * radius)}px; `
                + `box-shadow: 0 ${Math.max(1, Math.round(w * 0.03))}px ${Math.max(2, Math.round(w * 0.07))}px rgba(0, 0, 0, 0.2);`);
        };
        fit();
        plate.connect('notify::width', fit);
        // Callers treat the result as an St.Icon.
        for (const prop of ['gicon', 'icon_name', 'fallback_gicon', 'fallback_icon_name']) {
            Object.defineProperty(plate, prop, {
                configurable: true,
                get: () => icon[prop],
                set: v => (icon[prop] = v),
            });
        }
        Object.defineProperty(plate, 'icon_size', {
            configurable: true,
            get: () => plate.width,
            set: v => plate.set_size(v, v),
        });
        return plate;
    }

    // Icons already built keep their old look: rebuild the ones we can reach.
    _refresh() {
        const dock = this.ext._active?.get('dock');
        for (const d of dock?.instance?.dockManager?._allDocks ?? []) {
            for (const item of d.dash?._box?.get_children() ?? []) {
                const base = item.child?.icon;
                if (base?._createIconTexture)
                    base._createIconTexture(base.iconSize);
            }
        }
        this.ext._active?.get('drawer')?._dropTiles?.();
        Main.overview?.dash?.queueRedisplay?.();
    }
}
