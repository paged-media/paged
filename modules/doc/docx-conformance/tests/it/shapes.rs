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

//! Doc ADR 627 — shapes without text: read from `wps:wsp`, completed from
//! `wps:style`, lowered to anchored frames along their outline, and the
//! ones the lowering does not draw told.

#![allow(non_snake_case)]

use docx_conformance::{shapes_docx, SHAPE_CASES};
use docx_core::{Block, DocxDocument, Shape, ShapeGeometry};
use docx_lower::ir::{LoweredBlock, LoweredShape};
use paged_ooxml::drawingml::{ColorBase, Fill};

fn shapes(doc: &DocxDocument) -> Vec<&Shape> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.runs.iter().flat_map(|r| r.shapes.iter()))
        .collect()
}

fn preset(s: &Shape) -> &str {
    match &s.geometry {
        ShapeGeometry::Preset { name, .. } => name,
        ShapeGeometry::Custom(_) => "custGeom",
    }
}

fn lowered_shapes(ir: &docx_lower::ir::LoweredDoc) -> Vec<&LoweredShape> {
    ir.story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.shapes.iter())
        .collect()
}

#[test]
fn every_shape_without_text_is_read__feat__doc_shapes() {
    let doc = docx_import::import_docx(&shapes_docx()).expect("import");
    let got = shapes(&doc);
    assert_eq!(
        got.iter().map(|s| preset(s)).collect::<Vec<_>>(),
        SHAPE_CASES.iter().map(|(n, _)| *n).collect::<Vec<_>>()
    );
    // Not counted as drawings that are not carried.
    let others: u32 = doc
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| p.runs.iter())
        .map(|r| r.other_drawings)
        .sum();
    assert_eq!(others, 0);
    // Extents, floats and the rotation.
    assert_eq!((got[0].width_emu, got[0].height_emu), (1_828_800, 914_400));
    assert!(got[0].float.is_none() && got[1].float.is_some());
    assert_eq!(got[4].rotation, 5_400_000);
    // The authored triangle keeps its guide.
    assert_eq!(
        got[2].geometry,
        ShapeGeometry::Preset {
            name: "triangle".into(),
            adjust: vec![("adj".into(), 30000)]
        }
    );
}

#[test]
fn a_shape_leaves_its_fill_and_line_to_wps_style__feat__doc_shapes() {
    let doc = docx_import::import_docx(&shapes_docx()).expect("import");
    let got = shapes(&doc);
    // The rectangle states both.
    let rect = got[0].look.as_ref().expect("look").shape.clone();
    assert!(matches!(rect.fill, Some(Fill::Solid(_))));
    assert_eq!(rect.line.as_ref().and_then(|l| l.width), Some(19050));
    // The ellipse states neither: the fill is accent1 (fillRef), the line
    // the theme's second line style (12700 EMU) in accent1's shade.
    let ellipse = got[1].look.as_ref().expect("look").shape.clone();
    match ellipse.fill {
        Some(Fill::Solid(c)) => {
            assert_eq!(c.base, ColorBase::Scheme("accent1".into()))
        }
        other => panic!("fill from fillRef: {other:?}"),
    }
    let line = ellipse.line.expect("line from lnRef");
    assert_eq!(line.width, Some(12700));
    assert!(matches!(line.fill, Some(Fill::Solid(_))));
    // The triangle says `a:ln` is `noFill`: that stays.
    let tri = got[2].look.as_ref().expect("look").shape.clone();
    assert!(matches!(tri.line.and_then(|l| l.fill), Some(Fill::None)));
}

#[test]
fn the_lowering_draws_the_outlines_it_has_and_tells_the_rest__feat__doc_shapes() {
    let doc = docx_import::import_docx(&shapes_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    let drawn = lowered_shapes(&ir);
    // Every case: the presets through Annex D's definitions (doc ADR 629).
    assert_eq!(drawn.len(), SHAPE_CASES.iter().filter(|(_, d)| *d).count());
    // The triangle (third case): three anchors on the box, apex at 30 %.
    let tri = drawn[2];
    assert_eq!(tri.anchors.len(), 3);
    assert!((tri.anchors[1][0] - 0.3 * tri.width_pt).abs() < 0.01 && tri.anchors[1][1] == 0.0);
    assert_eq!(
        (tri.starts.clone(), tri.open.clone()),
        (vec![0], vec![false])
    );
    // The line is one open contour; it has a look with an outline only.
    let line = drawn[3];
    assert_eq!(line.open, vec![true]);
    assert!(line.fx.as_ref().is_some_and(|fx| fx.fill.is_none()));
    // The ellipse floats: an anchor with a wrap.
    assert!(drawn[1].anchor.is_some());
    // The inline rectangle does not.
    assert!(drawn[0].anchor.is_none());
    // The cloud callout, which the hand port of ADR 627 did not draw, is
    // drawn: its outline is many curves.
    assert!(drawn[6].anchors.len() > 10);
    // The arrow: an oval at its start, a large triangle at its end, the
    // frame's Office heads (engine ADR 1093, amendment 3), drawn by the
    // engine in the line's colour; the plain line has none. The line keeps
    // its whole length: the engine stops its stroke under the heads.
    use paged_model::OfficeHeadKind;
    assert!(drawn[3].start_head.is_none() && drawn[3].end_head.is_none());
    assert_eq!(
        drawn[7].start_head.map(|h| h.kind),
        Some(OfficeHeadKind::Oval)
    );
    assert_eq!(
        drawn[7].end_head.map(|h| h.kind),
        Some(OfficeHeadKind::Triangle)
    );
    let last = drawn[7].anchors.last().expect("line");
    assert!((last[0] - drawn[7].width_pt).abs() < 1e-3, "{last:?}");
    // Told: the shapes it draws.
    let messages: Vec<&str> = ir.diagnostics.iter().map(|d| d.message.as_str()).collect();
    assert!(
        messages
            .iter()
            .any(|m| m.contains("8 shape(s) without text placed")),
        "{messages:?}"
    );
    assert!(
        !messages.iter().any(|m| m.contains("NOT shown")),
        "{messages:?}"
    );
}

#[test]
fn an_unedited_save_keeps_the_drawings__feat__doc_shapes() {
    let bytes = shapes_docx();
    let session = docx_js::DocSession::load(&bytes).expect("load");
    assert_eq!(session.save_verbatim(), bytes);
}

/// The skeleton's anchored frames of a body, by id.
fn frames_by_id(
    body: &docx_skeleton::body::NativeBody,
) -> std::collections::HashMap<String, paged_model::AnchoredFrame> {
    let mut out = std::collections::HashMap::new();
    fn add(
        f: &paged_model::AnchoredFrame,
        out: &mut std::collections::HashMap<String, paged_model::AnchoredFrame>,
    ) {
        if let Some(id) = &f.self_id {
            out.insert(id.clone(), f.clone());
        }
        for c in &f.children {
            add(c, out);
        }
    }
    for b in &body.blocks {
        let paras: Vec<&paged_model::Paragraph> = match b {
            docx_skeleton::body::NativeBlock::Paragraph(p)
            | docx_skeleton::body::NativeBlock::Table(p) => vec![p],
            docx_skeleton::body::NativeBlock::Split(ps) => ps.iter().collect(),
            docx_skeleton::body::NativeBlock::Deferred { .. } => vec![],
        };
        for p in paras {
            for f in &p.anchored_frames {
                add(f, &mut out);
            }
        }
    }
    out
}

/// What the canvas reads back of a shape's frame.
fn read_back(f: &paged_model::AnchoredFrame, drawing: u32) -> docx_export::shapes::ShapeIn {
    docx_export::shapes::ShapeIn {
        drawing,
        preset: f.preset.clone(),
        anchors: f
            .anchors
            .iter()
            .map(|a| {
                [
                    a.anchor.0, a.anchor.1, a.left.0, a.left.1, a.right.0, a.right.1,
                ]
            })
            .collect(),
        starts: f.subpath_starts.clone(),
        open: f.subpath_open.clone(),
        size: f.bounds.map(|b| [b.right - b.left, b.bottom - b.top]),
    }
}

fn part_text(bytes: &[u8], name: &str) -> String {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

/// Engine ADR 1096 — docx → paged → docx. The import maps each Word
/// preset onto its anchored frame's engine preset (live while upright);
/// the canvas changes an adjust value as the engine does (the preset with
/// its new value, drawn again), moves a point of another shape by hand and
/// resizes a third (amendment 1: the frame's box and its preset refitted);
/// the writer writes the first as `a:prstGeom` with its new `a:avLst`, the
/// second as `a:custGeom`, the third's new size as `wp:extent` and
/// `a:xfrm/a:ext`, and leaves every other drawing byte for byte. The saved
/// file reads back with the presets, adjust values and sizes the canvas
/// held.
#[test]
fn presets_and_adjust_values_survive_docx_to_paged_to_docx__feat__doc_shapes() {
    let bytes = shapes_docx();
    let doc = docx_import::import_docx(&bytes).expect("import");
    let ir = docx_lower::lower(&doc);
    let body = docx_skeleton::body::native_body(&ir);
    let frames = frames_by_id(&body);
    assert_eq!(body.shapes.len(), SHAPE_CASES.len(), "{:?}", body.shapes);

    // Paged: every preset is on its frame; the upright ones are live (their
    // anchors are what the engine draws), the arrow with its heads too.
    let live = |f: &paged_model::AnchoredFrame| {
        f.preset.as_ref().is_some_and(|p| {
            paged_preset_geom::model::anchors_are(p, &f.anchors, &f.subpath_starts)
        })
    };
    let frame_of = |k: usize| &frames[&body.shapes[k].0];
    for (k, (name, _)) in SHAPE_CASES.iter().enumerate() {
        let f = frame_of(k);
        match *name {
            "custGeom" => assert!(f.preset.is_none()),
            n => assert_eq!(f.preset.as_ref().map(|p| p.name.as_str()), Some(n), "{k}"),
        }
    }
    for k in [0, 1, 2, 3, 6, 7] {
        assert!(live(frame_of(k)), "{}", SHAPE_CASES[k].0);
    }
    assert!(frame_of(7).end_office_head.is_some());
    // The turned rounded rectangle: stored, not live (the lowering turns
    // its anchors).
    assert!(!live(frame_of(4)));
    assert_eq!(
        frame_of(2).preset.as_ref().unwrap().adjusts,
        vec![("adj".to_string(), "val 30000".to_string())]
    );

    // The canvas: the triangle's apex dragged to 70 % (the engine's adjust
    // write draws the preset again), the turned rounded rectangle's corner
    // made rounder, and the rectangle's first point moved by hand.
    let adjusted = |k: usize, adj: (&str, &str)| {
        let f = frame_of(k);
        let mut p = f.preset.clone().unwrap();
        p.adjusts = vec![(adj.0.to_string(), adj.1.to_string())];
        let d = paged_preset_geom::model::draw(&p).unwrap();
        let mut g = f.clone();
        g.anchors = d.anchors;
        g.subpath_starts = d.starts;
        g.subpath_open = d.open;
        g.preset = Some(p);
        g
    };
    let triangle = adjusted(2, ("adj", "val 70000"));
    let mut turned = adjusted(4, ("adj", "val 45000"));
    {
        // The lowering's turn of the frame stays on its anchors.
        let r = &doc_shapes(&doc)[4];
        let (w, h) = (
            r.width_emu as f64 / 12_700.0,
            r.height_emu as f64 / 12_700.0,
        );
        use dml_geom::place::{apply, mul, orient, translate};
        let m = mul(
            &translate(w / 2.0, h / 2.0),
            &mul(&orient(90.0, false, false), &translate(-w / 2.0, -h / 2.0)),
        );
        for a in &mut turned.anchors {
            for p in [&mut a.anchor, &mut a.left, &mut a.right] {
                let (x, y) = apply(&m, (f64::from(p.0), f64::from(p.1)));
                *p = (x as f32, y as f32);
            }
        }
    }
    // The ellipse resized to half as wide again: its box and its preset
    // drawn for the new box, as the engine's `frameBounds` write leaves them.
    let mut ellipse = frame_of(1).clone();
    let (ew, eh) = {
        let b = ellipse.bounds.expect("box");
        ((b.right - b.left) * 1.5, b.bottom - b.top)
    };
    {
        let mut p = ellipse.preset.clone().unwrap();
        p.frame = [0.0, 0.0, ew, eh];
        let d = paged_preset_geom::model::draw(&p).unwrap();
        ellipse.anchors = d.anchors;
        ellipse.subpath_starts = d.starts;
        ellipse.subpath_open = d.open;
        ellipse.preset = Some(p);
        let b = ellipse.bounds.as_mut().unwrap();
        b.right = b.left + ew;
    }
    let mut rect = frame_of(0).clone();
    rect.anchors[0].anchor.0 += 10.0;
    rect.anchors[0].left.0 += 10.0;
    rect.anchors[0].right.0 += 10.0;
    let mut read: Vec<docx_export::shapes::ShapeIn> = (0..SHAPE_CASES.len())
        .map(|k| read_back(frame_of(k), body.shapes[k].1))
        .collect();
    read[0] = read_back(&rect, body.shapes[0].1);
    read[1] = read_back(&ellipse, body.shapes[1].1);
    read[2] = read_back(&triangle, body.shapes[2].1);
    read[4] = read_back(&turned, body.shapes[4].1);

    // Docx: written into the package the import read.
    let mut pkg = paged_ooxml::OpcPackage::read(&bytes).expect("package");
    let skips = docx_export::shapes::save_shapes(&mut pkg, "word/document.xml", &doc, &ir, &read)
        .expect("save");
    assert!(skips.is_empty(), "{skips:?}");
    let saved = pkg.write().expect("write");
    // For the Word oracle (engine ADR 1096, amendment 1): the saved file.
    if let Ok(dir) = std::env::var("PAGED_DOCX_EXPORT_DIR") {
        std::fs::write(
            std::path::Path::new(&dir).join("shapes-edited.docx"),
            &saved,
        )
        .unwrap();
    }
    let xml = part_text(&saved, "word/document.xml");
    assert!(xml.contains(
        r#"<a:prstGeom prst="triangle"><a:avLst><a:gd name="adj" fmla="val 70000"/></a:avLst></a:prstGeom>"#
    ));
    assert!(xml.contains(
        r#"<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 45000"/></a:avLst></a:prstGeom>"#
    ));
    assert!(
        !xml.contains(r#"prst="rect""#),
        "the rectangle is custom now"
    );
    // The rest is the file's own XML.
    let before = part_text(&bytes, "word/document.xml");
    for keep in [
        r#"<a:prstGeom prst="ellipse"><a:avLst></a:avLst></a:prstGeom>"#,
        r#"<a:prstGeom prst="cloudCallout"><a:avLst></a:avLst></a:prstGeom>"#,
        r#"<a:path w="100" h="100">"#,
    ] {
        assert!(before.contains(keep) && xml.contains(keep), "{keep}");
    }

    // And back: the presets and adjust values the canvas held.
    let again = docx_import::import_docx(&saved).expect("re-import");
    let shapes = doc_shapes(&again);
    assert_eq!(
        shapes[2].geometry,
        ShapeGeometry::Preset {
            name: "triangle".into(),
            adjust: vec![("adj".into(), 70000)]
        }
    );
    assert_eq!(
        shapes[4].geometry,
        ShapeGeometry::Preset {
            name: "roundRect".into(),
            adjust: vec![("adj".into(), 45000)]
        }
    );
    assert_eq!(shapes[4].rotation, 5_400_000);
    assert!(matches!(shapes[0].geometry, ShapeGeometry::Custom(_)));
    // The resized ellipse: its new size, its preset unchanged.
    let emu = |v: f32| (f64::from(v) * 12_700.0).round() as i64;
    assert_eq!(
        (shapes[1].width_emu, shapes[1].height_emu),
        (emu(ew), emu(eh))
    );
    assert_eq!(
        shapes[1].geometry,
        ShapeGeometry::Preset {
            name: "ellipse".into(),
            adjust: vec![]
        }
    );
    // The custom outline is the edited one.
    let ir2 = docx_lower::lower(&again);
    let drawn = lowered_shapes(&ir2);
    let moved = drawn[0].anchors[0];
    assert!(
        (moved[0] - rect.anchors[0].anchor.0).abs() < 0.01
            && (moved[1] - rect.anchors[0].anchor.1).abs() < 0.01,
        "{moved:?}"
    );
    // The adjusted triangle is live again on the next open.
    let body2 = docx_skeleton::body::native_body(&ir2);
    let frames2 = frames_by_id(&body2);
    assert!(live(&frames2[&body2.shapes[2].0]));

    // An unedited canvas writes nothing.
    let mut pkg = paged_ooxml::OpcPackage::read(&bytes).expect("package");
    let unchanged: Vec<_> = (0..SHAPE_CASES.len())
        .map(|k| read_back(frame_of(k), body.shapes[k].1))
        .collect();
    let skips =
        docx_export::shapes::save_shapes(&mut pkg, "word/document.xml", &doc, &ir, &unchanged)
            .expect("save");
    assert!(skips.is_empty(), "{skips:?}");
    assert_eq!(
        part_text(&pkg.write().unwrap(), "word/document.xml"),
        part_text(&bytes, "word/document.xml")
    );
}

fn doc_shapes(doc: &DocxDocument) -> Vec<Shape> {
    shapes(doc).into_iter().cloned().collect()
}
