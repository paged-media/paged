# ADR 1025 — Word tables: rows split across frames, autofit columns, indent and exact rows

- **Status:** Accepted 2026-10-30.
- **Scope:** protocol v78 rider (optional on the wire, skipped in the model when unset). Part
  of the paged.doc Word-parity program (doc wave W4).
  - `paged-model`: `Table.word` (`WordTableLayout`: `indent`, `autofit`, `width`,
    `cell_widths`, `cant_split_rows`), `TableWidth`, `CellWidth`.
  - `paged-mutate`: `NodeSpec::Table.word` (`WordTableSpec`, `TableWidthSpec`,
    `CellWidthSpec`); `Operation::SetRowHeight.auto_grow` and the inverse-only
    `clear_auto_grow`.
  - `paged-wire`: `insertTable.word`; `setRowHeight.autoGrow`.
  - `paged-renderer`: `pipeline/tables.rs` — the split in `emit_table` (`segments`,
    `CellBlock::advance`, the window each piece of a row draws), `word_column_widths`,
    `cell_paragraph_widths`, the indent in the table's line shift.
- **Builds on:** ADR 176 (nested tables), the row rules measured on InDesign in
  `tables_rows_pipeline` (a row never splits; `AutoGrow`, `MaximumHeight`,
  `KeepWithNextRow`, Start Row), ADR 1050 (cells reach nested tables and pictures).

## Context

InDesign never splits a table row: a row that does not fit moves to the next frame, and one
taller than any frame is overset. Word splits a row at the page's end, each cell continuing its
lines on the next page under the repeated header rows, unless the row says `w:cantSplit`. The
DOCX lowering worked around the difference by pouring any table with a row certainly taller
than a page as plain paragraphs (`flow_table`), losing the table. Word also fits an autofit
table's columns to their content, indents a table by `w:tblInd`, and holds an `exact` row at
its height; the wire could set none of it (`setRowHeight` set the floor only).

## Decision

**A policy switch on the table.** `Table.word` set: the table lays out by Word's rules below;
unset (every IDML import): InDesign's rules, unchanged. The plugin sets it on every Word table
(`insertTable { word }`).

**Rows split.** A body row of a Word table that does not fit the rest of its frame (above the
replayed footers and the stroke under it) splits there, unless it is in `cant_split_rows`,
spans rows (or is spanned into), or is held at an exact height. Each cell keeps the lines (and
whole nested tables) that fit, in order, and continues from the next in the next chain frame,
under the replayed header rows; a piece is as tall as its tallest cell's content plus its
insets, and the last piece is at least what is left of the row's floor. A row whose cells have
no line that fits waits for the next frame; a frame holding nothing yet takes at least one line
of each cell, so a line taller than a frame cannot stall the split. A continued cell's first
line stands where its earlier line's leading puts it below the piece's top inset. A row that
runs past the last frame is overset there (a growing chain makes room, as for text). The pieces
draw their cell's fill, edges and diagonals each; vertical justification does not apply to a
split row.

**Autofit.** A column's width is its grid width, else its cells' preferred width (`w:tcW`, in
points or a percentage of the table). With `autofit`, the table's width (`w:tblW`, points or a
percentage of the column it stands in) scales the columns, and a column narrower than its
content's longest unbreakable piece — a word, a picture, measured on the cell's own faces with
its insets — grows to it, the room coming from the columns with some to spare in proportion to
it. A column with no width at all takes its content's single-line width. Word saved its own
autofit result in the grid, so a table whose content fits keeps Word's widths; a fixed table
(`w:tblLayout fixed`) keeps its grid.

**Indent.** A left-aligned Word table stands `indent` pt in from its column's start (negative:
out into the margin); a centred or right-aligned one ignores it, as Word does.

**Exact rows.** `setRowHeight { autoGrow: false }` holds a row at exactly its height (the
existing `AutoGrow="false"` rule: the lines that fit are drawn, the rest overset), `true` lets
it grow from it; the inverse restores the previous state, unset included.

## Consequences

- IDML is untouched: no import sets `Table.word`, and a non-Word table takes exactly the code
  path it took before (the split block is skipped; `word_column_widths` returns the grid).
- Residuals: the row-height floor of a split row is checked only on its last piece; a split
  row's cell does not keep Word's per-cell widow/orphan rules; a kept run of rows
  (`KeepWithNextRow`) is not split; row and column inserts do not re-index `cant_split_rows`
  and `cell_widths`.

## Evidence

`paged-canvas/tests/it/word_tables.rs`: a Word row splitting across two linked frames (an
InDesign row not), a `cantSplit` row moving whole, a split row continuing under its repeated
header, an autofit column growing to its longest word (a fixed table keeping its grid), a
percent-wide table scaling its columns, an indent, an exact row and its undo.
