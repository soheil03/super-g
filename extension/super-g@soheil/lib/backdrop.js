// SPDX-License-Identifier: GPL-3.0-or-later
// How bright the screen is behind a rectangle, without reading pixels back
// from the GPU: the wallpaper image where it shows, and the app theme's
// window colour where a window covers it. Adaptive glass picks its tone from it.

import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {currentImage, currentWallpaperUri} from './wallpaper.js';

// Points per side sampled over the rectangle.
const GRID = 8;
const THUMB_WIDTH = 96;
// Gamma-space luma of an app window's background, by colour scheme.
const WINDOW_LUMA = {dark: 0.13, light: 0.96};
// The overview dims its wallpaper.
const OVERVIEW_DIM = 0.6;
const WINDOW_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG];

let thumb = {path: null, pixbuf: null};

function wallpaperPixbuf(dark) {
    const path = currentImage(currentWallpaperUri(dark));
    if (path !== thumb.path) {
        let pixbuf = null;
        try {
            pixbuf = path ? GdkPixbuf.Pixbuf.new_from_file_at_scale(path, THUMB_WIDTH, -1, true) : null;
        } catch {
            // Not an image we can read: windows alone decide.
        }
        thumb = {path, pixbuf};
    }
    return thumb.pixbuf;
}

// Decoding a 4K wallpaper takes longer than a menu should to open: callers
// warm it ahead of time.
export function warmBackdrop(darkApps) {
    wallpaperPixbuf(darkApps);
}

// Gamma-space luma of the wallpaper at a point of the monitor, as GNOME's
// default 'zoom' shows it: scaled to cover, centred.
function wallpaperAt(pb, px, monitor, x, y) {
    const scale = Math.max(monitor.width / pb.width, monitor.height / pb.height);
    const ix = Math.floor((x - monitor.x - (monitor.width - pb.width * scale) / 2) / scale);
    const iy = Math.floor((y - monitor.y - (monitor.height - pb.height * scale) / 2) / scale);
    const cx = Math.min(Math.max(ix, 0), pb.width - 1);
    const cy = Math.min(Math.max(iy, 0), pb.height - 1);
    const o = cy * pb.rowstride + cx * pb.n_channels;
    return (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
}

function coveringWindows() {
    if (Main.overview.visible)
        return [];
    const workspace = global.workspace_manager.get_active_workspace();
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .filter(w => w && !w.minimized && w.showing_on_its_workspace() && WINDOW_TYPES.includes(w.window_type) &&
            (w.is_on_all_workspaces() || w.get_workspace() === workspace))
        .map(w => w.get_frame_rect());
}

// Average gamma-space luma (0..1) behind a stage rectangle {x, y, width, height}.
// darkApps: the app colour scheme, which also picks the dark wallpaper.
export function backdropLuma(rect, darkApps) {
    const index = global.display.get_monitor_index_for_rect(new Mtk.Rectangle(rect));
    const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
    const pb = wallpaperPixbuf(darkApps);
    const px = pb?.get_pixels();
    const windows = coveringWindows();
    const appLuma = darkApps ? WINDOW_LUMA.dark : WINDOW_LUMA.light;
    const wallDim = Main.overview.visible ? OVERVIEW_DIM : 1;
    let sum = 0;
    for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
            const x = rect.x + (i + 0.5) * rect.width / GRID;
            const y = rect.y + (j + 0.5) * rect.height / GRID;
            const covered = windows.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
            sum += covered || !pb ? appLuma : wallpaperAt(pb, px, monitor, x, y) * wallDim;
        }
    }
    return sum / (GRID * GRID);
}
