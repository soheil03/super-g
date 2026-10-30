#!/usr/bin/env bash
# Hand the replaced extensions over to Ubuntu Plus before the next login:
# copy each one's settings into Ubuntu Plus (if not done yet), take it out of
# the enabled list and record it so Ubuntu Plus can switch it back on if the
# matching module is ever turned off. Then a single logout finishes the switch.
#   tools/takeover.sh            run it
#   tools/takeover.sh --dry-run  only show what would happen
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
dry=${1:-}
vendor="$root/extension/ubuntu-plus@soheil/vendor"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/ubuntu-plus"

# module  upstream-uuids...
map=(
  "corners rounded-window-corners@fxgn"
  "dock dash-to-dock@micxgx.gmail.com ubuntu-dock@ubuntu.com"
  "dockmotion flourish@orsso.github.io"
  "blur blur-my-shell@aunetx"
  "windows kiwi@kemma"
  "panel just-perfection-desktop@just-perfection"
  "hotcorners custom-hot-corners-extended@G-dH.github.com"
  "gestures touchpad-gesture-customization@coooolapps.com"
  "launcher superbar@Furkan-rgb.github.io"
)

mkdir -p "$state_dir"
python3 -I - "$state_dir/handover.json" "$dry" "$vendor" "${map[@]}" <<'EOF'
import ast, json, os, re, subprocess, sys
state_path, dry, vendor, *rows = sys.argv[1:]
dry = dry == '--dry-run'
state = json.load(open(state_path)) if os.path.exists(state_path) else {}
state.setdefault('migrated', {})
enabled = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True))

for row in rows:
    module, *uuids = row.split()
    info_path = os.path.join(vendor, module, 'UPSTREAM')
    if os.path.exists(info_path) and not state['migrated'].get(module):
        m = re.search(r'^dconf: (\S+) -> (\S+)$', open(info_path).read(), re.M)
        if m:
            src, dst = m.groups()
            ours = subprocess.check_output(['dconf', 'dump', dst], text=True)
            theirs = subprocess.check_output(['dconf', 'dump', src], text=True)
            if theirs.strip() and not ours.strip():
                print(f'{module}: copy settings {src} -> {dst}')
                if not dry:
                    subprocess.run(['dconf', 'load', dst], input=theirs, text=True, check=True)
        if not dry:
            state['migrated'][module] = True
    for uuid in uuids:
        if uuid in enabled:
            print(f'{module}: switch off {uuid}')
            enabled.remove(uuid)
            state[uuid] = module

if 'ubuntu-plus@soheil' not in enabled:
    enabled.append('ubuntu-plus@soheil')
if not dry:
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(enabled)])
    json.dump(state, open(state_path, 'w'), indent=2)
print('dry run, nothing changed' if dry else 'done; log out and back in')
EOF
