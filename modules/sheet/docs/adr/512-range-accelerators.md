# ADR 512 — Range accelerators: per-recalc column snapshots, anchored prefixes, exact-match indexes

- **Status:** Accepted, 2026-10-22.
- **Scope:** `sheet-calc` (`accel.rs`, `argview.rs`, `eval.rs`, `lib.rs`, `topo.rs`,
  `dirty.rs`, `graph.rs`).

## Context

A grid that behaves like Excel has to recalculate a real workbook within a frame or two of an
edit. The interval index (2026-10) already finds the dirty formulas in `O(log n)` per probe,
but evaluation stayed quadratic for the two most common workbook shapes:

- a running total, `B{i} = SUM($A$1:A{i})`: editing `A1` re-evaluates every total, and each
  total re-scanned its range — 10 000 rows took 1.33 s;
- many lookups into one table, `VLOOKUP(C{i}, $A$1:$B$10000, 2, FALSE)`: editing the table
  re-evaluates every lookup, and each scanned the key column until it matched — 1.59 s.

Every range cell was read through a boxed getter and a lookup in the row-major sparse grid
(`Worksheet.cells`, a `BTreeMap<(row, col)>`), so a column scan cost one tree descent per
cell. A 100 000-cell chain of plain cell references (no ranges) took 81 ms, half of it in the
topological sort's hash maps and per-node allocations.

## Decision

Accelerate inside the evaluator, for the length of one `Engine::recalc_dirty` call, and keep
the kernels as they are: pure, and the specification.

1. **Column snapshots.** A range view of at most 8 columns with at least 32 live rows asks
   `accel::column` for a dense `Vec<CellValue>` of each column over its live rows. The first
   request for a column in a recalc reads the grid as before (a lone formula pays nothing
   extra); the second builds the snapshot, which then grows by doubling to cover wider
   requests. A snapshot never extends past the sheet's populated rows; one of 4096 rows or more
   that is less than 1/16 filled is abandoned for the recalc. Views read the snapshot instead
   of the grid.
2. **Exactness by construction.** Every engine write during a recalc (a computed value, a
   spilled cell, a cleared spill cell) calls `accel::note_write`, which updates the snapshot in
   place and drops what was derived from the old value (prefixes are truncated at the written
   row, indexes rebuilt on next use). The state is thread-local, scoped to the recalc, and tied
   to the model by identity; outside a recalc nothing changes.
3. **Anchored prefix aggregates.** `SUM`, `COUNT`, `COUNTA`, `AVERAGE`, `MIN` and `MAX` of one
   single-column range read the running fold from the range's first live row, extended lazily
   and kept per anchor (up to 8 per column). Only ranges whose scan STARTS at the anchor use
   it, so the value is the kernel's own left-to-right fold bit for bit — a difference of two
   prefixes would not be, and other ranges fall back to the kernel over the snapshot. Errors,
   text, logicals and blanks follow the kernels: the first error in scan order wins for `SUM`,
   `AVERAGE`, `MIN`, `MAX`; `COUNT` counts numbers; `COUNTA` everything not blank.
4. **Exact-match indexes.** Per column: value → ascending rows, with numbers keyed by value
   (`-0 = 0`), logicals, errors, ASCII-case-folded text, and the blank rows apart (a blank equals
   `0`, `FALSE` and a blank key under `coerce::compare`). `MATCH` (type 0), `XMATCH` and
   `XLOOKUP` (exact mode, first-to-last or last-to-first) answer the position directly;
   `VLOOKUP` (exact) hands the kernel the table cut to the one row found (or to no rows), so the
   kernel still produces the value and its own argument errors. `COUNTIF` / `SUMIF` with an
   equality criterion (a number, a plain text without operator or wildcard, a logical or an
   error) read the matching rows from indexes keyed by `to_number` and by `to_text`, exactly as
   `criteria::matches` decides. Wildcard keys and criteria, operators, and a blank criterion
   are never indexed. Approximate `VLOOKUP` and `MATCH` (1 / -1) binary-search the non-blank
   cells of the searched rows only when a running count of order breaks proves them sorted the
   way the kernel assumes; on unsorted data the kernel's linear scan keeps its own answer. A
   column holding a NaN is never indexed.
5. **Everything else falls through.** Any argument shape a fast path does not recognise
   (several ranges, a range criterion, a masked SUBTOTAL view, `HLOOKUP`, `SUMIFS` /
   `COUNTIFS`) runs the kernel, over snapshots where they exist.
6. **A switch.** `Engine::set_accelerators(false)` turns all of it off. The proptest
   `sheet-calc/tests/it/accel_equivalence.rs` builds random sheets (numbers including `-0` and
   extremes, numeric text, case variants, empty text, logicals, errors, blanks, formulas inside
   the snapshotted column) with the accelerators on and off, applies edits and batches, and
   requires every cell bit-identical; deliberately broken fast paths fail it.
7. **The engine loop.** The topological sort works on dense ids in `CellRef` order (a sorted
   edge list as adjacency, integer heap, `Vec` in-degrees), dirty propagation walks dependents
   through a callback without allocating, and evaluation looks a cell up once to decide its path
   and once to commit. Orders and results are unchanged.

The batch door (`Engine::set_cells`, `SheetSession::set_cells`, the facade's `setCells`) already
existed; paste, fill, clear and sort already write through it, so one gesture is one recalc and
the snapshots serve every formula it dirties.

## Consequences

Measured natively (`cargo bench -p sheet-calc --bench calc -- --quick`, Apple silicon, work
counters on): 10 000-row running total head edit 1.33 s → 4.0 ms; 10 000 `VLOOKUP`s over a
10 000-row table, table edit 1.59 s → 9.3 ms; 100 000-cell chain head edit 81 ms → 39.5 ms.
The release wasm through the `set_cell` door (bun, headless): running total 3.08 s → 14 ms,
lookups 3.77 s → 15 ms, chain 188 ms → 118 ms (most of it serializing the 100 000 changed
cells the door reports). The work budgets (`tests/perf_budgets.rs`) count grid reads: the 2000-row running total reads
2 528 cells instead of 2 001 000.

A recalc that touches one formula pays nothing (snapshots start on a column's second request).
One edit per recalc still rebuilds its snapshots, so the work is linear in the columns a recalc
reads, not in the edit; keeping snapshots across recalcs would need every model write outside
the engine to be tracked and is not done. Snapshots copy cell values (text included) for the
length of a recalc. Row-oriented lookups (`HLOOKUP`, horizontal `XLOOKUP`) and multi-criteria
`SUMIFS` / `COUNTIFS` read snapshots but have no index yet.
