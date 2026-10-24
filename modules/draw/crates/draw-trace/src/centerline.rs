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

//! CENTRELINE tracing — line art in, OPEN STROKED paths out.
//!
//! The fill tracer walks the BOUNDARY of every dark region, so a pen line
//! comes back as a thin filled outline with two sides. Illustrator's Line
//! Art and Technical Drawing presets want the line itself: one path down
//! the middle of the ink, stroked at the ink's width. That is a different
//! algorithm, and it is this module:
//!
//! 1. **Threshold** — dark = luma below [`TraceOptions::bw_threshold`]
//!    (the BW mode's split, over the same composite-onto-white pixels).
//! 2. **Thin** — Zhang–Suen (1984), the two-sub-iteration parallel
//!    thinning, until nothing changes. What remains is a one-pixel-wide
//!    skeleton with the topology of the ink.
//! 3. **Clean the staircase** — Zhang–Suen leaves L-shaped corners where
//!    a diagonal step is drawn with an extra 4-neighbour. Such a pixel's
//!    neighbours are all connected to each other without it, so it is
//!    removed (and only such a pixel: an end has one neighbour, a line
//!    pixel two that do not touch, a junction neighbours that fall apart
//!    without it). Without this every diagonal would read as a chain of
//!    tiny junctions.
//! 4. **Walk the graph** — pixels with other than two neighbours are
//!    NODES (ends and junctions); every chain of two-neighbour pixels
//!    between two nodes is one stroke, and a chain that returns to itself
//!    with no node on it is a CLOSED stroke (a drawn circle). Spurs
//!    (a stroke from an end to a junction) and isolated scraps shorter
//!    than [`TraceOptions::filter_speckle`] pixels are dropped and
//!    counted.
//! 5. **Fit** — each chain of pixel centres is simplified (Ramer–Douglas–
//!    Peucker) and lowered to cubics: a turn sharper than
//!    [`TraceOptions::corner_threshold_deg`] stays a CORNER, everything
//!    else gets Catmull–Rom tangents with handles a third of the
//!    neighbouring segment long. Polygon path mode keeps every anchor a
//!    corner.
//! 6. **Width** — the ink's mean width: dark pixels over skeleton pixels
//!    (a line `w` wide and `l` long has `w·l` pixels and an `l`-pixel
//!    skeleton). One width for the whole trace — a variable-width stroke
//!    is not reconstructed.
//!
//! Deterministic: raster-order sweeps, no hashing in the output order.

use serde::Serialize;

use crate::contour::Anchor;
use crate::options::{PathMode, TraceOptions};

/// One traced centreline: an OPEN (or, for a drawn loop, closed) path in
/// PIXEL space, to be STROKED — never filled.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub anchors: Vec<Anchor>,
    /// A drawn loop with no end and no junction on it.
    pub closed: bool,
    /// Stroke width in PIXELS — the ink's mean width (module docs, 6).
    pub width: f64,
    /// Straight sRGB of the ink (black: line art is thresholded).
    pub color: [u8; 3],
    /// Skeleton pixels this stroke covers — what the ordering sorts on.
    pub pixels: usize,
}

/// What a centreline trace found.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Centerlines {
    pub strokes: Vec<Stroke>,
    /// Chains found before the speckle filter.
    pub found: usize,
    /// Spurs and scraps dropped by the speckle filter.
    pub speckles: usize,
}

/// A binary raster: `true` = ink.
pub struct Mask {
    pub width: usize,
    pub height: usize,
    pub bits: Vec<bool>,
}

impl Mask {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            bits: vec![false; width * height],
        }
    }

    fn at(&self, x: i64, y: i64) -> bool {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return false;
        }
        self.bits[y as usize * self.width + x as usize]
    }

    pub fn count(&self) -> usize {
        self.bits.iter().filter(|b| **b).count()
    }
}

/// The 8 neighbours, clockwise from north: P2..P9 in Zhang–Suen's
/// numbering.
const RING: [(i64, i64); 8] = [
    (0, -1),
    (1, -1),
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
];

fn ring_of(mask: &Mask, x: i64, y: i64) -> [bool; 8] {
    let mut out = [false; 8];
    for (k, (dx, dy)) in RING.iter().enumerate() {
        out[k] = mask.at(x + dx, y + dy);
    }
    out
}

/// Zhang–Suen thinning, in place, until stable.
pub fn thin(mask: &mut Mask) {
    let (w, h) = (mask.width as i64, mask.height as i64);
    loop {
        let mut changed = false;
        for pass in 0..2 {
            let mut remove: Vec<usize> = Vec::new();
            for y in 0..h {
                for x in 0..w {
                    if !mask.at(x, y) {
                        continue;
                    }
                    let p = ring_of(mask, x, y);
                    let b = p.iter().filter(|v| **v).count();
                    if !(2..=6).contains(&b) {
                        continue;
                    }
                    // A(P1): 0→1 transitions around the ring.
                    let a = (0..8).filter(|&k| !p[k] && p[(k + 1) % 8]).count();
                    if a != 1 {
                        continue;
                    }
                    // P2 = N, P4 = E, P6 = S, P8 = W.
                    let (n, e, s, wst) = (p[0], p[2], p[4], p[6]);
                    let ok = if pass == 0 {
                        !(n && e && s) && !(e && s && wst)
                    } else {
                        !(n && e && wst) && !(n && s && wst)
                    };
                    if ok {
                        remove.push(y as usize * mask.width + x as usize);
                    }
                }
            }
            if !remove.is_empty() {
                changed = true;
                for i in remove {
                    mask.bits[i] = false;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

/// How many 8-connected groups the set neighbours of a pixel fall into
/// (two set ring positions are adjacent when they are neighbours of each
/// other: consecutive on the ring, or a corner and the two edges next to
/// it, which consecutiveness already covers).
fn neighbour_groups(p: &[bool; 8]) -> usize {
    let mut seen = [false; 8];
    let mut groups = 0;
    for start in 0..8 {
        if !p[start] || seen[start] {
            continue;
        }
        groups += 1;
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(k) = stack.pop() {
            let mut next = vec![(k + 1) % 8, (k + 7) % 8];
            // An EDGE neighbour (even k) also touches the edge two away
            // only through the corner between them — already consecutive.
            // A CORNER neighbour (odd k) touches its two edge neighbours,
            // which are consecutive too. Edge-to-edge across a corner
            // (N and E) are diagonal neighbours of each other:
            if k % 2 == 0 {
                next.push((k + 2) % 8);
                next.push((k + 6) % 8);
            }
            for j in next {
                if p[j] && !seen[j] {
                    seen[j] = true;
                    stack.push(j);
                }
            }
        }
    }
    groups
}

/// Remove staircase pixels (module docs, 3): a pixel with two or more
/// neighbours that all stay connected without it. Raster-order sweeps
/// until stable.
pub fn clean_staircase(mask: &mut Mask) {
    let (w, h) = (mask.width as i64, mask.height as i64);
    loop {
        let mut changed = false;
        for y in 0..h {
            for x in 0..w {
                if !mask.at(x, y) {
                    continue;
                }
                let p = ring_of(mask, x, y);
                let b = p.iter().filter(|v| **v).count();
                if (2..=4).contains(&b) && neighbour_groups(&p) == 1 {
                    mask.bits[y as usize * mask.width + x as usize] = false;
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
}

fn neighbours(mask: &Mask, i: usize) -> Vec<usize> {
    let (x, y) = ((i % mask.width) as i64, (i / mask.width) as i64);
    RING.iter()
        .filter(|(dx, dy)| mask.at(x + dx, y + dy))
        .map(|(dx, dy)| ((y + dy) as usize) * mask.width + (x + dx) as usize)
        .collect()
}

/// The skeleton's chains (module docs, 4), as pixel-index lists, with
/// whether each one is closed and whether either end is a free END
/// (degree 1).
fn chains(mask: &Mask) -> Vec<(Vec<usize>, bool, usize)> {
    let n = mask.width * mask.height;
    let degree: Vec<usize> = (0..n)
        .map(|i| {
            if mask.bits[i] {
                neighbours(mask, i).len()
            } else {
                0
            }
        })
        .collect();
    let mut used = std::collections::BTreeSet::<(usize, usize)>::new();
    let edge = |a: usize, b: usize| (a.min(b), a.max(b));
    let mut out = Vec::new();
    // Chains between nodes.
    for start in 0..n {
        if !mask.bits[start] || degree[start] == 2 {
            continue;
        }
        if degree[start] == 0 {
            out.push((vec![start], false, 2));
            continue;
        }
        for first in neighbours(mask, start) {
            if used.contains(&edge(start, first)) {
                continue;
            }
            used.insert(edge(start, first));
            let mut chain = vec![start, first];
            let (mut prev, mut cur) = (start, first);
            while degree[cur] == 2 {
                let next = neighbours(mask, cur).into_iter().find(|&m| m != prev);
                let Some(next) = next else { break };
                if used.contains(&edge(cur, next)) {
                    break;
                }
                used.insert(edge(cur, next));
                chain.push(next);
                prev = cur;
                cur = next;
            }
            let ends = usize::from(degree[start] == 1) + usize::from(degree[cur] == 1);
            out.push((chain, false, ends));
        }
    }
    // Loops: two-neighbour pixels no node-to-node walk reached.
    let mut on_chain = vec![false; n];
    for (chain, _, _) in &out {
        for &i in chain {
            on_chain[i] = true;
        }
    }
    for start in 0..n {
        if !mask.bits[start] || degree[start] != 2 || on_chain[start] {
            continue;
        }
        let mut chain = vec![start];
        on_chain[start] = true;
        let mut prev = start;
        let mut cur = neighbours(mask, start)[0];
        while cur != start {
            if on_chain[cur] {
                break;
            }
            on_chain[cur] = true;
            chain.push(cur);
            let next = neighbours(mask, cur).into_iter().find(|&m| m != prev);
            let Some(next) = next else { break };
            prev = cur;
            cur = next;
        }
        out.push((chain, true, 0));
    }
    out
}

/// Ramer–Douglas–Peucker over a polyline; the first and last point stay.
pub fn rdp(points: &[[f64; 2]], tolerance: f64) -> Vec<[f64; 2]> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (pa, pb) = (points[a], points[b]);
        let (dx, dy) = (pb[0] - pa[0], pb[1] - pa[1]);
        let len = (dx * dx + dy * dy).sqrt();
        let mut far = a;
        let mut far_d = -1.0;
        for (i, p) in points.iter().enumerate().take(b).skip(a + 1) {
            let d = if len < 1e-12 {
                ((p[0] - pa[0]).powi(2) + (p[1] - pa[1]).powi(2)).sqrt()
            } else {
                ((p[0] - pa[0]) * dy - (p[1] - pa[1]) * dx).abs() / len
            };
            if d > far_d {
                far_d = d;
                far = i;
            }
        }
        if far_d > tolerance {
            keep[far] = true;
            stack.push((a, far));
            stack.push((far, b));
        }
    }
    points
        .iter()
        .zip(keep)
        .filter(|(_, k)| *k)
        .map(|(p, _)| *p)
        .collect()
}

fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

fn len(v: [f64; 2]) -> f64 {
    (v[0] * v[0] + v[1] * v[1]).sqrt()
}

/// Lower a simplified polyline to anchor triples (module docs, 5).
pub fn fit(points: &[[f64; 2]], closed: bool, corner_deg: f64, polygon: bool) -> Vec<Anchor> {
    let n = points.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let p = points[i];
        let prev = if i > 0 {
            Some(points[i - 1])
        } else if closed {
            Some(points[n - 1])
        } else {
            None
        };
        let next = if i + 1 < n {
            Some(points[i + 1])
        } else if closed {
            Some(points[0])
        } else {
            None
        };
        let (Some(a), Some(b)) = (prev, next) else {
            out.push(Anchor::corner(p));
            continue;
        };
        if polygon {
            out.push(Anchor::corner(p));
            continue;
        }
        let (u, v) = (sub(p, a), sub(b, p));
        let (lu, lv) = (len(u), len(v));
        if lu < 1e-9 || lv < 1e-9 {
            out.push(Anchor::corner(p));
            continue;
        }
        let cos = ((u[0] * v[0] + u[1] * v[1]) / (lu * lv)).clamp(-1.0, 1.0);
        let turn = cos.acos().to_degrees();
        if turn > corner_deg {
            out.push(Anchor::corner(p));
            continue;
        }
        let t = sub(b, a);
        let lt = len(t).max(1e-12);
        let dir = [t[0] / lt, t[1] / lt];
        out.push(Anchor {
            anchor: p,
            left: [p[0] - dir[0] * lu / 3.0, p[1] - dir[1] * lu / 3.0],
            right: [p[0] + dir[0] * lv / 3.0, p[1] + dir[1] * lv / 3.0],
        });
    }
    out
}

/// Trace `mask`'s centrelines (the whole pipeline after thresholding).
pub fn trace_centerlines(mut mask: Mask, options: TraceOptions) -> Centerlines {
    let ink = mask.count();
    thin(&mut mask);
    clean_staircase(&mut mask);
    let skeleton = mask.count();
    if skeleton == 0 {
        return Centerlines::default();
    }
    let width = (ink as f64 / skeleton as f64).max(1.0);
    let tolerance = (options.segment_length * 0.25).max(0.75);
    let polygon = options.path_mode == PathMode::Polygon;
    let mut result = Centerlines::default();
    for (chain, closed, ends) in chains(&mask) {
        // Two junction pixels side by side are ONE junction: the link
        // between them is not a stroke.
        if !closed && ends == 0 && chain.len() <= 2 {
            continue;
        }
        result.found += 1;
        // A scrap (both ends free) or a spur (one end free) shorter than
        // the speckle gate is noise; a chain between two junctions is
        // structure and always stays.
        if ends > 0 && chain.len() < options.filter_speckle.max(2) {
            result.speckles += 1;
            continue;
        }
        let pts: Vec<[f64; 2]> = chain
            .iter()
            .map(|&i| [(i % mask.width) as f64 + 0.5, (i / mask.width) as f64 + 0.5])
            .collect();
        let simplified = if closed {
            // RDP needs two fixed ends: split the loop at its far point.
            let far = (1..pts.len())
                .max_by(|&a, &b| {
                    len(sub(pts[a], pts[0]))
                        .partial_cmp(&len(sub(pts[b], pts[0])))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .unwrap_or(0);
            let mut first = rdp(&pts[..=far], tolerance);
            let mut rest: Vec<[f64; 2]> = pts[far..].to_vec();
            rest.push(pts[0]);
            let second = rdp(&rest, tolerance);
            first.pop();
            first.extend(second);
            first.pop(); // the repeated start
            first
        } else {
            rdp(&pts, tolerance)
        };
        if simplified.len() < 2 || (closed && simplified.len() < 3) {
            result.speckles += 1;
            continue;
        }
        result.strokes.push(Stroke {
            anchors: fit(&simplified, closed, options.corner_threshold_deg, polygon),
            closed,
            width,
            color: [0, 0, 0],
            pixels: chain.len(),
        });
    }
    result.strokes.sort_by_key(|s| std::cmp::Reverse(s.pixels));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask_of(w: usize, h: usize, ink: impl Fn(usize, usize) -> bool) -> Mask {
        let mut m = Mask::new(w, h);
        for y in 0..h {
            for x in 0..w {
                m.bits[y * w + x] = ink(x, y);
            }
        }
        m
    }

    #[test]
    fn a_thick_horizontal_bar_thins_to_a_one_pixel_line() {
        let mut m = mask_of(40, 15, |x, y| (5..35).contains(&x) && (5..10).contains(&y));
        thin(&mut m);
        clean_staircase(&mut m);
        // Every column the bar covers keeps at most ONE pixel.
        for x in 0..40 {
            let col = (0..15).filter(|&y| m.bits[y * 40 + x]).count();
            assert!(col <= 1, "column {x} kept {col} pixels");
        }
        assert!(m.count() >= 20, "the skeleton kept {} pixels", m.count());
    }

    #[test]
    fn thinning_preserves_a_ring_as_a_loop() {
        let mut m = mask_of(40, 40, |x, y| {
            let (dx, dy) = (x as f64 - 19.5, y as f64 - 19.5);
            let r = (dx * dx + dy * dy).sqrt();
            (12.0..16.0).contains(&r)
        });
        thin(&mut m);
        clean_staircase(&mut m);
        let found = chains(&m);
        assert_eq!(found.len(), 1, "one closed chain");
        assert!(found[0].1, "the chain is closed");
    }

    #[test]
    fn neighbour_groups_tell_a_corner_from_a_line() {
        // N and E: one group (they touch diagonally).
        let mut p = [false; 8];
        p[0] = true;
        p[2] = true;
        assert_eq!(neighbour_groups(&p), 1);
        // N and S: two.
        let mut q = [false; 8];
        q[0] = true;
        q[4] = true;
        assert_eq!(neighbour_groups(&q), 2);
    }

    #[test]
    fn rdp_keeps_the_ends_and_the_corner() {
        let pts: Vec<[f64; 2]> = (0..10)
            .map(|i| [i as f64, 0.0])
            .chain((1..10).map(|i| [9.0, i as f64]))
            .collect();
        let out = rdp(&pts, 0.5);
        assert_eq!(out, vec![[0.0, 0.0], [9.0, 0.0], [9.0, 9.0]]);
    }

    #[test]
    fn fit_keeps_sharp_turns_as_corners_and_smooths_gentle_ones() {
        let sharp = fit(&[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]], false, 60.0, false);
        assert_eq!(sharp[1].left, sharp[1].anchor);
        let gentle = fit(&[[0.0, 0.0], [10.0, 1.0], [20.0, 0.0]], false, 60.0, false);
        assert_ne!(gentle[1].left, gentle[1].anchor);
        assert_ne!(gentle[1].right, gentle[1].anchor);
        // The ends of an open stroke are corners.
        assert_eq!(gentle[0].left, gentle[0].anchor);
        let poly = fit(&[[0.0, 0.0], [10.0, 1.0], [20.0, 0.0]], false, 60.0, true);
        assert!(poly
            .iter()
            .all(|a| a.left == a.anchor && a.right == a.anchor));
    }

    #[test]
    fn a_plus_sign_traces_to_four_strokes_meeting_at_a_junction() {
        let m = mask_of(41, 41, |x, y| {
            ((18..23).contains(&x) && (2..39).contains(&y))
                || ((18..23).contains(&y) && (2..39).contains(&x))
        });
        let out = trace_centerlines(m, TraceOptions::default());
        assert_eq!(out.strokes.len(), 4, "{:?}", out.strokes.len());
        for s in &out.strokes {
            assert!(!s.closed);
            assert!((s.width - 5.0).abs() < 1.5, "width {}", s.width);
        }
    }

    #[test]
    fn speckles_are_dropped_and_counted() {
        let m = mask_of(30, 30, |x, y| {
            (x == 3 && y == 3) || ((5..25).contains(&x) && (14..17).contains(&y))
        });
        let out = trace_centerlines(m, TraceOptions::default());
        assert_eq!(out.strokes.len(), 1);
        assert!(out.speckles >= 1);
    }
}
