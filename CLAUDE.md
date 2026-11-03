# Super G (formerly Ubuntu Plus, GNOME Plus) — working notes for edits

Read this first; it replaces re-exploring the code. Deeper detail: docs/ARCHITECTURE.md.

## Layout
- `tokens/palette.json` — single source of colours, radii, motion, fonts, panel/drawer choices. Copied to the extension as `tokens.json` at install.
- `extension/super-g@soheil/`
  - `extension.js` — module registry (`MODULES`, start order matters: dock before dockmotion/windows/blur), sequential async start/stop, kill switch (`reportError` → `broken-modules`), lock-screen rule, `notePendingLogout`.
  - `lib/module.js` (base: tracked signals, `later()` debounce, `guard()`), `lib/engine.js` (runs vendored upstream extensions, lookup stand-ins, handover, first-run dconf migration), `lib/themeGen.js` (pure CSS generators, also used by tools), `lib/softShadow.js` (GPU drop shadows), `lib/color.js`, `lib/files.js` (managed blocks), `lib/stylesheet.js` (`LiveStylesheet`, `engineSettings`).
  - `lib/glass.js` + `modules/glass.js` — Super G glass, truly live: each frame copy the pixels behind from the stage view (plus a margin, so edges don't smear), blur with Blur my Shell's dual Kawase passes imported from `vendor/blur/effects/blur/`, one GLSL pass (edge lens, (squircle AA outline, vibrancy, palette tint, rim, fine dark outline, grain) plus a hollow analytic drop shadow. On the top bar (tracked layer under panelBox), dock (child of dash._background), every PopupMenu (bin wrapped on first open) and the drawer. Overview backdrop uses the older static wallpaper blur (`live: false`).
  - `modules/drawer.js` — app drawer (dock popup / fullscreen / GNOME's overview).
  - `lib/dockStyle.js` (dock CSS, apps-button icon, one-time engine defaults), `lib/dockMagnify.js` (per-frame magnification on transforms only, after Dhruva: cosine bell, items translate, inner widget scales, the glass stretches inside its effect), `lib/wallpaper.js` (wallpaper strip luminance → automatic top bar text colour), `lib/blurSetup.js` (legacy blur engine pipelines).
  - `modules/appearance.js` (GTK4 CSS inline in `~/.config/gtk-4.0/gtk.css`, GTK3 themes `Super-G[-dark]` over adw-gtk3, shell CSS, fonts, `slow_down_factor`, system accent), `modules/panel.js` (top bar).
  - `vendor/<name>/` — upstream code (blur, corners, dock, dockmotion, windows, hotcorners, gestures, launcher, lockscreen). `UPSTREAM` records version and schema/dconf renames.
  - `schemas/` — ours + one renamed schema per engine (`org.gnome.shell.extensions.super-g.<name>`, dconf `/org/gnome/shell/extensions/super-g/<name>/`).
  - `prefs.js` — Adw prefs. `enumRow` builds choices from a key's own schema, for engine settings that are safe to expose. Never expose keys our modules force (Kiwi's panel and button styling, the dock's theme keys).
- `tools/` — `install.sh`, `takeover.sh`, `vendor.sh` + `vendor-fixups.sh`, `gen.js`, `render.sh`/`render-gtk.py`, `shell-test.sh`.
- `tests/shot@super-g-test/` — camera extension used by shell-test.sh.

## Verify every visual change (don't guess)
- GTK: `gjs -m tools/gen.js <out> '{"palette":"stone"}' && tools/render.sh <out> <png-dir>` (broadway, offscreen).
- Shell: `tools/shell-test.sh <sandbox> light|dark [key=value | engine:key=value ...]`. Headless gnome-shell, own dconf, screenshots in `<sandbox>/shots`.
  - `CLONE=1` copies the real dconf and extensions (minus GSConnect), `TAKEOVER=1` runs takeover first, `EXCLUDE="uuid-prefix ..."` bisects clashes.
  - `SHOTS="desktop quick-settings calendar overview app-grid apps drawer drawer-search notification menu-over-window lock-cycle files settings text-editor disks-gtk3 dock-hover prefs eval"`.
  - `EVAL='return …'` with `SHOTS=eval` runs async JS inside the shell, output goes to `shots/eval.txt`. `Main.extensionManager.lookup('super-g@soheil').stateObj._active` holds the modules.
- Real input works headless: EVAL scripts get `pointer` (`move`, `glide`, `click`), `shot(name)` and `wait(ms)`. Pointer events reach the stage only on a frame and an idle stage draws none, so `makePointer` keeps frames coming; buttons use Clutter numbering (`BUTTON_PRIMARY`), not evdev. Always test dock and drawer behaviour this way.
- Wayland blocks screenshots of the real session.

## Gotchas learned
- libadwaita: user CSS overrides `:root` vars fine, but never force `gtk-theme-name` in a GTK4 harness (GTK's built-in theme then hides everything).
- Ubuntu's libadwaita picks Yaru styles when gtk-theme starts with `Yaru`. Our theme names avoid that.
- Shell CSS: scope everything under `#uiGroup` (`scoped()` in themeGen) or Blur my Shell's class-based popup rules win. Accent rules are mirrored from every loaded stylesheet.
- St takes actor margins from CSS. Set panel gaps in CSS, not JS. Borders add to height; use inset box-shadow.
- Vendored engines collide (GType names) with an original loaded in the same session, so the switch needs one logout. takeover.sh does it before login.
- vendor.sh: escape dots in schema ids before sed (they matched `/`); cross-engine references live in vendor-fixups.sh.
- Kiwi and we both rewrite gtk.css; appearance re-checks its block 2 s after theme changes. Kiwi's button CSS is forced off (`windows` configure).
- GTK3 can't do the floating sidebar card or a joined capsule; it falls back.
- New or renamed extension → logout required (Wayland). Code changes too: a running extension never reloads.
- Blur my Shell clears dock backgrounds with `!important`; our dock glass uses `!important` too (lib/dockStyle.js).
- GNOME BaseIcon keeps `createIcon` bound per instance; the apps-button icon is swapped per instance, not on the prototype.
- Dock magnification is ours (Flourish's hover doesn't track Dash to Dock 110). Never touch layout per frame: DashItemContainer multiplies its preferred size by its scale, so scale the widget inside the icon (Flourish also resets the AppIcon's own transforms) and translate the container. Items live in several places (apps button, `_box`, Kiwi's strips); `_items` finds them.
- `frame(name)` in EVAL scripts captures the frame the stage really drew. `shot` repaints everything, so culling and damage bugs (dock ends cut off, stale regions) only show in `frame`. A parent caches its paint volume: an effect's volume must stay constant (`reach`) or the parent culls what grew past it.
- `glass.js` imports pass code from `vendor/blur`; re-check those exports after `vendor.sh blur`.
- MessageTray's source is `getSystemSource()`. Exercise every notification path before shipping: a thrown handler kills the module, and appearance dying resets the GTK theme.
- The dock's glass stretches without layout: `GlassLayer.setRoom` fixes the copy size for a hover, `setStretch` per frame. `set_size` on it would grow its parents (feedback loop).
- Share compiled shaders: copy `shaderTemplates` pipelines, never add a snippet per surface.
- Glass layers contain a full-monitor wallpaper copy: they must report preferred size 0 or they blow up their parents.
- Forking vendored engines is allowed (user's call); every change lives in `tools/vendor-fixups.sh` so it survives `vendor.sh` updates (e.g. the dock clip headroom).
- Turning an engine off hands its original back unless another module replaced it (`noHandBack`, used by blur).
- Engine defaults Super G applies once are tracked in `~/.local/state/super-g/tuned.json` (delete a key to re-apply).

- Shell.Screenshot repaints the stage into its own framebuffer without before-paint, so live glass falls back to the paint context's framebuffer there. Anything that only works in view paints looks broken in screenshots, and things cached under an offscreen parent look fine while being stale. Test liveness: put a colored actor behind, change it, shoot again.
- BoxPointer has OffscreenRedirect.ALWAYS, which freezes glass inside menus; GlassLayer lifts ALWAYS on its ancestors to AUTOMATIC (fades still use the buffer).
- St paints box-shadow under a transparent interior too, and glass would blur that into mud. Glass surfaces have no CSS shadow; the shader draws a hollow one (paint volume grown in vfunc_modify_paint_volume; dock clip has side room in vendor-fixups).
- paintContext.get_stage_view isn't in GI; the painting view is tracked with stage before-paint/after-paint.
- Locking stops engines without `unlock-dialog` plus `needsDock` modules (glass, drawer), restarting them in order on unlock. Test locks with Main.screenShield.lock/deactivate (scene `lock-cycle`), never sessionMode.pushMode: that leaves the shell in a broken state. The headless shell re-locks itself a few seconds after unlock, so probe quickly.
- `broken-modules` resets every login and a crashed module doesn't hand its original back. Before this, one bad lock cycle silently put the user on the original Dash to Dock for good. Check `dconf read .../super-g/broken-modules` and the enabled list first when "nothing changed" on the real desktop.
- GTK4 reads gtk.css once at start-up, so open libadwaita apps can't take a new palette live. Prefs applies it to itself with a CssProvider; appearance offers "Restart them" for apps with libgtk-4 mapped.
- Islands: each is its own GlassLayer tracking an `Island` (union of buttons). Panel margins are in CSS on all sides, so panelBox (and the struts) reserve the same gap under the bar.
- Top bar text picks by real contrast through the bar's tint, per box; panel glass has `guard: 0` since its text adapts. Other surfaces have a fixed theme text colour, so their tint thickens when the backdrop fights it.
- Conflicts: `CONFLICTS` in extension.js; auto off by default (`conflicts-auto-off`), a notification asks otherwise. Extensions a switched-off module handed back don't count.
- Wallpapers can be timed XML (lib/wallpaper.js `currentImage`) and half light, half dark: each top bar box picks its own text colour.
- A running session keeps the old code: when the user reports a bug, confirm what's actually running (installed version, journal) before debugging.

- Launch motion is ours on the icon itself (`_bounce`, hooked per instance over Flourish's `animateLaunch`, setting `dock-launch-bounce`). Flourish flies a clone in its own layer, which slips away from a settling row: the "ghost going down".
- Drawer scrolling only moves a target, eased per frame (wheel, touchpad with coast, touch drag). Real inputs in tests: `seat.create_virtual_device` with `notify_discrete_scroll`, `notify_scroll_continuous`, `notify_touch_*`.
- Menus get glass from a hook on `BoxPointer.open`: some openers keep their own reference to `PopupMenu.open` (Kiwi's app menu).
- The folder dialog's dim is the dialog's own `background_color`, eased in `_zoomAndFadeIn`, and lies over anything below it. `dialog.ease` drops that property; our wash goes under the glass.
- Wayland Chromium and Electron windows draw short of the frame they report (at 133%: left 2, top 1-1.6, right 1-2.4, bottom 2.5-4 px, varying with the window's size). `cornersSetup.js` detects them (Chromium's files beside the executable) and gives each a custom config with `CHROMIUM_INSET` padding, set to the largest of those. Maximized windows use padding -1 instead, so no rim lines the screen. Don't exclude them from rounding: their bottom corners go square. X11 ones (Teams) get a compositor frame styled by GTK4's CSS and need nothing. Test both: `X11_OFF=" "` in shell-test.sh starts Xwayland; launch with `--password-store=basic` to avoid the keyring prompt.
- Stand-ins answer `manager.lookup`, which GNOME's D-Bus listing also calls: without the `GetExtensionInfo` wrap in engine.js, the Extensions window shows every engine's original as on. Check with `gnome-extensions info <uuid>`.
- Clutter.Timeline freezes silently in two ways, leaving what it animated stuck (a dock icon in the air): its actor leaves every monitor (an autohiding dock), or nothing references it. Bind dock timelines to `global.stage` and keep a reference.
- `vendor/dock` ships no stylesheet.css: anything its code expects from one (notification badge) is styled in `dockStyle.js`.
- A click on the dock seats the row (`state.seated`, with the icon under it): it eases home and stays until the pointer reaches another icon on the dock, or leaves the dock (then a fresh wave starts on return). Timelines stop when nothing moves (`_sleep`); a running timeline redraws the glass every frame.
- Running dots are pushed below the icon with translation (`DOT_DROP`), compensated for the inner widget's scale.
- Drawer tiles are cached for the module's life; detach them before destroying their rows.

- Super key: `super-key-action` blocks GNOME's `overlay-key` handler (found with `GObject.signal_handler_find`) rather than disconnecting it, so it can go back. Test by emitting `overlay-key`.

- Super gestures (press, double, hold) are in `modules/drawer.js`. Hold reads MOD4 on a timer that stops after 3 s without input (`Meta.IdleMonitor`), so an idle desktop gets no wakeups.
- Helper windows (`NORMAL`, skip-taskbar, no parent, e.g. Teams' call toast) get no corners effect: it drew a stray outline. A launch hop keeps the dock unclipped through `state.hops`.
- The first search result is `:highlighted`, not `:selected`; GNOME's dark tile shows through any state we don't style (`tileStates` in themeGen).
- The X11 frame (`mutter-x11-frames`) is `window.csd > .titlebar > headerbar`, has no libadwaita colour variables, and reads gtk.css once at start. Probe it with `GTK4_CSS='...'` in shell-test.sh, since the block appearance writes comes too late for a sandbox's frame. Mutter doesn't respawn it after SIGTERM: X11 windows stop appearing until the next login. Never `pkill` by name in a test: it reaches the real session too.
- The window rim is the corners engine's border, following the colour scheme; GTK's outline is off because it stopped where X11 content starts.
- Sidebar card is a margin, not a window-coloured border, so it casts a real shadow. Settings' rows have margins set in code; `row > grid` takes them back with negative CSS margins.
- Shell surfaces are solid by default; the glass module adds `super-g-glassed` once glass is behind one (lock, a crashed module and uncovered surfaces stay readable). Dialog glass lives inside `dialogLayout` because the dialog's lightbox moves later siblings under its dim; it's thickened (`thicken`) so it doesn't turn grey over that dim.
- Notification banners get tracked glass from `child-added` on `messageTray._bannerBin`. Run `lock-cycle` last or alone: the headless shell re-locks afterwards and later scenes come out black or mid-fade.
- "Effects gone, extension INITIALIZED, `broken-modules` empty": check `disable-user-extensions` first. GNOME sets it when the shell is killed for not exiting in 5 s during its first 60 s after login, so a restart right after login does it with no crash. `stop-time` in a sandbox shows our exit time (about 170 ms).
- Drop shadows are `lib/softShadow.js`: one shader for glass and windows, the corners engine's actor patched in `vendor-fixups.sh`. Cogl only blends a pipeline it knows has alpha and can't see into a snippet, so a pipeline with no real texture needs a 1x1 RGBA one or it paints opaque black. `get_uniform_location` is per context, cached by name.
- An EVAL timing is only real with `pointer.click`: `menu.open(true)` skips the click path and shows a different animation.
- St keeps a fill inside a transparent border only while a box-shadow is set: GNOME's resting inset shadow on `.panel-button` made a pill 3 px smaller than its hover.
- An offscreen effect's texture is the actor plus 2 px before and 1 after (`_clutter_actor_box_enlarge_for_effects`), at every scale. The corners shader's coordinates must use that (vendor-fixups): upstream's mapping put the clip about 1 px past every side, showing what apps draw outside their frame.
- `get_transformed_size` before layout returns the preferred size with margins. Tracked glass calls the surface's own `get_allocation_box()` first, which runs pending layout (the stage's doesn't: its flag isn't set). Glass still trails a sliding banner by one frame.
- Not ours: a maximized Chromium or Electron window on a 100% display beside a fractional one flips between WxH and (W+1)x(H+1) about 11 times a second. A clean shell and Chrome do it too. `--disable-features=WaylandFractionalScaleV1` stops it, but at 133% the app renders about 10% smaller and slightly softer. Two displays in a sandbox: `VIRTUAL_MONITOR="2400x1600 --virtual-monitor 1920x1080"` plus `ApplyMonitorsConfig`.
- To check edges, measure pixel rows across each side with an app really running at 133%: `ApplyMonitorsConfig` works on a headless `VIRTUAL_MONITOR=2400x1600`.
- Engine schema defaults live in `tools/engine-defaults.py`, since `vendor.sh` replaces those schemas. Never put state or personal values in defaults: launch history, app lists, monitor names, anything a module writes itself. Per-corner hot corner settings are on paths, so `HOT_CORNERS` in extension.js sets them once.
- St blurs a CSS drop shadow on the CPU, again on every size change. On a surface that animates its size (a quick settings submenu) that was 100 ms a frame. Only `inset` shadows there, and check `box-shadow` first when something stutters while resizing.
- Headless paint timings show CPU costs well, but say little about the real GPU. To find a stall, time `before-paint` to `after-paint` per frame during the animation, then switch suspects off inside the EVAL.
- `GlassLayer.holdFor(ms, room)` shows one blurred copy while a surface moves. Pass `room` when it will grow, none when it shrinks or leaves.
- Blur pass shaders are shared through `shaderTemplates().passes`: `createPassPipeline` makes a new snippet, which compiles again.
- `ext._active.get(name)` is the module itself; `.instance` exists only on engine modules.
- Tried and removed: re-blurring glass at half rate on 120 Hz. CPU went up (19.5% to 25.5%), since a skipped frame must force another redraw.
- Super hold fires from the timer in `_checkHold`, so a Super combo pressed more than 450 ms in fires it first: key presses to clients aren't visible to the shell.
- The window shadow takes opacity by hand (`fade` in `lib/softShadow.js`): a snippet writing `cogl_color_out` ignores the actor's opacity. Its pivot is the window's pivot in its own coordinates (`syncPivot`, vendor-fixups), or it keeps its full padding away from a shrinking window. To see this, slow down with `St.Settings.get().slow_down_factor` and use `frame`.
- A 1 px line at a fractional scale covers 1 or 2 device pixels depending on its position. Dock dividers are scaled to a whole number of device pixels (`_evenDividers`). Test at 133%: `VIRTUAL_MONITOR=2400x1600` plus `ApplyMonitorsConfig`, then read the pixels.
- The raised part of a magnified icon has no input: above the dock, clicks and motion go to the window or desktop below, since shell chrome only takes the dock's own rectangle.
- In a sandbox the dock only shows with `CLONE=1` (otherwise Ubuntu's own dock takes over), and intellihide can leave it off screen: set `dock-fixed` in the EVAL, then read the dock state after, since it's rebuilt. Only click safe apps there: a clone sees the real ones.

## Conventions
- Comments explain why, not what. Match the existing terse style. GPL-3.0 headers on our files.
- Every user-facing choice becomes a setting (user's rule). Show options before building visual pieces.
- Commit messages end with the Co-Authored-By line the session provides.

## Release checklist (GitHub)
- Every job ends with a version bump (`metadata.json`), a `CHANGELOG.md` entry and a commit, without asking. Tested versions live in `docs/UPGRADING.md` and the README.
- Porting to a new GNOME or Ubuntu: follow `docs/UPGRADING.md`, and add any new private shell name you depend on to its table.
- Public at github.com/soheil03/super-g. README shots in `docs/screenshots/` come from a sandbox without CLONE, so they hold no personal data: keep it that way.
- Before an extensions.gnome.org submission: a neutral uuid, and review its rules on bundled code.
