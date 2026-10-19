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

//! Placed SVGs against `resvg`, which drew them before the engine's CPU
//! lane moved to `vello_cpu` (ADR 189), and against the budgets beside
//! the fixtures.
//!
//! `corpus/generated-fixtures/svg/` holds small SVGs written for this:
//! every filter primitive, clip paths and masks, gradients, and text.
//! Each `<name>.resvg.png` is that SVG drawn by `resvg` 0.48.1 the way
//! the engine's decoder called it (default options, 1 px per user unit),
//! straight alpha. `svg-reference.json` gives each fixture its budget:
//! the mean and 99th-percentile ΔE2000 over white, sized to the measured
//! value plus headroom. Where `resvg` misreads the specification the
//! budget says so, with what a browser draws.
//!
//! `PAGED_SVG_OUT=<dir>` writes each candidate render there.

#![cfg(feature = "svg")]

use std::path::{Path, PathBuf};

use image::RgbImage;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/generated-fixtures/svg")
}

/// Straight-alpha RGBA over white.
fn over_white(rgba: &[u8], w: u32, h: u32) -> RgbImage {
    RgbImage::from_fn(w, h, |x, y| {
        let i = ((y * w + x) * 4) as usize;
        let a = rgba[i + 3] as f32 / 255.0;
        image::Rgb(std::array::from_fn(|c| {
            (rgba[i + c] as f32 * a + 255.0 * (1.0 - a)).round() as u8
        }))
    })
}

#[test]
fn placed_svgs_match_the_resvg_reference_within_their_budgets() {
    let dir = fixtures();
    let budgets: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("svg-reference.json")).expect("budgets"))
            .expect("budgets parse");
    let entries = budgets["fixtures"].as_array().expect("fixtures");
    let out = std::env::var_os("PAGED_SVG_OUT").map(PathBuf::from);
    let mut failures = Vec::new();
    let mut seen = Vec::new();
    for entry in entries {
        let name = entry["name"].as_str().expect("name");
        seen.push(name.to_string());
        let bytes = std::fs::read(dir.join(format!("{name}.svg"))).expect("svg");
        let tree = usvg::Tree::from_data(&bytes, &usvg::Options::default()).expect("parse");
        let (w, h) = (
            tree.size().width().ceil() as u32,
            tree.size().height().ceil() as u32,
        );
        let cand = paged_gpu::svg::rasterize_svg(&tree, w, h, 1.0).expect("render");
        let reference = image::open(dir.join(format!("{name}.resvg.png")))
            .expect("reference")
            .to_rgba8();
        assert_eq!(reference.dimensions(), (w, h), "{name}: reference size");
        if let Some(out) = &out {
            std::fs::create_dir_all(out).expect("out dir");
            image::save_buffer(
                out.join(format!("{name}.png")),
                &cand,
                w,
                h,
                image::ExtendedColorType::Rgba8,
            )
            .expect("write");
        }
        let (report, _) = paged_fidelity::diff::compare_images(
            &over_white(reference.as_raw(), w, h),
            &over_white(&cand, w, h),
        )
        .expect("compare");
        let (mean, p99) = (
            entry["max_mean_de"].as_f64().expect("max_mean_de"),
            entry["max_p99_de"].as_f64().expect("max_p99_de"),
        );
        println!(
            "{name:20} mean ΔE {:.3} (budget {mean:.3})  p99 ΔE {:.2} (budget {p99:.2})",
            report.mean_delta_e, report.p99_delta_e
        );
        if report.mean_delta_e > mean || report.p99_delta_e > p99 {
            failures.push(format!(
                "{name}: mean {:.3} > {mean} or p99 {:.2} > {p99}",
                report.mean_delta_e, report.p99_delta_e
            ));
        }
    }
    // Every fixture on disk has a budget.
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .expect("fixtures dir")
        .filter_map(|e| {
            let name = e.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".svg").map(str::to_string)
        })
        .collect();
    on_disk.sort();
    seen.sort();
    assert_eq!(
        on_disk, seen,
        "every fixture SVG needs an entry in svg-reference.json"
    );
    assert!(failures.is_empty(), "over budget:\n{}", failures.join("\n"));
}
