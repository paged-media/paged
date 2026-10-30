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

//! Engine ADR 10XX — live shapes through the canvas model: a polygon's
//! sides and star inset and an oval's pie angles read, write, redraw and
//! undo exactly; a point edit ends a live polygon; an IDML export keeps
//! the outline and the parameters (in a label) and its re-import lifts
//! them back; a `.paged` keeps them.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_mutate::operation::PathAnchorSpec;
use paged_mutate::Value;
use paged_wire::{ElementId, VirtualTarget};

fn contour(pts: &[(f32, f32)], open: bool) -> String {
    let points: String = pts
        .iter()
        .map(|(x, y)| {
            format!(
                r#"<PathPointType Anchor="{x} {y}" LeftDirection="{x} {y}" RightDirection="{x} {y}"/>"#
            )
        })
        .collect();
    format!(
        r#"<GeometryPathType PathOpen="{open}"><PathPointArray>{points}</PathPointArray></GeometryPathType>"#
    )
}

/// A closed quadrilateral `quad` (not a regular polygon), an open pen
/// path `pen`, and an oval `ov`, all filled black.
fn build_idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let quad = contour(
        &[(20.0, 20.0), (120.0, 30.0), (110.0, 120.0), (30.0, 100.0)],
        false,
    );
    let pen = contour(&[(150.0, 20.0), (200.0, 60.0), (250.0, 20.0)], true);
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 400 400"/>
    <Polygon Self="quad" FillColor="Color/Black" StrokeWeight="0">
      <Properties><PathGeometry>{quad}</PathGeometry></Properties>
    </Polygon>
    <Polygon Self="pen" StrokeColor="Color/Black" StrokeWeight="1">
      <Properties><PathGeometry>{pen}</PathGeometry></Properties>
    </Polygon>
    <Oval Self="ov" GeometricBounds="200 100 300 300" FillColor="Color/Black" StrokeWeight="0"/>
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
    CanvasModel::load("live-shapes", &build_idml(), CanvasOptions::default()).expect("load")
}

fn poly(id: &str) -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::Polygon(id.into()),
    }
}

fn oval(id: &str) -> VirtualTarget {
    VirtualTarget::Element {
        element_id: ElementId::Oval(id.into()),
    }
}

fn set(m: &mut CanvasModel, t: VirtualTarget, path: &str, v: Option<f32>) -> Result<(), String> {
    m.apply_mutation(&Mutation::Set {
        address: t.into(),
        path: path.to_string(),
        value: Value::Length(v),
    })
    .map(|_| ())
    .map_err(|e| format!("{e:?}"))
}

fn len(m: &CanvasModel, t: &VirtualTarget, path: &str) -> Option<f32> {
    match m.get_property(t, path) {
        Ok(Value::Length(v)) => v,
        other => panic!("{path}: {other:?}"),
    }
}

fn polygon<'a>(doc: &'a paged_scene::Document, id: &str) -> &'a paged_model::Polygon {
    doc.spreads[0]
        .spread
        .polygons
        .iter()
        .find(|p| p.self_id.as_deref() == Some(id))
        .expect("polygon")
}

fn the_oval<'a>(doc: &'a paged_scene::Document, id: &str) -> &'a paged_model::Oval {
    doc.spreads[0]
        .spread
        .ovals
        .iter()
        .find(|p| p.self_id.as_deref() == Some(id))
        .expect("oval")
}

fn anchors(m: &CanvasModel, id: &str) -> Vec<(f32, f32)> {
    polygon(m.scene(), id)
        .anchors
        .iter()
        .map(|a| a.anchor)
        .collect()
}

fn digest(m: &CanvasModel) -> u64 {
    let page = PageId(m.pages()[0].self_id.clone());
    m.display_list_for_page(&page)
        .expect("display list")
        .digest()
}

#[test]
#[allow(non_snake_case)]
fn sides_and_inset_redraw_the_polygon_and_undo_exactly__feat__plugin_draw_live_shapes() {
    let mut m = load();
    let q = poly("quad");
    let original = anchors(&m, "quad");
    let original_bounds = polygon(m.scene(), "quad").bounds;
    // A plain path is no live polygon: its sides read `None` and it has
    // no inset row.
    assert_eq!(len(&m, &q, "frameShapeSides"), None);
    assert_eq!(len(&m, &q, "frameShapeStarInset"), None);
    let before = digest(&m);

    set(&mut m, q.clone(), "frameShapeSides", Some(6.0)).expect("sides");
    assert_eq!(len(&m, &q, "frameShapeSides"), Some(6.0));
    assert_eq!(len(&m, &q, "frameShapeStarInset"), Some(0.0));
    let hexagon = anchors(&m, "quad");
    assert_eq!(hexagon.len(), 6);
    // Fitted to the path's own box: the quad's points span x 20..120 and
    // y 20..120.
    let xs = hexagon.iter().map(|p| p.0);
    let ys = hexagon.iter().map(|p| p.1);
    assert!((xs.clone().fold(f32::MAX, f32::min) - 20.0).abs() < 1e-3);
    assert!((xs.fold(f32::MIN, f32::max) - 120.0).abs() < 1e-3);
    assert!((ys.clone().fold(f32::MAX, f32::min) - 20.0).abs() < 1e-3);
    assert!((ys.fold(f32::MIN, f32::max) - 120.0).abs() < 1e-3);
    assert_ne!(digest(&m), before, "the hexagon is drawn");

    set(&mut m, q.clone(), "frameShapeStarInset", Some(40.0)).expect("inset");
    assert_eq!(anchors(&m, "quad").len(), 12);
    assert_eq!(len(&m, &q, "frameShapeStarInset"), Some(40.0));
    // A star keeps its inset when its points change.
    set(&mut m, q.clone(), "frameShapeSides", Some(5.0)).expect("points");
    assert_eq!(anchors(&m, "quad").len(), 10);
    // The frame box follows the path.
    let star = anchors(&m, "quad");
    let bottom = star.iter().map(|p| p.1).fold(f32::MIN, f32::max);
    assert!((polygon(m.scene(), "quad").bounds.bottom - bottom).abs() < 1e-3);
    assert_eq!(len(&m, &q, "frameShapeStarInset"), Some(40.0));

    m.undo().expect("undo points");
    assert_eq!(len(&m, &q, "frameShapeSides"), Some(6.0));
    assert_eq!(anchors(&m, "quad").len(), 12);
    m.undo().expect("undo inset");
    assert_eq!(
        anchors(&m, "quad"),
        hexagon,
        "the hexagon comes back exactly"
    );
    m.undo().expect("undo sides");
    assert_eq!(anchors(&m, "quad"), original, "the quad comes back exactly");
    assert_eq!(polygon(m.scene(), "quad").bounds.top, original_bounds.top);
    assert_eq!(len(&m, &q, "frameShapeSides"), None);
    assert!(polygon(m.scene(), "quad").live_shape.is_none());
    assert_eq!(digest(&m), before);
    // And redo replays it.
    m.redo().expect("redo");
    assert_eq!(anchors(&m, "quad"), hexagon);
}

#[test]
#[allow(non_snake_case)]
fn a_point_edit_ends_the_live_polygon__feat__plugin_draw_live_shapes() {
    let mut m = load();
    let q = poly("quad");
    set(&mut m, q.clone(), "frameShapeSides", Some(5.0)).expect("sides");
    let mut moved: Vec<PathAnchorSpec> = polygon(m.scene(), "quad")
        .anchors
        .iter()
        .map(PathAnchorSpec::from_parse)
        .collect();
    moved[1].anchor[1] += 7.0;
    moved[1].left = moved[1].anchor;
    moved[1].right = moved[1].anchor;
    m.apply_mutation(&Mutation::Set {
        address: q.clone().into(),
        path: "framePath".into(),
        value: Value::FramePath {
            anchors: moved,
            subpath_starts: vec![0],
        },
    })
    .expect("point edit");
    assert_eq!(len(&m, &q, "frameShapeSides"), None, "no longer live");
    // An inset needs a live polygon.
    assert!(set(&mut m, q.clone(), "frameShapeStarInset", Some(20.0)).is_err());
    // Sides make it live again.
    set(&mut m, q.clone(), "frameShapeSides", Some(5.0)).expect("sides again");
    assert_eq!(len(&m, &q, "frameShapeSides"), Some(5.0));
    // `None` ends it and keeps the path.
    let path = anchors(&m, "quad");
    set(&mut m, q.clone(), "frameShapeSides", None).expect("expand");
    assert_eq!(len(&m, &q, "frameShapeSides"), None);
    assert_eq!(anchors(&m, "quad"), path);
}

#[test]
#[allow(non_snake_case)]
fn bad_values_and_open_paths_are_refused__feat__plugin_draw_live_shapes() {
    let mut m = load();
    let q = poly("quad");
    for bad in [2.0, 101.0, 4.5, f32::NAN] {
        assert!(
            set(&mut m, q.clone(), "frameShapeSides", Some(bad)).is_err(),
            "{bad}"
        );
    }
    set(&mut m, q.clone(), "frameShapeSides", Some(4.0)).expect("sides");
    for bad in [-1.0, 100.0] {
        assert!(set(&mut m, q.clone(), "frameShapeStarInset", Some(bad)).is_err());
    }
    // An open pen path is no polygon.
    assert!(set(&mut m, poly("pen"), "frameShapeSides", Some(5.0)).is_err());
}

#[test]
#[allow(non_snake_case)]
fn pie_angles_cut_the_oval_and_undo__feat__plugin_draw_live_shapes() {
    let mut m = load();
    let o = oval("ov");
    assert_eq!(len(&m, &o, "frameShapePieStart"), Some(0.0));
    assert_eq!(len(&m, &o, "frameShapePieEnd"), Some(360.0));
    let whole = digest(&m);
    set(&mut m, o.clone(), "frameShapePieEnd", Some(90.0)).expect("end");
    assert_eq!(len(&m, &o, "frameShapePieEnd"), Some(90.0));
    let quarter = digest(&m);
    assert_ne!(quarter, whole, "the quarter is drawn");
    set(&mut m, o.clone(), "frameShapePieStart", Some(-90.0)).expect("start");
    assert_eq!(len(&m, &o, "frameShapePieStart"), Some(270.0));
    assert_eq!(
        the_oval(m.scene(), "ov").bounds.right,
        300.0,
        "the bounds stay the ellipse"
    );
    m.undo().expect("undo start");
    assert_eq!(digest(&m), quarter);
    m.undo().expect("undo end");
    assert_eq!(digest(&m), whole);
    assert!(the_oval(m.scene(), "ov").pie.is_none());
    // Two angles in one direction draw the ellipse, and both are kept:
    // the end moved onto the start and on again keeps the start.
    set(&mut m, o.clone(), "frameShapePieStart", Some(45.0)).expect("start");
    set(&mut m, o.clone(), "frameShapePieEnd", Some(45.0)).expect("end");
    assert_eq!(digest(&m), whole, "a zero sweep is the whole ellipse");
    assert_eq!(len(&m, &o, "frameShapePieStart"), Some(45.0));
    // Invert pie's two writes: the start onto the end first.
    set(&mut m, o.clone(), "frameShapePieEnd", Some(200.0)).expect("end");
    set(&mut m, o.clone(), "frameShapePieStart", Some(200.0)).expect("start");
    set(&mut m, o.clone(), "frameShapePieEnd", Some(45.0)).expect("end");
    assert_eq!(len(&m, &o, "frameShapePieStart"), Some(200.0));
    assert_eq!(len(&m, &o, "frameShapePieEnd"), Some(45.0));
    assert_ne!(digest(&m), whole);
    // Back to the default pair: no pie at all.
    set(&mut m, o.clone(), "frameShapePieStart", Some(0.0)).expect("start");
    set(&mut m, o.clone(), "frameShapePieEnd", Some(360.0)).expect("end");
    assert!(the_oval(m.scene(), "ov").pie.is_none());
}

#[test]
#[allow(non_snake_case)]
fn the_idml_export_keeps_the_outline_and_the_label_lifts_the_parameters__feat__plugin_draw_live_shapes(
) {
    let mut m = load();
    let clean = m.idml_export_losses();
    set(&mut m, poly("quad"), "frameShapeSides", Some(7.0)).expect("sides");
    set(&mut m, poly("quad"), "frameShapeStarInset", Some(30.0)).expect("inset");
    set(&mut m, oval("ov"), "frameShapePieStart", Some(30.0)).expect("start");
    set(&mut m, oval("ov"), "frameShapePieEnd", Some(300.0)).expect("end");

    let losses: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| !clean.contains(l))
        .collect();
    assert_eq!(losses.len(), 1, "only the pie is named: {losses:?}");
    assert!(
        losses[0].contains("`ov`") && losses[0].contains("pie"),
        "{}",
        losses[0]
    );

    let bytes = m.export_idml().expect("export");
    // The written spread: the oval's path is its wedge, and both items
    // carry the label.
    let spread = {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut s = String::new();
        std::io::Read::read_to_string(&mut z.by_name("Spreads/Spread_sp1.xml").unwrap(), &mut s)
            .unwrap();
        s
    };
    assert_eq!(spread.matches("paged:liveShape").count(), 2, "{spread}");

    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    let p = polygon(&twin, "quad");
    assert_eq!(
        p.live_shape,
        Some(paged_model::live_shape::PolygonShape::new(7, 30.0))
    );
    assert_eq!(p.anchors.len(), 14);
    let o = the_oval(&twin, "ov");
    assert_eq!(o.pie, paged_model::live_shape::PieAngles::new(30.0, 300.0));
    let b = o.bounds;
    for (got, want) in [
        (b.top, 200.0),
        (b.left, 100.0),
        (b.bottom, 300.0),
        (b.right, 300.0),
    ] {
        assert!((got - want).abs() < 1e-2, "{b:?}");
    }
    assert!(
        twin.spreads[0].spread.labels.is_empty(),
        "the labels are lifted into the model"
    );
}

#[test]
#[allow(non_snake_case)]
fn a_paged_file_keeps_the_live_shapes__feat__plugin_draw_live_shapes() {
    let mut m = load();
    set(&mut m, poly("quad"), "frameShapeSides", Some(8.0)).expect("sides");
    set(&mut m, oval("ov"), "frameShapePieEnd", Some(180.0)).expect("end");
    m.refresh_model_part().expect("refresh model part");
    let bytes = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export .paged");
    let reloaded = CanvasModel::load("live-shapes-reloaded", &bytes, CanvasOptions::default())
        .expect("reload");
    assert_eq!(len(&reloaded, &poly("quad"), "frameShapeSides"), Some(8.0));
    assert_eq!(len(&reloaded, &oval("ov"), "frameShapePieEnd"), Some(180.0));
}

#[test]
#[allow(non_snake_case)]
fn an_inserted_pie_is_written_as_its_wedge_and_read_back_whole__feat__plugin_draw_live_shapes() {
    let mut m = load();
    let out = m
        .apply_mutation(&Mutation::InsertOval {
            page_id: PageId("p1".into()),
            bounds: (50.0, 250.0, 150.0, 390.0),
        })
        .expect("insert oval");
    let id = match out.created_id {
        Some(ElementId::Oval(id)) => id,
        other => panic!("{other:?}"),
    };
    set(&mut m, oval(&id), "frameShapePieStart", Some(0.0)).expect("start");
    set(&mut m, oval(&id), "frameShapePieEnd", Some(90.0)).expect("end");
    let ellipse = the_oval(m.scene(), &id).bounds;
    let bytes = m.export_idml().expect("export");
    let twin = idml_import::import_idml_doc(&bytes).expect("re-import");
    let o = twin.spreads[0]
        .spread
        .ovals
        .iter()
        .find(|o| o.pie.is_some())
        .expect("the pie oval comes back a pie");
    assert_eq!(o.pie, paged_model::live_shape::PieAngles::new(0.0, 90.0));
    let b = o.bounds;
    for (got, want) in [
        (b.top, ellipse.top),
        (b.left, ellipse.left),
        (b.bottom, ellipse.bottom),
        (b.right, ellipse.right),
    ] {
        assert!((got - want).abs() < 1e-2, "{b:?} vs {ellipse:?}");
    }
    // InDesign sees the wedge: the `<Oval>`'s path is the centre and a
    // quarter arc (three points), not the four-point ellipse.
    let spread = {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut s = String::new();
        std::io::Read::read_to_string(&mut z.by_name("Spreads/Spread_sp1.xml").unwrap(), &mut s)
            .unwrap();
        s
    };
    let at = spread.rfind("<Oval ").expect("the inserted oval");
    let element = &spread[at..at + spread[at..].find("</Oval>").unwrap()];
    assert_eq!(element.matches("<PathPointType").count(), 3, "{element}");
}

/// The polygon tool's flow: it inserts the plain polygon inscribed in its
/// drag box, then sets the sides and the inset. The star the engine
/// draws is the one the tool previewed: its outer points on the drag
/// box's ellipse.
#[test]
#[allow(non_snake_case)]
fn the_polygon_tools_insert_becomes_a_live_star_in_its_drag_ellipse__feat__plugin_draw_live_shapes()
{
    use paged_model::live_shape::{polygon_anchors_in, PolygonShape};
    let mut m = load();
    let drag = paged_model::Bounds {
        top: 200.0,
        left: 20.0,
        bottom: 300.0,
        right: 160.0,
    };
    let pentagon = polygon_anchors_in(drag, PolygonShape::new(5, 0.0));
    let out = m
        .apply_mutation(&Mutation::InsertPath {
            page_id: PageId("p1".into()),
            anchors: pentagon.iter().map(PathAnchorSpec::from_parse).collect(),
            open: false,
            smooth: false,
        })
        .expect("insert path");
    let id = match out.created_id {
        Some(ElementId::Polygon(id)) => id,
        other => panic!("{other:?}"),
    };
    set(&mut m, poly(&id), "frameShapeSides", Some(5.0)).expect("sides");
    set(&mut m, poly(&id), "frameShapeStarInset", Some(50.0)).expect("inset");
    // Page-local `drag` sits at the same spread coordinates here (one
    // page at the origin).
    let want = polygon_anchors_in(drag, PolygonShape::new(5, 50.0));
    let got = anchors(&m, &id);
    assert_eq!(got.len(), want.len());
    for (g, w) in got.iter().zip(&want) {
        assert!(
            (g.0 - w.anchor.0).abs() < 1e-3 && (g.1 - w.anchor.1).abs() < 1e-3,
            "{got:?}"
        );
    }
    assert_eq!(len(&m, &poly(&id), "frameShapeStarInset"), Some(50.0));
}
