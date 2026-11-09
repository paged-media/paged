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

//! Shortening an open run of anchors along its curve: the stroke of a line
//! under its arrowheads (engine ADR 1093). InDesign, Word and PowerPoint all
//! end the stroke inside the head instead of at the tip, so the stroke does
//! not poke out past the tip or show inside a hollow head. The renderer
//! trims the engine's line ends with it, paged.doc the heads it draws itself.

use kurbo::{CubicBez, ParamCurve, ParamCurveArclen, Point};
use paged_model::PathAnchor;

/// Arc-length accuracy, in pt.
const ACCURACY: f64 = 1e-3;

fn pt(p: (f32, f32)) -> Point {
    Point::new(p.0 as f64, p.1 as f64)
}

fn tup(p: Point) -> (f32, f32) {
    (p.x as f32, p.y as f32)
}

fn segment(from: &PathAnchor, to: &PathAnchor) -> CubicBez {
    CubicBez::new(pt(from.anchor), pt(from.right), pt(to.left), pt(to.anchor))
}

/// The run backwards: the anchors in reverse order, each with its two
/// handles swapped.
fn reversed(run: &[PathAnchor]) -> Vec<PathAnchor> {
    run.iter()
        .rev()
        .map(|a| PathAnchor {
            anchor: a.anchor,
            left: a.right,
            right: a.left,
        })
        .collect()
}

/// `run` with its first `d` pt removed. `None` when `d` reaches past its end.
fn trim_start(run: &[PathAnchor], d: f64) -> Option<Vec<PathAnchor>> {
    if d <= 0.0 {
        return Some(run.to_vec());
    }
    let mut left = d;
    for i in 0..run.len().saturating_sub(1) {
        let seg = segment(&run[i], &run[i + 1]);
        let len = seg.arclen(ACCURACY);
        if left < len {
            let t = seg.inv_arclen(left, ACCURACY);
            let rest = seg.subsegment(t..1.0);
            let mut out = Vec::with_capacity(run.len() - i);
            out.push(PathAnchor {
                anchor: tup(rest.p0),
                left: tup(rest.p0),
                right: tup(rest.p1),
            });
            out.push(PathAnchor {
                left: tup(rest.p2),
                ..run[i + 1]
            });
            out.extend_from_slice(&run[i + 2..]);
            return Some(out);
        }
        left -= len;
    }
    None
}

/// The length of an open run along its curve, in pt.
pub fn run_length(run: &[PathAnchor]) -> f32 {
    run.windows(2)
        .map(|w| segment(&w[0], &w[1]).arclen(ACCURACY))
        .sum::<f64>() as f32
}

/// `run` (an open contour) shortened by `start` pt at its first anchor and
/// `end` pt at its last, measured along the curve. The curve keeps its
/// shape: a cut segment is split, not re-fitted. `None` when the two
/// together take the whole run, so nothing of the stroke is left.
pub fn trim_run(run: &[PathAnchor], start: f32, end: f32) -> Option<Vec<PathAnchor>> {
    if run.len() < 2 {
        return Some(run.to_vec());
    }
    let (start, end) = (start.max(0.0) as f64, end.max(0.0) as f64);
    if start == 0.0 && end == 0.0 {
        return Some(run.to_vec());
    }
    let total = run_length(run) as f64;
    if start + end >= total {
        return None;
    }
    let cut = trim_start(run, start)?;
    let cut = trim_start(&reversed(&cut), end)?;
    Some(reversed(&cut))
}

/// The point a distance `d` pt along `run` from its first anchor (for
/// tests and callers that place something on the curve).
pub fn point_along(run: &[PathAnchor], d: f32) -> Option<(f32, f32)> {
    trim_start(run, d.max(0.0) as f64).and_then(|r| r.first().map(|a| a.anchor))
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

    fn close(a: (f32, f32), b: (f32, f32)) -> bool {
        (a.0 - b.0).abs() < 1e-3 && (a.1 - b.1).abs() < 1e-3
    }

    #[test]
    fn a_straight_line_is_shortened_at_both_ends() {
        let run = [corner(0.0, 0.0), corner(100.0, 0.0)];
        let t = trim_run(&run, 10.0, 25.0).unwrap();
        assert_eq!(t.len(), 2);
        assert!(close(t[0].anchor, (10.0, 0.0)), "{t:?}");
        assert!(close(t[1].anchor, (75.0, 0.0)), "{t:?}");
    }

    #[test]
    fn a_cut_walks_past_short_segments() {
        // A zig-zag: 50 + 50 pt; cutting 60 from the start lands 10 pt
        // into the second segment, which becomes the first.
        let run = [corner(0.0, 0.0), corner(30.0, 40.0), corner(60.0, 0.0)];
        let t = trim_run(&run, 60.0, 0.0).unwrap();
        assert_eq!(t.len(), 2);
        assert!(close(t[0].anchor, (36.0, 32.0)), "{t:?}");
        assert!(close(t[1].anchor, (60.0, 0.0)), "{t:?}");
    }

    #[test]
    fn a_curve_keeps_its_shape() {
        // A quarter circle of radius 100: trimming a quarter of its length
        // from each end leaves the middle half, still on the circle.
        let k = 100.0 * crate::KAPPA_F32;
        let run = [
            PathAnchor {
                anchor: (100.0, 0.0),
                left: (100.0, 0.0),
                right: (100.0, k),
            },
            PathAnchor {
                anchor: (0.0, 100.0),
                left: (k, 100.0),
                right: (0.0, 100.0),
            },
        ];
        let len = run_length(&run);
        assert!(
            (len - std::f32::consts::FRAC_PI_2 * 100.0).abs() < 0.1,
            "{len}"
        );
        let t = trim_run(&run, len / 4.0, len / 4.0).unwrap();
        for a in [t[0].anchor, t[1].anchor] {
            let r = (a.0 * a.0 + a.1 * a.1).sqrt();
            assert!((r - 100.0).abs() < 0.05, "{a:?} r={r}");
        }
        assert!((run_length(&t) - len / 2.0).abs() < 0.05);
    }

    #[test]
    fn nothing_is_left_when_the_cuts_meet() {
        let run = [corner(0.0, 0.0), corner(10.0, 0.0)];
        assert!(trim_run(&run, 6.0, 4.0).is_none());
        assert!(trim_run(&run, 0.0, 0.0).is_some());
    }

    #[test]
    fn a_point_along_the_run() {
        let run = [corner(0.0, 0.0), corner(0.0, 10.0), corner(10.0, 10.0)];
        assert!(close(point_along(&run, 15.0).unwrap(), (5.0, 10.0)));
    }
}
