# ADR 523 — Conditional formatting: one model, evaluated in the calc engine, drawn the same on both surfaces

- **Status:** Accepted, 2026-10-23. Amends the frozen types (`sheet-core`, additive: a new
  `condfmt` module); supersedes the T2 subset of `sheet-lower/src/condfmt.rs` (kept as the
  static fallback for callers without an engine).
- **Scope:** `sheet-core/src/condfmt.rs`, `sheet-xlsx/src/parts/cf_model.rs`, `sheet-calc/src/cf.rs`,
  `sheet-lower/src/{cfdraw,styler,lib,tracks}.rs`, `sheet-grid`, `sheet-js/src/core/cf.rs`, the host
  model's bar / icon lanes and the grid painter.

## Context

The lowering evaluated a third of Excel's rule kinds (`cellIs` against numeric literals, an
`A1 op number` expression, colour scales over min/max, plain data bars). Everything that needs a
formula — operands like `$Z$1`, expressions, threshold formulas — or a whole-range statistic
(top N, averages, duplicates) was inert, and icon sets were not drawn at all. `sheet-lower` is pure
and cannot call the evaluator.

## Decision

1. **One model** (`sheet_core::condfmt`): `SheetCf { blocks: [CfBlock { ranges, rules }] }`, each
   `CfRule { kind, priority, stop_if_true, dxf (resolved DifferentialFormat), dxf_id, ext_id }` and
   `CfKind` for every type Excel writes: `cellIs` (formula operands), `expression`, `top10` (N and
   N %, top and bottom), `aboveAverage` (above/below, equal, standard deviations), duplicate /
   unique, the four text tests, `timePeriod`, blanks, errors, colour scales (every `cfvo` kind),
   data bars (the `x14` negative bars, axis, direction, border, solid fill, lengths) and icon sets
   (every set, `x14` custom icons); an unknown type is kept as `Unknown`. Formulas are text,
   relative to the block's first cell, as the file stores them.
2. **Read with the x14 extension.** `cf_model.rs` reads the 2006 blocks and the worksheet's
   `x14:conditionalFormattings`, merging an extension into its 2006 rule by `x14:id` and keeping
   extension-only rules as their own blocks. The captured XML still round-trips byte-identical.
3. **Evaluated in `sheet-calc/src/cf.rs`.** Formulas are parsed once per rule and moved to each
   cell (`rewrite_fill`) before `Engine::eval_formula_at`. Rules covering a cell are taken in
   priority order: a matching differential format merges under earlier ones (an earlier facet
   wins), the first colour scale / data bar / icon set is taken, `stopIfTrue` ends the walk.
   Whole-range statistics (sorted numbers, shared by the rules over the same ranges; mean and
   sample deviation; value counts; thresholds) are computed once per rule into a `CfCache` the
   session keeps per sheet until the next engine write.
4. **Drawn through the one styler.** The session hands the lowerings a `CellCfSource`; the
   `CellStyler` asks it once per cell and folds the outcome (a `VisualDelta` that can turn a facet
   off, a scale fill, a differential number format that renders the text, "show bar/icon only")
   into the cell's style key, and builds data bars (`bar_rect`) and icons (`place_icon`, vector
   polygons from `icon_shapes`) — the same geometry for the page and the grid. Empty cells under a
   rule are styled too (`containsBlanks`, `= 0`).
5. **Excel is the oracle.** A conditional-format display lane records Excel 16's display format
   (text, font and interior colour) for a fixture with one rule kind per column; colour scales
   interpolate by truncating each channel's step toward the lower stop, as Excel does.

## Consequences

- Every conditional format of the private corpus reads into a known kind and lowers (1,483
  blocks over 10 kinds); none is preserve-only any more.
- A 1,000,000-cell sheet under 20 rules: the grid's viewport takes 0.7 ms with the cache warm
  and 46 ms on the first frame after an edit (criterion, `sheet-calc/benches/cf.rs`).
- On the page, data bars are solid fills (a gradient bar shows its colour), the axis a solid
  line; a paginated chain draws neither bars nor icons yet (as before for bars).
