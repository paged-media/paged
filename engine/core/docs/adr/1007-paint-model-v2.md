# ADR 1007 — Paint model v2: opacity stops, inline stops, conic, mapped stroke gradients

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v76 (additive; no bump). `paged-model` (`GradientStopRef::opacity_pct`
  and `inline_color`, `InlineStopColor`, `GradientKind::Conic`, `StrokeGradientMode` and the
  `gradient_stroke_mode` field of `TextFrame`, `Rectangle`, `Oval`, `Polygon` and `GraphicLine`);
  `paged-mutate` (`GradientStopSpec::opacity_pct` and `color`, `StopColorSpec`, `"Conic"`,
  `PropertyPath::FrameGradientStrokeMode` and `FrameGradientFillStart`); `paged-introspect` (the
  `frameGradientStrokeMode` and `frameGradientFillStart` rows); `paged-compose`
  (`gradient_sample`, the one stop sampler); `paged-renderer` (`pipeline/color_paint.rs`, `module/fill_paint.rs`,
  `module/stroke_gradient.rs`, the stroke emitters); `paged-gpu` (`vello_map.rs`);
  `paged-export-pdf` (`color.rs`, `page.rs`); `paged-canvas` (`gradientDetail`, the IDML
  export lowering and `export_losses.rs`); `idml-export` (`effects.rs`, `resources.rs`). Gaps
  D-17, D-18, D-21.

## Context

The engine's paint was InDesign's: a gradient swatch is a list of stops, each a reference to a
colour swatch at a location with a midpoint, of kind linear or radial; a stroke shows the part of
the frame's gradient it covers. The vector modules want more, and so do the formats they read:

- **Opacity stops.** SVG's `stop-opacity`, CSS gradients, Illustrator and DrawingML (`<a:alpha>`
  on a `<a:gs>`) give each stop an opacity; a fade to transparent is the most common gradient in
  web and slide content. IDML has none: a stop's colour has no alpha, and InDesign fades an
  object with a separate *gradient feather*.
- **Inline stop colours.** A gradient pasted from SVG or built in the Gradient panel names
  colours no swatch holds; making a swatch per stop fills the Swatches panel with noise.
- **Conic gradients.** CSS `conic-gradient`, Illustrator's freeform-adjacent "angle" gradients
  and colour wheels. The display list already had a sweep pool for placed content, drawn by both
  rasterisers, but the model could not ask for it and PDF dropped it to a solid.
- **Stroke gradients along and across the path.** Illustrator applies a stroke's gradient
  *within* the stroke (InDesign's only mode), *along* it (the ramp follows the path) or *across*
  it (from one edge of the stroke to the other).

The display list's `GradientStop` already carried an RGBA colour, so per-stop alpha was
representable; nothing produced it.

## Decision

**The model.** A `GradientStopRef` gains `opacity_pct: Option<f32>` (0..=100, `None` is 100) and
`inline_color: Option<InlineStopColor>` (`space` + `value` as a `ColorEntry` has them). An inline
colour wins over `stop_color`, which may then be empty; the swatch reference stays the primary
form, the only one IDML has. `GradientStopRef::resolve_color` gives every reader one answer (an
inline colour reads as an unnamed process swatch of its space and value). `GradientKind` gains
`Conic`. A conic gradient's centre is the frame's gradient start (`gradient_fill_start`), else its
box's centre, and its start direction is the frame's gradient angle, counter-clockwise on the
page like a linear angle; the ramp turns once, clockwise on the page. The angle and start stay
per-use, as they are for linear and radial. Each frame kind with a stroke gains
`gradient_stroke_mode: StrokeGradientMode { Within, Along, Across }`, `Within` the default.

**`.paged` and the state hash.** Every new field is `serde(default)` and skipped when it holds
its default (`opacity_pct: None`, `inline_color: None`, `Within`), and `GradientKind` is an
externally tagged unit enum, so a document that uses none of it serialises the bytes it did
before and keeps its state hash ([ADR 195](195-the-state-hash-covers-the-whole-model.md)); an
older `.pgm` reads the defaults. `PGM_FORMAT_VERSION` does not move. An opacity of 100 is stored
as absent, so a stop set back to opaque in the panel leaves no trace. A newer `Conic` is unknown
to an older reader: the same forward-compatibility line every added enum value draws.

**The wire.** `GradientStopSpec` gains `opacityPct` (clamped to 0..=100 on apply) and `color`
(`StopColorSpec { space, value }`); `GradientSpec.kind` takes `"Conic"`. `createGradient` and
`editGradient` carry them; their inverses capture them, so undo is exact. The stroke mode is
`PropertyPath::FrameGradientStrokeMode` (`frame.gradientStrokeMode`, the catalog's
`frameGradientStrokeMode`), `Value::Text` `"Within"`, `"Along"` or `"Across"` (`""` clears to
`"Within"`; anything else is `InvalidValue`), paint-only, permission `appearance.stroke`. The
reads follow: `gradientDetail` stops carry `opacityPct` and `color`, and `kind` reads `"conic"`.
The frame's gradient start, which the model already had (`gradient_fill_start`, IDML's
`GradientFillStart`) and the wire did not, becomes `PropertyPath::FrameGradientFillStart`
(`frameGradientFillStart`, `Value::Lengths` `[x, y]` in the frame's inner coordinates, `[]` clears
to InDesign's default), so a conic or radial gradient can be centred and an importer (draw's SVG)
can place an axis exactly. All of it is additive, which governance rule 1 leaves at protocol v76.

**Opacity rides on the stop colour's alpha.** The renderer resolves each stop (its inline colour
or its swatch) and sets the colour's alpha from its opacity. A ramp is defined
**unpremultiplied**: colour and alpha blend apart, as PDF paints a colour shading under an alpha
soft mask. The rasterisers interpolate premultiplied, so a segment whose alpha *and* colour both
change is tessellated into 16 sub-stops (the path the midpoint and CMYK ramps already take);
the two readings then differ by under one 8-bit level. A segment whose colour holds (a fade of
one colour) needs no tessellation: premultiplied and unpremultiplied agree there.

**Conic is the sweep pool.** `Paint::SweepGradient` with its centre in the path's local
coordinates. Both rasterisers map it to peniko's sweep through `vello_map`, which now turns the
start angle by the transform's rotation (the angle is the path's own). Both rasterisers read a
sweep's angle in 0..2π only — a start past 0 shortened the turn (measured: a quarter-turn start
spread the ramp over three quarters) — so the sweep always runs 0..2π and the start moves into
the stops (`vello_map::turn_sweep_stops`: each stop moves on by the start, those passing the end
wrap, the seam at +x gets the ramp's colour there, the wrapped end before the start). A polygon's centre is rebased to its box, an explicit start moves it.

**A stroke mapped along or across its path is built, not rasterised.** Neither Vello nor
`vello_cpu` nor PDF has a paint whose parameter is the arc length along a path or the distance
across a stroke, and a stroke-space shader would have to be written twice (WGSL and the CPU
pipeline) and once more as a PDF mesh. `module::stroke_gradient` instead lowers the stroke, at
build time, to commands every back end already draws alike:

1. the stroke's outline (kurbo's stroker over the page-space centreline, dashes and marks
   included) becomes a `PushClip`;
2. inside it the ramp is laid down as bands of solid colour: `Along`, a strip of the stroke per
   stretch of the path (parameter = arc length / length, per contour); `Across`, a strip at a
   fixed signed distance from the centreline along the whole path (0 on the left of travel, 1 on
   the right). Bands break at every stop and are at most 1/128 of the parameter wide (never under
   0.25 pt), each the ramp's colour at its middle (blended in sRGB-encoded values, as the
   rasterisers and PDF blend a gradient); each reaches 0.25 pt under the next, which hides the
   seam two abutting antialiased fills leave, and 1 pt beyond the stroke's sides, so the clip
   draws the one antialiased edge; an open contour is extended a stroke width past each end to
   cover its caps;
3. a ramp with translucent stops draws the bands opaque inside a luminosity soft mask of the same
   bands in grey (the alpha, decoded from sRGB, since both back ends and PDF read a luminosity
   mask off the encoded colour): the overlaps would otherwise double the alpha.

GPU/CPU parity (ADR 146) follows by construction: the back ends receive solid fills, a clip and
a soft mask, which they already draw alike. The tolerance is the staircase: half a band step of
colour, under one 8-bit level for a full-range two-stop ramp; a curve tighter than half the
stroke folds the offset strips on its inside, where a band may show a neighbour's colour. The
centreline is flattened to 0.05 pt. Overprint and the striped and wavy stroke styles keep the
`Within` reading. The frame's `Within` stroke and every solid stroke emit exactly as before.

**PDF.**

- A conic gradient is a type-1 (function-based) shading over the painted area in page space,
  its function a Type-4 calculator: `(x, y)` → the angle about the centre (`atan`, which turns
  from +x toward +y, clockwise in the list's y-down space), less the start angle, over 360° →
  the stops evaluated piecewise linearly. Fills clip and `sh` it; strokes paint it through the
  `/Pattern` colour space as the other gradients do.
- A ramp with translucent stops paints its colour shading under an ExtGState whose luminosity
  soft mask is a form painting the same shading's alpha in DeviceGray (`ShadeChannels::Alpha`),
  set before the path's transform so it lives in page space (the form repeats the transform);
  outside it the backdrop is black.
- Along and across arrive as the bands, clip and soft mask above, which the writer already
  translates.

**IDML.** IDML cannot say any of this, so the export lowers what it can and reports the rest
(the export-losses pattern of [ADR 124](124-opacity-masks-native.md) and
[ADR 1006](1006-fill-rule-is-a-native-property.md)), from the model:

- *Inline stop colours* are written as unnamed process colours the stops reference, so the
  gradient survives with its colours (no loss).
- *Opacity stops on a fill* become an equivalent **gradient feather** where that is exact: the
  frame uses the gradient as its fill, has no stroke, no other feather and no content (a feather
  fades the whole object, its stroke, text and picture included —
  [ADR 204](204-a-feather-fades-the-stroke-and-the-text.md)), the gradient is linear or radial,
  and the feather takes the fill's geometry (type, angle, start, length) with one opacity stop
  per colour stop (location, midpoint, opacity). Colour × feather alpha is the unpremultiplied
  ramp exactly. The gradient swatch is written with its colours only. Anything else — a stroke
  gradient's opacity, an object with a stroke or content, a frame that already feathers, a conic
  ramp — is a loss line: the stops export opaque.
- *Conic* exports as a linear gradient of the same stops and is reported; *Along* and *Across*
  export as `Within` and are reported. No bake is available for either.

**One stop sampler.** Gradient stop interpolation lived twice (the effect masks' and the CPU
feather's alpha ramps) and this decision would have added two more (the stroke bands, the sweep
seam). `paged_compose::gradient_sample` holds it once: `sample_alpha` for `(location, alpha)`
ramps, `sample_ramp` for colour stops (sRGB-encoded colour, linear alpha), and the sRGB transfer
pair.

## Evidence

- `crates/paged-gpu/src/vello_rs.rs`: `opacity_stops_fade_alike_on_both_lanes__feat__…`
  (linear and radial), `conic_gradients_sweep_alike_on_both_lanes__feat__…` (upright and under
  a quarter turn) and `banded_stroke_under_a_clip_and_mask_matches__feat__…` (the lowering's
  command shape, opaque and translucent: no seam, the mask fades by the alpha), each comparing
  the Vello and `vello_cpu` lanes per pixel (Metal on the GPU lane).
- `crates/paged-renderer/tests/it/paint_v2.rs`: an opacity stop fades to the page, an inline
  colour paints with no swatch, a conic fill turns from its angle, a stroke within / along /
  across (the edge colours that tell the three apart), a translucent along stroke under its
  mask, a line along and across its length (the left-of-travel convention), and, with the
  `gpu` feature, the mapped stroke on both lanes.
- `crates/paged-export-pdf/tests/it/paint_v2.rs`: the type-1 shading and its calculator
  function for a conic fill, the alpha soft mask (`/SMask`, `/S /Luminosity`, a DeviceGray
  shading) for a translucent fill and stroke, none for an opaque one; the calculator function's
  values.
- `crates/paged-mutate`: create/edit round trips of the new stop fields and `"Conic"`, the
  clamp, the stroke mode's set, inverse and refusal.
- `crates/paged-canvas/tests/it/paint_v2.rs`: reads (`gradientDetail`), writes and undo through
  the canvas model; the IDML lowering (a feather for a fill's opacity stops, unnamed colours for
  inline stops) and the loss lines (stroke opacity, conic, along/across); the `.paged` round
  trip and an unchanged state hash for a document without paint v2.
- `crates/paged-store/tests/it/paint_v2.rs`: the fields round-trip; a document without them
  writes no keys.

All tests named `*__feat__color_swatches_paint_v2` are the evidence of the feature row
`color-swatches.paint-v2`.

## Consequences

- A gradient can fade, carry its own colours, sweep, and follow a stroke in the editor, on both
  rasterisers, in PDF and in `.paged`. IDML keeps a fill's fade where a feather is exact and
  names everything else.
- A placed or plugin sweep gradient on a rotated path now turns with it.
- The PDF writer still emits sRGB shadings (ADR "native-space shadings = v2" stands); an alpha
  mask is DeviceGray.
- Pattern and mesh/freeform paints, which the plan also gives this ADR, are not part of this
  decision; they follow in their own work package.
- The plugin scene-layer IR (`SceneGradient`) already has stop colours with alpha and a sweep;
  it needs nothing new.
