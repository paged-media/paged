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

//! Engine ADR 1040 — a frame's gradient mesh and freeform gradient
//! through the renderer: the clip, the patch colours, the freeform
//! field, opacity over the page, and a frame without one unchanged.
//!
//! The `__feat__color_swatches_mesh_freeform_gradients` suffix links these
//! tests to the `color-swatches.mesh-freeform-gradients` feature row.
#![allow(non_snake_case)]

use std::io::Write;

use paged_compose::{Color, DisplayCommand};
use paged_model::{FreeformGradient, FreeformPoint, GradientMesh, MeshColor, MeshFill, MeshGrid};
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
    <Color Self="Color/Sun" Name="Sun" Space="RGB" ColorValue="255 200 80"/>
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

/// A 200 × 200 square at x 100..300, y 50..250, filled Sun.
const SQUARE: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Color/Sun" StrokeWeight="0"/>"#;
const OVAL: &str =
    r#"<Oval Self="o1" GeometricBounds="50 100 250 300" FillColor="Color/Sun" StrokeWeight="0"/>"#;

fn doc(item: &str) -> Document {
    idml_import::import_idml_doc(&idml(item)).expect("import")
}

fn render(doc: &Document) -> (Vec<DisplayCommand>, image::RgbaImage, u64) {
    let (built, images) =
        pipeline::render_document(doc, &PipelineOptions::default(), 72.0, Color::WHITE)
            .expect("render");
    (
        built.pages[0].list.commands.clone(),
        images.into_iter().next().unwrap(),
        built.pages[0].list.digest(),
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
const GREEN: [i32; 3] = [0, 255, 0];
const BLUE: [i32; 3] = [0, 0, 255];
const YELLOW: [i32; 3] = [255, 255, 0];
const WHITE: [i32; 3] = [255, 255, 255];
const SUN: [i32; 3] = [255, 200, 80];

fn rgb(c: [i32; 3]) -> MeshColor {
    MeshColor::rgb(c[0] as f32, c[1] as f32, c[2] as f32)
}

/// A one-patch mesh over the square's box (its inner coordinates are
/// the page's here), corners red, green / blue, yellow.
fn four_corners() -> MeshFill {
    let mut g = MeshGrid::rect([100.0, 50.0, 300.0, 250.0], &rgb(RED));
    g.nodes[1].color = rgb(GREEN);
    g.nodes[2].color = rgb(BLUE);
    g.nodes[3].color = rgb(YELLOW);
    MeshFill::Mesh(GradientMesh { grids: vec![g] })
}

#[test]
fn a_mesh_paints_its_corner_colours_and_blends_between__feat__color_swatches_mesh_freeform_gradients(
) {
    let mut d = doc(SQUARE);
    d.spreads[0].spread.rectangles[0].fill_mesh = Some(Box::new(four_corners()));
    let (cmds, img, _) = render(&d);
    let at = cmds
        .iter()
        .position(|c| matches!(c, DisplayCommand::MeshShade { .. }))
        .expect("a MeshShade");
    assert!(matches!(cmds[at - 1], DisplayCommand::PushClip { .. }));
    assert!(matches!(cmds[at + 1], DisplayCommand::PopClip(_)));
    assert!(dist(px(&img, 102, 52), RED) < 12, "{:?}", px(&img, 102, 52));
    assert!(
        dist(px(&img, 297, 52), GREEN) < 12,
        "{:?}",
        px(&img, 297, 52)
    );
    assert!(
        dist(px(&img, 102, 247), BLUE) < 12,
        "{:?}",
        px(&img, 102, 247)
    );
    assert!(
        dist(px(&img, 297, 247), YELLOW) < 12,
        "{:?}",
        px(&img, 297, 247)
    );
    // The centre: the four corners' mean in sRGB-encoded values.
    let mid = px(&img, 200, 150);
    assert!(dist(mid, [128, 128, 64]) < 8, "{mid:?}");
    // Outside the frame: the page.
    assert_eq!(px(&img, 90, 150), WHITE);
}

#[test]
fn a_mesh_is_clipped_to_the_frames_outline__feat__color_swatches_mesh_freeform_gradients() {
    let mut d = doc(OVAL);
    d.spreads[0].spread.ovals[0].fill_mesh = Some(Box::new(four_corners()));
    let (_, img, _) = render(&d);
    // The box's corner is outside the ellipse.
    assert_eq!(px(&img, 104, 54), WHITE);
    let mid = px(&img, 200, 150);
    assert!(dist(mid, [128, 128, 64]) < 8, "{mid:?}");
}

#[test]
fn a_translucent_mesh_point_shows_the_page__feat__color_swatches_mesh_freeform_gradients() {
    let mut d = doc(SQUARE);
    let mut fill = four_corners();
    if let MeshFill::Mesh(m) = &mut fill {
        for n in &mut m.grids[0].nodes {
            n.color = rgb(RED);
        }
        m.grids[0].nodes[3].color.opacity_pct = Some(0.0);
    }
    d.spreads[0].spread.rectangles[0].fill_mesh = Some(Box::new(fill));
    let (_, img, _) = render(&d);
    assert!(dist(px(&img, 102, 52), RED) < 12);
    assert!(
        dist(px(&img, 297, 247), WHITE) < 12,
        "{:?}",
        px(&img, 297, 247)
    );
}

#[test]
fn a_freeform_gradient_holds_each_points_colour__feat__color_swatches_mesh_freeform_gradients() {
    let mut d = doc(SQUARE);
    let point = |x: f32, y: f32, c: [i32; 3]| FreeformPoint {
        point: [x, y],
        color: rgb(c),
        spread_pct: None,
    };
    d.spreads[0].spread.rectangles[0].fill_mesh =
        Some(Box::new(MeshFill::Freeform(FreeformGradient {
            points: vec![point(120.0, 70.0, RED), point(280.0, 230.0, BLUE)],
            lines: vec![],
        })));
    let (_, img, _) = render(&d);
    assert!(dist(px(&img, 120, 70), RED) < 10, "{:?}", px(&img, 120, 70));
    assert!(
        dist(px(&img, 280, 230), BLUE) < 10,
        "{:?}",
        px(&img, 280, 230)
    );
    // On the perpendicular bisector the two weigh the same.
    let mid = px(&img, 200, 150);
    assert!(dist(mid, [128, 0, 128]) < 8, "{mid:?}");
}

#[test]
fn a_frame_without_a_mesh_keeps_its_swatch_and_digest__feat__color_swatches_mesh_freeform_gradients(
) {
    let d = doc(SQUARE);
    let (cmds, img, digest) = render(&d);
    assert!(!cmds
        .iter()
        .any(|c| matches!(c, DisplayCommand::MeshShade { .. })));
    assert!(dist(px(&img, 200, 150), SUN) < 4);
    // An empty mesh paints the swatch as before, with the same list.
    let mut e = doc(SQUARE);
    e.spreads[0].spread.rectangles[0].fill_mesh =
        Some(Box::new(MeshFill::Mesh(GradientMesh::default())));
    let (_, _, digest_empty) = render(&e);
    assert_eq!(digest, digest_empty);
}

/// GPU/CPU parity (ADR 146): both lanes draw the one cached raster.
#[cfg(feature = "gpu")]
#[test]
fn a_mesh_draws_alike_on_both_lanes__feat__color_swatches_mesh_freeform_gradients() {
    use paged_gpu::{PathRasterizer, RasterOptions};
    let point = |x: f32, y: f32, c: [i32; 3]| FreeformPoint {
        point: [x, y],
        color: rgb(c),
        spread_pct: Some(5.0),
    };
    let fills = [
        four_corners(),
        MeshFill::Freeform(FreeformGradient {
            points: vec![
                point(120.0, 70.0, RED),
                point(280.0, 230.0, BLUE),
                point(250.0, 80.0, GREEN),
            ],
            lines: vec![],
        }),
    ];
    for (i, fill) in fills.into_iter().enumerate() {
        let mut d = doc(OVAL);
        d.spreads[0].spread.ovals[0].fill_mesh = Some(Box::new(fill));
        let built = pipeline::build_document(&d, &PipelineOptions::default()).expect("build");
        let list = &built.pages[0].list;
        for dpi in [72.0, 150.0] {
            let mut opts = RasterOptions::new(400.0, 300.0);
            opts.dpi = dpi;
            opts.background = Color::WHITE;
            let gpu = paged_gpu::VelloRasterizer::new().rasterize(list, &opts);
            if gpu.iter().all(|b| *b == 0) {
                paged_test_resources::unavailable(
                    paged_test_resources::Resource::Gpu,
                    "no GPU adapter",
                );
                return;
            }
            let cpu = paged_gpu::CpuRasterizer.rasterize(list, &opts);
            let far = gpu
                .chunks_exact(4)
                .zip(cpu.chunks_exact(4))
                .filter(|(g, c)| (0..4).any(|k| g[k].abs_diff(c[k]) > 8))
                .count();
            assert!(
                far <= 200,
                "fill {i} at {dpi} dpi: lanes differ by > 8 on {far} pixels"
            );
        }
    }
}
