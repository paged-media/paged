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

//! Scribble: the fill drawn as one back-and-forth line.
//!
//! The outline is turned so the lines run horizontally, cut by
//! horizontal scan lines `spacing` apart, and the line runs from one end
//! of each scan line's outermost span to the far end of the next (past
//! the outline by `path_overlap`), its turns rounded by `curviness`.
//! The line is then turned back and outlined at `stroke_width`, so the
//! result is a filled outline the item paints with its fill. Every
//! variation is seeded. Illustrator's Scribble is a random construction
//! of its own; the replay compares coverage, not geometry (ADR 1042).

use kurbo::{Affine, BezPath, PathEl, Point, Shape as _, Vec2};
use paged_geom::kurbo_kernel::{StrokeCap, StrokeJoin};
use paged_model::vector_effect::ScribbleParams;

use crate::path::{outline_stroke, StrokeStyle};
use crate::rng::Rng;
use crate::shape::Shape;

/// The polygon edges of a flattened path.
fn edges(path: &BezPath) -> Vec<(Point, Point)> {
    let mut out = Vec::new();
    let mut start = Point::ZERO;
    let mut last = Point::ZERO;
    kurbo::flatten(path, 0.1, |el| match el {
        PathEl::MoveTo(p) => {
            start = p;
            last = p;
        }
        PathEl::LineTo(p) => {
            out.push((last, p));
            last = p;
        }
        PathEl::ClosePath => {
            if (last - start).hypot() > 1e-9 {
                out.push((last, start));
            }
            last = start;
        }
        _ => {}
    });
    out
}

/// The outermost span `[x0, x1]` of a horizontal line at `y`.
fn span(edges: &[(Point, Point)], y: f64) -> Option<(f64, f64)> {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for (a, b) in edges {
        if (a.y <= y && b.y > y) || (b.y <= y && a.y > y) {
            let t = (y - a.y) / (b.y - a.y);
            let x = a.x + t * (b.x - a.x);
            lo = lo.min(x);
            hi = hi.max(x);
        }
    }
    (lo < hi).then_some((lo, hi))
}

/// The scribble's centre line, in page space.
pub fn scribble_line(shape: &Shape, p: &ScribbleParams, salt: u64) -> Option<BezPath> {
    let spacing = f64::from(p.spacing).max(0.1);
    // Turn the outline so the lines run along +x.
    let turn = Affine::rotate(f64::from(p.angle_deg).to_radians());
    let back = turn.inverse();
    let local = back * shape.to_bezpath();
    let e = edges(&local);
    let b = local.bounding_box();
    if !(b.width() > 0.0 && b.height() > 0.0) {
        return None;
    }
    let mut rng = Rng::new(u64::from(p.seed) ^ salt ^ 0x5C21);
    let mut pts: Vec<Point> = Vec::new();
    let mut y = b.y0 + spacing / 2.0;
    let mut left = true;
    let mut guard = 0;
    while y < b.y1 && guard < 100_000 {
        guard += 1;
        if let Some((x0, x1)) = span(&e, y) {
            let over =
                f64::from(p.path_overlap) + rng.signed() * f64::from(p.path_overlap_variation);
            let x = if left { x0 - over } else { x1 + over };
            pts.push(Point::new(x, y));
            left = !left;
        }
        let step = spacing + rng.signed() * f64::from(p.spacing_variation);
        y += step.max(0.1);
    }
    if pts.len() < 2 {
        return None;
    }
    let mut path = BezPath::new();
    path.move_to(pts[0]);
    for w in pts.windows(2) {
        let (a, c) = (w[0], w[1]);
        let curvy = (f64::from(p.curviness_pct)
            + rng.signed() * f64::from(p.curviness_variation_pct))
        .clamp(0.0, 100.0)
            / 100.0;
        if curvy <= 0.0 {
            path.line_to(c);
        } else {
            // A round turn leaves each end across the scan lines; the
            // handles' length is the curviness share of the step.
            let lift = Vec2::new(0.0, (c.y - a.y) * curvy);
            path.curve_to(a + lift, c - lift, c);
        }
    }
    Some(turn * path)
}

/// Scribble: the outlined line.
pub fn scribble(shape: &Shape, p: &ScribbleParams, salt: u64) -> Shape {
    let Some(line) = scribble_line(shape, p, salt) else {
        return Shape::default();
    };
    let centre = Shape::from_bezpath(&line);
    outline_stroke(
        &centre,
        &StrokeStyle {
            weight: p.stroke_width.max(0.01),
            cap: StrokeCap::Round,
            join: StrokeJoin::Round,
            miter_limit: 4.0,
        },
    )
    .unwrap_or_default()
}
