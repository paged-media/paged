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

#![allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)

//! W2.3 (sheet ADR 526): hyperlinks, notes and pictures through the session
//! — authored, saved, read back after a reload; pictures read from drawings
//! and from cells.

use std::io::{Read, Write};

use sheet_js::core::annotations::HyperlinkArg;
use sheet_js::core::{GridSceneOptions, SheetSession};

fn part(bytes: &[u8], name: &str) -> Option<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut f = z.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).unwrap();
    Some(s)
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../corpus/xlsx-corpus")
            .join(name),
    )
    .unwrap()
}

/// A package with `edits` applied: parts replaced or added by name.
fn rezip(bytes: &[u8], edits: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
        let opts = zip::write::SimpleFileOptions::default();
        for i in 0..z.len() {
            let mut f = z.by_index(i).unwrap();
            let name = f.name().unwrap().to_string();
            if edits.iter().any(|(n, _)| *n == name) {
                continue;
            }
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            w.start_file(name, opts).unwrap();
            w.write_all(&b).unwrap();
        }
        for (n, b) in edits {
            w.start_file(*n, opts).unwrap();
            w.write_all(b).unwrap();
        }
        w.finish().unwrap();
    }
    out
}

#[test]
fn hyperlinks_are_set_replaced_removed_and_saved__feat__sheet_xlsx_hyperlinks() {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "paged").unwrap();
    s.set_hyperlink(
        0,
        "A1",
        HyperlinkArg {
            url: Some("https://paged.media/?a=1&b=2".into()),
            tooltip: Some("Open the site".into()),
            ..Default::default()
        },
    )
    .unwrap();
    s.set_hyperlink(
        0,
        "B2:C3",
        HyperlinkArg {
            location: Some("Sheet1!E5".into()),
            display: Some("Totals".into()),
            ..Default::default()
        },
    )
    .unwrap();
    // The cells take Excel's Hyperlink style.
    assert_eq!(
        s.get_style(0, 0, 0).unwrap().named_style.as_deref(),
        Some("Hyperlink")
    );
    let links = s.list_hyperlinks(0).unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(links[1].range, "B2:C3");

    // The grid gets one rect per visible linked cell.
    let scene = s
        .get_grid_scene(0, 0, 0, 400.0, 200.0, GridSceneOptions::default())
        .unwrap();
    assert_eq!(scene.links.len(), 5);
    assert_eq!(
        scene.links[0].url.as_deref(),
        Some("https://paged.media/?a=1&b=2")
    );

    let saved = s.save_xlsx().unwrap();
    let ws = part(&saved, "xl/worksheets/sheet1.xml").unwrap();
    assert!(ws.contains("<hyperlinks"), "{ws}");
    assert!(ws.contains("location=\"Sheet1!E5\""));
    let rels = part(&saved, "xl/worksheets/_rels/sheet1.xml.rels").unwrap();
    assert!(rels.contains("TargetMode=\"External\""));
    assert!(rels.contains("https://paged.media/?a=1&amp;b=2"));

    let mut back = SheetSession::load_xlsx(&saved).unwrap();
    assert_eq!(back.list_hyperlinks(0).unwrap(), links);
    // Replacing A1's link leaves one external relationship; removing all
    // leaves none and no <hyperlinks>.
    back.set_hyperlink(
        0,
        "A1",
        HyperlinkArg {
            url: Some("mailto:office@example.com".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let again = back.save_xlsx().unwrap();
    let rels = part(&again, "xl/worksheets/_rels/sheet1.xml.rels").unwrap();
    assert_eq!(rels.matches("TargetMode=\"External\"").count(), 1, "{rels}");
    assert_eq!(back.remove_hyperlinks(0, "A1:Z99").unwrap(), 2);
    let none = back.save_xlsx().unwrap();
    assert!(!part(&none, "xl/worksheets/sheet1.xml")
        .unwrap()
        .contains("hyperlink"));
    // Undo puts the links back exactly.
    back.restore_hyperlinks(0, links.clone()).unwrap();
    assert_eq!(back.list_hyperlinks(0).unwrap(), links);
    assert!(back
        .set_hyperlink(0, "A1", HyperlinkArg::default())
        .is_err());
}

#[test]
fn notes_are_added_edited_and_deleted_with_their_shapes__feat__sheet_xlsx_comments() {
    let mut s = SheetSession::new();
    s.set_note(0, 1, 1, "Paged", "First note").unwrap();
    s.set_note(0, 0, 3, "Reviewer", "Second <note> & more")
        .unwrap();
    let saved = s.save_xlsx().unwrap();
    let comments = part(&saved, "xl/comments1.xml").expect("a comments part");
    assert!(comments.contains("<author>Paged</author><author>Reviewer</author>"));
    // Row-major: D1 before B2.
    assert!(comments.find("ref=\"D1\"").unwrap() < comments.find("ref=\"B2\"").unwrap());
    let vml = part(&saved, "xl/drawings/vmlDrawing1.vml").expect("a VML drawing");
    assert_eq!(vml.matches("ObjectType=\"Note\"").count(), 2);
    let ws = part(&saved, "xl/worksheets/sheet1.xml").unwrap();
    assert!(ws.contains("<legacyDrawing"), "{ws}");
    let ct = part(&saved, "[Content_Types].xml").unwrap();
    assert!(ct.contains("Extension=\"vml\""));
    assert!(ct.contains("/xl/comments1.xml"));

    let mut back = SheetSession::load_xlsx(&saved).unwrap();
    let notes = back.list_comments();
    assert_eq!(notes.len(), 2);
    assert!(notes
        .iter()
        .any(|n| n.text == "Second <note> & more" && n.author == "Reviewer"));
    back.set_note(0, 1, 1, "Paged", "Edited").unwrap();
    assert_eq!(
        back.list_comments()
            .iter()
            .find(|n| (n.row, n.col) == (1, 1))
            .unwrap()
            .text,
        "Edited"
    );
    assert!(back.delete_note(0, 1, 1).unwrap());
    assert!(!back.delete_note(0, 1, 1).unwrap());
    let one = back.save_xlsx().unwrap();
    assert_eq!(
        part(&one, "xl/drawings/vmlDrawing1.vml")
            .unwrap()
            .matches("ObjectType=\"Note\"")
            .count(),
        1
    );
    assert!(back.delete_note(0, 0, 3).unwrap());
    let none = back.save_xlsx().unwrap();
    assert!(part(&none, "xl/comments1.xml").is_none());
    assert!(part(&none, "xl/drawings/vmlDrawing1.vml").is_none());
    assert!(!part(&none, "xl/worksheets/sheet1.xml")
        .unwrap()
        .contains("legacyDrawing"));
    assert!(SheetSession::load_xlsx(&none)
        .unwrap()
        .list_comments()
        .is_empty());
}

#[test]
fn a_note_beside_a_threaded_comment_keeps_both__feat__sheet_xlsx_comments() {
    let mut s = SheetSession::load_xlsx(&fixture("16-structure.xlsx")).unwrap();
    let notes = s.list_comments();
    assert!(notes.iter().any(|n| (n.row, n.col) == (2, 3) && n.threaded));
    assert!(notes
        .iter()
        .any(|n| (n.row, n.col) == (2, 1) && !n.threaded));
    // The thread's note is refused; the plain note is edited in place.
    assert!(s.set_note(0, 2, 3, "Paged", "x").is_err());
    assert!(s.delete_note(0, 2, 3).is_err());
    s.set_note(0, 2, 1, "Paged", "Count checked").unwrap();
    s.set_note(0, 5, 5, "Paged", "New").unwrap();
    let saved = s.save_xlsx().unwrap();
    let vml = part(&saved, "xl/drawings/vmlDrawing1.vml").unwrap();
    assert_eq!(vml.matches("ObjectType=\"Note\"").count(), 3);
    assert!(vml.contains("_x0000_s1027"), "next shape number");
    assert!(part(&saved, "xl/threadedComments/threadedComment1.xml").is_some());
    let c = part(&saved, "xl/comments1.xml").unwrap();
    assert!(c.contains("xr:uid=\"{6F1D7E2A-0000-4000-8000-000000000002}\""));
    assert!(c.contains("Count checked"));
}

#[test]
fn drawing_pictures_are_placed_in_sheet_points__feat__sheet_xlsx_pictures() {
    let s = SheetSession::load_xlsx(&fixture("16-structure.xlsx")).unwrap();
    let pics = s.list_pictures(0).unwrap();
    assert_eq!(pics.len(), 1, "the chart is not a picture");
    let p = &pics[0];
    assert_eq!((p.row, p.col), (1, 11));
    assert!(!p.in_cell);
    assert_eq!(p.content_type, "image/png");
    assert_eq!(p.media, "xl/media/image1.png");
    // L2:M4 at the default sizes.
    let colw = 8.43 * 5.25;
    assert!((p.x - 11.0 * colw).abs() < 1e-6, "{}", p.x);
    assert!((p.y - 15.0).abs() < 1e-6);
    assert!((p.w - colw).abs() < 1e-6 && (p.h - 30.0).abs() < 1e-6);
    let bytes = s.picture_bytes(&p.media).unwrap();
    assert!(bytes.starts_with(b"\x89PNG"));
    assert!(s.picture_bytes("xl/workbook.xml").is_err());
    // In the grid when scrolled to it, not at A1 with a narrow window.
    let near = s
        .get_grid_scene(0, 0, 8, 400.0, 200.0, GridSceneOptions::default())
        .unwrap();
    assert_eq!(near.pictures.len(), 1);
    assert!((near.pictures[0].x - 3.0 * colw).abs() < 1e-6);
    let far = s
        .get_grid_scene(0, 0, 0, 100.0, 100.0, GridSceneOptions::default())
        .unwrap();
    assert!(far.pictures.is_empty());
}

const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0,
    0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

/// A workbook with an image placed in B3, written the way Excel writes one
/// (value metadata → rich value → rich value relationship → media).
fn in_cell_workbook() -> Vec<u8> {
    let mut s = SheetSession::new();
    s.set_cell(0, 0, 0, "x").unwrap();
    let base = s.save_xlsx().unwrap();
    let ws = part(&base, "xl/worksheets/sheet1.xml").unwrap();
    let ws = ws.replace(
        "</sheetData>",
        r#"<row r="3"><c r="B3" t="e" vm="1"><v>#VALUE!</v></c></row></sheetData>"#,
    );
    let ct = part(&base, "[Content_Types].xml").unwrap().replace(
        "</Types>",
        r#"<Default Extension="png" ContentType="image/png"/><Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/></Types>"#,
    );
    let metadata = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000"/></metadataTypes><futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata><valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>"#;
    let rv = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><rv s="0"><v>0</v><v>5</v></rv></rvData>"#;
    let rvs = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>"#;
    let rel = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><rel r:id="rId1"/></richValueRels>"#;
    let rel_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>"#;
    rezip(
        &base,
        &[
            ("xl/worksheets/sheet1.xml", ws.into_bytes()),
            ("[Content_Types].xml", ct.into_bytes()),
            ("xl/metadata.xml", metadata.as_bytes().to_vec()),
            ("xl/richData/rdrichvalue.xml", rv.as_bytes().to_vec()),
            (
                "xl/richData/rdrichvaluestructure.xml",
                rvs.as_bytes().to_vec(),
            ),
            ("xl/richData/richValueRel.xml", rel.as_bytes().to_vec()),
            (
                "xl/richData/_rels/richValueRel.xml.rels",
                rel_rels.as_bytes().to_vec(),
            ),
            ("xl/media/image1.png", PNG_1X1.to_vec()),
        ],
    )
}

#[test]
fn an_image_in_a_cell_is_found_through_the_rich_value_chain__feat__sheet_xlsx_pictures() {
    let s = SheetSession::load_xlsx(&in_cell_workbook()).unwrap();
    let pics = s.list_pictures(0).unwrap();
    assert_eq!(pics.len(), 1);
    let p = &pics[0];
    assert!(p.in_cell);
    assert_eq!((p.row, p.col), (2, 1));
    assert_eq!(p.id, "cell:B3");
    assert_eq!(p.media, "xl/media/image1.png");
    assert_eq!(p.content_type, "image/png");
    assert!((p.y - 30.0).abs() < 1e-6 && (p.h - 15.0).abs() < 1e-6);
    let scene = s
        .get_grid_scene(0, 0, 0, 400.0, 200.0, GridSceneOptions::default())
        .unwrap();
    assert_eq!(scene.pictures.len(), 1);
    assert!(scene.pictures[0].in_cell);
    // The parts round-trip untouched.
    let mut s = s;
    let saved = s.save_xlsx().unwrap();
    assert!(part(&saved, "xl/richData/rdrichvalue.xml").is_some());
    assert!(part(&saved, "xl/worksheets/sheet1.xml")
        .unwrap()
        .contains("vm=\"1\""));
}

#[test]
fn a_page_table_carries_the_pictures_in_its_cells__feat__sheet_xlsx_pictures() {
    let s = SheetSession::load_xlsx(&fixture("16-structure.xlsx")).unwrap();
    let spec =
        |rows: std::ops::Range<u32>, cols: std::ops::Range<u32>| sheet_js::core::TracksSpec {
            rows: rows.collect(),
            cols: cols.collect(),
            ..Default::default()
        };
    let page = s.get_tracks_page(0, spec(0..6, 9..14)).unwrap();
    let pics = s.page_pictures(0, &page);
    assert_eq!(pics.len(), 1);
    assert_eq!((pics[0].row, pics[0].col), (1, 11));
    assert!(pics[0].uri.starts_with("data:image/png;base64,iVBORw0KGgo"));
    let away = s.get_tracks_page(0, spec(0..6, 0..5)).unwrap();
    assert!(s.page_pictures(0, &away).is_empty());
    assert_eq!(sheet_js::core::annotations::base64(b"Man"), "TWFu");
    assert_eq!(sheet_js::core::annotations::base64(b"Ma"), "TWE=");
    assert_eq!(sheet_js::core::annotations::base64(b"M"), "TQ==");
}
