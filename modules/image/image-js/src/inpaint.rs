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

//! EXEMPLAR INPAINTING (Criminisi et al.) — now only the spot healing
//! brush's PROXIMITY MATCH search. Content-Aware Fill, Move and Remove run
//! on the multi-resolution PatchMatch in `crate::patchmatch`, which has
//! neither of the limits stated below.
//!
//! The catalog priced this as the one genuine XL left in the retouching
//! family, and it is the only one of the three that is not a brush:
//! filling a selection means SYNTHESISING plausible content, which is a
//! search problem rather than a compositing one. That is why it was
//! deliberately left out when clone and heal shipped — a button that
//! returned a blurry average would have been worse than its absence.
//!
//! # The algorithm, and why this one
//!
//! Exemplar-based inpainting (Criminisi, Pérez & Toyama, *Region Filling
//! and Object Removal by Exemplar-Based Image Inpainting*, IEEE TIP
//! 2004). The hole is filled PATCH BY PATCH from its boundary inward,
//! and the order is the whole idea:
//!
//! ```text
//!     P(p) = C(p) · D(p)
//!     C(p) = mean confidence over the known part of the patch at p
//!     D(p) = |∇I⊥(p) · n(p)| / α        (the isophote/normal term)
//! ```
//!
//! `C` prefers patches whose neighbourhood is mostly already known, so
//! the fill grows inward evenly instead of racing down one corridor.
//! `D` prefers patches where a strong edge runs INTO the hole, so linear
//! structure is continued before flat texture is. Together they are what
//! separates "content-aware" from "blur": a diffusion-based fill has no
//! `D` term and smears every edge it crosses.
//!
//! Each chosen patch is filled by copying the best-matching patch found
//! elsewhere in the image, compared over the pixels that are already
//! known. So the output is made of REAL pixels from the same image,
//! which is why it keeps grain and texture that any smoothing method
//! destroys.
//!
//! # The honest limits, stated here and in the panel
//!
//! * **The search is windowed.** Comparing every source position for
//!   every boundary patch is quadratic in image area; the search is
//!   bounded to a radius around the target, which is where plausible
//!   texture lives anyway. A hole whose best match is on the far side of
//!   a large image will not find it.
//! * **Single scale.** No pyramid, so very large holes reproduce texture
//!   faithfully but can lose large-scale structure.
//! * **Deterministic.** Same input, same output — no random restarts. A
//!   retoucher who does not like the result changes the selection, and
//!   the same selection twice gives the same answer.

/// Patch half-width. The patch is `2·R+1` square — 9×9, the size the
/// paper uses and the one that holds texture without over-smoothing.
const R: i32 = 4;

/// A pass's output: the filled pixels, and WHERE each filled pixel came
/// from. The shift map is what a finer pass starts from.
type PassResult = (Vec<u8>, Vec<(i32, i32)>);

/// How far from a target patch to look for its exemplar.
///
/// Bounded because an exhaustive search is quadratic in image area, and
/// unbounded search time inside an interactive tool is not a trade worth
/// making. Plausible replacement texture is almost always local.
const SEARCH: i32 = 96;

/// The window the FINE pass searches when the coarse pass has already
/// named an offset. Small on purpose: the coarse decision is the answer,
/// and this only lets the fine pass pick the best texture match near it.
const REFINE: i32 = 12;

/// The SPOT-HEALING search: where should a hole be healed FROM?
///
/// Runs the exemplar fill over `hole` (one byte per pixel, non-zero =
/// hole) and reads back the shift map it used — where each filled pixel
/// was copied from. The answer is the MOST FREQUENT shift (ties broken
/// toward the nearer source, then by value, so the result is
/// deterministic) whose translated hole lies wholly inside the window
/// and wholly outside the hole itself: a single offset the healing
/// brush can then copy and tone-match from, as if the user had
/// Alt-clicked there. `None` when the fill finds nothing to copy from,
/// or no candidate offset clears the hole.
///
/// Why an offset and not the synthesized pixels: the healing correction
/// interpolates the source−destination mismatch AROUND the hole, and a
/// synthesis that already equals the destination outside the hole has
/// no mismatch to interpolate — the heal step would do nothing. A
/// shifted copy carries its own surroundings, so the membrane solve
/// genuinely matches its tone to the destination's.
pub fn spot_source_offset(rgba: &[u8], width: u32, height: u32, hole: &[u8]) -> Option<(i32, i32)> {
    let (_, shifts) = fill_pass(rgba, width, height, hole, None)?;
    let (w, h) = (width as i32, height as i32);
    let mut counts: std::collections::HashMap<(i32, i32), usize> = Default::default();
    for (i, &m) in hole.iter().enumerate() {
        if m != 0 && shifts[i] != (0, 0) {
            *counts.entry(shifts[i]).or_default() += 1;
        }
    }
    let mut ranked: Vec<((i32, i32), usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then((a.0 .0.pow(2) + a.0 .1.pow(2)).cmp(&(b.0 .0.pow(2) + b.0 .1.pow(2))))
            .then(a.0.cmp(&b.0))
    });
    let clears = |(dx, dy): (i32, i32)| {
        hole.iter().enumerate().all(|(i, &m)| {
            if m == 0 {
                return true;
            }
            let (x, y) = (i as i32 % w + dx, i as i32 / w + dy);
            x >= 0 && y >= 0 && x < w && y < h && hole[(y * w + x) as usize] == 0
        })
    };
    ranked.into_iter().map(|(d, _)| d).find(|&d| clears(d))
}

/// One scale's fill. `bias`, when present, is a per-pixel offset the
/// exemplar search centres on — the coarse pass's decision, carried
/// down. Returns the filled pixels AND the shift map it used.
fn fill_pass(
    rgba: &[u8],
    width: u32,
    height: u32,
    mask: &[u8],
    bias: Option<&[(i32, i32)]>,
) -> Option<PassResult> {
    let (w, h) = (width as i32, height as i32);
    let n = (width as usize) * (height as usize);
    if n == 0 || rgba.len() < n * 4 {
        return None;
    }

    // `known[i]`: this pixel is source material. `conf[i]`: Criminisi's
    // confidence, 1 for original pixels and inherited by filled ones —
    // which is what makes later patches trust early ones less.
    let mut out = rgba.to_vec();
    let mut known = vec![true; n];
    let mut conf = vec![1f32; n];
    let mut shifts = vec![(0i32, 0i32); n];
    let mut remaining = 0usize;
    for i in 0..n {
        if mask.get(i).copied().unwrap_or(0) != 0 {
            known[i] = false;
            conf[i] = 0.0;
            remaining += 1;
        }
    }
    if mask.len() < n {
        return None;
    }
    if remaining == 0 || remaining == n {
        // Nothing selected, or everything is: with no source region
        // there is nothing to synthesise FROM, and inventing pixels from
        // nothing is not a thing this should pretend to do.
        return None;
    }

    // Guard the loop: every iteration fills at least one pixel, so this
    // cannot spin — but a bound makes that a fact rather than a belief.
    let mut guard = remaining * 4 + 64;
    while remaining > 0 && guard > 0 {
        guard -= 1;
        let Some(target) = best_front_patch(&out, &known, &conf, w, h) else {
            break;
        };
        let (tx, ty) = target;
        // The coarse pass's offset for this pixel, if there was one.
        let hint = bias.and_then(|b| b.get((ty * w + tx) as usize).copied());
        let Some((sx, sy)) = best_exemplar(&out, &known, w, h, tx, ty, hint) else {
            // No usable exemplar anywhere in range. Rather than leave the
            // hole (an infinite loop) or invent a colour, mark this
            // patch known at its current value and move on — the result
            // is visibly unfilled there, which is the honest outcome.
            for dy in -R..=R {
                for dx in -R..=R {
                    let (px, py) = (tx + dx, ty + dy);
                    if px < 0 || py < 0 || px >= w || py >= h {
                        continue;
                    }
                    let i = (py * w + px) as usize;
                    if !known[i] {
                        known[i] = true;
                        remaining -= 1;
                    }
                }
            }
            continue;
        };

        // Criminisi's update: the whole patch inherits the target's
        // confidence, so material copied later is trusted less than
        // material copied early.
        let patch_conf = mean_conf(&conf, &known, w, h, tx, ty);
        for dy in -R..=R {
            for dx in -R..=R {
                let (px, py) = (tx + dx, ty + dy);
                let (qx, qy) = (sx + dx, sy + dy);
                if px < 0 || py < 0 || px >= w || py >= h {
                    continue;
                }
                if qx < 0 || qy < 0 || qx >= w || qy >= h {
                    continue;
                }
                let pi = (py * w + px) as usize;
                if known[pi] {
                    continue;
                }
                let qi = (qy * w + qx) as usize;
                let texel = rgba_at(&out, qi);
                out[pi * 4..pi * 4 + 4].copy_from_slice(&texel);
                known[pi] = true;
                conf[pi] = patch_conf;
                // Where this pixel came FROM, so a finer pass can start
                // where this one finished.
                shifts[pi] = (sx - tx, sy - ty);
                remaining -= 1;
            }
        }
    }
    Some((out, shifts))
}

fn rgba_at(buf: &[u8], i: usize) -> [u8; 4] {
    [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2], buf[i * 4 + 3]]
}

/// Is this pixel on the fill front — unknown, with a known neighbour?
fn on_front(known: &[bool], w: i32, h: i32, x: i32, y: i32) -> bool {
    let i = (y * w + x) as usize;
    if known[i] {
        return false;
    }
    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
        let (nx, ny) = (x + dx, y + dy);
        if nx < 0 || ny < 0 || nx >= w || ny >= h {
            continue;
        }
        if known[(ny * w + nx) as usize] {
            return true;
        }
    }
    false
}

fn mean_conf(conf: &[f32], known: &[bool], w: i32, h: i32, x: i32, y: i32) -> f32 {
    let mut sum = 0f32;
    let mut count = 0f32;
    for dy in -R..=R {
        for dx in -R..=R {
            let (px, py) = (x + dx, y + dy);
            if px < 0 || py < 0 || px >= w || py >= h {
                continue;
            }
            let i = (py * w + px) as usize;
            count += 1.0;
            if known[i] {
                sum += conf[i];
            }
        }
    }
    if count == 0.0 {
        0.0
    } else {
        sum / count
    }
}

/// The front pixel with the highest Criminisi priority.
fn best_front_patch(
    rgba: &[u8],
    known: &[bool],
    conf: &[f32],
    w: i32,
    h: i32,
) -> Option<(i32, i32)> {
    let mut best: Option<((i32, i32), f32)> = None;
    for y in 0..h {
        for x in 0..w {
            if !on_front(known, w, h, x, y) {
                continue;
            }
            let c = mean_conf(conf, known, w, h, x, y);
            let d = data_term(rgba, known, w, h, x, y);
            // The `+ 0.001` floor on D keeps a patch with no measurable
            // isophote from getting priority zero, which would freeze it
            // out of the queue forever and leave a hole unfilled.
            let p = c * (d + 0.001);
            if best.is_none_or(|(_, bp)| p > bp) {
                best = Some(((x, y), p));
            }
        }
    }
    best.map(|(pt, _)| pt)
}

/// `|∇I⊥ · n|` — how strongly an edge runs INTO the hole here. This is
/// the term that makes structure continue instead of blurring.
fn data_term(rgba: &[u8], known: &[bool], w: i32, h: i32, x: i32, y: i32) -> f32 {
    let lum = |xx: i32, yy: i32| -> Option<f32> {
        if xx < 0 || yy < 0 || xx >= w || yy >= h {
            return None;
        }
        let i = (yy * w + xx) as usize;
        if !known[i] {
            return None;
        }
        Some(
            (0.2126 * f32::from(rgba[i * 4])
                + 0.7152 * f32::from(rgba[i * 4 + 1])
                + 0.0722 * f32::from(rgba[i * 4 + 2]))
                / 255.0,
        )
    };
    // Central differences over KNOWN pixels only; a one-sided or absent
    // neighbour contributes nothing rather than a fabricated gradient.
    let gx = match (lum(x + 1, y), lum(x - 1, y)) {
        (Some(a), Some(b)) => (a - b) * 0.5,
        _ => 0.0,
    };
    let gy = match (lum(x, y + 1), lum(x, y - 1)) {
        (Some(a), Some(b)) => (a - b) * 0.5,
        _ => 0.0,
    };
    // The fill-front normal: the gradient of the known/unknown mask.
    let m = |xx: i32, yy: i32| -> f32 {
        if xx < 0 || yy < 0 || xx >= w || yy >= h {
            return 1.0;
        }
        if known[(yy * w + xx) as usize] {
            1.0
        } else {
            0.0
        }
    };
    let nx = (m(x + 1, y) - m(x - 1, y)) * 0.5;
    let ny = (m(x, y + 1) - m(x, y - 1)) * 0.5;
    let nlen = (nx * nx + ny * ny).sqrt();
    if nlen <= f32::EPSILON {
        return 0.0;
    }
    // ∇I⊥ is the gradient rotated 90° — the ISOPHOTE direction, i.e. the
    // direction an edge runs, not the direction it changes.
    ((-gy) * (nx / nlen) + gx * (ny / nlen)).abs()
}

/// The best-matching fully-known patch within `SEARCH` of the target,
/// compared over the target's known pixels only.
fn best_exemplar(
    rgba: &[u8],
    known: &[bool],
    w: i32,
    h: i32,
    tx: i32,
    ty: i32,
    hint: Option<(i32, i32)>,
) -> Option<(i32, i32)> {
    let mut best: Option<((i32, i32), f64)> = None;
    // With a coarse hint, search a SMALL window around where the coarse
    // pass went; without one, the wide blind window.
    let (cx, cy, radius) = match hint {
        Some((dx, dy)) if (dx, dy) != (0, 0) => (tx + dx, ty + dy, REFINE),
        _ => (tx, ty, SEARCH),
    };
    let x0 = (cx - radius).max(R);
    let x1 = (cx + radius).min(w - 1 - R);
    let y0 = (cy - radius).max(R);
    let y1 = (cy + radius).min(h - 1 - R);
    for sy in y0..=y1 {
        'candidate: for sx in x0..=x1 {
            let mut ssd = 0f64;
            let mut compared = 0u32;
            for dy in -R..=R {
                for dx in -R..=R {
                    let (px, py) = (tx + dx, ty + dy);
                    let (qx, qy) = (sx + dx, sy + dy);
                    if px < 0 || py < 0 || px >= w || py >= h {
                        continue;
                    }
                    let pi = (py * w + px) as usize;
                    let qi = (qy * w + qx) as usize;
                    // A candidate patch must be ENTIRELY known — copying
                    // from a partly-unfilled patch would propagate the
                    // hole instead of closing it.
                    if !known[qi] {
                        continue 'candidate;
                    }
                    if !known[pi] {
                        continue;
                    }
                    for ch in 0..3 {
                        let d = f64::from(rgba[pi * 4 + ch]) - f64::from(rgba[qi * 4 + ch]);
                        ssd += d * d;
                    }
                    compared += 1;
                }
            }
            if compared == 0 {
                continue;
            }
            // Normalised, so a patch clipped by the image edge is not
            // preferred merely for having fewer terms in its sum.
            let score = ssd / f64::from(compared);
            if best.is_none_or(|(_, b)| score < b) {
                best = Some(((sx, sy), score));
            }
        }
    }
    best.map(|(pt, _)| pt)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exemplar fill copies real pixels (a two-valued image stays
    /// two-valued) and touches nothing outside the hole — what the spot
    /// healing brush's proximity match relies on.
    #[test]
    fn image_editor_inpaint_the_exemplar_pass_only_copies() {
        let (w, h) = (48u32, 48u32);
        let mut rgba = Vec::new();
        for _y in 0..h {
            for x in 0..w {
                let v = if (x / 3) % 2 == 0 { 0 } else { 255 };
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let mut hole = vec![0u8; (w * h) as usize];
        for y in 20..28 {
            for x in 20..28 {
                hole[(y * w + x) as usize] = 255;
            }
        }
        let (out, _) = fill_pass(&rgba, w, h, &hole, None).expect("filled");
        for (i, &m) in hole.iter().enumerate() {
            let v = out[i * 4];
            if m != 0 {
                assert!(v == 0 || v == 255, "pixel {i} is {v}");
            } else {
                assert_eq!(&out[i * 4..i * 4 + 4], &rgba[i * 4..i * 4 + 4]);
            }
        }
        // Nothing to fill from is None.
        assert!(fill_pass(&rgba, w, h, &vec![255u8; (w * h) as usize], None).is_none());
    }
}
