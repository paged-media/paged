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

//! THE BRUSH ENGINE on the stroke session: every Brush Settings pane and
//! the tools that need more than one colour or more than one pass.
//!
//! # Two lanes
//!
//! * **Accumulating** (brush, pencil, eraser, the retouching and filter
//!   strokes, history, art history, background eraser, colour
//!   replacement): the planner's stamps go into the coverage
//!   accumulator — through the oriented tip, the per-dab opacity
//!   ceiling, the colour field, texture-each-tip and the colour gate —
//!   and the dirty rectangle is re-composited FROM THE BASE exactly as
//!   on the plain path. Incremental still equals from-scratch.
//! * **Wet** (smudge, mixer): each dab reads what the dab before it
//!   left, so the stroke composites DAB BY DAB into the working pixels.
//!   Every pixel it changes is still a registered kernel dispatch
//!   (`compose.normal` under the dab's mask for the deposit, the same
//!   kernel under a uniform mask for the carried paint's pickup); the
//!   CPU only moves windows.
//!
//! A stroke with every pane off and a computed tip never enters this
//! module: it takes the plain path, byte for byte the pre-engine stroke
//! (the stroke tapes hold it to that).

use std::sync::Arc;

use image_core::Region;
use image_gpu::brush::{OrientedTip, StampSpec, TextureField};
use image_gpu::dab::TipCoverage;
use image_gpu::dynamics::{
    plan_pen_segment, BaseBrush, BrushDynamics, DabPlanner, PenDab, PenSample, PlannedStamp,
    PulledString,
};
use image_gpu::{composite_stroke_window, GpuContext, PaintMode, SampledTip, SelectionCoverage};
use image_kernels::families::compose::COMPOSE_NORMAL;

use super::{StrokeSession, StrokeTool};
use crate::fill::{f16_to_rgba8, rgba8_to_f16};
use crate::ingest::IngestError;

/// The planner, the walk and the smoothing of one stroke.
#[derive(Debug, Clone)]
pub(crate) struct BrushRun {
    planner: DabPlanner,
    residual: f32,
    last: Option<PenSample>,
    smoother: Option<PulledString>,
}

/// The smudge / mixer brush's carried paint: a straight rgba16float
/// square window centred on the dab (`size × size`).
#[derive(Debug, Clone)]
pub(crate) struct WetState {
    size: u32,
    carry: Vec<u8>,
}

/// The Art History Brush's styles: `(length in tip diameters, curl in
/// radians per step, spread as a fraction of the area)`. This engine's
/// table; the names are Photoshop's.
const ART_STYLES: [(f32, f32, f32); 10] = [
    (2.0, 0.0, 0.5),  // tight short
    (4.0, 0.0, 0.5),  // tight medium
    (8.0, 0.0, 0.5),  // tight long
    (4.0, 0.15, 1.0), // loose medium
    (8.0, 0.15, 1.0), // loose long
    (0.0, 0.0, 1.0),  // dab
    (4.0, 0.6, 0.5),  // tight curl
    (8.0, 0.6, 0.5),  // tight curl long
    (4.0, 0.6, 1.0),  // loose curl
    (8.0, 0.6, 1.0),  // loose curl long
];

/// Sub-strokes the art history brush starts per walked dab.
const ART_STROKES_PER_DAB: u32 = 2;

impl StrokeSession {
    /// Freeze Brush Settings into the stroke. Call before the first
    /// sample, like every other stroke parameter.
    pub fn set_dynamics(&mut self, d: BrushDynamics) {
        self.dynamics = d;
    }

    pub fn dynamics(&self) -> &BrushDynamics {
        &self.dynamics
    }

    /// The sampled tip (`None` = the computed tip).
    pub fn set_tip_bitmap(&mut self, tip: Option<SampledTip>) {
        self.tip_bitmap = tip.map(Arc::new);
    }

    /// The dual brush's sampled tip.
    pub fn set_dual_bitmap(&mut self, tip: Option<SampledTip>) {
        self.dual_bitmap = tip.map(Arc::new);
    }

    /// The texture pattern (straight RGBA8 `w × h`).
    pub fn set_texture_source(
        &mut self,
        w: u32,
        h: u32,
        rgba: Arc<[u8]>,
    ) -> Result<(), IngestError> {
        if (w as usize) * (h as usize) * 4 != rgba.len() || w == 0 || h == 0 {
            return Err(IngestError::Decode(format!(
                "texture pattern is {} bytes for {w}×{h}",
                rgba.len()
            )));
        }
        self.texture_source = Some((w, h, rgba));
        Ok(())
    }

    /// The pixels a history tool paints from, or a wet tool samples when
    /// it samples all layers: canvas-extent straight RGBA8.
    pub fn set_alt_source(&mut self, rgba: Arc<[u8]>) -> Result<(), IngestError> {
        let want = (self.width as usize) * (self.height as usize) * 4;
        if rgba.len() != want {
            return Err(IngestError::Decode(format!(
                "source state is {} bytes, expected {want}",
                rgba.len()
            )));
        }
        self.alt_source = Some(rgba);
        Ok(())
    }

    /// Pen up for the engine's run: no last sample, the spacing residual
    /// and the smoothing started afresh (`StrokeSession::lift`).
    pub(super) fn lift_run(&mut self) {
        let smoothing = self.dynamics.smoothing;
        if let Some(b) = self.brush.as_mut() {
            b.last = None;
            b.residual = 0.0;
            if let Some(s) = b.smoother.as_mut() {
                *s = PulledString::new(smoothing);
            }
        }
    }

    /// Does this stroke need the engine (any pane, a bitmap tip, or a
    /// tool that only exists here)?
    pub(super) fn uses_engine(&self) -> bool {
        !self.dynamics.is_plain()
            || self.tip_bitmap.is_some()
            || self.params.tool.wet()
            || self.params.tool.reads_history()
            || self.params.tool.gated()
    }

    fn run(&mut self) -> &mut BrushRun {
        if self.brush.is_none() {
            let d = self.dynamics;
            let base = BaseBrush {
                diameter: self.params.size,
                flow: self.params.flow,
                pressure: self.params.pressure,
                color: [
                    self.params.color[0],
                    self.params.color[1],
                    self.params.color[2],
                ],
            };
            // The texture field bakes the pane's scale, brightness,
            // contrast and invert once, here.
            if let (Some(t), Some((w, h, px))) = (&d.texture, &self.texture_source) {
                self.texture = TextureField::from_rgba8(
                    *w,
                    *h,
                    px,
                    t.scale,
                    t.brightness,
                    t.contrast,
                    t.invert,
                )
                .map(Arc::new);
            }
            let mut lowering = image_gpu::brush::Lowering {
                wet_edges: d.wet_edges,
                noise: d.noise.then_some(d.seed as u64 ^ 0x4E01_5E00),
                ..Default::default()
            };
            if let Some(dual) = &d.dual {
                lowering.dual = Some((
                    Box::new(image_gpu::StrokeAccumulator::new(self.width, self.height)),
                    dual.mode,
                ));
            }
            if let (Some(t), Some(field)) = (&d.texture, &self.texture) {
                if !t.each_tip {
                    lowering.texture = Some((Arc::clone(field), t.mode, t.depth));
                }
            }
            if lowering.dual.is_some()
                || lowering.texture.is_some()
                || lowering.wet_edges
                || lowering.noise.is_some()
            {
                self.accumulator.set_lowering(lowering);
            }
            self.brush = Some(BrushRun {
                planner: DabPlanner::new(d, base, self.width, self.height),
                residual: 0.0,
                last: None,
                smoother: (d.smoothing.radius > 0.0).then(|| PulledString::new(d.smoothing)),
            });
        }
        self.brush.as_mut().expect("just built")
    }

    /// The engine's `extend`: smoothing → walk → plan → deposit →
    /// composite.
    pub async fn extend_pen(
        &mut self,
        ctx: &GpuContext,
        raw: PenSample,
    ) -> Result<bool, IngestError> {
        if !raw.x.is_finite() || !raw.y.is_finite() {
            return Ok(false);
        }
        if self.params.tool.samples_image() && self.clone_offset.is_none() {
            if let Some(src) = self.clone_source {
                self.clone_offset = Some((src.x - raw.x, src.y - raw.y));
            }
        }
        if !self.uses_engine() {
            let s = image_gpu::StrokeSample::new(raw.x, raw.y, raw.pressure);
            return self.extend(ctx, s).await;
        }
        self.extend_engine(ctx, raw).await
    }

    pub(super) async fn extend_engine(
        &mut self,
        ctx: &GpuContext,
        raw: PenSample,
    ) -> Result<bool, IngestError> {
        let points: Vec<PenSample> = match self.run().smoother.as_mut() {
            Some(s) => s.pull(raw).into_iter().collect(),
            None => vec![raw],
        };
        self.walk_points(ctx, &points).await
    }

    /// Catch-up at end: the smoothed brush lands on the pointer before
    /// the stroke closes. A no-op without smoothing.
    pub async fn finish(&mut self, ctx: &GpuContext) -> Result<bool, IngestError> {
        if !self.dynamics.smoothing.catch_up_end {
            return Ok(false);
        }
        let Some(p) = self
            .brush
            .as_mut()
            .and_then(|b| b.smoother.as_mut())
            .and_then(|s| s.finish())
        else {
            return Ok(false);
        };
        self.walk_points(ctx, &[p]).await
    }

    async fn walk_points(
        &mut self,
        ctx: &GpuContext,
        points: &[PenSample],
    ) -> Result<bool, IngestError> {
        let mut stamps = Vec::new();
        let mut dual = Vec::new();
        let step = self.params.step_px();
        let spacing_enabled = self.dynamics.tip.spacing_enabled;
        let build_up = self.dynamics.build_up;
        {
            let run = self.run();
            for &p in points {
                let mut pens = Vec::new();
                match run.last {
                    None => pens.push(PenDab::of(p, 0.0)),
                    Some(prev) => {
                        let (dx, dy) = (p.x - prev.x, p.y - prev.y);
                        let moved = dx != 0.0 || dy != 0.0;
                        let dir = if moved {
                            image_gpu::dynamics::direction_deg(dx, dy)
                        } else {
                            0.0
                        };
                        if !spacing_enabled {
                            // Unchecked Spacing: one dab per sample.
                            if moved {
                                pens.push(PenDab::of(p, dir));
                            }
                        } else {
                            plan_pen_segment(&mut run.residual, prev, p, step, &mut pens);
                        }
                        // BUILD-UP: a held pointer keeps depositing.
                        if !moved && build_up {
                            pens.push(PenDab::of(p, dir));
                        }
                    }
                }
                run.planner.plan_dual(run.last, p, &mut dual);
                run.last = Some(p);
                for pen in pens {
                    run.planner.plan(pen, &mut stamps);
                }
            }
        }
        self.deposit_dual(&dual);
        if self.params.tool.wet() {
            return self.composite_wet(ctx, &stamps).await;
        }
        if self.params.tool == StrokeTool::ArtHistory {
            self.deposit_art(&stamps);
        } else {
            for st in &stamps {
                self.deposit(st);
            }
        }
        self.last_dirty = None;
        let Some(dirty) = self.accumulator.take_dirty() else {
            return Ok(false);
        };
        self.composite(ctx, dirty).await?;
        Ok(true)
    }

    fn oriented<'a>(&self, st: &PlannedStamp, bitmap: Option<&'a SampledTip>) -> OrientedTip<'a> {
        OrientedTip {
            diameter: st.diameter.clamp(super::MIN_SIZE_PX, super::MAX_SIZE_PX),
            hardness: self.params.hardness,
            antialias: self.params.tool.antialias(),
            angle_deg: st.angle,
            roundness: st.roundness,
            flip_x: st.flip_x,
            flip_y: st.flip_y,
            bitmap,
        }
    }

    /// Deposit one planned stamp into the accumulator.
    fn deposit(&mut self, st: &PlannedStamp) {
        let bitmap = self.tip_bitmap.clone();
        let tip = self.oriented(st, bitmap.as_deref());
        let tex = match (&self.dynamics.texture, &self.texture) {
            (Some(t), Some(f)) if t.each_tip => Some((Arc::clone(f), t.mode, st.depth)),
            _ => None,
        };
        let gate = if self.params.tool.gated() {
            self.gate_mask(&tip, st)
        } else {
            None
        };
        let modulate = |x: u32, y: u32, c: f32| -> f32 {
            let mut c = c;
            if let Some((f, mode, depth)) = &tex {
                c = mode.combine(c, f.at(x, y), *depth);
            }
            if let Some((r, m)) = &gate {
                let (lx, ly) = (x as i32 - r.x, y as i32 - r.y);
                if lx < 0 || ly < 0 || lx >= r.w as i32 || ly >= r.h as i32 {
                    return 0.0;
                }
                c *= m[(ly as usize) * (r.w as usize) + lx as usize];
            }
            c
        };
        let needs_mod = tex.is_some() || gate.is_some();
        self.accumulator.stamp_spec(&StampSpec {
            tip: &tip,
            cx: st.x,
            cy: st.y,
            flow: st.flow,
            ceiling: st.ceiling,
            color: st.color,
            modulate: if needs_mod { Some(&modulate) } else { None },
        });
    }

    /// The dual tip's stamps go into the dual accumulator; the primary's
    /// shaped coverage changes under them, so they dirty it too.
    fn deposit_dual(&mut self, dual: &[PlannedStamp]) {
        if dual.is_empty() {
            return;
        }
        let bitmap = self.dual_bitmap.clone();
        let (w, h) = (self.width, self.height);
        let mut touched: Option<Region> = None;
        for st in dual {
            let tip = OrientedTip {
                diameter: st.diameter.clamp(super::MIN_SIZE_PX, super::MAX_SIZE_PX),
                hardness: 1.0,
                antialias: true,
                angle_deg: st.angle,
                roundness: st.roundness,
                flip_x: st.flip_x,
                flip_y: st.flip_y,
                bitmap: bitmap.as_deref(),
            };
            if let Some(b) = tip.dab_bounds(st.x, st.y, w, h) {
                touched = Some(touched.map_or(b, |t| t.union(b)));
            }
            if let Some(l) = self.accumulator.lowering_mut() {
                if let Some((acc, _)) = l.dual.as_mut() {
                    acc.stamp_spec(&StampSpec {
                        tip: &tip,
                        cx: st.x,
                        cy: st.y,
                        flow: 1.0,
                        ceiling: 1.0,
                        color: None,
                        modulate: None,
                    });
                }
            }
        }
        if let (Some(t), Some(stroke)) = (touched, self.accumulator.stroke_bounds()) {
            if let Some(r) = t.intersect(stroke) {
                self.accumulator.mark_dirty(r);
            }
        }
    }

    /// The COLOUR GATE of the background eraser and the colour
    /// replacement tool, over the dab's bounds: `1` where the pixel is
    /// within the tolerance of the sampled colour, ramping to `0` over
    /// the last fifth of the tolerance; CONTIGUOUS keeps only what is
    /// 4-connected to the dab centre; FIND EDGES is contiguous with a
    /// hard gate (no ramp), which keeps edges crisp. Protect Foreground
    /// zeroes pixels within the tolerance of the foreground colour.
    fn gate_mask(
        &mut self,
        tip: &OrientedTip<'_>,
        st: &PlannedStamp,
    ) -> Option<(Region, Vec<f32>)> {
        let r = tip.dab_bounds(st.x, st.y, self.width, self.height)?;
        let t = self.dynamics.tools;
        let (sampling, limits, tol, protect) = if self.params.tool == StrokeTool::BackgroundEraser {
            (
                t.erase_sampling,
                t.erase_limits,
                t.erase_tolerance,
                t.erase_protect_fg,
            )
        } else {
            (
                t.replace_sampling,
                t.replace_limits,
                t.replace_tolerance,
                false,
            )
        };
        let cx = (st.x.floor().max(0.0) as u32).min(self.width - 1);
        let cy = (st.y.floor().max(0.0) as u32).min(self.height - 1);
        let px = |x: u32, y: u32| -> [u8; 4] {
            let i = ((y * self.width + x) as usize) * 4;
            [
                self.base[i],
                self.base[i + 1],
                self.base[i + 2],
                self.base[i + 3],
            ]
        };
        let to8 = |c: [f32; 3]| -> [u8; 4] {
            [
                (c[0].clamp(0.0, 1.0) * 255.0).round() as u8,
                (c[1].clamp(0.0, 1.0) * 255.0).round() as u8,
                (c[2].clamp(0.0, 1.0) * 255.0).round() as u8,
                255,
            ]
        };
        let sample = match sampling {
            0 => px(cx, cy),
            1 => *self.gate_sample.get_or_insert(px(cx, cy)),
            _ => to8(self.dynamics.background),
        };
        let fg = to8([
            self.params.color[0],
            self.params.color[1],
            self.params.color[2],
        ]);
        let dist = |a: [u8; 4], b: [u8; 4]| -> f32 {
            (0..3).map(|c| a[c].abs_diff(b[c])).max().unwrap_or(0) as f32 / 255.0
        };
        let hard = limits == 2;
        let tol = tol.max(1.0 / 255.0);
        let mut m = vec![0f32; (r.w as usize) * (r.h as usize)];
        for y in 0..r.h {
            for x in 0..r.w {
                let p = px(r.x as u32 + x, r.y as u32 + y);
                let d = dist(p, sample);
                let mut g = if d <= tol * 0.8 {
                    1.0
                } else if d >= tol || hard {
                    if d <= tol && hard {
                        1.0
                    } else {
                        0.0
                    }
                } else {
                    (tol - d) / (tol * 0.2)
                };
                if protect && dist(p, fg) <= tol {
                    g = 0.0;
                }
                m[(y * r.w + x) as usize] = g;
            }
        }
        if limits >= 1 {
            // Flood from the dab centre through gated pixels.
            let (sx, sy) = (cx as i32 - r.x, cy as i32 - r.y);
            let mut reach = vec![false; m.len()];
            let idx = |x: i32, y: i32| (y as usize) * (r.w as usize) + x as usize;
            if sx >= 0 && sy >= 0 && sx < r.w as i32 && sy < r.h as i32 && m[idx(sx, sy)] > 0.0 {
                let mut q = std::collections::VecDeque::from([(sx, sy)]);
                reach[idx(sx, sy)] = true;
                while let Some((x, y)) = q.pop_front() {
                    for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                        if nx < 0 || ny < 0 || nx >= r.w as i32 || ny >= r.h as i32 {
                            continue;
                        }
                        let i = idx(nx, ny);
                        if !reach[i] && m[i] > 0.0 {
                            reach[i] = true;
                            q.push_back((nx, ny));
                        }
                    }
                }
            }
            for (v, ok) in m.iter_mut().zip(reach) {
                if !ok {
                    *v = 0.0;
                }
            }
        }
        Some((r, m))
    }

    /// ART HISTORY: each walked dab starts [`ART_STROKES_PER_DAB`]
    /// short strokes inside the area, each in the history state's colour
    /// at its start (pulled toward random by `1 − fidelity`), shaped by
    /// the style, and skipped where the history state and the layer
    /// differ by less than the tolerance.
    fn deposit_art(&mut self, stamps: &[PlannedStamp]) {
        let Some(src) = self.alt_source.clone() else {
            return;
        };
        let t = self.dynamics.tools;
        let (len_d, curl, spread) = ART_STYLES[(t.art_style as usize).min(9)];
        let mut rng = image_gpu::dynamics::Rng::new(
            (self.dynamics.seed as u64) ^ 0xA27_0000 ^ self.accumulator.dab_count(),
        );
        let (w, h) = (self.width, self.height);
        let at = |buf: &[u8], x: f32, y: f32| -> [u8; 4] {
            let xi = (x.floor().max(0.0) as u32).min(w - 1);
            let yi = (y.floor().max(0.0) as u32).min(h - 1);
            let i = ((yi * w + xi) as usize) * 4;
            [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
        };
        for st in stamps {
            for _ in 0..ART_STROKES_PER_DAB {
                let ua = rng.unit();
                let ur = rng.unit();
                let ud = rng.unit();
                let us = rng.unit();
                let (uc0, uc1, uc2) = (rng.unit(), rng.unit(), rng.unit());
                let radius = 0.5 * t.art_area * spread * ur.sqrt();
                let theta = ua * std::f32::consts::TAU;
                let (mut x, mut y) = (st.x + radius * theta.cos(), st.y + radius * theta.sin());
                let s = at(&src, x, y);
                let cur = at(&self.base, x, y);
                let diff = (0..3).map(|c| s[c].abs_diff(cur[c])).max().unwrap_or(0) as f32 / 255.0;
                if diff < t.art_tolerance {
                    continue;
                }
                let jitter = (1.0 - t.art_fidelity) * 0.5;
                let colour = [
                    (s[0] as f32 / 255.0 + jitter * (2.0 * uc0 - 1.0)).clamp(0.0, 1.0),
                    (s[1] as f32 / 255.0 + jitter * (2.0 * uc1 - 1.0)).clamp(0.0, 1.0),
                    (s[2] as f32 / 255.0 + jitter * (2.0 * uc2 - 1.0)).clamp(0.0, 1.0),
                ];
                let d = (st.diameter * 0.5).max(1.0);
                let step = (d * 0.25).max(0.5);
                let steps = ((len_d * d) / step).round().max(0.0) as u32;
                let mut dir = ud * std::f32::consts::TAU;
                let turn = if us < 0.5 { curl } else { -curl };
                for k in 0..=steps {
                    let tip = OrientedTip {
                        diameter: d,
                        hardness: self.params.hardness,
                        antialias: true,
                        angle_deg: st.angle,
                        roundness: st.roundness,
                        flip_x: false,
                        flip_y: false,
                        bitmap: None,
                    };
                    self.accumulator.stamp_spec(&StampSpec {
                        tip: &tip,
                        cx: x,
                        cy: y,
                        flow: st.flow,
                        ceiling: st.ceiling,
                        color: Some(colour),
                        modulate: None,
                    });
                    if k < steps {
                        x += step * dir.cos();
                        y += step * dir.sin();
                        dir += turn;
                    }
                }
            }
        }
    }

    /// The paint layer the ENGINE supplies for `region`, if any: the
    /// colour field of a multi-coloured stroke, or the history state's
    /// window.
    pub(super) fn engine_paint_window(&self, region: Region) -> Option<Vec<u8>> {
        if self.params.tool == StrokeTool::History {
            let src = self.alt_source.as_ref()?;
            return Some(rgba8_to_f16(&window_of(src, self.width, region)));
        }
        if self.accumulator.has_colors() {
            let c = self.params.color;
            return Some(
                self.accumulator
                    .color_window_f16(region, [c[0], c[1], c[2]]),
            );
        }
        None
    }

    /// Lock Transparent Pixels on the ERASER paints the background
    /// colour (there is no alpha to take away), as Photoshop does.
    pub(super) fn locked_erase_paint(&self) -> Option<PaintMode<'static>> {
        (self.dynamics.lock_alpha && self.params.tool == StrokeTool::Eraser).then(|| {
            let b = self.dynamics.background;
            PaintMode::Paint {
                blend: &COMPOSE_NORMAL,
                color: [b[0], b[1], b[2], 1.0],
            }
        })
    }

    // ── the wet lane ─────────────────────────────────────────────────

    /// SMUDGE / MIXER, dab by dab. Per dab, on a square window `S`
    /// centred on it (the carried paint's footprint):
    ///
    /// * the PAINT it lays down is the carried paint — for the mixer
    ///   first mixed with the canvas under it by `mix · wet`;
    /// * it lands under the tip's coverage × strength (smudge) or × flow
    ///   (mixer) × the selection, through `compose.normal`;
    /// * then the brush PICKS UP: the carried paint moves toward what is
    ///   now under it by `1 − strength` (smudge) or `wet · (1 − load)`
    ///   (mixer) — the same kernel under a uniform mask.
    ///
    /// The canvas a dab reads is the working layer, or with "sample all
    /// layers" the composite of every layer as the stroke began.
    async fn composite_wet(
        &mut self,
        ctx: &GpuContext,
        stamps: &[PlannedStamp],
    ) -> Result<bool, IngestError> {
        let t = self.dynamics.tools;
        let smudge = self.params.tool == StrokeTool::Smudge;
        let sample_all = if smudge {
            t.smudge_sample_all
        } else {
            t.mixer_sample_all
        };
        let size = (self.params.size.ceil() as u32 + 4).max(4);
        let mut any = false;
        let mut dirty: Option<Region> = None;
        for st in stamps {
            let bitmap = self.tip_bitmap.clone();
            let tip = self.oriented(st, bitmap.as_deref());
            let half = (size / 2) as i32;
            let (ox, oy) = (st.x.round() as i32 - half, st.y.round() as i32 - half);
            let full = Region::new(ox, oy, size, size);
            let Some(win) = full.intersect(Region::new(0, 0, self.width, self.height)) else {
                continue;
            };
            let canvas_now = window_of(&self.working, self.width, win);
            let canvas_src = match (&self.alt_source, sample_all) {
                (Some(a), true) => window_of(a, self.width, win),
                _ => canvas_now.clone(),
            };
            let carry_init = self.wet.is_none();
            if carry_init {
                let fg = self.params.color;
                let loaded = if smudge {
                    t.smudge_finger
                } else {
                    t.mixer_load > 0.0
                };
                let carry = if loaded {
                    solid_f16(size, size, [fg[0], fg[1], fg[2], 1.0])
                } else {
                    // Picked up from where the stroke starts.
                    let mut px = vec![0u8; (size as usize) * (size as usize) * 4];
                    paste(&mut px, size, win.x - ox, win.y - oy, win.w, &canvas_src);
                    rgba8_to_f16(&px)
                };
                self.wet = Some(WetState { size, carry });
            }
            let wet = self.wet.as_ref().expect("initialised");
            if wet.size != size {
                continue;
            }
            let carry_win = crop_f16(&wet.carry, size, win.x - ox, win.y - oy, win.w, win.h);
            let canvas_f16 = rgba8_to_f16(&canvas_now);
            let src_f16 = rgba8_to_f16(&canvas_src);
            // The paint this dab lays down.
            let paint = if smudge {
                carry_win.clone()
            } else {
                let k = (t.mixer_mix * t.mixer_wet).clamp(0.0, 1.0);
                mix_f16(ctx, &carry_win, &src_f16, k, win.w, win.h).await?
            };
            let strength = if smudge {
                t.smudge_strength
            } else {
                t.mixer_flow
            };
            let mut mask_vals = vec![0f32; (win.w as usize) * (win.h as usize)];
            let mut touched = false;
            for y in 0..win.h {
                for x in 0..win.w {
                    let (ix, iy) = (win.x as u32 + x, win.y as u32 + y);
                    let mut c = tip.coverage_at_pixel(st.x, st.y, ix, iy) * strength * st.flow;
                    if let Some(sel) = self.selection.as_deref() {
                        c *= sel.coverage_at(ix, iy) as f32 / 255.0;
                    }
                    c *= self.params.opacity;
                    if c > 0.0 {
                        touched = true;
                    }
                    mask_vals[(y * win.w + x) as usize] = c.clamp(0.0, 1.0);
                }
            }
            if touched {
                let mask = image_gpu::SelectionMask::from_fn(win.w, win.h, |x, y| {
                    mask_vals[(y * win.w + x) as usize]
                })
                .into_bytes();
                let mode = PaintMode::Sample {
                    blend: &COMPOSE_NORMAL,
                    source_f16: &paint,
                    correction_f16: None,
                };
                let mut out = composite_stroke_window(ctx, &mode, &canvas_f16, &mask, win.w, win.h)
                    .await
                    .map_err(gpu_err)?;
                if self.dynamics.lock_alpha {
                    out = image_gpu::keep_alpha_window(ctx, &out, &canvas_f16, win.w, win.h)
                        .await
                        .map_err(gpu_err)?;
                }
                let out8 = f16_to_rgba8(&out);
                self.splice_masked(win, &out8, &mask_vals);
                self.accumulator.stamp(&tip, st.x, st.y, 1.0);
                dirty = Some(dirty.map_or(win, |d| d.union(win)));
                any = true;
            }
            // The pickup.
            let after = if sample_all {
                src_f16
            } else {
                rgba8_to_f16(&window_of(&self.working, self.width, win))
            };
            let k = if smudge {
                1.0 - t.smudge_strength
            } else {
                t.mixer_wet * (1.0 - t.mixer_load)
            };
            let picked = mix_f16(ctx, &carry_win, &after, k.clamp(0.0, 1.0), win.w, win.h).await?;
            // The carry FOLLOWS the brush: its window is dab-relative, so
            // the picked window is pasted back at the same offset.
            let wet = self.wet.as_mut().expect("initialised");
            paste_f16(&mut wet.carry, size, win.x - ox, win.y - oy, win.w, &picked);
        }
        let _ = self.accumulator.take_dirty();
        self.last_dirty = dirty;
        Ok(any)
    }

    /// Write `window` into `working` where `mask > 0` — the wet lane's
    /// splice (its masks are per dab, not the accumulated coverage).
    fn splice_masked(&mut self, region: Region, window: &[u8], mask: &[f32]) {
        if Arc::get_mut(&mut self.working).is_none() {
            crate::counters::whole_copy(self.working.len());
            self.working = Arc::from(&self.working[..]);
        }
        let working = Arc::get_mut(&mut self.working).expect("unique after the copy");
        for y in 0..region.h {
            for x in 0..region.w {
                if mask[(y * region.w + x) as usize] <= 0.0 {
                    continue;
                }
                let src = ((y * region.w + x) as usize) * 4;
                let dst = (((region.y as u32 + y) * self.width + region.x as u32 + x) as usize) * 4;
                working[dst..dst + 4].copy_from_slice(&window[src..src + 4]);
            }
        }
    }

    /// Paint a whole COVERAGE FIELD in one go (the magic eraser): the
    /// field is stamped as the stroke's coverage at `opacity` and the
    /// stroke composited. The stroke's own tool decides what it does.
    pub async fn paint_field(
        &mut self,
        ctx: &GpuContext,
        field: &SelectionCoverage,
    ) -> Result<bool, IngestError> {
        if field.width() != self.width || field.height() != self.height {
            return Err(IngestError::Decode("coverage field is mis-sized".into()));
        }
        let tip = FieldTip { field };
        self.accumulator.stamp_spec(&StampSpec {
            tip: &tip,
            cx: 0.0,
            cy: 0.0,
            flow: 1.0,
            ceiling: 1.0,
            color: None,
            modulate: None,
        });
        self.last_dirty = None;
        let Some(dirty) = self.accumulator.take_dirty() else {
            return Ok(false);
        };
        self.composite(ctx, dirty).await?;
        Ok(true)
    }
}

/// Largest side of a defined brush tip, px.
pub const MAX_DEFINED_TIP: u32 = 2500;

/// DEFINE BRUSH PRESET: `rgba` (straight RGBA8, `w × h`) inside the
/// selection's bounds (everything without one) as a tip bitmap —
/// `[w, h]` little-endian u32 followed by `w·h` coverage bytes, cropped
/// to the painted area. Coverage is `(255 − luma) · alpha · selection`
/// (Rec. 601 luma): black paints, white and transparent do not.
/// `None` when nothing would paint. A tip larger than
/// [`MAX_DEFINED_TIP`] on a side is reduced by an integer box average.
pub fn tip_from_pixels(
    w: u32,
    h: u32,
    rgba: &[u8],
    selection: Option<&SelectionCoverage>,
) -> Option<Vec<u8>> {
    if rgba.len() != (w as usize) * (h as usize) * 4 {
        return None;
    }
    let area = match selection {
        Some(s) => s.bounds()?,
        None => Region::new(0, 0, w, h),
    };
    let cov = |x: u32, y: u32| -> u8 {
        let i = ((y * w + x) as usize) * 4;
        let luma = 0.299 * rgba[i] as f32 + 0.587 * rgba[i + 1] as f32 + 0.114 * rgba[i + 2] as f32;
        let mut c = (255.0 - luma) * (rgba[i + 3] as f32 / 255.0);
        if let Some(s) = selection {
            c *= s.coverage_at(x, y) as f32 / 255.0;
        }
        c.round().clamp(0.0, 255.0) as u8
    };
    // Crop to what actually paints.
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in area.y as u32..area.bottom() as u32 {
        for x in area.x as u32..area.right() as u32 {
            if cov(x, y) > 0 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    if x0 >= x1 || y0 >= y1 {
        return None;
    }
    let (cw, ch) = (x1 - x0, y1 - y0);
    let k = cw.max(ch).div_ceil(MAX_DEFINED_TIP).max(1);
    let (tw, th) = (cw.div_ceil(k), ch.div_ceil(k));
    let mut out = Vec::with_capacity(8 + (tw as usize) * (th as usize));
    out.extend_from_slice(&tw.to_le_bytes());
    out.extend_from_slice(&th.to_le_bytes());
    for ty in 0..th {
        for tx in 0..tw {
            let (mut sum, mut n) = (0u32, 0u32);
            for dy in 0..k {
                for dx in 0..k {
                    let (x, y) = (x0 + tx * k + dx, y0 + ty * k + dy);
                    if x < x1 && y < y1 {
                        sum += cov(x, y) as u32;
                        n += 1;
                    }
                }
            }
            out.push((sum / n.max(1)) as u8);
        }
    }
    Some(out)
}

/// A coverage field as a "tip" — every pixel's coverage is the field's.
struct FieldTip<'a> {
    field: &'a SelectionCoverage,
}

impl TipCoverage for FieldTip<'_> {
    fn coverage_at_pixel(&self, _cx: f32, _cy: f32, px: u32, py: u32) -> f32 {
        self.field.coverage_at(px, py) as f32 / 255.0
    }
    fn dab_bounds(&self, _cx: f32, _cy: f32, w: u32, h: u32) -> Option<Region> {
        self.field
            .bounds()
            .and_then(|b| b.intersect(Region::new(0, 0, w, h)))
    }
}

fn gpu_err(e: image_gpu::GpuError) -> IngestError {
    IngestError::Pipeline(e.to_string())
}

/// `mix(a, b, k)` of two straight rgba16float windows on the GPU —
/// `compose.normal` of `b` over `a` under a uniform mask `k`.
async fn mix_f16(
    ctx: &GpuContext,
    a: &[u8],
    b: &[u8],
    k: f32,
    w: u32,
    h: u32,
) -> Result<Vec<u8>, IngestError> {
    if k <= 0.0 {
        return Ok(a.to_vec());
    }
    let mask = image_gpu::SelectionMask::from_fn(w, h, |_, _| k).into_bytes();
    let mode = PaintMode::Sample {
        blend: &COMPOSE_NORMAL,
        source_f16: b,
        correction_f16: None,
    };
    composite_stroke_window(ctx, &mode, a, &mask, w, h)
        .await
        .map_err(gpu_err)
}

/// `region` of a canvas-extent straight RGBA8 buffer, tightly packed.
fn window_of(buf: &[u8], width: u32, region: Region) -> Vec<u8> {
    let mut out = Vec::with_capacity((region.w as usize) * (region.h as usize) * 4);
    for y in 0..region.h {
        let row = (region.y as u32 + y) as usize;
        let start = (row * width as usize + region.x as usize) * 4;
        out.extend_from_slice(&buf[start..start + (region.w as usize) * 4]);
    }
    out
}

/// A `w × h` straight rgba16float field of one colour.
fn solid_f16(w: u32, h: u32, c: [f32; 4]) -> Vec<u8> {
    let texel: Vec<u8> = c
        .iter()
        .flat_map(|v| half::f16::from_f32(*v).to_bits().to_le_bytes())
        .collect();
    texel.repeat((w as usize) * (h as usize))
}

/// Paste a `ww`-wide RGBA8 window into a `size`-square buffer at `(x, y)`.
fn paste(dst: &mut [u8], size: u32, x: i32, y: i32, ww: u32, src: &[u8]) {
    paste_bpp(dst, size, x, y, ww, src, 4);
}

fn paste_f16(dst: &mut [u8], size: u32, x: i32, y: i32, ww: u32, src: &[u8]) {
    paste_bpp(dst, size, x, y, ww, src, 8);
}

fn paste_bpp(dst: &mut [u8], size: u32, x: i32, y: i32, ww: u32, src: &[u8], bpp: usize) {
    let rows = src.len() / ((ww as usize) * bpp).max(1);
    for r in 0..rows {
        let dy = y + r as i32;
        if dy < 0 || dy >= size as i32 || x < 0 {
            continue;
        }
        let d0 = ((dy as usize) * (size as usize) + x as usize) * bpp;
        let n = ((ww as usize).min(size as usize - x as usize)) * bpp;
        let s0 = r * (ww as usize) * bpp;
        dst[d0..d0 + n].copy_from_slice(&src[s0..s0 + n]);
    }
}

/// Crop a `w × h` window at `(x, y)` out of a `size`-square f16 buffer.
fn crop_f16(src: &[u8], size: u32, x: i32, y: i32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w as usize) * (h as usize) * 8);
    for r in 0..h as i32 {
        let sy = (y + r).clamp(0, size as i32 - 1) as usize;
        let s0 = (sy * size as usize + x.max(0) as usize) * 8;
        out.extend_from_slice(&src[s0..s0 + (w as usize) * 8]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_editor_brush_engine_define_brush_preset_takes_dark_pixels_as_paint() {
        // 4×2: black, white, transparent black, mid grey / all black.
        let px = [
            0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 128, 128, 128, 255, //
            0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
        ];
        let tip = tip_from_pixels(4, 2, &px, None).expect("paints");
        let (w, h) = (
            u32::from_le_bytes(tip[0..4].try_into().unwrap()),
            u32::from_le_bytes(tip[4..8].try_into().unwrap()),
        );
        assert_eq!((w, h), (4, 2));
        assert_eq!(&tip[8..12], &[255, 0, 0, 127]);
        // A selection crops it; a blank area is refused.
        let mut sel = SelectionCoverage::empty(4, 2);
        sel.combine(
            &SelectionCoverage::rasterize_rect(4, 2, 0.0, 0.0, 1.0, 2.0),
            image_gpu::CombineMode::Replace,
        );
        let t = tip_from_pixels(4, 2, &px, Some(&sel)).unwrap();
        assert_eq!(&t[0..8], &[1, 0, 0, 0, 2, 0, 0, 0]);
        let white = [255u8; 16];
        assert!(tip_from_pixels(2, 2, &white, None).is_none());
    }

    #[test]
    fn image_editor_brush_engine_windows_paste_and_crop_round_trip() {
        let size = 6u32;
        let mut buf = vec![0u8; (size * size * 8) as usize];
        let win: Vec<u8> = (0..(2 * 3 * 8)).map(|i| i as u8).collect();
        paste_f16(&mut buf, size, 1, 2, 2, &win);
        assert_eq!(crop_f16(&buf, size, 1, 2, 2, 3), win);
        let rgba = vec![9u8; 4 * 4 * 4];
        assert_eq!(window_of(&rgba, 4, Region::new(1, 1, 2, 2)).len(), 16);
        assert_eq!(solid_f16(2, 2, [1.0, 0.0, 0.0, 1.0]).len(), 32);
    }
}
