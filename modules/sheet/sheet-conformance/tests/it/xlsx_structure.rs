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

//! Row/column inserts and deletes across preserved content (W1.2): every
//! piece of `corpus/xlsx-corpus/16-structure.xlsx` that addresses cells
//! moves with the edit, on its own sheet and on the sheets that name it; a
//! pivot cache over the sheet still refuses the edit, the package untouched.

use std::io::{Read, Write};

use proptest::prelude::*;
use sheet_js::core::{SheetSession, StructuralEdit};

fn corpus(name: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../corpus/xlsx-corpus")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn part(bytes: &[u8], name: &str) -> String {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut f = z.by_name(name).unwrap_or_else(|_| panic!("no part {name}"));
    let mut s = String::new();
    f.read_to_string(&mut s).unwrap();
    s
}

fn has(xml: &str, needle: &str) {
    assert!(xml.contains(needle), "{needle} not in {xml}");
}

#[test]
fn a_row_insert_moves_everything_that_addresses_cells__feat__sheet_calc_rewrite_structural_door() {
    let mut s = SheetSession::load_xlsx(&corpus("16-structure.xlsx")).unwrap();
    s.structural_edit(0, StructuralEdit::InsertRows, 1, 2)
        .unwrap();
    let out = s.save_xlsx().unwrap();
    let data = part(&out, "xl/worksheets/sheet1.xml");
    has(&data, r#"<conditionalFormatting sqref="B4:B7">"#);
    has(&data, "<formula>$D$4</formula>");
    has(&data, r#"sqref="C4:C7"><formula1>$F$1:$F$5</formula1>"#);
    has(&data, r#"<hyperlink ref="A8" location="Report!A1""#);
    has(&data, r#"<autoFilter ref="A1:D7"/>"#);
    has(&data, r#"<selection activeCell="B6" sqref="B6"/>"#);
    has(&data, r#"<brk id="6" max="16383" man="1"/>"#);
    has(&data, "<xm:f>Data!B4:B7</xm:f><xm:sqref>B9</xm:sqref>");
    has(&data, r#"<c r="B8"><f>SUM(B4:B7)</f>"#);

    let table = part(&out, "xl/tables/table1.xml");
    has(&table, r#"ref="H1:J6""#);
    has(&table, r#"<autoFilter ref="H1:J6"/>"#);

    let drawing = part(&out, "xl/drawings/drawing1.xml");
    // The picture (move, do not size) and the chart (move and size).
    has(&drawing, "<xdr:row>3</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row>");
    has(&drawing, "<xdr:row>10</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row>");

    let chart = part(&out, "xl/charts/chart1.xml");
    has(&chart, "<c:f>Data!$B$4:$B$7</c:f>");
    has(&chart, "<c:f>Data!$A$4:$A$7</c:f>");
    has(&chart, "<c:f>Data!$B$1</c:f>");
    has(&chart, "<c:v>Pens</c:v>"); // cached values are kept

    let comments = part(&out, "xl/comments1.xml");
    has(&comments, r#"<comment ref="B5""#);
    has(&comments, r#"<comment ref="D5""#);
    let vml = part(&out, "xl/drawings/vmlDrawing1.vml");
    has(&vml, "<x:Row>4</x:Row><x:Column>1</x:Column>");
    has(&vml, "<x:Anchor>2, 15, 4, 10, 4, 15, 8, 4</x:Anchor>");
    has(
        &part(&out, "xl/threadedComments/threadedComment1.xml"),
        r#"<threadedComment ref="D5""#,
    );

    let wb = part(&out, "xl/workbook.xml");
    has(&wb, ">Data!$A$1:$D$7</definedName>");
    has(&wb, ">Data!$A$1:$D$8</definedName>");
    has(&wb, ">Data!$D$4:$D$7</definedName>");

    let report = part(&out, "xl/worksheets/sheet2.xml");
    has(&report, "<f>SUM(Data!B4:B7)</f>");
    has(&report, "<formula1>Data!$A$4:$A$7</formula1>");

    // The saved package reads back with the moved content.
    let mut back = SheetSession::load_xlsx(&out).unwrap();
    assert_eq!(back.get_cell_display(1, 0, 0), "69");
    back.set_cell(0, 3, 1, "100").unwrap();
    assert_eq!(back.get_cell_display(1, 0, 0), "157");
    assert_eq!(
        back.get_cell_display(0, 7, 4),
        "7.5",
        "the table still resolves"
    );
    assert_eq!(back.list_comments().len(), 2);
}

#[test]
fn a_column_inserted_inside_a_table_becomes_a_named_column__feat__sheet_calc_rewrite_structural_door(
) {
    let mut s = SheetSession::load_xlsx(&corpus("16-structure.xlsx")).unwrap();
    s.structural_edit(0, StructuralEdit::InsertCols, 8, 1)
        .unwrap();
    assert_eq!(s.get_cell_display(0, 0, 8), "Column1");
    let out = s.save_xlsx().unwrap();
    let table = part(&out, "xl/tables/table1.xml");
    has(&table, r#"ref="H1:K4""#);
    has(
        &table,
        r#"<tableColumns count="4"><tableColumn id="1" name="Code"/><tableColumn id="4" name="Column1"/><tableColumn id="2" name="Rate"/>"#,
    );
    let mut back = SheetSession::load_xlsx(&out).unwrap();
    assert_eq!(back.get_cell_display(0, 5, 4), "7.5");
    back.set_cell(0, 1, 9, "10").unwrap();
    assert_eq!(back.get_cell_display(0, 5, 4), "16");
}

#[test]
fn a_delete_takes_notes_and_rules_on_deleted_cells_with_it__feat__sheet_calc_rewrite_structural_door(
) {
    let mut s = SheetSession::load_xlsx(&corpus("16-structure.xlsx")).unwrap();
    // Delete column B: the note on B3, the conditional format on B2:B5 and
    // the sparkline over B2:B5 go; the hyperlink on A6 stays.
    s.structural_edit(0, StructuralEdit::DeleteCols, 1, 1)
        .unwrap();
    let out = s.save_xlsx().unwrap();
    let data = part(&out, "xl/worksheets/sheet1.xml");
    assert!(!data.contains("conditionalFormatting"), "{data}");
    assert!(!data.contains("sparkline"), "{data}");
    has(&data, r#"sqref="B2:B5"><formula1>$E$1:$E$3</formula1>"#);
    has(&data, r#"<hyperlink ref="A6""#);
    let comments = part(&out, "xl/comments1.xml");
    assert!(!comments.contains(r#"ref="B3""#));
    has(&comments, r#"<comment ref="C3""#);
    let vml = part(&out, "xl/drawings/vmlDrawing1.vml");
    assert_eq!(vml.matches("<v:shape ").count(), 1);
    has(&part(&out, "xl/charts/chart1.xml"), "<c:f>Data!#REF!</c:f>");
    // The engine prints the formula; a deleted reference reads #REF!.
    has(&part(&out, "xl/worksheets/sheet2.xml"), "#REF!)</f>");
    assert!(SheetSession::load_xlsx(&out).is_ok());
}

/// `bytes` with one more part in the zip.
fn with_part(bytes: &[u8], name: &str, body: &str) -> Vec<u8> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
        let opts = zip::write::SimpleFileOptions::default();
        for i in 0..z.len() {
            let mut f = z.by_index(i).unwrap();
            let n = f.name().unwrap().to_string();
            let mut data = Vec::new();
            f.read_to_end(&mut data).unwrap();
            w.start_file(n, opts).unwrap();
            w.write_all(&data).unwrap();
        }
        w.start_file(name, opts).unwrap();
        w.write_all(body.as_bytes()).unwrap();
        w.finish().unwrap();
    }
    out
}

#[test]
fn a_pivot_cache_over_the_sheet_still_refuses__feat__sheet_calc_rewrite_structural_door() {
    let src = with_part(
        &corpus("16-structure.xlsx"),
        "xl/pivotCache/pivotCacheDefinition1.xml",
        r#"<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cacheSource type="worksheet"><worksheetSource ref="A1:D5" sheet="Data"/></cacheSource></pivotCacheDefinition>"#,
    );
    let mut s = SheetSession::load_xlsx(&src).unwrap();
    let err = s
        .structural_edit(0, StructuralEdit::InsertRows, 1, 1)
        .unwrap_err()
        .to_string();
    assert!(err.contains("pivot"), "{err}");
    assert_eq!(
        s.get_cell_display(0, 1, 0),
        "Pens",
        "the model is untouched"
    );
    assert!(!s.metadata().dirty);
    // Another sheet is free to change.
    s.structural_edit(1, StructuralEdit::InsertRows, 0, 1)
        .unwrap();
}

/// A reference model of the cells and of one rectangle (a conditional
/// format's range) under a sequence of inserts and deletes.
#[derive(Clone, Debug)]
enum Op {
    Ins(bool, u32, u32),
    Del(bool, u32, u32),
}

fn op() -> impl Strategy<Value = Op> {
    (any::<bool>(), any::<bool>(), 0u32..8, 1u32..3).prop_map(|(ins, rows, at, n)| {
        if ins {
            Op::Ins(rows, at, n)
        } else {
            Op::Del(rows, at, n)
        }
    })
}

fn shift(ins: bool, at: u32, n: u32, c: u32) -> Option<u32> {
    if ins {
        Some(if c >= at { c + n } else { c })
    } else if c < at {
        Some(c)
    } else if c < at + n {
        None
    } else {
        Some(c - n)
    }
}

/// The range a rectangle side `lo..=hi` becomes (`None`: deleted).
fn shift_span(ins: bool, at: u32, n: u32, lo: u32, hi: u32) -> Option<(u32, u32)> {
    if ins {
        return Some((shift(true, at, n, lo)?, shift(true, at, n, hi)?));
    }
    if lo >= at && hi < at + n {
        return None;
    }
    let a = if lo < at {
        lo
    } else if lo < at + n {
        at
    } else {
        lo - n
    };
    let b = if hi < at {
        hi
    } else if hi < at + n {
        at - 1
    } else {
        hi - n
    };
    Some((a, b))
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    #[test]
    fn random_inserts_and_deletes_match_a_reference_model__feat__sheet_calc_rewrite_structural_door(
        ops in proptest::collection::vec(op(), 1..6)
    ) {
        let mut s = SheetSession::load_xlsx(&corpus("12-datavalidation.xlsx")).unwrap();
        // Marker cells on a 6×6 block, and the reference positions.
        let mut cells: Vec<(u32, u32, String)> = Vec::new();
        for r in 0..6u32 {
            for c in 0..6u32 {
                let v = format!("m{r}_{c}");
                s.set_cell(0, r + 10, c, &v).unwrap();
                cells.push((r + 10, c, v));
            }
        }
        // One validation range to follow: the fixture's first sqref.
        let src = s.save_xlsx().unwrap();
        let x = part(&src, "xl/worksheets/sheet1.xml");
        let first = x.find("sqref=\"").map(|i| {
            let rest = &x[i + 7..];
            rest[..rest.find('"').unwrap()].to_string()
        }).unwrap();
        let (a, b) = first.split_once(':').unwrap_or((first.as_str(), first.as_str()));
        let (r0, c0, _, _) = sheet_core::parse_a1(a).unwrap();
        let (r1, c1, _, _) = sheet_core::parse_a1(b).unwrap();
        let mut rect = Some((r0, c0, r1, c1));
        for o in &ops {
            let (ins, rows, at, n) = match *o {
                Op::Ins(rows, at, n) => (true, rows, at, n),
                Op::Del(rows, at, n) => (false, rows, at, n),
            };
            let kind = match (ins, rows) {
                (true, true) => StructuralEdit::InsertRows,
                (false, true) => StructuralEdit::DeleteRows,
                (true, false) => StructuralEdit::InsertCols,
                (false, false) => StructuralEdit::DeleteCols,
            };
            s.structural_edit(0, kind, at, n).unwrap();
            cells = cells
                .into_iter()
                .filter_map(|(r, c, v)| {
                    if rows {
                        shift(ins, at, n, r).map(|r| (r, c, v))
                    } else {
                        shift(ins, at, n, c).map(|c| (r, c, v))
                    }
                })
                .collect();
            rect = rect.and_then(|(r0, c0, r1, c1)| {
                if rows {
                    shift_span(ins, at, n, r0, r1).map(|(a, b)| (a, c0, b, c1))
                } else {
                    shift_span(ins, at, n, c0, c1).map(|(a, b)| (r0, a, r1, b))
                }
            });
        }
        let out = s.save_xlsx().unwrap();
        let back = SheetSession::load_xlsx(&out).unwrap();
        for (r, c, v) in &cells {
            prop_assert_eq!(&back.get_cell_display(0, *r, *c), v);
        }
        let x = part(&out, "xl/worksheets/sheet1.xml");
        // (Deleted whole, the validation went with its cells.)
        if let Some((r0, c0, r1, c1)) = rect {
            let a = format!("{}{}", sheet_core::col_to_a1(c0), r0 + 1);
            let want = if (r0, c0) == (r1, c1) {
                a
            } else {
                format!("{a}:{}{}", sheet_core::col_to_a1(c1), r1 + 1)
            };
            prop_assert!(x.contains(&format!("sqref=\"{want}\"")), "{} not in {}", want, x);
        }
    }
}

#[test]
fn a_table_deleted_whole_goes_with_its_part__feat__sheet_calc_rewrite_structural_door() {
    let mut s = SheetSession::load_xlsx(&corpus("16-structure.xlsx")).unwrap();
    s.structural_edit(0, StructuralEdit::DeleteCols, 7, 3)
        .unwrap();
    let out = s.save_xlsx().unwrap();
    let names: Vec<String> = {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(&out)).unwrap();
        (0..z.len())
            .map(|i| z.by_index(i).unwrap().name().unwrap().to_string())
            .collect()
    };
    assert!(!names.iter().any(|n| n.contains("tables/")), "{names:?}");
    let data = part(&out, "xl/worksheets/sheet1.xml");
    assert!(!data.contains("tableParts"), "{data}");
    assert!(!part(&out, "xl/worksheets/_rels/sheet1.xml.rels").contains("table1.xml"));
    assert!(!part(&out, "[Content_Types].xml").contains("table1.xml"));
    assert!(SheetSession::load_xlsx(&out).is_ok());
}
