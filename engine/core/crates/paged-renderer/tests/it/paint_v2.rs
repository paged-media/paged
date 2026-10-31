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

//! Engine ADR 1007 — paint model v2 through the renderer: a stop's
//! opacity and inline colour, the conic kind, and a gradient stroke
//! mapped along or across its path.
//!
//! The `__feat__color_swatches_paint_v2` suffix links these tests to the
//! `color-swatches.paint-v2` feature row (hence the lint allowance).
#![allow(non_snake_case)]

use std::io::Write;

use paged_compose::{Color, DisplayCommand, Paint};
use paged_model::{ColorSpace, GradientKind, InlineStopColor, StrokeGradientMode};
use paged_renderer::pipeline::{self, PipelineOptions};
use paged_scene::Document;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A 400 × 300 page with `item`; the palette has Sun (255 200 80), Sky
/// (60 120 220) and a linear `Gradient/Ramp` Sun → Sky.
fn idml(item: &str) -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", o).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    zip.start_file("designmap.xml", o).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", o).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic>
    <Color Self="Color/Sun" Name="Sun" Space="RGB" ColorValue="255 200 80"/>
    <Color Self="Color/Sky" Name="Sky" Space="RGB" ColorValue="60 120 220"/>
    <Gradient Self="Gradient/Ramp" Name="Ramp" Type="Linear">
      <GradientStop StopColor="Color/Sun" Location="0"/>
      <GradientStop StopColor="Color/Sky" Location="100"/>
    </Gradient>
  </Graphic>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", o).unwrap();
    zip.write_all(
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 300 400"/>
    {item}
  </Spread>
</idPkg:Spread>"#
        )
        .as_bytes(),
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

/// A 200 × 200 square at x 100..300, y 50..250.
const SQUARE_FILL: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Gradient/Ramp" StrokeWeight="0"/>"#;
const SQUARE_STROKE: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Swatch/None" StrokeColor="Gradient/Ramp" StrokeWeight="20"/>"#;

fn doc(item: &str) -> Document {
    idml_import::import_idml_doc(&idml(item)).expect("import")
}

fn render(doc: &Document) -> (Vec<DisplayCommand>, image::RgbaImage) {
    let (built, images) =
        pipeline::render_document(doc, &PipelineOptions::default(), 72.0, Color::WHITE)
            .expect("render");
    (
        built.pages[0].list.commands.clone(),
        images.into_iter().next().unwrap(),
    )
}

fn px(img: &image::RgbaImage, x: u32, y: u32) -> [i32; 3] {
    let p = img.get_pixel(x, y).0;
    [i32::from(p[0]), i32::from(p[1]), i32::from(p[2])]
}

fn dist(a: [i32; 3], b: [i32; 3]) -> i32 {
    (0..3).map(|i| (a[i] - b[i]).abs()).max().unwrap_or(0)
}

const SUN: [i32; 3] = [255, 200, 80];
const SKY: [i32; 3] = [60, 120, 220];
const WHITE: [i32; 3] = [255, 255, 255];

fn ramp(d: &mut Document) -> &mut paged_model::GradientEntry {
    d.palette.gradients.get_mut("Gradient/Ramp").unwrap()
}

fn rect(d: &mut Document) -> &mut paged_model::Rectangle {
    &mut d.spreads[0].spread.rectangles[0]
}

#[test]
fn an_opacity_stop_fades_the_fill_to_the_page__feat__color_swatches_paint_v2() {
    let mut d = doc(SQUARE_FILL);
    ramp(&mut d).stops[1].opacity_pct = Some(0.0);
    let (_, img) = render(&d);
    assert!(
        dist(px(&img, 102, 150), SUN) < 12,
        "opaque Sun at the start"
    );
    assert!(
        dist(px(&img, 298, 150), WHITE) < 12,
        "transparent at the end: {:?}",
        px(&img, 298, 150)
    );
    // Half way: half the colour blend over the white page, alpha 0.5.
    let mid = px(&img, 200, 150);
    assert!(
        dist(mid, WHITE) > 20 && dist(mid, SUN) > 20,
        "between: {mid:?}"
    );
}

#[test]
fn an_inline_stop_colour_needs_no_swatch__feat__color_swatches_paint_v2() {
    let mut d = doc(SQUARE_FILL);
    let s = &mut ramp(&mut d).stops[0];
    s.stop_color = String::new();
    s.inline_color = Some(InlineStopColor {
        space: ColorSpace::Rgb,
        value: vec![255.0, 0.0, 0.0],
    });
    let (_, img) = render(&d);
    assert!(
        dist(px(&img, 102, 150), [255, 0, 0]) < 16,
        "the inline red: {:?}",
        px(&img, 102, 150)
    );
    assert!(dist(px(&img, 298, 150), SKY) < 16, "the Sky swatch");
}

#[test]
fn a_conic_gradient_turns_about_the_centre_from_its_angle__feat__color_swatches_paint_v2() {
    for angle in [None, Some(90.0)] {
        let mut d = doc(SQUARE_FILL);
        ramp(&mut d).kind = GradientKind::Conic;
        rect(&mut d).gradient_fill_angle = angle;
        let (cmds, img) = render(&d);
        assert!(
            cmds.iter().any(|c| matches!(
                c,
                DisplayCommand::FillPath {
                    paint: Paint::SweepGradient(_),
                    ..
                }
            )),
            "a conic fill is a sweep paint"
        );
        // Just past the start (the ramp turns clockwise on the page) it is
        // still Sun; half a turn on it is half way to Sky. 0° starts on +x;
        // 90° (counter-clockwise on the page, like a linear angle) starts
        // straight up.
        let (start, opposite) = match angle {
            None => ((240, 152), (160, 148)),
            _ => ((202, 110), (198, 190)),
        };
        let at_start = px(&img, start.0, start.1);
        assert!(
            dist(at_start, SUN) < 24,
            "{angle:?}: Sun at the start: {at_start:?}"
        );
        let half = px(&img, opposite.0, opposite.1);
        assert!(
            dist(half, SUN) > 40 && dist(half, SKY) > 40,
            "{angle:?}: half way opposite: {half:?}"
        );
    }
}

/// The colour of the top edge's and the bottom edge's middle, and of the
/// top edge's outer and inner side, for `mode`.
fn stroke_probe(
    mode: StrokeGradientMode,
    translucent: bool,
) -> (Vec<DisplayCommand>, [[i32; 3]; 4]) {
    let mut d = doc(SQUARE_STROKE);
    rect(&mut d).gradient_stroke_mode = mode;
    if translucent {
        ramp(&mut d).stops[1].opacity_pct = Some(20.0);
    }
    let (cmds, img) = render(&d);
    (
        cmds,
        [
            px(&img, 200, 50),
            px(&img, 200, 250),
            px(&img, 200, 41),
            px(&img, 200, 59),
        ],
    )
}

#[test]
fn a_stroke_within_paints_the_frames_gradient__feat__color_swatches_paint_v2() {
    let (cmds, [top, bottom, outer, inner]) = stroke_probe(StrokeGradientMode::Within, false);
    // A 0° ramp depends on x alone.
    assert!(dist(top, bottom) < 6 && dist(outer, inner) < 6);
    assert!(cmds.iter().any(|c| matches!(
        c,
        DisplayCommand::StrokePath {
            paint: Paint::LinearGradient(_),
            ..
        }
    )));
}

#[test]
fn a_stroke_along_runs_the_ramp_along_the_path__feat__color_swatches_paint_v2() {
    let (cmds, [top, bottom, outer, inner]) = stroke_probe(StrokeGradientMode::Along, false);
    assert!(
        dist(top, bottom) > 40,
        "the ramp has moved on between the edges: {top:?} {bottom:?}"
    );
    assert!(dist(outer, inner) < 8, "and is the same across the stroke");
    assert!(
        !cmds
            .iter()
            .any(|c| matches!(c, DisplayCommand::StrokePath { .. })),
        "the stroke is laid down as bands"
    );
    let bands = cmds
        .iter()
        .filter(|c| {
            matches!(
                c,
                DisplayCommand::FillPath {
                    paint: Paint::Solid(_),
                    ..
                }
            )
        })
        .count();
    assert!(bands >= 64, "{bands} bands");
    assert!(cmds
        .iter()
        .any(|c| matches!(c, DisplayCommand::PushClip { .. })));
}

#[test]
fn a_stroke_across_runs_the_ramp_edge_to_edge__feat__color_swatches_paint_v2() {
    let (_, [top, bottom, outer, inner]) = stroke_probe(StrokeGradientMode::Across, false);
    assert!(
        dist(outer, inner) > 60,
        "one edge to the other: {outer:?} {inner:?}"
    );
    assert!(
        dist(top, bottom) < 10,
        "every edge alike at its middle: {top:?} {bottom:?}"
    );
    // The two sides are the ramp's two ends (which is which follows the
    // path's direction; the line test pins the convention).
    let ends = (
        dist(outer, SUN).min(dist(outer, SKY)),
        dist(inner, SUN).min(dist(inner, SKY)),
    );
    assert!(ends.0 < 40 && ends.1 < 40, "{outer:?} {inner:?}");
}

#[test]
fn a_translucent_stroke_along_draws_under_its_alpha__feat__color_swatches_paint_v2() {
    let (cmds, [_, bottom, ..]) = stroke_probe(StrokeGradientMode::Along, true);
    assert!(cmds
        .iter()
        .any(|c| matches!(c, DisplayCommand::BeginSoftMask { .. })));
    let (_, [_, opaque_bottom, ..]) = stroke_probe(StrokeGradientMode::Along, false);
    assert!(
        dist(bottom, WHITE) < dist(opaque_bottom, WHITE),
        "the far side fades toward the page: {bottom:?} vs {opaque_bottom:?}"
    );
}

#[test]
fn a_line_strokes_along_its_length__feat__color_swatches_paint_v2() {
    let line = r#"<GraphicLine Self="l1" StrokeColor="Gradient/Ramp" StrokeWeight="12">
      <Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray>
        <PathPointType Anchor="50 150" LeftDirection="50 150" RightDirection="50 150"/>
        <PathPointType Anchor="350 150" LeftDirection="350 150" RightDirection="350 150"/>
      </PathPointArray></GeometryPathType></PathGeometry></Properties>
    </GraphicLine>"#;
    let mut d = doc(line);
    d.spreads[0].spread.graphic_lines[0].gradient_stroke_mode = StrokeGradientMode::Along;
    let (_, img) = render(&d);
    assert!(dist(px(&img, 52, 150), SUN) < 20, "{:?}", px(&img, 52, 150));
    assert!(
        dist(px(&img, 348, 150), SKY) < 20,
        "{:?}",
        px(&img, 348, 150)
    );
}

/// GPU/CPU parity (ADR 146) of the banded stroke, on the GPU lane only.
#[cfg(feature = "gpu")]
#[test]
fn a_mapped_stroke_draws_alike_on_both_lanes__feat__color_swatches_paint_v2() {
    use paged_gpu::{PathRasterizer, RasterOptions};
    for (mode, translucent) in [
        (StrokeGradientMode::Along, false),
        (StrokeGradientMode::Across, true),
    ] {
        let mut d = doc(SQUARE_STROKE);
        rect(&mut d).gradient_stroke_mode = mode;
        if translucent {
            ramp(&mut d).stops[1].opacity_pct = Some(20.0);
        }
        let built = pipeline::build_document(&d, &PipelineOptions::default()).expect("build");
        let list = &built.pages[0].list;
        let mut opts = RasterOptions::new(400.0, 300.0);
        opts.dpi = 72.0;
        opts.background = Color::WHITE;
        let gpu = paged_gpu::VelloRasterizer::new().rasterize(list, &opts);
        if gpu.iter().all(|b| *b == 0) {
            paged_test_resources::unavailable(
                paged_test_resources::Resource::Gpu,
                "no GPU adapter",
            );
            return;
        }
        let cpu = paged_gpu::CpuRasterizer.rasterize(list, &opts);
        let far = gpu
            .chunks_exact(4)
            .zip(cpu.chunks_exact(4))
            .filter(|(g, c)| (0..4).any(|i| g[i].abs_diff(c[i]) > 8))
            .count();
        assert!(far <= 200, "{mode:?}: lanes differ by > 8 on {far} pixels");
    }
}
