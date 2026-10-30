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

//! The `effects` fixture (written by PowerPoint, ADR 705): each shape
//! carries one DrawingML paint or effect, and opens as the engine
//! construct the shared mapper (ADR 722) lowers it to — or is reported.

#![allow(non_snake_case)]

use std::path::PathBuf;

use paged_model::{Polygon, Spread};
use paged_scene::Document;

fn built() -> (Document, Vec<String>) {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures/effects.pptx");
    let bytes = std::fs::read(p).unwrap();
    let ir = pptx_import::import_pptx(&bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    let b = slide_native::build(&deck, &images, "effects");
    (b.document, b.diagnostics)
}

/// The outline polygon of the shape named `name`.
fn shape<'a>(doc: &'a Document, name: &str) -> &'a Polygon {
    let spreads: Vec<&Spread> = doc.spreads.iter().map(|s| &s.spread).collect();
    for sp in spreads {
        for p in &sp.polygons {
            let id = p.self_id.as_deref().unwrap_or("");
            if sp.item_names.get(id).map(String::as_str) == Some(name) {
                return p;
            }
        }
    }
    panic!("no shape {name:?}")
}

#[test]
fn powerpoints_effects_open_as_the_engine_effects__feat__plugin_slide_native_effects() {
    let (doc, _) = built();
    let s = shape(&doc, "outer shadow")
        .drop_shadow
        .as_ref()
        .expect("drop shadow");
    assert_eq!(
        (s.mode.as_str(), s.size, s.opacity_pct),
        ("Drop", 3.0, 40.0)
    );
    assert!((s.x_offset - 2.121).abs() < 1e-3 && (s.y_offset - 2.121).abs() < 1e-3);
    let fx = |n: &str| {
        shape(&doc, n)
            .effects
            .clone()
            .unwrap_or_else(|| panic!("{n}: no effects"))
    };
    let i = fx("inner shadow").inner_shadow.expect("inner shadow");
    assert_eq!((i.size, i.opacity_pct), (Some(2.5), Some(50.0)));
    let g = fx("glow").outer_glow.expect("glow");
    assert_eq!((g.size, g.opacity_pct), (Some(8.0), Some(60.0)));
    assert_eq!(fx("soft edge").feather.expect("feather").width, Some(5.0));
    let p = shape(&doc, "preset shadow")
        .drop_shadow
        .as_ref()
        .expect("preset as drop");
    assert!((p.x_offset - 2.121).abs() < 1e-3);
    // PowerPoint's reflection rides the effect stack (engine ADR 1008).
    let stack = &shape(&doc, "reflection").effect_stack;
    assert_eq!(stack.len(), 1, "{stack:?}");
    let paged_model::effect_stack::Effect::Reflection(r) = &stack[0].effect else {
        panic!("{stack:?}")
    };
    assert_eq!(
        (
            r.distance_pt,
            r.size_pct,
            r.start_opacity_pct,
            r.end_opacity_pct
        ),
        (0.0, 35.0, 52.0, 0.3)
    );
    assert!((r.blur_pt - 0.5 / 3.0).abs() < 1e-3, "{}", r.blur_pt);
    // The other effects are InDesign's alone: the canonical, empty stack.
    for n in ["outer shadow", "inner shadow", "glow", "soft edge"] {
        assert!(shape(&doc, n).effect_stack.is_empty(), "{n}");
    }
}

#[test]
fn alpha_stops_patterns_and_dashes_open_as_powerpoint_draws_them__feat__plugin_slide_dml_native_mapper(
) {
    let (doc, diagnostics) = built();
    let a = shape(&doc, "alpha gradient");
    let gf = a
        .effects
        .as_ref()
        .and_then(|e| e.gradient_feather.clone())
        .expect("feather");
    assert_eq!(
        gf.stops.iter().map(|s| s.alpha_pct).collect::<Vec<_>>(),
        [100.0, 10.0]
    );
    let r = shape(&doc, "radial gradient");
    assert!(r.fill_color.as_deref().unwrap().starts_with("Gradient/"));
    assert_eq!(r.gradient_fill_start, Some([100.0, 60.0]));
    assert_eq!(
        shape(&doc, "pattern").fill_color.as_deref(),
        Some("Color/R808080")
    );
    assert_eq!(shape(&doc, "dash sysDash").stroke_dash, [9.0, 3.0]);
    assert_eq!(
        shape(&doc, "dash lgDashDot").stroke_dash,
        [24.0, 9.0, 3.0, 9.0]
    );
    assert_eq!(
        shape(&doc, "dash custom").stroke_dash,
        [15.0, 6.0, 3.0, 6.0]
    );
    // What the engine cannot hold yet is reported, once per kind; the
    // reflection is carried (engine ADR 1008) and is not.
    assert!(
        !diagnostics.iter().any(|d| d.contains("reflection")),
        "{diagnostics:?}"
    );
    for what in ["pattern fill", "preset shadow shdw17"] {
        assert_eq!(
            diagnostics.iter().filter(|d| d.contains(what)).count(),
            1,
            "{what}: {diagnostics:?}"
        );
    }
}

/// The fixture with its "alpha gradient" shape's linear angle set to
/// `ang` (DrawingML 60 000ths of a degree, clockwise).
fn built_with_angle(ang: &str) -> Document {
    use std::io::{Read, Write};
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures/effects.pptx");
    let bytes = std::fs::read(p).unwrap();
    let mut zin = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for i in 0..zin.len() {
        let mut f = zin.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        if name == "ppt/slides/slide2.xml" {
            let xml = String::from_utf8(data).unwrap();
            assert!(xml.contains(r#"<a:lin ang="0" scaled="0"/>"#));
            data = xml
                .replace(
                    r#"<a:lin ang="0" scaled="0"/>"#,
                    &format!(r#"<a:lin ang="{ang}" scaled="0"/>"#),
                )
                .into_bytes();
        }
        out.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        out.write_all(&data).unwrap();
    }
    let bytes = out.finish().unwrap().into_inner();
    let ir = pptx_import::import_pptx(&bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, "effects").document
}

/// A linear gradient's axis starts where PowerPoint centres it on the
/// shape's 200 × 120 pt box, in the shape's local coordinates: the
/// engine's own placement (the box's bottom-left corner) is right only
/// for an axis running up or right.
#[test]
fn a_vertical_or_down_diagonal_gradient_starts_where_powerpoint_starts_it__feat__plugin_slide_native_effects(
) {
    let at = |ang: &str| {
        let doc = built_with_angle(ang);
        let s = shape(&doc, "alpha gradient");
        (
            s.gradient_fill_angle,
            s.gradient_fill_length,
            s.gradient_fill_start,
        )
    };
    // Left to right: the middle of the left edge.
    assert_eq!(at("0"), (Some(0.0), Some(200.0), Some([0.0, 60.0])));
    // DrawingML 90° runs top to bottom: from the middle of the top edge.
    assert_eq!(
        at("5400000"),
        (Some(-90.0), Some(120.0), Some([100.0, 0.0]))
    );
    // 45° runs down-right, from the top-left corner's projection.
    let (a, l, s) = at("2700000");
    assert_eq!(a, Some(-45.0));
    let l = l.unwrap() as f64;
    assert!((l - 320.0 / 2f64.sqrt()).abs() < 1e-2, "{l}");
    let [x, y] = s.unwrap();
    assert!(
        (x - 20.0).abs() < 1e-2 && (y + 20.0).abs() < 1e-2,
        "{x} {y}"
    );
}
