# Changelog

Tested versions are in [docs/UPGRADING.md](docs/UPGRADING.md).

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
