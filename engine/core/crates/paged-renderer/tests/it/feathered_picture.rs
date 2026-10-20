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

//! A frame's feathers and interior effects apply to its placed picture.
//!
//! InDesign applies an object's effects to the whole object, content
//! included: a feathered picture frame fades its picture, an inner
//! shadow falls over it. The engine emitted the effects right after the
//! frame's fill and the picture after them, so a feather masked only the
//! fill (nothing, on an unfilled picture frame) and the picture painted
//! over every interior effect at full strength. The effects now follow
//! the picture, and a `BeginFeatheredObject` marker before the fill
//! tells every lane where the feathered run begins.

use std::io::Write;

use paged_compose::{Color, DisplayCommand};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A one-page package whose only item is a 120 pt square picture frame
/// (no fill, no stroke) at (40, 40) carrying `effects` in its
/// `<TransparencySetting>` and a placed `picture.png` stretched over it.
fn package(effects: &str) -> Vec<u8> {
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
    zip.start_file("Resources/Graphic.xml", deflated).unwrap();
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Graphic>
    <Color Self="Color/Black" Name="Black" Space="CMYK" ColorValue="0 0 0 100"/>
  </Graphic>
</idPkg:Graphic>"#,
    )
    .unwrap();
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="r1" GeometricBounds="40 40 160 160" StrokeWeight="0">
      <TransparencySetting>
        {effects}
      </TransparencySetting>
      <FrameFittingOption LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="FillProportionally"/>
      <Image Self="i1" LinkResourceURI="picture.png"/>
    </Rectangle>
  </Spread>
</idPkg:Spread>"#
    );
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

/// A flat green picture.
fn green_png() -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 200, 0, 255]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

fn resolver() -> BytesResolver {
    let mut br = BytesResolver::new();
    br.add_image("picture.png", green_png());
    br
}

fn commands(effects: &str) -> Vec<DisplayCommand> {
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package(effects)).unwrap();
    let built = pipeline::build_document(&document, &opts).unwrap();
    built.pages[0].list.commands.clone()
}

fn render(effects: &str) -> image::RgbaImage {
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package(effects)).unwrap();
    let (_built, images) = pipeline::render_document(&document, &opts, 72.0, Color::WHITE).unwrap();
    images.into_iter().next().unwrap()
}

/// How far a pixel has faded from the picture's green toward the white
/// paper: 0 is the picture, 1 is paper.
fn fade(p: image::Rgba<u8>) -> f32 {
    p.0[0] as f32 / 255.0
}

const FEATHER: &str = r#"<FeatherSetting Mode="Standard" Width="20" CornerType="Sharp"/>"#;
const DIRECTIONAL: &str = r#"<DirectionalFeatherSetting Applied="true" LeftWidth="30" RightWidth="0" TopWidth="0" BottomWidth="0" Angle="0"/>"#;
const GRADIENT: &str = r#"<GradientFeatherSetting Applied="true" Type="Linear" GradientAngle="0"><GradientStop StopColor="Color/Black" Location="0" Alpha="100" GradientStopMidpoint="50"/><GradientStop StopColor="Color/Black" Location="100" Alpha="0" GradientStopMidpoint="50"/></GradientFeatherSetting>"#;
const INNER_SHADOW: &str = r#"<InnerShadowSetting Applied="true" Size="6" Opacity="100" XOffset="8" YOffset="8" EffectColor="Color/Black" BlendMode="Multiply"/>"#;

/// The display list brackets the picture: the marker before it, the
/// feather after it, and the feathered run starts at the marker.
#[test]
fn the_feather_follows_the_picture_and_its_run_starts_at_the_marker() {
    for effects in [FEATHER, DIRECTIONAL, GRADIENT] {
        let cmds = commands(effects);
        let pos = |f: &dyn Fn(&DisplayCommand) -> bool| cmds.iter().position(f);
        let marker = pos(&|c| matches!(c, DisplayCommand::BeginFeatheredObject { .. }))
            .unwrap_or_else(|| panic!("{effects}: no marker"));
        let picture = pos(&|c| matches!(c, DisplayCommand::Image { .. }))
            .unwrap_or_else(|| panic!("{effects}: no picture"));
        let feather = pos(&|c| {
            matches!(
                c,
                DisplayCommand::Feather { .. }
                    | DisplayCommand::DirectionalFeather { .. }
                    | DisplayCommand::GradientFeather { .. }
            )
        })
        .unwrap_or_else(|| panic!("{effects}: no feather"));
        assert!(
            marker < picture && picture < feather,
            "{effects}: marker {marker}, picture {picture}, feather {feather}"
        );
        let list = paged_compose::DisplayList {
            commands: cmds.clone(),
            ..Default::default()
        };
        let runs = paged_compose::mask::feather_run_starts(&list);
        assert_eq!(
            runs.get(&marker),
            Some(&feather),
            "{effects}: the run opens at the marker, got {runs:?}"
        );
    }
}

/// A frame without a feather gets no marker.
#[test]
fn an_unfeathered_frame_carries_no_marker() {
    let cmds = commands(INNER_SHADOW);
    assert!(!cmds
        .iter()
        .any(|c| matches!(c, DisplayCommand::BeginFeatheredObject { .. })));
}

/// A basic feather fades the picture at the frame's edge; its middle
/// stays the picture.
#[test]
fn a_feather_fades_the_picture_at_the_frame_edge() {
    let img = render(FEATHER);
    let centre = fade(*img.get_pixel(100, 100));
    assert!(centre < 0.05, "the middle is the picture, faded {centre}");
    for (x, y) in [(42, 100), (157, 100), (100, 42), (100, 157)] {
        let edge = fade(*img.get_pixel(x, y));
        assert!(
            edge > 0.25,
            "({x},{y}) is 2-3 pt inside a 20 pt feather, faded only {edge}"
        );
    }
}

/// A directional feather fades only the edge it names.
#[test]
fn a_directional_feather_fades_the_picture_on_its_side_only() {
    let img = render(DIRECTIONAL);
    let left = fade(*img.get_pixel(43, 100));
    let right = fade(*img.get_pixel(156, 100));
    assert!(left > 0.5, "the 30 pt left edge fades, got {left}");
    assert!(right < 0.05, "the right edge has no feather, got {right}");
}

/// A gradient feather fades the picture along its axis.
#[test]
fn a_gradient_feather_fades_the_picture_along_its_axis() {
    let img = render(GRADIENT);
    let start = fade(*img.get_pixel(45, 100));
    let end = fade(*img.get_pixel(155, 100));
    assert!(
        start < 0.1,
        "the opaque stop keeps the picture, got {start}"
    );
    assert!(end > 0.8, "the clear stop shows the paper, got {end}");
}

/// An inner shadow falls over the picture, not under it.
#[test]
fn an_inner_shadow_falls_over_the_picture() {
    let img = render(INNER_SHADOW);
    let shaded = *img.get_pixel(44, 44);
    let open = *img.get_pixel(100, 100);
    assert!(
        (shaded.0[1] as i32) < (open.0[1] as i32) - 40,
        "the shadow's top-left corner darkens the picture: {shaded:?} vs {open:?}"
    );
}
