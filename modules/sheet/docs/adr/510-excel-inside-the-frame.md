# ADR 510 — Excel inside the frame: a sheet frame is a window onto the sheet

- **Status:** Accepted, 2026-10-22. Amends [ADR 505](505-native-table-and-edit-grid.md).
- **Scope:** `sheet-grid` (`frame_window`), `sheet-js` (`get_frame_window`),
  `packages/sheet-host-model` (`binding.ts`, `grid.ts`), `packages/sheet-bundle` (`engine.ts`,
  `session.ts`), and later the host's frame surface.

## Context

ADR 505 put a fixed range on the page as a native table and edited it in a grid painted over
the frame. That grid had no row or column headings and no workbook formatting, always opened
the active sheet at A1 whatever the frame showed, kept its scroll position in memory only, and
sized its columns differently from the table under it (character units against text-measured
widths). The product goal is different: working in a sheet frame should feel like working in
Excel, and the frame should be a window onto the sheet, as frames are in a frame-based layout
program, not a snapshot of a range.

## Decision

A sheet frame shows the window of its sheet that starts at the top-left cell the user last
scrolled to. While the frame is being edited it is a full grid with headings; when the user
leaves, the window that fits the frame is written into the page as a native table.

- **One answer for which tracks are shown.** `sheet_grid::frame_window(model, sheet, spec)`
  takes the frame's top-left cell, the box the cells must fit (pt) and the frozen split, and
  returns the rows and columns in display order with their pt sizes: frozen tracks first,
  hidden and filtered rows skipped, whole tracks only, plus the first track past the edge that
  is partly visible. The live grid (with the heading strips taken off the box) and the page
  lowering (the whole box) both ask it, so they cannot disagree.
- **Whole columns on the page.** A native table cannot clip a column, so the page shows whole
  tracks. The live grid draws the partly visible track greyed past a hairline print edge.
- **The binding carries the view (envelope v2).** `{sheet, range, contentVersion, table?,
  view: {topLeft, lock}, print: {headings, gridlines}, freeze?, sizing}`. `range` stays the
  range the page table shows now. `view.topLeft` is where the window starts; with `lock` set,
  leaving the frame snaps back to it. `print` turns headings and gridlines on for the page (off
  by default, as Excel prints). `sizing: "window"` sizes the table from the sheet's own column
  widths; `"fit"` is the earlier measured-width, fixed-range behaviour.
- **Migration.** A v1 envelope is read as v2 with `view.topLeft` at its range's top-left,
  `lock: true` and `sizing: "fit"`, so a frame placed before this keeps exactly what it shows.
  A plugin version before this one does not read v2 and treats such a frame as a plain table.
- **The grid follows the binding.** Entering a frame opens its bound sheet (made the active
  sheet) at its view's top-left cell.
- **Leaving keeps the work.** When the edit context ends because the selection moved to
  another item, the host now runs the context's commit before its exit, as a click outside
  does (`exitAll({ commit: true })` in the editor's edit-context stack).

## Consequences

- The page lowering moves to `frame_window` with `sizing: "window"` frames; until then new
  frames are placed with `sizing: "fit"`.
- Column widths in character units need Excel's max-digit-width rule measured with the
  document's default face to match Excel exactly; until then the 5.25 pt per character constant
  stays.
- Frozen rows on the page become table header rows, which needs a lowering over
  non-contiguous tracks.
- Later work replaces the scene-layer grid with a host frame surface; the window model above
  does not change with it.
- The live grid scene stands on `frame_window` and takes its styles through the page
  lowering's per-cell styler (`sheet_lower::CellStyler`), so the two surfaces share the tracks
  and the style table. The scene's viewport names the shown tracks (`rowIndices`/`colIndices`,
  frozen ones first) and `firstRow`/`firstCol` the first body track; a consumer finds a cell's
  position through the index arrays, never by subtracting `firstRow`. Merged areas are drawn
  from the anchor cell, also when the anchor is scrolled out of the window.

## Amendment (2026-10-23): the page side of the window

When the user leaves a frame, the window it shows is written into the page as a native table
that looks as the grid did.

- **One lowering over explicit tracks.** `sheet_lower::lower_tracks` lowers the rows and
  columns it is given, in display order: frozen tracks first, gaps allowed. A frame's page is
  `sheet_grid::frame_page` = `frame_window` + `lower_tracks` (wasm `get_frame_page`,
  `get_tracks_page`; TS `getFramePage`, `getTracksPage`). Widths and heights are the sheet's own
  pt sizes (`sheet_lower::col_width_pt` / `row_height_pt`, which the grid uses too); text
  measurement stays only for `sizing: "fit"` frames.
- **Sheet indices on the page.** A frame page's rows, columns, cells, merges and data bars carry
  sheet indices (a range lowering keeps its range-relative ones). The printed heading row and
  column carry `HEADING_INDEX` (`u32::MAX`). A refresh aligns tracks by these indices.
- **Print options.** Printed headings add a heading row (A, B, C…) and a heading column
  (1, 2, 3…) as Excel prints them, boxed, without fill; their strips are taken off the frame's
  box before the window is asked, so the printed table still fits. Printed gridlines are an
  option (off unless the binding's `print.gridlines` is set), broken across merged areas as in
  the grid.
- **Frozen rows are header rows.** The frozen rows shown, plus the printed heading row, are the
  table's header rows (`headerRows`, passed to `insertTable`), so they repeat on continuation
  frames.
- **Merges per pane, anchor on the corner.** A merged area becomes one span per pane (frozen
  band and body), as in the grid; a span whose anchor is clipped away starts at its first shown
  cell, and that cell carries the anchor's text, alignment and style.
- **Same window, same cells.** For random sheets with hidden tracks, merges, conditional
  formats and frozen splits, the page without headings equals the grid scene of the same spec
  track by track (`sheet-grid/tests/parity.rs`).
- **Refresh in place.** `tableRefreshOps` aligns columns by index (as it aligns rows), so a
  horizontal scroll by k columns costs k deletes and k inserts and re-pours only the new cells;
  the header band grows and shrinks at its top (`insertHeaderRow` / `removeHeaderRow`); when more
  than 60 % of the cells would be re-poured it answers `replace`, and the caller writes a new
  table instead.
