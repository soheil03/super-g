# Architecture

## Flow

```
tokens/palette.json ──► lib/themeGen.js ──► GTK4 CSS (inline block in ~/.config/gtk-4.0/gtk.css)
                                        ├─► GTK3 themes ~/.local/share/themes/Super-G[-dark] (@import adw-gtk3 + overrides)
                                        └─► shell CSS (LiveStylesheet, scoped under #uiGroup)
extension.js ── MODULES (in order) ──► Module (ours)   appearance, panel, glass, drawer
                                   └─► Engine (vendor) corners, dock, dockmotion, blur, windows, hotcorners, gestures, launcher
```

## Modules

A module is a class with `enable()` (may be async) and `disable()`, built on
`lib/module.js`. `extension.js` starts and stops modules one after another in
`MODULES` order. A module is wanted when `module-<name>` is on, it isn't in
`broken-modules`, and, while the screen is locked, its upstream declares
`unlock-dialog` (modules with `needsDock` stop on lock too, and restart after
the dock). Errors in `enable()` or in guarded callbacks go to `reportError`:
the module stops, is added to `broken-modules` for this session (the list
resets at login), keeps its original switched off, and the user gets one
notification.

## Engines (vendored upstream extensions)

`lib/engine.js`:
1. **Handover:** switches off the original extension if it's active and records
   that in `~/.local/state/super-g/handover.json`. On disable, only originals
   that we switched off are switched back on.
2. **Migration (first run):** `dconf dump <old path>` → `dconf load <new path>`
   if ours is empty. The paths come from `vendor/<name>/UPSTREAM`.
3. **Collision guard:** if the original was imported earlier in this session,
   wait for the next login (`notePendingLogout`).
4. Builds the upstream `Extension` class with its own metadata, but with `path`/`dir`
   set to `vendor/<name>` and `settings-schema` set to our renamed id.
   install.sh copies the compiled schemas into each vendor folder, so
   `getSettings()` works unchanged.
5. Registers a stand-in so that `Main.extensionManager.lookup(<upstream uuid>)`
   returns the engine. Flourish and Kiwi find Dash to Dock this way.
6. Loads `vendor/<name>/stylesheet.css`, enables the instance, then runs the
   optional `configure()` hook. The `windows` hook forces Kiwi's button CSS off.

### Updating an engine

```bash
tools/vendor.sh dock /path/to/newer/dash-to-dock@micxgx.gmail.com
tools/vendor-fixups.sh
tools/install.sh
CLONE=1 tools/shell-test.sh /tmp/up light   # then look at the shots
```

## Settings

- Ours: `org.gnome.shell.extensions.super-g` (appearance, panel, motion, modules).
- Engines: `org.gnome.shell.extensions.super-g.<name>[.<child>]`. Modules
  can reach them through `engineSettings()` / `engineChildSettings()` (e.g. the
  panel module sets the blur engine's panel blur and turns off Kiwi's panel styling).
- Values Super G overwrites in system settings are saved first and restored
  on disable: `original-settings.json` (appearance), `panel-original.json` (panel).

## Theme details

- GTK4/libadwaita: `:root` custom properties plus `@define-color` for plain GTK4.
  `@media (prefers-color-scheme: dark)` holds the dark set. Window buttons
  target `windowcontrols`. The floating sidebar card is drawn on `.sidebar-pane`
  with a border in the window colour, so inner radius = outer − inset.
- GTK3: themes that `@import` adw-gtk3 and redefine its named colours. Switching
  `gtk-theme` between the light and dark names makes GTK3 apps reload.
- Shell: accent rules are mirrored from every loaded stylesheet (theme +
  other extensions) with our accent, then palette rules for menus and popups.
  Popups get a translucent tint when the blur engine marks `#uiGroup` with a
  `bms-popup-*` class, and stay solid otherwise.
