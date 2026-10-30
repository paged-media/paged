# ADR 479 — 16 bits end to end, colour modes as a projection, and the proof view

- **Status:** Accepted, 2026-10-28 (WP5.13, first part; amends 455). The second part — 32-bit
  float, tiled compositing past the texture limit, and N-channel planes for CMYK, Indexed,
  Duotone and Multichannel — is not decided here (see Deferred).
- **Scope:** `image-js/src/pixels.rs` (depth conversions), `layers.rs` and `layers/fold.rs`
  (the document's depth, the fold at each plate's depth, edits at another depth, the colour
  mode), `layers_persist.rs` (manifest version 6), `ingest.rs` (`adjust_px`),
  `color_mode.rs`, the `image_bits` / `image_set_bits` / `image_mode` / `image_set_mode` /
  `view_set_proof` / `ingest_rgba16` / `image_samples16` wasm doors; `paged-psd`'s 16-bit
  layer plates (`LayerPlate::rgba16`); the bundle's `mode-engine.ts`, `mode-contrib.ts`, the
  decode worker's 16-bit hand-off and Image ▸ Mode / Image ▸ Proof; the Photoshop probe
  `mode-conversions.jsx`.

## Context

ADR 455 recorded that 16 bits were carried by decode, the single-kernel door and
`LayerStack::edit_active`, and that everything else read four bytes per pixel: `layers_open`
refused a 16-bit image outright (the buffer was twice the length it expected), the panel's
adjustment chain handed 16-bit bytes to an 8-bit source and failed, the fold read a 16-bit plate's
first canvas of bytes as RGBA8, the composite came back as 8 bits, the decode worker narrowed,
and a 16-bit PSD's layers were reduced to their high bytes at import. Colour modes were a
non-goal; the master plan brought CMYK and Lab editing into scope (gaps I-2 … I-9).

## Decision

**The document's depth is its layers' depth.** `LayerStack::depth()` is 16 bits when any layer
holds 16-bit pixels. `layers_open` opens the image at its own depth (`from_image_px`); a new
layer is created at the document's depth; a 16-bit RGB PSD's layers are imported at 16 bits
(`paged-psd` decodes each channel's samples beside the 8-bit view; a 16-bit RLE channel, a CMYK
document and an adjustment stay as before, and `depth_reduced` says when anything was reduced).
The decode worker hands a 16-bit source over as its samples (`image_samples16` →
`ingest_rgba16`), so the off-thread decode keeps what the main-thread one keeps.

**The fold takes each plate at its own depth and reads back at the document's.** Plates,
steps and the fold's caches hold `Pixels` (bytes and depth), so the compiler found every place
that read a plate's bytes. A 16-bit plate uploads its samples (`v / 65535`) into the
`rgba16float` working tiles; the readback is 16-bit for a 16-bit document (`composite_px`) and
8-bit otherwise, and `composite` stays the 8-bit display view (the high bytes). The windowed
refold of a brush sample is depth-generic and stays byte-equal to the full fold. Mixed depths
fold together. The working tiles are f16 (ADR 452/455): a 16-bit document keeps about 11 bits
in the highlights through a kernel — measured on a 16384-level ramp under a Levels gamma of 2.2,
2826 distinct levels, against Photoshop's 16259 at 16 bits and 184 at 8 bits.

**An edit at another depth adopts the layer's depth inside its damage.** The tools that paint
8-bit (the brush engine, fills, retouching) used to be refused on a 16-bit layer ("depths must
match"). `edit_active` now converts the edit to the layer's depth inside its damage rectangle and
keeps the layer's own samples everywhere else, so the journal stays in one geometry, undo
restores full 16-bit samples, and only the touched pixels carry the tool's precision.

**Image ▸ Mode ▸ 8/16 Bits/Channel converts every layer as one undo step**
(`LayerStack::set_depth`): widening is exact (`v << 8 | v`), narrowing rounds to the nearest
level (`Pixels::at_depth`), where the 8-bit display view keeps the high byte. Like a canvas
operation, older pixel steps are reachable only by undoing the conversion first. The panel's
adjustment chain and Bake run at f16 on a 16-bit image (`ingest::adjust_px`) and land at 16
bits; the Levels replay agrees with Photoshop's 16-bit result within 0.16 of an 8-bit level above
15 % input.

**A colour mode is a projection, not a channel layout.** The stack keeps working in RGB. A
document's mode (`color_mode::DocMode`: RGB, Grayscale, CMYK with its profile, Lab) is the set
of colours its pixels may hold: converting puts every layer's pixels through the mode's space
and back — sRGB → Gray Gamma 2.2, → the CMYK profile, or → CIE Lab (D50), stored at the
document's depth, → sRGB — through `paged_color::cms` (lcms2 native, moxcms wasm32), relative
colorimetric with black-point compensation (the Color Settings default). A pixel edit lands
projected the same way inside its damage, so a greyscale document stays grey and a CMYK one
inside its press gamut. The mode is one undo step, in every snapshot, and persisted (layer
manifest version 6). CMYK converts through the profile the session holds (the one chosen for
Export As, or a CMYK document's own); without one the plain ink formula changes no colour, and
the status says so. Measured against Photoshop converting the same stimulus and back to sRGB:
Grayscale and 16-bit Lab within 0.05 of a level; CMYK (Coated FOGRA39, the profile read from
Photoshop's own PSD) and 8-bit Lab within 1.8 ΔE at the 99th percentile and 2.65 ΔE at most, the
largest per-channel gaps (21 and 35 levels) on sRGB colours outside the press gamut or where an
8-bit Lab round trip is ill-conditioned (`mode_conversions_photoshop.rs`).

**Proof Colors and Gamut Warning are a display view.** `view_set_proof` adds a soft proof
(`paged_color::cms::SoftProof`: source → output under the proof's rendering → display) and a
gamut warning (`GamutCheck`, ΔE*ab 1976 above 3 after the round trip, painted Photoshop's default
grey) to the view `view_apply` already applies to what the frame shows; the document is never
touched. The output is Gray Gamma 2.2 or a CMYK profile (the session's, else the document's own;
refused without one).

## Evidence

- `image-js/src/layers/depth_tests.rs`: a 16-bit image opens a 16-bit stack whose composite is the
  image; a two-layer 16-bit fold keeps more than 900 of 1024 levels; the windowed refold equals the
  full fold at 16 bits; an 8-bit edit lands inside its damage only and undo restores the low bytes;
  Mode 8 ↔ 16 bits is one undo step and rounds; a bounded layer keeps its bounds; a bake keeps 16
  bits; Grayscale is one undo step and an edit lands grey; the mode is persisted, and a version-5
  manifest opens as RGB.
- `image-js/src/color_mode.rs`: the projections (neutral grey, the Lab round trip, a region, 16
  bits, the CMYK profile's clipping) and the proof view.
- `image-conformance/tests/it/mode_conversions_photoshop.rs` replays
  `fixtures/photoshop/mode-conversions` (Photoshop 27.10): the mode conversions at 8 and 16 bits and
  a Levels gamma on the `deep-ramp` stimulus at both depths.
- `image-js/tests/it/ingest_16bit.rs` and `image-conformance/tests/it/prop_layer_cache.rs` (the
  resident fold against the reference fold, now including 16-bit stacks).
- The bundle: `glue/test/mode.spec.ts`, `decode-pool.spec.ts`; the menu rows in the editor's
  `menus-image.spec.ts`.

## Consequences

- A 16-bit image works through layers, adjustments, Bake, the fold, undo, persistence, the layered
  PSD save (ADR 478 already wrote `Lr16`) and the 16-bit exporters without being narrowed.
- The 8-bit display (`composite`, the tiles, the scene image) is unchanged.
- **Recorded defect, not of depth:** Photoshop's Levels gamma bends the shadows below about 15 %
  input (at 0.24 % input it answers 732 where x^(1/2.2) is 4256, at 8 bits too); `adjust.levels`
  draws the plain power curve. The replay holds the toe's size (20.8 levels at most) instead of
  asserting it away.
- The layered PSD save keeps the file's own depth and mode; a conversion is exported through
  Export As (gray, CMYK, 16 bits).
- The compute wasm grew from 8,311,571 bytes (main before this record) to 8,393,037 (+81 KB: the
  mode transforms, the soft proof and the gamut check reach moxcms' Lab and grey paths), past the
  manifest's 8 MiB `maxBytes`; the cap is raised to 9 MiB.

## Deferred (the next sub-package)

- **N-channel planes and subtractive compose.** A CMYK document whose layers are ink planes and
  whose blend modes work on the inks, and Indexed, Duotone and Multichannel, need a `paged-pixel`
  PixelFormat amendment (a channel layout for Lab and N named channels), N-channel tiles through
  the kernels, and a fold that blends in ink space. No PixelFormat change is made here.
- **32-bit float.** `paged-raster` decodes EXR and Radiance HDR to f32; `Pixels` holds 8 or 16
  bits and many readers branch on that. A float document (open, view through a tone map, save)
  needs `SampleDepth::F32` in the store with the same compiler-guided migration.
- **Past the texture limit.** The fold keeps whole-canvas accumulators, so the largest image is
  the device's texture limit. Engine B as the production path (residency tier 3, the fold per
  tile) and a wider CPU fold for headless templates remain to be built.

## Related

- [ADR 455](455-pixel-model.md) — the pixel model this amends (16 bits now reach every path it
  listed as 8-bit, except the display view)
- [ADR 457](457-colour-management.md) — one CMS; the conversions here are its transforms
- [ADR 464](464-layers-at-their-own-bounds.md) — bounded layers keep their bounds through a depth
  or mode change
- [ADR 478](478-psd-write-depth.md) — the 16-bit layered save the 16-bit import now feeds
