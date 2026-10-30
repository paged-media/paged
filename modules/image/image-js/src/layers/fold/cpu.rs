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

//! THE CPU FOLD (image ADR 480): the layer fold where no GPU device
//! exists — the Node CLI, a headless template render.
//!
//! It runs the SAME plan the device runs (`plan_fold`), window by window
//! through the tiled fold (so its memory is a tile's, not the canvas's),
//! and executes each step with the kernels' shipped scalar twins:
//! `compose_twin` for the blend modes (the very functions the compose
//! parity tests and the PSD flatten oracle use), the `kernel_family!`
//! twins of `cast.*`, `band.*` and `math.*`, and the adjustment chain's
//! twins (ADR 465). Every intermediate is stored as f16, as the device's
//! rgba16float textures store it, and every mask is read as the r16float
//! texel the device reads, so the CPU fold agrees with the GPU fold to
//! within the kernels' tolerances (`image-conformance`'s
//! `prop_cpu_fold.rs`).
//!
//! It covers pixel layers (every blend mode, opacity, fill opacity, Blend
//! If, knockout, the text layers' gamma), bounded layers, masks, isolated
//! and pass-through groups, clipping groups and adjustment layers built
//! from the chain. A LAYER STYLE and the direct adjustments (Gradient
//! Map, Selective Color, Color Lookup) are refused by name: their kernels
//! have no shipped twin.

use half::f16;
use image_kernels::compose_twin::{composite, composite_normal_gamma, Blend};
use image_kernels::families::band::{
    band_blend_if, band_broadcast_alpha, band_fade_neutral, band_set_alpha,
    BandBroadcastAlphaParams, BandSetAlphaParams,
};
use image_kernels::families::cast::{
    cast_premultiply, cast_unpremultiply, CastPremultiplyParams, CastUnpremultiplyParams,
};
use image_kernels::reference_prelude::Px;
use image_kernels::KernelDef;

use super::{CovKey, Frame, Step};
use crate::ingest::IngestError;
use crate::pixels::Pixels;
use image_core::Region;

/// The CPU fold's tile: small enough that a window's handful of f32
/// planes stays in cache-friendly memory, large enough that the halo is
/// a small share.
pub(in crate::layers) const CPU_TILE_SIDE: u32 = 512;

/// A texture: premultiplied (or straight, as the step says) RGBA, every
/// value one an rgba16float texel can hold.
type Tex = Vec<Px>;

/// A mask: the `.r` of an r16float texel.
type Mask = Vec<f32>;

fn q(v: f32) -> f32 {
    f16::from_f32(v).to_f32()
}

fn q4(p: Px) -> Px {
    Px(p.0.map(q))
}

/// The ABI's mask epilogue: `mix(a, result, m)`, then the f16 store.
fn mixed(a: Px, r: Px, m: f32) -> Px {
    q4(Px(std::array::from_fn(|c| a.0[c] * (1.0 - m) + r.0[c] * m)))
}

impl crate::layers::LayerStack {
    /// Can the composite run without a GPU — the trivial stack, or one
    /// the CPU fold covers (no style, no direct adjustment, no fill layer
    /// waiting for its render)? The doors that must not change a document
    /// whose composite they could not then compute ask this.
    pub fn composite_runs_without_gpu(&self) -> bool {
        if self.composite_is_trivial() {
            return true;
        }
        if self
            .layers
            .iter()
            .any(|l| l.enabled() && l.fill().is_some_and(|f| f.stale))
        {
            return false;
        }
        let (steps, _) = self.plan_fold(&self.plates_indexed(None));
        supported(&steps).is_ok()
    }
}

/// Can the CPU fold run this plan? Names what it cannot.
pub(super) fn supported(steps: &[Step]) -> Result<(), IngestError> {
    for s in steps {
        let why = match s {
            Step::Effect { .. }
            | Step::BodyOpen
            | Step::BodyClose { .. }
            | Step::StyleClose { .. } => "a layer style",
            Step::Direct { .. } => "a Gradient Map, Selective Color or Color Lookup layer",
            Step::Pixel {
                blend, gamma: None, ..
            }
            | Step::ClipClose { blend, .. }
                if Blend::from_kernel_id(blend.id).is_none() =>
            {
                "a blend mode without a CPU twin"
            }
            Step::Close {
                blend: Some((def, _)),
                ..
            } if Blend::from_kernel_id(def.id).is_none() => "a blend mode without a CPU twin",
            _ => continue,
        };
        return Err(IngestError::Unsupported(format!(
            "compositing {why} needs a GPU — call init_gpu first (the CPU fold covers pixel, \
             adjustment, group and clipping layers)"
        )));
    }
    Ok(())
}

fn f16_tex(bytes: &[u8]) -> Tex {
    bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|t| {
            Px(std::array::from_fn(|c| {
                f16::from_le_bytes([t[c * 2], t[c * 2 + 1]]).to_f32()
            }))
        })
        .collect()
}

fn tex_f16(t: &Tex) -> Vec<u8> {
    let mut out = Vec::with_capacity(t.len() * 8);
    for p in t {
        for c in 0..4 {
            out.extend_from_slice(&f16::from_f32(p.0[c]).to_le_bytes());
        }
    }
    out
}

fn zeros(n: usize) -> Tex {
    vec![Px([0.0; 4]); n]
}

/// A plate: the pixels' straight f16 texels, premultiplied.
fn plate(px: &Pixels, n: usize) -> Result<Tex, IngestError> {
    if px.pixel_count() < n {
        return Err(IngestError::Decode(format!(
            "layer plate is {} pixels for {n}",
            px.pixel_count()
        )));
    }
    let p = CastPremultiplyParams::new();
    Ok(f16_tex(&px.to_f16())
        .into_iter()
        .take(n)
        .map(|c| q4(cast_premultiply(c, Px([0.0; 4]), &p)))
        .collect())
}

fn mask_of(cov: &CovKey, w: u32, h: u32) -> Option<Mask> {
    cov.mask_bytes(w, h).map(|b| {
        b.as_chunks::<2>()
            .0
            .iter()
            .map(|t| f16::from_le_bytes(*t).to_f32())
            .collect()
    })
}

/// `compose.<mode>` (or `compose.normal_gamma`) of `b` over `a`.
fn compose(
    def: &KernelDef,
    gamma: Option<f32>,
    a: &Tex,
    b: &Tex,
    opacity: f32,
    mask: Option<&Mask>,
) -> Tex {
    let blend = Blend::from_kernel_id(def.id).unwrap_or(Blend::Normal);
    a.iter()
        .zip(b)
        .enumerate()
        .map(|(i, (&a, &b))| {
            let r = match gamma {
                Some(g) => composite_normal_gamma(a, b, opacity, g),
                None => composite(a, b, opacity, blend),
            };
            mixed(a, r, mask.map_or(1.0, |m| m[i]))
        })
        .collect()
}

/// `band.take` through `m`: `mix(a, b, m)`.
fn take(a: &Tex, b: &Tex, m: &Mask) -> Tex {
    a.iter()
        .zip(b)
        .zip(m)
        .map(|((&a, &b), &m)| mixed(a, b, m))
        .collect()
}

fn alpha_mask(t: &Tex) -> Mask {
    let p = BandBroadcastAlphaParams::new();
    t.iter()
        .map(|&c| q(band_broadcast_alpha(c, Px([0.0; 4]), &p).0[0]))
        .collect()
}

fn unpremultiply(t: &Tex) -> Tex {
    let p = CastUnpremultiplyParams::new();
    t.iter()
        .map(|&c| q4(cast_unpremultiply(c, Px([0.0; 4]), &p)))
        .collect()
}

fn premultiply(t: &Tex) -> Tex {
    let p = CastPremultiplyParams::new();
    t.iter()
        .map(|&c| q4(cast_premultiply(c, Px([0.0; 4]), &p)))
        .collect()
}

/// `math.mul_const` of a mask by an opacity (`None`: one everywhere).
fn scaled(mask: Option<Mask>, opacity: f32, n: usize) -> Option<Mask> {
    if opacity >= 1.0 {
        return mask;
    }
    let o = opacity.max(0.0);
    Some(match mask {
        Some(m) => m.into_iter().map(|v| q(v * o)).collect(),
        None => vec![q(o); n],
    })
}

#[derive(Default)]
struct State {
    acc: Option<Tex>,
    parked: Vec<Option<Tex>>,
    clip: Vec<Tex>,
    saved: Vec<(u32, Option<Tex>)>,
}

/// Fold `steps` over one window (`frame`) on the CPU and hand back its
/// `inner` rectangle, straight, at `depth`.
pub(super) fn fold_window(
    steps: &[Step],
    frame: Frame,
    inner: Region,
    depth: image_core::SampleDepth,
) -> Result<Pixels, IngestError> {
    let (w, h) = (frame.w, frame.h);
    let n = w as usize * h as usize;
    let mut st = State::default();
    for step in steps {
        match step {
            Step::Open { .. } => {
                let acc = st.acc.take();
                st.parked.push(acc);
            }
            Step::Save { slot } => {
                st.saved.retain(|(s, _)| s != slot);
                st.saved.push((*slot, st.acc.clone()));
            }
            Step::Pixel {
                px,
                rect: None,
                blend,
                gamma,
                opacity,
                cov,
                extra,
                ..
            } => {
                let plate = plate(px, n)?;
                let mut mask = mask_of(cov, w, h);
                let acc = st.acc.take().unwrap_or_else(|| zeros(n));
                let Some(x) = extra else {
                    st.acc = Some(compose(
                        blend,
                        *gamma,
                        &acc,
                        &plate,
                        *opacity,
                        mask.as_ref(),
                    ));
                    continue;
                };
                if let Some(bi) = &x.blend_if {
                    let c: Mask = acc
                        .iter()
                        .zip(&plate)
                        .map(|(&a, &b)| q(band_blend_if(a, b, bi).0[0]))
                        .collect();
                    mask = Some(match mask {
                        None => c,
                        Some(m) => c.iter().zip(&m).map(|(a, b)| q(a * b)).collect(),
                    });
                }
                let src = match &x.fade {
                    None => plate.clone(),
                    Some(f) => plate
                        .iter()
                        .map(|&c| q4(band_fade_neutral(c, Px([0.0; 4]), f)))
                        .collect(),
                };
                st.acc = Some(match &x.knockout {
                    None => compose(blend, *gamma, &acc, &src, *opacity, mask.as_ref()),
                    Some(k) => {
                        let backdrop = k
                            .slot
                            .and_then(|s| st.saved.iter().find(|(id, _)| *id == s))
                            .and_then(|(_, r)| r.clone())
                            .unwrap_or_else(|| zeros(n));
                        let hole = take(&acc, &backdrop, &alpha_mask(&plate));
                        let blended = compose(blend, *gamma, &hole, &src, *opacity, None);
                        match scaled(mask, k.opacity, n) {
                            None => blended,
                            Some(m) => take(&acc, &blended, &m),
                        }
                    }
                });
            }
            Step::Pixel {
                px,
                rect: Some(rect),
                blend,
                gamma,
                opacity,
                cov,
                ..
            } => {
                let (rx, ry, rw, rh) = (rect.x as u32, rect.y as u32, rect.w, rect.h);
                let plate = plate(px, rw as usize * rh as usize)?;
                let mask: Option<Mask> = (!cov.is_none()).then(|| {
                    super::mask_window(cov, w, (rx, ry, rw, rh))
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|t| f16::from_le_bytes(*t).to_f32())
                        .collect()
                });
                let mut acc = st.acc.take().unwrap_or_else(|| zeros(n));
                let win: Tex = (0..rh)
                    .flat_map(|y| {
                        let o = ((ry + y) * w + rx) as usize;
                        acc[o..o + rw as usize].to_vec()
                    })
                    .collect();
                let blended = compose(blend, *gamma, &win, &plate, *opacity, mask.as_ref());
                for y in 0..rh as usize {
                    let o = (ry as usize + y) * w as usize + rx as usize;
                    acc[o..o + rw as usize]
                        .copy_from_slice(&blended[y * rw as usize..(y + 1) * rw as usize]);
                }
                st.acc = Some(acc);
            }
            Step::ClipOpen { px, cov, .. } => {
                let plate = plate(px, n)?;
                let mask = mask_of(cov, w, h);
                let acc = st.acc.take();
                st.parked.push(acc);
                let base = compose(
                    &image_kernels::families::compose::COMPOSE_NORMAL,
                    None,
                    &zeros(n),
                    &plate,
                    1.0,
                    mask.as_ref(),
                );
                let p = BandSetAlphaParams::new(1.0);
                let opaque = unpremultiply(&base)
                    .into_iter()
                    .map(|c| q4(band_set_alpha(c, Px([0.0; 4]), &p)))
                    .collect();
                st.clip.push(base);
                st.acc = Some(opaque);
            }
            Step::ClipClose {
                blend,
                opacity,
                shape,
            } => {
                let base = st.clip.pop().expect("a clip group is open");
                let inner = st.acc.take().unwrap_or_else(|| zeros(n));
                let outer = st.parked.pop().flatten().unwrap_or_else(|| zeros(n));
                st.acc = Some(if *shape {
                    let alpha = alpha_mask(&base);
                    let group: Tex = inner
                        .iter()
                        .zip(&alpha)
                        .map(|(&c, &a)| q4(Px(c.0.map(|v| v * a))))
                        .collect();
                    compose(blend, None, &outer, &group, *opacity, None)
                } else {
                    compose(blend, None, &outer, &inner, *opacity, None)
                });
            }
            Step::Close { blend, cov, .. } => {
                let inner = st.acc.take();
                let parked = st.parked.pop().flatten();
                let mask = mask_of(cov, w, h);
                st.acc = match blend {
                    None => parked,
                    Some((def, opacity)) => {
                        let a = parked.unwrap_or_else(|| zeros(n));
                        let b = inner.unwrap_or_else(|| zeros(n));
                        Some(compose(def, None, &a, &b, *opacity, mask.as_ref()))
                    }
                };
            }
            Step::Adjust {
                params,
                opacity,
                cov,
            } => {
                let acc = st.acc.take().unwrap_or_else(|| zeros(n));
                let straight = tex_f16(&unpremultiply(&acc));
                let sel = crate::layers::with_opacity(cov.coverage(w, h), *opacity, w, h);
                let adjusted =
                    crate::region_filter::adjust_f16_cpu(w, h, &straight, params, sel.as_deref());
                st.acc = Some(premultiply(&f16_tex(&adjusted)));
            }
            Step::Direct { .. }
            | Step::Effect { .. }
            | Step::BodyOpen
            | Step::BodyClose { .. }
            | Step::StyleClose { .. } => {
                // `supported` refused the plan before any window ran.
                return Err(IngestError::Unsupported(
                    "this step needs a GPU (see `supported`)".into(),
                ));
            }
        }
    }
    let acc = st.acc.unwrap_or_else(|| zeros(n));
    let straight = unpremultiply(&acc);
    let mut out = Vec::with_capacity(inner.w as usize * inner.h as usize);
    for y in 0..inner.h as usize {
        let o = (inner.y as usize + y) * w as usize + inner.x as usize;
        out.extend_from_slice(&straight[o..o + inner.w as usize]);
    }
    Ok(Pixels::from_f16(&tex_f16(&out), depth))
}
