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

//! paged-vector-fx's integration tests (engine ADR 1042). Tests named
//! `*__feat__effects_transparency_live_vector_effects` are the evidence
//! of the feature row `effects-transparency.live-vector-effects`.

#![allow(non_snake_case)]

mod bake;
mod effects;
mod illustrator_oracle;
mod properties;

use paged_model::PathAnchor;
use paged_vector_fx::Shape;

/// A closed polygon of corner anchors.
pub fn poly(points: &[(f32, f32)]) -> Shape {
    let anchors: Vec<PathAnchor> = points
        .iter()
        .map(|p| PathAnchor {
            anchor: *p,
            left: *p,
            right: *p,
        })
        .collect();
    Shape::from_anchors(&anchors, &[], &[])
}

/// The 100 × 60 rectangle at (100, 100) the oracle uses.
pub fn rect() -> Shape {
    poly(&[
        (100.0, 100.0),
        (200.0, 100.0),
        (200.0, 160.0),
        (100.0, 160.0),
    ])
}

/// The 3-4-5 triangle the oracle uses.
pub fn tri() -> Shape {
    poly(&[(100.0, 100.0), (220.0, 100.0), (100.0, 190.0)])
}

/// Signed area of a shape (positive clockwise on a Y-down page), exact
/// for cubics.
pub fn area(s: &Shape) -> f64 {
    let mut sum = 0.0;
    for c in &s.contours {
        for seg in c.segments() {
            let (p0, p1, p2, p3) = (seg.p0, seg.p1, seg.p2, seg.p3);
            let cr = |a: kurbo::Point, b: kurbo::Point| a.x * b.y - a.y * b.x;
            sum += (6.0 * cr(p0, p1)
                + 3.0 * cr(p0, p2)
                + cr(p0, p3)
                + 3.0 * cr(p1, p2)
                + 3.0 * cr(p1, p3)
                + 6.0 * cr(p2, p3))
                / 20.0;
        }
    }
    sum
}

pub fn anchor_count(s: &Shape) -> usize {
    s.contours.iter().map(|c| c.nodes.len()).sum()
}
