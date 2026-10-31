# ADR 364 — Interchange rides the engine's doors: one SVG reader and writer, DXF through SVG, AI and EPS through the host

- **Status:** Accepted 2026-10-28.
- **Scope:** `packages/draw-bundle/src/io/{svg,dxf,vector-files}.ts`, `src/interchange-wasm.ts`,
  `src/actions.ts` (recolor, the trace's SVG), `src/target-page.ts`; `crates/draw-dxf` (new),
  `crates/trace-js` (its DXF and SVG-paint exports); `packages/draw-geometry` (`svg-doc.ts` and
  `orientForFillRule` deleted). Engine side: `paged-svg`'s `paint` module and named groups (core
  ADR 1031, amendment 2026-10-28). Amends [ADR 357](357-image-trace-rust-lane.md). Work package
  WP6.10 of the image/draw plan (gaps D-58, D-59, D-60, D-61, D-64; plan item C9).

## Context

The engine reads and writes SVG for every module since core ADR 1031 (`paged-svg` over usvg:
`document.importSvg`, `document.exportSvg`). paged.draw still carried its own TypeScript reader
and writer (`draw-geometry/src/svg-doc.ts`, 600 lines, plus 900 lines of lowering in
`io/svg.ts`) as the fallback for an engine before protocol 77, and three more things leaned on
them: the `recolor` action (an SVG asset in, an SVG asset out) parsed and re-wrote the file, the
`trace` action wrote its result with the same writer, and an editor test planned the showcase
crest through it. The fallback had a known bug: a compound shape it could not land whole (no page
origin, or a refused contour) was split into one path per contour, its holes painted. It also
gave every stroke-less shape a 1 pt black hairline. And it was a second SVG reader, which plan
item C9 rules out.

DXF, Illustrator and EPS had no door in the module at all. The host has since gained Open/Place
PDF and AI as vectors (paged.pdf, publish ADR 658) and draws placed EPS from its PostScript
(`paged-ps`, core ADR 1033).

## Decision

1. **SVG is the engine's, only.** The `.svg` importer hands the file to `document.importSvg`
   (one batch, one undo step; the report logged row by row), the exporter asks
   `document.exportSvg` for what the selection draws. On a host without the doors neither is
   registered and the log says why. `svg-doc.ts`, the TypeScript lowering and its specs, and
   `orientForFillRule` (the winding rule for an engine without an element fill rule) are
   deleted. The compound-shape bug goes with them: `paged-svg` lands a shape of several contours
   as ONE element with its fill rule (`a_ring_is_one_compound_element_with_its_hole`, and
   `interchange.spec.ts` on the real engine). Nothing draw-specific rode the old writer (it wrote
   paths and solid paints), so nothing draw-specific is lost; a named `<g>` now names its group.
2. **Recolouring rewrites colours in the source.** The `recolor` action asks `paged-svg::paint`
   (in the draw wasm) for the colours a file declares — fills, strokes, gradient stops, `style`
   attributes and `<style>` rules — and for the same file with them replaced. Every other byte is
   kept, so gradients, CSS, `<use>` and text survive a recolour; the old action flattened the file
   to one solid path per shape. The `trace` action writes its own two kinds of path (an even-odd
   fill, an unfilled stroke) with the path-data writer; that is the trace's output, not a
   document writer.
3. **DXF goes in and out through SVG.** `crates/draw-dxf` (the `dxf` crate, MIT) reads a
   drawing's model space into an SVG document — LINE, LWPOLYLINE and 2-D POLYLINE (bulges as
   arcs), CIRCLE, ARC, ELLIPSE, SPLINE (cut into its Bézier pieces by knot insertion: exact for
   degree ≤ 3, Hermite cubics through points and tangents for rational or higher-degree pieces),
   INSERT (block references, arrays, eight levels), and SOLID HATCH as a filled path of its
   boundary loops (read from the group codes: the `dxf` crate models no HATCH, and Illustrator
   writes every fill as one) — one named group per layer, file order as paint order, true
   colours and the AutoCAD index colours, line weights, `$INSUNITS` (unitless as millimetres,
   as Illustrator reads it), y flipped. The importer lands that SVG through `importSvgFile`.
   Every other entity type, and a pattern hatch, is reported by name and count — including the
   types the `dxf` crate skips while reading, counted from the file's own ENTITIES section. The exporter takes
   `document.exportSvg` (the selection, else the page) and walks it with `paged-svg`'s one walker
   into DXF entities in millimetres: LWPOLYLINE for a straight contour, a cubic SPLINE with its
   Bézier pieces as control points (the same curve, exactly) for a curved one, the stroke's
   colour as a true colour with the nearest index colour, the width snapped to DXF's weights, a
   top-level named group as a layer. Fills (DXF lines carry none), gradients, dashes, opacity,
   clips, masks, filters and images are reported.
4. **AI and EPS ride the host's doors.** The `.ai` importer runs paged.pdf's typed command
   `media.paged.pdf.placeVectors` through the shared object registry (an Illustrator file with
   PDF compatibility is a PDF; publish ADR 658), its losses logged; without paged.pdf it refuses
   by name. The `.eps` importer places the file in a frame of its `%%BoundingBox` (the engine
   draws it with `paged-ps`), asks `document.exportSvg` for what that frame draws, undoes the
   placement while it is still the last step, and lands the SVG through `document.importSvg`:
   editable paths in one undo step. Where the export draws nothing, the EPS stays placed and the
   log says so. Neither importer reads the format itself.
5. **The draw wasm carries the interchange.** `trace-js` exports `dxfToSvg`, `svgToDxf`,
   `svgColors` and `svgRecolor` beside the trace (`interchange-wasm.ts` is their facade; one
   artifact, one instance per realm). This amends ADR 357's "one Rust lane": the second Rust
   capability is format I/O over existing crates, the same reason the trace is Rust.

## Consequences

- The draw wasm grows from about 198 KB to 1.31 MiB (the `dxf` crate's generated entity, table
  and header model is most of it; usvg's parser and the paint reader the rest), under the
  manifest's 2 MiB cap. A trace worker boots the larger artifact too; splitting the interchange
  into its own artifact is a follow-up if that start-up cost shows.
- An imported stroke-less SVG shape has no stroke (it had a black hairline); the round-trip
  recording's SVG case and the perf budgets were moved to the engine lane.
- An `.eps` import costs one placement, one export and one undo before the import: the undo log
  shows one step, and a redo after it is gone (the import is a new edit).
- Every SVG now reaches the engine, so the engine's limits are the module's: the SVG door
  carries the bytes as a JSON number array, and a 96 MB file makes the engine's allocation
  panic and leaves its wasm instance unusable (found by the real-corpus lane handing it a large
  `.ai`). `importSvgFile` refuses a file over 32 MB before it reaches the door; the door taking
  bytes and refusing an oversize file itself is an engine follow-up.
- Lottie export (P3) is not built: a single-frame Lottie from the export's SVG is a follow-up.
- The Illustrator oracle (`scripts/illustrator/probes/interchange-open.jsx`, recorded with
  Illustrator 30.1, replayed by `crates/draw-dxf/tests/illustrator_oracle.rs`): Illustrator
  opens the SVG the exporter writes and reads all four test paths exactly (bounds within
  0.05 pt, paints exact); paged.draw reads the DXF Illustrator exports exactly (geometry,
  colours, its SPLINE and CIRCLE, its layer as a named group, its fill from the HATCH, which is
  why HATCH is read; stroke widths within the 0.01 mm line-weight steps). Illustrator writes a
  filled shape's boundary as an uncoloured LWPOLYLINE beside the hatch, so it arrives outlined
  in black too. Illustrator opening paged.draw's DXF is NOT recorded: its DXF/DWG Options
  dialog cannot be filled in or kept shut from a script (no `OpenOptionsAutoCAD` constructor,
  `app.open` refuses the preference object, a suppressed dialog cancels the open, placing
  refuses the file). The export's readability rests on the round trip through the `dxf`
  crate and the importer, and on a manual check in Illustrator, which is a follow-up.
