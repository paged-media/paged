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

//! The lookup tables the kernels read: a contour's curve and a ramp's
//! colours, each at 256 evenly spaced inputs.

use paged_model::layer_style::{FxContour, FxCurvePoint, FxRamp};

/// The curve at 256 evenly spaced inputs, each in `[0, 1]`: a natural
/// cubic spline through the points (the Curves dialog's curve,
/// `paged_pixel::curve_natural_f32`), split at every corner point into
/// pieces that each are such a spline.
pub fn contour_lut(c: &FxContour) -> [f32; 256] {
    let mut pts: Vec<FxCurvePoint> = c.points.clone();
    pts.sort_by(|a, b| a.x.total_cmp(&b.x));
    if pts.len() < 2 {
        return paged_pixel::curve_natural_f32(&[]);
    }
    let norm = |p: &FxCurvePoint| (p.x / 255.0, p.y / 255.0);
    // Pieces between corners (a corner ends one piece and starts the
    // next); the end points are corners by construction.
    let mut cuts = vec![0usize];
    for (i, p) in pts.iter().enumerate().take(pts.len() - 1).skip(1) {
        if p.corner {
            cuts.push(i);
        }
    }
    cuts.push(pts.len() - 1);
    let mut out = [0.0f32; 256];
    let first = norm(&pts[0]);
    let last = norm(&pts[pts.len() - 1]);
    for (k, slot) in out.iter_mut().enumerate() {
        let x = k as f32 / 255.0;
        *slot = if x <= first.0 {
            first.1
        } else if x >= last.0 {
            last.1
        } else {
            0.0
        };
    }
    for w in cuts.windows(2) {
        let piece: Vec<(f32, f32)> = pts[w[0]..=w[1]].iter().map(norm).collect();
        let lut = paged_pixel::curve_natural_f32(&piece);
        let (x0, x1) = (piece[0].0, piece[piece.len() - 1].0);
        for (k, slot) in out.iter_mut().enumerate() {
            let x = k as f32 / 255.0;
            if x >= x0 && x <= x1 {
                *slot = lut[k];
            }
        }
    }
    out
}

/// The ramp at 256 evenly spaced positions as straight `[r, g, b, a]` in
/// `[0, 1]`, `reverse`d when asked. Between two stops the blend reaches
/// one half at the midpoint (piecewise linear on either side of it),
/// eased by the smoothness.
pub fn ramp_lut(g: &FxRamp, reverse: bool) -> [[f32; 4]; 256] {
    fn ramp<const N: usize>(
        stops: &[(f32, [f32; N], f32)],
        t: f32,
        fallback: [f32; N],
        ease: f32,
    ) -> [f32; N] {
        if stops.is_empty() {
            return fallback;
        }
        let first = &stops[0];
        let last = &stops[stops.len() - 1];
        if t <= first.0 {
            return first.1;
        }
        if t >= last.0 {
            return last.1;
        }
        for w in stops.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if t >= a.0 && t <= b.0 {
                let span = (b.0 - a.0).max(1e-6);
                let u = (t - a.0) / span;
                let m = a.2.clamp(0.01, 0.99);
                let f = if u <= m {
                    0.5 * u / m
                } else {
                    0.5 + 0.5 * (u - m) / (1.0 - m)
                };
                // SMOOTHNESS eases each segment: half way to a
                // smoothstep at 100 % (fitted to Photoshop's own
                // black-to-white overlay within a level).
                let f = f + ease * (f * f * (3.0 - 2.0 * f) - f);
                let mut out = a.1;
                for (o, (x, y)) in out.iter_mut().zip(a.1.iter().zip(b.1.iter())) {
                    *o = x + (y - x) * f;
                }
                return out;
            }
        }
        last.1
    }
    let mut colors: Vec<(f32, [f32; 3], f32)> = g
        .color_stops
        .iter()
        .map(|s| (s.at, s.rgb.map(|v| f32::from(v) / 255.0), s.midpoint))
        .collect();
    colors.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut alphas: Vec<(f32, [f32; 1], f32)> = g
        .alpha_stops
        .iter()
        .map(|s| (s.at, [s.opacity], s.midpoint))
        .collect();
    alphas.sort_by(|a, b| a.0.total_cmp(&b.0));
    let ease = 0.5 * (g.smoothness_pct / 100.0).clamp(0.0, 1.0);
    std::array::from_fn(|i| {
        let t = i as f32 / 255.0;
        let t = if reverse { 1.0 - t } else { t };
        let c = ramp(&colors, t, [t, t, t], ease);
        let a = ramp(&alphas, t, [1.0], ease);
        [c[0], c[1], c[2], a[0]]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: f32, y: f32, corner: bool) -> FxCurvePoint {
        FxCurvePoint { x, y, corner }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_contour_is_a_spline_split_at_corners__feat__image_layers_styles() {
        let lin = contour_lut(&FxContour::linear());
        assert!((lin[0]).abs() < 1e-6 && (lin[255] - 1.0).abs() < 1e-6);
        assert!((lin[128] - 128.0 / 255.0).abs() < 1e-4);
        let cone = FxContour {
            name: "Cone".into(),
            points: vec![
                pt(0.0, 0.0, false),
                pt(127.5, 255.0, true),
                pt(255.0, 0.0, false),
            ],
        };
        let l = contour_lut(&cone);
        // With a corner each half is a straight line: a tent.
        assert!((l[64] - 64.0 / 127.5).abs() < 1e-3, "{}", l[64]);
        assert!((l[191] - (255.0 - 191.0) / 127.5).abs() < 1e-3);
        // Smooth, the same three points overshoot nowhere above 1 and
        // round the peak.
        let mut smooth = cone.clone();
        smooth.points[1].corner = false;
        let s = contour_lut(&smooth);
        assert!(s.iter().all(|v| (0.0..=1.0).contains(v)));
        assert!(s[64] > l[64], "a smooth peak is fuller");
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_ramp_lut_honours_midpoints_and_opacity__feat__image_layers_styles() {
        let mut g = FxRamp::two([0, 0, 0], [255, 255, 255]);
        g.alpha_stops[1].opacity = 0.0;
        let l = ramp_lut(&g, false);
        assert!(l[0][0] < 1e-6 && (l[255][0] - 1.0).abs() < 1e-6);
        assert!((l[255][3]).abs() < 1e-6 && (l[0][3] - 1.0).abs() < 1e-6);
        g.color_stops[0].midpoint = 0.25;
        let l = ramp_lut(&g, false);
        // Half way to white at a quarter.
        assert!((l[64][0] - 0.5).abs() < 0.02, "{}", l[64][0]);
        let r = ramp_lut(&g, true);
        assert!((r[0][0] - 1.0).abs() < 1e-6);
    }
}
