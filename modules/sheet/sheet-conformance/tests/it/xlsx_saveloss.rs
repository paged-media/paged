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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

#![allow(non_snake_case)]

//! An edited sheet must not lose data (W1.4): the worksheet part is PATCHED
//! row by row, so what Paged does not model — rich text, hidden and styled
//! columns, outlines, row styles, unknown attributes — survives an edit, and
//! everything the edit did not touch is the bytes it was read as.

use std::io::Read;

use sheet_js::core::{SheetSession, StructuralEdit};

fn corpus(name: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../corpus/xlsx-corpus")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn parts(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        if f.is_dir() {
            continue;
        }
        let name = f.name().unwrap().to_string();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        out.push((name, data));
    }
    out
}

fn part(bytes: &[u8], name: &str) -> String {
    let p = parts(bytes);
    let (_, b) = p
        .iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no part {name}"));
    String::from_utf8(b.clone()).unwrap()
}

/// The `<row r="n" …>…</row>` (or `<row …/>`) element, if any.
fn row_xml(xml: &str, r1: u32) -> Option<&str> {
    let open = format!(r#"<row r="{r1}""#);
    let at = xml.find(&open)?;
    let rest = &xml[at..];
    let gt = rest.find('>')?;
    if rest[..gt].ends_with('/') {
        return Some(&rest[..=gt]);
    }
    Some(&rest[..rest.find("</row>")? + 6])
}

/// The `<c r="addr" …>` element.
fn cell_xml<'a>(xml: &'a str, addr: &str) -> &'a str {
    let open = format!(r#"<c r="{addr}""#);
    let at = xml
        .find(&open)
        .unwrap_or_else(|| panic!("no <c r=\"{addr}\"> in {xml}"));
    let rest = &xml[at..];
    let end = match (rest.find("/>"), rest.find('>')) {
        (Some(e), Some(g)) if e < g => e + 2,
        _ => rest.find("</c>").map(|e| e + 4).unwrap(),
    };
    &rest[..end]
}

#[test]
fn an_edited_sheet_keeps_what_paged_does_not_model__feat__sheet_xlsx_roundtrip() {
    let src = corpus("15-saveloss.xlsx");
    let mut s = SheetSession::load_xlsx(&src).unwrap();
    // A new cell, and a changed value in a cell with attributes Paged does
    // not model.
    s.set_cell(0, 3, 0, "edited").unwrap();
    s.set_cell(0, 0, 2, "6").unwrap();
    let out = s.save_xlsx().unwrap();
    let was = part(&src, "xl/worksheets/sheet1.xml");
    let xml = part(&out, "xl/worksheets/sheet1.xml");

    // Rich text: still the shared string, and sharedStrings is untouched.
    assert_eq!(cell_xml(&xml, "B1"), r#"<c r="B1" t="s"><v>1</v></c>"#);
    assert_eq!(
        part(&out, "xl/sharedStrings.xml"),
        part(&src, "xl/sharedStrings.xml")
    );
    // The inline rich string keeps its runs.
    assert!(cell_xml(&xml, "D1").contains("<r><rPr><b/></rPr><t>in</t></r>"));
    // The edited cell keeps `s` and `ph`; only the value changed.
    assert_eq!(
        cell_xml(&xml, "C1"),
        r#"<c r="C1" s="1" ph="1"><v>6</v></c>"#
    );
    // Hidden / styled / outlined columns, verbatim.
    let cols = |x: &str| x[x.find("<cols>").unwrap()..x.find("</cols>").unwrap()].to_string();
    assert_eq!(cols(&xml), cols(&was));
    // Rows the edit did not touch are their bytes; the touched row keeps its
    // style, `customFormat` and `x14ac:dyDescent`.
    for r in [2, 3, 5] {
        assert_eq!(row_xml(&xml, r), row_xml(&was, r), "row {r}");
    }
    assert!(row_xml(&xml, 1)
        .unwrap()
        .starts_with(r#"<row r="1" spans="1:4" s="1" customFormat="1" x14ac:dyDescent="0.25">"#));
    assert!(row_xml(&xml, 4).unwrap().contains("edited"));
    // The hidden sheets stay hidden, and the session says so.
    assert_eq!(part(&out, "xl/workbook.xml"), part(&src, "xl/workbook.xml"));
    let states: Vec<&str> = s.list_sheets().iter().map(|i| i.state).collect();
    assert_eq!(states, ["visible", "hidden", "veryHidden"]);

    // The model read what it carries.
    let ws = &s.model().sheets[0];
    assert!(ws.col_hidden(1) && !ws.col_hidden(0));
    assert_eq!(ws.row_meta.get(&1).map(|m| m.outline_level), Some(1));
    assert!(ws
        .row_meta
        .get(&2)
        .is_some_and(|m| m.collapsed && m.thick_bot));
    assert_eq!(ws.row_meta.get(&4).map(|m| m.style), Some(1));
}

#[test]
fn a_row_insert_moves_row_and_column_attributes_with_their_rows__feat__sheet_calc_rewrite_structural_door(
) {
    let src = corpus("15-saveloss.xlsx");
    let mut s = SheetSession::load_xlsx(&src).unwrap();
    s.structural_edit(0, StructuralEdit::InsertRows, 1, 2)
        .unwrap();
    s.structural_edit(0, StructuralEdit::InsertCols, 0, 1)
        .unwrap();
    let out = s.save_xlsx().unwrap();
    let xml = part(&out, "xl/worksheets/sheet1.xml");
    // Old row 2 (hidden, outlined, 20 pt) is row 4 now, column-shifted.
    let r4 = row_xml(&xml, 4).unwrap();
    assert!(
        r4.contains(r#"ht="20" customHeight="1" hidden="1" outlineLevel="1""#),
        "{r4}"
    );
    assert!(r4.contains(r#"<c r="B4"><v>1</v></c>"#), "{r4}");
    // Old row 3's formula follows the moved cells.
    let r5 = row_xml(&xml, 5).unwrap();
    assert!(r5.contains(r#"collapsed="1" thickBot="1""#), "{r5}");
    assert!(r5.contains("<f>B4*2</f>"), "{r5}");
    // The shared string moved with its cell.
    assert!(r5.contains(r#"<c r="C5" t="s"><v>2</v></c>"#), "{r5}");
    // The hidden column B is column C now.
    assert!(xml.contains(r#"<col min="3" max="3" width="0" hidden="1" customWidth="1"/>"#));
    let back = SheetSession::load_xlsx(&out).unwrap();
    let ws = &back.model().sheets[0];
    assert!(ws.col_hidden(2) && ws.hidden_rows.contains(&3));
    assert_eq!(ws.row_meta.get(&4).map(|m| m.collapsed), Some(true));
}

/// The "edit one cell" property: over every round-trip fixture, a new cell
/// changes only the row it lands in and the `<dimension>`; every other part
/// (the calc chain aside) is the bytes it was read as.
#[test]
fn editing_one_cell_changes_only_its_row__feat__sheet_xlsx_roundtrip() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../corpus/xlsx-corpus");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".xlsx"))
        .collect();
    names.sort();
    let mut checked = 0;
    for name in names {
        let src = corpus(&name);
        let Ok(mut s) = SheetSession::load_xlsx(&src) else {
            continue;
        };
        let used = s.model().sheets[0].used_range();
        let row = used.map_or(0, |u| u.row1 + 2);
        s.set_cell(0, row, 0, "edit-one-cell").unwrap();
        let out = s.save_xlsx().unwrap();
        let before = parts(&src);
        let after = parts(&out);
        let sheet1 = s
            .doc_part_name(0)
            .unwrap_or("xl/worksheets/sheet1.xml".into());
        for (pname, bytes) in &before {
            if pname.ends_with("calcChain.xml") {
                continue;
            }
            let Some((_, now)) = after.iter().find(|(n, _)| n == pname) else {
                panic!("{name}: {pname} was dropped");
            };
            if *pname == sheet1 {
                let strip = |b: &[u8]| -> String {
                    let x = String::from_utf8_lossy(b).into_owned();
                    let x = match row_xml(&x, row + 1) {
                        Some(r) => x.replacen(r, "", 1),
                        None => x,
                    };
                    match (
                        x.find("<dimension"),
                        x.find("<dimension")
                            .and_then(|i| x[i..].find("/>").map(|e| i + e + 2)),
                    ) {
                        (Some(a), Some(b)) => format!("{}{}", &x[..a], &x[b..]),
                        _ => x,
                    }
                };
                assert_eq!(
                    strip(now),
                    strip(bytes),
                    "{name}: {pname} beyond the edited row"
                );
            } else if pname == "[Content_Types].xml" || pname.ends_with("workbook.xml.rels") {
                // These lose the calc chain's entry when there is one.
                if !before.iter().any(|(n, _)| n.ends_with("calcChain.xml")) {
                    assert_eq!(now, bytes, "{name}: {pname}");
                }
            } else {
                assert_eq!(now, bytes, "{name}: {pname}");
            }
        }
        checked += 1;
    }
    assert!(checked >= 14, "{checked} fixtures checked");
}

#[test]
fn rich_text_reads_and_appends_without_renumbering__feat__sheet_xlsx_roundtrip() {
    let src = corpus("15-saveloss.xlsx");
    let mut doc = sheet_xlsx::XlsxDocument::open(&src).unwrap();
    let rich = doc.shared_rich_text(1).unwrap().unwrap();
    assert_eq!(rich.text(), "Bold italic");
    assert_eq!(rich.runs.len(), 2);
    assert!(rich.runs[0].rpr.as_deref().unwrap().contains("<b/>"));
    let i = doc.append_shared_string(&rich).unwrap();
    assert_eq!(i, 3);
    let out = doc.save().unwrap();
    let sst = part(&out, "xl/sharedStrings.xml");
    let was = part(&src, "xl/sharedStrings.xml");
    // The old entries are their bytes; one entry more.
    let body = |x: &str| x[x.find("<si>").unwrap()..x.rfind("</sst>").unwrap()].to_string();
    assert!(body(&sst).starts_with(&body(&was)));
    assert!(sst.contains(r#"count="4" uniqueCount="4""#));
    let back = sheet_xlsx::XlsxDocument::open(&out).unwrap();
    assert_eq!(back.shared_rich_text(3).unwrap().unwrap(), rich);

    // A package without a shared-string table gets one.
    let mut doc = sheet_xlsx::XlsxDocument::open(&corpus("01-minimal.xlsx")).unwrap();
    if doc.shared_rich_text(0).unwrap().is_none() {
        let i = doc
            .append_shared_string(&sheet_xlsx::RichText::plain("x"))
            .unwrap();
        let back = sheet_xlsx::XlsxDocument::open(&doc.save().unwrap()).unwrap();
        assert_eq!(
            back.shared_rich_text(i as usize).unwrap().unwrap().text(),
            "x"
        );
    }
}
