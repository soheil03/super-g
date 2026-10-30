# Ubuntu Plus — working notes for edits

Read this first; it replaces re-exploring the code. Deeper detail: docs/ARCHITECTURE.md.

## Layout
- `tokens/palette.json` — single source of colours, radii, motion, fonts, panel/drawer choices. Copied to the extension as `tokens.json` at install.
- `extension/ubuntu-plus@soheil/`
  - `extension.js` — module registry (`MODULES`, start order matters: dock before dockmotion/windows/blur), sequential async start/stop, kill switch (`reportError` → `broken-modules`), lock-screen rule, `notePendingLogout`.
  - `lib/module.js` (base: tracked signals, `later()` debounce, `guard()`), `lib/engine.js` (runs vendored upstream extensions, lookup stand-ins, handover, first-run dconf migration), `lib/themeGen.js` (pure CSS generators, also used by tools), `lib/color.js`, `lib/files.js` (managed blocks), `lib/stylesheet.js` (`LiveStylesheet`, `engineSettings`).
  - `lib/glass.js` + `modules/glass.js` — Ubuntu Plus glass (replaces Blur my Shell): Shell.BlurEffect of the wallpaper + one GLSL pass (squircle AA outline, vibrancy, palette tint, top-weighted rim, grain). Applied to the top bar (tracked layer under panelBox), dock (child of dash._background), every PopupMenu (bin wrapped on first open) and the overview backdrop.
  - `lib/dockStyle.js` (dock CSS, apps-button icon, one-time engine defaults), `lib/dockMagnify.js` (Apple-style magnification: widens item slots + scales the icon's inner widget), `lib/wallpaper.js` (wallpaper strip luminance → automatic top bar text colour), `lib/blurSetup.js` (legacy blur engine pipelines).
  - `modules/appearance.js` (GTK4 CSS inline in `~/.config/gtk-4.0/gtk.css`, GTK3 themes `Ubuntu-Plus[-dark]` over adw-gtk3, shell CSS, fonts, `slow_down_factor`, system accent), `modules/panel.js` (top bar).
  - `vendor/<name>/` — upstream code (blur, corners, dock, dockmotion, windows, hotcorners, gestures, launcher). `UPSTREAM` records version and schema/dconf renames.
  - `schemas/` — ours + one renamed schema per engine (`org.gnome.shell.extensions.ubuntu-plus.<name>`, dconf `/org/gnome/shell/extensions/ubuntu-plus/<name>/`).
  - `prefs.js` — Adw prefs (Appearance, Fonts, Motion, Modules).
- `tools/` — `install.sh`, `takeover.sh`, `vendor.sh` + `vendor-fixups.sh`, `gen.js`, `render.sh`/`render-gtk.py`, `shell-test.sh`.
- `tests/shot@ubuntu-plus-test/` — camera extension used by shell-test.sh.

## Verify every visual change (don't guess)
- GTK: `gjs -m tools/gen.js <out> '{"palette":"stone"}' && tools/render.sh <out> <png-dir>` (broadway, offscreen).
- Shell: `tools/shell-test.sh <sandbox> light|dark [key=value | engine:key=value ...]`. Headless gnome-shell, own dconf, screenshots in `<sandbox>/shots`.
  - `CLONE=1` copies the real dconf and extensions (minus GSConnect), `TAKEOVER=1` runs takeover first, `EXCLUDE="uuid-prefix ..."` bisects clashes.
  - `SHOTS="desktop quick-settings calendar overview app-grid files settings text-editor disks-gtk3 dock-hover prefs eval"`.
  - `EVAL='return …'` with `SHOTS=eval` runs async JS inside the shell, output goes to `shots/eval.txt`. `Main.extensionManager.lookup('ubuntu-plus@soheil').stateObj._active` holds the modules.
- Headless limits: virtual pointer motion doesn't reach the stage (feed engines directly); Wayland blocks screenshots of the real session.

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
- Blur my Shell's panel blur is a rectangle, so a floating bar shows square corners; panel glass defaults off.
- Dock magnification is ours (Flourish's hover doesn't track Dash to Dock 110). Flourish resets the AppIcon's own transforms each frame, so scale the icon's inner widget and widen the DashItemContainer. Test it headless via `magnifier.applyAt()` (shell-test dock-hover).
- Glass layers contain a full-monitor wallpaper copy: they must report preferred size 0 or they blow up their parents.
- Forking vendored engines is allowed (user's call); every change lives in `tools/vendor-fixups.sh` so it survives `vendor.sh` updates (e.g. the dock clip headroom).
- Turning an engine off hands its original back unless another module replaced it (`noHandBack`, used by blur).
- Engine defaults Ubuntu Plus applies once are tracked in `~/.local/state/ubuntu-plus/tuned.json` (delete a key to re-apply).

## Conventions
- Comments explain why, not what. Match the existing terse style. GPL-3.0 headers on our files.
- Every user-facing choice becomes a setting (user's rule). Show options before building visual pieces.
- Commit messages end with the Co-Authored-By line the session provides.

## Release checklist (GitHub)
- Confirm licenses of `corners` and `gestures` upstream repos (no LICENSE file shipped in their packages) and add their license files to vendor/.
- Replace the `<you>` placeholders in README/INSTALL; consider a neutral uuid before publishing.
- Screenshots in README.
