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

//! The range accelerators (sheet ADR 512) never change a value: random
//! sheets are recalculated with the accelerators ON and OFF
//! (`Engine::set_accelerators`) and every cell must come out bit-identical
//! (numbers compared by their bits, so `-0` vs `0` counts).
//!
//! The sheets mix the values the kernels treat differently — numbers
//! including `-0` and extremes, numeric text, case variants of text, the
//! empty string, logicals, errors, blanks — in key/value columns long
//! enough to be snapshotted, plus formulas IN the snapshotted column (so a
//! snapshot is written to while it is being read), then apply random edits
//! (each a recalc of its own) and batches.

// Test names end in `__feat__<cockpit id>` — the cockpit link (CLAUDE.md).
#![allow(non_snake_case)]

use proptest::prelude::*;
use sheet_calc::{perf, Engine, EngineConfig, SetInput};
use sheet_core::{CellError, CellValue, SheetModel};

/// splitmix64 — the sheet generator is driven from one proptest seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len() as u64) as usize]
    }
}

/// A literal from the pool the kernels distinguish (`None` = blank).
fn value(r: &mut Rng) -> Option<CellValue> {
    Some(match r.below(20) {
        0..=2 => return None,
        3..=7 => CellValue::Number(r.below(12) as f64),
        8 => CellValue::Number(*r.pick(&[
            -0.0,
            0.5,
            -3.25,
            1e308,
            -1e308,
            5e-324,
            1e15 + 0.3,
            0.1,
            0.2,
        ])),
        9..=11 => CellValue::from(*r.pick(&["a", "A", "b", "apple", "Apple", "x y", "Ä"])),
        12 => CellValue::from(*r.pick(&["5", "3", "0", " 4 ", "1e1", "-0"])),
        13 => CellValue::from(""),
        14 | 15 => CellValue::Bool(r.below(2) == 1),
        16 => CellValue::Error(*r.pick(&[CellError::Na, CellError::Div0, CellError::Value])),
        _ => CellValue::Number(r.below(4) as f64 * 0.1),
    })
}

/// A lookup key / criterion literal, as formula text.
fn key(r: &mut Rng) -> String {
    match r.below(16) {
        0..=5 => r.below(12).to_string(),
        6 => "0.5".into(),
        7 => "TRUE".into(),
        8 => "FALSE".into(),
        9..=11 => format!("\"{}\"", r.pick(&["a", "A", "APPLE", "b", "zz", "x y"])),
        12 => format!("\"{}\"", r.pick(&["5", "3", "0", "1e1"])),
        13 => format!("\"{}\"", r.pick(&["a*", "?", "~*", ">3", "<>a", "=b", ""])),
        14 => "#N/A".into(),
        _ => "\"\"".into(),
    }
}

fn col(c: u32) -> char {
    (b'A' + c as u8) as char
}

/// One random formula over the key/value columns A (keys) and B (values)
/// of `n` rows, written at row `at` (1-based in the text).
fn formula(r: &mut Rng, n: u32, at: u32) -> String {
    let a0 = if r.below(3) == 0 {
        1 + r.below(u64::from(n / 2)) as u32
    } else {
        1
    };
    let a1 = (a0 + r.below(u64::from(n + 4)) as u32).max(a0);
    let rng_ab = |c: char| format!("{c}${a0}:{c}{a1}");
    let k = key(r);
    match r.below(15) {
        0..=5 => {
            let f = r.pick(&["SUM", "COUNT", "COUNTA", "AVERAGE", "MIN", "MAX"]);
            // A running form (`$A$1:A{at}`) half the time.
            if r.below(2) == 0 {
                format!("={f}($A${a0}:A{})", at.max(a0))
            } else {
                format!("={f}({})", rng_ab('A'))
            }
        }
        6 => format!(
            "=VLOOKUP({k},$A${a0}:$B${a1},{},{})",
            1 + r.below(2),
            r.pick(&["FALSE", "TRUE", "0", "1"])
        ),
        7 => format!("=VLOOKUP({k},$A${a0}:$B${a1},2)"),
        8 => format!("=MATCH({k},{},{})", rng_ab('A'), r.pick(&["0", "1", "-1"])),
        9 => format!("=XMATCH({k},{},0,{})", rng_ab('A'), r.pick(&["1", "-1"])),
        10 => format!(
            "=XLOOKUP({k},{},{},\"nf\",0,{})",
            rng_ab('A'),
            rng_ab('B'),
            r.pick(&["1", "-1"])
        ),
        11 => format!("=XLOOKUP({k},{},{})", rng_ab('A'), rng_ab('B')),
        12 => format!("=COUNTIF({},{k})", rng_ab('A')),
        13 => format!("=SUMIF({},{k},{})", rng_ab('A'), rng_ab('B')),
        _ => format!("=SUMIF({},{k})", rng_ab('A')),
    }
}

fn input(e: &Engine, v: Option<CellValue>) -> SetInput {
    let _ = e;
    match v {
        None => SetInput::Empty,
        Some(v) => SetInput::Value(v),
    }
}

/// Build the same random sheet into two engines (accelerators on / off),
/// replay the same edits, and compare every cell after every step. Returns
/// how many calls the accelerated engine answered from its indexes.
fn run(seed: u64) -> u64 {
    let mut r = Rng(seed);
    let n = 40 + r.below(120) as u32;
    let mut on = Engine::new(SheetModel::new(), EngineConfig::default());
    let mut off = Engine::new(SheetModel::new(), EngineConfig::default());
    off.set_accelerators(false);

    // A sorted key column sometimes (approximate lookups take the binary
    // search only on sorted data).
    let sorted = r.below(3) == 0;
    let mut batch_spec: Vec<(u32, u32, Result<Option<CellValue>, String>)> = Vec::new();
    for row in 0..n {
        let a = if sorted {
            if r.below(8) == 0 {
                None
            } else {
                Some(CellValue::Number(f64::from(row / 2)))
            }
        } else if r.below(10) == 0 && row > 2 {
            // A formula inside the key column, reading the column above it.
            let f = r.pick(&["SUM", "COUNT", "MAX"]);
            batch_spec.push((row, 0, Err(format!("={f}(A$1:A{row})"))));
            continue;
        } else {
            value(&mut r)
        };
        batch_spec.push((row, 0, Ok(a)));
        batch_spec.push((row, 1, Ok(value(&mut r))));
    }
    let n_formulas = 10 + r.below(50) as u32;
    for i in 0..n_formulas {
        let c = 3 + (i % 4);
        let row = i / 4;
        batch_spec.push((row, c, Err(formula(&mut r, n, row + 1))));
    }
    perf::reset();
    let mut hits = 0;
    for e in [&mut on, &mut off] {
        let batch: Vec<_> = batch_spec
            .iter()
            .map(|(row, c, v)| {
                let inp = match v {
                    Ok(v) => input(e, v.clone()),
                    Err(f) => e.parse_input(0, f).expect("formula parses"),
                };
                (0u16, *row, *c, inp)
            })
            .collect();
        e.set_cells(batch);
        if hits == 0 {
            hits = perf::snapshot().accel_hits;
        }
    }
    compare(&on, &off, seed, "build");

    // Random single edits in the key / value columns, and a few batches.
    for step in 0..6 {
        let row = r.below(u64::from(n)) as u32;
        let c = r.below(2) as u32;
        let v = value(&mut r);
        if step % 3 == 2 {
            let row2 = r.below(u64::from(n)) as u32;
            let v2 = value(&mut r);
            for e in [&mut on, &mut off] {
                e.set_cells([
                    (0, row, c, input(e, v.clone())),
                    (0, row2, 1 - c, input(e, v2.clone())),
                ]);
            }
        } else {
            for e in [&mut on, &mut off] {
                e.set_cell(0, row, c, input(e, v.clone()));
            }
        }
        compare(
            &on,
            &off,
            seed,
            &format!("edit {step} at {}{}", col(c), row + 1),
        );
    }
    hits
}

fn same(a: &CellValue, b: &CellValue) -> bool {
    match (a, b) {
        (CellValue::Number(x), CellValue::Number(y)) => x.to_bits() == y.to_bits(),
        _ => a == b,
    }
}

fn compare(on: &Engine, off: &Engine, seed: u64, when: &str) {
    let (a, b) = (on.model().sheet(0).unwrap(), off.model().sheet(0).unwrap());
    let keys: std::collections::BTreeSet<_> = a.cells.keys().chain(b.cells.keys()).collect();
    for k in keys {
        let va = a.cells.get(k).map(|c| c.value.clone()).unwrap_or_default();
        let vb = b.cells.get(k).map(|c| c.value.clone()).unwrap_or_default();
        assert!(
            same(&va, &vb),
            "seed {seed} {when}: cell {}{} accelerated {va:?} vs kernel {vb:?}",
            col(k.1),
            k.0 + 1
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, .. ProptestConfig::default() })]

    #[test]
    fn accelerated_recalc_equals_kernels__feat__sheet_calc_accel(seed in any::<u64>()) {
        let _ = run(seed);
    }
}

/// The edge rows of the fast paths, pinned: a lookup range that starts
/// above the data (blank rows a `0` key matches), a whole-column range, and
/// a criterion a blank satisfies.
#[test]
fn accelerated_edges_equal_kernels__feat__sheet_calc_accel() {
    // The random sheets really do take the fast paths.
    let hits: u64 = (0..64).map(run).sum();
    assert!(hits > 500, "only {hits} accelerated calls over 64 sheets");
    let mut on = Engine::new(SheetModel::new(), EngineConfig::default());
    let mut off = Engine::new(SheetModel::new(), EngineConfig::default());
    off.set_accelerators(false);
    let mut batch_spec: Vec<(u32, u32, String)> = Vec::new();
    for row in 5..100 {
        batch_spec.push((row, 0, ((row * 7) % 13).to_string()));
        batch_spec.push((row, 1, (row * 10).to_string()));
    }
    for (i, f) in [
        "=MATCH(0,A1:A100,0)",
        "=XMATCH(0,A1:A200)",
        "=XMATCH(0,A1:A200,0,-1)",
        "=XLOOKUP(FALSE,A1:A200,B1:B200,\"none\")",
        "=VLOOKUP(0,A1:B100,2,FALSE)",
        "=COUNTIF(A:A,0)",
        "=COUNTIF(A1:A300,\"\")",
        "=SUMIF(A:A,3,B:B)",
        "=SUM(A:A)",
        "=COUNTA(A1:A300)",
        "=MATCH(5,A1:A100,1)",
        "=VLOOKUP(5,A6:B100,2)",
        "=MIN(A1:A100)",
        "=MAX(A6:A100)",
        "=AVERAGE(A1:A300)",
    ]
    .iter()
    .enumerate()
    {
        for rep in 0..3u32 {
            batch_spec.push((i as u32 + 200 * rep, 4 + rep, (*f).to_string()));
        }
    }
    perf::reset();
    for e in [&mut on, &mut off] {
        let batch: Vec<_> = batch_spec
            .iter()
            .map(|(row, c, raw)| (0u16, *row, *c, e.parse_input(0, raw).unwrap()))
            .collect();
        e.set_cells(batch);
    }
    assert!(perf::snapshot().accel_hits >= 15, "{:?}", perf::snapshot());
    compare(&on, &off, 0, "edges");
}
