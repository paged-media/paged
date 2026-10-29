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

//! THE TILED FOLD (ADR 480): the composite of a canvas larger than the
//! device can hold as one texture, folded tile by tile.
//!
//! The resident fold keeps whole-canvas accumulators, so the largest
//! canvas it can fold is the device's texture limit (16384 px on Apple
//! silicon, 8192 on many others) and the largest it can read back is the
//! device's buffer limit (`w · h · 8` bytes, 256 MiB by default — a
//! 5800 px square). Past either, the fold runs per TILE:
//!
//! 1. The plan is made once, at canvas size (the steps hold canvas-sized
//!    CPU pixels; nothing here needs the device).
//! 2. Each tile is WIDENED by the plan's HALO — how far any step reads
//!    its neighbours (a style's blur, distance and offset, an adjustment
//!    layer's blur or sharpen), summed over the steps, since a step reads
//!    what the steps below it made — and every step is cut to that window
//!    ([`Step::window`]): its plates, its masks, a bounded plate's
//!    rectangle.
//! 3. The window folds through the same `run_steps` the whole canvas
//!    does, with a [`Frame`] that says where the window lies, so what is
//!    drawn in canvas coordinates (gradients, patterns, a style's noise)
//!    lands where it lands on the whole canvas.
//! 4. Only the tile's own texels are kept; the halo is thrown away.
//!
//! A texel of the result depends only on the inputs within the halo of
//! it, so the tile's texels are the whole fold's (the whole-vs-tiled
//! tests compare them on stacks small enough to fold both ways).
//!
//! BETWEEN COMPOSITES the result is kept with the plan it came from, as
//! the resident fold keeps its last composite. When only pixels changed
//! — a brush sample, a mask stroke, a filter in a region — the damage is
//! the rectangle where they changed, widened by the halo, and only the
//! tiles it touches are folded again. That is Engine B's evaluation
//! model (ADR 454) — tiles, damage, and recomputing only the invalid
//! ones — applied to the fold.

use image_core::Region;
use image_gpu::coverage::SelectionCoverage;
use image_gpu::{GpuBatch, GpuContext};
use image_kernels::families::cast::{CastUnpremultiplyParams, CAST_UNPREMULTIPLY};

use super::super::styles::{EffectStep, Fx, StrokePart};
use super::super::{LayerMask, LayerStack, Plate};
use super::{diff_bbox, gpu_err, CovKey, FoldCache, FoldState, Frame, Step};
use crate::ingest::IngestError;
use crate::pixels::Pixels;

/// The side of a tile when the device allows it: 2048² rgba16float is
/// 32 MiB a texture, and a fold holds a handful at once.
pub(in crate::layers) const TILE_SIDE: u32 = 2048;

/// Tiles and windows start on this grid when an adjustment layer blurs
/// or sharpens: the adjustment chain runs through Engine A, whose
/// windowed kernels see their 256² tile grid, so a window must lay that
/// grid where the whole canvas lays it.
const CHAIN_GRID: u32 = 256;

/// Otherwise on the dispatch grid.
const GRID: u32 = 16;

fn round_up(v: u32, to: u32) -> u32 {
    v.div_ceil(to) * to
}

/// How far an effect reads around a texel, px (generous: twice the
/// size, the distance and the softening, which bounds every blur, shift
/// and distance field the effect draws with).
fn fx_reach(e: &EffectStep) -> u32 {
    let k = (e.scale / 100.0).max(0.0);
    let r = match &e.fx {
        Fx::DropShadow(s) | Fx::InnerShadow(s) => 2.0 * (s.distance + s.size) * k,
        Fx::OuterGlow(g) | Fx::InnerGlow(g) => 2.0 * g.size * k,
        Fx::Satin(s) => 2.0 * (s.distance + s.size) * k,
        Fx::Stroke(_, StrokePart::Outer(d) | StrokePart::Inner(d)) => 2.0 * d.max(0.0),
        Fx::Bevel(b) => 2.0 * (2.0 * b.size + b.soften) * k + 2.0 * e.stroke_reach,
        Fx::ColorOverlay(_) | Fx::GradientOverlay(_) | Fx::PatternOverlay(_) => 0.0,
    };
    // The distance fields' "+ 2" and a blur's rounding.
    if r > 0.0 {
        r.ceil() as u32 + 8
    } else {
        0
    }
}

impl Step {
    /// How far this step reads around a texel of the accumulator or its
    /// plates.
    fn reach(&self) -> u32 {
        match self {
            Step::Adjust { params, .. } => {
                let blur = if params.blur_sigma > 0.0 {
                    u32::from(image_kernels::families::conv::GAUSSIAN_MAX_RADIUS)
                } else {
                    0
                };
                // The sharpen's own blur: radius 5.
                let sharpen = if params.sharpen_amount > 0.0 { 5 } else { 0 };
                blur + sharpen
            }
            Step::Effect { fx, .. } => fx_reach(fx),
            _ => 0,
        }
    }

    /// An adjustment that reads neighbours through Engine A's tiles.
    fn chain_reads_neighbours(&self) -> bool {
        matches!(self, Step::Adjust { params, .. }
            if params.blur_sigma > 0.0 || params.sharpen_amount > 0.0)
    }

    /// This step cut to `win` (canvas coordinates, inside the
    /// `cw × ch` canvas): its plates, masks and rectangle in the
    /// window's coordinates. `None` when a bounded plate misses the
    /// window, where the step is the identity.
    fn window(&self, win: Region, cw: u32) -> Option<Step> {
        let px = |p: &Pixels| crop(p, cw, win);
        let cov = |c: &CovKey| c.window(win, cw);
        Some(match self {
            Step::Pixel {
                layer,
                px: p,
                rect,
                blend,
                gamma,
                opacity,
                cov: c,
                extra,
            } => {
                let (p, rect) = match rect {
                    None => (px(p), None),
                    Some(r) => {
                        let hit = r.intersect(win)?;
                        let inner = Region::new(hit.x - r.x, hit.y - r.y, hit.w, hit.h);
                        (
                            crop(p, r.w, inner),
                            Some(Region::new(hit.x - win.x, hit.y - win.y, hit.w, hit.h)),
                        )
                    }
                };
                Step::Pixel {
                    layer: *layer,
                    px: p,
                    rect,
                    blend,
                    gamma: *gamma,
                    opacity: *opacity,
                    cov: cov(c),
                    extra: extra.clone(),
                }
            }
            Step::Adjust {
                params,
                opacity,
                cov: c,
            } => Step::Adjust {
                params: params.clone(),
                opacity: *opacity,
                cov: cov(c),
            },
            Step::Direct {
                layer,
                ops,
                opacity,
                cov: c,
            } => Step::Direct {
                layer: *layer,
                ops: ops.clone(),
                opacity: *opacity,
                cov: cov(c),
            },
            Step::ClipOpen {
                layer,
                px: p,
                cov: c,
            } => Step::ClipOpen {
                layer: *layer,
                px: px(p),
                cov: cov(c),
            },
            Step::Effect {
                layer,
                px: p,
                cov: c,
                interior,
                fx,
            } => Step::Effect {
                layer: *layer,
                px: px(p),
                cov: cov(c),
                interior: *interior,
                fx: fx.clone(),
            },
            Step::BodyClose {
                layer,
                px: p,
                cov: c,
            } => Step::BodyClose {
                layer: *layer,
                px: px(p),
                cov: cov(c),
            },
            Step::StyleClose {
                layer,
                slot,
                opacity,
                cov: c,
            } => Step::StyleClose {
                layer: *layer,
                slot: *slot,
                opacity: *opacity,
                cov: cov(c),
            },
            Step::Close {
                group,
                blend,
                cov: c,
            } => Step::Close {
                group: *group,
                blend: *blend,
                cov: cov(c),
            },
            Step::Save { .. } | Step::Open { .. } | Step::ClipClose { .. } | Step::BodyOpen => {
                self.clone()
            }
        })
    }

    /// The pixels this step reads (its plate, and a clip base's), with a
    /// bounded plate's rectangle, and its own mask.
    fn inputs(&self) -> (Vec<(&Pixels, Option<Region>)>, Option<&LayerMask>) {
        fn with_clip<'a>(
            p: &'a Pixels,
            r: Option<Region>,
            c: &'a CovKey,
        ) -> Vec<(&'a Pixels, Option<Region>)> {
            let mut v = vec![(p, r)];
            v.extend(c.clip.as_ref().map(|x| (x, None)));
            v
        }
        match self {
            Step::Pixel { px, rect, cov, .. } => (with_clip(px, *rect, cov), cov.own.as_ref()),
            Step::ClipOpen { px, cov, .. }
            | Step::Effect { px, cov, .. }
            | Step::BodyClose { px, cov, .. } => (with_clip(px, None, cov), cov.own.as_ref()),
            Step::Adjust { cov, .. }
            | Step::Direct { cov, .. }
            | Step::StyleClose { cov, .. }
            | Step::Close { cov, .. } => (
                cov.clip.iter().map(|x| (x, None)).collect(),
                cov.own.as_ref(),
            ),
            _ => (Vec::new(), None),
        }
    }

    /// The same step with `new`'s pixels and masks: equal to `new`
    /// exactly when the two differ in nothing but pixels and masks.
    fn with_inputs_of(&self, new: &Step) -> Step {
        let mut out = self.clone();
        let (np, nm) = new.inputs();
        let nm = nm.cloned();
        let mut np = np.into_iter();
        let mut take = |dst: &mut Pixels, rect: Option<&mut Option<Region>>| {
            if let Some((p, r)) = np.next() {
                *dst = p.clone();
                if let Some(rect) = rect {
                    *rect = r;
                }
            }
        };
        match &mut out {
            Step::Pixel { px, rect, cov, .. } => {
                take(px, Some(rect));
                if let Some(c) = cov.clip.as_mut() {
                    take(c, None);
                }
                cov.own = nm;
            }
            Step::ClipOpen { px, cov, .. }
            | Step::Effect { px, cov, .. }
            | Step::BodyClose { px, cov, .. } => {
                take(px, None);
                if let Some(c) = cov.clip.as_mut() {
                    take(c, None);
                }
                cov.own = nm;
            }
            Step::Adjust { cov, .. }
            | Step::Direct { cov, .. }
            | Step::StyleClose { cov, .. }
            | Step::Close { cov, .. } => {
                if let Some(c) = cov.clip.as_mut() {
                    take(c, None);
                }
                cov.own = nm;
            }
            _ => {}
        }
        out
    }
}

impl CovKey {
    /// The coverage cut to `win` on a canvas `cw` wide.
    fn window(&self, win: Region, cw: u32) -> CovKey {
        CovKey {
            own: self.own.as_ref().map(|m| {
                let data = (0..win.h)
                    .flat_map(|y| (0..win.w).map(move |x| m.at(win.x as u32 + x, win.y as u32 + y)))
                    .collect();
                LayerMask::Canvas(std::sync::Arc::new(
                    SelectionCoverage::from_data(win.w, win.h, data).expect("window-sized"),
                ))
            }),
            clip: self.clip.as_ref().map(|p| crop(p, cw, win)),
        }
    }
}

/// `win` of `px` (a `w`-wide image at its own depth), as new pixels.
fn crop(px: &Pixels, w: u32, win: Region) -> Pixels {
    let bpp = px.bytes_per_pixel();
    let row = win.w as usize * bpp;
    let src = px.raw();
    let mut out = Vec::with_capacity(row * win.h as usize);
    for y in 0..win.h as usize {
        let s = ((win.y as usize + y) * w as usize + win.x as usize) * bpp;
        out.extend_from_slice(&src[s..s + row]);
    }
    Pixels::from_raw(std::sync::Arc::from(out.into_boxed_slice()), px.depth())
}

/// Where two masks differ, canvas coordinates.
fn mask_damage(a: &LayerMask, b: &LayerMask) -> Option<(u32, u32, u32, u32)> {
    let (a, b) = (a.to_canvas(), b.to_canvas());
    if a.width() != b.width() || a.data().len() != b.data().len() {
        return Some((0, 0, a.width().max(b.width()), u32::MAX));
    }
    diff_bbox(a.data(), b.data(), a.width(), 1)
}

/// Where the pixels a step reads changed between `old` and `new` — the
/// union of every changed plate's and mask's rectangle, canvas
/// coordinates — when nothing else changed. `Some(None)`: nothing
/// changed at all; `None`: something other than pixels changed, and the
/// whole canvas is damaged.
fn damage(old: &[Step], new: &[Step], cw: u32, ch: u32) -> Option<Option<Region>> {
    if old.len() != new.len() {
        return None;
    }
    let mut out: Option<Region> = None;
    let mut add = |r: Region| {
        out = Some(match out {
            None => r,
            Some(o) => o.union(r),
        });
    };
    let whole = Region::new(0, 0, cw, ch);
    for (o, n) in old.iter().zip(new) {
        if o.same(n) {
            continue;
        }
        if !o.with_inputs_of(n).same(n) {
            return None;
        }
        let ((op, om), (np, nm)) = (o.inputs(), n.inputs());
        for ((a, ar), (b, br)) in op.into_iter().zip(np) {
            if a.same(b) && ar == br {
                continue;
            }
            match (ar, br) {
                (None, None) if a.len() == b.len() && a.depth() == b.depth() => {
                    if let Some((x, y, w, h)) = diff_bbox(a.raw(), b.raw(), cw, a.bytes_per_pixel())
                    {
                        add(Region::new(x as i32, y as i32, w, h));
                    }
                }
                (Some(ra), Some(rb))
                    if ra == rb && a.len() == b.len() && a.depth() == b.depth() =>
                {
                    if let Some((x, y, w, h)) =
                        diff_bbox(a.raw(), b.raw(), ra.w, a.bytes_per_pixel())
                    {
                        add(Region::new(ra.x + x as i32, ra.y + y as i32, w, h));
                    }
                }
                (ra, rb) => {
                    add(ra.unwrap_or(whole));
                    add(rb.unwrap_or(whole));
                }
            }
        }
        match (om, nm) {
            (None, None) => {}
            (Some(a), Some(b)) if a.same(b) => {}
            (Some(a), Some(b)) => match mask_damage(a, b) {
                Some((_, _, _, u32::MAX)) => add(whole),
                Some((x, y, w, h)) => add(Region::new(x as i32, y as i32, w, h)),
                None => {}
            },
            _ => add(whole),
        }
    }
    Some(out.and_then(|r| r.intersect(whole)))
}

impl LayerStack {
    /// Must this composite run tile by tile — the canvas larger than a
    /// texture, or its readback larger than a buffer, on this device (or
    /// a tile side set for it)?
    pub(in crate::layers) fn fold_tile_side(&self, ctx: &GpuContext) -> Option<u32> {
        let forced = self.fold.lock().expect("fold cache lock").tile;
        if forced.is_some() {
            return forced;
        }
        let (w, h) = (self.width, self.height);
        let too_wide = w.max(h) > ctx.max_texture_dim();
        let too_big = u64::from(w) * u64::from(h) * 8 > ctx.max_buffer_size();
        (too_wide || too_big).then_some(TILE_SIDE)
    }

    /// Fold tiles of `side` px (a multiple of the grid it rounds to)
    /// instead of the whole canvas at once, whatever the canvas's size
    /// (`None`: only past the device's limits). Tests and benches set it
    /// to compare the tiled fold with the whole one.
    #[doc(hidden)]
    pub fn set_fold_tile(&self, side: Option<u32>) {
        let mut cache = self.fold.lock().expect("fold cache lock");
        cache.tile = side;
        cache.last = None;
        cache.checkpoint = None;
    }

    /// The tiled composite (see the module docs): on the device, or —
    /// `ctx` `None` — on the CPU ([`super::cpu`], image ADR 480).
    pub(in crate::layers) async fn composite_tiled(
        &self,
        ctx: Option<&GpuContext>,
        plates: &[(usize, Plate)],
        depth: image_core::SampleDepth,
        side: u32,
    ) -> Result<Pixels, IngestError> {
        let (steps, _) = self.plan_fold(plates);
        self.fold_steps_tiled(ctx, steps, depth, side, true).await
    }

    /// Fold a plan tile by tile (see the module docs). `keep`: compare with
    /// and keep the last result (the document's own composite); a plan of
    /// substituted plates (the ink planes, ADR 481) neither reads nor
    /// replaces it.
    pub(in crate::layers) async fn fold_steps_tiled(
        &self,
        ctx: Option<&GpuContext>,
        steps: Vec<Step>,
        depth: image_core::SampleDepth,
        side: u32,
        keep: bool,
    ) -> Result<Pixels, IngestError> {
        let (cw, ch) = (self.width, self.height);
        if ctx.is_none() {
            super::cpu::supported(&steps)?;
        }
        let grid = if steps.iter().any(Step::chain_reads_neighbours) {
            CHAIN_GRID
        } else {
            GRID
        };
        let halo = round_up(steps.iter().map(Step::reach).sum::<u32>(), grid);
        let side = round_up(side.max(1), grid);
        let side = match ctx {
            Some(ctx) => {
                let limit = ctx.max_texture_dim();
                let room = limit.saturating_sub(2 * halo) / grid * grid;
                if room == 0 {
                    return Err(IngestError::Unsupported(format!(
                        "the layer styles and adjustments reach {halo} px around a pixel, more \
                         than a {limit} px texture can hold around a tile"
                    )));
                }
                side.min(room)
            }
            None => side,
        };

        let mut cache = if keep {
            std::mem::take(&mut *self.fold.lock().expect("fold cache lock"))
        } else {
            FoldCache::default()
        };
        cache.bind_to(ctx);
        // What to fold: everything, or the damage since the last result.
        let (mut out, dirty) = match cache.last.take() {
            Some((last_steps, last)) if last.depth() == depth => {
                match damage(&last_steps, &steps, cw, ch) {
                    Some(None) => {
                        cache.last = Some((steps, last.clone()));
                        if keep {
                            *self.fold.lock().expect("fold cache lock") = cache;
                        }
                        return Ok(last);
                    }
                    Some(Some(r)) => {
                        let wide = Region::new(
                            r.x - halo as i32,
                            r.y - halo as i32,
                            r.w + 2 * halo,
                            r.h + 2 * halo,
                        );
                        (last, wide.intersect(Region::new(0, 0, cw, ch)))
                    }
                    None => (blank(cw, ch, depth), None),
                }
            }
            _ => (blank(cw, ch, depth), None),
        };
        let mut folded = 0u64;
        for ty in (0..ch).step_by(side as usize) {
            for tx in (0..cw).step_by(side as usize) {
                let tile = Region::new(tx as i32, ty as i32, side.min(cw - tx), side.min(ch - ty));
                if let Some(d) = dirty {
                    if d.intersect(tile).is_none() {
                        continue;
                    }
                }
                let wx = tx.saturating_sub(halo);
                let wy = ty.saturating_sub(halo);
                let win = Region::new(
                    wx as i32,
                    wy as i32,
                    (tx + tile.w + halo).min(cw) - wx,
                    (ty + tile.h + halo).min(ch) - wy,
                );
                let frame = Frame {
                    w: win.w,
                    h: win.h,
                    ox: win.x,
                    oy: win.y,
                    cw,
                    ch,
                };
                let wsteps: Vec<Step> = steps.iter().filter_map(|s| s.window(win, cw)).collect();
                let inner = Region::new(tx as i32 - win.x, ty as i32 - win.y, tile.w, tile.h);
                let px = match ctx {
                    Some(ctx) => self.fold_window(ctx, &wsteps, frame, inner, depth).await?,
                    None => super::cpu::fold_window(&wsteps, frame, inner, depth)?,
                };
                paste(&mut out, cw, &px, tile);
                folded += 1;
            }
        }
        crate::counters::bump(|c| c.fold_tiles += folded);
        if keep {
            cache.retain(&[]);
            cache.checkpoint = None;
            cache.last = Some((steps, out.clone()));
            *self.fold.lock().expect("fold cache lock") = cache;
        }
        Ok(out)
    }

    /// One window folded on the device; `inner` of it read back.
    async fn fold_window(
        &self,
        ctx: &GpuContext,
        steps: &[Step],
        frame: Frame,
        inner: Region,
        depth: image_core::SampleDepth,
    ) -> Result<Pixels, IngestError> {
        // Each window its own plates and masks: they are cut anew, so
        // nothing would be found in a shared cache.
        let mut local = FoldCache::default();
        local.bind(ctx);
        let mut batch = GpuBatch::new(ctx);
        let (st, _) = self
            .run_steps(
                ctx,
                &mut local,
                &mut batch,
                steps,
                0,
                FoldState::default(),
                usize::MAX,
                frame,
            )
            .await?;
        let acc = st.acc.unwrap_or_else(|| ctx.zeros(frame.w, frame.h));
        let un = batch.target(frame.w, frame.h);
        batch
            .dispatch(
                &CAST_UNPREMULTIPLY,
                &[&acc],
                CastUnpremultiplyParams::new().as_bytes(),
                None,
                &un,
            )
            .map_err(gpu_err)?;
        let ticket = batch.read_window(&un, inner.x as u32, inner.y as u32, inner.w, inner.h);
        let reads = batch.finish_async().await.map_err(gpu_err)?;
        Ok(Pixels::from_f16(&reads[ticket.0], depth))
    }
}

fn blank(w: u32, h: u32, depth: image_core::SampleDepth) -> Pixels {
    let bpp = match depth {
        image_core::SampleDepth::U16 => 8,
        _ => 4,
    };
    Pixels::from_raw(
        std::sync::Arc::from(vec![0u8; w as usize * h as usize * bpp].into_boxed_slice()),
        depth,
    )
}

/// Write `px` (`tile`'s size) into `out` (a `cw`-wide canvas) at `tile`.
fn paste(out: &mut Pixels, cw: u32, px: &Pixels, tile: Region) {
    let bpp = out.bytes_per_pixel();
    let row = tile.w as usize * bpp;
    let src = px.raw();
    let dst = out.make_mut();
    for y in 0..tile.h as usize {
        let d = ((tile.y as usize + y) * cw as usize + tile.x as usize) * bpp;
        dst[d..d + row].copy_from_slice(&src[y * row..(y + 1) * row]);
    }
}
