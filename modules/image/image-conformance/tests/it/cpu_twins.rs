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

//! The shipped CPU twins (`image_kernels::cpu`, ADR 465) held to the
//! same tolerance as the GPU.
//!
//! - Every covered kernel against its test-only scalar reference
//!   (`family_adjust.rs`, `family_conv.rs`) over the same stimulus, within
//!   the kernel's declared `gpu_tolerance`. No device needed: these run
//!   in every lane.
//! - Every covered kernel against the shader on a device (the GPU lanes).
//! - The region filter's two lanes (`image_js::region_filter`) against
//!   each other on a device, and the CPU lane's own properties without
//!   one.

use image_conformance::harness::{assert_within, parity, ParityResult, RefTile};
use image_conformance::quantize::{f16_ulp_distance, f32_to_f16_bits};
use image_conformance::Px;
use image_js::ingest::AdjustParams;
use image_js::region_filter::{filter_region_cpu, filter_region_gpu, PixelRect};
use image_kernels::cpu::{self, CPU_KERNELS};
use image_kernels::families::adjust::*;
use image_kernels::families::conv::{
    ConvGaussianParams, ConvUnsharpParams, CONV_GAUSSIAN_H, CONV_GAUSSIAN_V, CONV_UNSHARP,
    GAUSSIAN_MAX_RADIUS,
};
use image_kernels::KernelDef;

use crate::family_adjust::*;
use crate::family_conv::{
    gauss_window, gaussian_h_ref, gaussian_v_ref, unsharp_inputs, unsharp_ref,
};

const TILE: u32 = 64;
const R24: i32 = GAUSSIAN_MAX_RADIUS as i32;

/// A windowed reference: (window, its width and height, output x, y, params).
type GaussRef = fn(&[Px], u32, u32, u32, u32, &ConvGaussianParams) -> Px;

/// The CPU lane against the reference over the same f16-quantized
/// stimulus, measured as the GPU parity harness measures.
fn cpu_vs_ref(want: impl Fn(usize) -> Px, got: impl Fn(usize) -> Px, n: usize) -> ParityResult {
    let mut max_ulp = 0;
    let mut worst_at = (0, 0);
    for i in 0..n {
        let (w, g) = (want(i), got(i));
        for c in 0..4 {
            let d = f16_ulp_distance(f32_to_f16_bits(w.0[c]), f32_to_f16_bits(g.0[c]));
            if d > max_ulp {
                max_ulp = d;
                worst_at = (i, c);
            }
        }
    }
    ParityResult {
        max_ulp,
        worst_at,
        mean_delta_e: 0.0,
    }
}

/// One point kernel: CPU twin against the reference (always), and
/// against the shader (on a device).
fn point_case<P: bytemuck::Pod>(
    def: &'static KernelDef,
    reference: impl Fn(Px, Px, &P) -> Px,
    twin: impl Fn(Px, &P) -> Px,
    tile: &RefTile,
    p: &P,
) {
    assert!(
        CPU_KERNELS.iter().any(|d| d.id == def.id),
        "{} has no shipped CPU twin",
        def.id
    );
    let q = tile.quantized_px();
    let r = cpu_vs_ref(|i| reference(q[i], q[i], p), |i| twin(q[i], p), q.len());
    eprintln!("{}: CPU vs reference, max f16 ULP {}", def.id, r.max_ulp);
    assert_within(r, def);
    if let Some(r) = parity(def, |a, _b, p: &P| twin(a, p), &[tile], p) {
        eprintln!("{}: CPU vs GPU, max f16 ULP {}", def.id, r.max_ulp);
        assert_within(r, def);
    }
}

#[test]
#[allow(non_snake_case)]
fn every_point_twin_is_within_tolerance__feat__image_editor_region_filter() {
    let t = premul_tile(TILE, TILE);
    let t2 = premul_tile_pow2(TILE, TILE);
    point_case(
        &ADJUST_EXPOSURE,
        exposure_ref,
        cpu::exposure,
        &t,
        &AdjustExposureParams::new(0.8),
    );
    point_case(
        &ADJUST_EXPOSURE,
        exposure_ref,
        cpu::exposure,
        &t,
        &AdjustExposureParams::encoded(-0.6),
    );
    point_case(
        &ADJUST_WHITE_BALANCE,
        white_balance_ref,
        cpu::white_balance,
        &t,
        &AdjustWhiteBalanceParams::new(0.15, -0.08),
    );
    point_case(
        &ADJUST_LEVELS,
        levels_ref,
        cpu::levels,
        &t,
        &AdjustLevelsParams::new(0.05, 0.95, 1.4, 0.0, 1.0),
    );
    point_case(
        &ADJUST_LEVELS_RGB,
        levels_rgb_ref,
        cpu::levels_rgb,
        &t,
        &AdjustLevelsRgbParams::new([0.05, 0.9, 1.2], [0.0, 1.0, 0.8], [0.1, 0.95, 1.0]),
    );
    point_case(
        &ADJUST_BRIGHTNESS_CONTRAST,
        brightness_contrast_ref,
        cpu::brightness_contrast,
        &t,
        &AdjustBrightnessContrastParams::new(0.1, 1.3),
    );
    point_case(
        &ADJUST_COLOR_BALANCE,
        color_balance_ref,
        cpu::color_balance,
        &t,
        &AdjustColorBalanceParams::new([0.1, -0.05, 0.0], [0.0, 0.08, -0.1], [-0.06, 0.0, 0.12]),
    );
    point_case(
        &ADJUST_PHOTO_FILTER,
        photo_filter_ref,
        cpu::photo_filter,
        &t,
        &AdjustPhotoFilterParams::new([0.93, 0.55, 0.1], 0.4, true),
    );
    point_case(
        &ADJUST_CHANNEL_MIXER,
        channel_mixer_ref,
        cpu::channel_mixer,
        &t,
        &AdjustChannelMixerParams::new(
            [0.8, 0.2, 0.0, 0.0],
            [0.1, 0.9, 0.0, 0.02],
            [0.0, 0.3, 0.7, -0.01],
        ),
    );
    point_case(
        &ADJUST_VIBRANCE,
        vibrance_ref,
        cpu::vibrance,
        &t,
        &AdjustVibranceParams::new(0.6, 0.15),
    );
    point_case(
        &ADJUST_SATURATION,
        saturation_ref,
        cpu::saturation,
        &t,
        &AdjustSaturationParams::new(1.6),
    );
    point_case(
        &ADJUST_BLACK_WHITE,
        black_white_ref,
        cpu::black_white,
        &t,
        &AdjustBlackWhiteParams::new(0.4, 0.6, 0.4, 0.6, 0.2, 0.8),
    );
    point_case(
        &ADJUST_POSTERIZE,
        posterize_ref,
        cpu::posterize,
        &t2,
        &AdjustPosterizeParams::new(5.0),
    );
    point_case(
        &ADJUST_THRESHOLD,
        threshold_ref,
        cpu::threshold,
        &t2,
        &AdjustThresholdParams::new(0.45),
    );
    point_case(
        &ADJUST_HUE_ROTATE,
        hue_rotate_ref,
        cpu::hue_rotate,
        &t,
        &AdjustHueRotateParams::new(35.0),
    );
    point_case(
        &ADJUST_HUE_SATURATION,
        hue_saturation_ref,
        cpu::hue_saturation,
        &t,
        &hue_sat_master_and_ranges(),
    );
    point_case(
        &ADJUST_HUE_SATURATION,
        hue_saturation_ref,
        cpu::hue_saturation,
        &t,
        &hue_sat_colorize(),
    );
    point_case(
        &ADJUST_INVERT_RGB,
        adjust_invert_rgb,
        |a, _p: &AdjustInvertRgbParams| cpu::invert_rgb(a),
        &t,
        &AdjustInvertRgbParams::new(),
    );
}

#[test]
#[allow(non_snake_case)]
fn the_unsharp_twin_is_within_tolerance__feat__image_editor_region_filter() {
    let (a, b) = unsharp_inputs(TILE, TILE);
    let (qa, qb) = (a.quantized_px(), b.quantized_px());
    for p in [
        ConvUnsharpParams::new(0.8, 0.0),
        ConvUnsharpParams::new(1.5, 0.05),
    ] {
        let r = cpu_vs_ref(
            |i| unsharp_ref(qa[i], qb[i], &p),
            |i| cpu::unsharp(qa[i], qb[i], &p),
            qa.len(),
        );
        assert_within(r, &CONV_UNSHARP);
        if let Some(r) = parity(&CONV_UNSHARP, cpu::unsharp, &[&a, &b], &p) {
            assert_within(r, &CONV_UNSHARP);
        }
    }
}

/// Both Gaussian passes over the conformance window: the twin reads the
/// same texels the shader's fixed `out + 2·24` window holds.
#[test]
#[allow(non_snake_case)]
fn the_gaussian_twins_are_within_tolerance__feat__image_editor_region_filter() {
    let (w, h) = (48u32, 40u32);
    for p in [
        ConvGaussianParams::new(3.0, 8),
        ConvGaussianParams::new(7.5, u32::from(GAUSSIAN_MAX_RADIUS)),
        ConvGaussianParams::new(1.5, 5),
    ] {
        let weights = cpu::gaussian_weights(&p);
        for horizontal in [true, false] {
            let (ww, wh) = if horizontal {
                (w + 2 * R24 as u32, h)
            } else {
                (w, h + 2 * R24 as u32)
            };
            let win = gauss_window(ww, wh);
            let q = win.quantized_px();
            let (def, reference): (_, GaussRef) = if horizontal {
                (&CONV_GAUSSIAN_H, gaussian_h_ref)
            } else {
                (&CONV_GAUSSIAN_V, gaussian_v_ref)
            };
            let twin = |ox: u32, oy: u32| {
                cpu::gaussian_axis(
                    |i| {
                        let (x, y) = if horizontal {
                            (ox as i32 + R24 + i, oy as i32)
                        } else {
                            (ox as i32, oy as i32 + R24 + i)
                        };
                        q[(y as u32 * ww + x as u32) as usize]
                    },
                    &weights,
                )
            };
            let at = |i: usize| ((i as u32) % w, (i as u32) / w);
            let r = cpu_vs_ref(
                |i| {
                    let (ox, oy) = at(i);
                    reference(&q, ww, wh, ox, oy, &p)
                },
                |i| {
                    let (ox, oy) = at(i);
                    twin(ox, oy)
                },
                (w * h) as usize,
            );
            eprintln!("{}: CPU vs reference, max f16 ULP {}", def.id, r.max_ulp);
            assert_within(r, def);
            if let Some(r) = image_conformance::harness::parity_windowed(
                def,
                |_win, _ww, _wh, ox, oy, _p| twin(ox, oy),
                &win,
                w,
                h,
                &p,
            ) {
                eprintln!("{}: CPU vs GPU, max f16 ULP {}", def.id, r.max_ulp);
                assert_within(r, def);
            }
        }
    }
}

/// Every kernel the chain can dispatch has a twin, and nothing else does.
#[test]
#[allow(non_snake_case)]
fn the_twin_list_is_the_chain__feat__image_editor_region_filter() {
    let mut ids: Vec<&str> = CPU_KERNELS.iter().map(|d| d.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), CPU_KERNELS.len(), "a kernel listed twice");
    for id in &ids {
        assert!(
            image_kernels::lookup(id).is_some(),
            "{id} is not registered"
        );
    }
    assert_eq!(ids.len(), 19);
}

// ─────────────────────────── the region filter ───────────────────────────

/// A W×H straight-RGBA8 test image: gradients, some texture, an alpha
/// ramp in one corner.
fn image(w: u32, h: u32) -> Vec<u8> {
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            px.push(((x * 255) / w.max(1)) as u8);
            px.push(((y * 255) / h.max(1)) as u8);
            px.push((((x * 7 + y * 13) % 64) * 4) as u8);
            px.push(if x < 6 && y < 6 {
                128 + (x * 20) as u8
            } else {
                255
            });
        }
    }
    px
}

fn chain() -> AdjustParams {
    let mut p = AdjustParams {
        exposure_ev: 0.4,
        contrast: 1.2,
        saturation: 1.3,
        hue_degrees: 20.0,
        blur_sigma: 2.0,
        sharpen_amount: 0.7,
        vibrance: 0.3,
        posterize: None,
        ..AdjustParams::default()
    };
    p.hue_sat.master = [10.0, 0.1, 0.0, 0.0];
    p.curve_lut = Some(std::array::from_fn(|i| (255 - i) as u8));
    p
}

/// The CPU lane leaves everything outside the region as it was, and an
/// identity chain changes nothing.
#[test]
#[allow(non_snake_case)]
fn the_cpu_region_filter_touches_only_its_region__feat__image_editor_region_filter() {
    let (w, h) = (40u32, 30u32);
    let src = image(w, h);
    let rect = PixelRect {
        x: 5,
        y: 4,
        w: 20,
        h: 15,
    };
    let mut out = src.clone();
    filter_region_cpu(w, h, &mut out, &chain(), rect).unwrap();
    let mut changed = 0;
    for y in 0..h {
        for x in 0..w {
            let o = ((y * w + x) * 4) as usize;
            let inside = (5..25).contains(&x) && (4..19).contains(&y);
            if !inside {
                assert_eq!(&out[o..o + 4], &src[o..o + 4], "({x}, {y}) is outside");
            } else if out[o..o + 4] != src[o..o + 4] {
                changed += 1;
            }
        }
    }
    assert!(changed > 250, "the region was filtered ({changed} changed)");

    let mut same = src.clone();
    filter_region_cpu(w, h, &mut same, &AdjustParams::default(), rect).unwrap();
    assert_eq!(same, src);

    // A blur of a constant image is that constant, edges included (the
    // window repeats the image's edge pixel).
    let flat = vec![90u8; (w * h * 4) as usize];
    let mut blurred = flat.clone();
    let all = PixelRect { x: 0, y: 0, w, h };
    let p = AdjustParams {
        blur_sigma: 4.0,
        ..AdjustParams::default()
    };
    filter_region_cpu(w, h, &mut blurred, &p, all).unwrap();
    assert_eq!(blurred, flat);

    let err = filter_region_cpu(
        w,
        h,
        &mut out,
        &chain(),
        PixelRect {
            x: 30,
            y: 0,
            w: 20,
            h: 5,
        },
    );
    assert!(err.unwrap_err().contains("inside the 40×30 image"));
}

/// The two lanes agree: the CPU region filter against the GPU pipeline
/// with the same rectangle as its selection, every channel within one
/// level after the 8-bit round (the per-kernel f16 tolerances, compounded
/// over the chain, stay below half a level).
#[test]
#[allow(non_snake_case)]
fn the_cpu_and_gpu_region_filters_agree__feat__image_editor_region_filter() {
    let Some(ctx) = image_conformance::device::test_device() else {
        return;
    };
    let (w, h) = (300u32, 270u32);
    let src = image(w, h);
    for (params, rect) in [
        (
            chain(),
            PixelRect {
                x: 20,
                y: 260,
                w: 280,
                h: 10,
            },
        ),
        (
            AdjustParams {
                blur_sigma: 6.0,
                ..AdjustParams::default()
            },
            PixelRect {
                x: 0,
                y: 0,
                w: 300,
                h: 270,
            },
        ),
        (
            AdjustParams {
                sharpen_amount: 1.2,
                invert: true,
                threshold: Some(0.5),
                ..AdjustParams::default()
            },
            PixelRect {
                x: 100,
                y: 40,
                w: 37,
                h: 200,
            },
        ),
    ] {
        let mut cpu_out = src.clone();
        filter_region_cpu(w, h, &mut cpu_out, &params, rect).unwrap();
        let mut gpu_out = src.clone();
        pollster::block_on(filter_region_gpu(ctx, w, h, &mut gpu_out, &params, rect)).unwrap();
        let worst = cpu_out
            .iter()
            .zip(&gpu_out)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(worst <= 1, "CPU and GPU lanes differ by {worst} levels");
    }
}
