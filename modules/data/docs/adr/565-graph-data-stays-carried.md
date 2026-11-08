# ADR 565 — Illustrator graph data stays carried, not resolved

- **Status:** Accepted 2026-11-08 (W9 slice 4; records a gap, builds nothing).
- **Scope:** `paged-data-dataset` (`VarTrait::GraphData`, `xml.rs`), the chart readers `dml-chart` and the sheet
  engine, the engine model (no chart item).

## Context

An Illustrator variable library can hold `graphdata` variables: the series of a chart object. The dataset codec
reads, preserves and re-emits their body verbatim and resolves nothing ("carried, never resolved"). The earlier
reason was the isolation contract: paged.data could not reach the module that draws charts. Since PM-0015 and
PM-0017 the data layer is a platform layer, so that reason is gone. Asked in W9: resolve them through the sheet
charts (`dml-chart` and the sheet engine) if feasible.

## Finding

It is not feasible as a small step, for three reasons that are about the target, not the contract:

1. **There is no chart item in the engine model to bind to.** A chart exists as a DrawingML part inside a sheet,
   a slide or (not yet) a doc; `dml-chart` reads and draws that part inside the module that owns it. A `graphdata`
   variable would have to name a chart in an InDesign or Illustrator-origin document, and the engine has no such
   object: an Illustrator graph is a native `GraphObject` with its own series, axes and style, not a DrawingML chart.
2. **The payload is opaque on purpose.** The codec keeps the body verbatim because Illustrator's graph data
   (a tab-separated grid with a header convention, wrapped in the Adobe Graphs namespace) is undocumented outside
   Adobe's applications. A reader would be reverse-engineered without an oracle in the repository; the installed
   Illustrator can produce one, but a mapping to a DrawingML chart loses the graph styling that makes the variable
   worth binding.
3. **Doc has no charts yet** (capability register, "Charts, data, scripting, PDF"), so the one module a data
   set targets in doc has nothing to receive the series.

## Decision

`graphdata` stays carried. The doc comment of `VarTrait::GraphData` now names this ADR instead of the retired
isolation argument. The way it closes: (a) doc gains charts through `dml-chart` (register item), (b) the engine
gets a chart item or a chart-series binding target, (c) an Illustrator graph payload reader is written against
samples exported by the installed Illustrator. Until (b) exists nothing here can be resolved; (a) and (c) are not
blocked.

## Consequences

No behaviour changes. Round-tripping an Illustrator library keeps its graph variables as before.
