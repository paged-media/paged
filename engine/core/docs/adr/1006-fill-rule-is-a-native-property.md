# ADR 1006 — The fill rule is a native property

- **Status:** Accepted 2026-10-24.
- **Scope:** protocol v76 (additive; no bump). `paged-model` (`FillRule`, the `fill_rule`
  field of `TextFrame`, `Rectangle`, `Oval`, `Polygon` and `GraphicLine`, the `winding`
  module); `paged-compose` (`FillRule`, `PathData::fill_rule`); `paged-gpu` (`vello_map`,
  `vello_rs.rs`, `vcpu.rs`); `paged-export-pdf` (`path.rs`, `page.rs`, `transparency.rs`);
  `paged-renderer` (`module/frame.rs` and the outline builders, `pipeline/placed_svg.rs`,
  `pipeline/placed_pdf.rs`); `paged-mutate` (`PropertyPath::FrameFillRule`); `paged-introspect`
  (the `frameFillRule` row); `paged-canvas` (its reads, `export_losses.rs`); `idml-export`
  (`rewrite.rs`). Amends [ADR 154](154-a-placed-pdf-is-drawn-from-its-own-operations.md) and
  the placed-SVG lane of [ADR 190](190-a-placed-svg-draws-its-filters.md). Gap D-10.

## Context

A filled outline covers the points its contours wind around. Two rules decide which: under
**non-zero** a point is inside when the contours wind around it a net number of times other than
zero; under **even-odd** when they cross a ray from it an odd number of times. They agree on one
simple contour and on nested contours wound against each other, and differ where contours wind
the same way (a donut whose hole turns like its ring fills solid under non-zero) or cross
(a five-pointed star drawn as one contour keeps its middle under non-zero and loses it under
even-odd).

IDML has one rule. It fills non-zero and has no attribute for another: a hole is a contour
wound against the one around it. The engine had one rule too: the display list's `PushClip` was
documented non-zero and every back end hard-coded it (`Fill::NonZero` at some thirty sites in
the Vello encoder, `set_fill_rule(Fill::NonZero)` in `vello_cpu`, `f` and `W n` in the PDF
writer). Two inputs ask for even-odd anyway:

- a placed SVG's `fill-rule="evenodd"` and `clip-rule="evenodd"`, which the SVG lane converted
  by re-winding (`even_odd_as_non_zero`) and, when contours crossed, gave up on and drew the
  SVG's raster;
- a placed PDF's `f*`, `B*` and `W*`, which ADR 154 recorded as filled non-zero: a compound
  path whose subpaths wind the same way lost its holes.

And the editor wants the property itself: Illustrator and every vector tool expose a fill rule
on a path, and the vector modules (draw, the DrawingML `custGeom` of slide/doc/sheet) carry it.

## Decision

**The model.** `paged_model::FillRule { NonZero, EvenOdd }`, `NonZero` the default, is a field
of every frame kind with an outline: `TextFrame`, `Rectangle`, `Oval`, `Polygon` and
`GraphicLine`. An oval is one simple contour, so both rules fill it alike; it carries the field
so that every kind takes the same write. The importer never sets it (IDML has none), so every
imported document reads `NonZero`.

**The `.paged` model part.** The field is `#[serde(default, skip_serializing_if =
"FillRule::is_non_zero")]`: a `NonZero` frame serialises exactly as before the field existed,
so an older `.pgm` reads `NonZero`, a document without even-odd writes the same bytes, and the
state hash ([ADR 195](195-the-state-hash-covers-the-whole-model.md)), which streams the same
serde form, is unchanged for it. `PGM_FORMAT_VERSION` does not move.

**The display list carries the rule on the path.** `PathData` gains `fill_rule:
paged_compose::FillRule`. The alternative, a field on each command that fills or clips by a path
(`FillPath`, `FillPathBlend`, `FillPathOverprint`, `PushClip`, and the shadow and effect
commands that stamp a path's interior), was rejected: it touches every emitter of every such
command, and lets two commands drawing one path disagree. The rule is a property of the outline,
so every command that names the outline fills it alike, the frame's fill, its clip of a placed
picture, its shadow and its feather; a stroke ignores it. `PathData::new` builds a `NonZero`
path and `with_fill_rule` sets another. A path transformed into another (the PDF writer's
`transform_path`, the effects' grown outlines, the SVG lane's placement) keeps its rule; a
stroke's outline is a new `NonZero` path.

**The digest stays.** `DisplayList::digest` ([ADR 101](101-display-list-single-intermediate.md))
hashes the paths' `Debug` form. `PathData`'s `Debug` is written by hand to print the rule only
when it is `EvenOdd`, so a document without even-odd content digests as it did before, which
the pinned `paged digest` golden of `paged-cli` and the test
`a_non_zero_path_keeps_its_digest__feat__frames_paths_fill_rule_even_odd` hold.

**Every back end reads it.**

- *Vello* fills `FillPath`, `FillPathBlend` (and its blend layer), `FillPathOverprint` and the
  overprint batch scene, and encodes a `PushClip` layer and an effect stamp's clip to its path,
  with the path's rule (`vello_map::path_fill`). Layers over rectangles stay non-zero.
- *`vello_cpu`* fills and clips by the path's rule and resets the context to non-zero after each
  draw; a clip remembers its rule so the clip stack it re-applies on a reset, its coverage
  scratch and the CMYK splat all clip as the clip did. A drop shadow and a feather render the
  path's interior by its rule.
- *The PDF writer* writes `f*` for an even-odd fill and `W* n` for an even-odd clip, a gradient
  fill's clip and a gradient feather's mask included (`path::fill`, `path::clip`).
- `surface.rs`'s page rectangles and the effect masks of `paged_compose::mask` are untouched:
  the first is one rectangle, and the second's scanline already pairs crossings, which is the
  even-odd rule.

**The renderer.** `ResolvedFrame` carries the frame's rule, and the outline builders give it to
the outline path: a polygon's, a pathed rectangle's and a pathed text frame's fill outline, the
outline its shadow is cast from, the clip of a picture placed in a polygon, the clip a container
puts around pasted-in children, and the clip a pathed text frame puts around its text.

**Placed content is drawn by its own rule.** A placed SVG's even-odd shape is drawn as an
even-odd path, whether its contours cross or not, so the SVG that drew its raster for a crossing
even-odd shape now draws as vectors. Only a clip path of several shapes still converts (one
path has one rule): each even-odd shape in it is re-wound to non-zero first, and one whose
contours cross keeps the raster lane. A placed PDF's `f*` and `B*` fill, and `W*` clips, even-odd
(ADR 154, amended).

**The wire.** `PropertyPath::FrameFillRule` (`frame.fillRule`, the catalog's `frameFillRule`),
`Value::Text` `"NonZero"` or `"EvenOdd"` (`""` clears to `"NonZero"`; anything else is
`InvalidValue`), on the five kinds. Paint-only: it invalidates the frame's style, never its
text. The inverse names the rule it replaced, so undo restores the model exactly
([ADR 197](197-undo-restores-the-model-exactly.md)). It is an additive path, which the
governance's bump rule 1 leaves at protocol v76. The permission is `appearance.fill`.

**The IDML export re-winds when that is lossless and reports when it is not.** Following the
opacity mask ([ADR 124](124-opacity-masks-native.md)): a construct IDML cannot express is kept
in `.paged` and named on IDML export. Here part of it can be expressed: contours that cross
neither themselves nor each other fill the same area under both rules once each turns the way
its nesting depth says (even depths one way, odd depths the other).
`paged_model::winding::even_odd_as_non_zero` re-winds the anchors so, swapping each reversed
anchor's handles, and the writer (`idml_anchors`) writes them, in the patch lane and for an
inserted polygon alike. The outline then fills the same area in InDesign and reads `NonZero` on
reopen; no loss is reported, because the picture is kept. Where contours cross, no re-winding
fills the same area: the anchors are written as they are and `idml_export_losses` carries one
line per such frame, naming it, the rule and `.paged`. The line is declared from the model, as
the opacity mask's is, because the re-imported twin cannot tell a re-wound outline from one
that never was even-odd. The import is unchanged: always `NonZero`.

**The winding module lives in the model.** The re-wind and its crossing test
(`paged_model::winding`) are pure geometry on the model's anchors and flattened polygons. The
exporter, the loss report and the placed-SVG lane all reach `paged-model`, so it is the lowest
layer every consumer reaches ([PM-0014](../../../../docs/adr/PM-0014-capability-layering.md)); the
SVG lane's own copy of the crossing test is gone.

## Evidence

- `crates/paged-gpu/src/vello_rs.rs`: `even_odd_fills_match_the_cpu_lane__feat__…` and
  `even_odd_clips_match_the_cpu_lane__feat__…` draw a same-wound donut and a self-crossing star
  through both lanes (ADR 146's per-pixel comparison), the hole and the middle empty under
  even-odd and filled under non-zero.
- `crates/paged-export-pdf/tests/it/fill_rule.rs`: `f*` for an even-odd compound polygon, none in
  the non-zero control; `W* n` for an even-odd clip.
- `crates/paged-renderer/tests/it/placed_svg_vectors.rs`: a crossing even-odd SVG is drawn as
  vectors, by the even-odd rule, within the existing tolerance of its 3× raster.
  `crates/paged-renderer/tests/it/placed_pdf_page.rs`: `f*` and `W*` leave the middle empty.
- `crates/paged-mutate/src/lib.rs`: set, paint-only invalidation, inverse, refusal.
  `crates/paged-canvas/tests/it/fill_rule.rs`: read, write, redraw and undo through the canvas
  model; the IDML export re-winds the donut (its hole turns against its ring in the written
  file) and reports the star; a `.paged` round trip keeps the rule.
- `crates/paged-store/tests/it/fill_rule.rs`: the rule round-trips; a non-zero frame writes no
  key and hashes alike.
- `crates/paged-model/src/winding.rs`: the re-wind and its refusals.

All tests named `*__feat__frames_paths_fill_rule_even_odd` are the evidence of the feature row
`frames-paths.fill-rule-even-odd`.

## Consequences

- A frame can be even-odd in the editor, on both rasterizers, in PDF and in `.paged`. In IDML it
  stays exact when its contours do not cross and is reported when they do.
- Placed SVG and PDF art with even-odd fills and clips draws exactly; ADR 154's "Even-odd fills
  and clips are filled non-zero" is closed.
- The geometry operations keep the item's rule: an outline-stroke or offset of an even-odd
  item gives an outline that fills correctly only under non-zero (`kurbo_kernel`'s note).
  Setting the rule back is one more write; making those operations reset it is left to their
  owners.
- The text that flows inside a pathed text frame is laid out by the scanline of
  `paged_text::FrameShape`, which already pairs crossings (even-odd) whatever the rule; the
  frame's clip of its text now follows the rule.
- The plugin scene-layer IR (`ScenePathSeg`) has no rule yet: a plugin's paths fill non-zero.
- The TypeScript side (the vendored wire types, the typed core commands and the plugin SDK's
  `IMPLEMENTED` table) learns `frameFillRule` in a separate contract change.
