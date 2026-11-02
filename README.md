# Super G

One GNOME Shell extension and one theme for a clean, consistent Ubuntu desktop.
Instead of nine separate extensions that each patch the shell their own way,
Super G runs everything as modules of a single extension, driven by a
single colour and shape palette, with one settings window.

Built for **Ubuntu 26.04 LTS / GNOME 50** (GNOME 51 declared). An independent project, not affiliated with GNOME or Canonical. Dock magnification follows [Dhruva](https://github.com/narkagni/dhruva) by NarkAgni (GPL-3.0).

## What it does

| Module | What you get | Built on |
|---|---|---|
| Appearance | Palette-driven theme for GTK4/libadwaita, GTK3 and Flatpak apps, plus shell menus, quick settings, calendar, dialogs and switchers. Window button styles, floating sidebar card, corner radius, fonts, animation speed. | Super G |
| Top bar | Floating, islands or adaptive bar, height, glass, clock format, grouped status pill, hidden accessibility icon, start on the desktop | Super G |
| Corners | Rounded window corners with smoothing, borders and shadows | [Rounded Window Corners Reborn](https://github.com/flexagoon/rounded-window-corners) |
| Glass | Live dual Kawase blur (Blur my Shell's passes) of what is really behind menus, dock, top bar, drawer and launcher, with edge refraction after [Liquid Glass](https://github.com/ryohsuke1231/liquid-glass), in five thicknesses or custom | Super G |
| Lock screen | Sonoma-style clock and unlock | [WACK](https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen) |
| App drawer | Popup from the dock, fullscreen or GNOME's overview; search, category pills, most used | Super G |
| Dock | Dock with autohide, intellihide, previews, trash and mounts | [Dash to Dock](https://micheleg.github.io/dash-to-dock/) |
| Dock motion | Hover, press, launch and attention motion for dock icons | [Flourish](https://github.com/Orsso/flourish) |
| Windows | App title in the top bar, minimize to dock, keyboard indicator, calendar layout and more | [Kiwi](https://github.com/kem-a/kiwi-kemma) |
| Hot corners | Actions for corners and edges | [Custom Hot Corners - Extended](https://github.com/G-dH/custom-hot-corners) |
| Gestures | Touchpad gesture customisation | [Touchpad Gesture Customization](https://github.com/HieuTNg/touchpad-gesture-customization) |
| Launcher | Keyboard-driven command bar | [Superbar](https://github.com/Furkan-rgb/superbar) |

Four palettes (Graphite, Catppuccin, Warm stone, Cool slate) and seven accents
(blue, lavender, slate, teal, sage, peach, rose) work in light and dark mode.

### How it stays robust

- **Isolated modules.** If a module fails, for example after a GNOME update
  changes something it relies on, only that module switches off and you get a
  notification. Everything else keeps working. Turn it back on from Settings → Modules.
- **Upstream code, kept up to date.** Modules marked *Built on* run the original
  project's code, with its settings moved under Super G. When an upstream
  project ships a fix for a new GNOME release, `tools/vendor.sh` pulls it in.
- **Takes over cleanly.** If you already use any of those extensions,
  Super G copies their settings and switches them off. Turning a module
  off switches the original back on.
- **Theme, not a re-skin.** Colours, radii and fonts are applied on top of
  GNOME's own styles (libadwaita, adw-gtk3, the shell theme). Nothing is
  rewritten, so GNOME updates don't break the look.

## Install

See [INSTALL.md](INSTALL.md). Short version:

```bash
git clone https://github.com/<you>/super-g.git && cd super-g
tools/install.sh && tools/takeover.sh
```

Then log out and back in.

## Settings

Open **Extensions → Super G → Settings**. Pages: Appearance, Fonts, Motion,
Modules. Each module's full upstream settings are kept too.

## Limitations

- Apps that draw their own interface (Electron apps such as VS Code, Discord
  or Slack, and Chrome's web UI) only follow the GNOME accent colour.
- Snap apps follow the GTK4 part of the theme. GTK3 snaps may not.
- New or renamed extensions only load after a logout on Wayland.

## Credits and license

Super G is licensed under **GPL-3.0-or-later** (see [LICENSE](LICENSE)).
It includes code from the projects listed above, all GPL licensed, and each
keeps its original license file and copyright in `extension/super-g@soheil/vendor/<module>/`.
Thanks to their authors. Super G only adds the glue, the theme and the
settings around their work.
