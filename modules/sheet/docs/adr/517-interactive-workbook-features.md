# ADR 517 — Validation, what-if, external links, outline and protection are interpreted; pivots stay preserved

- **Status:** Accepted, 2026-10-23. Amends [ADR 504](504-publishing-first-scope.md) (the scope);
  extends [ADR 503](503-xlsx-patched-not-regenerated.md) (what a save writes) and
  [ADR 515](515-structural-edits-shift-preserved-content.md) (what an edit shifts).
- **Scope:** `sheet-xlsx` (`ws_child.rs`, `xtree.rs`, `protect_doc.rs`, `parts/protection.rs`,
  `style_edit.rs`), `sheet-calc` (`layout.rs`), `sheet-js` (`core/outline.rs`, `core/protect.rs`,
  `wasm_w2.rs`), the bundle facade (`packages/sheet-bundle/src/engine-w2.ts`).

## Context

ADR 504 put data validation, what-if tools and external links on the list of things paged.sheet
never interprets. The frame-as-Excel program (plan "Excel inside the frame", ADR 510) changes the
premise: a sheet frame is now a place where a workbook is edited, and a workbook whose dropdowns do
not drop down, whose data tables show stale numbers and whose protected cells take any entry is a
broken workbook, not a preserved one. The scope was decided again for each feature.

## Decision

**Interpreted from now on:**

- **Data validation, in full.** An entry is checked against the rules of its cell; a `stop` rule
  refuses it, a `warning` or `information` rule answers the caller with the alert (title, message,
  style) so the UI can ask. List rules give their items (an inline list, a range, a name, a dynamic
  range through `OFFSET`/`INDIRECT`). Every Excel rule kind can be authored and edited with its
  input message and error alert, and "circle invalid data" is an engine call that lists the cells
  breaking their rules. The rules are written back by rewriting `<dataValidations>` in place.
- **What-if: data tables and Goal Seek.** `TABLE()` data tables (`<f t="dataTable" r1 r2 dt2D
  dtr>`) are evaluated, one- and two-variable. Goal Seek is a one-shot engine command (the changing
  cell found by the secant method with bisection fallback; Excel's defaults: 100 iterations,
  maximum change 0.001). Scenario Manager and Solver stay preserved only.
- **External links recalculate from the cached values.** A formula over `[n]Sheet!A1` evaluates
  against the `externalLinkN.xml` cache (the read-only shadow sheets of `SheetModel::external_sheets`);
  a link is never followed — no file, no network.
- **Outline and visibility.** Group and ungroup rows and columns, collapse and expand groups,
  Excel's outline-level buttons, hide and unhide rows, columns and sheets.
- **Protection, enforced.** While a sheet is protected a locked cell refuses an entry at every
  write door (entry, batch, sort, fill, replace), and the `allow*` flags gate formatting, row and
  column inserts and deletes, sorting and filtering. A protected workbook structure refuses adding,
  deleting, renaming and hiding sheets. A password is checked against the stored hash: the SHA-512
  spin form (`algorithmName`, `hashValue`, `saltValue`, `spinCount`) or the legacy 16-bit hash; a
  new password is stored as SHA-512 with 100,000 spins, as Excel 2013 and later store it.
  Protection is not encryption, and the engine says nothing that suggests it is.
- **Tables, sort and filter** (W2.6, W2.7) are interpreted as Excel does — calculated columns,
  totals, table styles, multi-key sort written as `sortState`, the full autoFilter criteria written
  as `filterColumn`.

**Still preserved, never interpreted:** pivot tables and their caches, slicers and timelines,
`GETPIVOTDATA` (a `cached_only` function), VBA and macros (never executed), Scenario Manager,
Solver. The reasons of ADR 504 hold for them.

**How a save writes it.** The captured worksheet children stay the single store (ADR 503): an
authored `<sheetProtection>`, `<autoFilter>`, `<sortState>`, `<dataValidations>` or
`<sheetFormatPr>` replaces the captured bytes, or is added in its ECMA-376 §18.3.1.99 position
(`ws_child::ws_rank`; `patch.rs` places an added child before the first child the schema puts after
it). A structural edit then shifts it like anything read from the file (ADR 515). Workbook-level
state (`<workbookProtection>`, `<sheet state>`, the active tab) is spliced into `workbook.xml`.
`<sheetFormatPr outlineLevelRow/outlineLevelCol>` follows the deepest outline level, so Excel
draws the outline buttons. A cell's lock and hidden-formula flags are `StylePatch::locked` /
`formula_hidden` (`<xf><protection>`).

**No frozen type changes for W2.8.** The model already carries what outline and visibility need
(`RowMeta`, `ColMeta`, `hidden_rows`, `SheetState`, the W1.4 amendment); protection lives in the
captured XML. The engine gains a mutable view door (`Engine::sheet_view_mut`) next to
`sheet_layout_mut`.

## Evidence

- Outline, visibility, protection: `sheet-js/src/core/outline.rs`, `sheet-js/src/core/protect.rs`,
  `sheet-xlsx/src/parts/protection.rs` (SHA-512 and the legacy hash, with FIPS 180-4 vectors and
  the hashes Excel writes for `test` and `password`), `sheet-xlsx/src/protect_doc.rs`,
  `sheet-conformance/tests/it/w2_outline_protect.rs` (group/collapse/expand and level buttons
  saved and reloaded, SUBTOTAL 109 over collapsed rows, hidden columns and sheets, locked cells
  refused and unlocked ones accepted, allow flags, workbook structure, wrong passwords).

- Data validation: `sheet-xlsx/src/parts/validation.rs` (the rule model, `sqref` arithmetic,
  the write that keeps each untouched rule's element), `sheet-js/src/core/validation.rs`,
  `sheet-calc/src/adhoc.rs` (`Engine::eval_formula_at` / `eval_formula_block_at` /
  `eval_reference_at`: a formula evaluated as if it stood in a cell, nothing stored),
  `sheet-conformance/tests/it/w2_validation.rs` (every kind, the three alert styles, inline and
  dynamic lists, custom rules with the entry in place, Circle Invalid Data, authoring that moves
  cells between rules, the round trip, the corpus workbook's own rules enforced and its zero-edit
  save unchanged).
- Sort and filter: `sheet-js/src/core/sort.rs`, `sheet-js/src/core/filter.rs`,
  `sheet-xlsx/src/parts/autofilter.rs` (every criterion read and written, a byte-identical round
  trip of Excel's forms), `sheet-xlsx/src/style_edit.rs` (`color_dxf`: the differential format a
  colour sort or filter names), `sheet-conformance/tests/it/w2_sort_filter.rs` (two-level, custom
  list, case-sensitive, left-to-right and colour sorts with their `sortState`; every criterion,
  the clock-driven dynamic dates, the dropdown data, named views; property tests: a two-key sort
  is stable against brute force, the custom-condition engine equals a brute-force reading).
- Tables: `sheet-xlsx/src/table_doc.rs` (the part read whole and written back, a new part with its
  relationship, content type and `<tablePart>`), `sheet-xlsx/src/table_style.rs` (the 60 built-in
  styles as a family model over the theme, a workbook's `<tableStyles>`),
  `sheet-lower/src/table_band.rs` (the style under the cell's own, folded by the shared
  `CellStyler` through `SheetCondFmt::tables`), `sheet-js/src/core/tables.rs`,
  `sheet-conformance/tests/it/w2_tables.rs`.
- What-if: `sheet-xlsx/src/parts/worksheet.rs` (`DataTableDef`), `sheet-xlsx/src/patch.rs` (a data
  table's `<f>` kept on its cell), `sheet-js/src/core/whatif.rs`,
  `sheet-conformance/oracle/excel/whatif.applescript` and `recorded/whatif.excel.xlsx` (Excel
  built the tables and ran the seeks), `sheet-conformance/tests/it/excel_whatif.rs`.
- External links were already evaluated from their caches before this record: a formula over
  `[n]Sheet!A1` reads the read-only shadow sheets `SheetModel::external_sheets` (no AST variant
  was needed). A defined name of another workbook (`[1]!Name`) is still not parsed; such a
  formula keeps its cached value.
- Excel opens what Paged authors: the open-check lane (`excel_opencheck.rs`,
  `recorded/opencheck.tsv`) gained seven cases — a table created with a calculated column, totals
  and style switches; a table renamed with its totals toggled; validations authored (list, whole
  number with a warning, custom) and edited; sheet and workbook protection with unlocked and
  hidden-formula cells; a colour-and-value sort under an AutoFilter with custom, top-10 and
  dynamic criteria; row and column outlines, a hidden column and a hidden sheet. Excel 16 opens
  each without a repair and its re-save reads back the same (protection, AutoFilter, outline and
  sheet states are now part of the compared inventory). Two writer faults the lane found are
  fixed: a new `<sheetFormatPr>` went after a new `<cols>` (insertions at one offset now go in
  schema order), and a `<col>` record without a width read as hidden (it carries the sheet's
  default width); a formula inside a table is written as a plain formula with its `[@Col]`
  references naming the table (`Sales[[#This Row],[Col]]`), never as a dynamic array.
- On the private corpus (728 workbooks) a zero-edit save through the session is byte-identical
  in every part (`real_xlsx_corpus::zero_edit_saves_…`); of 1778 inserts and deletes, the 24
  refused are on protected sheets that do not allow them, as in Excel.

**Frozen type amendment (filter criteria).** `sheet_core::FilterCriterion` gains `DateGroups`,
`Custom`, `Dynamic`, `Color` and `Icon` (with `FilterOp`, `CustomCondition`, `DateGroup`);
`Unsupported` remains for criteria in extensions Paged does not read. The existing variants keep
their meaning. A sheet's filter is now its `<autoFilter>`: what was a Paged-only view written
nowhere is written as Excel writes it, and the rows it hides are saved hidden.

## Consequences

The workbook panel's "preserved, not enforced" line for validations goes away when validation
lands. Excel's open-check lane (`excel_opencheck.rs`) covers the authored elements, so a schema
slip shows as a repair prompt there. Every write door that changes cells has to call
`guard_cells`; a new door that forgets it lets a protected cell change.
