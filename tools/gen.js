// Generate every CSS output into a sandbox directory, for testing without
// touching the live system.
//   gjs -m tools/gen.js <outdir> ['{"palette":"stone","windowButtons":"mini-dots"}']
// Layout of <outdir> mirrors XDG dirs so tools/render-gtk.py can point
// XDG_CONFIG_HOME / XDG_DATA_HOME at it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import * as Gen from '../extension/unified-shell@soheil/lib/themeGen.js';

const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const root = GLib.path_get_dirname(here);
const [outdir, optsJson = '{}'] = ARGV;
if (!outdir) {
    printerr('usage: gjs -m tools/gen.js <outdir> [json-options]');
    System.exit(2);
}

const read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const write = (p, text) => {
    GLib.mkdir_with_parents(GLib.path_get_dirname(p), 0o755);
    GLib.file_set_contents(p, text);
};

const tokens = JSON.parse(read(`${root}/tokens/palette.json`));
const opts = JSON.parse(optsJson);
const adw = `${GLib.get_home_dir()}/.local/share/themes`;

write(`${outdir}/config/gtk-4.0/gtk.css`, Gen.gtk4Css(tokens, opts));
for (const [name, dark] of [['Unified', false], ['Unified-dark', true]]) {
    const base = `${adw}/${dark ? 'adw-gtk3-dark' : 'adw-gtk3'}/gtk-3.0/gtk.css`;
    write(`${outdir}/data/themes/${name}/gtk-3.0/gtk.css`, Gen.gtk3Css(tokens, opts, dark, base));
    write(`${outdir}/data/themes/${name}/index.theme`, Gen.gtkThemeIndex(name));
}
for (const [variant, dark] of [['light', false], ['dark', true]]) {
    const theme = `/usr/share/gnome-shell/theme/${dark ? 'Yaru-dark' : 'Yaru'}/gnome-shell.css`;
    const css = Gio.File.new_for_path(theme).query_exists(null) ? read(theme) : '';
    write(`${outdir}/shell-${variant}.css`, Gen.shellCss(tokens, opts, dark, css));
}
print(`wrote ${outdir}`);
