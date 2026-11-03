# Porting Super G to a new GNOME or Ubuntu

For us, not for users. Follow it top to bottom when a new release arrives.

## Tested versions

Add a row each time, and copy the newest one into the README.

| Super G | Ubuntu | GNOME Shell | Mutter | GTK 4 | libadwaita | Session | How it was tested |
|---|---|---|---|---|---|---|---|
| 1.1.0 | 26.04.1 LTS | 50.1 | 50.1 | 4.22.4 | 1.9.1 | Wayland, 133% scale, Xwayland on | Headless shell at 100% scale, real keyboard and pointer input. Real-desktop check still to do |

`shell-version` in `metadata.json` also lists 51. That is a declaration, not a test.

## Why it breaks

GTK theming only sets CSS, so it rarely breaks. The shell side patches GNOME's private code, which changes without notice, so the risk sits there. A module that throws turns itself off through the kill switch (`reportError`, `broken-modules`), and the others keep running. So the usual symptom is one feature falling back to stock, not a dead desktop. Before debugging, check:

```bash
dconf read /org/gnome/shell/extensions/super-g/broken-modules
```

```bash
journalctl --user -b | grep -i super-g
```

## Steps

1. **Don't upgrade the real machine first.** Run the tests below on the new release in a VM or a spare install.
2. **Declare the version.** Add it to `shell-version` in `metadata.json`.
3. **Check the private names.** Use the table below. The library name carries a version (`libshell-18.so` on GNOME 50), so find it first:
   ```bash
   ls /usr/lib/gnome-shell/
   ```
   ```bash
   gresource list /usr/lib/gnome-shell/libshell-18.so | grep '\.js$'
   ```
   ```bash
   gresource extract /usr/lib/gnome-shell/libshell-18.so /org/gnome/shell/ui/dialog.js | grep -n '_dialog ='
   ```
4. **Update the engines.** Install each upstream's release for the new GNOME, then run the line below for each one. `vendor.sh` replaces the folder, and `vendor-fixups.sh` reapplies our patches. A fixup that no longer matches means upstream changed that code: read it, don't force it.
   ```bash
   tools/vendor.sh blur ~/.local/share/gnome-shell/extensions/blur-my-shell@aunetx
   ```
   Then check that the pass exports `lib/glass.js` imports from `vendor/blur/effects/blur/` still exist.
5. **Run every test below**, in light and dark.
6. **Check the stock stylesheet.** Selectors and pseudo-classes move. Extract it and compare states against `shellCss` in `lib/themeGen.js`:
   ```bash
   gresource extract /usr/share/gnome-shell/gnome-shell-theme.gresource /org/gnome/shell/theme/gnome-shell-light.css > /tmp/shell-light.css
   ```
   Check the libadwaita variables in `gtk4Vars` the same way, against a rendered Files and Settings.
7. **Install on the real machine and log out.** A running shell never reloads extension code. Check `broken-modules`, then go through the real-desktop list.
8. **Release.** See the checklist at the end.

## Private names we depend on

| Name | Used in | If it changes |
|---|---|---|
| `PopupMenu.prototype.open`, `BoxPointer.prototype.open`, `bin` | `modules/glass.js` | Menus are solid, no glass |
| `ModalDialog.prototype.open`, `dialogLayout._dialog` | `modules/glass.js` | Dialogs are solid, no glass |
| `SwitcherPopup.prototype.show`, `_switcherList` | `modules/glass.js` | Alt-Tab is solid |
| `OsdWindow.prototype.show`, `_hbox` | `modules/glass.js` | Volume and brightness popups are solid |
| `WorkspaceSwitcherPopup.prototype.display`, `_list` on its children | `modules/glass.js` | Workspace popup is solid |
| `Main.messageTray._bannerBin` | `modules/glass.js` | Module crash at start: check first |
| `AppFolderDialog.prototype.popup`, `_viewBox`, `background_color` eased in `_zoomAndFadeIn` | `modules/glass.js` | Folder has no glass, or a dark dim over it |
| `Main.panel._leftBox`, `_centerBox`, `_rightBox` | `modules/panel.js`, `modules/glass.js` | Top bar layout and islands |
| `dock.dash._background`, `_box`, `_items` (Dash to Dock) | `modules/glass.js`, `modules/drawer.js`, `lib/dockMagnify.js` | Dock has no glass or no magnification |
| `AppIcon.animateLaunch`, `createIcon` on `BaseIcon` | `lib/dockMagnify.js`, `lib/dockStyle.js` | Launch bounce, Show Apps icon |
| `Main.shellDBusService._extensionsService.GetExtensionInfo` | `lib/engine.js` | Extensions window shows the originals as on |
| GNOME's `overlay-key` handler, found with `GObject.signal_handler_find` | `modules/drawer.js` | Super key setting does nothing |
| `Clutter.Effect.vfunc_paint_node`, `Cogl.Framebuffer.blit`, stage `before-paint`/`after-paint` | `lib/glass.js` | Glass is blank or frozen: the hardest one |
| `OffscreenRedirect.ALWAYS` on BoxPointer | `lib/glass.js` | Menu glass freezes |
| `window.csd > .titlebar > headerbar` in `mutter-x11-frames` | `lib/themeGen.js` | X11 title bars lose palette and padding |
| Yaru name check in libadwaita | theme names | Ubuntu's Yaru styles return if a name starts with `Yaru` |

The rest is `CLAUDE.md`, "Gotchas learned": read it before changing anything here.

## Engines

Each folder's `vendor/<name>/UPSTREAM` holds the imported version and schema renames.

| Engine | Upstream | Version in 1.1.0 |
|---|---|---|
| `blur` | [Blur my Shell](https://github.com/aunetx/blur-my-shell) | 76 |
| `corners` | [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners) | 25 |
| `dock` | [Dash to Dock](https://micheleg.github.io/dash-to-dock/) | 110 |
| `dockmotion` | [Flourish](https://github.com/Orsso/flourish) | 1.2.1 |
| `gestures` | [Touchpad Gesture Customization](https://github.com/HieuTNg/touchpad-gesture-customization) | 28 |
| `hotcorners` | [Custom Hot Corners Extended](https://github.com/G-dH/custom-hot-corners-extended) | 50.0 |
| `launcher` | [Superbar](https://github.com/Furkan-rgb/superbar) | none recorded |
| `lockscreen` | [WACK](https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen) | 2.1.0 |
| `windows` | [Kiwi](https://github.com/kem-a/kiwi-kemma) | 2.3.1 |

## Tests

`tools/shell-test.sh <sandbox> light|dark` runs a headless shell with its own dconf, so it can't touch your settings. Use `CLONE=1 TAKEOVER=1` to test with your real setup.

```bash
CLONE=1 TAKEOVER=1 SHOTS="desktop quick-settings calendar overview app-grid apps drawer drawer-search notification menu-over-window files settings text-editor disks-gtk3 dock-hover prefs" tools/shell-test.sh /tmp/sg light
```

```bash
CLONE=1 TAKEOVER=1 SHOTS="lock-cycle" tools/shell-test.sh /tmp/sg-lock light
```

Then read the shots and look for `JS ERROR` and `super-g: module` in `shell.log`.

Rules that cost us time:

- Run `lock-cycle` alone. The headless shell re-locks afterwards, and later scenes come out black or mid-fade.
- `frame(name)` in an `EVAL` script shows what the stage really drew. `shot` repaints everything and hides culling and staleness bugs.
- To test liveness, put a coloured actor behind a surface, change its colour, and capture again.
- Set `X11_OFF=" "` to test X11 apps. The X11 frame reads gtk.css once at start, before the extension writes it, so seed it with `GTK4_CSS='...'`.
- Never `pkill` by name inside a test. It reaches the real session too, and Mutter does not restart `mutter-x11-frames` after SIGTERM.

## Real-desktop list

Wayland blocks screenshots of the real session, so this part is by eye.

- [ ] Top bar in each style, on a light and a dark wallpaper, with a maximized window
- [ ] Dock hover, launch bounce, autohide reveal from the screen edge, right-click menu
- [ ] Drawer: open, search, scroll with touchpad and wheel, close by Super and by clicking outside
- [ ] Super: press, double press, hold
- [ ] Quick settings, calendar and app menus, with a moving window behind
- [ ] Restart, shut down and log out dialogs, Run dialog (Alt+F2)
- [ ] Alt-Tab, volume popup, workspace popup, notification popup
- [ ] Lock, unlock, then check that the dock is still ours
- [ ] Files, Settings, a GTK3 app and an Electron app, in light and dark; corners on all
- [ ] An X11 app such as Teams with `--ozone-platform=x11`: title bar, corners
- [ ] Extensions window: the originals show as off
- [ ] Touchpad gestures and hot corners
- [ ] Multiple monitors, if available

## Release checklist

Every change ends with these:

1. Bump `version` and `version-name` in `metadata.json`.
2. Add it to `CHANGELOG.md`.
3. Update the tested versions here and in the README if anything was retested.
4. Commit, with the Co-Authored-By line.

Patch for fixes, minor for features, major when a GNOME port drops an older release.
