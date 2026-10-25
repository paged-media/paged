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

//! The CPU resample (`paged_resample`, ADR 467) against the GPU kernels it
//! stands in for headless: `resample.lanczos3` for a resize and
//! `geom.rotate_bilinear` (through `image_js::ingest::straighten_crop_rgba8`)
//! for a straightened crop, on a device (the GPU lanes; without one the
//! tests report `unavailable` and return).
//!
//! The tolerance ADR 467 states is the one held here: on an opaque picture
//! the two backends agree within one 8-bit level per channel (the GPU
//! carries f16 working values, the CPU f32 with f64 weights; both sample
//! the same points). Where translucent pixels are filtered the results
//! differ by design — the CPU filters premultiplied, the GPU kernels
//! straight — so a translucent picture is measured and printed, not
//! bounded (the difference reaches opaque output pixels whose footprint
//! holds translucent ones, too).

use half::f16;
use image_js::ingest::{straighten_crop_rgba8, DecodedImage};
use image_kernels::families::resample::{ResampleParams, RESAMPLE_LANCZOS3};
use paged_resample::{resize_rgba8, rotate_crop_rgba8, Filter, Rect};

/// A smooth gradient with a sharp-edged disc and a little noise: edges for
/// Lanczos to ring on, flat areas, and every channel moving.
fn picture(w: u32, h: u32, opaque: bool) -> Vec<u8> {
    let mut state = 0x9e37_79b9_u32;
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let n = (state >> 28) as i32 - 8;
            let (cx, cy) = (x as i32 - w as i32 / 3, y as i32 - h as i32 / 2);
            let disc = cx * cx + cy * cy < (h as i32 / 4).pow(2);
            let r = if disc { 230 } else { (x * 255 / w) as i32 };
            let g = if disc { 40 } else { (y * 255 / h) as i32 };
            let b = ((x + y) * 255 / (w + h)) as i32;
            let a = if opaque {
                255
            } else {
                ((x * 7 + y * 3) % 256) as i32
            };
            for v in [r + n, g - n, b + n, a] {
                px.push(v.clamp(0, 255) as u8);
            }
        }
    }
    px
}

fn to_f16(rgba: &[u8]) -> Vec<u8> {
    rgba.iter()
        .flat_map(|&b| f16::from_f32(b as f32 / 255.0).to_le_bytes())
        .collect()
}

fn from_f16(bytes: &[u8]) -> Vec<u8> {
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&p| (f16::from_le_bytes(p).to_f32().clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

fn gpu_resize(
    ctx: &image_gpu::GpuContext,
    src: &[u8],
    w: u32,
    h: u32,
    ow: u32,
    oh: u32,
) -> Vec<u8> {
    let params = ResampleParams::new(w as f32 / ow as f32, h as f32 / oh as f32, 0.0, 0.0);
    let out = image_gpu::execute_windowed_once(
        ctx,
        &RESAMPLE_LANCZOS3,
        &to_f16(src),
        w,
        h,
        params.as_bytes(),
        None,
        ow,
        oh,
    )
    .expect("GPU resize");
    from_f16(&out)
}

/// The worst channel difference over pixels both results hold opaque, and
/// over all the rest.
fn worst(a: &[u8], b: &[u8]) -> (u8, u8) {
    let (mut opaque, mut other) = (0u8, 0u8);
    for (p, q) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0) {
        let d = p.iter().zip(q).map(|(x, y)| x.abs_diff(*y)).max().unwrap();
        if p[3] == 255 && q[3] == 255 {
            opaque = opaque.max(d);
        } else {
            other = other.max(d);
        }
    }
    (opaque, other)
}

#[test]
#[allow(non_snake_case)]
fn the_cpu_resize_agrees_with_the_gpu_lanczos_kernel__feat__image_actions_cpu_resample() {
    let Some(ctx) = image_conformance::device::test_device() else {
        return;
    };
    let (w, h) = (240u32, 160u32);
    for opaque in [true, false] {
        let src = picture(w, h, opaque);
        // Down 1.5×, 3.7× and 12× (under the GPU's 16× filter cap), up
        // 2.3×, and a mixed one.
        for (ow, oh) in [(160, 107), (65, 43), (20, 13), (552, 368), (300, 90)] {
            let cpu = resize_rgba8(&src, w, h, ow, oh, Filter::Lanczos3).unwrap();
            let gpu = gpu_resize(ctx, &src, w, h, ow, oh);
            let (o, t) = worst(&cpu, &gpu);
            println!(
                "lanczos3 {w}×{h} → {ow}×{oh} (opaque {opaque}): worst {o} opaque, {t} translucent"
            );
            if opaque {
                assert!(o <= 1, "opaque pixels differ by {o} levels at {ow}×{oh}");
            }
        }
    }
}

#[test]
#[allow(non_snake_case)]
fn the_cpu_straightened_crop_agrees_with_the_gpu_rotation__feat__image_actions_cpu_resample() {
    let Some(ctx) = image_conformance::device::test_device() else {
        return;
    };
    let (w, h) = (200u32, 140u32);
    for opaque in [true, false] {
        let src = picture(w, h, opaque);
        let img = DecodedImage::from_rgba8(w, h, src.clone()).unwrap();
        for (rect, deg) in [
            (
                Rect {
                    x: 30,
                    y: 20,
                    w: 140,
                    h: 100,
                },
                4.5f32,
            ),
            (
                Rect {
                    x: 0,
                    y: 0,
                    w: 200,
                    h: 140,
                },
                -12.0,
            ),
            (
                Rect {
                    x: 51,
                    y: 33,
                    w: 77,
                    h: 61,
                },
                33.3,
            ),
        ] {
            let cpu = rotate_crop_rgba8(&src, w, h, rect, deg as f64).unwrap();
            let gpu = pollster::block_on(straighten_crop_rgba8(
                ctx, &img, rect.x, rect.y, rect.w, rect.h, deg,
            ))
            .unwrap();
            let gpu = gpu.rgba.to_rgba8();
            let (o, t) = worst(&cpu, &gpu);
            println!("rotate {deg}° {rect:?} (opaque {opaque}): worst {o} opaque, {t} translucent");
            if opaque {
                assert!(o <= 1, "opaque pixels differ by {o} levels at {deg}°");
            }
        }
    }
}
