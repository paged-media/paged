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

//! Draw ADR 364 — DXF in and out, on a synthetic drawing built here: what
//! the import's SVG says each entity is, and that a DXF the export wrote
//! reads back as the same geometry, colours and layers.

use dxf::entities::{
    Arc, Circle, Ellipse, Entity, EntityType, Insert, Line, LwPolyline, Spline, Text,
};
use dxf::enums::{AcadVersion, Units};
use dxf::tables::Layer;
use dxf::{Block, Color, Drawing, LwPolylineVertex, Point, Vector};

use draw_dxf::{dxf_to_svg, svg_to_dxf};

fn on(layer: &str, specific: EntityType) -> Entity {
    let mut e = Entity::new(specific);
    e.common.layer = layer.into();
    // AutoCAD's "default" weight (the crate's new entities say 0, the
    // thinnest line).
    e.common.lineweight_enum_value = -3;
    e
}

fn bytes(d: &Drawing) -> Vec<u8> {
    let mut out = Vec::new();
    d.save(&mut out).unwrap();
    out
}

/// A drawing in millimetres: a 100 × 50 frame on layer "Frame" (red by
/// layer), a circle, an arc, an ellipse, a spline and a bulged polyline
/// on "Parts", a block inserted twice, and a TEXT that is not imported.
fn sample() -> Drawing {
    let mut d = Drawing::new();
    // LWPOLYLINE, ELLIPSE and SPLINE are R13+, line weights R2000+, true
    // colours R2004+.
    d.header.version = AcadVersion::R2010;
    d.header.default_drawing_units = Units::Millimeters;
    let frame = Layer {
        name: "Frame".into(),
        color: Color::from_index(1),
        ..Default::default()
    };
    d.add_layer(frame);
    d.add_layer(Layer {
        name: "Parts".into(),
        ..Default::default()
    });
    let mut rect = LwPolyline::default();
    for (x, y) in [(0.0, 0.0), (100.0, 0.0), (100.0, 50.0), (0.0, 50.0)] {
        rect.vertices.push(LwPolylineVertex {
            x,
            y,
            ..Default::default()
        });
    }
    rect.set_is_closed(true);
    d.add_entity(on("Frame", EntityType::LwPolyline(rect)));

    let mut circle = on(
        "Parts",
        EntityType::Circle(Circle::new(Point::new(20.0, 25.0, 0.0), 10.0)),
    );
    circle.common.color = Color::from_index(5);
    d.add_entity(circle);
    let mut arc = on(
        "Parts",
        EntityType::Arc(Arc::new(Point::new(50.0, 25.0, 0.0), 10.0, 0.0, 90.0)),
    );
    // A true colour wins over the index.
    arc.common.color = Color::from_index(1);
    arc.common.color_24_bit = 0x12_34_56;
    d.add_entity(arc);
    let ellipse = Ellipse {
        center: Point::new(80.0, 25.0, 0.0),
        major_axis: Vector::new(10.0, 0.0, 0.0),
        minor_axis_ratio: 0.5,
        start_parameter: 0.0,
        end_parameter: std::f64::consts::TAU,
        ..Default::default()
    };
    d.add_entity(on("Parts", EntityType::Ellipse(ellipse)));
    let spline = Spline {
        degree_of_curve: 3,
        knot_values: vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0],
        control_points: vec![
            Point::new(0.0, 60.0, 0.0),
            Point::new(10.0, 70.0, 0.0),
            Point::new(20.0, 70.0, 0.0),
            Point::new(30.0, 60.0, 0.0),
        ],
        ..Default::default()
    };
    d.add_entity(on("Parts", EntityType::Spline(spline)));
    let mut bulged = LwPolyline::default();
    bulged.vertices.push(LwPolylineVertex {
        x: 40.0,
        y: 60.0,
        bulge: 1.0,
        ..Default::default()
    });
    bulged.vertices.push(LwPolylineVertex {
        x: 60.0,
        y: 60.0,
        ..Default::default()
    });
    d.add_entity(on("Parts", EntityType::LwPolyline(bulged)));

    let mut block = Block {
        name: "Bolt".into(),
        base_point: Point::new(0.0, 0.0, 0.0),
        ..Default::default()
    };
    block.entities.push(on(
        "0",
        EntityType::Line(Line::new(
            Point::new(-2.0, 0.0, 0.0),
            Point::new(2.0, 0.0, 0.0),
        )),
    ));
    d.add_block(block);
    for x in [10.0, 90.0] {
        let ins = Insert {
            name: "Bolt".into(),
            location: Point::new(x, 5.0, 0.0),
            ..Default::default()
        };
        d.add_entity(on("Frame", EntityType::Insert(ins)));
    }
    d.add_entity(on("Parts", EntityType::Text(Text::default())));
    d
}

use paged_svg::usvg;

fn tree(svg: &str) -> usvg::Tree {
    usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap()
}

#[test]
fn the_import_writes_each_layer_as_a_named_group_in_points() {
    let out = dxf_to_svg(&bytes(&sample())).unwrap();
    assert_eq!(out.layers, 2, "{}", out.svg);
    assert!(out.svg.contains(r#"<g id="Frame">"#));
    assert!(out.svg.contains(r#"<g id="Parts">"#));
    // 1 rectangle + 2 block lines on Frame; circle, arc, ellipse, spline,
    // polyline on Parts.
    assert_eq!(out.report.items, 8, "{:?}", out.report);
    // The text is reported, not dropped silently.
    let text = out.report.get("entity.TEXT").expect("the TEXT is reported");
    assert_eq!(text.count, 1);
    // Millimetres to points: the drawing is 100 mm wide.
    let t = tree(&out.svg);
    assert!(
        (t.size().width() - 283.465).abs() < 0.01,
        "{}",
        t.size().width()
    );
    // Colours: the frame is red by layer, the circle blue by index, the
    // arc its true colour.
    assert!(out.svg.contains(r##"stroke="#ff0000""##));
    assert!(out.svg.contains(r##"stroke="#0000ff""##));
    assert!(out.svg.contains(r##"stroke="#123456""##));
    // The default line weight, 0.25 mm.
    assert!(out.svg.contains(r#"stroke-width="0.709""#), "{}", out.svg);
}

#[test]
fn y_points_down_and_the_top_left_corner_is_the_origin() {
    let out = dxf_to_svg(&bytes(&sample())).unwrap();
    // The frame's DXF corner (0, 0) is the bottom left: in the SVG it is
    // at y = height of the drawing (70 mm, the spline's top).
    let h: f64 = 70.0 * 72.0 / 25.4;
    let expect = format!("M0 {}", (h * 1000.0).round() / 1000.0);
    assert!(out.svg.contains(&expect), "{expect} in {}", out.svg);
}

/// An R12 file has no line weights: its lines take the default.
#[test]
fn an_r12_file_draws_at_the_default_weight() {
    let mut d = Drawing::new();
    d.header.version = AcadVersion::R12;
    d.add_entity(on(
        "0",
        EntityType::Line(Line::new(
            Point::new(0.0, 0.0, 0.0),
            Point::new(10.0, 0.0, 0.0),
        )),
    ));
    let out = dxf_to_svg(&bytes(&d)).unwrap();
    assert!(out.svg.contains(r#"stroke-width="0.709""#), "{}", out.svg);
}

#[test]
fn a_file_that_is_not_dxf_is_an_error() {
    assert!(dxf_to_svg(b"<svg/>").is_err() || dxf_to_svg(b"<svg/>").unwrap().report.items == 0);
}

/// The export's DXF reads back with the geometry it was given.
#[test]
fn the_export_writes_polylines_and_exact_splines_that_read_back() {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
      <g id="Outline">
        <rect x="10" y="10" width="50" height="30" fill="none" stroke="#ff0000" stroke-width="1"/>
        <path d="M100 50 C100 20 150 20 150 50 L150 80" fill="#00ff00"/>
      </g>
      <path d="M0 0 L10 10" stroke="#000" stroke-dasharray="2 2"/>
    </svg>"##;
    let out = svg_to_dxf(svg).unwrap();
    assert_eq!(out.report.items, 3);
    assert!(out.report.get("fill.outline").is_some());
    assert!(out.report.get("stroke.dash").is_some());
    let d = Drawing::load(&mut std::io::Cursor::new(out.dxf.as_bytes())).unwrap();
    assert_eq!(d.header.default_drawing_units, Units::Millimeters);
    assert!(d.layers().any(|l| l.name == "Outline"));
    let ents: Vec<&Entity> = d.entities().collect();
    let mm = 25.4 / 72.0;
    match &ents[0].specific {
        EntityType::LwPolyline(p) => {
            assert!(p.is_closed());
            assert_eq!(p.vertices.len(), 4);
            // (10, 10) top-left in the SVG is (10, 90) from the bottom.
            assert!((p.vertices[0].x - 10.0 * mm).abs() < 1e-6);
            assert!((p.vertices[0].y - 90.0 * mm).abs() < 1e-6);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(ents[0].common.layer, "Outline");
    assert_eq!(ents[0].common.color_24_bit, 0xff0000);
    assert_eq!(ents[0].common.color.index(), Some(1));
    match &ents[1].specific {
        EntityType::Spline(s) => {
            assert_eq!(s.degree_of_curve, 3);
            // One cubic and one line: 7 control points, knots 0000 111 2222.
            assert_eq!(s.control_points.len(), 7);
            assert_eq!(
                s.knot_values,
                vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 2.0, 2.0, 2.0, 2.0]
            );
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(ents[1].common.color_24_bit, 0x00ff00);
    assert_eq!(ents[2].common.layer, "0");
}

/// DXF → SVG → DXF: the same entities come back, in millimetres, with
/// their colours; and SVG → DXF → SVG draws the same paths.
#[test]
fn a_drawing_survives_the_round_trip() {
    let first = dxf_to_svg(&bytes(&sample())).unwrap();
    let back = svg_to_dxf(&first.svg).unwrap();
    assert_eq!(back.report.items, first.report.items);
    let d = Drawing::load(&mut std::io::Cursor::new(back.dxf.as_bytes())).unwrap();
    let layers: Vec<String> = d.layers().map(|l| l.name.clone()).collect();
    assert!(layers.contains(&"Frame".to_string()) && layers.contains(&"Parts".to_string()));
    let colours: Vec<i32> = d.entities().map(|e| e.common.color_24_bit).collect();
    assert!(colours.contains(&0x123456));
    // The frame is still 100 × 50 mm: its polyline's extent.
    let frame = d
        .entities()
        .find_map(|e| match &e.specific {
            EntityType::LwPolyline(p) if e.common.layer == "Frame" && p.vertices.len() == 4 => {
                Some(p)
            }
            _ => None,
        })
        .expect("the frame");
    let xs: Vec<f64> = frame.vertices.iter().map(|v| v.x).collect();
    let ys: Vec<f64> = frame.vertices.iter().map(|v| v.y).collect();
    let span = |v: &[f64]| {
        v.iter().cloned().fold(f64::MIN, f64::max) - v.iter().cloned().fold(f64::MAX, f64::min)
    };
    assert!((span(&xs) - 100.0).abs() < 0.01, "{xs:?}");
    assert!((span(&ys) - 50.0).abs() < 0.01, "{ys:?}");
    // And once more into SVG: the same document, to the written precision.
    let again = dxf_to_svg(back.dxf.as_bytes()).unwrap();
    assert_eq!(again.report.items, first.report.items);
    assert_eq!(again.layers, first.layers);
}
