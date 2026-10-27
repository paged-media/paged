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

//! Select ▸ FOCUS AREA, the classical way (image ADR 470): a SHARPNESS
//! MAP — the local variance of the Laplacian, the standard focus measure
//! (Pech-Pacheco et al. 2000, "Diatom autofocusing in brightfield
//! microscopy") — thresholded by the in-focus range and cleaned into
//! regions. No model, no learning.
//!
//! 1. Luma; with a noise level above 0, first blurred by up to σ = 2 px
//!    so sensor grain does not read as detail.
//! 2. The 4-neighbour Laplacian, then its variance over a window of
//!    radius R (R = 1 % of the shorter side, at least 2 px).
//! 3. Normalised by its 99th percentile (one specular highlight must not
//!    set the scale for the whole picture).
//! 4. In focus where the normalised sharpness ≥ 1 − range (range 0…1:
//!    more range, more selected), with a soft step.
//! 5. Cleaned: closed by R (bridges the gaps between textured patches),
//!    holes the image border cannot reach filled, a 1 px feather.
//!
//! Mask preparation, CPU like every coverage operation (`selection.rs`).

use image_gpu::SelectionCoverage;

/// The Focus Area dialog's two sliders.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FocusParams {
    /// In-focus range, 0…1 (Photoshop's 0…7.5 scale is mapped linearly).
    pub range: f32,
    /// Image noise level, 0…1 (0 = no pre-blur).
    pub noise: f32,
}

fn box_mean(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    // Separable running sums with clamped edges.
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let mut acc = 0f32;
        for k in 0..=2 * r {
            acc += row[k.saturating_sub(r).min(w - 1)];
        }
        // acc covers [x - r, x + r] clamped, for x = 0 after this init
        // (the init above double counts index 0 r times, as the clamp does).
        for x in 0..w {
            tmp[y * w + x] = acc / (2 * r + 1) as f32;
            let add = row[(x + r + 1).min(w - 1)];
            let sub = row[x.saturating_sub(r)];
            acc += add - sub;
        }
    }
    let mut out = vec![0f32; w * h];
    for x in 0..w {
        let mut acc = 0f32;
        for k in 0..=2 * r {
            acc += tmp[k.saturating_sub(r).min(h - 1) * w + x];
        }
        for y in 0..h {
            out[y * w + x] = acc / (2 * r + 1) as f32;
            let add = tmp[(y + r + 1).min(h - 1) * w + x];
            let sub = tmp[y.saturating_sub(r) * w + x];
            acc += add - sub;
        }
    }
    out
}

/// The sharpness map, normalised to 0…1 (1 = the 99th percentile).
pub fn sharpness_map(rgba: &[u8], w: u32, h: u32, noise: f32) -> Vec<f32> {
    let (w, h) = (w as usize, h as usize);
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return Vec::new();
    }
    let mut luma: Vec<f32> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .take(w * h)
        .map(|p| {
            (0.299 * f32::from(p[0]) + 0.587 * f32::from(p[1]) + 0.114 * f32::from(p[2])) / 255.0
        })
        .collect();
    let blur_r = (noise.clamp(0.0, 1.0) * 2.0).round() as usize;
    for _ in 0..2 {
        if blur_r > 0 {
            luma = box_mean(&luma, w, h, blur_r);
        }
    }
    let at = |x: isize, y: isize| -> f32 {
        let x = x.clamp(0, w as isize - 1) as usize;
        let y = y.clamp(0, h as isize - 1) as usize;
        luma[y * w + x]
    };
    let mut lap = vec![0f32; w * h];
    for y in 0..h as isize {
        for x in 0..w as isize {
            lap[y as usize * w + x as usize] =
                at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) - 4.0 * at(x, y);
        }
    }
    let r = ((w.min(h) as f32) * 0.01).round().max(2.0) as usize;
    let mean = box_mean(&lap, w, h, r);
    let sq: Vec<f32> = lap.iter().map(|v| v * v).collect();
    let mean_sq = box_mean(&sq, w, h, r);
    let mut var: Vec<f32> = mean_sq
        .iter()
        .zip(&mean)
        .map(|(s, m)| (s - m * m).max(0.0).sqrt())
        .collect();
    let mut sorted = var.clone();
    sorted.sort_by(f32::total_cmp);
    let p99 = sorted[((sorted.len() - 1) as f32 * 0.99) as usize].max(1e-6);
    for v in &mut var {
        *v = (*v / p99).min(1.0);
    }
    var
}

/// Focus Area's coverage.
pub fn focus_area(rgba: &[u8], width: u32, height: u32, p: FocusParams) -> SelectionCoverage {
    let (w, h) = (width as usize, height as usize);
    let map = sharpness_map(rgba, width, height, p.noise);
    if map.is_empty() {
        return SelectionCoverage::empty(width, height);
    }
    let cut = 1.0 - p.range.clamp(0.0, 1.0);
    let soft = 0.05f32;
    let hard: Vec<u8> = map
        .iter()
        .map(|&s| {
            let t = ((s - cut) / soft + 0.5).clamp(0.0, 1.0);
            (t * 255.0).round() as u8
        })
        .collect();
    let base = SelectionCoverage::from_data(width, height, hard)
        .unwrap_or_else(|| SelectionCoverage::empty(width, height));
    // Close: expand then contract by R.
    let r = ((w.min(h) as f32) * 0.01).round().max(2.0);
    let closed = crate::selection::modify_coverage(
        &crate::selection::modify_coverage(&base, crate::selection::ModifyOp::Expand, r),
        crate::selection::ModifyOp::Contract,
        r,
    );
    // Fill holes: unselected pixels the border cannot reach.
    let data = closed.data();
    let mut outside = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    for x in 0..w {
        stack.push(x);
        stack.push((h - 1) * w + x);
    }
    for y in 0..h {
        stack.push(y * w);
        stack.push(y * w + w - 1);
    }
    while let Some(i) = stack.pop() {
        if outside[i] || data[i] >= 128 {
            continue;
        }
        outside[i] = true;
        let (x, y) = (i % w, i / w);
        if x > 0 {
            stack.push(i - 1);
        }
        if x + 1 < w {
            stack.push(i + 1);
        }
        if y > 0 {
            stack.push(i - w);
        }
        if y + 1 < h {
            stack.push(i + w);
        }
    }
    let filled: Vec<u8> = (0..w * h)
        .map(|i| if outside[i] { 0 } else { 255 })
        .collect();
    let mut out = SelectionCoverage::from_data(width, height, filled)
        .unwrap_or_else(|| SelectionCoverage::empty(width, height));
    out.feather(1.0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 64×32: the left half a fine checker (in focus), the right half a
    /// smooth ramp (out of focus).
    fn half_sharp() -> Vec<u8> {
        let mut px = Vec::new();
        for y in 0..32u32 {
            for x in 0..64u32 {
                let v = if x < 32 {
                    if (x + y) % 2 == 0 {
                        40
                    } else {
                        220
                    }
                } else {
                    (100 + (x - 32) * 2) as u8
                };
                px.extend_from_slice(&[v, v, v, 255]);
            }
        }
        px
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_textured_half_is_in_focus__feat__image_selection_select_and_mask() {
        let px = half_sharp();
        let map = sharpness_map(&px, 64, 32, 0.0);
        assert!(map[16 * 64 + 10] > 0.9, "the checker is sharp");
        assert!(map[16 * 64 + 54] < 0.05, "the ramp is not");
        let cov = focus_area(
            &px,
            64,
            32,
            FocusParams {
                range: 0.5,
                noise: 0.0,
            },
        );
        assert_eq!(cov.coverage_at(10, 16), 255);
        assert_eq!(cov.coverage_at(56, 16), 0);
        // Noise suppression blurs the checker away: nothing reads sharp
        // relative to itself any more, but the map stays finite.
        let noisy = sharpness_map(&px, 64, 32, 1.0);
        assert!(noisy.iter().all(|v| v.is_finite()));
        // No range selects (almost) nothing.
        let none = focus_area(
            &px,
            64,
            32,
            FocusParams {
                range: 0.0,
                noise: 0.0,
            },
        );
        assert!(none.selected_fraction() < 0.6);
    }

    #[test]
    fn holes_inside_the_sharp_region_are_filled() {
        // A sharp ring with a flat centre: the centre is enclosed.
        let mut px = Vec::new();
        for y in 0..40u32 {
            for x in 0..40u32 {
                let ring = (8..32).contains(&x)
                    && (8..32).contains(&y)
                    && !((14..26).contains(&x) && (14..26).contains(&y));
                let v = if ring && (x + y) % 2 == 0 {
                    230
                } else if ring {
                    30
                } else {
                    128
                };
                px.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let cov = focus_area(
            &px,
            40,
            40,
            FocusParams {
                range: 0.6,
                noise: 0.0,
            },
        );
        assert_eq!(
            cov.coverage_at(20, 20),
            255,
            "the enclosed centre is filled"
        );
        assert_eq!(cov.coverage_at(2, 2), 0, "the outside is not");
    }
}
