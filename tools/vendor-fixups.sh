#!/usr/bin/env bash
# Cross-engine fixes re-applied after every tools/vendor.sh run. Engines that
# talk to Dash to Dock by schema id must use the vendored dock's schema.
set -euo pipefail
v="$(cd "$(dirname "$0")/.." && pwd)/extension/super-g@soheil/vendor"
sed -i "s#const D2D_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';#const D2D_SCHEMA = 'org.gnome.shell.extensions.super-g.dock';#" \
    "$v/windows/apps/dockUtils.js"
grep -q "super-g.dock'" "$v/windows/apps/dockUtils.js" && echo "fixups applied"
# Hot corners builds per-corner settings paths from a base without a slash.
sed -i "s#export const _path = '/org/gnome/shell/extensions/custom-hot-corners-extended';#export const _path = '/org/gnome/shell/extensions/super-g/hotcorners';#" \
    "$v/hotcorners/src/common/settings.js"
grep -q "super-g/hotcorners'" "$v/hotcorners/src/common/settings.js" && echo "hotcorners path fixed"
# Dock: the slide container clips its child to the dock area; magnified icons
# grow past it towards the screen centre. Give the clip headroom on that side
# only (the slid-out side stays clipped).
python3 -I - "$v/dock/docking.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """        this.child.set_clip(-childBox.x1, -childBox.y1,
            -childBox.x1 + availWidth, -childBox.y1 + availHeight);"""
new = """        // Super G: headroom for magnified icons on the inner side, and
        // along it for the row stretching and the dock's shadow.
        const headroom = 160;
        const shadow = 360;
        // Same (x, y, width, height) as upstream, grown on the inner side.
        const [x, y, w, h] = [-childBox.x1, -childBox.y1,
            -childBox.x1 + availWidth, -childBox.y1 + availHeight];
        if (this.side === St.Side.BOTTOM)
            this.child.set_clip(x - shadow, y - headroom, w + 2 * shadow, h + headroom);
        else if (this.side === St.Side.TOP)
            this.child.set_clip(x - shadow, y, w + 2 * shadow, h + headroom);
        else if (this.side === St.Side.LEFT)
            this.child.set_clip(x, y - shadow, w + headroom, h + 2 * shadow);
        else
            this.child.set_clip(x - headroom, y - shadow, w + headroom, h + 2 * shadow);"""
if 'Super G: headroom' not in s:
    assert old in s, 'dock clip code changed upstream'
    s = s.replace(old, new)
    open(p, 'w').write(s)
print('dock clip headroom patched')
PY
