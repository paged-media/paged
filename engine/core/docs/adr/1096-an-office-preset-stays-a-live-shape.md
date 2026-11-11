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
  box the text flow placed); their move and resize follow is left to later work.
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

## Open questions

- A shaded face (`darken`, `lighten` paths of ribbons, action buttons, curved arrows) is still drawn
  as its own item by the modules that draw it; a per-contour paint mode in the engine would make
  it part of the preset.
- Anchored frames (Word) take the preset writes and reads but not the follow after a move or
  resize; a resized Word shape is redrawn by the docx lowering, not refitted by the engine.

## Consequences

- Every host (the editor, the command line, scripts, the server) keeps an Office preset a preset:
  a resize keeps its corners, a connector follows its shapes, an adjust value or a handle drag
  redraws it, with exact undo.
- Doc, sheet and slide shapes are edited by the same host handles; vector editing is the same on an
  Illustrator path, a PowerPoint preset or a Word shape.
- The preset table is data in every wasm that evaluates presets (the engine's now, too); no XML
  reader or XML text ships for it.
