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

//! Blur kernels shared by the CPU lane's effects (`vcpu`) and the SVG
//! filters of placed SVGs (`svg_filter`).
//!
//! The effects pipeline pads its scratch buffers by 3σ and clamps at
//! their edges; an SVG filter's input is transparent black beyond its
//! region, so the SVG variants read zero there instead.

/// 1-D Gaussian kernel sampled at integer pixel offsets, truncated at
/// 3σ on each side and normalised to sum to 1.
pub(crate) fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as i32;
    let two_sigma_sq = 2.0 * sigma * sigma;
    let mut k = Vec::with_capacity(2 * radius as usize + 1);
    let mut sum = 0.0f32;
    for i in -radius..=radius {
        let v = (-(i as f32) * (i as f32) / two_sigma_sq).exp();
        k.push(v);
        sum += v;
    }
    if sum > 0.0 {
        for v in &mut k {
            *v /= sum;
        }
    }
    k
}

#[cfg(feature = "cpu")]
/// Separable Gaussian over a premultiplied RGBA8 buffer, edges clamped
/// (the caller pads by 3σ, so the clamp reads the empty margin).
pub(crate) fn gaussian_blur_premul(data: &mut [u8], width: u32, height: u32, kernel: &[f32]) {
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

#[cfg(feature = "cpu")]
/// Separable Gaussian over a single-channel mask, edges clamped.
pub(crate) fn gaussian_blur_mask(mask: &mut [u8], width: u32, height: u32, kernel: &[f32]) {
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

#[cfg(feature = "svg")]
/// Separable Gaussian over a premultiplied RGBA8 buffer, a kernel per
/// axis (`None` leaves that axis alone), reading transparent black
/// outside the buffer.
pub(crate) fn gaussian_blur_premul_xy(
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

#[cfg(feature = "svg")]
/// Five centred boxes whose successive blurs approximate a Gaussian of
/// `sigma` px: odd widths `wl` and `wl + 2`, as many of each as makes
/// their variances sum to σ² (Kovesi, "Fast almost-Gaussian filtering").
/// The Filter Effects specification allows any approximation and
/// describes three boxes; five follow the Gaussian about twice as
/// closely, at the same linear cost. Each box is its `(left, right)`
/// reach around the output pixel.
fn gauss_boxes(sigma: f32) -> [(usize, usize); 5] {
    const N: f32 = 5.0;
    let ideal = (12.0 * sigma * sigma / N + 1.0).sqrt();
    let mut wl = ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wlf = wl as f32;
    let m = ((12.0 * sigma * sigma - N * wlf * wlf - 4.0 * N * wlf - 3.0 * N) / (-4.0 * wlf - 4.0))
        .round()
        .clamp(0.0, N) as usize;
    std::array::from_fn(|i| {
        let r = if i < m { (wl - 1) / 2 } else { (wl + 1) / 2 } as usize;
        (r, r)
    })
}

#[cfg(feature = "svg")]
/// One box pass along rows (`horizontal`) or columns: each output pixel
/// is the rounded mean of the `left + 1 + right` input pixels around
/// it, transparent beyond the buffer.
fn box_pass(
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

#[cfg(feature = "svg")]
/// A Gaussian of σ ≥ 2 px, approximated by five box blurs per axis, over
/// a premultiplied RGBA8 buffer, transparent beyond it. Linear in σ,
/// where the kernel above grows with it. A σ of 0 leaves that axis
/// alone.
pub(crate) fn box_blur_premul(
    data: &mut [u8],
    width: u32,
    height: u32,
    sigma_x: f32,
    sigma_y: f32,
) {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return;
    }
    let mut tmp = vec![0u8; data.len()];
    for (sigma, horizontal) in [(sigma_x, true), (sigma_y, false)] {
        if sigma <= 0.0 {
            continue;
        }
        for reach in gauss_boxes(sigma) {
            box_pass(data, &mut tmp, w, h, horizontal, reach);
            data.copy_from_slice(&tmp);
        }
    }
}

#[cfg(all(test, feature = "svg"))]
mod tests {
    use super::*;

    #[test]
    fn the_boxes_add_up_to_the_gaussians_variance() {
        // A box of width w has variance (w² − 1) / 12.
        for sigma in [4.0f32, 4.5, 6.0, 8.0, 20.0] {
            let var: f32 = gauss_boxes(sigma)
                .iter()
                .map(|&(l, r)| {
                    let w = (l + r + 1) as f32;
                    (w * w - 1.0) / 12.0
                })
                .sum();
            let rel = (var - sigma * sigma).abs() / (sigma * sigma);
            assert!(rel < 0.05, "σ {sigma}: variance {var}");
        }
    }

    #[test]
    fn a_box_blur_keeps_the_ink_and_spreads_it_evenly() {
        // A single opaque pixel in the middle of a 41 × 1 row.
        let mut row = vec![0u8; 41 * 4];
        row[20 * 4..20 * 4 + 4].copy_from_slice(&[255; 4]);
        box_blur_premul(&mut row, 41, 1, 4.0, 0.0);
        let alpha: Vec<u32> = row.chunks(4).map(|p| p[3] as u32).collect();
        let total: u32 = alpha.iter().sum();
        assert!((240..=270).contains(&total), "{total}");
        for i in 0..20 {
            assert_eq!(alpha[20 - i], alpha[20 + i], "symmetric at {i}");
        }
        assert!(alpha[20] > alpha[24] && alpha[24] > alpha[28]);
    }

    #[test]
    fn a_transparent_edge_darkens_a_blurred_border() {
        // Opaque everywhere: clamping would keep the edge opaque; reading
        // transparent beyond the buffer fades it.
        let mut px = vec![255u8; 9 * 9 * 4];
        let k = gaussian_kernel(1.0);
        gaussian_blur_premul_xy(&mut px, 9, 9, Some(&k), Some(&k));
        assert_eq!(px[(4 * 9 + 4) * 4 + 3], 255);
        assert!(px[3] < 200, "{}", px[3]);
    }
}
