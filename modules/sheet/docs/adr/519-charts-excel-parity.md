# ADR 519 — Charts as Excel draws them: plots, every kind, style roles, written back

**2026-10-23 · decision record · status: ACCEPTED (W4 of the Excel-in-the-frame program;
amends [016](016-chart-engine-plotters-chartgeometry.md) and
[503](503-xlsx-patched-not-regenerated.md)).**

## Context

Until W4 a chart was one kind with a flat series list, ten kinds were drawn, and everything
else was drawn as a column without saying so: a 3-D pie, a surface, a stock chart, a 3-D line
all became columns (`sheet-xlsx/src/parts/chart.rs`, the `unwrap_or(Column)` after the kind
loop). Lines and areas ignored `c:grouping`; 100% stacked bars were approximated; a combo chart
kept only its last plot's kind; there were no markers, data labels, trendlines, error bars,
log axes, gridlines or legend positions; colours were `#RRGGBB` literals; charts authored in
Paged never reached the xlsx; chartEx parts (waterfall, funnel, treemap, sunburst, histogram,
pareto, box & whisker) were not found at all, and sparklines and chartsheets were not read.
In the corpus 17 of 172 charts were drawn as the wrong kind.

## Decisions

1. **A chart is a list of plots.** `ChartModel.plots: Vec<Plot>`, each with its kind, grouping
   (standard / stacked / percent-stacked), axis group (primary or secondary) and type options
   (gap, overlap, hole, first slice, bubble scale, pie-of-pie split, high-low lines, up/down
   bars, chartEx layout). A combo chart is several plots; authoring a combo gives each series a
   kind and an axis group and `set_series` groups consecutive series into plots.

2. **Every kind is drawn as itself.** New kinds: bubble, stock (HLC/OHLC), filled radar,
   pie-of-pie, bar-of-pie, surface (as a contour of value bands), waterfall, funnel, treemap,
   sunburst, histogram, pareto, box & whisker; doughnuts are concentric rings (one per series)
   drawn as ring segments. A 3-D element is its 2-D kind with `flattened_3d` set (shown in the
   chart list and carried in the geometry). An element nothing draws (a region map, an unknown
   future type) is `Unsupported`: a dashed placeholder naming the type. RULING
   `sheet.chart.kinds.pie-series`: a pie draws its first series, as Excel does.

3. **Excel's layout rules.** Value axes use Excel's automatic bounds (5% headroom, a 1-2-5
   major unit, zero included unless the data sit in a narrow band away from it), logarithmic
   and reversed scales, crossing points (`autoZero`, `min`, `max`, a value — bars grow from
   the crossing), date axes by base unit, and the axis or source number format. Stacking
   follows Excel: positive values up and negative values down on separate running totals;
   percent-stacked on 0–100% (this replaces the floor-clamp ruling of
   `sheet.chart.geometry.stacked`). Blank and error cells are gaps (text is 0). Legends take
   the side their position names. Default colours are the workbook theme's accents in Excel's
   tier order, under the chart style's colour column (`c:style`).

4. **Series features.** Markers (Excel's symbols and automatic sequence), data labels (value,
   category, series, percent, bubble size; position; number format), trendlines (linear,
   exponential, logarithmic, polynomial 2–6, power, moving average; forward/backward,
   intercept, R² and equation) fitted with the function library's least-squares solver — the
   one LINEST uses — and error bars (fixed, percentage, standard deviation centred on the mean,
   standard error, custom ranges).

5. **Style roles.** Every colour role (series fill and line, markers, axis, gridlines, plot
   area, chart area, label text) is a `ColorRef` and every text role (title, axis titles, tick
   labels, data labels, legend) a `TextStyleRef` — the cell visual model's own types
   (`sheet-core` `visual`, [ADR 518](518-cell-visual-model-and-colour-references.md)): the
   concrete colour or font beside an optional document swatch or paragraph/character style. The geometry carries the document reference next to the resolved colour
   (`fillSwatchRef`, `strokeSwatchRef`, a text's `colorSwatchRef`, `paragraphStyle`,
   `characterStyle`); the page lowering references the swatch instead of minting one, applies
   the paragraph or character style to the label and lets its frame size itself
   (`textFrameAutoSizing`). A DrawingML scheme slot maps to the shared type's spreadsheet theme
   index (dk1/lt1 and dk2/lt2 swap) on read and back on write.

6. **The IR grows only optional fields.** `ChartGeometry` keeps its five primitives; W4 adds
   fields that are omitted when unset (the references above, a wedge's `innerR`, a line's
   `dash`, a text's colour, weight, face and role, the geometry's `flattened3d`), so a consumer
   that ignores them draws the same chart.

7. **chartEx, sparklines, chartsheets are read.** The drawing's `/chartEx` relationship is
   followed and the part read by the shared `dml_chart::chart_ex`; `x14:sparklineGroups` in a
   worksheet's captured `<extLst>` become `SparklineGroup`s drawn by `sheet_chart::sparkline`
   in a cell box; a workbook sheet whose relationship is a chartsheet is flagged and its chart
   marked `chartsheet`.

8. **Charts are written back** (amends [503](503-xlsx-patched-not-regenerated.md)). The
   shared `dml_chart::write` describes a chart module-neutrally (`ChartOut`, `ChartExOut`) and
   generates `c:chartSpace` / `cx:chartSpace` parts in schema order, plus the primitives that
   patch a part as read (`put_child` in schema order, the paged extension). paged.sheet splices
   an edited chart (only the changed roles), generates an authored one with its anchor and
   relationships, and removes a deleted one. A chartEx part is written with the `cs:chartStyle`
   and `cs:colorStyle` parts Excel requires before it opens one. Colours are written as their
   concrete value (`a:srgbClr`, or `a:schemeClr` with `lumMod`/`lumOff` for a theme-sourced
   role); text roles as `a:latin`, size, bold and italic in `c:txPr`. Document references ride
   in a paged `c:extLst` extension and are restored on import only while the concrete value is
   unchanged. The extension also records each chart's session index, and a load places such a
   chart at that index (the others fill the remaining slots in file order), so placements,
   journals and template fields keep naming the right chart after a save and reload; a deleted
   chart's slot stays empty. Excel writes a chartEx part's data as hidden `_xlchart.v1.N`
   defined names; the reader resolves them.

## Consequences

- The corpus lane `chart_corpus` (opt-in, private corpus) checks that every chart renders
  with the kind its elements name: 172 of 172 do, 17 of them 3-D and flagged.
- `sheet-chart` depends on `sheet-fn` (for the solver); `sheet-xlsx` reaches it through
  `sheet-chart`. Neither depends on anything above it.
- The geometry snapshots (`sheet-chart/tests/snapshots/*.json`, one per kind and feature)
  are reviewed as diffs; `UPDATE_SNAPSHOTS=1` re-records them.
