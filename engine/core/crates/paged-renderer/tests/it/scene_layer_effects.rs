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

//! Engine ADR 1046 — a plugin scene layer is the frame's own content: it
//! paints inside the frame's object group and inside the run the frame's
//! effect stack applies to, so the frame's opacity, blend mode and effects
//! take it with the box. A 100 pt square on a 200 pt page, drawn by the
//! CPU rasterizer at one pixel per pt, with a red scene layer over its
//! left half.

use std::collections::HashMap;
use std::io::Write;

use paged_compose::{
    BlendMode, DisplayCommand, DisplayList, LayerEffect, SceneItem, SceneLayer, ScenePaint,
    ScenePathSeg,
};
use paged_gpu::RasterOptions;
use paged_model::effect_stack::{
    Effect, EffectBearing, EffectEntry, EffectTarget, GaussianBlurParams,
};
use paged_renderer::pipeline::{build_document, PipelineOptions};
use paged_scene::Document;

fn idml(fill: &str) -> Vec<u8> {
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
    let spread = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 200 200"/>
    <Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="{fill}" StrokeWeight="0"/>
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
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

fn doc(fill: &str) -> Document {
    idml_import::import_idml_doc(&idml(fill)).expect("import")
}

/// Red over the left half of the content box: content points 0..50 × 0..100,
/// page points 50..100 × 50..150.
fn red_half() -> SceneLayer {
    SceneLayer {
        items: vec![SceneItem::FillPath {
            path: vec![
                ScenePathSeg::MoveTo { x: 0.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 50.0, y: 0.0 },
                ScenePathSeg::LineTo { x: 50.0, y: 100.0 },
                ScenePathSeg::LineTo { x: 0.0, y: 100.0 },
                ScenePathSeg::Close,
            ],
            paint: ScenePaint {
                r: 1.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            },
        }],
    }
}

fn list(d: &Document, layer: Option<SceneLayer>) -> DisplayList {
    let mut reg = HashMap::new();
    if let Some(l) = layer {
        reg.insert("sq".to_string(), l);
    }
    let opts = PipelineOptions {
        scene_layers: Some(&reg),
        ..PipelineOptions::default()
    };
    let built = build_document(d, &opts).expect("build");
    built.pages.into_iter().next().expect("a page").list
}

fn pixels(l: &DisplayList) -> image::RgbaImage {
    let mut opts = RasterOptions::new(200.0, 200.0);
    opts.dpi = 72.0;
    paged_gpu::rasterize(l, &opts)
}

/// Index of the scene layer's red fill.
fn red_fill(l: &DisplayList) -> usize {
    l.commands
        .iter()
        .position(|c| match c {
            DisplayCommand::FillPath {
                paint: paged_compose::Paint::Solid(c),
                ..
            } => c.r > 0.9 && c.g < 0.1 && c.b < 0.1,
            _ => false,
        })
        .expect("the scene layer's red fill")
}

/// The openers enclosing command `at`, outermost first.
fn enclosing(l: &DisplayList, at: usize) -> Vec<DisplayCommand> {
    let mut stack: Vec<DisplayCommand> = Vec::new();
    for c in &l.commands[..at] {
        match c {
            DisplayCommand::BeginBlendGroup { .. } | DisplayCommand::PushLayer { .. } => {
                stack.push(c.clone())
            }
            DisplayCommand::EndBlendGroup(_) | DisplayCommand::PopLayer(_) => {
                stack.pop();
            }
            _ => {}
        }
    }
    stack
}

fn set_opacity(mut d: Document, opacity: f32, blend: Option<&str>) -> Document {
    let r = &mut d.spreads[0].spread.rectangles[0];
    r.opacity = Some(opacity);
    r.blend_mode = blend.map(str::to_string);
    d
}

fn with_blur(mut d: Document, radius_pt: f32) -> Document {
    d.spreads[0].spread.rectangles[0]
        .effect_slots_mut(EffectTarget::Object)
        .set_stack(vec![EffectEntry::new(Effect::GaussianBlur(
            GaussianBlurParams { radius_pt },
        ))])
        .expect("stack");
    d
}

#[test]
#[allow(non_snake_case)]
fn a_frames_opacity_fades_its_scene_layer_with_it__feat__effects_transparency_scene_layer_effects()
{
    let d = set_opacity(doc("Color/Black"), 50.0, None);
    let l = list(&d, Some(red_half()));
    let at = red_fill(&l);
    let groups = enclosing(&l, at);
    assert!(
        groups.iter().any(|g| matches!(
            g,
            DisplayCommand::BeginBlendGroup { opacity, .. } if (*opacity - 0.5).abs() < 1e-6
        )),
        "the scene fill sits in the frame's 50 % group: {groups:?}"
    );
    // The red over the black square at half opacity: a light red, not the
    // opaque red an ungrouped layer painted over the faded box.
    let img = pixels(&l);
    let p = img.get_pixel(75, 100).0;
    assert!(
        p[0] > 200 && p[1] > 90 && p[2] > 90,
        "red at 50 % over paper, got {p:?}"
    );
    // The right half is the faded black box alone.
    let q = img.get_pixel(125, 100).0;
    assert!(q[0] > 90 && q[0] < 220, "grey at 50 %, got {q:?}");
    // Inside the group the layer covers the box: no black shows through.
    assert!(p[1] == p[2], "the box does not show through the red: {p:?}");
}

#[test]
#[allow(non_snake_case)]
fn a_frames_blend_mode_composites_its_scene_layer__feat__effects_transparency_scene_layer_effects()
{
    let d = set_opacity(doc("Color/Black"), 100.0, Some("Multiply"));
    let l = list(&d, Some(red_half()));
    let groups = enclosing(&l, red_fill(&l));
    assert!(
        groups.iter().any(|g| matches!(
            g,
            DisplayCommand::BeginBlendGroup {
                blend_mode: BlendMode::Multiply,
                ..
            }
        )),
        "the scene fill composites in the frame's Multiply group: {groups:?}"
    );
}

#[test]
#[allow(non_snake_case)]
fn a_frames_blur_reaches_its_scene_layer__feat__effects_transparency_scene_layer_effects() {
    // No fill: the frame paints only its scene layer.
    let sharp = list(&doc("Swatch/None"), Some(red_half()));
    let blurred_doc = with_blur(doc("Swatch/None"), 6.0);
    let blurred = list(&blurred_doc, Some(red_half()));
    let groups = enclosing(&blurred, red_fill(&blurred));
    assert!(
        groups.iter().any(|g| matches!(
            g,
            DisplayCommand::PushLayer {
                effect: LayerEffect::GaussianBlur { .. },
                ..
            }
        )),
        "the scene fill sits in the blur layer: {groups:?}"
    );
    // The red's right edge (page x = 100) is hard without the blur and
    // graded with it: a pixel 3 pt past the edge picks up red.
    let a = pixels(&sharp);
    let b = pixels(&blurred);
    assert_eq!(a.get_pixel(103, 100).0[1], 255, "white past a sharp edge");
    let p = b.get_pixel(103, 100).0;
    assert!(p[1] < 250 && p[0] > p[1], "red bleeds past the edge: {p:?}");
    let inside = b.get_pixel(96, 100).0;
    assert!(inside[1] > 5, "the edge softens inward too: {inside:?}");
}

#[test]
#[allow(non_snake_case)]
fn a_plain_frame_keeps_its_scene_layer_on_top__feat__effects_transparency_scene_layer_effects() {
    // No group and no stack: the layer is appended after the box, as
    // before, and draws opaque red over the black square.
    let l = list(&doc("Color/Black"), Some(red_half()));
    let at = red_fill(&l);
    assert!(enclosing(&l, at).is_empty(), "nothing wraps the layer");
    let p = pixels(&l).get_pixel(75, 100).0;
    assert!(p[0] > 240 && p[1] < 10, "opaque red, got {p:?}");
}

/// A text frame's scene layer moves into the body's object group, under
/// the frame's story text (which stays frontmost).
#[test]
#[allow(non_snake_case)]
fn a_text_frames_scene_layer_sits_in_its_group__feat__effects_transparency_scene_layer_effects() {
    let idml = paged_gen::write_idml(&paged_gen::samples::text::build()).unwrap();
    let mut d = idml_import::import_idml_doc(&idml).unwrap();
    let frame = d
        .spreads
        .iter_mut()
        .flat_map(|s| s.spread.text_frames.iter_mut())
        .find(|f| f.self_id.is_some())
        .expect("a text frame");
    frame.opacity = Some(40.0);
    let id = frame.self_id.clone().unwrap();
    let mut reg = HashMap::new();
    reg.insert(id, red_half());
    let opts = PipelineOptions {
        scene_layers: Some(&reg),
        ..PipelineOptions::default()
    };
    let built = build_document(&d, &opts).expect("build");
    let page = built
        .pages
        .iter()
        .find(|p| !p.scene_layer_frames.is_empty())
        .expect("the page with the layer");
    let at = red_fill(&page.list);
    let groups = enclosing(&page.list, at);
    assert!(
        groups.iter().any(|g| matches!(
            g,
            DisplayCommand::BeginBlendGroup { opacity, .. } if (*opacity - 0.4).abs() < 1e-6
        )),
        "the scene fill sits in the text frame's 40 % group: {groups:?}"
    );
}
