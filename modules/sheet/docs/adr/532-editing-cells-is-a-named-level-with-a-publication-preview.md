# ADR 532 — Editing cells is a named level, left by Done, with a publication preview of the selection

- **Status:** Accepted, 2026-11-14. Extends 510 (the frame is a window onto its sheet) and 024 (no
  canvas tool edits a spreadsheet).
- **Scope:** `sheet-bundle/src/activate.ts` (the `sheet` context's `editLabel`),
  `src/surface/edit-cells-strip.tsx` (new: the bar's first row and the preview card),
  `src/surface/sheet-frame-surface.tsx` (the bar mounts it; its words come from the locale),
  `src/publication-preview.ts` (new: the counts), `session.ts` (`publicationPreview`),
  `src/panels/format-section.tsx`, `src/panels/workbook-panel.tsx`, `src/surface/data-cards.tsx`
  (the host's numeric field); the editor's `frameLevels` (`editLabel`, extensions ADR 1108). Task
  CM5 of the editor's interaction plan; the UX strategy's §7.3; the UX audit's F-42; the
  interaction specification's §10.4, `UXI-T38`.

## Context

A selected sheet frame offered the levels Frame and "Spreadsheet": the second named the context,
not what entering does. Inside, the grid was Excel in the frame — the active cell, ranges,
formulas, fill, the sheet tabs, row and column actions, its own undo journal (ADR 510) — but the
bar over it never said which mode this was, and the only way out was Escape or a click outside.
A spreadsheet has no notion of a page: nothing told the user that the rows below the frame's edge
would not print, so a selection could be edited, formatted and checked without any sign that half
of it never reaches the publication (the strategy's "publication preview of selected cells"). The
workbook panel, its format section and the Top 10 filter card typed numbers into raw
`<input type="number">` fields, outside the editor's one numeric field (editor ADR 1216).

## Decision

1. **Frame → Edit cells.** The `sheet` context declares `editLabel: "Edit cells"` (extensions ADR
   1108): the selected frame's level control reads **Frame · Edit cells**; the breadcrumb keeps the
   context's name, "Spreadsheet". The double-click, Enter and the level control enter the same
   context; none moves the camera or resizes the canvas (editor ADR 1215).
2. **The bar says the mode and has the way out.** Its first row reads **Editing cells** (with what
   the keys do as its hint) and ends with **Done**: a cell still being typed is committed, as
   Enter would, then the context is left through the host's exit with `commit: true` — the same
   resolution as Escape on a clean grid (`commit-if-safe`, editor ADR 1214). The frame stays
   selected and the camera stays where it was.
3. **The grid owns its keys.** Unchanged and now asserted: typing edits the active cell, the
   arrows move it, Tab and Enter commit and move, Cmd/Ctrl+Z inside undoes the workbook's cell
   edit (the session's journal) and never a document step; the frame is never nudged. Leaving
   lands the session's edits on the page as the document's step.
4. **Publication preview.** While a placed frame is entered, the session answers
   `publicationPreview()`: the selection's current area against what the page prints when the
   frame is left — a window frame's page windows (`pageWindowsOnLeave`, the rule leaving applies,
   one per frame of a chain) or, for a fitted range, the laid-out tracks of its table that fit the
   frame's content box after a printed heading. The counts are pure index arithmetic
   (`publication-preview.ts`); which tracks fit stays Rust's (`get_frame_window`) or the
   lowering's. The bar shows **Prints in the frame**, or a warning with the count of rows and
   columns that do not print (`role="status"`). **Print preview** opens a card with a schematic of
   the frame's printed cells and the selection — cells that print, cells that do not — and one
   line per overflow: rows below the frame's edge, columns past its right edge, rows above or
   columns left of the frame's window. The preview reads; it never writes the document.
5. **One numeric field.** The column width (characters), the row height (a length: "12 pt",
   "5 mm"), the paginate header rows, the sort key column and the Top 10 count are the host's
   `NumericField` (editor ADR 1216; the frame surface's cards get it through
   `makeSheetFrameSurface(session, host.widgets)`). Enter or leaving the field applies a width or
   height: the separate "Set width" and "Set height" buttons are gone. The three files leave the
   `raw-number-input` baseline.
6. **Words from the locale.** The bar's words (the mode, Done, the preview, the full-screen
   header, the cell editor's ✕ and ✓, the formula field) are messages with German.

## Conformance (interaction specification §21.3)

| Item | How |
|---|---|
| Owner and focus | The frame surface owns pointer and keys inside the frame; its cell editor has focus on entry. |
| Entry and exit | Double-click, Enter, the level's **Edit cells**; Escape, **Done**, a click outside, another tool (editor ADR 1214). |
| Cursor | The surface's own (cell, move border, fill handle, heading resize). |
| Preview, commit, cancel | A cell edit commits on Enter, Tab or Done; Escape cancels a cell being typed, then leaves. The publication preview never writes. |
| Undo | Inside: the session's journal, one step per cell edit or bulk action; on leaving, the page refresh is the document's step. |
| Permission refusal | The context's writes go through the session's doors, which the engine's role policy refuses (no write without the role). |
| Keyboard alternative | Every action of the bar has its key (Escape for Done, Enter for ✓); the preview's status is announced. |

## Consequences

- `UXI-T38` (`tests/e2e/uxi-module-conformance.spec.ts`) enters by **Edit cells**, types into a
  cell, moves with the arrows without nudging the frame, undoes inside without a document step,
  sees the warning for a selection extended past the frame, leaves by **Done** with the camera
  unchanged and finds the value on the page.
- `test/publication-preview.spec.ts` holds the counts (windows, overflow, scrolled windows,
  chains, fitted ranges); `test/frame-surface.dom.test.tsx` the strip and the card.
- The UX audit's F-42 is closed: the frame enters on a double-click, the grid shows a cell cursor
  and the keys edit cells in the frame; the bar says so and how to leave.
- The page still prints only what the frame's box holds; the preview says so, it does not grow
  the frame. Growing or threading a frame to fit stays the user's (Paginate, a resize).
