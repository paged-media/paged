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

//! Engine ADR 1006 — an even-odd outline as the non-zero outline that
//! fills the same area.
//!
//! Contours that cross neither themselves nor each other fill the same
//! area under both rules once every contour turns the way its nesting
//! depth says: even depths one way, odd depths the other, so each hole
//! cancels the area around it. Where contours cross, no turning of them
//! makes the rules agree (the middle of a five-pointed star is inside
//! under non-zero and outside under even-odd), and these functions say
//! so with `None`.
//!
//! The IDML export re-winds an even-odd frame through
//! [`even_odd_as_non_zero`] (IDML fills non-zero and has no attribute for
//! another rule), and reports the outline as lost when it returns `None`;
//! the renderer turns an even-odd shape of a multi-shape SVG clip the
//! same way through [`non_zero_turns`].

use crate::PathAnchor;

/// The edge budget of the crossing test; a shape with more is reported
/// as not convertible.
const MAX_EDGES: usize = 20_000;

/// For closed polygons `polys` (flattened contours, any orientation),
/// which to reverse (`true`) so the non-zero rule fills what the even-odd
/// rule does. `None` when two edges cross, a contour's own included, or
/// the shape has more than `MAX_EDGES` edges. A contour with no area
/// keeps its turn: it fills nothing under either rule.
pub fn non_zero_turns(polys: &[Vec<(f32, f32)>]) -> Option<Vec<bool>> {
    if any_crossing(polys)? {
        return None;
    }
    Some(
        polys
            .iter()
            .enumerate()
            .map(|(i, pts)| {
                let area = signed_area(pts);
                if pts.len() < 3 || area == 0.0 {
                    return false;
                }
                let depth = polys
                    .iter()
                    .enumerate()
                    .filter(|(j, other)| *j != i && other.len() >= 3 && inside(pts[0], other))
                    .count();
                (area > 0.0) != (depth % 2 == 0)
            })
            .collect(),
    )
}

/// The anchors of an even-odd outline re-wound so the non-zero rule
/// fills the same area, contour by contour in place (`subpath_starts`
/// and `subpath_open` still describe the result). `None` when contours
/// cross (see [`non_zero_turns`]).
pub fn even_odd_as_non_zero(
    anchors: &[PathAnchor],
    subpath_starts: &[usize],
    subpath_open: &[bool],
) -> Option<Vec<PathAnchor>> {
    let ranges = contour_ranges(anchors.len(), subpath_starts);
    let polys: Vec<Vec<(f32, f32)>> = ranges
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let closed = !subpath_open.get(i).copied().unwrap_or(false);
            flatten_anchors(&anchors[r.clone()], closed)
        })
        .collect();
    let turns = non_zero_turns(&polys)?;
    let mut out = anchors.to_vec();
    for (r, turn) in ranges.into_iter().zip(turns) {
        if turn {
            out[r.clone()].reverse();
            for a in &mut out[r] {
                std::mem::swap(&mut a.left, &mut a.right);
            }
        }
    }
    Some(out)
}

/// True when `even_odd_as_non_zero` can re-wind the outline, i.e. the
/// two rules can be made to agree.
pub fn even_odd_is_expressible(
    anchors: &[PathAnchor],
    subpath_starts: &[usize],
    subpath_open: &[bool],
) -> bool {
    even_odd_as_non_zero(anchors, subpath_starts, subpath_open).is_some()
}

/// The anchor range of each contour.
fn contour_ranges(len: usize, subpath_starts: &[usize]) -> Vec<std::ops::Range<usize>> {
    if subpath_starts.is_empty() {
        return std::iter::once(0..len).filter(|r| !r.is_empty()).collect();
    }
    subpath_starts
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let e = subpath_starts.get(i + 1).copied().unwrap_or(len);
            s.min(len)..e.min(len).max(s.min(len))
        })
        .collect()
}

/// A contour's points, each Bezier span flattened into eight chords. An
/// open contour's fill closes it with a straight line, which the polygon
/// does implicitly.
fn flatten_anchors(contour: &[PathAnchor], closed: bool) -> Vec<(f32, f32)> {
    const STEPS: usize = 8;
    let n = contour.len();
    let mut pts = Vec::new();
    if n == 0 {
        return pts;
    }
    let spans = if closed { n } else { n - 1 };
    pts.push(contour[0].anchor);
    for i in 0..spans {
        let (a, b) = (&contour[i], &contour[(i + 1) % n]);
        let (p0, p1, p2, p3) = (a.anchor, a.right, b.left, b.anchor);
        let straight = p1 == p0 && p2 == p3;
        if straight {
            pts.push(p3);
            continue;
        }
        for k in 1..=STEPS {
            let t = k as f32 / STEPS as f32;
            let u = 1.0 - t;
            let (c0, c1, c2, c3) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
            pts.push((
                c0 * p0.0 + c1 * p1.0 + c2 * p2.0 + c3 * p3.0,
                c0 * p0.1 + c1 * p1.1 + c2 * p2.1 + c3 * p3.1,
            ));
        }
    }
    // A closing point equal to the first is the same vertex.
    if pts.len() > 1 && pts.first() == pts.last() {
        pts.pop();
    }
    pts
}

/// Twice the signed area of the closed polygon `pts`.
pub fn signed_area(pts: &[(f32, f32)]) -> f32 {
    let n = pts.len();
    (0..n)
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum()
}

/// True when segments `a0→a1` and `b0→b1` cross (touching ends excluded).
fn cross(a0: (f32, f32), a1: (f32, f32), b0: (f32, f32), b1: (f32, f32)) -> bool {
    let orient = |p: (f32, f32), q: (f32, f32), r: (f32, f32)| {
        (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0)
    };
    let (d1, d2) = (orient(b0, b1, a0), orient(b0, b1, a1));
    let (d3, d4) = (orient(a0, a1, b0), orient(a0, a1, b1));
    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

/// True when any two edges of `polys` (closed polygons) cross, adjacent
/// edges of one polygon aside. A sweep over the edges sorted by their
/// left end. `None` past the edge budget.
fn any_crossing(polys: &[Vec<(f32, f32)>]) -> Option<bool> {
    struct Edge {
        poly: usize,
        idx: usize,
        a: (f32, f32),
        b: (f32, f32),
        x0: f32,
        x1: f32,
    }
    let mut edges = Vec::new();
    for (pi, pts) in polys.iter().enumerate() {
        let n = pts.len();
        for i in 0..n {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            edges.push(Edge {
                poly: pi,
                idx: i,
                a,
                b,
                x0: a.0.min(b.0),
                x1: a.0.max(b.0),
            });
        }
    }
    if edges.len() > MAX_EDGES {
        return None;
    }
    edges.sort_by(|p, q| p.x0.total_cmp(&q.x0));
    for i in 0..edges.len() {
        let e = &edges[i];
        for f in &edges[i + 1..] {
            if f.x0 > e.x1 {
                break;
            }
            if e.poly == f.poly {
                let n = polys[e.poly].len();
                let (i, j) = (e.idx, f.idx);
                if (i + 1) % n == j || (j + 1) % n == i {
                    continue;
                }
            }
            if cross(e.a, e.b, f.a, f.b) {
                return Some(true);
            }
        }
    }
    Some(false)
}

/// Even-odd point-in-polygon.
fn inside(p: (f32, f32), pts: &[(f32, f32)]) -> bool {
    let n = pts.len();
    let mut c = false;
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
            c = !c;
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corner(x: f32, y: f32) -> PathAnchor {
        PathAnchor {
            anchor: (x, y),
            left: (x, y),
            right: (x, y),
        }
    }

    /// A square contour, clockwise in a y-down space or not.
    fn square(x: f32, y: f32, s: f32, clockwise: bool) -> Vec<PathAnchor> {
        let mut c = vec![
            corner(x, y),
            corner(x + s, y),
            corner(x + s, y + s),
            corner(x, y + s),
        ];
        if !clockwise {
            c.reverse();
        }
        c
    }

    fn turn(c: &[PathAnchor]) -> f32 {
        signed_area(&flatten_anchors(c, true))
    }

    #[test]
    #[allow(non_snake_case)]
    fn nested_contours_alternate_their_turn__feat__frames_paths_fill_rule_even_odd() {
        // Both clockwise: non-zero would fill the hole, even-odd does not.
        let mut anchors = square(0.0, 0.0, 10.0, true);
        anchors.extend(square(3.0, 3.0, 4.0, true));
        let out = even_odd_as_non_zero(&anchors, &[0, 4], &[]).unwrap();
        assert!(turn(&out[..4]) > 0.0);
        assert!(
            turn(&out[4..]) < 0.0,
            "the hole turns against the outer contour"
        );
        // Already opposed: unchanged.
        let mut opposed = square(0.0, 0.0, 10.0, true);
        opposed.extend(square(3.0, 3.0, 4.0, false));
        let same = even_odd_as_non_zero(&opposed, &[0, 4], &[]).unwrap();
        assert!(same
            .iter()
            .zip(&opposed)
            .all(|(a, b)| a.anchor == b.anchor && a.left == b.left && a.right == b.right));
    }

    #[test]
    fn reversing_a_curved_contour_swaps_its_handles() {
        // c -> b straight, b -> a bulging outward, a -> c straight.
        let a = PathAnchor {
            anchor: (0.0, 0.0),
            left: (3.0, -2.0),
            right: (0.0, 0.0),
        };
        let b = PathAnchor {
            anchor: (10.0, 0.0),
            left: (10.0, 0.0),
            right: (7.0, -2.0),
        };
        let c = corner(5.0, 8.0);
        // Counter-clockwise outer contour (negative area): reversed.
        let anchors = vec![c, b, a];
        assert!(turn(&anchors) < 0.0);
        let out = even_odd_as_non_zero(&anchors, &[], &[]).unwrap();
        assert_eq!(out[0].anchor, a.anchor);
        assert_eq!((out[0].left, out[0].right), (a.right, a.left));
        assert!(turn(&out) > 0.0);
    }

    #[test]
    #[allow(non_snake_case)]
    fn crossing_contours_are_refused__feat__frames_paths_fill_rule_even_odd() {
        let mut anchors = square(0.0, 0.0, 10.0, true);
        anchors.extend(square(5.0, 5.0, 10.0, true));
        assert!(even_odd_as_non_zero(&anchors, &[0, 4], &[]).is_none());
        // A self-crossing star (one contour) cannot be re-wound either.
        let star: Vec<PathAnchor> = (0..5)
            .map(|k| {
                let a = std::f32::consts::PI * (-0.5 + 0.8 * k as f32);
                corner(50.0 + 40.0 * a.cos(), 50.0 + 40.0 * a.sin())
            })
            .collect();
        assert!(!even_odd_is_expressible(&star, &[], &[]));
    }
}
