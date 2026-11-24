# Liquid glass recipe

How Super G's liquid glass is meant to look, and why. Measured against Apple's
own (macOS 27 dock and a Control Center slider over a split light/dark
backdrop, November 2026) and checked against the open implementations that
come closest to it. `lib/glass.js` follows this; change both together.

## What Apple does

From Apple's "Meet Liquid Glass" session (WWDC25) and the 27.0 releases:

- Lensing, not frosting, defines the material: it bends and concentrates the
  light behind it, strongest at the edge. Blur is light.
- Regular glass adapts continuously to what's behind. Small elements (bars,
  tab bars, controls) flip between light and dark with their glyphs; big ones
  (menus, sidebars) follow the appearance and never flip, since a flip that
  large distracts.
- Clear glass stays transparent and needs a dimming layer only under symbols
  that must read on bright media.
- Highlights come from light sources in an environment: they follow the
  shape's geometry, on the side facing the light and, fainter, the far side.
- Shadows grow over text and busy content, and fade over solid light
  backgrounds.
- Bigger glass reads as thicker: deeper shadow, more lensing, softer scatter.
- 27.0 replaced the clear/tinted switch with a slider, made refraction more
  uniform, and added a dark contact edge (rebuilt as "dark edges" in Liquid
  Glass Studio).

## What the pixels say

Luma (0-1) inside and outside the glass on the reference screenshots:

| Backdrop | Outside | Inside | Change |
|---|---|---|---|
| Dark purple (slider) | 0.15 | 0.23 | +0.08 |
| Dark wallpaper (dock) | 0.23 | 0.31-0.35 | +0.1 |
| Light lavender (slider) | 0.69-0.76 | 0.69-0.76 | about none |

- The glass never darkens. It adds about a tenth of white: `mix(b, white, 0.1)`
  gives 0.15 → 0.235 and 0.70 → 0.73, matching both.
- Colour survives and gets richer (vibrancy). The backdrop's texture is still
  visible through the dock: a blur of a few pixels, not a frost.
- The rim is a one-point line of near-white tinted by the backdrop (warm over
  orange, lilac over purple), at the top and bottom alike and somewhat weaker
  on the sides. Below it, a glow falls off over about five points.
- Just outside the rim, a faint darker contact line separates the glass from
  a light backdrop.

## What other implementations do

- Kyant's Backdrop (Android/Compose, the most faithful port): colour filter,
  then blur, then lens, in that order. Vibrancy is saturation × 1.5, blur 4 dp,
  lens height 16 dp with amount 32 dp on a circular profile. Readability comes
  from a white surface at 50% on top, not from darkening. The highlight is a
  0.5 dp stroke whose strength is `|dot(normal, light)|^falloff`, so it lights
  both the facing and the far side.
- Liquid Glass Studio (WebGL/WebGPU): the glare is the backdrop itself made
  lighter and more saturated in LCH, not white. Fresnel blends towards white
  near the edge, and the iOS 27 dark edge multiplies a thin band at the
  silhouette.
- Windows Acrylic: blur, then a luminosity layer, then a tint, then noise.
  Light versus dark is a luminosity choice, not a black overlay.

## The recipe

Per pixel, in this order:

1. **Sample.** The lens pulls from further in across the bevel; it must stay
   monotonic. A slight RGB split goes on the bevel.
2. **Blur lightly.** About 3 px on chrome (dock, top bar), about 11 px on
   panels that carry text.
3. **Vibrancy.** Saturation × 1.3-1.5 around luma, with chroma scaled to fit,
   never clipped.
4. **Tone.** Pick it by role, and never dim light content in light mode:
   - Chrome, either mode: the backdrop plus a light veil, `mix(b, white, ~0.1)`.
     No brightness cut, and no contrast guard (no text of a fixed colour sits
     on it; the top bar picks its text per box).
   - Text panels, light: a white veil strong enough for dark text. Luma is
     lifted to about 0.75 or more, and hue is kept.
   - Text panels, dark: the backdrop dimmed, with a white window pushed to
     about 0.3 at most, under white text.
5. **Rim.** A one-device-pixel line, screen-blended, so it takes the
   backdrop's colour. On chrome it is strong all round (about 0.75 top and
   bottom, 0.5 on the sides); on big panels it is subtle. A short glow falls
   off under it.
6. **Dark edge.** A faint multiply at the outermost pixel on light glass.
7. **Shadow.** Soft and wide, heavier over busy content.

Light appearance gives light glass with dark text. "Dark panels in light
mode" (`glass-tone` wallpaper) is still a choice, but over a white window it
can only ever be grey.
