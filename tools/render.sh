#!/usr/bin/env bash
# Render the sandboxed theme to PNGs: tools/render.sh <sandbox> <out-dir> [light|dark|both]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
sandbox=$(realpath "$1"); out=$(realpath -m "$2"); schemes=${3:-both}
[ "$schemes" = both ] && schemes="light dark"
mkdir -p "$out"

export XDG_CONFIG_HOME="$sandbox/config" XDG_DATA_HOME="$sandbox/data"
export GSETTINGS_BACKEND=memory GTK_A11Y=none NO_AT_BRIDGE=1

gtk4-broadwayd :17 >/dev/null 2>&1 &
bpid=$!
trap 'kill $bpid 2>/dev/null' EXIT
sleep 0.5

for s in $schemes; do
    GDK_BACKEND=broadway BROADWAY_DISPLAY=:17 python3 -I "$here/render-gtk.py" gtk4 "$out" "$s"
    python3 -I "$here/render-gtk.py" gtk3 "$out" "$s"
done
ls "$out"
