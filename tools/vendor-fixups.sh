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
# Dock: badges read 99+ past two digits, as on a Mac.
python3 -I - "$v/dock/appIconIndicators.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """    _notificationBadgeCountToText(count) {
"""
new = """    _notificationBadgeCountToText(count) {
        // Super G: 99+ past two digits.
        if (count > 99)
            return '99+';
"""
if 'Super G: 99+' not in s:
    assert old in s, 'dock badge code changed upstream'
    s = s.replace(old, new)
    open(p, 'w').write(s)
print('dock badge cap patched')
PY
# Dock: late signals after the manager went away (a lock) must not throw.
python3 -I - "$v/dock/locations.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """    const locationApps = [];

    if (dockManager.removables)"""
new = """    const locationApps = [];

    // Super G: late signals after the manager went away (a lock) must not throw.
    if (!dockManager)
        return locationApps;

    if (dockManager.removables)"""
if 'Super G: late signals' not in s:
    assert old in s, 'dock locations code changed upstream'
    s = s.replace(old, new)
    open(p, 'w').write(s)
print('dock locations guard patched')
PY

python3 -I "$(dirname "$0")/engine-defaults.py" "$v/../schemas"

# Corners: map the shader's coordinates onto the effect's real, padded texture.
python3 -I - "$v/corners" <<'PY'
import sys
root = sys.argv[1]
p = root + '/manager/utils.js'
s = open(p).read()
old = """    const bounds = {
        x1: x + 1,
        y1: y + 1,
        x2: x + actor.width + width,
        y2: y + actor.height + height,
"""
new = """    // Super G: the effect's texture starts 2 px before the actor (see
    // rounded_corners_effect.js), which moves all four sides.
    const bounds = {
        x1: x + 2,
        y1: y + 2,
        x2: x + 2 + actor.width + width,
        y2: y + 2 + actor.height + height,
"""
if 'Super G: the effect' not in s:
    assert old in s, 'corners computeBounds changed upstream'
    s = s.replace(old, new)
    open(p, 'w').write(s)
p = root + '/effect/rounded_corners_effect.js'
s = open(p).read()
old = """        const pixelStep = [
            1 / this.actor.get_width(),
            1 / this.actor.get_height(),
        ];
"""
new = """        // Super G: Clutter pads an offscreen effect's texture by 2 px before the
        // actor and 1 after it, at every scale. Mapping it onto the actor's own
        // size left the clip about 1 px past the window on every side.
        const pixelStep = [
            1 / (Math.round(this.actor.get_width()) + 3),
            1 / (Math.round(this.actor.get_height()) + 3),
        ];
"""
if 'Super G: Clutter pads' not in s:
    assert old in s, 'corners pixelStep changed upstream'
    s = s.replace(old, new)
    open(p, 'w').write(s)
print('corners clip mapping patched')
PY

# Corners: no per-app inset on maximized windows.
python3 -I - "$v/corners/manager/event_handlers.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """    const cfg = getRoundedCornersCfg(win);
"""
new = """    let cfg = getRoundedCornersCfg(win);
    // Super G: a per-app inset hugs what a floating window draws. Against the
    // screen's edges it would pull the rim on screen on some sides only.
    if (win.maximizedHorizontally || win.maximizedVertically) {
        const { left, right, top, bottom } = cfg.padding;
        // Past the edge by the rim's width, which would otherwise line the screen.
        cfg = { ...cfg, padding: {
            left: win.maximizedHorizontally ? -1 : left,
            right: win.maximizedHorizontally ? -1 : right,
            top: win.maximizedVertically ? -1 : top,
            bottom: win.maximizedVertically ? -1 : bottom,
        } };
    }
"""
if 'Super G: a per-app inset' not in s:
    i = s.index('function updateEffect') if 'function updateEffect' in s else s.rindex(old)
    j = s.index(old, i)
    assert 'updateUniforms' in s[j:j+300], 'corners updateEffect changed upstream'
    s = s[:j] + new + s[j+len(old):]
    open(p, 'w').write(s)
print('corners maximized inset patched')
PY

# Corners: skip-taskbar normal windows are helpers (Teams keeps an invisible call
# toast open); a shadow and border around one floats on screen around nothing.
python3 -I - "$v/corners/manager/utils.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """    // Skip libhandy/libadwaita applications according to settings.
"""
new = """    // Super G: helper windows, not the app's real ones.
    if (win.windowType === Meta.WindowType.NORMAL && win.is_skip_taskbar() &&
        !win.get_transient_for()) {
        return false;
    }
    // Skip libhandy/libadwaita applications according to settings.
"""
if 'Super G: helper windows' not in s:
    assert old in s, 'corners enable check changed upstream'
    s = s.replace(old, new)
    open(p, 'w').write(s)
print('corners helper windows patched')
PY

# Corners: window shadows are ours (lib/softShadow.js). Layered, squircle, dithered,
# drawn on the GPU with no offscreen buffer and nothing to redo on resize or focus.
python3 -I - "$v/corners" <<'PY'
import sys
root = sys.argv[1]
p = root + '/utils/constants.js'
s = open(p).read()
s = s.replace('export const SHADOW_PADDING = 80;', 'export const SHADOW_PADDING = 120;')
open(p, 'w').write(s)

p = root + '/manager/event_handlers.js'
s = open(p).read()
if 'WindowShadow' not in s:
    a = s.index('    const shadow = new St.Bin({\n        name: \'Shadow Actor\',')
    b = s.index('    // Draw the shadow actor below the window actor.')
    s = s[:a] + "    const shadow = new WindowShadow({ name: 'Shadow Actor' });\n    refreshShadow(actor);\n" + s[b:]
    s = s.replace("import { ClipShadowEffect } from '../effect/clip_shadow_effect.js';\n",
                  "import { WindowShadow } from '../../../lib/softShadow.js';\n")
    s = s.replace('import { CLIP_SHADOW_EFFECT, ', 'import { ')
    open(p, 'w').write(s)

p = root + '/manager/utils.js'
s = open(p).read()
if 'actor.setWindow' not in s:
    a = s.index('export function updateShadowActorStyle(')
    b = s.index('\n}\n', a) + 3
    s = s[:a] + """export function updateShadowActorStyle(win, actor, borderRadius, _shadow, padding) {
    const { left, right, top, bottom } = padding;
    actor.setWindow({
        hidden: !getPref('keep-shadow-for-maximized-fullscreen') &&
            (win.maximizedHorizontally || win.maximizedVertically || win.fullscreen),
        focused: win.appears_focused,
        radius: borderRadius,
        smoothing: getPref('global-rounded-corner-settings')?.smoothing ?? 0,
        inset: {
            left: SHADOW_PADDING + left,
            right: SHADOW_PADDING + right,
            top: SHADOW_PADDING + top,
            bottom: SHADOW_PADDING + bottom,
        },
    });
}
""" + s[b:]
    s = s.replace("import { boxShadowCss } from '../utils/box_shadow.js';\n", '')
    open(p, 'w').write(s)
print('corners shadows patched')
PY

# Corners: the shadow follows the window through a minimize. Its opacity wasn't
# bound, and the window's pivot, copied as is, scaled the shadow around its own
# corner, leaving it its full padding away from a shrunken window.
python3 -I - "$v/corners/manager/event_handlers.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
old = """        'pivot-point',
        'translation-x',
"""
new = """        'opacity',
        'translation-x',
"""
if "'opacity'," not in s:
    assert old in s, 'corners shadow bindings changed upstream'
    s = s.replace(old, new)
old = """    // Store shadow, app type, visible binding, so that we can access them later
    actor.rwcCustomData = {
        shadow,
"""
new = """    // Super G: the same point of the window, in the shadow's own coordinates.
    const syncPivot = () => {
        const [offsetX, offsetY] = shadow.get_constraints().map(constraint => constraint.offset);
        if (shadow.width && shadow.height) {
            shadow.set_pivot_point(
                (actor.pivot_point.x * actor.width - offsetX) / shadow.width,
                (actor.pivot_point.y * actor.height - offsetY) / shadow.height);
        }
    };
    actor.connectObject('notify::pivot-point', syncPivot, shadow);
    shadow.connect('notify::allocation', syncPivot);
    // Store shadow, app type, visible binding, so that we can access them later
    actor.rwcCustomData = {
        shadow,
        syncPivot,
"""
if 'syncPivot' not in s:
    assert old in s, 'corners shadow data changed upstream'
    s = s.replace(old, new)
    old = """            constraint.offset = offsets[i];
        }
    });
"""
    new = old + """    windowInfo.syncPivot();
"""
    assert old in s, 'corners shadow offsets changed upstream'
    s = s.replace(old, new)
open(p, 'w').write(s)
print('corners shadow follows the window')
PY

# Corners: windows can vanish at any time while the engine waits or keeps signals
# on them. Popups get no wm "destroy" at all (mutter just kills them), a surface
# can swap its texture, and adding the effect awaits a check. Without this the
# engine touches dead actors, logs a burst at every lock and leaks connections.
python3 -I - "$v/corners/manager" <<'PY'
import sys
root = sys.argv[1]
p = root + '/event_manager.js'
s = open(p).read()
if 'rwcRemoved' not in s:
    for old, new in [
        ("""            const notifyId = win.connect('notify::wm-class', () => {
                applyEffectTo(actor);
                win.disconnect(notifyId);
            });
""", """            // Super G: tracked, or it fires after the engine stopped; the actor
            // is looked up then, since the window may be gone.
            connect(win, 'notify::wm-class', () => {
                disconnectAll(win);
                const current = win.get_compositor_private();
                if (current)
                    applyEffectTo(current);
            });
"""),
        ("""    connections.push({
        object,
        id: object.connect(signal, callback),
    });
}
""", """    connections.push({
        object,
        id: object.connect(signal, callback),
    });
    // Super G: an actor dies with its signals; never disconnect those later.
    if (object instanceof Clutter.Actor && !watched.has(object)) {
        watched.add(object);
        object.connect('destroy', () => {
            for (let i = connections.length - 1; i >= 0; i--) {
                if (connections[i].object === object)
                    connections.splice(i, 1);
            }
        });
    }
}
const watched = new WeakSet();
"""),
        ("""    const texture = actor.get_texture();
    if (!texture) {
        return;
    }
    // Window resized.
""", """    const texture = actor.get_texture();
    if (!texture) {
        return;
    }
    // Super G: see tools/vendor-fixups.sh.
    actor.rwcRemoved = false;
    const metaWindow = actor.metaWindow;
    connect(actor, 'destroy', () => {
        actor.rwcRemoved = true;
        disconnectAll(metaWindow);
    });
    // Window resized.
"""),
        ("""function removeEffectFrom(actor) {
    disconnectAll(actor);
""", """function removeEffectFrom(actor) {
    actor.rwcRemoved = true;
    disconnectAll(actor);
"""),
    ]:
        assert old in s, 'corners event manager changed upstream: ' + old[:40]
        s = s.replace(old, new)
    if "gi://Clutter" not in s:
        s = "import Clutter from 'gi://Clutter';\n" + s
    open(p, 'w').write(s)

p = root + '/event_handlers.js'
s = open(p).read()
if 'rwcRemoved' not in s:
    for old, new in [
        ("""    const prev = actor.rwcLock;
    const next = prev ? prev.then(fn, fn) : fn();
""", """    const prev = actor.rwcLock;
    // Super G: the actor may be gone by the time this one's turn comes.
    const run = () => (actor.rwcRemoved ? undefined : fn());
    const next = prev ? prev.then(run, run) : run();
"""),
        ("""        const shouldHaveEffect = await shouldEnableEffect(win);
        const effect = getRoundedCornersEffect(actor);
""", """        const shouldHaveEffect = await shouldEnableEffect(win);
        if (actor.rwcRemoved)
            return;
        const effect = getRoundedCornersEffect(actor);
"""),
    ]:
        assert old in s, 'corners event handlers changed upstream: ' + old[:40]
        s = s.replace(old, new)
    open(p, 'w').write(s)
print('corners follows dead windows')
PY

# Corners: a preview's window can report no size yet, and a closed one no actor.
python3 -I - "$v/corners/patch/add_shadow_in_overview.js" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if 'frameWidth' not in s:
    for old, new in [
        ("""        const containerScaleFactor = windowContainerBox.get_width() /
            metaWindow.get_frame_rect().width;
""", """        const frameWidth = metaWindow.get_frame_rect().width;
        const containerScaleFactor = frameWidth ? windowContainerBox.get_width() / frameWidth : 1;
"""),
        ("""    const shadow = windowActor.rwcCustomData?.shadow;
""", """    const shadow = windowActor?.rwcCustomData?.shadow;
"""),
    ]:
        assert old in s, 'corners overview shadow changed upstream: ' + old[:40]
        s = s.replace(old, new)
    open(p, 'w').write(s)
print('corners overview shadow guarded')
PY

# Lock screen: idle callbacks that outlive what they style.
python3 -I - "$v/lockscreen/src/main" <<'PY'
import sys
root = sys.argv[1]
p = root + '/promptStyling.js'
s = open(p).read()
if '_wackGone' not in s:
    old = "if (entry && entry.get_stage && entry.get_stage())"
    assert s.count(old) == 2, 'lock prompt idle changed upstream'
    s = s.replace(old, "if (entry && !entry._wackGone && entry.get_stage && entry.get_stage())")
    old = """                'destroy', () => {
                    if (global.stage)
                        global.stage.disconnectObject(entry);"""
    assert old in s, 'lock prompt destroy changed upstream'
    s = s.replace(old, """                'destroy', () => {
                    entry._wackGone = true;
                    if (global.stage)
                        global.stage.disconnectObject(entry);""")
    open(p, 'w').write(s)
p = root + '/notificationManager.js'
s = open(p).read()
if 'cardGone' not in s:
    old = """                if (!this._extension) return;
                this._extension._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!this._extension) return GLib.SOURCE_REMOVE;
                    if (!actor.get_parent()) return GLib.SOURCE_REMOVE;
"""
    assert old in s, 'lock notifications idle changed upstream'
    s = s.replace(old, """                if (!this._extension) return;
                let cardGone = false;
                actor.connect('destroy', () => (cardGone = true));
                this._extension._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!this._extension || cardGone) return GLib.SOURCE_REMOVE;
                    if (!actor.get_parent()) return GLib.SOURCE_REMOVE;
""")
    open(p, 'w').write(s)
print('lock screen idles guarded')
PY
