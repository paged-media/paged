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

//! Engine ADR 10XX — stroke styles, drawn: a width profile and a brush
//! draw the stroke as artwork in the stroke's colour, and the item's fill
//! stays on the source outline (the split); both rasterizers agree.

use std::io::Write;

use paged_gpu::RasterOptions;
use paged_model::effect_stack::{Effect, EffectEntry};
use paged_model::vector_effect::*;
use paged_renderer::pipeline::{build_document, PipelineOptions};
use paged_scene::Document;

fn idml(items: &str) -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    {items}
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

/// A black square with a 6 pt red stroke.
const SQUARE: &str = r#"<Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="Color/Black" StrokeColor="Color/Red" StrokeWeight="6"/>"#;
/// A red 8 pt open line, no fill.
const LINE: &str = r#"<Polygon Self="ln" FillColor="Swatch/None" StrokeColor="Color/Red" StrokeWeight="8" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray><PathPointType Anchor="20 100" LeftDirection="20 100" RightDirection="20 100"/><PathPointType Anchor="180 100" LeftDirection="180 100" RightDirection="180 100"/></PathPointArray></GeometryPathType></PathGeometry></Properties></Polygon>"#;

fn doc(items: &str) -> Document {
    idml_import::import_idml_doc(&idml(items)).expect("import")
}

fn list(d: &Document) -> paged_compose::DisplayList {
    let built = build_document(d, &PipelineOptions::default()).expect("build");
    built.pages.into_iter().next().expect("a page").list
}

fn opts() -> RasterOptions {
    let mut o = RasterOptions::new(200.0, 200.0);
    o.dpi = 72.0;
    o
}

fn pixels(d: &Document) -> image::RgbaImage {
    paged_gpu::rasterize(&list(d), &opts())
}

fn rgb(img: &image::RgbaImage, x: u32, y: u32) -> [u8; 3] {
    let p = img.get_pixel(x, y).0;
    [p[0], p[1], p[2]]
}

fn is_red(c: [u8; 3]) -> bool {
    c[0] > 180 && c[1] < 80 && c[2] < 80
}

fn lens() -> EffectEntry {
    EffectEntry::new(Effect::WidthProfile(
        WidthProfileParams {
            points: vec![
                WidthPoint { t: 0.0, width: 0.2 },
                WidthPoint { t: 0.5, width: 2.0 },
                WidthPoint { t: 1.0, width: 0.2 },
            ],
        }
        .normalized(),
    ))
}

#[test]
#[allow(non_snake_case)]
fn a_width_profile_swells_the_stroke_and_keeps_the_fill__feat__plugin_draw_brushes_width() {
    let plain = pixels(&doc(SQUARE));
    let mut d = doc(SQUARE);
    d.spreads[0].spread.rectangles[0].effect_stack = vec![lens()];
    let img = pixels(&d);
    // The fill is the source square's: black in the middle.
    assert!(
        rgb(&img, 100, 100).iter().all(|c| *c < 60),
        "the fill stays"
    );
    // The contour starts at the top-left corner; half way round (the
    // bottom-right corner) the band is 12 pt wide, 6 pt outside.
    assert!(
        !is_red(rgb(&plain, 154, 154)),
        "the plain stroke is 3 pt out"
    );
    assert!(is_red(rgb(&img, 154, 154)), "the swollen band reaches it");
    // Near the start it has narrowed to 1.2 pt.
    assert!(!is_red(rgb(&img, 47, 52)));
}

#[test]
fn a_brush_draws_its_artwork_in_the_stroke_colour() {
    let mut d = doc(LINE);
    d.spreads[0].spread.polygons[0].effect_stack =
        vec![EffectEntry::new(Effect::Brush(BrushParams {
            brush_type: BrushKind::Pattern,
            ..Default::default()
        }))];
    let img = pixels(&d);
    // 8 pt diamonds along the line: a diamond's centre is red, the point
    // where two meet is barely painted above and below.
    assert!(is_red(rgb(&img, 24, 100)));
    assert!(!is_red(rgb(&img, 28, 97)));
    // A switched-off stroke style draws the plain stroke.
    let mut off = d.clone();
    off.spreads[0].spread.polygons[0].effect_stack[0].enabled = false;
    assert_eq!(list(&off).digest(), list(&doc(LINE)).digest());
}

#[cfg(feature = "gpu")]
#[test]
#[allow(non_snake_case)]
fn both_lanes_draw_stroke_styles_alike__feat__plugin_draw_brushes_width() {
    use paged_gpu::vello_rs::VelloRasterizer;
    use paged_gpu::{CpuRasterizer, PathRasterizer};
    use paged_test_resources::{skip, Resource};
    let mut d = doc(&format!("{SQUARE}{LINE}"));
    d.spreads[0].spread.rectangles[0].effect_stack = vec![lens()];
    d.spreads[0].spread.polygons[0].effect_stack =
        vec![EffectEntry::new(Effect::Brush(BrushParams {
            brush_type: BrushKind::Scatter,
            spacing_pct: 150.0,
            seed: 2,
            ..Default::default()
        }))];
    let l = list(&d);
    let cpu = CpuRasterizer.rasterize(&l, &opts());
    let gpu = VelloRasterizer::new().rasterize(&l, &opts());
    if paged_test_resources::gpu_forced_off() {
        skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
    }
    if gpu.iter().all(|b| *b == 0) {
        skip!(
            Resource::Gpu,
            "no wgpu adapter: Vello returned its zero-fill fallback"
        );
    }
    let differ = cpu
        .chunks(4)
        .zip(gpu.chunks(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 96))
        .count();
    assert!(
        differ * 100 < cpu.len() / 4,
        "{differ} pixels differ between the lanes"
    );
}
