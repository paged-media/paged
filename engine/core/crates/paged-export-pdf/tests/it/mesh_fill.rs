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

//! Engine ADR 1048 — gradient meshes and freeform gradients in the PDF:
//! a mesh is a type-6 (Coons) or type-7 (tensor) patch shading, a
//! freeform gradient the type-6 grid sampled from the canvas's field,
//! translucent colours under a luminosity soft mask of the patches'
//! alpha. Where poppler is installed the exported page is rasterised and
//! held to the canvas's own pixels.
#![allow(non_snake_case)]

use std::io::Write;

use lopdf::{Dictionary, Object};
use paged_color::{DisplaySetup, IccCmm};
use paged_compose::Color;
use paged_export_pdf::{export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles};
use paged_model::{FreeformGradient, FreeformPoint, GradientMesh, MeshColor, MeshFill, MeshGrid};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};
use paged_scene::Document;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// A 400 × 300 page with `item`; the palette's `Gradient/Ramp` runs Sun
/// (255 200 80) → Sky (60 120 220).
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
    <Color Self="Color/Sky" Name="Sky" Space="RGB" ColorValue="60 120 220"/>
    <Gradient Self="Gradient/Ramp" Name="Ramp" Type="Linear">
      <GradientStop StopColor="Color/Sun" Location="0"/>
      <GradientStop StopColor="Color/Sky" Location="100"/>
    </Gradient>
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

fn doc(item: &str, edit: impl FnOnce(&mut Document)) -> Document {
    let mut d = idml_import::import_idml_doc(&idml(item)).expect("import");
    edit(&mut d);
    d
}

fn export(document: &Document) -> Vec<u8> {
    let opts = PipelineOptions::default();
    let fonts = FontTable::build(document, &opts);
    let built = {
        let o = PipelineOptions {
            pre_built_font_table: Some(&fonts),
            ..PipelineOptions::default()
        };
        pipeline::build_document(document, &o).expect("build document")
    };
    let cmm = IccCmm::new(None, DisplaySetup::default());
    export_pdf(ExportInput {
        doc: &built,
        palette: &document.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions::default(),
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes
}

fn dicts(pdf: &[u8]) -> Vec<Dictionary> {
    let parsed = lopdf::Document::load_mem(pdf).expect("re-parse");
    parsed
        .objects
        .values()
        .filter_map(|o| match o {
            Object::Dictionary(d) => Some(d.clone()),
            Object::Stream(s) => Some(s.dict.clone()),
            _ => None,
        })
        .collect()
}

fn int(d: &Dictionary, key: &[u8]) -> Option<i64> {
    d.get(key).ok().and_then(|v| v.as_i64().ok())
}

fn name<'a>(d: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    d.get(key).ok().and_then(|v| v.as_name().ok())
}

fn luminosity_masks(pdf: &[u8]) -> usize {
    dicts(pdf)
        .iter()
        .filter_map(|d| d.get(b"SMask").ok())
        .filter_map(|v| v.as_dict().ok())
        .filter(|sm| name(sm, b"S") == Some(b"Luminosity"))
        .count()
}

fn gray_shadings(pdf: &[u8]) -> usize {
    dicts(pdf)
        .iter()
        .filter(|d| {
            int(d, b"ShadingType").is_some() && name(d, b"ColorSpace") == Some(b"DeviceGray")
        })
        .count()
}

/// The page rasterised by poppler at 72 dpi, or `None` without it.
fn rasterise(pdf: &[u8], tag: &str) -> Option<image::RgbImage> {
    paged_test_resources::tool("pdftoppm")?;
    let dir = std::env::temp_dir().join(format!("paged-mesh-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let pdf_path = dir.join("page.pdf");
    std::fs::write(&pdf_path, pdf).expect("write pdf");
    let status = std::process::Command::new("pdftoppm")
        .args(["-r", "72", "-png", "-singlefile"])
        .arg(&pdf_path)
        .arg(dir.join("page"))
        .status()
        .expect("run pdftoppm");
    assert!(status.success(), "pdftoppm failed");
    let png = std::fs::read(dir.join("page.png")).expect("rasterised page");
    let _ = std::fs::remove_dir_all(&dir);
    Some(image::load_from_memory(&png).expect("decode").to_rgb8())
}

fn px(img: &image::RgbImage, x: u32, y: u32) -> [i32; 3] {
    let p = img.get_pixel(x, y).0;
    [i32::from(p[0]), i32::from(p[1]), i32::from(p[2])]
}

fn dist(a: [i32; 3], b: [i32; 3]) -> i32 {
    (0..3).map(|i| (a[i] - b[i]).abs()).max().unwrap_or(0)
}

const SQUARE: &str = r#"<Rectangle Self="r1" GeometricBounds="50 100 250 300" FillColor="Color/Sun" StrokeWeight="0"/>"#;

fn rgb(r: f32, g: f32, b: f32) -> MeshColor {
    MeshColor::rgb(r, g, b)
}

fn four_corners() -> MeshFill {
    let mut g = MeshGrid::rect([100.0, 50.0, 300.0, 250.0], &rgb(255.0, 0.0, 0.0));
    g.nodes[1].color = rgb(0.0, 255.0, 0.0);
    g.nodes[2].color = rgb(0.0, 0.0, 255.0);
    g.nodes[3].color = rgb(255.0, 255.0, 0.0);
    MeshFill::Mesh(GradientMesh { grids: vec![g] })
}

fn with_fill(fill: MeshFill) -> Document {
    doc(SQUARE, |d| {
        d.spreads[0].spread.rectangles[0].fill_mesh = Some(Box::new(fill));
    })
}

fn shading_types(pdf: &[u8]) -> Vec<(i64, Vec<u8>)> {
    dicts(pdf)
        .iter()
        .filter_map(|d| {
            Some((
                int(d, b"ShadingType")?,
                name(d, b"ColorSpace").unwrap_or_default().to_vec(),
            ))
        })
        .collect()
}

/// The largest per-channel difference between poppler's page and
/// `expect` (sRGB 0..=255) over a 9 × 9 lattice inside the square.
fn worst_against(pdf: &[u8], tag: &str, expect: impl Fn(f32, f32) -> [i32; 3]) -> Option<i32> {
    let page = rasterise(pdf, tag)?;
    let mut worst = 0;
    for i in 0..9u32 {
        for j in 0..9u32 {
            let (x, y) = (110 + i * 22, 60 + j * 22);
            worst = worst.max(dist(
                px(&page, x, y),
                expect(x as f32 + 0.5, y as f32 + 0.5),
            ));
        }
    }
    Some(worst)
}

/// The four-corner mesh's colour at `(x, y)`: bilinear in encoded values.
fn bilinear(x: f32, y: f32) -> [i32; 3] {
    let (u, v) = ((x - 100.0) / 200.0, (y - 50.0) / 200.0);
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c = |tl: f32, tr: f32, bl: f32, br: f32| {
        lerp(lerp(tl, tr, u), lerp(bl, br, u), v).round() as i32
    };
    [
        c(255.0, 0.0, 0.0, 255.0),
        c(0.0, 255.0, 0.0, 255.0),
        c(0.0, 0.0, 255.0, 0.0),
    ]
}

#[test]
fn a_mesh_is_a_coons_patch_shading__feat__color_swatches_mesh_freeform_gradients() {
    let d = with_fill(four_corners());
    let pdf = export(&d);
    let types = shading_types(&pdf);
    assert_eq!(types, vec![(6, b"DeviceRGB".to_vec())], "{types:?}");
    let shading = dicts(&pdf)
        .into_iter()
        .find(|d| int(d, b"ShadingType") == Some(6))
        .unwrap();
    assert_eq!(int(&shading, b"BitsPerCoordinate"), Some(32));
    assert_eq!(int(&shading, b"BitsPerComponent"), Some(16));
    assert_eq!(int(&shading, b"BitsPerFlag"), Some(8));
    let decode: Vec<f32> = shading
        .get(b"Decode")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o.as_float().unwrap())
        .collect();
    assert_eq!(
        decode,
        vec![100.0, 300.0, 50.0, 250.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
    );
    assert_eq!(luminosity_masks(&pdf), 0, "an opaque mesh needs no mask");
    if let Some(worst) = worst_against(&pdf, "coons", bilinear) {
        assert!(worst <= 6, "poppler vs the bilinear patch: {worst}");
    }
}

#[test]
fn a_tensor_patch_is_a_type_7_shading__feat__color_swatches_mesh_freeform_gradients() {
    let mut fill = four_corners();
    if let MeshFill::Mesh(m) = &mut fill {
        let g = &mut m.grids[0];
        let p = g.patch(0, 0).unwrap().points;
        // The Coons interior pulled toward the top-left corner.
        g.tensor = vec![[
            [p[1][1][0] - 30.0, p[1][1][1] - 30.0],
            p[1][2],
            p[2][1],
            p[2][2],
        ]];
    }
    let d = with_fill(fill);
    let pdf = export(&d);
    assert_eq!(shading_types(&pdf), vec![(7, b"DeviceRGB".to_vec())]);
    // Against the engine's own rasteriser over the same tensor patch:
    // poppler and the canvas agree on the surface the interior points
    // make, not only on its corners.
    let fill = d.spreads[0].spread.rectangles[0].fill_mesh.clone().unwrap();
    let MeshFill::Mesh(m) = *fill else {
        unreachable!()
    };
    let p = m.grids[0].patch(0, 0).unwrap();
    assert!(p.tensor);
    let lin = |c: &MeshColor| {
        let d = |v: f32| paged_compose::gradient_sample::srgb_decode(v / 255.0);
        Color::rgba(d(c.value[0]), d(c.value[1]), d(c.value[2]), 1.0)
    };
    let shading = paged_compose::MeshShading::patches(vec![paged_compose::ShadePatch {
        points: p.points.map(|row| row.map(|[x, y]| (x, y))),
        colors: p.colors.map(lin),
        tensor: true,
    }]);
    let ours = paged_compose::mesh::rasterize(&shading, 1.0, (0, 0)).unwrap();
    let [_, _, _, _, ox, oy] = ours.to_local.0;
    let at = |x: f32, y: f32| {
        let (i, j) = ((x - ox) as usize, (y - oy) as usize);
        let k = (j * ours.width as usize + i) * 4;
        [
            i32::from(ours.rgba[k]),
            i32::from(ours.rgba[k + 1]),
            i32::from(ours.rgba[k + 2]),
        ]
    };
    if let Some(worst) = worst_against(&pdf, "tensor", at) {
        assert!(worst <= 8, "poppler vs the engine's tensor patch: {worst}");
    }
    // And the interior points moved the colours: not the Coons patch.
    if let Some(page) = rasterise(&pdf, "tensor-moved") {
        let moved = (0..9u32)
            .flat_map(|i| (0..9u32).map(move |j| (110 + i * 22, 60 + j * 22)))
            .filter(|&(x, y)| dist(px(&page, x, y), bilinear(x as f32 + 0.5, y as f32 + 0.5)) > 4)
            .count();
        assert!(moved > 0, "the tensor points change the surface");
    }
}

#[test]
fn a_translucent_mesh_paints_under_an_alpha_mask__feat__color_swatches_mesh_freeform_gradients() {
    let mut fill = four_corners();
    if let MeshFill::Mesh(m) = &mut fill {
        m.grids[0].nodes[3].color.opacity_pct = Some(0.0);
    }
    let pdf = export(&with_fill(fill));
    assert_eq!(luminosity_masks(&pdf), 1);
    assert_eq!(gray_shadings(&pdf), 1, "the mask is the patches' alpha");
    if let Some(page) = rasterise(&pdf, "alpha") {
        assert!(
            dist(px(&page, 297, 247), WHITE) < 16,
            "{:?}",
            px(&page, 297, 247)
        );
        assert!(
            dist(px(&page, 102, 52), [255, 0, 0]) < 16,
            "{:?}",
            px(&page, 102, 52)
        );
    }
}

#[test]
fn a_freeform_gradient_is_a_sampled_coons_grid__feat__color_swatches_mesh_freeform_gradients() {
    let point = |x: f32, y: f32, c: MeshColor| FreeformPoint {
        point: [x, y],
        color: c,
        spread_pct: None,
    };
    let d = with_fill(MeshFill::Freeform(FreeformGradient {
        points: vec![
            point(120.0, 70.0, rgb(255.0, 0.0, 0.0)),
            point(280.0, 230.0, rgb(0.0, 0.0, 255.0)),
            point(270.0, 80.0, rgb(0.0, 200.0, 0.0)),
        ],
        lines: vec![],
    }));
    let pdf = export(&d);
    assert_eq!(shading_types(&pdf), vec![(6, b"DeviceRGB".to_vec())]);
    // The grid's bilinear cells against the exact field the rasterisers
    // draw: the freeform type-6 approximation's tolerance (ADR 1048).
    let fill = d.spreads[0].spread.rectangles[0].fill_mesh.clone().unwrap();
    let MeshFill::Freeform(ff) = *fill else {
        unreachable!()
    };
    let lin = |c: &MeshColor| {
        let d = |v: f32| paged_compose::gradient_sample::srgb_decode(v / 255.0);
        Color::rgba(d(c.value[0]), d(c.value[1]), d(c.value[2]), 1.0)
    };
    let field = paged_compose::FreeformShading {
        bounds: paged_compose::Rect {
            x: 100.0,
            y: 50.0,
            w: 200.0,
            h: 200.0,
        },
        points: ff
            .points
            .iter()
            .map(|p| paged_compose::FreeformSource {
                at: (p.point[0], p.point[1]),
                color: lin(&p.color),
                spread: 0.0,
            })
            .collect(),
        lines: vec![],
    }
    .field();
    let exact = |x: f32, y: f32| field.sample(x, y).map(|v| (v * 255.0).round() as i32);
    if let Some(worst) = worst_against(&pdf, "freeform", |x, y| {
        let c = exact(x, y);
        [c[0], c[1], c[2]]
    }) {
        assert!(worst <= 12, "poppler vs the exact field: {worst}");
    }
}

#[test]
fn a_frame_without_a_mesh_writes_no_patch_shading__feat__color_swatches_mesh_freeform_gradients() {
    let pdf = export(&doc(SQUARE, |_| {}));
    assert!(shading_types(&pdf).is_empty());
}

const WHITE: [i32; 3] = [255, 255, 255];

// ---------------------------------------------------------------------------
// The Illustrator oracle (engine ADR 1048).
//
// `write_illustrator_oracle_inputs` (ignored; run it before recording)
// exports the cases below as PDFs into `tests/fixtures/mesh-oracle/`.
// `modules/draw/scripts/illustrator/probes/mesh-render.jsx` opens each in
// Illustrator, exports its rendering (PNG, 72 dpi) and Illustrator's own
// PDF of it, and records what Illustrator made of the shading; the
// replay below holds the engine's raster of the same mesh to Illustrator's
// pixels and reads the shading type Illustrator writes.
// ---------------------------------------------------------------------------

fn oracle_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mesh-oracle")
}

/// The oracle's cases: a bilinear four-corner patch, a 2 × 2 grid with
/// bent edges and a translucent-free palette, and a tensor patch.
fn oracle_cases() -> Vec<(&'static str, MeshFill)> {
    let mut curved = MeshGrid::rect([100.0, 50.0, 300.0, 250.0], &rgb(240.0, 240.0, 240.0));
    // Split into 2 × 2 by hand: nodes on a 3 × 3 lattice.
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
            paged_model::MeshNode {
                point: [x, y],
                handles: [[x, y]; 4],
                color: colours[k].clone(),
            }
        })
        .collect();
    curved.straighten_handles();
    // The centre node moves and its edges bend.
    curved.nodes[4].point = [215.0, 135.0];
    curved.straighten_handles();
    curved.nodes[4].handles[paged_model::MeshHandle::Right as usize] = [260.0, 110.0];
    curved.nodes[4].handles[paged_model::MeshHandle::Down as usize] = [190.0, 180.0];
    let mut tensor = match four_corners() {
        MeshFill::Mesh(m) => m.grids[0].clone(),
        MeshFill::Freeform(_) => unreachable!(),
    };
    let p = tensor.patch(0, 0).unwrap().points;
    tensor.tensor = vec![[
        [p[1][1][0] - 40.0, p[1][1][1] - 40.0],
        p[1][2],
        p[2][1],
        [p[2][2][0] + 30.0, p[2][2][1] + 10.0],
    ]];
    vec![
        ("coons-four-corners", four_corners()),
        (
            "coons-curved-2x2",
            MeshFill::Mesh(GradientMesh {
                grids: vec![curved],
            }),
        ),
        (
            "tensor-one-patch",
            MeshFill::Mesh(GradientMesh {
                grids: vec![tensor],
            }),
        ),
    ]
}

#[test]
#[ignore = "writes the Illustrator oracle's input PDFs; run before recording"]
fn write_illustrator_oracle_inputs() {
    let dir = oracle_dir();
    std::fs::create_dir_all(&dir).expect("fixture dir");
    for (name, fill) in oracle_cases() {
        let pdf = export(&with_fill(fill));
        std::fs::write(dir.join(format!("{name}.pdf")), pdf).expect("write input");
    }
}

/// The engine's own raster of `fill` in page space at 72 dpi, sampled at
/// a pixel centre: the shading pool entry the renderer builds, through
/// the one rasteriser both canvas lanes draw.
fn engine_pixel(fill: &MeshFill) -> impl Fn(u32, u32) -> Option<[i32; 4]> {
    let d = with_fill(fill.clone());
    let opts = PipelineOptions::default();
    let built = pipeline::build_document(&d, &opts).expect("build");
    let list = &built.pages[0].list;
    let (mesh_id, transform) = list
        .commands
        .iter()
        .find_map(|c| match c {
            paged_compose::DisplayCommand::MeshShade {
                mesh_id, transform, ..
            } => Some((*mesh_id, *transform)),
            _ => None,
        })
        .expect("a MeshShade");
    assert_eq!(transform.0[..4], [1.0, 0.0, 0.0, 1.0], "an upright frame");
    let mesh = list.mesh(mesh_id).expect("mesh").clone();
    let raster = paged_compose::mesh::rasterize(&mesh, 1.0, (0, 0)).expect("raster");
    let [_, _, _, _, ox, oy] = raster.to_local.0;
    let (tx, ty) = (transform.0[4], transform.0[5]);
    move |x: u32, y: u32| {
        let (lx, ly) = (x as f32 + 0.5 - tx, y as f32 + 0.5 - ty);
        let (i, j) = ((lx - ox).floor(), (ly - oy).floor());
        if i < 0.0 || j < 0.0 || i >= raster.width as f32 || j >= raster.height as f32 {
            return None;
        }
        let k = (j as usize * raster.width as usize + i as usize) * 4;
        Some([
            i32::from(raster.rgba[k]),
            i32::from(raster.rgba[k + 1]),
            i32::from(raster.rgba[k + 2]),
            i32::from(raster.rgba[k + 3]),
        ])
    }
}

/// Engine ADR 1048 — Illustrator's rendering of the engine's mesh PDFs
/// against the engine's raster of the same meshes, and the shading type
/// Illustrator's own PDF export writes for them. Skips (reported) until
/// the probe has been recorded.
#[test]
fn the_engine_draws_a_mesh_as_illustrator_does__feat__color_swatches_mesh_freeform_gradients() {
    let dir = oracle_dir();
    let fixture = dir.join("mesh-render.illustrator.json");
    let Ok(text) = std::fs::read_to_string(&fixture) else {
        paged_test_resources::unavailable(
            paged_test_resources::Resource::Corpus,
            "the Illustrator mesh oracle is not recorded (tests/fixtures/mesh-oracle)",
        );
        return;
    };
    let rec: serde_json::Value = serde_json::from_str(&text).expect("fixture json");
    let cases = rec["cases"].as_array().expect("cases");
    for (name, fill) in oracle_cases() {
        let case = cases
            .iter()
            .find(|c| c["id"] == name)
            .unwrap_or_else(|| panic!("case {name} recorded"));
        // Illustrator opens the shading as a shading (no MeshItem: its
        // scripting cannot reach the object, which is not a mesh) inside
        // the clip path, which is the one path item.
        assert_eq!(case["path_items"].as_i64(), Some(1), "{name}: {case}");
        let png = image::open(dir.join(case["png"].as_str().unwrap()))
            .expect("illustrator png")
            .to_rgb8();
        let ours = engine_pixel(&fill);
        // A lattice inside the mesh, clear of its edge.
        let mut worst = 0;
        let mut n = 0;
        for i in 0..13u32 {
            for j in 0..13u32 {
                let (x, y) = (108 + i * 15, 58 + j * 15);
                let Some(o) = ours(x, y) else { continue };
                if o[3] < 255 {
                    continue;
                }
                let a = png.get_pixel(x, y).0;
                let a = [i32::from(a[0]), i32::from(a[1]), i32::from(a[2])];
                let d = dist(a, [o[0], o[1], o[2]]);
                worst = worst.max(d);
                n += 1;
            }
        }
        assert!(n > 100, "{name}: {n} samples");
        let tolerance = case["tolerance"].as_i64().unwrap_or(ORACLE_TOLERANCE) as i32;
        assert!(
            worst <= tolerance,
            "{name}: Illustrator vs the engine differ by {worst} (> {tolerance}) on an 8-bit channel"
        );
        // What Illustrator's PDF export writes for a mesh.
        let ai_pdf = std::fs::read(dir.join(case["pdf"].as_str().unwrap())).expect("ai pdf");
        let types: Vec<i64> = shading_types(&ai_pdf).into_iter().map(|(t, _)| t).collect();
        let ours: Vec<i64> = shading_types(&export(&with_fill(fill.clone())))
            .into_iter()
            .map(|(t, _)| t)
            .collect();
        assert_eq!(
            types, ours,
            "{name}: Illustrator writes the shading type the engine writes"
        );
    }
}

/// The largest 8-bit channel difference the replay allows between
/// Illustrator's PNG and the engine's raster. Recorded (Illustrator 30.1,
/// 2026-10-29): the curved 2 × 2 grid differs by at most 4, the tensor
/// patch by 2, the bilinear four-corner patch by 8 — a CONVENTION, not a
/// defect: at (123, 73), near a corner where the bilinear red channel
/// bends most, the exact bilinear value is 202 and the engine draws 202
/// (poppler agrees, `a_mesh_is_a_coons_patch_shading`), Illustrator 210:
/// it Gouraud-shades a coarser tessellation of the patch. Elsewhere it
/// agrees with the exact value within one level.
const ORACLE_TOLERANCE: i64 = 8;
