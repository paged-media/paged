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

//! WARP TEXT, recorded from Photoshop (`scripts/photoshop/probes/
//! warp-text.jsx`): one line of type in each Warp Text style at ±50 %
//! bend, saved as a layered PSD with the warped layer's bounds.
//!
//! Two claims, two strengths:
//!
//! - AGREEMENT — the PSD's warp opens as the style, bend, distortions and
//!   orientation that made it (the type layer's `TySh` warp descriptor),
//!   and a 300 ppi document's type opens at its pixel size.
//! - CONVENTION — paged-warp's style meshes are this project's own closed
//!   forms. Their extent over the unwarped text's box is held to
//!   Photoshop's warped bounds within [`EXPECT`]'s recorded distance (the
//!   largest edge difference, px), so a change to a style shows up here
//!   as a moved number rather than silently.

use std::path::PathBuf;

use image_js::layers::LayerStack;
use image_psd::PsdFile;
use paged_warp::envelope::{extent, mesh, Rect};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop")
}

fn record() -> serde_json::Value {
    let text = std::fs::read_to_string(fixtures().join("warp-text.photoshop.json"))
        .expect("warp-text.photoshop.json");
    serde_json::from_str(&text).expect("json")
}

fn type_source(id: &str) -> image_js::layers::TypeSource {
    let bytes = std::fs::read(fixtures().join(format!("warp-text/{id}.psd"))).expect("psd");
    let file = PsdFile::parse(&bytes).expect("parse");
    let import = file.layer_plates_rgba8().expect("plates");
    let stack =
        LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers)).expect("stack");
    stack
        .layers()
        .iter()
        .find_map(|l| l.type_layer())
        .expect("a type layer")
        .source
        .clone()
}

/// Largest edge difference (px) between Photoshop's warped bounds and
/// paged-warp's extent of the same warp over the flat bounds, by case.
/// Recorded 2026-10-27 against Photoshop 27.10 (the ratchet: a number may
/// shrink, never grow).
const EXPECT: &[(&str, f64)] = &[
    ("none", 1.0),
    ("arc-50", 33.0),
    ("arc-minus-50", 20.0),
    ("arcLower-50", 2.0),
    ("arcLower-minus-50", 8.0),
    ("arcUpper-50", 4.0),
    ("arcUpper-minus-50", 8.0),
    ("arch-50", 8.0),
    ("arch-minus-50", 1.0),
    ("bulge-50", 5.0),
    ("bulge-minus-50", 2.0),
    ("shellLower-50", 2.0),
    ("shellLower-minus-50", 3.0),
    ("shellUpper-50", 3.0),
    ("shellUpper-minus-50", 7.0),
    ("flag-50", 5.0),
    ("flag-minus-50", 5.0),
    ("wave-50", 3.0),
    ("wave-minus-50", 3.0),
    ("fish-50", 6.0),
    ("fish-minus-50", 6.0),
    ("rise-50", 1.0),
    ("rise-minus-50", 1.0),
    ("fishEye-50", 4.0),
    ("fishEye-minus-50", 2.0),
    ("inflate-50", 4.0),
    ("inflate-minus-50", 10.0),
    ("squeeze-50", 6.0),
    ("squeeze-minus-50", 5.0),
    ("twist-50", 10.0),
    ("twist-minus-50", 9.0),
    ("arc-distorted", 27.0),
    ("flag-vertical", 46.0),
];

#[test]
#[allow(non_snake_case)]
fn photoshop_warp_text_opens_as_the_warp_that_made_it__feat__image_layers_type() {
    let rec = record();
    for case in rec["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().unwrap();
        let p = &case["params"];
        let src = type_source(id);
        let want = p["style"].as_str().unwrap();
        assert_eq!(src.warp.style, want, "{id}");
        let pct = |k: &str| p[k].as_f64().unwrap_or(0.0) / 100.0;
        if want != "none" {
            assert!((src.warp.bend - pct("bend")).abs() < 1e-6, "{id}: bend");
            assert!(
                (src.warp.horizontal - pct("horizontal")).abs() < 1e-6,
                "{id}: horizontal"
            );
            assert!(
                (src.warp.vertical - pct("vertical")).abs() < 1e-6,
                "{id}: vertical"
            );
            assert_eq!(
                src.warp.rotate_vertical,
                p["vertical_orientation"].as_bool().unwrap_or(false),
                "{id}: orientation"
            );
        }
    }
}

#[test]
#[allow(non_snake_case)]
fn a_300_ppi_type_layer_opens_at_its_pixel_size__feat__image_layers_type() {
    // The probe asked for 48 px and Photoshop set 48 pt at 300 ppi: the
    // text is 300 / 72 times the 72 ppi case, and the size the import
    // gives is the size in canvas pixels, whatever the file's transform.
    let src = type_source("none-300ppi");
    let flat = type_source("none");
    let ratio = src.runs[0].size / flat.runs[0].size;
    assert!((ratio - 300.0 / 72.0).abs() < 0.02, "size ratio {ratio}");
}

#[test]
#[allow(non_snake_case)]
fn paged_warp_styles_bend_the_box_like_photoshop_within_the_recorded_distance__feat__image_layers_type(
) {
    let rec = record();
    let mut report = Vec::new();
    for case in rec["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().unwrap();
        let Some(&(_, limit)) = EXPECT.iter().find(|(k, _)| *k == id) else {
            continue;
        };
        let v = &case["values"];
        let b = |k: &str| -> Vec<f64> {
            v[k].as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect()
        };
        let (flat, warped) = (b("flat_bounds"), b("warped_bounds"));
        let rect = Rect {
            x: flat[0],
            y: flat[1],
            w: flat[2] - flat[0],
            h: flat[3] - flat[1],
        };
        let src = type_source(id);
        let e = extent(&mesh(&src.warp.to_warp(), rect));
        let ours = [e.x, e.y, e.x + e.w, e.y + e.h];
        let d = ours
            .iter()
            .zip(&warped)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f64, f64::max);
        report.push(format!("{id}: {d:.1}"));
        if std::env::var("PAGED_WARP_MEASURE").is_err() {
            assert!(
                d <= limit,
                "{id}: {d:.1} px from Photoshop (recorded {limit})"
            );
        }
    }
    eprintln!(
        "warp text vs Photoshop (max edge px): {}",
        report.join(", ")
    );
}
