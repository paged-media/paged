# ADR 715 — Live charts via paged.sheet

- **Status:** Accepted 2026-10-25. Part of the parity program ([ADR 711](711-powerpoint-parity-program.md)),
  wave 4. Builds on [ADR 709](709-one-drawingml-chart-reader.md) (one chart reader) and
  [ADR 710](710-chart-labels-are-formatted-by-sheet-format.md) (labels by sheet-format).
- **Scope:** `slide-sheet` (new), `slide-resolve` (`resolve_with`, the chart drawer),
  `slide-native` (`snippet`, the chart label), `pptx-export` (chart plans), `slide-js`
  (`LiveCharts`, the import's workbooks), `packages/slide-bundle` (`charts.ts`,
  `charts-model.ts`, `chart-surface.tsx`, manifest)

## Context

A PowerPoint chart holds its data twice: the cached values in the chart part, which PowerPoint
draws from, and an embedded workbook (`c:externalData`), which PowerPoint opens when the user
edits the data. paged.slide drew charts from the caches (`slide-chart`) as groups of native
shapes, and an edit inside one was refused on export. PowerPoint parity asks for a chart that is
live: its data edited in a sheet, the chart redrawn, the deck written back with the new values and
the new workbook.

paged.sheet already has every piece of a live chart: an xlsx reader and patching writer
(`sheet-xlsx`), a cell model and calculation engine (`sheet-core`, `sheet-calc`, `sheet-parser`),
a chart model bound to cells by the series' `c:f` formulas, and chart geometry (`sheet-chart`).

## Decision

- **paged.sheet's engine is linked into the slide wasm**, as `slide-chart` already links
  sheet-format (PM-0005: built-ins depend on each other through the workspace). The other way,
  through the sheet bundle's doors, was not taken: TypeScript modules may not import each other
  (PM-0002), the sheet bundle keeps one workbook per session (sheet ADR 506) while a deck has one
  per chart, and the contract has no door for one bundle to run another's engine. Cost: the
  slide wasm grows by the sheet crates it links (see Consequences).
- **A chart's workbook** (`slide_sheet::ChartBook`) is its embedded package read by
  `sheet-xlsx`, its formulas parsed and calculated as paged.sheet loads a file. A chart without
  one (or with one that cannot be read) gets a workbook made from its cached values, laid out as
  PowerPoint lays out a new chart's sheet (`Sheet1`; categories down column A from row 2; one
  series per column from B, its name in row 1), and its series are bound to those cells.
- **The binding is paged.sheet's.** The series are bound to cells by their `c:f` formulas, read by
  paged.sheet's chart reader; a cell entered (`=` a formula, else a literal, as typed into a
  sheet) recalculates the workbook, and the chart reads its values, names and categories from the
  cells.
- **Who draws.** `slide-chart` stays the drawing of the kinds it lays out as PowerPoint draws them
  (2-D bars, lines, areas, pies and doughnuts), now from the live values. Every other kind
  (scatter, bubble, radar, stock, surface, 3-D, the Office 2016 kinds), which `slide-chart` drew
  flat or not at all, is drawn by paged.sheet's chart geometry (`sheet_chart::generate` →
  `slide_sheet::prims` → the same native shapes). Measured on the corpus decks' charts
  (`slide-sheet/tests/oracle.rs`): `slide-chart` from the workbook's cells puts all 44 of
  PowerPoint's bars within 3 pt; paged.sheet's geometry (Excel's layout profile) misses by up to
  19 pt. PowerPoint is the oracle (ADR 705), so the plan's fallback runs the other way round:
  the sheet draws what the slide's layout cannot.
- **Import** draws every chart as before from its caches (PowerPoint draws from them, even when
  the workbook says otherwise); a chart drawn by paged.sheet is drawn from its cells. The report
  lists each chart part (origin, who draws it) with its workbook's bytes, and the bundle keeps
  them as container parts (`charts/<chart>.xlsx`, indexed by `charts/charts.json`). A chart
  frame's label names its chart part and its box (`chart`, `box`).
- **Editing.** A chart frame is entered like any content: double-click (an object type claims
  the frame's members; the first double-click enters the group, as for any group, the second the
  chart) enters the `slideChart` edit context, whose frame surface is the chart's data sheet: a
  grid of the workbook with the cells the chart reads tinted, sheet tabs, full screen. The
  context is entered on the shape that was double-clicked, so a surface over a box smaller than
  240 × 140 pt opens full screen, as PowerPoint opens Edit Data in a window of its own. Leaving (✓, Enter, a click outside) keeps the workbook in the document and redraws every
  frame of that chart: the slide wasm resolves the slide again with the live values, at the box
  the frame has now (moves and resizes kept), and answers the frame as the engine's page-item
  snippet (engine ADR 193); the bundle swaps it in for the old group in one batch (dissolve, delete
  the members, paste, restack at the old index), one undo step. Esc throws the session away.
- **Export.** The plan names each chart whose workbook the document edited, with the workbook.
  The chart part is the original with every series' caches rewritten from the cells (names,
  categories, values; formulas, formats and everything else kept, `dml_chart::write` splices);
  the embedded workbook part is replaced by the edited one (sheet-xlsx's writer: edited sheets
  re-encoded, every other part as read). A made workbook becomes the chart's embedded workbook: a
  new `ppt/embeddings/…xlsx` part, its relationship and `c:externalData`. The redrawn frame on the
  slide is accepted as the chart's (no "edits inside the chart" refusal). Untouched charts keep
  their bytes, and an unedited deck still exports its own file.

## Consequences

- PowerPoint opens an exported deck with an edited chart without repair and shows the new values;
  Edit Data opens the written workbook.
- Charts inside a PowerPoint group are drawn and their data exported, but are not redrawn on the
  page after an edit (the redraw replaces top-level groups only).
- A duplicated slide's chart shares the chart part: editing one copy's data redraws both.
- Workbook edits are kept in a container part and are not on the document's undo stack; undoing
  the redraw restores the old drawing, not the old values.
- The slide wasm carries the sheet engine: `slide_js_bg.wasm` is 5,184,454 B (4.94 MiB), about
  2.1 MB more than without it (3,057,871 B for the same revision line before this change),
  within the manifest's 8 MiB cap and the app-wide 120 MB budget. paged.sheet's own wasm is not
  loaded for it.
- Office's default chart style now strokes a line series that has no line of its own (2.25 pt,
  its automatic colour, round caps); before, such a line was not drawn.
