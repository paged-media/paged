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
    // What the engine cannot hold yet is reported, once per kind.
    for what in ["a:reflection", "pattern fill", "preset shadow shdw17"] {
        assert_eq!(
            diagnostics.iter().filter(|d| d.contains(what)).count(),
            1,
            "{what}: {diagnostics:?}"
        );
    }
}
