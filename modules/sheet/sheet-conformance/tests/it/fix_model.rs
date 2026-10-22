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

//! W3 partial fixes that need a whole engine: TEXT in the workbook's locale,
//! and SUBTOTAL / AGGREGATE recalculating when rows are hidden or filtered.

use sheet_calc::{Engine, EngineConfig};
use sheet_core::{CellValue, Locale, SheetModel};

fn engine(locale: Locale) -> Engine {
    let mut m = SheetModel::new();
    m.add_sheet("Sheet1");
    m.calc.locale = locale;
    Engine::new(m, EngineConfig::default())
}

fn value(e: &Engine, row: u32, col: u32) -> CellValue {
    e.model()
        .sheet(0)
        .and_then(|ws| ws.cell(row, col))
        .map(|c| c.value.clone())
        .unwrap_or(CellValue::Empty)
}

#[allow(non_snake_case)]
#[test]
fn text_renders_in_the_workbook_locale__feat__sheet_fn_library() {
    let mut e = engine(Locale::DeDe);
    e.enter(0, 0, 0, "=TEXT(1234.5,\"#,##0.00\")").unwrap();
    e.enter(0, 1, 0, "=TEXT(DATE(2024,3,1),\"mmmm\")").unwrap();
    assert_eq!(value(&e, 0, 0), CellValue::Text("1.234,50".into()));
    assert_eq!(value(&e, 1, 0), CellValue::Text("März".into()));
    let mut us = engine(Locale::EnUs);
    us.enter(0, 0, 0, "=TEXT(1234.5,\"#,##0.00\")").unwrap();
    assert_eq!(value(&us, 0, 0), CellValue::Text("1,234.50".into()));
}

#[allow(non_snake_case)]
#[test]
fn subtotal_recalculates_when_rows_hide__feat__sheet_fn_library() {
    let mut e = engine(Locale::EnUs);
    for (r, v) in [10.0, 20.0, 30.0].iter().enumerate() {
        e.enter(0, r as u32, 0, &v.to_string()).unwrap();
    }
    e.enter(0, 5, 0, "=SUBTOTAL(109,A1:A3)").unwrap();
    e.enter(0, 6, 0, "=SUBTOTAL(9,A1:A3)").unwrap();
    e.enter(0, 7, 0, "=AGGREGATE(9,5,A1:A3)").unwrap();
    assert_eq!(value(&e, 5, 0), CellValue::Number(60.0));
    let r = e.set_rows_hidden(0, [1], true);
    assert!(!r.changed.is_empty());
    assert_eq!(value(&e, 5, 0), CellValue::Number(40.0));
    // A row hidden by hand still counts for SUBTOTAL 1–11.
    assert_eq!(value(&e, 6, 0), CellValue::Number(60.0));
    assert_eq!(value(&e, 7, 0), CellValue::Number(40.0));
    // A filter-hidden row is skipped by both forms.
    e.set_rows_hidden(0, [1], false);
    e.set_filter_view(0, Vec::new(), [2].into_iter().collect());
    e.recalc_visibility();
    assert_eq!(value(&e, 5, 0), CellValue::Number(30.0));
    assert_eq!(value(&e, 6, 0), CellValue::Number(30.0));
}
