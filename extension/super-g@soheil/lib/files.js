// SPDX-License-Identifier: GPL-3.0-or-later
// File helpers. Writes are skipped when content is unchanged so callers can
// tell whether anything actually changed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const HOME = GLib.get_home_dir();
export const CONFIG = GLib.get_user_config_dir();
export const DATA = GLib.get_user_data_dir();
export const CACHE = `${GLib.get_user_cache_dir()}/super-g`;
export const STATE = `${GLib.get_user_state_dir()}/super-g`;

const decoder = new TextDecoder();

export function readText(path) {
    try {
        return decoder.decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

export function readFile(file) {
    try {
        return decoder.decode(file.load_contents(null)[1]);
    } catch {
        return '';
    }
}

export function writeText(path, text) {
    if (readText(path) === text)
        return false;
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
    return true;
}

export function remove(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch {}
}

const BEGIN = '/* super-g: begin */';
const END = '/* super-g: end */';

// Put `block` in a CSS file between markers, keeping whatever else the user
// or other tools wrote there. `null` removes our block. Blocks holding rules
// go at the end so other tools' @import lines stay valid at the top.
export function setManagedBlock(path, block, {atEnd = false} = {}) {
    const current = readText(path) ?? '';
    const start = current.indexOf(BEGIN), stop = current.indexOf(END);
    let rest = current;
    if (start >= 0 && stop > start)
        rest = (current.slice(0, start) + current.slice(stop + END.length)).replace(/^\n+/, '').replace(/\n+$/, '\n');
    let next = rest;
    if (block !== null) {
        const ours = `${BEGIN}\n${block}\n${END}\n`;
        next = atEnd ? `${rest}${rest && !rest.endsWith('\n') ? '\n' : ''}${ours}` : `${ours}${rest}`;
    }
    if (next === current)
        return false;
    if (!next.trim() && block === null) {
        remove(path);
        return true;
    }
    return writeText(path, next);
}
