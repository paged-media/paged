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

//! visioncortex geometry → the engine's ANCHOR TRIPLE table.
//!
//! The engine (and draw-geometry's `AnchorTable`) speaks IDML
//! `PathPointType`: one on-curve `anchor` with an incoming `left` and an
//! outgoing `right` handle, a corner being the case where both handles
//! collapse onto the anchor. visioncortex speaks two other dialects —
//! `PathI32`/`PathF64` (a vertex ring) and `Spline` (`1 + 3n` control
//! points, cubic chain). This module is the ONE translation, so the two
//! never drift.
//!
//! CLOSURE. Both dialects repeat the first point as the last (a walked
//! boundary is a closed ring; the spline fitter closes the chain across
//! its cut points). The repeat is dropped here and the contour is
//! reported CLOSED — which is also all the wire can carry: the engine's
//! `framePath` value has `anchors` + `subpathStarts` and no
//! `subpathOpen`, and a traced region is a FILL boundary anyway.

use serde::Serialize;
use visioncortex::{CompoundPath, CompoundPathElement, PathF64, PathI32, PointF64, Spline};

/// One cubic path point in the engine's wire shape (pixel space).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Anchor {
    pub anchor: [f64; 2],
    pub left: [f64; 2],
    pub right: [f64; 2],
}

impl Anchor {
    /// A CORNER: both handles collapsed onto the anchor (the IDML
    /// convention a polygon vertex lowers to).
    pub fn corner(p: [f64; 2]) -> Self {
        Self {
            anchor: p,
            left: p,
            right: p,
        }
    }
}

/// One closed contour of a traced region, in PIXEL space.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Contour {
    pub anchors: Vec<Anchor>,
    /// Shoelace signed area over a flattened sampling of the contour, in
    /// px². SIGN = winding direction. Reported, not relied upon: the
    /// authoritative hole orientation is applied on the TS side by
    /// draw-geometry's `orientForNonZeroHoles`, which re-winds by nesting
    /// depth because the engine fills NON-ZERO.
    pub area: f64,
}

/// Samples per cubic when flattening for the area measure. Eight is far
/// past what a shoelace sign needs and cheap at these contour counts.
const AREA_SAMPLES: usize = 8;

fn point(p: &PointF64) -> [f64; 2] {
    [p.x, p.y]
}

fn near(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[0] - b[0]).abs() < 1e-9 && (a[1] - b[1]).abs() < 1e-9
}

/// Shoelace over the polyline `ring` (implicitly closed).
fn ring_area(ring: &[[f64; 2]]) -> f64 {
    if ring.len() < 3 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        j = i;
    }
    sum / 2.0
}

/// Flatten an anchor ring into a polyline and measure its signed area.
fn anchors_area(anchors: &[Anchor]) -> f64 {
    let mut ring: Vec<[f64; 2]> = Vec::with_capacity(anchors.len() * AREA_SAMPLES);
    for i in 0..anchors.len() {
        let a = anchors[i];
        let b = anchors[(i + 1) % anchors.len()];
        ring.push(a.anchor);
        // Straight segment (both handles collapsed) — no samples needed.
        if near(a.right, a.anchor) && near(b.left, b.anchor) {
            continue;
        }
        for s in 1..AREA_SAMPLES {
            let t = s as f64 / AREA_SAMPLES as f64;
            let u = 1.0 - t;
            let w = [u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t];
            ring.push([
                w[0] * a.anchor[0] + w[1] * a.right[0] + w[2] * b.left[0] + w[3] * b.anchor[0],
                w[0] * a.anchor[1] + w[1] * a.right[1] + w[2] * b.left[1] + w[3] * b.anchor[1],
            ]);
        }
    }
    ring_area(&ring)
}

/// Build a contour from a closed vertex ring (polygon mode). Returns
/// `None` for anything under three distinct vertices.
fn contour_from_ring(mut ring: Vec<[f64; 2]>) -> Option<Contour> {
    if ring.len() >= 2 && near(ring[0], ring[ring.len() - 1]) {
        ring.pop();
    }
    if ring.len() < 3 {
        return None;
    }
    let anchors: Vec<Anchor> = ring.into_iter().map(Anchor::corner).collect();
    let area = anchors_area(&anchors);
    Some(Contour { anchors, area })
}

/// Build a contour from a visioncortex `Spline` (`1 + 3n` control
/// points). Curve `k` is `points[3k .. 3k+3]`; the on-curve points are
/// the multiples of three.
fn contour_from_spline(spline: &Spline) -> Option<Contour> {
    let pts: Vec<[f64; 2]> = spline.points.iter().map(point).collect();
    if pts.len() < 4 || !(pts.len() - 1).is_multiple_of(3) {
        return None;
    }
    let curves = (pts.len() - 1) / 3;
    // Closed when the chain returns to its start — which is what the
    // fitter produces for a walked boundary. An UNCLOSED chain still
    // lowers as a closed contour (a fill boundary), with the straight
    // closing segment implied; that is the wire's only shape.
    let closed = near(pts[0], pts[pts.len() - 1]);
    let count = if closed { curves } else { curves + 1 };
    if count < 2 {
        return None;
    }
    let mut anchors: Vec<Anchor> = Vec::with_capacity(count);
    for k in 0..count {
        let idx = 3 * k;
        let p = pts[idx];
        // Outgoing handle: the first control point of curve k (absent for
        // the final anchor of an OPEN chain).
        let right = if idx + 1 < pts.len() { pts[idx + 1] } else { p };
        // Incoming handle: the last control point of curve k-1, wrapping
        // to the final curve for a closed chain's first anchor.
        let left = if idx >= 1 {
            pts[idx - 1]
        } else if closed {
            pts[pts.len() - 2]
        } else {
            p
        };
        anchors.push(Anchor {
            anchor: p,
            left,
            right,
        });
    }
    let area = anchors_area(&anchors);
    Some(Contour { anchors, area })
}

fn ring_i32(path: &PathI32) -> Vec<[f64; 2]> {
    path.path.iter().map(|p| [p.x as f64, p.y as f64]).collect()
}

fn ring_f64(path: &PathF64) -> Vec<[f64; 2]> {
    path.path.iter().map(point).collect()
}

/// Lower one visioncortex `CompoundPath` (an outer boundary followed by
/// its holes) into contours. Degenerate elements are dropped rather than
/// emitted as unrenderable stubs.
pub fn contours_of(compound: &CompoundPath) -> Vec<Contour> {
    compound
        .iter()
        .filter_map(|element| match element {
            CompoundPathElement::PathI32(p) => contour_from_ring(ring_i32(p)),
            CompoundPathElement::PathF64(p) => contour_from_ring(ring_f64(p)),
            CompoundPathElement::Spline(s) => contour_from_spline(s),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use visioncortex::{PointF64, PointI32};

    fn square_path() -> PathI32 {
        let mut path = PathI32::new();
        for p in [(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)] {
            path.add(PointI32 { x: p.0, y: p.1 });
        }
        path
    }

    #[test]
    fn a_walked_ring_drops_its_repeated_last_point_and_becomes_corners() {
        let contour = contour_from_ring(ring_i32(&square_path())).unwrap();
        assert_eq!(contour.anchors.len(), 4);
        for a in &contour.anchors {
            assert_eq!(a.left, a.anchor);
            assert_eq!(a.right, a.anchor);
        }
        assert!((contour.area.abs() - 16.0).abs() < 1e-9);
    }

    #[test]
    fn winding_shows_up_in_the_sign_of_the_area() {
        let cw = contour_from_ring(ring_i32(&square_path())).unwrap();
        let mut reversed = ring_i32(&square_path());
        reversed.reverse();
        let ccw = contour_from_ring(reversed).unwrap();
        assert!(cw.area.signum() != ccw.area.signum());
        assert!((cw.area.abs() - ccw.area.abs()).abs() < 1e-9);
    }

    #[test]
    fn a_closed_spline_wraps_the_first_anchors_incoming_handle() {
        // A 2-curve closed chain: 7 points, last == first.
        let mut spline = Spline::new(PointF64 { x: 0.0, y: 0.0 });
        spline.add(
            PointF64 { x: 4.0, y: 0.0 },
            PointF64 { x: 8.0, y: 4.0 },
            PointF64 { x: 8.0, y: 8.0 },
        );
        spline.add(
            PointF64 { x: 8.0, y: 12.0 },
            PointF64 { x: 4.0, y: 16.0 },
            PointF64 { x: 0.0, y: 0.0 },
        );
        let contour = contour_from_spline(&spline).unwrap();
        assert_eq!(contour.anchors.len(), 2);
        assert_eq!(contour.anchors[0].anchor, [0.0, 0.0]);
        assert_eq!(contour.anchors[0].right, [4.0, 0.0]);
        // The incoming handle wraps to the LAST control point of the
        // final curve — not to the anchor itself.
        assert_eq!(contour.anchors[0].left, [4.0, 16.0]);
        assert_eq!(contour.anchors[1].anchor, [8.0, 8.0]);
        assert_eq!(contour.anchors[1].left, [8.0, 4.0]);
        assert_eq!(contour.anchors[1].right, [8.0, 12.0]);
    }

    #[test]
    fn degenerate_geometry_is_dropped_not_emitted() {
        assert!(contour_from_ring(vec![[0.0, 0.0], [1.0, 1.0]]).is_none());
        assert!(contour_from_spline(&Spline::new(PointF64 { x: 0.0, y: 0.0 })).is_none());
    }

    #[test]
    fn a_curved_contour_measures_more_area_than_its_anchor_polygon() {
        // Four anchors bulging outwards: sampling the cubics has to see
        // more area than the inscribed square would.
        let mut spline = Spline::new(PointF64 { x: 0.0, y: 0.0 });
        spline.add(
            PointF64 { x: 6.0, y: -6.0 },
            PointF64 { x: 16.0, y: 4.0 },
            PointF64 { x: 10.0, y: 10.0 },
        );
        spline.add(
            PointF64 { x: 4.0, y: 16.0 },
            PointF64 { x: -6.0, y: 6.0 },
            PointF64 { x: 0.0, y: 0.0 },
        );
        let contour = contour_from_spline(&spline).unwrap();
        assert!(contour.area.abs() > 100.0, "area was {}", contour.area);
    }
}
