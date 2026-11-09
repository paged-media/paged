# ADR 628 — Word's charts are drawn from their cached values as anchored groups

- **Status:** Accepted 2026-11-08.
- **Scope:** `docx-core` (`ChartDrawing`, `Run::charts`), `docx-import` (`chart`,
  `objects::drawing_chart`), `docx-lower` (`chart`, `LoweredChart`), `docx-skeleton` (`body`),
  `slide-chart` (`outline`, shared with `slide-resolve`), the doc manifest's wasm ceiling.
- **Builds on:** ADR 614 (floats as anchored objects), 618 (the shared DrawingML mapper), 625 (the
  native body), 627 (shapes as anchored frames along their outline); slide ADR 709 (one chart
  reader) and 715 (live charts through paged.sheet).

## Context

A chart in a Word document is a `w:drawing` whose graphic is a `c:chart r:id`; the relationship
names a chart part (`word/charts/chartN.xml`, a DrawingML `c:chartSpace`) that holds every series'
cached names, categories and values, which Word draws from, and links the embedded workbook
Word opens to edit the data. Doc counted the drawing as one it does not carry and showed nothing.

paged.slide draws the same part two ways (slide ADR 715): from the cached values with PowerPoint's
layout (`slide-chart`, which formats labels with `sheet-format`), or live from its workbook through
paged.sheet's engine (`sheet-xlsx`, `sheet-calc`, `sheet-chart`), which a chart needs once its data
is edited.

## Decision

- **Static first.** Doc draws a chart from its cached values with paged.slide's layout:
  `slide_chart::layout` lays out PowerPoint's chart, and Word's is the same Office chart engine.
  The live path is not linked: doc edits no chart data yet, and paged.sheet's reader, calculation
  engine and chart geometry are megabytes; it is the next step when chart data editing comes to
  doc (the slide bundle's `slideChart` edit context is the model).
- **Read.** `docx_import::objects::drawing_chart` takes the drawing's extent and float as a shape's;
  the part's tree reader (the pass that reads shapes' looks) records each chart's relationship id by
  `wp:docPr/@id`. `docx_import::chart` resolves it to the part and reads it with `dml_chart::chart`
  into paged.slide's chart model (`pptx_core::chart::Chart`, whose paints are the shared DrawingML
  paint IR), the chart's `c:spPr` and `a:rPr` read through `paged_ooxml::drawingml`. A linked,
  missing or unreadable part, and the Office 2016 kinds (`cx:chart`), stay drawings that are not
  carried, as before.
- **Lower.** `docx_lower::chart` places the chart as a shape is (ADR 627: a float at Word's position
  with Word's wrap, an inline chart a character of its line) and turns each primitive of the layout
  into a piece of a `LoweredChart`, in z-order: a bar, line, area, wedge or gridline is an outline
  in its own box (the contour from `slide_chart::outline`, which `slide-resolve` now uses too, so
  the Bézier arcs of a pie are one definition) with its look through `dml-native`; a title, legend
  entry or axis label is a text frame of one paragraph, lowered as a text box's paragraph is, with
  the label's size, weight, resolved colour and font (the theme's minor or major face for `+mn-lt`
  and `+mj-lt`) as direct formatting, no spacing and single lines.
- **Build.** `docx-skeleton` makes an anchored Group frame (`docx_chartN`) whose children are
  outlined anchored Rectangles and anchored TextFrames, each label with a story of its own beside
  the body's (as an anchored text box has). The renderer's anchored pass already places a group's
  children by their bounds.
- **Not placed.** A chart in a table cell, as a shape there (ADR 627), with a warning on open. An
  embedded placement (the batch builder) takes no charts and pours the TypeScript way.
- **Save.** Nothing is written: the drawing, the chart part, its relationships and the embedded
  workbook stay as they were, byte for byte, on an unedited and on an edited save.

## Size

The ceiling of `docx_js_bg.wasm` (the manifest's `maxBytes`) goes from 8,388,608 B (8 MiB) to
9,437,184 B (9 MiB), on the owner's decision of 2026-11-08 to raise it for charts and SmartArt
instead of shipping a second wasm. Measured on this change (release, `wasm-doc`, wasm-opt), on the
author's machine: 8,529,596 B, against 8,377,028 B there before it; the chart reader, the layout,
the label formatter (`sheet-format`) and the lowering cost about 150 KB. CI's `doc / rust` build
of this change measured 8,533,653 B. The editor's `dist/` budget (PM-0013, 73 MiB) is not raised
by this change.

## Evidence

- `docx-conformance` `charts` (nextest): the two body charts read with their title, series and
  cached values; the column chart lowered to six bars in two colours inside its box and labels for
  the title, the legend and the categories; the pie to three wedges of three colours; the chart in a
  table cell told; the chart parts, their relationships and the workbooks byte-identical after an
  unedited and after an edited save.
- `docx-skeleton` `body_native`: the whole body stays native; each chart is an anchored Group of
  outlined Rectangles and TextFrames whose stories are made beside the body's.
- `slide-chart` `outline` tests; slide's chart suites unchanged (`slide-resolve` draws through the
  shared contour).
- `test/headless/charts.spec.ts` (real engine): the bars and slices are painted in the theme's
  accents; an unedited export keeps the chart parts.
