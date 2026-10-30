#!/usr/bin/env bash
# Run the extension in a throwaway headless GNOME Shell and screenshot it.
# Nothing touches the real session: settings, data and config live in the sandbox.
#   tools/shell-test.sh <sandbox> [light|dark] [gsettings-overrides...]
#   overrides look like: palette=stone window-buttons=mini-dots
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
sb=$(realpath -m "$1"); scheme=${2:-light}; shift 2 || true
rm -rf "$sb"; mkdir -p "$sb"/{data,config,cache,state,shots}
# Wayland socket paths must stay under 108 bytes, so the runtime dir is short.
run=$(mktemp -d "/run/user/$(id -u)/ust-XXXXXX")
trap 'rm -rf "$run"' EXIT
export XDG_DATA_HOME="$sb/data" XDG_CONFIG_HOME="$sb/config" XDG_CACHE_HOME="$sb/cache" \
       XDG_STATE_HOME="$sb/state" XDG_RUNTIME_DIR="$run" SANDBOX="$sb" SHOT_DIR="$sb/shots"
unset WAYLAND_DISPLAY DISPLAY
"$root/tools/install.sh" "$sb/data" >/dev/null
cp -r "$root/tests/shot@unified-test" "$sb/data/gnome-shell/extensions/"
# Same GTK3 base theme the real system has.
mkdir -p "$sb/data/themes" && cp -r "$HOME/.local/share/themes/adw-gtk3" "$HOME/.local/share/themes/adw-gtk3-dark" "$sb/data/themes/"

dbus-run-session -- bash -c '
  set -e
  schema=org.gnome.shell.extensions.unified-shell
  schemadir="$XDG_DATA_HOME/gnome-shell/extensions/unified-shell@soheil/schemas"
  gsettings set org.gnome.shell enabled-extensions "[\"unified-shell@soheil\", \"shot@unified-test\"]"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.desktop.interface color-scheme "$([ "$0" = dark ] && echo prefer-dark || echo default)"
  for kv in "$@"; do
    k=${kv%%=*}; v=${kv#*=}
    gsettings --schemadir "$schemadir" set $schema "$k" "$v"
  done
  gnome-shell --headless --wayland --no-x11 --mode=ubuntu --virtual-monitor 1600x1000 > "$SANDBOX/shell.log" 2>&1 &
  pid=$!
  for i in $(seq 1 60); do [ -f "$SHOT_DIR/done" ] && break; sleep 0.5; done
  kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
' "$scheme" "$@"

ls "$sb/shots"
grep -iE "unified|JS ERROR|camera failed" "$sb/shell.log" | grep -v "^$" | head -30 || true
