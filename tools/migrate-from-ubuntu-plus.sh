#!/usr/bin/env bash
# One time, on a machine that ran this project under its old name: move
# settings and state to GNOME Plus, install it, swap the extensions, log out.
# The state moves first, so the old extension finds nothing to hand back when
# it stops. The switch needs the logout (Wayland), so the script does it too.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
data=${XDG_DATA_HOME:-$HOME/.local/share}
state=${XDG_STATE_HOME:-$HOME/.local/state}
cache=${XDG_CACHE_HOME:-$HOME/.cache}
config=${XDG_CONFIG_HOME:-$HOME/.config}

dconf dump /org/gnome/shell/extensions/ubuntu-plus/ | dconf load /org/gnome/shell/extensions/gnome-plus/
if [ -d "$state/ubuntu-plus" ] && [ ! -e "$state/gnome-plus" ]; then
    mv "$state/ubuntu-plus" "$state/gnome-plus"
fi
rm -rf "$cache/ubuntu-plus"
python3 -I - "$config/gtk-4.0/gtk.css" "$config/gtk-3.0/gtk.css" <<'PY'
import os, re, sys
for path in sys.argv[1:]:
    if os.path.isfile(path):
        text = open(path).read()
        clean = re.sub(r'/\* ubuntu-plus: begin \*/.*?/\* ubuntu-plus: end \*/\n?', '', text, flags=re.S)
        if clean != text:
            open(path, 'w').write(clean)
PY
"$root/tools/install.sh"
"$root/tools/takeover.sh"
enabled=$(gsettings get org.gnome.shell enabled-extensions | sed -e "s/'ubuntu-plus@soheil', //" -e "s/, 'ubuntu-plus@soheil'//")
gsettings set org.gnome.shell enabled-extensions "$enabled"
rm -rf "$data/gnome-shell/extensions/ubuntu-plus@soheil" "$data"/themes/Ubuntu-Plus* "$state/ubuntu-plus"
gnome-session-quit --logout --no-prompt
