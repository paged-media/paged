/*
 * This file is part of paged (https://paged.media).
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

//! PERF BUDGETS — the calc engine's work, counted (`sheet_calc::perf`).
//!
//! THE RULES, and they are the whole point of this file:
//!
//!  1. A budget is a COUNT, never a duration. Wall clock is trended by the
//!     criterion benches (`benches/`), never gated.
//!  2. A budget is the MEASURED value, pinned exactly — the bad ones
//!     included, with the number it should become written beside it.
//!  3. A budget is only ever LOWERED, in the same commit as the change that
//!     earns it. A budget that fails UPWARD means the change made the engine
//!     do more work; raising the number is not the fix. One that fails
//!     DOWNWARD means a change earned a lower number: lower it there.
//!  4. Every budget sits beside a behaviour assertion on the same edit — a
//!     cheap wrong answer must not pass.
//!
//! `PERF_SHOW=1 cargo nextest run -p sheet-calc --test perf_budgets
//! --no-capture` prints every scenario's counters (how a budget is found
//! before it is pinned, and how a failing one is read).
//!
//! The counters exist because the crate's own dev-dependency turns the
//! `perf-counters` feature on for tests; no shipped build carries them.

// Test names end in `__feat__<cockpit id>` — the cockpit link (CLAUDE.md).
#![allow(non_snake_case)]

use sheet_calc::perf::{self, PerfCounters};
use sheet_calc::{Engine, EngineConfig};
use sheet_core::{CellValue, SheetModel};
use sheet_parser::Edit;

fn engine() -> Engine {
    let mut m = SheetModel::new();
    m.add_sheet("Sheet1");
    Engine::new(m, EngineConfig::default())
}

fn enter(e: &mut Engine, row: u32, col: u32, raw: &str) {
    e.enter(0, row, col, raw).expect("input parses");
}

fn num(e: &Engine, row: u32, col: u32) -> f64 {
    match e
        .model()
        .sheet(0)
        .and_then(|ws| ws.cell(row, col))
        .map(|c| c.value.clone())
    {
        Some(CellValue::Number(n)) => n,
        other => panic!("({row},{col}) is not a number: {other:?}"),
    }
}

/// Run `f` with the counters zeroed and return what it did.
fn measure(f: impl FnOnce()) -> PerfCounters {
    perf::reset();
    f();
    perf::snapshot()
}

/// Print under `PERF_SHOW`, then pin the whole counter set.
fn check(scenario: &str, actual: PerfCounters, budget: PerfCounters) {
    if std::env::var_os("PERF_SHOW").is_some() {
        println!("PERF {scenario} {actual:?}");
    }
    assert_eq!(
        actual, budget,
        "{scenario}: the work moved. Higher = a regression (fix the change, \
         never raise the budget); lower = earned (lower the budget in this commit)"
    );
}

/// A1:A{n} = 1..n, B{i} = SUM($A$1:A{i}) — the running total. Every B
/// registers its OWN range box, so a write to A1 dirties all n formulas,
/// and each dirty cell's probe scans all n boxes.
fn running_total(n: u32) -> Engine {
    let mut e = engine();
    for i in 0..n {
        enter(&mut e, i, 0, &(i + 1).to_string());
    }
    for i in 0..n {
        enter(&mut e, i, 1, &format!("=SUM($A$1:A{})", i + 1));
    }
    e
}

const N: u32 = 2000;

// COVERS: the range-dependency walk (graph.rs dependents_of / precedents_in,
// the M1 interval-index seam) and range materialization (argview.rs).
// Editing A1 of a 2000-row running total: 2000 evaluations are inherent
// (every total changes). The dirty walk is the interval index's: each
// probe costs the tree levels plus its hits (before 2026-10 each probe
// scanned every box: 4 000 000). The first 32 totals (shorter than a
// snapshot is worth) read the grid; from the 33rd, column A is snapshotted
// once and every total is its anchored prefix (sheet ADR 512) — before
// that, SUM's own scan read N²/2 = 2 001 000 cells.
#[test]
fn perf_running_total_edit_head__feat__sheet_calc_engine() {
    let mut e = running_total(N);
    let work = measure(|| enter(&mut e, 0, 0, "10"));
    // Behaviour: every total moved by +9.
    let n = f64::from(N);
    assert_eq!(num(&e, 0, 1), 10.0);
    assert_eq!(num(&e, N - 1, 1), n * (n + 1.0) / 2.0 + 9.0);
    check(
        "running-total n=2000, edit A1",
        work,
        PerfCounters {
            range_probes: 2_001,
            range_keys_scanned: 2_011, // 2000 hits + 11 tree levels (was 4 002 000: every probe scanned every box)
            precedent_candidates_scanned: 2_000, // one column seek per dirty total (was 4 000 000: boxes × dirty cut)
            ranges_materialized: 2_000,
            cells_read: 2_528, // 528 grid reads by the 32 short totals + one 2 000-row snapshot (was 2_001_000: N²/2)
            cells_visited: 528, // the prefix answers read no view cell (was 2_001_000)
            snapshot_cells: 2_000,
            accel_hits: 1_968,
            evaluations: 2_000,
            recalcs: 1,
            recalc_passes: 1,
            cells_marked_dirty: 2_000,
        },
    );
}

// COVERS: the same walk from the tail — one formula reads A2000, so only one
// evaluation is inherent; the probe walks the tree levels to its one hit.
#[test]
fn perf_running_total_edit_tail__feat__sheet_calc_engine() {
    let mut e = running_total(N);
    let work = measure(|| enter(&mut e, N - 1, 0, "0"));
    let n = f64::from(N);
    assert_eq!(num(&e, N - 1, 1), n * (n + 1.0) / 2.0 - n);
    assert_eq!(num(&e, N - 2, 1), (n - 1.0) * n / 2.0);
    check(
        "running-total n=2000, edit A2000",
        work,
        PerfCounters {
            range_probes: 2,
            range_keys_scanned: 12, // 11 tree levels + 1 hit (was 4 000)
            precedent_candidates_scanned: 1,
            ranges_materialized: 1,
            cells_read: 2_000,
            cells_visited: 2_000,
            snapshot_cells: 0,
            accel_hits: 0,
            evaluations: 1,
            recalcs: 1,
            recalc_passes: 1,
            cells_marked_dirty: 1,
        },
    );
}

// COVERS: building the running total formula by formula — what a paste or
// a load-by-entry pays. (Before the index each entry probed every box
// registered so far; now the column-B writes meet no lane holding a box.)
#[test]
fn perf_running_total_build__feat__sheet_calc_engine() {
    let mut e = engine();
    let work = measure(|| {
        for i in 0..N {
            enter(&mut e, i, 0, &(i + 1).to_string());
        }
        for i in 0..N {
            enter(&mut e, i, 1, &format!("=SUM($A$1:A{})", i + 1));
        }
    });
    let n = f64::from(N);
    assert_eq!(num(&e, N - 1, 1), n * (n + 1.0) / 2.0);
    check(
        "running-total n=2000, build",
        work,
        PerfCounters {
            range_probes: 4_000,
            range_keys_scanned: 0, // no probe meets a lane holding a box (was 2 001 000)
            precedent_candidates_scanned: 2_000,
            ranges_materialized: 2_000,
            cells_read: 2_001_000, // N²/2 — inherent for SUM-by-scan (copies: 2_001_000 → 0)
            cells_visited: 2_001_000,
            snapshot_cells: 0,
            accel_hits: 0,
            evaluations: 2_000,
            recalcs: 4_000, // one per entry — the batched scenario below: 1
            recalc_passes: 2_000,
            cells_marked_dirty: 2_000,
        },
    );
}

// COVERS: the same build through the batch door (Engine::set_cells): one
// recalc, every total evaluated once, no probe meets a box.
#[test]
fn perf_running_total_build_batched__feat__sheet_calc_engine() {
    let mut e = engine();
    let work = measure(|| {
        let mut batch = Vec::new();
        for i in 0..N {
            batch.push((0, i, 0, e.parse_input(0, &(i + 1).to_string()).unwrap()));
        }
        for i in 0..N {
            let f = e.parse_input(0, &format!("=SUM($A$1:A{})", i + 1)).unwrap();
            batch.push((0, i, 1, f));
        }
        e.set_cells(batch);
    });
    let n = f64::from(N);
    assert_eq!(num(&e, N - 1, 1), n * (n + 1.0) / 2.0);
    assert_eq!(num(&e, 0, 1), 1.0);
    check(
        "running-total n=2000, build in one set_cells batch",
        work,
        PerfCounters {
            range_probes: 4_000,
            range_keys_scanned: 0,
            precedent_candidates_scanned: 2_000,
            ranges_materialized: 2_000,
            cells_read: 2_528, // one recalc, so one column snapshot + prefixes (was 2_001_000: SUM's own scan)
            cells_visited: 528,
            snapshot_cells: 2_000,
            accel_hits: 1_968,
            evaluations: 2_000,
            recalcs: 1, // per-entry lane: 4 000
            recalc_passes: 1,
            cells_marked_dirty: 2_000,
        },
    );
}

const T: u32 = 1000;

/// A1:B1000 a key/value table (key i+1 → value 10·(i+1)); C{i} a key to
/// look up, D{i} = VLOOKUP(C{i},$A$1:$B$1000,2,FALSE).
fn vlookup_sheet() -> Engine {
    let mut e = engine();
    for i in 0..T {
        enter(&mut e, i, 0, &(i + 1).to_string());
        enter(&mut e, i, 1, &((i + 1) * 10).to_string());
    }
    for i in 0..T {
        // Keys in reverse so no lookup hits the first row.
        enter(&mut e, i, 2, &(T - i).to_string());
        enter(
            &mut e,
            i,
            3,
            &format!("=VLOOKUP(C{},$A$1:$B${T},2,FALSE)", i + 1),
        );
    }
    e
}

// COVERS: one shared range box read by 1000 formulas. A write into the
// table dirties all 1000 lookups (inherent under whole-range invalidation).
// The first lookup scans the grid; then both table columns are snapshotted
// and every other lookup finds its row in the exact-match index and hands
// the kernel the table cut to that row (sheet ADR 512). Before, each lookup
// read its key column until it matched (501 500 cells; before 2026-10 each
// evaluation copied all 2000 cells).
#[test]
fn perf_vlookup_edit_table__feat__sheet_calc_engine() {
    let mut e = vlookup_sheet();
    // Row 500 holds key 500; the lookup for key 500 sits in D501 (C501 = 500).
    let work = measure(|| enter(&mut e, 499, 1, "-1"));
    assert_eq!(num(&e, 500, 3), -1.0);
    assert_eq!(num(&e, 0, 3), f64::from(T * 10));
    check(
        "vlookup 1000 over 1000x2, edit a table value",
        work,
        PerfCounters {
            range_probes: 1_001,
            range_keys_scanned: 1, // the one shared table box (flat-scanned lane)
            precedent_candidates_scanned: 2_000, // 2 column seeks per lookup (was 1 000 000)
            ranges_materialized: 1_000,
            cells_read: 4_001, // 1 001 for the first lookup's scan + 2 snapshotted columns (was 501_500)
            cells_visited: 3_997, // the cut kernels read 2 cells each (was 501_500)
            snapshot_cells: 2_000,
            accel_hits: 998,
            evaluations: 1_000,
            recalcs: 1,
            recalc_passes: 1,
            cells_marked_dirty: 1_000,
        },
    );
}

// COVERS: editing one lookup KEY — the cheap path. One evaluation, one
// lookup scan; the dirty walk is a single cell edge.
#[test]
fn perf_vlookup_edit_key__feat__sheet_calc_engine() {
    let mut e = vlookup_sheet();
    let work = measure(|| enter(&mut e, 0, 2, "7"));
    assert_eq!(num(&e, 0, 3), 70.0);
    check(
        "vlookup 1000 over 1000x2, edit a key",
        work,
        PerfCounters {
            range_probes: 2,
            range_keys_scanned: 0,
            precedent_candidates_scanned: 1,
            ranges_materialized: 1,
            cells_read: 8, // the lookup reads 7 keys + 1 value (was 2_000 COPIED)
            cells_visited: 8,
            snapshot_cells: 0,
            accel_hits: 0,
            evaluations: 1,
            recalcs: 1,
            recalc_passes: 1,
            cells_marked_dirty: 1,
        },
    );
}

// COVERS: a structural edit (apply_edit) — the graph is rebuilt from scratch
// and EVERY formula re-evaluates, whatever the edit touched.
#[test]
fn perf_insert_row__feat__sheet_calc_engine() {
    const R: u32 = 1000;
    let mut e = running_total(R);
    let work = measure(|| {
        e.apply_edit(&Edit::InsertRows {
            sheet: 0,
            at: R / 2,
            n: 1,
        });
    });
    // Behaviour: the row below the insert point moved down one, and the last
    // total still sums every value (its range grew over the blank row).
    let r = f64::from(R);
    assert_eq!(num(&e, R, 1), r * (r + 1.0) / 2.0);
    assert_eq!(num(&e, R / 2 + 1, 0), r / 2.0 + 1.0);
    check(
        "running-total n=1000, insert a row mid-way",
        work,
        PerfCounters {
            range_probes: 0,
            range_keys_scanned: 0,
            precedent_candidates_scanned: 1_000, // one seek per formula (was 1 000 000) — evaluations stay all-dirty
            ranges_materialized: 1_000,
            cells_read: 1_529, // 528 short totals + 1 001-row snapshot (was 501_000: SUM-by-scan)
            cells_visited: 528,
            snapshot_cells: 1_001,
            accel_hits: 968,
            evaluations: 1_000, // every formula, whatever the edit touched — only the shifted ones need it
            recalcs: 1,
            recalc_passes: 1,
            cells_marked_dirty: 1_000,
        },
    );
}

/// A1:A{n} = 1..n and C1 = SUM(A:A) — a whole-column reference.
fn whole_column_sum(n: u32) -> Engine {
    let mut e = engine();
    for i in 0..n {
        enter(&mut e, i, 0, &(i + 1).to_string());
    }
    enter(&mut e, 0, 2, "=SUM(A:A)");
    e
}

const WHOLE: u32 = 10_000;

// COVERS: a whole-column reference (`SUM(A:A)`) — its range view and its one
// interval-index box. The view's geometry is all 1 048 576 rows; the sum must
// cost the POPULATED rows, not the column: `cells_visited` is the kernel's
// whole scan, blanks below the data included.
#[test]
fn perf_whole_column_sum_edit__feat__sheet_calc_engine() {
    let mut e = whole_column_sum(WHOLE);
    let work = measure(|| enter(&mut e, 5, 0, "0"));
    let n = f64::from(WHOLE);
    assert_eq!(num(&e, 0, 2), n * (n + 1.0) / 2.0 - 6.0);
    check(
        "whole column SUM(A:A) over 10 000 rows, edit A6",
        work,
        PerfCounters {
            range_probes: 2,
            range_keys_scanned: 1, // the one A:A box — a whole column is one interval
            precedent_candidates_scanned: 1,
            ranges_materialized: 1,
            cells_read: 10_000,
            cells_visited: 10_000, // the populated rows (was 1 048 576: the kernel scanned the whole column)
            snapshot_cells: 0,
            accel_hits: 0,
            evaluations: 1,
            recalcs: 1,
            recalc_passes: 1,
            cells_marked_dirty: 1,
        },
    );
}

/// A1:A1000 a category column (`c0`…`c9`), B1:B1000 amounts; D{k} =
/// SUMIF over the category `c{k}` and E{k} = COUNTIF of it, k = 0..9.
fn category_totals() -> Engine {
    let mut e = engine();
    let mut batch = Vec::new();
    for i in 0..T {
        batch.push((0, i, 0, e.parse_input(0, &format!("c{}", i % 10)).unwrap()));
        batch.push((0, i, 1, e.parse_input(0, &(i + 1).to_string()).unwrap()));
    }
    for k in 0..10 {
        let sumif = format!("=SUMIF($A$1:$A${T},\"c{k}\",$B$1:$B${T})");
        let countif = format!("=COUNTIF($A$1:$A${T},\"C{k}\")");
        batch.push((0, k, 3, e.parse_input(0, &sumif).unwrap()));
        batch.push((0, k, 4, e.parse_input(0, &countif).unwrap()));
    }
    e.set_cells(batch);
    e
}

// COVERS: the equality-criterion index (sheet ADR 512). Editing one amount
// dirties every SUMIF (they share the amount box) and the COUNTIFs do not
// move. The first SUMIF scans the grid; the other nine read their 100 rows
// out of the category column's text index instead of testing all 1000.
#[test]
fn perf_sumif_categories_edit_amount__feat__sheet_calc_accel() {
    let mut e = category_totals();
    let work = measure(|| enter(&mut e, 499, 1, "0"));
    // Row 500 is category c9 (499 % 10) and held 500.
    let c9: f64 = (0..T)
        .filter(|i| i % 10 == 9)
        .map(|i| f64::from(i + 1))
        .sum();
    assert_eq!(num(&e, 9, 3), c9 - 500.0);
    assert_eq!(num(&e, 9, 4), 100.0);
    check(
        "10 SUMIFs over a 1000-row category column, edit an amount",
        work,
        PerfCounters {
            range_probes: 11,
            range_keys_scanned: 1, // the one shared amount box
            precedent_candidates_scanned: 20,
            ranges_materialized: 20,
            cells_read: 3_100, // the first SUMIF's 1 100-cell scan + 2 snapshotted columns (kernels alone: 11 000)
            cells_visited: 2_000, // 1 100 + 9 × 100 matched amounts (kernels alone: 11 000)
            snapshot_cells: 2_000,
            accel_hits: 9,
            evaluations: 10,
            recalcs: 1,
            recalc_passes: 1,
            cells_marked_dirty: 10,
        },
    );
}
