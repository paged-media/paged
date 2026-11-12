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

//! Engine ADR 1099 — "Place PSD layers as frames", end to end: files
//! Photoshop 27.10 wrote (the `layer-styles` probe's, copied with their
//! provenance into `paged-psd-fx`'s fixtures) placed on a page through the
//! canvas model (`psd_layers_place_plan`, one batch), drawn by the engine
//! (the frames' pictures, and their styles through the layer-style
//! evaluator on its CPU device, composited by the rasteriser), and held to
//! Photoshop's own merged composite of the same file.
//!
//! This is the parity the evaluator owes the engine: the image module
//! measures the same files through its fold (`image-conformance`'s
//! `psd_layer_styles`, GPU and CPU); here the page draws them.

use paged_canvas::{
    psd_io::PsdPlaceOptions, render_snapshot_request, CanvasModel, CanvasOptions, PageId,
    SnapshotFormat, SnapshotRequest,
};
use paged_model::effect_stack::{Effect, EffectTarget};

fn fixture(id: &str) -> Vec<u8> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../paged-psd-fx/tests/fixtures/photoshop-layer-styles")
        .join(format!("{id}.psd"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn blank() -> (CanvasModel, PageId) {
    let idml = paged_canvas::blank::blank_idml(612.0, 792.0);
    let m = CanvasModel::load("psd", &idml, CanvasOptions::default()).expect("load");
    let page = PageId(m.pages()[0].self_id.clone());
    (m, page)
}

/// Place `id`'s layers with the canvas's top-left at the page's.
fn place(id: &str) -> (CanvasModel, PageId, paged_canvas::psd_io::PsdPlacePlan) {
    let (mut m, page) = blank();
    let plan = m.psd_layers_place_plan(
        &page,
        &fixture(id),
        &PsdPlaceOptions {
            origin: Some([0.0, 0.0]),
            group: None,
        },
    );
    assert!(plan.error.is_none(), "{id}: {:?}", plan.error);
    let batch = plan.mutation.clone().expect("layers to place");
    m.apply_mutation(&batch)
        .unwrap_or_else(|e| panic!("{id}: the batch applies: {e:?}"));
    (m, page, plan)
}

/// The page at 72 dpi (the files' resolution: one pixel per point), RGBA.
fn pixels(m: &CanvasModel, page: &PageId) -> (u32, Vec<u8>) {
    let snap = render_snapshot_request(
        m,
        &SnapshotRequest {
            dpi: Some(72.0),
            format: SnapshotFormat::Rgba,
            ..SnapshotRequest::page(page, 612)
        },
    )
    .expect("snapshot");
    (snap.width_px, snap.rgba)
}

/// The largest and the mean channel difference (8-bit levels) over the
/// file's canvas, both straight RGB.
fn distance(page: &(u32, Vec<u8>), theirs: &[u8], w: u32, h: u32) -> (u8, f64) {
    let (mut max, mut sum, mut n) = (0u8, 0u64, 0u64);
    for y in 0..h {
        for x in 0..w {
            let a = ((y * page.0 + x) * 4) as usize;
            let b = ((y * w + x) * 4) as usize;
            for c in 0..3 {
                // Photoshop's composite is over transparency where the
                // file has no background; the page is white.
                let alpha = f32::from(theirs[b + 3]) / 255.0;
                let t = (f32::from(theirs[b + c]) * alpha + 255.0 * (1.0 - alpha)).round() as u8;
                let d = page.1[a + c].abs_diff(t);
                max = max.max(d);
                sum += u64::from(d);
                n += 1;
            }
        }
    }
    (max, sum as f64 / n.max(1) as f64)
}

/// (file, max levels, mean levels × 100) — the engine's page against
/// Photoshop's composite, measured 2026-11-12 with a level of slack.
const EXPECT: &[(&str, u8, u32)] = &[
    ("bv-contour-cone", 160, 290),
    ("bv-inner-smooth", 46, 70),
    ("co-fill0", 4, 20),
    ("ds-basic", 4, 25),
    ("go-linear", 4, 25),
    ("go-radial", 4, 25),
    ("ig-edge", 6, 40),
    ("is-basic", 4, 25),
    ("og-gradient", 13, 65),
    ("og-softer", 4, 30),
    ("sa-plain", 4, 30),
    ("st-outside-square", 36, 35),
];

#[test]
#[allow(non_snake_case)]
fn placed_psd_layers_draw_their_styles_as_photoshop_does__feat__images_graphics_psd_layer_styles() {
    let mut report = Vec::new();
    let mut problems = Vec::new();
    for (id, wmax, wmean) in EXPECT {
        let (m, page, plan) = place(id);
        assert!(plan.layers >= 1, "{id}");
        let file = paged_psd::PsdFile::parse(&fixture(id)).expect("parse");
        let theirs = file.composite_rgba8().expect("composite");
        let img = pixels(&m, &page);
        let (max, mean) = distance(&img, &theirs.rgba, theirs.width, theirs.height);
        let mean100 = (mean * 100.0).round() as u32;
        report.push(format!("    (\"{id}\", {max}, {mean100}),"));
        if max > *wmax || mean100 > *wmean {
            problems.push(format!(
                "{id}: expected max ≤ {wmax}, mean ≤ {:.2}; got max {max}, mean {mean:.2}",
                *wmean as f64 / 100.0
            ));
        }
    }
    println!("{}", report.join("\n"));
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// The style arrives whole: a layer-style stack on the frame, its slot
/// with the contour Photoshop wrote, one undo step for the whole place.
#[test]
#[allow(non_snake_case)]
fn a_placed_layer_carries_its_style_as_effects__feat__images_graphics_psd_layer_styles() {
    let (mut m, _page, plan) = place("ds-basic");
    let spread = &m.scene().spreads[0].spread;
    let styled: Vec<_> = spread
        .rectangles
        .iter()
        .filter(|r| !r.effect_stack.is_empty())
        .collect();
    assert_eq!(styled.len(), 1, "{:?}", plan.losses);
    let r = styled[0];
    assert!(r.effect_stack.iter().all(|e| e.is_layer_style()));
    assert!(matches!(
        r.effect_stack[0].effect,
        Effect::DropShadow { .. }
    ));
    let d = r.drop_shadow.as_ref().expect("the slot");
    assert!(d.contour.is_some() && d.angle_deg == Some(120.0));
    assert_eq!(
        paged_model::effect_stack::EffectBearing::effect_slots(r, EffectTarget::Object)
            .with_params()
            .len(),
        1
    );
    let frames = spread.rectangles.len();
    m.undo().expect("undo");
    assert!(m.scene().spreads[0].spread.rectangles.len() < frames);
}

/// Not a PSD: an error, no batch.
#[test]
fn a_file_that_is_not_a_psd_plans_nothing() {
    let (m, page) = blank();
    let plan = m.psd_layers_place_plan(&page, b"not a psd", &PsdPlaceOptions::default());
    assert!(plan.mutation.is_none());
    assert!(plan.error.is_some());
}
