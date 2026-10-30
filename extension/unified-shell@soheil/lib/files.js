// SPDX-License-Identifier: GPL-3.0-or-later
// File helpers. Writes are skipped when content is unchanged so callers can
// tell whether anything actually changed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const HOME = GLib.get_home_dir();
export const CONFIG = GLib.get_user_config_dir();
export const DATA = GLib.get_user_data_dir();
export const CACHE = `${GLib.get_user_cache_dir()}/unified-shell`;
export const STATE = `${GLib.get_user_state_dir()}/unified-shell`;

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

const BEGIN = '/* unified-shell: begin */';
const END = '/* unified-shell: end */';

// Put `block` at the top of a CSS file between markers, keeping whatever
// else the user or other tools wrote there. `null` removes our block.
export function setManagedBlock(path, block) {
    const current = readText(path) ?? '';
    const start = current.indexOf(BEGIN), stop = current.indexOf(END);
    let rest = current;
    if (start >= 0 && stop > start)
        rest = (current.slice(0, start) + current.slice(stop + END.length)).replace(/^\n+/, '');
    const next = block === null ? rest : `${BEGIN}\n${block}\n${END}\n${rest}`;
    if (next === current)
        return false;
    if (!next.trim() && block === null) {
        remove(path);
        return true;
    }
    return writeText(path, next);
}
