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

//! Sheet ADR 530 — the shapes of a drawing (`xdr:sp`, `xdr:cxnSp`) read,
//! their outlines evaluated by `dml-geom` and their paint mapped by the
//! shared DrawingML mapper, placed in their anchor boxes.

#![allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)

use std::io::{Read, Write};

use sheet_js::core::SheetSession;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../corpus/xlsx-corpus")
            .join(name),
    )
    .unwrap()
}

fn part(bytes: &[u8], name: &str) -> String {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut f = z.by_name(name).unwrap();
    let mut s = String::new();
    f.read_to_string(&mut s).unwrap();
    s
}

fn rezip(bytes: &[u8], name: &str, new: Vec<u8>) -> Vec<u8> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = Vec::new();
    {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut out));
        let opts = zip::write::SimpleFileOptions::default();
        for i in 0..z.len() {
            let mut f = z.by_index(i).unwrap();
            let n = f.name().unwrap().to_string();
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            w.start_file(n.clone(), opts).unwrap();
            w.write_all(if n == name { &new } else { &b }).unwrap();
        }
        w.finish().unwrap();
    }
    out
}

/// A one-cell-anchored shape at (`col`, `row`) of `cx` × `cy` EMU.
fn anchored(col: u32, row: u32, cx: i64, cy: i64, shape: &str) -> String {
    format!(
        r#"<xdr:oneCellAnchor><xdr:from><xdr:col>{col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="{cx}" cy="{cy}"/>{shape}<xdr:clientData/></xdr:oneCellAnchor>"#
    )
}

fn session_with(shapes: &str) -> SheetSession {
    let bytes = fixture("16-structure.xlsx");
    let drawing = part(&bytes, "xl/drawings/drawing1.xml");
    let edited = drawing.replacen("</xdr:wsDr>", &format!("{shapes}</xdr:wsDr>"), 1);
    let bytes = rezip(&bytes, "xl/drawings/drawing1.xml", edited.into_bytes());
    SheetSession::load_xlsx(&bytes).unwrap()
}

const RECT: &str = r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="5" name="Rectangle 4"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:prstDash val="dash"/></a:ln></xdr:spPr></xdr:sp>"#;

#[test]
fn a_preset_shape_is_read_and_lowered_with_its_paint__feat__sheet_xlsx_shapes() {
    let s = session_with(&anchored(3, 12, 1_270_000, 635_000, RECT));
    let shapes = s.list_shapes(0).unwrap();
    assert_eq!(shapes.len(), 1, "the picture and the chart are not shapes");
    let sh = &shapes[0];
    assert_eq!((sh.row, sh.col), (12, 3));
    assert_eq!((sh.w_pt, sh.h_pt), (100.0, 50.0));
    assert_eq!(sh.items.len(), 1);
    let item = &sh.items[0];
    assert!(item.closed && item.filled && item.stroked);
    let xs: Vec<f64> = item.anchors.iter().map(|a| a.anchor[0]).collect();
    let ys: Vec<f64> = item.anchors.iter().map(|a| a.anchor[1]).collect();
    let span = |v: &[f64]| {
        (
            v.iter().cloned().fold(f64::MAX, f64::min),
            v.iter().cloned().fold(f64::MIN, f64::max),
        )
    };
    assert_eq!(span(&xs), (0.0, 100.0));
    assert_eq!(span(&ys), (0.0, 50.0));
    let fx = sh.fx.as_ref().expect("the shape's paint");
    assert_eq!(fx.fill.as_deref(), Some("#FF0000"));
    let stroke = fx.stroke.as_ref().expect("the outline");
    assert_eq!((stroke.color.as_str(), stroke.weight), ("#0000FF", 2.0));
    assert!(!stroke.dash.is_empty());
    assert!(sh.losses.is_empty(), "{:?}", sh.losses);
}

#[test]
fn a_page_carries_the_shapes_in_its_cells__feat__sheet_xlsx_shapes() {
    let s = session_with(&anchored(3, 12, 1_270_000, 635_000, RECT));
    let page = |rows: std::ops::Range<u32>| {
        let spec = sheet_js::core::TracksSpec {
            rows: rows.collect(),
            cols: (0..6).collect(),
            ..Default::default()
        };
        s.get_tracks_page(0, spec).unwrap()
    };
    assert_eq!(s.page_shapes(0, &page(10..16)).len(), 1);
    assert!(s.page_shapes(0, &page(0..4)).is_empty());
}

#[test]
fn a_turned_flipped_rounded_shape_is_evaluated_in_its_box__feat__sheet_xlsx_shapes() {
    // A 100 x 50 pt rounded rectangle turned 90 degrees: its anchor is the
    // 50 x 100 pt box it fills, the outline stays inside it.
    let shape = r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="6" name="Rounded"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom><a:noFill/></xdr:spPr></xdr:sp>"#;
    let s = session_with(&anchored(2, 14, 635_000, 1_270_000, shape));
    let sh = &s.list_shapes(0).unwrap()[0];
    assert_eq!((sh.w_pt, sh.h_pt), (50.0, 100.0));
    let item = &sh.items[0];
    // Rounded corners are curves: some anchor has handles off its point.
    assert!(item
        .anchors
        .iter()
        .any(|a| a.left != a.anchor || a.right != a.anchor));
    for a in &item.anchors {
        for p in [a.anchor, a.left, a.right] {
            assert!(
                (-0.01..=50.01).contains(&p[0]) && (-0.01..=100.01).contains(&p[1]),
                "{p:?}"
            );
        }
    }
    assert!(
        sh.fx.as_ref().is_none_or(|f| f.fill.is_none()),
        "{:?}",
        sh.fx
    );
}

#[test]
fn text_and_arrowheads_are_reported__feat__sheet_xlsx_shapes() {
    let shape = r#"<xdr:cxnSp macro=""><xdr:nvCxnSpPr><xdr:cNvPr id="7" name="Arrow"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln></xdr:spPr></xdr:cxnSp>"#;
    let text = r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="8" name="Box"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr><xdr:txBody><a:bodyPr/><a:p><a:r><a:t>Hello</a:t></a:r></a:p></xdr:txBody></xdr:sp>"#;
    let s = session_with(&format!(
        "{}{}",
        anchored(1, 20, 1_270_000, 0, shape),
        anchored(2, 22, 1_270_000, 635_000, text)
    ));
    let shapes = s.list_shapes(0).unwrap();
    assert_eq!(shapes.len(), 2);
    assert!(shapes[0].losses.iter().any(|l| l.contains("arrowheads")));
    assert!(shapes[1].losses.iter().any(|l| l.contains("text")));
}
