// SPDX-License-Identifier: GPL-3.0-or-later
// How bright the wallpaper is under a strip of the screen, so text and icons
// drawn over glass can pick dark or light automatically.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

const cache = new Map();

// Average relative luminance (0..1) of the wallpaper's top or bottom
// `fraction`; null when the wallpaper isn't a plain image (e.g. a slideshow).
export function stripLuminance(uri, edge = 'top', fraction = 0.05) {
    const key = `${uri}|${edge}|${fraction}`;
    if (cache.has(key))
        return cache.get(key);
    let value = null;
    try {
        const path = Gio.File.new_for_uri(uri).get_path();
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
        for (let y = from; y < from + rows; y++) {
            for (let x = 0; x < w; x++) {
                const o = y * stride + x * n;
                sum += 0.2126 * lin(px[o]) + 0.7152 * lin(px[o + 1]) + 0.0722 * lin(px[o + 2]);
            }
        }
        value = sum / (rows * w);
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
