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

//! The wire form of the mapper's result (`dml_native::native`): authored
//! DrawingML read through `paged_ooxml::drawingml`, lowered for a module
//! that places its items through mutations (doc ADR 618).

#![allow(non_snake_case)]

use dml_native::native::{Lowering, NativeFx};
use paged_ooxml::drawingml::{self, Rgba, ShapeProperties};
use paged_ooxml::tree::parse;

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

fn slots() -> Vec<(String, Rgba)> {
    vec![
        ("accent1".into(), Rgba::from_hex(0x4472c4)),
        ("tx1".into(), Rgba::from_hex(0x000000)),
    ]
}

fn sp(inner: &str) -> ShapeProperties {
    let el = parse(format!(r#"<a:spPr {NS}>{inner}</a:spPr>"#).as_bytes()).unwrap();
    drawingml::shape_properties(&el, &|_| None)
}

#[test]
fn a_shape_takes_its_gradient_outline_and_effects__feat__plugin_doc_native_effects() {
    let mut l = Lowering::new(slots());
    let fx = l.shape(
        &sp(concat!(
            r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="accent1"/></a:gs>"#,
            r#"<a:gs pos="100000"><a:srgbClr val="FFFFFF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>"#,
            r#"<a:ln w="25400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:prstDash val="dash"/></a:ln>"#,
            r#"<a:effectLst><a:glow rad="63500"><a:schemeClr val="accent1"><a:alpha val="40000"/></a:schemeClr></a:glow>"#,
            r#"<a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw></a:effectLst>"#,
        )),
        200.0,
        100.0,
    );
    let g = fx.gradient.as_ref().unwrap();
    assert_eq!(g.kind, "linear");
    assert_eq!(
        g.stops,
        vec![(0.0, "#4472C4".into()), (100.0, "#FFFFFF".into())]
    );
    // Top to bottom, from the middle of the top edge.
    assert_eq!(
        (g.angle, g.length, g.start),
        (Some(-90.0), Some(100.0), Some((100.0, 0.0)))
    );
    let s = fx.stroke.as_ref().unwrap();
    assert_eq!((s.color.as_str(), s.weight), ("#FF0000", 2.0));
    assert_eq!(s.dash, [8.0, 6.0]);
    let glow = fx.outer_glow.as_ref().unwrap();
    assert_eq!(
        (glow.size, glow.opacity, glow.color.as_str()),
        (5.0, 40.0, "#4472C4")
    );
    let d = fx.drop_shadow.as_ref().unwrap();
    assert_eq!((d.size, d.opacity), (2.0, 40.0));
    assert!(l.take_losses().is_empty());
    assert_eq!(fx.describe(), "gradient fill, outline, drop shadow, glow");
}

#[test]
fn a_picture_takes_its_alpha_and_reports_what_the_engine_cannot_hold__feat__plugin_doc_native_effects(
) {
    let blip_el = parse(
        format!(r#"<pic:blipFill {NS} xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><a:blip r:embed="rId4"><a:alphaModFix amt="50000"/><a:grayscl/></a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>"#)
            .as_bytes(),
    )
    .unwrap();
    let blip = drawingml::blip(&blip_el, &|_| None);
    let mut l = Lowering::new(slots());
    let fx = l.picture(
        &blip,
        &sp(concat!(
            r#"<a:effectLst><a:innerShdw blurRad="63500" dist="50800" dir="2700000"><a:srgbClr val="000000"/></a:innerShdw>"#,
            r#"<a:softEdge rad="31750"/><a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dir="5400000" sy="-100000" algn="bl"/></a:effectLst>"#,
        )),
        100.0,
        80.0,
    );
    assert_eq!(fx.opacity, Some(50.0));
    let i = fx.inner_shadow.as_ref().unwrap();
    assert_eq!((i.angle, i.size), (-45.0, 2.5));
    assert_eq!(fx.feather, Some(2.5));
    let losses = l.take_losses();
    assert!(losses.iter().any(|m| m.contains("a:grayscl")), "{losses:?}");
    assert!(
        losses.iter().any(|m| m.contains("a:reflection")),
        "{losses:?}"
    );
}

#[test]
fn a_translucent_fill_is_the_opacity_and_alpha_stops_a_feather__feat__plugin_doc_native_effects() {
    let mut l = Lowering::new(slots());
    let fx = l.shape(
        &sp(r#"<a:solidFill><a:srgbClr val="00FF00"><a:alpha val="25000"/></a:srgbClr></a:solidFill>"#),
        10.0,
        10.0,
    );
    assert_eq!(
        (fx.fill.as_deref(), fx.opacity),
        (Some("#00FF00"), Some(25.0))
    );
    let fx = l.shape(
        &sp(concat!(
            r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>"#,
            r#"<a:gs pos="100000"><a:srgbClr val="FF0000"><a:alpha val="0"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>"#,
        )),
        10.0,
        10.0,
    );
    let gf = fx.gradient_feather.unwrap();
    assert_eq!(gf.stops, vec![(0.0, 100.0), (100.0, 0.0)]);
    assert!(fx.opacity.is_none());
}

#[test]
fn the_wire_form_round_trips_and_omits_what_is_unset__feat__plugin_doc_native_effects() {
    let mut l = Lowering::new(slots());
    let fx = l.shape(
        &sp(r#"<a:effectLst><a:softEdge rad="12700"/></a:effectLst>"#),
        10.0,
        10.0,
    );
    let json = serde_json::to_string(&fx).unwrap();
    assert_eq!(json, r#"{"feather":1.0}"#);
    assert_eq!(serde_json::from_str::<NativeFx>(&json).unwrap(), fx);
    assert!(l.shape(&ShapeProperties::default(), 1.0, 1.0).is_empty());
}
