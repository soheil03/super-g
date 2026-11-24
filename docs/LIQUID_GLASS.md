# Liquid glass: Apple's model, the recipe, and where ours differs

Research from November 2026, against macOS 27 (Golden Gate) and the work of
people who took Apple's glass apart. This is the reference for `lib/glass.js`:
read it before touching the glass shader.

Every earlier pass (1.10 to 1.14) tuned constants on our own model and checked
them against a few screenshots. The model itself is what differs from Apple's,
so the numbers kept missing. Apple's real shader is now known; build on it.

## How Apple builds it

Liquid Glass is Core Animation, not SwiftUI magic. A glass view is a
`CABackdropLayer` running the private `glassBackground` filter, shaped by a
signed distance field (`CASDFLayer`, `CASDFElementLayer`), with the rim light
drawn by sibling SDF layers (`CASDFGlassHighlightEffect`, or
`CASDFKeyFillHighlightEffect` for AppKit's `NSGlassEffectView`) through a
`vibrantColorMatrix`. The filter's Metal shader (`glass_background_lpf` in
QuartzCore's `default.metallib`) has been transcribed, and the inputs AppKit
sets read back from a live view on macOS 26.6. One shader serves every glass;
only the inputs change (light, dark, clear, size, focused).

S below is the glass's short side in points. All tones are sRGB values (0-1),
as on screen.

### 1. Capture and frost

- The backdrop is captured at 1/4 resolution (1/2 for clear glass), so nothing
  sharper than that ever reaches the glass.
- Frost is a mip-level blur. Regular glass on 26.6: 6.4 pt for S ≥ 160, down
  to about 2 pt for small controls. macOS 27 frosts more and ties it to the
  Liquid Glass slider: about 4.5 / 6.9 / 18.7 pt at clear / middle / tinted for
  a toolbar, scaled with S (clear glass: 0.35 / 1.3 / 16.4 pt).
- The frost halves towards the edge: full from S/2 inwards, 50% at the rim. The
  rim is never sharp.

### 2. The edge lens

- A flat face with a rounded bevel. Only the bevel bends light.
- Bevel width 20 pt, displacement 60 pt inwards at the outermost pixel, falling
  off as a quarter circle: offset = 60 × (1 − √(s(2 − s))), s = depth / 20.
- Displacement three times the bevel means the bevel shows a **mirrored,
  compressed** copy of what lies 17-60 pt inside. Apple's glass mirrors; it is
  what makes the edge read as thick glass. The half-strength frost keeps the
  mirrored copy soft, so text never reads backwards.
- Small glass shrinks the lens: bevel at most S/4, never sampling past the
  centre line.
- The outermost point mixes in 30% of a sample from 0.2 S *outside* the glass.
- No colour split. Regular and clear glass on 27 show no dispersion.

### 3. Tone: a luma remap into a fixed band

The face colour is `set_ycc_composite(black, white, sat, fill)`:

    out = (1 − fill.a) × (black + (white − black) × Y + sat × chroma) + fill

Y is the backdrop's luma and chroma its colour around Y. Brightness is
squeezed into a band, colour scales by (1 − fill.a) × sat, and a **neutral**
fill (white in light, black in dark) sits over it. It is monotonic: brighter
behind always means brighter glass.

| Glass | black | white | sat | fill | Band (black → white) | Chroma |
|---|---|---|---|---|---|---|
| Light, regular | 0.50 | 1.03 | 1 | white 0.40 | 0.70 → 1.0 | × 0.6 |
| Light, tinted end | 0.25 | 1.03 | 2 | white 0.80 | 0.85 → 1.0 | × 0.4 |
| Light, small control (S < 64) | 0.85 | 1.03 | 1 | white 0.25 | 0.89 → 1.0 | × 0.75 |
| Dark, regular (26.6) | 0.20 | 0.60 | 1 | black 0.40 | 0.12 → 0.36 | × 0.6 |
| Dark, tinted end | 0.20 | 0.75 | 2 | black 0.60 | 0.08 → 0.38 | × 0.8 |
| Dark, regular (27.2, measured) | | | | | 0.08 → 0.49 | fixed factor |
| Clear | 0.075 | 1.15 | 1.06 | none | 0.075 → 1.0+ | × 1.06 |

- iOS and macOS 27 made dark glass lighter (white maps to about 0.49, was
  0.36) and the wash more opaque towards the tinted end.
- The remap comes before the blur.
- macOS keeps one material whatever is behind (flat greys 0-255 all follow the
  same mapping); only iOS flips small controls between light and dark.
- `tintColor` on macOS carries no hue on its own, only an amount (measured on
  26.6). Tint is for prominent buttons.

### 4. Bleed: light from around the glass

A second, very blurred sample (radius about 0.56 S, at most about 128 pt),
pulled outwards by up to 0.35 S near the edge so it carries what surrounds the
glass, then:

- light: toned into 0.9 → 1.0 with saturation 1.2, mixed in by Y⁴ × 0.5 (only
  where the face is already bright);
- dark: toned into 0 → 0.5, mixed in by (1 − Y)⁴ × 0.8;
- faded out under S = 64, full from S = 160.

This is why Apple's glass looks lit by its surroundings instead of looking like
a filter: soft colour from nearby windows and wallpaper drifts into it.

### 5. Rim light (glint)

- A band 1 pt wide (1.2 pt on iOS 27) just inside the edge, with a curved
  falloff. Strength about 0.5 where it faces the light.
- Two equal lobes with a cosine falloff (180° spread), so the light wraps round
  the corners and fades towards the unlit walls. SwiftUI glass lights top and
  bottom; AppKit's `NSGlassEffectView` uses key and fill lights at the bottom
  right and top left (160° spread each): about 0.32 along every straight edge,
  0.5 at those two corners, none at the other two.
- It takes the colour of what's behind (glass over blue glints blue), and on
  27 it is brighter, reaching into HDR headroom where the display has it.
- Under SDR the face is held at 0.97 while the outer 1-2 pt are not, so the rim
  sits a touch above the face.

### 6. Dark contour (new in 27)

A 0.75-1 pt line just outside the silhouette: the unblurred backdrop at about
half its brightness (measured 50% top and bottom, 36% at the sides), strongest
where the glint fades. On light and dark glass alike; the slider's tinted end
makes it stronger. Over a near-black backdrop (21/255) the rim measured 14 and
10 against a face of 34.

### 7. Shadow

- Big glass (S ≥ 160): 25% at most, offset 8 pt down, an erf falloff over about
  ±48 pt, and *vibrant*: its colour is the blurred backdrop at × 0.88 with
  saturation 1.8. It tints more than it darkens.
- Small glass: up to 50%, plainer and darker.
- In-window glass on 27 (toolbars, `.glass` buttons) casts none.

### 8. What Apple's glass doesn't have

No grain (only a 1/255 dither), no colour split, no sheen gradient, no palette
tint, no local thickening where the backdrop is busy. Legibility comes from the
band alone.

### Shape

Continuous corners fit an exponent-3 superellipse at radius × 1.375 (0.3 pt
RMS against `CASDFElementLayer`). macOS 27 gave every window the same, smaller
radius.

## The recipe

Per pixel, in this order:

1. **Distance and normal** from the squircle SDF (exponent 3, radius × 1.375).
2. **Lens**: bevel h = min(20, S/4) pt, offset = 3h × (1 − √(s(2 − s))) along
   the inward normal, never past the centre line. No dispersion.
3. **Frost**: sample the blurred copy at that point. Blur radius for the
   surface: chrome (dock, top bar) 4-5 pt; panels 6-10 pt; up to 18 pt at the
   tinted end of the clarity slider. Halve it linearly from depth S/2 to the rim.
4. **Tone** with the band for the surface, monotonic, neutral fill:
   - Light surfaces: 0.70 → 1.0, chroma × 0.6 (tinted end 0.85 → 1.0, × 0.4).
   - Dark surfaces: 0.08 → 0.49, chroma × 0.6-0.8.
   - Clear end: the backdrop nearly as is (0.075 → 1.0, × 1.06).
5. **Bleed**: mix the wide, outward-pulled, toned sample in by Y⁴ × 0.5
   (light) or (1 − Y)⁴ × 0.8 (dark), scaled by clamp((S − 64) / 96).
6. **Glint**: a 1-1.2 pt band, two equal cosine lobes, strength 0.5, screen or
   plus-lighter so it takes the backdrop's colour. Face × 0.97, rim × 1.
7. **Contour**: 0.75 pt outside the edge, the unblurred backdrop × 0.5 (× 0.36
   on the side walls).
8. **Shadow**: hollow, vibrant on big glass (≤ 25%), plainer on small glass.

Light appearance means light glass with dark text, dark appearance dark glass
with light text. Dark panels in light mode are not Apple's (macOS 27 panels
follow the appearance); over a white window dark glass can only be mid-grey
(about 0.49), which still holds white text at about 4:1.

## Where ours differed (1.14.1)

1.15.0 rebuilt the liquid path on this model and closes these gaps; the list
stays as the record of why. Kept from ours: the clarity slider (0 is a clear
end between Apple's Clear and regular, 0.3 is Apple's regular) and the
`wallpaper` tone that puts dark glass under the light theme.

Ranked by how much each costs the look. Line numbers are in
`extension/super-g@soheil/lib/glass.js`.

1. **The dark band inverts the backdrop.** After brightness 0.62 (line 1067)
   and calm 0.75 (lines 194-218, `dark_band` at line 200), dark panels map a
   black backdrop to about 0.03, a light grey one up to 0.41, and then *down*
   to 0.23 for a white window. A window behind a dark panel shows as a darker
   hole with lighter edges, like a negative. Apple's band is a straight line,
   0.08 → 0.49.
2. **Colour is boosted, Apple cuts it.** Saturation 1.12 at clarity 0 (line
   1036), × 1.3 more on chrome (line 966), and a gain of 1.375 in dark calm
   (line 211): chroma ends at about 1.3 times the backdrop's on the dock and
   the bar and about 0.95 on dark panels, where Apple keeps 0.6. Over a
   colourful wallpaper that reads as neon.
3. **The dock and the bar get no band at all.** Calm is 0.65 × k and k is 0 at
   their size (lines 991, 1003-1004), so they are the backdrop at × 0.9 and
   follow every bright and dark patch behind them. Apple's chrome still goes
   through a band.
4. **The edge lens is a tenth of Apple's and the wrong shape.** A 6-12 px bevel
   pulling at most 5.5 px (lines 69-71, 121, 137), kept monotonic on purpose,
   against 20 pt and 60 pt, mirrored. The lens is the trait that defines the
   material, and ours barely shows. Our bevel also shows a sharper copy
   (`clear_rgb`, `LIQ_CLEAR`, lines 149-150, 230) where Apple's stays half
   frosted, which draws a crisp ring instead of a soft lens.
5. **No bleed.** Nothing brings in the light around the glass; the only outside
   sample is an 18 px reflection on the rim of dark glass (lines 172-175). This
   is most of what "elegant" means in Apple's version.
6. **The contrast guard makes patches.** Where the backdrop fights the text
   colour, the tint thickens locally up to 0.8 (lines 222-223): opaque blotches
   that follow what's behind. Apple has no such term; the band does the job.
7. **Palette tint instead of a neutral fill.** The face mixes towards the
   palette's window colour (lines 223, 230, floor at line 987), a blue-violet
   cast in Catppuccin. Apple's fill is white or black.
8. **The glint is a bottom line.** Light from straight above with pow-4 lobes,
   the bottom four times the top, nothing on the sides, and × 0.4 on chrome
   (lines 75-76, 162, 966). Apple's lobes are equal, wrap round the corners
   with a cosine, and are brighter.
9. **The dark contour is a trace, on light glass only.** An 8% multiply on the
   outermost pixel (lines 79, 165, 240), where 27 draws the unblurred backdrop
   at half brightness, 0.75 pt outside, on light and dark glass.
10. **The shadow is heavy and black.** The standard surface shadow reaches about
    0.5 in blue-black (`lib/softShadow.js`, `SURFACE_LAYERS`); Apple's big glass
    stays under 0.25 and takes the backdrop's colour.
11. **Extras Apple doesn't have:** dispersion 0.06 (lines 72, 142-145), a sheen
    gradient under the top (`LIQ_SHEEN`, lines 236-238) and grain 0.012, about
    3/255 (line 1074), which shows as noise through the lightly blurred dock.
12. **Chrome is too sharp.** About 3 px of blur on the dock at clarity 0, from a
    full-resolution copy, against Apple's 4.5 pt from a quarter-resolution one:
    wallpaper detail shows through and competes with the icons.
13. **Corner fit.** Exponent 2 + 4 × smoothing at radius × exponent / 2 (lines
    955-956) is not the measured exponent 3 at × 1.375.

What already matches: live capture with the partial-redraw guard, the dual
Kawase blur, the squircle SDF, the hollow analytic shadow, a light calm band of
about 0.56 → 0.99 on panels (Apple's is 0.70 → 1.0), a screen-blended rim, and a
single clarity slider like 27's.

What GNOME can't match: HDR headroom for the glint (Mutter's HDR path is not
ours to use), and vibrant text and icons drawn with plus-lighter or plus-darker
over the glass.

## What other implementations do

- **spacedouut/liquid-glass** (WebGL2): a line-for-line transcription of
  `glass_background_lpf`, with AppKit's inputs read off a live view and swept
  over sizes. The closest thing to Apple's own code; the source of sections
  1-7. It has no licence and transcribes Apple's binary, so we reimplement the
  model and never copy its code.
- **whynotmake-it/liquid_glass_renderer** (Flutter, fitted to iOS 27
  captures): the same bevel (20 / 60, quarter circle, mirrored), frost tied to
  the slider and scaled by S, a 1.2 pt glint that recolours rather than adds
  white, a 0.75 pt dark contour outside the silhouette, a faint inner bevel
  shadow, no dispersion.
- **A macOS 27.2 web port** (jarvis, measured against a live
  `NSGlassEffectView` over 21 flat colours): luma through a curve before the
  blur, chroma by a fixed factor, a 1 px rim of darkened unblurred backdrop;
  matched Apple within 1-3 levels.
- **Kyant's Backdrop** (Android): colour filter, then blur, then lens; a white
  surface at 50% for readability rather than darkening; the highlight lights
  both the facing and the far wall.
- **kube.io** (CSS and SVG): Snell refraction through a convex squircle
  profile, precomputed once along one radius; the rim lit by normal against a
  light angle.
- **Liquid Glass Studio**: the glare is the backdrop itself made lighter and
  more saturated, never plain white.
- **Windows Acrylic**: blur, a luminosity layer, a tint, then noise; light and
  dark are a luminosity choice.

What they share: copy Apple's structure (remap, bevel, glint, contour) first,
then fit numbers to captures. And measure in a key window: one port fitted to
inactive windows, which Apple renders flat and frosted, and had to throw the
numbers away.

## Sources

- QuartzCore shader transcription and AppKit inputs: <https://github.com/spacedouut/liquid-glass>
  (README, `app.js` `QC_FS` and `qcRecipe`)
- Layer structure: <https://github.com/AlexStrNik/ShatteredGlass>; Gui Rambo,
  "Inside Liquid Glass" (Swift Connection 2025)
- iOS 27 fit: <https://pub.dev/packages/liquid_glass_renderer>
- macOS 27.2 measurements: <https://github.com/benjaminbayerpriv-cmd/jarvis/pull/121>
- macOS 27 variants and inactive-window flattening: <https://github.com/hoyeonpark1221/liquidglasseffects/blob/main/Docs/Internals.md>,
  <https://github.com/egoist/mygo/pull/136>
- macOS 27 changes: <https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/>
- Refraction model: <https://kube.io/blog/liquid-glass-css-svg/>
