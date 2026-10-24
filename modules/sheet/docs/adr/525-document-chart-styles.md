# ADR 525 — Document chart styles: roles, a colour-group palette, a workbook default

- **Status:** Accepted, 2026-10-23. Completes the chart half of P7 (document styles); builds on
  [ADR 518](518-cell-visual-model-and-colour-references.md) (colour and text-style references),
  [ADR 519](519-charts-excel-parity.md) (chart style roles) and
  [ADR 520](520-document-styles-in-the-frame.md) (document styles in the frame); extends
  [ADR 503](503-xlsx-patched-not-regenerated.md) (one more paged extension, spliced).
- **Scope:** `sheet-chart/src/style.rs`, `ChartModel::palette`; `sheet-xlsx/src/parts/chart_style.rs`,
  `XlsxDocument::{chart_style, set_chart_style}`, the `model` attribute and `pg:palette` of the
  chart `pg:refs` extension (`parts/chart.rs`); `sheet-js` `chart_style`, `set_chart_style`,
  `use_chart_style_as_default`, `update_chart` (`roles`, `resetRoles`, `seriesPalette`),
  `chart_specs` (`roles`, `seriesPalette`); the bundle's `chart-style.ts`, the object-model paths
  `chart.roles`, `chart.seriesColorGroup`, `workbook.chartStyle`, and the Workbook panel's
  Chart style section (`panels/chart-style-section.tsx`).

## Context

ADR 519 made every chart role a `ColorRef` or `TextStyleRef` that can name a document swatch or
paragraph / character style, and the page already references what a role names. Only the series
colour and the title's paragraph style could be set, every swatch was recorded as RGB whatever
the document said, and there was no way to say "our charts look like this" once for a workbook.

## Decision

1. **Roles.** Colour roles: `chartArea`, `plotArea` (fills), `axisLine` (every axis line),
   `gridlines` (every axis' gridlines — never added where the chart has none). Text roles:
   `text` (the chart default every text inherits), `title`, `axisTitle`, `tickLabels`, `legend`,
   `dataLabels`, each a paragraph style, a character style and a colour swatch. A role names a
   kind of slot, not one slot.
2. **An override is a document reference.** A chart overrides a role where its model holds a
   document reference there — what the per-chart door writes and what the chart part's `pg:refs`
   restores. Each part of a text role overrides on its own. Giving an override up drops the
   reference; a colour that was only the reference's fallback returns to automatic.
3. **The workbook default** (`ChartStyle`: role references plus an optional palette) fills every
   role a chart does not override, over the concrete value the workbook stores. It is applied to
   a copy of the model at every geometry call (`sheet_chart::style::effective`); the stored chart
   keeps only its own overrides, so changing the default reaches every chart without touching
   one. "Use as default for this workbook" moves a chart's overrides into the default (the chart
   looks the same and follows it); "Reset to default" gives a chart's role overrides and palette
   up.
4. **A colour group as series colours.** Series `i` in drawing order takes the group's swatch
   `i mod n`; a one-series plot with varied colours (a pie) takes them per point. A series whose
   own colour names a swatch keeps it; a chart's own palette wins over the workbook's. The group's
   swatches are stored resolved (id, model, fallback), so the chart draws without the document.
5. **The real colour model.** The bundle reads each swatch from the document
   (`host.document.swatchDisplay`): model `rgb | cmyk | spot | lab` and the sRGB it shows. Doors
   take `{id, model, fallbackRgb}` (a bare id still works, as an RGB swatch); the chart part's
   `pg:ref` gains `model="…"`.
6. **Storage, patched.** The workbook default is one paged extension at the end of
   `workbook.xml`'s `<extLst>` (`uri="{8E2A6C41-3B7D-4F09-A1C5-6D9E2B7F4A18}"`,
   `xmlns:pg="urn:paged:sheet:chartstyle"`, swatches as `id|model|RRGGBB`), spliced when it
   changes; every other byte of the part stays. A chart's palette rides its part's `pg:refs`
   extension as `<pg:palette group="…"><pg:swatch ref="…"/>…` (read on import). The chart
   writer (ADR 519, W4.3) is to record the chart's own references there (with `model`) and write
   the concrete colours of `effective_chart_model`, so another spreadsheet application shows what
   the page shows; until it splices edited charts, a chart's overrides persist with the object
   model's journalled chart ops.
7. **One undo step, through the object model.** The panel writes `chart.roles` (a write replaces
   the chart's overrides), `chart.seriesColorGroup` and `workbook.chartStyle` with document ids;
   the object model reads the referenced swatches and colour group from the document before
   planning, refuses an id the document lacks, journals the resolved chart patch with the
   workbook version (so a stored version replays it) and the placed charts redraw through the
   session's refresh when their geometry changes.

## Consequences

- Editing a document swatch recolours every placed chart that names it with no redraw: the page
  references the swatch (verified on the real engine: the exported spreads are unchanged, the
  swatch's display colour is new).
- A chart is drawn with its document style everywhere the geometry is used — the page, the panel
  palette and a save.
- The in-frame grid does not draw charts; a style change previews on the placed chart.

## Amendment (2026-10-24): the chart writer carries the references

A chart written to the xlsx shows the colours it draws — the workbook default chart style applied
where the chart does not override a role — so another application sees what Paged shows. The
paged extension keeps only the chart's own references, now with each swatch's colour model
(`model="…"` on `pg:ref`) and the chart's colour-group palette (`<pg:palette>`), so a reload
restores them; changing the workbook default marks every chart to be written again.
