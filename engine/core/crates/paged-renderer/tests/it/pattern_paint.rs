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

//! Engine ADR 1041 — a pattern swatch through the renderer: the tile
//! repeated from the frame's box origin, the lattice, the frame's own
//! pattern transform, the clip to the outline, a pattern stroke, a
//! missing pattern, and a document without one unchanged.
//!
//! The `__feat__color_swatches_pattern_paint` suffix links these tests to
//! the `color-swatches.pattern-paint` feature row.
#![allow(non_snake_case)]

use std::io::Write;

use paged_compose::{Color, Paint};
use paged_model::{
    FillRule, PathAnchor, PatternColor, PatternEntry, PatternItem, PatternLayout, PatternPlacement,
    PatternTileKind,
};
use paged_renderer::pipeline::{self, PipelineOptions};
use paged_scene::Document;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

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
    <Color Self="Color/Red" Name="Red" Space="RGB" ColorValue="255 0 0"/>
    <Color Self="Color/Sun" Name="Sun" Space="RGB" ColorValue="255 200 80"/>
    <Color Self="Color/Magenta" Name="Magenta" Space="CMYK" ColorValue="0 100 0 0"/>
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

/// A 200 × 200 square at x 100..300, y 50..250.
const SQUARE: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Color/Sun" StrokeWeight="0"/>"#;
const OVAL: &str =
    r#"<Oval Self="o1" GeometricBounds="50 100 250 300" FillColor="Color/Sun" StrokeWeight="0"/>"#;
/// A horizontal line at y 150 from x 100 to 300, 20 pt wide.
const LINE: &str = r#"<GraphicLine Self="l1" StrokeColor="Color/Sun" StrokeWeight="20"><Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray><PathPointType Anchor="100 150" LeftDirection="100 150" RightDirection="100 150"/><PathPointType Anchor="300 150" LeftDirection="300 150" RightDirection="300 150"/></PathPointArray></GeometryPathType></PathGeometry></Properties></GraphicLine>"#;

fn doc(item: &str) -> Document {
    idml_import::import_idml_doc(&idml(item)).expect("import")
}

fn square_item(x: f32, y: f32, s: f32, color: PatternColor) -> PatternItem {
    let p = |x: f32, y: f32| PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    PatternItem {
        anchors: vec![p(x, y), p(x + s, y), p(x + s, y + s), p(x, y + s)],
        subpath_starts: vec![],
        subpath_open: vec![],
        fill_rule: FillRule::NonZero,
        fill: Some(color),
        stroke: None,
        stroke_weight: 0.0,
    }
}

/// A 20 × 20 tile with a red 10 × 10 square in its top-left quarter.
fn checker(kind: PatternTileKind) -> PatternEntry {
    PatternEntry {
        self_id: "Pattern/check".into(),
        name: Some("Check".into()),
        width: 20.0,
        height: 20.0,
        layout: PatternLayout {
            kind,
            ..Default::default()
        },
        placement: PatternPlacement::default(),
        items: vec![square_item(
            0.0,
            0.0,
            10.0,
            PatternColor::Swatch("Color/Red".into()),
        )],
    }
}

fn with_pattern(mut d: Document, pattern: PatternEntry) -> Document {
    let id = pattern.self_id.clone();
    d.palette.patterns.insert(id.clone(), pattern);
    let sp = &mut d.spreads[0].spread;
    for r in &mut sp.rectangles {
        r.fill_color = Some(id.clone());
    }
    for o in &mut sp.ovals {
        o.fill_color = Some(id.clone());
    }
    for l in &mut sp.graphic_lines {
        l.stroke_color = Some(id.clone());
    }
    d
}

fn render(doc: &Document) -> (image::RgbaImage, u64, usize) {
    let (built, images) =
        pipeline::render_document(doc, &PipelineOptions::default(), 72.0, Color::WHITE)
            .expect("render");
    let list = &built.pages[0].list;
    (
        images.into_iter().next().unwrap(),
        list.digest(),
        list.patterns.len(),
    )
}

fn px(img: &image::RgbaImage, x: u32, y: u32) -> [i32; 3] {
    let p = img.get_pixel(x, y).0;
    [i32::from(p[0]), i32::from(p[1]), i32::from(p[2])]
}

fn dist(a: [i32; 3], b: [i32; 3]) -> i32 {
    (0..3).map(|i| (a[i] - b[i]).abs()).max().unwrap_or(0)
}

const RED: [i32; 3] = [255, 0, 0];
const WHITE: [i32; 3] = [255, 255, 255];
const SUN: [i32; 3] = [255, 200, 80];

#[test]
fn a_pattern_fill_repeats_its_tile_from_the_box_origin__feat__color_swatches_pattern_paint() {
    let d = with_pattern(doc(SQUARE), checker(PatternTileKind::Grid));
    let (img, _, n) = render(&d);
    assert_eq!(n, 1, "one pattern use");
    // Tile (0, 0) at the box's top-left (100, 50): red 100..110 × 50..60.
    for (x, y) in [(105, 55), (125, 55), (105, 75), (285, 235)] {
        assert!(
            dist(px(&img, x, y), RED) < 6,
            "red at {x},{y}: {:?}",
            px(&img, x, y)
        );
    }
    // The other three quarters are empty: the page shows.
    for (x, y) in [(115, 55), (105, 65), (115, 65), (295, 245)] {
        assert!(
            dist(px(&img, x, y), WHITE) < 6,
            "page at {x},{y}: {:?}",
            px(&img, x, y)
        );
    }
    // Outside the frame: the page.
    assert_eq!(px(&img, 90, 150), WHITE);
}

#[test]
fn a_brick_row_shifts_every_other_row_by_half__feat__color_swatches_pattern_paint() {
    let d = with_pattern(doc(SQUARE), checker(PatternTileKind::BrickByRow));
    let (img, _, _) = render(&d);
    // Row 0 as the grid; row 1 (y 70..80) shifted 10 pt: red at x 110..120.
    assert!(dist(px(&img, 105, 55), RED) < 6);
    assert!(dist(px(&img, 115, 75), RED) < 6, "{:?}", px(&img, 115, 75));
    assert!(
        dist(px(&img, 105, 75), WHITE) < 6,
        "{:?}",
        px(&img, 105, 75)
    );
}

#[test]
fn the_placement_and_the_frames_own_transform_move_the_tile__feat__color_swatches_pattern_paint() {
    let mut p = checker(PatternTileKind::Grid);
    p.placement.offset = [5.0, 0.0];
    let mut d = with_pattern(doc(SQUARE), p);
    let (img, _, _) = render(&d);
    assert!(
        dist(px(&img, 102, 55), WHITE) < 6,
        "{:?}",
        px(&img, 102, 55)
    );
    assert!(dist(px(&img, 112, 55), RED) < 6, "{:?}", px(&img, 112, 55));
    // The frame's own transform moves it down 10 more.
    d.spreads[0].spread.rectangles[0].pattern_transform = Some([1.0, 0.0, 0.0, 1.0, 0.0, 10.0]);
    let (img, _, _) = render(&d);
    assert!(
        dist(px(&img, 112, 55), WHITE) < 6,
        "{:?}",
        px(&img, 112, 55)
    );
    assert!(dist(px(&img, 112, 65), RED) < 6, "{:?}", px(&img, 112, 65));
    // Doubled in scale: the red square is 20 pt.
    let mut p = checker(PatternTileKind::Grid);
    p.placement.scale = [2.0, 2.0];
    let d = with_pattern(doc(SQUARE), p);
    let (img, _, _) = render(&d);
    assert!(dist(px(&img, 115, 65), RED) < 6, "{:?}", px(&img, 115, 65));
    assert!(
        dist(px(&img, 125, 55), WHITE) < 6,
        "{:?}",
        px(&img, 125, 55)
    );
}

#[test]
fn a_pattern_is_clipped_to_the_frames_outline__feat__color_swatches_pattern_paint() {
    let d = with_pattern(doc(OVAL), checker(PatternTileKind::Grid));
    let (img, _, _) = render(&d);
    // The box's corner tile is outside the ellipse.
    assert_eq!(px(&img, 103, 53), WHITE);
    // Tile (4, 4) at x 180..190, y 130..140 is inside.
    assert!(
        dist(px(&img, 185, 135), RED) < 6,
        "{:?}",
        px(&img, 185, 135)
    );
}

#[test]
fn a_pattern_strokes_a_line__feat__color_swatches_pattern_paint() {
    let d = with_pattern(doc(LINE), checker(PatternTileKind::Grid));
    let (img, _, n) = render(&d);
    assert_eq!(n, 1);
    // The line's box is x 100..300 at y 150 (zero height): tiles from
    // (100, 150). The stroke covers y 140..160: red at y 150..160, the
    // page (the tile's empty half) at y 140..150 under red columns? The
    // tile row above the origin (y 130..150) holds red at y 130..140.
    assert!(
        dist(px(&img, 105, 155), RED) < 6,
        "{:?}",
        px(&img, 105, 155)
    );
    assert!(
        dist(px(&img, 115, 155), WHITE) < 6,
        "{:?}",
        px(&img, 115, 155)
    );
    assert!(
        dist(px(&img, 105, 145), WHITE) < 6,
        "{:?}",
        px(&img, 105, 145)
    );
    // Beyond the stroke: the page.
    assert_eq!(px(&img, 105, 165), WHITE);
}

#[test]
fn inline_and_cmyk_item_colours_resolve__feat__color_swatches_pattern_paint() {
    let mut p = checker(PatternTileKind::Grid);
    p.items[0].fill = Some(PatternColor::Inline(paged_model::InlineStopColor {
        space: paged_model::ColorSpace::Rgb,
        value: vec![0.0, 0.0, 255.0],
    }));
    let d = with_pattern(doc(SQUARE), p);
    let (built, _) = pipeline::render_document(&d, &PipelineOptions::default(), 72.0, Color::WHITE)
        .expect("render");
    let tile = &built.pages[0].list.patterns[0].tile;
    assert!(matches!(tile.items[0].fill, Some(Paint::Solid(c)) if c.b > 0.9 && c.r < 0.1));
}

#[test]
fn a_missing_or_empty_pattern_paints_the_fallback__feat__color_swatches_pattern_paint() {
    // A frame naming a pattern the palette lacks falls back as an unknown
    // swatch does; an empty pattern paints nothing either.
    let mut d = doc(SQUARE);
    d.spreads[0].spread.rectangles[0].fill_color = Some("Pattern/none".into());
    let (_, _, n) = render(&d);
    assert_eq!(n, 0);
    let mut p = checker(PatternTileKind::Grid);
    p.items.clear();
    let d = with_pattern(doc(SQUARE), p);
    let (_, _, n) = render(&d);
    assert_eq!(n, 0);
}

#[test]
fn a_document_without_patterns_keeps_its_digest__feat__color_swatches_pattern_paint() {
    let d = doc(SQUARE);
    let (img, digest, n) = render(&d);
    assert_eq!(n, 0);
    assert_eq!(px(&img, 200, 150), SUN);
    // An unused pattern swatch changes nothing on the page.
    let mut e = doc(SQUARE);
    e.palette
        .patterns
        .insert("Pattern/check".into(), checker(PatternTileKind::Grid));
    let (_, digest2, _) = render(&e);
    assert_eq!(digest, digest2);
}

#[test]
fn a_cmyk_item_keeps_its_ink_channels__feat__color_swatches_pattern_paint() {
    // ADR 106: with a CMYK working profile a CMYK swatch item is a
    // `Paint::Cmyk` in the tile (its inks reach the planes and the PDF).
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        paged_test_resources::unavailable(
            paged_test_resources::Resource::Icc,
            paged_color::test_profiles::NO_PROFILE_HINT,
        );
        return;
    };
    let mut p = checker(PatternTileKind::Grid);
    p.items[0].fill = Some(PatternColor::Swatch("Color/Magenta".into()));
    let d = with_pattern(doc(SQUARE), p);
    let opts = PipelineOptions {
        cmyk_icc_profile: Some(&profile),
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&d, &opts).expect("build");
    let tile = &built.pages[0].list.patterns[0].tile;
    assert!(
        matches!(tile.items[0].fill, Some(Paint::Cmyk { m, .. }) if (m - 1.0).abs() < 1e-4),
        "{:?}",
        tile.items[0].fill
    );
}
