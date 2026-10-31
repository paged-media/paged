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

//! Engine ADR 1037 — a placed picture is drawn through its frame's filter
//! stack: the stack arrives on the IDML label the export writes, the
//! adjusted twin replaces the picture in the display list's pool (at the
//! picture's own pixels for an export, reduced for a display density), and
//! the build cache reuses it.
#![allow(non_snake_case)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Write;

use paged_compose::{Color, DisplayCommand};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A one-page package with a 120 pt square frame placing `picture.png`
/// stretched over it, its stack on the frame's label.
fn package(stack_json: &str) -> Vec<u8> {
    let label = stack_json.replace('"', "&quot;");
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
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
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="r1" GeometricBounds="40 40 160 160" StrokeWeight="0">
      <Properties><Label><KeyValuePair Key="paged:imageAdjustments" Value="{label}"/></Label></Properties>
      <FrameFittingOption LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0"/>
      <Image Self="i1" LinkResourceURI="picture.png"/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#
        )
        .as_bytes(),
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

/// A 400 × 400 picture of one colour.
fn png() -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(400, 400, image::Rgba([200, 30, 30, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

/// The drawn picture's pool entry: size and first pixel; and the page
/// rendered at 72 dpi.
fn build(
    stack: &str,
    density: Option<f32>,
    cache: Option<&RefCell<HashMap<String, paged_compose::DecodedImage>>>,
) -> ((u32, u32), [u8; 4], image::RgbaImage) {
    let mut br = BytesResolver::new();
    br.add_image("picture.png", png());
    let opts = PipelineOptions {
        assets: Some(&br),
        image_adjust_px_per_pt: density,
        image_decode_cache: cache,
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package(stack)).unwrap();
    assert!(
        !document.spreads[0].spread.rectangles[0]
            .image_adjustments
            .is_empty()
            || stack == "[]",
        "the label is read onto the frame"
    );
    let (built, images) = pipeline::render_document(&document, &opts, 72.0, Color::WHITE).unwrap();
    let list = &built.pages[0].list;
    let id = list
        .commands
        .iter()
        .find_map(|c| match c {
            DisplayCommand::Image { image_id, .. } => Some(*image_id),
            _ => None,
        })
        .expect("the picture is drawn");
    let img = list.image(id).unwrap();
    (
        (img.width, img.height),
        img.rgba[..4].try_into().unwrap(),
        images.into_iter().next().unwrap(),
    )
}

#[test]
fn a_placed_picture_is_drawn_through_its_stack__feat__images_graphics_image_filter_stack() {
    let (size, px, page) = build(r#"[{"op":"invert"}]"#, None, None);
    assert_eq!(
        size,
        (400, 400),
        "an export evaluates at the picture's own pixels"
    );
    assert_eq!(px, [55, 225, 225, 255]);
    let centre = page.get_pixel(100, 100).0;
    assert!(
        centre[..3]
            .iter()
            .zip([55u8, 225, 225])
            .all(|(a, b)| a.abs_diff(b) <= 1),
        "the page shows the adjusted picture: {centre:?}"
    );
    let (_, plain, _) = build("[]", None, None);
    assert_eq!(plain, [200, 30, 30, 255], "no stack, no change");
}

#[test]
fn a_display_density_reduces_the_picture_first__feat__images_graphics_image_filter_stack() {
    // 400 px over 120 pt: 0.3 pt per pixel. At 1 px per pt the display
    // wants 0.3 of the pixels; rounded up to a power of two, half.
    let (size, px, _) = build(r#"[{"op":"invert"}]"#, Some(1.0), None);
    assert_eq!(size, (200, 200));
    assert_eq!(px, [55, 225, 225, 255]);
    // A density above the picture's own keeps every pixel.
    let (size, _, _) = build(r#"[{"op":"invert"}]"#, Some(8.0), None);
    assert_eq!(size, (400, 400));
}

#[test]
fn the_adjusted_twin_is_cached_across_builds__feat__images_graphics_image_filter_stack() {
    let cache = RefCell::new(HashMap::new());
    build(r#"[{"op":"exposure","ev":1.0}]"#, Some(1.0), Some(&cache));
    let twins = |c: &RefCell<HashMap<String, paged_compose::DecodedImage>>| {
        c.borrow().keys().filter(|k| k.contains("#adjust:")).count()
    };
    assert_eq!(twins(&cache), 1);
    build(r#"[{"op":"exposure","ev":1.0}]"#, Some(1.0), Some(&cache));
    assert_eq!(twins(&cache), 1, "the same stack reuses its twin");
    build(r#"[{"op":"exposure","ev":0.5}]"#, Some(1.0), Some(&cache));
    assert_eq!(twins(&cache), 2, "another stack is another twin");
}
