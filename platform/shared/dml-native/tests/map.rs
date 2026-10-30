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

//! The mapper from DrawingML as written to the engine's model: each case
//! reads real DrawingML through `paged_ooxml::drawingml`, resolves it and
//! lowers it, so the whole chain a module runs is under test.

#![allow(non_snake_case)]

use dml_native::*;
use paged_model::{ArrowheadType, GradientKind, RasterOp};
use paged_ooxml::drawingml::{self, resolved, Rgba};
use paged_ooxml::tree::{parse, El};

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

fn sp_pr(inner: &str) -> El {
    parse(format!(r#"<a:spPr {NS}>{inner}</a:spPr>"#).as_bytes()).unwrap()
}

fn theme() -> Vec<(String, Rgba)> {
    vec![("accent1".into(), Rgba::from_hex(0x4472c4))]
}

fn paint_of(xml: &str) -> Paint {
    let f = drawingml::fill_in(&sp_pr(xml), &|_| None).unwrap();
    resolved::paint(&f, &theme(), &mut |_| {})
}

fn effects_of_xml(xml: &str) -> Effects {
    let el = parse(format!(r#"<a:effectLst {NS}>{xml}</a:effectLst>"#).as_bytes()).unwrap();
    resolved::effects(&drawingml::effects(&el, &|_| None), &theme(), &mut |_| {})
}

#[test]
fn solid_and_theme_colours_become_named_swatches__feat__plugin_slide_dml_native_mapper() {
    let mut m = Mapper::new(&[("accent1".into(), [0x44, 0x72, 0xc4])]);
    assert_eq!(
        m.paint(&paint_of(
            r#"<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>"#
        )),
        "Color/accent1"
    );
    assert_eq!(
        m.paint(&paint_of(
            r#"<a:solidFill><a:srgbClr val="FF8000"/></a:solidFill>"#
        )),
        "Color/RFF8000"
    );
    assert_eq!(m.paint(&paint_of("<a:noFill/>")), NONE_SWATCH);
    let entries = m.palette.color_entries();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].value, vec![68.0, 114.0, 196.0]);
    assert!(m.losses().is_empty());
}

#[test]
fn gradients_mint_one_swatch_per_look_and_place_as_powerpoint_runs_them__feat__plugin_slide_dml_native_mapper(
) {
    let mut m = Mapper::default();
    let lin = paint_of(
        r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="2700000"/></a:gradFill>"#,
    );
    let id = m.paint(&lin);
    assert_eq!(id, "Gradient/g1");
    assert_eq!(m.paint(&lin), id, "the same gradient is one swatch");
    let p = placement(&lin, 200.0, 100.0);
    assert_eq!(p.angle, Some(-45.0));
    assert!((p.length.unwrap() as f64 - 300.0 * std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-3);
    let rad = paint_of(
        r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>"#,
    );
    assert_eq!(m.paint(&rad), "Gradient/g2");
    let p = placement(&rad, 30.0, 40.0);
    assert_eq!(p.start, Some([15.0, 20.0]));
    assert_eq!(p.length, Some(25.0));
    let g = m.palette.gradient_entries();
    assert_eq!(g[0].kind, GradientKind::Linear);
    assert_eq!(g[1].kind, GradientKind::Radial);
    assert_eq!(g[0].stops[1].location_pct, 100.0);
    assert_eq!(g[0].stops[1].stop_color, "Color/R0000FF");
}

#[test]
fn alpha_stops_fade_the_item_through_a_gradient_feather__feat__plugin_slide_dml_native_mapper() {
    let mut m = Mapper::default();
    let p = paint_of(
        r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="FF0000"><a:alpha val="20000"/></a:srgbClr></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill>"#,
    );
    let t = m.transparency(1.0, &Effects::default(), Some(&p));
    let gf = t.effects.unwrap().gradient_feather.unwrap();
    assert_eq!(gf.gradient_type.as_deref(), Some("Linear"));
    assert_eq!(gf.angle_deg, Some(-90.0));
    assert_eq!(
        gf.stops
            .iter()
            .map(|s| (s.location_pct, s.alpha_pct))
            .collect::<Vec<_>>(),
        [(0.0, 100.0), (100.0, 20.0)]
    );
    assert!(t.opacity.is_none() && t.shadow.is_none());
}

#[test]
fn a_pattern_is_the_mix_of_its_colours_and_reported__feat__plugin_slide_dml_native_mapper() {
    let mut m = Mapper::default();
    let p = paint_of(
        r#"<a:pattFill prst="pct50"><a:fgClr><a:srgbClr val="000000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill>"#,
    );
    assert_eq!(m.paint(&p), "Color/R808080");
    m.paint(&p);
    assert_eq!(m.losses().len(), 1, "one line per kind of loss");
    assert!(m.losses()[0].contains("pattern"));
}

#[test]
fn strokes_map_compound_dash_caps_joins_alignment_and_arrows__feat__plugin_slide_dml_native_mapper()
{
    let mut m = Mapper::default();
    let line = |xml: &str| {
        let l = drawingml::line(
            &parse(format!(r#"<a:ln {NS} {xml}</a:ln>"#).as_bytes()).unwrap(),
            &|_| None,
        );
        resolved::stroke(&l, &(), 9525, &mut |_| {}).unwrap()
    };
    let s = line(
        r#"w="25400" cmpd="dbl" cap="rnd"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:bevel/><a:headEnd type="diamond"/><a:tailEnd type="stealth"/>"#,
    );
    let f = m.stroke(Some(&s));
    assert_eq!(f.weight, Some(2.0));
    assert_eq!(f.kind.as_deref(), Some("StrokeStyle/$ID/ThickThick"));
    assert_eq!(f.cap.as_deref(), Some("RoundEndCap"));
    assert_eq!(f.join.as_deref(), Some("BevelEndJoin"));
    assert_eq!(
        (f.head, f.tail),
        (
            Some(ArrowheadType::SquareSolid),
            Some(ArrowheadType::Barbed)
        )
    );
    assert!(f.dash.is_empty());
    let d = m.stroke(Some(&line(r#"w="12700" cmpd="dbl"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="sysDash"/><a:miter lim="800000"/>"#)));
    assert_eq!(
        d.kind.as_deref(),
        Some("StrokeStyle/$ID/Dashed"),
        "dashes win over the compound"
    );
    assert_eq!(d.dash, vec![3.0, 1.0]);
    assert_eq!(d.miter_limit, Some(8.0));
    let c = m.stroke(Some(&line(r#"w="25400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:custDash><a:ds d="300000" sp="100000"/><a:ds d="100000" sp="100000"/></a:custDash>"#)));
    assert_eq!(c.dash, vec![6.0, 2.0, 2.0, 2.0]);
    let none = m.stroke(None);
    assert_eq!(
        (none.color.as_deref(), none.weight),
        (Some(NONE_SWATCH), Some(0.0))
    );
    m.stroke(Some(&line(
        r#"w="12700" cmpd="tri"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>"#,
    )));
    assert!(m.losses().iter().any(|l| l.contains("triple")));
}

#[test]
fn every_dash_preset_comes_back_from_its_pattern__feat__plugin_slide_dml_native_mapper() {
    for name in [
        "dot",
        "dash",
        "lgDash",
        "dashDot",
        "lgDashDot",
        "lgDashDotDot",
        "sysDash",
        "sysDot",
        "sysDashDot",
        "sysDashDotDot",
    ] {
        let pattern: Vec<f32> = preset_dash(name)
            .unwrap()
            .iter()
            .map(|v| (*v * 1.5) as f32)
            .collect();
        assert_eq!(dash_of(&pattern, 1.5), Some(Ok(name)), "{name}");
    }
    assert_eq!(
        dash_of(&[10.0, 4.0, 2.0, 4.0], 2.0),
        Some(Err(vec![(500_000, 200_000), (100_000, 200_000)]))
    );
    assert_eq!(dash_of(&[], 1.0), None);
}

#[test]
fn shadows_glow_and_soft_edge_become_the_engine_effects__feat__plugin_slide_native_effects() {
    let mut m = Mapper::default();
    let fx = effects_of_xml(
        r#"<a:outerShdw blurRad="50800" dist="38100" dir="2700000" algn="tl" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw><a:innerShdw blurRad="63500" dist="50800" dir="13500000"><a:schemeClr val="accent1"/></a:innerShdw><a:glow rad="101600"><a:srgbClr val="FFC000"><a:alpha val="60000"/></a:srgbClr></a:glow><a:softEdge rad="63500"/>"#,
    );
    let t = m.transparency(0.5, &fx, None);
    assert_eq!(t.opacity, Some(50.0));
    let s = t.shadow.unwrap();
    assert_eq!(
        (s.mode.as_str(), s.size, s.opacity_pct),
        ("Drop", 2.0, 40.0)
    );
    assert!((s.x_offset - 2.121).abs() < 1e-3 && (s.y_offset - 2.121).abs() < 1e-3);
    assert_eq!(s.effect_color.as_deref(), Some("Color/R000000"));
    let e = t.effects.unwrap();
    let i = e.inner_shadow.unwrap();
    assert_eq!(
        (i.x_offset, i.y_offset, i.size),
        (Some(-2.828), Some(-2.828), Some(2.5))
    );
    assert_eq!(i.effect_color.as_deref(), Some("Color/R4472C4"));
    let g = e.outer_glow.unwrap();
    assert_eq!(
        (g.size, g.opacity_pct, g.effect_color.as_deref()),
        (Some(8.0), Some(60.0), Some("Color/RFFC000"))
    );
    assert_eq!(e.feather.unwrap().width, Some(5.0));
    assert!(m.losses().is_empty(), "{:?}", m.losses());
}

#[test]
fn what_the_engine_cannot_hold_is_reported_never_dropped__feat__plugin_slide_native_effects() {
    let mut m = Mapper::default();
    let fx = effects_of_xml(
        r#"<a:blur rad="12700" grow="0"/><a:fillOverlay blend="mult"><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="FF0000"><a:alpha val="0"/></a:srgbClr></a:gs></a:gsLst><a:path path="circle"/></a:gradFill></a:fillOverlay><a:outerShdw dist="12700" sy="-50000"><a:srgbClr val="000000"/></a:outerShdw><a:prstShdw prst="shdw3" dist="12700"><a:srgbClr val="000000"/></a:prstShdw><a:reflection dir="0" sy="100000"/>"#,
    );
    let t = m.transparency(1.0, &fx, None);
    assert!(t.shadow.is_some());
    let l = m.take_losses();
    for what in [
        "grow=\"0\"",
        "gradient fill overlay",
        "reflection's direction",
        "scale and skew",
        "preset shadow beside",
    ] {
        assert!(l.iter().any(|x| x.contains(what)), "{what}: {l:?}");
    }
    // A preset shadow alone is drawn as a drop shadow, and says so.
    let fx = effects_of_xml(
        r#"<a:prstShdw prst="shdw17" dist="25400" dir="5400000"><a:srgbClr val="808080"/></a:prstShdw>"#,
    );
    let t = m.transparency(1.0, &fx, None);
    let s = t.shadow.unwrap();
    assert_eq!((s.x_offset, s.y_offset, s.size), (0.0, 2.0, 0.0));
    assert!(m.losses()[0].contains("shdw17"));
}

#[test]
fn blur_reflection_and_overlay_ride_the_effect_stack__feat__plugin_slide_native_effects() {
    use paged_model::effect_stack::Effect;
    let mut m = Mapper::default();
    let fx = effects_of_xml(
        r#"<a:blur rad="127000"/><a:fillOverlay blend="mult"><a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill></a:fillOverlay><a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw><a:reflection blurRad="6350" stA="52000" endA="300" endPos="35000" dist="12700" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/><a:softEdge rad="63500"/>"#,
    );
    let t = m.transparency(1.0, &fx, None);
    assert!(m.losses().is_empty(), "{:?}", m.losses());
    let kinds: Vec<&str> = t.stack.iter().map(|e| e.effect.kind_name()).collect();
    // InDesign's effects first, in InDesign's order (the body draws them),
    // then the overlay on the shape, the blur of it and its reflection.
    assert_eq!(
        kinds,
        [
            "dropShadow",
            "feather",
            "colorOverlay",
            "gaussianBlur",
            "reflection"
        ]
    );
    assert!(t.shadow.is_some() && t.effects.as_ref().unwrap().feather.is_some());
    let overlay = &t.stack[2];
    assert_eq!(
        (overlay.blend_mode.as_deref(), overlay.opacity_pct),
        (Some("Multiply"), Some(50.0))
    );
    let Effect::ColorOverlay(o) = &overlay.effect else {
        panic!()
    };
    assert_eq!(o.color.as_deref(), Some("Color/RFF0000"));
    // PowerPoint's blur reaches its radius either side of the edge: σ is a
    // third of it.
    let Effect::GaussianBlur(b) = &t.stack[3].effect else {
        panic!()
    };
    assert!((b.radius_pt - 10.0 / 3.0).abs() < 1e-3, "{}", b.radius_pt);
    let Effect::Reflection(r) = &t.stack[4].effect else {
        panic!()
    };
    assert_eq!(
        (
            r.distance_pt,
            r.size_pct,
            r.start_opacity_pct,
            r.end_opacity_pct
        ),
        (1.0, 35.0, 52.0, 0.3)
    );
    assert!(paged_model::effect_stack::is_canonical(&t.stack[..2]));
    // InDesign's effects alone keep the canonical (empty) stack.
    let only = effects_of_xml(r#"<a:softEdge rad="63500"/>"#);
    assert!(m.transparency(1.0, &only, None).stack.is_empty());
    // PowerPoint draws no gradient overlay; neither does the stack, and
    // the loss says so.
    let fx = effects_of_xml(
        r#"<a:fillOverlay blend="screen"><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill></a:fillOverlay>"#,
    );
    assert!(m.transparency(1.0, &fx, None).stack.is_empty());
    assert!(
        m.losses()[0].contains("gradient fill overlay"),
        "{:?}",
        m.losses()
    );
}

#[test]
fn the_effect_stack_comes_back_as_drawingml__feat__plugin_slide_native_effects() {
    let mut m = Mapper::default();
    let fx = effects_of_xml(
        r#"<a:blur rad="114300"/><a:fillOverlay blend="mult"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:fillOverlay><a:reflection blurRad="38100" stA="52000" endA="300" endPos="35000" dist="12700" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/>"#,
    );
    let t = m.transparency(1.0, &fx, None);
    let colours: Vec<(Rgb, String)> = m.palette.colors().map(|(c, id)| (*c, id.clone())).collect();
    let rgb_of = |id: &str| colours.iter().find(|(_, i)| i == id).map(|(c, _)| *c);
    let back = effects_with_stack(
        t.shadow.as_ref(),
        t.effects.as_ref(),
        &t.stack,
        &rgb_of,
        &|_| None,
    );
    let near = |a: f64, b: f64| (a - b).abs() < 2e-3;
    assert!(near(back.blur.as_ref().unwrap().radius, 9.0));
    let (r, r2) = (
        fx.reflection.as_ref().unwrap(),
        back.reflection.as_ref().unwrap(),
    );
    assert!(near(r.blur, r2.blur) && near(r.end_pos, r2.end_pos) && near(r.distance, r2.distance));
    assert!(near(r.start_alpha, r2.start_alpha) && near(r.end_alpha, r2.end_alpha));
    assert_eq!(
        back.fill_overlay,
        fx.fill_overlay.clone().map(|mut o| {
            if let Paint::Solid { theme, .. } = &mut o.paint {
                *theme = None;
            }
            o
        })
    );
    let xml = drawingml::write::effects(&back, &drawingml::write::srgb).unwrap();
    assert!(
        xml.starts_with(
            r#"<a:effectLst><a:blur rad="114300" grow="1"/><a:fillOverlay blend="mult">"#
        ),
        "{xml}"
    );
    assert!(xml.contains(r#"<a:reflection blurRad="38100""#), "{xml}");
}

#[test]
fn powerpoint_fills_a_path_even_odd__feat__frames_paths_fill_rule_even_odd() {
    use paged_model::{FillRule, PathAnchor};
    let square = |x0: f32, y0: f32, x1: f32, y1: f32| -> Vec<PathAnchor> {
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
            .into_iter()
            .map(|p| PathAnchor {
                anchor: p,
                left: p,
                right: p,
            })
            .collect()
    };
    let mut m = Mapper::default();
    // Two squares turning the same way, one path: PowerPoint shows a hole.
    let mut a = square(0.0, 0.0, 100.0, 100.0);
    a.extend(square(25.0, 25.0, 75.0, 75.0));
    assert_eq!(
        m.fill_rule(&a, &[0, 4], &[false, false], &[0, 0]),
        FillRule::EvenOdd
    );
    // Turning against each other the rules agree: non-zero, unchanged.
    let mut b = square(0.0, 0.0, 100.0, 100.0);
    let mut hole = square(25.0, 25.0, 75.0, 75.0);
    hole.reverse();
    b.extend(hole);
    assert_eq!(
        m.fill_rule(&b, &[0, 4], &[false, false], &[0, 0]),
        FillRule::NonZero
    );
    // One contour: non-zero.
    assert_eq!(
        m.fill_rule(&square(0.0, 0.0, 1.0, 1.0), &[0], &[false], &[0]),
        FillRule::NonZero
    );
    assert!(m.losses().is_empty());
    // Several paths, each filled on its own: one rule cannot say it.
    let mut c = a.clone();
    c.extend(square(200.0, 0.0, 300.0, 100.0));
    assert_eq!(
        m.fill_rule(&c, &[0, 4, 8], &[false; 3], &[0, 0, 1]),
        FillRule::NonZero
    );
    assert!(m.losses()[0].contains("several paths"), "{:?}", m.losses());
}

#[test]
fn picture_opacity_is_kept_and_other_picture_effects_reported__feat__plugin_slide_native_effects() {
    let el = parse(format!(r#"<a:blipFill {NS}><a:blip r:embed="r1"><a:alphaModFix amt="70000"/><a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange><a:extLst><a:ext uri="x"><a14:imgProps xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><a14:imgLayer><a14:imgEffect><a14:artisticBlur radius="20"/></a14:imgEffect></a14:imgLayer></a14:imgProps></a:ext></a:extLst></a:blip></a:blipFill>"#).as_bytes()).unwrap();
    let pic = resolved::picture(&drawingml::blip(&el, &|_| None), &());
    let mut m = Mapper::default();
    let mapped = m.picture(&pic);
    assert_eq!(mapped.opacity, 0.7);
    assert!(mapped.adjustments.is_empty());
    let l = m.losses();
    assert_eq!(l.len(), 1, "{l:?}");
    assert!(l[0].contains("a:clrChange"), "{l:?}");
}

#[test]
fn colour_replacement_and_picture_blur_join_the_filter_stack__feat__images_graphics_image_filter_stack(
) {
    let el = parse(format!(r#"<a:blipFill {NS}><a:blip r:embed="r1"><a:clrRepl><a:srgbClr val="FF8000"/></a:clrRepl><a:blur rad="38100"/><a:tint hue="1200000" amt="50000"/></a:blip></a:blipFill>"#).as_bytes()).unwrap();
    let pic = resolved::picture(&drawingml::blip(&el, &|_| None), &());
    let mut m = Mapper::default();
    // 2 pixels per point: a 3 pt blur radius is σ 1 pt, 2 px.
    let mapped = m.picture_at(&pic, Some(2.0));
    assert_eq!(mapped.elements, ["a:clrRepl", "a:blur"]);
    let orange = [1.0, 128.0 / 255.0, 0.0];
    assert_eq!(
        mapped.adjustments[0],
        RasterOp::Duotone {
            shadow: orange,
            highlight: orange
        }
    );
    let RasterOp::Blur { radius } = mapped.adjustments[1] else {
        panic!()
    };
    assert!((radius - 2.0).abs() < 1e-4, "{radius}");
    assert!(mapped.adjustments.iter().all(RasterOp::is_valid));
    let l = m.take_losses();
    assert_eq!(l.len(), 1, "{l:?}");
    assert!(l[0].contains("a:tint"), "{l:?}");
    // Without the picture's pixel size the blur cannot be stated.
    let mapped = m.picture(&pic);
    assert_eq!(mapped.elements, ["a:clrRepl"]);
    assert!(
        m.losses().iter().any(|x| x.contains("a:blur")),
        "{:?}",
        m.losses()
    );
    assert_eq!(
        mapped.native_lane_losses(),
        ["a:clrRepl (picture adjustment duotone) is not carried on the native lane"]
    );
}

#[test]
fn picture_effects_become_the_filter_stack__feat__images_graphics_image_filter_stack() {
    let el = parse(format!(r#"<a:blipFill {NS}><a:blip r:embed="r1"><a:grayscl/><a:lum bright="20000" contrast="-50000"/><a:duotone><a:srgbClr val="000000"/><a:srgbClr val="FFFFFF"/></a:duotone><a:biLevel thresh="40000"/><a:hsl hue="1200000" sat="-25000" lum="10000"/></a:blip></a:blipFill>"#).as_bytes()).unwrap();
    let pic = resolved::picture(&drawingml::blip(&el, &|_| None), &());
    let mut m = Mapper::default();
    let mapped = m.picture(&pic);
    assert!(m.losses().is_empty(), "{:?}", m.losses());
    let names: Vec<&str> = mapped.adjustments.iter().map(|op| op.name()).collect();
    assert_eq!(
        names,
        [
            "blackWhite",
            "brightnessContrast",
            "duotone",
            "threshold",
            "hueSaturation"
        ]
    );
    assert_eq!(
        mapped.adjustments[1],
        RasterOp::BrightnessContrast {
            brightness: 0.2,
            contrast: 0.5
        }
    );
    assert_eq!(
        mapped.adjustments[2],
        RasterOp::Duotone {
            shadow: [0.0; 3],
            highlight: [1.0; 3]
        }
    );
    assert_eq!(mapped.adjustments[3], RasterOp::Threshold { level: 0.4 });
    assert!(mapped.adjustments.iter().all(RasterOp::is_valid));
}

#[test]
fn the_engine_effects_come_back_as_drawingml__feat__plugin_slide_native_effects() {
    let mut m = Mapper::default();
    let fx = effects_of_xml(
        r#"<a:glow rad="101600"><a:srgbClr val="FFC000"><a:alpha val="60000"/></a:srgbClr></a:glow><a:innerShdw blurRad="63500" dist="50800" dir="13500000"><a:srgbClr val="4472C4"/></a:innerShdw><a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr></a:outerShdw><a:softEdge rad="63500"/>"#,
    );
    let t = m.transparency(1.0, &fx, None);
    let colours: Vec<(Rgb, String)> = m.palette.colors().map(|(c, id)| (*c, id.clone())).collect();
    let rgb_of = |id: &str| colours.iter().find(|(_, i)| i == id).map(|(c, _)| *c);
    let back = effects_of(t.shadow.as_ref(), t.effects.as_ref(), &rgb_of);
    let near = |a: f64, b: f64| (a - b).abs() < 2e-3;
    let (o, o2) = (
        fx.outer_shadow.as_ref().unwrap(),
        back.outer_shadow.as_ref().unwrap(),
    );
    assert!(
        near(o.dx, o2.dx)
            && near(o.dy, o2.dy)
            && near(o.blur, o2.blur)
            && o.rgb == o2.rgb
            && near(o.alpha, o2.alpha)
    );
    let (i, i2) = (
        fx.inner_shadow.as_ref().unwrap(),
        back.inner_shadow.as_ref().unwrap(),
    );
    assert!(near(i.dx, i2.dx) && near(i.dy, i2.dy) && near(i.blur, i2.blur) && i.rgb == i2.rgb);
    assert_eq!(back.glow, fx.glow);
    assert_eq!(back.soft_edge, fx.soft_edge);
    let xml = drawingml::write::effects(&back, &drawingml::write::srgb).unwrap();
    assert!(
        xml.starts_with("<a:effectLst><a:glow rad=\"101600\">"),
        "{xml}"
    );
    assert!(xml.contains(r#"<a:softEdge rad="63500"/>"#));
}

#[test]
fn a_linear_axis_starts_where_office_centres_it__feat__sheet_chart_native_effects() {
    let lin = |ang: &str| {
        paint_of(&format!(
            r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="{ang}"/></a:gradFill>"#
        ))
    };
    // 0°: left to right across the box, from the middle of its left edge.
    let p = placement(&lin("0"), 200.0, 100.0);
    assert_eq!(axis_start(&p, 200.0, 100.0), Some([0.0, 50.0]));
    // 90° in DrawingML (clockwise): top to bottom, from the top edge.
    let p = placement(&lin("5400000"), 200.0, 100.0);
    assert_eq!(p.angle, Some(-90.0));
    assert_eq!(axis_start(&p, 200.0, 100.0), Some([100.0, 0.0]));
    // 45°: top-left to bottom-right, from the top-left corner's projection.
    let p = placement(&lin("2700000"), 100.0, 100.0);
    let [x, y] = axis_start(&p, 100.0, 100.0).unwrap();
    assert!((x - 0.0).abs() < 1e-3 && (y - 0.0).abs() < 1e-3, "{x} {y}");
    // A radial gradient keeps the centre placement states.
    let rad = paint_of(
        r#"<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FFFFFF"/></a:gs><a:gs pos="100000"><a:srgbClr val="000000"/></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>"#,
    );
    let p = placement(&rad, 30.0, 40.0);
    assert_eq!(axis_start(&p, 30.0, 40.0), Some([15.0, 20.0]));
    assert_eq!(axis_start(&Placement::default(), 30.0, 40.0), None);
}
