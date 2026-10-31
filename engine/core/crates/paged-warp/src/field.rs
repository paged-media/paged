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

//! DISPLACEMENT FIELDS: the backward map of a free-form raster warp, and
//! LIQUIFY — the brushes that edit one (WP5.6).
//!
//! # The field
//!
//! A [`Field`] answers, for an output pixel, where in the source it reads:
//! `source(x, y) = (x, y) + D(x, y)`, in TAP coordinates (pixel `i`'s
//! centre is `i`; continuous coordinates differ by the half pixel on both
//! sides, so `D` is the same in either). `D` is stored at the nodes of a
//! regular grid — node `(i, j)` sits on pixel `(i·step, j·step)` — and
//! interpolated bilinearly between them; `step` 1 is a dense per-pixel
//! map (Puppet Warp's), a larger step the coarse mesh Liquify edits. A
//! node whose displacement is NaN reads NO source: the output there is
//! transparent, and so is every pixel whose four nodes include one
//! (Puppet Warp's outside of the mesh).
//!
//! The image module's `geom.warp_field` kernel samples the same field on
//! the GPU and `paged-resample`'s `warp_map_rgba8` on the CPU.
//!
//! # Liquify
//!
//! Each tool is one rule for how a DAB (a brush footprint at a centre)
//! rewrites the field, derived from the backward map: if the warped image
//! is `out(q) = src(q + D(q))` and a tool wants `out'(q) = out(m(q))` for
//! a map `m` (where each pixel now reads from), then
//! `D'(q) = D(m(q)) + m(q) − q`. With the brush weight `w(q)` (the
//! falloff times the pressure, times what the freeze mask leaves):
//!
//! - Forward Warp: `m(q) = q − w·δ`, `δ` the brush's move since its last
//!   dab — what was under the brush is dragged along;
//! - Push Left: the same with `δ` turned a quarter to the left of the
//!   drag (dragging up pushes left);
//! - Twirl clockwise / counter-clockwise: `m(q) = c + R(∓θ·w)(q − c)`;
//! - Pucker: `m(q) = c + (q − c)(1 + s·w)` — each pixel reads from
//!   farther out, so the content contracts towards the centre; Bloat
//!   with `−s`;
//! - Reconstruct: `D'(q) = D(q)·(1 − r·w)`, back towards the original;
//! - Smooth: `D'(q) = D(q) + r·w·(mean of the four neighbours − D(q))`;
//! - Freeze / Thaw paint the FREEZE MASK (0..1 per node), which scales
//!   every other tool's weight by `1 − freeze`.
//!
//! Every dab reads the field as it was before the dab (a copy of the
//! footprint), so the result does not depend on the scan order. A stroke
//! places dabs along its polyline every quarter brush radius (Forward
//! Warp: every tenth). These are this crate's own rules after the
//! published descriptions of Photoshop's Liquify tools (Photoshop User
//! Guide, "Liquify filter"); the falloff, the per-dab amounts and the dab
//! spacing are this crate's choices, not Photoshop's.

use std::f64::consts::PI;

/// A displacement field on a grid (see the module note).
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    /// The pixel extent the field covers.
    pub width: u32,
    pub height: u32,
    /// Pixels between nodes (≥ 1).
    pub step: u32,
    /// Nodes per row and per column.
    pub cols: u32,
    pub rows: u32,
    /// `(dx, dy)` per node, row-major; NaN = no source.
    pub d: Vec<[f32; 2]>,
}

impl Field {
    /// The identity field over `width`×`height` with nodes every `step`
    /// pixels (the last node row and column reach or pass the last pixel).
    pub fn new(width: u32, height: u32, step: u32) -> Self {
        let step = step.max(1);
        let nodes = |n: u32| n.saturating_sub(1).div_ceil(step) + 1;
        let (cols, rows) = (nodes(width), nodes(height));
        Self {
            width,
            height,
            step,
            cols,
            rows,
            d: vec![[0.0; 2]; cols as usize * rows as usize],
        }
    }

    /// The node step that keeps the longer side at no more than
    /// `max_nodes` nodes (Liquify's mesh).
    pub fn step_for(width: u32, height: u32, max_nodes: u32) -> u32 {
        let long = width.max(height).max(1);
        long.div_ceil(max_nodes.max(2) - 1).max(1)
    }

    /// Does every node read its own pixel?
    pub fn is_identity(&self) -> bool {
        self.d.iter().all(|v| v[0] == 0.0 && v[1] == 0.0)
    }

    fn at(&self, i: u32, j: u32) -> [f32; 2] {
        self.d[(j.min(self.rows - 1) * self.cols + i.min(self.cols - 1)) as usize]
    }

    /// The displacement at pixel `(x, y)` (tap coordinates; clamped to the
    /// grid), bilinear between the nodes; `None` where a node of the cell
    /// reads no source.
    pub fn displacement(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let s = f64::from(self.step);
        let gx = (x / s).clamp(0.0, f64::from(self.cols - 1));
        let gy = (y / s).clamp(0.0, f64::from(self.rows - 1));
        let (i0, j0) = (gx.floor(), gy.floor());
        let (fx, fy) = (gx - i0, gy - j0);
        let (i0, j0) = (i0 as u32, j0 as u32);
        let n = [
            self.at(i0, j0),
            self.at(i0 + 1, j0),
            self.at(i0, j0 + 1),
            self.at(i0 + 1, j0 + 1),
        ];
        if n.iter().any(|v| v[0].is_nan() || v[1].is_nan()) {
            return None;
        }
        let lerp = |c: usize| {
            let top = f64::from(n[0][c]) * (1.0 - fx) + f64::from(n[1][c]) * fx;
            let bot = f64::from(n[2][c]) * (1.0 - fx) + f64::from(n[3][c]) * fx;
            top * (1.0 - fy) + bot * fy
        };
        Some((lerp(0), lerp(1)))
    }

    /// Where output pixel `(x, y)` reads in the source (tap coordinates).
    pub fn source(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        self.displacement(x, y).map(|(dx, dy)| (x + dx, y + dy))
    }

    /// Node `(i, j)`'s pixel position.
    pub fn node_px(&self, i: u32, j: u32) -> (f64, f64) {
        (f64::from(i * self.step), f64::from(j * self.step))
    }

    /// The field scaled to a `width`×`height` copy of the image (a proxy
    /// preview): the same node count, every displacement scaled with it.
    pub fn scaled(&self, width: u32, height: u32) -> Field {
        let mut out = Field::new(width, height, 1);
        let (sx, sy) = (
            f64::from(width) / f64::from(self.width.max(1)),
            f64::from(height) / f64::from(self.height.max(1)),
        );
        out.step = ((f64::from(self.step) * sx.max(sy)).round() as u32).max(1);
        let nodes = |n: u32| n.saturating_sub(1).div_ceil(out.step) + 1;
        out.cols = nodes(width);
        out.rows = nodes(height);
        out.d = vec![[0.0; 2]; out.cols as usize * out.rows as usize];
        for j in 0..out.rows {
            for i in 0..out.cols {
                let (px, py) = out.node_px(i, j);
                let v = self
                    .displacement(px / sx, py / sy)
                    .map(|(dx, dy)| [(dx * sx) as f32, (dy * sy) as f32])
                    .unwrap_or([f32::NAN; 2]);
                out.d[(j * out.cols + i) as usize] = v;
            }
        }
        out
    }
}

/// The Liquify tools (Photoshop's Liquify filter, without the face and
/// the mask-from-selection tools).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiquifyTool {
    ForwardWarp,
    Reconstruct,
    Smooth,
    TwirlClockwise,
    TwirlCounterClockwise,
    Pucker,
    Bloat,
    PushLeft,
    Freeze,
    Thaw,
}

impl LiquifyTool {
    /// Every tool, in the order of the wire code.
    pub const ALL: [LiquifyTool; 10] = [
        LiquifyTool::ForwardWarp,
        LiquifyTool::Reconstruct,
        LiquifyTool::Smooth,
        LiquifyTool::TwirlClockwise,
        LiquifyTool::TwirlCounterClockwise,
        LiquifyTool::Pucker,
        LiquifyTool::Bloat,
        LiquifyTool::PushLeft,
        LiquifyTool::Freeze,
        LiquifyTool::Thaw,
    ];

    /// The tool of wire code `n` (its index in [`Self::ALL`]).
    pub fn from_code(n: u32) -> Option<Self> {
        Self::ALL.get(n as usize).copied()
    }

    fn spacing(self) -> f64 {
        match self {
            LiquifyTool::ForwardWarp | LiquifyTool::PushLeft => 0.1,
            _ => 0.25,
        }
    }
}

/// A Liquify brush. `size` is the diameter in px; `pressure`, `density`
/// (how much of the radius is feathered) and `rate` (the per-dab amount
/// of the stationary tools) are 0..1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Brush {
    pub size: f64,
    pub pressure: f64,
    pub density: f64,
    pub rate: f64,
}

impl Brush {
    /// The brush weight at distance `d` from the centre: 1 inside the hard
    /// core, a raised-cosine fall to 0 at the radius, times the pressure.
    pub fn weight(&self, d: f64) -> f64 {
        let r = self.size / 2.0;
        if r <= 0.0 || d >= r {
            return 0.0;
        }
        let t = d / r;
        let core = (1.0 - self.density.clamp(0.0, 1.0)).clamp(0.0, 0.999);
        let f = if t <= core {
            1.0
        } else {
            0.5 * (1.0 + (PI * (t - core) / (1.0 - core)).cos())
        };
        f * self.pressure.clamp(0.0, 1.0)
    }
}

/// The largest twirl per dab at full weight and rate (radians).
pub const TWIRL_PER_DAB: f64 = 0.06;
/// The largest pucker / bloat scale per dab at full weight and rate.
pub const PUCKER_PER_DAB: f64 = 0.04;

/// A Liquify session's state: the field and the freeze mask (per node).
#[derive(Debug, Clone, PartialEq)]
pub struct Liquify {
    pub field: Field,
    pub freeze: Vec<f32>,
}

impl Liquify {
    /// An undistorted, unfrozen mesh over `width`×`height`, at most
    /// `max_nodes` nodes on the longer side.
    pub fn new(width: u32, height: u32, max_nodes: u32) -> Self {
        let field = Field::new(width, height, Field::step_for(width, height, max_nodes));
        let n = field.d.len();
        Self {
            field,
            freeze: vec![0.0; n],
        }
    }

    /// One stroke: dabs of `tool` along the polyline `points` (px), spaced
    /// by a fraction of the brush radius. A single point is one dab.
    pub fn stroke(&mut self, tool: LiquifyTool, brush: &Brush, points: &[(f64, f64)]) {
        let Some(&first) = points.first() else {
            return;
        };
        let spacing = (brush.size / 2.0 * tool.spacing()).max(0.5);
        if points.len() == 1 {
            self.dab(tool, brush, first, (0.0, 0.0));
            return;
        }
        let mut last = first;
        // Stationary tools put a dab where the stroke starts.
        if !matches!(tool, LiquifyTool::ForwardWarp | LiquifyTool::PushLeft) {
            self.dab(tool, brush, first, (0.0, 0.0));
        }
        let mut carried = 0.0;
        for seg in points.windows(2) {
            let (a, b) = (seg[0], seg[1]);
            let len = (b.0 - a.0).hypot(b.1 - a.1);
            if len <= 0.0 {
                continue;
            }
            let mut t = spacing - carried;
            while t <= len {
                let p = (a.0 + (b.0 - a.0) * t / len, a.1 + (b.1 - a.1) * t / len);
                self.dab(tool, brush, p, (p.0 - last.0, p.1 - last.1));
                last = p;
                t += spacing;
            }
            carried = len - (t - spacing);
        }
    }

    /// One dab at `c`; `delta` is the brush's move since its last dab.
    pub fn dab(&mut self, tool: LiquifyTool, brush: &Brush, c: (f64, f64), delta: (f64, f64)) {
        let f = &self.field;
        let r = brush.size / 2.0;
        if r <= 0.0 {
            return;
        }
        let s = f64::from(f.step);
        let i0 = ((c.0 - r) / s).floor().max(0.0) as u32;
        let j0 = ((c.1 - r) / s).floor().max(0.0) as u32;
        let i1 = (((c.0 + r) / s).ceil().max(0.0) as u32).min(f.cols - 1);
        let j1 = (((c.1 + r) / s).ceil().max(0.0) as u32).min(f.rows - 1);
        if i0 > i1 || j0 > j1 {
            return;
        }
        let mut writes: Vec<(usize, [f32; 2])> = Vec::new();
        let mut freezes: Vec<(usize, f32)> = Vec::new();
        for j in j0..=j1 {
            for i in i0..=i1 {
                let q = f.node_px(i, j);
                let wb = brush.weight((q.0 - c.0).hypot(q.1 - c.1));
                if wb <= 0.0 {
                    continue;
                }
                let k = (j * f.cols + i) as usize;
                match tool {
                    LiquifyTool::Freeze => {
                        freezes.push((k, (f64::from(self.freeze[k]) + wb).min(1.0) as f32));
                        continue;
                    }
                    LiquifyTool::Thaw => {
                        freezes.push((k, (f64::from(self.freeze[k]) * (1.0 - wb)).max(0.0) as f32));
                        continue;
                    }
                    _ => {}
                }
                let w = wb * (1.0 - f64::from(self.freeze[k]));
                if w <= 0.0 {
                    continue;
                }
                let own = f.d[k];
                if own[0].is_nan() {
                    continue;
                }
                let rate = brush.rate.clamp(0.0, 1.0);
                let from = |m: (f64, f64)| -> Option<[f32; 2]> {
                    let (dx, dy) = f.displacement(m.0, m.1)?;
                    Some([(dx + m.0 - q.0) as f32, (dy + m.1 - q.1) as f32])
                };
                let new = match tool {
                    LiquifyTool::ForwardWarp => from((q.0 - w * delta.0, q.1 - w * delta.1)),
                    LiquifyTool::PushLeft => {
                        let left = (delta.1, -delta.0);
                        from((q.0 - w * left.0, q.1 - w * left.1))
                    }
                    LiquifyTool::TwirlClockwise | LiquifyTool::TwirlCounterClockwise => {
                        let sign = if tool == LiquifyTool::TwirlClockwise {
                            -1.0
                        } else {
                            1.0
                        };
                        let th = sign * TWIRL_PER_DAB * rate * w;
                        let (sn, cs) = th.sin_cos();
                        let (vx, vy) = (q.0 - c.0, q.1 - c.1);
                        from((c.0 + cs * vx - sn * vy, c.1 + sn * vx + cs * vy))
                    }
                    LiquifyTool::Pucker | LiquifyTool::Bloat => {
                        let sign = if tool == LiquifyTool::Pucker {
                            1.0
                        } else {
                            -1.0
                        };
                        let k = 1.0 + sign * PUCKER_PER_DAB * rate * w;
                        from((c.0 + (q.0 - c.0) * k, c.1 + (q.1 - c.1) * k))
                    }
                    LiquifyTool::Reconstruct => {
                        let keep = (1.0 - rate * w) as f32;
                        Some([own[0] * keep, own[1] * keep])
                    }
                    LiquifyTool::Smooth => {
                        let mut sum = [0f64; 2];
                        let mut n = 0.0;
                        for (di, dj) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                            let (ni, nj) = (i64::from(i) + di, i64::from(j) + dj);
                            if ni < 0
                                || nj < 0
                                || ni >= i64::from(f.cols)
                                || nj >= i64::from(f.rows)
                            {
                                continue;
                            }
                            let v = f.d[(nj as u32 * f.cols + ni as u32) as usize];
                            if v[0].is_nan() {
                                continue;
                            }
                            sum[0] += f64::from(v[0]);
                            sum[1] += f64::from(v[1]);
                            n += 1.0;
                        }
                        if n == 0.0 {
                            None
                        } else {
                            let a = rate * w;
                            Some([
                                (f64::from(own[0]) + a * (sum[0] / n - f64::from(own[0]))) as f32,
                                (f64::from(own[1]) + a * (sum[1] / n - f64::from(own[1]))) as f32,
                            ])
                        }
                    }
                    LiquifyTool::Freeze | LiquifyTool::Thaw => None,
                };
                if let Some(v) = new {
                    writes.push((k, v));
                }
            }
        }
        for (k, v) in writes {
            self.field.d[k] = v;
        }
        for (k, v) in freezes {
            self.freeze[k] = v;
        }
    }

    /// Restore All: the identity field (the freeze mask stays).
    pub fn restore_all(&mut self) {
        self.field.d.fill([0.0; 2]);
    }
}

/// One recorded Liquify stroke (the image module replays a dialog's
/// strokes into a fresh [`Liquify`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Stroke {
    pub tool: LiquifyTool,
    pub brush: Brush,
    pub points: Vec<(f64, f64)>,
}

/// Replay `strokes` over a fresh mesh of `width`×`height`.
pub fn replay(width: u32, height: u32, max_nodes: u32, strokes: &[Stroke]) -> Liquify {
    let mut l = Liquify::new(width, height, max_nodes);
    for s in strokes {
        l.stroke(s.tool, &s.brush, &s.points);
    }
    l
}

/// Parse the flat wire form of a stroke list: per stroke `[tool, size,
/// pressure, density, rate, n, x0, y0, …, x(n−1), y(n−1)]`, positions in
/// px. `None` on a malformed list.
pub fn parse_strokes(flat: &[f32]) -> Option<Vec<Stroke>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < flat.len() {
        let head = flat.get(i..i + 6)?;
        let tool = LiquifyTool::from_code(head[0] as u32)?;
        let n = head[5] as usize;
        let pts = flat.get(i + 6..i + 6 + 2 * n)?;
        if head.iter().chain(pts).any(|v| !v.is_finite()) {
            return None;
        }
        out.push(Stroke {
            tool,
            brush: Brush {
                size: f64::from(head[1]),
                pressure: f64::from(head[2]),
                density: f64::from(head[3]),
                rate: f64::from(head[4]),
            },
            points: pts
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&[x, y]| (f64::from(x), f64::from(y)))
                .collect(),
        });
        i += 6 + 2 * n;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BRUSH: Brush = Brush {
        size: 40.0,
        pressure: 1.0,
        density: 0.5,
        rate: 1.0,
    };

    #[test]
    fn a_new_field_is_the_identity_and_covers_every_pixel() {
        let f = Field::new(101, 50, 8);
        assert!(f.is_identity());
        assert!(f64::from((f.cols - 1) * f.step) >= 100.0);
        assert!(f64::from((f.rows - 1) * f.step) >= 49.0);
        assert_eq!(f.source(37.25, 12.5), Some((37.25, 12.5)));
    }

    #[test]
    fn nan_nodes_read_no_source() {
        let mut f = Field::new(10, 10, 1);
        f.d[3 * 10 + 4] = [f32::NAN; 2];
        assert!(f.source(4.0, 3.0).is_none());
        assert!(f.source(3.5, 2.5).is_none(), "a cell touching it");
        assert!(f.source(8.0, 8.0).is_some());
    }

    #[test]
    fn forward_warp_drags_the_content_along() {
        let mut l = Liquify::new(200, 200, 201);
        l.stroke(
            LiquifyTool::ForwardWarp,
            &BRUSH,
            &[(100.0, 100.0), (110.0, 100.0)],
        );
        // The pixel just ahead of the start now shows what was behind it.
        let (sx, _) = l.field.source(110.0, 100.0).unwrap();
        assert!(sx < 110.0 - 5.0, "reads from behind: {sx}");
        // Outside the brush nothing moved.
        assert_eq!(l.field.source(10.0, 10.0), Some((10.0, 10.0)));
    }

    #[test]
    fn pucker_pulls_inwards_and_bloat_pushes_out() {
        let mut p = Liquify::new(200, 200, 201);
        p.stroke(LiquifyTool::Pucker, &BRUSH, &[(100.0, 100.0)]);
        let (sx, _) = p.field.source(110.0, 100.0).unwrap();
        assert!(sx > 110.0, "pucker reads from farther out: {sx}");
        let mut b = Liquify::new(200, 200, 201);
        b.stroke(LiquifyTool::Bloat, &BRUSH, &[(100.0, 100.0)]);
        let (sx, _) = b.field.source(110.0, 100.0).unwrap();
        assert!(sx < 110.0, "bloat reads from nearer in: {sx}");
    }

    #[test]
    fn twirl_turns_about_the_centre_by_the_rule() {
        let mut l = Liquify::new(200, 200, 201);
        l.stroke(LiquifyTool::TwirlClockwise, &BRUSH, &[(100.0, 100.0)]);
        // A point right of the centre reads from above it (y down): the
        // content turns clockwise on screen.
        let (sx, sy) = l.field.source(105.0, 100.0).unwrap();
        assert!(sy < 100.0, "reads from above: ({sx}, {sy})");
        assert!(
            ((sx - 100.0).hypot(sy - 100.0) - 5.0).abs() < 1e-3,
            "a rotation keeps the radius"
        );
    }

    #[test]
    fn freeze_protects_and_reconstruct_restores() {
        let mut l = Liquify::new(200, 200, 201);
        l.stroke(LiquifyTool::Freeze, &BRUSH, &[(100.0, 100.0)]);
        l.stroke(
            LiquifyTool::ForwardWarp,
            &BRUSH,
            &[(90.0, 100.0), (110.0, 100.0)],
        );
        assert_eq!(l.field.source(100.0, 100.0), Some((100.0, 100.0)), "frozen");
        l.stroke(LiquifyTool::Thaw, &BRUSH, &[(100.0, 100.0)]);
        l.stroke(
            LiquifyTool::ForwardWarp,
            &BRUSH,
            &[(90.0, 100.0), (110.0, 100.0)],
        );
        let moved = l.field.displacement(100.0, 100.0).unwrap().0.abs();
        assert!(moved > 1.0);
        for _ in 0..40 {
            l.stroke(LiquifyTool::Reconstruct, &BRUSH, &[(100.0, 100.0)]);
        }
        assert!(l.field.displacement(100.0, 100.0).unwrap().0.abs() < moved * 0.05);
        l.restore_all();
        assert!(l.field.is_identity());
    }

    #[test]
    fn the_wire_form_round_trips_and_refuses_garbage() {
        let flat = [
            0.0, 40.0, 1.0, 0.5, 0.8, 2.0, 10.0, 20.0, 30.0, 40.0, 5.0, 10.0, 1.0, 0.5, 0.8, 1.0,
            1.0, 2.0,
        ];
        let s = parse_strokes(&flat).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].tool, LiquifyTool::ForwardWarp);
        assert_eq!(s[0].points, vec![(10.0, 20.0), (30.0, 40.0)]);
        assert_eq!(s[1].tool, LiquifyTool::Pucker);
        assert!(parse_strokes(&flat[..7]).is_none());
        assert!(parse_strokes(&[99.0, 1.0, 1.0, 1.0, 1.0, 0.0]).is_none());
        let l = replay(64, 64, 65, &s);
        assert!(!l.field.is_identity());
    }

    #[test]
    fn a_scaled_field_scales_its_displacements() {
        let mut l = Liquify::new(200, 100, 101);
        l.stroke(
            LiquifyTool::ForwardWarp,
            &BRUSH,
            &[(100.0, 50.0), (120.0, 50.0)],
        );
        let half = l.field.scaled(100, 50);
        let (a, _) = l.field.displacement(110.0, 50.0).unwrap();
        let (b, _) = half.displacement(55.0, 25.0).unwrap();
        assert!((a / 2.0 - b).abs() < 0.75, "{a} / 2 vs {b}");
    }
}
