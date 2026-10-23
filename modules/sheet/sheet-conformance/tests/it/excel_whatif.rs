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

//! What-if analysis against Excel (sheet ADR 517). The workbook
//! `oracle/excel/recorded/whatif.excel.xlsx` was BUILT by Excel 16 itself
//! (`oracle/excel/whatif.applescript` through `drive.sh`): three data tables
//! made with What-If Analysis ▸ Data Table (one variable in a column, one
//! in a row, two variables) on sheet DT, the same with a changed input on
//! DT2, and three Goal Seeks on GS. The engine must reproduce Excel's data
//! tables on load, again after the input edit (DT2 holds Excel's answer),
//! and Goal Seek must land where Excel's did.

#![allow(non_snake_case)]

use sheet_core::CellValue;
use sheet_js::core::SheetSession;
use std::path::PathBuf;

fn recorded() -> Vec<u8> {
    let p =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/excel/recorded/whatif.excel.xlsx");
    std::fs::read(p).expect("the recorded what-if workbook")
}

fn num(s: &SheetSession, sheet: u16, row: u32, col: u32) -> f64 {
    match s
        .model()
        .sheet(sheet)
        .and_then(|w| w.cell(row, col))
        .map(|c| c.value.clone())
    {
        Some(CellValue::Number(n)) => n,
        other => panic!("({sheet},{row},{col}) is {other:?}"),
    }
}

/// The result cells of the three tables: B6:C10, G5:J6, M5:O8.
fn result_cells() -> Vec<(u32, u32)> {
    let mut v = Vec::new();
    for r in 5..=9 {
        for c in 1..=2 {
            v.push((r, c));
        }
    }
    for r in 4..=5 {
        for c in 6..=9 {
            v.push((r, c));
        }
    }
    for r in 4..=7 {
        for c in 12..=14 {
            v.push((r, c));
        }
    }
    v
}

#[test]
fn data_tables_match_excel_on_load_and_after_an_edit__feat__sheet_whatif_datatable() {
    let bytes = recorded();
    let excel = SheetSession::load_xlsx(&bytes).unwrap();
    let mut s = SheetSession::load_xlsx(&bytes).unwrap();
    // Wipe the cached results, recompute, compare with what Excel saved.
    let cells = result_cells();
    let wiped: Vec<_> = cells
        .iter()
        .map(|&(r, c)| sheet_js::core::CellInput {
            sheet: 0,
            row: r,
            col: c,
            input: "0".into(),
        })
        .collect();
    s.set_cells(&wiped).unwrap();
    // set_cells recalculated the tables already; once more on demand.
    s.calculate_data_tables().unwrap();
    for &(r, c) in &cells {
        let (a, b) = (num(&s, 0, r, c), num(&excel, 0, r, c));
        assert!(
            (a - b).abs() <= 1e-9 * b.abs().max(1.0),
            "DT ({r},{c}): {a} vs Excel {b}"
        );
    }
    // The amount 1000 → 2000: DT must show what Excel shows on DT2.
    s.set_cell(0, 1, 1, "2000").unwrap();
    for &(r, c) in &cells {
        let (a, b) = (num(&s, 0, r, c), num(&excel, 1, r, c));
        assert!(
            (a - b).abs() <= 1e-9 * b.abs().max(1.0),
            "after edit ({r},{c}): {a} vs Excel {b}"
        );
    }
    // The inputs are back where they were.
    assert_eq!(num(&s, 0, 0, 1), 0.05);
    assert_eq!(num(&s, 0, 2, 1), 10.0);
    // The saved file keeps the data tables.
    let saved = s.save_xlsx().unwrap();
    let back = SheetSession::load_xlsx(&saved).unwrap();
    assert_eq!(back.list_data_tables().len(), 6);
    assert!((num(&back, 0, 5, 1) - num(&excel, 1, 5, 1)).abs() < 1e-9);
}

#[test]
fn goal_seek_lands_where_excel_did__feat__sheet_whatif_goalseek() {
    let bytes = recorded();
    let excel = SheetSession::load_xlsx(&bytes).unwrap();
    let mut s = SheetSession::load_xlsx(&bytes).unwrap();
    // (set row, changing row, start, target) on sheet GS, column B.
    for (set_row, ch_row, start, target) in [
        (1u32, 0u32, "100", 500.0),
        (4, 3, "5", 1000.0),
        (7, 6, "1", 12.0),
    ] {
        s.set_cell(2, ch_row, 1, start).unwrap();
        let r = s.goal_seek(2, set_row, 1, target, 2, ch_row, 1).unwrap();
        assert!(r.found, "row {set_row}: {r:?}");
        assert!((r.result - target).abs() <= 0.001, "{r:?}");
        assert_eq!(r.prev_input, start);
        let want = num(&excel, 2, ch_row, 1);
        assert!(
            (r.value - want).abs() <= 1e-3 * want.abs().max(1.0),
            "row {set_row}: {} vs Excel {want}",
            r.value
        );
    }
    // A set cell without a formula, and a changing cell with one, refuse.
    assert!(s.goal_seek(2, 0, 1, 1.0, 2, 3, 1).is_err());
    assert!(s.goal_seek(2, 1, 1, 1.0, 2, 1, 1).is_err());
}

#[test]
fn an_unreachable_goal_is_not_found_and_restores__feat__sheet_whatif_goalseek() {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "3").unwrap();
    s.set_cell(0, 1, 0, "=A1^2").unwrap();
    let r = s.goal_seek(0, 1, 0, -4.0, 0, 0, 0).unwrap();
    assert!(!r.found);
    assert_eq!(s.get_cell_display(0, 0, 0), "3");
}
