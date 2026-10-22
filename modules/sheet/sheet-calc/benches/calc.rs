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

//! Wall-clock benches for the calc engine — TRENDED, never gated (the gates
//! are the count budgets in `tests/perf_budgets.rs`; a duration moves with
//! the machine, a count does not).
//!
//! `cargo bench -p sheet-calc` (add `-- --quick` for a fast pass). The
//! `perf-counters` feature is on in bench builds (the crate's own
//! dev-dependency), which costs a thread-local add per counted event.
//!
//! The SUM-form running total runs at n = 10 000: its head edit was ~n²
//! (1.3 s at 10k) until the anchored prefix aggregates (sheet ADR 512) made
//! it linear (~4 ms). The cell-chain form (`B{i} = B{i-1} + A{i}`) has no
//! range edges and runs at 100k. The `quadratic` group keeps its name for
//! trend continuity.

use criterion::{criterion_group, criterion_main, Criterion};
use sheet_calc::{Engine, EngineConfig};
use sheet_core::{CellValue, SheetModel};

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

/// A{i} = 1, B1 = A1, B{i} = B{i-1} + A{i} — a running total over cell
/// edges only.
fn chain_total(n: u32) -> Engine {
    let mut e = engine();
    for i in 0..n {
        enter(&mut e, i, 0, "1");
    }
    enter(&mut e, 0, 1, "=A1");
    for i in 1..n {
        enter(&mut e, i, 1, &format!("=B{}+A{}", i, i + 1));
    }
    e
}

/// A{i} = 1, B{i} = SUM($A$1:A{i}) — a running total over n range boxes.
fn sum_total(n: u32) -> Engine {
    let mut e = engine();
    for i in 0..n {
        enter(&mut e, i, 0, "1");
    }
    for i in 0..n {
        enter(&mut e, i, 1, &format!("=SUM($A$1:A{})", i + 1));
    }
    e
}

/// A1:B{n} a key/value table, D{i} = VLOOKUP(C{i}, $A$1:$B${n}, 2, FALSE)
/// for n lookups.
fn vlookup(n: u32) -> Engine {
    let mut e = engine();
    for i in 0..n {
        enter(&mut e, i, 0, &(i + 1).to_string());
        enter(&mut e, i, 1, &((i + 1) * 10).to_string());
    }
    for i in 0..n {
        enter(&mut e, i, 2, &(n - i).to_string());
        enter(
            &mut e,
            i,
            3,
            &format!("=VLOOKUP(C{},$A$1:$B${n},2,FALSE)", i + 1),
        );
    }
    e
}

/// Edit the head of the column, alternating 1 ↔ 2 so every iteration does
/// the same work (the value really changes each time).
fn bench_edit_head(c: &mut Criterion, name: &str, mut e: Engine, n: u32) {
    let mut flip = false;
    c.bench_function(name, |b| {
        b.iter(|| {
            flip = !flip;
            enter(&mut e, 0, 0, if flip { "2" } else { "1" });
        })
    });
    let tail = num(&e, n - 1, 1);
    assert!(
        tail == f64::from(n) || tail == f64::from(n) + 1.0,
        "tail total {tail}"
    );
}

fn running_total(c: &mut Criterion) {
    const CHAIN: u32 = 100_000;
    bench_edit_head(
        c,
        "running_total_chain_100k_edit_head",
        chain_total(CHAIN),
        CHAIN,
    );

    const SUM: u32 = 10_000;
    let mut g = c.benchmark_group("quadratic");
    g.sample_size(10);
    let mut e = sum_total(SUM);
    let mut flip = false;
    g.bench_function("running_total_sum_10k_edit_head", |b| {
        b.iter(|| {
            flip = !flip;
            enter(&mut e, 0, 0, if flip { "2" } else { "1" });
        })
    });
    g.finish();
}

fn vlookup_table(c: &mut Criterion) {
    const N: u32 = 10_000;
    let mut g = c.benchmark_group("quadratic");
    g.sample_size(10);
    let mut e = vlookup(N);
    let mut flip = false;
    // Edit a table VALUE: every lookup reads the box, so all N recalc.
    g.bench_function("vlookup_10k_over_10k_edit_table", |b| {
        b.iter(|| {
            flip = !flip;
            enter(&mut e, N / 2, 1, if flip { "-1" } else { "0" });
        })
    });
    // Edit one lookup KEY: one formula recalcs (one table copy).
    g.bench_function("vlookup_10k_over_10k_edit_key", |b| {
        b.iter(|| {
            flip = !flip;
            enter(&mut e, 0, 2, if flip { "7" } else { "8" });
        })
    });
    g.finish();
    assert!(matches!(num(&e, 0, 3), 70.0 | 80.0));
}

/// A1:B{n} a key/value table, D{i} = XLOOKUP(C{i}, $A$1:$A${n}, $B$1:$B${n}).
fn xlookup(n: u32) -> Engine {
    let mut e = engine();
    let mut batch = Vec::new();
    for i in 0..n {
        batch.push((0, i, 0, e.parse_input(0, &(i + 1).to_string()).unwrap()));
        batch.push((
            0,
            i,
            1,
            e.parse_input(0, &((i + 1) * 10).to_string()).unwrap(),
        ));
        batch.push((0, i, 2, e.parse_input(0, &(n - i).to_string()).unwrap()));
        let f = format!("=XLOOKUP(C{},$A$1:$A${n},$B$1:$B${n})", i + 1);
        batch.push((0, i, 3, e.parse_input(0, &f).unwrap()));
    }
    e.set_cells(batch);
    e
}

/// A1:A{n} categories c0..c99, B1:B{n} amounts; D{k} = SUMIF over c{k}.
fn sumif_categories(n: u32) -> Engine {
    let mut e = engine();
    let mut batch = Vec::new();
    for i in 0..n {
        batch.push((0, i, 0, e.parse_input(0, &format!("c{}", i % 100)).unwrap()));
        batch.push((0, i, 1, e.parse_input(0, &(i + 1).to_string()).unwrap()));
    }
    for k in 0..100 {
        let f = format!("=SUMIF($A$1:$A${n},\"c{k}\",$B$1:$B${n})");
        batch.push((0, k, 3, e.parse_input(0, &f).unwrap()));
    }
    e.set_cells(batch);
    e
}

fn index_lookups(c: &mut Criterion) {
    const N: u32 = 10_000;
    let mut g = c.benchmark_group("quadratic");
    g.sample_size(10);
    let mut e = xlookup(N);
    let mut flip = false;
    g.bench_function("xlookup_10k_over_10k_edit_table", |b| {
        b.iter(|| {
            flip = !flip;
            enter(&mut e, N / 2, 1, if flip { "-1" } else { "0" });
        })
    });
    let mut e = sumif_categories(N);
    g.bench_function("sumif_100_over_10k_edit_amount", |b| {
        b.iter(|| {
            flip = !flip;
            enter(&mut e, N / 2, 1, if flip { "-1" } else { "0" });
        })
    });
    g.finish();
}

criterion_group!(benches, running_total, vlookup_table, index_lookups);
criterion_main!(benches);
