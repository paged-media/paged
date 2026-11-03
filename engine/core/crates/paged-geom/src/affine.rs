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

//! The IDML affine in single precision, `[a, b, c, d, tx, ty]`: the 2x3
//! matrix `| a c tx |` over `| b d ty |`, a point `(x, y)` mapping to
//! `(a x + c y + tx, b x + d y + ty)`.
//!
//! One definition of the product and the point map the mutation engine, the
//! canvas and the renderer each wrote out. The expressions are the ones
//! those copies shared, term for term (`tests::*_match_the_replaced_copies`),
//! so results are unchanged bit for bit. The inverse's arithmetic is one
//! function ([`invert_if`]); the singularity test stays the caller's, because
//! it differs between them (`|det| < 1e-9` in the mutation engine and the
//! IDML writer, `< 1e-12` in the display list, zero or non-finite in the
//! canvas hit test) and a change would change which matrices invert.

/// `[a, b, c, d, tx, ty]`.
pub type Affine = [f32; 6];

/// The identity.
pub const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `outer ∘ inner`: `inner` applies first, a point `p` mapping to
/// `outer(inner(p))`. The IDML `ItemTransform` composition order.
#[inline]
pub fn multiply(outer: Affine, inner: Affine) -> Affine {
    [
        outer[0] * inner[0] + outer[2] * inner[1],
        outer[1] * inner[0] + outer[3] * inner[1],
        outer[0] * inner[2] + outer[2] * inner[3],
        outer[1] * inner[2] + outer[3] * inner[3],
        outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
        outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
    ]
}

/// The image of `(x, y)` under `m`.
#[inline]
pub fn apply(m: &Affine, x: f32, y: f32) -> (f32, f32) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// The inverse of `m`, or `None` when `singular(det)` holds for its
/// determinant `a d - b c`. The arithmetic is the one every caller wrote:
/// the reciprocal of the determinant scales the adjugate, and the
/// translation is `-(inverse linear part * t)`.
#[inline]
pub fn invert_if(m: &Affine, singular: impl FnOnce(f32) -> bool) -> Option<Affine> {
    let [a, b, c, d, tx, ty] = *m;
    let det = a * d - b * c;
    if singular(det) {
        return None;
    }
    let inv_det = 1.0 / det;
    let ia = d * inv_det;
    let ib = -b * inv_det;
    let ic = -c * inv_det;
    let id = a * inv_det;
    let itx = -(ia * tx + ic * ty);
    let ity = -(ib * tx + id * ty);
    Some([ia, ib, ic, id, itx, ity])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples() -> Vec<Affine> {
        let mut v = vec![
            IDENTITY,
            [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0, 3.0, 10.0, -4.0],
            [
                std::f32::consts::FRAC_1_SQRT_2,
                std::f32::consts::FRAC_1_SQRT_2,
                -std::f32::consts::FRAC_1_SQRT_2,
                std::f32::consts::FRAC_1_SQRT_2,
                612.0,
                792.0,
            ],
            [1e-3, -1e3, 7.25, 1e-7, -0.1, 3e4],
        ];
        let mut s = 0xD1B5_4A32_D192_ED03u64;
        for _ in 0..300 {
            let mut m = [0.0f32; 6];
            for x in &mut m {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                *x = ((s >> 11) as f64 / (1u64 << 53) as f64) as f32 * 40.0 - 20.0;
            }
            v.push(m);
        }
        v
    }

    /// `paged_mutate::path_math::affine_multiply` (before).
    fn old_mutate(a: Affine, b: Affine) -> Affine {
        [
            a[0] * b[0] + a[2] * b[1],
            a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3],
            a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4],
            a[1] * b[4] + a[3] * b[5] + a[5],
        ]
    }

    /// `paged_mutate::apply::symbol::multiply` (before).
    fn old_symbol(outer: Affine, inner: Affine) -> Affine {
        let [a, b, c, d, e, f] = outer;
        let [g, h, i, j, k, l] = inner;
        [
            a * g + c * h,
            b * g + d * h,
            a * i + c * j,
            b * i + d * j,
            a * k + c * l + e,
            b * k + d * l + f,
        ]
    }

    fn bits(m: Affine) -> [u32; 6] {
        m.map(f32::to_bits)
    }

    #[test]
    fn products_match_the_replaced_copies_bit_for_bit() {
        let all = samples();
        for a in &all {
            for b in all.iter().step_by(7) {
                let new = bits(multiply(*a, *b));
                assert_eq!(new, bits(old_mutate(*a, *b)));
                assert_eq!(new, bits(old_symbol(*a, *b)));
            }
        }
    }

    #[test]
    fn point_maps_match_the_replaced_copies_bit_for_bit() {
        for m in samples() {
            for (x, y) in [(0.0, 0.0), (1.0, -1.0), (123.456, 7.0), (-1e4, 3e-3)] {
                // `canvas::hit::apply_matrix` and `gesture::apply_affine`.
                let old = (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
                // `renderer::pipeline::geom::apply_matrix`.
                let [a, b, c, d, e, f] = m;
                let old2 = (a * x + c * y + e, b * x + d * y + f);
                let new = apply(&m, x, y);
                assert_eq!(
                    (new.0.to_bits(), new.1.to_bits()),
                    (old.0.to_bits(), old.1.to_bits())
                );
                assert_eq!(
                    (new.0.to_bits(), new.1.to_bits()),
                    (old2.0.to_bits(), old2.1.to_bits())
                );
            }
        }
    }

    #[test]
    fn identity_is_neutral() {
        let m = [2.0, 1.0, -1.0, 3.0, 5.0, 6.0];
        assert_eq!(multiply(IDENTITY, m), m);
        assert_eq!(multiply(m, IDENTITY), m);
    }

    /// The four replaced inverses, each with its own test, written out as
    /// they were (`paged_mutate::path_math::affine_inverse` and
    /// `idml_export::rewrite::invert_matrix` were the same text).
    fn old_inverse(m: &Affine, singular: impl Fn(f32) -> bool) -> Option<Affine> {
        let [a, b, c, d, tx, ty] = *m;
        let det = a * d - b * c;
        if singular(det) {
            return None;
        }
        let inv_det = 1.0 / det;
        let ia = d * inv_det;
        let ib = -b * inv_det;
        let ic = -c * inv_det;
        let id = a * inv_det;
        Some([ia, ib, ic, id, -(ia * tx + ic * ty), -(ib * tx + id * ty)])
    }

    #[test]
    fn the_inverse_matches_the_replaced_copies_under_each_singularity_test() {
        let mut all = samples();
        all.extend([
            // Determinants either side of 1e-9 and 1e-12, zero, and non-finite.
            [1e-4, 0.0, 0.0, 1e-5, 3.0, 4.0],
            [1e-4, 0.0, 0.0, 1e-4, 3.0, 4.0],
            [1e-6, 0.0, 0.0, 1e-6, 3.0, 4.0],
            [1e-7, 0.0, 0.0, 1e-7, 3.0, 4.0],
            [f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0],
            [f32::INFINITY, 0.0, 0.0, 1.0, 0.0, 0.0],
            [f32::MAX, 0.0, 0.0, f32::MAX, 1.0, 1.0],
            [1.0, 2.0, 2.0, 4.0, 0.0, 0.0],
        ]);
        type Test = (&'static str, fn(f32) -> bool);
        let tests: [Test; 3] = [
            ("1e-9", |d| d.abs() < 1e-9),
            ("1e-12", |d| d.abs() < 1e-12),
            ("zero or non-finite", |d| d == 0.0 || !d.is_finite()),
        ];
        for (name, singular) in tests {
            let mut none = 0;
            for m in &all {
                let new = invert_if(m, singular);
                let old = old_inverse(m, singular);
                assert_eq!(new.map(bits), old.map(bits), "{name}: {m:?}");
                none += new.is_none() as usize;
            }
            assert!(none >= 2, "{name} never reported a singular matrix");
        }
    }
}
