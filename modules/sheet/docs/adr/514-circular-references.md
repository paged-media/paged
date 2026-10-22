# ADR 514 — Circular references: a cycle member keeps its last value

- **Status:** Accepted, 2026-10-22. Supersedes the `#REF!` ruling in
  [ADR 502](502-recalculation-and-spill.md) (Cycles) and registry row `sheet.calc.circular`.
- **Scope:** `sheet-calc` (`Engine::recalc_dirty`), `sheet-js` (the circular warning).

## Context

With iterative calculation off, the engine stored `#REF!` in every member of a cycle. Excel
does not: it warns, does not calculate the cycle, and the cells keep what they showed — a cell
never calculated shows 0. Recorded against Excel (`corpus/calc-model/cases.tsv`, `circ-*`): on
a full calculation of a workbook whose cycles carry no cached value, Excel leaves the members,
and every cell downstream of them, uncalculated — it saves them as an empty string and shows 0.

## Decision

With `CalcSettings::iterative` off, a cycle member is not evaluated. It keeps its stored value;
one that holds nothing (never calculated) becomes 0. Cells downstream of the cycle are
evaluated from those values (`TopoOrder::after`). The cycle set is reported on
`RecalcResult::circular` as before, which is what the session turns into the circular warning.
With iteration on, the cycle iterates as before (seeded at 0).

## Evidence

- `sheet-calc/src/lib.rs` (`recalc_dirty`, the cycle branch); tests
  `sheet-calc` `circular_keeps_last_values_and_reports`, `iterative_off_keeps_last_values`,
  `sheet-conformance/tests/it/calc_graph.rs::sheet_calc_circular`, `itercalc.rs`.
- `oracle/excel/calcmodel-divergences.tsv`: the 11 `circ-*` cells, where Excel's file holds an
  empty string (shown 0) and the engine 0, and the downstream `C1` where Excel shows 0 and the
  engine the value computed from the member's 0.

## Alternatives considered

- **Leave dependents uncalculated too**, as Excel's full calculation does: the engine would need
  a "never calculated" state a `CellValue` cannot hold, and an interactive Excel computes them.
- **Keep `#REF!`:** it is no Excel behaviour and hid the values a user had.

## Consequences

A cycle member's value depends on the order of the edits that closed the cycle, as in Excel.
The batch door and a sequence of single edits agree on the cycle set, not necessarily on the
members' values (`sheet-calc/tests/it/set_cells.rs`). Breaking the cycle recalculates
normally.

## Related

- [ADR 502](502-recalculation-and-spill.md), [ADR 513](513-calc-model-amendment.md)
