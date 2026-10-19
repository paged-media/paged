# ADR 709 — One DrawingML chart reader and model for paged.slide and paged.sheet; the layouts stay per module

- **Status:** Accepted 2026-10-19.
- **Scope:** `platform/shared/dml-chart` (the crate `dml-chart`), `pptx-import/src/chart.rs`,
  `pptx-core/src/chart.rs`, and paged.sheet's `sheet-xlsx/src/parts/chart.rs`. The element tree
  this reads (slide ADR 702) moves to `paged_ooxml::tree` (doc ADR 607).

## Context

A deck and a workbook carry the same chart part, a DrawingML `c:chartSpace`. paged.slide read it
into its own model (`pptx-core::chart`) with a reader over its element tree; paged.sheet read it
with a streaming scanner of its own that kept only what its curated chart kinds draw. Two
readers of one format, written to different depths: slide's knew the caches, axes, labels and
paints but not the formulas a series is bound to; sheet's knew the formulas and little else.

How the two applications lay a chart out does differ, and is each module's to keep: PowerPoint
draws from the cached values with the paddings and scales `slide-chart` measures; paged.sheet
binds the series to live cells and draws its curated kinds with `sheet-chart`.

## Decision

- **One reader, one model.** `dml_chart::chart(root, props)` reads a `c:chartSpace` element
  tree into `Chart`: the plots in file order (with each plot's element name, so a 3-D variant is
  visible), the series with their cached names, categories and values and the `c:f` formulas
  they are bound to (`SeriesRefs`), the axes, the title and the legend.
- **The paints are the module's.** The model is generic over the shape-property and
  text-property types, and the reader hands every `c:spPr` and `a:rPr` / `a:defRPr` to the
  module's `Props`, in file order. paged.slide passes its `ShapeProps` / `RunProps` readers, so
  its chart model is the shared one with its own paints (`pptx-core::chart` is type aliases);
  paged.sheet passes `()` and reads no paint at all.
- **The layout profiles stay in the modules.** `slide-chart` (PowerPoint's layout from the
  caches) and `sheet-chart` (the curated kinds and geometry over live cells) are unchanged.
- **paged.sheet's reading rules stay its own.** It folds the shared model into its frozen
  `ChartModel` as before: the last plot of a curated kind decides the kind (a 3-D variant does
  not), a bar plot's own direction and grouping pick the variant, the series of every plot
  bind to their `c:f` ranges, and two rules read the element tree directly, because they are
  the Excel profile's rather than the format's: a series' colour is the first `a:srgbClr` in
  it, and the chart's title is the first non-empty text run of the first title that has one.
- **The element tree reads what paged.sheet's scanner read.** The chart namespace includes the
  strict one (`http://purl.oclc.org/ooxml/drawingml/chart`), which the local-name scanner had
  always accepted, and element text has its line ends normalised as XML 1.0 requires (a title
  written with CR LF reads with LF, as it did).

## Evidence

- `platform/shared/dml-chart/src/read.rs`, `src/model.rs`, `tests/read.rs`
- `modules/slide/pptx-import/src/chart.rs` (the `Props` for a deck), `modules/slide/pptx-core/src/chart.rs`
- `modules/sheet/sheet-xlsx/src/parts/chart.rs` (the fold into `ChartModel`)

## Consequences

- A chart construct either module learns to read (a new chart type, a formula form) is read
  once, for both.
- paged.slide's deck IR carries each plot's element name and each series' formulas.
- paged.sheet compiles the element tree and the full reader; its wasm still shrinks overall
  with wave C (shared-foundations record).
