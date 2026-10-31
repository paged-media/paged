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

//! Engine ADR 1042 — live vector effects, drawn.
//!
//! Black squares on a 200 pt page, drawn by the CPU rasterizer (and, with
//! the `gpu` feature, by Vello: the two lanes agree). The renderer draws
//! the item its effected outline describes: a Zig Zag paints past the
//! square's edge and leaves notches in it; a switched-off entry draws the
//! source; an oval under Pucker & Bloat is a path; Outline Stroke paints
//! the band in the stroke's colour and leaves the middle empty; a group
//! with a Pathfinder effect is one outline (Minus Front leaves the
//! overlap empty).

use std::io::Write;

use paged_gpu::RasterOptions;
use paged_model::effect_stack::{Effect, EffectEntry};
use paged_model::vector_effect::*;
use paged_model::{FrameRef, Group};
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
  <Color Self="Color/Black" Model="Process" Space="CMYK" ColorValue="0 0 0 100" Name="Black"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>"#,
    )
    .unwrap();
    zip.start_file("Spreads/Spread_sp1.xml", deflated).unwrap();
    zip.write_all(spread.as_bytes()).unwrap();
    zip.finish().unwrap().into_inner()
}

const SQUARE: &str = r#"<Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="Color/Black" StrokeWeight="0"/>"#;

fn doc(items: &str) -> Document {
    idml_import::import_idml_doc(&idml(items)).expect("import")
}

fn list(d: &Document) -> paged_compose::DisplayList {
    let built = build_document(d, &PipelineOptions::default()).expect("build");
    built.pages.into_iter().next().expect("a page").list
}

fn opts() -> RasterOptions {
    let mut o = RasterOptions::new(200.0, 200.0);
    o.dpi = 72.0;
    o
}

fn pixels(d: &Document) -> image::RgbaImage {
    paged_gpu::rasterize(&list(d), &opts())
}

fn luma(img: &image::RgbaImage, x: u32, y: u32) -> u8 {
    let p = img.get_pixel(x, y).0;
    ((p[0] as u32 + p[1] as u32 + p[2] as u32) / 3) as u8
}

fn zig() -> EffectEntry {
    EffectEntry::new(Effect::ZigZag(ZigZagParams {
        size: 8.0,
        ridges: 4,
        ..Default::default()
    }))
}

#[test]
#[allow(non_snake_case)]
fn a_zig_zag_draws_past_and_into_the_edge__feat__effects_transparency_live_vector_effects() {
    let plain = doc(SQUARE);
    let before = pixels(&plain);
    let mut d = doc(SQUARE);
    d.spreads[0].spread.rectangles[0].effect_stack = vec![zig()];
    let img = pixels(&d);
    // Top edge, 100 pt long: ridge points at x = 70, 90, 110, 130, the
    // first inward (y 58), the second outward (y 42).
    assert!(
        luma(&before, 90, 45) > 200,
        "nothing above the plain square"
    );
    assert!(luma(&img, 90, 45) < 60, "the outward ridge paints above it");
    assert!(luma(&img, 70, 55) > 200, "the inward ridge leaves a notch");
    assert!(luma(&img, 100, 100) < 60, "the middle stays filled");
}

#[test]
fn a_switched_off_entry_draws_the_source() {
    let plain = list(&doc(SQUARE)).digest();
    let mut d = doc(SQUARE);
    let mut off = zig();
    off.enabled = false;
    d.spreads[0].spread.rectangles[0].effect_stack = vec![off];
    assert_eq!(list(&d).digest(), plain);
}

#[test]
fn an_oval_under_pucker_and_bloat_is_a_path() {
    let oval = r#"<Oval Self="ov" GeometricBounds="50 50 150 150" FillColor="Color/Black" StrokeWeight="0"/>"#;
    let plain = pixels(&doc(oval));
    let mut d = doc(oval);
    d.spreads[0].spread.ovals[0].effect_stack =
        vec![EffectEntry::new(Effect::PuckerBloat(PuckerBloatParams {
            amount_pct: -60.0,
        }))];
    let img = pixels(&d);
    // A pucker pulls the curves in between the anchors: the circle's
    // diagonal edge (at 45°, ~85 pt from the corner) is now empty.
    assert!(luma(&plain, 70, 70) < 60);
    assert!(luma(&img, 70, 70) > 200);
    // The anchors move out: past the circle's top.
    assert!(luma(&img, 100, 45) < 60);
}

#[test]
fn outline_stroke_paints_the_band_in_the_stroke_colour() {
    let stroked = r#"<Rectangle Self="sq" GeometricBounds="50 50 150 150" FillColor="Color/Black" StrokeColor="Color/Red" StrokeWeight="10"/>"#;
    let mut d = doc(stroked);
    d.spreads[0].spread.rectangles[0].effect_stack =
        vec![EffectEntry::new(Effect::OutlinePath(OutlinePathParams {}))];
    let img = pixels(&d);
    let mid = img.get_pixel(100, 100).0;
    assert!(mid[0] > 200 && mid[1] > 200, "the middle is empty: {mid:?}");
    let band = img.get_pixel(50, 100).0;
    assert!(band[0] > 200 && band[1] < 60, "the band is red: {band:?}");
}

fn two_squares() -> Document {
    let items = r#"<Rectangle Self="a" GeometricBounds="40 40 120 120" FillColor="Color/Black" StrokeWeight="0"/>
    <Rectangle Self="b" GeometricBounds="80 80 160 160" FillColor="Color/Red" StrokeWeight="0"/>"#;
    let mut d = doc(items);
    let spread = &mut d.spreads[0].spread;
    spread.groups.push(Group {
        self_id: Some("g".into()),
        members: vec![FrameRef::Rectangle(0), FrameRef::Rectangle(1)],
        ..Default::default()
    });
    spread.frames_in_order = vec![FrameRef::Group(0)];
    d
}

#[test]
fn a_group_with_a_pathfinder_effect_draws_one_outline() {
    let mut d = two_squares();
    let plain = pixels(&d);
    assert!(luma(&plain, 100, 100) < 120, "the overlap is painted");
    d.spreads[0].spread.groups[0].effect_stack =
        vec![EffectEntry::new(Effect::Pathfinder(PathfinderParams {
            op: PathfinderOp::Subtract,
        }))];
    let img = pixels(&d);
    assert!(
        luma(&img, 100, 100) > 200,
        "Minus Front empties the overlap"
    );
    assert!(luma(&img, 60, 60) < 60, "the back square keeps its black");
    assert!(luma(&img, 140, 140) > 200, "the front square is gone");
    d.spreads[0].spread.groups[0].effect_stack =
        vec![EffectEntry::new(Effect::Pathfinder(PathfinderParams {
            op: PathfinderOp::Add,
        }))];
    let united = pixels(&d);
    let p = united.get_pixel(60, 60).0;
    assert!(
        p[0] > 200 && p[1] < 60,
        "Unite paints in the front member's red: {p:?}"
    );
}

#[test]
fn the_display_list_of_an_item_without_vector_entries_is_unchanged() {
    // The other effect kinds and the source outline: no vector entry, no
    // change (ADR 101's digest).
    let plain = list(&doc(SQUARE)).digest();
    let mut d = doc(SQUARE);
    d.spreads[0].spread.rectangles[0].effect_stack = vec![];
    assert_eq!(list(&d).digest(), plain);
}

#[cfg(feature = "gpu")]
#[test]
#[allow(non_snake_case)]
fn both_lanes_draw_vector_effects_alike__feat__effects_transparency_live_vector_effects() {
    use paged_gpu::vello_rs::VelloRasterizer;
    use paged_gpu::{CpuRasterizer, PathRasterizer};
    use paged_test_resources::{skip, Resource};
    let mut d = two_squares();
    d.spreads[0].spread.groups[0].effect_stack = vec![
        EffectEntry::new(Effect::Pathfinder(PathfinderParams {
            op: PathfinderOp::Exclude,
        })),
        EffectEntry::new(Effect::Twist(TwistParams { angle_deg: 40.0 })),
    ];
    let l = list(&d);
    let cpu = CpuRasterizer.rasterize(&l, &opts());
    let gpu = VelloRasterizer::new().rasterize(&l, &opts());
    if paged_test_resources::gpu_forced_off() {
        skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
    }
    if gpu.iter().all(|b| *b == 0) {
        skip!(
            Resource::Gpu,
            "no wgpu adapter: Vello returned its zero-fill fallback"
        );
    }
    let differ = cpu
        .chunks(4)
        .zip(gpu.chunks(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 96))
        .count();
    assert!(
        differ * 100 < cpu.len() / 4,
        "{differ} pixels differ between the lanes"
    );
}
