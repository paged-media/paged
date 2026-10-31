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

//! Engine ADR 1043 — native appearance, drawn.
//!
//! A yellow 100 pt square with a black 2 pt stroke on a 200 pt page,
//! drawn by the CPU rasterizer with different appearances: the placeholders
//! alone draw exactly the frame (the display-list digest is unchanged); an
//! extra fill draws over the frame's fill with its blend mode and opacity;
//! an extra stroke draws its own weight; the order decides what covers
//! what; a disabled layer paints nothing; a layer's effects apply to that
//! layer; the item's opacity, blend mode and drop shadow apply once, to
//! all the layers together; each kind (rectangle, oval, polygon, text
//! frame) draws them.

use std::io::Write;

use paged_compose::{BlendMode, DisplayCommand, LayerEffect};
use paged_gpu::RasterOptions;
use paged_model::appearance::PaintLayer;
use paged_model::effect_stack::{Effect, EffectEntry, GaussianBlurParams};
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
  <Color Self="Color/Black" Model="Process" Space="RGB" ColorValue="0 0 0" Name="Black"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
  <Color Self="Color/Blue" Model="Process" Space="RGB" ColorValue="0 0 255" Name="Blue"/>
  <Color Self="Color/Yellow" Model="Process" Space="RGB" ColorValue="255 255 0" Name="Yellow"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

const SQUARE: &str = r#"<Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="Color/Yellow" StrokeColor="Color/Black" StrokeWeight="2"/>"#;

fn doc(items: &str) -> Document {
    idml_import::import_idml_doc(&idml(items)).expect("import")
}

fn square(layers: Vec<PaintLayer>) -> Document {
    let mut d = doc(SQUARE);
    d.spreads[0].spread.rectangles[0].appearance = layers;
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

fn rgb(img: &image::RgbaImage, x: u32, y: u32) -> [u8; 3] {
    let p = img.get_pixel(x, y).0;
    [p[0], p[1], p[2]]
}

fn near(got: [u8; 3], want: [u8; 3]) -> bool {
    got.iter()
        .zip(want)
        .all(|(g, w)| (i32::from(*g) - i32::from(w)).abs() <= 3)
}

fn fill(color: &str) -> PaintLayer {
    PaintLayer::fill(color)
}

#[test]
#[allow(non_snake_case)]
fn the_placeholders_alone_draw_the_frame__feat__frames_paths_native_appearance() {
    let plain = list(&doc(SQUARE)).digest();
    let d = square(vec![PaintLayer::frame_fill(), PaintLayer::frame_stroke()]);
    assert_eq!(list(&d).digest(), plain);
}

#[test]
#[allow(non_snake_case)]
fn an_extra_fill_draws_with_its_blend_and_opacity__feat__frames_paths_native_appearance() {
    // Normal blue over yellow: blue.
    let img = pixels(&square(vec![fill("Color/Blue")]));
    assert!(
        near(rgb(&img, 100, 100), [0, 0, 255]),
        "{:?}",
        rgb(&img, 100, 100)
    );
    // Multiply blue over yellow: black.
    let mut blue = fill("Color/Blue");
    blue.blend_mode = Some("Multiply".into());
    let img = pixels(&square(vec![blue]));
    assert!(
        near(rgb(&img, 100, 100), [0, 0, 0]),
        "{:?}",
        rgb(&img, 100, 100)
    );
    // Red at 50 % over yellow: orange.
    let mut red = fill("Color/Red");
    red.opacity = Some(50.0);
    let img = pixels(&square(vec![red]));
    let p = rgb(&img, 100, 100);
    assert!(
        p[0] >= 250 && (100..=200).contains(&p[1]) && p[2] <= 3,
        "{p:?}"
    );
}

#[test]
#[allow(non_snake_case)]
fn an_extra_stroke_draws_its_own_weight__feat__frames_paths_native_appearance() {
    let img = pixels(&square(vec![PaintLayer::stroke("Color/Blue", 10.0)]));
    // Centred on the outline at x = 50: 45..55 is blue, over the frame's
    // own 2 pt black stroke.
    assert!(
        near(rgb(&img, 46, 100), [0, 0, 255]),
        "{:?}",
        rgb(&img, 46, 100)
    );
    assert!(
        near(rgb(&img, 53, 100), [0, 0, 255]),
        "{:?}",
        rgb(&img, 53, 100)
    );
    assert!(near(rgb(&img, 42, 100), [255, 255, 255]), "outside");
    assert!(near(rgb(&img, 60, 100), [255, 255, 0]), "inside: the fill");
    // Outside alignment: 50..40.
    let mut out = PaintLayer::stroke("Color/Blue", 10.0);
    out.alignment = Some("OutsideAlignment".into());
    let img = pixels(&square(vec![out]));
    assert!(
        near(rgb(&img, 42, 100), [0, 0, 255]),
        "{:?}",
        rgb(&img, 42, 100)
    );
    assert!(
        near(rgb(&img, 53, 100), [255, 255, 0]),
        "{:?}",
        rgb(&img, 53, 100)
    );
}

#[test]
#[allow(non_snake_case)]
fn the_order_decides_what_covers_what__feat__frames_paths_native_appearance() {
    // A fill under the frame's opaque fill is hidden.
    let img = pixels(&square(vec![fill("Color/Blue"), PaintLayer::frame_fill()]));
    assert!(near(rgb(&img, 100, 100), [255, 255, 0]));
    // The frame's stroke under a fill: the fill covers the stroke's
    // inner half.
    let img = pixels(&square(vec![
        PaintLayer::frame_stroke(),
        PaintLayer::frame_fill(),
    ]));
    assert!(
        near(rgb(&img, 50, 100), [255, 255, 0]),
        "{:?}",
        rgb(&img, 50, 100)
    );
    assert!(
        near(rgb(&img, 49, 100), [0, 0, 0]),
        "{:?}",
        rgb(&img, 49, 100)
    );
    let plain = pixels(&doc(SQUARE));
    assert!(near(rgb(&plain, 50, 100), [0, 0, 0]), "the frame as it is");
}

#[test]
#[allow(non_snake_case)]
fn a_disabled_layer_paints_nothing__feat__frames_paths_native_appearance() {
    let mut off = fill("Color/Blue");
    off.enabled = false;
    assert_eq!(
        list(&square(vec![off])).digest(),
        list(&doc(SQUARE)).digest()
    );
    // The frame's own fill switched off: the picture area shows the page.
    let mut ff = PaintLayer::frame_fill();
    ff.enabled = false;
    let img = pixels(&square(vec![ff]));
    assert!(near(rgb(&img, 100, 100), [255, 255, 255]));
}

#[test]
#[allow(non_snake_case)]
fn a_layers_effects_apply_to_that_layer__feat__frames_paths_native_appearance() {
    let mut blurred = fill("Color/Blue");
    blurred
        .effects
        .push(EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams {
            radius_pt: 4.0,
        })));
    let l = list(&square(vec![blurred]));
    let blurs = l
        .commands
        .iter()
        .filter(|c| {
            matches!(
                c,
                DisplayCommand::PushLayer {
                    effect: LayerEffect::GaussianBlur { .. },
                    ..
                }
            )
        })
        .count();
    assert_eq!(blurs, 1);
    let img = pixels(&square({
        let mut b = fill("Color/Blue");
        b.effects
            .push(EffectEntry::new(Effect::GaussianBlur(GaussianBlurParams {
                radius_pt: 4.0,
            })));
        vec![b]
    }));
    // The blue spills past the outline, softly.
    let p = rgb(&img, 46, 100);
    assert!(p[2] > 40 && p[0] < 250, "{p:?}");
}

#[test]
#[allow(non_snake_case)]
fn the_items_opacity_and_shadow_apply_once__feat__frames_paths_native_appearance() {
    let items = r#"<Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="Color/Yellow" StrokeColor="Color/Black" StrokeWeight="2"><TransparencySetting><BlendingSetting Opacity="50" BlendMode="Multiply"/><DropShadowSetting Mode="Drop" XOffset="7" YOffset="7" Size="5" Opacity="75"/></TransparencySetting></Rectangle>"#;
    let mut d = doc(items);
    d.spreads[0].spread.rectangles[0].appearance =
        vec![fill("Color/Red"), PaintLayer::stroke("Color/Blue", 6.0)];
    let l = list(&d);
    let groups = l
        .commands
        .iter()
        .filter(|c| {
            matches!(
                c,
                DisplayCommand::BeginBlendGroup {
                    blend_mode: BlendMode::Multiply,
                    ..
                }
            )
        })
        .count();
    assert_eq!(groups, 1, "one object group");
    let shadows = l
        .commands
        .iter()
        .filter(|c| matches!(c, DisplayCommand::DropShadow { .. }))
        .count();
    assert_eq!(shadows, 1, "one shadow, cast by every layer together");
}

#[test]
#[allow(non_snake_case)]
fn every_kind_draws_its_layers__feat__frames_paths_native_appearance() {
    let items = r#"
    <Oval Self="ov" GeometricBounds="10 10 90 90" FillColor="Color/Yellow" StrokeWeight="0"/>
    <Polygon Self="pg" GeometricBounds="110 10 190 90" FillColor="Color/Yellow" StrokeWeight="0"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray><PathPointType Anchor="10 110" LeftDirection="10 110" RightDirection="10 110"/><PathPointType Anchor="90 110" LeftDirection="90 110" RightDirection="90 110"/><PathPointType Anchor="50 190" LeftDirection="50 190" RightDirection="50 190"/></PathPointArray></GeometryPathType></PathGeometry></Properties></Polygon>
    <TextFrame Self="tf" GeometricBounds="110 110 190 190" FillColor="Color/Yellow" StrokeWeight="0"/>"#;
    let mut d = doc(items);
    let blue = || vec![fill("Color/Blue")];
    let sp = &mut d.spreads[0].spread;
    sp.ovals[0].appearance = blue();
    sp.polygons[0].appearance = blue();
    sp.text_frames[0].appearance = blue();
    let img = pixels(&d);
    for (x, y, what) in [
        (50, 50, "oval"),
        (50, 140, "polygon"),
        (150, 150, "text frame"),
    ] {
        assert!(
            near(rgb(&img, x, y), [0, 0, 255]),
            "{what}: {:?}",
            rgb(&img, x, y)
        );
    }
}
