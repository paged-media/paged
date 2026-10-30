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

//! THE INK FOLD (image ADR 481): a CMYK document composites in its inks.
//!
//! Photoshop blends a CMYK document's layers channel by channel on the ink
//! numbers it stores (`1 − ink`): Multiply adds ink, Screen removes it,
//! and the result is converted to the screen afterwards. Blending the
//! layers' RGB conversions instead lands tens of levels off on anything
//! that mixes (`psd_cmyk_photoshop.rs` measured 83 levels for Multiply).
//!
//! Here the plan the RGB fold runs is folded TWICE, once over each ink
//! plane ([`crate::planes`]): the plates are swapped for `(C', M', Y', α)`
//! and for `(K', K', K', α)` — a layer's own inks from its CMYK file when
//! it still holds them, else its pixels through the document's profile —
//! and everything else (masks, opacities, groups, clipping, knockout, the
//! fill opacity of the special modes) is the same plan. A separable step
//! is exact per channel whichever plane its channel sits in, so the two
//! folds are the one ink fold Photoshop makes; the folded inks go to the
//! screen through the profile.
//!
//! What is not separable is not folded in inks: the four non-separable
//! modes (and Darker/Lighter Color), Blend If (it reads grey and RGB),
//! an adjustment layer (the chain is RGB), a layer style and the direct
//! adjustments. A plan with one of them composites in RGB, as before,
//! and [`LayerStack::ink_fold_declines`] says why.

use image_kernels::compose_twin::Blend;

use super::super::{LayerStack, Plate};
use super::Step;
use crate::color_mode::{ColorMode, ModeTransform};
use crate::ingest::IngestError;
use crate::pixels::Pixels;
use image_gpu::GpuContext;

/// Is a blend applied channel by channel?
fn separable(def: &image_kernels::KernelDef) -> bool {
    Blend::from_kernel_id(def.id).is_some_and(|b| !b.is_non_separable())
}

/// Why the plan cannot fold in inks, or `None` when it can.
fn declines(steps: &[Step]) -> Option<&'static str> {
    for s in steps {
        let why = match s {
            Step::Pixel {
                blend,
                gamma,
                extra,
                ..
            } => {
                if gamma.is_some() {
                    Some("a text layer's gamma blend")
                } else if !separable(blend) {
                    Some("a non-separable blend mode")
                } else if extra.as_ref().is_some_and(|x| x.blend_if.is_some()) {
                    Some("Blend If")
                } else {
                    None
                }
            }
            Step::ClipClose { blend, .. } if !separable(blend) => {
                Some("a non-separable blend mode")
            }
            Step::Close {
                blend: Some((def, _)),
                ..
            } if !separable(def) => Some("a non-separable blend mode"),
            Step::Adjust { .. } | Step::Direct { .. } => Some("an adjustment layer"),
            Step::Effect { .. }
            | Step::BodyOpen
            | Step::BodyClose { .. }
            | Step::StyleClose { .. } => Some("a layer style"),
            _ => None,
        };
        if why.is_some() {
            return why;
        }
    }
    None
}

impl Step {
    /// The same step over other plate pixels (an ink plane of them). A
    /// clip base's pixels in a coverage stay: only their alpha is read,
    /// and every plane has the plate's alpha.
    fn with_px(&self, plane: Pixels) -> Step {
        let mut s = self.clone();
        if let Step::Pixel { px, .. } | Step::ClipOpen { px, .. } = &mut s {
            *px = plane;
        }
        s
    }
}

/// The derived ink planes kept between composites: (the pixels, their
/// planes), by identity.
pub(super) type InkCache = Vec<(Pixels, [Pixels; 2])>;

impl LayerStack {
    /// The CMYK document's transform (its profile), when it has one.
    /// Compiled per call (a few milliseconds): the transform is not
    /// `Send`, and the stack keeps nothing that is not.
    pub(in crate::layers) fn ink_transform(&self) -> Result<Option<ModeTransform>, IngestError> {
        if self.mode.mode != ColorMode::Cmyk || self.mode.cmyk_profile.is_none() {
            return Ok(None);
        }
        ModeTransform::new(&self.mode)
    }

    /// Why this CMYK document composites in RGB rather than in its inks
    /// (`None`: it composites in its inks, or it is not a CMYK document
    /// with a profile).
    pub fn ink_fold_declines(&self) -> Option<&'static str> {
        if self.mode.mode != ColorMode::Cmyk || self.mode.cmyk_profile.is_none() {
            return None;
        }
        let (steps, _) = self.plan_fold(&self.plates_indexed(None));
        declines(&steps)
    }

    /// The composite of a CMYK document folded in its inks, or `None`
    /// when the document is not one or its plan is not separable.
    pub(in crate::layers) async fn composite_inks(
        &self,
        ctx: Option<&GpuContext>,
        plates: &[(usize, Plate)],
        depth: image_core::SampleDepth,
    ) -> Result<Option<Pixels>, IngestError> {
        let Some(t) = self.ink_transform()? else {
            return Ok(None);
        };
        let (steps, _) = self.plan_fold(plates);
        if declines(&steps).is_some() {
            return Ok(None);
        }
        // The planes of every plate: a layer's own inks, the cached
        // derivation, or a new one.
        let mut derived: InkCache =
            std::mem::take(&mut self.fold.lock().expect("fold cache lock").inks);
        let mut used: InkCache = Vec::new();
        let mut plane_of = |px: &Pixels| -> [Pixels; 2] {
            for l in &self.layers {
                if let Some(inks) = &l.ext.inks.0 {
                    if let Some(p) = inks.planes_for(&l.rgba, px) {
                        return p;
                    }
                }
            }
            if let Some((_, p)) = used.iter().find(|(k, _)| k.same(px)) {
                return p.clone();
            }
            let p = match derived.iter().position(|(k, _)| k.same(px)) {
                Some(i) => derived.swap_remove(i).1,
                None => crate::planes::ink_planes_of(&t, px),
            };
            used.push((px.clone(), p.clone()));
            p
        };
        let mut planes: [Vec<Step>; 2] = [Vec::new(), Vec::new()];
        for s in &steps {
            match s {
                Step::Pixel { px, .. } | Step::ClipOpen { px, .. } => {
                    let [c, k] = plane_of(px);
                    planes[0].push(s.with_px(c));
                    planes[1].push(s.with_px(k));
                }
                _ => {
                    planes[0].push(s.clone());
                    planes[1].push(s.clone());
                }
            }
        }
        // What this composite did not use goes; what it derived stays.
        self.fold.lock().expect("fold cache lock").inks = used;
        let [p0, p1] = planes;
        let side = self.width.max(self.height);
        let side = match ctx {
            Some(c) if self.fold_tile_side(c).is_none() => side,
            Some(_) => super::TILE_SIDE,
            None => super::CPU_TILE_SIDE,
        };
        let deep = image_core::SampleDepth::U16;
        let c = self.fold_steps_tiled(ctx, p0, deep, side, false).await?;
        let k = self.fold_steps_tiled(ctx, p1, deep, side, false).await?;
        Ok(Some(crate::planes::rgb_of_ink_planes(&t, &c, &k, depth)))
    }
}
