#!/usr/bin/env bash
# Install the extension for the current user (or into a sandbox data dir).
#   tools/install.sh            → ~/.local/share/gnome-shell/extensions
#   tools/install.sh <datadir>  → <datadir>/gnome-shell/extensions (for tests)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
uuid=super-g@soheil
data=${1:-${XDG_DATA_HOME:-$HOME/.local/share}}
dest="$data/gnome-shell/extensions/$uuid"

rm -rf "$dest"
mkdir -p "$dest"
cp -r "$root/extension/$uuid/." "$dest/"
cp "$root/tokens/palette.json" "$dest/tokens.json"
glib-compile-schemas --strict "$dest/schemas"
# Vendored engines look their schemas up in their own folder.
for v in "$dest"/vendor/*/; do
    mkdir -p "$v/schemas" && cp "$dest/schemas/gschemas.compiled" "$v/schemas/"
done
echo "installed $dest"
