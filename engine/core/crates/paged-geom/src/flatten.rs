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

//! Fixed-step Bezier sampling in single precision: the one definition of
//! the uniform-parameter flattener the renderer, the composer and the text
//! shaper each had a copy of (capability register, "Geometry and vector").
//!
//! Point `i` of an `n`-step curve sits at `t = i / n`, evaluated in the
//! Bernstein form with the weights `(1-t)^3`, `3(1-t)^2 t`, `3(1-t) t^2`
//! and `t^3`, summed left to right in `f32`. The expression order is part
//! of the contract: every copy this replaced evaluated it the same way, so
//! callers keep their output bit for bit (`tests::*_match_the_replaced_copies`
//! holds each old form against this one).
//!
//! Tolerance-driven flattening (the step count from a chord error, or
//! kurbo's adaptive `flatten`) is a different job: the step count stays the
//! caller's choice (`paged_text::cubic_steps_for_tolerance`), this module
//! only samples.

/// A point of the page, `(x, y)` in single precision.
pub type Pt = (f32, f32);

/// The point at parameter `t` of the cubic `p0 → (c1, c2) → p1`.
#[inline]
pub fn cubic_point(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: f32) -> Pt {
    let mt = 1.0 - t;
    let w0 = mt * mt * mt;
    let w1 = 3.0 * mt * mt * t;
    let w2 = 3.0 * mt * t * t;
    let w3 = t * t * t;
    (
        w0 * p0.0 + w1 * c1.0 + w2 * c2.0 + w3 * p1.0,
        w0 * p0.1 + w1 * c1.1 + w2 * c2.1 + w3 * p1.1,
    )
}

/// The point at parameter `t` of the quadratic `p0 → c → p1`.
#[inline]
pub fn quad_point(p0: Pt, c: Pt, p1: Pt, t: f32) -> Pt {
    let mt = 1.0 - t;
    (
        mt * mt * p0.0 + 2.0 * mt * t * c.0 + t * t * p1.0,
        mt * mt * p0.1 + 2.0 * mt * t * c.1 + t * t * p1.1,
    )
}

/// Calls `emit` with the `steps` points after `p0` of the cubic (the start
/// point excluded, the end point last). `steps` below one counts as one.
#[inline]
pub fn sample_cubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, steps: u32, mut emit: impl FnMut(Pt)) {
    let n = steps.max(1);
    for i in 1..=n {
        emit(cubic_point(p0, c1, c2, p1, i as f32 / n as f32));
    }
}

/// Calls `emit` with the `steps` points after `p0` of the quadratic.
#[inline]
pub fn sample_quad(p0: Pt, c: Pt, p1: Pt, steps: u32, mut emit: impl FnMut(Pt)) {
    let n = steps.max(1);
    for i in 1..=n {
        emit(quad_point(p0, c, p1, i as f32 / n as f32));
    }
}

/// Appends the cubic's intermediate and end points to `out`; the caller
/// has pushed `p0`.
pub fn flatten_cubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, steps: u32, out: &mut Vec<Pt>) {
    sample_cubic(p0, c1, c2, p1, steps, |p| out.push(p));
}

/// Appends the quadratic's intermediate and end points to `out`.
pub fn flatten_quad(p0: Pt, c: Pt, p1: Pt, steps: u32, out: &mut Vec<Pt>) {
    sample_quad(p0, c, p1, steps, |p| out.push(p));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Curves from straight to cusped, loops and tiny to page-sized.
    fn curves() -> Vec<[Pt; 4]> {
        let mut v = vec![
            [(0.0, 0.0), (0.0, 0.0), (10.0, 10.0), (10.0, 10.0)],
            [(0.0, 0.0), (3.0, 0.0), (7.0, 0.0), (10.0, 0.0)],
            [(0.0, 0.0), (100.0, 0.0), (0.0, 100.0), (100.0, 100.0)],
            [(0.0, 0.0), (200.0, 100.0), (-100.0, 100.0), (100.0, 0.0)],
            [(1.0, 1.0), (1.0, 1.0), (1.0, 1.0), (1.0, 1.0)],
            [(-0.1, 0.3), (0.7, -1.9), (2.3, 4.1), (-3.3, 0.07)],
            [
                (612.0, 792.0),
                (0.552_284_8 * 300.0, 5.5),
                (17.25, 1e3),
                (0.001, 0.002),
            ],
        ];
        // A spread of pseudo-random curves (fixed xorshift, no dependency).
        let mut s = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            ((s >> 11) as f64 / (1u64 << 53) as f64) as f32 * 2000.0 - 1000.0
        };
        for _ in 0..200 {
            v.push([
                (next(), next()),
                (next(), next()),
                (next(), next()),
                (next(), next()),
            ]);
        }
        v
    }

    fn bits(p: Pt) -> (u32, u32) {
        (p.0.to_bits(), p.1.to_bits())
    }

    /// `stroke_geom::flatten_path` and `mask::flatten_path_px` (before):
    /// the weights written out in the sum, `i / n` steps.
    fn old_inline_cubic(p: [Pt; 4], n: u32) -> Vec<Pt> {
        let [(p0x, p0y), (cx1, cy1), (cx2, cy2), (x, y)] = p;
        (1..=n)
            .map(|i| {
                let t = i as f32 / n as f32;
                let mt = 1.0 - t;
                let px = mt * mt * mt * p0x
                    + 3.0 * mt * mt * t * cx1
                    + 3.0 * mt * t * t * cx2
                    + t * t * t * x;
                let py = mt * mt * mt * p0y
                    + 3.0 * mt * mt * t * cy1
                    + 3.0 * mt * t * t * cy2
                    + t * t * t * y;
                (px, py)
            })
            .collect()
    }

    /// `placed_svg::flatten` and `winding::flatten_anchors` (before).
    fn old_tuple_weights(p: [Pt; 4], n: u32) -> Vec<Pt> {
        let [cur, (cx1, cy1), (cx2, cy2), (x, y)] = p;
        (1..=n)
            .map(|i| {
                let t = i as f32 / n as f32;
                let u = 1.0 - t;
                let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                (
                    a * cur.0 + b * cx1 + c * cx2 + d * x,
                    a * cur.1 + b * cy1 + c * cy2 + d * y,
                )
            })
            .collect()
    }

    /// `paged_text::flatten_cubic` and `dash_fit::flatten_cubic` (before).
    fn old_named_weights(p: [Pt; 4], n: u32) -> Vec<Pt> {
        let [p0, c1, c2, p1] = p;
        (1..=n)
            .map(|k| {
                let t = k as f32 / n as f32;
                let mt = 1.0 - t;
                let w0 = mt * mt * mt;
                let w1 = 3.0 * mt * mt * t;
                let w2 = 3.0 * mt * t * t;
                let w3 = t * t * t;
                (
                    w0 * p0.0 + w1 * c1.0 + w2 * c2.0 + w3 * p1.0,
                    w0 * p0.1 + w1 * c1.1 + w2 * c2.1 + w3 * p1.1,
                )
            })
            .collect()
    }

    /// `image-js masking::flatten` (before): weights in an array.
    fn old_array_weights(p: [Pt; 4], n: u32) -> Vec<Pt> {
        let [a, b, c, d] = p.map(|q| [q.0, q.1]);
        (1..=n)
            .map(|s| {
                let t = s as f32 / n as f32;
                let u = 1.0 - t;
                let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
                (
                    w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * d[0],
                    w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * d[1],
                )
            })
            .collect()
    }

    #[test]
    fn cubics_match_the_replaced_copies_bit_for_bit() {
        for p in curves() {
            for n in [1u32, 2, 3, 8, 12, 16, 37, 256] {
                let mut new = Vec::new();
                flatten_cubic(p[0], p[1], p[2], p[3], n, &mut new);
                assert_eq!(new.len(), n as usize);
                for old in [
                    old_inline_cubic(p, n),
                    old_tuple_weights(p, n),
                    old_named_weights(p, n),
                    old_array_weights(p, n),
                ] {
                    let a: Vec<_> = new.iter().copied().map(bits).collect();
                    let b: Vec<_> = old.iter().copied().map(bits).collect();
                    assert_eq!(a, b, "curve {p:?} at {n} steps");
                }
            }
        }
    }

    #[test]
    fn quads_match_the_replaced_copies_bit_for_bit() {
        for p in curves() {
            let (p0, c, p1) = (p[0], p[1], p[2]);
            for n in [1u32, 2, 8, 12, 33] {
                let mut new = Vec::new();
                flatten_quad(p0, c, p1, n, &mut new);
                // `stroke_geom` (u32 steps) and `placed_svg` (usize steps).
                let old: Vec<Pt> = (1..=n)
                    .map(|i| {
                        let t = i as f32 / n as f32;
                        let mt = 1.0 - t;
                        (
                            mt * mt * p0.0 + 2.0 * mt * t * c.0 + t * t * p1.0,
                            mt * mt * p0.1 + 2.0 * mt * t * c.1 + t * t * p1.1,
                        )
                    })
                    .collect();
                assert_eq!(
                    new.iter().copied().map(bits).collect::<Vec<_>>(),
                    old.iter().copied().map(bits).collect::<Vec<_>>(),
                    "quad {p0:?} {c:?} {p1:?} at {n} steps"
                );
            }
        }
    }

    #[test]
    fn the_last_sample_is_the_end_point_and_zero_steps_count_as_one() {
        for p in curves() {
            let mut out = Vec::new();
            flatten_cubic(p[0], p[1], p[2], p[3], 0, &mut out);
            assert_eq!(out.len(), 1);
            assert_eq!(bits(out[0]), bits(p[3]));
        }
    }
}
