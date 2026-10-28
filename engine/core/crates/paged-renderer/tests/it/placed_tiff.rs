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

//! A placed TIFF renders: the renderer decodes it through paged-raster,
//! and a CMYK TIFF with an embedded profile converts through paged-color
//! with that profile.
//!
//! The `__feat__images_graphics_tiff_raster` suffix links these tests to
//! the `images-graphics.tiff-raster` feature row (the evidence join's
//! convention, hence the lint allowance).
#![allow(non_snake_case)]

use std::io::Write;

use paged_compose::{Color, DisplayCommand};
use paged_raster::{
    encode_tiff, Alpha, ColorModel, Format, RasterImage, RasterInfo, SampleFormat, Samples,
    TiffCompression, TiffEncodeOptions,
};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use paged_test_resources::{skip, Resource};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A one-page package with a 120 pt square frame at (40, 40) that places
/// `picture.tif`, stretched over it.
/// `image_attrs` are extra attributes on the `<Image>`.
fn package_with(image_attrs: &str) -> Vec<u8> {
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
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="r1" GeometricBounds="40 40 160 160" StrokeWeight="0">
      <FrameFittingOption LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="FillProportionally"/>
      <Image Self="i1" LinkResourceURI="picture.tif" IMAGE_ATTRS/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#
            .replace("IMAGE_ATTRS", image_attrs)
            .as_bytes(),
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

/// A flat 8 x 8 picture of one colour.
fn flat(model: ColorModel, colour: &[u8], icc: Option<Vec<u8>>) -> RasterImage {
    let data: Vec<u8> = colour
        .iter()
        .copied()
        .cycle()
        .take(64 * colour.len())
        .collect();
    RasterImage {
        info: RasterInfo {
            format: Format::Tiff,
            width: 8,
            height: 8,
            channels: colour.len() as u16,
            bits_per_sample: 8,
            sample_format: SampleFormat::UInt,
            color_model: model,
            alpha: Alpha::None,
            icc,
            xmp: None,
            iptc: None,
            exif: None,
            photoshop_irb: None,
            has_layers: false,
            layer_count: Some(0),
            resolution: Some((72.0, 72.0)),
            orientation: 1,
            page_count: 1,
        },
        width: 8,
        height: 8,
        model,
        alpha: Alpha::None,
        data: Samples::U8(data),
    }
}

fn render(tiff: Vec<u8>) -> (Vec<DisplayCommand>, image::RgbaImage) {
    render_with(tiff, "", paged_color::Intent::RelativeColorimetric, true)
}

/// [`render`] with `<Image>` attributes and the document's Color Settings.
fn render_with(
    tiff: Vec<u8>,
    image_attrs: &str,
    intent: paged_color::Intent,
    bpc: bool,
) -> (Vec<DisplayCommand>, image::RgbaImage) {
    let mut br = BytesResolver::new();
    br.add_image("picture.tif", tiff);
    let opts = PipelineOptions {
        assets: Some(&br),
        cmyk_intent: intent,
        cmyk_bpc: bpc,
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package_with(image_attrs)).unwrap();
    let (built, images) = pipeline::render_document(&document, &opts, 72.0, Color::WHITE).unwrap();
    (
        built.pages[0].list.commands.clone(),
        images.into_iter().next().unwrap(),
    )
}

fn close(p: image::Rgba<u8>, want: [u8; 3], tol: u8) -> bool {
    p.0[..3].iter().zip(want).all(|(a, b)| a.abs_diff(b) <= tol)
}

#[test]
fn a_placed_rgb_tiff_renders__feat__images_graphics_tiff_raster() {
    let tiff = encode_tiff(
        &flat(ColorModel::Rgb, &[0, 200, 0], None),
        TiffEncodeOptions {
            compression: TiffCompression::Lzw,
            ..Default::default()
        },
    )
    .unwrap();
    let (cmds, img) = render(tiff);
    assert!(cmds
        .iter()
        .any(|c| matches!(c, DisplayCommand::Image { .. })));
    let centre = *img.get_pixel(100, 100);
    assert!(close(centre, [0, 200, 0], 1), "centre {centre:?}");
    let paper = *img.get_pixel(20, 20);
    assert!(close(paper, [255, 255, 255], 0), "outside {paper:?}");
}

#[test]
fn a_profile_less_cmyk_tiff_renders_with_the_naive_conversion() {
    let tiff = encode_tiff(
        &flat(ColorModel::Cmyk, &[255, 0, 0, 0], None),
        TiffEncodeOptions::default(),
    )
    .unwrap();
    let (_, img) = render(tiff);
    let centre = *img.get_pixel(100, 100);
    assert!(close(centre, [0, 255, 255], 1), "centre {centre:?}");
}

#[test]
fn a_cmyk_tiff_converts_through_its_embedded_profile__feat__images_graphics_tiff_raster() {
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let cmyk = [20u8, 180, 60, 30];
    let tiff = encode_tiff(
        &flat(ColorModel::Cmyk, &cmyk, Some(profile.clone())),
        TiffEncodeOptions::default(),
    )
    .unwrap();
    let mut rgb = [[0u8; 3]];
    paged_color::IccTransform::cmyk_to_linear_rgb(&profile)
        .unwrap()
        .cmyk_bytes_to_rgb_bytes(&[cmyk], &mut rgb);
    let (_, img) = render(tiff);
    let centre = *img.get_pixel(100, 100);
    assert!(
        close(centre, rgb[0], 1),
        "centre {centre:?}, paged-color {:?}",
        rgb[0]
    );
}

/// The colour a CMYK pixel converts to through paged-color with `rendering`.
fn expected(profile: &[u8], cmyk: [u8; 4], rendering: paged_color::cms::Rendering) -> [u8; 3] {
    let t = paged_color::cms::Transform::new(
        paged_color::cms::Backend::preferred(),
        paged_color::cms::ProfileRef::Icc(profile),
        paged_color::cms::Layout::CMYK,
        paged_color::cms::ProfileRef::Srgb,
        paged_color::cms::Layout::RGB,
        rendering,
    )
    .expect("transform");
    let mut rgb = [0u8; 3];
    t.apply_u8(&cmyk, &mut rgb);
    rgb
}

/// A placed CMYK TIFF converts with the frame's `ImageRenderingIntent`
/// when it names one and with the document's Color Settings (intent and
/// BPC) when it says `UseColorSettings`.
#[test]
fn a_placed_cmyk_tiff_converts_with_the_frames_rendering_intent__feat__color_swatches_cms_unified()
{
    use paged_color::cms::Rendering;
    use paged_color::Intent;
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    // A dark rich colour: the black point (BPC) and the paper white
    // (absolute colorimetric) both move it.
    let cmyk = [60u8, 40, 30, 200];
    let tiff = || {
        encode_tiff(
            &flat(ColorModel::Cmyk, &cmyk, Some(profile.clone())),
            TiffEncodeOptions::default(),
        )
        .unwrap()
    };
    let centre = |attrs: &str, intent: Intent, bpc: bool| {
        let (_, img) = render_with(tiff(), attrs, intent, bpc);
        *img.get_pixel(100, 100)
    };
    let rel_bpc = expected(
        &profile,
        cmyk,
        Rendering::new(Intent::RelativeColorimetric, true),
    );
    let rel = expected(
        &profile,
        cmyk,
        Rendering::new(Intent::RelativeColorimetric, false),
    );
    let abs = expected(
        &profile,
        cmyk,
        Rendering::new(Intent::AbsoluteColorimetric, false),
    );
    assert_ne!(rel_bpc, rel, "BPC moves the dark colour");
    assert_ne!(abs, rel, "absolute moves it");

    // The document's settings, relative colorimetric with BPC.
    let c = centre(
        r#"ImageRenderingIntent="UseColorSettings""#,
        Intent::RelativeColorimetric,
        true,
    );
    assert!(close(c, rel_bpc, 1), "{c:?} vs {rel_bpc:?}");
    // The document's settings without BPC.
    let c = centre("", Intent::RelativeColorimetric, false);
    assert!(close(c, rel, 1), "{c:?} vs {rel:?}");
    // The frame's own intent outranks the document's.
    let c = centre(
        r#"ImageRenderingIntent="AbsoluteColorimetric""#,
        Intent::RelativeColorimetric,
        false,
    );
    assert!(close(c, abs, 1), "{c:?} vs {abs:?}");
    let perc = expected(&profile, cmyk, Rendering::new(Intent::Perceptual, true));
    let c = centre(
        r#"ImageRenderingIntent="Perceptual""#,
        Intent::RelativeColorimetric,
        true,
    );
    assert!(close(c, perc, 1), "{c:?} vs {perc:?}");
}
