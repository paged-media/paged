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

//! CPU READOUTS behind the WP5.2 adjustments (inherently CPU work, like
//! the histogram and `readouts::coverage_mean`): Equalize's table and
//! Match Color's statistics. No GPU, testable on the host.

use image_gpu::coverage::SelectionCoverage;

/// Image ▸ Adjustments ▸ Equalize as a 256-entry table: the histogram of
/// every r, g and b sample (alpha-weighted, times the selection's
/// coverage when given) flattened through its cumulative distribution,
///
/// ```text
/// lut[v] = round(255 · (cdf(v) − cdf_min) / (total − cdf_min))
/// ```
///
/// One table for all three channels, so a neutral stays neutral —
/// Photoshop's Equalize redistributes the COMPOSITE brightness. `None`
/// when nothing is weighted (an empty selection, a transparent image) or
/// the image is one flat level (there is nothing to redistribute).
pub fn equalize_lut(
    rgba: &[u8],
    w: u32,
    h: u32,
    coverage: Option<&SelectionCoverage>,
) -> Option<[u8; 256]> {
    let mut hist = [0f64; 256];
    for y in 0..h {
        for x in 0..w {
            let k = coverage.map_or(1.0, |cov| f64::from(cov.coverage_at(x, y)) / 255.0);
            let i = (y as usize * w as usize + x as usize) * 4;
            let k = k * f64::from(rgba[i + 3]) / 255.0;
            if k == 0.0 {
                continue;
            }
            for c in 0..3 {
                hist[rgba[i + c] as usize] += k;
            }
        }
    }
    let total: f64 = hist.iter().sum();
    if total <= 0.0 {
        return None;
    }
    let first = hist.iter().position(|&n| n > 0.0)?;
    let cdf_min = hist[first];
    if total - cdf_min <= 0.0 {
        return None;
    }
    let mut lut = [0u8; 256];
    let mut cdf = 0.0;
    for (v, slot) in lut.iter_mut().enumerate() {
        cdf += hist[v];
        let t = ((cdf - cdf_min) / (total - cdf_min)).clamp(0.0, 1.0);
        *slot = if v < first {
            0
        } else {
            (255.0 * t).round() as u8
        };
    }
    Some(lut)
}

/// Match Color's statistics of an image: `[L mean, a mean, b mean, L std,
/// a std, b std]` in CIELAB (D50, the engine's `paged_color::lab`
/// conversion — the one `adjust.match_color` writes out), each pixel
/// weighted by its alpha and the selection's coverage. `None` when
/// nothing is weighted.
pub fn color_stats(
    rgba: &[u8],
    w: u32,
    h: u32,
    coverage: Option<&SelectionCoverage>,
) -> Option<[f32; 6]> {
    let mut wsum = 0f64;
    let mut s1 = [0f64; 3];
    let mut s2 = [0f64; 3];
    for y in 0..h {
        for x in 0..w {
            let k = coverage.map_or(1.0, |cov| f64::from(cov.coverage_at(x, y)) / 255.0);
            let i = (y as usize * w as usize + x as usize) * 4;
            let k = k * f64::from(rgba[i + 3]) / 255.0;
            if k == 0.0 {
                continue;
            }
            let lab = paged_color::lab::srgb_to_lab_d50([0, 1, 2].map(|c| f32::from(rgba[i + c]) / 255.0));
            wsum += k;
            for c in 0..3 {
                let v = f64::from(lab[c]);
                s1[c] += k * v;
                s2[c] += k * v * v;
            }
        }
    }
    if wsum <= 0.0 {
        return None;
    }
    let mut out = [0f32; 6];
    for c in 0..3 {
        let m = s1[c] / wsum;
        out[c] = m as f32;
        out[3 + c] = (s2[c] / wsum - m * m).max(0.0).sqrt() as f32;
    }
    Some(out)
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn img(px: &[[u8; 4]]) -> Vec<u8> {
        px.iter().flatten().copied().collect()
    }

    #[test]
    fn equalize_spreads_a_narrow_histogram_over_the_range__feat__image_editor_filters() {
        // Four greys bunched between 100 and 130.
        let px = img(&[[100, 100, 100, 255], [110, 110, 110, 255], [120, 120, 120, 255], [130, 130, 130, 255]]);
        let lut = equalize_lut(&px, 4, 1, None).expect("a table");
        assert_eq!(lut[100], 0, "the darkest level goes to black");
        assert_eq!(lut[130], 255, "the brightest to white");
        assert!(lut[110] > 60 && lut[110] < 110 && lut[120] > 150 && lut[120] < 200);
        assert!(lut.windows(2).all(|w| w[0] <= w[1]), "monotone");
    }

    #[test]
    fn equalize_refuses_a_flat_or_empty_image__feat__image_editor_filters() {
        let flat = img(&[[90, 90, 90, 255], [90, 90, 90, 255]]);
        assert!(equalize_lut(&flat, 2, 1, None).is_none());
        let clear = img(&[[90, 10, 200, 0]]);
        assert!(equalize_lut(&clear, 1, 1, None).is_none());
    }

    #[test]
    fn color_stats_of_a_grey_have_no_chroma_and_white_is_l100__feat__image_editor_filters() {
        let px = img(&[[255, 255, 255, 255], [255, 255, 255, 255]]);
        let s = color_stats(&px, 2, 1, None).expect("stats");
        assert!((s[0] - 100.0).abs() < 0.2, "{s:?}");
        assert!(s[1].abs() < 0.2 && s[2].abs() < 0.2 && s[3] < 1e-3);
        let two = img(&[[0, 0, 0, 255], [255, 255, 255, 255]]);
        let s = color_stats(&two, 2, 1, None).expect("stats");
        assert!((s[0] - 50.0).abs() < 0.2 && (s[3] - 50.0).abs() < 0.2, "{s:?}");
        assert!(color_stats(&img(&[[1, 2, 3, 0]]), 1, 1, None).is_none());
    }
}
