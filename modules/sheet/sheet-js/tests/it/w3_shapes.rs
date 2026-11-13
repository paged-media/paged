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

fn rezip(bytes: &[u8], edits: &[(&str, Vec<u8>)]) -> Vec<u8> {
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
            let edited = edits.iter().find(|(e, _)| *e == n);
            w.write_all(edited.map_or(&b, |(_, new)| new)).unwrap();
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
    let bytes = rezip(&bytes, &[("xl/drawings/drawing1.xml", edited.into_bytes())]);
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
    // 50 x 100 pt box it fills; the outline, through the items' transform,
    // stays inside it.
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
    let t = sh.transform.expect("the turn is the items' transform");
    let at = |p: [f64; 2]| {
        let (x, y) = dml_geom::place::apply(&t.map(f64::from), (p[0], p[1]));
        [x, y]
    };
    for a in &item.anchors {
        for p in [a.anchor, a.left, a.right] {
            let q = at(p);
            assert!(
                (-0.01..=50.01).contains(&q[0]) && (-0.01..=100.01).contains(&q[1]),
                "{q:?}"
            );
        }
    }
    assert!(
        sh.fx.as_ref().is_none_or(|f| f.fill.is_none()),
        "{:?}",
        sh.fx
    );
}

/// Engine ADR 1096 — a preset is the engine's live preset: its item names
/// the program, the adjust values and the box it is drawn for (centred in
/// the anchor box), its anchors are what the engine draws for that box
/// (flips included), and a rotation is kept out of them.
#[test]
fn a_preset_item_is_the_engines_live_preset__feat__sheet_xlsx_shapes() {
    let shape = r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="6" name="Rounded"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom><a:noFill/></xdr:spPr></xdr:sp>"#;
    let s = session_with(&anchored(2, 14, 635_000, 1_270_000, shape));
    let sh = &s.list_shapes(0).unwrap()[0];
    let item = &sh.items[0];
    let p = item.preset.as_ref().expect("a preset item");
    assert_eq!(p.name, "roundRect");
    assert_eq!(
        p.adjusts,
        vec![("adj".to_string(), "val 25000".to_string())]
    );
    // The 100 x 50 shape box centred in the 50 x 100 anchor box.
    assert_eq!(p.frame, [-25.0, 25.0, 100.0, 50.0]);
    assert!(p.flip_h && !p.flip_v);
    let anchors: Vec<paged_model::PathAnchor> = item
        .anchors
        .iter()
        .map(|a| paged_model::PathAnchor {
            anchor: (a.anchor[0] as f32, a.anchor[1] as f32),
            left: (a.left[0] as f32, a.left[1] as f32),
            right: (a.right[0] as f32, a.right[1] as f32),
        })
        .collect();
    assert!(paged_preset_geom::model::anchors_are(p, &anchors, &[0]));
    // Upright anchors: they span the shape box, not the anchor box.
    let xs = item.anchors.iter().map(|a| a.anchor[0]);
    let (lo, hi) = xs.fold((f64::MAX, f64::MIN), |(l, h), x| (l.min(x), h.max(x)));
    assert!(
        (lo + 25.0).abs() < 1e-6 && (hi - 75.0).abs() < 1e-6,
        "{lo} {hi}"
    );
    // An unturned preset needs no transform; a custom geometry has no preset.
    let s = session_with(&anchored(3, 12, 1_270_000, 635_000, RECT));
    let rect = &s.list_shapes(0).unwrap()[0];
    assert!(rect.transform.is_none());
    assert_eq!(
        rect.items[0].preset.as_ref().unwrap().frame,
        [0.0, 0.0, 100.0, 50.0]
    );
}

/// A preset whose detail path is stroke-only (a callout's leader) is two
/// items: the filled path and the detail over it, each its part of the
/// program. A preset with several filled paths (a can's shaded lid, a
/// cube's sides) keeps them in its one filled item, which the engine paints
/// face by face (engine ADR 1096, amendment 1): it is a live preset too.
#[test]
fn a_detail_path_is_the_presets_detail_part__feat__sheet_xlsx_shapes() {
    let callout = RECT.replacen(r#"prst="rect""#, r#"prst="borderCallout1""#, 1);
    let s = session_with(&anchored(3, 12, 1_270_000, 635_000, &callout));
    let sh = &s.list_shapes(0).unwrap()[0];
    let parts: Vec<_> = sh
        .items
        .iter()
        .map(|i| i.preset.as_ref().map(|p| p.part))
        .collect();
    use paged_model::live_shape::PresetPart;
    assert_eq!(
        parts,
        vec![Some(PresetPart::Fill), Some(PresetPart::Detail)],
        "{:?}",
        sh.items
    );
    assert!(sh
        .items
        .iter()
        .all(|i| i.preset.as_ref().unwrap().key.as_deref() == Some(sh.id.as_str())));
    for (name, faces) in [("can", 2), ("cube", 3)] {
        let shape = RECT.replacen(r#"prst="rect""#, &format!(r#"prst="{name}""#), 1);
        let s = session_with(&anchored(3, 12, 1_270_000, 635_000, &shape));
        let sh = &s.list_shapes(0).unwrap()[0];
        let parts: Vec<_> = sh
            .items
            .iter()
            .map(|i| i.preset.as_ref().map(|p| p.part))
            .collect();
        assert_eq!(
            parts,
            vec![Some(PresetPart::Fill), Some(PresetPart::Detail)],
            "{name}"
        );
        let fill = &sh.items[0];
        assert!(fill.filled && !fill.stroked && fill.closed, "{name}");
        assert_eq!(fill.subpath_starts.len(), faces, "{name}");
        // The engine paints its faces with their shades.
        let p = fill.preset.as_ref().unwrap();
        let anchors: Vec<paged_model::PathAnchor> = fill
            .anchors
            .iter()
            .map(|a| paged_model::PathAnchor {
                anchor: (a.anchor[0] as f32, a.anchor[1] as f32),
                left: (a.left[0] as f32, a.left[1] as f32),
                right: (a.right[0] as f32, a.right[1] as f32),
            })
            .collect();
        let paints =
            paged_preset_geom::model::contour_paints(p, &anchors, &fill.subpath_starts).unwrap();
        assert!(paints.iter().any(|c| c.fill.is_shaded()), "{name}");
    }
}

#[test]
fn text_and_arrowheads_are_reported__feat__sheet_xlsx_shapes() {
    let shape = r#"<xdr:cxnSp macro=""><xdr:nvCxnSpPr><xdr:cNvPr id="7" name="Arrow"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:headEnd type="oval" w="sm"/><a:tailEnd type="triangle"/></a:ln></xdr:spPr></xdr:cxnSp>"#;
    let text = r#"<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="8" name="Box"/><xdr:cNvSpPr txBox="1"/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr><xdr:txBody><a:bodyPr/><a:p><a:r><a:t>Hello</a:t></a:r></a:p></xdr:txBody></xdr:sp>"#;
    let s = session_with(&format!(
        "{}{}",
        anchored(1, 20, 1_270_000, 0, shape),
        anchored(2, 22, 1_270_000, 635_000, text)
    ));
    let shapes = s.list_shapes(0).unwrap();
    assert_eq!(shapes.len(), 2);
    // Engine ADR 1093 (amendment 2): the line carries Office's heads, and
    // the nearest InDesign arrowhead beside them for IDML.
    use paged_model::{OfficeHeadKind, OfficeHeadSize};
    let line = &shapes[0].items[0];
    let head = line.start_head.expect("the head end");
    assert_eq!(
        (head.kind, head.w),
        (OfficeHeadKind::Oval, OfficeHeadSize::Sm)
    );
    assert_eq!(line.end_head.unwrap().kind, OfficeHeadKind::Triangle);
    assert_eq!(
        line.start_arrowhead.as_deref(),
        Some("CircleSolidArrowHead")
    );
    assert_eq!(line.end_arrowhead.as_deref(), Some("TriangleArrowHead"));
    // The line is still the whole preset (the renderer stops it under its
    // heads), so it stays live.
    assert_eq!(line.preset.as_ref().unwrap().name, "line");
    assert!(shapes[0].losses.is_empty(), "{:?}", shapes[0].losses);
    assert!(shapes[1]
        .losses
        .iter()
        .any(|l| l.code == "xlsx.shape.text" && l.message.contains("text")));
    assert!(shapes[1].items[0].start_head.is_none());
}

/// Sheet ADR 531 — a picture's and a shape's click action (`a:hlinkClick`)
/// is the external URL its relationship names; a link inside the workbook is
/// none.
#[test]
fn an_items_click_action_is_its_external_url__feat__sheet_xlsx_shapes() {
    let bytes = fixture("16-structure.xlsx");
    let drawing = part(&bytes, "xl/drawings/drawing1.xml");
    let rels = part(&bytes, "xl/drawings/_rels/drawing1.xml.rels");
    let link = |id: &str| format!(r#"<a:hlinkClick r:id="{id}"/>"#);
    let picture_linked = drawing.replacen(
        r#"<xdr:cNvPr id="2" name="Picture 1"/>"#,
        &format!(
            r#"<xdr:cNvPr id="2" name="Picture 1">{}</xdr:cNvPr>"#,
            link("rId90")
        ),
        1,
    );
    let shape = RECT.replacen(
        r#"<xdr:cNvPr id="5" name="Rectangle 4"/>"#,
        &format!(
            r#"<xdr:cNvPr id="5" name="Rectangle 4">{}</xdr:cNvPr>"#,
            link("rId91")
        ),
        1,
    );
    let inside = RECT.replacen(
        r#"<xdr:cNvPr id="5" name="Rectangle 4"/>"#,
        &format!(
            r#"<xdr:cNvPr id="6" name="Inside">{}</xdr:cNvPr>"#,
            link("rId92")
        ),
        1,
    );
    let edited = picture_linked.replacen(
        "</xdr:wsDr>",
        &format!(
            "{}{}</xdr:wsDr>",
            anchored(3, 12, 1_270_000, 635_000, &shape),
            anchored(4, 14, 1_270_000, 635_000, &inside)
        ),
        1,
    );
    let rels = rels.replacen(
        "</Relationships>",
        concat!(
            r#"<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://paged.media/a" TargetMode="External"/>"#,
            r#"<Relationship Id="rId91" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://paged.media/b" TargetMode="External"/>"#,
            r##"<Relationship Id="rId92" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="#Sheet1!A1"/>"##,
            "</Relationships>"
        ),
        1,
    );
    let bytes = rezip(
        &bytes,
        &[
            ("xl/drawings/drawing1.xml", edited.into_bytes()),
            ("xl/drawings/_rels/drawing1.xml.rels", rels.into_bytes()),
        ],
    );
    let s = SheetSession::load_xlsx(&bytes).unwrap();
    assert_eq!(
        s.list_pictures(0).unwrap()[0].link.as_deref(),
        Some("https://paged.media/a")
    );
    let shapes = s.list_shapes(0).unwrap();
    assert_eq!(shapes[0].link.as_deref(), Some("https://paged.media/b"));
    assert_eq!(shapes[1].link, None, "a link inside the workbook");
}

/// Engine ADR 1096 — a preset changed on the page is written into the
/// workbook's drawing: the shape's `a:prstGeom` and its `a:avLst`, the rest
/// of the part as it was; the saved file reads back with it.
#[test]
fn a_pages_preset_is_written_into_the_drawing__feat__sheet_xlsx_shapes() {
    let rounded = RECT.replacen(r#"prst="rect""#, r#"prst="roundRect""#, 1);
    let mut s = session_with(&format!(
        "{}{}",
        anchored(3, 12, 1_270_000, 635_000, &rounded),
        anchored(4, 14, 1_270_000, 635_000, RECT)
    ));
    let shapes = s.list_shapes(0).unwrap();
    let (id, other) = (shapes[0].id.clone(), shapes[1].id.clone());
    let adj = vec![("adj".to_string(), "val 40000".to_string())];
    assert!(s.set_shape_preset(&id, "roundRect", &adj).unwrap());
    assert!(
        !s.set_shape_preset(&id, "roundRect", &adj).unwrap(),
        "already says so"
    );
    assert!(s.set_shape_preset(&id, "notAPreset", &[]).is_err());
    let saved = s.save_xlsx().unwrap();
    // For the Excel oracle (engine ADR 1096, amendment 1): the saved file.
    if let Ok(dir) = std::env::var("PAGED_XLSX_EXPORT_DIR") {
        std::fs::write(
            std::path::Path::new(&dir).join("presets-edited.xlsx"),
            &saved,
        )
        .unwrap();
    }
    let drawing = part(&saved, id.split('#').next().unwrap());
    assert!(drawing.contains(
        r#"<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 40000"/></a:avLst></a:prstGeom>"#
    ));
    assert!(drawing.contains(r#"<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>"#));
    let again = SheetSession::load_xlsx(&saved).unwrap();
    let back = again.list_shapes(0).unwrap();
    let p = back[0].items[0].preset.as_ref().unwrap();
    assert_eq!((p.name.as_str(), p.adjusts.clone()), ("roundRect", adj));
    assert_eq!(back[1].id, other);
}
