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

//! W2.6 (sheet ADR 517): tables created from a range, totals, calculated
//! columns, auto-expansion, renames, header edits, styles banded through
//! the shared styler, resize — saved and read back.

#![allow(non_snake_case)]

use sheet_js::core::tables::TableStyleArg;
use sheet_js::core::{LowerOptions, SheetSession};
use std::io::Read;
use std::path::PathBuf;

fn read_part(bytes: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid zip");
    let mut f = zip.by_name(name).unwrap_or_else(|_| panic!("part {name}"));
    let mut data = String::new();
    f.read_to_string(&mut data).unwrap();
    data
}

fn sales() -> SheetSession {
    let mut s = SheetSession::new();
    let rows = [
        ["Region", "Units", "Price"],
        ["West", "5", "2"],
        ["East", "9", "3"],
        ["North", "7", "4"],
    ];
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            s.set_cell(0, r as u32, c as u32, v).unwrap();
        }
    }
    s
}

#[test]
fn create_from_range_writes_the_part_and_resolves_refs__feat__sheet_table_create() {
    let mut s = sales();
    let t = s.create_table(0, "A1:C4", true, None, None).unwrap();
    assert_eq!(t.name, "Table1");
    assert_eq!(t.style.as_deref(), Some("TableStyleMedium2"));
    s.set_cell(0, 6, 0, "=SUM(Table1[Units])").unwrap();
    assert_eq!(s.get_cell_display(0, 6, 0), "21");
    let bytes = s.save_xlsx().unwrap();
    let part = read_part(&bytes, "xl/tables/table1.xml");
    assert!(
        part.contains(r#"ref="A1:C4""#) && part.contains(r#"name="Units""#),
        "{part}"
    );
    let ct = read_part(&bytes, "[Content_Types].xml");
    assert!(ct.contains("/xl/tables/table1.xml"));
    let rels = read_part(&bytes, "xl/worksheets/_rels/sheet1.xml.rels");
    assert!(rels.contains("../tables/table1.xml"));
    let ws = read_part(&bytes, "xl/worksheets/sheet1.xml");
    assert!(ws.contains("<tableParts count=\"1\">"), "{ws}");
    let back = SheetSession::load_xlsx(&bytes).unwrap();
    assert_eq!(back.get_cell_display(0, 6, 0), "21");
    assert_eq!(back.list_table_details().len(), 1);
}

#[test]
fn blank_and_repeated_headers_and_no_header_row__feat__sheet_table_create() {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "x").unwrap();
    s.set_cell(0, 0, 2, "X").unwrap();
    s.set_cell(0, 1, 0, "1").unwrap();
    let t = s
        .create_table(0, "A1:C2", true, None, Some("Data"))
        .unwrap();
    let names: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["x", "Column2", "X2"]);
    assert_eq!(s.get_cell_display(0, 0, 1), "Column2");
    assert!(
        s.create_table(0, "B2:D3", true, None, None).is_err(),
        "overlap"
    );

    let mut n = SheetSession::new();
    n.set_cell(0, 0, 0, "5").unwrap();
    n.set_cell(0, 1, 0, "6").unwrap();
    let t = n.create_table(0, "A1:A2", false, None, None).unwrap();
    assert_eq!(t.range, "A1:A3");
    assert_eq!(n.get_cell_display(0, 0, 0), "Column1");
    assert_eq!(n.get_cell_display(0, 1, 0), "5");
}

#[test]
fn totals_row_functions_and_custom__feat__sheet_table_totals() {
    let mut s = sales();
    s.create_table(0, "A1:C4", true, None, None).unwrap();
    let t = s.set_table_totals("Table1", true).unwrap();
    assert!(t.totals_row);
    assert_eq!(t.range, "A1:C5");
    assert_eq!(s.get_cell_display(0, 4, 0), "Total");
    assert_eq!(s.get_cell_input(0, 4, 2), "=SUBTOTAL(109,Table1[Price])");
    assert_eq!(s.get_cell_display(0, 4, 2), "9");
    s.set_totals_function("Table1", "Units", "average", None)
        .unwrap();
    assert_eq!(s.get_cell_display(0, 4, 1), "7");
    s.set_totals_function("Table1", "Price", "custom", Some("=MAX(Table1[Price])*10"))
        .unwrap();
    assert_eq!(s.get_cell_display(0, 4, 2), "40");
    let part = read_part(&s.save_xlsx().unwrap(), "xl/tables/table1.xml");
    assert!(part.contains(r#"totalsRowCount="1""#), "{part}");
    assert!(part.contains(r#"totalsRowFunction="average""#));
    assert!(part.contains("<totalsRowFormula>MAX(Table1[Price])*10</totalsRowFormula>"));
    assert!(part.contains(r#"totalsRowLabel="Total""#));
    let t = s.set_table_totals("Table1", false).unwrap();
    assert_eq!(t.range, "A1:C4");
    assert_eq!(s.get_cell_display(0, 4, 2), "");
}

#[test]
fn calculated_columns_and_auto_expand__feat__sheet_table_calculated() {
    let mut s = sales();
    s.set_cell(0, 0, 3, "Total").unwrap();
    s.create_table(0, "A1:D4", true, None, None).unwrap();
    s.set_calculated_column("Table1", "Total", Some("=[@Units]*[@Price]"))
        .unwrap();
    assert_eq!(s.get_cell_display(0, 3, 3), "28");
    // A typed entry below the table grows it, and the new row computes.
    assert!(s.enter_cell(0, 4, 0, "South", false).unwrap().applied);
    let t = s.table_detail("Table1").unwrap();
    assert_eq!(t.range, "A1:D5");
    s.enter_cell(0, 4, 1, "2", false).unwrap();
    s.enter_cell(0, 4, 2, "10", false).unwrap();
    assert_eq!(s.get_cell_display(0, 4, 3), "20");
    // To the right: a new column.
    s.enter_cell(0, 0, 4, "Note", false).unwrap();
    let t = s.table_detail("Table1").unwrap();
    assert_eq!(t.range, "A1:E5");
    assert_eq!(t.columns[4].name, "Note");
    let part = read_part(&s.save_xlsx().unwrap(), "xl/tables/table1.xml");
    assert!(part.contains("<calculatedColumnFormula>Table1[[#This Row],[Units]]*Table1[[#This Row],[Price]]</calculatedColumnFormula>")
        || part.contains("<calculatedColumnFormula>"), "{part}");
}

#[test]
fn a_formula_in_an_empty_column_fills_it__feat__sheet_table_calculated() {
    let mut s = sales();
    s.set_cell(0, 0, 3, "Double").unwrap();
    s.create_table(0, "A1:D4", true, None, None).unwrap();
    s.enter_cell(0, 2, 3, "=B3*2", false).unwrap();
    assert_eq!(s.get_cell_display(0, 1, 3), "10");
    assert_eq!(s.get_cell_display(0, 3, 3), "14");
    let t = s.table_detail("Table1").unwrap();
    assert_eq!(t.columns[3].calculated_formula.as_deref(), Some("=B2*2"));
}

#[test]
fn rename_and_header_edits_carry_the_formulas__feat__sheet_table_edit() {
    let mut s = sales();
    s.create_table(0, "A1:C4", true, None, None).unwrap();
    s.set_cell(0, 6, 0, "=SUM(Table1[Units])").unwrap();
    s.rename_table("Table1", "Sales").unwrap();
    assert_eq!(s.get_cell_input(0, 6, 0), "=SUM(Sales[Units])");
    s.set_cell(0, 0, 1, "Qty").unwrap();
    assert_eq!(s.get_cell_input(0, 6, 0), "=SUM(Sales[Qty])");
    assert_eq!(s.get_cell_display(0, 6, 0), "21");
    assert!(s.rename_table("Sales", "A1").is_err());
    let back = SheetSession::load_xlsx(&s.save_xlsx().unwrap()).unwrap();
    assert_eq!(back.get_cell_display(0, 6, 0), "21");
    assert_eq!(back.table_detail("Sales").unwrap().columns[1].name, "Qty");
}

#[test]
fn styles_band_the_page_and_the_switches__feat__sheet_table_styles() {
    let mut s = sales();
    s.create_table(0, "A1:C4", true, Some("TableStyleMedium2"), None)
        .unwrap();
    let low = s
        .get_range_page(0, "A1:C4", LowerOptions::default())
        .unwrap();
    let fill = |r: usize, c: usize| {
        let k = low.rows[r].cells[c].style_key as usize;
        low.styles[k].fill_rgb.clone()
    };
    assert_eq!(fill(0, 0).as_deref(), Some("#4472C4"), "header");
    assert_eq!(fill(1, 1).as_deref(), Some("#DAE3F3"), "first stripe");
    assert_eq!(fill(2, 1), None, "second row unbanded");
    s.set_table_style(
        "Table1",
        TableStyleArg {
            banded_rows: Some(false),
            style: Some("TableStyleLight9".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let t = s.table_detail("Table1").unwrap();
    assert_eq!(t.style.as_deref(), Some("TableStyleLight9"));
    assert!(!t.banded_rows);
    assert!(s
        .set_table_style(
            "Table1",
            TableStyleArg {
                style: Some("NoSuchStyle".into()),
                ..Default::default()
            }
        )
        .is_err());
    assert_eq!(s.table_style_names().len(), 60);
}

#[test]
fn resize_adds_and_drops_columns__feat__sheet_table_edit() {
    let mut s = sales();
    s.set_cell(0, 0, 3, "Extra").unwrap();
    s.create_table(0, "A1:B4", true, None, None).unwrap();
    let t = s.resize_table("Table1", "A1:D6").unwrap();
    let names: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Region", "Units", "Price", "Extra"]);
    assert!(s.resize_table("Table1", "A2:D6").is_err(), "header moved");
    let t = s.resize_table("Table1", "A1:B4").unwrap();
    assert_eq!(t.columns.len(), 2);
}

#[test]
fn corpus_table_round_trips_and_edits__feat__sheet_table_edit() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("corpus/xlsx-corpus/07-tables.xlsx");
    let bytes = std::fs::read(path).unwrap();
    let mut z = SheetSession::load_xlsx(&bytes).unwrap();
    let names: Vec<String> = z
        .list_table_details()
        .iter()
        .map(|t| t.name.clone())
        .collect();
    assert!(!names.is_empty());
    let saved = z.save_xlsx().unwrap();
    for n in ["xl/tables/table1.xml", "xl/worksheets/sheet1.xml"] {
        assert_eq!(read_part(&bytes, n), read_part(&saved, n), "{n} unchanged");
    }
    let mut s = SheetSession::load_xlsx(&bytes).unwrap();
    let t = s.list_table_details()[0].clone();
    s.set_table_style(
        &t.name,
        TableStyleArg {
            banded_columns: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let back = SheetSession::load_xlsx(&s.save_xlsx().unwrap()).unwrap();
    assert!(back.table_detail(&t.name).unwrap().banded_columns);
}
