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

//! A placed PSD or PSB renders its merged composite: the renderer decodes
//! it through paged-raster (paged-psd's composite decode), and a CMYK PSD
//! with an embedded profile converts through paged-color with that
//! profile. Before, a placed PSD did not decode and the frame showed its
//! fill with an `ImageDecodeFailed` diagnostic.
//!
//! The `__feat__images_graphics_placed_psd` suffix links these tests to
//! the `images-graphics.placed-psd` feature row (the evidence join's
//! convention, hence the lint allowance).
#![allow(non_snake_case)]

use std::io::Write;

use paged_compose::{Color, DisplayCommand};
use paged_psd::model::{
    ColorMode, ColorModeData, FileHeader, GlobalImageData, ImageResourceBlock, ImageResources,
    LayerAndMaskInfo, PascalString, PsdFile, ResourceBody,
};
use paged_psd::Container;
use paged_renderer::{pipeline, BytesResolver, DiagnosticCode, PipelineOptions};
use paged_test_resources::{skip, Resource};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A one-page package with a 120 pt square frame at (40, 40) filled red,
/// placing `link` stretched over it.
fn package(link: &str) -> Vec<u8> {
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
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
</Document>"#,
    )
    .unwrap();
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    write!(
        zip,
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="r1" GeometricBounds="40 40 160 160" StrokeWeight="0" FillColor="Color/Red">
      <FrameFittingOption LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="FillProportionally"/>
      <Image Self="i1" LinkResourceURI="{link}"/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#
    )
    .unwrap();
    zip.finish().unwrap().into_inner()
}

/// A flat 8 x 8 document of one colour, written by paged-psd: a RAW
/// merged composite, one plane per channel (CMYK planes inverted, as
/// Photoshop stores them), optionally with an embedded profile.
fn flat(container: Container, mode: ColorMode, colour: &[u8], icc: Option<Vec<u8>>) -> Vec<u8> {
    let stored = |v: u8| if mode == ColorMode::Cmyk { 255 - v } else { v };
    let planes: Vec<u8> = colour.iter().flat_map(|&v| [stored(v); 64]).collect();
    let blocks = icc
        .map(|p| ImageResourceBlock {
            id: 1039,
            name: PascalString::new(""),
            body: ResourceBody::IccProfile(p),
            raw_block: None,
        })
        .into_iter()
        .collect();
    PsdFile {
        container,
        header: FileHeader {
            channels: colour.len() as u16,
            height: 8,
            width: 8,
            depth: 8,
            color_mode: mode,
        },
        color_mode: ColorModeData::default(),
        resources: ImageResources { blocks },
        layer_mask: LayerAndMaskInfo::default(),
        composite: GlobalImageData {
            compression: 0,
            raw: planes,
        },
    }
    .write()
    .unwrap()
}

struct Rendered {
    commands: Vec<DisplayCommand>,
    page: image::RgbaImage,
    decode_failed: usize,
}

fn render(link: &str, bytes: Vec<u8>) -> Rendered {
    let mut br = BytesResolver::new();
    br.add_image(link, bytes);
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package(link)).unwrap();
    let (built, images) = pipeline::render_document(&document, &opts, 72.0, Color::WHITE).unwrap();
    let decode_failed = built
        .diagnostics
        .items
        .iter()
        .filter(|d| d.code == DiagnosticCode::ImageDecodeFailed)
        .count();
    Rendered {
        commands: built.pages[0].list.commands.clone(),
        page: images.into_iter().next().unwrap(),
        decode_failed,
    }
}

fn close(p: image::Rgba<u8>, want: [u8; 3], tol: u8) -> bool {
    p.0[..3].iter().zip(want).all(|(a, b)| a.abs_diff(b) <= tol)
}

fn assert_drawn(r: &Rendered, want: [u8; 3], tol: u8) {
    assert!(
        r.commands
            .iter()
            .any(|c| matches!(c, DisplayCommand::Image { .. })),
        "the composite is drawn as an image"
    );
    assert_eq!(r.decode_failed, 0, "no ImageDecodeFailed");
    let centre = *r.page.get_pixel(100, 100);
    assert!(close(centre, want, tol), "centre {centre:?}, want {want:?}");
    let paper = *r.page.get_pixel(20, 20);
    assert!(close(paper, [255, 255, 255], 0), "outside {paper:?}");
}

#[test]
fn a_placed_psd_renders_its_composite__feat__images_graphics_placed_psd() {
    let psd = flat(Container::Psd, ColorMode::Rgb, &[0, 200, 0], None);
    assert_drawn(&render("picture.psd", psd), [0, 200, 0], 1);
}

#[test]
fn a_placed_psb_renders_its_composite__feat__images_graphics_placed_psd() {
    let psb = flat(Container::Psb, ColorMode::Rgb, &[0, 0, 200], None);
    assert_eq!(&psb[4..6], &[0, 2], "a PSB (version 2)");
    assert_drawn(&render("picture.psb", psb), [0, 0, 200], 1);
}

#[test]
fn a_placed_grayscale_psd_renders() {
    let psd = flat(Container::Psd, ColorMode::Grayscale, &[90], None);
    assert_drawn(&render("picture.psd", psd), [90, 90, 90], 1);
}

#[test]
fn a_placed_layered_psd_renders_photoshops_composite__feat__images_graphics_placed_psd() {
    let annual = include_bytes!("../../../paged-psd/tests/fixtures/annual-layers.psd").to_vec();
    let want = PsdFile::parse(&annual).unwrap().composite_rgba8().unwrap();
    // The fixture is 400 x 300 placed proportionally in a 120 pt square:
    // its centre pixel lands on the frame's centre.
    let centre = (200 + 150 * 400) * 4;
    let rgb = [
        want.rgba[centre],
        want.rgba[centre + 1],
        want.rgba[centre + 2],
    ];
    assert_drawn(&render("annual.psd", annual), rgb, 3);
}

#[test]
fn a_placed_cmyk_psd_converts_through_its_embedded_profile__feat__images_graphics_placed_psd() {
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let ink = [20u8, 180, 60, 30];
    let psd = flat(Container::Psd, ColorMode::Cmyk, &ink, Some(profile.clone()));
    let mut rgb = [[0u8; 3]];
    paged_color::IccTransform::cmyk_to_linear_rgb(&profile)
        .unwrap()
        .cmyk_bytes_to_rgb_bytes(&[ink], &mut rgb);
    assert_drawn(&render("picture.psd", psd), rgb[0], 1);
}

#[test]
fn a_profile_less_cmyk_psd_takes_the_device_formula() {
    let psd = flat(Container::Psd, ColorMode::Cmyk, &[255, 0, 0, 0], None);
    assert_drawn(&render("picture.psd", psd), [0, 255, 255], 1);
}

/// A composite the decoder does not read keeps the old outcome: the frame
/// fill and the diagnostic (a Lab document here).
#[test]
fn a_psd_whose_composite_cannot_be_read_still_falls_back_to_the_frame_fill() {
    let psd = flat(Container::Psd, ColorMode::Lab, &[50, 128, 128], None);
    let r = render("picture.psd", psd);
    assert_eq!(r.decode_failed, 1);
    let centre = *r.page.get_pixel(100, 100);
    assert!(close(centre, [255, 0, 0], 2), "frame fill {centre:?}");
}
