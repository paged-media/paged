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

//! The information functions over a real multi-sheet workbook (W3): `SHEET`,
//! `SHEETS`, `CELL` and `INFO` read the model, which the one-sheet golden
//! replay cannot show (the Excel-recorded values in `info3/` come from a
//! workbook of 75 sheets).

use sheet_calc::{Engine, EngineConfig};
use sheet_core::{CellValue, SheetModel};

fn workbook() -> Engine {
    let mut m = SheetModel::new();
    for name in ["Jan", "Feb", "Mar", "My Sheet"] {
        m.add_sheet(name);
    }
    Engine::new(m, EngineConfig::default())
}

fn eval(e: &mut Engine, sheet: u16, formula: &str) -> CellValue {
    e.enter(sheet, 20, 20, formula).expect("parses");
    e.model()
        .sheet(sheet)
        .and_then(|ws| ws.cell(20, 20))
        .map(|c| c.value.clone())
        .unwrap_or(CellValue::Empty)
}

fn n(x: f64) -> CellValue {
    CellValue::Number(x)
}

fn t(s: &str) -> CellValue {
    CellValue::Text(s.into())
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info_sheet_names_references_and_spans__feat__sheet_fn_information() {
    let mut e = workbook();
    assert_eq!(eval(&mut e, 2, "=SHEET()"), n(3.0));
    assert_eq!(eval(&mut e, 0, "=SHEET(\"feb\")"), n(2.0));
    assert_eq!(eval(&mut e, 0, "=SHEET(\"My Sheet\")"), n(4.0));
    assert_eq!(
        eval(&mut e, 0, "=SHEET(\"nosuch\")"),
        CellValue::Error(sheet_core::CellError::Na)
    );
    assert_eq!(eval(&mut e, 0, "=SHEET(Mar!B2)"), n(3.0));
    assert_eq!(eval(&mut e, 0, "=SHEET(Feb:Mar!B2)"), n(2.0));
    assert_eq!(
        eval(&mut e, 0, "=SHEET(7)"),
        CellValue::Error(sheet_core::CellError::Na)
    );
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info_sheets_counts_the_workbook_and_3d_spans__feat__sheet_fn_information() {
    let mut e = workbook();
    assert_eq!(eval(&mut e, 0, "=SHEETS()"), n(4.0));
    assert_eq!(eval(&mut e, 0, "=SHEETS(Jan:Mar!A1)"), n(3.0));
    assert_eq!(eval(&mut e, 0, "=SHEETS(Feb:Mar!A1:B2)"), n(2.0));
    assert_eq!(eval(&mut e, 0, "=SHEETS(B3)"), n(1.0));
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info_cell_reads_the_workbook__feat__sheet_fn_information() {
    let mut e = workbook();
    assert_eq!(eval(&mut e, 0, "=CELL(\"address\",Feb!C4)"), t("Feb!$C$4"));
    assert_eq!(
        eval(&mut e, 0, "=CELL(\"address\",'My Sheet'!A1)"),
        t("'My Sheet'!$A$1")
    );
    assert_eq!(eval(&mut e, 0, "=CELL(\"filename\")"), t(""));
    e.set_document_name(Some("Budget.xlsx"));
    assert_eq!(
        eval(&mut e, 1, "=CELL(\"filename\")"),
        t("[Budget.xlsx]Feb")
    );
    assert_eq!(
        eval(&mut e, 0, "=CELL(\"address\",Feb!C4)"),
        t("[Budget.xlsx]Feb!$C$4")
    );
    assert_eq!(eval(&mut e, 0, "=CELL(\"width\",A1)"), n(8.0));
    assert_eq!(
        eval(&mut e, 0, "=INDEX(CELL(\"width\",A1),1,2)"),
        CellValue::Bool(true)
    );
}

#[allow(non_snake_case)]
#[test]
fn sheet_fn_info_info_answers_for_the_engine__feat__sheet_fn_information() {
    let mut e = workbook();
    assert_eq!(eval(&mut e, 0, "=INFO(\"numfile\")"), n(4.0));
    assert_eq!(eval(&mut e, 0, "=INFO(\"recalc\")"), t("Automatic"));
    assert_eq!(eval(&mut e, 0, "=INFO(\"system\")"), t("pcdos"));
}
