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

//! The affine in double precision, `[a, b, c, d, tx, ty]`: the 2x3 matrix
//! `| a c tx |` over `| b d ty |`, a point `(x, y)` mapping to
//! `(a x + c y + tx, b x + d y + ty)`.
//!
//! The DrawingML modules (slide's resolver, the pptx writer and the live
//! shape code) and the DXF importer each wrote out this product and point
//! map; the writer and the live shape code also wrote the same inverse.
//! The expressions here are theirs, term for term
//! (`tests::*_match_the_replaced_copies`), so results are unchanged bit for
//! bit. The single-precision IDML affine is [`crate::affine`].

/// `[a, b, c, d, tx, ty]`.
pub type Affine64 = [f64; 6];

/// The identity.
pub const IDENTITY: Affine64 = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `outer ∘ inner`: `inner` applies first, a point `p` mapping to
/// `outer(inner(p))`.
#[inline]
pub fn multiply(outer: &Affine64, inner: &Affine64) -> Affine64 {
    [
        outer[0] * inner[0] + outer[2] * inner[1],
        outer[1] * inner[0] + outer[3] * inner[1],
        outer[0] * inner[2] + outer[2] * inner[3],
        outer[1] * inner[2] + outer[3] * inner[3],
        outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
        outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
    ]
}

/// The image of `p` under `m`.
#[inline]
pub fn apply(m: &Affine64, p: (f64, f64)) -> (f64, f64) {
    (
        m[0] * p.0 + m[2] * p.1 + m[4],
        m[1] * p.0 + m[3] * p.1 + m[5],
    )
}

/// The inverse of `m`, or `None` when its determinant is below `1e-12` in
/// magnitude (a map that flattens a plane has no inverse; a near-singular
/// one would only amplify rounding).
pub fn invert(m: &Affine64) -> Option<Affine64> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return None;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples() -> Vec<Affine64> {
        let mut v = vec![
            IDENTITY,
            [0.0; 6],
            [2.0, 0.0, 0.0, 3.0, 10.0, -4.0],
            // Determinants either side of the singularity threshold.
            [1e-6, 0.0, 0.0, 1e-6, 1.0, 2.0],
            [1e-7, 0.0, 0.0, 1e-6, 1.0, 2.0],
            [1.0, 2.0, 2.0, 4.0, 0.0, 0.0],
            [
                std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
                -std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
                612.0,
                792.0,
            ],
            [1e-3, -1e3, 7.25, 1e-7, -0.1, 3e4],
        ];
        let mut s = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..300 {
            let mut m = [0.0f64; 6];
            for x in &mut m {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                *x = (s >> 11) as f64 / (1u64 << 53) as f64 * 40.0 - 20.0;
            }
            v.push(m);
        }
        v
    }

    fn bits(m: Affine64) -> [u64; 6] {
        m.map(f64::to_bits)
    }

    /// `slide_resolve::mul`, `pptx_export::geom::mul` and
    /// `dml_geom::live::mul` (before), which were the same text.
    fn old_mul(m: &Affine64, n: &Affine64) -> Affine64 {
        [
            m[0] * n[0] + m[2] * n[1],
            m[1] * n[0] + m[3] * n[1],
            m[0] * n[2] + m[2] * n[3],
            m[1] * n[2] + m[3] * n[3],
            m[0] * n[4] + m[2] * n[5] + m[4],
            m[1] * n[4] + m[3] * n[5] + m[5],
        ]
    }

    /// `draw_dxf::curves::Affine::then` (before).
    fn old_dxf_then(a: Affine64, b: Affine64) -> Affine64 {
        let [a1, b1, c1, d1, e1, f1] = a;
        let [a2, b2, c2, d2, e2, f2] = b;
        [
            a1 * a2 + c1 * b2,
            b1 * a2 + d1 * b2,
            a1 * c2 + c1 * d2,
            b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1,
            b1 * e2 + d1 * f2 + f1,
        ]
    }

    /// `pptx_export::geom::invert` and `dml_geom::live::invert` (before).
    fn old_invert(m: &Affine64) -> Option<Affine64> {
        let det = m[0] * m[3] - m[1] * m[2];
        if det.abs() < 1e-12 {
            return None;
        }
        let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
        Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
    }

    #[test]
    fn products_match_the_replaced_copies_bit_for_bit() {
        let all = samples();
        for a in &all {
            for b in all.iter().step_by(5) {
                let new = bits(multiply(a, b));
                assert_eq!(new, bits(old_mul(a, b)));
                assert_eq!(new, bits(old_dxf_then(*a, *b)));
            }
        }
    }

    #[test]
    fn point_maps_match_the_replaced_copies_bit_for_bit() {
        for m in samples() {
            for (x, y) in [(0.0, 0.0), (1.0, -1.0), (123.456, 7.0), (-1e4, 3e-3)] {
                let new = apply(&m, (x, y));
                // The three slide copies.
                let old = (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
                // `draw_dxf::curves::Affine::apply`.
                let [a, b, c, d, e, f] = m;
                let old_dxf = (a * x + c * y + e, b * x + d * y + f);
                assert_eq!(
                    (new.0.to_bits(), new.1.to_bits()),
                    (old.0.to_bits(), old.1.to_bits())
                );
                assert_eq!(
                    (new.0.to_bits(), new.1.to_bits()),
                    (old_dxf.0.to_bits(), old_dxf.1.to_bits())
                );
            }
        }
    }

    #[test]
    fn the_inverse_and_its_singularity_rule_match_the_replaced_copies() {
        let mut singular = 0;
        for m in samples() {
            let new = invert(&m);
            let old = old_invert(&m);
            assert_eq!(new.map(bits), old.map(bits));
            singular += new.is_none() as usize;
        }
        // The threshold cases are exercised, not skipped.
        assert!(singular >= 3);
        assert!(invert(&[1e-6, 0.0, 0.0, 1e-6, 0.0, 0.0]).is_some());
        assert!(invert(&[1e-7, 0.0, 0.0, 1e-7, 0.0, 0.0]).is_none());
    }

    #[test]
    fn identity_is_neutral_and_an_inverse_returns_it() {
        let m = [2.0, 1.0, -1.0, 3.0, 5.0, 6.0];
        assert_eq!(multiply(&IDENTITY, &m), m);
        assert_eq!(multiply(&m, &IDENTITY), m);
        let i = multiply(&m, &invert(&m).unwrap());
        for (got, want) in i.iter().zip(IDENTITY) {
            assert!((got - want).abs() < 1e-12);
        }
    }
}
