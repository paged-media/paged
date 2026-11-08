# ADR 724 — Autofit and chart-data editing: the reach audit (W7)

- **Status:** Accepted, 2026-11-08. Records two checked gaps of the capability register's reach
  matrix. No code changes: both need a decision above this module (an engine feature; a contract
  door), and the reasons are written down so the next attempt starts from facts.
- **Scope:** `slide-resolve` (`text.rs`, `shrink`), `slide-native`, `pptx-export` (`probe.rs`),
  `slide-sheet`, `packages/slide-bundle` (`chart-surface.tsx`); engine `paged-model`
  (`AutoSizingType`), PM-0002, ADR 715.

## 1. Autofit: `fontScale` and `lnSpcReduction` stay fixed values

**What is stored.** `a:normAutofit` carries `fontScale` and `lnSpcReduction`: the factors
PowerPoint last computed when the text was edited. PowerPoint does not recompute them when it
opens a file; it draws the stored values. `slide-resolve` reads both as `shrink` and multiplies
every run's size and the line spacing by them (`text.rs`), so the imported text is laid out as
PowerPoint laid it out. `pptx-export` writes the factors back unchanged for a frame whose text
did not change.

**What the engine has.** `paged_model::AutoSizingType` (`HeightOnly`, `WidthOnly`,
`HeightAndWidth`, `HeightAndWidthProportionally`) lets a frame GROW to fit its text. That is the
engine's answer to `a:spAutoFit` and slide already uses it (`HeightOnly`, anchored at the text
anchor) so that overset text shows. There is no shrink-to-fit: no field says "reduce the text size
until it fits", and the composer does not search for a scale. The register's wording was right.

**Decision.** Not carried by the engine today, so recorded, not faked:

- Kept: the stored factors, as fixed values. They are exactly what PowerPoint draws for the file
  as it was saved (checked against the fixtures PowerPoint authored: ADR 705).
- Open: text edited in the editor inside a `normAutofit` frame does not re-shrink (PowerPoint
  does). The edit is made at the stored scale; the frame grows (`HeightOnly`) rather than the
  text shrinking.
- What it takes, for whoever carries it: a `TextFramePreference` shrink field in `paged-model`
  (a minimum scale and a line-spacing floor, `serde(default)`, so no format bump), a fit search in
  the composer (re-compose at decreasing scales until the story is not overset, as PowerPoint does
  in steps of 10 % of the stored size, cached per story version), the wire/catalog rows
  (`frameAutoShrink…` paths) with the full resync (catalog, `wire.d.ts`, `core-commands.generated.ts`,
  the contract canary), the IDML/PDF export losses, and then `slide-native` setting it from
  `Autofit::Normal` instead of scaling the runs, with `pptx-export` reading the engine's computed
  scale back into `fontScale`. That is an engine ADR (1000 range) and a composer change, larger
  than this wave's slides and with its own fidelity gate; it was not started.

## 2. Chart data editing on paged.sheet's surface: blocked by the module contract

**What exists.** ADR 715 links the sheet crates into the slide wasm (`slide-sheet`: `sheet-core`,
`sheet-calc`, `sheet-xlsx`, `sheet-chart`, `sheet-format`) and edits a chart's data on a slide
surface of its own (`chart-surface.tsx`). The register says this is "a second compiled sheet
engine".

**What a shared engine would need.**

- The sheet engine is a wasm module of the sheet bundle (`sheet-js`), loaded by that bundle with
  one workbook per session (sheet ADR 506). Slide would have to run the same module with a
  workbook per chart, or load a second instance of it. TypeScript bundles may not import one
  another (PM-0002, enforced by `bun lint`), and the contract has no door that hands one bundle
  another's engine or surface. A new door (a host-provided "workbook engine" service) is a
  contract change: `plugin-api`/`plugin-sdk`, the canary bump, the conformance harness, and a
  decision on who loads and owns the module's lifetime.
- Linking `slide-sheet` out of the slide wasm moves the same bytes behind that door, not out of
  the product; the slide wasm would shrink only if the door exists. Slide's chart export
  (`dml_chart::write` of the edited caches, the embedded workbook's writer) and its redraw
  (`slide_sheet::prims`) run inside the slide wasm today, on the workbook the chart owns; moving
  them across the door means serialising the workbook both ways on every edit.
- The goldens that must stay bit-identical (the PowerPoint-verified chart decks) depend on
  `slide-chart` drawing from the workbook's cells with no change in the numbers; that stays true
  only if the calculation engine is the same code, which a shared instance would keep.

**Decision.** Left as is, recorded as blocked on a contract door (a host-provided workbook
engine, PM-0002 amendment). Nothing in this module can reach sheet's engine or surface without
it; a bundle-to-bundle import is exactly what the boundary rule forbids.

## Consequences

- The capability register's reach rows for slide say "autofit: stored values only; engine
  shrink-to-fit absent (ADR 724)" and "chart data: second sheet engine, blocked on a host door".
- No golden, wasm size or contract number changes.
