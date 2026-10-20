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

//! An object feather fades the frame's stroke and a text frame's text.
//!
//! InDesign feathers the whole object (engine ADR 204). On a stroked
//! frame the feather's band is measured from the stroke's OUTER edge,
//! so the feathers are built on the frame's outline grown to that edge
//! and come after the stroke. A text frame's text is moved into the
//! frame's run before its feathers; a text frame with neither a fill nor
//! a stroke paints only its text, and its feather follows the glyphs.

use std::io::Write;

use paged_compose::{Color, DisplayCommand, DisplayList, PathId, PathSegment, Transform};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const FEATHER: &str = r#"<FeatherSetting Mode="Standard" Width="10" CornerType="Sharp"/>"#;

/// A one-page package holding `items` (spread XML) and, when given, one
/// story `s1` of `text` in Open Sans 30 pt.
fn package(items: &str, text: Option<&str>) -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let mut put = |path: &str, body: &str| {
        zip.start_file(path, deflated).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    let story_ref = if text.is_some() {
        r#"<idPkg:Story src="Stories/Story_s1.xml"/>"#
    } else {
        ""
    };
    put(
        "designmap.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<idPkg:Graphic src="Resources/Graphic.xml"/>
<idPkg:Spread src="Spreads/Spread_sp1.xml"/>
{story_ref}
</Document>"#
        ),
    );
    put(
        "Resources/Graphic.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Black" Name="Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100"/>
  <Color Self="Color/Yellow" Name="Yellow" Model="Process" Space="CMYK" ColorValue="0 0 100 0"/>
</idPkg:Graphic>"#,
    );
    put(
        "Spreads/Spread_sp1.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Spread Self="sp1">
<Page Self="p1" GeometricBounds="0 0 200 200"/>
{items}
</Spread>
</idPkg:Spread>"#
        ),
    );
    if let Some(text) = text {
        put(
            "Stories/Story_s1.xml",
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0"><Story Self="s1"><ParagraphStyleRange><CharacterStyleRange AppliedFont="Open Sans" FontStyle="Regular" PointSize="30" FillColor="Color/Black"><Content>{text}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>"#
            ),
        );
    }
    zip.finish().unwrap().into_inner()
}

/// A 120 pt square frame at (40, 40) with `attrs` and `effects`.
fn rectangle(attrs: &str, effects: &str) -> String {
    format!(
        r#"<Rectangle Self="r1" GeometricBounds="40 40 160 160" {attrs}><TransparencySetting>{effects}</TransparencySetting></Rectangle>"#
    )
}

/// A 120 × 60 pt text frame at (40, 70) holding story `s1`, with `attrs`
/// and `effects`, its text set from its left edge.
fn text_frame(attrs: &str, effects: &str) -> String {
    format!(
        r#"<TextFrame Self="t1" ParentStory="s1" GeometricBounds="70 40 130 160" {attrs}><Properties/><TransparencySetting>{effects}</TransparencySetting><TextFramePreference InsetSpacing="0 0 0 0"/></TextFrame>"#
    )
}

fn resolver() -> BytesResolver {
    let font = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../corpus/fonts/OpenSans.ttf"),
    )
    .expect("corpus/fonts/OpenSans.ttf");
    let mut r = BytesResolver::new();
    r.add_font("Open Sans", None, font);
    r
}

fn build(items: &str, text: Option<&str>) -> DisplayList {
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package(items, text)).unwrap();
    let mut built = pipeline::build_document(&document, &opts).unwrap();
    built.pages.swap_remove(0).list
}

fn render(items: &str, text: Option<&str>) -> image::RgbaImage {
    let br = resolver();
    let opts = PipelineOptions {
        assets: Some(&br),
        ..PipelineOptions::default()
    };
    let document = idml_import::import_idml_doc(&package(items, text)).unwrap();
    let (_built, images) = pipeline::render_document(&document, &opts, 72.0, Color::WHITE).unwrap();
    images.into_iter().next().unwrap()
}

/// How far a pixel has faded from black toward the white paper.
fn fade(img: &image::RgbaImage, x: u32, y: u32) -> f32 {
    let p = img.get_pixel(x, y).0;
    (p[0] as f32 + p[1] as f32 + p[2] as f32) / (3.0 * 255.0)
}

/// The page-space bounds of `path_id` under `transform`.
fn page_bounds(list: &DisplayList, path_id: PathId, transform: &Transform) -> [f32; 4] {
    let path = list.paths.get(path_id).expect("path");
    let mut b = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for seg in &path.segments {
        let pts: Vec<(f32, f32)> = match *seg {
            PathSegment::MoveTo { x, y } | PathSegment::LineTo { x, y } => vec![(x, y)],
            PathSegment::QuadTo { x, y, .. } | PathSegment::CubicTo { x, y, .. } => vec![(x, y)],
            PathSegment::Close => vec![],
        };
        for (x, y) in pts {
            let (x, y) = transform.apply(x, y);
            b = [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)];
        }
    }
    b
}

/// The marker, the first feather, and the marker's pair.
fn marker_and_feather(list: &DisplayList) -> (usize, usize, PathId, Transform, bool) {
    let (m, pid, xf, content) = list
        .commands
        .iter()
        .enumerate()
        .find_map(|(i, c)| match c {
            DisplayCommand::BeginFeatheredObject {
                path_id,
                transform,
                content_shaped,
            } => Some((i, *path_id, *transform, *content_shaped)),
            _ => None,
        })
        .expect("a marker");
    let f = list
        .commands
        .iter()
        .position(|c| matches!(c, DisplayCommand::Feather { .. }))
        .expect("a feather");
    match &list.commands[f] {
        DisplayCommand::Feather {
            path_id, transform, ..
        } => {
            assert_eq!(
                (*path_id, *transform),
                (pid, xf),
                "the feather carries the marker's pair"
            );
        }
        _ => unreachable!(),
    }
    (m, f, pid, xf, content)
}

fn assert_near(got: [f32; 4], want: [f32; 4]) {
    for (g, w) in got.iter().zip(want) {
        assert!((g - w).abs() < 0.05, "bounds {got:?}, want {want:?}");
    }
}

/// The stroke paints between the marker and the feather, and the feather
/// is built on the frame grown to the stroke's outer edge: half the
/// weight for a centred stroke, all of it outside, none inside.
#[test]
fn the_feather_follows_the_stroke_and_is_built_on_its_outer_edge() {
    for (alignment, outset) in [
        ("", 4.0),
        (r#"StrokeAlignment="OutsideAlignment""#, 8.0),
        (r#"StrokeAlignment="InsideAlignment""#, 0.0),
    ] {
        let attrs = format!(r#"StrokeWeight="8" StrokeColor="Color/Black" {alignment}"#);
        let list = build(&rectangle(&attrs, FEATHER), None);
        let (m, f, pid, xf, content) = marker_and_feather(&list);
        assert!(!content, "a stroked frame keeps its own outline");
        let stroke = list
            .commands
            .iter()
            .position(|c| matches!(c, DisplayCommand::StrokePath { .. }))
            .expect("a stroke");
        assert!(
            m < stroke && stroke < f,
            "{alignment}: marker {m}, stroke {stroke}, feather {f}"
        );
        assert_near(
            page_bounds(&list, pid, &xf),
            [40.0 - outset, 40.0 - outset, 160.0 + outset, 160.0 + outset],
        );
    }
}

/// An oval's feather outline is the ellipse grown by the stroke too.
#[test]
fn an_ovals_feather_is_built_on_its_strokes_outer_edge() {
    let oval = format!(
        r#"<Oval Self="o1" GeometricBounds="40 40 160 160" StrokeWeight="8" StrokeColor="Color/Black"><TransparencySetting>{FEATHER}</TransparencySetting></Oval>"#
    );
    let list = build(&oval, None);
    let (m, f, pid, xf, _) = marker_and_feather(&list);
    assert!(m < f);
    assert_near(page_bounds(&list, pid, &xf), [36.0, 36.0, 164.0, 164.0]);
}

/// On the canvas the stroke's outer half fades: at 1 pt inside its
/// outer edge it is well on its way to the paper, at 7 pt it is still
/// nearly black. Unfeathered, both are black.
#[test]
fn the_stroke_fades_from_its_outer_edge() {
    let attrs = r#"StrokeWeight="8" StrokeColor="Color/Black""#;
    let plain = render(&rectangle(attrs, ""), None);
    let feathered = render(&rectangle(attrs, FEATHER), None);
    assert!(
        fade(&plain, 36, 100) < 0.1,
        "unfeathered, the stroke is black"
    );
    let outer = fade(&feathered, 36, 100);
    let inner = fade(&feathered, 43, 100);
    assert!(outer > 0.3, "the stroke's outer edge fades: {outer}");
    assert!(
        inner < outer,
        "the fade runs inward from the outer edge: {inner} vs {outer}"
    );
}

/// A filled text frame's glyphs sit between its marker and its feather,
/// so the feather fades the text with the box.
#[test]
fn a_text_frames_text_is_inside_its_feathered_run() {
    let list = build(
        &text_frame(r#"FillColor="Color/Yellow""#, FEATHER),
        Some("HHHH"),
    );
    let (m, f, _, _, content) = marker_and_feather(&list);
    assert!(!content, "a filled frame keeps its own outline");
    let fills = list.commands[m + 1..f]
        .iter()
        .filter(|c| matches!(c, DisplayCommand::FillPath { .. }))
        .count();
    assert!(
        fills >= 5,
        "the box's fill and four glyphs are in the run, found {fills}"
    );
    assert!(
        !list.commands[f + 1..]
            .iter()
            .any(|c| matches!(c, DisplayCommand::FillPath { .. })),
        "no glyph paints after the feather"
    );
}

/// The glyph nearest the frame's left edge fades on the canvas.
#[test]
fn a_text_frames_feather_fades_its_text_at_the_edge() {
    let plain = render(&text_frame(r#"FillColor="Color/Yellow""#, ""), Some("HHHH"));
    let feathered = render(
        &text_frame(r#"FillColor="Color/Yellow""#, FEATHER),
        Some("HHHH"),
    );
    // The darkest pixel of the first H's left stem, in its middle row.
    let y = 90;
    let x = (40..52)
        .min_by(|&a, &b| fade(&plain, a, y).total_cmp(&fade(&plain, b, y)))
        .unwrap();
    assert!(fade(&plain, x, y) < 0.2, "a stem at ({x}, {y})");
    assert!(
        fade(&feathered, x, y) > fade(&plain, x, y) + 0.15,
        "the stem at the edge fades: {} vs {}",
        fade(&feathered, x, y),
        fade(&plain, x, y)
    );
}

/// With neither a fill nor a stroke the frame paints only its text, and
/// the feather is rebuilt on the glyphs: its outline spans the ink, not
/// the frame, and a stem far from the frame's edge fades as much as one
/// beside it.
#[test]
fn an_unfilled_text_frames_feather_follows_its_glyphs() {
    let list = build(&text_frame("", FEATHER), Some("HHHH"));
    let (m, f, pid, xf, content) = marker_and_feather(&list);
    assert!(
        content,
        "an unfilled, unstroked text frame is shaped by its content"
    );
    let glyphs = list.commands[m + 1..f]
        .iter()
        .filter(|c| matches!(c, DisplayCommand::FillPath { .. }))
        .count();
    assert_eq!(glyphs, 4, "the four glyphs are in the run");
    let b = page_bounds(&list, pid, &xf);
    assert!(
        b[1] > 75.0 && b[3] < 125.0,
        "the outline spans the ink, not the frame: {b:?}"
    );

    let plain = render(&text_frame("", ""), Some("HHHH"));
    let feathered = render(&text_frame("", FEATHER), Some("HHHH"));
    // A stem near the middle of the frame, 50 pt from either edge.
    let y = 90;
    let x = (90..110)
        .min_by(|&a, &b| fade(&plain, a, y).total_cmp(&fade(&plain, b, y)))
        .unwrap();
    assert!(fade(&plain, x, y) < 0.2, "a stem at ({x}, {y})");
    assert!(
        fade(&feathered, x, y) > 0.4,
        "the stem fades with its own edges: {}",
        fade(&feathered, x, y)
    );
}
