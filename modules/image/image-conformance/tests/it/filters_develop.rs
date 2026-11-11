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

//! gpu↔ref parity and behaviour proofs for `families::develop` (WP5.2):
//! the Develop adjustment's point stages (`develop.tone`) and
//! neighbourhood stages (`develop.detail`). The scalar twins mirror the
//! WGSL modules stage for stage, reading the same integer taps and
//! weights the CPU hands the shader.
//!
//! The parity tests report `unavailable: GPU adapter` without one and fail
//! under `PAGED_REQUIRE_GPU=1` (never a silent pass).
#![allow(non_snake_case)]

use image_conformance::harness::{assert_within, parity_windowed, ParityResult};
use image_conformance::Px;
use image_kernels::families::develop::{
    DevelopSettings, DEVELOP_DETAIL, DEVELOP_LEN, DEVELOP_TONE,
};
use image_kernels::KernelDef;

use paged_image_adjust::develop::{detail as detail_ref, tone as tone_ref};

use super::filters_adjust_ext::{luma, stimulus, unpremul};

const W: u32 = 48;
const H: u32 = 40;

fn check(result: Option<ParityResult>, def: &KernelDef) {
    if let Some(r) = result {
        eprintln!("{}: measured max f16 ULP {}", def.id, r.max_ulp);
        assert_within(r, def);
    }
}

fn settings(pairs: &[(usize, f32)]) -> DevelopSettings {
    let mut s = DevelopSettings::identity();
    for &(i, v) in pairs {
        s.0[i] = v;
    }
    s
}

/// A spread of tone settings: white balance + exposure, the tonal
/// sliders and curve, HSL in several ranges, vibrance/saturation and the
/// grading wheels.
fn tone_cases() -> Vec<DevelopSettings> {
    vec![
        settings(&[(0, 30.0), (1, -15.0), (2, 0.6)]),
        settings(&[
            (3, 40.0),
            (4, -50.0),
            (5, 60.0),
            (6, 20.0),
            (7, -30.0),
            (51, 30.0),
            (54, -40.0),
        ]),
        settings(&[
            (13, 20.0),
            (14, 40.0),
            (15, -20.0),
            (22, -30.0),
            (23, 50.0),
            (31, 10.0),
            (11, 40.0),
            (12, -10.0),
        ]),
        settings(&[
            (37, 210.0),
            (38, 50.0),
            (39, -20.0),
            (43, 40.0),
            (44, 60.0),
            (46, 120.0),
            (47, 15.0),
            (50, 30.0),
        ]),
    ]
}

fn detail_cases() -> Vec<DevelopSettings> {
    vec![
        settings(&[(8, 50.0), (9, 60.0)]),
        settings(&[(10, 40.0), (55, 80.0), (56, 1.5), (58, 30.0)]),
        settings(&[(10, -50.0), (59, 50.0), (60, 60.0), (55, 40.0)]),
    ]
}

#[test]
fn develop_tone_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    for s in tone_cases() {
        check(
            parity_windowed(&DEVELOP_TONE, tone_ref, &win, W, H, &s.tone_params()),
            &DEVELOP_TONE,
        );
    }
}

#[test]
fn develop_detail_parity__feat__image_editor_filters() {
    let win = stimulus(W, H);
    for s in detail_cases() {
        check(
            parity_windowed(&DEVELOP_DETAIL, detail_ref, &win, W, H, &s.detail_params()),
            &DEVELOP_DETAIL,
        );
    }
}

#[test]
fn develop_defaults_are_the_identity__feat__image_editor_filters() {
    let id = DevelopSettings::identity();
    assert!(id.is_identity() && id.tone_is_identity() && id.detail_is_identity());
    assert!(id.ops().is_empty(), "the defaults dispatch nothing");
    let win = stimulus(W, H).quantized_px();
    for (i, px) in win.iter().enumerate() {
        let (x, y) = (i as u32 % W, i as u32 / W);
        let t = tone_ref(&win, W, H, x, y, &id.tone_params());
        let d = detail_ref(&win, W, H, x, y, &id.detail_params());
        for c in 0..4 {
            assert!((t.0[c] - px.0[c]).abs() < 1e-6, "tone moved pixel {i}");
        }
        assert_eq!(d.0, px.0, "detail moved pixel {i}");
    }
    // One half at identity is skipped; both halves run tone then detail.
    assert_eq!(settings(&[(2, 1.0)]).ops().len(), 1);
    let both = settings(&[(2, 1.0), (9, 20.0)]).ops();
    assert_eq!(both.len(), 2);
    assert_eq!(both[0].0.id, "develop.tone");
    assert_eq!(both[1].0.id, "develop.detail");
}

#[test]
fn develop_settings_clamp_to_their_ranges__feat__image_editor_filters() {
    assert!(DevelopSettings::from_values(&[0.0; 60]).is_none());
    let mut v = DevelopSettings::identity().0.to_vec();
    v[2] = 9.0;
    v[37] = 500.0;
    v[56] = f32::NAN;
    let s = DevelopSettings::from_values(&v).expect("61 values");
    assert_eq!(s.0[2], 5.0);
    assert_eq!(s.0[37], 360.0);
    assert_eq!(s.0[56], 1.0, "a non-finite value takes its default");
    assert_eq!(s.0.len(), DEVELOP_LEN);
}

fn mean_luma(px: &[Px]) -> f32 {
    px.iter().map(|p| luma(unpremul(*p))).sum::<f32>() / px.len() as f32
}

fn run_tone(win: &[Px], s: &DevelopSettings) -> Vec<Px> {
    (0..W * H)
        .map(|i| tone_ref(win, W, H, i % W, i / W, &s.tone_params()))
        .collect()
}

fn run_detail(win: &[Px], s: &DevelopSettings) -> Vec<Px> {
    (0..W * H)
        .map(|i| detail_ref(win, W, H, i % W, i / W, &s.detail_params()))
        .collect()
}

#[test]
fn develop_exposure_brightens_and_temperature_warms__feat__image_editor_filters() {
    let win = stimulus(W, H).quantized_px();
    let base = mean_luma(&win);
    assert!(mean_luma(&run_tone(&win, &settings(&[(2, 1.0)]))) > base + 0.08);
    assert!(mean_luma(&run_tone(&win, &settings(&[(2, -1.0)]))) < base - 0.05);
    let warm = run_tone(&win, &settings(&[(0, 60.0)]));
    let (mut dr, mut db) = (0.0f32, 0.0f32);
    for (a, b) in win.iter().zip(&warm) {
        let (ca, cb) = (unpremul(*a), unpremul(*b));
        dr += cb[0] - ca[0];
        db += cb[2] - ca[2];
    }
    assert!(dr > 0.0 && db < 0.0, "warmer: red up {dr}, blue down {db}");
}

#[test]
fn develop_saturation_minus_100_is_grey__feat__image_editor_filters() {
    let win = stimulus(W, H).quantized_px();
    for p in run_tone(&win, &settings(&[(12, -100.0)])) {
        let c = unpremul(p);
        assert!(
            (c[0] - c[1]).abs() < 1e-5 && (c[1] - c[2]).abs() < 1e-5,
            "{c:?}"
        );
    }
}

#[test]
fn develop_clarity_raises_local_contrast_and_noise_reduction_lowers_it__feat__image_editor_filters()
{
    let win = stimulus(W, H).quantized_px();
    // Local contrast: the mean absolute difference to the right neighbour.
    let lc = |px: &[Px]| {
        let mut s = 0.0f32;
        for y in 0..H {
            for x in 0..W - 1 {
                let i = (y * W + x) as usize;
                s += (luma(unpremul(px[i])) - luma(unpremul(px[i + 1]))).abs();
            }
        }
        s
    };
    let base = lc(&win);
    assert!(lc(&run_detail(&win, &settings(&[(9, 80.0)]))) > base * 1.05);
    assert!(lc(&run_detail(&win, &settings(&[(8, 80.0)]))) > base * 1.05);
    assert!(lc(&run_detail(&win, &settings(&[(55, 120.0)]))) > base * 1.05);
    assert!(lc(&run_detail(&win, &settings(&[(59, 100.0)]))) < base * 0.95);
    // Dehaze deepens the darks (the dark channel is pushed down).
    let hz = run_detail(&win, &settings(&[(10, 80.0)]));
    assert!(mean_luma(&hz) < mean_luma(&win));
}
