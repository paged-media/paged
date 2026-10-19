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

//! Per-ink plane state: the page's separation, kept while it renders.
//!
//! One byte per page pixel per process ink (C/M/Y/K), one per named
//! spot ink, and a coverage mask saying which pixels a `Paint::Cmyk`
//! draw reached. Allocated lazily on the first CMYK draw that needs it.
//!
//! Two kinds of write, with fixed arithmetic in 8-bit space:
//!
//!  * an ordinary (knockout) CMYK draw **splats**: every ink plane takes
//!    `max(plane, ink · coverage)`, the coverage mask `max(mask,
//!    coverage)`. Spot paints write only their own spot plane, at the
//!    spot's tint, and leave the process planes and the mask alone, so
//!    the spot identity stays separable;
//!  * a `*Overprint` draw **composites**: per channel, a heavier ink
//!    moves the plane toward itself by its coverage, `bottom + (top −
//!    bottom) · coverage`; a lighter one leaves it. The visible pixel is
//!    rewritten from the result through the naive CMYK→RGB map.
//!
//! The draw's coverage is its rasterized alpha with the active clip
//! already applied (the rasterizer renders the scratch through the clip),
//! so a pixel the clip hides is untouched and a clip edge weighs the
//! write like the draw's own antialiasing does.
//!
//! Where a pixel has no plane truth yet, an overprint recovers the
//! bottom ink from the RGB under it (`rgb_to_naive_cmyk_8bit`, the
//! inverse of the forward map), which is exact for a pixel a CMYK
//! swatch painted and approximate for anything else.

use paged_compose::{DisplayList, Paint, SpotInkId};

use crate::rgb_to_naive_cmyk_8bit;

/// The plane state. See the module docs.
pub(crate) struct CmykPlanes {
    planes: [Vec<u8>; 4],
    coverage: Vec<u8>,
    /// One plane per spot ink id: the per-pixel tint of that ink.
    spots: Vec<Vec<u8>>,
    /// 8-bit CMYK alternate per spot id (`SpotInk::cmyk_alternate`).
    spot_alts: Vec<[u8; 4]>,
    w: u32,
    h: u32,
}

impl CmykPlanes {
    pub(crate) fn new(w: u32, h: u32) -> Self {
        let n = (w as usize) * (h as usize);
        Self {
            planes: [vec![0u8; n], vec![0u8; n], vec![0u8; n], vec![0u8; n]],
            coverage: vec![0u8; n],
            spots: Vec::new(),
            spot_alts: Vec::new(),
            w,
            h,
        }
    }

    /// One process plane by channel index (0 = C, 1 = M, 2 = Y, 3 = K).
    pub(crate) fn process_plane(&self, channel: usize) -> &[u8] {
        &self.planes[channel]
    }

    /// The process-ink coverage mask. A non-overprint spot draw writes
    /// its spot plane and leaves this alone, so a separation folds the
    /// spot planes in itself.
    pub(crate) fn coverage_mask(&self) -> &[u8] {
        &self.coverage
    }

    pub(crate) fn spot_planes(&self) -> &[Vec<u8>] {
        &self.spots
    }

    pub(crate) fn spot_alternate(&self, idx: usize) -> [u8; 4] {
        self.spot_alts.get(idx).copied().unwrap_or([0; 4])
    }

    fn ensure_spot_plane(&mut self, idx: usize, alt: [u8; 4]) {
        let n = (self.w as usize) * (self.h as usize);
        while self.spots.len() <= idx {
            self.spots.push(vec![0u8; n]);
            self.spot_alts.push([0u8; 4]);
        }
        self.spot_alts[idx] = alt;
    }
}

/// A draw's coverage: an alpha raster placed at `off` (page pixels).
pub(crate) struct Coverage<'a> {
    pub alpha: &'a [u8],
    pub w: u32,
    pub h: u32,
    pub off: (i32, i32),
}

impl Coverage<'_> {
    /// Every covered pixel inside a `pw × ph` page: `(scratch index,
    /// page index, coverage)`.
    fn covered(&self, pw: u32, ph: u32) -> impl Iterator<Item = (usize, u16)> + '_ {
        let (sw, sh) = (self.w as i32, self.h as i32);
        let (pw, ph) = (pw as i32, ph as i32);
        (0..sh).flat_map(move |j| {
            let py = j + self.off.1;
            (0..sw).filter_map(move |i| {
                let px = i + self.off.0;
                if py < 0 || py >= ph || px < 0 || px >= pw {
                    return None;
                }
                let a = self.alpha[(j * sw + i) as usize];
                (a > 0).then_some(((py * pw + px) as usize, a as u16))
            })
        })
    }
}

/// How much of a spot ink a paint carries: the heaviest channel of the
/// paint (the alternate × the use's tint) over the heaviest channel of
/// the alternate at full strength. 0 for a spot whose alternate is
/// paper.
fn spot_tint_8(paint_cmyk: [f32; 4], alt: [u8; 4]) -> u16 {
    let alt_max = alt.iter().map(|v| *v as f32 / 255.0).fold(0.0_f32, f32::max);
    let tint = if alt_max <= f32::EPSILON {
        0.0
    } else {
        let [c, m, y, k] = paint_cmyk;
        (c.max(m).max(y).max(k) / alt_max).clamp(0.0, 1.0)
    };
    (tint * 255.0).round() as u16
}

fn ink_8(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u16
}

/// Splat an ordinary (knockout) CMYK draw into the planes.
pub(crate) fn splat_cmyk_draw(
    planes: &mut CmykPlanes,
    list: &DisplayList,
    paint: &Paint,
    cov: &Coverage<'_>,
) {
    let Paint::Cmyk {
        c, m, y, k, spot, ..
    } = *paint
    else {
        return;
    };
    let (pw, ph) = (planes.w, planes.h);
    if let Some(SpotInkId(spot_id)) = spot {
        // A stale id (a list the paint does not belong to) falls through
        // to the process planes so the visible ink stays roughly right.
        if let Some(ink) = list.spot_ink(SpotInkId(spot_id)) {
            let idx = spot_id as usize;
            planes.ensure_spot_plane(idx, ink.cmyk_alternate);
            let tint = spot_tint_8([c, m, y, k], ink.cmyk_alternate);
            for (t_idx, a) in cov.covered(pw, ph) {
                let add = (tint * a + 127) / 255;
                let plane = &mut planes.spots[idx];
                plane[t_idx] = (plane[t_idx] as u16).max(add).min(255) as u8;
            }
            return;
        }
    }
    let top = [ink_8(c), ink_8(m), ink_8(y), ink_8(k)];
    for (t_idx, a) in cov.covered(pw, ph) {
        for (ch, &t) in top.iter().enumerate() {
            let add = (t * a + 127) / 255;
            let plane = &mut planes.planes[ch];
            plane[t_idx] = (plane[t_idx] as u16).max(add).min(255) as u8;
        }
        planes.coverage[t_idx] = (planes.coverage[t_idx] as u16).max(a).min(255) as u8;
    }
}

/// `bottom + (top − bottom) · coverage` where the top ink is heavier,
/// `bottom` otherwise.
fn overprint_channel(bot: u16, top: u16, cov: u16) -> u8 {
    if top <= bot {
        bot as u8
    } else {
        let add = ((top - bot) * cov + 127) / 255;
        (bot + add).min(255) as u8
    }
}

/// Forward naive CMYK→RGB in 8-bit space: `R = (255−C)(255−K)/255`.
pub(crate) fn naive_cmyk_to_rgb_8bit(c: u8, m: u8, y: u8, k: u8) -> (u8, u8, u8) {
    let kp = 255u16 - k as u16;
    let chan = |v: u8| -> u8 {
        let prod = (255u16 - v as u16) * kp;
        ((prod + 127) / 255).min(255) as u8
    };
    (chan(c), chan(m), chan(y))
}

/// The pixel an overprint reads as "what is under it", straight RGB.
///
/// On the page the paper is under everything, so a pixel is read as it
/// will finally show — composited over the paper — and the overprint
/// writes an opaque result (`paper` is `Some`). Inside a group buffer
/// there is no paper: an empty pixel reads as white, the inverse map's
/// "no ink", and the write keeps the buffer's own coverage.
fn under_rgb(px: &[u8], paper: Option<[u8; 4]>) -> ((u8, u8, u8), u8) {
    let (r, g, b, a) = (px[0], px[1], px[2], px[3]);
    if let Some(p) = paper {
        let inv = 255 - a as u32;
        let over = |c: u8, pc: u8| ((c as u32 * 255 + pc as u32 * inv + 127) / 255).min(255) as u8;
        return ((over(r, p[0]), over(g, p[1]), over(b, p[2])), 255);
    }
    if a == 0 {
        ((255, 255, 255), 0)
    } else if a == 255 {
        ((r, g, b), 255)
    } else {
        let demul = |c: u8| ((c as u32 * 255 + (a as u32 / 2)) / a as u32).min(255) as u8;
        ((demul(r), demul(g), demul(b)), a)
    }
}

fn write_rgb(px: &mut [u8], rgb: (u8, u8, u8), out_a: u8) {
    let pre = |c: u8| ((c as u32 * out_a as u32 + 127) / 255).min(255) as u8;
    px[0] = pre(rgb.0);
    px[1] = pre(rgb.1);
    px[2] = pre(rgb.2);
    px[3] = out_a;
}

/// A premultiplied RGBA8 target the overprint rewrites.
pub(crate) struct Target<'a> {
    pub data: &'a mut [u8],
    pub w: u32,
    pub h: u32,
    /// The paper (premultiplied RGBA8) when this is the page.
    pub paper: Option<[u8; 4]>,
}

/// Route an overprint draw through the right composite: a spot paint
/// into its own plane, a process paint into the four process planes;
/// both rewrite the visible pixel. Without `planes` (a group buffer —
/// plane state is page-level) the bottom ink always comes from the RGB.
pub(crate) fn compose_overprint(
    target: Target<'_>,
    mut planes: Option<&mut CmykPlanes>,
    list: &DisplayList,
    paint: &Paint,
    cov: &Coverage<'_>,
) {
    let Paint::Cmyk {
        c, m, y, k, spot, ..
    } = *paint
    else {
        return;
    };
    let Target { data, w, h, paper } = target;
    if let (Some(p), Some(SpotInkId(spot_id))) = (planes.as_deref_mut(), spot) {
        if let Some(ink) = list.spot_ink(SpotInkId(spot_id)) {
            let idx = spot_id as usize;
            p.ensure_spot_plane(idx, ink.cmyk_alternate);
            let tint = spot_tint_8([c, m, y, k], ink.cmyk_alternate);
            for (t_idx, a) in cov.covered(w.min(p.w), h.min(p.h)) {
                let bot = p.spots[idx][t_idx] as u16;
                p.spots[idx][t_idx] = overprint_channel(bot, tint, a);
                // The visible pixel: process plane state (where any) and
                // every active spot's alternate × tint, per-channel max.
                let mut acc = if p.coverage[t_idx] > 0 {
                    [
                        p.planes[0][t_idx] as u16,
                        p.planes[1][t_idx] as u16,
                        p.planes[2][t_idx] as u16,
                        p.planes[3][t_idx] as u16,
                    ]
                } else {
                    [0u16; 4]
                };
                for (sidx, plane) in p.spots.iter().enumerate() {
                    let t = plane[t_idx] as u16;
                    if t == 0 {
                        continue;
                    }
                    let alt = p.spot_alts[sidx];
                    for ch in 0..4 {
                        acc[ch] = acc[ch].max((alt[ch] as u16 * t + 127) / 255);
                    }
                }
                let rgb = naive_cmyk_to_rgb_8bit(
                    acc[0].min(255) as u8,
                    acc[1].min(255) as u8,
                    acc[2].min(255) as u8,
                    acc[3].min(255) as u8,
                );
                let px = &mut data[t_idx * 4..t_idx * 4 + 4];
                let (_, t_a) = under_rgb(px, paper);
                write_rgb(px, rgb, t_a.max(a as u8));
                p.coverage[t_idx] = (p.coverage[t_idx] as u16).max(a).min(255) as u8;
            }
            return;
        }
    }
    let top = [ink_8(c), ink_8(m), ink_8(y), ink_8(k)];
    let (pw, ph) = match planes.as_deref() {
        Some(p) => (w.min(p.w), h.min(p.h)),
        None => (w, h),
    };
    for (t_idx, a) in cov.covered(pw, ph) {
        let px = &mut data[t_idx * 4..t_idx * 4 + 4];
        let (under, t_a) = under_rgb(px, paper);
        let bot = match planes.as_deref() {
            Some(p) if p.coverage[t_idx] > 0 => [
                p.planes[0][t_idx],
                p.planes[1][t_idx],
                p.planes[2][t_idx],
                p.planes[3][t_idx],
            ],
            _ => {
                let (bc, bm, by, bk) = rgb_to_naive_cmyk_8bit(under.0, under.1, under.2);
                [bc, bm, by, bk]
            }
        };
        let new: [u8; 4] = std::array::from_fn(|ch| overprint_channel(bot[ch] as u16, top[ch], a));
        if let Some(p) = planes.as_deref_mut() {
            for (ch, v) in new.iter().enumerate() {
                p.planes[ch][t_idx] = *v;
            }
            p.coverage[t_idx] = (p.coverage[t_idx] as u16).max(a).min(255) as u8;
        }
        let rgb = naive_cmyk_to_rgb_8bit(new[0], new[1], new[2], new[3]);
        write_rgb(px, rgb, t_a.max(a as u8));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naive_forward_and_inverse_round_trip() {
        for &(c, m, y, k) in &[(0u8, 0, 0, 0), (255, 0, 0, 0), (40, 90, 10, 30), (0, 0, 0, 255)] {
            let (r, g, b) = naive_cmyk_to_rgb_8bit(c, m, y, k);
            let (c2, m2, y2, k2) = rgb_to_naive_cmyk_8bit(r, g, b);
            let (r2, g2, b2) = naive_cmyk_to_rgb_8bit(c2, m2, y2, k2);
            assert_eq!((r, g, b), (r2, g2, b2), "cmyk {c} {m} {y} {k}");
        }
    }
}
