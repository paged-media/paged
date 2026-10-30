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

//! N-CHANNEL PLANES (image ADR 481, the `paged-pixel` PixelFormat
//! amendment's `ChannelLayout::Planes`): N colour channels and an alpha,
//! carried as ⌈N/3⌉ RGBA planes that share the alpha — three colours a
//! plane. Every kernel speaks `vec4`, so a plane folds through the same
//! kernels, the same plan and the same fold as an RGB layer; a SEPARABLE
//! step (a blend applied per channel, a mask, an opacity, a group, a
//! clip) is exact per channel whichever plane the channel sits in.
//!
//! A CMYK document's layer is two planes of INK BRIGHTNESS (`1 − ink`, the
//! number a PSD stores, so paper is 1): `(C', M', Y', α)` and
//! `(K', K', K', α)`. Folding them is Photoshop's SUBTRACTIVE compose:
//! its CMYK blend modes apply the RGB formulas to those numbers, so
//! Multiply adds ink and Screen takes it away (`cmyk-stacks` replays it).
//!
//! A layer imported from a CMYK PSD keeps the file's own inks
//! ([`InkPlanes`], exactly as Photoshop stored them, black generation
//! included); any other layer's inks are its pixels through the
//! document's profile ([`ink_planes_of`]).

use std::sync::Arc;

use crate::color_mode::ModeTransform;
use crate::pixels::{LayerPixels, Pixels};

/// The RGBA planes N colour channels take.
pub const fn planes_for(channels: usize) -> usize {
    channels.div_ceil(3)
}

/// A CMYK layer's own inks, as the file stored them, for the pixels they
/// were read with (`source`): valid while the layer still holds those
/// pixels (an edit replaces them — see `LayerStack::edit_active`, which
/// carries the inks outside the damage).
#[derive(Debug, Clone)]
pub struct InkPlanes {
    /// The layer's pixels these inks are (the stored shape: a bounded
    /// layer's own pixels, else the canvas).
    pub source: Pixels,
    /// `(C', M', Y', α)`, in the layer's shape.
    pub cmy: LayerPixels,
    /// `(K', K', K', α)`, in the layer's shape.
    pub k: LayerPixels,
}

impl InkPlanes {
    /// Are these the inks of `rgba` (the layer's stored pixels)?
    pub fn of(&self, rgba: &LayerPixels) -> bool {
        match rgba {
            LayerPixels::Canvas(p) => p.same(&self.source),
            LayerPixels::Bounded(b) => b.px.same(&self.source),
        }
    }

    /// The planes for a step's pixels `px`: the stored shape, or its
    /// canvas expansion (a step that needs the canvas expands the layer).
    pub fn planes_for(&self, rgba: &LayerPixels, px: &Pixels) -> Option<[Pixels; 2]> {
        if !self.of(rgba) {
            return None;
        }
        let stored = |l: &LayerPixels| match l {
            LayerPixels::Canvas(p) => p.clone(),
            LayerPixels::Bounded(b) => b.px.clone(),
        };
        if px.same(&self.source) {
            return Some([stored(&self.cmy), stored(&self.k)]);
        }
        if px.same(rgba.canvas()) {
            return Some([self.cmy.canvas().clone(), self.k.canvas().clone()]);
        }
        None
    }

    /// Inks from the import's probing plates: `cmy_ink` and `k_ink` are
    /// RGBA8 in the layer's shape whose colour bytes are TRUE ink (255 =
    /// full) — `PsdFile::layer_plates_rgba8_via` with a transform that
    /// hands the ink through. The alpha is the layer's own.
    pub fn from_ink_rgba8(rgba: &LayerPixels, cmy_ink: &[u8], k_ink: &[u8]) -> Option<InkPlanes> {
        let source = match rgba {
            LayerPixels::Canvas(p) => p.clone(),
            LayerPixels::Bounded(b) => b.px.clone(),
        };
        let n = source.pixel_count();
        if cmy_ink.len() != n * 4 || k_ink.len() != n * 4 {
            return None;
        }
        let alpha = source.to_rgba8();
        let plane = |f: &dyn Fn(usize) -> [u8; 3]| -> Pixels {
            let v: Vec<u8> = (0..n)
                .flat_map(|i| {
                    let c = f(i);
                    [c[0], c[1], c[2], alpha[i * 4 + 3]]
                })
                .collect();
            Pixels::from_rgba8(Arc::from(v.into_boxed_slice()))
        };
        let cmy = plane(&|i| {
            [
                255 - cmy_ink[i * 4],
                255 - cmy_ink[i * 4 + 1],
                255 - cmy_ink[i * 4 + 2],
            ]
        });
        let k = plane(&|i| [255 - k_ink[i * 4]; 3]);
        let shape = |p: Pixels| match rgba {
            LayerPixels::Canvas(_) => Some(LayerPixels::Canvas(p)),
            LayerPixels::Bounded(b) => {
                crate::pixels::Bounded::new(b.rect, p, b.canvas_w, b.canvas_h)
                    .map(LayerPixels::Bounded)
            }
        };
        Some(InkPlanes {
            source,
            cmy: shape(cmy)?,
            k: shape(k)?,
        })
    }
}

/// The two ink planes of straight RGB pixels `px` through a CMYK
/// transform, at `px`'s depth.
pub fn ink_planes_of(t: &ModeTransform, px: &Pixels) -> [Pixels; 2] {
    let n = px.pixel_count();
    let rgb: Vec<f32> = (0..n)
        .flat_map(|i| (0..3).map(move |c| f32::from(px.sample16(i, c)) / 65535.0))
        .collect();
    let ink = t.device_of(&rgb);
    let alpha: Vec<u16> = (0..n).map(|i| px.sample16(i, 3)).collect();
    let bright = |v: f32| ((1.0 - v.clamp(0.0, 1.0)) * 65535.0).round() as u16;
    let p0: Vec<u16> = (0..n)
        .flat_map(|i| {
            let d = &ink[i * 4..i * 4 + 4];
            [bright(d[0]), bright(d[1]), bright(d[2]), alpha[i]]
        })
        .collect();
    let p1: Vec<u16> = (0..n)
        .flat_map(|i| {
            let k = bright(ink[i * 4 + 3]);
            [k, k, k, alpha[i]]
        })
        .collect();
    let depth = px.depth();
    [
        Pixels::from_rgba16(&p0).at_depth(depth),
        Pixels::from_rgba16(&p1).at_depth(depth),
    ]
}

/// Straight RGB of two folded ink planes (`p0` = C'M'Y', `p1` = K'; the
/// alpha is `p0`'s) through the transform back, at `depth`.
pub fn rgb_of_ink_planes(
    t: &ModeTransform,
    p0: &Pixels,
    p1: &Pixels,
    depth: image_core::SampleDepth,
) -> Pixels {
    let n = p0.pixel_count();
    let ink = |v: u16| 1.0 - f32::from(v) / 65535.0;
    let cmyk: Vec<f32> = (0..n)
        .flat_map(|i| {
            [
                ink(p0.sample16(i, 0)),
                ink(p0.sample16(i, 1)),
                ink(p0.sample16(i, 2)),
                ink(p1.sample16(i, 0)),
            ]
        })
        .collect();
    let rgb = t.rgb_of(&cmyk);
    let out: Vec<u16> = (0..n)
        .flat_map(|i| {
            let c = |k: usize| (rgb[i * 3 + k].clamp(0.0, 1.0) * 65535.0).round() as u16;
            [c(0), c(1), c(2), p0.sample16(i, 3)]
        })
        .collect();
    Pixels::from_rgba16(&out).at_depth(depth)
}

/// A Grayscale document's plane of straight RGB pixels `px`: the stored
/// grey (the mode's grey profile) in every colour channel, `(G, G, G, α)`
/// at `px`'s depth (image ADR 483).
pub fn gray_plane_of(t: &ModeTransform, px: &Pixels) -> Pixels {
    let n = px.pixel_count();
    let rgb: Vec<f32> = (0..n)
        .flat_map(|i| (0..3).map(move |c| f32::from(px.sample16(i, c)) / 65535.0))
        .collect();
    let g = t.device_of(&rgb);
    let q = |v: f32| (v.clamp(0.0, 1.0) * 65535.0).round() as u16;
    let p: Vec<u16> = (0..n)
        .flat_map(|i| {
            let v = q(g[i]);
            [v, v, v, px.sample16(i, 3)]
        })
        .collect();
    Pixels::from_rgba16(&p).at_depth(px.depth())
}

/// A Lab document's two planes: `(L*, L*, L*, α)` and `(a*, b*, b*, α)`
/// as the document stores them, normalised — L* over the full range, a*
/// and b* about the middle (+128 of 255 at 8 bits; 256 a unit about 32768
/// at 16) — at `px`'s depth. Photoshop blends a Lab document's L* with
/// the layer's mode and its a*, b* by a chroma rule of its own (image ADR
/// 483, `color-modes/lab-*`), so the two fold apart.
pub fn lab_planes_of(t: &ModeTransform, px: &Pixels, sixteen: bool) -> [Pixels; 2] {
    let n = px.pixel_count();
    let rgb: Vec<f32> = (0..n)
        .flat_map(|i| (0..3).map(move |c| f32::from(px.sample16(i, c)) / 65535.0))
        .collect();
    let lab = t.device_of(&rgb);
    let q = |v: f32| (v.clamp(0.0, 1.0) * 65535.0).round() as u16;
    let mut l = Vec::with_capacity(n * 4);
    let mut ab = Vec::with_capacity(n * 4);
    for i in 0..n {
        let d = &lab[i * 3..i * 3 + 3];
        let a = px.sample16(i, 3);
        let lv = q(d[0] / 100.0);
        l.extend_from_slice(&[lv, lv, lv, a]);
        let (av, bv) = (
            q(lab_ab_stored(d[1], sixteen)),
            q(lab_ab_stored(d[2], sixteen)),
        );
        ab.extend_from_slice(&[av, bv, bv, a]);
    }
    [
        Pixels::from_rgba16(&l).at_depth(px.depth()),
        Pixels::from_rgba16(&ab).at_depth(px.depth()),
    ]
}

/// A chroma plane as the source of Photoshop's Lab Linear Burn and Linear
/// Dodge, `(v + ½) / 2` in every colour channel: Linear Light over it is
/// `Cb + Cs − ½`, the sum of the two a* (b*) offsets Photoshop makes.
pub fn halved_about_middle(px: &Pixels) -> Pixels {
    let n = px.pixel_count();
    let s: Vec<u16> = (0..n)
        .flat_map(|i| {
            let h = |c: usize| ((u32::from(px.sample16(i, c)) + 32768) / 2) as u16;
            [h(0), h(1), h(2), px.sample16(i, 3)]
        })
        .collect();
    Pixels::from_rgba16(&s).at_depth(px.depth())
}

/// a* or b* as its stored number, normalised.
fn lab_ab_stored(v: f32, sixteen: bool) -> f32 {
    if sixteen {
        (v * 256.0 + 32768.0) / 65535.0
    } else {
        (v + 128.0) / 255.0
    }
}

/// Straight RGB of a folded grey plane, at `depth`.
pub fn rgb_of_gray_plane(t: &ModeTransform, p: &Pixels, depth: image_core::SampleDepth) -> Pixels {
    let n = p.pixel_count();
    let g: Vec<f32> = (0..n)
        .map(|i| f32::from(p.sample16(i, 0)) / 65535.0)
        .collect();
    let rgb = t.rgb_of(&g);
    finish_rgb(&rgb, p, depth)
}

/// Straight RGB of a Lab document's folded planes (L* from `l`, a* and
/// b* from `ab`), at `depth`.
pub fn rgb_of_lab_planes(
    t: &ModeTransform,
    l: &Pixels,
    ab: &Pixels,
    sixteen: bool,
    depth: image_core::SampleDepth,
) -> Pixels {
    let n = l.pixel_count();
    let off = |v: f32| {
        if sixteen {
            (v * 65535.0 - 32768.0) / 256.0
        } else {
            v * 255.0 - 128.0
        }
    };
    let lab: Vec<f32> = (0..n)
        .flat_map(|i| {
            let s = |p: &Pixels, c: usize| f32::from(p.sample16(i, c)) / 65535.0;
            [s(l, 0) * 100.0, off(s(ab, 0)), off(s(ab, 1))]
        })
        .collect();
    let rgb = t.rgb_of(&lab);
    finish_rgb(&rgb, l, depth)
}

fn finish_rgb(rgb: &[f32], alpha_of: &Pixels, depth: image_core::SampleDepth) -> Pixels {
    let n = alpha_of.pixel_count();
    let out: Vec<u16> = (0..n)
        .flat_map(|i| {
            let c = |k: usize| (rgb[i * 3 + k].clamp(0.0, 1.0) * 65535.0).round() as u16;
            [c(0), c(1), c(2), alpha_of.sample16(i, 3)]
        })
        .collect();
    Pixels::from_rgba16(&out).at_depth(depth)
}

/// `win` of `px` (a `w`-wide image), as new pixels at its depth.
fn crop(px: &Pixels, w: u32, win: image_core::Region) -> Pixels {
    let bpp = px.bytes_per_pixel();
    let row = win.w as usize * bpp;
    let src = px.raw();
    let mut out = Vec::with_capacity(row * win.h as usize);
    for y in 0..win.h as usize {
        let s = ((win.y as usize + y) * w as usize + win.x as usize) * bpp;
        out.extend_from_slice(&src[s..s + row]);
    }
    Pixels::from_raw(Arc::from(out.into_boxed_slice()), px.depth())
}

/// Write `part` (`win`'s size) into `px` (a `w`-wide image) at `win`.
fn paste(px: &mut Pixels, w: u32, part: &Pixels, win: image_core::Region) {
    let bpp = px.bytes_per_pixel();
    let row = win.w as usize * bpp;
    let src = part.raw().to_vec();
    let dst = px.make_mut();
    for y in 0..win.h as usize {
        let d = ((win.y as usize + y) * w as usize + win.x as usize) * bpp;
        dst[d..d + row].copy_from_slice(&src[y * row..(y + 1) * row]);
    }
}

impl InkPlanes {
    /// The inks after an edit that replaced the layer's pixels with
    /// `px` (canvas-sized) inside `damage`: the file's own inks
    /// everywhere else, `px` through the profile inside it — so a brush
    /// stroke costs the exact inks of the pixels it touched, not of the
    /// layer.
    pub fn carried(
        &self,
        t: &ModeTransform,
        px: &Pixels,
        damage: image_core::Region,
        w: u32,
    ) -> InkPlanes {
        let depth = px.depth();
        let mut cmy = self.cmy.canvas().at_depth(depth);
        let mut k = self.k.canvas().at_depth(depth);
        if damage.w > 0 && damage.h > 0 {
            let [c, kk] = ink_planes_of(t, &crop(px, w, damage));
            paste(&mut cmy, w, &c, damage);
            paste(&mut k, w, &kk, damage);
        }
        InkPlanes {
            source: px.clone(),
            cmy: LayerPixels::Canvas(cmy),
            k: LayerPixels::Canvas(k),
        }
    }
}
