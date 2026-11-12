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

//! Publish ADR 659 — PDF mesh shadings (types 4–7) read as the engine's
//! native gradient mesh (engine ADR 1048).
//!
//! Two kinds of evidence:
//!
//! - **The round trip.** The engine's PDF export of three meshes (the
//!   inputs of its Illustrator oracle, `paged-export-pdf`'s
//!   `tests/fixtures/mesh-oracle/`, written by that crate's
//!   `write_illustrator_oracle_inputs` from `oracle_cases` in
//!   `tests/it/mesh_fill.rs`) reads back as the meshes it was written from,
//!   and so do Illustrator 30.1's own PDFs of the same artwork (recorded by
//!   `modules/draw/tooling/oracle/illustrator/probes/mesh-render.jsx`): native
//!   mesh → PDF → import → native mesh.
//! - **One construct per test**, each on a PDF the test writes: Coons and
//!   tensor patches, shared edges, free-form and lattice triangle meshes,
//!   colour functions, the pattern matrix, a placement, opacity, a
//!   background and the patch cap.

#![allow(non_snake_case)]

mod support;

use paged_model::{GradientMesh, MeshColor, MeshFill, MeshGrid, MeshHandle, MeshNode, Polygon};
use paged_scene::snippet::ItemSnippet;
use pdf_import::snippet::{place, PlaceRequest, PlaceResult};
use pdf_import::vectors::ir::{Item, MeshPatchIr, Paint, VectorPage};
use pdf_import::vectors::{read_page, ReadOptions, MAX_MESH_PATCHES};
use support::{obj, pdf, stream};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read(bytes: &[u8]) -> VectorPage {
    read_page(bytes, 0, &ReadOptions::default()).expect("the page reads")
}

fn loss(losses: &[pdf_import::vectors::ir::Loss], code: &str) -> u32 {
    losses
        .iter()
        .find(|l| l.code == code)
        .map_or(0, |l| l.count as u32)
}

/// Every mesh paint on the page, depth first.
fn meshes(items: &[Item]) -> Vec<(&Vec<MeshPatchIr>, f32)> {
    let mut out = Vec::new();
    for i in items {
        match i {
            Item::Path(p) => {
                if let Some(Paint::Mesh { patches, opacity }) = &p.fill {
                    out.push((patches, *opacity));
                }
            }
            Item::Group(g) => out.extend(meshes(&g.items)),
            _ => {}
        }
    }
    out
}

fn images(items: &[Item]) -> usize {
    items
        .iter()
        .map(|i| match i {
            Item::Image(_) => 1,
            Item::Group(g) => images(&g.items),
            _ => 0,
        })
        .sum()
}

/// Place page 0 of `bytes` under `placement`, ungrouped; the result and
/// the snippet's polygons.
fn placed(bytes: &[u8], placement: [f64; 6]) -> (PlaceResult, Vec<Polygon>) {
    let req: PlaceRequest = serde_json::from_value(serde_json::json!({
        "page": 0,
        "placement": placement,
        "group": false,
    }))
    .expect("request");
    let r = place(bytes, &req).expect("the page places");
    let snippet: ItemSnippet = serde_json::from_str(&r.snippet).expect("snippet json");
    let polys = snippet.spread.polygons;
    (r, polys)
}

/// The one mesh-filled polygon's mesh.
fn the_mesh(polys: &[Polygon]) -> &GradientMesh {
    let with: Vec<&Polygon> = polys.iter().filter(|p| p.fill_mesh.is_some()).collect();
    assert_eq!(with.len(), 1, "one mesh-filled path");
    match with[0].fill_mesh.as_deref() {
        Some(MeshFill::Mesh(m)) => m,
        other => panic!("a gradient mesh, got {other:?}"),
    }
}

fn near(a: [f32; 2], b: [f32; 2], tol: f32) -> bool {
    (a[0] - b[0]).abs() <= tol && (a[1] - b[1]).abs() <= tol
}

fn assert_near(a: [f32; 2], b: [f32; 2], tol: f32, what: &str) {
    assert!(near(a, b, tol), "{what}: {a:?} vs {b:?} (tolerance {tol})");
}

fn assert_rgb(c: [f32; 3], expect: [f32; 3], what: &str) {
    for k in 0..3 {
        assert!(
            (c[k] - expect[k]).abs() <= 1.0 / 255.0,
            "{what}: {c:?} vs {expect:?}"
        );
    }
}

/// A shading stream's packed data: coordinates as 16-bit integers over
/// `Decode [0 655.35 0 655.35 …]` (so a raw value is the coordinate × 100
/// exactly), colour components as bytes over `[0 1]`.
struct Packer(Vec<u8>);

impl Packer {
    fn new() -> Self {
        Packer(Vec::new())
    }
    fn flag(&mut self, f: u8) -> &mut Self {
        self.0.push(f);
        self
    }
    fn pt(&mut self, x: f32, y: f32) -> &mut Self {
        for v in [x, y] {
            let raw = (v * 100.0).round() as u16;
            self.0.extend_from_slice(&raw.to_be_bytes());
        }
        self
    }
    fn pts(&mut self, pts: &[(f32, f32)]) -> &mut Self {
        for &(x, y) in pts {
            self.pt(x, y);
        }
        self
    }
    fn rgb(&mut self, c: [u8; 3]) -> &mut Self {
        self.0.extend_from_slice(&c);
        self
    }
    fn byte(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
}

const COORDS: &str = "/BitsPerCoordinate 16 /BitsPerComponent 8";
const RGB_DECODE: &str = "/Decode [0 655.35 0 655.35 0 1 0 1 0 1]";

/// A 200 × 200 page painting shading object 0 with `sh` under a clip of
/// the whole page, after `pre` (graphics state operators).
fn sh_page(resources_extra: &str, pre: &str, shading: support::Obj) -> Vec<u8> {
    pdf(
        200.0,
        200.0,
        &format!("/Shading << /Sh0 {} 0 R >> {resources_extra}", obj(1, 0)),
        &format!("q {pre} 0 0 200 200 re W n /Sh0 sh Q"),
        &[shading],
    )
}

/// One Coons patch over (20..180)², its "row 0" edge (`p00 … p03`, the
/// first four points) along PDF y = 20 — the page's bottom, y = 180 down —
/// its top edge bent upwards.
fn one_coons_patch() -> support::Obj {
    let mut p = Packer::new();
    p.flag(0).pts(&[
        (20.0, 20.0),
        (73.33, 20.0),
        (126.67, 20.0),
        (180.0, 20.0),
        (180.0, 73.33),
        (180.0, 126.67),
        (180.0, 180.0),
        (126.67, 195.0),
        (73.33, 195.0),
        (20.0, 180.0),
        (20.0, 126.67),
        (20.0, 73.33),
    ]);
    p.rgb([255, 0, 0])
        .rgb([0, 255, 0])
        .rgb([0, 0, 255])
        .rgb([255, 255, 0]);
    let data = p.0;
    stream(
        &format!("/ShadingType 6 /ColorSpace /DeviceRGB {COORDS} /BitsPerFlag 8 {RGB_DECODE}"),
        &data,
    )
}

// ---------------------------------------------------------------------------
// The round trip: native mesh → PDF (the engine's export) → import
// ---------------------------------------------------------------------------

/// The engine's Illustrator-oracle fixtures (engine ADR 1048).
fn oracle_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../engine/core/crates/paged-export-pdf/tests/fixtures/mesh-oracle")
}

fn rgb(r: f32, g: f32, b: f32) -> MeshColor {
    MeshColor::rgb(r, g, b)
}

/// `oracle_cases` of `paged-export-pdf`'s `tests/it/mesh_fill.rs`, the
/// meshes its committed PDFs were exported from: on a 400 × 300 page, a
/// rectangle at (100, 50)–(300, 250) holding a bilinear four-corner patch,
/// a 2 × 2 grid with a moved centre node and bent edges, and a tensor
/// patch. The two must move together (the PDFs are regenerated by that
/// crate's `write_illustrator_oracle_inputs`).
fn oracle_cases() -> Vec<(&'static str, GradientMesh)> {
    let four_corners = || {
        let mut g = MeshGrid::rect([100.0, 50.0, 300.0, 250.0], &rgb(255.0, 0.0, 0.0));
        g.nodes[1].color = rgb(0.0, 255.0, 0.0);
        g.nodes[2].color = rgb(0.0, 0.0, 255.0);
        g.nodes[3].color = rgb(255.0, 255.0, 0.0);
        g
    };
    let mut curved = MeshGrid::rect([100.0, 50.0, 300.0, 250.0], &rgb(240.0, 240.0, 240.0));
    curved.rows = 2;
    curved.cols = 2;
    let colours = [
        rgb(230.0, 30.0, 40.0),
        rgb(250.0, 200.0, 20.0),
        rgb(30.0, 160.0, 60.0),
        rgb(40.0, 90.0, 220.0),
        rgb(255.0, 255.0, 255.0),
        rgb(140.0, 40.0, 170.0),
        rgb(20.0, 20.0, 30.0),
        rgb(0.0, 190.0, 200.0),
        rgb(250.0, 120.0, 160.0),
    ];
    curved.nodes = (0..9)
        .map(|k| {
            let (r, c) = (k / 3, k % 3);
            let (x, y) = (100.0 + c as f32 * 100.0, 50.0 + r as f32 * 100.0);
            MeshNode {
                point: [x, y],
                handles: [[x, y]; 4],
                color: colours[k].clone(),
            }
        })
        .collect();
    curved.straighten_handles();
    curved.nodes[4].point = [215.0, 135.0];
    curved.straighten_handles();
    curved.nodes[4].handles[MeshHandle::Right as usize] = [260.0, 110.0];
    curved.nodes[4].handles[MeshHandle::Down as usize] = [190.0, 180.0];
    let mut tensor = four_corners();
    let p = tensor.patch(0, 0).unwrap().points;
    tensor.tensor = vec![[
        [p[1][1][0] - 40.0, p[1][1][1] - 40.0],
        p[1][2],
        p[2][1],
        [p[2][2][0] + 30.0, p[2][2][1] + 10.0],
    ]];
    vec![
        (
            "coons-four-corners",
            GradientMesh {
                grids: vec![four_corners()],
            },
        ),
        (
            "coons-curved-2x2",
            GradientMesh {
                grids: vec![curved],
            },
        ),
        (
            "tensor-one-patch",
            GradientMesh {
                grids: vec![tensor],
            },
        ),
    ]
}

/// `got` is `want` within `tol` points and one 16-bit colour step: the
/// same grid shape, every node's position, colour and edge handles (an
/// outside handle has no edge and is not compared), every tensor point.
fn assert_same_mesh(got: &GradientMesh, want: &GradientMesh, tol: f32, what: &str) {
    assert_eq!(got.grids.len(), want.grids.len(), "{what}: grid count");
    for (g, w) in got.grids.iter().zip(&want.grids) {
        assert_eq!((g.rows, g.cols), (w.rows, w.cols), "{what}: grid shape");
        assert_eq!(g.nodes.len(), w.nodes.len(), "{what}: node count");
        for (k, (a, b)) in g.nodes.iter().zip(&w.nodes).enumerate() {
            let (r, c) = (k as u32 / (w.cols + 1), k as u32 % (w.cols + 1));
            assert_near(a.point, b.point, tol, &format!("{what}: node {k} point"));
            let edges = [c > 0, c < w.cols, r > 0, r < w.rows];
            for (h, has) in edges.iter().enumerate() {
                if *has {
                    assert_near(
                        a.handles[h],
                        b.handles[h],
                        tol,
                        &format!("{what}: node {k} handle {h}"),
                    );
                }
            }
            assert_eq!(a.color.space, b.color.space, "{what}: node {k} space");
            for (x, y) in a.color.value.iter().zip(&b.color.value) {
                assert!(
                    (x - y).abs() <= 0.05,
                    "{what}: node {k} colour {:?} vs {:?}",
                    a.color.value,
                    b.color.value
                );
            }
            assert_eq!(a.color.opacity(), b.color.opacity(), "{what}: opacity");
        }
        assert_eq!(g.tensor.len(), w.tensor.len(), "{what}: tensor entries");
        for (a, b) in g.tensor.iter().zip(&w.tensor) {
            for k in 0..4 {
                assert_near(a[k], b[k], tol, &format!("{what}: tensor point {k}"));
            }
        }
    }
}

#[test]
fn the_engines_mesh_pdfs_read_back_as_their_meshes__feat__plugin_pdf_import_transparency() {
    for (name, want) in oracle_cases() {
        let bytes = std::fs::read(oracle_dir().join(format!("{name}.pdf"))).expect("engine pdf");
        let (r, polys) = placed(&bytes, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        assert!(r.losses.is_empty(), "{name}: {:?}", r.losses);
        assert_eq!(r.counts.meshes, 1, "{name}");
        assert_eq!(r.counts.images, 0, "{name}: nothing sampled");
        // The engine writes 32-bit coordinates and 16-bit components.
        assert_same_mesh(the_mesh(&polys), &want, 1e-3, name);
    }
}

#[test]
fn illustrators_mesh_pdfs_read_back_as_the_same_meshes__feat__plugin_pdf_import_transparency() {
    // Illustrator 30.1 opened each engine PDF and saved its own (engine
    // ADR 1048's oracle): its shading — in its own coordinate system,
    // under its own clip — is the same mesh.
    for (name, want) in oracle_cases() {
        let bytes =
            std::fs::read(oracle_dir().join(format!("{name}.ai.pdf"))).expect("illustrator pdf");
        let (r, polys) = placed(&bytes, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        assert_eq!(loss(&r.losses, "shading.mesh_sampled"), 0, "{name}");
        assert_eq!(loss(&r.losses, "shading.mesh_patches"), 0, "{name}");
        assert_same_mesh(the_mesh(&polys), &want, 1e-2, name);
    }
}

// ---------------------------------------------------------------------------
// One construct per test
// ---------------------------------------------------------------------------

#[test]
fn a_coons_patch_reads_as_one_native_patch__feat__plugin_pdf_import_transparency() {
    let page = read(&sh_page("", "", one_coons_patch()));
    assert_eq!(loss(&page.losses, "shading.mesh_sampled"), 0);
    assert_eq!(images(&page.items), 0, "not sampled");
    let m = meshes(&page.items);
    assert_eq!(m.len(), 1);
    let (patches, opacity) = m[0];
    assert_eq!(opacity, 1.0);
    assert_eq!(patches.len(), 1);
    let p = &patches[0];
    assert!(!p.tensor);
    // PDF y up → page y down (200 − y); row 0 is the PDF's first edge.
    assert_near(p.points[0][0], [20.0, 180.0], 1e-3, "p00");
    assert_near(p.points[0][3], [180.0, 180.0], 1e-3, "p03");
    assert_near(p.points[3][3], [180.0, 20.0], 1e-3, "p33");
    assert_near(p.points[3][0], [20.0, 20.0], 1e-3, "p30");
    assert_near(p.points[3][1], [73.33, 5.0], 1e-3, "the bent edge");
    // Colours of p00, p03, p33, p30 in the stream → [c00, c03, c30, c33].
    assert_rgb(p.colors[0], [1.0, 0.0, 0.0], "c00");
    assert_rgb(p.colors[1], [0.0, 1.0, 0.0], "c03");
    assert_rgb(p.colors[2], [1.0, 1.0, 0.0], "c30");
    assert_rgb(p.colors[3], [0.0, 0.0, 1.0], "c33");
}

#[test]
fn a_placed_mesh_lowers_to_the_frames_native_mesh__feat__plugin_pdf_import_transparency() {
    // Twice the size, moved: the mesh follows the placement exactly, in
    // the polygon's inner coordinates; the swatch is the mean colour.
    let (r, polys) = placed(
        &sh_page("", "", one_coons_patch()),
        [2.0, 0.0, 0.0, 2.0, 10.0, 30.0],
    );
    assert_eq!(r.counts.meshes, 1);
    let mesh = the_mesh(&polys);
    assert_eq!(mesh.grids.len(), 1);
    let g = &mesh.grids[0];
    assert_eq!((g.rows, g.cols), (1, 1));
    assert_near(g.nodes[0].point, [50.0, 390.0], 1e-2, "c00 placed");
    assert_near(g.nodes[3].point, [370.0, 70.0], 1e-2, "c33 placed");
    assert_eq!(g.nodes[0].color, MeshColor::rgb(255.0, 0.0, 0.0));
    assert_eq!(g.nodes[3].color, MeshColor::rgb(0.0, 0.0, 255.0));
    let poly = polys.iter().find(|p| p.fill_mesh.is_some()).unwrap();
    // (255+0+255+0)/4, (0+255+255+0)/4, (0+0+0+255)/4 → 128 128 64.
    assert_eq!(poly.fill_color.as_deref(), Some("Color/pdf_128_128_64"));
    assert!(poly.fill_transparency.is_none());
}

#[test]
fn a_pattern_fill_maps_through_the_pattern_matrix__feat__plugin_pdf_import_transparency() {
    // The shading in a pattern whose matrix halves it, filling a smaller
    // path: the patch lands in device space, clipped by the path.
    let bytes = pdf(
        200.0,
        200.0,
        &format!("/Pattern << /P0 {} 0 R >>", obj(1, 0)),
        "/Pattern cs /P0 scn 30 30 60 60 re f",
        &[
            support::Obj(format!(
                "<< /PatternType 2 /Shading {} 0 R /Matrix [0.5 0 0 0.5 0 0] >>",
                obj(1, 1)
            )),
            one_coons_patch(),
        ],
    );
    let page = read(&bytes);
    let m = meshes(&page.items);
    assert_eq!(m.len(), 1, "{:?}", page.items);
    let p = &m[0].0[0];
    assert_near(p.points[0][0], [10.0, 190.0], 1e-3, "p00 halved");
    assert_near(p.points[3][3], [90.0, 110.0], 1e-3, "p33 halved");
}

#[test]
fn patches_sharing_edges_become_one_grid__feat__plugin_pdf_import_transparency() {
    // Two patches side by side, each written whole (flag 0): the right
    // one's first column is the left one's last. They tile one 1 × 2 grid.
    let mut p = Packer::new();
    let patch = |p: &mut Packer, x0: f32, x1: f32, c: [[u8; 3]; 4]| {
        let t = |a: f32, b: f32, k: f32| a + (b - a) * k / 3.0;
        p.flag(0).pts(&[
            (x0, 150.0),
            (t(x0, x1, 1.0), 150.0),
            (t(x0, x1, 2.0), 150.0),
            (x1, 150.0),
            (x1, 116.67),
            (x1, 83.33),
            (x1, 50.0),
            (t(x0, x1, 2.0), 50.0),
            (t(x0, x1, 1.0), 50.0),
            (x0, 50.0),
            (x0, 83.33),
            (x0, 116.67),
        ]);
        for k in c {
            p.rgb(k);
        }
    };
    let (red, green, blue, white, black, grey) = (
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 255],
        [0, 0, 0],
        [128, 128, 128],
    );
    // Stream colours: p00 (x0, top) p03 (x1, top) p33 (x1, bottom) p30 (x0, bottom).
    patch(&mut p, 20.0, 100.0, [red, green, blue, white]);
    patch(&mut p, 100.0, 180.0, [green, black, grey, blue]);
    let sh = stream(
        &format!("/ShadingType 6 /ColorSpace /DeviceRGB {COORDS} /BitsPerFlag 8 {RGB_DECODE}"),
        &p.0,
    );
    let (r, polys) = placed(&sh_page("", "", sh), [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    assert_eq!(loss(&r.losses, "shading.mesh_patches"), 0, "{:?}", r.losses);
    let mesh = the_mesh(&polys);
    assert_eq!(mesh.grids.len(), 1);
    let g = &mesh.grids[0];
    assert_eq!((g.rows, g.cols), (1, 2));
    assert_eq!(g.nodes.len(), 6);
    assert_near(g.nodes[1].point, [100.0, 50.0], 1e-2, "the shared top node");
    assert_eq!(g.nodes[1].color, MeshColor::rgb(0.0, 255.0, 0.0));
}

#[test]
fn a_patch_continuing_its_neighbours_edge_paints_but_stays_apart__feat__plugin_pdf_import_transparency(
) {
    // Flag 1: the second patch's first edge is the first patch's second
    // edge (p03 … p33). It paints next to it, turned a quarter: the patches
    // tile no grid in one orientation, so each is a grid of its own — the
    // same surface, reported as separate patches.
    let mut p = Packer::new();
    p.flag(0).pts(&[
        (20.0, 150.0),
        (46.67, 150.0),
        (73.33, 150.0),
        (100.0, 150.0),
        (100.0, 116.67),
        (100.0, 83.33),
        (100.0, 50.0),
        (73.33, 50.0),
        (46.67, 50.0),
        (20.0, 50.0),
        (20.0, 83.33),
        (20.0, 116.67),
    ]);
    p.rgb([255, 0, 0])
        .rgb([0, 255, 0])
        .rgb([0, 0, 255])
        .rgb([255, 255, 255]);
    // The continuation: eight points (p13 … p10 of the new patch), two colours.
    p.flag(1).pts(&[
        (126.67, 50.0),
        (153.33, 50.0),
        (180.0, 50.0),
        (180.0, 83.33),
        (180.0, 116.67),
        (180.0, 150.0),
        (153.33, 150.0),
        (126.67, 150.0),
    ]);
    p.rgb([0, 0, 0]).rgb([128, 128, 128]);
    let sh = stream(
        &format!("/ShadingType 6 /ColorSpace /DeviceRGB {COORDS} /BitsPerFlag 8 {RGB_DECODE}"),
        &p.0,
    );
    let bytes = sh_page("", "", sh);
    let page = read(&bytes);
    let m = meshes(&page.items);
    assert_eq!(m[0].0.len(), 2, "two patches");
    let second = &m[0].0[1];
    // Its first edge is the first patch's second edge, carried over.
    assert_near(second.points[0][0], [100.0, 50.0], 1e-3, "shared p00");
    assert_near(second.points[0][3], [100.0, 150.0], 1e-3, "shared p03");
    assert_rgb(second.colors[0], [0.0, 1.0, 0.0], "c00 carried over");
    assert_rgb(second.colors[1], [0.0, 0.0, 1.0], "c03 carried over");
    let (r, polys) = placed(&bytes, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    assert_eq!(loss(&r.losses, "shading.mesh_patches"), 1);
    assert_eq!(the_mesh(&polys).grids.len(), 2);
}

#[test]
fn a_tensor_patch_keeps_its_interior_points__feat__plugin_pdf_import_transparency() {
    let mut p = Packer::new();
    p.flag(0).pts(&[
        (20.0, 20.0),
        (73.33, 20.0),
        (126.67, 20.0),
        (180.0, 20.0),
        (180.0, 73.33),
        (180.0, 126.67),
        (180.0, 180.0),
        (126.67, 180.0),
        (73.33, 180.0),
        (20.0, 180.0),
        (20.0, 126.67),
        (20.0, 73.33),
        // p11 p12 p22 p21, pulled off the bilinear lattice.
        (40.0, 40.0),
        (73.33, 160.0),
        (150.0, 150.0),
        (126.67, 73.33),
    ]);
    p.rgb([255, 0, 0])
        .rgb([0, 255, 0])
        .rgb([0, 0, 255])
        .rgb([255, 255, 0]);
    let sh = stream(
        &format!("/ShadingType 7 /ColorSpace /DeviceRGB {COORDS} /BitsPerFlag 8 {RGB_DECODE}"),
        &p.0,
    );
    let bytes = sh_page("", "", sh);
    let page = read(&bytes);
    let patch = &meshes(&page.items)[0].0[0];
    assert!(patch.tensor);
    assert_near(patch.points[1][1], [40.0, 160.0], 1e-3, "p11");
    assert_near(patch.points[1][2], [73.33, 40.0], 1e-3, "p12");
    assert_near(patch.points[2][2], [150.0, 50.0], 1e-3, "p22");
    assert_near(patch.points[2][1], [126.67, 126.67], 1e-3, "p21");
    let (_, polys) = placed(&bytes, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let g = &the_mesh(&polys).grids[0];
    assert_eq!(g.tensor.len(), 1, "a tensor grid");
    assert_near(g.tensor[0][0], [40.0, 160.0], 1e-2, "tensor p11");
    assert_near(g.tensor[0][3], [150.0, 50.0], 1e-2, "tensor p22");
}

/// The point and colour of a patch at `(u, v)` — `u` across the columns,
/// `v` down the rows — for a patch whose edges are straight (its surface
/// the bilinear blend of its corners).
fn bilinear(p: &MeshPatchIr, u: f32, v: f32) -> ([f32; 2], [f32; 3]) {
    let w = [(1.0 - u) * (1.0 - v), u * (1.0 - v), (1.0 - u) * v, u * v];
    let corners = [
        p.points[0][0],
        p.points[0][3],
        p.points[3][0],
        p.points[3][3],
    ];
    let pt = [0, 1].map(|d| (0..4).map(|k| w[k] * corners[k][d]).sum());
    let c = [0, 1, 2].map(|d| (0..4).map(|k| w[k] * p.colors[k][d]).sum());
    (pt, c)
}

/// The Gouraud colour of triangle `t` (points, colours) at `q`.
fn gouraud(t: [([f32; 2], [f32; 3]); 3], q: [f32; 2]) -> [f32; 3] {
    let [(a, ca), (b, cb), (c, cc)] = t;
    let det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    let l1 = ((b[1] - c[1]) * (q[0] - c[0]) + (c[0] - b[0]) * (q[1] - c[1])) / det;
    let l2 = ((c[1] - a[1]) * (q[0] - c[0]) + (a[0] - c[0]) * (q[1] - c[1])) / det;
    let l3 = 1.0 - l1 - l2;
    [0, 1, 2].map(|k| l1 * ca[k] + l2 * cb[k] + l3 * cc[k])
}

#[test]
fn a_free_form_triangle_mesh_paints_each_triangle_exactly__feat__plugin_pdf_import_transparency() {
    // Type 4: a triangle (flag 0), then one sharing its last edge (flag 1:
    // vertices b c d).
    let mut p = Packer::new();
    p.flag(0).pt(20.0, 20.0).rgb([255, 0, 0]);
    p.flag(0).pt(180.0, 20.0).rgb([0, 255, 0]);
    p.flag(0).pt(100.0, 160.0).rgb([0, 0, 255]);
    p.flag(1).pt(190.0, 170.0).rgb([255, 255, 255]);
    let sh = stream(
        &format!("/ShadingType 4 /ColorSpace /DeviceRGB {COORDS} /BitsPerFlag 8 {RGB_DECODE}"),
        &p.0,
    );
    let bytes = sh_page("", "", sh);
    let page = read(&bytes);
    assert_eq!(images(&page.items), 0, "not sampled");
    let m = meshes(&page.items);
    let patches = m[0].0;
    assert_eq!(patches.len(), 2);
    let first = &patches[0];
    // The triangle a b c as a patch whose last row is c.
    let (a, b, c) = ([20.0, 180.0], [180.0, 180.0], [100.0, 40.0]);
    assert_near(first.points[0][0], a, 1e-3, "a");
    assert_near(first.points[0][3], b, 1e-3, "b");
    for j in 0..4 {
        assert_near(first.points[3][j], c, 1e-3, "the collapsed edge");
    }
    assert_eq!(first.colors[2], first.colors[3]);
    // Everywhere on the patch, its bilinear colour is the triangle's
    // Gouraud colour at that point.
    let tri = [
        (a, [1.0, 0.0, 0.0]),
        (b, [0.0, 1.0, 0.0]),
        (c, [0.0, 0.0, 1.0]),
    ];
    for i in 0..=8 {
        for j in 0..=8 {
            let (q, col) = bilinear(first, i as f32 / 8.0, j as f32 / 8.0);
            let want = gouraud(tri, q);
            for k in 0..3 {
                assert!(
                    (col[k] - want[k]).abs() < 1e-4,
                    "{q:?}: {col:?} vs {want:?}"
                );
            }
        }
    }
    // The second triangle shares b and c.
    assert_near(patches[1].points[0][0], b, 1e-3, "b shared");
    assert_near(patches[1].points[0][3], c, 1e-3, "c shared");
    let (r, polys) = placed(&bytes, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    assert_eq!(r.counts.meshes, 1);
    assert_eq!(
        the_mesh(&polys)
            .grids
            .iter()
            .map(|g| g.rows * g.cols)
            .sum::<u32>(),
        2
    );
}

#[test]
fn a_lattice_mesh_reads_as_its_triangles__feat__plugin_pdf_import_transparency() {
    // Type 5: 3 × 2 vertices, two triangles per cell.
    let mut p = Packer::new();
    for (y, row) in [
        (150.0, [[255, 0, 0], [0, 255, 0], [0, 0, 255]]),
        (50.0, [[0, 0, 0], [255, 255, 255], [128, 128, 128]]),
    ] {
        for (k, x) in [20.0, 100.0, 180.0].into_iter().enumerate() {
            p.pt(x, y).rgb(row[k]);
        }
    }
    let sh = stream(
        &format!("/ShadingType 5 /ColorSpace /DeviceRGB {COORDS} /VerticesPerRow 3 {RGB_DECODE}"),
        &p.0,
    );
    let page = read(&sh_page("", "", sh));
    assert_eq!(images(&page.items), 0, "not sampled");
    assert_eq!(loss(&page.losses, "shading.mesh_sampled"), 0);
    assert_eq!(meshes(&page.items)[0].0.len(), 4);
}

/// A type-6 patch over (20..180)² whose corners carry the parameter
/// `t` (0, 1, 1, 0) of `function`.
fn function_patch(function: &str) -> Vec<u8> {
    let mut p = Packer::new();
    p.flag(0).pts(&[
        (20.0, 20.0),
        (73.33, 20.0),
        (126.67, 20.0),
        (180.0, 20.0),
        (180.0, 73.33),
        (180.0, 126.67),
        (180.0, 180.0),
        (126.67, 180.0),
        (73.33, 180.0),
        (20.0, 180.0),
        (20.0, 126.67),
        (20.0, 73.33),
    ]);
    p.byte(0).byte(255).byte(255).byte(0);
    sh_page(
        "",
        "",
        stream(
            &format!(
                "/ShadingType 6 /ColorSpace /DeviceRGB {COORDS} /BitsPerFlag 8 \
                 /Decode [0 655.35 0 655.35 0 1] /Function {function}"
            ),
            &p.0,
        ),
    )
}

#[test]
fn a_colour_function_maps_each_corner__feat__plugin_pdf_import_transparency() {
    // A linear function: the corners' colours blend as the PDF's
    // parameter does; nothing to report.
    let linear = "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>";
    let page = read(&function_patch(linear));
    assert_eq!(loss(&page.losses, "shading.mesh_function"), 0);
    let patch = &meshes(&page.items)[0].0[0];
    assert_rgb(patch.colors[0], [1.0, 0.0, 0.0], "t 0");
    assert_rgb(patch.colors[1], [0.0, 0.0, 1.0], "t 1");
    // A curved one: the mesh blends the mapped corners, the PDF maps the
    // blended parameter — reported.
    let curved = "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 3 >>";
    let page = read(&function_patch(curved));
    assert_eq!(loss(&page.losses, "shading.mesh_function"), 1);
    assert_eq!(meshes(&page.items).len(), 1, "still native");
}

#[test]
fn opacity_and_background_ride_along__feat__plugin_pdf_import_transparency() {
    // The fill alpha of a graphics state, and a /Background the native
    // mesh cannot paint (it paints its patches only).
    let shading = support::Obj(
        one_coons_patch()
            .0
            .replacen("<< ", "<< /Background [1 1 1] ", 1),
    );
    let bytes = pdf(
        200.0,
        200.0,
        &format!(
            "/Shading << /Sh0 {} 0 R >> /ExtGState << /G0 {} 0 R >>",
            obj(1, 0),
            obj(1, 1)
        ),
        "q /G0 gs 0 0 200 200 re W n /Sh0 sh Q",
        &[shading, support::Obj("<< /ca 0.5 >>".into())],
    );
    let page = read(&bytes);
    let m = meshes(&page.items);
    assert_eq!(m.len(), 1);
    assert!((m[0].1 - 0.5).abs() < 1e-3, "the fill alpha: {}", m[0].1);
    assert_eq!(loss(&page.losses, "shading.mesh_background"), 1);
    let (_, polys) = placed(&bytes, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let poly = polys.iter().find(|p| p.fill_mesh.is_some()).unwrap();
    let t = poly.fill_transparency.as_ref().expect("fill transparency");
    assert!((t.opacity.unwrap() - 50.0).abs() < 0.5);
}

#[test]
fn a_mesh_past_the_patch_cap_is_sampled__feat__plugin_pdf_import_transparency() {
    // MAX_MESH_PATCHES + 1 tiny triangles (type 4, flag 0 each).
    let mut p = Packer::new();
    for k in 0..=MAX_MESH_PATCHES {
        let x = (k % 64) as f32 * 3.0 + 1.0;
        let y = (k / 64) as f32 * 2.5 + 1.0;
        p.flag(0).pt(x, y).rgb([255, 0, 0]);
        p.flag(0).pt(x + 2.0, y).rgb([0, 255, 0]);
        p.flag(0).pt(x, y + 2.0).rgb([0, 0, 255]);
    }
    let sh = stream(
        &format!("/ShadingType 4 /ColorSpace /DeviceRGB {COORDS} /BitsPerFlag 8 {RGB_DECODE}"),
        &p.0,
    );
    let page = read(&sh_page("", "", sh));
    assert_eq!(loss(&page.losses, "shading.mesh_too_large"), 1);
    assert!(meshes(&page.items).is_empty());
    assert_eq!(images(&page.items), 1, "sampled to an image");
}
