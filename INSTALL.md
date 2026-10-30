# Installing Ubuntu Plus

## Requirements

- Ubuntu 26.04 LTS (GNOME Shell 50) or newer, on Wayland or X11
- `adw-gtk3` theme, for GTK3 apps. Install it from your package manager, or
  from [its releases](https://github.com/lassekongo83/adw-gtk3/releases) into
  `~/.local/share/themes`.
- `git`, `glib-compile-schemas` (package `libglib2.0-bin`), `python3`, `rsync`
  (the last is only needed to update the vendored modules)

## Install

```bash
git clone https://github.com/<you>/ubuntu-plus.git
cd ubuntu-plus
tools/install.sh
```

`tools/install.sh` copies the extension to
`~/.local/share/gnome-shell/extensions/ubuntu-plus@soheil` and compiles its settings.

### If you already use any of the replaced extensions

Blur my Shell, Dash to Dock, Rounded Window Corners Reborn, Flourish, Kiwi,
Just Perfection, Custom Hot Corners - Extended, Touchpad Gesture Customization
or Superbar:

```bash
tools/takeover.sh --dry-run   # shows what would happen
tools/takeover.sh
```

It copies each extension's settings into Ubuntu Plus, switches the originals
off and enables Ubuntu Plus. Run it **before** logging out, so the originals
don't load again. If you skip it, Ubuntu Plus does the same at the next login,
but then needs one more logout to finish.

### Finish

Log out and back in. On Wayland, GNOME only loads new extensions at login.

## Update

```bash
cd ubuntu-plus && git pull && tools/install.sh
```

Then log out and back in.

## Turn off or uninstall

- **Turn off one module:** Ubuntu Plus settings → Modules. Any original
  extension that module replaced is switched back on.
- **Turn off everything:** switch Ubuntu Plus off in the Extensions app. Your
  previous GTK theme, accent, fonts and clock settings are restored, and the
  originals are switched back on.
- **Uninstall:** turn it off first, then
  `rm -rf ~/.local/share/gnome-shell/extensions/ubuntu-plus@soheil ~/.local/share/themes/Ubuntu-Plus*`.

## Troubleshooting

| Symptom | What to do |
|---|---|
| A notification says a module was switched off | Check `journalctl --user -b \| grep ubuntu-plus` for the error, then turn the module back on in Settings → Modules |
| "Log out and back in once to finish switching" | Log out once. An original extension was still loaded in this session. |
| GTK apps didn't change | Restart the app. GTK4 apps read the theme at start-up. |
| Theme reverted after using Ubuntu's Appearance panel | Ubuntu Plus switches it back within a second. Choose colours in Ubuntu Plus settings instead. |
