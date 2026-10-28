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

//! The planar-arrangement workload (engine ADR 1019): many overlapping
//! rectangles and circles, generated exactly as the Illustrator probe
//! `modules/draw/scripts/illustrator/probes/divide-many.jsx` generates
//! them — the same Park–Miller sequence, the same 1/4 pt rounding, the
//! cases drawn one after the other (20, then 50, then 100 shapes) — so
//! `divide(100)` is the input Illustrator divided into 1057 pieces.
//!
//! The scenario's expensive paths: the collision pass (every curve pair
//! whose boxes overlap is clipped) and the face walk (one sort per
//! vertex, one boundary walk, one point test per face).

use paged_model::PathAnchor;

/// One input: an anchor table and its subpath starts.
pub type Input = (Vec<PathAnchor>, Vec<usize>);

/// The probe's case of `count` shapes (20, 50 or 100), BACK to front
/// (the probe's paint order). Any other count continues the sequence
/// after the three cases.
pub fn divide_back_to_front(count: usize) -> Vec<Input> {
    let cases: &[usize] = match count {
        20 => &[20],
        50 => &[20, 50],
        100 => &[20, 50, 100],
        _ => &[20, 50, 100, count],
    };
    let mut seq = cases.iter().flat_map(|n| 0..*n);
    let all: Vec<usize> = (&mut seq).collect();
    let shapes = shapes(&all);
    shapes[shapes.len() - count..].to_vec()
}

/// One shape per entry of `indices` — each entry the shape's index
/// WITHIN its case (even = rectangle, odd = circle) — drawing from one
/// running sequence.
fn shapes(indices: &[usize]) -> Vec<Input> {
    let mut seed: f64 = 20_261_025.0;
    let mut next = move || {
        seed = (seed * 16_807.0) % 2_147_483_647.0;
        seed / 2_147_483_647.0
    };
    let q = |v: f64| (v * 4.0).round() / 4.0;
    const K: f64 = 0.552_284_749_8;
    let corner = |x: f64, y: f64| PathAnchor {
        anchor: (x as f32, y as f32),
        left: (x as f32, y as f32),
        right: (x as f32, y as f32),
    };
    let p = |x: f64, y: f64| (x as f32, y as f32);
    indices
        .iter()
        .map(|&i| {
            let x = q(40.0 + next() * 340.0);
            let y = q(40.0 + next() * 340.0);
            if i % 2 == 0 {
                let w = q(20.0 + next() * 80.0);
                let h = q(20.0 + next() * 80.0);
                (
                    vec![
                        corner(x, y),
                        corner(x + w, y),
                        corner(x + w, y + h),
                        corner(x, y + h),
                    ],
                    vec![0],
                )
            } else {
                let r = q(12.0 + next() * 40.0);
                let (cx, cy) = (x + r, y + r);
                let k = q(r * K);
                (
                    vec![
                        PathAnchor {
                            anchor: p(cx + r, cy),
                            left: p(cx + r, cy - k),
                            right: p(cx + r, cy + k),
                        },
                        PathAnchor {
                            anchor: p(cx, cy + r),
                            left: p(cx + k, cy + r),
                            right: p(cx - k, cy + r),
                        },
                        PathAnchor {
                            anchor: p(cx - r, cy),
                            left: p(cx - r, cy + k),
                            right: p(cx - r, cy - k),
                        },
                        PathAnchor {
                            anchor: p(cx, cy - r),
                            left: p(cx - k, cy - r),
                            right: p(cx + k, cy - r),
                        },
                    ],
                    vec![0],
                )
            }
        })
        .collect()
}

/// The same shapes TOP to bottom — the order the Pathfinder verbs take.
pub fn divide(count: usize) -> Vec<Input> {
    let mut v = divide_back_to_front(count);
    v.reverse();
    v
}
