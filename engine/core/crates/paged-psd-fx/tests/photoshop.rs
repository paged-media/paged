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

//! Engine ADR 1044 — files Photoshop 27.10 wrote itself
//! (`fixtures/photoshop-layer-styles/layer-styles.photoshop.json` names
//! the probe and the recording): each layer's `lfx2` read by `paged-psd`
//! and mapped onto the stack with the parameters the probe set, at the
//! files' 72 ppi.

#![allow(non_snake_case)]

use paged_model::effect_stack::{Effect, StrokePosition};
use paged_psd::PsdFile;
use paged_psd_fx::{map_layer_record, MapOptions, MappedStyle};

fn mapped(id: &str) -> MappedStyle {
    let path = format!(
        "{}/tests/fixtures/photoshop-layer-styles/{id}.psd",
        env!("CARGO_MANIFEST_DIR")
    );
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let file = PsdFile::parse(&bytes).expect("parse");
    file.layer_mask
        .layers
        .iter()
        .find_map(|rec| map_layer_record(rec, &MapOptions::default()))
        .unwrap_or_else(|| panic!("{id}: no styled layer"))
}

fn kinds(m: &MappedStyle) -> Vec<&'static str> {
    m.stack.iter().map(|e| e.effect.kind_name()).collect()
}

#[test]
fn photoshop_files_map_onto_the_stack__feat__images_graphics_psd_layer_styles() {
    // ds-basic: multiply black 75, 120°, distance 5, size 5.
    let m = mapped("ds-basic");
    assert_eq!(kinds(&m), ["dropShadow"]);
    let Effect::DropShadow { parked: Some(p) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(p.opacity_pct, 75.0);
    assert_eq!(p.blend_mode.as_deref(), Some("Multiply"));
    assert!((p.size - 5.0).abs() < 1e-3);
    // 120°: light from the upper left, the shadow down and right.
    assert!((p.x_offset - 2.5).abs() < 1e-3 && (p.y_offset - 4.330).abs() < 1e-3);
    assert!(m.losses.is_empty(), "{:?}", m.losses);

    // is-basic: the same, inside.
    let m = mapped("is-basic");
    let Effect::InnerShadow { parked: Some(p) } = &m.stack[0].effect else {
        panic!("{:?}", kinds(&m))
    };
    assert_eq!(
        (p.angle_deg, p.distance, p.size),
        (Some(120.0), Some(5.0), Some(5.0))
    );

    // og-softer: screen (255,255,190) 75, softer, size 10.
    let m = mapped("og-softer");
    let Effect::OuterGlow { parked: Some(p) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(p.blend_mode.as_deref(), Some("Screen"));
    assert_eq!(p.technique.as_deref(), Some("Softer"));
    assert_eq!(p.size, Some(10.0));
    assert_eq!(
        p.effect_color.as_deref(),
        Some("Color/PSD R=255 G=255 B=190")
    );

    // ig-edge: from the edge.
    let m = mapped("ig-edge");
    let Effect::InnerGlow { parked: Some(p) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(p.source.as_deref(), Some("EdgeGlow"));

    // bv-inner-smooth: inner bevel, smooth, depth 100, size 5.
    let m = mapped("bv-inner-smooth");
    let Effect::BevelEmboss { parked: Some(p) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(p.style.as_deref(), Some("InnerBevel"));
    assert_eq!(p.technique.as_deref(), Some("Smooth"));
    assert_eq!((p.depth_pct, p.size), (Some(100.0), Some(5.0)));

    // sa-plain: multiply black 50, 19°, distance 11, size 14.
    let m = mapped("sa-plain");
    let Effect::Satin { parked: Some(p) } = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(
        (p.angle_deg, p.distance, p.size, p.opacity_pct),
        (Some(19.0), Some(11.0), Some(14.0), Some(50.0))
    );

    // co-fill0: a colour overlay, normal 100.
    let m = mapped("co-fill0");
    assert_eq!(kinds(&m), ["colorOverlay"]);
    assert_eq!(m.stack[0].opacity_pct, None);

    // go-linear: black to white at 90°.
    let m = mapped("go-linear");
    let Effect::GradientOverlay(g) = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!(g.angle_deg, Some(90.0));
    let stops = &m.gradients[0].stops;
    assert_eq!(stops.first().unwrap().stop_color, "Color/PSD R=0 G=0 B=0");
    assert_eq!(
        stops.last().unwrap().stop_color,
        "Color/PSD R=255 G=255 B=255"
    );
    assert!(m.losses.is_empty(), "{:?}", m.losses);

    // st-outside-square: outside, 5 px.
    let m = mapped("st-outside-square");
    let Effect::OutlineStroke(s) = &m.stack[0].effect else {
        panic!()
    };
    assert_eq!((s.position, s.size_pt), (StrokePosition::Outside, 5.0));
}

#[test]
fn what_the_stack_cannot_say_is_reported() {
    let radial = mapped("go-radial");
    assert!(
        radial.losses.iter().any(|l| l.what.contains("Radial")),
        "{:?}",
        radial.losses
    );
    let glow = mapped("og-gradient");
    assert!(glow.losses.iter().any(|l| l.effect == "Outer Glow"));
    let cone = mapped("bv-contour-cone");
    assert!(
        cone.losses.iter().any(|l| l.effect == "Bevel & Emboss"),
        "{:?}",
        cone.losses
    );
}
