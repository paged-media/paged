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

//! The 8-bit CPU blurs of the engine's effects (engine ADR 1013, amendment
//! "Blur"): an exact separable Gaussian and a running-sum box pass over
//! interleaved `u8` buffers of `C` channels.
//!
//! A blur is linear, so it runs on whatever the channels hold: callers pass
//! premultiplied RGBA (`C = 4`) or a coverage mask (`C = 1`), never straight
//! alpha (a straight-alpha buffer would need un- and re-premultiplying around
//! the call). What differs between the callers is stated, not guessed:
//!
//! - [`Edge`]: an effect's scratch buffer is padded by 3σ and clamps at its
//!   border ([`Edge::Clamp`]); an SVG filter region is transparent black
//!   beyond it ([`Edge::Transparent`]).
//! - [`Round`]: the box pass of the SVG filter rounds to nearest, the
//!   InDesign feather and shadow masks truncate.
//! - Where the rounding falls: [`gaussian_separable`] rounds after each
//!   pass (the effects lane, the SVG filter), [`gaussian_separable_f32_mid`]
//!   once at the end (paged.image's selection feather).
//!
//! The f32 twins of the image pipeline (`cpu::gaussian_weights` and
//! `cpu::gaussian_axis`) are a different kernel: radius capped at 24 and the
//! exponent multiplied by `1 / 2σ²`, so the two are not interchangeable bit
//! for bit.

/// What a pass reads beyond the buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    /// The nearest pixel inside.
    Clamp,
    /// Zero in every channel.
    Transparent,
}

/// How a box pass turns its sum into a mean.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Round {
    /// `(sum + n / 2) / n`.
    Nearest,
    /// `sum / n`.
    Truncate,
}

/// 1-D Gaussian kernel sampled at integer pixel offsets, truncated at
/// 3σ on each side (at least one pixel) and normalised to sum to 1.
pub fn gaussian_kernel(sigma: f32) -> Vec<f32> {
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

/// Separable Gaussian over `C` interleaved channels: the rows through `kx`,
/// then the columns through `ky`, each pass rounded to `u8`. A kernel of
/// fewer than two taps (or `None`) leaves its axis alone. Accumulates in
/// kernel order in f32.
pub fn gaussian_separable<const C: usize>(
    data: &mut [u8],
    width: u32,
    height: u32,
    kx: Option<&[f32]>,
    ky: Option<&[f32]>,
    edge: Edge,
) {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return;
    }
    let mut tmp = vec![0u8; data.len()];
    for (kernel, horizontal) in [(kx, true), (ky, false)] {
        let Some(kernel) = kernel.filter(|k| k.len() > 1) else {
            continue;
        };
        let radius = (kernel.len() / 2) as isize;
        let (len, step) = if horizontal { (w, 1) } else { (h, w) };
        for y in 0..h {
            for x in 0..w {
                let (pos, base) = if horizontal { (x, y * w) } else { (y, x) };
                let mut acc = [0.0f32; C];
                for (k, &coeff) in kernel.iter().enumerate() {
                    let mut s = pos as isize + k as isize - radius;
                    if s < 0 || s >= len as isize {
                        match edge {
                            Edge::Clamp => s = s.clamp(0, len as isize - 1),
                            Edge::Transparent => continue,
                        }
                    }
                    let p = (base + s as usize * step) * C;
                    for c in 0..C {
                        acc[c] += data[p + c] as f32 * coeff;
                    }
                }
                let q = (y * w + x) * C;
                for c in 0..C {
                    tmp[q + c] = acc[c].round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        data.copy_from_slice(&tmp);
    }
}

/// Separable Gaussian through one kernel on both axes with a single
/// rounding: the row pass stays in f32 and only the column pass rounds to
/// `u8`. paged.image's selection feather (`SelectionCoverage::feather`)
/// runs it; the effects lane's [`gaussian_separable`] rounds after each
/// pass, so the two differ by up to one level.
pub fn gaussian_separable_f32_mid<const C: usize>(
    data: &mut [u8],
    width: u32,
    height: u32,
    kernel: &[f32],
    edge: Edge,
) {
    let (w, h) = (width as isize, height as isize);
    if w == 0 || h == 0 || kernel.is_empty() {
        return;
    }
    let radius = (kernel.len() / 2) as isize;
    let tap = |s: isize, len: isize| -> Option<isize> {
        if s >= 0 && s < len {
            Some(s)
        } else {
            match edge {
                Edge::Clamp => Some(s.clamp(0, len - 1)),
                Edge::Transparent => None,
            }
        }
    };
    let mut mid = vec![0.0f32; data.len()];
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0.0f32; C];
            for (k, &wt) in kernel.iter().enumerate() {
                if let Some(sx) = tap(x + k as isize - radius, w) {
                    let p = (y * w + sx) as usize * C;
                    for c in 0..C {
                        acc[c] += wt * data[p + c] as f32;
                    }
                }
            }
            mid[(y * w + x) as usize * C..][..C].copy_from_slice(&acc);
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0.0f32; C];
            for (k, &wt) in kernel.iter().enumerate() {
                if let Some(sy) = tap(y + k as isize - radius, h) {
                    let p = (sy * w + x) as usize * C;
                    for c in 0..C {
                        acc[c] += wt * mid[p + c];
                    }
                }
            }
            let q = (y * w + x) as usize * C;
            for c in 0..C {
                data[q + c] = acc[c].clamp(0.0, 255.0).round() as u8;
            }
        }
    }
}

/// One box pass in place along rows (`horizontal`) or columns: each pixel
/// becomes the mean of the `left + 1 + right` pixels around it (`reach`),
/// by a running integer sum.
#[allow(clippy::too_many_arguments)]
pub fn box_pass<const C: usize>(
    data: &mut [u8],
    width: u32,
    height: u32,
    horizontal: bool,
    reach: (usize, usize),
    edge: Edge,
    round: Round,
) {
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 {
        return;
    }
    let (lines, len, step, stride) = if horizontal {
        (h, w, C, w * C)
    } else {
        (w, h, w * C, C)
    };
    let (left, right) = (reach.0 as isize, reach.1 as isize);
    let n = (reach.0 + reach.1 + 1) as u32;
    let mut line = vec![0u8; len * C];
    for l in 0..lines {
        let base = l * stride;
        for i in 0..len {
            line[i * C..(i + 1) * C].copy_from_slice(&data[base + i * step..base + i * step + C]);
        }
        let sample = |i: isize, c: usize| -> u32 {
            if i < 0 || i >= len as isize {
                match edge {
                    Edge::Clamp => line[i.clamp(0, len as isize - 1) as usize * C + c] as u32,
                    Edge::Transparent => 0,
                }
            } else {
                line[i as usize * C + c] as u32
            }
        };
        let mut sum = [0u32; C];
        for (c, s) in sum.iter_mut().enumerate() {
            for j in -left..right {
                *s += sample(j, c);
            }
        }
        for i in 0..len as isize {
            let q = base + i as usize * step;
            for c in 0..C {
                sum[c] += sample(i + right, c);
                data[q + c] = match round {
                    Round::Nearest => (sum[c] + n / 2) / n,
                    Round::Truncate => sum[c] / n,
                } as u8;
                sum[c] -= sample(i - left, c);
            }
        }
    }
}

#[cfg(test)]
#[path = "blur_oracle_tests.rs"]
mod oracle_tests;
