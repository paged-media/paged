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

//! Path, Pathfinder and Convert to Shape: Offset Path, Outline Stroke,
//! Round Corners, Convert to Shape, and the Pathfinder shape modes of a
//! group. The path algebra is `paged-geom`'s, the same kernels the
//! editor's Offset Path, Outline Stroke and Pathfinder operations run.

use kurbo::{Point, Rect, Vec2};
use paged_geom::kurbo_kernel::{StrokeCap, StrokeJoin};
use paged_geom::pathfinder::{pathfinder_boolean, PathfinderKind};
use paged_geom::stroke_kernel::{offset_path as geom_offset, OffsetSide};
use paged_model::vector_effect::{
    ConvertToShapeParams, OffsetPathParams, PathJoin, PathfinderOp, RoundCornersParams, ShapeKind,
};

use crate::shape::{is_straight, length, Contour, Node, Shape};

/// The stroke an Outline Stroke effect outlines: the item's own.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokeStyle {
    pub weight: f32,
    pub cap: StrokeCap,
    pub join: StrokeJoin,
    pub miter_limit: f32,
}

impl Default for StrokeStyle {
    fn default() -> Self {
        Self {
            weight: 1.0,
            cap: StrokeCap::Butt,
            join: StrokeJoin::Miter,
            miter_limit: 4.0,
        }
    }
}

fn join_of(j: PathJoin) -> StrokeJoin {
    match j {
        PathJoin::Miter => StrokeJoin::Miter,
        PathJoin::Round => StrokeJoin::Round,
        PathJoin::Bevel => StrokeJoin::Bevel,
    }
}

/// Offset Path: the editor's operation (`paged-geom`'s offset kernel,
/// recorded against Illustrator by draw's `offset-path` and
/// `offset-compound` oracles). Nothing left (an inset past every
/// contour's middle) is an empty outline.
pub fn offset_path(shape: &Shape, p: &OffsetPathParams) -> Shape {
    if p.offset == 0.0 {
        return shape.clone();
    }
    let (a, s, o) = shape.to_anchors();
    let starts = if s.is_empty() { vec![0] } else { s };
    let open = if o.is_empty() {
        vec![false; starts.len()]
    } else {
        o
    };
    match geom_offset(
        &a,
        &starts,
        &open,
        p.offset,
        join_of(p.join),
        p.miter_limit.max(1.0),
        OffsetSide::Both,
    ) {
        Some((a, s, o)) => Shape::from_anchors(&a, &s, &o),
        None => Shape::default(),
    }
}

/// Outline Stroke: the band the item's stroke paints, as a filled
/// outline (`paged-geom`'s outline kernel, recorded by draw's
/// `outline-stroke` oracle).
pub fn outline_stroke(shape: &Shape, stroke: &StrokeStyle) -> Option<Shape> {
    if stroke.weight <= 0.0 {
        return None;
    }
    let (a, s, o) = shape.to_anchors();
    let starts = if s.is_empty() { vec![0] } else { s };
    let open = if o.is_empty() {
        vec![false; starts.len()]
    } else {
        o
    };
    paged_geom::kurbo_kernel::outline_stroke(
        &a,
        &starts,
        &open,
        stroke.weight,
        stroke.cap,
        stroke.join,
        stroke.miter_limit,
    )
    .map(|(a, s, o)| Shape::from_anchors(&a, &s, &o))
}

/// Whether a node is a corner: its handles do not continue each other
/// (collapsed handles, or a bend between the incoming and outgoing
/// tangent).
fn is_corner(prev: &Node, n: &Node, next: &Node) -> bool {
    let tin = if (n.p - n.l).hypot() > 1e-6 {
        n.p - n.l
    } else {
        n.p - prev.r
    };
    let tin = if tin.hypot() > 1e-6 {
        tin
    } else {
        n.p - prev.p
    };
    let tout = if (n.r - n.p).hypot() > 1e-6 {
        n.r - n.p
    } else {
        next.l - n.p
    };
    let tout = if tout.hypot() > 1e-6 {
        tout
    } else {
        next.p - n.p
    };
    let (a, b) = (tin.hypot(), tout.hypot());
    if a < 1e-9 || b < 1e-9 {
        return false;
    }
    let cos = tin.dot(tout) / (a * b);
    cos < 0.9999
}

/// Kappa: the handle length of a quarter circle's cubic, per unit radius
/// — and Illustrator's handle per unit of Round Corners' radius
/// (recorded: 8.25 for a radius of 15 on a 36.87° corner as on a right
/// angle).
const ROUND_HANDLE: f64 = 0.55;

/// Round Corners. At every corner the outline is cut `radius` along each
/// edge (at most half of it), and the two cuts are joined by a cubic
/// whose handles point back at the corner, `0.55 · radius` long.
/// Recorded exactly (`Adobe Round Corners`): the cut is measured along
/// the edge whatever the angle, not as a tangent circle's.
pub fn round_corners(shape: &Shape, p: &RoundCornersParams) -> Shape {
    let r = f64::from(p.radius.max(0.0));
    if r == 0.0 {
        return shape.clone();
    }
    let contours = shape
        .contours
        .iter()
        .map(|c| {
            let n = c.nodes.len();
            if n < 3 {
                return c.clone();
            }
            let segs = c.segments();
            let mut out: Vec<Node> = Vec::new();
            for i in 0..n {
                let node = c.nodes[i];
                let has_prev = c.closed || i > 0;
                let has_next = c.closed || i + 1 < n;
                if !(has_prev && has_next) {
                    out.push(node);
                    continue;
                }
                let prev = c.nodes[(i + n - 1) % n];
                let next = c.nodes[(i + 1) % n];
                let seg_in = segs[(i + segs.len() - 1) % segs.len()];
                let seg_out = segs[i % segs.len()];
                if !is_corner(&prev, &node, &next)
                    || !is_straight(&seg_in)
                    || !is_straight(&seg_out)
                {
                    out.push(node);
                    continue;
                }
                let len_in = length(&seg_in);
                let len_out = length(&seg_out);
                let cut_in = r.min(len_in / 2.0);
                let cut_out = r.min(len_out / 2.0);
                if cut_in < 1e-6 || cut_out < 1e-6 {
                    out.push(node);
                    continue;
                }
                let d_in = (prev.p - node.p) / len_in;
                let d_out = (next.p - node.p) / len_out;
                let a = node.p + d_in * cut_in;
                let b = node.p + d_out * cut_out;
                out.push(Node {
                    p: a,
                    l: a,
                    r: a - d_in * (ROUND_HANDLE * cut_in),
                });
                out.push(Node {
                    p: b,
                    l: b - d_out * (ROUND_HANDLE * cut_out),
                    r: b,
                });
            }
            Contour {
                nodes: out,
                closed: c.closed,
            }
        })
        .collect();
    Shape { contours }
}

/// The circle's kappa, for Convert to Shape's ellipse and rounded corners.
const KAPPA: f64 = 0.552_284_749_830_793_4;

fn rect_contour(r: Rect) -> Contour {
    Contour {
        nodes: [
            Point::new(r.x0, r.y0),
            Point::new(r.x1, r.y0),
            Point::new(r.x1, r.y1),
            Point::new(r.x0, r.y1),
        ]
        .into_iter()
        .map(Node::corner)
        .collect(),
        closed: true,
    }
}

fn ellipse_contour(r: Rect) -> Contour {
    let c = r.center();
    let (rx, ry) = (r.width() / 2.0, r.height() / 2.0);
    let (kx, ky) = (rx * KAPPA, ry * KAPPA);
    let n = |p: Point, l: Vec2, rr: Vec2| Node {
        p,
        l: p + l,
        r: p + rr,
    };
    Contour {
        nodes: vec![
            n(
                Point::new(c.x, c.y - ry),
                Vec2::new(-kx, 0.0),
                Vec2::new(kx, 0.0),
            ),
            n(
                Point::new(c.x + rx, c.y),
                Vec2::new(0.0, -ky),
                Vec2::new(0.0, ky),
            ),
            n(
                Point::new(c.x, c.y + ry),
                Vec2::new(kx, 0.0),
                Vec2::new(-kx, 0.0),
            ),
            n(
                Point::new(c.x - rx, c.y),
                Vec2::new(0.0, ky),
                Vec2::new(0.0, -ky),
            ),
        ],
        closed: true,
    }
}

fn rounded_rect_contour(r: Rect, radius: f64) -> Contour {
    let rad = radius.min(r.width() / 2.0).min(r.height() / 2.0).max(0.0);
    if rad <= 1e-9 {
        return rect_contour(r);
    }
    let k = rad * KAPPA;
    let corner = |p: Point, l: Vec2, rr: Vec2| Node {
        p,
        l: p + l,
        r: p + rr,
    };
    Contour {
        nodes: vec![
            corner(Point::new(r.x0 + rad, r.y0), Vec2::new(-k, 0.0), Vec2::ZERO),
            corner(Point::new(r.x1 - rad, r.y0), Vec2::ZERO, Vec2::new(k, 0.0)),
            corner(Point::new(r.x1, r.y0 + rad), Vec2::new(0.0, -k), Vec2::ZERO),
            corner(Point::new(r.x1, r.y1 - rad), Vec2::ZERO, Vec2::new(0.0, k)),
            corner(Point::new(r.x1 - rad, r.y1), Vec2::new(k, 0.0), Vec2::ZERO),
            corner(Point::new(r.x0 + rad, r.y1), Vec2::ZERO, Vec2::new(-k, 0.0)),
            corner(Point::new(r.x0, r.y1 - rad), Vec2::new(0.0, k), Vec2::ZERO),
            corner(Point::new(r.x0, r.y0 + rad), Vec2::ZERO, Vec2::new(0.0, -k)),
        ],
        closed: true,
    }
}

/// Convert to Shape: a rectangle, rounded rectangle or ellipse about the
/// bounding box's centre, the box's size plus the extra (relative) or a
/// fixed size (absolute).
pub fn convert_to_shape(shape: &Shape, p: &ConvertToShapeParams) -> Shape {
    let Some(b) = shape.bounds() else {
        return shape.clone();
    };
    let (w, h) = if p.relative {
        (
            b.width() + 2.0 * f64::from(p.extra_width),
            b.height() + 2.0 * f64::from(p.extra_height),
        )
    } else {
        (f64::from(p.width), f64::from(p.height))
    };
    let (w, h) = (w.max(0.0), h.max(0.0));
    let c = b.center();
    let r = Rect::new(c.x - w / 2.0, c.y - h / 2.0, c.x + w / 2.0, c.y + h / 2.0);
    let contour = match p.shape {
        ShapeKind::Rectangle => rect_contour(r),
        ShapeKind::RoundedRectangle => rounded_rect_contour(r, f64::from(p.corner_radius)),
        ShapeKind::Ellipse => ellipse_contour(r),
    };
    Shape {
        contours: vec![contour],
    }
}

/// The Pathfinder shape modes over a group's members, BACK FIRST (the
/// order the group lists them). Add, Intersect and Exclude are
/// symmetric; Subtract is Illustrator's Minus Front, the backmost member
/// minus the rest. `paged-geom`'s boolean (the editor's Pathfinder
/// operation, recorded by draw's `pathfinder-boolean` oracle).
pub fn pathfinder(members_back_first: &[Shape], op: PathfinderOp) -> Shape {
    let inputs: Vec<(Vec<paged_model::PathAnchor>, Vec<usize>)> = members_back_first
        .iter()
        .filter(|s| !s.contours.is_empty())
        .map(|s| {
            // Booleans read closed regions: an open contour closes.
            let closed = Shape {
                contours: s
                    .contours
                    .iter()
                    .map(|c| Contour {
                        nodes: c.nodes.clone(),
                        closed: true,
                    })
                    .collect(),
            };
            let (a, st, _) = closed.to_anchors();
            (a, if st.is_empty() { vec![0] } else { st })
        })
        .collect();
    if inputs.is_empty() {
        return Shape::default();
    }
    let kind = match op {
        PathfinderOp::Add => PathfinderKind::Union,
        PathfinderOp::Subtract => PathfinderKind::Subtract,
        PathfinderOp::Intersect => PathfinderKind::Intersect,
        PathfinderOp::Exclude => PathfinderKind::Exclude,
    };
    let (a, s) = pathfinder_boolean(&inputs, kind);
    let open = vec![false; s.len().max(1)];
    Shape::from_anchors(&a, &s, &open)
}
