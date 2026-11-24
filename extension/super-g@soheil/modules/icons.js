// SPDX-License-Identifier: GPL-3.0-or-later
// Unified app icons, as Apple's: every app icon takes one shape (squircle,
// circle or rounded square), whatever the icon pack draws. Icons that are a
// tile already become the shape; the rest sit on a neutral plate. One hook,
// Shell.App.create_icon_texture, so the dock, the drawer, the overview grid and
// the switchers all agree. The plate is drawn by the GPU (lib/iconPlate.js).

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppGridLook} from '../lib/appGrid.js';
import {IconPlate} from '../lib/iconPlate.js';
import {Module} from '../lib/module.js';

// Corner radius as a part of the plate, and the corner's exponent: Apple's
// tiles have continuous corners (a superellipse), not circular ones.
const SHAPES = {
    squircle: {radius: 0.45, exponent: 4.2},
    circle: {radius: 0.5, exponent: 2},
    rounded: {radius: 0.22, exponent: 2},
};
// Shadow layers, [drop, sigma] as parts of the plate and alpha: a wide soft
// ambient one, a mid one, and a tight contact line that seats the tile.
const SHADOW = {
    light: [0.07, 0.09, 0.16, 0.02, 0.035, 0.12, 0.004, 0.008, 0.16],
    dark: [0.07, 0.09, 0.32, 0.02, 0.035, 0.2, 0.004, 0.008, 0.3],
};
// The tile's share of the icon box, as Apple's grid: an 824 px tile on a
// 1024 px canvas. A plate filling the whole box crowded the dock and grids.
const TILE_SHARE = 0.82;
const SAMPLE = 48;
const OPAQUE = 200;
// Neutral plates, top and bottom of a faint vertical gradient, as Apple's
// tiles for icons that bring no background of their own.
const NEUTRAL = {
    light: [[255, 255, 255], [238, 240, 244]],
    dark: [[70, 72, 80], [44, 45, 52]],
};
// An edge colour this close (0-255, per channel) along a side counts as one.
const EVEN = 30;
// How much of a tile's edge is cut away on each side: icon art often has a
// lighter ring or bevel there, which would show inside our shape.
const TILE_CROP = 0.05;

const luma = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const average = list => [0, 1, 2].map(j => list.reduce((t, c) => t + c[j], 0) / list.length);
const spread = list => {
    const mean = average(list);
    return Math.max(...list.map(c => Math.max(...[0, 1, 2].map(j => Math.abs(c[j] - mean[j])))));
};
const apart = (a, b) => Math.max(...[0, 1, 2].map(j => Math.abs(a[j] - b[j])));

// What the icon looks like, from a small render. A tile is an icon that
// already is a plate: a rounded square or a circle filling most of its square,
// whose edge runs one colour along each side (a gradient from top to bottom is
// fine). It gets drawn large on a plate of its own edge colours, so it takes
// the shape instead of sitting on a second plate inside the first. Anything
// else is a glyph, which gets a neutral plate.
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
    let [x1, y1, x2, y2, opaque] = [w, h, -1, -1, 0];
    const glyph = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const c = at(x, y);
            if (c[3] < OPAQUE)
                continue;
            opaque++;
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
            if ((x + y) % 3 === 0)
                glyph.push(c);
        }
    }
    if (x2 < 0)
        return {tile: null, glyphLuma: 0.5};
    const glyphLuma = luma(average(glyph));
    const bw = x2 - x1 + 1, bh = y2 - y1 + 1;
    const coverage = opaque / (bw * bh);
    const extent = Math.max(bw, bh) / Math.max(w, h);
    if (Math.abs(bw - bh) > 0.08 * Math.max(bw, bh) || extent < 0.7 || coverage < 0.74)
        return {tile: null, glyphLuma};
    // A ring just inside the shape, on the middle of each side.
    const inset = Math.max(1, Math.round(bw * TILE_CROP));
    const side = (fx, fy) => {
        const out = [];
        for (let t = 0.3; t <= 0.7; t += 0.05) {
            const [x, y] = fx(t), c = at(Math.round(x), Math.round(y));
            if (c[3] >= OPAQUE)
                out.push(c);
        }
        return out;
    };
    const top = side(t => [x1 + t * bw, y1 + inset]);
    const bottom = side(t => [x1 + t * bw, y2 - inset]);
    const left = side(t => [x1 + inset, y1 + t * bh]);
    const right = side(t => [x2 - inset, y1 + t * bh]);
    if ([top, bottom, left, right].some(l => l.length < 5 || spread(l) > EVEN))
        return {tile: null, glyphLuma};
    const [ct, cb, cl, cr] = [top, bottom, left, right].map(average);
    const middle = ct.map((v, j) => (v + cb[j]) / 2);
    if (apart(cl, cr) > EVEN || apart(cl, middle) > 1.4 * EVEN)
        return {tile: null, glyphLuma};
    // The tile's own corner radius, as a part of its size, from how much of
    // its square it covers: a circle 0.5, a square 0.
    const radius = Math.min(0.5, Math.sqrt(Math.max(0, 1 - coverage) / (4 - Math.PI)));
    return {tile: {top: ct.map(Math.round), bottom: cb.map(Math.round), extent, radius}, glyphLuma};
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
        this._grid = new AppGridLook(this.settings);
        this._grid.enable();
        for (const key of ['app-grid-icon-size', 'icon-shape'])
            this.connect(this.settings, `changed::${key}`, () => this.later('grid', 100, () => this._grid.apply()));
        this._refresh();
        this._warmUp();
    }

    // Reading an icon's shape and colours costs a few ms; the drawer's first
    // open read ~90 of them at once (230 ms of its 334). Read them ahead, a
    // few per idle moment, at low priority.
    _warmUp() {
        const system = Shell.AppSystem.get_default();
        const ids = system.get_installed().map(info => info.get_id());
        this._warmId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            for (let i = 0; i < 3 && ids.length; i++) {
                const app = system.lookup_app(ids.shift());
                if (app)
                    this._look(app, app.get_icon());
            }
            if (ids.length)
                return GLib.SOURCE_CONTINUE;
            this._warmId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._warmId)
            GLib.source_remove(this._warmId);
        this._warmId = 0;
        this.cleanup();
        this._proto.create_icon_texture = this._original;
        this._grid?.disable();
        this._grid = null;
        this._looks.clear();
        this._refresh();
    }

    get _dark() {
        return St.Settings.get().color_scheme === St.SystemColorScheme.PREFER_DARK;
    }

    // The plate's look for an app, remembered per icon.
    _look(app, gicon) {
        const key = app.get_id();
        if (this._looks.has(key))
            return this._looks.get(key);
        let look = {tile: null, glyphLuma: 0.5};
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

    // Plate colours, rim and how much of it the icon fills. A tile keeps its
    // own edge colours, so its edge vanishes into the plate. A glyph gets a
    // neutral plate, never a tint of its own colour: those read as mud (brown
    // under Chrome, olive under a calculator). A dark glyph keeps a light plate
    // in dark mode, or it is lost.
    _plateLook(look, shape) {
        const dark = this._dark;
        const tile = this.settings.get_string('icon-plate') !== 'neutral' ? look.tile : null;
        const base = {...shape, shadow: SHADOW[dark ? 'dark' : 'light']};
        if (tile) {
            // Cut to our shape: its own edge is cropped away.
            const fill = 1 / ((1 - 2 * TILE_CROP) * tile.extent);
            const light = luma(tile.top) > 0.75;
            return {...base, top: tile.top, bottom: tile.bottom, fill, tile: true, spec: light ? 0.35 : 0.4, hair: light ? 0.1 : 0.05};
        }
        const lightPlate = !dark || look.glyphLuma < 0.3;
        const [top, bottom] = lightPlate ? NEUTRAL.light : NEUTRAL.dark;
        return {...base, top, bottom, fill: this.settings.get_double('icon-scale'),
            spec: lightPlate ? 0.6 : 0.3, hair: lightPlate ? 0.1 : 0.0};
    }

    // A tile's pixels at the size they are drawn, or null (the icon then shows).
    _art(gicon, size) {
        try {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const px = Math.min(512, Math.ceil(size * scale * 1.5));
            const pixbuf = this._theme.lookup_by_gicon(gicon, px, 0)?.load_icon();
            if (!pixbuf)
                return null;
            return pixbuf.get_width() === px && pixbuf.get_height() === px ? pixbuf
                : pixbuf.scale_simple(px, px, GdkPixbuf.InterpType.BILINEAR);
        } catch {
            return null;
        }
    }

    _wrap(app, icon, size) {
        const shape = SHAPES[this.settings.get_string('icon-shape')];
        if (!shape || !icon || size < 16)
            return icon;
        const gicon = icon.gicon ?? app.get_icon();
        const look = this._plateLook(this._look(app, gicon), shape);
        const inner = v => Math.round(v * TILE_SHARE);
        const plate = new IconPlate(icon, inner(size), look);
        // Same outer size as the icon it replaces: the rest is margin.
        const frame = v => {
            const m = (v - inner(v)) / 2;
            plate.set({margin_left: Math.floor(m), margin_right: Math.ceil(m), margin_top: Math.floor(m), margin_bottom: Math.ceil(m)});
            plate.set_size(inner(v), inner(v));
        };
        frame(size);
        // The icon follows the size the plate really has: callers resize it.
        // A tile's art is loaded at 1.5x that, for the dock's magnification.
        let shown = 0;
        const fit = () => {
            const w = Math.round(plate.width);
            if (!w || w === shown)
                return;
            shown = w;
            icon.icon_size = Math.round(w * Math.min(look.fill, 1));
            if (look.tile)
                plate.setArt(() => this._art(gicon, w * look.fill));
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
            get: () => Math.round(plate.width / TILE_SHARE),
            set: v => frame(v),
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
        // Folder previews are built from icons too.
        this._grid?.apply();
    }
}
