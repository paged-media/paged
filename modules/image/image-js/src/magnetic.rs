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

//! The MAGNETIC LASSO (image ADR 470): a live-wire (Mortensen and
//! Barrett 1995, "Intelligent scissors") over the gradient magnitude.
//!
//! * COST: every pixel costs `1 − ĝ`, where ĝ is the Sobel gradient
//!   magnitude normalised by its 99th percentile; gradients below the
//!   CONTRAST option (0…1 of that scale) count as no edge at all. A step
//!   costs the target pixel's cost times the step length (1 or √2), plus
//!   a small length term so a flat region is crossed straight.
//! * WIDTH (px): the pointer snaps to the strongest edge within the width,
//!   and the wire is searched in the box spanning the last anchor and the
//!   snapped pointer, padded by the width.
//! * FREQUENCY (0…100): anchors are placed automatically once the live
//!   wire is longer than `10 + (100 − frequency) · 1.5` px, at the point
//!   that far back along the wire — the stable part of a wire is the part
//!   nearest the last anchor.
//!
//! The session holds the cost map (computed once per gesture) and the
//! fixed part of the outline; the pointer's live part is recomputed per
//! move. Interaction geometry, CPU.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// The tool options.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MagneticOptions {
    pub width: f32,
    pub contrast: f32,
    pub frequency: f32,
}

impl Default for MagneticOptions {
    fn default() -> Self {
        // Photoshop's defaults: width 10 px, contrast 10 %, frequency 57.
        MagneticOptions {
            width: 10.0,
            contrast: 0.1,
            frequency: 57.0,
        }
    }
}

/// One magnetic gesture.
pub struct MagneticSession {
    w: usize,
    h: usize,
    cost: Vec<f32>,
    edge: Vec<f32>,
    opts: MagneticOptions,
    /// The fixed outline, anchor to anchor (pixel centres).
    fixed: Vec<(u32, u32)>,
    anchors: Vec<(u32, u32)>,
    live: Vec<(u32, u32)>,
}

#[derive(PartialEq)]
struct Node(f32, usize);

impl Eq for Node {}

impl Ord for Node {
    fn cmp(&self, o: &Self) -> Ordering {
        o.0.total_cmp(&self.0).then(self.1.cmp(&o.1))
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

/// The normalised edge strength (0…1) of a straight RGBA8 image.
pub fn edge_strength(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    let l: Vec<f32> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .take(w * h)
        .map(|p| 0.299 * f32::from(p[0]) + 0.587 * f32::from(p[1]) + 0.114 * f32::from(p[2]))
        .collect();
    let at = |x: isize, y: isize| {
        l[(y.clamp(0, h as isize - 1) as usize) * w + x.clamp(0, w as isize - 1) as usize]
    };
    let mut g = vec![0f32; w * h];
    for y in 0..h as isize {
        for x in 0..w as isize {
            let gx = at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x - 1, y)
                - at(x - 1, y + 1);
            let gy = at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x, y - 1)
                - at(x + 1, y - 1);
            g[y as usize * w + x as usize] = (gx * gx + gy * gy).sqrt();
        }
    }
    let mut s = g.clone();
    s.sort_by(f32::total_cmp);
    let top = s[((s.len().max(1) - 1) as f32 * 0.99) as usize].max(1e-3);
    for v in &mut g {
        *v = (*v / top).min(1.0);
    }
    g
}

impl MagneticSession {
    /// Start at `(x, y)` (image px) over a straight RGBA8 image.
    pub fn begin(
        rgba: &[u8],
        width: u32,
        height: u32,
        x: f32,
        y: f32,
        opts: MagneticOptions,
    ) -> Option<Self> {
        let (w, h) = (width as usize, height as usize);
        if w == 0 || h == 0 || rgba.len() < w * h * 4 {
            return None;
        }
        let edge = edge_strength(rgba, w, h);
        let c = opts.contrast.clamp(0.0, 1.0);
        let cost = edge
            .iter()
            .map(|&e| if e < c { 1.0 } else { 1.0 - e })
            .collect();
        let mut s = MagneticSession {
            w,
            h,
            cost,
            edge,
            opts,
            fixed: Vec::new(),
            anchors: Vec::new(),
            live: Vec::new(),
        };
        let p = s.snap(x, y);
        s.anchors.push(p);
        s.fixed.push(p);
        Some(s)
    }

    fn clamp_px(&self, x: f32, y: f32) -> (u32, u32) {
        (
            (x.floor().max(0.0) as usize).min(self.w - 1) as u32,
            (y.floor().max(0.0) as usize).min(self.h - 1) as u32,
        )
    }

    /// The strongest edge pixel within the width of `(x, y)` (the pointer
    /// itself when nothing there passes the contrast).
    pub fn snap(&self, x: f32, y: f32) -> (u32, u32) {
        let (px, py) = self.clamp_px(x, y);
        let r = self.opts.width.max(0.0).round() as i64;
        // Only an edge STRONGER than the contrast option pulls the pointer;
        // the strongest wins, the nearest among equals.
        let mut best = (px, py);
        let mut best_e = self.opts.contrast.clamp(0.0, 1.0);
        let mut best_d = i64::MAX;
        let mut found = false;
        for dy in -r..=r {
            for dx in -r..=r {
                let d2 = dx * dx + dy * dy;
                if d2 > r * r {
                    continue;
                }
                let (qx, qy) = (i64::from(px) + dx, i64::from(py) + dy);
                if qx < 0 || qy < 0 || qx >= self.w as i64 || qy >= self.h as i64 {
                    continue;
                }
                let e = self.edge[qy as usize * self.w + qx as usize];
                let stronger = if found {
                    e > best_e + 1e-6 || ((e - best_e).abs() <= 1e-6 && d2 < best_d)
                } else {
                    e > best_e + 1e-6
                };
                if stronger {
                    found = true;
                    best_e = e;
                    best_d = d2;
                    best = (qx as u32, qy as u32);
                }
            }
        }
        best
    }

    /// The cheapest 8-connected path from `a` to `b` inside their box
    /// padded by the width.
    fn wire(&self, a: (u32, u32), b: (u32, u32)) -> Vec<(u32, u32)> {
        let pad = self.opts.width.max(2.0).round() as i64;
        let x0 = (i64::from(a.0.min(b.0)) - pad).max(0) as usize;
        let y0 = (i64::from(a.1.min(b.1)) - pad).max(0) as usize;
        let x1 = ((i64::from(a.0.max(b.0)) + pad) as usize).min(self.w - 1);
        let y1 = ((i64::from(a.1.max(b.1)) + pad) as usize).min(self.h - 1);
        let bw = x1 - x0 + 1;
        let bh = y1 - y0 + 1;
        let idx = |x: usize, y: usize| (y - y0) * bw + (x - x0);
        let mut dist = vec![f32::INFINITY; bw * bh];
        let mut prev = vec![usize::MAX; bw * bh];
        let start = idx(a.0 as usize, a.1 as usize);
        let goal = idx(b.0 as usize, b.1 as usize);
        dist[start] = 0.0;
        let mut heap = BinaryHeap::new();
        heap.push(Node(0.0, start));
        while let Some(Node(d, i)) = heap.pop() {
            if i == goal {
                break;
            }
            if d > dist[i] {
                continue;
            }
            let (lx, ly) = (i % bw, i / bw);
            for (dx, dy) in [
                (-1i64, -1i64),
                (0, -1),
                (1, -1),
                (-1, 0),
                (1, 0),
                (-1, 1),
                (0, 1),
                (1, 1),
            ] {
                let (nx, ny) = (lx as i64 + dx, ly as i64 + dy);
                if nx < 0 || ny < 0 || nx >= bw as i64 || ny >= bh as i64 {
                    continue;
                }
                let j = ny as usize * bw + nx as usize;
                let step = if dx != 0 && dy != 0 {
                    std::f32::consts::SQRT_2
                } else {
                    1.0
                };
                let c = self.cost[(ny as usize + y0) * self.w + nx as usize + x0];
                let nd = d + step * (c + 0.05);
                if nd < dist[j] {
                    dist[j] = nd;
                    prev[j] = i;
                    heap.push(Node(nd, j));
                }
            }
        }
        let mut out = Vec::new();
        let mut i = goal;
        while i != usize::MAX {
            out.push(((i % bw + x0) as u32, (i / bw + y0) as u32));
            if i == start {
                break;
            }
            i = prev[i];
        }
        out.reverse();
        out
    }

    fn auto_length(&self) -> f32 {
        10.0 + (100.0 - self.opts.frequency.clamp(0.0, 100.0)) * 1.5
    }

    /// The pointer moved: recompute the live wire, fixing anchors along
    /// it whenever it outgrows the frequency's length.
    pub fn move_to(&mut self, x: f32, y: f32) {
        let target = self.snap(x, y);
        loop {
            let last = *self.anchors.last().expect("begun with one anchor");
            let wire = self.wire(last, target);
            let len = self.auto_length();
            let mut acc = 0f32;
            let mut cut = None;
            for k in 1..wire.len() {
                let (a, b) = (wire[k - 1], wire[k]);
                acc += (a.0 as f32 - b.0 as f32).hypot(a.1 as f32 - b.1 as f32);
                if acc >= len && k + 1 < wire.len() {
                    cut = Some(k);
                    break;
                }
            }
            match cut {
                Some(k) => {
                    self.fixed.extend_from_slice(&wire[1..=k]);
                    self.anchors.push(wire[k]);
                }
                None => {
                    self.live = wire;
                    return;
                }
            }
        }
    }

    /// A click: fix the live wire up to the (snapped) point as an anchor.
    pub fn anchor_at(&mut self, x: f32, y: f32) {
        self.move_to(x, y);
        if self.live.len() > 1 {
            self.fixed.extend_from_slice(&self.live[1..]);
            self.anchors.push(*self.live.last().expect("non-empty"));
        }
        self.live.clear();
    }

    /// Backspace: drop the newest anchor (not the first).
    pub fn undo_anchor(&mut self) {
        if self.anchors.len() < 2 {
            return;
        }
        self.anchors.pop();
        let last = *self.anchors.last().expect("kept the first");
        if let Some(k) = self.fixed.iter().rposition(|&p| p == last) {
            self.fixed.truncate(k + 1);
        }
        self.live.clear();
    }

    pub fn anchors(&self) -> &[(u32, u32)] {
        &self.anchors
    }

    /// The whole outline so far — fixed then live — as pixel centres.
    pub fn outline(&self) -> Vec<[f32; 2]> {
        self.fixed
            .iter()
            .chain(self.live.iter().skip(1))
            .map(|&(x, y)| [x as f32 + 0.5, y as f32 + 0.5])
            .collect()
    }

    /// Close: the wire from the newest anchor back to the first; the
    /// closed polygon (pixel centres), or `None` with too few points.
    pub fn close(&mut self) -> Option<Vec<[f32; 2]>> {
        if !self.live.is_empty() && self.live.len() > 1 {
            self.fixed.extend_from_slice(&self.live[1..]);
            self.anchors.push(*self.live.last().expect("non-empty"));
        }
        self.live.clear();
        let first = self.anchors[0];
        let last = *self.anchors.last().expect("kept the first");
        if last != first {
            let back = self.wire(last, first);
            self.fixed.extend_from_slice(&back[1..]);
        }
        let poly = self.outline();
        (poly.len() >= 3).then_some(poly)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 40×40: a bright 20×20 square on a dark ground.
    fn square() -> Vec<u8> {
        let mut px = Vec::new();
        for y in 0..40u32 {
            for x in 0..40u32 {
                let v = if (10..30).contains(&x) && (10..30).contains(&y) {
                    220
                } else {
                    30
                };
                px.extend_from_slice(&[v, v, v, 255]);
            }
        }
        px
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_wire_hugs_the_edge_and_snaps_the_pointer__feat__image_selection_select_and_mask() {
        let px = square();
        let mut s = MagneticSession::begin(&px, 40, 40, 6.0, 6.0, MagneticOptions::default())
            .expect("begun");
        // The start snapped onto the square's corner region (an edge).
        let a0 = s.anchors()[0];
        assert!(
            (8..=11).contains(&a0.0) && (8..=11).contains(&a0.1),
            "{a0:?}"
        );
        // A pointer outside the square, near its top edge, pulls the wire
        // along the edge rather than straight through the dark.
        s.move_to(28.0, 7.0);
        let out = s.outline();
        assert!(
            out.iter().all(|p| (8.0..=12.0).contains(&p[1])),
            "the wire runs along the top edge: {out:?}"
        );
        // Around three more corners, then closed: the polygon hugs the
        // square, so its rasterization is the square, give or take the
        // edge pixels.
        s.anchor_at(29.0, 9.0);
        s.anchor_at(30.0, 29.0);
        s.anchor_at(10.0, 30.0);
        let poly = s.close().expect("closed");
        let cov = image_gpu::SelectionCoverage::rasterize_polygon(
            40,
            40,
            &poly.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>(),
        );
        assert_eq!(cov.coverage_at(20, 20), 255);
        assert_eq!(cov.coverage_at(3, 3), 0);
        let area = cov.data().iter().filter(|&&v| v >= 128).count();
        assert!(
            (300..=500).contains(&area),
            "about the 400-px square: {area}"
        );
    }

    #[test]
    fn frequency_places_anchors_and_backspace_removes_them() {
        let px = square();
        let opts = MagneticOptions {
            frequency: 100.0,
            ..MagneticOptions::default()
        };
        let mut s = MagneticSession::begin(&px, 40, 40, 10.0, 10.0, opts).unwrap();
        s.move_to(29.0, 10.0);
        // At frequency 100 an anchor is fixed every 10 px of wire.
        assert!(s.anchors().len() >= 2, "{:?}", s.anchors());
        let n = s.anchors().len();
        s.undo_anchor();
        assert_eq!(s.anchors().len(), n - 1);
        let first = s.anchors()[0];
        for _ in 0..10 {
            s.undo_anchor();
        }
        assert_eq!(s.anchors(), &[first], "the first anchor stays");
        assert!(MagneticSession::begin(&[], 0, 0, 0.0, 0.0, opts).is_none());
    }
}
