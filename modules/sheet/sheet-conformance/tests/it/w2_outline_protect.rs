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

//! W2.8 (sheet ADR 517): outline groups, collapse and expand, hidden rows,
//! columns and sheets, sheet and workbook protection — through the session,
//! saved, and read back.

#![allow(non_snake_case)]

use sheet_js::core::outline::Axis;
use sheet_js::core::protect::ProtectOptions;
use sheet_js::core::{SheetSession, StylePatchArg};
use std::io::Read;

fn read_part(bytes: &[u8], name: &str) -> String {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid zip");
    let mut f = zip.by_name(name).unwrap_or_else(|_| panic!("part {name}"));
    let mut data = String::new();
    f.read_to_string(&mut data).unwrap();
    data
}

fn filled() -> SheetSession {
    let mut s = SheetSession::new();
    for r in 0..10 {
        s.set_cell(0, r, 0, &format!("{}", r + 1)).unwrap();
    }
    s.set_cell(0, 10, 0, "=SUBTOTAL(109,A1:A10)").unwrap();
    s
}

#[test]
fn group_collapse_expand_round_trip__feat__sheet_outline_group() {
    let mut s = filled();
    s.group(0, Axis::Rows, 1, 3).unwrap();
    let o = s.outline(0).unwrap();
    assert_eq!(o.rows.len(), 1);
    assert_eq!(
        (o.rows[0].first, o.rows[0].last, o.rows[0].level),
        (1, 3, 1)
    );
    assert_eq!(o.rows[0].summary, Some(4));

    // Collapsing hides the detail; SUBTOTAL 109 skips hidden rows.
    s.set_group_collapsed(0, Axis::Rows, 2, true).unwrap();
    assert_eq!(s.outline(0).unwrap().hidden_rows, vec![1, 2, 3]);
    assert_eq!(s.get_cell_display(0, 10, 0), "46"); // 55 − (2+3+4)

    let bytes = s.save_xlsx().unwrap();
    let ws = read_part(&bytes, "xl/worksheets/sheet1.xml");
    assert!(ws.contains(r#"outlineLevelRow="1""#), "{ws}");
    assert!(ws.contains(r#"<row r="3""#));
    let row3 = &ws[ws.find(r#"<row r="3""#).unwrap()..];
    let row3 = &row3[..row3.find('>').unwrap()];
    assert!(row3.contains(r#"hidden="1""#) && row3.contains(r#"outlineLevel="1""#));
    let row5 = &ws[ws.find(r#"<row r="5""#).unwrap()..];
    let row5 = &row5[..row5.find('>').unwrap()];
    assert!(row5.contains(r#"collapsed="1""#), "{row5}");
    // sheetFormatPr comes before sheetData.
    assert!(ws.find("sheetFormatPr").unwrap() < ws.find("sheetData").unwrap());

    let mut back = SheetSession::load_xlsx(&bytes).unwrap();
    let o = back.outline(0).unwrap();
    assert!(o.rows[0].collapsed);
    assert_eq!(o.hidden_rows, vec![1, 2, 3]);
    // Expanding from the summary row works too.
    back.set_group_collapsed(0, Axis::Rows, 4, false).unwrap();
    assert!(back.outline(0).unwrap().hidden_rows.is_empty());
    assert_eq!(back.get_cell_display(0, 10, 0), "55");
}

#[test]
fn nested_groups_keep_their_own_collapse__feat__sheet_outline_group() {
    let mut s = filled();
    s.group(0, Axis::Rows, 1, 6).unwrap();
    s.group(0, Axis::Rows, 2, 3).unwrap();
    s.set_group_collapsed(0, Axis::Rows, 2, true).unwrap();
    s.set_group_collapsed(0, Axis::Rows, 1, true).unwrap();
    assert_eq!(
        s.outline(0).unwrap().hidden_rows,
        (1..=6).collect::<Vec<_>>()
    );
    s.set_group_collapsed(0, Axis::Rows, 1, false).unwrap();
    assert_eq!(s.outline(0).unwrap().hidden_rows, vec![2, 3]);
    // The level buttons: level 1 shows only ungrouped rows; 3 shows all.
    s.show_outline_level(0, Axis::Rows, 1).unwrap();
    assert_eq!(
        s.outline(0).unwrap().hidden_rows,
        (1..=6).collect::<Vec<_>>()
    );
    s.show_outline_level(0, Axis::Rows, 2).unwrap();
    assert_eq!(s.outline(0).unwrap().hidden_rows, vec![2, 3]);
    s.show_outline_level(0, Axis::Rows, 3).unwrap();
    assert!(s.outline(0).unwrap().hidden_rows.is_empty());
    // Ungroup the inner one: one level left.
    s.ungroup(0, Axis::Rows, 2, 3).unwrap();
    assert_eq!(s.outline(0).unwrap().max_row_level, 1);
}

#[test]
fn columns_group_and_hide__feat__sheet_outline_hide() {
    let mut s = filled();
    s.group(0, Axis::Cols, 2, 4).unwrap();
    s.set_group_collapsed(0, Axis::Cols, 3, true).unwrap();
    s.set_hidden(0, Axis::Cols, 7, 7, true).unwrap();
    s.set_hidden(0, Axis::Rows, 8, 8, true).unwrap();
    let o = s.outline(0).unwrap();
    assert_eq!(o.hidden_cols, vec![2, 3, 4, 7]);
    assert_eq!(o.hidden_rows, vec![8]);
    let bytes = s.save_xlsx().unwrap();
    let ws = read_part(&bytes, "xl/worksheets/sheet1.xml");
    assert!(ws.contains(r#"outlineLevelCol="1""#), "{ws}");
    let back = SheetSession::load_xlsx(&bytes).unwrap();
    let o = back.outline(0).unwrap();
    assert_eq!(o.hidden_cols, vec![2, 3, 4, 7]);
    assert_eq!(o.cols.len(), 1);
    assert!(o.cols[0].collapsed);
}

#[test]
fn hide_and_unhide_sheets__feat__sheet_outline_hide() {
    let mut s = filled();
    s.add_sheet("Two").unwrap();
    assert!(s.set_sheet_state(0, "hidden").is_ok());
    assert!(
        s.set_sheet_state(1, "hidden").is_err(),
        "the last visible sheet cannot be hidden"
    );
    let bytes = s.save_xlsx().unwrap();
    let wb = read_part(&bytes, "xl/workbook.xml");
    assert!(wb.contains(r#"state="hidden""#), "{wb}");
    let mut back = SheetSession::load_xlsx(&bytes).unwrap();
    assert_eq!(back.list_sheets()[0].state, "hidden");
    back.set_sheet_state(0, "visible").unwrap();
    let wb = read_part(&back.save_xlsx().unwrap(), "xl/workbook.xml");
    assert!(!wb.contains("state="));
}

#[test]
fn protected_sheet_refuses_locked_cells__feat__sheet_protect_sheet() {
    let mut s = filled();
    // Unlock B1:B3 before protecting (Format Cells ▸ Protection).
    s.set_style(
        0,
        "B1:B3",
        StylePatchArg {
            locked: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    s.protect_sheet(
        0,
        ProtectOptions {
            password: Some("pw".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let err = s.set_cell(0, 0, 0, "x").unwrap_err();
    assert!(err.0.contains("protected"), "{}", err.0);
    s.set_cell(0, 1, 1, "ok").unwrap();
    assert!(s.set_style(0, "B1", StylePatchArg::default()).is_err());
    assert!(s
        .structural_edit(0, sheet_js::core::StructuralEdit::InsertRows, 0, 1)
        .is_err());
    assert!(s.group(0, Axis::Rows, 0, 1).is_err());

    let bytes = s.save_xlsx().unwrap();
    let ws = read_part(&bytes, "xl/worksheets/sheet1.xml");
    let at = ws.find("<sheetProtection").expect("written");
    assert!(at > ws.find("</sheetData>").unwrap());
    assert!(ws.contains(r#"algorithmName="SHA-512""#));
    assert!(ws.contains(r#"spinCount="100000""#));

    let mut back = SheetSession::load_xlsx(&bytes).unwrap();
    assert!(back.sheet_protection(0).unwrap().protected);
    assert!(back.set_cell(0, 0, 0, "x").is_err());
    assert!(back.set_cell(0, 2, 1, "fine").is_ok());
    assert!(back.unprotect_sheet(0, "wrong").is_err());
    back.unprotect_sheet(0, "pw").unwrap();
    back.set_cell(0, 0, 0, "x").unwrap();
}

#[test]
fn allow_flags_let_actions_through__feat__sheet_protect_sheet() {
    let mut s = filled();
    s.protect_sheet(
        0,
        ProtectOptions {
            format_rows: Some(true),
            insert_rows: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(s.set_hidden(0, Axis::Rows, 2, 2, true).is_ok());
    assert!(s.set_hidden(0, Axis::Cols, 2, 2, true).is_err());
    assert!(s
        .structural_edit(0, sheet_js::core::StructuralEdit::InsertRows, 20, 1)
        .is_ok());
    // No password: unprotect with any.
    s.unprotect_sheet(0, "").unwrap();
    assert!(!s.sheet_protection(0).unwrap().protected);
}

#[test]
fn workbook_structure_protection__feat__sheet_protect_workbook() {
    let mut s = filled();
    s.protect_workbook("book", true, false).unwrap();
    assert!(s.add_sheet("New").is_err());
    assert!(s.rename_sheet(0, "Other").is_err());
    let bytes = s.save_xlsx().unwrap();
    let wb = read_part(&bytes, "xl/workbook.xml");
    let p = wb.find("<workbookProtection").expect("written");
    assert!(p < wb.find("<sheets").unwrap());
    assert!(wb.contains(r#"lockStructure="1""#));
    let mut back = SheetSession::load_xlsx(&bytes).unwrap();
    assert!(back.workbook_protection().structure);
    assert!(back.unprotect_workbook("nope").is_err());
    back.unprotect_workbook("book").unwrap();
    back.add_sheet("New").unwrap();
}
