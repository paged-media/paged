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

//! Engine ADR 1006 — `frameFillRule` through the canvas model: it reads,
//! writes, redraws and undoes; a `.paged` keeps it; the IDML export
//! re-winds an even-odd outline whose contours do not cross and reports
//! the one whose contours do.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_compose::DisplayCommand;
use paged_mutate::Value;
use paged_wire::{ElementId, VirtualTarget};

/// One clockwise square contour (y down).
fn square(x: f32, y: f32, s: f32) -> String {
    let pts = [(x, y), (x + s, y), (x + s, y + s), (x, y + s)];
    contour(&pts)
}

fn contour(pts: &[(f32, f32)]) -> String {
    let points: String = pts
        .iter()
        .map(|(x, y)| {
            format!(
                r#"<PathPointType Anchor="{x} {y}" LeftDirection="{x} {y}" RightDirection="{x} {y}"/>"#
            )
        })
        .collect();
    format!(
        r#"<GeometryPathType PathOpen="false"><PathPointArray>{points}</PathPointArray></GeometryPathType>"#
    )
}

/// A donut whose hole turns the same way as its ring (two contours that
/// do not cross) and a five-pointed star drawn as one self-crossing
/// contour, both filled black.
fn build_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let star: Vec<(f32, f32)> = (0..5)
        .map(|k| {
            let a = std::f32::consts::PI * (-0.5 + 0.8 * k as f32);
            (220.0 + 50.0 * a.cos(), 70.0 + 50.0 * a.sin())
        })
        .collect();
    let polygon = |id: &str, bounds: &str, contours: String| {
        format!(
            r#"<Polygon Self="{id}" GeometricBounds="{bounds}" FillColor="Color/Black" StrokeWeight="0">
      <Properties><PathGeometry>{contours}</PathGeometry></Properties>
    </Polygon>"#
        )
    };
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 300 300"/>
    {}
    {}
  </Spread>
</idPkg:Spread>"#,
        polygon(
            "donut",
            "20 20 120 120",
            square(20.0, 20.0, 100.0) + &square(50.0, 50.0, 40.0)
        ),
        polygon("star", "20 170 120 270", contour(&star)),
    );
    let buf = std::io::Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn target(id: &str) -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::Polygon(id.into()),
    }
}

fn set(m: &mut CanvasModel, id: &str, rule: &str) {
    m.apply_mutation(&Mutation::Set {
        address: target(id).into(),
        path: "frameFillRule".to_string(),
        value: Value::Text(rule.into()),
    })
    .expect("frameFillRule");
}

/// How many of the first page's fills draw by the even-odd rule.
fn even_odd_fills(m: &CanvasModel) -> usize {
    let page = PageId(m.pages()[0].self_id.clone());
    let list = m.display_list_for_page(&page).expect("display list");
    list.commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::FillPath { path_id, .. } => list.paths.get(*path_id),
            _ => None,
        })
        .filter(|p| p.fill_rule == paged_compose::FillRule::EvenOdd)
        .count()
}

/// Twice the signed area of each contour of polygon `id` in `doc`.
fn turns(doc: &paged_scene::Document, id: &str) -> Vec<f32> {
    let p = doc.spreads[0]
        .spread
        .polygons
        .iter()
        .find(|p| p.self_id.as_deref() == Some(id))
        .expect("polygon");
    let mut starts = p.subpath_starts.clone();
    if starts.is_empty() {
        starts.push(0);
    }
    starts
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let e = starts.get(i + 1).copied().unwrap_or(p.anchors.len());
            let pts: Vec<(f32, f32)> = p.anchors[s..e].iter().map(|a| a.anchor).collect();
            paged_model::winding::signed_area(&pts)
        })
        .collect()
}

fn load() -> CanvasModel {
    CanvasModel::load("fill-rule", &build_idml(), CanvasOptions::default()).expect("load")
}

#[test]
#[allow(non_snake_case)]
fn the_fill_rule_is_set_drawn_and_undone__feat__frames_paths_fill_rule_even_odd() {
    let mut m = load();
    assert_eq!(
        m.get_property(&target("donut"), "frameFillRule"),
        Ok(Value::Text("NonZero".into()))
    );
    assert_eq!(even_odd_fills(&m), 0);
    set(&mut m, "donut", "EvenOdd");
    set(&mut m, "star", "EvenOdd");
    assert_eq!(
        m.get_property(&target("star"), "frameFillRule"),
        Ok(Value::Text("EvenOdd".into()))
    );
    assert_eq!(even_odd_fills(&m), 2, "both outlines fill even-odd");
    m.undo().expect("undo");
    m.undo().expect("undo");
    assert_eq!(
        m.get_property(&target("donut"), "frameFillRule"),
        Ok(Value::Text("NonZero".into()))
    );
    assert_eq!(even_odd_fills(&m), 0);
}

#[test]
#[allow(non_snake_case)]
fn the_idml_export_rewinds_or_reports__feat__frames_paths_fill_rule_even_odd() {
    let mut m = load();
    let clean = m.idml_export_losses();
    set(&mut m, "donut", "EvenOdd");
    // A donut re-winds: no loss.
    assert_eq!(m.idml_export_losses(), clean);
    set(&mut m, "star", "EvenOdd");
    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "{losses:?}");
    assert!(losses[0].contains("`star`"), "{}", losses[0]);
    assert!(losses[0].contains("even-odd"), "{}", losses[0]);
    assert!(losses[0].contains(".paged"), "{}", losses[0]);

    // The written IDML: the donut's hole now turns against its ring, so
    // IDML's non-zero fill leaves it empty; the star keeps its anchors.
    let before = turns(m.scene(), "donut");
    assert!(before[0] > 0.0 && before[1] > 0.0, "{before:?}");
    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    let after = turns(&twin, "donut");
    assert!(after[0] > 0.0 && after[1] < 0.0, "re-wound: {after:?}");
    assert_eq!(turns(&twin, "star"), turns(m.scene(), "star"));
    let p = &twin.spreads[0].spread.polygons[0];
    assert_eq!(
        p.fill_rule,
        paged_model::FillRule::NonZero,
        "IDML has no rule"
    );
}

#[test]
#[allow(non_snake_case)]
fn the_fill_rule_survives_paged__feat__frames_paths_fill_rule_even_odd() {
    let mut m = load();
    set(&mut m, "star", "EvenOdd");
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded =
        CanvasModel::load("fill-rule-reloaded", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(
        reloaded.get_property(&target("star"), "frameFillRule"),
        Ok(Value::Text("EvenOdd".into()))
    );
    assert_eq!(
        reloaded.get_property(&target("donut"), "frameFillRule"),
        Ok(Value::Text("NonZero".into()))
    );
}
