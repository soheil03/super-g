#!/usr/bin/env bash
# Cross-engine fixes re-applied after every tools/vendor.sh run. Engines that
# talk to Dash to Dock by schema id must use the vendored dock's schema.
set -euo pipefail
v="$(cd "$(dirname "$0")/.." && pwd)/extension/ubuntu-plus@soheil/vendor"
sed -i "s#const D2D_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';#const D2D_SCHEMA = 'org.gnome.shell.extensions.ubuntu-plus.dock';#" \
    "$v/windows/apps/dockUtils.js"
grep -q "ubuntu-plus.dock'" "$v/windows/apps/dockUtils.js" && echo "fixups applied"
# Hot corners builds per-corner settings paths from a base without a slash.
sed -i "s#export const _path = '/org/gnome/shell/extensions/custom-hot-corners-extended';#export const _path = '/org/gnome/shell/extensions/ubuntu-plus/hotcorners';#" \
    "$v/hotcorners/src/common/settings.js"
grep -q "ubuntu-plus/hotcorners'" "$v/hotcorners/src/common/settings.js" && echo "hotcorners path fixed"
