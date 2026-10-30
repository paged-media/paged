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

//! Engine ADR 1008 — Photoshop is the oracle for the effect stack's
//! layer-style Stroke, Color Overlay and Gaussian Blur.
//!
//! `modules/image/scripts/photoshop/probes/effect-stack.jsx` (recorded with
//! Photoshop 27.10, see `fixtures/photoshop-effect-stack/
//! effect-stack.photoshop.json`) draws a black 32 px square on white in a
//! 64 px document at 72 ppi and applies each effect; this replays the same
//! square through the engine's stack at one pixel per pt and compares.
//!
//! Measured 2026-10-25: the overlay and the inside stroke agree exactly;
//! the outside and centred strokes differ only in the antialiasing of the
//! rounded outer corners (mean 0.11 and 0.02 levels); the blur at Photoshop
//! radius 3 against σ = 3 pt differs by at most 3 levels (mean 0.29), so
//! Photoshop's "Radius" is the Gaussian's σ. The thresholds hold those.

use std::io::Write;

use paged_gpu::RasterOptions;
use paged_model::effect_stack::{
    ColorOverlayParams, Effect, EffectBearing, EffectEntry, EffectTarget, GaussianBlurParams,
    OutlineStrokeParams, StrokePosition,
};
use paged_renderer::pipeline::{build_document, PipelineOptions};

const DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/photoshop-effect-stack/effect-stack"
);

fn idml() -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut put = |n: &str, b: &[u8]| {
        zip.start_file(n, o).unwrap();
        zip.write_all(b).unwrap();
    };
    put("mimetype", b"application/vnd.adobe.indesign-idml-package");
    put(
        "designmap.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    );
    put(
        "Resources/Graphic.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/K" Model="Process" Space="RGB" ColorValue="0 0 0" Name="K"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>"#,
    );
    put(
        "Spreads/Spread_sp1.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 64 64"/>
    <Rectangle Self="sq" GeometricBounds="16 16 48 48" FillColor="Color/K" StrokeWeight="0"/>
  </Spread>
</idPkg:Spread>"#,
    );
    zip.finish().unwrap().into_inner()
}

fn engine(stack: Vec<EffectEntry>) -> image::RgbaImage {
    let mut d = idml_import::import_idml_doc(&idml()).expect("import");
    d.spreads[0].spread.rectangles[0]
        .effect_slots_mut(EffectTarget::Object)
        .set_stack(stack)
        .expect("stack");
    let built = build_document(&d, &PipelineOptions::default()).expect("build");
    let mut opts = RasterOptions::new(64.0, 64.0);
    opts.dpi = 72.0;
    paged_gpu::rasterize(&built.pages.into_iter().next().unwrap().list, &opts)
}

fn photoshop(id: &str) -> image::RgbaImage {
    image::open(format!("{DIR}/{id}.png"))
        .expect("recorded PNG")
        .to_rgba8()
}

/// (worst channel delta, mean channel delta, pixels off by more than 32).
fn delta(a: &image::RgbaImage, b: &image::RgbaImage) -> (u8, f64, usize) {
    let (mut worst, mut sum, mut off) = (0u8, 0u64, 0usize);
    for (p, q) in a.pixels().zip(b.pixels()) {
        let mut px = 0u8;
        for c in 0..3 {
            let d = p.0[c].abs_diff(q.0[c]);
            px = px.max(d);
            sum += d as u64;
        }
        worst = worst.max(px);
        if px > 32 {
            off += 1;
        }
    }
    (worst, sum as f64 / (a.len() as f64 * 0.75), off)
}

fn stroke(position: StrokePosition) -> EffectEntry {
    EffectEntry::new(Effect::OutlineStroke(OutlineStrokeParams {
        size_pt: 4.0,
        position,
        color: Some("Color/Red".into()),
    }))
}

fn check(id: &str, stack: Vec<EffectEntry>, max_mean: f64, max_off: usize) {
    let (worst, mean, off) = delta(&engine(stack), &photoshop(id));
    eprintln!("{id}: worst {worst} mean {mean:.3} off {off}");
    assert!(
        mean <= max_mean && off <= max_off,
        "{id}: worst {worst}, mean {mean:.3}, {off} px off by > 32"
    );
}

#[test]
#[allow(non_snake_case)]
fn the_square_itself_agrees__feat__effects_transparency_effect_stack() {
    check("identity", Vec::new(), 0.01, 0);
}

#[test]
#[allow(non_snake_case)]
fn the_layer_style_stroke_agrees_with_photoshop__feat__effects_transparency_effect_stack() {
    check(
        "stroke-outside",
        vec![stroke(StrokePosition::Outside)],
        0.25,
        0,
    );
    check(
        "stroke-inside",
        vec![stroke(StrokePosition::Inside)],
        0.05,
        0,
    );
    check(
        "stroke-center",
        vec![stroke(StrokePosition::Center)],
        0.1,
        0,
    );
}

#[test]
#[allow(non_snake_case)]
fn the_color_overlay_agrees_with_photoshop__feat__effects_transparency_effect_stack() {
    check(
        "color-overlay",
        vec![EffectEntry::new(Effect::ColorOverlay(ColorOverlayParams {
            color: Some("Color/Red".into()),
        }))],
        0.01,
        0,
    );
}

#[test]
#[allow(non_snake_case)]
fn the_gaussian_blur_agrees_with_photoshop__feat__effects_transparency_effect_stack() {
    check(
        "gaussian-blur-3",
        vec![EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams {
            radius_pt: 3.0,
        }))],
        0.5,
        0,
    );
}
