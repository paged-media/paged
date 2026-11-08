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

//! The blurs this module replaced, kept verbatim as the oracle: the new
//! functions must equal them byte for byte on every input (engine ADR 1013,
//! amendment "Blur"). `paged-gpu/src/blur.rs` held the Gaussian variants and
//! the SVG box pass, `paged-compose/src/mask.rs` the mask's box passes,
//! `image-gpu/src/coverage.rs` the selection feather.

use super::*;

mod old {
    /// Separable Gaussian over a premultiplied RGBA8 buffer, edges clamped
    /// (the caller pads by 3σ, so the clamp reads the empty margin).
    pub fn gaussian_blur_premul(data: &mut [u8], width: u32, height: u32, kernel: &[f32]) {
        if kernel.len() < 2 || width == 0 || height == 0 {
            return;
        }
        let (w, h) = (width as usize, height as usize);
        let radius = (kernel.len() / 2) as isize;
        let mut tmp = vec![0u8; data.len()];
        for y in 0..h {
            let row = y * w * 4;
            for x in 0..w {
                let mut acc = [0.0f32; 4];
                for (k, &coeff) in kernel.iter().enumerate() {
                    let sx = (x as isize + k as isize - radius).clamp(0, w as isize - 1) as usize;
                    let p = row + sx * 4;
                    for c in 0..4 {
                        acc[c] += data[p + c] as f32 * coeff;
                    }
                }
                let q = row + x * 4;
                for c in 0..4 {
                    tmp[q + c] = acc[c].round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0.0f32; 4];
                for (k, &coeff) in kernel.iter().enumerate() {
                    let sy = (y as isize + k as isize - radius).clamp(0, h as isize - 1) as usize;
                    let p = (sy * w + x) * 4;
                    for c in 0..4 {
                        acc[c] += tmp[p + c] as f32 * coeff;
                    }
                }
                let q = (y * w + x) * 4;
                for c in 0..4 {
                    data[q + c] = acc[c].round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }

    /// Separable Gaussian over a single-channel mask, edges clamped.
    pub fn gaussian_blur_mask(mask: &mut [u8], width: u32, height: u32, kernel: &[f32]) {
        if kernel.len() < 2 || width == 0 || height == 0 {
            return;
        }
        let (w, h) = (width as usize, height as usize);
        let radius = (kernel.len() / 2) as isize;
        let mut tmp = vec![0u8; mask.len()];
        for y in 0..h {
            let row = y * w;
            for x in 0..w {
                let mut acc = 0.0f32;
                for (k, &coeff) in kernel.iter().enumerate() {
                    let sx = (x as isize + k as isize - radius).clamp(0, w as isize - 1) as usize;
                    acc += mask[row + sx] as f32 * coeff;
                }
                tmp[row + x] = acc.round().clamp(0.0, 255.0) as u8;
            }
        }
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0f32;
                for (k, &coeff) in kernel.iter().enumerate() {
                    let sy = (y as isize + k as isize - radius).clamp(0, h as isize - 1) as usize;
                    acc += tmp[sy * w + x] as f32 * coeff;
                }
                mask[y * w + x] = acc.round().clamp(0.0, 255.0) as u8;
            }
        }
    }

    /// Separable Gaussian over a premultiplied RGBA8 buffer, a kernel per
    /// axis (`None` leaves that axis alone), reading transparent black
    /// outside the buffer.
    pub fn gaussian_blur_premul_xy(
        data: &mut [u8],
        width: u32,
        height: u32,
        kx: Option<&[f32]>,
        ky: Option<&[f32]>,
    ) {
        let (w, h) = (width as usize, height as usize);
        if w == 0 || h == 0 {
            return;
        }
        let mut tmp = vec![0u8; data.len()];
        if let Some(kernel) = kx.filter(|k| k.len() > 1) {
            let radius = (kernel.len() / 2) as isize;
            for y in 0..h {
                let row = y * w;
                for x in 0..w {
                    let mut acc = [0.0f32; 4];
                    for (k, &coeff) in kernel.iter().enumerate() {
                        let sx = x as isize + k as isize - radius;
                        if sx < 0 || sx >= w as isize {
                            continue;
                        }
                        let p = (row + sx as usize) * 4;
                        for c in 0..4 {
                            acc[c] += data[p + c] as f32 * coeff;
                        }
                    }
                    let q = (row + x) * 4;
                    for c in 0..4 {
                        tmp[q + c] = acc[c].round().clamp(0.0, 255.0) as u8;
                    }
                }
            }
            data.copy_from_slice(&tmp);
        }
        if let Some(kernel) = ky.filter(|k| k.len() > 1) {
            let radius = (kernel.len() / 2) as isize;
            for y in 0..h {
                for x in 0..w {
                    let mut acc = [0.0f32; 4];
                    for (k, &coeff) in kernel.iter().enumerate() {
                        let sy = y as isize + k as isize - radius;
                        if sy < 0 || sy >= h as isize {
                            continue;
                        }
                        let p = (sy as usize * w + x) * 4;
                        for c in 0..4 {
                            acc[c] += data[p + c] as f32 * coeff;
                        }
                    }
                    let q = (y * w + x) * 4;
                    for c in 0..4 {
                        tmp[q + c] = acc[c].round().clamp(0.0, 255.0) as u8;
                    }
                }
            }
            data.copy_from_slice(&tmp);
        }
    }
    /// is the rounded mean of the `left + 1 + right` input pixels around
    /// it, transparent beyond the buffer.
    pub fn box_pass(
        src: &[u8],
        dst: &mut [u8],
        w: usize,
        h: usize,
        horizontal: bool,
        reach: (usize, usize),
    ) {
        let (lines, len, step, stride) = if horizontal {
            (h, w, 4, w * 4)
        } else {
            (w, h, w * 4, 4)
        };
        let (left, right) = reach;
        let d = (left + right + 1) as u32;
        for line in 0..lines {
            let base = line * stride;
            let at = |i: usize| base + i * step;
            let mut sum = [0u32; 4];
            for i in 0..right.min(len) {
                for c in 0..4 {
                    sum[c] += src[at(i) + c] as u32;
                }
            }
            for i in 0..len {
                if i + right < len {
                    let p = at(i + right);
                    for c in 0..4 {
                        sum[c] += src[p + c] as u32;
                    }
                }
                let q = at(i);
                for c in 0..4 {
                    dst[q + c] = ((sum[c] + d / 2) / d) as u8;
                }
                if i >= left {
                    let p = at(i - left);
                    for c in 0..4 {
                        sum[c] -= src[p + c] as u32;
                    }
                }
            }
        }
    }

    pub fn box_blur_h(buf: &mut [u8], w: u32, h: u32, r: i32) {
        let w = w as i32;
        let h = h as i32;
        let norm = (2 * r + 1) as u32;
        let mut row = vec![0u8; w as usize];
        for y in 0..h {
            let base = (y * w) as usize;
            let mut acc: u32 = 0;
            for i in -r..=r {
                acc += buf[base + i.clamp(0, w - 1) as usize] as u32;
            }
            for x in 0..w {
                row[x as usize] = (acc / norm) as u8;
                let add = (x + r + 1).clamp(0, w - 1);
                let sub = (x - r).clamp(0, w - 1);
                acc += buf[base + add as usize] as u32;
                acc -= buf[base + sub as usize] as u32;
            }
            buf[base..base + w as usize].copy_from_slice(&row);
        }
    }

    pub fn box_blur_v(buf: &mut [u8], w: u32, h: u32, r: i32) {
        let w = w as i32;
        let h = h as i32;
        let norm = (2 * r + 1) as u32;
        let mut col = vec![0u8; h as usize];
        for x in 0..w {
            let mut acc: u32 = 0;
            for i in -r..=r {
                acc += buf[(i.clamp(0, h - 1) * w + x) as usize] as u32;
            }
            for y in 0..h {
                col[y as usize] = (acc / norm) as u8;
                let add = (y + r + 1).clamp(0, h - 1);
                let sub = (y - r).clamp(0, h - 1);
                acc += buf[(add * w + x) as usize] as u32;
                acc -= buf[(sub * w + x) as usize] as u32;
            }
            for y in 0..h {
                buf[(y * w + x) as usize] = col[y as usize];
            }
        }
    }
    /// `image_gpu::SelectionCoverage::feather`'s body, on its `data`.
    pub fn coverage_feather(data: &mut [u8], width: u32, height: u32, sigma: f32) {
        if sigma <= 0.0 || data.is_empty() {
            return;
        }
        let radius = (sigma * 3.0).ceil() as i64;
        let mut weights = Vec::with_capacity((2 * radius + 1) as usize);
        let s2 = 2.0 * sigma * sigma;
        for i in -radius..=radius {
            weights.push((-((i * i) as f32) / s2).exp());
        }
        let norm: f32 = weights.iter().sum();
        for w in &mut weights {
            *w /= norm;
        }

        let (w, h) = (width as i64, height as i64);
        let mut mid = vec![0.0f32; data.len()];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0f32;
                for (k, &wt) in weights.iter().enumerate() {
                    let sx = x + (k as i64 - radius);
                    if sx >= 0 && sx < w {
                        acc += wt * data[(y * w + sx) as usize] as f32;
                    }
                }
                mid[(y * w + x) as usize] = acc;
            }
        }
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0f32;
                for (k, &wt) in weights.iter().enumerate() {
                    let sy = y + (k as i64 - radius);
                    if sy >= 0 && sy < h {
                        acc += wt * mid[(sy * w + x) as usize];
                    }
                }
                data[(y * w + x) as usize] = acc.clamp(0.0, 255.0).round() as u8;
            }
        }
    }
}

/// A fixed pseudo-random buffer (xorshift), so the cases are reproducible.
fn noise(len: usize, seed: u32) -> Vec<u8> {
    let mut s = seed.max(1);
    (0..len)
        .map(|_| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s >> 24) as u8
        })
        .collect()
}

const SIZES: [(u32, u32); 6] = [(1, 1), (3, 2), (7, 5), (16, 9), (40, 3), (2, 31)];
const SIGMAS: [f32; 6] = [0.3, 0.8, 1.0, 2.5, 3.7, 6.0];

#[test]
fn the_clamped_rgba_gaussian_equals_the_effects_lane_copy() {
    for (i, &(w, h)) in SIZES.iter().enumerate() {
        for &sigma in &SIGMAS {
            let k = gaussian_kernel(sigma);
            let src = noise((w * h * 4) as usize, 7 + i as u32);
            let (mut a, mut b) = (src.clone(), src);
            old::gaussian_blur_premul(&mut a, w, h, &k);
            gaussian_separable::<4>(&mut b, w, h, Some(&k), Some(&k), Edge::Clamp);
            assert_eq!(a, b, "{w}×{h} σ {sigma}");
        }
    }
}

#[test]
fn the_clamped_mask_gaussian_equals_the_effects_lane_copy() {
    for (i, &(w, h)) in SIZES.iter().enumerate() {
        for &sigma in &SIGMAS {
            let k = gaussian_kernel(sigma);
            let src = noise((w * h) as usize, 11 + i as u32);
            let (mut a, mut b) = (src.clone(), src);
            old::gaussian_blur_mask(&mut a, w, h, &k);
            gaussian_separable::<1>(&mut b, w, h, Some(&k), Some(&k), Edge::Clamp);
            assert_eq!(a, b, "{w}×{h} σ {sigma}");
        }
    }
}

#[test]
fn the_transparent_gaussian_equals_the_svg_filter_copy() {
    for (i, &(w, h)) in SIZES.iter().enumerate() {
        for &sx in &SIGMAS {
            for sy in [0.0, 1.3, 4.0] {
                let kx = gaussian_kernel(sx);
                let ky = (sy > 0.0).then(|| gaussian_kernel(sy));
                let src = noise((w * h * 4) as usize, 13 + i as u32);
                let (mut a, mut b) = (src.clone(), src);
                old::gaussian_blur_premul_xy(&mut a, w, h, Some(&kx), ky.as_deref());
                gaussian_separable::<4>(&mut b, w, h, Some(&kx), ky.as_deref(), Edge::Transparent);
                assert_eq!(a, b, "{w}×{h} σ {sx}/{sy}");
            }
        }
    }
}

#[test]
fn the_transparent_rounded_box_equals_the_svg_filter_copy() {
    for (i, &(w, h)) in SIZES.iter().enumerate() {
        for reach in [(0, 0), (1, 1), (2, 3), (3, 2), (5, 5), (40, 40)] {
            for horizontal in [true, false] {
                let src = noise((w * h * 4) as usize, 17 + i as u32);
                let mut a = vec![0u8; src.len()];
                old::box_pass(&src, &mut a, w as usize, h as usize, horizontal, reach);
                let mut b = src;
                box_pass::<4>(
                    &mut b,
                    w,
                    h,
                    horizontal,
                    reach,
                    Edge::Transparent,
                    Round::Nearest,
                );
                assert_eq!(a, b, "{w}×{h} reach {reach:?} h {horizontal}");
            }
        }
    }
}

#[test]
fn the_clamped_truncated_box_equals_the_mask_copy() {
    for (i, &(w, h)) in SIZES.iter().enumerate() {
        for r in [1usize, 2, 4, 9, 50] {
            let src = noise((w * h) as usize, 19 + i as u32);
            let (mut a, mut b) = (src.clone(), src);
            for _ in 0..3 {
                old::box_blur_h(&mut a, w, h, r as i32);
                old::box_blur_v(&mut a, w, h, r as i32);
                box_pass::<1>(&mut b, w, h, true, (r, r), Edge::Clamp, Round::Truncate);
                box_pass::<1>(&mut b, w, h, false, (r, r), Edge::Clamp, Round::Truncate);
            }
            assert_eq!(a, b, "{w}×{h} r {r}");
        }
    }
}

#[test]
fn a_transparent_edge_darkens_a_blurred_border() {
    // Opaque everywhere: clamping would keep the edge opaque; reading
    // transparent beyond the buffer fades it.
    let k = gaussian_kernel(1.0);
    let mut clamped = vec![255u8; 9 * 9 * 4];
    gaussian_separable::<4>(&mut clamped, 9, 9, Some(&k), Some(&k), Edge::Clamp);
    assert!(clamped.iter().all(|&v| v == 255));
    let mut px = vec![255u8; 9 * 9 * 4];
    gaussian_separable::<4>(&mut px, 9, 9, Some(&k), Some(&k), Edge::Transparent);
    assert_eq!(px[(4 * 9 + 4) * 4 + 3], 255);
    assert!(px[3] < 200, "{}", px[3]);
}

#[test]
fn the_single_rounding_gaussian_equals_the_selection_feather_copy() {
    for (i, &(w, h)) in SIZES.iter().enumerate() {
        for &sigma in &SIGMAS {
            let src = noise((w * h) as usize, 23 + i as u32);
            let (mut a, mut b) = (src.clone(), src);
            old::coverage_feather(&mut a, w, h, sigma);
            gaussian_separable_f32_mid::<1>(
                &mut b,
                w,
                h,
                &gaussian_kernel(sigma),
                Edge::Transparent,
            );
            assert_eq!(a, b, "{w}×{h} σ {sigma}");
        }
    }
}
