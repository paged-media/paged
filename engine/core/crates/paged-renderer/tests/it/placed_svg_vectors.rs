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

//! A placed SVG is drawn as vectors (ADR 190, amendment of 2026-10-20).
//!
//! The frame's display list carries the SVG's own paths, strokes,
//! gradients, clip and groups under the placement the raster took, and
//! no image; its pixels match the SVG rasterized at the render's own
//! resolution, where the raster it replaces was one pixel per user unit
//! at every zoom. An SVG the list cannot express keeps its raster.

use std::io::Write;

use paged_compose::{Color, DisplayCommand};
use paged_renderer::{pipeline, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// 120 × 80 user units: a dashed stroke, an even-odd ring, a linear and a
/// radial gradient, a clip path, a group at 50 % and a multiply group.
const ART: &str = include_str!("../../../../corpus/generated-fixtures/svg-vectors/art.svg");

/// A one-spread package whose only item is `rect`.
fn package(rect: &str) -> Vec<u8> {
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
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 120 160"/>
    {rect}
  </Spread>
</idPkg:Spread>"#
    );
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

/// The frame (20, 20)–(140, 100), placing `link` with `transform`; it
/// crops the art's right-hand 10 units.
fn frame(link: &str, transform: &str) -> Vec<u8> {
    package(&format!(
        r#"<Rectangle Self="r1" GeometricBounds="20 20 100 130" StrokeWeight="0">
      <Image Self="i1" ItemTransform="{transform}" LinkResourceURI="{link}"/>
    </Rectangle>"#
    ))
}

fn options(br: &paged_renderer::BytesResolver) -> PipelineOptions<'_> {
    PipelineOptions {
        assets: Some(br),
        ..PipelineOptions::default()
    }
}

fn resolver(name: &str, bytes: Vec<u8>) -> paged_renderer::BytesResolver {
    let mut br = paged_renderer::BytesResolver::new();
    br.add_image(name, bytes);
    br
}

fn render(idml: &[u8], br: &paged_renderer::BytesResolver, dpi: f32) -> image::RgbaImage {
    let document = idml_import::import_idml_doc(idml).unwrap();
    let (_built, images) =
        pipeline::render_document(&document, &options(br), dpi, Color::WHITE).unwrap();
    images.into_iter().next().unwrap()
}

/// The art rasterized `scale` pixels per user unit, as a PNG.
fn raster_png(svg: &str, scale: f32) -> Vec<u8> {
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default()).unwrap();
    let (w, h) = ((120.0 * scale) as u32, (80.0 * scale) as u32);
    let rgba = paged_gpu::svg::rasterize_svg(&tree, w, h, scale).unwrap();
    let img = image::RgbaImage::from_raw(w, h, rgba).unwrap();
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

/// Mean absolute channel difference (0..255) over the frame's pixels,
/// and the share of them more than 32 apart in some channel.
fn difference(a: &image::RgbaImage, b: &image::RgbaImage, px_per_pt: f32) -> (f32, f32) {
    let (x0, y0) = ((20.0 * px_per_pt) as u32, (20.0 * px_per_pt) as u32);
    let (x1, y1) = ((130.0 * px_per_pt) as u32, (100.0 * px_per_pt) as u32);
    let (mut sum, mut far, mut n) = (0.0f64, 0usize, 0usize);
    for y in y0..y1 {
        for x in x0..x1 {
            let (p, q) = (a.get_pixel(x, y).0, b.get_pixel(x, y).0);
            let d: Vec<i32> = (0..3).map(|i| (p[i] as i32 - q[i] as i32).abs()).collect();
            sum += d.iter().sum::<i32>() as f64 / 3.0;
            if d.iter().any(|v| *v > 32) {
                far += 1;
            }
            n += 1;
        }
    }
    ((sum / n as f64) as f32, far as f32 / n as f32)
}

#[test]
fn a_placed_svg_emits_vector_commands_and_no_image() {
    let br = resolver("art.svg", ART.as_bytes().to_vec());
    let document = idml_import::import_idml_doc(&frame("art.svg", "1 0 0 1 20 20")).unwrap();
    let built = pipeline::build_document(&document, &options(&br)).unwrap();
    let list = &built.pages[0].list;
    let count = |f: fn(&DisplayCommand) -> bool| list.commands.iter().filter(|c| f(c)).count();
    assert_eq!(count(|c| matches!(c, DisplayCommand::Image { .. })), 0);
    assert!(list.images.is_empty(), "no raster of the SVG is decoded");
    // Background, ring, gradient rect, circle, clipped rect, two group
    // rects, multiply rect.
    assert_eq!(count(|c| matches!(c, DisplayCommand::FillPath { .. })), 8);
    let dashed = list.commands.iter().find_map(|c| match c {
        DisplayCommand::StrokePath { stroke, .. } => Some(*stroke),
        _ => None,
    });
    assert!(dashed.is_some_and(|s| s.width == 2.0 && s.dash.as_slice() == [6.0, 3.0]));
    assert_eq!(list.gradients.len(), 1);
    assert_eq!(list.radial_gradients.len(), 1);
    // The frame clip, the SVG canvas clip, the disc, and the two
    // gradient fills (each a square clipped by its path).
    assert_eq!(count(|c| matches!(c, DisplayCommand::PushClip { .. })), 5);
    assert_eq!(count(|c| matches!(c, DisplayCommand::PopClip(_))), 5);
    let groups: Vec<_> = list
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::BeginBlendGroup {
                blend_mode,
                opacity,
                ..
            } => Some((*blend_mode, *opacity)),
            _ => None,
        })
        .collect();
    assert!(groups.contains(&(paged_compose::BlendMode::Normal, 0.5)));
    assert!(groups.contains(&(paged_compose::BlendMode::Multiply, 1.0)));
    // The art rides the placement: the ring's outer corner (10, 10)
    // lands at the frame's (20, 20) plus that.
    let ring = list
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::FillPath { path_id, .. } => list.paths.get(*path_id),
            _ => None,
        })
        .nth(1)
        .unwrap();
    assert!(matches!(
        ring.segments[0],
        paged_compose::PathSegment::MoveTo { x, y } if x == 30.0 && y == 30.0
    ));
}

#[test]
fn a_placed_svg_matches_its_raster_at_the_render_resolution() {
    // At 3x, the vectors against the SVG rasterized at 3x and placed at a
    // third (the ideal), and against the raster this replaces (one pixel
    // per unit, scaled up three times).
    let dpi = 216.0;
    let k = dpi / 72.0;
    let vectors = render(
        &frame("art.svg", "1 0 0 1 20 20"),
        &resolver("art.svg", ART.as_bytes().to_vec()),
        dpi,
    );
    let third = 1.0 / k;
    let sharp = render(
        &frame("art.png", &format!("{third} 0 0 {third} 20 20")),
        &resolver("art.png", raster_png(ART, k)),
        dpi,
    );
    let coarse = render(
        &frame("art.png", "1 0 0 1 20 20"),
        &resolver("art.png", raster_png(ART, 1.0)),
        dpi,
    );
    let (mean, far) = difference(&vectors, &sharp, k);
    assert!(
        mean < 0.5 && far < 0.002,
        "vectors vs the 3x raster: mean {mean}, far {far}"
    );
    let (coarse_mean, coarse_far) = difference(&coarse, &sharp, k);
    eprintln!("vectors: mean {mean}, far {far}; 1x raster: mean {coarse_mean}, far {coarse_far}");
    assert!(
        coarse_mean > 10.0 * mean,
        "the 1x raster ({coarse_mean}) is further from the 3x raster than the vectors ({mean})"
    );
}

#[test]
fn a_placed_svg_with_a_filter_keeps_its_raster() {
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">
  <filter id="b"><feGaussianBlur stdDeviation="2"/></filter>
  <rect x="10" y="10" width="40" height="40" fill="red" filter="url(#b)"/></svg>"#;
    let br = resolver("art.svg", svg.as_bytes().to_vec());
    let document = idml_import::import_idml_doc(&frame("art.svg", "1 0 0 1 20 20")).unwrap();
    let built = pipeline::build_document(&document, &options(&br)).unwrap();
    let list = &built.pages[0].list;
    let images = list
        .commands
        .iter()
        .filter(|c| matches!(c, DisplayCommand::Image { .. }))
        .count();
    assert_eq!(images, 1);
}
