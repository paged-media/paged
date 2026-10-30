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

//! The GPU-RESIDENT layer fold.
//!
//! The fold used to read the whole accumulator back after every layer
//! and upload it again for the next one, and to upload and premultiply
//! every layer's plate on every composite. Here the accumulator stays
//! on the device: every blend of one composite is recorded into one
//! batch, one submit, ONE readback of the finished canvas.
//!
//! Three caches live between composites, all keyed by IDENTITY (the
//! `Arc` of a layer's pixels, of its mask, of its clip base) plus the
//! layer's properties — so they need no invalidation hook: an edit
//! replaces the `Arc`, and the old key simply stops matching. Each
//! cache holds clones of the `Arc`s it keys on, so an address cannot be
//! reused under a stale entry.
//!
//! * PLATES: each layer's premultiplied rgba16float plate, uploaded once
//!   per pixel generation.
//! * A PREFIX CHECKPOINT: the fold state just before the active layer.
//!   An edit at or above it (paint, opacity, blend, mask) re-folds from
//!   there instead of from the bottom.
//! * THE LAST COMPOSITE: an unchanged stack hands back the last result.
//!
//! Every recorded dispatch is the dispatch the CPU round-trip fold made
//! (same kernels, params, masks, extents), and rgba16float textures hold
//! exactly the bytes that round trip re-uploaded, so the result is byte
//! for byte the same (`image-conformance/tests/it/prop_layer_cache.rs`
//! compares the two). The one rewrite that is not a pure relocation:
//! the old fold skipped its final unpremultiply when the whole canvas
//! was opaque (it could look at the bytes); the resident fold cannot
//! without a second readback, so it always dispatches it — which over
//! an opaque texel divides by one and is the identity (asserted
//! exhaustively over f16 by the same test file).

use std::collections::HashMap;
use std::sync::Arc;

use image_gpu::coverage::SelectionCoverage;
use image_gpu::selection::SelectionMask;
use image_gpu::stroke::window_is_opaque;
use image_gpu::{GpuBatch, GpuContext, Resident, TexFormat};
use image_kernels::families::arithmetic::{
    MathMulConstParams, MathMulParams, MATH_MUL, MATH_MUL_CONST,
};
use image_kernels::families::band::{
    BandBlendIfParams, BandBroadcastAlphaParams, BandFadeNeutralParams, BandSetAlphaParams,
    BandTakeParams, BAND_BLEND_IF, BAND_BROADCAST_ALPHA, BAND_FADE_NEUTRAL, BAND_SET_ALPHA,
    BAND_TAKE,
};
use image_kernels::families::cast::{
    CastPremultiplyParams, CastUnpremultiplyParams, CAST_PREMULTIPLY, CAST_UNPREMULTIPLY,
};
use image_kernels::families::compose::{
    ComposeGammaParams, ComposeParams, COMPOSE_NORMAL, COMPOSE_NORMAL_GAMMA,
};
use image_kernels::KernelDef;

use super::{alpha_of_px, effective_coverage, LayerMask, LayerStack, Plate};
use crate::ingest::{AdjustParams, IngestError};
use crate::pixels::Pixels;
use image_core::Region;

/// Device bytes of plates the cache keeps between composites. Past it a
/// plate is still uploaded for the composite that needs it, just not
/// kept — the cache trades memory for uploads, and an unbounded trade
/// would put a large many-layer document's every plate on the device.
const PLATE_CACHE_BYTES: u64 = 512 << 20;

fn gpu_err(e: image_gpu::GpuError) -> IngestError {
    IngestError::Pipeline(e.to_string())
}

fn same_mask(a: &Option<LayerMask>, b: &Option<LayerMask>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.same(b),
        _ => false,
    }
}

/// What a step's coverage is built from: the layer's own live mask and
/// the clip base's pixels (whose alpha is the clip).
#[derive(Clone, Default)]
pub(super) struct CovKey {
    pub own: Option<LayerMask>,
    pub clip: Option<Pixels>,
}

impl CovKey {
    fn same(&self, o: &CovKey) -> bool {
        same_mask(&self.own, &o.own)
            && match (&self.clip, &o.clip) {
                (None, None) => true,
                (Some(a), Some(b)) => a.same(b),
                _ => false,
            }
    }

    fn is_none(&self) -> bool {
        self.own.is_none() && self.clip.is_none()
    }

    /// The combined coverage, exactly as the fold has always built it.
    pub(super) fn coverage(&self, w: u32, h: u32) -> Option<Arc<SelectionCoverage>> {
        let clip = self.clip.as_ref().map(alpha_of_px);
        effective_coverage(self.own.as_ref(), clip.as_deref(), w, h)
    }

    /// The r16float mask bytes, exactly as the fold has always lowered
    /// them — read texel by texel, so a bounded mask is never expanded
    /// on the CPU for its upload.
    fn mask_bytes(&self, w: u32, h: u32) -> Option<Vec<u8>> {
        if self.is_none() {
            return None;
        }
        let clip = self.clip.as_ref();
        Some(
            SelectionMask::from_fn(w, h, |x, y| {
                let own = self.own.as_ref().map(|m| u32::from(m.at(x, y)));
                let c = clip.map(|px| u32::from(px.alpha8(y as usize * w as usize + x as usize)));
                let v = match (own, c) {
                    (Some(a), Some(b)) => (a * b + 127) / 255,
                    (Some(a), None) => a,
                    (None, Some(b)) => b,
                    (None, None) => 255,
                };
                v as f32 / 255.0
            })
            .into_bytes(),
        )
    }
}

/// Where a knockout layer's hole shows through to: a saved fold state
/// (`Some(slot)`: the start of its pass-through group, or the Background
/// layer), or transparency (`None`: an isolated group's own start, or a
/// stack without a Background).
#[derive(Clone, Copy, PartialEq)]
pub(super) struct KnockoutStep {
    pub slot: Option<u32>,
    /// The layer's opacity: the knocked-out result mixes in by it (the
    /// blend itself runs at the fill).
    pub opacity: f32,
}

/// The slot the Background layer's fold state is saved under.
pub(super) const DEEP_SLOT: u32 = u32::MAX;

/// A styled layer's backdrop is saved under `STYLE_SLOT | id`.
pub(super) const STYLE_SLOT: u32 = 0x4000_0000;

/// The mask cache keeps a layer's effect-hiding mask under `id | this`.
pub(super) const HIDE_MASK_BIT: u32 = 0x2000_0000;

/// An open clipping group in the plan: the base's blend and opacity,
/// whether its close applies the base's shape, and the steps a styled
/// base adds just before (interior effects blended as a group) and after
/// its close (the rest of its style).
struct OpenClip {
    blend: &'static KernelDef,
    opacity: f32,
    shape: bool,
    before: Vec<Step>,
    after: Vec<Step>,
}

/// What a pixel step does beyond a plain blend (the blending options).
#[derive(Clone, PartialEq, Default)]
pub(super) struct PixelExtra {
    /// Blend If: the coverage the layer blends with, from its own and the
    /// backdrop's values (`band.blend_if`), times its mask.
    pub blend_if: Option<BandBlendIfParams>,
    /// Fill opacity on a special mode: the plate fades toward the mode's
    /// neutral colour before it blends (`band.fade_neutral`).
    pub fade: Option<BandFadeNeutralParams>,
    pub knockout: Option<KnockoutStep>,
}

/// One step of the fold, in the order the fold runs them.
#[derive(Clone)]
pub(super) enum Step {
    /// Blend a pixel plate into the accumulator. With `rect` the plate is
    /// a bounded layer's pixels inside that rectangle (ADR 464), blended
    /// through a window of the accumulator.
    Pixel {
        layer: u32,
        px: Pixels,
        rect: Option<Region>,
        blend: &'static KernelDef,
        /// Normal blending in this gamma space (a text layer).
        gamma: Option<f32>,
        opacity: f32,
        cov: CovKey,
        /// The blending options in effect (`None`: a plain blend). A step
        /// with extras is always canvas-sized (`rect: None`).
        extra: Option<Box<PixelExtra>>,
    },
    /// Run the adjust chain over the accumulator, through the layer's
    /// coverage scaled by its opacity.
    Adjust {
        params: Box<AdjustParams>,
        opacity: f32,
        cov: CovKey,
    },
    /// Run point kernels over the RESIDENT accumulator, in order, and mix
    /// the result in through the layer's coverage × opacity — a Gradient
    /// Map, Selective Color or Color Lookup layer (no readback).
    Direct {
        layer: u32,
        ops: Arc<Vec<(&'static KernelDef, Vec<u8>)>>,
        opacity: f32,
        cov: CovKey,
    },
    /// Keep the accumulator as it is now under `slot` (a knockout's
    /// backdrop).
    Save { slot: u32 },
    /// Park the accumulator and start an isolated group's own.
    Open { group: u32 },
    /// Start a CLIPPING GROUP (Photoshop's): park the accumulator, put the
    /// clip base in alone — normal, full strength, through its own mask —
    /// and make it opaque, so the clipped layers blend onto the base and
    /// nothing else.
    ClipOpen { layer: u32, px: Pixels, cov: CovKey },
    /// End it: give the group the base's alpha back and blend it onto the
    /// parked accumulator with the BASE's blend mode and opacity — which
    /// is why a clip base at 50 % fades its clipped layers too.
    ClipClose {
        blend: &'static KernelDef,
        opacity: f32,
        /// Apply the base's alpha (a clipping group). `false` closes a
        /// styled layer's BODY: its shape is applied later, at
        /// `BodyClose`, after the interior effects.
        shape: bool,
    },
    /// Draw one effect of a layer's STYLE onto the accumulator
    /// (`styles`). `px` is the layer's canvas-sized pixels, `cov` the
    /// mask that shapes the effects (none when the mask hides them).
    /// `interior` blends the effect through the layer's shape (an
    /// interior effect of a clipped layer, which has no body).
    Effect {
        layer: u32,
        px: Pixels,
        cov: CovKey,
        interior: bool,
        fx: Arc<super::styles::EffectStep>,
    },
    /// Start a styled layer's BODY: keep the accumulator (with the
    /// exterior effects) to mix the body into at `BodyClose`.
    BodyOpen,
    /// End it: `mix(kept, accumulator, shape)` — the layer's alpha times
    /// `cov`.
    BodyClose { layer: u32, px: Pixels, cov: CovKey },
    /// End a styled layer: `mix(saved backdrop, accumulator, opacity ×
    /// cov)` — its opacity, and a mask that hides its effects.
    StyleClose {
        layer: u32,
        slot: u32,
        opacity: f32,
        cov: CovKey,
    },
    /// Blend the group's accumulator into the parked one (`None`: the
    /// group vanished, and the parked accumulator comes back unchanged).
    Close {
        group: u32,
        blend: Option<(&'static KernelDef, f32)>,
        /// The group's live mask (`own`; no clip), through which its
        /// composite blends.
        cov: CovKey,
    },
}

impl Step {
    fn same(&self, o: &Step) -> bool {
        match (self, o) {
            (
                Step::Pixel {
                    layer,
                    px,
                    rect,
                    blend,
                    gamma,
                    opacity,
                    cov,
                    extra,
                },
                Step::Pixel {
                    layer: l2,
                    px: p2,
                    rect: r2,
                    blend: b2,
                    gamma: g2,
                    opacity: o2,
                    cov: c2,
                    extra: e2,
                },
            ) => {
                layer == l2
                    && rect == r2
                    && gamma == g2
                    && px.same(p2)
                    && std::ptr::eq(*blend, *b2)
                    && opacity.to_bits() == o2.to_bits()
                    && cov.same(c2)
                    && extra == e2
            }
            (
                Step::Direct {
                    layer,
                    ops,
                    opacity,
                    cov,
                },
                Step::Direct {
                    layer: l2,
                    ops: o2,
                    opacity: p2,
                    cov: c2,
                },
            ) => {
                layer == l2
                    && opacity.to_bits() == p2.to_bits()
                    && cov.same(c2)
                    && ops.len() == o2.len()
                    && ops
                        .iter()
                        .zip(o2.iter())
                        .all(|((d, b), (d2, b2))| std::ptr::eq(*d, *d2) && b == b2)
            }
            (Step::Save { slot }, Step::Save { slot: s2 }) => slot == s2,
            (
                Step::Adjust {
                    params,
                    opacity,
                    cov,
                },
                Step::Adjust {
                    params: p2,
                    opacity: o2,
                    cov: c2,
                },
            ) => params == p2 && opacity.to_bits() == o2.to_bits() && cov.same(c2),
            (Step::Open { group }, Step::Open { group: g2 }) => group == g2,
            (
                Step::ClipOpen { layer, px, cov },
                Step::ClipOpen {
                    layer: l2,
                    px: p2,
                    cov: c2,
                },
            ) => layer == l2 && px.same(p2) && cov.same(c2),
            (
                Step::ClipClose {
                    blend,
                    opacity,
                    shape,
                },
                Step::ClipClose {
                    blend: b2,
                    opacity: o2,
                    shape: s2,
                },
            ) => std::ptr::eq(*blend, *b2) && opacity.to_bits() == o2.to_bits() && shape == s2,
            (
                Step::Effect {
                    layer,
                    px,
                    cov,
                    interior,
                    fx,
                },
                Step::Effect {
                    layer: l2,
                    px: p2,
                    cov: c2,
                    interior: i2,
                    fx: f2,
                },
            ) => {
                layer == l2
                    && px.same(p2)
                    && cov.same(c2)
                    && interior == i2
                    && (Arc::ptr_eq(fx, f2) || fx == f2)
            }
            (Step::BodyOpen, Step::BodyOpen) => true,
            (
                Step::BodyClose { layer, px, cov },
                Step::BodyClose {
                    layer: l2,
                    px: p2,
                    cov: c2,
                },
            ) => layer == l2 && px.same(p2) && cov.same(c2),
            (
                Step::StyleClose {
                    layer,
                    slot,
                    opacity,
                    cov,
                },
                Step::StyleClose {
                    layer: l2,
                    slot: s2,
                    opacity: o2,
                    cov: c2,
                },
            ) => layer == l2 && slot == s2 && opacity.to_bits() == o2.to_bits() && cov.same(c2),
            (
                Step::Close { group, blend, cov },
                Step::Close {
                    group: g2,
                    blend: b2,
                    cov: c2,
                },
            ) => {
                group == g2
                    && cov.same(c2)
                    && match (blend, b2) {
                        (None, None) => true,
                        (Some((d, o)), Some((d2, o2))) => {
                            std::ptr::eq(*d, *d2) && o.to_bits() == o2.to_bits()
                        }
                        _ => false,
                    }
            }
            _ => false,
        }
    }

    fn is_layer(&self) -> bool {
        matches!(
            self,
            Step::Pixel { .. } | Step::Adjust { .. } | Step::ClipOpen { .. } | Step::Direct { .. }
        )
    }

    /// Does this step need more than the point-wise windowed refold?
    fn needs_whole_refold(&self) -> bool {
        matches!(
            self,
            Step::Direct { .. }
                | Step::Save { .. }
                | Step::Pixel { extra: Some(_), .. }
                | Step::Effect { .. }
                | Step::BodyOpen
                | Step::BodyClose { .. }
                | Step::StyleClose { .. }
        )
    }
}

pub(super) fn same_steps(a: &[Step], b: &[Step]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.same(y))
}

/// The accumulator and the parked accumulators of the open isolated
/// groups. `None` is transparent black (never materialized).
#[derive(Clone, Default)]
pub(super) struct FoldState {
    acc: Option<Resident>,
    parked: Vec<Option<Resident>>,
    /// The premultiplied base of each open clipping group (its alpha is
    /// the group's).
    clip: Vec<Resident>,
    /// Knockout backdrops kept by `Step::Save`.
    saved: Vec<(u32, Option<Resident>)>,
}

/// Everything the fold keeps on the device between composites.
#[derive(Default)]
pub(super) struct FoldCache {
    /// The device these textures live on (its address).
    device: usize,
    /// Layer id → (the pixels the plate was made from, the plate).
    plates: HashMap<u32, (Pixels, Resident)>,
    /// Layer id → (what the mask was made from, the r16float mask).
    masks: HashMap<u32, (CovKey, Resident)>,
    /// The steps before the checkpoint, and the state after them.
    checkpoint: Option<(Vec<Step>, FoldState)>,
    /// The last composite's steps and result.
    last: Option<(Vec<Step>, Pixels)>,
}

impl FoldCache {
    fn bind(&mut self, ctx: &GpuContext) {
        let id = ctx as *const GpuContext as usize;
        if self.device != id {
            *self = FoldCache {
                device: id,
                ..FoldCache::default()
            };
        }
    }

    /// The premultiplied plate for `layer`'s pixels `px`: the cached one
    /// when the pixels are the same allocation, else uploaded (and
    /// premultiplied unless opaque — the fold's long-standing skip,
    /// which is decided on the CPU bytes, exactly as before).
    fn plate(
        &mut self,
        batch: &mut GpuBatch<'_>,
        layer: u32,
        px: &Pixels,
        w: u32,
        h: u32,
    ) -> Result<Resident, IngestError> {
        if let Some((cached, tex)) = self.plates.get(&layer) {
            if cached.same(px) {
                return Ok(tex.clone());
            }
        }
        // A canvas (or the bounded window) at the plate's own depth: a
        // 16-bit layer uploads its 16-bit samples, so the fold blends
        // what the layer holds rather than its high bytes.
        if px.len() < (w as usize) * (h as usize) * px.bytes_per_pixel() {
            return Err(IngestError::Decode(format!(
                "layer plate is {} bytes for {w}×{h}",
                px.len()
            )));
        }
        let straight = px.to_f16();
        let tex = if window_is_opaque(&straight) {
            batch.upload(w, h, TexFormat::Rgba16Float, &straight)
        } else {
            let src = batch.upload(w, h, TexFormat::Rgba16Float, &straight);
            let out = batch.target(w, h);
            batch
                .dispatch(
                    &CAST_PREMULTIPLY,
                    &[&src],
                    CastPremultiplyParams::new().as_bytes(),
                    None,
                    &out,
                )
                .map_err(gpu_err)?;
            out
        };
        let held: u64 = self
            .plates
            .iter()
            .filter(|(id, _)| **id != layer)
            .map(|(_, (_, t))| t.bytes())
            .sum();
        if held + tex.bytes() <= PLATE_CACHE_BYTES {
            self.plates.insert(layer, (px.clone(), tex.clone()));
        } else {
            self.plates.remove(&layer);
        }
        Ok(tex)
    }

    /// The r16float mask for a step, cached per layer by what built it.
    fn mask(
        &mut self,
        batch: &mut GpuBatch<'_>,
        layer: u32,
        cov: &CovKey,
        w: u32,
        h: u32,
    ) -> Option<Resident> {
        if cov.is_none() {
            return None;
        }
        if let Some((key, tex)) = self.masks.get(&layer) {
            if key.same(cov) {
                return Some(tex.clone());
            }
        }
        let bytes = cov.mask_bytes(w, h)?;
        let tex = batch.upload(w, h, TexFormat::R16Float, &bytes);
        self.masks.insert(layer, (cov.clone(), tex.clone()));
        Some(tex)
    }

    /// Forget plates and masks of layers the latest plan no longer has.
    fn retain(&mut self, steps: &[Step]) {
        let live: Vec<u32> = steps
            .iter()
            .filter_map(|s| match s {
                Step::Pixel { layer, .. }
                | Step::ClipOpen { layer, .. }
                | Step::Direct { layer, .. } => Some(*layer),
                Step::Close { group, .. } => Some(*group),
                Step::StyleClose { layer, .. } => Some(*layer | HIDE_MASK_BIT),
                _ => None,
            })
            .collect();
        self.plates.retain(|id, _| live.contains(id));
        self.masks.retain(|id, _| live.contains(id));
    }
}

impl LayerStack {
    /// Plan the fold: the steps it runs, bottom-up, and where the
    /// checkpoint goes (before the first contributing layer at or above
    /// the active one). The SAME walk the fold has always made — group
    /// opening and closing, the hidden-group skip, the clip base — just
    /// recorded instead of executed.
    pub(super) fn plan_fold(&self, plates: &[(usize, Plate)]) -> (Vec<Step>, usize) {
        let mut steps = Vec::new();
        let mut open: Vec<u32> = Vec::new();
        // The clip base: its layer index and plate. Its CANVAS-sized
        // pixels (whose alpha is the clip) are asked for only when a
        // clipped layer needs them, so a bounded layer that clips nothing
        // is never expanded.
        let mut clip_base: Option<(usize, &Plate)> = None;
        let canvas_of = |(i, p): (usize, &Plate)| -> Pixels {
            match p.rect {
                Some(_) => self.layers[i].rgba.canvas().clone(),
                None => p.px.clone(),
            }
        };
        // The open clipping group's base (blend, opacity, …).
        let mut clip_group: Option<OpenClip> = None;
        let close_clip = |steps: &mut Vec<Step>, g: &mut Option<OpenClip>| {
            if let Some(g) = g.take() {
                steps.extend(g.before);
                steps.push(Step::ClipClose {
                    blend: g.blend,
                    opacity: g.opacity,
                    shape: g.shape,
                });
                steps.extend(g.after);
            }
        };
        // KNOCKOUT needs the fold state at its backdrops: the Background
        // layer (deep) and the start of each pass-through group (shallow).
        // They are saved only when some layer knocks out.
        let knocks = plates.iter().any(|(i, _)| {
            let l = &self.layers[*i];
            l.ext.knockout != super::Knockout::None && !l.clipped && l.is_pixels()
        });
        let background = knocks
            && plates.first().is_some_and(|(i, _)| {
                let l = &self.layers[*i];
                *i == 0
                    && l.name == super::BACKGROUND_LAYER_NAME
                    && l.group.is_none()
                    && l.is_pixels()
                    && !self.layers.get(1).is_some_and(|n| n.clipped)
            });
        let mut entered: Vec<u32> = Vec::new();
        let mut checkpoint = None;
        for (index, plate) in plates {
            let layer = &self.layers[*index];
            if *index >= self.active && checkpoint.is_none() {
                checkpoint = Some(steps.len());
            }
            let want = self.chain_of(layer.group);
            if want.iter().any(|g| !self.group_enabled(*g)) {
                continue;
            }
            if !layer.clipped {
                close_clip(&mut steps, &mut clip_group);
            }
            while let Some(gid) = open.last() {
                if want.contains(gid) {
                    break;
                }
                close_clip(&mut steps, &mut clip_group);
                let gid = open.pop().expect("non-empty");
                steps.push(self.close_step(gid));
                clip_base = None;
            }
            entered.retain(|g| want.contains(g));
            for gid in want.iter().copied() {
                if open.contains(&gid) || entered.contains(&gid) {
                    continue;
                }
                let isolates = self
                    .groups
                    .iter()
                    .find(|g| g.id == gid)
                    .is_some_and(|g| g.isolates());
                if isolates {
                    close_clip(&mut steps, &mut clip_group);
                    open.push(gid);
                    steps.push(Step::Open { group: gid });
                    clip_base = None;
                } else {
                    entered.push(gid);
                    if knocks {
                        close_clip(&mut steps, &mut clip_group);
                        steps.push(Step::Save { slot: gid });
                    }
                }
            }
            if layer.clipped {
                let Some(base) = clip_base else {
                    continue;
                };
                // The first clipped layer turns the base's step into the
                // start of its clipping group.
                if clip_group.is_none() {
                    if let Some(Step::Pixel {
                        layer,
                        blend,
                        opacity,
                        cov,
                        ..
                    }) = steps.last()
                    {
                        if *layer == self.layers[base.0].id {
                            clip_group = Some(OpenClip {
                                blend,
                                opacity: *opacity,
                                shape: true,
                                before: Vec::new(),
                                after: Vec::new(),
                            });
                            let open_step = Step::ClipOpen {
                                layer: *layer,
                                px: canvas_of(base),
                                cov: cov.clone(),
                            };
                            *steps.last_mut().expect("non-empty") = open_step;
                        }
                    }
                }
            } else if layer.is_pixels() {
                clip_base = Some((*index, plate));
            }
            let cov = CovKey {
                own: super::multiply_coverage(
                    layer.live_mask(),
                    self.pass_through_mask(layer.group),
                ),
                // Inside a clipping group the base's alpha is applied
                // once, at its close; outside one (no base step to open
                // it on) the clip falls back to confining coverage.
                clip: if layer.clipped && clip_group.is_none() {
                    clip_base.map(canvas_of)
                } else {
                    None
                },
            };
            let fill = layer.ext.fill_opacity.clamp(0.0, 1.0);
            if let Some(adj) = layer.adjustment() {
                // An adjustment layer's fill opacity is its opacity again
                // (it has no pixels for the fill to act on separately).
                let opacity = layer.opacity * fill;
                match adj.to_chain() {
                    Some(params) => steps.push(Step::Adjust {
                        params: Box::new(params),
                        opacity,
                        cov,
                    }),
                    None => steps.push(Step::Direct {
                        layer: layer.id,
                        ops: Arc::new(adj.direct_ops()),
                        opacity,
                        cov,
                    }),
                }
                continue;
            }
            // A LAYER STYLE: the layer's effects around its pixels
            // (`styles`, which documents the order).
            let style_plan = layer
                .ext
                .style
                .as_ref()
                .map(|s| (s, super::styles::StylePlan::of(s)))
                .filter(|(_, p)| !p.is_empty());
            if let Some((style, plan)) = style_plan {
                let canvas_px = canvas_of((*index, plate));
                let opts = layer.ext.style_options;
                let hides = opts.hides() && cov.own.is_some();
                let shape = CovKey {
                    own: if hides { None } else { cov.own.clone() },
                    clip: None,
                };
                let needs_bounds = plan
                    .exterior
                    .iter()
                    .chain(&plan.interior)
                    .chain(&plan.interior_top)
                    .chain(&plan.top)
                    .any(super::styles::Fx::needs_bounds);
                let bounds = if needs_bounds {
                    super::styles::alpha_bounds(&canvas_px.to_rgba8(), self.width, self.height)
                } else {
                    Region::new(0, 0, self.width, self.height)
                };
                let effect = |fx: super::styles::Fx, interior: bool| Step::Effect {
                    layer: layer.id,
                    px: canvas_px.clone(),
                    cov: shape.clone(),
                    interior,
                    fx: Arc::new(super::styles::EffectStep {
                        pattern: self.style_pattern(&fx),
                        fx,
                        scale: style.scale,
                        light: self.styles.global_light,
                        bounds,
                        seed: layer.id,
                        fill,
                        stroke_reach: super::styles::stroke_reach(style),
                    }),
                };
                let slot = STYLE_SLOT | layer.id;
                let wrap = layer.opacity < 1.0 || hides;
                if wrap {
                    steps.push(Step::Save { slot });
                }
                for fx in plan.exterior {
                    steps.push(effect(fx, false));
                }
                let mut tail: Vec<Step> =
                    plan.top.into_iter().map(|fx| effect(fx, false)).collect();
                if wrap {
                    tail.push(Step::StyleClose {
                        layer: layer.id,
                        slot,
                        opacity: layer.opacity,
                        cov: CovKey {
                            own: if hides { cov.own.clone() } else { None },
                            clip: None,
                        },
                    });
                }
                let next_clipped = self.layers.get(*index + 1).is_some_and(|n| n.clipped);
                let neutral = super::special_fill_neutral(layer.blend).filter(|_| fill < 1.0);
                let has_interior = !plan.interior.is_empty() || !plan.interior_top.is_empty();
                if !layer.clipped && (has_interior || next_clipped) {
                    // THE BODY: a clipping group of the layer made opaque,
                    // closed without its shape, then the interior effects,
                    // then the shape.
                    steps.push(Step::BodyOpen);
                    steps.push(Step::ClipOpen {
                        layer: layer.id,
                        px: canvas_px.clone(),
                        cov: CovKey::default(),
                    });
                    let interior: Vec<Step> = plan
                        .interior
                        .into_iter()
                        .map(|fx| effect(fx, false))
                        .collect();
                    let (before, mut after) = if opts.blend_interior {
                        (interior, Vec::new())
                    } else {
                        (Vec::new(), interior)
                    };
                    // Inner Shadow and the inner part of a stroke stay
                    // outside the group (Photoshop's Blend Interior Effects
                    // covers the overlays, satin and inner glow).
                    after.extend(plan.interior_top.into_iter().map(|fx| effect(fx, false)));
                    after.push(Step::BodyClose {
                        layer: layer.id,
                        px: canvas_px.clone(),
                        cov: shape.clone(),
                    });
                    after.extend(tail);
                    clip_group = Some(OpenClip {
                        blend: layer.blend,
                        opacity: fill,
                        shape: false,
                        before,
                        after,
                    });
                } else {
                    let blend_fill = if neutral.is_some() { 1.0 } else { fill };
                    let extra = PixelExtra {
                        blend_if: layer.live_blend_if().map(|b| b.kernel_params()),
                        fade: neutral.map(|n| BandFadeNeutralParams::new(n, fill)),
                        knockout: None,
                    };
                    steps.push(Step::Pixel {
                        layer: layer.id,
                        px: canvas_px.clone(),
                        rect: None,
                        blend: layer.blend,
                        gamma: layer
                            .blend_gamma
                            .filter(|_| std::ptr::eq(layer.blend, &COMPOSE_NORMAL)),
                        opacity: blend_fill,
                        cov: CovKey {
                            own: shape.own.clone(),
                            clip: cov.clip.clone(),
                        },
                        extra: (extra != PixelExtra::default()).then(|| Box::new(extra)),
                    });
                    for fx in plan.interior.into_iter().chain(plan.interior_top) {
                        steps.push(effect(fx, true));
                    }
                    steps.extend(tail);
                }
                if background && *index == 0 {
                    steps.push(Step::Save { slot: DEEP_SLOT });
                }
                continue;
            }
            // THE BLENDING OPTIONS. Fill opacity multiplies the opacity,
            // except on the eight special modes, where it fades the plate
            // toward the mode's neutral colour inside the blend instead.
            let neutral = super::special_fill_neutral(layer.blend).filter(|_| fill < 1.0);
            let knockout =
                (layer.ext.knockout != super::Knockout::None && !layer.clipped).then(|| {
                    KnockoutStep {
                        slot: self.knockout_slot(layer, background),
                        opacity: layer.opacity,
                    }
                });
            let blend_fill = if neutral.is_some() { 1.0 } else { fill };
            let opacity = match knockout {
                Some(_) => blend_fill,
                None => layer.opacity * blend_fill,
            };
            let extra = PixelExtra {
                blend_if: layer.live_blend_if().map(|b| b.kernel_params()),
                fade: neutral.map(|n| BandFadeNeutralParams::new(n, fill)),
                knockout,
            };
            let extra = (extra != PixelExtra::default()).then(|| Box::new(extra));
            let (px, rect) = match &extra {
                Some(_) => (canvas_of((*index, plate)), None),
                None => (plate.px.clone(), plate.rect),
            };
            steps.push(Step::Pixel {
                layer: layer.id,
                px,
                rect,
                blend: layer.blend,
                gamma: layer
                    .blend_gamma
                    .filter(|_| std::ptr::eq(layer.blend, &COMPOSE_NORMAL)),
                opacity,
                cov,
                extra,
            });
            if background && *index == 0 {
                steps.push(Step::Save { slot: DEEP_SLOT });
            }
        }
        let checkpoint = checkpoint.unwrap_or(steps.len());
        close_clip(&mut steps, &mut clip_group);
        while let Some(gid) = open.pop() {
            steps.push(self.close_step(gid));
        }
        (steps, checkpoint)
    }

    /// The backdrop a knockout layer shows through to (`KnockoutStep`).
    fn knockout_slot(&self, layer: &super::Layer, background: bool) -> Option<u32> {
        let deep = background.then_some(DEEP_SLOT);
        if layer.ext.knockout == super::Knockout::Deep {
            return deep;
        }
        // Shallow: the start of the innermost enclosing group.
        match layer.group {
            None => deep,
            Some(gid) => {
                let isolates = self
                    .groups
                    .iter()
                    .find(|g| g.id == gid)
                    .is_some_and(|g| g.isolates());
                if isolates {
                    None
                } else {
                    Some(gid)
                }
            }
        }
    }

    fn close_step(&self, gid: u32) -> Step {
        let g = self.groups.iter().find(|g| g.id == gid);
        Step::Close {
            group: gid,
            blend: g.map(|g| (g.blend, g.opacity)),
            cov: CovKey {
                own: g.and_then(|g| {
                    super::multiply_coverage(
                        g.live_mask().cloned().map(LayerMask::Canvas),
                        self.pass_through_mask(g.parent),
                    )
                }),
                clip: None,
            },
        }
    }

    /// Run `steps[from..]` from `state`, recording into `batch` and
    /// flushing it only where an adjustment layer needs the accumulator
    /// on the CPU. Returns the final state and, when the checkpoint index
    /// was passed on the way, the state there.
    #[allow(clippy::too_many_arguments)]
    async fn run_steps<'c>(
        &self,
        ctx: &'c GpuContext,
        cache: &mut FoldCache,
        batch: &mut GpuBatch<'c>,
        steps: &[Step],
        from: usize,
        mut st: FoldState,
        checkpoint: usize,
    ) -> Result<(FoldState, Option<FoldState>), IngestError> {
        let (w, h) = (self.width, self.height);
        let mut snap = None;
        let mut folded = 0u64;
        // Each styled layer's source alpha (and distance field), shared by
        // its effects within this composite.
        let mut sources: Vec<(u32, Pixels, super::styles::Source)> = Vec::new();
        for (i, step) in steps.iter().enumerate().skip(from) {
            if i == checkpoint {
                snap = Some(st.clone());
            }
            if step.is_layer() {
                folded += 1;
            }
            match step {
                Step::Open { .. } => {
                    let acc = st.acc.take();
                    st.parked.push(acc);
                }
                Step::Save { slot } => {
                    st.saved.retain(|(s, _)| s != slot);
                    st.saved.push((*slot, st.acc.clone()));
                }
                Step::Direct {
                    layer,
                    ops,
                    opacity,
                    cov,
                } => {
                    let acc = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    let mut cur = acc.clone();
                    for (def, params) in ops.iter() {
                        let out = batch.target(w, h);
                        batch
                            .dispatch(def, &[&cur], params, None, &out)
                            .map_err(gpu_err)?;
                        cur = out;
                    }
                    let mask = cache.mask(batch, *layer, cov, w, h);
                    st.acc = Some(match scaled_mask(ctx, batch, mask, *opacity, w, h)? {
                        None => cur,
                        Some(m) => take_through(batch, &acc, &cur, &m, w, h)?,
                    });
                }
                Step::Pixel {
                    layer,
                    px,
                    rect: None,
                    blend,
                    gamma,
                    opacity,
                    cov,
                    extra: Some(x),
                } => {
                    let plate = cache.plate(batch, *layer, px, w, h)?;
                    let mut mask = cache.mask(batch, *layer, cov, w, h);
                    let acc = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    // BLEND IF: the coverage from the layer's own and the
                    // backdrop's values, times the layer's mask.
                    if let Some(bi) = &x.blend_if {
                        let c = batch.target(w, h);
                        batch
                            .dispatch(&BAND_BLEND_IF, &[&acc, &plate], bi.as_bytes(), None, &c)
                            .map_err(gpu_err)?;
                        mask = Some(match mask {
                            None => c,
                            Some(m) => {
                                let both = batch.target(w, h);
                                batch
                                    .dispatch(
                                        &MATH_MUL,
                                        &[&c, &m],
                                        MathMulParams::new().as_bytes(),
                                        None,
                                        &both,
                                    )
                                    .map_err(gpu_err)?;
                                both
                            }
                        });
                    }
                    // FILL on a special mode: toward the neutral first.
                    let src = match &x.fade {
                        None => plate.clone(),
                        Some(f) => {
                            let out = batch.target(w, h);
                            batch
                                .dispatch(&BAND_FADE_NEUTRAL, &[&plate], f.as_bytes(), None, &out)
                                .map_err(gpu_err)?;
                            out
                        }
                    };
                    st.acc = Some(match &x.knockout {
                        None => {
                            let out = batch.target(w, h);
                            batch
                                .dispatch(
                                    pixel_kernel(blend, *gamma),
                                    &[&acc, &src],
                                    &pixel_params(*opacity, *gamma),
                                    mask.as_ref(),
                                    &out,
                                )
                                .map_err(gpu_err)?;
                            out
                        }
                        // KNOCKOUT: where the layer has pixels the backdrop
                        // replaces what is beneath; the layer blends onto
                        // that at its fill, and the result mixes in through
                        // its mask at its opacity.
                        Some(k) => {
                            let backdrop = k
                                .slot
                                .and_then(|s| st.saved.iter().find(|(id, _)| *id == s))
                                .and_then(|(_, r)| r.clone())
                                .unwrap_or_else(|| ctx.zeros(w, h));
                            let alpha = batch.target(w, h);
                            batch
                                .dispatch(
                                    &BAND_BROADCAST_ALPHA,
                                    &[&plate],
                                    BandBroadcastAlphaParams::new().as_bytes(),
                                    None,
                                    &alpha,
                                )
                                .map_err(gpu_err)?;
                            let hole = take_through(batch, &acc, &backdrop, &alpha, w, h)?;
                            let blended = batch.target(w, h);
                            batch
                                .dispatch(
                                    pixel_kernel(blend, *gamma),
                                    &[&hole, &src],
                                    &pixel_params(*opacity, *gamma),
                                    None,
                                    &blended,
                                )
                                .map_err(gpu_err)?;
                            match scaled_mask(ctx, batch, mask, k.opacity, w, h)? {
                                None => blended,
                                Some(m) => take_through(batch, &acc, &blended, &m, w, h)?,
                            }
                        }
                    });
                }
                Step::ClipOpen { layer, px, cov } => {
                    let plate = cache.plate(batch, *layer, px, w, h)?;
                    let mask = cache.mask(batch, *layer, cov, w, h);
                    let acc = st.acc.take();
                    st.parked.push(acc);
                    let (base, opaque) = clip_base(ctx, batch, &plate, mask.as_ref(), w, h)?;
                    st.clip.push(base);
                    st.acc = Some(opaque);
                }
                Step::ClipClose {
                    blend,
                    opacity,
                    shape,
                } => {
                    let base = st.clip.pop().expect("a clip group is open");
                    let inner = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    let outer = st.parked.pop().flatten();
                    let outer = outer.unwrap_or_else(|| ctx.zeros(w, h));
                    st.acc = Some(if *shape {
                        clip_close(batch, &base, &inner, &outer, blend, *opacity, w, h)?
                    } else {
                        let out = batch.target(w, h);
                        batch
                            .dispatch(
                                blend,
                                &[&outer, &inner],
                                ComposeParams::new(*opacity).as_bytes(),
                                None,
                                &out,
                            )
                            .map_err(gpu_err)?;
                        out
                    });
                }
                Step::Effect {
                    layer,
                    px,
                    cov,
                    interior,
                    fx,
                } => {
                    let plate = cache.plate(batch, *layer, px, w, h)?;
                    let mask = cache.mask(batch, *layer, cov, w, h);
                    let src = match sources
                        .iter_mut()
                        .position(|(id, p, _)| *id == *layer && p.same(px))
                    {
                        Some(i) => i,
                        None => {
                            let a = super::styles::source_alpha(
                                ctx,
                                batch,
                                &plate,
                                mask.as_ref(),
                                w,
                                h,
                            )?;
                            sources.push((*layer, px.clone(), super::styles::Source::new(a)));
                            sources.len() - 1
                        }
                    };
                    let acc = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    let drawn =
                        super::styles::draw(ctx, batch, &acc, &mut sources[src].2, fx, w, h)?;
                    st.acc = Some(if *interior {
                        let shape = sources[src].2.alpha.clone();
                        take_through(batch, &acc, &drawn, &shape, w, h)?
                    } else {
                        drawn
                    });
                }
                Step::BodyOpen => {
                    let keep = st.acc.clone();
                    st.parked.push(keep);
                }
                Step::BodyClose { layer, px, cov } => {
                    let plate = cache.plate(batch, *layer, px, w, h)?;
                    let mask = cache.mask(batch, *layer, cov, w, h);
                    let shape =
                        super::styles::source_alpha(ctx, batch, &plate, mask.as_ref(), w, h)?;
                    let body = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    let kept = st.parked.pop().flatten().unwrap_or_else(|| ctx.zeros(w, h));
                    st.acc = Some(take_through(batch, &kept, &body, &shape, w, h)?);
                }
                Step::StyleClose {
                    layer,
                    slot,
                    opacity,
                    cov,
                } => {
                    let backdrop = st
                        .saved
                        .iter()
                        .find(|(s, _)| s == slot)
                        .and_then(|(_, r)| r.clone())
                        .unwrap_or_else(|| ctx.zeros(w, h));
                    st.saved.retain(|(s, _)| s != slot);
                    let mask = cache.mask(batch, *layer | HIDE_MASK_BIT, cov, w, h);
                    let acc = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    st.acc = Some(match scaled_mask(ctx, batch, mask, *opacity, w, h)? {
                        None => acc,
                        Some(m) => take_through(batch, &backdrop, &acc, &m, w, h)?,
                    });
                }
                Step::Close { group, blend, cov } => {
                    let inner = st.acc.take();
                    let parked = st.parked.pop().flatten();
                    let mask = cache.mask(batch, *group, cov, w, h);
                    st.acc = match blend {
                        None => parked,
                        Some((def, opacity)) => {
                            let a = parked.unwrap_or_else(|| ctx.zeros(w, h));
                            let b = inner.unwrap_or_else(|| ctx.zeros(w, h));
                            let out = batch.target(w, h);
                            batch
                                .dispatch(
                                    def,
                                    &[&a, &b],
                                    ComposeParams::new(*opacity).as_bytes(),
                                    mask.as_ref(),
                                    &out,
                                )
                                .map_err(gpu_err)?;
                            Some(out)
                        }
                    };
                }
                Step::Pixel {
                    layer,
                    px,
                    rect: Some(rect),
                    blend,
                    gamma,
                    opacity,
                    cov,
                    extra: _,
                } => {
                    // A BOUNDED plate (ADR 464): blend it into a window of
                    // the accumulator and write the window back into a
                    // copy of it. The accumulator is never written in
                    // place — a checkpoint may hold the same texture.
                    let (rx, ry, rw, rh) = (rect.x as u32, rect.y as u32, rect.w, rect.h);
                    let plate = cache.plate(batch, *layer, px, rw, rh)?;
                    let mask = (!cov.is_none()).then(|| {
                        batch.upload(
                            rw,
                            rh,
                            TexFormat::R16Float,
                            &mask_window(cov, w, (rx, ry, rw, rh)),
                        )
                    });
                    let acc = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    let win = batch.target(rw, rh);
                    batch.copy(&acc, (rx, ry), &win, (0, 0), rw, rh);
                    let blended = batch.target(rw, rh);
                    batch
                        .dispatch(
                            pixel_kernel(blend, *gamma),
                            &[&win, &plate],
                            &pixel_params(*opacity, *gamma),
                            mask.as_ref(),
                            &blended,
                        )
                        .map_err(gpu_err)?;
                    let out = batch.target(w, h);
                    batch.copy(&acc, (0, 0), &out, (0, 0), w, h);
                    batch.copy(&blended, (0, 0), &out, (rx, ry), rw, rh);
                    st.acc = Some(out);
                }
                Step::Pixel {
                    layer,
                    px,
                    rect: None,
                    blend,
                    gamma,
                    opacity,
                    cov,
                    extra: None,
                } => {
                    let plate = cache.plate(batch, *layer, px, w, h)?;
                    let mask = cache.mask(batch, *layer, cov, w, h);
                    let acc = st.acc.take().unwrap_or_else(|| ctx.zeros(w, h));
                    let out = batch.target(w, h);
                    batch
                        .dispatch(
                            pixel_kernel(blend, *gamma),
                            &[&acc, &plate],
                            &pixel_params(*opacity, *gamma),
                            mask.as_ref(),
                            &out,
                        )
                        .map_err(gpu_err)?;
                    st.acc = Some(out);
                }
                Step::Adjust {
                    params,
                    opacity,
                    cov,
                } => {
                    // The adjust chain runs through the pipeline on CPU
                    // bytes, so the accumulator comes back here — exactly
                    // as it did before, and only for this step.
                    let ticket = st.acc.as_ref().map(|a| batch.read(a));
                    let done = std::mem::replace(batch, GpuBatch::new(ctx));
                    let mut reads = done.finish_async().await.map_err(gpu_err)?;
                    let acc = match ticket {
                        Some(t) => std::mem::take(&mut reads[t.0]),
                        None => vec![0u8; (w as usize) * (h as usize) * 8],
                    };
                    let straight = super::unpremultiply(ctx, &acc, w, h).await?;
                    let adjusted = crate::ingest::adjust_f16(
                        ctx,
                        w,
                        h,
                        &straight,
                        params,
                        super::with_opacity(cov.coverage(w, h), *opacity, w, h),
                    )
                    .await?;
                    let premul = super::premultiply(ctx, &adjusted, w, h).await?;
                    st.acc = Some(batch.upload(w, h, TexFormat::Rgba16Float, &premul));
                }
            }
        }
        if checkpoint == steps.len() && checkpoint >= from {
            snap = Some(st.clone());
        }
        crate::counters::bump(|c| c.layers_folded += folded);
        Ok((st, snap))
    }

    /// The resident composite (the caller has already handled the
    /// trivial stacks).
    pub(super) async fn composite_resident(
        &self,
        ctx: &GpuContext,
        plates: &[(usize, Plate)],
        depth: image_core::SampleDepth,
    ) -> Result<Pixels, IngestError> {
        let (w, h) = (self.width, self.height);
        let (steps, checkpoint) = self.plan_fold(plates);
        // Taken out for the awaits (no lock is held across a suspension
        // point) and put back after; a failed composite leaves it empty,
        // which only costs the next composite its uploads.
        let mut cache = std::mem::take(&mut *self.fold.lock().expect("fold cache lock"));
        cache.bind(ctx);

        // Nothing changed since the last composite: its result stands.
        if let Some((last_steps, out)) = &cache.last {
            if same_steps(last_steps, &steps) && out.depth() == depth {
                let out = out.clone();
                *self.fold.lock().expect("fold cache lock") = cache;
                return Ok(out);
            }
        }

        // One plate's pixels changed inside a rectangle (a brush sample):
        // fold just that rectangle and splice it into the last result.
        if let Some(out) = self.refold_dirty(ctx, &mut cache, &steps, depth).await? {
            *self.fold.lock().expect("fold cache lock") = cache;
            return Ok(out);
        }

        // Resume from the checkpoint when everything below it is unchanged.
        let (from, state) = match &cache.checkpoint {
            Some((prefix, state))
                if prefix.len() <= steps.len() && same_steps(prefix, &steps[..prefix.len()]) =>
            {
                (prefix.len(), state.clone())
            }
            _ => (0, FoldState::default()),
        };

        let mut batch = GpuBatch::new(ctx);
        let (st, snap) = self
            .run_steps(ctx, &mut cache, &mut batch, &steps, from, state, checkpoint)
            .await?;
        if let Some(snap) = snap {
            cache.checkpoint = Some((steps[..checkpoint].to_vec(), snap));
        }

        // Out of premultiplied space on the device, then the one readback.
        let acc = st.acc.unwrap_or_else(|| ctx.zeros(w, h));
        let out = batch.target(w, h);
        batch
            .dispatch(
                &CAST_UNPREMULTIPLY,
                &[&acc],
                CastUnpremultiplyParams::new().as_bytes(),
                None,
                &out,
            )
            .map_err(gpu_err)?;
        let ticket = batch.read(&out);
        let reads = batch.finish_async().await.map_err(gpu_err)?;
        // At the document's depth: a 16-bit document keeps what the
        // rgba16float accumulator computed instead of cutting it to bytes.
        let rgba = Pixels::from_f16(&reads[ticket.0], depth);

        cache.retain(&steps);
        cache.last = Some((steps, rgba.clone()));
        *self.fold.lock().expect("fold cache lock") = cache;
        Ok(rgba)
    }
}

/// A clipping group's start: the base alone (premultiplied, through its
/// own mask) and the same colour made opaque for the clipped layers to
/// blend onto. Shared with the reference fold, op for op.
pub(super) fn clip_base(
    ctx: &GpuContext,
    batch: &mut GpuBatch<'_>,
    plate: &Resident,
    mask: Option<&Resident>,
    w: u32,
    h: u32,
) -> Result<(Resident, Resident), IngestError> {
    let zeros = ctx.zeros(w, h);
    let base = batch.target(w, h);
    batch
        .dispatch(
            &COMPOSE_NORMAL,
            &[&zeros, plate],
            ComposeParams::new(1.0).as_bytes(),
            mask,
            &base,
        )
        .map_err(gpu_err)?;
    let straight = batch.target(w, h);
    batch
        .dispatch(
            &CAST_UNPREMULTIPLY,
            &[&base],
            CastUnpremultiplyParams::new().as_bytes(),
            None,
            &straight,
        )
        .map_err(gpu_err)?;
    let opaque = batch.target(w, h);
    batch
        .dispatch(
            &BAND_SET_ALPHA,
            &[&straight],
            BandSetAlphaParams::new(1.0).as_bytes(),
            None,
            &opaque,
        )
        .map_err(gpu_err)?;
    Ok((base, opaque))
}

/// A clipping group's end: the group (opaque) times the base's alpha,
/// blended onto `outer` with the base's blend mode and opacity.
#[allow(clippy::too_many_arguments)]
pub(super) fn clip_close(
    batch: &mut GpuBatch<'_>,
    base: &Resident,
    inner: &Resident,
    outer: &Resident,
    blend: &'static KernelDef,
    opacity: f32,
    w: u32,
    h: u32,
) -> Result<Resident, IngestError> {
    let alpha = batch.target(w, h);
    batch
        .dispatch(
            &BAND_BROADCAST_ALPHA,
            &[base],
            BandBroadcastAlphaParams::new().as_bytes(),
            None,
            &alpha,
        )
        .map_err(gpu_err)?;
    let group = batch.target(w, h);
    batch
        .dispatch(
            &MATH_MUL,
            &[inner, &alpha],
            MathMulParams::new().as_bytes(),
            None,
            &group,
        )
        .map_err(gpu_err)?;
    let out = batch.target(w, h);
    batch
        .dispatch(
            blend,
            &[outer, &group],
            ComposeParams::new(opacity).as_bytes(),
            None,
            &out,
        )
        .map_err(gpu_err)?;
    Ok(out)
}

/// `mix(a, b, m)` — `band.take` through the mask `m`.
fn take_through(
    batch: &mut GpuBatch<'_>,
    a: &Resident,
    b: &Resident,
    m: &Resident,
    w: u32,
    h: u32,
) -> Result<Resident, IngestError> {
    let out = batch.target(w, h);
    batch
        .dispatch(
            &BAND_TAKE,
            &[a, b],
            BandTakeParams::new().as_bytes(),
            Some(m),
            &out,
        )
        .map_err(gpu_err)?;
    Ok(out)
}

/// A coverage scaled by an opacity: `None` when the result is one
/// everywhere (no mask, full opacity).
fn scaled_mask(
    ctx: &GpuContext,
    batch: &mut GpuBatch<'_>,
    mask: Option<Resident>,
    opacity: f32,
    w: u32,
    h: u32,
) -> Result<Option<Resident>, IngestError> {
    if opacity >= 1.0 {
        return Ok(mask);
    }
    let base = mask.unwrap_or_else(|| ctx.one_mask(w, h));
    let out = batch.target(w, h);
    batch
        .dispatch(
            &MATH_MUL_CONST,
            &[&base],
            MathMulConstParams::new(opacity.max(0.0)).as_bytes(),
            None,
            &out,
        )
        .map_err(gpu_err)?;
    Ok(Some(out))
}

/// The (old, new) pixels of the one plate a brush sample changed.
type PlatePair = (Pixels, Pixels);

/// The bounding box of the pixels that differ between two canvases of
/// width `w` at `bpp` bytes per pixel, or `None` when they are identical.
fn diff_bbox(old: &[u8], new: &[u8], w: u32, bpp: usize) -> Option<(u32, u32, u32, u32)> {
    let row = w as usize * bpp;
    let rows_old = old.chunks_exact(row);
    let mut y0 = None;
    let mut y1 = 0;
    let (mut x0, mut x1) = (usize::MAX, 0usize);
    for (y, (a, b)) in rows_old.zip(new.chunks_exact(row)).enumerate() {
        if a == b {
            continue;
        }
        y0.get_or_insert(y);
        y1 = y;
        let first = a.iter().zip(b).position(|(p, q)| p != q).unwrap_or(0) / bpp;
        let last = row
            - 1
            - a.iter()
                .rev()
                .zip(b.iter().rev())
                .position(|(p, q)| p != q)
                .unwrap_or(0);
        x0 = x0.min(first);
        x1 = x1.max(last / bpp);
    }
    let y0 = y0?;
    Some((
        x0 as u32,
        y0 as u32,
        (x1 - x0 + 1) as u32,
        (y1 - y0 + 1) as u32,
    ))
}

/// A canvas plate's window → rgba16float bytes, at the plate's depth.
fn window_f16(px: &Pixels, w: u32, r: (u32, u32, u32, u32)) -> Vec<u8> {
    let (x, y, rw, rh) = r;
    let bpp = px.bytes_per_pixel();
    let raw = px.raw();
    let mut win = Vec::with_capacity(rw as usize * rh as usize * bpp);
    for row in y..y + rh {
        let start = (row as usize * w as usize + x as usize) * bpp;
        win.extend_from_slice(&raw[start..start + rw as usize * bpp]);
    }
    Pixels::from_raw(Arc::from(win.into_boxed_slice()), px.depth()).to_f16()
}

/// The kernel a pixel step blends with: its own, or Normal in a gamma
/// space for a text layer.
fn pixel_kernel(blend: &'static KernelDef, gamma: Option<f32>) -> &'static KernelDef {
    match gamma {
        Some(_) => &COMPOSE_NORMAL_GAMMA,
        None => blend,
    }
}

/// The parameter block for [`pixel_kernel`].
fn pixel_params(opacity: f32, gamma: Option<f32>) -> Vec<u8> {
    match gamma {
        Some(g) => ComposeGammaParams::new(opacity, g).as_bytes().to_vec(),
        None => ComposeParams::new(opacity).as_bytes().to_vec(),
    }
}

/// A BOUNDED plate's window `r` (canvas coordinates) as rgba16float:
/// the plate's pixels where it covers the window, transparent elsewhere.
fn window_f16_bounded(px: &Pixels, b: Region, r: (u32, u32, u32, u32)) -> Vec<u8> {
    let (x, y, rw, rh) = r;
    let bpp = px.bytes_per_pixel();
    let raw = px.raw();
    let mut win = vec![0u8; rw as usize * rh as usize * bpp];
    let (bx, by) = (b.x as i64, b.y as i64);
    for row in 0..rh as i64 {
        let cy = y as i64 + row - by;
        if cy < 0 || cy >= i64::from(b.h) {
            continue;
        }
        for col in 0..rw as i64 {
            let cx = x as i64 + col - bx;
            if cx < 0 || cx >= i64::from(b.w) {
                continue;
            }
            let s = (cy * i64::from(b.w) + cx) as usize * bpp;
            let d = (row * i64::from(rw) + col) as usize * bpp;
            win[d..d + bpp].copy_from_slice(&raw[s..s + bpp]);
        }
    }
    Pixels::from_raw(Arc::from(win.into_boxed_slice()), px.depth()).to_f16()
}

/// A step's r16float mask over the window — the same per-texel values
/// the full-canvas mask holds there.
fn mask_window(cov: &CovKey, w: u32, r: (u32, u32, u32, u32)) -> Vec<u8> {
    let (x0, y0, rw, rh) = r;
    SelectionMask::from_fn(rw, rh, |x, y| {
        let (cx, cy) = (x0 + x, y0 + y);
        let own = cov.own.as_ref().map(|c| u32::from(c.at(cx, cy)));
        let clip = cov
            .clip
            .as_ref()
            .map(|px| u32::from(px.alpha8(cy as usize * w as usize + cx as usize)));
        let v = match (own, clip) {
            (Some(a), Some(b)) => (a * b + 127) / 255,
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => 255,
        };
        v as f32 / 255.0
    })
    .into_bytes()
}

impl LayerStack {
    /// Fold ONLY the rectangle in which one plate changed, when that is
    /// all that changed since the last composite: the steps differ only
    /// in that plate (and in clip bases that are that plate), the fold
    /// from the checkpoint on is all point-wise blends, and the
    /// checkpoint lies below the change. Every compose/cast kernel is a
    /// per-texel function, so folding a window of every input yields the
    /// same texels the full fold would — and outside the rectangle every
    /// input is unchanged, so the last result stands there.
    async fn refold_dirty(
        &self,
        ctx: &GpuContext,
        cache: &mut FoldCache,
        steps: &[Step],
        depth: image_core::SampleDepth,
    ) -> Result<Option<Pixels>, IngestError> {
        let w = self.width;
        let pixels = (w as usize) * (self.height as usize);
        let Some((last_steps, _)) = &cache.last else {
            return Ok(None);
        };
        // A clipping group refolds whole (its base's alpha and its close
        // are not windowed here), and so do the blending options and the
        // direct adjustments.
        if steps.iter().any(|s| {
            matches!(s, Step::ClipOpen { .. } | Step::ClipClose { .. }) || s.needs_whole_refold()
        }) {
            return Ok(None);
        }
        let Some((prefix, state)) = &cache.checkpoint else {
            return Ok(None);
        };
        if last_steps.len() != steps.len()
            || prefix.len() > steps.len()
            || !same_steps(prefix, &steps[..prefix.len()])
        {
            return Ok(None);
        }
        // Exactly one (old, new) plate pair may differ, at or above the
        // checkpoint; every other difference must be that same pair.
        let mut pair: Option<PlatePair> = None;
        let mut note = |a: &Pixels, b: &Pixels| -> bool {
            if a.same(b) {
                return true;
            }
            match &pair {
                None => {
                    pair = Some((a.clone(), b.clone()));
                    true
                }
                Some((o, n)) => o.same(a) && n.same(b),
            }
        };
        for (old, new) in last_steps.iter().zip(steps) {
            if old.same(new) {
                continue;
            }
            let ok = match (old, new) {
                (
                    Step::Pixel {
                        layer: l1,
                        px: p1,
                        rect: None,
                        blend: b1,
                        gamma: g1,
                        opacity: o1,
                        cov: c1,
                        extra: None,
                    },
                    Step::Pixel {
                        layer: l2,
                        px: p2,
                        rect: None,
                        blend: b2,
                        gamma: g2,
                        opacity: o2,
                        cov: c2,
                        extra: None,
                    },
                ) => {
                    l1 == l2
                        && g1 == g2
                        && std::ptr::eq(*b1, *b2)
                        && o1.to_bits() == o2.to_bits()
                        && same_mask(&c1.own, &c2.own)
                        && note(p1, p2)
                        && match (&c1.clip, &c2.clip) {
                            (None, None) => true,
                            (Some(a), Some(b)) => note(a, b),
                            _ => false,
                        }
                }
                _ => false,
            };
            if !ok {
                return Ok(None);
            }
        }
        let Some((old_px, new_px)) = pair else {
            return Ok(None);
        };
        // The change must lie at or above the checkpoint, and nothing
        // from the checkpoint on may be an adjustment (not point-wise).
        let first_change = steps
            .iter()
            .position(|s| matches!(s, Step::Pixel { px, .. } if px.same(&new_px)))
            .unwrap_or(0);
        if first_change < prefix.len()
            || steps[prefix.len()..]
                .iter()
                .any(|s| matches!(s, Step::Adjust { .. }))
            || old_px.depth() != new_px.depth()
            || old_px.len() != pixels * old_px.bytes_per_pixel()
            || new_px.len() != pixels * new_px.bytes_per_pixel()
            || cache.last.as_ref().is_some_and(|(_, o)| o.depth() != depth)
        {
            return Ok(None);
        }
        let Some(r) = diff_bbox(old_px.raw(), new_px.raw(), w, new_px.bytes_per_pixel()) else {
            // Byte-identical pixels in a new allocation: same composite.
            let out = cache.last.as_ref().map(|(_, o)| o.clone());
            if let Some(out) = &out {
                cache.last = Some((steps.to_vec(), out.clone()));
            }
            return Ok(out);
        };
        let (rx, ry, rw, rh) = r;
        crate::counters::bump(|c| {
            c.layers_folded += steps[prefix.len()..]
                .iter()
                .filter(|s| s.is_layer())
                .count() as u64
        });

        let mut batch = GpuBatch::new(ctx);
        let window = |batch: &mut GpuBatch<'_>, t: &Option<Resident>| -> Option<Resident> {
            t.as_ref().map(|t| {
                let out = batch.target(rw, rh);
                batch.copy(t, (rx, ry), &out, (0, 0), rw, rh);
                out
            })
        };
        let mut acc = window(&mut batch, &state.acc);
        let mut parked: Vec<Option<Resident>> =
            state.parked.iter().map(|p| window(&mut batch, p)).collect();
        for step in &steps[prefix.len()..] {
            match step {
                Step::Open { .. } => parked.push(acc.take()),
                Step::Close { blend, cov, .. } => {
                    let inner = acc.take();
                    let outer = parked.pop().flatten();
                    let mask = (!cov.is_none()).then(|| {
                        batch.upload(rw, rh, TexFormat::R16Float, &mask_window(cov, w, r))
                    });
                    acc = match blend {
                        None => outer,
                        Some((def, opacity)) => {
                            let a = outer.unwrap_or_else(|| ctx.zeros(rw, rh));
                            let b = inner.unwrap_or_else(|| ctx.zeros(rw, rh));
                            let out = batch.target(rw, rh);
                            batch
                                .dispatch(
                                    def,
                                    &[&a, &b],
                                    ComposeParams::new(*opacity).as_bytes(),
                                    mask.as_ref(),
                                    &out,
                                )
                                .map_err(gpu_err)?;
                            Some(out)
                        }
                    };
                }
                Step::Pixel {
                    layer,
                    px,
                    rect,
                    blend,
                    gamma,
                    opacity,
                    cov,
                    extra: _,
                } => {
                    // The plate's window: copied from the cached plate,
                    // or uploaded and premultiplied (premultiplying an
                    // opaque texel is exactly the identity, so this does
                    // not depend on the whole plate's opacity). A
                    // bounded plate's cached texture is its own size, so
                    // its window is always cut from its bytes.
                    let cached = cache
                        .plates
                        .get(layer)
                        .filter(|(p, _)| rect.is_none() && p.same(px))
                        .map(|(_, t)| t.clone());
                    let plate = match cached {
                        Some(t) => {
                            let out = batch.target(rw, rh);
                            batch.copy(&t, (rx, ry), &out, (0, 0), rw, rh);
                            out
                        }
                        None => {
                            let bytes = match rect {
                                Some(b) => window_f16_bounded(px, *b, r),
                                None => window_f16(px, w, r),
                            };
                            let src = batch.upload(rw, rh, TexFormat::Rgba16Float, &bytes);
                            let out = batch.target(rw, rh);
                            batch
                                .dispatch(
                                    &CAST_PREMULTIPLY,
                                    &[&src],
                                    CastPremultiplyParams::new().as_bytes(),
                                    None,
                                    &out,
                                )
                                .map_err(gpu_err)?;
                            out
                        }
                    };
                    let mask = (!cov.is_none()).then(|| {
                        batch.upload(rw, rh, TexFormat::R16Float, &mask_window(cov, w, r))
                    });
                    let a = acc.take().unwrap_or_else(|| ctx.zeros(rw, rh));
                    let out = batch.target(rw, rh);
                    batch
                        .dispatch(
                            pixel_kernel(blend, *gamma),
                            &[&a, &plate],
                            &pixel_params(*opacity, *gamma),
                            mask.as_ref(),
                            &out,
                        )
                        .map_err(gpu_err)?;
                    acc = Some(out);
                }
                Step::Adjust { .. }
                | Step::ClipOpen { .. }
                | Step::ClipClose { .. }
                | Step::Direct { .. }
                | Step::Save { .. }
                | Step::Effect { .. }
                | Step::BodyOpen
                | Step::BodyClose { .. }
                | Step::StyleClose { .. } => {
                    unreachable!("excluded above")
                }
            }
        }
        let a = acc.unwrap_or_else(|| ctx.zeros(rw, rh));
        let out = batch.target(rw, rh);
        batch
            .dispatch(
                &CAST_UNPREMULTIPLY,
                &[&a],
                CastUnpremultiplyParams::new().as_bytes(),
                None,
                &out,
            )
            .map_err(gpu_err)?;
        let ticket = batch.read(&out);
        let reads = batch.finish_async().await.map_err(gpu_err)?;
        let win = Pixels::from_f16(&reads[ticket.0], depth);

        // Splice into the last result — in place when nobody else holds
        // it, else once into a copy.
        let (_, mut last) = cache.last.take().expect("checked above");
        {
            let bpp = last.bytes_per_pixel();
            let dst = last.make_mut();
            let src = win.raw();
            let row = rw as usize * bpp;
            for y in 0..rh as usize {
                let d = ((ry as usize + y) * w as usize + rx as usize) * bpp;
                dst[d..d + row].copy_from_slice(&src[y * row..(y + 1) * row]);
            }
        }
        cache.last = Some((steps.to_vec(), last.clone()));
        Ok(Some(last))
    }
}
