# ADR 1091 — A text warp is an envelope over the text's outlines

- **Status:** Accepted 2026-11-08; **slice 1 built** (the shared reader of `prstTxWarp` with the 41
  presets, their families and adjusts); **slice 2 built** (Amendment 1: the preset guides, the
  model field, the render pass, doc and slide import); **turned frames built** (Amendment 2, 2026-11-09).
  Open: a measured match of Word's and
  PowerPoint's shapes, write-back of an edited warp, the adjust handles. Part of the capability
  layering of PM-0014 and PM-0017
  ([capability register](../../../../docs/development/capability-register.md), "Text envelope").
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

## Amendment 1 — guides, model, render and import (2026-11-08)

**Guides.** `paged_warp::textshape::text_shape(preset, adjust, thickness)` gives the two guide
curves of each of the 41 presets in the box's unit square: polylines (taper: stop, triangles,
chevrons, fades, slants, cascades), arcs of the inscribed ellipse (arch, circle, ring, pour,
button; a single-guide preset's band is the text's own height, `thickness`), one curve offset
by the box (curve, can), sines (waves) and half-sine bulges (inflate, deflate; the two- and
three-line presets as a deflate). `TextShape::map(rect, (u, v))` is the Coons patch between the
guides with straight sides: the point `v` of the way along the segment joining the guides at
`u`. Defaults are the schema's adjust defaults as this reader states them. The guides are
evaluated as functions, not fitted to a bicubic mesh: an arc of up to 360 degrees is exact, which
one envelope patch is not. The ADR's "the mesh is the Coons patch" holds in that form.

**Model.** `TextFrame.text_warp` and `AnchoredFrame.text_warp`
(`paged_model::text_warp::TextWarp { preset, adjusts }`, the preset's name and its plain-value
adjusts), skipped when unset. Not on the wire: no mutation sets one yet.

**Render.** `StoryEmitter::apply_text_warp` runs after vertical justification over each warped
frame's command range: every filled or stroked path the frame's text drew (glyph outlines,
underlines) is flattened in page space (0.05 pt), its straight pieces cut to 0.5 pt, and each
point mapped. The source square is the text's ink box, the target the frame's text area (its box
less its insets), so the text fills the shape, as WordArt does. A bent glyph is a path: its
glyph-run record is dropped, and a PDF draws it as an outline. Turned frames: Amendment 2.
Not yet: stroke widths are not bent, a warp in a frame with threaded text bends each frame on
its own.

**Import.** doc: a `wps:wsp` text box's `wps:bodyPr` through the shared reader
(`docx-import` `shape_looks`, keyed like the box's look by `wp:docPr/@id`), carried as
`docx_core::WordArt` to `LoweredTextBox.warp` / `LoweredItemKind::TextBox.warp` and onto the
anchored frame or the page item's text frame. slide: `a:bodyPr` (`pptx_core::BodyProps.warp`),
inherited like the other body properties, onto the resolved `TextFrame` and the native frame.
Neither writer touches the element: a part nobody edited keeps its bytes.

**Verification.** `paged-warp` (`textshape` tests: plain is the box, an arch of 180 degrees is
symmetric and highest in the middle, an arch down lowest, an inflate keeps its corners, adjusts
move the guides, a circle closes, every preset name maps), the renderer (`text_warp` unit tests;
`tests/it/text_warp_pipeline.rs`: `textPlain` stretches the ink onto the text area, an arch keeps
the text inside the area's ellipse and above its centre), doc and slide readers (the warp and its
adjusts are kept, `textNoShape` is none). **Not verified:** any match to Word's or PowerPoint's
drawing of a preset; the forms are the guides' shapes, not measured ones.

## Amendment 2 — turned frames (2026-11-09)

**Render.** A turned frame's lines are laid out upright from its spread top-left and turned about
it by the frame's linear part (the line emit's `frame_is_upright` pass). The warp now works in
that upright space: `text_warp::warp_range` takes a `Turn` (the linear part and its pivot), takes
each flattened point back through it, maps it onto the preset's shape over the frame's upright
text area and turns it again, so the bent text turns with its frame. Vertical justification of a
turned frame moves its lines along the frame's own vertical axis (`frame_down`), no longer along
the page's.

**Anchored frames turn** (engine ADR 1050, amendment 2026-11-09): the anchored pass gives the
TextFrame and Rectangle it synthesises the linear part of the anchored frame's `item_transform`
about the centre of the placed box (`anchored::anchored_turn`), so an anchored Word text box —
WordArt or not — turns with its text, warp, fill and outline.

**Import.** doc: `shape_looks` reads a text box's `wps:spPr/a:xfrm/@rot` beside its look and warp
(`docx_core::TextBox.rotation`), carried as `LoweredTextBox.rotation` /
`LoweredItemKind::TextBox.rotation` (degrees) onto the anchored frame's `item_transform` (linear
only) or the page item's text frame (about its centre on the page). slide: unchanged (a shape's
turn is its item's transform); a shape whose text is bent no longer grows to its text
(`slide-native` leaves `auto_sizing` unset for a warped frame), since the text is bent onto the
box itself: grown to the text, an arch had a box one line tall and collapsed to a line.

**Verification.** `text_warp` unit test (a quarter-turned frame is bent in its upright space);
`tests/it/text_warp_pipeline.rs` (the arch of a frame turned a quarter about its centre, turned
back, is the upright frame's arch); `tests/it/anchored_turn_pipeline.rs` (a turned anchored text
frame's glyphs turn); `docx-import` (a turned box keeps its `rot`), `docx-conformance` `wordart`
(the `wordart` fixture: a page-item arch at 30 degrees and an anchored wave at -20 degrees are
read, lowered and built turned).

**Oracle.** PowerPoint 16 (the `rotated-text` fixture of `slide-conformance`, slide 1: an arch up
turned 30 degrees, a wave turned -20 degrees, authored by
`tooling/oracle/office/powerpoint/fixtures/rotated-text.*`): our render and PowerPoint's PDF agree
on the turn of both boxes and their bent text; the wave matches closely. The arch follows the box's
turn, but PowerPoint sets the text along part of the arc at its own length while ours stretches it
over the whole half ellipse: the preset's form, not the turn (still the open "measured match").
Word: see doc ADR 629's amendment for the probe of the `wordart` fixture.
