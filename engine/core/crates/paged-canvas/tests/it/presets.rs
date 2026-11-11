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

//! Engine ADR 1096 — a preset is an engine live shape: set, read with its
//! handles, refitted by a resize (a rounded corner keeps its radius),
//! adjusted by a value or a handle drag, ended by a point edit, its
//! companions and glued connectors following, every write undone exactly;
//! an IDML export keeps it in a label and a `.paged` keeps it.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions};
use paged_model::live_shape::{PresetConnector, PresetGlue, PresetShape};
use paged_mutate::operation::{PathPointAddress, PathPointRole};
use paged_mutate::Value;
use paged_wire::{ElementId, VirtualTarget};

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

/// Two boxes `a` and `b` and a third path `c` that becomes a connector.
fn build_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let a = contour(&[(20.0, 20.0), (120.0, 20.0), (120.0, 80.0), (20.0, 80.0)]);
    let b = contour(&[
        (220.0, 120.0),
        (320.0, 120.0),
        (320.0, 180.0),
        (220.0, 180.0),
    ]);
    let c = contour(&[(120.0, 50.0), (220.0, 150.0)]);
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 400 400"/>
    <Polygon Self="a" FillColor="Color/Black" StrokeWeight="0">
      <Properties><PathGeometry>{a}</PathGeometry></Properties>
    </Polygon>
    <Polygon Self="b" FillColor="Color/Black" StrokeWeight="0">
      <Properties><PathGeometry>{b}</PathGeometry></Properties>
    </Polygon>
    <Polygon Self="c" StrokeColor="Color/Black" StrokeWeight="1">
      <Properties><PathGeometry>{c}</PathGeometry></Properties>
    </Polygon>
  </Spread>
</idPkg:Spread>"#
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

fn load() -> CanvasModel {
    CanvasModel::load("presets", &build_idml(), CanvasOptions::default()).expect("load")
}

fn poly(id: &str) -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::Polygon(id.into()),
    }
}

fn set(m: &mut CanvasModel, id: &str, path: &str, value: Value) -> Result<(), String> {
    m.apply_mutation(&Mutation::Set {
        address: poly(id).into(),
        path: path.to_string(),
        value,
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

fn text(m: &CanvasModel, id: &str, path: &str) -> String {
    match m.get_property(&poly(id), path) {
        Ok(Value::Text(t)) => t,
        other => panic!("{path}: {other:?}"),
    }
}

fn polygon<'a>(m: &'a CanvasModel, id: &str) -> &'a paged_model::Polygon {
    m.scene().spreads[0]
        .spread
        .polygons
        .iter()
        .find(|p| p.self_id.as_deref() == Some(id))
        .expect("polygon")
}

/// Everything a preset write may touch on a polygon.
fn state(m: &CanvasModel, id: &str) -> String {
    let p = polygon(m, id);
    format!(
        "{:?} {:?} {:?} {:?} {:?} {:?}",
        p.preset, p.anchors, p.subpath_starts, p.subpath_open, p.bounds, p.item_transform
    )
}

fn round_rect(frame: [f32; 4]) -> PresetShape {
    PresetShape {
        frame,
        ..PresetShape::new("roundRect", 0.0, 0.0)
    }
}

fn set_preset(m: &mut CanvasModel, id: &str, p: &PresetShape) {
    set(
        m,
        id,
        "frameShapePreset",
        Value::Text(serde_json::to_string(p).unwrap()),
    )
    .expect("preset");
}

/// The smallest x of an anchor right of the box's left edge: a rounded
/// rectangle's corner radius plus the edge.
fn first_corner_x(m: &CanvasModel, id: &str, left: f32) -> f32 {
    polygon(m, id)
        .anchors
        .iter()
        .map(|a| a.anchor.0)
        .filter(|&x| x > left + 1e-3)
        .fold(f32::MAX, f32::min)
}

#[test]
fn a_preset_is_set_read_and_undone_exactly() {
    let mut m = load();
    let before = state(&m, "a");
    assert_eq!(text(&m, "a", "frameShapePreset"), "");
    set_preset(&mut m, "a", &round_rect([20.0, 20.0, 100.0, 60.0]));
    let read: serde_json::Value = serde_json::from_str(&text(&m, "a", "frameShapePreset")).unwrap();
    assert_eq!(read["name"], "roundRect");
    // roundRect has one handle: on the top edge, a radius in from the left.
    let h = &read["handles"][0];
    assert!((h["x"].as_f64().unwrap() - 30.0).abs() < 1e-3, "{h}");
    assert!((h["y"].as_f64().unwrap() - 20.0).abs() < 1e-3, "{h}");
    assert_eq!(
        text(&m, "a", "frameShapePresetAdjust"),
        r#"[["adj","val 16667"]]"#
    );
    // A radius of a sixth of the short side.
    assert!((first_corner_x(&m, "a", 20.0) - 30.0).abs() < 1e-2);
    m.undo().expect("undo");
    assert_eq!(state(&m, "a"), before);
}

#[test]
fn a_resize_refits_the_preset_and_undo_restores_it() {
    let mut m = load();
    set_preset(&mut m, "a", &round_rect([20.0, 20.0, 100.0, 60.0]));
    let set_state = state(&m, "a");
    // Scale twice as wide by the transform, as the editor's scale gesture
    // does: the scale moves into the box and the corner keeps its radius.
    set(
        &mut m,
        "a",
        "frameTransform",
        Value::Transform(Some([2.0, 0.0, 0.0, 1.0, -20.0, 0.0])),
    )
    .expect("scale");
    let p = polygon(&m, "a");
    let preset = p.preset.as_ref().unwrap();
    assert!((preset.frame[2] - 200.0).abs() < 1e-3, "{preset:?}");
    assert_eq!(p.item_transform.map(|t| [t[0], t[3]]), Some([1.0, 1.0]));
    assert!((first_corner_x(&m, "a", 20.0) - 30.0).abs() < 1e-2);
    assert_ne!(text(&m, "a", "frameShapePreset"), "", "still live");
    m.undo().expect("undo");
    assert_eq!(state(&m, "a"), set_state);
}

#[test]
fn adjust_values_and_handle_drags_redraw_and_undo() {
    let mut m = load();
    set_preset(&mut m, "a", &round_rect([20.0, 20.0, 100.0, 60.0]));
    let set_state = state(&m, "a");
    set(
        &mut m,
        "a",
        "frameShapePresetAdjust",
        Value::Text(r#"[["adj","val 5000"]]"#.into()),
    )
    .expect("adjust");
    assert!((first_corner_x(&m, "a", 20.0) - 23.0).abs() < 1e-2);
    m.undo().expect("undo adjust");
    assert_eq!(state(&m, "a"), set_state);
    // Drag the handle 10 pt in from the left: a 10 pt radius.
    set(
        &mut m,
        "a",
        "frameShapePresetHandle",
        Value::PathPoint {
            address: PathPointAddress {
                index: 0,
                role: PathPointRole::Anchor,
            },
            position: [30.0, 20.0],
        },
    )
    .expect("drag");
    assert!((first_corner_x(&m, "a", 20.0) - 30.0).abs() < 0.05);
    set(
        &mut m,
        "a",
        "frameShapePresetHandle",
        Value::PathPoint {
            address: PathPointAddress {
                index: 0,
                role: PathPointRole::Anchor,
            },
            position: [25.0, 20.0],
        },
    )
    .expect("drag");
    assert!((first_corner_x(&m, "a", 20.0) - 25.0).abs() < 0.05);
    m.undo().expect("undo drag");
    m.undo().expect("undo drag");
    assert_eq!(state(&m, "a"), set_state);
}

#[test]
fn a_point_edit_ends_the_preset_and_expand_keeps_the_path() {
    let mut m = load();
    set_preset(&mut m, "a", &round_rect([20.0, 20.0, 100.0, 60.0]));
    let mut anchors: Vec<paged_mutate::operation::PathAnchorSpec> = polygon(&m, "a")
        .anchors
        .iter()
        .map(paged_mutate::operation::PathAnchorSpec::from_parse)
        .collect();
    let path = anchors.clone();
    anchors[1].anchor[1] += 9.0;
    set(
        &mut m,
        "a",
        "framePath",
        Value::FramePath {
            anchors,
            subpath_starts: vec![0],
        },
    )
    .expect("edit");
    assert_eq!(text(&m, "a", "frameShapePreset"), "", "no longer live");
    assert!(polygon(&m, "a").preset.is_some(), "kept, stale");
    m.undo().expect("undo edit");
    set(&mut m, "a", "frameShapePreset", Value::Text(String::new())).expect("expand");
    assert!(polygon(&m, "a").preset.is_none());
    let kept: Vec<_> = polygon(&m, "a")
        .anchors
        .iter()
        .map(paged_mutate::operation::PathAnchorSpec::from_parse)
        .collect();
    assert_eq!(kept, path);
}

#[test]
fn a_glued_connector_is_routed_again_when_its_shape_moves() {
    let mut m = load();
    set_preset(
        &mut m,
        "a",
        &PresetShape::new("rect", 0.0, 0.0).with_frame([20.0, 20.0, 100.0, 60.0]),
    );
    set_preset(
        &mut m,
        "b",
        &PresetShape::new("rect", 0.0, 0.0).with_frame([220.0, 120.0, 100.0, 60.0]),
    );
    // Annex D's rect sites: top, left, bottom, right (0..3).
    let connector = PresetShape {
        connector: Some(PresetConnector {
            start: Some(PresetGlue {
                item: "a".into(),
                site: 3,
            }),
            end: Some(PresetGlue {
                item: "b".into(),
                site: 1,
            }),
        }),
        ..PresetShape::new("bentConnector3", 0.0, 0.0).with_frame([0.0, 0.0, 100.0, 100.0])
    };
    set_preset(&mut m, "c", &connector);
    let c_before = state(&m, "c");
    // Move `b` down by 40.
    set(
        &mut m,
        "b",
        "frameTransform",
        Value::Transform(Some([1.0, 0.0, 0.0, 1.0, 0.0, 40.0])),
    )
    .expect("move");
    let c = polygon(&m, "c");
    let t = c.item_transform.unwrap();
    let last = c.anchors.last().unwrap().anchor;
    let end = (
        t[0] * last.0 + t[2] * last.1 + t[4],
        t[1] * last.0 + t[3] * last.1 + t[5],
    );
    assert!(
        (end.0 - 220.0).abs() < 1e-3 && (end.1 - 190.0).abs() < 1e-3,
        "{end:?}"
    );
    m.undo().expect("undo move");
    assert_eq!(state(&m, "c"), c_before);
}

#[test]
fn idml_and_paged_keep_the_preset() {
    let mut m = load();
    let p = round_rect([20.0, 20.0, 100.0, 60.0]);
    set_preset(&mut m, "a", &p);
    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    let a = twin.spreads[0]
        .spread
        .polygons
        .iter()
        .find(|q| q.self_id.as_deref() == Some("a"))
        .unwrap();
    assert_eq!(a.preset.as_ref(), Some(&p));
    assert!(twin.spreads[0].spread.labels.is_empty());

    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded =
        CanvasModel::load("presets-reloaded", &bytes, CanvasOptions::default()).expect("reload");
    assert_eq!(polygon(&reloaded, "a").preset.as_ref(), Some(&p));
}
