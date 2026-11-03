# Changelog

Tested versions are in [docs/UPGRADING.md](docs/UPGRADING.md).

## 1.2.6 - 2026-11-03

### Fixed
- The dock stays still after you open an app and move the pointer away. The icons used to rise again for a moment on the way up. They now only return when the pointer reaches another icon, or comes back to the dock after leaving it.
- Minimizing no longer leaves a dark rectangle flying ahead of the window. The window's shadow kept its full strength while the window faded, and drifted away from it as it shrank. It now fades and shrinks with the window, on restore and close too.
- The dock's dividers match. At fractional scales one could come out twice as thick as the other, depending on where it landed, and the one before the stack and minimized windows had wider gaps.
- A running dot no longer ends up too high when the dock settles while a slow app is still bouncing.

## 1.2.5 - 2026-11-03

### Fixed
- Notifications no longer glitch when you hover over them. While a banner expanded, its glass read the banner's size before layout ran and stuck out 28 px wider and 16 px taller. Glass that follows another surface now settles its layout first.

## 1.2.4 - 2026-11-03

### Fixed
- Clean edges and round corners on every app. The window clip sat about 1 px past each side, because the corners shader mapped its coordinates onto the window's size instead of the slightly larger texture it really gets. That let through whatever apps draw outside their frame: a dark line along Zen's straight edges, gaps beside Electron apps.
- Chromium and Electron apps leave more of a gap than the old inset allowed for (up to 4 px at the bottom at 133% scale). The inset now covers the largest measured, so there is never a gap, at the cost of up to about 2 px of an app's edge.
- Maximized windows have no rim or stray pixels along the screen's edges.
- No row of backdrop pixels shows between a window and its shadow.

### Changed
- New defaults, from the author's own setup: Slate palette, adaptive 36 px top bar, Thin glass, Adwaita window buttons, 12-hour clock, the Super key opening the app drawer, and matching dock, dock motion, gesture, lock screen and hot corner choices. Anything you already changed stays as it is. Settings you never touched follow the new defaults, and "Reset this page" now goes to them.

## 1.2.3 - 2026-11-03

### Fixed
- Quick settings submenus no longer stutter when opening or closing. Their drop shadow was blurred on the CPU again on every frame the submenu changed size: about 100 ms a frame in tests, now 3-9 ms. The submenu card has a thin outline instead.
- Submenu text stays inside its card while it animates.
- Glass no longer loses its background in a screenshot when it is inside a parent's offscreen pass.

### Changed
- The panel behind a quick settings submenu is no longer dimmed. The dim redrew the whole panel through an offscreen pass.

### Performance
- Blur shaders are shared. They used to compile again each time a menu reopened or a surface outgrew its textures.
- Menus blur once while they open, close or resize, then show that copy until the motion ends.
- Something small moving on glass, like the Wi-Fi spinner, redoes the blur at most 20 times a second rather than on every frame.

## 1.2.2 - 2026-11-03

### Changed
- Quick settings submenus (power, Wi-Fi and the rest) open in about 150 ms instead of 370 ms: the content fades in while the menu grows, not after it.

### Fixed
- The status pill keeps its size on hover. At rest it was painted 3 px smaller on every side.
- Maximized Chromium and Electron windows have no stray rim along some screen edges. The inset now applies only to floating windows, and is back to its earlier value, since the even one from 1.2.1 left artifacts.
- The dim behind quick settings submenus is back. Removing it in 1.2.1 didn't help the power menu.

## 1.2.1 - 2026-11-03

### Added
- **Reset this page to defaults** at the bottom of every settings page, with a confirmation.

### Fixed
- Stacked notifications from one app no longer show through each other in the quick settings panel.
- The clock's hover no longer draws a second, smaller pill inside the first.
- Chromium and Electron windows get the same edge inset on the left and right, so maximized ones look even.
- The power menu in quick settings no longer runs its dimming effect, which pushed the live glass through an offscreen pass. This could not be reproduced in the headless test shell, so check it on the real desktop.

## 1.2.0 - 2026-11-03

### Added
- New drop shadows on windows and glass, drawn on the GPU: three layers (ambient, mid, contact), following the true squircle corner, dithered so they don't band on smooth wallpapers. A window's shadow eases when it gains or loses focus.
- **Shadows** setting: none, subtle, standard or deep.
- **Adwaita (normal size)** window buttons.

### Changed
- Holding Super now acts while the key is still down, about half a second in, rather than on release.
- Default animation duration is 0.9x instead of 1.15x, and the app drawer opens faster. Your own setting is kept if you changed it.
- Clearer selection in Alt-Tab, and a focus ring on dock and app grid icons.

### Performance
- Window shadows no longer need a CPU blur on every resize and focus change, or an offscreen buffer per window.
- Glass sends its shader settings only when they change and does less per frame. CPU use under load did not change measurably in tests.

## 1.1.1 - 2026-11-03

### Docs
- Troubleshooting for GNOME turning all extensions off after a restart soon after login. No code change in the extension.

### Tools
- `tools/shell-test.sh` records how long the shell takes to exit, in `<sandbox>/stop-time`.

## 1.1.0 - 2026-11-03

### Added
- Live glass on restart, shutdown and logout dialogs, the Run dialog and every other modal dialog, plus notification popups, Alt-Tab, the volume and brightness popup, the workspace popup and the input method popup.
- Apple-style sidebars in GTK4 apps: inset card with a real shadow, tighter rows, soft accent selection. New settings for the card's corner radius and accent icons.
- Super key press, double press and hold actions, each configurable.
- `docs/UPGRADING.md`: how to port to a new GNOME or Ubuntu release.

### Fixed
- Dialogs, Alt-Tab, the OSD and the workspace popup had no background at all while glass was on. Surfaces now stay solid unless glass is really behind them, including during lock.
- The selected search result was a dark tile with dark text.
- X11 apps: GTK's light ring stopped where the app's content began, and title bars ignored the palette and sat too close to the edge.
- Glass read the wrong source under fades and on multiple monitors.
- A launch hop was cut off when the pointer left the dock.
- Teams' call toast and similar helper windows drew a stray outline. Not yet confirmed on a real session.

### Performance
- Closed menus release their GPU textures.
- The Super hold timer stops when the desktop is idle.

## 1.0.0

First public release: palette-driven theme for GTK and the shell, live glass, top bar, dock with magnification, app drawer, window corners, gestures, hot corners, launcher and lock screen, as one extension.
