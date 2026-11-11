# ADR 1037 — An image frame has a filter stack

- **Status:** Accepted 2026-10-28.
- **Scope:** protocol v77 (additive; no bump). `paged-kernels` (new; the first step of
  [ADR 1013](../../../../docs/adr/PM-0014-capability-layering.md)'s move); `paged-model`
  (`image_adjust`: `RasterOp`, the `image_adjustments` field of `Rectangle`, `Oval` and
  `Polygon`, the label helpers); `paged-mutate` (`PropertyPath::FrameImageAdjustments`,
  `Value::ImageAdjustments`); `paged-introspect` (the `frameImageAdjustments` row);
  `paged-renderer` (`pipeline/image_adjust.rs`, `pipeline/images.rs`,
  `PipelineOptions::image_adjust_px_per_pt`); `paged-canvas` (its reads, the live density,
  `export_losses.rs`); `idml-import` and `idml-export` (the label); paged.image's
  `image-kernels` (re-exports), `platform/shared/dml-native` (picture effects) and
  paged.slide's `slide-native`. Gap: the cross-module "image features everywhere" requirement
  (plan WP3.5).

## Context

A picture placed in a document, a slide or a sheet often wants a quick fix: a little more
exposure, a curve, a black-and-white or duotone look, a touch of sharpening. Until now the only
way was the image module: ingest the picture, edit its pixels, write the new bytes back. That
is the right tool for retouching and the wrong one for a fix the user expects to undo, retune or
remove at any time, in any module, and to see in every output.

PM-0014 puts "image filter stacks on image frames" at L1 (the model and the renderer) and the
kernels they evaluate at L2 (`paged-kernels`, one definition shared with paged.image). The
image module's kernels already have one definition each: a WGSL module and, for the
adjustment chain, a shipped CPU twin held to the shader's tolerance (image ADRs 451, 465). The
engine must not grow a third copy of those formulas.

## Decision

**The model.** `paged_model::RasterOp` is one step of a picture's filter stack:

| op | parameters | evaluated by |
|---|---|---|
| `exposure` | `ev` (stops on the light) | `adjust.exposure`, encoded input |
| `brightnessContrast` | `brightness` −1..1, `contrast` slope | `adjust.brightness_contrast` |
| `levels` | `inBlack`, `inWhite`, `gamma`, `outBlack`, `outWhite` | `adjust.levels` |
| `curves` | `points` `[[in, out], …]` | paged-pixel's natural cubic spline, as a lookup |
| `hueSaturation` | `hue`°, `saturation`, `lightness` | `adjust.hue_saturation` master |
| `recolor` | `hue`°, `saturation`, `lightness` | `adjust.hue_saturation` colorize |
| `duotone` | `shadow`, `highlight` (RGB) | `adjust.gradient_map`, two stops |
| `blackWhite` | six range weights | `adjust.black_white` |
| `sharpen` | `amount`, `radius` (px) | `conv.gaussian_*` then `conv.unsharp` |
| `blur` | `radius` (px, σ) | `conv.gaussian_h` / `_v` |
| `posterize` | `levels` | `adjust.posterize` |
| `threshold` | `level` | `adjust.threshold` |
| `invert` | — | `adjust.channel_mixer` (negated identity, constant 1) |

`Rectangle`, `Oval` and `Polygon` (the kinds that place a picture) carry `image_adjustments:
Vec<RasterOp>`, applied in order. Colours are the picture's own encoded RGB, 0..1; a radius is
in the picture's own pixels, so the look does not change with the size the picture is placed
or drawn at. The field is `#[serde(default, skip_serializing_if = "Vec::is_empty")]`: a frame
without a stack serialises as before, an older `.pgm` reads an empty stack, and the state hash
(ADR 195) is unchanged for it. `PGM_FORMAT_VERSION` does not move. The "artistic presets" of
the plan are not ops: the host panel offers them as ready-made stacks of these ops (sepia is a
duotone, noir a black & white with a curve), so a preset is editable once applied and needs no
format of its own.

**The kernels are paged.image's, moved, not copied.** `engine/core/crates/paged-kernels` is
the crate ADR 1013 plans. This record moves the part the engine needs into it with `git mv`:
the pixel type `Px`, the param blocks of the twenty kernels with a shipped CPU twin, and the
twins themselves (`image-kernels/src/cpu.rs`). `image-kernels` re-exports all three under their
old paths and keeps what is its own: `KernelDef`, the WGSL, the registry build, the
`CPU_KERNELS` list and the `kernel_family!` twin of `adjust.invert_rgb`. `adjust.gradient_map`,
which had only the test reference, gains a shipped twin for the duotone; it joins `CPU_KERNELS`
with its tolerance case (`image-conformance` `cpu_twins.rs`, CPU against the reference and, on
a device, against the shader). The rest of `image-kernels` (the WGSL, the registry) moves when
ADR 1013 is written; the crate is shaped for it.

**Evaluation.** `paged_renderer::pipeline::image_adjust` runs the stack on the CPU over
premultiplied `f32` pixels, the working space the twins are written for, and returns straight
RGBA8. A blur wider than one pass's window (3σ ≤ 24 px) runs as `n` passes of σ/√n, whose
variances add to σ². The renderer replaces a placed raster with its adjusted twin before it is
drawn (`adjusted_placement`, every frame kind, inline and linked pictures alike):

- *Resolution.* `PipelineOptions::image_adjust_px_per_pt` names the display density a build
  evaluates for. The canvas's live builds set the camera scale, at least 2 px per pt; the
  picture is first reduced (paged-resample's Lanczos-3) to that density's share of its pixels,
  rounded up to a power of two (1, ½, ¼ …) so that zooming does not re-run the stack at every
  step. `None`, the default and the export's, evaluates at the picture's own pixels.
- *Cache.* The twin is keyed by (picture, stack, scale) in the build's decoded-image cache,
  which the canvas keeps across builds: an edit elsewhere on the page does not re-run the
  stack. A slider drag writes a new stack per step, so a picture keeps at most eight twins.
- *wasm32.* There the build decodes pictures lazily at raster time; a picture with a stack is
  decoded at build time instead (at its display size), because its twin must exist before it is
  drawn.
- Placed PDF, SVG and EPS art is vector and is drawn as it is.

**Both rasterizers draw the same pixels** (ADR 146's rule of one builder for both lanes): the
twin is an ordinary RGBA8 image of the display list's pool, which Vello uploads and
`vello_cpu` samples. A GPU evaluation of the stack is later work (PM-0014's "GPU via
paged-gpu's wgpu device later"); it will be held to these CPU twins, as the image module's
shader is.

**PDF.** The export build evaluates at the picture's own pixels, so the adjusted picture is
embedded at its effective ppi (Flate, the source's ICC profile kept); the DCT passthrough of an
unadjusted JPEG does not apply to it, because its pixels are no longer the file's.

**The wire.** `PropertyPath::FrameImageAdjustments` (`frame.imageAdjustments`, the catalog's
`frameImageAdjustments`, a list of `RasterOp`) carries the whole stack as
`Value::ImageAdjustments`; the empty list clears it. Every op is range-checked
(`RasterOp::is_valid`; out of range is `InvalidValue`). Paint-only: it invalidates the frame's
style, never text. The inverse carries the stack it replaced, so undo restores the model
exactly (ADR 197). A new `PropertyPath` and a new `Value` variant are additive (the governance's
rule 1, the `TabStops` / `Lengths` precedent): protocol v77 stays.

**IDML has no such construct.** On export each frame's stack is written as the JSON of a
`<KeyValuePair Key="paged:imageAdjustments">` label on the frame, and the import moves that
label back onto the frame, so a paged → IDML → paged round trip keeps the stack. InDesign
shows the picture unadjusted, so `idml_export_losses` names each frame with a stack and its
ops (declared from the model, as the opacity mask's line is: the twin reads the label back and
cannot tell).

**DrawingML.** `dml-native`'s `Mapper::picture` lowers `a:lum` to brightness/contrast,
`a:duotone` to a duotone, `a:grayscl` to a black & white with the luma weights (0.3, 0.59,
0.11 — the six range weights that reproduce them exactly), `a:biLevel` to a threshold and
`a:hsl` to hue/saturation; paged.slide's pictures carry the result. `a:clrChange`,
`a:clrRepl`, `a:tint` and a picture blur have no op and stay reported.

## Evidence

- `crates/paged-model/src/image_adjust.rs`: the JSON form, camelCase fields, range refusals,
  the label round trip.
- `crates/paged-renderer/src/pipeline/image_adjust.rs`: each op against its expected pixels
  (exposure doubles the light, invert, threshold, duotone ends, recolor and black & white,
  curves, blur keeps the light, the multi-pass blur, sharpen), the power-of-two display scale,
  the cache key, the reduction before evaluation.
- `crates/paged-renderer/tests/it/image_adjustments.rs`: a placed picture is drawn adjusted, at
  display size with a density and at its own pixels without; the cache reuses the twin.
- `crates/paged-gpu/src/vello_rs.rs`: an adjusted picture drawn through both lanes agrees per
  pixel (ADR 146).
- `crates/paged-export-pdf/tests/it/image_adjustments.rs`: the PDF embeds the adjusted pixels
  at the picture's own size.
- `crates/paged-mutate/src/lib.rs`: set, refusal, paint-only invalidation, inverse.
  `crates/paged-canvas/tests/it/image_adjustments.rs`: read, write, redraw and undo through the
  canvas model; the IDML export's label, its loss line and the round trip; the `.paged` round
  trip.
- `modules/image/image-conformance/tests/it/cpu_twins.rs`: the gradient-map twin within
  tolerance.
- `platform/shared/dml-native/tests/map.rs`: picture effects become the stack.

All tests named `*__feat__images_graphics_image_filter_stack` are the evidence of the feature
row `images-graphics.image-filter-stack`.

## Consequences

- A picture can be adjusted in any module's output, on both rasterizers and in PDF, without
  touching its bytes; removing the stack restores it exactly.
- IDML keeps the stack for paged only; InDesign shows the original picture.
- A pptx export does not write the stack back as DrawingML yet (the inverse mapping belongs to
  the slide save path, plan WP10.2): a picture whose effects came from the source keeps its
  source blip, a stack added in paged is lost on that save.
- The image module's "Open in Image editor" ingests the picture as it is stored; turning the
  stack into adjustment layers needs a door the image module does not offer yet.

## Amendment 2026-11-11 — one picture correction in every module, the encodings at the boundary

A Photoshop adjustment layer, a Word, PowerPoint or Excel picture correction and a CSS filter on
a web picture are the same engine operations; only the readers and writers of PSD, DrawingML and
CSS know their encodings (capability register, "Differences belong at the format boundary").

**Two ops.** `channelMixer { red, green, blue }` (each row `[from red, from green, from blue,
constant]` as fractions, the result clamped to the gamut; `adjust.channel_mixer`) is Photoshop's
Channel Mixer, and every CSS colour function is one exactly, since Filter Effects 1 defines
`grayscale`, `sepia`, `saturate`, `hue-rotate`, `brightness`, `contrast` and `invert` as linear
maps of the straight sRGB colour, clamped after each. `colorReplace { from, to, alpha, tolerance }`
replaces the pixels within `tolerance` of `from` by `to`, their alpha multiplied by `alpha`:
Office's `a:clrChange` (PowerPoint's "Set Transparent Color" is `alpha` 0). Its twin is
`paged_kernels::cpu::color_replace`, which has no WGSL kernel yet (the filter stack evaluates on
the CPU). Both are additive on the wire (an older engine refuses an op it does not know, as it
refuses an unknown path); plugin-sdk 0.74.3-canary.86.

**An anchored picture carries the stack.** `AnchoredFrame::image_adjustments` is a free
frame's `image_adjustments` on the picture of an anchored frame (paged.doc's pictures, doc ADR
600): the renderer's synthetic rectangle takes it (ADR 1045), `frameImageAdjustments` writes it
through the anchored-frame finder and the canvas lists it with the picture's placement, so the
Picture panel edits a Word picture as it edits any other. Serialised only when set: an anchored
frame without a stack hashes as before.

**DrawingML, both ways in one place.** `dml-native` is the one mapping of a picture's crop
(`dml_native::crop`: `a:srcRect` as the placement, the placement back as `a:srcRect`; the
fraction conversion is `paged_ooxml::drawingml::paint::rel_rect_fractions`), which paged.doc's
lowering and crop save-back, paged.sheet's pictures, paged.slide's pictures and its save path
called through five copies before (single-owner rule `drawingml-crop`). paged.doc lowers a
picture's `a:lum`, `a:duotone`, `a:grayscl`, `a:biLevel`, `a:hsl`, `a:clrRepl`, `a:clrChange` and
`a:blur` onto the frame's stack through `native::Lowering::picture_with_filters`, as slide and
sheet do, in the standalone open (`docx-skeleton`) and in a placement (`doc-host-model`, the
skeleton's batch), body and table cells; they are no longer reported as lost.

**Saved back as DrawingML.** `dml_native::picture` is the inverse of the import's mapping:
`effects_of` turns a stack into the resolved picture effects (`a:lum` with the slope's inverse,
`a:duotone`, `a:clrRepl` for a one-colour duotone, `a:grayscl`, `a:biLevel`, `a:hsl`,
`a:clrChange`, `a:blur` in points from the picture's own pixels), which
`paged_ooxml::drawingml::write::blip_effects` writes, and `splice_blip` rewrites a picture's
`a:blip`: its picture-effect children are replaced, `a:alphaModFix`, the alpha effects, `a:tint`
and the extension list (Office 2010's image layer) are kept byte for byte. An op DrawingML has no
element for (exposure, levels, curves, recolor, sharpen, posterize, invert, a channel mixer), a
black & white with its own range weights and a colour replace's tolerance are reported on save.
`pptx-export` writes a changed stack on an edited picture and the stack of a new one;
`docx-export` writes the stack the canvas reads back (`PictureContent::adjustments`, always
listed so a cleared stack is told from a host that does not read one) into the drawing's blip,
beside the crop (doc ADR 623). paged.sheet keeps its drawing parts byte for byte (sheet ADR 529)
and has no path that edits a picture's corrections, so it has nothing to write.

**One evaluator.** The stack's evaluation (`apply_rgba8`, the ops over premultiplied f32
pixels through `paged-kernels`' twins) moved out of the renderer into `paged-image-adjust`, unchanged;
the renderer keeps its display density, cache key and adjusted twin and re-exports it. paged.sheet's
in-frame grid draws a picture through it (`adjust_picture_rgba` of the sheet wasm) and cuts the crop's
part of the image (`dml_native::crop::source_rect`, `GridPicture::src`), as the page draws it,
instead of drawing the stored bytes whole. paged.image's `actions@1` `adjust` takes `ops`, a list of
`RasterOp`, evaluated by it (`adjust_raster_ops_rgba8` of the image wasm); the older path form
still runs the adjustment chain.

**CSS.** paged.web's bake (`css-filter-ops.ts`) maps a picture's colour functions to channel
mixers and `blur()` to a blur in the picture's own pixels, in the filter list's order; on
anything but one picture they stay deferred by key as before.

Evidence: `paged-renderer` `pipeline/image_adjust.rs` (the mixer clamps, the colour replace),
`paged-kernels` `cpu.rs` (`color_replace`), `dml-native` `crop.rs` and `tests/map.rs` (`a:clrChange`),
`web-bundle` `test/bake-effects.spec.ts` (a picture's filter list becomes its stack),
`dml-native` `picture.rs` (the ops DrawingML holds round-trip; the splice keeps what it does
not own), `paged-ooxml` `drawingml/write.rs` (`blip_effects` reads back), `pptx-export`
`tests/pictures.rs` and `docx-conformance` `crop_saveback.rs` (a stack set in the editor is saved
and reads back).

This supersedes the Consequences' note that a pptx export loses a stack added in paged.
