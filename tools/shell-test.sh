#!/usr/bin/env bash
# Run the extension in a throwaway headless GNOME Shell and screenshot it.
# Nothing touches the real session: settings, data and config live in the sandbox.
#
#   tools/shell-test.sh <sandbox> [light|dark] [key=value ...]
#     key=value pairs set GNOME Plus settings, e.g. palette=stone window-buttons=mini-dots;
#     engine settings take a prefix: dockmotion:custom-hover-enabled=true
#   CLONE=1 tools/shell-test.sh ...
#     start from a copy of the real settings and extensions (minus GSConnect),
#     to catch clashes with other extensions and see real apps.
#   EVAL="return ..." with SHOTS="eval" runs JS inside the shell, result in shots/eval.txt.
#   TAKEOVER=1 runs tools/takeover.sh first, as a real switch-over would.
#   EXCLUDE="kiwi@ blur-my-shell@" drops extensions from a clone (prefix match).
#   SHOTS="desktop quick-settings calendar overview app-grid files ..." limits the scenes.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
sb=$(realpath -m "$1"); scheme=${2:-light}; shift 2 || true
rm -rf "$sb"; mkdir -p "$sb"/{data/gnome-shell/extensions,data/themes,config,cache,state,shots}
# Wayland socket paths must stay under 108 bytes, so the runtime dir is short.
run=$(mktemp -d "/run/user/$(id -u)/ust-XXXXXX")
trap 'rm -rf "$run"' EXIT
export XDG_DATA_HOME="$sb/data" XDG_CONFIG_HOME="$sb/config" XDG_CACHE_HOME="$sb/cache" \
       XDG_STATE_HOME="$sb/state" XDG_RUNTIME_DIR="$run" SANDBOX="$sb" SHOT_DIR="$sb/shots" \
       CLONE="${CLONE:-0}" SHOTS="${SHOTS:-}" EXCLUDE="${EXCLUDE:-}" TAKEOVER="${TAKEOVER:-0}" ROOT="$root" EVAL="${EVAL:-}"
unset WAYLAND_DISPLAY DISPLAY

real="$HOME/.local/share"
"$root/tools/install.sh" "$sb/data" >/dev/null
cp -r "$root/tests/shot@gnome-plus-test" "$sb/data/gnome-shell/extensions/"
for t in "$real"/themes/*; do
    case $(basename "$t") in Unified*|Ubuntu-Plus*|GNOME-Plus*) continue ;; esac
    ln -s "$t" "$sb/data/themes/"
done
if [ "$CLONE" = 1 ]; then
    XDG_CONFIG_HOME="$HOME/.config" dconf dump / > "$sb/user.ini"
    for d in "$real"/gnome-shell/extensions/*; do
        case $(basename "$d") in gnome-plus@*|ubuntu-plus@*|unified-shell@*|gsconnect@*) continue ;; esac
        ln -s "$d" "$sb/data/gnome-shell/extensions/"
    done
    for x in icons fonts backgrounds applications; do
        if [ -e "$real/$x" ]; then ln -s "$real/$x" "$sb/data/$x"; fi
    done
fi

dbus-run-session -- bash -c '
  set -e
  schemadir="$XDG_DATA_HOME/gnome-shell/extensions/gnome-plus@soheil/schemas"
  if [ "$CLONE" = 1 ]; then
    dconf load / < "$SANDBOX/user.ini"
    enabled=$(gsettings get org.gnome.shell enabled-extensions | python3 -I -c "
import ast, sys
import os
drop = (\"unified-shell@\", \"ubuntu-plus@\", \"gsconnect@\", *os.environ[\"EXCLUDE\"].split())
l = [e for e in ast.literal_eval(sys.stdin.read()) if not e.startswith(drop)]
print(str(l + [\"gnome-plus@soheil\", \"shot@gnome-plus-test\"]))")
  else
    enabled="[\"gnome-plus@soheil\", \"shot@gnome-plus-test\"]"
  fi
  gsettings set org.gnome.shell enabled-extensions "$enabled"
  if [ "$TAKEOVER" = 1 ]; then "$ROOT/tools/takeover.sh" >/dev/null; fi
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.desktop.interface color-scheme "$([ "$0" = dark ] && echo prefer-dark || echo default)"
  for kv in "$@"; do
    key=${kv%%=*}; schema=org.gnome.shell.extensions.gnome-plus
    case $key in *:*) schema="$schema.${key%%:*}"; key=${key#*:} ;; esac
    gsettings --schemadir "$schemadir" set "$schema" "$key" "${kv#*=}"
  done
  gnome-shell --headless --wayland --no-x11 --mode=ubuntu --virtual-monitor 1600x1000 > "$SANDBOX/shell.log" 2>&1 &
  pid=$!
  for i in $(seq 1 240); do [ -f "$SHOT_DIR/done" ] && break; sleep 0.5; done
  kill $pid 2>/dev/null || true; wait $pid 2>/dev/null || true
' "$scheme" "$@" >/dev/null 2>&1

ls "$sb/shots"
grep -iE "gnome-plus|JS ERROR|camera" "$sb/shell.log" | head -30 || true
