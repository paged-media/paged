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
//! so results are unchanged bit for bit. The inverse is not here: its
//! singularity test differs between callers (see the capability register).

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
}
