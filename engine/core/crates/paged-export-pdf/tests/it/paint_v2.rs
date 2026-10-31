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

//! Engine ADR 1007 — paint model v2 in the PDF: a conic gradient is a
//! type-1 shading over a calculator function, a translucent ramp paints
//! under a luminosity soft mask of its alpha, and a stroke mapped along
//! its path arrives as bands. Where poppler is installed the exported page
//! is rasterised and held to the canvas's colours.
#![allow(non_snake_case)]

use std::io::Write;

use lopdf::{Dictionary, Object};
use paged_color::{DisplaySetup, IccCmm};
use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::{GradientKind, StrokeGradientMode};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_scene::Document;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A 400 × 300 page with `item`; the palette's `Gradient/Ramp` runs Sun
/// (255 200 80) → Sky (60 120 220).
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

const SQUARE_FILL: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Gradient/Ramp" StrokeWeight="0"/>"#;
const SQUARE_STROKE: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Swatch/None" StrokeColor="Gradient/Ramp" StrokeWeight="20"/>"#;

fn doc(item: &str, edit: impl FnOnce(&mut Document)) -> Document {
    let mut d = idml_import::import_idml_doc(&idml(item)).expect("import");
    edit(&mut d);
    d
}

fn export(document: &Document) -> Vec<u8> {
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(document, &opts);
    let built = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            ..PipelineOptions::default()
        };
        pipeline::build_document(document, &o).expect("build document")
    };
    let cmm = IccCmm::new(None, DisplaySetup::default());
    export_pdf(ExportInput {
        doc: &built,
        palette: &document.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions::default(),
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes
}

fn dicts(pdf: &[u8]) -> Vec<Dictionary> {
    let parsed = lopdf::Document::load_mem(pdf).expect("re-parse");
    parsed
        .objects
        .values()
        .filter_map(|o| match o {
            Object::Dictionary(d) => Some(d.clone()),
            Object::Stream(s) => Some(s.dict.clone()),
            _ => None,
        })
        .collect()
}

fn int(d: &Dictionary, key: &[u8]) -> Option<i64> {
    d.get(key).ok().and_then(|v| v.as_i64().ok())
}

fn name<'a>(d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    d.get(key).ok().and_then(|v| v.as_name().ok())
}

fn luminosity_masks(pdf: &[u8]) -> usize {
    dicts(pdf)
        .iter()
        .filter_map(|d| d.get(b"SMask").ok())
        .filter_map(|v| v.as_dict().ok())
        .filter(|sm| name(sm, b"S") == Some(b"Luminosity"))
        .count()
}

fn gray_shadings(pdf: &[u8]) -> usize {
    dicts(pdf)
        .iter()
        .filter(|d| {
            int(d, b"ShadingType").is_some() && name(d, b"ColorSpace") == Some(b"DeviceGray")
        })
        .count()
}

/// The page rasterised by poppler at 72 dpi, or `None` without it.
fn rasterise(pdf: &[u8], tag: &str) -> Option<image::RgbImage> {
    paged_test_resources::tool("pdftoppm")?;
    let dir = std::env::temp_dir().join(format!("paged-paint2-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let pdf_path = dir.join("page.pdf");
    std::fs::write(&pdf_path, pdf).expect("write pdf");
    let status = std::process::Command::new("pdftoppm")
        .args(["-r", "72", "-png", "-singlefile"])
        .arg(&pdf_path)
        .arg(dir.join("page"))
        .status()
        .expect("run pdftoppm");
    assert!(status.success(), "pdftoppm failed");
    let png = std::fs::read(dir.join("page.png")).expect("rasterised page");
    let _ = std::fs::remove_dir_all(&dir);
    Some(image::load_from_memory(&png).expect("decode").to_rgb8())
}

fn px(img: &image::RgbImage, x: u32, y: u32) -> [i32; 3] {
    let p = img.get_pixel(x, y).0;
    [i32::from(p[0]), i32::from(p[1]), i32::from(p[2])]
}

fn dist(a: [i32; 3], b: [i32; 3]) -> i32 {
    (0..3).map(|i| (a[i] - b[i]).abs()).max().unwrap_or(0)
}

const SUN: [i32; 3] = [255, 200, 80];
const SKY: [i32; 3] = [60, 120, 220];
const WHITE: [i32; 3] = [255, 255, 255];

#[test]
fn a_conic_fill_is_a_function_shading__feat__color_swatches_paint_v2() {
    let d = doc(SQUARE_FILL, |d| {
        d.palette.gradients.get_mut("Gradient/Ramp").unwrap().kind = GradientKind::Conic;
    });
    let pdf = export(&d);
    let all = dicts(&pdf);
    assert!(
        all.iter().any(|d| int(d, b"ShadingType") == Some(1)),
        "a type-1 shading"
    );
    assert!(
        all.iter().any(|d| int(d, b"FunctionType") == Some(4)),
        "over a calculator function"
    );
    if let Some(img) = rasterise(&pdf, "conic") {
        // As the canvas draws it: Sun just past the start (+x, the ramp
        // turning clockwise on the page), half way to Sky opposite.
        let start = px(&img, 240, 152);
        assert!(dist(start, SUN) < 30, "Sun at the start: {start:?}");
        let opposite = px(&img, 160, 148);
        assert!(
            dist(opposite, SUN) > 40 && dist(opposite, SKY) > 40,
            "half way opposite: {opposite:?}"
        );
        let below = px(&img, 198, 190);
        let above = px(&img, 202, 110);
        assert!(
            dist(below, SUN) < dist(above, SUN),
            "a quarter turn (below) is nearer the start than three (above): {below:?} {above:?}"
        );
    }
}

#[test]
fn an_opacity_stop_paints_under_an_alpha_mask__feat__color_swatches_paint_v2() {
    let opaque = export(&doc(SQUARE_FILL, |_| {}));
    assert_eq!(luminosity_masks(&opaque), 0, "an opaque ramp has no mask");
    assert_eq!(gray_shadings(&opaque), 0);
    let fade = export(&doc(SQUARE_FILL, |d| {
        d.palette.gradients.get_mut("Gradient/Ramp").unwrap().stops[1].opacity_pct = Some(0.0);
    }));
    assert!(luminosity_masks(&fade) >= 1, "a luminosity soft mask");
    assert!(gray_shadings(&fade) >= 1, "of the ramp's alpha");
    if let Some(img) = rasterise(&fade, "fade") {
        assert!(
            dist(px(&img, 103, 150), SUN) < 20,
            "opaque Sun at the start"
        );
        let end = px(&img, 297, 150);
        assert!(dist(end, WHITE) < 20, "the page at the end: {end:?}");
    }
}

#[test]
fn a_translucent_stroke_gradient_paints_under_its_mask__feat__color_swatches_paint_v2() {
    let pdf = export(&doc(SQUARE_STROKE, |d| {
        d.palette.gradients.get_mut("Gradient/Ramp").unwrap().stops[1].opacity_pct = Some(10.0);
    }));
    assert!(luminosity_masks(&pdf) >= 1);
    assert!(
        dicts(&pdf)
            .iter()
            .any(|d| int(d, b"PatternType") == Some(2)),
        "the stroke paints a shading pattern"
    );
}

#[test]
fn a_stroke_along_its_path_arrives_as_bands__feat__color_swatches_paint_v2() {
    let pdf = export(&doc(SQUARE_STROKE, |d| {
        d.spreads[0].spread.rectangles[0].gradient_stroke_mode = StrokeGradientMode::Along;
    }));
    assert!(
        !dicts(&pdf)
            .iter()
            .any(|d| int(d, b"PatternType") == Some(2)),
        "no shading pattern: the stroke is solid bands"
    );
    if let Some(img) = rasterise(&pdf, "along") {
        let (top, bottom) = (px(&img, 200, 50), px(&img, 200, 250));
        assert!(
            dist(top, bottom) > 40,
            "the ramp moved on along the path: {top:?} {bottom:?}"
        );
    }
}
