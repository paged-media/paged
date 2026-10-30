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

//! Engine ADR 1045 — an anchored picture frame paints its look as a free
//! frame does: its opacity, drop shadow, feathers and effect stack take
//! its picture in. The frame is read from the story by the IDML reader
//! (the effect blocks inside an anchored `<Rectangle>`), and painted
//! whole in the picture pass, its picture as the content of its run; a
//! frame without a look keeps its two passes and its display list.

use std::io::Write;

use paged_compose::{Color, DisplayCommand, LayerEffect};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A one-page package: a text frame at (20, 20)–(180, 180) whose story
/// opens with an inline 60 pt picture frame carrying `look` (its
/// transparency blocks) and a placed `picture.png`, then a word.
fn package(look: &str) -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut put = |name: &str, body: &[u8]| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(body).unwrap();
    };
    put("mimetype", b"application/vnd.adobe.indesign-idml-package");
    put(
        "designmap.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_st1.xml"/>
</Document>"#,
    );
    put(
        "Resources/Graphic.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Name="Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100"/>
</idPkg:Graphic>"#,
    );
    put(
        "Spreads/Spread_sp1.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200" ItemTransform="1 0 0 1 0 0"/>
    <TextFrame Self="tf1" ParentStory="st1" GeometricBounds="20 20 180 180" ItemTransform="1 0 0 1 0 0"/>
  </Spread>
</idPkg:Spread>"#,
    );
    let story = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
<Story Self="st1"><ParagraphStyleRange><CharacterStyleRange AppliedFont="Inter" PointSize="12">
<Rectangle Self="a1" GeometricBounds="0 0 60 60" StrokeWeight="0">
{look}
<Image Self="i1" LinkResourceURI="picture.png"/>
<AnchoredObjectSetting AnchoredPosition="InlinePosition"/>
</Rectangle>
<Content>x</Content>
</CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#
    );
    put("Stories/Story_st1.xml", story.as_bytes());
    zip.finish().unwrap().into_inner()
}

fn read_font(name: &str) -> Vec<u8> {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus/fonts")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read font fixture {}: {e}", p.display()))
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
    let mut br = BytesResolver::new().with_default_font(read_font("Inter.ttf"));
    br.add_font("Inter", None, read_font("Inter.ttf"));
    br.add_image("picture.png", green_png());
    br
}

fn document(look: &str) -> paged_scene::Document {
    idml_import::import_idml_doc(&package(look)).expect("import")
}

fn commands(look: &str) -> Vec<DisplayCommand> {
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&document(look), &opts).unwrap();
    built.pages[0].list.commands.clone()
}

fn render(look: &str) -> image::RgbaImage {
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let (_built, images) =
        pipeline::render_document(&document(look), &opts, 72.0, Color::WHITE).unwrap();
    images.into_iter().next().unwrap()
}

/// The picture's box on the page, `[x0, y0, x1, y1]`, from its image
/// command: the picture is stretched over the 60 pt frame, its unit
/// square placed by the command's transform.
fn picture_box(cmds: &[DisplayCommand]) -> [f32; 4] {
    let t = cmds
        .iter()
        .find_map(|c| match c {
            DisplayCommand::Image { transform, .. } => Some(*transform),
            _ => None,
        })
        .expect("the picture paints");
    let (x0, y0) = t.apply(0.0, 0.0);
    let (x1, y1) = t.apply(1.0, 1.0);
    [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)]
}

fn pos(cmds: &[DisplayCommand], f: impl Fn(&DisplayCommand) -> bool) -> Option<usize> {
    cmds.iter().position(f)
}

fn tx(look: &str) -> String {
    format!("<TransparencySetting>{look}</TransparencySetting>")
}

const SHADOW: &str = r#"<DropShadowSetting Mode="Drop" XOffset="10" YOffset="10" Size="0" Opacity="100" EffectColor="Color/Black" BlendMode="Normal"/>"#;
const FEATHER: &str = r#"<FeatherSetting Mode="Standard" Width="20" CornerType="Sharp"/>"#;
const HALF: &str = r#"<BlendingSetting Opacity="50"/>"#;

/// The reader takes the anchored frame's blocks; the picture is read
/// as before.
#[test]
#[allow(non_snake_case)]
fn the_reader_takes_an_anchored_frames_look__feat__anchored_inline_objects_anchored_effects() {
    let doc = document(&format!(
        r#"{}<FillTransparencySetting><BlendingSetting Opacity="40"/></FillTransparencySetting>"#,
        tx(&format!(
            r#"{HALF}{SHADOW}<InnerShadowSetting Applied="true" Size="4" Opacity="60"/><OuterGlowSetting Applied="false" Size="9"/>{FEATHER}"#
        ))
    ));
    let af = doc.stories[0].story.paragraphs[0]
        .anchored_frames
        .first()
        .expect("the anchored frame");
    assert_eq!(af.opacity, Some(50.0));
    let shadow = af.drop_shadow.as_ref().expect("its shadow");
    assert_eq!((shadow.x_offset, shadow.size), (10.0, 0.0));
    let fx = af.effects.as_ref().expect("its effects");
    assert!(fx.inner_shadow.is_some() && fx.feather.is_some());
    assert!(
        fx.outer_glow.is_none(),
        "an effect switched off is not read"
    );
    assert_eq!(
        af.fill_transparency.as_ref().and_then(|t| t.opacity),
        Some(40.0)
    );
    assert_eq!(af.image_link.as_deref(), Some("picture.png"));
}

/// Without a look the frame keeps its two passes: nothing groups or
/// shadows the picture.
#[test]
#[allow(non_snake_case)]
fn a_frame_without_a_look_paints_as_before__feat__anchored_inline_objects_anchored_effects() {
    let cmds = commands("");
    assert!(pos(&cmds, |c| matches!(c, DisplayCommand::Image { .. })).is_some());
    assert!(pos(&cmds, |c| matches!(
        c,
        DisplayCommand::DropShadow { .. }
            | DisplayCommand::PushLayer { .. }
            | DisplayCommand::BeginFeatheredObject { .. }
    ))
    .is_none());
}

/// A drop shadow falls under the picture, offset by its offsets.
#[test]
#[allow(non_snake_case)]
fn an_anchored_picture_casts_its_shadow__feat__anchored_inline_objects_anchored_effects() {
    let look = tx(SHADOW);
    let cmds = commands(&look);
    let shadow = pos(&cmds, |c| matches!(c, DisplayCommand::DropShadow { .. })).expect("shadow");
    let picture = pos(&cmds, |c| matches!(c, DisplayCommand::Image { .. })).expect("picture");
    assert!(shadow < picture, "the shadow is under the picture");
    let [x0, y0, x1, y1] = picture_box(&cmds);
    let img = render(&look);
    // Below and right of the picture, inside the 10 pt offset: shadow.
    let (sx, sy) = ((x1 + 5.0) as u32, ((y0 + y1) / 2.0 + 5.0) as u32);
    let p = img.get_pixel(sx, sy).0;
    assert!(p[0] < 60 && p[1] < 60, "shadow at ({sx},{sy}): {p:?}");
    // Above-left of the picture: paper.
    let p = img
        .get_pixel((x0 - 3.0).max(0.0) as u32, (y0 + 3.0) as u32)
        .0;
    assert!(p[0] > 240, "paper beside the picture: {p:?}");
}

/// The frame's opacity fades its picture: the picture is inside the
/// frame's group.
#[test]
#[allow(non_snake_case)]
fn an_anchored_pictures_opacity_fades_its_picture__feat__anchored_inline_objects_anchored_effects()
{
    let look = tx(HALF);
    let cmds = commands(&look);
    let [x0, y0, x1, y1] = picture_box(&cmds);
    let img = render(&look);
    let p = img
        .get_pixel(((x0 + x1) / 2.0) as u32, ((y0 + y1) / 2.0) as u32)
        .0;
    // Green 200 over white at 50 %: red and blue half-way to paper.
    assert!(
        (110..=145).contains(&p[0]) && p[1] > 210,
        "half the picture over the paper: {p:?}"
    );
    let plain = render("");
    let q = plain
        .get_pixel(((x0 + x1) / 2.0) as u32, ((y0 + y1) / 2.0) as u32)
        .0;
    assert!(q[0] < 10, "without a look the picture is opaque: {q:?}");
}

/// A feather fades the picture at the frame's edge: the marker opens the
/// run before the picture, the feather closes it after (ADR 203).
#[test]
#[allow(non_snake_case)]
fn a_feather_fades_an_anchored_picture__feat__anchored_inline_objects_anchored_effects() {
    let look = tx(FEATHER);
    let cmds = commands(&look);
    let marker = pos(&cmds, |c| {
        matches!(c, DisplayCommand::BeginFeatheredObject { .. })
    })
    .expect("marker");
    let picture = pos(&cmds, |c| matches!(c, DisplayCommand::Image { .. })).expect("picture");
    let feather = pos(&cmds, |c| matches!(c, DisplayCommand::Feather { .. })).expect("feather");
    assert!(marker < picture && picture < feather);
    let [x0, y0, x1, y1] = picture_box(&cmds);
    let img = render(&look);
    let centre = img
        .get_pixel(((x0 + x1) / 2.0) as u32, ((y0 + y1) / 2.0) as u32)
        .0;
    let edge = img.get_pixel((x0 + 2.0) as u32, ((y0 + y1) / 2.0) as u32).0;
    assert!(centre[0] < 30, "the middle is the picture: {centre:?}");
    assert!(edge[0] > 60, "the edge fades toward the paper: {edge:?}");
}

/// The effect stack's own effects reach an anchored frame: a blur wraps
/// the picture in its layer.
#[test]
#[allow(non_snake_case)]
fn an_anchored_pictures_stack_blurs_its_picture__feat__anchored_inline_objects_anchored_effects() {
    use paged_model::effect_stack::{
        Effect, EffectBearing, EffectEntry, EffectTarget, GaussianBlurParams,
    };
    let mut doc = document("");
    let af = &mut doc.stories[0].story.paragraphs[0].anchored_frames[0];
    af.effect_slots_mut(EffectTarget::Object)
        .set_stack(vec![EffectEntry::new(Effect::GaussianBlur(
            GaussianBlurParams { radius_pt: 3.0 },
        ))])
        .expect("stack");
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&doc, &opts).unwrap();
    let cmds = &built.pages[0].list.commands;
    let open = pos(cmds, |c| {
        matches!(
            c,
            DisplayCommand::PushLayer {
                effect: LayerEffect::GaussianBlur { .. },
                ..
            }
        )
    })
    .expect("the blur layer");
    let picture = pos(cmds, |c| matches!(c, DisplayCommand::Image { .. })).expect("picture");
    let close = (open..cmds.len())
        .find(|&i| matches!(cmds[i], DisplayCommand::PopLayer(_)))
        .expect("closed");
    assert!(
        open < picture && picture < close,
        "{open} {picture} {close}"
    );
}

/// A filled anchored frame without a picture casts its shadow from its
/// outline in the story pass, as a free frame does.
#[test]
#[allow(non_snake_case)]
fn a_filled_anchored_frame_casts_its_shadow__feat__anchored_inline_objects_anchored_effects() {
    let mut doc = document("");
    let af = &mut doc.stories[0].story.paragraphs[0].anchored_frames[0];
    af.image_link = None;
    af.fill_color = Some("Color/Black".into());
    af.drop_shadow = Some(paged_model::DropShadowSetting {
        mode: "Drop".into(),
        x_offset: 6.0,
        y_offset: 6.0,
        size: 2.0,
        opacity_pct: 80.0,
        effect_color: Some("Color/Black".into()),
        ..Default::default()
    });
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&doc, &opts).unwrap();
    let cmds = &built.pages[0].list.commands;
    let shadow = pos(cmds, |c| matches!(c, DisplayCommand::DropShadow { .. })).expect("shadow");
    // The frame's own fill: the 60 pt box, painted after its shadow.
    let fill = pos(cmds, |c| {
        matches!(c, DisplayCommand::FillPath { transform, .. } if (transform.0[0] - 60.0).abs() < 0.01)
    })
    .expect("the frame's fill");
    assert!(shadow < fill, "the shadow is under the fill");
}
