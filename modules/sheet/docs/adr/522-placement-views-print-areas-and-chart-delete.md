# ADR 522 — Placement kinds: a frame's view and sizing, print areas of several ranges, a deleted chart leaves the file

- **Status:** Accepted, 2026-10-23. Extends [ADR 510](510-excel-inside-the-frame.md) (the frame
  window, placed by command) and [ADR 503](503-xlsx-patched-not-regenerated.md) (what a save
  writes); builds on [ADR 519](519-charts-excel-parity.md) (charts and where they live in the
  package).
- **Scope:** `sheet-xlsx` (`structure.rs` `remove_chart_parts`, `parts/chart.rs`),
  `sheet-lower` (`paginate_sequence`), `sheet-js` (`print_areas`, `paginate_areas`,
  `chart_tombstones`, `restore_chart_slots`, `define_name` for a print area of several ranges),
  the bundle (`layout-commands.ts` `place`, `session.ts`, `lower.ts`, `lower-chart.ts`,
  `object-model.ts`, `workbook-part.ts`), `sheet-host-model` (`binding.ts` `box`).

## Context

The typed `place` (plan G4) put a range, a defined name or a print area on the page and
`deleteChart` took a chart out of the workbook. Four things were left: `place` could not say what
a frame shows (its view, printed headings and gridlines, how it is sized), a print area of
several ranges could not be placed, a chart read from the xlsx stayed in the saved file (the
delete was only replayed from the chart journal on load), and the art an undone `deleteChart`
brought back — like every chart placed in an earlier session — was not refreshed by later edits.

## Decision

1. **`place` places a view.** `place { …, sizing, box?, view?, print? }`:
   - `sizing: "window"` (the default) is ADR 510's window frame, the size of the range in sheet
     tracks; with `view.topLeft` it shows the window of that size that starts at that cell.
   - `sizing: "fixed"` is a window frame whose box (`box: { width, height }`, pt) the caller
     gives: the frame is that box (only a column whose text would wrap still widens it, as for
     every window frame) and the table the window that fits it.
   - `sizing: "fit"` is the earlier fixed range with text-measured widths; it takes no view.
   - `view.lock` pins the window (leaving the frame snaps back to it); `print.headings` and
     `print.gridlines` print Excel's headings and gridlines.
   The binding records all of it (envelope v2 as ADR 510 defined it; `"fixed"` is recorded as a
   `"window"` frame, the box being the frame's geometry). What cannot be combined is refused
   before anything is written: a view on a `"fit"` frame, a box without `"fixed"`, a view on a
   chain (a chain paginates its range) or on a defined name (it is placed by name).

2. **A print area of several ranges is placed area by area.** Excel stores it as one formula
   (`Sheet1!$A$1:$C$5,Sheet1!$E$1:$F$3`); `print_areas` splits it at its top-level commas and
   resolves each area, a whole column or row cut to the sheet's used cells. `place { source:
   "printArea" }` places one table per area, in order, each in its own frame (the next one 12 pt
   under the one before; one undo step each). With `chain`, the areas paginate in sequence
   (`paginate_sequence`): each with its own header band, the next one starting in the room the
   one before it left in its last frame when that room holds its header band and first row, else
   on the next frame — one batch, one undo step. `define_name` accepts a print area of several
   ranges on one sheet and writes it as that formula.

3. **A deleted chart leaves the saved xlsx.** On save, a chart read from the file and deleted
   since is taken out of the package by byte splices: its anchor in the drawing (the one drawing
   element whose `<c:chart r:id>` names it, a whole `mc:AlternateContent` when it is wrapped),
   the drawing relationship, the chart part and the parts only it reached (its style and colour
   parts, an embedded workbook) with their content-type overrides. Every other part, and every
   other byte of the drawing, its `.rels` and `[Content_Types].xml`, stays as it was. A
   chartsheet's chart stays (the tab is the chart; the delete replays from the journal).

4. **Indices survive the save: tombstones.** Charts are named by index (placements, the chart
   journal, template fields), and an index of a chart read from a file is its position there. The
   deleted slot stays in the session; the slots the saved bytes no longer carry
   (`chart_tombstones`) are stored with the bytes — in a version's metadata (`chartSlots`) and
   beside the workbook part (`workbook.chart-slots.json`, keyed to the bytes it belongs to) — and
   re-opened right after a load (`restore_chart_slots`), before any chart op replays, so every
   other chart is back at its index. A journal delete of a re-opened slot is skipped.

5. **Placed charts are tracked again from the page.** A placed chart's binding records its box
   (`box: [top, left, bottom, right]`). After every document undo or redo (the object model's
   version follow) and when a document is opened, the session reads the scene tree: every chart
   copy it does not track is tracked at its recorded box (a chart placed before the box was
   recorded at the extent of its elements), with the geometry it shows now, so the next edit that
   changes the chart redraws it; tracked art that left the page is dropped. A copy of a chart the
   workbook no longer has is left alone.

## Consequences

- A view placed through `place` is the frame the editor makes: entering it opens the grid at its
  view, leaving it refreshes it, a resize re-windows it (ADR 510).
- Each area of a print area placed without a chain is its own undo step.
- A workbook saved by an older version and reopened by this one has no tombstones; nothing
  changes for it. An older version opening bytes this one saved after a delete sees the later
  charts one index lower (it does not read the slots).
- A chart moved on the page is redrawn at its recorded box (as charts placed in the same session
  always were). Amendment 1 lifts this, and the single-step and chain limits above.

## Amendment 1 (2026-10-23): charts follow their art, one step per print area, chains are rediscovered

1. **A chart follows its art.** The binding of a placed chart also records `art`: the page-space
   outline of the element that carries it (its first element), as the batch draws it. A refresh
   reads where that element stands now (`elementGeometry`, through its composed transform, so a
   moved or scaled group is seen) and carries the box along: moved by the art's offset and, on an
   axis where the art has an extent, scaled by its change of size (a label frame, which sizes
   itself to its text, is followed by its top-left only). The chart is redrawn where it stands,
   and its new binding records the box and art it was drawn at. A later session does the same
   from the recorded box and art, so a chart moved before the document was saved is redrawn where
   it was moved to.
2. **A chart placed before its box was recorded gets one on discovery**: the outline of its
   elements, with its first element's outline as its art, so it follows moves and redraws like a
   new one; its next redraw writes both into its binding. Discovery itself writes nothing: on
   open it would be an undo step of its own, and after an undo it would clear the redo stack.
3. **A print area placed without a chain is one undo step.** Every area's frame, binding, native
   table, cell pour, data bars and text styles go in ONE batch (`lowerAreasToFrames`), each frame
   and table named by its in-batch handle (`f<i>`, `t<i>`) and placed under the one before, and
   every document resource two areas both mint is minted once (the mint-dedupe rule: a second
   mint of an id fails the whole batch). A host without in-batch handles refuses the batch and
   the areas are placed one by one, as before.
4. **A paginated chain records itself.** The chain's first frame carries a binding with `chain:
   { areas?, repeatHeaderRows, tables: [{ tableId, hash, widths }] }` — the source (its sheet and
   range, or the areas paginated in sequence), the repeated rows and the tables the last pass
   left in story order. The table ids exist only after the write, so the record joins the
   pagination's undo step through `mutate(…, { amend })` (engine ADR 1004); a pass that refreshes
   its tables in place (a reflow, an edit) carries it in its last changed table's batch instead,
   and a pass that changes nothing writes nothing. On open the session subscribes every recorded
   chain as `paginateSelection` does: a resize reflows it and an edit refreshes its tables in
   place, from the recorded tables when their hashes are what the workbook paginates to now; a
   chain whose tables no longer match is replaced on the next refresh (its tables deleted, the
   range paginated afresh). A chain's first frame is not a sheet frame (the `sheetFrame` object
   type skips a chain binding), so it is still edited as text.

Consequences: a host that cannot amend an undo step keeps no record of a first pagination (the
chain stays live for that session only); a chart placed by the version just before this one has
a box but no art, and a move made to it before reopening is not followed.
