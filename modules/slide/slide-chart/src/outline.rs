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

//! A primitive's outline as Bézier anchors, in the chart frame's points:
//! one definition for every module that draws [`layout`](crate::layout)'s
//! primitives (paged.slide's native items, paged.doc's anchored frames,
//! doc ADR 628). Bars and polylines are corner anchors, a smoothed line a
//! Catmull-Rom curve, a pie slice arcs of at most 90° as cubic segments.

use crate::Prim;

/// One anchor of a contour with its two direction handles.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub anchor: (f64, f64),
    pub left: (f64, f64),
    pub right: (f64, f64),
}

/// One contour: closed ones are filled and stroked, open ones stroked.
#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub points: Vec<Point>,
    pub closed: bool,
}

/// The outline of a shape primitive; `None` for a label and for a bar or
/// path with nothing to draw.
pub fn contour(prim: &Prim) -> Option<Contour> {
    match prim {
        Prim::Rect { x, y, w, h, .. } => {
            if *w <= 0.0 || *h <= 0.0 {
                return None;
            }
            let (x, y, w, h) = (*x, *y, *w, *h);
            Some(polygon(
                &[(x, y), (x + w, y), (x + w, y + h), (x, y + h)],
                true,
            ))
        }
        Prim::Path {
            points,
            smooth,
            closed,
            ..
        } => {
            if points.len() < 2 {
                return None;
            }
            Some(if *smooth {
                catmull_rom(points)
            } else {
                polygon(points, *closed)
            })
        }
        Prim::Wedge {
            cx,
            cy,
            r,
            hole,
            start,
            sweep,
            ..
        } => Some(wedge(*cx, *cy, *r, *hole, *start, *sweep)),
        Prim::Label { .. } => None,
    }
}

fn corner(p: (f64, f64)) -> Point {
    Point {
        anchor: p,
        left: p,
        right: p,
    }
}

fn polygon(points: &[(f64, f64)], closed: bool) -> Contour {
    Contour {
        points: points.iter().copied().map(corner).collect(),
        closed,
    }
}

/// A Catmull-Rom curve through `points`, as cubic Béziers.
fn catmull_rom(points: &[(f64, f64)]) -> Contour {
    let n = points.len();
    let at = |i: isize| points[i.clamp(0, n as isize - 1) as usize];
    let pts = (0..n as isize)
        .map(|i| {
            let (p, prev, next) = (at(i), at(i - 1), at(i + 1));
            let d = ((next.0 - prev.0) / 6.0, (next.1 - prev.1) / 6.0);
            Point {
                anchor: p,
                left: (p.0 - d.0, p.1 - d.1),
                right: (p.0 + d.0, p.1 + d.1),
            }
        })
        .collect();
    Contour {
        points: pts,
        closed: false,
    }
}

/// A pie slice (or ring segment when `hole` > 0): degrees clockwise from
/// 12 o'clock, arcs as cubic segments of at most 90°.
fn wedge(cx: f64, cy: f64, r: f64, hole: f64, start: f64, sweep: f64) -> Contour {
    let arc = |radius: f64, a0: f64, a1: f64| -> Vec<Point> {
        let segs = ((a1 - a0).abs() / 90.0).ceil().max(1.0) as usize;
        let step = (a1 - a0) / segs as f64;
        let pt = |a: f64| {
            let a = a.to_radians();
            (cx + radius * a.sin(), cy - radius * a.cos())
        };
        let tan = |a: f64| {
            let a = a.to_radians();
            (a.cos(), a.sin())
        };
        let k = 4.0 / 3.0 * (step.to_radians() / 4.0).tan() * radius;
        let mut out: Vec<Point> = Vec::new();
        for s in 0..=segs {
            let a = a0 + step * s as f64;
            let p = pt(a);
            let d = tan(a);
            out.push(Point {
                anchor: p,
                left: (p.0 - k * d.0, p.1 - k * d.1),
                right: (p.0 + k * d.0, p.1 + k * d.1),
            });
        }
        out
    };
    let full = sweep >= 359.999;
    let mut points = arc(r, start, start + sweep);
    if full && hole <= 0.0 {
        points.pop();
    } else if hole > 0.0 {
        let mut inner = arc(hole, start, start + sweep);
        inner.reverse();
        for p in &mut inner {
            std::mem::swap(&mut p.left, &mut p.right);
        }
        // The straight edges between the arcs keep corner handles.
        if let Some(last) = points.last_mut() {
            last.right = last.anchor;
        }
        if let Some(first) = inner.first_mut() {
            first.left = first.anchor;
        }
        points.extend(inner);
    } else {
        if let Some(last) = points.last_mut() {
            last.right = last.anchor;
        }
        if let Some(first) = points.first_mut() {
            first.left = first.anchor;
        }
        points.push(corner((cx, cy)));
    }
    Contour {
        points,
        closed: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quarter_wedge_is_one_arc_and_the_centre() {
        let c = contour(&Prim::Wedge {
            cx: 50.0,
            cy: 50.0,
            r: 10.0,
            hole: 0.0,
            start: 0.0,
            sweep: 90.0,
            fill: None,
            line: None,
        })
        .unwrap();
        assert!(c.closed);
        assert_eq!(c.points.len(), 3);
        assert_eq!(c.points[2].anchor, (50.0, 50.0));
        assert!((c.points[1].anchor.0 - 60.0).abs() < 1e-9);
    }

    #[test]
    fn a_flat_bar_has_no_outline() {
        let bar = Prim::Rect {
            x: 0.0,
            y: 0.0,
            w: 5.0,
            h: 0.0,
            fill: None,
            line: None,
        };
        assert!(contour(&bar).is_none());
    }
}
