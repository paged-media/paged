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

//! Deleting a chart read from the workbook, and print areas of several
//! ranges (plan G4, sheet ADR 522). A deleted chart leaves the saved package —
//! its drawing anchor, its drawing relationship, its part and the parts only
//! it reached, with their content types — while every other part stays byte
//! for byte what it was (the preservation invariant: only the parts the delete
//! touches change). Its slot becomes a tombstone a reload restores, so every
//! other chart keeps its index.

#![allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)

use std::path::PathBuf;

use sheet_js::core::SheetSession;
use sheet_xlsx::write::write_package;

fn corpus(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("corpus")
        .join("xlsx-corpus")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read fixture {}: {e}", p.display()))
}

fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid zip");
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        if f.is_dir() {
            continue;
        }
        let name = f.name().unwrap().into_owned();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        out.push((name, data));
    }
    out
}

fn part<'a>(parts: &'a [(String, Vec<u8>)], name: &str) -> Option<&'a [u8]> {
    parts
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, b)| b.as_slice())
}

fn text(parts: &[(String, Vec<u8>)], name: &str) -> String {
    String::from_utf8(
        part(parts, name)
            .unwrap_or_else(|| panic!("{name}"))
            .to_vec(),
    )
    .unwrap()
}

/// `(index, kind, title)` of every listed chart.
fn listed(s: &SheetSession) -> Vec<(u32, String, Option<String>)> {
    s.list_charts()
        .into_iter()
        .map(|c| (c.index, c.kind.to_string(), c.title))
        .collect()
}

const DRAWING: &str = "xl/drawings/drawing1.xml";
const DRAWING_RELS: &str = "xl/drawings/_rels/drawing1.xml.rels";
const TYPES: &str = "[Content_Types].xml";

#[test]
fn deleted_file_chart_leaves_the_package_and_nothing_else_changes__feat__sheet_objects() {
    let original = corpus("annual-charts.xlsx");
    let mut s = SheetSession::load_xlsx(&original).expect("load");
    let before = listed(&s);
    assert_eq!(before.len(), 10);
    // Zero edits: the package re-emits as it was (calcChain aside).
    let zero = unzip(&s.save_xlsx().expect("save"));
    let orig = unzip(&original);
    for (name, bytes) in &orig {
        assert_eq!(part(&zero, name), Some(bytes.as_slice()), "{name}");
    }

    // chart3.xml is chart index 2, anchored through rId3.
    s.delete_chart(2).expect("delete");
    assert_eq!(s.chart_tombstones(), vec![2]);
    let saved = s.save_xlsx().expect("save after delete");
    let out = unzip(&saved);

    assert!(
        part(&out, "xl/charts/chart3.xml").is_none(),
        "the chart part goes"
    );
    assert!(!text(&out, DRAWING_RELS).contains("Id=\"rId3\""));
    assert!(text(&out, DRAWING_RELS).contains("Id=\"rId4\""));
    assert!(!text(&out, TYPES).contains("/xl/charts/chart3.xml"));
    assert!(text(&out, TYPES).contains("/xl/charts/chart4.xml"));
    let drawing = text(&out, DRAWING);
    assert!(!drawing.contains("r:id=\"rId3\""), "the anchor goes");
    let anchors =
        |x: &str| x.matches("<xdr:twoCellAnchor").count() + x.matches("<xdr:oneCellAnchor").count();
    assert_eq!(anchors(&drawing), anchors(&text(&orig, DRAWING)) - 1);
    // The drawing is the original with exactly one element cut out.
    let was = text(&orig, DRAWING);
    let common = was
        .bytes()
        .zip(drawing.bytes())
        .take_while(|(a, b)| a == b)
        .count();
    let tail = drawing.len() - common;
    assert_eq!(&was[was.len() - tail..], &drawing[common..]);

    // Every part the delete did not touch is byte-identical.
    let touched = ["xl/charts/chart3.xml", DRAWING, DRAWING_RELS, TYPES];
    for (name, bytes) in &orig {
        if touched.contains(&name.as_str()) {
            continue;
        }
        assert_eq!(part(&out, name), Some(bytes.as_slice()), "{name} untouched");
    }
    assert_eq!(out.len(), orig.len() - 1);

    // Reloaded, the tombstone puts every chart back at its index.
    let mut back = SheetSession::load_xlsx(&saved).expect("reload");
    assert_eq!(back.list_charts().len(), 9);
    back.restore_chart_slots(&[2]).expect("restore");
    let want: Vec<_> = before.iter().filter(|c| c.0 != 2).cloned().collect();
    assert_eq!(listed(&back), want);
    assert_eq!(back.chart_tombstones(), vec![2]);
    assert!(
        back.delete_chart(2).is_err(),
        "a tombstone is deleted already"
    );
    // A second save changes nothing more.
    let again = unzip(&back.save_xlsx().expect("save again"));
    for (name, bytes) in &out {
        assert_eq!(part(&again, name), Some(bytes.as_slice()), "{name} stable");
    }
}

#[test]
fn a_deleted_chart_takes_only_the_parts_it_alone_reached__feat__sheet_objects() {
    // annual-charts with chart3 carrying a style part of its own and a
    // colour part it shares with chart1.
    let mut parts = unzip(&corpus("annual-charts.xlsx"));
    let rel = |id: &str, ty: &str, target: &str| {
        format!(
            r#"<Relationship Id="{id}" Type="http://schemas.microsoft.com/office/2011/relationships/{ty}" Target="{target}"/>"#
        )
    };
    let rels = |body: String| {
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{body}</Relationships>"#).into_bytes()
    };
    parts.push((
        "xl/charts/_rels/chart3.xml.rels".into(),
        rels(
            rel("rId1", "chartStyle", "style3.xml")
                + &rel("rId2", "chartColorStyle", "colors1.xml"),
        ),
    ));
    parts.push((
        "xl/charts/_rels/chart1.xml.rels".into(),
        rels(rel("rId1", "chartColorStyle", "colors1.xml")),
    ));
    parts.push((
        "xl/charts/style3.xml".into(),
        b"<cs:chartStyle xmlns:cs=\"x\"/>".to_vec(),
    ));
    parts.push((
        "xl/charts/colors1.xml".into(),
        b"<cs:colorStyle xmlns:cs=\"x\"/>".to_vec(),
    ));
    let types = text(&parts, TYPES).replace(
        "</Types>",
        r#"<Override PartName="/xl/charts/style3.xml" ContentType="application/vnd.ms-office.chartstyle+xml"/><Override PartName="/xl/charts/colors1.xml" ContentType="application/vnd.ms-office.chartcolorstyle+xml"/></Types>"#,
    );
    for p in parts.iter_mut() {
        if p.0 == TYPES {
            p.1 = types.clone().into_bytes();
        }
    }
    let bytes = write_package(parts.iter().map(|(n, b)| (n.as_str(), b.as_slice())));

    let mut s = SheetSession::load_xlsx(&bytes).expect("load");
    s.delete_chart(2).expect("delete");
    let out = unzip(&s.save_xlsx().expect("save"));
    for gone in [
        "xl/charts/chart3.xml",
        "xl/charts/_rels/chart3.xml.rels",
        "xl/charts/style3.xml",
    ] {
        assert!(part(&out, gone).is_none(), "{gone} goes");
    }
    let types = text(&out, TYPES);
    assert!(!types.contains("/xl/charts/style3.xml"));
    // Shared with chart1: kept, with its content type.
    assert_eq!(
        part(&out, "xl/charts/colors1.xml"),
        part(&parts, "xl/charts/colors1.xml")
    );
    assert!(types.contains("/xl/charts/colors1.xml"));
    assert_eq!(
        part(&out, "xl/charts/_rels/chart1.xml.rels"),
        part(&parts, "xl/charts/_rels/chart1.xml.rels")
    );
}

#[test]
fn an_added_chart_is_no_tombstone_and_restore_refuses_a_slot_past_the_end__feat__sheet_objects() {
    let mut s = SheetSession::load_xlsx(&corpus("09-chart.xlsx")).expect("load");
    let added = s
        .add_chart(0, "B2:B4", "A2:A4", "column", "", "")
        .expect("add");
    s.delete_chart(added).expect("delete added");
    assert!(
        s.chart_tombstones().is_empty(),
        "an added chart never reached the file"
    );
    let saved = s.save_xlsx().expect("save");
    let mut back = SheetSession::load_xlsx(&saved).expect("reload");
    assert_eq!(back.list_charts().len(), 1, "the file chart stays");
    assert!(back.restore_chart_slots(&[5]).is_err());
}

#[test]
fn a_print_area_of_several_ranges_resolves_area_by_area__feat__sheet_objects() {
    let mut s = SheetSession::new();
    for (r, c, v) in [
        (0, 0, "a"),
        (4, 2, "c"),
        (0, 4, "e"),
        (2, 5, "f"),
        (9, 1, "z"),
    ] {
        s.set_cell(0, r, c, v).unwrap();
    }
    s.define_name(
        0,
        "_xlnm.Print_Area",
        "Sheet1!A1:C5,Sheet1!$E$1:$F$3",
        Some(0),
    )
    .expect("define a two-area print area");
    let areas = |s: &SheetSession| -> Vec<String> {
        s.print_areas(0)
            .unwrap()
            .into_iter()
            .map(|r| r.range)
            .collect()
    };
    assert_eq!(areas(&s), ["A1:C5", "E1:F3"]);
    // Saved as the one formula Excel writes, and read back the same.
    let saved = s.save_xlsx().expect("save");
    let wb = text(&unzip(&saved), "xl/workbook.xml");
    assert!(wb.contains("Sheet1!$A$1:$C$5,Sheet1!$E$1:$F$3"), "{wb}");
    let back = SheetSession::load_xlsx(&saved).expect("reload");
    assert_eq!(areas(&back), ["A1:C5", "E1:F3"]);

    // Whole columns (as a file may store them) are cut to the used rows.
    let mut parts = unzip(&saved);
    for p in parts.iter_mut() {
        if p.0 == "xl/workbook.xml" {
            p.1 = wb
                .replace(
                    "Sheet1!$A$1:$C$5,Sheet1!$E$1:$F$3",
                    "Sheet1!$A:$B,Sheet1!$2:$3",
                )
                .into_bytes();
        }
    }
    let bands = SheetSession::load_xlsx(&write_package(
        parts.iter().map(|(n, b)| (n.as_str(), b.as_slice())),
    ))
    .expect("load bands");
    assert_eq!(areas(&bands), ["A1:B10", "A2:F3"]);
    // Areas on two sheets are refused; a sheet without one says so.
    s.add_sheet("Two").unwrap();
    assert!(s
        .define_name(0, "_xlnm.Print_Area", "Sheet1!A1:B2,Two!A1:B2", Some(0))
        .is_err());
    assert!(s.print_areas(1).is_err());
}
