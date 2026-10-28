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

//! Offsets and variable-width outlines over whole paths (engine ADR 1019).
//!
//! [`crate::kurbo_kernel`] offsets ONE closed contour and outlines a
//! constant-width stroke. This module builds on it for the shapes a
//! document actually holds:
//!
//! - [`offset_path`] — any path: a compound of closed contours is offset
//!   per contour with the role its nesting gives it (an outer contour
//!   outsets when the shape grows, a hole insets, an island in a hole
//!   outsets again) and the pieces are recombined depth by depth with the
//!   Pathfinder booleans; an open contour becomes the two-sided band it
//!   always was, or — with [`OffsetSide::Left`] / [`OffsetSide::Right`] —
//!   ONE parallel open path on that side, with the join the caller asked
//!   for at its corners.
//! - [`variable_width_outline`] — a variable-width stroke outline built
//!   per vertex, with caps at open ends and joins (miter with limit,
//!   round, bevel) at every corner, for every subpath.
//!
//! Directions are stated ON THE PAGE (y down): the LEFT of a path is the
//! left of someone walking along it as it is drawn on screen.

use kurbo::{Arc as KurboArc, BezPath, CubicBez, ParamCurve, Point, Shape, Vec2};
use paged_model::PathAnchor;

use crate::kurbo_kernel::{
    anchors_to_bezpath, bezpath_to_anchors, offset_closed_path, outline_stroke, StrokeCap,
    StrokeJoin,
};
use crate::pathfinder::{pathfinder_boolean, PathfinderKind};

/// Which side of an OPEN path [`offset_path`] offsets it to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OffsetSide {
    /// Both sides: the closed band of width `2·|δ|` (the default, and
    /// what Illustrator's Offset Path does with an open path: butt ends,
    /// round ones for a round join).
    #[default]
    Both,
    /// One open parallel path, `δ` to the left of the direction of travel
    /// on the page (a negative `δ` lands on the right).
    Left,
    /// One open parallel path, `δ` to the right.
    Right,
}

impl OffsetSide {
    /// The wire's spelling: `"both"` (or absent), `"left"`, `"right"`.
    pub fn parse(s: Option<&str>) -> Option<OffsetSide> {
        match s {
            None | Some("both") | Some("") => Some(OffsetSide::Both),
            Some("left") => Some(OffsetSide::Left),
            Some("right") => Some(OffsetSide::Right),
            _ => None,
        }
    }
}

type PathTriple = (Vec<PathAnchor>, Vec<usize>, Vec<bool>);

const EPS: f64 = 1e-6;
/// Arc flattening accuracy for round joins and caps (they are emitted as
/// cubic arcs; this is the arc-to-cubic error bound).
const ARC_TOLERANCE: f64 = 0.01;
/// A turn smaller than this (radians) at an anchor is no corner.
const SMOOTH_TURN: f64 = 0.017;
/// Flattening tolerance of the variable-width centreline, pt.
const FLATTEN: f64 = 0.05;

fn pt(p: (f32, f32)) -> Point {
    Point::new(f64::from(p.0), f64::from(p.1))
}

/// The page-space LEFT normal of a direction: on a y-down page, walking
/// along `+x`, left is `−y`.
fn left_of(t: Vec2) -> Vec2 {
    Vec2::new(t.y, -t.x)
}

fn unit(v: Vec2) -> Option<Vec2> {
    let len = v.hypot();
    (len > EPS && len.is_finite()).then(|| v / len)
}

/// Subpath spans `(start, end, open)` of an anchor table.
fn spans(n: usize, starts: &[usize], open: &[bool]) -> Vec<(usize, usize, bool)> {
    let starts: Vec<usize> = if starts.is_empty() {
        vec![0]
    } else {
        starts.to_vec()
    };
    starts
        .iter()
        .enumerate()
        .filter_map(|(i, &s)| {
            let e = starts.get(i + 1).copied().unwrap_or(n);
            (s < e && e <= n).then(|| (s, e, open.get(i).copied().unwrap_or(false)))
        })
        .collect()
}

fn cubic_of(a: &PathAnchor, b: &PathAnchor) -> CubicBez {
    CubicBez::new(pt(a.anchor), pt(a.right), pt(b.left), pt(b.anchor))
}

/// Unit tangent at the start / end of a cubic, falling back past
/// collapsed handles to the chord.
fn start_tangent(c: &CubicBez) -> Option<Vec2> {
    unit(c.p1 - c.p0)
        .or_else(|| unit(c.p2 - c.p0))
        .or_else(|| unit(c.p3 - c.p0))
}

fn end_tangent(c: &CubicBez) -> Option<Vec2> {
    unit(c.p3 - c.p2)
        .or_else(|| unit(c.p3 - c.p1))
        .or_else(|| unit(c.p3 - c.p0))
}

/// Signed turn from `a` to `b` (radians, positive = toward `+y` of
/// `a`'s algebraic left, i.e. clockwise on the page).
fn turn(a: Vec2, b: Vec2) -> f64 {
    a.cross(b).atan2(a.dot(b))
}

/// Intersection of the lines `p + s·u` and `q + t·v`: `(point, s, t)`.
fn line_intersection(p: Point, u: Vec2, q: Point, v: Vec2) -> Option<(Point, f64, f64)> {
    let den = u.cross(v);
    if den.abs() < 1e-12 {
        return None;
    }
    let w = q - p;
    let s = w.cross(v) / den;
    let t = w.cross(u) / den;
    Some((p + u * s, s, t))
}

/// Append an arc around `centre` from the current point (which must lie
/// on it) sweeping `sweep` radians, as cubics.
fn arc_to(path: &mut BezPath, centre: Point, radius: f64, from: Vec2, sweep: f64) {
    if radius <= EPS || sweep.abs() < 1e-9 {
        return;
    }
    let start = from.y.atan2(from.x);
    let arc = KurboArc::new(centre, Vec2::new(radius, radius), start, sweep, 0.0);
    arc.to_cubic_beziers(ARC_TOLERANCE, |p1, p2, p| path.curve_to(p1, p2, p));
}

/// The join on the OUTER side of a corner at `v`: the offset edges end
/// at `e` (incoming, direction `t_in`) and resume at `s` (outgoing,
/// `t_out`), both `r` from `v`. Appends to `path`, whose current point is
/// `e`, ending at `s`.
#[allow(clippy::too_many_arguments)]
fn outer_join(
    path: &mut BezPath,
    v: Point,
    r: f64,
    e: Point,
    s: Point,
    t_in: Vec2,
    t_out: Vec2,
    join: StrokeJoin,
    miter_limit: f64,
) {
    let phi = turn(t_in, t_out);
    match join {
        StrokeJoin::Miter => {
            // Stroke rule: mitred while 1/cos(φ/2) ≤ limit (the miter
            // length over the half-width), bevelled past it.
            let ratio = 1.0 / (phi / 2.0).cos().abs().max(1e-12);
            if ratio <= miter_limit.max(1.0) {
                if let Some((x, _, _)) = line_intersection(e, t_in, s, t_out) {
                    path.line_to(x);
                }
            }
            path.line_to(s);
        }
        StrokeJoin::Round => {
            arc_to(path, v, r, e - v, phi);
            path.line_to(s);
        }
        StrokeJoin::Bevel => path.line_to(s),
    }
}

// ---------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------

/// Offset Path over a whole path. `delta > 0` grows a closed shape
/// (outsets it) and `delta < 0` shrinks it; open contours follow `side`.
/// `None` when nothing survives (an inset past the medial axis of every
/// contour, degenerate input).
pub fn offset_path(
    anchors: &[PathAnchor],
    subpath_starts: &[usize],
    subpath_open: &[bool],
    delta: f32,
    join: StrokeJoin,
    miter_limit: f32,
    side: OffsetSide,
) -> Option<PathTriple> {
    if anchors.is_empty() || delta == 0.0 {
        return None;
    }
    let all = spans(anchors.len(), subpath_starts, subpath_open);
    let closed: Vec<&[PathAnchor]> = all
        .iter()
        .filter(|(s, e, open)| !open && e - s >= 3)
        .map(|(s, e, _)| &anchors[*s..*e])
        .collect();
    let open: Vec<&[PathAnchor]> = all
        .iter()
        .filter(|(s, e, open)| *open && e - s >= 2)
        .map(|(s, e, _)| &anchors[*s..*e])
        .collect();

    // One closed contour and nothing else: the single-contour kernel,
    // unchanged.
    if closed.len() == 1 && open.is_empty() {
        return offset_closed_path(closed[0], &[0], &[false], delta, join, miter_limit);
    }

    let region = if closed.is_empty() {
        None
    } else {
        offset_compound(&closed, delta, join, miter_limit)
    };

    match side {
        OffsetSide::Both => {
            // Open contours: the two-sided band, unioned with the region.
            // Its ends follow the join, as Illustrator's do (recorded,
            // `offset-compound` oracle): round for a round join, butt
            // otherwise.
            let cap = if join == StrokeJoin::Round {
                StrokeCap::Round
            } else {
                StrokeCap::Butt
            };
            let mut pieces: Vec<(Vec<PathAnchor>, Vec<usize>)> = Vec::new();
            if let Some((a, s, _)) = region {
                pieces.push((a, s));
            }
            for run in &open {
                if let Some((a, s, _)) = outline_stroke(
                    run,
                    &[0],
                    &[true],
                    2.0 * delta.abs(),
                    cap,
                    join,
                    miter_limit,
                ) {
                    pieces.push(resolve_nonzero(&(a, s)));
                }
            }
            match pieces.len() {
                0 => None,
                // A lone closed region is already resolved; a band is the
                // stroker's raw outline, whose inner joins loop through
                // the path (fine for a non-zero fill, wrong for a shape
                // someone edits), so it is resolved by a Unite of itself —
                // Illustrator hands back the clean outline too.
                1 if open.is_empty() => {
                    let (a, s) = pieces.pop()?;
                    let o = vec![false; s.len().max(1)];
                    Some((a, s, o))
                }
                1 => finish_region(pieces.pop()?),
                _ => finish_region(pathfinder_boolean(&pieces, PathfinderKind::Union)),
            }
        }
        OffsetSide::Left | OffsetSide::Right => {
            let d = if side == OffsetSide::Left {
                f64::from(delta)
            } else {
                -f64::from(delta)
            };
            let (mut a, mut s, mut o) = region.unwrap_or_default();
            for run in &open {
                if let Some(parallel) = one_sided_offset(run, d, join, f64::from(miter_limit)) {
                    s.push(a.len());
                    o.push(true);
                    a.extend(parallel);
                }
            }
            (!a.is_empty()).then_some((a, s, o))
        }
    }
}

/// The region a NON-ZERO fill of `path` paints, as clean contours: the
/// stroker's inner-join loops and any other self-overlap resolved
/// (`flo_curves`' `path_remove_interior_points`, on the boolean grid —
/// C-21).
fn resolve_nonzero((a, s): &(Vec<PathAnchor>, Vec<usize>)) -> (Vec<PathAnchor>, Vec<usize>) {
    use crate::bezier_conv::{flo_to_idml_path, idml_path_to_flo_on_grid, BOOLEAN_GRID};
    let paths = idml_path_to_flo_on_grid(a, s, BOOLEAN_GRID);
    let resolved: Vec<flo_curves::bezier::path::SimpleBezierPath> =
        flo_curves::bezier::path::path_remove_interior_points(&paths, BOOLEAN_GRID);
    if resolved.is_empty() {
        return (a.clone(), s.clone());
    }
    flo_to_idml_path(&resolved)
}

/// Orient a boolean result the Offset Path way (outer contours clockwise
/// on the page, holes the other way; C-81) and give it closed flags.
fn finish_region((mut a, s): (Vec<PathAnchor>, Vec<usize>)) -> Option<PathTriple> {
    if a.is_empty() {
        return None;
    }
    let o = vec![false; s.len().max(1)];
    crate::orientation::orient_contours(&mut a, &s, &o, crate::orientation::Turn::Clockwise);
    Some((a, s, o))
}

/// Offset a compound of closed contours. Each contour's role comes from
/// its nesting depth (even = it bounds filled area from outside, odd =
/// a hole): growing the shape outsets the even ones and insets the odd
/// ones, shrinking it the other way round. The offsets are then folded
/// depth by depth — the depth-0 results united, every odd depth
/// subtracted, every even depth united back — which is the offset of the
/// even-odd region the contours bound: a hole that shrinks to nothing
/// vanishes, outer contours that grow into each other merge, and an
/// island inside a hole stays an island.
fn offset_compound(
    contours: &[&[PathAnchor]],
    delta: f32,
    join: StrokeJoin,
    miter_limit: f32,
) -> Option<PathTriple> {
    let paths: Vec<BezPath> = contours
        .iter()
        .map(|c| anchors_to_bezpath(c, &[0], &[false]))
        .collect();
    let depth: Vec<usize> = contours
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let probe = cubic_of(&c[0], &c[1 % c.len()]).eval(0.5);
            paths
                .iter()
                .enumerate()
                .filter(|(j, p)| *j != i && p.winding(probe) != 0)
                .count()
        })
        .collect();
    let max_depth = depth.iter().copied().max().unwrap_or(0);
    let mut by_depth: Vec<Vec<(Vec<PathAnchor>, Vec<usize>)>> = vec![Vec::new(); max_depth + 1];
    for (i, c) in contours.iter().enumerate() {
        let d = if depth[i].is_multiple_of(2) {
            delta
        } else {
            -delta
        };
        if let Some((a, s, _)) = offset_closed_path(c, &[0], &[false], d, join, miter_limit) {
            by_depth[depth[i]].push((a, s));
        }
    }
    let union = |set: &[(Vec<PathAnchor>, Vec<usize>)]| -> (Vec<PathAnchor>, Vec<usize>) {
        match set.len() {
            0 => (Vec::new(), Vec::new()),
            1 => set[0].clone(),
            _ => pathfinder_boolean(set, PathfinderKind::Union),
        }
    };
    let mut acc = union(&by_depth[0]);
    for (d, set) in by_depth.iter().enumerate().skip(1) {
        if set.is_empty() {
            continue;
        }
        let layer = union(set);
        if layer.0.is_empty() {
            continue;
        }
        acc = if d % 2 == 1 {
            if acc.0.is_empty() {
                continue;
            }
            pathfinder_boolean(&[acc, layer], PathfinderKind::Subtract)
        } else if acc.0.is_empty() {
            layer
        } else {
            pathfinder_boolean(&[acc, layer], PathfinderKind::Union)
        };
    }
    finish_region(acc)
}

/// One OPEN parallel path `d` to the left of `run` (negative: to the
/// right), page space. Every segment is offset exactly (`flo_curves`'
/// offset, the same parallel curves the bevel offset uses); where two
/// offset segments part at a corner the gap gets the join, where they
/// cross they are trimmed at the crossing.
///
/// A crossing that is not between NEIGHBOURING segments (an offset
/// larger than a whole segment, a tight loop) is left in place, as a
/// small self-overlap — there is no fill to resolve it against.
pub fn one_sided_offset(
    run: &[PathAnchor],
    d: f64,
    join: StrokeJoin,
    miter_limit: f64,
) -> Option<Vec<PathAnchor>> {
    use flo_curves::bezier::{curve_intersects_curve_clip, offset, BezierCurveFactory, Curve};
    use flo_curves::geo::Coord2;
    use flo_curves::BezierCurve;

    if run.len() < 2 || d == 0.0 {
        return None;
    }
    let c2 = |p: Point| Coord2(p.x, p.y);
    let kp = |p: Coord2| Point::new(p.0, p.1);

    // Each segment: its source cubic and its offset pieces.
    struct Seg {
        src: CubicBez,
        pieces: Vec<CubicBez>,
    }
    let mut segs: Vec<Seg> = Vec::new();
    for w in run.windows(2) {
        let src = cubic_of(&w[0], &w[1]);
        if (src.p3 - src.p0).hypot() < EPS
            && (src.p1 - src.p0).hypot() < EPS
            && (src.p2 - src.p0).hypot() < EPS
        {
            continue;
        }
        let tangent = start_tangent(&src)?;
        let expected = src.p0 + left_of(tangent) * d;
        let curve = Curve::from_points(c2(src.p0), (c2(src.p1), c2(src.p2)), c2(src.p3));
        let to_kurbo = |pieces: Vec<Curve<Coord2>>| -> Vec<CubicBez> {
            pieces
                .iter()
                .map(|c| {
                    let (p1, p2) = c.control_points();
                    CubicBez::new(kp(c.start_point()), kp(p1), kp(p2), kp(c.end_point()))
                })
                .collect()
        };
        let mut pieces = to_kurbo(offset(&curve, d, d));
        // flo's normal is not documented to be the page's left: take the
        // side whose first point lands where the left offset must.
        if pieces
            .first()
            .is_none_or(|c| (c.p0 - expected).hypot() > d.abs() * 0.5)
        {
            pieces = to_kurbo(offset(&curve, -d, -d));
        }
        if pieces.is_empty() {
            return None;
        }
        segs.push(Seg { src, pieces });
    }
    if segs.is_empty() {
        return None;
    }

    // Trim crossings between neighbours, then chain with joins.
    for i in 0..segs.len().saturating_sub(1) {
        let t_in = end_tangent(&segs[i].src)?;
        let t_out = start_tangent(&segs[i + 1].src)?;
        if turn(t_in, t_out).abs() < SMOOTH_TURN {
            continue;
        }
        let e = segs[i].pieces.last()?.p3;
        let s = segs[i + 1].pieces.first()?.p0;
        let outer = line_intersection(e, t_in, s, t_out).is_none_or(|(_, along, _)| along >= 0.0);
        if outer {
            continue;
        }
        // Inner corner: search the last pieces of `i` against the first
        // of `i + 1` for the crossing.
        let a_len = segs[i].pieces.len();
        let mut hit: Option<(usize, f64, usize, f64)> = None;
        'search: for pa in (a_len.saturating_sub(4)..a_len).rev() {
            for pb in 0..segs[i + 1].pieces.len().min(4) {
                let a = segs[i].pieces[pa];
                let b = segs[i + 1].pieces[pb];
                let fa = Curve::from_points(c2(a.p0), (c2(a.p1), c2(a.p2)), c2(a.p3));
                let fb = Curve::from_points(c2(b.p0), (c2(b.p1), c2(b.p2)), c2(b.p3));
                if let Some(&(ta, tb)) = curve_intersects_curve_clip(&fa, &fb, 1e-4).first() {
                    hit = Some((pa, ta, pb, tb));
                    break 'search;
                }
            }
        }
        if let Some((pa, ta, pb, tb)) = hit {
            segs[i].pieces.truncate(pa + 1);
            let a = segs[i].pieces[pa];
            segs[i].pieces[pa] = a.subsegment(0.0..ta);
            segs[i + 1].pieces.drain(..pb);
            let b = segs[i + 1].pieces[0];
            segs[i + 1].pieces[0] = b.subsegment(tb..1.0);
        }
    }

    let mut path = BezPath::new();
    path.move_to(segs[0].pieces[0].p0);
    for (i, seg) in segs.iter().enumerate() {
        if i > 0 {
            let prev = &segs[i - 1];
            let e = prev.pieces.last()?.p3;
            let s = seg.pieces[0].p0;
            if (s - e).hypot() > 1e-4 {
                let t_in = end_tangent(&prev.src)?;
                let t_out = start_tangent(&seg.src)?;
                let outer =
                    line_intersection(e, t_in, s, t_out).is_none_or(|(_, along, _)| along >= 0.0);
                if outer && turn(t_in, t_out).abs() >= SMOOTH_TURN {
                    outer_join(
                        &mut path,
                        prev.src.p3,
                        d.abs(),
                        e,
                        s,
                        t_in,
                        t_out,
                        join,
                        miter_limit,
                    );
                } else {
                    path.line_to(s);
                }
            }
        }
        for c in &seg.pieces {
            path.curve_to(c.p1, c.p2, c.p3);
        }
    }
    let (a, _, _) = bezpath_to_anchors(&path);
    (a.len() >= 2).then_some(a)
}

// ---------------------------------------------------------------------------
// Variable width
// ---------------------------------------------------------------------------

/// One vertex of a flattened centreline.
struct Vertex {
    p: Point,
    /// Unit direction of the chord arriving here (`None` at an open start).
    t_in: Option<Vec2>,
    /// Unit direction of the chord leaving (`None` at an open end).
    t_out: Option<Vec2>,
    /// Lengths of the chords arriving and leaving.
    l_in: f64,
    l_out: f64,
    /// An anchor where the path turns: it gets a join.
    corner: bool,
    /// Normalised arc length, 0..=1.
    s: f64,
}

/// Flatten one subpath into vertices, keeping track of which are the
/// path's own anchors (where a join may be needed).
fn centreline(run: &[PathAnchor], closed: bool) -> Option<Vec<Vertex>> {
    let n = run.len();
    let seg_count = if closed { n } else { n - 1 };
    let mut pts: Vec<(Point, bool)> = Vec::new();
    for k in 0..seg_count {
        let (a, b) = (&run[k], &run[(k + 1) % n]);
        let c = cubic_of(a, b);
        if pts.is_empty() {
            pts.push((c.p0, true));
        }
        let mut seg_pts: Vec<Point> = Vec::new();
        kurbo::flatten(
            [
                kurbo::PathEl::MoveTo(c.p0),
                kurbo::PathEl::CurveTo(c.p1, c.p2, c.p3),
            ],
            FLATTEN,
            |el| {
                if let kurbo::PathEl::LineTo(p) = el {
                    seg_pts.push(p);
                }
            },
        );
        let last = seg_pts.len();
        for (i, p) in seg_pts.into_iter().enumerate() {
            pts.push((p, i + 1 == last));
        }
    }
    if closed {
        // The closing segment ended on the first point: fold it.
        if let (Some(first), Some(last)) = (pts.first().copied(), pts.last().copied()) {
            if (first.0 - last.0).hypot() < 1e-6 {
                pts.pop();
            }
        }
    }
    pts.dedup_by(|a, b| (a.0 - b.0).hypot() < EPS);
    if pts.len() < 2 {
        return None;
    }
    let m = pts.len();
    let mut cum = vec![0.0f64; m];
    for i in 1..m {
        cum[i] = cum[i - 1] + (pts[i].0 - pts[i - 1].0).hypot();
    }
    let total = cum[m - 1]
        + if closed {
            (pts[0].0 - pts[m - 1].0).hypot()
        } else {
            0.0
        };
    if total <= EPS {
        return None;
    }
    let mut out = Vec::with_capacity(m);
    for i in 0..m {
        let prev = if i > 0 {
            Some(pts[i - 1].0)
        } else if closed {
            Some(pts[m - 1].0)
        } else {
            None
        };
        let next = if i + 1 < m {
            Some(pts[i + 1].0)
        } else if closed {
            Some(pts[0].0)
        } else {
            None
        };
        let p = pts[i].0;
        let t_in = prev.and_then(|q| unit(p - q));
        let t_out = next.and_then(|q| unit(q - p));
        let corner = pts[i].1
            && match (t_in, t_out) {
                (Some(a), Some(b)) => turn(a, b).abs() >= SMOOTH_TURN,
                _ => false,
            };
        out.push(Vertex {
            p,
            t_in,
            t_out,
            l_in: prev.map(|q| (p - q).hypot()).unwrap_or(0.0),
            l_out: next.map(|q| (q - p).hypot()).unwrap_or(0.0),
            corner,
            s: cum[i] / total,
        });
    }
    Some(out)
}

/// Half-width at normalised arc length `s`, lerped across the width
/// stops (spread uniformly over 0..=1 by index).
fn half_width(widths: &[f32], s: f64) -> f64 {
    let n = widths.len();
    if n == 1 {
        return f64::from(widths[0]).max(0.0) * 0.5;
    }
    let x = s.clamp(0.0, 1.0) * (n - 1) as f64;
    let i = (x.floor() as usize).min(n - 2);
    let frac = x - i as f64;
    let w = f64::from(widths[i]) * (1.0 - frac) + f64::from(widths[i + 1]) * frac;
    w.max(0.0) * 0.5
}

/// One side of the outline, in travel order: `sign` is +1 for the page
/// left, −1 for the right. Appends to `path` (the first point by
/// `move_to` when `start` is set, otherwise by `line_to`).
fn side(
    path: &mut BezPath,
    verts: &[Vertex],
    widths: &[f32],
    sign: f64,
    join: StrokeJoin,
    miter_limit: f64,
    start: bool,
) {
    let mut first = start;
    let emit = |path: &mut BezPath, p: Point, first: &mut bool| {
        if *first {
            path.move_to(p);
            *first = false;
        } else {
            path.line_to(p);
        }
    };
    for v in verts {
        let r = half_width(widths, v.s);
        match (v.t_in, v.t_out) {
            (Some(t_in), Some(t_out)) if v.corner => {
                let n_in = left_of(t_in) * sign;
                let n_out = left_of(t_out) * sign;
                let e = v.p + n_in * r;
                let s = v.p + n_out * r;
                // Outer when the offset lines meet AHEAD of `e`.
                let outer =
                    line_intersection(e, t_in, s, t_out).is_none_or(|(_, along, _)| along >= 0.0);
                emit(path, e, &mut first);
                if outer {
                    outer_join(path, v.p, r, e, s, t_in, t_out, join, miter_limit);
                } else {
                    // Inner: the offset chords cross; meet there when the
                    // crossing lies on both, else loop through the centre
                    // (correct under nonzero, like the stroker's own
                    // conservative inner joins).
                    match line_intersection(e, t_in, s, t_out) {
                        Some((x, along_in, along_out))
                            if -along_in <= v.l_in && along_out <= v.l_out =>
                        {
                            path.line_to(x);
                            path.line_to(s);
                        }
                        _ => {
                            path.line_to(v.p);
                            path.line_to(s);
                        }
                    }
                }
            }
            _ => {
                // Smooth vertex (or an open end): along the normal of the
                // chord between its neighbours.
                let t = match (v.t_in, v.t_out) {
                    (Some(a), Some(b)) => unit(a + b).unwrap_or(b),
                    (Some(a), None) => a,
                    (None, Some(b)) => b,
                    (None, None) => Vec2::new(1.0, 0.0),
                };
                emit(path, v.p + left_of(t) * sign * r, &mut first);
            }
        }
    }
}

/// The cap at an open end `v` (direction of travel `t` pointing OUT of
/// the path), from the current point (`v + r·left_of(t)`... on the side
/// the outline arrives on) round to the other side.
fn cap(path: &mut BezPath, v: Point, t: Vec2, r: f64, cap: StrokeCap) {
    // Arriving on the left of `t`, leaving on its right.
    let from = left_of(t) * r;
    let to = v - from;
    match cap {
        StrokeCap::Butt => path.line_to(to),
        StrokeCap::Square => {
            path.line_to(v + from + t * r);
            path.line_to(to + t * r);
            path.line_to(to);
        }
        StrokeCap::Round => {
            // From the left of `t` to its right through `t` itself: the
            // left normal is `t` turned a quarter back, so that is a half
            // turn forward in the coordinates' own angle sense.
            arc_to(path, v, r, from, std::f64::consts::PI);
            path.line_to(to);
        }
    }
}

/// Variable-width stroke outline (B-08, engine ADR 1019): `widths[i]`
/// is the FULL stroke width at width stop `i`, the stops spread over
/// each subpath's normalised arc length. Built per vertex of the
/// flattened centreline: smooth vertices are pushed along their normal,
/// anchors where the path turns get the `join` on the outer side
/// (mitred while `1/cos(φ/2) ≤ miter_limit`, bevelled past it; round as
/// a cubic arc) and meet at the crossing of the offset chords on the
/// inner side. Open ends get the `cap`. A closed subpath gives two
/// contours (its outer and inner edge). Contours run clockwise on the
/// page, holes the other way (C-81).
pub fn variable_width_outline(
    anchors: &[PathAnchor],
    subpath_starts: &[usize],
    subpath_open: &[bool],
    widths: &[f32],
    cap_kind: StrokeCap,
    join: StrokeJoin,
    miter_limit: f32,
) -> Option<PathTriple> {
    if anchors.len() < 2 || widths.is_empty() {
        return None;
    }
    let ml = f64::from(miter_limit.max(1.0));
    let mut path = BezPath::new();
    for (s, e, open) in spans(anchors.len(), subpath_starts, subpath_open) {
        let run = &anchors[s..e];
        if run.len() < 2 {
            continue;
        }
        let closed = !open && run.len() >= 3;
        let Some(verts) = centreline(run, closed) else {
            continue;
        };
        if closed {
            side(&mut path, &verts, widths, 1.0, join, ml, true);
            path.close_path();
            // The right edge, travelled backwards, as its own contour.
            let reversed: Vec<Vertex> = verts
                .iter()
                .rev()
                .map(|v| Vertex {
                    p: v.p,
                    t_in: v.t_out.map(|t| -t),
                    t_out: v.t_in.map(|t| -t),
                    l_in: v.l_out,
                    l_out: v.l_in,
                    corner: v.corner,
                    s: v.s,
                })
                .collect();
            side(&mut path, &reversed, widths, 1.0, join, ml, true);
            path.close_path();
        } else {
            let last = verts.last()?;
            let first = &verts[0];
            side(&mut path, &verts, widths, 1.0, join, ml, true);
            cap(
                &mut path,
                last.p,
                last.t_in?,
                half_width(widths, 1.0),
                cap_kind,
            );
            let reversed: Vec<Vertex> = verts
                .iter()
                .rev()
                .map(|v| Vertex {
                    p: v.p,
                    t_in: v.t_out.map(|t| -t),
                    t_out: v.t_in.map(|t| -t),
                    l_in: v.l_out,
                    l_out: v.l_in,
                    corner: v.corner,
                    s: v.s,
                })
                .collect();
            side(&mut path, &reversed, widths, 1.0, join, ml, false);
            cap(
                &mut path,
                first.p,
                -first.t_out?,
                half_width(widths, 0.0),
                cap_kind,
            );
            path.close_path();
        }
    }
    let (mut a, s, _) = bezpath_to_anchors(&path);
    if a.len() < 3 {
        return None;
    }
    let closed = vec![false; s.len().max(1)];
    crate::orientation::orient_contours(&mut a, &s, &closed, crate::orientation::Turn::Clockwise);
    Some((a, s, closed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kurbo::Shape;

    fn corner(x: f32, y: f32) -> PathAnchor {
        PathAnchor {
            anchor: (x, y),
            left: (x, y),
            right: (x, y),
        }
    }

    fn area((a, s, o): &PathTriple) -> f64 {
        // Signed contour areas summed: outer clockwise (positive on the
        // page), holes the other way, so the sum is the region's area.
        let n = a.len();
        let mut total = 0.0;
        for (i, &cs) in s.iter().enumerate() {
            let ce = s.get(i + 1).copied().unwrap_or(n);
            if o.get(i).copied().unwrap_or(false) {
                continue;
            }
            total += crate::orientation::signed_area(&a[cs..ce]);
        }
        total
    }

    fn bbox(a: &[PathAnchor]) -> (f64, f64, f64, f64) {
        let p = anchors_to_bezpath(a, &[0], &[true]).bounding_box();
        (p.x0, p.y0, p.x1, p.y1)
    }

    fn square(l: f32, t: f32, r: f32, b: f32) -> Vec<PathAnchor> {
        vec![corner(l, t), corner(r, t), corner(r, b), corner(l, b)]
    }

    /// A 100 × 100 square with a 40 × 40 hole — the D-7 case: a compound
    /// path's offset keeps its hole and moves it the other way.
    fn ring() -> (Vec<PathAnchor>, Vec<usize>, Vec<bool>) {
        let mut a = square(0.0, 0.0, 100.0, 100.0);
        a.extend(square(30.0, 30.0, 70.0, 70.0));
        (a, vec![0, 4], vec![false, false])
    }

    #[test]
    fn a_compound_outset_grows_the_outer_contour_and_shrinks_the_hole() {
        let (a, s, o) = ring();
        let out = offset_path(&a, &s, &o, 10.0, StrokeJoin::Miter, 4.0, OffsetSide::Both)
            .expect("outset");
        assert_eq!(out.1.len(), 2, "outer contour + hole");
        // 120² − 20² = 14000.
        assert!((area(&out) - 14_000.0).abs() < 1.0, "area {}", area(&out));
    }

    #[test]
    fn a_compound_inset_shrinks_the_outer_contour_and_grows_the_hole() {
        let (a, s, o) = ring();
        let out = offset_path(&a, &s, &o, -10.0, StrokeJoin::Miter, 4.0, OffsetSide::Both)
            .expect("inset");
        // 80² − 60² = 2800.
        assert!((area(&out) - 2_800.0).abs() < 1.0, "area {}", area(&out));
    }

    #[test]
    fn a_hole_that_shrinks_to_nothing_vanishes() {
        let (a, s, o) = ring();
        let out = offset_path(&a, &s, &o, 25.0, StrokeJoin::Miter, 4.0, OffsetSide::Both)
            .expect("outset");
        assert_eq!(out.1.len(), 1, "the 40 pt hole is gone at 25 pt");
        assert!((area(&out) - 150.0 * 150.0).abs() < 1.0);
    }

    #[test]
    fn outer_contours_that_grow_into_each_other_merge() {
        let mut a = square(0.0, 0.0, 40.0, 40.0);
        a.extend(square(50.0, 0.0, 90.0, 40.0));
        let out = offset_path(
            &a,
            &[0, 4],
            &[false, false],
            10.0,
            StrokeJoin::Miter,
            4.0,
            OffsetSide::Both,
        )
        .expect("outset");
        assert_eq!(out.1.len(), 1, "one merged contour");
        // 110 × 60.
        assert!((area(&out) - 6_600.0).abs() < 1.0, "area {}", area(&out));
    }

    #[test]
    fn an_island_in_a_hole_stays_an_island() {
        let (mut a, _, _) = ring();
        a.extend(square(45.0, 45.0, 55.0, 55.0));
        let out = offset_path(
            &a,
            &[0, 4, 8],
            &[false, false, false],
            2.0,
            StrokeJoin::Miter,
            4.0,
            OffsetSide::Both,
        )
        .expect("outset");
        assert_eq!(out.1.len(), 3);
        // 104² − 36² + 14² = 10816 − 1296 + 196.
        assert!((area(&out) - 9_716.0).abs() < 1.0, "area {}", area(&out));
    }

    #[test]
    fn a_one_sided_offset_of_a_line_is_the_parallel_line() {
        // Walking +x on a y-down page, LEFT is −y.
        let line = [corner(0.0, 0.0), corner(100.0, 0.0)];
        let (a, s, o) = offset_path(
            &line,
            &[0],
            &[true],
            5.0,
            StrokeJoin::Miter,
            4.0,
            OffsetSide::Left,
        )
        .expect("left");
        assert_eq!((s, o), (vec![0], vec![true]));
        assert_eq!(a.len(), 2);
        assert!((a[0].anchor.1 + 5.0).abs() < 1e-3 && (a[1].anchor.1 + 5.0).abs() < 1e-3);
        let (a, ..) = offset_path(
            &line,
            &[0],
            &[true],
            5.0,
            StrokeJoin::Miter,
            4.0,
            OffsetSide::Right,
        )
        .expect("right");
        assert!((a[0].anchor.1 - 5.0).abs() < 1e-3);
    }

    #[test]
    fn a_one_sided_offset_joins_outer_corners_and_trims_inner_ones() {
        // An L: right along the top, then down. Its LEFT (page) is the
        // outside of the turn, its right the inside.
        let l = [corner(0.0, 0.0), corner(100.0, 0.0), corner(100.0, 100.0)];
        let left_miter = one_sided_offset(&l, 10.0, StrokeJoin::Miter, 4.0).expect("left, miter");
        let (x0, y0, x1, _) = bbox(&left_miter);
        assert!(
            (y0 + 10.0).abs() < 1e-3 && (x1 - 110.0).abs() < 1e-3,
            "mitred corner"
        );
        assert!((x0 - 0.0).abs() < 1e-3);
        // Start, the end of the first edge, the miter tip, the start of
        // the second edge, the end.
        assert_eq!(left_miter.len(), 5, "{left_miter:?}");

        let left_bevel = one_sided_offset(&l, 10.0, StrokeJoin::Bevel, 4.0).expect("bevel");
        assert_eq!(left_bevel.len(), 4, "start, two bevel ends, end");

        let left_round = one_sided_offset(&l, 10.0, StrokeJoin::Round, 4.0).expect("round");
        let (_, y0, x1, _) = bbox(&left_round);
        assert!((y0 + 10.0).abs() < 1e-2 && (x1 - 110.0).abs() < 1e-2);

        // The inside: trimmed at the crossing (90, 10), no loop.
        let right = one_sided_offset(&l, -10.0, StrokeJoin::Miter, 4.0).expect("right");
        assert_eq!(right.len(), 3, "start, the trimmed corner, end: {right:?}");
        assert!((right[1].anchor.0 - 90.0).abs() < 1e-2 && (right[1].anchor.1 - 10.0).abs() < 1e-2);
    }

    #[test]
    fn variable_width_honours_round_and_square_caps() {
        let line = [corner(0.0, 0.0), corner(100.0, 0.0)];
        let butt = variable_width_outline(
            &line,
            &[0],
            &[true],
            &[10.0],
            StrokeCap::Butt,
            StrokeJoin::Miter,
            4.0,
        )
        .expect("butt");
        let square = variable_width_outline(
            &line,
            &[0],
            &[true],
            &[10.0],
            StrokeCap::Square,
            StrokeJoin::Miter,
            4.0,
        )
        .expect("square");
        let round = variable_width_outline(
            &line,
            &[0],
            &[true],
            &[10.0],
            StrokeCap::Round,
            StrokeJoin::Miter,
            4.0,
        )
        .expect("round");
        assert!((area(&butt) - 1_000.0).abs() < 0.5, "butt {}", area(&butt));
        assert!(
            (area(&square) - 1_100.0).abs() < 0.5,
            "square {}",
            area(&square)
        );
        let disc = std::f64::consts::PI * 25.0;
        assert!(
            (area(&round) - (1_000.0 + disc)).abs() < 0.5,
            "round {}",
            area(&round)
        );
    }

    #[test]
    fn variable_width_honours_the_join_at_a_corner() {
        let l = [corner(0.0, 0.0), corner(100.0, 0.0), corner(100.0, 100.0)];
        let make = |join| {
            variable_width_outline(&l, &[0], &[true], &[10.0], StrokeCap::Butt, join, 4.0)
                .expect("outline")
        };
        // A 10 pt stroke round a right angle: two 100 × 10 arms minus the
        // 5 × 5 they share, plus the outer corner's join.
        let base = 2.0 * 1_000.0 - 25.0;
        let miter = area(&make(StrokeJoin::Miter));
        let bevel = area(&make(StrokeJoin::Bevel));
        let round = area(&make(StrokeJoin::Round));
        assert!((miter - (base + 25.0)).abs() < 0.5, "miter {miter}");
        assert!((bevel - (base + 12.5)).abs() < 0.5, "bevel {bevel}");
        let quarter = std::f64::consts::PI * 25.0 / 4.0;
        assert!((round - (base + quarter)).abs() < 0.5, "round {round}");
        // Past the limit a miter bevels: 1/cos(45°) = 1.414 > 1.2.
        let limited = variable_width_outline(
            &l,
            &[0],
            &[true],
            &[10.0],
            StrokeCap::Butt,
            StrokeJoin::Miter,
            1.2,
        )
        .expect("limited");
        assert!((area(&limited) - (base + 12.5)).abs() < 0.5);
    }

    #[test]
    fn variable_width_outlines_every_subpath_and_closed_ones_as_rings() {
        // Two open lines and a closed square in one path.
        let mut a = vec![corner(0.0, 0.0), corner(100.0, 0.0)];
        a.extend([corner(0.0, 50.0), corner(100.0, 50.0)]);
        a.extend(square(200.0, 0.0, 300.0, 100.0));
        let out = variable_width_outline(
            &a,
            &[0, 2, 4],
            &[true, true, false],
            &[4.0],
            StrokeCap::Butt,
            StrokeJoin::Miter,
            4.0,
        )
        .expect("outline");
        assert_eq!(out.1.len(), 4, "two bands + the ring's two edges");
        // 2 × 400 + (104² − 96²) = 800 + 1600.
        assert!((area(&out) - 2_400.0).abs() < 1.0, "area {}", area(&out));
    }
}
