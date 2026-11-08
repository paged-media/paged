# ADR 1091 — A text warp is an envelope over the text's outlines

- **Status:** Accepted 2026-11-08; **slice 1 built** (the shared reader of `prstTxWarp` with the 41
  presets, their families and adjusts). Open, in this order: the preset guide curves, the engine
  model and its mapping, render, doc and slide import, write-back. Part of the capability layering
  of PM-0014 and PM-0017 ([capability register](../../../../docs/development/capability-register.md),
  "Text envelope").
- **Scope:** `paged-ooxml::drawingml::textwarp` (the reader); later `paged-warp` (preset guides →
  `Mesh`), `paged-vector-fx` (the envelope of [ADR 1042](1042-live-vector-effects-are-stack-entries.md),
  amendment 2026-10-31), `paged-model` / `paged-renderer` (a text frame's warp), `docx-*`, `slide-native`.

## Context

WordArt is `a:bodyPr/a:prstTxWarp prst="textArchUp"` with an `a:avLst` of adjusts, in Word
(`wps:bodyPr`), PowerPoint and Excel. Forty-one presets bend the text box: arches and circles
(the text follows an arc), buttons, curves and cans, waves, inflate and deflate, fades, slants,
cascades, stops, triangles and chevrons. The engine draws such text unbent.

The engine already has the parts: `paged-warp::envelope` maps points through a bicubic Bézier mesh
(Photoshop's warp styles, ADR 1013), and ADR 1042 added `Effect::Envelope` to vector items, a
`rows × columns` patch net the item's outline is mapped through.

## Decision

**A text warp is an envelope applied to the frame's text after layout.** Text is laid out in the
unwarped box (line breaking, justification and hyphenation do not know about the warp, as in
Word). The glyph outlines of every line are then mapped through the preset's mesh: a point at
`(u, v)` in the box (0 to 1 each way) moves to the mesh's surface at `(u, v)`. This is exactly how
Word draws it, and exactly the operation the vector envelope performs, so one mapping serves both:
`paged-warp` owns the mesh evaluation, `paged-vector-fx` the application to outlines.

**The reader is shared** (`paged-ooxml::drawingml::textwarp`): `read(body_pr) -> Option<TextWarp>`
with the `Preset` (41 variants, `prst` names round-tripping), its `Family` and the adjusts as
written. An unknown preset reads as no warp and stays in the bytes. It never rewrites the markup,
so a part nobody edited saves byte-identical.

**Presets are described by their guide curves**, in families:

| Family | Presets | Mesh |
|---|---|---|
| Plain | `textNoShape`, `textPlain` | identity |
| Taper | stop, triangle(+inverted), chevron(+inverted), fade ×4, slant ×2, cascade ×2 | top and bottom guides are straight lines (corners pinned, ends raised or narrowed by the adjust) |
| Arch | `textArchUp`, `textArchDown` | the line follows an arc of angle `adj` (default 180°) |
| Circle | `textCircle`, rings | the line follows a full circle; ring variants fill the annulus |
| Pour | `…Pour` | the box maps to the band between two concentric arcs |
| Button | `textButton` | a text line on an arc over a straight line and an arc under it |
| Curve | curve up/down, can up/down | top and bottom guide are one curve, offset by the box height |
| Wave | wave 1, 2, 4, double wave | sinusoidal guides, `adj1` amplitude, `adj2` phase |
| Inflate | inflate, deflate, their halves, the combined shapes | guides bulge/pinch around the middle |

Each guide is a cubic chain; the mesh is the Coons patch between the two guides and the box's
vertical sides. The default adjusts are the schema's (`adj` etc., 0 to 100000 or angles in
60000ths of a degree).

**Verification plan.** Geometry invariants per family (arch of 180° puts the first and last glyph
on the same baseline height, the middle highest; an inflate leaves the box corners fixed), the
adjust-defaults table checked against the ECMA-376 preset definitions, and a Word-saved PDF of a
generated `.docx` per preset (headless, `tooling/oracle/office/word`) for the glyph extents.

## Built in this slice

`Preset`/`Family`/`TextWarp`/`read` with tests: 41 unique names that round-trip, the adjusts as
written with `adjust()` for plain `val N`, absent/unknown/`textNoShape` giving no active warp, a
non-value formula not read as a number.

## Next slices (documented, not built)

1. **Guides.** `paged-warp::textshape`: `Preset` family + adjusts → `Mesh`, with the invariants
   above; the preset table with the schema defaults.
2. **Model.** `TextFrame.warp: Option<TextWarp>` (absent when none, so existing documents' hash
   does not move), a wire/catalog entry (the full resync in one commit), and a pass in the
   renderer: outline the lines, map the points, paint as paths (fill, stroke and the text's
   effects follow the mapped outline).
3. **Import.** doc (`wps:bodyPr`), slide (`a:bodyPr`) and sheet shapes through the shared reader;
   export writes the element back from the model, or leaves the original bytes when untouched.
4. **Editing.** The adjust handles (yellow diamonds) through the handle door.
