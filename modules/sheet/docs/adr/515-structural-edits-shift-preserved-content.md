# ADR 515 — A row or column insert or delete shifts the preserved content

- **Status:** Accepted, 2026-10-22. Extends [ADR 503](503-xlsx-patched-not-regenerated.md)
  (the package is patched); keeps [ADR 504](504-publishing-first-scope.md) (preserved content is
  never interpreted).
- **Scope:** `sheet-parser` (`rewrite.rs`: `shift_ref_text`, `shift_sqref`, `shift_index`,
  `shift_range_ref`, `shift_table`), `sheet-xlsx` (`shift.rs`, `XlsxDocument::shift_for_edit`),
  `sheet-calc` (`apply_edit_structural`), `sheet-js` (`SheetSession::structural_edit`).

## Context

`structural_edit` refused an insert or delete on any sheet that carried conditional formats, data
validations, hyperlinks, an autoFilter, tables, drawings, comments or defined names naming it
(`XlsxDocument::structural_edit_blockers`): the writer re-emitted those parts verbatim, so after
the edit they would have addressed the wrong cells. On real workbooks that is most sheets.

## Decision

Every piece of preserved content that addresses cells moves with the edit, the way a parsed
formula moves (`sheet_parser::rewrite`): `$` does not exempt a reference, an insert inside a range
grows it, a delete clips it, and a reference the delete removes reads `#REF!`. Moving is
preservation, not interpretation: a validation's formula is shifted as text and still never
evaluated.

- **Text.** `shift_ref_text` and `shift_sqref` find references with a scanner of their own, not
  the formula lexer, because preserved text is whatever its writer put there: non-ASCII names,
  external `[1]Sheet!` prefixes, structured references, error literals. Strings and bracketed parts
  are skipped; a word followed by `!` qualifies the next reference; a qualifier matching the edited
  sheet (case-insensitive) or, without one, text whose host is the edited sheet, moves. Text that
  does not change is returned byte for byte. A reference over a span of sheets keeps its address,
  as the AST rewrite keeps it ([ADR 513](513-calc-model-amendment.md)).
- **Lists and owners.** A range list (`sqref`, `ref`) drops the ranges the delete removes; when
  none is left the owner goes with its cells, as in Excel: a conditional format (and its x14
  twin), a validation, a hyperlink, a sparkline, a note and its VML box, a threaded comment, a
  page break, a cell watch. Containers that must not be empty go with their last child; `count`
  attributes follow. A sheet view's active cell lands on the first surviving row or column.
- **What is shifted.** On every sheet: the captured worksheet children (conditional formats,
  validations, hyperlinks, autoFilter with its column offsets, sortState, protected ranges,
  ignored errors, page breaks, sheet views, scenarios, data consolidation, the x14 conditional
  formats, validations and sparklines in `extLst`). On the edited sheet: its tables (extent,
  autoFilter, sortState, calculated and totals formulas; a column inserted inside a table becomes
  `ColumnN`, Excel's name, in the part and in the header cell; a table the edit deletes whole is
  removed with its part, relationship, content type and `<tablePart>`), drawings (each anchor by
  `editAs`: move and size, move only, absolute; shape text links), notes and their VML boxes,
  threaded comments. Across the package: every chart's series references (cached values kept),
  every defined name (print areas and titles included; a sheet-scoped name's unqualified
  references are on its own sheet) and, in the model, the names, row and column attributes,
  hidden rows, tables and filter views. A formula Paged keeps verbatim (unparsed) is shifted as
  text and moved with its cell.
- **Plan, then apply.** `shift_for_edit` plans every change first and applies none unless all
  succeed; the session plans the verbatim formulas and the names before that and only then
  applies the edit to the engine. A refusal names what blocks it; the model and the package are
  untouched.
- **Still refused, named:** a pivot table on the sheet or a pivot cache reading it (pivots are
  preserved, never moved — ADR 504); an extension in `extLst` Paged does not know that holds
  cell references; an unterminated string in reference text.

## Evidence

- `sheet-parser/src/rewrite.rs` (text shift and its tests), `sheet-xlsx/src/shift.rs` (the walk,
  tables, drawings, VML, defined names, the plan), `sheet-js/src/core/ops.rs` (`structural_edit`).
- `corpus/xlsx-corpus/16-structure.xlsx` (every kind, written as Excel writes it) and
  `sheet-conformance/tests/it/xlsx_structure.rs`: a row insert, a column insert inside a table, a
  column delete that takes a note, a rule and a sparkline, a table deleted whole, a pivot cache
  that refuses, and a property test of random insert/delete sequences against a reference model.
- The opt-in real-corpus lane `real_xlsx_corpus::excel_workbooks_take_structural_edits_and_one_cell_edits`:
  1778 inserts and deletes on the Excel-written workbooks of the private corpus, none refused.

## Consequences

An edited workbook's preserved content keeps addressing the cells it addressed. The writer still
never interprets it: a moved validation is still not enforced, a moved chart is drawn from its
cached values until Paged recomputes it. Inserted rows and columns take no formatting from their
neighbours (Excel copies the row above or the column to the left).
