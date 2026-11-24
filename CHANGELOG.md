# Changelog

Tested versions are in [docs/UPGRADING.md](docs/UPGRADING.md).

## 1.16.0 - 2026-11-24

### Added
- Adaptive glass tone, now the default (Glass, Tone: Adaptive, Always dark, Follow light and dark). The shell stays dark glass, but a menu, quick settings, a banner, a dialog, the OSD or a switcher over something bright turns light glass with dark text. Dark glass over a bright sky turned it into a flat grey slab with white text at about 2:1; a surface now turns light where white text would fall under 3:1, and back above 3.6:1. The backdrop is judged when the surface opens, from the wallpaper image and the app theme's colour where a window covers it, so nothing is read back from the GPU. The dock and the top bar are unchanged (the bar already picks its text per box).
- Quick settings' submenus follow their panel's tone.

## 1.15.3 - 2026-11-24

### Changed
- Liquid glass at the clear end of the clarity slider is much thinner: dark glass now lets white through at 0.7 (was 0.53, a grey slab), light glass goes down to 0.42 over black (was 0.55), colour keeps 92% (was 80%), and the frost drops to 0.35 of regular (was 0.65). Regular and tinted glass are unchanged; move the slider up for more calm under text.

### Fixed
- Lock screen clock and date over a light wallpaper: they were always white at 60 to 85% with an almost invisible shadow. Over a light clock region they now go dark and translucent, so the wallpaper's colour shows through; over mid tones the white gets a stronger shadow. The user name and the unlock hint follow the same rule from the prompt region.
- Collapsed notification stacks no longer touch a card the lock screen already destroyed (a "has been already disposed" critical on every lock).

## 1.15.2 - 2026-11-24

### Performance
- Shell stylesheet is a third smaller (87 KB to 55 KB, 1278 selectors to about 640). Each class selector was written twice in case the class sat on the UI root; only the few classes engines really put there (Blur my Shell's, Kiwi's) keep that second form. St matches every selector against every widget it styles, so every menu, dialog and overview open gets cheaper.
- Top bar menus get their glass while closed, two seconds after start, instead of on the first click.
- Measured in a headless shell: first Quick Settings open 175 ms to 90 ms, second 171 ms to 37 ms (GNOME alone: 56 and 24); first calendar open 49 ms to 38 ms. An idle desktop still draws no frames (0.2% CPU), and following glass surfaces costs about 6 microseconds a frame.

## 1.15.1 - 2026-11-24

### Docs
- README leads with a tagline, light and dark hero shots and a list of the best features. New screenshots (hero, dock magnification, drawer, quick settings, calendar) come from a sandbox on a bright wallpaper with real windows open, so the glass shows; none holds personal data. No change to the extension itself.

## 1.15.0 - 2026-11-24

### Changed
- Liquid glass is rebuilt on Apple's own model (docs/LIQUID_GLASS.md), not tuned constants on ours. Brightness goes through a fixed band that never inverts what's behind (dark glass: black 0.08 to white 0.48; light: 0.68 to 0.97), colour is calmed to about 0.6 instead of boosted, and the fill is neutral, not the palette colour.
- The edge is a real lens: a 20 pt rounded rim that bends and softly mirrors what's inside, frosted half as much as the face. No colour fringes.
- Light from around the glass drifts into it (bleed), a 1 pt glint in the backdrop's own colour lights two opposite corners, and a thin dark contour outside the edge separates it from light backdrops, as on macOS 27.
- Shadows under big glass are lighter and take the backdrop's colour. Grain, sheen and the contrast guard's patches are gone.
- Corners follow Apple's continuous curve (exponent 3).
- Glass clarity: 0.3 is Apple's regular glass, 1 the tinted end, 0 a clear end.
- Notifications in Quick Settings and the calendar take the toggles' translucent wash instead of solid grey. Stacked cards are cut to the strip that peeks out, so they never show through each other.
- Notification banners frost more of what's behind, and the app name in every notification is easier to read.

## 1.14.2 - 2026-11-24

### Docs
- [docs/LIQUID_GLASS.md](docs/LIQUID_GLASS.md): how Apple builds Liquid Glass on macOS 27, from the transcribed QuartzCore shader and the values AppKit sets on a live view, checked against an iOS 27-fitted renderer and macOS 27.2 measurements. It gives a recipe for light and dark glass and ranks thirteen ways ours differs, from a dark band that inverts what's behind to an edge lens a tenth of Apple's. No change to the extension itself.

## 1.14.1 - 2026-11-24

### Reverted
- Everything in 1.14.0: glass, the dock and the bar look as in 1.13.0 again, and "Wallpaper, as Apple" is the default tone again. 1.14.0's light veil and light panels were a step back.

## 1.13.0 - 2026-11-24

### Added
- Top bar menus switch on click only (Settings, Top bar, "Switch menus by hovering", off by default): while a menu is open, pointing at another item no longer opens it; one click on it does, and keys still move between menus.

### Fixed
- The jump when opening the date panel (and every menu): the wallpaper tone stacked the shell theme's whole dark variant over the light one, doubling style matching for every widget (opening the calendar took 123 ms instead of 48, longer than its 150 ms animation's first frames). On Ubuntu the shell now switches to its own dark theme (org.gnome.shell.ubuntu color-scheme, set only from 'default' and put back); stacking stays only as a fallback elsewhere.
- Dark glass over a white window settles at dark graphite instead of flat grey, and text panels blur 11 px instead of 7, so a window's text no longer ghosts through menus and the calendar.
- Quick settings toggles and their arrows pick text by real contrast: white on the pale dark-mode accent was 2.4:1, dark text is 7:1.

### Performance
- The first drawer open went from 334 ms to 122 ms: icon shapes and colours are read ahead in idle time after login.
- Icon tiles no longer keep their pixels after the GPU has them, and load at 1.5x instead of 2x.
- Glass no longer grows its blur targets to the whole screen when a surface outgrows them (a calendar whose weather row loaded); it leaves 25% headroom.

## 1.12.1 - 2026-11-24

### Fixed
- Dock running dots are white with a dark halo: the theme's dark dot vanished on the dimmed dock.

## 1.12.0 - 2026-11-24

### Changed
- Glass edges measured against Apple's panels pixel by pixel: light comes from straight above, so only the top edge is lit (faintly) and the bottom edge carries the brighter reflection; the sides get none, and dark glass loses the fine dark outline. The old all-round bright line read as a drawn plastic border.
- Floating panels cast Apple's deeper drop shadow (about 40% darker right below the edge, fading over some 15 px); the dock casts none, and the dock and the top bar carry only a faint rim, as Apple's do.
- Icon tiles take 82% of their icon box, as Apple's 824 px tile on a 1024 px canvas: plates filling the whole box crowded the dock and every grid. The drawer's icons grew to keep the same visible size as Apple's apps panel.
- Drawer, as Apple's apps panel: 34 px corners, darker pill controls, a neutral selected chip instead of an accent one, pure white medium-weight labels, and no focus ring around the search field (the theme's ring was forced with !important).

## 1.11.0 - 2026-11-24

### Added
- Glass tone (Settings, Glass): "Wallpaper, as Apple" (default) gives the shell's glass (the drawer, menus, quick settings, the calendar, notifications) Apple's floating-panel material in light mode too: the wallpaper dimmed and saturated, with white text, while apps stay light. "Follow light and dark" keeps the old light glass. In wallpaper tone on a light system the shell theme's own dark variant (Yaru-dark, gnome-shell-dark.css) loads under our sheet, so headers, buttons and switches inside the glass match.
- `tools/shell-test.sh` takes `WALLPAPER=/path/to/image`, to calibrate against a reference screenshot's backdrop.

### Changed
- Calibrated on the backdrop of an Apple screenshot: over the same orange, the drawer now lands at the same brightness as Apple's apps panel (luma 0.36-0.48 against 0.35-0.46). Dark glass keeps a mid-tone wallpaper's own brightness and colour instead of murk, and dims harder over a white window, so white text stays strong there.
- The dock and the top bar are Apple's vibrant material: what's behind, slightly dimmed and more saturated, never lifted towards white. The dock's lens edge is wider, so its ends bend what's behind as Apple's do.

## 1.10.0 - 2026-11-24

### Changed
- Liquid glass retuned against Apple's Control Center: it is clear, not frosted. Text panels blur about 7 px instead of 34 (the backdrop shows through as soft streaks, as on Apple's), the rim's lens band is at most 12 px instead of 22, the inner glow is a narrow line where the light falls rather than a wide band, and the tint floor is halved. Legibility comes from the brightness squeeze, not from blur.
- The squeeze moves brightness and keeps hue: colour is scaled to fit instead of clipped, so light glass over a navy wallpaper is soft blue-white rather than saturated cyan. Light glass keeps a little less colour, dark glass a little more.

## 1.9.0 - 2026-11-24

### Changed
- Liquid glass has real thickness at its edge: the bevel shows the actual backdrop, bent further and only lightly diffused (the first level of the blur, already computed), while the middle stays frosted and quiet. A window edge or bright grass behind a panel now bends along its rim, as through Apple's glass, instead of the panel reading as a flat tint.
- Liquid glass adds a broad, quiet reflection: a soft sheen under the top edge and in the lit corner, a faint one opposite. Light glass whitens a little less and gets less vibrancy, so it stays near white rather than pastel; dark glass keeps its colour.
- App icon plates are drawn by the GPU (lib/iconPlate.js): true continuous-corner squircles, a three-layer soft shadow (wide ambient, mid, tight contact line) instead of St's single CPU-blurred halo, and a specular rim over the icon, bright along the top with a faint reflection along the bottom, plus a hairline that holds a white tile's shape.
- Icons that are tiles are drawn by the plate from their own pixels, cropped past their edge and cut to the shape, the way Apple masks full-bleed art: no more nested squares or the icon's own lighter ring inside ours (terminal, Obsidian, GitKraken).

## 1.8.0 - 2026-11-23

### Changed
- Liquid glass reads by role, not size: everything that carries text in the theme's colour (menus, the calendar, quick settings, notification banners, OSDs, switchers, dialogs, the drawer) always gets the full reading treatment, so small surfaces like a banner no longer show sharp windows behind their text. The dock and the top bar stay clear.
- Liquid glass material: the brightness squeeze no longer reads as milk; the colour it lifts is given back as vibrancy (clean pale blue glass over a blue backdrop, not lavender grey), and light glass sits a little brighter under text.
- Liquid glass edge, after Apple's: a specular hairline one device pixel in, brightest facing the light with a second lobe opposite, a soft glow falling off inside the lit bevel, screen-blended so light glass never burns white, and a fine darker edge that outlines the shape over light backdrops.
- Cards on glass (calendar events, world clocks, weather) are light platters with a fine light edge instead of grey cards.
- App icons: an icon that already is a tile (a rounded square or circle with one edge colour, like Telegram, GitKraken or a terminal) becomes the shape instead of sitting nested on a second plate; its plate takes its top and bottom edge colours and it fills up to where its corners stay inside. Glyph icons get clean neutral plates (white, graphite in dark mode) instead of tints of their own colour, which read as mud. Plates have a fine edge and a closer, softer shadow.

## 1.7.0 - 2026-11-23

### Changed
- Liquid glass is legible on big panels (drawer, menus, calendar, dialogs) without turning frosted: a "calm" step squeezes the backdrop's brightness into the band the theme's text reads on, keeping its colour, so a white window beside a dark one no longer puts text on the wrong side of the glass. Big panels also never blur below a real frost (a window edge showed as a hard seam) and carry a little tint that grows with size. The dock and the top bar keep your Clear/Tinted setting.
- App icon plates: a glyph icon now sits on a calm light (dark in dark mode) plate with a hint of its own colour, instead of its own colour (an orange glyph on orange vanished). Dark glyphs keep a light plate in dark mode. Plates have a soft vertical gradient and one gentle drop shadow. Full-bleed icons keep their colour.

## 1.6.0 - 2026-11-23

### Added
- Unified app icons (Settings, App icons): every app icon sits on one plate shape, squircle as Apple, circle as Google or rounded square, whatever the icon pack draws, as on Android. The plate takes its colour from each icon (a full-bleed icon is its own plate, a glyph gets its strongest colour, a grey one a neutral tile), or one neutral tile for all. The dock, the overview grid, the drawer and switchers agree, since it hooks `Shell.App.create_icon_texture`. Plain St with no shader, so it also works on GNOME 51. Off by default. The Trash and Downloads items keep their own look.

## 1.5.2 - 2026-11-23

### Fixed
- The All Windows preview menu could be taller than the screen and sit partly off it. Previews were a fixed fraction of each window, so a large window gave a huge preview. They are now capped to a 300 x 190 box whatever the scale setting says.
- GNOME 51 (Fedora 45): the extension failed to load with "class heritage ... GLSLEffect is not an object", since GNOME 51 removed `Shell.GLSLEffect`. It now loads there with glass, the app drawer and window corners switched off until their shaders are ported to `Clutter.ShaderEffect`. Reported by Balazsmi in issue 1.

### Changed
- Liquid glass at Clear is now actually clear: about a 2 px blur, almost no tint and a mild saturation (it was 12 px, 1.6 saturation). A wider bevel with a stronger pull.

## 1.5.1 - 2026-11-18

### Fixed
- Glass stayed frozen on an old picture (the wallpaper behind a window you had since opened, for example). On a real GPU only the changed part of the screen is redrawn, and the rest of the buffer still holds an older frame, Super G's own glass included. The check for whether a redraw covered the whole glass rounded to 133% and counted overlaps twice, so the glass copied and re-blurred its own past output. It now asks mutter's region directly whether the glass lies inside the redraw. Both Frosted and Liquid styles.
- Text along a glass edge no longer shows mirrored. Both styles' edge lens could bend harder than the distance it covered and fold what's behind over itself.

### Changed
- Liquid glass edge, after Apple's: the bevel bends the blurred material rather than mixing in sharp pixels (which made the blur look as if it stopped short of the edge). The bevel is narrower (8 to 16 px), with a fainter colour split and an even hairline rim all round, brightest at the top left.

## 1.5.0 - 2026-11-18

### Added
- Pin apps to the top of the app drawer: right-click an app, Pin to Top (Unpin from Top to remove). Pinned apps lead the All view, in the order you pinned them.

### Changed
- Liquid glass, tuned against Apple's own panels on a vivid backdrop. Big panels (the drawer, menus) blur about 1.6 times wider, so what's behind turns into soft colour fields. In dark mode they dim what's behind by about a third and keep its colour, so white text no longer sits on bright colour. The dock and top bar stay bright and clear. The glow inside the edge is subtler, leaving a crisp rim.

## 1.4.1 - 2026-11-18

### Changed
- Liquid glass looks closer to Apple's. The curved edge now shows what's behind it sharp, rather than smeared, and bends it by an amount that follows the edge's own width, so large panels no longer streak. Big panels (the drawer, menus) blur more, so text behind them reads as colour instead of ghosts, while the dock and top bar stay clear. The lit rim is brighter, with a soft glow inside the lit edge and a slight shade on the far side, so the edge shows over light windows too.

## 1.4.0 - 2026-11-18

### Added
- Liquid glass, a new glass style (Appearance → Glass → Style). The edge is a curved bevel that refracts what's behind it, with a faint colour split, and a rim lit from the top left with a weaker one opposite. Ported from [liquid-dom](https://github.com/AndrewPrifer/liquid-dom) (MIT) onto Super G's live blur, with no extra redraws. It has one setting, Look, from Clear to Tinted. Frosted stays the default and keeps its settings.

## 1.3.6 - 2026-11-18

### Fixed
- gnome-shell no longer burns a CPU core while the desktop is idle. Glass followed its surfaces with a repeating redraw callback, and GNOME 50's compositor answered it with tens of thousands of empty stage updates a second (up to 98% CPU and half the GPU on a Surface Laptop Studio). Glass now follows on real frames only.

## 1.3.5 - 2026-11-16

### Added
- The app drawer opens with a "New" section: apps installed in the last three days, newest first. App drawer settings "New apps section" and "Days an app counts as new" change that.
- Right-clicking an app in the drawer (or pressing the Menu key on it) opens its menu: open windows, new window, the app's own actions, pin to dock, app details. Choosing anything closes the drawer; clicking outside closes only the menu.

### Changed
- New apps no longer lead the dock by default. The Dock setting "New apps in the dock" turns that back on.

## 1.3.4 - 2026-11-13

### Fixed
- Running-app indicators in every style except "GNOME default" (small dot, dots per window, dashes) showed two marks and sat inside the magnified icon. The hidden default dot was being faded back in beside the drawn one, and the drawn mark grew with the icon. Now there is one mark, at the foot of the dock at its normal size (bottom dock; other sides keep the old placement).

## 1.3.3 - 2026-11-13

### Added
- New apps first: an app that gets installed leads the dock (before pinned and running apps) for three days. Dock settings "New apps first" and "Days a new app stays" change that. Apps already installed when you update don't count as new. Right-clicking a dock icon already opens the app menu (new window, pin or unpin, details).

## 1.3.2 - 2026-11-13

### Changed
- An app asking for attention now jumps three times and rests, instead of ten jumps over a minute. New Dock settings "Attention jumps" and "Attention reminders" change that (existing installs are moved to 3 and 1 once).
- Dock icons and the drag placeholder slide in and out on a softer, slightly quicker curve, so dragging an app along the dock moves the row more smoothly.

## 1.3.1 - 2026-11-09

### Fixed
- Changing the dock's magnification size or reach takes effect right away. It used to wait until the dock was restarted.
- A dock rebuilt while the pointer was on it (a monitor or dock setting change) no longer leaves its magnification running in the background.
- Turning the adaptive top bar's solid mode on and off no longer stacks up a copy of its window watching each time.
- Enter in the drawer's search box with nothing typed no longer opens whichever app is first in the list.
- "Restart them" after a colour change: an app whose quit you cancel (unsaved work) is no longer killed and reopened later, when you close it yourself.
- A built-in engine that fails to stop no longer leaves a dead copy of itself for the others to find.

## 1.3.0 - 2026-11-09

### Added
- A choice of where minimized windows go: into the app's icon, or into their own spot in the dock (as before, the default). Windows > Behaviour > Minimize windows into.

### Fixed
- With minimizing into the dock turned off, windows shrank to nowhere: they had no target until the dock next touched their app. They now fly into their app's icon.
- Windows minimize to where their icon really is after the dock recentres (an app opening or closing), not up to half an icon off.
- With minimizing into the dock turned off, the Trash sat before the Downloads stack. It stays at the end now.
- Test camera: a script that throws no longer leaves its pointer running into shutdown.

## 1.2.9 - 2026-11-04

### Added
- Drag an app from the drawer to the dock to pin it, at the spot you drop it. The drawer steps aside as the drag starts, and the dock comes up if it was hidden. Dropping anywhere else pins nothing.
- A setting to bring the dock up over full-screen windows by pushing the pointer against the screen edge: Dock > Show over full-screen windows. It's off by default.

### Fixed
- Pinning and unpinning no longer breaks the dock. With the pointer on the dock, a newly pinned or moved icon stayed invisible at size zero, and an unpinned one could stay on the row.
- Dragging dock icons to reorder them works again. Those invisible icons threw off the row's count, so drags after the first did nothing.
- The top bar over a full-screen window is now solid in every style, with text in the theme's colour, so it stays readable over whatever the window shows.
- The top bar no longer glitches when it slides out over a full-screen window:
  - It no longer changes the work area on each reveal, which made the dock and maximized windows re-layout.
  - It no longer flashes at the moment a window goes full screen.
  - It no longer slides or hides when the full-screen window is minimized, covered or on another monitor.
  - Windows drawn directly to the screen no longer hide the slide.
  - Floating and islands styles slide all the way out, margins included.
  - Leaving full screen in the middle of a reveal no longer leaves it stuck.
- In drawer search, Right and Down now go to the next result instead of onto the first one, which was already selected. Right moves along the row and on to the next row, Down moves to the row below, or to the next result if there's only one row. Up and Left come back to the search box, and Backspace edits the search from the results.

## 1.2.8 - 2026-11-04

The modules now hold up together through locks, restarts and crashes. Everything here was found by running them all at once.

### Fixed
- A hidden accessibility icon stays hidden. GNOME showed it again at every lock and unlock, and nothing hid it until the setting changed.
- The drawer's All view no longer drops your most-used apps from their categories, which left holes in those rows. Those apps now appear in both places.
- The drawer no longer goes blank (titles with no apps) when an app is installed or removed while it's open.
- Superbar keeps its glass. It repainted its surface at every theme or session change, covering the glass with a nearly solid colour.
- App folders no longer get darker behind them after each lock. Every unlock added another dim layer.
- Switching the dock off and on, or the dock crashing, now restarts what attaches to it (dock motion, windows, glass, drawer) on the new dock, in the right order. Dock motion and the windows module used to stay attached to the old one.
- Switching glass off gives Superbar its own surface back, and the drawer's glass stays live without the glass module.
- If glass crashes, the top bar and dock go solid and stay readable instead of staying transparent.
- Rebuilding the dock no longer leaves dead buttons behind in the drawer. Stopping the drawer used to fail on them and left its style and signals in place.
- Window corners no longer touch windows that are already gone, which caused bursts of errors in the log at every lock and whenever a popup closed. The overview's window shadows no longer get invalid sizes.
- Overview glass no longer places its wallpaper at an invalid position on its first frame.

### Changed
- Changing a setting no longer reloads the shell's whole stylesheet unless its CSS really changed.
- Modules wait for the dock's setup to finish before attaching to it.
- `tests/integration.js` runs all the modules together.

## 1.2.7 - 2026-11-03

### Fixed
- The whole of a magnified dock icon can be clicked. Clicks on the part that rises above the dock used to go through to the window behind it. Right-click and dragging work there too. A dock with too many icons to fit, which has to scroll, keeps the old behaviour.
- A running dot no longer jumps up to the icon after a hover or when its app starts.

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
