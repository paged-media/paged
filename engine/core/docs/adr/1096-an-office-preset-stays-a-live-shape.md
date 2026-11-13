# ADR 1096 — An Office preset stays a live shape

- **Status:** Accepted 2026-11-11 with option 2 (below); built in stages (see Build). Extends
  [ADR 1047](1047-live-shapes.md); amends [PM-0014](../../../../docs/adr/PM-0014-capability-layering.md)
  (its DrawingML amendment of 2026-10-25).
- **Scope (when built):** `paged-model` (a preset live shape on a path item), `paged-mutate` (the
  refit after a resize, the adjust writes), `paged-canvas` (the reads and the handle positions),
  the importers and exporters of pptx, docx and xlsx, `platform/shared/dml-geom`, paged.slide's
  live-preset mechanism (slide ADR 717), paged.sheet's table shapes.

## Context

A DrawingML preset (`a:prstGeom` with its `a:avLst`) is a parametric shape: 187 programs of
adjust values, guide formulas and paths (ECMA-376 Annex D), evaluated for the shape's box. Office
keeps a shape a preset while it is edited: a resized rounded rectangle keeps its corner radius,
the yellow handles change the adjust values, a connector follows the shapes it is glued to.

paged has three answers to this today, one per module, and none in the engine:

- **paged.slide** keeps presets live in plugin metadata. The importer labels each element of a
  shape with its preset, adjust values and box (`x-paged:media.paged.slide`); after every edit
  the bundle hands the labelled elements of the touched pages to `slide-native`'s `live`
  module (about 1,200 lines), which refits a resized preset and re-routes connectors, and
  `adjust-handles.ts` serves the handles (slide ADR 717, extensions ADR 1103). A host that is not
  slide's bundle (the command line, a script, the server) sees paths.
- **paged.doc and paged.sheet** draw the preset once, at import, as a path (doc ADR 627, sheet
  ADR 530). A resize stretches it; there are no adjust handles.
- **paged.sheet's table shapes** (`table-shapes.ts`) are drawn again on every refresh, so an edit
  made with the host's tools is lost.

The principle of the capability register is one canonical implementation, with the differences
between Microsoft and Adobe at the import and export boundary. A PowerPoint preset, a Word shape
and an Excel shape must be one engine object, edited by the same host tools and handles in every
module, and only the pptx, docx and xlsx readers and writers should know DrawingML.

ADR 1047 already gives the engine live shapes in the form this needs: parameters on the item,
the anchors the truth every consumer reads, live while the anchors are still what the parameters
make, writes that redraw and undo exactly.

## The blocker: where the program is evaluated

The engine must evaluate the preset program itself (a resize in `paged-mutate` refits it; the
handle positions are a read). The evaluator, the 187 definitions and the live arithmetic (refit,
handle drag, connection sites, connector routing) live in `platform/shared/dml-geom`, which
PM-0014's amendment of 2026-10-25 placed above the engine on purpose: "the engine's model carries
the outlines it draws, while the preset programs, adjust handles and connection sites are
DrawingML's". No engine crate depends on `platform/shared` today. Three ways out:

1. **The engine depends on `dml-geom`.** Smallest change. It inverts PM-0014's layering (an L1/L2
   crate on format-family code), pulls `paged-ooxml` (its zip and XML reader) into the engine's
   wasm and the 526 KB definitions as text, parsed on first use.
2. **The evaluator moves into an engine crate** (recommended). A new L2 crate (working name
   `paged-shape-program`) holds the geometry program (`CustomGeometry`, guides, paths, handles,
   sites), its evaluator, the live arithmetic of `dml_geom::live`, and the Annex D table compiled
   at build time from `presetShapeDefinitions.xml` (no XML reader at run time). `dml-geom` keeps
   the DrawingML side: the XML reader and writer of `a:prstGeom` / `a:custGeom`, `place` (`a:xfrm`)
   and `heads`, and re-exports the evaluator under its current paths, so slide, doc and sheet
   change nothing at first. A test proves all 187 presets evaluate bit-identically before and
   after the move, and the slide, doc and sheet goldens do not move. PM-0014's amendment is
   amended: the preset program is a parametric shape the engine owns; its DrawingML encoding
   stays at the boundary.
3. **The engine stores the parameters and a host door evaluates them.** The built-ins always
   ship (PM-0017), so the door would always be served in the editor, but the engine alone (the
   command line, the server, a test) could not refit a preset, and the model would depend on a
   module to stay consistent.

## Decision: option 2

The owner's lead chose option 2 on 2026-11-11. Why not the other two:

- Option 1 would make the engine's lowest layers depend on format-family code: the engine's wasm
  would carry `paged-ooxml`'s zip and XML reader and the Annex D XML as text, only to evaluate a
  shape, and PM-0014 would have to be inverted rather than amended.
- Option 3 would leave the engine unable to keep its own model consistent: a resize in the command
  line, a script or the server could not refit a preset, so "live" would depend on which host ran
  the edit.
- Option 2 puts the parametric shape where the engine's other live shapes are (ADR 1047): the
  program is geometry the engine owns, like a star's inset; only its DrawingML encoding is
  Microsoft's, and that stays at the boundary. Vector editing is then the same on an Illustrator
  path, a PowerPoint preset or a Word shape.

The crate is `paged-preset-geom` (`engine/core/crates`, L2, pure Rust): the program types
(`CustomGeometry`, guides, paths, handles, sites), the evaluator, the live arithmetic (refit, handle
drag, connection sites, connector routing) and the 187 presets. `build.rs` compiles
`data/presetShapeDefinitions.xml` into a static table, so neither XML text nor an XML reader is in
the binary. `dml-geom` keeps the DrawingML side (`read`: `a:custGeom`; `place`: `a:xfrm`; `heads`)
and re-exports the evaluator under its old paths. `dml-geom`'s `the_table_is_annex_d` test reads
the XML with the DrawingML reader the modules used before and asserts that every preset's program
and text rectangle equal the table's, so every preset evaluates bit-identically.

- **The model** (`paged_model::live_shape`). `Polygon::preset: Option<PresetShape>`: the program's
  name, its adjust values as authored (`("adj", "val 16667")`, overriding the program's defaults),
  the box the outline is drawn for (`frame`, `[x, y, w, h]` in the item's own anchor coordinates),
  the flips (anchors mirrored within the box), the `part` the item draws (every path, the filled
  paths, or the stroke-only detail paths over a filled shape, which is a second item because one
  item has one paint), a `key` the items one shape was lowered to share, and for a connector its
  glued ends (`PresetConnector`: the item's `Self` and the site index). A shape's text frame
  carries `TextFrame::preset_text` (`PresetText { key }`); Word's anchored shapes carry
  `AnchoredFrame::preset`. Every field is `serde(default)` and absent when unset, so documents
  without presets write and hash as before. In the lead's words this is `LiveShape::Preset`: it
  sits beside ADR 1047's `Polygon::live_shape`, which keeps its `.paged` form untouched.
- **Live while the anchors are its shape** (ADR 1047's rule). `paged_preset_geom::model::live_preset`
  answers the preset only while the anchors are what the program draws for its box (fitted by
  least squares, `live::FIT_TOLERANCE`); a point edit ends it without a write and a stale preset
  reads as nothing. Rotation lives in the item transform, never in the anchors.
- **The writes** (`paged-mutate`, `apply/preset_shape.rs`). `frameShapePreset` (`Value::Text`, the
  preset as JSON) sets it and draws the anchors for it unless they already are what it draws; `""`
  ends it and keeps the path (Expand Shape). `frameShapePresetAdjust` merges adjust values and
  draws again. `frameShapePresetHandle` (`Value::PathPoint`: handle `address.index` to `position`)
  lets the engine solve the adjust values the handle sets (`live::drag_handle`, within the
  handle's range). After any write that moves or resizes an item (its path, transform, scale,
  rotation, flips or box) the engine follows in the same apply: a live preset on it is refitted
  (the scale moved out of the transform into the box and the program drawn again, so a rounded
  rectangle keeps its radius), its companions on the same box follow (detail items redrawn with
  their own part, text frames scaled with the box), and every connector glued to a moved item is
  routed again between its sites. Every inverse restores the touched items verbatim through the
  raw form of `frameShapePreset` (`{"restore": …}`, which neither redraws nor follows), so undo
  restores the model exactly (ADR 197). Anchored frames take the three writes (their box stays the
  box the text flow placed); their resize follows since amendment 1.
- **Reads.** `frameShapePreset` reads the live preset with its adjust handles (`handles`: position
  in the item's own coordinates, polar or xy, the values they move); `frameShapePresetAdjust`
  every adjust value of the program. Protocol 78, additive (three settable paths, 291 in all).
- **Handles in every module.** The host's live-shape overlay (editor ADR 310) draws a live
  preset's handles, yellow as in Office, under the Selection and Direct Selection tools in every
  module's context, and a drag commits one `frameShapePresetHandle` write. No module draws its own.
- **The boundary.** The pptx, docx and xlsx readers map `a:prstGeom` + `a:avLst` (and `a:stCxn` /
  `a:endCxn`) onto the fields; their writers write `a:prstGeom` + `a:avLst` back while the preset is
  live and `a:custGeom` otherwise. Office's line ends map onto the model's Office head (engine
  ADR 1093, amendment 2). IDML keeps the outline and stamps the preset in the item's
  `paged:liveShape` label, as ADR 1047 does for polygons; the reader lifts it back.
- **Migration.** A `.paged` document with slide ADR 717's labels is lifted once when it opens: the
  labels' preset, box and connector become the fields and leave the label. Slide's `live` follow,
  `live-presets.ts` and `adjust-handles.ts` are removed; sheet's `table-shapes.ts` keeps a shape
  across a refresh instead of drawing it again.

## Evidence

- `paged-preset-geom`: the evaluator's and the live arithmetic's tests, moved with them; `model`
  (draw, live, refit with the scale moved into the box, handles with flips, sites, routing, a short
  rounded leader line still live). `dml-geom`'s `the_table_is_annex_d` holds the build-time table to
  the XML as the DrawingML reader reads it, for all 187 presets and their text rectangles.
- `paged-canvas/tests/it/presets.rs`: set, read with handles and undo exactly; a scale refits and
  keeps the radius; adjust values and handle drags; a point edit and Expand Shape; a glued
  connector routed again; IDML and `.paged` keep the preset; a Word anchored shape takes a preset
  and a handle drag; Office heads and the text key undo exactly.
- slide: every conformance fixture lowers byte-identically (anchors, transforms, bounds) with the
  engine fields set; `pptx-export/tests/live.rs` drives the engine (move, resize, handle drag) and
  still matches PowerPoint's own result; `slide-native/tests/migrate.rs` lifts old documents.
  doc: `presets_and_adjust_values_survive_docx_to_paged_to_docx`. sheet: shapes kept across a
  refresh, `set_shape_preset` round trip.
- Real applications (2026-11-12): PowerPoint 16 opened the exported decks (an adjust value dragged,
  a resized rounded rectangle, connectors re-routed) without a repair prompt and saved them again
  with the presets and `adj = val 39259` intact; Word 16 opened the edited docx (triangle `val
  70000`, rounded rectangle `val 45000`, a reshaped rectangle as custom geometry) without a repair
  prompt and kept both presets and adjust values through its own save.

## Open questions

- Closed by amendment 1: the shaded face, and the follow of Word's anchored shapes.
- The one-time lift of slide ADR 717's labels writes one undo step ("Update shapes"): the host has
  no write outside the undo history (amendment 1, "Not done").

## Consequences

- Every host (the editor, the command line, scripts, the server) keeps an Office preset a preset:
  a resize keeps its corners, a connector follows its shapes, an adjust value or a handle drag
  redraws it, with exact undo.
- Doc, sheet and slide shapes are edited by the same host handles; vector editing is the same on an
  Illustrator path, a PowerPoint preset or a Word shape.
- The preset table is data in every wasm that evaluates presets (the engine's now, too); no XML
  reader or XML text ships for it.

## Amendment 1 (2026-11-12): shaded faces, Word's anchored shapes, the xlsx save

- **A shaded face is part of the preset.** One path item holds every filled path of a preset
  (`PresetPart::Fill`, or `All` for a shape without detail paths), shaded faces included. While the
  preset is live, `paged_preset_geom::model::contour_paints` names each contour's fill as the
  program says (`ContourFill`: `Norm`, `None` for a stroke-only contour, `Darken`, `DarkenLess`,
  `Lighten`, `LightenLess`) and its program path. The renderer (`text_path::preset_faces`,
  `emit_preset_fill`) fills the item's filled contours (a stroke-only contour of a whole preset is
  not filled), then each shaded path again under the even-odd rule, as PowerPoint fills a path,
  with the item's own paint shaded (`module::fill_paint_shaded`): every colour of the paint (a
  solid, a process colour, a gradient's stops) in sRGB through `ContourFill::shade_srgb`. A pattern
  or a mesh paints unshaded. Nothing is stored: the shade is a read of the live preset, so a point
  edit ends it with the preset, and documents write and hash as before.
- **The shade is PowerPoint's.** PowerPoint 16 (macOS) drew a cube, a can and an information
  button in seven fills (`C86432`, `4472C4`, `808080`, `FF0000`, `00FF00`, `FFFFFF`, `202020`),
  saved as PDF and sampled: `darken` is 60 % of each sRGB channel, `darkenLess` 80 %, `lighten`
  40 % of the way to white, `lightenLess` 20 % (`C86432` → lid `D3825A`, side `A15028`, can lid
  `DEA284`, button `784020`). The arithmetic is in sRGB, not in linear light, so it is applied to
  the paint, not composited over it.
- **Every module gets it.** paged.sheet's live items are the engine's parts now (`live_items`: one
  filled item, one detail item), so `can`, `cube` and every preset with several filled paths are
  live presets on the page. paged.slide already lowered a shape's filled paths as one item: its
  shaded faces now paint as PowerPoint draws them (the `connectors` fixture's can, the `geometry`
  fixture's 27 shaded presets). paged.doc's anchored shapes paint through the same path: an
  anchored frame whose outline is a live preset with shaded or stroke-only contours, or that has
  Office line ends, is drawn as the Polygon of its outline (`anchored::synthetic_path_item`).
- **Word's anchored shapes follow a resize.** `frameBounds` on a Word shape's anchored frame (its
  `Rectangle` id) takes the new size and keeps the box's top left, where the text flow placed it
  (`preset_shape::apply_anchored_bounds`); in the same apply a live preset is drawn again for the
  box scaled with it (a rounded corner keeps its radius) and any other outline is scaled with the
  box; the raw restore undoes it exactly. The frame reads its box (`frameBounds`) and its Office
  heads, and the canvas gesture resizes it by its handles (a move of an anchored object is the text
  flow's: a drag keeps it). The docx writer writes a resized shape's size as `wp:extent` and
  `wps:spPr/a:xfrm/a:ext` (EMU, the place keeping its top left) and its geometry only when the
  program, the adjust values or the outline changed (`docx-export` `shapes::Plan`); the doc bundle
  reads the frame's box back (`ShapeFrameRead.size`). A frame whose preset is not drawn for its box
  is refused with a ledger line.
- **The xlsx save holds the presets.** The sheet session writes the live presets of the placed
  shapes into the workbook's drawings (`writeShapePresets` → `SheetEngine.setShapePreset`) after a
  document change it did not make has settled, and before a `.paged` save (`onWillSave`), then
  marks the workbook for its next persist. Every save, the synchronous `saveWorkbook` and the
  persist included, then carries the edited preset and adjust values; the shape's size and place
  (its cell anchor) are still not written.
- **Not done: the slide lift outside the undo history.** It needs a host capability the contract
  does not have: a `document.mutate` option that applies a write without an undo step (probed, as
  `amend` is), an engine `Mutate` that does not record (refused unless the history is empty, or
  clearing it, so no earlier inverse runs on a state it was not computed for), and the editor
  host's plumbing between them. That is a plugin-contract change (a canary of plugin-sdk) and an
  engine protocol change, larger than this amendment and owned by the extension contract; until
  then the lift stays one named undo step, which an undo right after opening reverts.

### Evidence (amendment 1)

- `paged-preset-geom` `model`: a cube's faces paint `Norm`, `DarkenLess`, `LightenLess` while
  live and nothing once reshaped; a whole can leaves its rim unfilled; the shade arithmetic.
- `paged-renderer` `tests/it/preset_faces.rs` (CPU raster, one pixel per pt): a cube filled
  `C86432` shows `C86432`, `D3825A` and `A05028` on its front, lid and side, within 2 levels of
  PowerPoint's PDF; a reshaped cube paints plainly; a can's lid is `DEA284`.
- `paged-canvas` `presets::an_anchored_shape_refits_its_preset_when_resized`: twice as wide, the
  radius stays 10 pt, the box reads back, one undo restores preset, outline and box; its Office
  head is written, read and undone.
- `docx-export` `shapes::a_resized_shape_writes_its_size`; `docx-conformance` `shapes`: a resized
  ellipse saves its new extent and keeps its `a:prstGeom` byte for byte, and reads back with the
  size the canvas held.
- `sheet-js` `w3_shapes`: `can` and `cube` are a filled item and a detail item, both live, the
  filled one with shaded contours.
- Real applications (2026-11-13): Word 16 opened `docx-conformance` `shapes`' saved file
  (`PAGED_DOCX_EXPORT_DIR`) without a repair prompt, read the resized ellipse at 162 x 72 pt and the
  line's heads (oval, triangle) on the one line shape, and its own save kept `wp:extent`
  `2057400 x 914400`, the presets with their adjust values and `a:headEnd` / `a:tailEnd`. Excel 16
  opened `w3_shapes`' saved workbook (`PAGED_XLSX_EXPORT_DIR`) without repairing it, and its own save
  kept `roundRect` with `adj = val 40000`.

