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

/// FIXED and DOLLAR in the workbook's locale. Expected values recorded from
/// Excel 16 (macOS) with the region set to each locale.
#[allow(non_snake_case)]
#[test]
fn fixed_and_dollar_render_in_the_workbook_locale__feat__sheet_fn_financial() {
    let formulas = [
        "=FIXED(1234.567)",
        "=FIXED(-1234.567,0)",
        "=FIXED(1234.567,-1)",
        "=FIXED(1234567.891,2,TRUE)",
        "=FIXED(-0.004,2)",
        "=DOLLAR(1234.567)",
        "=DOLLAR(-1234.567)",
        "=DOLLAR(1234.567,-2)",
        "=DOLLAR(-1234567.891,1)",
    ];
    let cases: [(Locale, [&str; 9]); 5] = [
        (
            Locale::EnUs,
            [
                "1,234.57",
                "-1,235",
                "1,230",
                "1234567.89",
                "0.00",
                "$1,234.57",
                "($1,234.57)",
                "$1,200",
                "($1,234,567.9)",
            ],
        ),
        (
            Locale::DeDe,
            [
                "1.234,57",
                "-1.235",
                "1.230",
                "1234567,89",
                "0,00",
                "1.234,57 €",
                "-1.234,57 €",
                "1.200 €",
                "-1.234.567,9 €",
            ],
        ),
        (
            Locale::FrFr,
            [
                "1 234,57",
                "-1 235",
                "1 230",
                "1234567,89",
                "0,00",
                "€1 234,57",
                "-€1 234,57",
                "€1 200",
                "-€1 234 567,9",
            ],
        ),
        (
            Locale::EsEs,
            [
                "1.234,57",
                "-1.235",
                "1.230",
                "1234567,89",
                "0,00",
                "1.234,57 €",
                "-1.234,57 €",
                "1.200 €",
                "-1.234.567,9 €",
            ],
        ),
        (
            Locale::ItIt,
            [
                "1.234,57",
                "-1.235",
                "1.230",
                "1234567,89",
                "0,00",
                "1.234,57 €",
                "-1.234,57 €",
                "1.200 €",
                "-1.234.567,9 €",
            ],
        ),
    ];
    for (locale, want) in cases {
        let mut e = engine(locale);
        for (i, f) in formulas.iter().enumerate() {
            e.enter(0, i as u32, 0, f).unwrap();
        }
        for (i, w) in want.iter().enumerate() {
            assert_eq!(
                value(&e, i as u32, 0),
                CellValue::Text((*w).into()),
                "{locale:?} {}",
                formulas[i]
            );
        }
    }
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

#[allow(non_snake_case)]
#[test]
fn cached_only_w3_functions_keep_their_error__feat__sheet_fn_library() {
    use sheet_core::CellError;
    // Typed fresh (no cached value): the row's error. A cached value from a
    // workbook is kept — tested for the family in calc_model.rs.
    let mut e = engine(Locale::EnUs);
    let cases = [
        ("=CUBEMEMBER(\"c\",\"[m]\")", CellError::Connect),
        ("=CUBESETCOUNT(A9)", CellError::Connect),
        ("=CUBEKPIMEMBER(\"c\",\"k\",1)", CellError::Connect),
        ("=CUBEMEMBERPROPERTY(\"c\",\"m\",\"p\")", CellError::Connect),
        ("=CUBERANKEDMEMBER(\"c\",\"s\",1)", CellError::Connect),
        ("=CUBESET(\"c\",\"s\")", CellError::Connect),
        ("=RTD(\"p\",\"\",\"t\")", CellError::Blocked),
        ("=STOCKHISTORY(\"MSFT\",1)", CellError::Blocked),
        ("=IMAGE(\"https://example.com/a.png\")", CellError::Blocked),
        ("=TRANSLATE(\"Hallo\")", CellError::Blocked),
        ("=DETECTLANGUAGE(\"Hallo\")", CellError::Blocked),
        ("=COPILOT(\"x\")", CellError::Blocked),
        ("=PY(\"1+1\",0)", CellError::Blocked),
        ("=CALL(1)", CellError::Blocked),
        ("=REGISTER.ID(\"m\",\"p\")", CellError::Blocked),
        ("=GETPIVOTDATA(\"Sales\",A1)", CellError::Blocked),
    ];
    for (i, (formula, want)) in cases.iter().enumerate() {
        e.enter(0, i as u32, 3, formula).unwrap();
        assert_eq!(value(&e, i as u32, 3), CellValue::Error(*want), "{formula}");
    }
}
