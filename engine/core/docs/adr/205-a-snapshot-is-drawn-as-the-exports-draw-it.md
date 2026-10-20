# ADR 205 — A snapshot is drawn as the exports draw it; only the canvas shows its markers

- **Status:** Accepted 2026-10-20.
- **Scope:** `RequestSnapshot.markers` (`crates/paged-canvas/src/channel.rs`, additive on protocol
  74); `snapshot_page` / `render_snapshot_png_hiding` and `SnapshotPage::Export`
  (`crates/paged-canvas/src/snapshot.rs`); `CanvasModel::{live_build_has_markers,
  live_build_is_export_faithful, export_build}` (`crates/paged-canvas/src/model.rs`); the
  snapshot handlers of `paged-canvas-wasm` (`dispatch.rs`, `renderSnapshotGpu`,
  `renderPageVelloPng`); the CLI's `paged render` and session snapshot; the editor client's
  `requestSnapshot(pageId, widthPx, dpi?, { markers? })` and the page thumbnails.

## Context

Since the degraded-asset markers landed (A3/A4), the interactive canvas build sets
`PipelineOptions::degraded_asset_markers`: text set in a substitute face gets a pink highlight
behind it, and a frame whose inline EPS/PDF cannot be drawn gets a stroke-only cross. They are
ordinary commands in the page's display list, emitted while the page is built.

A snapshot drew `CanvasModel::page`, the live build's page, so every snapshot carried them. The
snapshot backs more than the canvas: the Page images (PNG) export, the canvas fidelity gate, the
eyedropper, the assistant's page renders, `paged render`, plugins' page images and the journey
drivers. Exported PNGs carried the pink, and with the fidelity gate reading its thresholds again,
6 of 15 gated packs failed on it. The PDF export never did: it builds the document once more with
`PipelinePurpose::Export`, which leaves the option at its default `false` (and renders the working
space at full resource resolution, ignoring the soft proof).

The markers are part of the canvas, not of the document. Stripping them out of a live display list
afterwards is not reliable: the emit caches re-append cached command ranges, so a command's
position does not say which emit produced it.

## Decision

1. **`RequestSnapshot` takes `markers: bool`, default `false`.** `false` draws the page as the
   exports draw it: no markers, the working space, full-resolution resources. `true` draws the page
   the canvas shows, markers and soft proof included. The field is optional on the wire (governance
   rule 1, no protocol bump): a client that never sends it, which is every client before it existed,
   gets the clean page.

2. **The default is clean because only the canvas wants the markers.** Every consumer of a snapshot
   other than a view of the canvas writes a file, compares pixels or reads colours, and a marker is
   wrong in all of those. The one view of the canvas that goes through `RequestSnapshot`, the page
   thumbnail in the shell, asks for `markers: true`. The worker's tile loop (`renderTilePng`,
   `render_snapshot_png`) keeps drawing the live page: it is the canvas.

3. **A clean snapshot reuses the live page when it already is clean.** When the live build painted
   no marker (it reported neither `FontSubstituted` nor `ImageContentUnrenderable`), no soft proof
   is active and resources are served at full scale, the live page is what an export draws and no
   second build is made. The check is per document: a page without substituted text in a document
   with some counts as marked, which costs a build and never a wrong pixel.

4. **Otherwise the model builds the document for export once per build generation.**
   `CanvasModel::export_build` makes the same build the PDF export makes and keeps it until the next
   rebuild drops it, so a PNG export of every page pays one build, not one per page. A snapshot
   with items hidden (`hideItems`) was already built for export and stays so; `markers` changes
   nothing there.

5. **`renderPageVelloPng`** (the fidelity suite's GPU lane) draws the export page too.

## Consequences

- PNG exports, `paged render`, the eyedropper, the assistant's renders, plugins' page images and
  the fidelity gate no longer carry the pink highlight or the cross.
- On a document with a substituted face or an undrawable EPS/PDF, the first clean snapshot after an
  edit costs one document build, and the model holds a second `BuiltDocument` until the next edit.
- The page thumbnails still show the markers; the canvas is unchanged.
- The ink coverage collection still reads the live build. The pink is an RGB paint, so it counts as
  *unknown* ink rather than as coverage; it lowers `separated_pct` on a marked document.
