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

//! Warp maths (plan §1.1, PM-0014 L2): the 3×3 HOMOGRAPHY behind Free
//! Transform (editor ADR 295, extensions ADR 339) and the projective
//! resample (`geom.warp_projective`). One definition for every consumer —
//! the image kernels feed its inverse to the backward sampler; vector and
//! envelope warps (WP3.2) map points through it.
//!
//! Matrices are ROW-MAJOR on column vectors, the convention the SDK's
//! `ProjectiveMatrix` uses: `(x, y) ↦ ((m0·x + m1·y + m2)/w, (m3·x + m4·y +
//! m5)/w)` with `w = m6·x + m7·y + m8`. All maths is f64.

/// A 3×3 projective matrix, row-major.
pub type Homography = [f64; 9];

/// The identity map.
pub const IDENTITY: Homography = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

/// The inverse, or `None` when `m` is singular (it folds the plane flat).
pub fn invert(m: Homography) -> Option<Homography> {
    let [a, b, c, d, e, f, g, h, i] = m;
    let co_a = e * i - f * h;
    let co_b = -(d * i - f * g);
    let co_c = d * h - e * g;
    let det = a * co_a + b * co_b + c * co_c;
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let k = 1.0 / det;
    Some([
        co_a * k,
        -(b * i - c * h) * k,
        (b * f - c * e) * k,
        co_b * k,
        (a * i - c * g) * k,
        -(a * f - c * d) * k,
        co_c * k,
        -(a * h - b * g) * k,
        (a * e - b * d) * k,
    ])
}

/// `a · b` (apply `b` first).
pub fn multiply(a: Homography, b: Homography) -> Homography {
    let mut out = [0.0; 9];
    for r in 0..3 {
        for c in 0..3 {
            out[r * 3 + c] = (0..3).map(|k| a[r * 3 + k] * b[k * 3 + c]).sum();
        }
    }
    out
}

/// Map a point. A point on the horizon (`w == 0`) maps to infinity.
pub fn apply(m: &Homography, (x, y): (f64, f64)) -> (f64, f64) {
    let w = m[6] * x + m[7] * y + m[8];
    (
        (m[0] * x + m[1] * y + m[2]) / w,
        (m[3] * x + m[4] * y + m[5]) / w,
    )
}

/// The homography taking the four `src` corners onto the four `dst`
/// corners (in order), or `None` when either quad is degenerate. The direct
/// linear solve with `m8 = 1`: eight equations, Gaussian elimination with
/// partial pivoting.
pub fn from_quads(src: [(f64, f64); 4], dst: [(f64, f64); 4]) -> Option<Homography> {
    let mut a = [[0.0f64; 9]; 8];
    for i in 0..4 {
        let (x, y) = src[i];
        let (u, v) = dst[i];
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    for col in 0..8 {
        let piv = (col..8).max_by(|&p, &q| a[p][col].abs().total_cmp(&a[q][col].abs()))?;
        if a[piv][col].abs() < 1e-10 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..8 {
            if r == col {
                continue;
            }
            let f = a[r][col] / a[col][col];
            if f == 0.0 {
                continue;
            }
            let pivot_row = a[col];
            for (v, p) in a[r].iter_mut().zip(pivot_row).skip(col) {
                *v -= f * p;
            }
        }
    }
    let mut m = [0.0; 9];
    for (i, row) in a.iter().enumerate() {
        m[i] = row[8] / row[i];
    }
    m[8] = 1.0;
    m.iter().all(|v| v.is_finite()).then_some(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT: [(f64, f64); 4] = [(0.0, 0.0), (64.0, 0.0), (64.0, 48.0), (0.0, 48.0)];

    fn near(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9
    }

    #[test]
    fn from_quads_sends_each_corner_to_its_target() {
        let dst = [(12.8, 0.0), (51.2, 0.0), (64.0, 48.0), (0.0, 48.0)];
        let h = from_quads(RECT, dst).expect("non-degenerate");
        for i in 0..4 {
            assert!(near(apply(&h, RECT[i]), dst[i]), "corner {i}");
        }
        assert!(h[6].abs() + h[7].abs() > 0.0, "a trapezoid is projective");
    }

    #[test]
    fn invert_undoes_the_map() {
        let dst = [(5.0, 3.0), (70.0, -2.0), (60.0, 50.0), (-4.0, 44.0)];
        let h = from_quads(RECT, dst).expect("non-degenerate");
        let id = multiply(invert(h).expect("invertible"), h);
        for (got, want) in id.iter().zip(IDENTITY) {
            assert!((got - want).abs() < 1e-9);
        }
    }

    #[test]
    fn degenerate_quads_and_singular_maps_are_refused() {
        let flat = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)];
        assert!(from_quads(RECT, flat).is_none());
        assert!(invert([1.0, 2.0, 0.0, 2.0, 4.0, 0.0, 0.0, 0.0, 1.0]).is_none());
    }
}

/// Envelope warps: the Bézier mesh and Photoshop's warp styles (WP5.10).
pub mod envelope;

/// Displacement fields (the backward map of a free-form raster warp) and
/// the Liquify brushes that edit one (WP5.6).
pub mod field;

/// Puppet Warp: an as-rigid-as-possible triangle mesh bent by pins, and
/// its raster backward field (WP5.6).
pub mod puppet;
