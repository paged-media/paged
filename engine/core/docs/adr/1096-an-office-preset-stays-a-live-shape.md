# ADR 1096 — An Office preset stays a live shape

- **Status:** Proposed 2026-11-11. Not built: it waits on the owner's choice of where the geometry
  program is evaluated (below). Extends [ADR 1047](1047-live-shapes.md).
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

## Decision (proposed, option 2)

- **The model.** A path item (`Polygon`) gains `preset: Option<PresetShape>`: the preset's name,
  its adjust values as authored (`adj`, `adj1`, … with their values), the box the outline was
  drawn for, the flips, and for a connector the two glued ends (the item and the site index).
  `serde(default)`, absent when `None`, so documents without presets write and hash as before.
- **Live while the anchors are its shape** (ADR 1047's rule): the reads answer the preset only
  while the anchors are what the program makes for the stated box under an axis-aligned scale
  (the refit of slide ADR 717, 0.05 pt). A point edit ends it without a write.
- **The writes.** A resize of a live preset is refitted in the same apply: the program is drawn
  again for the new box, so a rounded rectangle keeps its radius. `frameShapePresetAdjust` sets
  one adjust value (or all of them) and redraws; `frameShapePreset` sets or clears the preset
  (clearing is Expand Shape). The inverse is a batch, as for the polygon writes, so undo restores
  the model exactly. A connector glued to an item is routed again when that item moves, in the
  same apply.
- **Handles.** The adjust handles are an engine read (position, polar or xy, the values they
  move); the host draws and drags them through the handles door (`overlay.handles@1`, extensions
  ADR 339 and 1103) for every module, and a drag writes `frameShapePresetAdjust`.
- **The boundary.** pptx, docx and xlsx readers map `a:prstGeom` + `a:avLst` (and `a:stCxn` /
  `a:endCxn`) onto the field; their writers write `a:prstGeom` from it while it is live and
  `a:custGeom` (`dml_geom::place::cust_geom`) otherwise. IDML keeps the outline and stamps the
  parameters in a label, as ADR 1047 does for polygons.
- **Migration.** A `.paged` document with slide ADR 717's labels is lifted on open: the label's
  `preset` and `box` become the field and the label is dropped, as IDML's `paged:liveShape` is.
  Slide's `live` follow, `live-presets.ts` and `adjust-handles.ts` are then removed; sheet's
  `table-shapes.ts` stops drawing shapes again on refresh.

## Open questions for the build

- A preset with a stroke-only detail path (a cube's edges, a can's lid) is two items in slide
  today, since one engine item has one paint. Either the preset lives on the filled item and
  owns its detail item (redrawn with it), or the engine draws a per-contour paint mode
  (`darken`, `lighten`, no fill), which also covers the shaded faces slide now draws as separate
  items.
- The text rectangle (`a:rect`) of a preset places the shape's text frame; whether the frame
  follows a refit through the engine or stays a companion item.

## Consequences

- Once built, every host (the editor, the command line, scripts, the server) keeps an Office
  preset a preset, and doc and sheet shapes get adjust handles from the host's Selection tools.
- Until the owner chooses, slide keeps its metadata mechanism, doc and sheet draw presets once.
