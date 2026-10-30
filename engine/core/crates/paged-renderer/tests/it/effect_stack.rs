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

//! Engine ADR 1008 — the ordered effect stack, drawn.
//!
//! A black 100 pt square on a 200 pt page, drawn by the CPU rasterizer
//! with different stacks: the canonical stack draws exactly what no stack
//! draws (the display-list digest is unchanged); a Gaussian blur softens
//! the edge; an outline stroke paints a band outside it; the ORDER
//! decides whether the blur reaches the stroke; a disabled effect paints
//! nothing; the stack-only effects composite inside the object's own
//! group.

use std::io::Write;

use paged_compose::{DisplayCommand, LayerEffect};
use paged_gpu::RasterOptions;
use paged_model::effect_stack::{
    ColorAdjustParams, ColorOverlayParams, Effect, EffectBearing, EffectEntry, EffectTarget,
    GaussianBlurParams, IndesignEffect, NoiseParams, OutlineStrokeParams, ReflectionParams,
    SoftEdgeParams, StrokePosition,
};
use paged_renderer::pipeline::{build_document, PipelineOptions};
use paged_scene::Document;

const FEAT: &str = "effects-transparency.effect-stack";

fn idml(extra: &str) -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="Color/Black" StrokeWeight="0">{extra}</Rectangle>
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
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn doc(extra: &str) -> Document {
    idml_import::import_idml_doc(&idml(extra)).expect("import")
}

fn with_stack(mut d: Document, stack: Vec<EffectEntry>) -> Document {
    let r = &mut d.spreads[0].spread.rectangles[0];
    r.effect_slots_mut(EffectTarget::Object)
        .set_stack(stack)
        .expect("stack");
    d
}

fn list(d: &Document) -> paged_compose::DisplayList {
    let built = build_document(d, &PipelineOptions::default()).expect("build");
    built.pages.into_iter().next().expect("a page").list
}

/// The page at 72 dpi: one pixel per pt.
fn pixels(d: &Document) -> image::RgbaImage {
    let mut opts = RasterOptions::new(200.0, 200.0);
    opts.dpi = 72.0;
    paged_gpu::rasterize(&list(d), &opts)
}

fn luma(img: &image::RgbaImage, x: u32, y: u32) -> u8 {
    let p = img.get_pixel(x, y).0;
    ((p[0] as u32 + p[1] as u32 + p[2] as u32) / 3) as u8
}

fn blur(r: f32) -> EffectEntry {
    EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams { radius_pt: r }))
}

fn stroke(size: f32, position: StrokePosition, color: &str) -> EffectEntry {
    EffectEntry::new(Effect::OutlineStroke(OutlineStrokeParams {
        size_pt: size,
        position,
        color: Some(color.into()),
    }))
}

const SHADOW: &str = r#"<Properties/><TransparencySetting><DropShadowSetting Mode="Drop" XOffset="7" YOffset="7" Size="5" Opacity="75"/><OuterGlowSetting Applied="true" Size="6" Opacity="80" EffectColor="Color/Red"/></TransparencySetting>"#;

#[test]
fn the_canonical_stack_draws_what_no_stack_draws() {
    let _ = FEAT;
    let plain = doc(SHADOW);
    let before = list(&plain).digest();
    let resolved = plain.spreads[0].spread.rectangles[0]
        .effect_slots(EffectTarget::Object)
        .resolved();
    assert!(!resolved.is_empty(), "the fixture's shadow is read");
    let d = with_stack(plain, resolved);
    assert!(d.spreads[0].spread.rectangles[0].effect_stack.is_empty());
    assert_eq!(list(&d).digest(), before);
}

#[test]
#[allow(non_snake_case)]
fn a_blur_softens_the_edge__feat__effects_transparency_effect_stack() {
    let sharp = pixels(&doc(""));
    let soft = pixels(&with_stack(doc(""), vec![blur(4.0)]));
    // On the edge (x = 50): sharp is black inside, white outside; the
    // blur grades it.
    assert!(luma(&sharp, 47, 100) > 250 && luma(&sharp, 52, 100) < 5);
    let (outside, inside) = (luma(&soft, 47, 100), luma(&soft, 52, 100));
    assert!(
        outside < 230 && outside > 128,
        "outside the edge: {outside}"
    );
    assert!(inside > 25 && inside < 128, "inside the edge: {inside}");
    // The middle stays black.
    assert!(luma(&soft, 100, 100) < 5);
    let l = list(&with_stack(doc(""), vec![blur(4.0)]));
    assert!(l.commands.iter().any(|c| matches!(
        c,
        DisplayCommand::PushLayer {
            effect: LayerEffect::GaussianBlur { .. },
            ..
        }
    )));
}

#[test]
#[allow(non_snake_case)]
fn an_outline_stroke_sits_outside_inside_or_on_the_edge__feat__effects_transparency_effect_stack() {
    let red = |img: &image::RgbaImage, x, y| {
        let p = img.get_pixel(x, y).0;
        p[0] > 200 && p[1] < 60 && p[2] < 60
    };
    let out = pixels(&with_stack(
        doc(""),
        vec![stroke(6.0, StrokePosition::Outside, "Color/Red")],
    ));
    assert!(red(&out, 47, 100), "the band is outside the edge");
    assert!(!red(&out, 53, 100), "and not inside it");
    assert!(luma(&out, 40, 100) > 250, "6 pt wide");
    let inside = pixels(&with_stack(
        doc(""),
        vec![stroke(6.0, StrokePosition::Inside, "Color/Red")],
    ));
    assert!(red(&inside, 53, 100) && !red(&inside, 47, 100));
    let centre = pixels(&with_stack(
        doc(""),
        vec![stroke(6.0, StrokePosition::Center, "Color/Red")],
    ));
    assert!(red(&centre, 48, 100) && red(&centre, 52, 100));
}

#[test]
#[allow(non_snake_case)]
fn the_order_decides_what_a_blur_reaches__feat__effects_transparency_effect_stack() {
    // Stroke, then blur: the blur takes the stroke with it.
    let stroke_then_blur = pixels(&with_stack(
        doc(""),
        vec![stroke(6.0, StrokePosition::Outside, "Color/Red"), blur(3.0)],
    ));
    // Blur, then stroke: the stroke is drawn crisp over the blurred
    // square.
    let blur_then_stroke = pixels(&with_stack(
        doc(""),
        vec![blur(3.0), stroke(6.0, StrokePosition::Outside, "Color/Red")],
    ));
    let at = |img: &image::RgbaImage| img.get_pixel(45, 100).0;
    let crisp = at(&blur_then_stroke);
    let soft = at(&stroke_then_blur);
    assert!(crisp[0] > 240 && crisp[1] < 20, "crisp red band: {crisp:?}");
    assert!(
        soft[1] > crisp[1] + 20 || soft[0] < crisp[0],
        "a softened band: {soft:?}"
    );
    // The outer edge of the band (x = 44) is hard in the second, graded
    // in the first.
    assert!(luma(&blur_then_stroke, 42, 100) > 250);
    assert!(luma(&stroke_then_blur, 42, 100) < 250);
}

#[test]
#[allow(non_snake_case)]
fn a_disabled_effect_paints_nothing__feat__effects_transparency_effect_stack() {
    let plain = doc(SHADOW);
    let mut stack = plain.spreads[0].spread.rectangles[0]
        .effect_slots(EffectTarget::Object)
        .resolved();
    for e in &mut stack {
        e.enabled = false;
    }
    let d = with_stack(plain, stack);
    let l = list(&d);
    assert!(!l.commands.iter().any(|c| matches!(
        c,
        DisplayCommand::DropShadow { .. } | DisplayCommand::OuterGlow { .. }
    )));
    assert_eq!(
        list(&doc("")).digest(),
        l.digest(),
        "as if it had no effects"
    );
}

#[test]
#[allow(non_snake_case)]
fn indesign_effects_follow_a_custom_order__feat__effects_transparency_effect_stack() {
    // A blur FIRST, then InDesign's drop shadow: the shadow is the
    // outline's, drawn under the blurred object (outside its layer).
    let plain = doc(SHADOW);
    let d = with_stack(
        plain,
        vec![
            blur(3.0),
            EffectEntry::new(Effect::slot(IndesignEffect::DropShadow)),
        ],
    );
    let l = list(&d);
    let shadow = l
        .commands
        .iter()
        .position(|c| matches!(c, DisplayCommand::DropShadow { .. }))
        .expect("the shadow is drawn");
    let layer = l
        .commands
        .iter()
        .position(|c| {
            matches!(
                c,
                DisplayCommand::PushLayer {
                    effect: LayerEffect::GaussianBlur { .. },
                    ..
                }
            )
        })
        .expect("the blur layer");
    assert!(shadow < layer, "the shadow sits under the blur layer");
    // The outer glow was left out of the stack: it is gone.
    assert!(!l
        .commands
        .iter()
        .any(|c| matches!(c, DisplayCommand::OuterGlow { .. })));
}

#[test]
#[allow(non_snake_case)]
fn every_stack_only_effect_draws__feat__effects_transparency_effect_stack() {
    let plain = pixels(&doc(""));
    let cases: Vec<(&str, EffectEntry, (u32, u32))> = vec![
        (
            "colorOverlay",
            EffectEntry::new(Effect::ColorOverlay(ColorOverlayParams {
                color: Some("Color/Red".into()),
            })),
            (100, 100),
        ),
        (
            "gradientOverlay",
            EffectEntry::new(Effect::GradientOverlay(Default::default())),
            (140, 100),
        ),
        (
            "reflection",
            EffectEntry::new(Effect::Reflection(ReflectionParams {
                distance_pt: 2.0,
                ..Default::default()
            })),
            (100, 155),
        ),
        (
            "softEdge",
            EffectEntry::new(Effect::SoftEdge(SoftEdgeParams { size_pt: 8.0 })),
            (51, 100),
        ),
        (
            "colorAdjust",
            EffectEntry::new(Effect::ColorAdjust(ColorAdjustParams {
                brightness: 60.0,
                ..Default::default()
            })),
            (100, 100),
        ),
        (
            "noise",
            EffectEntry::new(Effect::Noise(NoiseParams {
                amount_pct: 40.0,
                monochromatic: true,
            })),
            (0, 0),
        ),
    ];
    for (name, entry, (x, y)) in cases {
        let img = pixels(&with_stack(doc(""), vec![entry]));
        if name == "noise" {
            // Somewhere in the square the grain lifts black.
            let lifted = (55..145).any(|x| luma(&img, x, 100) > 10);
            assert!(lifted, "noise grains the square");
            continue;
        }
        assert_ne!(
            img.get_pixel(x, y).0,
            plain.get_pixel(x, y).0,
            "{name} changes ({x}, {y})"
        );
    }
}

#[test]
#[allow(non_snake_case)]
fn an_entry_blend_and_opacity_composite_the_effect__feat__effects_transparency_effect_stack() {
    let mut e = stroke(6.0, StrokePosition::Outside, "Color/Red");
    e.opacity_pct = Some(50.0);
    let img = pixels(&with_stack(doc(""), vec![e]));
    let p = img.get_pixel(47, 100).0;
    // Half red over white.
    assert!(p[0] > 240 && (100..160).contains(&p[1]), "{p:?}");
}
