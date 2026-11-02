// SPDX-License-Identifier: GPL-3.0-or-later
// How bright the wallpaper is under a strip of the screen, so text and icons
// drawn over glass can pick dark or light automatically.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const cache = new Map();

// The image a wallpaper shows now: itself, or for a timed wallpaper (GNOME's
// slideshow XML) the slide the clock is on.
export function currentImage(uri) {
    const path = Gio.File.new_for_uri(uri).get_path();
    if (!path?.endsWith('.xml'))
        return path;
    try {
        const xml = new TextDecoder().decode(GLib.file_get_contents(path)[1]);
        const part = tag => parseInt(xml.match(new RegExp(`<${tag}>\\s*(\\d+)`))?.[1] ?? 0);
        const start = new Date(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
        const slides = [...xml.matchAll(/<(static|transition)\b[^>]*>([\s\S]*?)<\/\1>/g)].map(m => ({
            duration: parseFloat(m[2].match(/<duration>\s*([\d.]+)/)?.[1] ?? 0),
            image: m[2].match(/<(?:to|file)>\s*(?:<size[^>]*>\s*)?([^<\s]+)/)?.[1],
        }));
        const total = slides.reduce((sum, s) => sum + s.duration, 0);
        let at = (((Date.now() - start) / 1000) % total + total) % total;
        for (const slide of slides) {
            at -= slide.duration;
            if (at < 0)
                return slide.image;
        }
    } catch {
        // Unreadable: the caller treats it as an unknown wallpaper.
    }
    return null;
}

// Average relative luminance (0..1) of the wallpaper's top or bottom
// `fraction`, between x0 and x1 (fractions of the width); null when the
// wallpaper isn't a plain image (e.g. a slideshow).
export function stripLuminance(uri, edge = 'top', fraction = 0.05, x0 = 0, x1 = 1) {
    const path = currentImage(uri);
    const key = `${path}|${edge}|${fraction}|${x0}|${x1}`;
    if (cache.has(key))
        return cache.get(key);
    let value = null;
    try {
        const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 96, -1, true);
        const [w, h, n, stride] = [pb.width, pb.height, pb.n_channels, pb.rowstride];
        const px = pb.get_pixels();
        const rows = Math.max(1, Math.round(h * fraction));
        const from = edge === 'top' ? 0 : h - rows;
        let sum = 0;
        const lin = v => {
            v /= 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const [left, right] = [Math.floor(w * x0), Math.max(Math.floor(w * x0) + 1, Math.ceil(w * x1))];
        for (let y = from; y < from + rows; y++) {
            for (let x = left; x < right; x++) {
                const o = y * stride + x * n;
                sum += 0.2126 * lin(px[o]) + 0.7152 * lin(px[o + 1]) + 0.0722 * lin(px[o + 2]);
            }
        }
        value = sum / (rows * (right - left));
    } catch {
        value = null;
    }
    cache.set(key, value);
    return value;
}

export function currentWallpaperUri(dark) {
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    return bg.get_string(dark ? 'picture-uri-dark' : 'picture-uri') || bg.get_string('picture-uri');
}
