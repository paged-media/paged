# ADR 481 — N-channel planes, the ink fold, and a converted document saved in its mode

- **Status:** Accepted, 2026-10-29 (WP5.13, second part; amends 455, 478 and 479; the
  `paged-pixel` PixelFormat amendment 1, interface version 2).
- **Scope:** `paged-pixel`'s `ChannelLayout` (`Lab`, `LabA`, `Planes`, `PIXEL_FORMAT_VERSION`),
  `image-js/src/planes.rs` (ink planes), `layers/fold/ink.rs` (the ink fold), `LayerExt::inks`
  and `LayerStack::{attach_inks, adopt_mode, ink_fold_declines}`, the ink carry in
  `edit_active`, `psd_write.rs` (the layered save in the document's mode and depth),
  `color_mode.rs` (`DocMode::of_psd`, `ModeTransform::rgb_of`), `paged_color::cms::
  moxcms_gray_icc`; the replays `psd_cmyk_photoshop.rs` (the ink fold) and
  `psd_write_photoshop.rs` (Photoshop reopens a converted document).

## Context

ADR 479 made a colour mode a projection: the stack keeps working in RGB and a mode is the set
of colours its pixels may hold. Two things it left open are decided here.

- **A CMYK document did not composite as Photoshop composites it.** Photoshop blends a CMYK
  document's layers channel by channel on the numbers it stores — ink brightness, `1 − ink` —
  and converts the result. The stack blended each layer's RGB conversion; on Photoshop's own
  documents (`cmyk-stacks`) that was 61 levels off on a stack of normal layers at partial
  opacity and 46 to 225 levels off for every other blend mode, which is why the import refused
  CMYK files with blend modes (`cmyk-blend`) or that mix (`cmyk-composite`).
- **The layered save wrote the file's own depth and mode.** A document converted with Image ▸
  Mode reached a file only through Export As, flattened.

`paged-pixel`'s `PixelFormat` is a frozen interface (M0); a layout it does not name needs a
versioned amendment.

## Decision

**PixelFormat amendment 1 (`PIXEL_FORMAT_VERSION` 2).** `ChannelLayout` gains `Lab` and `LabA`
(L*, a*, b* as a PSD stores them) and `Planes { colours, alpha }`: N colour channels and an
alpha carried as ⌈N/3⌉ RGBA planes that share the alpha — three colours a plane
(`ChannelLayout::planes`). Every kernel reads and writes `vec4`, so a plane goes through the
kernels, the plan and the fold an RGB layer goes through; a SEPARABLE step — a blend applied
per channel, a mask, an opacity, a group, a clip, a knockout, the special modes' fill — is
exact per channel whichever plane holds the channel. The codecs' interleaved paths name the new
layouts and refuse them (a raster file stores grey, RGB or CMYK).

**A CMYK layer is two planes of ink brightness** (`planes.rs`): `(C', M', Y', α)` and
`(K', K', K', α)`. A layer read from a CMYK PSD keeps the file's own inks (`InkPlanes`, read
through `layer_plates_rgba8_via` with transforms that hand the ink through,
`LayerStack::attach_inks`), black generation included, while it holds the pixels they were
read with; an edit through `edit_active` keeps them outside its damage and takes the edited
pixels' inks through the profile inside it. Any other layer's inks are its pixels through the
document's profile, cached between composites by identity. The document keeps the file's mode
and profile on open (`DocMode::of_psd`, `adopt_mode`).

**A CMYK document with a profile folds in its inks** (`fold/ink.rs`): the plan the RGB fold
would run is folded twice — once with every plate swapped for its `C'M'Y'` plane, once for
its `K'` plane — through the tiled fold of ADR 480 (GPU, or the CPU fold without a device),
and the folded inks go to the screen through the profile. That is Photoshop's subtractive
compose: on `cmyk-stacks` every separable blend tile agrees with Photoshop's own CMYK composite
within the stated bound (`a_cmyk_document_composites_in_its_inks_as_photoshop_does`), and
`normal-stack`, 61 levels off in RGB, folds within it too. What is not separable composites in
RGB as before, and `ink_fold_declines` names it: Hue, Saturation, Color, Luminosity, Darker
and Lighter Color, Blend If (it reads grey and RGB), an adjustment layer (the chain is RGB), a
style and the direct adjustments.

**The layered save writes the document's mode and depth** (`psd_write.rs`). When the stack's
mode or depth is not the file's, every record is written anew (an unedited record's channels
are in the old encoding): the header's mode, depth and channel count; every layer's and
mask's channels at the new depth; colours as the mode's samples — grey; inks inverted;
L* over the full range and a*, b* about the middle (+128 at 8 bits, 256 per unit about 32768
at 16, measured on Photoshop's own Lab documents) — the profile the values are in (the
document's CMYK profile; Gray Gamma 2.2, a description and a fixed date so the bytes are the
same every time; sRGB; none for Lab), and the "untagged" flag dropped. An adjustment layer or
Blend If in a document converted to another MODE is refused (Photoshop would apply them to the
new channels; the stack evaluates RGB) so the caller flattens and says why; a depth change
alone writes them. A CMYK file's document stays CMYK on open, so its save keeps writing CMYK
as ADR 478 did. Photoshop 27.10 opens each converted file in its new mode and depth with live
layers, and its render, taken to sRGB by Photoshop, agrees with paged's composite:
Photoshop merges each document in its own mode (the probe flattens before it converts: a
layered conversion would blend the converted layers in RGB) and the replay compares
(`photoshop_opens_a_converted_document_in_its_new_mode`, 99th percentile / max ΔE*ab):
Grayscale 1.45 / 2.0, CMYK 0.86 / 1.5 (the ink fold; the RGB fold was 2.6 / 5.3 against
Photoshop's per-layer conversion and is ~11 against its CMYK merge), 16-bit RGB 0.68 / 1.4,
Lab 0.61 / 0.97 at 8 bits and 0.10 / 0.69 at 16 where nothing blends. Over the Lab documents'
blended square Photoshop blends in L*a*b* and the stack in RGB: 10 ΔE under a 70 % Multiply,
12.7 under a 70 % Normal layer (deferred, below).

## Evidence

- `paged-pixel` `format.rs`: the layouts' counts and planes; the codecs refuse them.
- `image-js` `saveback.rs`: a converted document saved in Gray, Lab and 16-bit RGB — header,
  channel ids, samples, profile; the refusals.
- `image-conformance/tests/it/psd_cmyk_photoshop.rs`: the ink fold per `blend-modes` tile and on
  `normal-stack`, against Photoshop's merged CMYK through our transform.
- `image-conformance/tests/it/psd_write_photoshop.rs` with `psd-readback.jsx` re-recorded:
  seven converted documents (Gray, Lab and CMYK at 8 and 16 bits, RGB at 16) opened by
  Photoshop, merged in their mode and rendered to sRGB.

## Consequences

- A CMYK file opened in paged composites as in Photoshop when its blends are separable, and its
  layers keep their exact inks until edited; an undo restores the pixels and the inks are then
  derived through the profile (the journal holds pixels).
- An edit in a CMYK document with a profile is projected into its gamut (ADR 479) — CMYK files
  now open in their mode, so this applies to them too.
- The compute wasm is 8,472,888 bytes (8,440,812 after ADR 480), within the 9 MiB cap.
- The import's `cmyk-blend` and `cmyk-composite` gates are unchanged here: they judge the RGB
  blend the importer's own check still uses; lifting them for separable files is the next step.

## Deferred

- **32-bit float documents.** `paged-raster` decodes EXR and Radiance HDR to f32 on main
  (engine ADR 1038), not yet on this branch; a float document needs `SampleDepth::F32` in the
  layer store with the compiler-guided migration ADR 479 made for 16 bits, a tone-mapped view
  and the float writers. Not started here.
- **Indexed, Duotone and Multichannel.** `Planes` carries them (a Duotone's one to four inks, a
  Multichannel document's N channels), but each needs its own mode transform (a colour table
  and dither; ink curves; spot colours), its PSD encoding and an oracle; none is offered in
  Image ▸ Mode yet.
- **The ink fold for non-separable modes, adjustments and styles** (Photoshop's own rules for
  them in CMYK are unmeasured).
- **Lab and grey layer planes, and blending in them**: a Lab or Grayscale document still keeps
  RGB pixels projected into the mode (ADR 479) and blends them in RGB; Photoshop blends a Lab
  document in L*a*b* (measured 10–13 ΔE apart under a partly opaque layer). `Planes` carries
  L*a*b* the way it carries inks; the Lab plane fold (and its oracle) is the next step. A
  grey document's blend is within 1.5 ΔE of Photoshop's grey blend.

## Related

- [ADR 455](455-pixel-model.md), [ADR 479](479-depth-and-colour-modes.md) — the pixel model and
  the colour modes this extends
- [ADR 478](478-psd-write-depth.md) — the layered save, now in the document's mode and depth
- [ADR 480](480-tiles-past-the-device-and-the-cpu-fold.md) — the tiled and CPU folds the ink
  planes go through


## Amendment, 2026-10-30 (ADR 483)

Of the deferred list: 32-bit float documents, Indexed and Multichannel, and the Lab and grey
plane fold (with Photoshop's Lab chroma rule) are ADR 483, which also lifts the `cmyk-blend`
gate for the separable modes the ink fold composites. Duotone conversion, and the ink fold for
non-separable modes, adjustments and styles, remain open.
