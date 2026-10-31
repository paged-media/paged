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

//! gpu↔ref parity of the `style.*` kernels (layer styles, WP5.4): each
//! WGSL module dispatched over a whole canvas through `GpuBatch` (the way
//! the layer fold runs it) against its scalar twin
//! (`image_kernels::families::style::reference`) on the same f16 inputs,
//! held to the kernel's declared tolerance in f16 ULPs — or within 1e-4
//! absolute, where a value near zero spans many ULPs. Plus the distance
//! field as a whole against the exact Euclidean distance of a disc.
//!
//! Fails without an adapter under `PAGED_REQUIRE_GPU=1`, reports
//! `unavailable: GPU adapter` otherwise.
#![allow(non_snake_case)]

use half::f16;
use image_conformance::device::test_device;
use image_gpu::{GpuBatch, TexFormat};
use image_kernels::families::style::reference as r;
use image_kernels::families::style::*;
use image_kernels::{KernelDef, Tolerance};

const W: u32 = 48;
const H: u32 = 40;

fn q(v: f32) -> f32 {
    f16::from_f32(v).to_f32()
}

fn quant(img: &[[f32; 4]]) -> Vec<[f32; 4]> {
    img.iter().map(|p| p.map(q)).collect()
}

fn bytes(img: &[[f32; 4]]) -> Vec<u8> {
    img.iter()
        .flat_map(|p| p.iter().flat_map(|v| f16::from_f32(*v).to_le_bytes()))
        .collect()
}

/// One dispatch of `def` over `inputs` on the test device.
fn gpu(def: &'static KernelDef, inputs: &[&[[f32; 4]]], params: &[u8]) -> Option<Vec<[f32; 4]>> {
    let ctx = test_device()?;
    let mut b = GpuBatch::new(ctx);
    let tex: Vec<_> = inputs
        .iter()
        .map(|i| b.upload(W, H, TexFormat::Rgba16Float, &bytes(i)))
        .collect();
    let refs: Vec<_> = tex.iter().collect();
    let out = b.target(W, H);
    b.dispatch(def, &refs, params, None, &out)
        .expect("dispatch");
    let t = b.read(&out);
    let reads = b.finish().expect("finish");
    Some(
        reads[t.0]
            .as_chunks::<8>()
            .0
            .iter()
            .map(|c| std::array::from_fn(|k| f16::from_le_bytes([c[2 * k], c[2 * k + 1]]).to_f32()))
            .collect(),
    )
}

fn check(def: &KernelDef, got: &[[f32; 4]], want: &[[f32; 4]]) {
    let limit = match def.gpu_tolerance {
        Tolerance::Exact => 0,
        Tolerance::ChannelEpsF16(n) => n,
        Tolerance::PerceptualDeltaE(_) => unreachable!("coverage kernels"),
    };
    let mut worst = 0u32;
    for (k, (g, w)) in got.iter().zip(want).enumerate() {
        for c in 0..4 {
            let (a, b) = (f16::from_f32(g[c]), f16::from_f32(w[c]));
            if (a.to_f32() - b.to_f32()).abs() < 1e-4 && limit > 0 {
                continue;
            }
            let ulp = image_conformance::quantize::f16_ulp_distance(a.to_bits(), b.to_bits());
            worst = worst.max(ulp);
            assert!(
                ulp <= limit,
                "{}: texel {k} channel {c}: gpu {} ref {} ({ulp} ULP > {limit})",
                def.id,
                g[c],
                w[c]
            );
        }
    }
    eprintln!("{}: max f16 ULP {worst}", def.id);
}

/// A soft disc of coverage (alpha and red both), on a ramp elsewhere.
fn disc() -> Vec<[f32; 4]> {
    quant(
        &(0..W * H)
            .map(|i| {
                let (x, y) = ((i % W) as f32 + 0.5, (i / W) as f32 + 0.5);
                let d = ((x - 20.0).powi(2) + (y - 18.0).powi(2)).sqrt();
                let a = (12.5 - d).clamp(0.0, 1.0);
                [a, x / W as f32, y / H as f32, a]
            })
            .collect::<Vec<_>>(),
    )
}

#[test]
fn style_shift_parity__feat__image_layers_styles() {
    let img = disc();
    for p in [
        StyleShiftParams::new(3.0, -2.0, 3, false, 0.0),
        StyleShiftParams::new(-4.25, 1.5, 3, true, 1.0),
        StyleShiftParams::new(0.5, 0.5, 1, false, 0.0),
    ] {
        let Some(got) = gpu(&STYLE_SHIFT, &[&img], p.as_bytes()) else {
            return;
        };
        check(&STYLE_SHIFT, &got, &r::shift(&img, W, H, &p));
    }
}

#[test]
fn style_blur_parity__feat__image_layers_styles() {
    let img = disc();
    for p in [
        StyleBlurParams::new(2.0, 6, 0.0),
        StyleBlurParams::new(5.5, 17, 1.0),
        StyleBlurParams::new(0.0, 4, 0.0),
        StyleBlurParams::boxed(3.6, 0.0),
        StyleBlurParams::boxed(7.0, 1.0),
        StyleBlurParams::new(3.0, 9, -1.0),
    ] {
        let Some(h) = gpu(&STYLE_BLUR_H, &[&img], p.as_bytes()) else {
            return;
        };
        check(&STYLE_BLUR_H, &h, &r::blur(&img, W, H, &p, false));
        let hq = quant(&h);
        let Some(v) = gpu(&STYLE_BLUR_V, &[&hq], p.as_bytes()) else {
            return;
        };
        check(&STYLE_BLUR_V, &v, &r::blur(&hq, W, H, &p, true));
    }
}

/// Seed, flood (steps 32 … 1, then 1 again) and combine — each pass
/// exact against its twin, the field within a texel of the true distance.
#[test]
fn style_distance_field_parity__feat__image_layers_styles() {
    let img = disc();
    let seed = StyleJfaSeedParams::new(0.5);
    let Some(mut field) = gpu(&STYLE_JFA_SEED, &[&img], seed.as_bytes()) else {
        return;
    };
    check(&STYLE_JFA_SEED, &field, &r::jfa_seed(&img, &seed));
    for step in [32, 16, 8, 4, 2, 1, 1] {
        let p = StyleJfaStepParams::new(step);
        let Some(next) = gpu(&STYLE_JFA_STEP, &[&field], p.as_bytes()) else {
            return;
        };
        check(&STYLE_JFA_STEP, &next, &r::jfa_step(&field, W, H, &p));
        field = next;
    }
    let p = StyleDistanceParams::new();
    let Some(sd) = gpu(&STYLE_DISTANCE, &[&field, &img], p.as_bytes()) else {
        return;
    };
    check(&STYLE_DISTANCE, &sd, &r::distance(&field, &img, W, H));
    // Against the truth: the disc's edge is at radius 12.5.
    for (i, v) in sd.iter().enumerate() {
        let (x, y) = ((i as u32 % W) as f32 + 0.5, (i as u32 / W) as f32 + 0.5);
        let truth = ((x - 20.0).powi(2) + (y - 18.0).powi(2)).sqrt() - 12.5;
        assert!(
            (v[0] - truth).abs() <= 1.0,
            "texel {i}: {} vs {truth}",
            v[0]
        );
    }
}

#[test]
fn style_ramp_contour_colorize_parity__feat__image_layers_styles() {
    let sd = quant(
        &(0..W * H)
            .map(|i| [(i % W) as f32 * 0.5 - 8.0, 0.0, 0.0, 1.0])
            .collect::<Vec<_>>(),
    );
    for p in [
        StyleRampParams::band(0.0, 3.0),
        StyleRampParams::band(-2.5, 2.5),
        StyleRampParams::falloff(-1.0, 6.0),
    ] {
        let Some(got) = gpu(&STYLE_RAMP, &[&sd], p.as_bytes()) else {
            return;
        };
        check(&STYLE_RAMP, &got, &r::ramp(&sd, &p));
    }
    let img = disc();
    let cone: [f32; 256] = std::array::from_fn(|i| 1.0 - (i as f32 / 127.5 - 1.0).abs());
    for p in [
        StyleContourParams::new(&cone, 0.0, 1.0, false, 3),
        StyleContourParams::new(&cone, 0.25, 0.75, true, 1),
        StyleContourParams::identity(true, 0),
    ] {
        let Some(got) = gpu(&STYLE_CONTOUR, &[&img], p.as_bytes()) else {
            return;
        };
        check(&STYLE_CONTOUR, &got, &r::contour(&img, &p));
    }
    let grad: [[f32; 4]; 256] = std::array::from_fn(|i| {
        let t = i as f32 / 255.0;
        [t, 0.2, 1.0 - t, 1.0 - 0.5 * t]
    });
    for p in [
        StyleColorizeParams::solid([0.1, 0.4, 0.9], 3, 0.0, 0),
        StyleColorizeParams::solid([1.0, 1.0, 0.0], 3, 0.4, 7),
        StyleColorizeParams::new(grad, COLORIZE_COVERAGE, 3, 0.0, 0.3, 11),
        StyleColorizeParams::new(grad, COLORIZE_LOOKUP, 1, 0.0, 0.0, 0),
        StyleColorizeParams::new(grad, COLORIZE_GLOW_GRADIENT, 3, 0.0, 0.2, 5),
    ] {
        let Some(got) = gpu(&STYLE_COLORIZE, &[&img], p.as_bytes()) else {
            return;
        };
        check(&STYLE_COLORIZE, &got, &r::colorize(&img, W, &p));
    }
}

#[test]
fn style_bevel_split_absdiff_parity__feat__image_layers_styles() {
    let img = disc();
    for p in [
        StyleBevelParams::new(4.0, 120.0, 30.0),
        StyleBevelParams::new(20.0, 30.0, 65.0),
    ] {
        let Some(got) = gpu(&STYLE_BEVEL, &[&img], p.as_bytes()) else {
            return;
        };
        check(&STYLE_BEVEL, &got, &r::bevel(&img, W, H, &p));
    }
    let shade = quant(
        &(0..W * H)
            .map(|i| [(i % W) as f32 / W as f32; 4])
            .collect::<Vec<_>>(),
    );
    let p = StyleSplitParams::new(0.5);
    let Some(got) = gpu(&STYLE_SPLIT, &[&shade], p.as_bytes()) else {
        return;
    };
    check(&STYLE_SPLIT, &got, &r::split(&shade, &p));
    let p = StyleAbsDiffParams::new();
    let Some(got) = gpu(&STYLE_ABSDIFF, &[&img, &shade], p.as_bytes()) else {
        return;
    };
    check(&STYLE_ABSDIFF, &got, &r::absdiff(&img, &shade));
}
