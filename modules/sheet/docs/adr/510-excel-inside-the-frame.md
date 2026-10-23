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
