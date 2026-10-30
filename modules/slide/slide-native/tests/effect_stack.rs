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
//! The `effect-stack` fixture (PowerPoint-written, its PDF recorded): each
//! shape carries one DrawingML effect the shared mapper (ADR 722) puts on
//! the engine's effect stack (engine ADR 1008), or a custom geometry whose
//! path PowerPoint fills even-odd (engine ADR 1006).

#![allow(non_snake_case)]

use std::path::PathBuf;

use paged_model::effect_stack::Effect;
use paged_model::{FillRule, Polygon};
use paged_scene::Document;

fn built() -> (Document, Vec<String>) {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures/effect-stack.pptx");
    let bytes = std::fs::read(p).unwrap();
    let ir = pptx_import::import_pptx(&bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(&bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    let b = slide_native::build(&deck, &images, "effect-stack");
    (b.document, b.diagnostics)
}

fn shape<'a>(doc: &'a Document, name: &str) -> &'a Polygon {
    for s in &doc.spreads {
        let sp = &s.spread;
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
fn a_path_powerpoint_fills_with_a_hole_takes_the_even_odd_rule__feat__frames_paths_fill_rule_even_odd(
) {
    let (doc, _) = built();
    // Two squares turning the same way: PowerPoint shows a hole (its PDF),
    // which only the even-odd rule draws.
    assert_eq!(shape(&doc, "even-odd").fill_rule, FillRule::EvenOdd);
    // Turning against each other both rules show it: the item stays
    // non-zero, as every outline whose rules agree.
    assert_eq!(shape(&doc, "non-zero").fill_rule, FillRule::NonZero);
    assert_eq!(shape(&doc, "blur").fill_rule, FillRule::NonZero);
}

#[test]
fn blur_overlay_and_reflection_open_on_the_effect_stack__feat__plugin_slide_native_effects() {
    let (doc, diagnostics) = built();
    let only = |n: &str| {
        let st = &shape(&doc, n).effect_stack;
        assert_eq!(st.len(), 1, "{n}: {st:?}");
        st[0].clone()
    };
    // a:blur rad 10 pt: σ a third of it, as PowerPoint's PDF ramps.
    let Effect::GaussianBlur(b) = only("blur").effect else {
        panic!()
    };
    assert!((b.radius_pt - 10.0 / 3.0).abs() < 1e-3, "{}", b.radius_pt);
    let o = only("multiply overlay");
    assert_eq!(o.blend_mode.as_deref(), Some("Multiply"));
    let Effect::ColorOverlay(c) = o.effect else {
        panic!()
    };
    assert_eq!(c.color.as_deref(), Some("Color/RFF0000"));
    let Effect::Reflection(r) = only("reflection").effect else {
        panic!()
    };
    assert_eq!(
        (
            r.distance_pt,
            r.size_pct,
            r.start_opacity_pct,
            r.end_opacity_pct
        ),
        (3.0, 35.0, 52.0, 0.3)
    );
    // PowerPoint draws no gradient overlay: the shape is plain, and the
    // loss is reported once.
    assert!(shape(&doc, "gradient overlay").effect_stack.is_empty());
    assert_eq!(
        diagnostics
            .iter()
            .filter(|d| d.contains("gradient fill overlay"))
            .count(),
        1,
        "{diagnostics:?}"
    );
}
