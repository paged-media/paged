# Status

What `paged.sheet` ships and what it does not, read from the code on `main` at
`@paged-media/sheet` 0.1.0-canary.24 (2026-10-18), with `@paged-media/plugin-api` and
`@paged-media/plugin-sdk` `>=0.2.45-canary.0` as peers. The tests run against
`@paged-media/canvas-wasm` 0.71.13 and the 0.2.58-canary.0 contract. How the parts fit is in
[`architecture.md`](architecture.md). The analysis behind the 2026-10-04 round of work, and what
changed against it, is in [`design/analysis-2026-10-04.md`](design/analysis-2026-10-04.md). What
each published canary added is under [Releases](#releases).

## Shipped

- **Open and keep a workbook.** An `.xlsx` file reaches the plugin through the host's importer,
  the "Import workbook (.xlsx)" command or the Workbook panel; CSV and TSV import as a one-sheet
  workbook, typed by locale; "New workbook" starts a blank one. The bytes are stored in the
  document when the host supports container parts, and in the browser's per-plugin store when it
  has one. Every committed edit re-saves the workbook after a short quiet period, and
  deactivation flushes, so a reload restores the edited workbook. Where the host announces saves
  (`document.onWillSave`), the workbook is written before the save takes the document's bytes.
  A reopened document restores its workbook when the host reports the open
  (`document.onDidOpen`).
- **Calculation.** 389 registered functions: 371 evaluated, and 18 that need a network, a cube
  connection, a native library or a pivot table (`WEBSERVICE`, `CUBE*`, `RTD`, `STOCKHISTORY`,
  `IMAGE`, `TRANSLATE`, `DETECTLANGUAGE`, `COPILOT`, `PY`, `CALL`, `REGISTER.ID`, `GETPIVOTDATA`)
  keep the value the workbook cached (else `#BLOCKED!` / `#CONNECT!`). Among them `LET`, `LAMBDA` and its
  helpers, the engineering set (radix and bit functions, `CONVERT` with Excel's full unit table and
  prefixes, the complex-number `IM*` functions on Excel's text form, the error and Bessel
  functions with Excel's own approximations) and the modern math set (`CEILING.MATH`,
  `FLOOR.MATH`, `MDETERM`/`MINVERSE`/`MUNIT`, the reciprocal trigonometric functions), the regular-expression functions (PCRE syntax through
  `fancy-regex`; Unicode property classes limited to `\p{L}`/`\p{N}`), `ARRAYTOTEXT`,
  `VALUETOTEXT`, `BAHTTEXT`, `ENCODEURL`, `FILTERXML` (an XPath location-path subset) and
  `EUROCONVERT`; numbers convert to text as Excel's `CONCAT` does (fixed notation up to 20
  characters); `CELL`, `INFO`, `SHEET`/`SHEETS` over the whole workbook (sheet names, 3D spans,
  the document name the host gives) and `ISOMITTED` for omitted LAMBDA arguments; `EXPAND`, `WRAPROWS`/`WRAPCOLS`, `TRIMRANGE`,
  `AREAS` and `GROUPBY`/`PIVOTBY` (headers, totals and subtotals, sort orders, filters, LAMBDA or
  eta-reduced aggregations such as `SUM`, stored `_xleta.SUM`; the trim-reference operators `.:`
  `:.` are not parsed yet); AGGREGATE's full set (functions 12–19, every option) and SUBTOTAL
  101–111 over hidden rows, ROMAN's five forms, TREND over several regressors, TEXTBEFORE/TEXTAFTER
  `match_end`, INDIRECT with R1C1 addresses, and TEXT in the workbook's locale; dynamic arrays that spill and nest; Excel tables with structured references;
  incremental recalculation with an interval index for range dependencies, and range
  accelerators within a recalc (column snapshots, anchored prefix aggregates for SUM/COUNT/
  COUNTA/AVERAGE/MIN/MAX, exact-match indexes for VLOOKUP/MATCH/XMATCH/XLOOKUP/COUNTIF/SUMIF,
  ADR 512) that never change a value — a 10,000-row running total recalculates in about 4 ms
  and 10,000 lookups into an edited 10,000-row table in about 9 ms natively; dependents of
  volatile cells recalculate with them; iterative calculation when the workbook's `calcPr`
  asks for it; `NOW` and `TODAY` follow the host clock. Number formats render in five display
  locales. Expected values are recorded from Excel and replayed in CI: 5,156 of 5,222 function
  cases and 152 of 164 number-format cases agree, every disagreement a recorded ruling.
  Recalculating real workbooks reproduces Excel's saved value in 93.6% of comparable formula
  cells (56,533 of 60,419 over 201 workbooks): shared formulas, defined names of every kind,
  structured references (including `[#Headers],[#Data]` and `[#Data],[#Totals]`), whole-column
  and whole-row references, omitted arguments, legacy array formulas and element-wise array
  arguments evaluate as Excel does. A number literal beyond the double-precision range is a
  formula error, as in Excel.
- **Calculation model** (ADRs 513, 514). A typed formula that can produce an array spills by its
  result (`=A1:A3`, `=A1:A3*2`, `=IF(A1:A3>1,A1:A3,0)`, `=OFFSET(A1,0,0,3)`, a LAMBDA over a
  range); a formula loaded without Excel's dynamic-array mark keeps implicit intersection; `@`;
  3D references (`Jan:Mar!A1`) for the aggregates; a defined name called as a function is a
  named LAMBDA; an unknown name or function is `#NAME?` and keeps its spelling; IF, IFS,
  IFERROR, IFNA, CHOOSE and SWITCH evaluate only the branch they return; `#CALC!` and Excel 365's
  other errors; comparisons and COUNTIF/SUMIF criteria at 15 significant digits and the
  final-operation cancellation snap (`=0.1+0.2=0.3` is TRUE, `=0.1+0.2-0.3` is 0); a cycle keeps
  its last values (0 when never calculated) with the circular warning; manual calculation
  (`calcMode`, Calculate Now / Calculate Sheet) and precision as displayed, read from and written
  to `<calcPr>`. Recorded from Excel and replayed in CI: 400 of 415 probed cells (135 cases)
  agree, every disagreement a recorded ruling or a listed defect.
- **Typed entry.** What a person types into a cell is stored as Excel stores it (ADR 511):
  percentages, currency, group separators, fractions, scientific notation, dates, times and
  date-times become numbers with the number format Excel gives them, a leading `'` forces text
  with Excel's quote prefix, and value and format undo as one step. The CSV import types fields
  through the same parser. Recorded from Excel and replayed in CI: 741 of 742 en-US entries
  through the session agree (215 of 216 through the parser), de-DE, es-ES and it-IT 71 of 71,
  fr-FR 63 of 71, every disagreement a recorded ruling.
- **Insert and delete rows and columns** on any sheet (ADR 515): references move in every
  formula, and so does what the workbook keeps beside its cells — conditional formats,
  validations, hyperlinks, filters and sorts, page breaks, sheet views, sparklines, tables (a
  column inserted inside one becomes `ColumnN`; a table deleted whole goes with its part),
  drawings and pictures, notes and threaded comments, defined names and print areas, chart
  series, row and column attributes. What the delete removes entirely goes with its cells, as
  in Excel. Still refused, with the reason: a pivot table on the sheet or a pivot cache over it,
  and an extension Paged does not know that holds cell references. Over the Excel-written
  workbooks of the private corpus, 1778 inserts and deletes: none refused. Excel 16 opens what
  Paged saves after these edits without a repair and keeps what it holds (the open-check lane,
  `recorded/opencheck.tsv`: 16 cases; a broken control file is caught; the generated fixtures 05,
  11 and 13 are refused by Excel as generated, so the cases made from them are not gated). A reference to a table
  the edit deletes reads `#REF!`, as Excel rewrites it.
- **Tables, editable** (ADR 517). `createTable` makes a range a table (its part, the worksheet
  relationship, the content type and `<tablePart>`; blank and repeated headers made unique as
  Excel makes them; without headers the data moves down under a `Column1…` row), `resizeTable`
  (the header row stays), `renameTable` and header edits (the structured references follow),
  `setTableTotals` (the row below, `Total` and a SUM or COUNT; `setTotalsFunction`: SUBTOTAL's
  functions, a custom formula, a label), `setCalculatedColumn` (filled down every data row, kept
  as `calculatedColumnFormula`), `setTableStyle` (the 60 built-in styles and a workbook's own
  `<tableStyles>`, banded rows and columns, first and last column). A typed entry (`enterCell`)
  directly below or to the right of a table grows it, and a formula typed into an empty table
  column becomes its calculated column. Table styles paint under the cells' own formatting
  through the shared styler, on the page and in the grid, empty table cells included. The
  built-in styles are a family model over the theme (nine families × dark 1 and six accents),
  not Excel's internal definitions: a shade can differ by a tint step. The object model's
  `table` kind is writable (name, range, totals row, style and its switches) and creatable, with
  a Table section in Sheet properties.
- **Sort and AutoFilter** (ADR 517). `sortRangeBy` is Excel's Sort dialog: up to 64 levels, each
  by value (ascending, descending, a custom list), cell colour or font colour (on top or on
  bottom), case-sensitive or not, top to bottom or left to right; stable, blanks last, formats move
  with their rows, formulas are re-addressed; the sort is written as `<sortState>` (inside the
  `<autoFilter>` when the range lies in it) so Excel's dialog reopens with the same levels. The
  AutoFilter engine evaluates every criterion Excel writes — value lists with date groups and
  blanks, one or two custom conditions with wildcards, top/bottom n or n%, dynamic filters
  (above/below average, today … year to date, `Q1`–`Q4`, `M1`–`M12`, against the host clock), cell
  and font colour as shown (conditional formatting included) — and writes it as `<filterColumn>`;
  the rows it hides are saved hidden, as Excel saves them, and clearing it shows exactly those.
  `filterColumnValues` is the dropdown's data (distinct shown values with counts and ticks over
  the rows the other columns keep, the date tree, blanks, the colours present, the current
  criterion); `filterState`, `reapplyFilter`, `clearFilterCriteria`, `removeAutofilter`. Named
  filter views are saved and applied by name and kept beside the workbook in the `.paged` part
  (`filter-views.json`, `writeFilterViewsPart`); the active one is the `<autoFilter>`. No UI calls
  these doors yet; the bundle does not yet persist the named views on its own.
- **Data validation, interpreted** (ADR 517). `enterCell` checks a typed entry against its
  cell's rule: whole and decimal numbers, dates, times and text length against the operator and
  operands (formulas, relative to the rule's first cell), lists (case-insensitive text, numbers by
  value) from an inline list or a range, a name or a dynamic `OFFSET`/`INDIRECT` source, and
  custom formulas evaluated with the entry in place; a blank passes where the rule allows it. A
  `stop` alert refuses; a `warning` or `information` alert is returned unapplied until the
  caller confirms; a rule with its error alert off never refuses. Only an entry is checked, as in
  Excel (paste, fill, sort and undo are not). `validationAt` gives a cell's rule with its input
  message and a list rule's dropdown items; `invalidCells` is Circle Invalid Data. Rules are
  authored and edited (`setValidation`, `updateValidation`, `clearValidation`; the cells leave
  older rules, Excel's length limits on messages apply) and written back into
  `<dataValidations>`, keeping what each untouched rule held. A protected sheet refuses rule
  edits. The editor's cell editor does not call `enterCell` yet, and the Workbook panel still
  reports the rules as not enforced. The Excel 2010 `x14:dataValidation` copies in `extLst`
  (cross-sheet lists written by Excel 2010) are kept but not read.
- **Outline, hidden rows, columns and sheets, protection** (ADR 517). Rows and columns group
  and ungroup (up to seven levels), groups collapse and expand (a nested collapsed group stays
  collapsed when its parent expands), Excel's outline-level buttons, hide and unhide rows, columns
  and sheet tabs (never the last visible one); `outline` reports the groups and hidden tracks for
  the grid. The save writes the row and column attributes, `<sheetFormatPr outlineLevelRow/Col>`
  and `<sheet state>`. A protected sheet refuses an entry into a locked cell at every write door
  (entry, batch, sort, fill, replace) and the actions its `allow*` flags do not allow (format
  cells, rows, columns; insert and delete rows and columns; sort); a protected workbook structure
  refuses adding, deleting, renaming and hiding sheets. Passwords are checked against the stored
  SHA-512 spin hash or the legacy 16-bit hash; new ones are stored as SHA-512 with 100,000 spins.
  Format Cells ▸ Protection (locked, hidden) is a style patch. No UI calls these doors yet.
- **Workbook panel.** File and sheet controls on top (open, new, and sheets: add, rename,
  delete), then collapsible sections: Place on page (open by default), Rows and columns, Format
  and layout (borders, merge, column width, row height, freeze), Names, Sort range (formula cells
  move with their row), Cell styles, Charts, Functions and Workbook contents. Number format,
  font, fill, alignment, wrap and iterative calculation are rows of the Sheet properties panel;
  the Format and layout section points there, and shows those controls itself only on a host
  that does not render schema panels. Deleting a sheet, rows or columns, starting a blank
  workbook over an open one and filling a workbook from a dataset over an open one ask for a
  second click.
- **Sheet properties panel.** A schema panel of property rows that the host renders with its
  `PropertyField` over `host.objects` (`src/panels/properties-panel.ts`): Cell (the grid's
  active cell), Selected range (values and inputs edited row by row at the range's shape,
  formula fill, and the format rows across the range), Sheet, Workbook, Named range and Chart
  (each of Sheet, Named range and Chart picked from a list first). A chart's series are a list
  of items (name, values, categories, colour) that can be added, removed and reordered. Every
  writable row of every kind is a field (a spec holds the panel to the schemas); each commit is
  one undo step, and each field offers the host's "Bind to data…".
- **The frame is a window onto its sheet (ADR 510).** A sheet frame's binding (v2) carries its
  view (the top-left cell and a lock), print headings and gridlines and its column sizing; a
  binding written before reads as locked at its range. Entering a frame opens its bound sheet at
  that cell. `get_frame_window` decides which rows and columns a frame shows, for the live grid
  and the page alike. On a host with frame surfaces (extensions ADR 334) the entered frame shows
  a grid drawn on the main thread over the frame, with row and column headings inside it,
  instead of the scene layer; pointer, wheel and keys go straight to it. The page table does not
  follow the scrolled window yet: it still shows the placed range.
- **The live grid looks like the page (ADR 510).** `get_grid_scene` builds on `frame_window`:
  the frozen rows and columns stay pinned while the body scrolls, hidden and filtered rows are
  skipped, and the viewport lists the shown sheet rows and columns (`rowIndices`/`colIndices`,
  `frozenRows`/`frozenCols`, `partialRow`/`partialCol`). Cells take the workbook's styles
  through `CellStyler`, the per-cell path the page lowering (`get_range_page`) uses as well —
  fills, fonts, text colour, per-edge borders, vertical alignment, wrap, the number-format text,
  and conditional formatting (dxf rules, colour scales, data bars) — so a cell has the same style
  key and style on both surfaces (pinned by a property test over random sheets). Merged areas
  come as rects with the anchor's text and style, split at the frozen band, with the gridlines
  inside them left out; text cells name the empty neighbours they may overflow into. The
  painter (`paintGridScene`) and the SVG/scene-layer views draw all of it. Hidden columns are skipped
  like hidden rows.
- **The page side of the window (ADR 510 amendment).** `get_frame_page` (TS `getFramePage`)
  lowers the window a frame shows into the page table: `frame_window` for the frame's spec, then
  `lower_tracks` over its rows and columns (`get_tracks_page` / `getTracksPage` takes explicit
  tracks). Widths and heights are the sheet's own pt sizes, not measured; rows and columns keep
  their sheet index; the frozen rows become the table's header rows (`headerRows`, so they repeat
  on continuation frames). Printed headings add a heading row (A, B, C…) and column (1, 2, 3…),
  boxed, taken off the box first; printed gridlines are an option. A merge clipped by the window
  carries its anchor's text and style on its shown corner (on the page and in the grid). A
  property test holds the page (without headings) to the grid scene of the same window, track by
  track: indices, sizes, styles table, cells, merges, gridlines and data bars. The in-place
  refresh (`tableRefreshOps`) aligns columns by their index as rows are aligned, so a scroll by k
  columns is k column deletes and k inserts and only the new cells are re-poured (perf budget:
  6 column ops for a 3-column scroll); header-band changes use `insertHeaderRow` /
  `removeHeaderRow`; `replace` asks for a fresh table when more than 60 % of the cells would be
  re-poured. The session does not call the page door on leave yet (the exit flow is the next
  step).
- **Number formats as a cell shows them** (W2.1). A section's colour (`[Red]`, the other seven
  names and `[Color1]`–`[Color56]`, read through the workbook's own palette when it overrides
  the default) colours the number on the page table and in the live grid alike; a conditional
  format's font colour wins over it, and a text value keeps its font colour, as in Excel.
  Conditional sections, fractions (the last continued-fraction convergent that fits, as Excel
  picks it), elapsed time, `@` (a number under a text section shows as General) and the system
  long date and time (`[$-F800]`, `[$-F400]`, `[$-x-sysdate]`, `[$-x-systime]`) render; a General
  cell fits 11 characters as in Excel (`1.23457E+14`, `3.141592654`), while `&` and `CONCAT` keep
  15 digits. A repeat fill (`*x`, the accounting formats' `* `) splits the cell: the grid
  repeats the character across the free width, the page table puts a right tab stop at the
  cell's inner width with the character as its leader. Recorded from Excel 16 (the display lane,
  `recorded/display.tsv`: the text and the font colour of 190 cells) and replayed in CI: all 190
  agree. Not modelled: General narrowing to a column narrower than 11 characters, `_x` as the
  exact width of `x` (it is one space).
- **The cell visual model** (W2.2, ADR 518). A cell style reads into `CellVisual`: the 18 fill
  patterns with both colours, gradients, every border line style and the diagonals, indent,
  rotation (0–180, stacked), shrink-to-fit, strike-through, super- and subscript, the underline
  kinds and the Excel named cell style it derives from; every colour is a reference (the stored
  RGB / theme / indexed / automatic colour plus an optional document swatch, RGB, CMYK, spot or
  Lab) and one resolver gives the page and the grid the same colour. `set_style` authors all of
  it, applies an Excel named style by name (adding a built-in the workbook lacks from Excel's
  definition), and sets document swatches and character / paragraph / cell styles; an xlsx save
  writes the concrete colours and keeps the references in the style record's own `extLst`,
  restored on re-import only while the concrete colour is unchanged. `get_cell_visual` and
  `named_styles` read the model. Both surfaces draw it from the same lowered style: the grid
  paints the 18 patterns, gradients, diagonals, rotated and stacked text, indent, shrink-to-fit,
  strike-through, super- and subscript, double underlines and rich-text runs (each run in its
  own font); the page table names a document swatch instead of minting one, applies the
  document character and cell styles as they are and bases its paragraph styles on the
  document paragraph style, sets strike-through and super/subscript, applies each rich-text
  run's character style over its range, turns rotated cells by a rotation cell style (the
  table's quarter turns: 45–135° turn, smaller angles stay upright), stacks text one character
  per line, and draws diagonals as page lines. Not on the page: a pattern shows as the blend of
  its colours and a gradient as its mean colour, dashed and double borders as solid lines of
  their weight, shrink-to-fit and the double underlines (the table model has no such
  properties).
- **Grid panel and in-frame grid.** Range selection by click, drag and shift; arrows, Tab, F2,
  Delete and scrolling in the frame; a cell editor with function completion; copy and paste of
  ranges with relative references re-addressed; the fill handle with number, date, weekday and
  month series; Fill Down / Fill Right; find and replace in the sheet (Find all, Replace all,
  Match case, Entire cell; the "Find & replace…" command opens the grid). The grid's viewport
  follows the panel's width, and copy, paste, fill and edit refusals show in the panel.
- **Undo.** In the edit context, every committed cell edit is one step, and so is each bulk
  operation (sort, replace-all, paste, fill, clear) and each format change (style, borders,
  merge, sizes, freeze, names, and the formats a fill carries). Outside it, the host's undo takes
  a placed table back and the workbook follows the version the table shows.
- **A range on the page.** One text frame holding a native table: the workbook's fills, borders,
  fonts and conditional formatting, numbers aligned right and centred cells centred, Excel's
  bottom alignment where a row is tall enough to show it, merged cells, column widths measured
  with the document's font metrics, and conditional-format data bars drawn under the table. The
  frame lands at the current selection, as tall as the table the engine lays out (its rows grown
  to their tallest cell), so every row shows. On an engine of protocol 66 or later, placing a
  range is one document write: the frame, its binding, the table and the content in one batch.
  An older engine takes two, the frame and table first and the content second.
- **Placed tables follow the workbook.** After an edit the table is refreshed in place: only
  changed cells are re-poured, rows and columns reshaped, data bars redrawn, the binding's
  content version stamped, all in one document write and one undo step. A table placed in an
  earlier session is found again on restore and refreshes the same way, in place: what each
  table shows is kept in the document (`placements/<hash>.json`, written by the save hook), so
  the table keeps its id and whatever the host formatted. A header or footer band the host
  added (`insertHeaderRow`, `insertFooterRow`) is kept: where the engine reports a table's band
  sizes (`tableHeaderRowCount` / `tableFooterRowCount`, core v0.71.13), the refresh writes the
  workbook's rows between the bands. The table is replaced when no such record was kept, when
  the host inserted or deleted rows or columns in the body, or when it added a band on an
  engine that does not report band sizes: there the workbook's rows cannot be told apart from
  the host's, and the band does not survive the refresh.
- **Pagination.** A command threads a range over linked frames, repeats the header rows with
  their formatting in every frame, and re-paginates when a frame is resized, refreshing its own
  tables rather than adding new ones. A resize counts whether it is a `resizeFrame` or a drag of
  the frame's handles; the second needs a host that reports a gesture's reflow (core v0.71.13
  through plugin-sdk 0.2.58). On an older host a handle resize leaves the split where it was
  until the next resize by command or the next workbook edit.
- **Charts** (ADR 519). Every chart kind Excel writes is drawn as itself: column, bar, line and
  area (each clustered, stacked or 100% stacked), pie, doughnut (one ring per series), pie of
  pie, bar of pie, scatter, bubble, radar (outlined, with markers, filled), stock (high-low-close
  and open-high-low-close), surface (as a contour), and the Office 2016 chartEx kinds waterfall,
  funnel, treemap, sunburst, histogram, pareto and box & whisker. A 3-D chart is drawn as its
  2-D kind and flagged; a region map is a labelled placeholder. Combo charts keep each plot's
  kind and draw a secondary value axis. Markers, data labels, trendlines (with R² and
  equation, fitted as LINEST fits), error bars, logarithmic, reversed and date axes, axis
  crossings, gridlines, legend positions and the chart style's theme colours follow Excel.
  Colour and text roles carry document swatch and style references, which the page uses.
  Sparklines (line, column, win/loss) and chartsheets are read; 172 of 172 corpus charts
  render with their real kind. Charts are placed as vector paths and labelled text frames in
  one document write, grouped as one object, and replaced in one write when their data
  changes. Each label frame is sized to its text (measured with the document's font metrics,
  or sized by the frame when a document style sets the label), justified to its anchor, inside
  the chart. A new chart lands inside the page's margins: beside what is selected (below it,
  else above, else to its right or left), never on top of it, and in the margin box's top-left
  corner with nothing selected. It is shrunk proportionally only when the margin box cannot
  hold 360 × 240 pt.
- **Host panels in the sheet context.** The host's Swatches panel shows and edits the workbook
  chart colours; the Character and Paragraph panels show the selected cells' type, read-only.
- **Datasets.** A panel lists the datasets the host offers, by a display name derived from the
  provider id (the id is in the tooltip), and fills a new workbook from one.
- **Export.** An `.xlsx` exporter. Parts the session did not touch are written back with their
  original bytes, including pivot caches, macros and other parts never interpreted. A spilled
  formula is stored the way Excel stores a dynamic array (an array formula over its spill range,
  flagged by the `XLDAPR` cell metadata) and reloads as a live spill; Excel's own dynamic arrays
  load the same way. A workbook saved before that (each anchor a plain formula next to its
  spilled values) reads those values back as the spill when they match. An edited worksheet is
  patched, not regenerated: rows and cells whose content did not change keep their bytes, a
  changed cell keeps its start tag (`ph`, `vm`, unknown attributes) and a text cell that still
  holds its shared string keeps the index, so rich-text runs survive. Hidden, styled and
  outlined columns, row styles, outline levels and the `collapsed`/`thickTop`/`thickBot` flags
  are read into the model (`RowMeta`, `ColMeta`) and written back; hidden columns are skipped
  by the page lowering and the frame window like hidden rows. `listSheets` reports each tab's
  `state` (`visible`, `hidden`, `veryHidden`). A rich-text string can be appended to
  the shared-string table without renumbering it (`XlsxDocument::append_shared_string`); no
  editing surface writes one yet.

- **Object model.** On `main` and published since 0.1.0-canary.15. The contract is plugin-sdk's
  [`DESIGN.md`](https://github.com/paged-media/paged/blob/main/platform/extensions/DESIGN.md) §21, with the
  fix-ups from its first consumers in §21.8 and the panel property row in §12.7. Seven
  kinds under `plugin:media.paged.sheet/…`: `workbook/main`, `sheet/<name>`,
  `cell/<sheet>!<A1>` (value, formula, input, display, number format, font, fill, alignment,
  wrap), `range/<sheet>!<A1:B2>` (values, inputs, formula fill, display and the same format
  rows), `namedRange/<name>`, `table/<name>` and `chart/<index>` (type, title, legend, series
  ranges, axis titles and bounds). The rows are in `packages/sheet-bundle/object-model/`. A
  `host.objects` batch reaches ONE plugin-level planner (every kind's ops, in batch order),
  applies to the engine, stores the workbook as a content-addressed version
  (`versions/<hash>.xlsx` + `.json`) and answers a `state` write hosted on `doc` under the
  sub-key `x-paged:media.paged.sheet.wb`, which the registry merges into the document label's
  `data.wb` (other sub-keys survive; labels written before read unchanged): one undo step, and
  document undo/redo reloads the version the label names. The range `values`, `inputs` and
  `display` rows are `heavy` (skipped by `getAll` unless asked); typed command arguments carry
  struct defaults (`count` 1, `live` true, `header` true, the find options false). A
  100-cell range write is one engine write, one save, one commit and two part writes (a pinned
  budget). Typed commands (16 typed twins of palette commands, plus `publishDataset` /
  `unpublishDataset`) take value-typed arguments; 8 commands remain untyped. The bundle boots in
  `createHeadlessHost` with the real engine for get, set, batch and undo.
- **Template fields** (editor plan G3; extensions ADR 335). Three module field kinds, in
  `packages/sheet-bundle/src/template-fields.ts`, are the parts of a workbook a template can
  open to a filler; each reads and writes through `host.objects` (one batch, one undo step,
  checked by the engine against the session's role) and refuses a value with one sentence:
  - `media.paged.sheet.cell` `{ ref, type?, allowed?, min?, max? }`: one cell's constant
    (`ref` is `Sheet!A1` or a defined name); a text, a number (`type: "number"`, with bounds)
    or a choice (`allowed`). Grants `text.edit` and `text.style`.
  - `media.paged.sheet.range` `{ ref, columns?, rows? }`: a range's values as a table (rows of
    strings, column order; `columns` titles them). `rows: "fixed"` (the default) takes exactly
    the range's rows; `rows: { min?, max? }` takes up to the range's own rows and clears the
    rest. Grants `text.edit` and `text.style`.
  - `media.paged.sheet.chartSource` `{ chart, allowed: [{ name, label?, series }] }`: which of
    the author's series lists a chart draws.

  A cell holding a formula, and a value starting with `=`, are refused. The workbook's version
  label is the sheet's own document-level state, which a template with a sheet field opens to
  a filler (engine ADR 1000, amendment of 2026-10-23). Every placed table that shows a written cell is re-poured
  after the write: each must be a sheet field itself (its grants say it may be re-poured), or
  the write is refused before anything changes. A placed chart is redrawn by replacing its art,
  so a chart's source is writable only where the template lets a filler add and delete items.
  Not a field kind yet: a list data validation as a cell's choice (the engine reports how many
  validations a sheet has, not their lists), and a growable range that inserts rows (a placed
  table keeps the range it was placed with).

- **Layout commands** (plan G4; `src/layout-commands.ts`). Typed `importCsv { text, name }`,
  `mergeCells`, `unmergeCells`, `setBorders { range, edges: all | outline | top | right |
bottom | left, style, color? }`, `setColumnWidth` and `setRowHeight { sheet, first, last?,
size? }` (no size clears it), each one workbook version and one undo step.
- **Placement and chart delete** (plan G4). Typed `place { source: range | name | printArea,
ref, chain?, repeatHeaderRows }` puts an A1 range, a defined name or table (the placement
  keeps the name, as the panel's Place does) or a sheet's print area (`_xlnm.Print_Area`,
  resolved by the engine; `ref` is the sheet) on the page as one table in a new frame, or,
  with `chain` (a frame of a threaded chain), paginated across the chain with the leading rows
  repeated, live as the palette's Paginate is. Each placement is one document write and one
  undo step: the first pagination of a chain is one batch on a host with in-batch handles
  (core protocol 66), every page's table addressed by its handle and each swatch or style
  minted once; an older host places table by table. Typed `deleteChart { chart }` removes the
  chart from the workbook (`delete_chart`: the slot stays, so every other chart keeps its
  index; the chart journal replays the delete) and every placed copy of it (found on the scene
  tree by its binding, so a chart placed in an earlier session goes too), one workbook version
  and one undo step; a `host.objects` delete of `chart/<n>` does the same in its batch.
  `apps/cli/test/cli-sheet.spec.ts` runs both through `paged-node invoke`. Not a placement
  kind yet: a frame's view and sizing (`sizing: "window"`, print headings and gridlines, ADR
  510), whose page side is not wired to placement; a print area of several ranges; a chart read
  from the workbook stays in the saved xlsx (the writer never re-derives chart parts) and is
  deleted again from the journal when the version is loaded.
- **Datasets, both ways.** A dataset-sourced sheet re-pulls on every provider revision by default
  (`live: false` keeps the old mark-stale behaviour), and a sheet range can be published as a
  `dataset` provider whose revision moves with every edit.

## Limits of what is shipped

- **Object model.** The version label is the document's, not a frame's:
  core keeps one label per plugin per host, and a frame's already holds the placement binding.
  The page refresh after a write is a second document step. Charts the object model creates or
  changes are kept as a chart-op journal next to each version; charts authored in the panel are
  not.
- **Engines before protocol 66.** Placing a range takes two writes and so two undo steps (frame
  and table, then content), because one write needs the engine to resolve a table handle inside
  a batch; and each in-frame grid change invalidates every page cache. Core v0.66.0 and later
  resolve the handle, and a grid change re-encodes only the pages that show its frame.
- **The protocol-66 doors are used directly** (the in-tree engine has them): a shrinking
  pagination deletes the tables it no longer needs (should the engine refuse, they are emptied
  and kept), placed elements are read back from the batch's own `minted` list, and a frame's
  story is one geometry read.
- **Engines before core v0.71.8** leave a blank line above a table placed in a fresh frame. The
  frame is sized without that line, so on those engines a freshly placed table's frame is one
  line short.
- **Data bars** are page paths stacked one step under the table's frame: a frame that later had
  another item stacked directly over it gets its bars under that item. Paginated chains and
  tables rediscovered from an earlier session draw no bars. Under a header band the host added,
  the bars are drawn from the table's top, not from the first workbook row: no read reports the
  band's height.
- **Rediscovery** finds tables placed by this version; a table placed before the binding
  carried its table record is not found again. Charts and paginated chains are not
  rediscovered.
- **Colours.** `getStyle` and the page lowering resolve theme and indexed colours through the
  theme part and the workbook palette; conditional-format colour-scale stops still use the
  default Office theme.
- **One workbook** is stored at a time; importing another replaces it.
- **Icon criteria.** Sorting by a conditional-format icon is refused and an icon filter keeps
  every row (`filterState` reports it as not applied): the styler does not compute icon sets yet.
  Tables' own AutoFilters are read and kept; the filter doors work on the sheet's AutoFilter.
- **Formulas** are the Excel en-US dialect only. On load, a formula the parser does not read
  keeps its cached value (an external defined name or DDE item, `[1]!Name`), and so does one
  calling a function the engine does not know or never runs (WEBSERVICE, CUBEVALUE).
- **Calculation model limits** (ADR 513): a root in parentheses is snapped where Excel does not; SUM's own cancellation is not snapped; a row
  insert does not move a 3D reference; a recursive LAMBDA stops at 128 nested calls (`#NUM!`);
  a load always calculates, also in manual mode; loaded rich-value errors read as `#VALUE!` until
  recalculated.
  `TREND` fits one regressor only.
- **Typed entry** follows Excel (ADR 511): month names and `TRUE`/`FALSE` are English in every
  locale; `#GETTING_DATA` typed stays text; a number re-entered by undo keeps 15 significant
  digits.
- **Locale.** The display locale is taken from the workbook's number formats on load.
- **Saving an edited sheet** writes a new or changed literal text cell as an inline string
  (`t="inlineStr"`), not into the shared-string table. Two calculation findings show on a save of an edited sheet (measured on the Excel-converted
  corpus): the members of a legacy array formula (`{=MINVERSE(…)}`) are not kept as cells, so
  their cached values are not written; and a pre-dynamic-array formula that returns an array
  (`MMULT` in one cell) is written back as a dynamic array.

## Not built

- **The tab-separated lane with drawn rules** as a user choice: it runs only through an option
  the bundle never sets.
- **Exact decimal arithmetic:** a Cargo feature `sheet-js` does not enable
  ([ADR 501](adr/501-f64-numbers.md)).
- **Interpreting pivot tables, slicers or macros**
  ([ADR 504](adr/504-publishing-first-scope.md), amended by [ADR 517](adr/517-interactive-workbook-features.md)). External links are never followed; a formula
  over another workbook (`[1]Sheet1!A1`) evaluates from the values cached in the file.
- **Other file formats.** `.xlsx`, CSV and TSV are read; `.xlsx` is written; a legacy `.xls` is
  refused.
- **Localised function names and argument separators**, and CJK display locales.
- **A worker-hosted engine.** The manifest declares no worker capability.
- **Three registry rows marked `planned`:** `sheet.chart.design-markers`,
  `sheet.format.locale.cjk-followup`, `sheet.style.doc-style-group`.

## Releases

What each published canary of `@paged-media/sheet` added since 0.1.0-canary.8. A merge that
leaves the version unchanged publishes nothing; 0.1.0-canary.9 to .12 were never published.

| Version         | Published                      | Added                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0-canary.24 | not yet (a merge publishes it) | A new chart or lowered range goes beside (or at) the selection only while the selection is on the spread in view; once the view has moved to another spread it goes to the active page, as InDesign places onto the spread in view. Before, a selection anywhere in the document took it there: a chart placed with the last one still selected on the facing spread landed on that spread.                                                                    |
| 0.1.0-canary.23 | 2026-10-17                     | A range paginated over a frame chain re-splits when a chain frame is resized by its handles, not only by `resizeFrame`, on a host that reports a gesture's reflow (core v0.71.13, plugin-sdk 0.2.58). A stale placed table refreshed in place keeps a header or footer band the host added, on core v0.71.13, which reports band sizes. The real-engine tests move to canvas-wasm 0.71.13 and the contract to 0.2.58-canary.0; peers stay `>=0.2.45-canary.0`. |
| 0.1.0-canary.22 | 2026-10-16                     | A stale placed table refreshes in place, keeping its id and the host's formatting; a reshaped one is replaced, never written into. A new chart lands inside the page's margins.                                                                                                                                                                                                                                                                                |
| 0.1.0-canary.21 | 2026-10-16                     | A spill saves as Excel's dynamic array and reloads live; a reopen over an unchanged spilled workbook writes nothing; the spill-range operator answers as Excel does.                                                                                                                                                                                                                                                                                           |
| 0.1.0-canary.20 | 2026-10-13                     | No blank line above a placed table on core v0.71.8, which puts the table in the frame's first paragraph, so the frame is sized to the rows alone. The real-engine tests move to canvas-wasm 0.71.8.                                                                                                                                                                                                                                                            |
| 0.1.0-canary.19 | 2026-10-13                     | A number literal beyond the double-precision range is a formula error instead of infinity.                                                                                                                                                                                                                                                                                                                                                                     |
| 0.1.0-canary.18 | 2026-10-13                     | A placed table's frame is sized to the rows the engine lays out, so no row is overset. A placed chart is one grouped object, its labels sized to their text, beside the selection. The registry is read at build time with `serde_norway` instead of `serde_yaml`.                                                                                                                                                                                             |
| 0.1.0-canary.17 | 2026-10-11                     | Warnings a user sees say what happens in plain words instead of naming internal ids and wire terms.                                                                                                                                                                                                                                                                                                                                                            |
| 0.1.0-canary.16 | 2026-10-11                     | The panel pass: the grid follows the panel's width and shows refusals; the Workbook panel in collapsible sections; find and replace in the Grid panel; number format, font, fill, alignment and iterative calculation in Sheet properties; "Place on page" for "Lower to frame"; a second click before deleting; dataset display names.                                                                                                                        |
| 0.1.0-canary.15 | 2026-10-11                     | The object model (seven kinds, 16 typed command twins, `publishDataset` / `unpublishDataset`) and the Sheet properties panel; datasets that re-pull on every revision and ranges published as datasets; one engine instance per realm, with a trap reported as a diagnostic. Engine protocol 71 (canvas-wasm 0.71.1). Peers `>=0.2.45-canary.0`.                                                                                                               |
| 0.1.0-canary.14 | 2026-10-06                     | A reopened document restores its workbook on `document.onDidOpen` where the host reports opens. Tests against canvas-wasm 0.70.0.                                                                                                                                                                                                                                                                                                                              |
| 0.1.0-canary.13 | 2026-10-05                     | The first release since canary.8, with the 2026-10-04 round: the Excel oracle, the format and layout, names, sort, find, fill and clipboard work, placed tables that refresh in place, data bars, pagination with repeated headers, the protocol-66 doors, persistence of every edit, restore on open, the wheel in the in-frame grid, the will-save flush and one-call placement.                                                                             |
