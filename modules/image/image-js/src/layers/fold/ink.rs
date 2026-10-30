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

/// A layer's Color or Luminosity in a Lab document: L* from one side,
/// a* and b* from the other — two separable steps (image ADR 484).
fn lab_split(def: &image_kernels::KernelDef) -> bool {
    matches!(def.id, "compose.color" | "compose.luminosity")
}

/// Why the plan cannot fold in the document's planes, or `None` when it
/// can.
fn declines(steps: &[Step], space: PlaneSpace) -> Option<&'static str> {
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
                } else if !separable(blend) && !(space == PlaneSpace::Lab && lab_split(blend)) {
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

/// Photoshop's chroma rule for a Lab document's a* and b* (image ADR
/// 483, measured on `color-modes/lab-*`): Multiply and Screen blend them
/// as Overlay does; Linear Burn and Linear Dodge add the two offsets from
/// the middle (Linear Light over a source halved about the middle — `true`
/// asks for that source); every other mode as it is.
fn lab_chroma_blend(
    def: &'static image_kernels::KernelDef,
) -> (&'static image_kernels::KernelDef, bool) {
    let k = |n: &str| crate::stroke::blend_kernel(n).expect("a compose kernel");
    match def.id {
        // Color takes the source's chroma (Luminosity keeps the
        // backdrop's: `for_lab`'s zero opacity).
        "compose.color" | "compose.luminosity" => (k("normal"), false),
        "compose.multiply" | "compose.screen" => (k("overlay"), false),
        "compose.linear_burn" | "compose.linear_dodge" => (k("linear_light"), true),
        _ => (def, false),
    }
}

impl Step {
    /// The step as it folds a Lab document's chroma plane: its blend by
    /// [`lab_chroma_blend`], its pixels `plane` (halved for the additive
    /// modes) when it has pixels.
    fn for_lab_chroma(&self, plane: Option<Pixels>) -> Step {
        let mut s = self.clone();
        match &mut s {
            Step::Pixel {
                px, blend, opacity, ..
            } => {
                if blend.id == "compose.luminosity" {
                    *opacity = 0.0;
                }
                let (b, halve) = lab_chroma_blend(blend);
                *blend = b;
                if let Some(plane) = plane {
                    *px = if halve {
                        crate::planes::halved_about_middle(&plane)
                    } else {
                        plane
                    };
                }
            }
            Step::ClipOpen { px, .. } => {
                if let Some(plane) = plane {
                    *px = plane;
                }
            }
            Step::ClipClose { blend, .. } => *blend = lab_chroma_blend(blend).0,
            Step::Close {
                blend: Some((def, _)),
                ..
            } => *def = lab_chroma_blend(def).0,
            _ => {}
        }
        s
    }

    /// The step as it folds a Lab document's L* plane: Luminosity takes
    /// the source's L* (Normal), Color keeps the backdrop's (nothing).
    fn for_lab_lightness(&self, plane: Pixels) -> Step {
        let mut s = self.with_px(plane);
        if let Step::Pixel { blend, opacity, .. } = &mut s {
            if lab_split(blend) {
                if blend.id == "compose.color" {
                    *opacity = 0.0;
                }
                *blend = crate::stroke::blend_kernel("normal").expect("normal");
            }
        }
        s
    }

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

/// The derived planes kept between composites: (the pixels, their
/// planes), by identity.
pub(super) type InkCache = Vec<(Pixels, Vec<Pixels>)>;

/// The space a document folds in when it is not RGB (image ADRs 481,
/// 483): a CMYK document's inks (two planes), a Grayscale document's
/// stored grey or a Lab document's stored L*a*b* (one plane each).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::layers) enum PlaneSpace {
    Ink,
    Gray,
    Lab,
}

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

    /// The space this document folds in, with its transform: CMYK with a
    /// profile in its inks; Grayscale and Lab at 8 or 16 bits in their
    /// stored numbers, as Photoshop blends them (a 32-bit grey document
    /// is linear grey in RGB already). `None`: RGB.
    pub(in crate::layers) fn plane_transform(
        &self,
    ) -> Result<Option<(PlaneSpace, ModeTransform)>, IngestError> {
        let space = match self.mode.mode {
            ColorMode::Cmyk if self.mode.cmyk_profile.is_some() => PlaneSpace::Ink,
            ColorMode::Gray if self.depth() != image_core::SampleDepth::F32 => PlaneSpace::Gray,
            ColorMode::Lab => PlaneSpace::Lab,
            _ => return Ok(None),
        };
        Ok(ModeTransform::new(&self.mode)?.map(|t| (space, t)))
    }

    /// Why this CMYK, Grayscale or Lab document composites in RGB rather
    /// than in its own numbers (`None`: it composites in them, or it is an
    /// RGB document or a CMYK one without a profile).
    pub fn ink_fold_declines(&self) -> Option<&'static str> {
        let Ok(Some((space, _))) = self.plane_transform() else {
            return None;
        };
        let (steps, _) = self.plan_fold(&self.plates_indexed(None));
        declines(&steps, space)
    }

    /// The composite of a CMYK document folded in its inks, or `None`
    /// when the document is not one or its plan is not separable.
    pub(in crate::layers) async fn composite_inks(
        &self,
        ctx: Option<&GpuContext>,
        plates: &[(usize, Plate)],
        depth: image_core::SampleDepth,
    ) -> Result<Option<Pixels>, IngestError> {
        let Some((space, t)) = self.plane_transform()? else {
            return Ok(None);
        };
        let sixteen = depth != image_core::SampleDepth::U8;
        let (steps, _) = self.plan_fold(plates);
        if declines(&steps, space).is_some() {
            return Ok(None);
        }
        // The planes of every plate: a layer's own inks, the cached
        // derivation, or a new one.
        let mut derived: InkCache =
            std::mem::take(&mut self.fold.lock().expect("fold cache lock").inks);
        let mut used: InkCache = Vec::new();
        let mut plane_of = |px: &Pixels| -> Vec<Pixels> {
            for l in &self.layers {
                if let Some(inks) = &l.ext.inks.0 {
                    if let Some(p) = inks.planes_for(&l.rgba, px) {
                        return p.to_vec();
                    }
                }
            }
            if let Some((_, p)) = used.iter().find(|(k, _)| k.same(px)) {
                return p.clone();
            }
            let p = match derived.iter().position(|(k, _)| k.same(px)) {
                Some(i) => derived.swap_remove(i).1,
                None => match space {
                    PlaneSpace::Ink => crate::planes::ink_planes_of(&t, px).to_vec(),
                    PlaneSpace::Gray => vec![crate::planes::gray_plane_of(&t, px)],
                    PlaneSpace::Lab => crate::planes::lab_planes_of(&t, px, sixteen).to_vec(),
                },
            };
            used.push((px.clone(), p.clone()));
            p
        };
        let count = if space == PlaneSpace::Gray { 1 } else { 2 };
        let mut planes: Vec<Vec<Step>> = vec![Vec::new(); count];
        for s in &steps {
            match s {
                Step::Pixel { px, .. } | Step::ClipOpen { px, .. } => {
                    for (k, p) in plane_of(px).into_iter().enumerate().take(count) {
                        planes[k].push(if space == PlaneSpace::Lab && k == 1 {
                            s.for_lab_chroma(Some(p))
                        } else if space == PlaneSpace::Lab {
                            s.for_lab_lightness(p)
                        } else {
                            s.with_px(p)
                        });
                    }
                }
                _ => {
                    for (k, plane) in planes.iter_mut().enumerate() {
                        plane.push(if space == PlaneSpace::Lab && k == 1 {
                            s.for_lab_chroma(None)
                        } else {
                            s.clone()
                        });
                    }
                }
            }
        }
        // What this composite did not use goes; what it derived stays.
        self.fold.lock().expect("fold cache lock").inks = used;
        let side = self.width.max(self.height);
        let side = match ctx {
            Some(c) if self.fold_tile_side(c).is_none() => side,
            Some(_) => super::TILE_SIDE,
            None => super::CPU_TILE_SIDE,
        };
        let deep = image_core::SampleDepth::U16;
        let mut folded = Vec::with_capacity(count);
        for p in planes {
            folded.push(self.fold_steps_tiled(ctx, p, deep, side, false).await?);
        }
        Ok(Some(match space {
            PlaneSpace::Ink => crate::planes::rgb_of_ink_planes(&t, &folded[0], &folded[1], depth),
            PlaneSpace::Gray => crate::planes::rgb_of_gray_plane(&t, &folded[0], depth),
            PlaneSpace::Lab => {
                crate::planes::rgb_of_lab_planes(&t, &folded[0], &folded[1], sixteen, depth)
            }
        }))
    }
}
