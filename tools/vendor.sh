#!/usr/bin/env bash
# Import (or update) an upstream extension as a vendored engine of Ubuntu Plus.
#   tools/vendor.sh <name> <upstream-extension-dir>
# e.g. tools/vendor.sh blur ~/.local/share/gnome-shell/extensions/blur-my-shell@aunetx
#
# Copies the code including its prefs UI (not translations or schemas),
# moves its GSettings schema under org.gnome.shell.extensions.ubuntu-plus.<name>
# (dconf path /org/gnome/shell/extensions/ubuntu-plus/<name>/) and records the
# upstream version. Re-run after an upstream release to pick up GNOME fixes.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
name=$1; src=$(realpath "$2")
ext="$root/extension/ubuntu-plus@soheil"
dest="$ext/vendor/$name"

# The main schema id: from metadata, else the shortest id in the schema file.
old_id=$(python3 -I -c "import json,sys; print(json.load(open(sys.argv[1])).get('settings-schema',''))" "$src/metadata.json")
[ -n "$old_id" ] || old_id=$(grep -hoE "<schema [^>]*id=[\"'][^\"']*" "$src"/schemas/*.gschema.xml | sed -E "s/.*id=[\"']//" | awk '{print length, $0}' | sort -n | head -1 | cut -d' ' -f2)
old_path=$(grep -hoE "path= ?[\"']/org/gnome/shell/extensions/[^/\"']*/" "$src"/schemas/*.gschema.xml | head -1 | sed -E "s/.*path= ?[\"']//")
new_id="org.gnome.shell.extensions.ubuntu-plus.$name"
new_path="/org/gnome/shell/extensions/ubuntu-plus/$name/"
# Escape for sed: dots in ids would otherwise match the slashes in paths.
re() { printf '%s' "$1" | sed 's/[][\.*^$#]/\\&/g'; }
old_id_re=$(re "$old_id"); old_path_re=$(re "$old_path")

rm -rf "$dest"
mkdir -p "$dest"
rsync -a --exclude locale --exclude schemas \
      --exclude metadata.json --exclude '*.ts' "$src/" "$dest/"
cp "$src/metadata.json" "$dest/upstream-metadata.json"

# Schema id and dconf path, in the schema and in any code that names them.
for f in "$src"/schemas/*.gschema.xml; do
    sed -e "s#${old_path_re}#${new_path}#g" -e "s#${old_id_re}#${new_id}#g" "$f" \
        > "$ext/schemas/${new_id}.gschema.xml"
done
grep -rlZF --include='*.js' -e "$old_id" -e "$old_path" "$dest" 2>/dev/null \
    | xargs -0 -r sed -i -e "s#${old_path_re}#${new_path}#g" -e "s#${old_id_re}#${new_id}#g" || true

version=$(python3 -I -c "import json,sys; m=json.load(open(sys.argv[1])); print(m.get('version-name') or m.get('version'), m.get('url',''))" "$src/metadata.json")
printf '%s\n' "upstream: $(basename "$src")" "version/url: $version" "schema: $old_id -> $new_id" "dconf: $old_path -> $new_path" > "$dest/UPSTREAM"
echo "vendored $name from $(basename "$src") ($version)"
