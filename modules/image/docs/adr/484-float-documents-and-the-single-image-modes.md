# ADR 484 — 32-bit float documents, Lab and Grayscale in their own numbers, and the single-image modes

- **Status:** Accepted, 2026-10-30 (WP5.13, third part; amends 455, 478, 479 and 481).
- **Scope:** `image-js/src/pixels.rs` (`SampleDepth::F32` in the store), `layers.rs`
  (`set_depth`, `depth`, `convert_flat`, float plates in the fold), `layers/fold/ink.rs` (the
  plane fold for Grayscale and Lab, Photoshop's Lab chroma rule), `planes.rs`, `color_mode.rs`
  (`ColorMode::{Indexed, Multichannel, Duotone}`, `ModeTable`, `StoredToSrgb`, the palettes, the
  spot inks), `ingest.rs` (the merged composite of every mode and depth, float sources),
  `psd_write.rs` (32-bit layers, the single-image save), `layers_persist.rs` (manifest version 9);
  `paged-psd`'s 32-bit channels, `composite_samples`, `indexed_palette`, `layer_plates_device`
  and `CMYK_INK_FOLD_DECLINES`; `image-codecs`' float hand-off; `paged_color::math::
  linear_to_srgb`; the bundle's Image ▸ Mode rows (32 Bits/Channel, Indexed Color…,
  Multichannel) and the Indexed Color dialog; the probe `color-modes.jsx`.

## Context

ADRs 479–481 left these of WP5.13 open: 32-bit float documents; Lab and Grayscale documents
blended in RGB (Photoshop blends them in their own numbers — 10 to 43 ΔE apart under a blend);
Indexed, Duotone and Multichannel; and the CMYK import's `cmyk-blend` gate, which still judged
the RGB blend the ink fold had replaced.

## Decision

**A 32-bit document holds linear light.** `Pixels` gains `SampleDepth::F32`: native-endian
`f32` RGBA, colour LINEAR and scene-referred (a value may exceed 1), alpha coverage — what a
Photoshop 32-bit document stores. Every conversion between it and the integer depths applies
the sRGB transfer (`at_depth`, `to_rgba8`, `sample16`; `paged_color::math::linear_to_srgb`, the
shared inverse of the EOTF). 8/16 → 32 Bits/Channel decodes; 32 → 8/16 encodes, clamps and
rounds (Photoshop's HDR Toning at exposure 0, gamma 1). The fold uploads a float plate's values
as they are into its f16 tiles (f16 keeps up to 65504, so a value above 1 passes through
unclipped) and reads back floats; an integer plate in a float document (a fill's render, a
stroke's preview) is decoded first. The display view is the encoding at exposure 0, clipped.
An 8-bit tool's edit on a float layer adopts the layer's depth only where it changed a pixel,
so the stroke's rectangle neither quantises nor clips what it did not touch (the same rule now
spares a 16-bit layer's low bytes). A Grayscale float document's grey is the linear luminance
(Y of sRGB's primaries at D50); CMYK and Lab have no float document and refuse 32 bits.
EXR, Radiance HDR and 32-bit PSDs open at 32 bits (the codec adapter hands floats over;
the colour row says "32-bit float, linear light"); the layered save writes 32 bits — `Lr32`
layers, ZIP with Photoshop's byte-plane prediction (each row's floats as four byte planes,
delta-coded over the row's bytes; read from its own files), the composite RAW floats.

**A Grayscale or Lab document folds in its stored numbers.** The plane fold of ADR 481 takes
Grayscale (one plane, `(G, G, G, α)`, the stored grey) and Lab (two planes: `(L*, L*, L*, α)`
and `(a*, b*, b*, α)`, normalised as the file stores them). Photoshop blends a Lab document's
L* with the layer's mode and its a* and b* by a rule of its own, read from its documents:
Multiply and Screen blend the chroma as Overlay does; Linear Burn and Linear Dodge add the two
offsets from the middle (Linear Light over a source halved about the middle); Color and
Luminosity take the chroma or the L* from the source. So the chroma plane folds with those
blends while the L* plane folds with the layer's own. Hue and Saturation (L*C*h) still fold the
document in RGB, and `ink_fold_declines` says so. Grayscale and Lab PSDs now import their
layers (`layer_plates_device`, through the file's grey profile or CIE Lab — the transform the
merged composite takes, `StoredToSrgb`), at 16 bits when the file is.

**Indexed and Multichannel are single-image modes, Duotone is read as its grey.** A `DocMode`
carries a `ModeTable`: an Indexed document's colour table, a Multichannel document's channels
(name and display ink), a Duotone document's specification verbatim. Image ▸ Mode ▸ Indexed
Color… (Exact — the image's own colours, at most 256 —, Web, or Local (adaptive): median cut)
and Multichannel (from RGB: Cyan, Magenta and Yellow inks holding the red, green and blue
values, which change no colour; from grey: one Black ink) flatten the image over white into
the mode as one undo step; Indexed is 8 bits, every pixel the table's nearest colour, and an
edit stays in the table. These documents open from a PSD as their composite with their table
and save as the one image Photoshop keeps — the table (Color Mode Data, resources 1046/1047) or
the channels' names (1006, 1045) and display colours (1077), no layer records. A Duotone file
opens as its grey (the format leaves the specification undocumented and tells readers to do
so), its layers import as grey, and its save keeps the specification; Image ▸ Mode offers no
Duotone conversion: Photoshop refuses every Convert Mode descriptor a script can build (the
class alone, an empty or a monotone object), so no duotone can be recorded, and a specification
cannot be written without one. The table is persisted (layer manifest version 9; the
object model's TypeScript codec reads and writes it byte for byte).

**Hue, Saturation, Color and Luminosity fold on the ink planes.** Photoshop applies their
formulas to a CMYK document's inks as they are: to `C'M'Y'` as if it were RGB, and to `K'`, a
grey, where they keep the backdrop's black (Luminosity takes the source's). The compose kernels
do exactly that unchanged on the two ink planes, so the ink fold composites the four modes too
(`cmyk-stacks/blend-modes`: within 0.68 ΔE00 at the 95th percentile and 3 levels at most of
Photoshop's CMYK composite, where blending the RGB conversions was 11–20 off). Darker and Lighter
Color are not measured in CMYK and still fold in RGB, saying so (`ink_fold_declines`).

**The CMYK import gate follows the ink fold.** `cmyk-blend` now declines only the blends the
ink fold cannot composite (Darker and Lighter Color: `CMYK_INK_FOLD_DECLINES`); every other mode
is composited in inks and the per-file check against the merged composite
(`cmyk_flatten_agrees`) judges it. `normal-stack` — declined by that check when it blended in
RGB (61 levels) — passes through the ink fold at 2 levels, at 8 and 16 bits; `blend-modes`, one
tile per mode, imports with no blocker.

## Evidence

`color-modes.jsx` (Photoshop 27.10) records, with real merged data: layered Lab and Grayscale
documents at 8 and 16 bits and a 32-bit one, one feathered layer per blend mode over a
three-colour background (the modes a mode does not offer stay Normal and say so); the sweep
converted 16 → 32 and 8 → 32; Indexed with the Web palette and with an Exact one, each with
Photoshop's sRGB render; Multichannel from RGB. `color_modes_photoshop.rs` replays them:

- Lab: every judged tile within 2.7 ΔE*ab (max) and 1.9 (p95) at 8 bits, 0.5 / 0.25 at 16, where
  the RGB fold was 8.2–43 at p95; Grayscale within 1.5 / 1.1 at 8 bits and 0.2 / 0.1 at 16
  (the RGB fold: up to 6.7). The 8-bit Lab maximum is one pixel's worst, and an 8-bit a* or b*
  step is 1 ΔE*ab on its own: the GPU fold (Metal) measures 2.11 at worst (Soft Light), the CPU
  fold a runner without a GPU takes 2.47 (p95 1.81), the two folds rounding a few edge pixels
  to neighbouring steps. The bound (2.7, first 2.4) covers both with a quarter of a step to
  spare; the p95 bound, which the improvement over the RGB fold rests on, is unchanged.
- 32 bits: every offered separable tile within 0.001 of Photoshop's linear values; 16 → 32 is
  the sRGB decode within 8 · 10⁻⁵; 8 → 32 stores decoded 8-bit levels, ours within a level
  (Photoshop rounds its own 15-bit samples).
- Indexed: our nearest Web colour is Photoshop's on all 16384 pixels; both documents decode to
  Photoshop's render exactly. Multichannel: the channels are the RGB values and the decode is
  the image.
- `mode-readback.jsx` has Photoshop open what the save writes: the 32-bit document with both
  layers live (its merge within 0.0014 of our fold, linear), the Indexed one (every pixel the
  table colour of ours) and the Multichannel one (Cyan, Magenta, Yellow; every sample ours).
  Without the HDR Color Mode Data Photoshop writes for a 32-bit document (`hdrt`, `hdra`) it
  refuses the file, so the save writes Photoshop's defaults when the document had none.
- `psd_cmyk_photoshop.rs`: every `blend-modes` tile through the ink fold (Hue 3 levels / 0.68
  ΔE00 p95, Saturation 1 / 0.66, Color 3 / 0.68, Luminosity 1 / 0.66) and no blocker on it;
  Darker and Lighter Color declined by name; `normal-stack`(-16) and `opaque-stack` through the
  ink fold.
- `image-js`: `float_tests.rs` (linear blend, values above 1 through the fold, the 32-bit
  conversion's undo step, an 8-bit stroke keeping HDR pixels, a float grey, persistence),
  `saveback.rs` (32-bit save and reopen, Indexed and Multichannel save and reopen), `pixels.rs`;
  `paged-psd`: 32-bit prediction both ways, `composite_samples` per mode.

## Consequences

- A float source keeps its highlights through layers, the fold, the save and persistence.
- **Recorded defects.** Linear Dodge in a 32-bit document clips its sum at 1 (the compose
  kernels' formula; Photoshop's 32-bit Add does not — 0.73 off on the probe's tile); Hue, Color
  and Luminosity in a 32-bit document are 0.06–0.22 off (Photoshop measures luminosity on
  linear values otherwise); the panel's adjustment chain on a float image works on linear
  values (Photoshop's 32-bit adjustments do too, but its set is narrower); a merged composite
  the layered save writes is straight colour, not matted against white (as before at every
  depth). The f16 working tiles give a float document about 11 bits of precision per kernel.
- A Multichannel document is displayed with its inks' display colours multiplied (the spot
  model at 0 % solidity); Photoshop shows a CMYK ink through the working CMYK profile, so a
  Multichannel document made in Photoshop from CMYK looks more saturated here.
- The Lab chroma rule is read from Photoshop's results for the modes it offers in Lab; the
  modes it does not offer (Darken, Lighten, Color Burn and Dodge, Difference, Exclusion) fold
  on the raw numbers.

## Deferred

- Duotone conversion and its curves dialog (no scriptable oracle; the specification is
  undocumented).
- An unclamped Add (and Photoshop's 32-bit non-separable rules) for float documents.
- Hue and Saturation in Lab (L*C*h steps); Darker and Lighter Color, Blend If, adjustments and
  styles in CMYK's inks; adjustments and styles in a mode's own numbers.
- Residency tier 3.

## Related

- [ADR 479](479-depth-and-colour-modes.md), [ADR 481](481-n-channel-planes-and-the-ink-fold.md)
  — the depth, the modes and the ink fold this extends
- [ADR 478](478-psd-write-depth.md) — the layered save, now at 32 bits and in the single-image modes
- [ADR 455](455-pixel-model.md) — the pixel model, now with a float store
