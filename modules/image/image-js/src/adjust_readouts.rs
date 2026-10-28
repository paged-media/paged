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

/// The uniform share Equalize adds to every histogram bin, as a fraction
/// of the mean bin count (see [`equalize_lut`]).
pub const EQUALIZE_PRIOR: f64 = 0.5;

/// Image ▸ Adjustments ▸ Equalize as a 256-entry table (for
/// `adjust.lut1d`, which interpolates between entries).
///
/// The histogram is every r, g and b sample (alpha-weighted, times the
/// selection's coverage when given) — ONE table for the three channels,
/// so a neutral stays neutral: Photoshop's Equalize redistributes the
/// composite brightness. The table is the histogram's cumulative
/// distribution, taken
///
/// * at the MIDDLE of each bin (`cdf(v) − h(v)/2`), with the ends pinned
///   (0 → 0, 255 → 255) and linear in between, and
/// * over the histogram plus a UNIFORM share of [`EQUALIZE_PRIOR`] × the
///   mean bin count in every bin.
///
/// The uniform share is what makes the transfer a partial equalisation
/// (two thirds of the way from the identity to a flat histogram) and stops
/// a spike — a solid black or white area — from swallowing the range.
/// Both choices were FITTED to Photoshop's recorded Equalize
/// (`fixtures/photoshop/adjustments-ext`): the textbook full-strength
/// `(cdf − cdf_min)/(N − cdf_min)` table is 8 levels off at the median
/// (25 at most) on that stimulus; this one is within 1 level at the median
/// (4 at most). `None` when nothing is weighted (an empty selection, a
/// transparent image) or the image is one flat level.
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
    if total <= 0.0 || hist.iter().filter(|&&n| n > 0.0).count() < 2 {
        return None;
    }
    let prior = EQUALIZE_PRIOR * total / 256.0;
    let sum = total + prior * 256.0;
    // The transfer at the 258 knots: 0, the 256 bin centres, 1.
    let mut knot_x = [0f64; 258];
    let mut knot_y = [0f64; 258];
    let mut cdf = 0.0;
    for b in 0..256 {
        let n = hist[b] + prior;
        cdf += n;
        knot_x[b + 1] = (b as f64 + 0.5) / 256.0;
        knot_y[b + 1] = (cdf - n / 2.0) / sum;
    }
    knot_x[257] = 1.0;
    knot_y[257] = 1.0;
    let mut lut = [0u8; 256];
    let mut j = 0usize;
    for (v, slot) in lut.iter_mut().enumerate() {
        let x = v as f64 / 255.0;
        while j + 2 < 258 && knot_x[j + 1] <= x {
            j += 1;
        }
        let t = ((x - knot_x[j]) / (knot_x[j + 1] - knot_x[j])).clamp(0.0, 1.0);
        let y = knot_y[j] + (knot_y[j + 1] - knot_y[j]) * t;
        *slot = (255.0 * y).round().clamp(0.0, 255.0) as u8;
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
            let lab = paged_color::lab::srgb_to_lab_d50(
                [0, 1, 2].map(|c| f32::from(rgba[i + c]) / 255.0),
            );
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
        let px = img(&[
            [100, 100, 100, 255],
            [110, 110, 110, 255],
            [120, 120, 120, 255],
            [130, 130, 130, 255],
        ]);
        let lut = equalize_lut(&px, 4, 1, None).expect("a table");
        assert_eq!((lut[0], lut[255]), (0, 255), "the ends are pinned");
        // Thirty levels of input spread over far more of the output.
        assert!(lut[130] - lut[100] > 60, "{} → {}", lut[100], lut[130]);
        assert!(lut[100] < 100 && lut[130] > 130);
        assert!(lut.windows(2).all(|w| w[0] <= w[1]), "monotone");
    }

    /// The shape of Photoshop's recorded case (`colour-sweep`: a flat
    /// sweep plus spikes at black and white, which Photoshop maps 32 → 52,
    /// 64 → 79, 193 → 175): mid-grey stays put, the shadows rise, the
    /// highlights fall — the spikes do not swallow the range. The pixel
    /// comparison with the recording is `oracle_photoshop`'s.
    #[test]
    fn equalize_matches_photoshops_recorded_greys__feat__image_editor_filters() {
        // A histogram that is flat except for spikes at black and white —
        // the colour sweep's shape — maps mid-grey to mid-grey and pulls
        // the shadows up (the spike does not swallow the range).
        let mut px = Vec::new();
        for v in 0..=255u8 {
            px.push([v, v, v, 255]);
        }
        for _ in 0..30 {
            px.push([0, 0, 0, 255]);
            px.push([255, 255, 255, 255]);
        }
        let n = px.len() as u32;
        let lut = equalize_lut(&img(&px), n, 1, None).expect("a table");
        assert!((i32::from(lut[128]) - 128).abs() <= 2, "{}", lut[128]);
        assert!(lut[32] > 32 && lut[193] < 193, "{} {}", lut[32], lut[193]);
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
        assert!(
            (s[0] - 50.0).abs() < 0.2 && (s[3] - 50.0).abs() < 0.2,
            "{s:?}"
        );
        assert!(color_stats(&img(&[[1, 2, 3, 0]]), 1, 1, None).is_none());
    }
}
