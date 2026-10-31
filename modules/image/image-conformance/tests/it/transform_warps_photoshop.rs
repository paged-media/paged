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

//! Transform and warp on pixels against Photoshop (WP5.6, image ADR 483),
//! replayed from `fixtures/photoshop/transform-warps`
//! (`scripts/photoshop/probes/transform-warps.jsx`): the `colour-sweep`
//! stimulus as a layer, warped in each of the fifteen styles at +50 % bend
//! and content-aware scaled to 75 % width by Photoshop 27.10, flattened on
//! white. (Distort and Perspective are not scriptable — Photoshop's
//! Transform event ignores every corner form; the probe says which — so a
//! homography, fixed by its four corners, is held to the maths in
//! `family_geom.rs`.)
//!
//! Paged's side runs the CPU twin the GPU kernel is held to
//! (`paged-resample`'s `warp_map_rgba8` through `paged-warp`'s envelope;
//! `image_js::warps::content_aware_scale`), on white too, and each case is
//! classified as the ledgers are:
//!
//! * CONVENTION — the Warp styles: `paged-warp`'s styles are its own
//!   closed forms (warp-text.jsx recorded the same for type), so the
//!   pixels differ where the shapes do; each style's mean distance is
//!   recorded in [`WARP_CONVENTION`] and held there, so a change to a
//!   style shows up as a changed number.
//! * CONVENTION — Content-Aware Scale: both keep the width Photoshop
//!   gives (75 %) and both differ from a plain scale; the seams are each
//!   app's own.

#![allow(non_snake_case)]

use std::path::PathBuf;

use paged_resample::{warp_map_rgba8, WarpFilter, Window};
use paged_warp::envelope::{self, Rect, Warp, WarpStyle};
use zune_core::bytestream::ZCursor;
use zune_core::result::DecodingResult;
use zune_png::PngDecoder;

const N: u32 = 128;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/photoshop")
}

/// A 16-bit PNG as 8-bit RGB (rounded levels).
fn png8(rel: &str) -> Vec<[u8; 3]> {
    let path = dir().join(rel);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut dec = PngDecoder::new(ZCursor::new(&bytes));
    let res = dec.decode().expect("decode");
    let ch = dec.colorspace().expect("colorspace").num_components();
    let DecodingResult::U16(v) = res else {
        panic!("{rel}: not 16-bit");
    };
    let l = |s: u16| ((f64::from(s) / 257.0).round()) as u8;
    v.chunks_exact(ch)
        .map(|p| [l(p[0]), l(p[1]), l(p[2])])
        .collect()
}

/// The stimulus as opaque straight RGBA8.
fn stimulus() -> Vec<u8> {
    png8("stimuli/colour-sweep.png")
        .into_iter()
        .flat_map(|p| [p[0], p[1], p[2], 255])
        .collect()
}

/// Straight RGBA8 flattened on white, as Photoshop's flatten does.
fn on_white(rgba: &[u8]) -> Vec<[u8; 3]> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .map(|p| {
            let a = f64::from(p[3]) / 255.0;
            let c = |v: u8| (f64::from(v) * a + 255.0 * (1.0 - a)).round() as u8;
            [c(p[0]), c(p[1]), c(p[2])]
        })
        .collect()
}

/// Mean and 99th percentile of the per-channel distance, 8-bit levels.
fn distance(ours: &[[u8; 3]], theirs: &[[u8; 3]]) -> (f64, f64) {
    assert_eq!(ours.len(), theirs.len());
    let mut d: Vec<f64> = ours
        .iter()
        .zip(theirs)
        .flat_map(|(a, b)| (0..3).map(move |c| f64::from(a[c].abs_diff(b[c]))))
        .collect();
    d.sort_by(f64::total_cmp);
    let mean = d.iter().sum::<f64>() / d.len() as f64;
    (mean, d[d.len() * 99 / 100])
}

const WINDOW: Window = Window {
    x: 0,
    y: 0,
    w: N,
    h: N,
};

/// The layer bent through `style` at +50 %.
fn warped(style: WarpStyle) -> Vec<[u8; 3]> {
    let n = f64::from(N);
    let mesh = envelope::mesh(
        &Warp {
            style,
            bend: 0.5,
            ..Warp::NONE
        },
        Rect {
            x: 0.0,
            y: 0.0,
            w: n,
            h: n,
        },
    );
    let out = warp_map_rgba8(&stimulus(), N, N, WINDOW, WarpFilter::Bilinear, |x, y| {
        envelope::invert_extended(&mesh, (x, y), 0.5).map(|(u, v)| (u * n - 0.5, v * n - 0.5))
    })
    .expect("warp");
    on_white(&out)
}

#[test]
fn the_identity_case_converted_nothing__feat__image_editor_transform_warp() {
    let (mean, p99) = distance(
        &on_white(&stimulus()),
        &png8("transform-warps/identity.png"),
    );
    eprintln!("identity: mean {mean:.4}, p99 {p99}");
    // Photoshop holds 16-bit samples as 0..32768: a level of rounding.
    assert!(
        mean <= 0.05 && p99 <= 1.0,
        "the identity case converted something"
    );
}

/// The fifteen styles: (name, recorded mean distance in 8-bit levels,
/// Photoshop 27.10 against paged-warp's style meshes on the 128 px square,
/// 2026-10-30). LARGE, and recorded as such: on a square Photoshop's
/// styles bend by an amount that follows the box's WIDTH (Rise at +50 %
/// drops the left edge by about half the height; Arc lifts the bottom
/// edge's middle by a quarter), where paged-warp's closed forms — fitted
/// to the wide boxes of Warp Text — bend far less (Rise) or fan out
/// (Arc). Directions agree for every style. Refitting the styles to these
/// recordings is open work (image ADR 483, "Open"); until then a change
/// to a style shows up here as a moved number.
const WARP_CONVENTION: &[(&str, f64)] = &[
    ("arc", 54.63),
    ("arcLower", 21.87),
    ("arcUpper", 26.18),
    ("arch", 27.49),
    ("bulge", 20.64),
    ("shellLower", 21.15),
    ("shellUpper", 21.82),
    ("flag", 75.5),
    ("wave", 23.84),
    ("fish", 20.41),
    ("rise", 103.14),
    ("fishEye", 14.53),
    ("inflate", 4.39),
    ("squeeze", 14.54),
    ("twist", 37.04),
];

#[test]
fn warp_styles_are_a_recorded_convention__feat__image_editor_transform_warp() {
    let mut report = Vec::new();
    let mut moved = Vec::new();
    for &(name, recorded) in WARP_CONVENTION {
        let style = WarpStyle::from_name(name).expect("style");
        let theirs = png8(&format!("transform-warps/warp-{name}-50.png"));
        let ours = warped(style);
        if let Ok(dir) = std::env::var("PAGED_WARP_DUMP") {
            let mut ppm = format!("P6 {N} {N} 255\n").into_bytes();
            ppm.extend(ours.iter().flatten());
            std::fs::write(format!("{dir}/{name}.ppm"), ppm).expect("dump");
        }
        let (mean, p99) = distance(&ours, &theirs);
        report.push(format!("(\"{name}\", {mean:.2}), // p99 {p99}"));
        if (mean - recorded).abs() > 0.5 {
            moved.push(format!("{name}: {mean:.2} (recorded {recorded})"));
        }
    }
    eprintln!("{}", report.join("\n"));
    assert!(moved.is_empty(), "warp styles moved: {moved:?}");
}

#[test]
fn content_aware_scale_keeps_photoshops_width_and_is_not_a_plain_scale__feat__image_editor_transform_warp(
) {
    let theirs_cas = png8("transform-warps/content-aware-scale-w75.png");
    let theirs_plain = png8("transform-warps/plain-scale-w75.png");
    let ours = on_white(
        &image_js::warps::content_aware_scale(&stimulus(), N, N, 0.75, 1.0, 1.0, None)
            .expect("scale"),
    );
    // The covered columns: not white.
    let covered = |img: &[[u8; 3]]| -> Vec<u32> {
        (0..N)
            .filter(|&x| (0..N).any(|y| img[(y * N + x) as usize] != [255; 3]))
            .collect()
    };
    let (o, t) = (covered(&ours), covered(&theirs_cas));
    eprintln!(
        "covered: ours {}..{} ({}), Photoshop {}..{} ({})",
        o[0],
        o[o.len() - 1],
        o.len(),
        t[0],
        t[t.len() - 1],
        t.len()
    );
    assert_eq!(o.len(), 96);
    assert!(t.len().abs_diff(96) <= 1, "Photoshop covers {}", t.len());
    assert!(o[0].abs_diff(t[0]) <= 1);
    let (vs_plain, _) = distance(&theirs_cas, &theirs_plain);
    let (vs_ours, _) = distance(&ours, &theirs_cas);
    eprintln!("Photoshop CAS vs its plain scale {vs_plain:.2}; ours vs Photoshop CAS {vs_ours:.2}");
    assert!(
        vs_plain > 0.5,
        "Photoshop's content-aware scale is not a plain scale"
    );
}
