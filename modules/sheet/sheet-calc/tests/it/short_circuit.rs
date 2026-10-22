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

//! Short-circuit evaluation (`lazy_args`, sheet ADR 513), proved by the work
//! counters: the branch IF / IFS / IFERROR / IFNA / CHOOSE / SWITCH does not
//! return reads no cell at all, while the dependency graph still knows it.

// Test names end in `__feat__<cockpit id>` — the cockpit link (CLAUDE.md).
#![allow(non_snake_case)]

use sheet_calc::{perf, Engine, EngineConfig};
use sheet_core::{CellValue, SheetModel};

/// A sheet with B1:B10000 filled, so a SUM over it reads 10 000 cells.
fn engine() -> Engine {
    let mut m = SheetModel::new();
    m.add_sheet("S");
    let mut e = Engine::new(m, EngineConfig::default());
    let cells = (0..10_000u32).map(|r| {
        (
            0u16,
            r,
            1u32,
            sheet_calc::SetInput::Value(CellValue::Number(f64::from(r))),
        )
    });
    e.set_cells(cells);
    e
}

fn value(e: &Engine, r: u32, c: u32) -> CellValue {
    e.model()
        .sheet(0)
        .and_then(|ws| ws.cell(r, c))
        .map(|c| c.value.clone())
        .unwrap_or(CellValue::Empty)
}

/// Enter `formula` in A1 and return (value, cells read, ranges built).
fn measure(e: &mut Engine, formula: &str) -> (CellValue, u64, u64) {
    e.set_accelerators(false);
    perf::reset();
    e.enter(0, 0, 0, formula).unwrap();
    let c = perf::snapshot();
    (value(e, 0, 0), c.cells_read, c.ranges_materialized)
}

#[test]
fn the_untaken_branch_reads_no_cell__feat__sheet_calc_model() {
    let mut e = engine();
    // Taken: the SUM reads every cell.
    let (v, read, built) = measure(&mut e, "=IF(FALSE,1,SUM(B1:B10000))");
    assert_eq!(v, CellValue::Number(49_995_000.0));
    assert!(read >= 10_000, "the taken SUM reads its range ({read})");
    assert_eq!(built, 1);
    // Untaken: nothing is read.
    for f in [
        "=IF(TRUE,1,SUM(B1:B10000))",
        "=IF(1>0,1,SUM(B1:B10000))",
        "=IFERROR(1,SUM(B1:B10000))",
        "=IFNA(1,SUM(B1:B10000))",
        "=CHOOSE(1,7,SUM(B1:B10000))",
        "=SWITCH(2,1,SUM(B1:B10000),2,7,SUM(B1:B10000))",
        "=IFS(FALSE,SUM(B1:B10000),TRUE,7,TRUE,SUM(B1:B10000))",
    ] {
        let (v, read, built) = measure(&mut e, f);
        assert!(
            matches!(v, CellValue::Number(x) if x == 1.0 || x == 7.0),
            "{f}: {v:?}"
        );
        assert_eq!(
            (read, built),
            (0, 0),
            "{f} read the branch it does not return"
        );
    }
}

#[test]
fn an_untaken_branch_is_still_a_dependency__feat__sheet_calc_model() {
    let mut e = engine();
    e.enter(0, 0, 3, "TRUE").unwrap(); // D1
    e.enter(0, 0, 0, "=IF(D1,1,SUM(B1:B3))").unwrap();
    assert_eq!(value(&e, 0, 0), CellValue::Number(1.0));
    // Flip the condition: A1 now returns the SUM, and an edit inside it
    // recalculates A1 — the graph registered the branch it skipped.
    e.enter(0, 0, 3, "FALSE").unwrap();
    assert_eq!(value(&e, 0, 0), CellValue::Number(3.0));
    e.enter(0, 2, 1, "100").unwrap(); // B3
    assert_eq!(value(&e, 0, 0), CellValue::Number(101.0));
}

#[test]
fn an_untaken_error_or_volatile_is_never_evaluated__feat__sheet_calc_model() {
    let mut e = engine();
    // A named LAMBDA recursing through IF terminates only if IF is lazy.
    let mut m = e.into_model();
    m.names.define(sheet_core::NameDef {
        name: "Fact".into(),
        scope: sheet_core::NameScope::Workbook,
        target: sheet_core::NameTarget::Formula("LAMBDA(n,IF(n<=1,1,n*Fact(n-1)))".into()),
    });
    e = Engine::new(m, EngineConfig::default());
    e.recalc_all();
    e.enter(0, 0, 0, "=Fact(10)").unwrap();
    assert_eq!(value(&e, 0, 0), CellValue::Number(3_628_800.0));
    // A runaway recursion is #NUM!, not a stack overflow.
    let mut m = e.into_model();
    m.names.define(sheet_core::NameDef {
        name: "Loop".into(),
        scope: sheet_core::NameScope::Workbook,
        target: sheet_core::NameTarget::Formula("LAMBDA(n,Loop(n+1))".into()),
    });
    let mut e = Engine::new(m, EngineConfig::default());
    e.recalc_all();
    e.enter(0, 0, 0, "=Loop(1)").unwrap();
    assert_eq!(
        value(&e, 0, 0),
        CellValue::Error(sheet_core::CellError::Num)
    );
}
