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

//! The CONTENT-AWARE verbs over [`crate::patchmatch`]: the Content-Aware
//! Fill workspace (sampling area, preview, overlay, output), the
//! Content-Aware Move tool, the Remove tool and the spot healing brush's
//! content-aware and create-texture types.
//!
//! Everything here works on straight RGBA8 canvases and one-byte masks and
//! returns pixels; the wasm doors decide where they land (the active
//! layer, a new layer, a duplicate) and journal them as one undo step.

use image_core::Region;

use crate::patchmatch::{self, ColourAdaptation, FillOptions, RotationAdaptation, SamplingArea};

/// The sampling area as asked for: one of the automatic ones, or a mask
/// the user painted (one byte per pixel).
#[derive(Clone, Debug)]
pub enum Sampling<'a> {
    Auto,
    Rectangular,
    Custom(&'a [u8]),
}

/// The sampling area as a mask (never the hole).
pub fn sampling_mask(rgba: &[u8], w: u32, h: u32, hole: &[u8], s: &Sampling<'_>) -> Vec<u8> {
    match s {
        Sampling::Auto => patchmatch::sampling_area(rgba, w, h, hole, SamplingArea::Auto),
        Sampling::Rectangular => {
            patchmatch::sampling_area(rgba, w, h, hole, SamplingArea::Rectangular)
        }
        Sampling::Custom(m) => m
            .iter()
            .zip(hole)
            .map(|(&s, &hh)| if s != 0 && hh == 0 { 255 } else { 0 })
            .collect(),
    }
}

/// The CAF workspace's on-canvas overlay: `rgba` with the sampling area
/// tinted (straight RGB `tint`, at `opacity`). The hole is left as it is —
/// the selection outline marks it.
pub fn sampling_overlay(rgba: &[u8], sample: &[u8], tint: [u8; 3], opacity: f32) -> Vec<u8> {
    let k = opacity.clamp(0.0, 1.0);
    let mut out = rgba.to_vec();
    for (i, &m) in sample.iter().enumerate() {
        if m == 0 {
            continue;
        }
        for c in 0..3 {
            let b = f32::from(out[i * 4 + c]);
            out[i * 4 + c] = (b + (f32::from(tint[c]) - b) * k).round() as u8;
        }
    }
    out
}

/// One byte per pixel from a coverage threshold.
pub fn binarise(coverage: &[u8], threshold: u8) -> Vec<u8> {
    coverage
        .iter()
        .map(|&c| if c >= threshold { 255 } else { 0 })
        .collect()
}

/// A CAF PREVIEW: the fill computed on a reduced copy when the canvas is
/// larger than `max_side`, cropped to the hole's box plus a margin.
pub struct Preview {
    /// The crop in CANVAS pixels.
    pub region: Region,
    /// The crop's pixels at the preview's resolution.
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// Preview px per canvas px (1 when not reduced).
    pub scale: f32,
}

fn box_down(px: &[u8], w: u32, h: u32, k: u32, channels: usize) -> (Vec<u8>, u32, u32) {
    let (nw, nh) = ((w / k).max(1), (h / k).max(1));
    let mut out = vec![0u8; (nw * nh) as usize * channels];
    for y in 0..nh {
        for x in 0..nw {
            let mut sum = vec![0u32; channels];
            let mut n = 0u32;
            for yy in y * k..((y + 1) * k).min(h) {
                for xx in x * k..((x + 1) * k).min(w) {
                    let i = (yy * w + xx) as usize * channels;
                    for c in 0..channels {
                        sum[c] += u32::from(px[i + c]);
                    }
                    n += 1;
                }
            }
            let o = (y * nw + x) as usize * channels;
            for c in 0..channels {
                out[o + c] = (sum[c] / n.max(1)) as u8;
            }
        }
    }
    (out, nw, nh)
}

fn mask_bbox(mask: &[u8], w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    let mut any = false;
    for y in 0..h {
        for x in 0..w {
            if mask[(y * w + x) as usize] != 0 {
                any = true;
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    any.then_some((x0, y0, x1, y1))
}

/// Compute a preview of the fill. `None` when the fill would refuse.
pub fn preview(
    rgba: &[u8],
    w: u32,
    h: u32,
    hole: &[u8],
    sample: &[u8],
    opts: &FillOptions,
    max_side: u32,
) -> Option<Preview> {
    let k = (w.max(h).div_ceil(max_side.max(64))).max(1);
    let (px, pw, ph, ph_hole, ph_sample) = if k > 1 {
        let (px, pw, ph) = box_down(rgba, w, h, k, 4);
        let (hm, _, _) = box_down(hole, w, h, k, 1);
        let (sm, _, _) = box_down(sample, w, h, k, 1);
        // Any hole in a block makes it hole; only a whole sampled block
        // samples (the search's own conventions at a coarser level).
        let hm: Vec<u8> = hm.iter().map(|&v| if v > 0 { 255 } else { 0 }).collect();
        let sm: Vec<u8> = sm.iter().map(|&v| if v == 255 { 255 } else { 0 }).collect();
        (px, pw, ph, hm, sm)
    } else {
        (rgba.to_vec(), w, h, hole.to_vec(), sample.to_vec())
    };
    let filled = patchmatch::fill_cpu(&px, pw, ph, &ph_hole, &ph_sample, opts)?;
    let (x0, y0, x1, y1) = mask_bbox(&ph_hole, pw, ph)?;
    let margin = ((x1 - x0 + 1).max(y1 - y0 + 1) / 2).max(8);
    let (cx0, cy0) = (x0.saturating_sub(margin), y0.saturating_sub(margin));
    let (cx1, cy1) = ((x1 + margin).min(pw - 1), (y1 + margin).min(ph - 1));
    let (cw, ch) = (cx1 - cx0 + 1, cy1 - cy0 + 1);
    let mut crop = Vec::with_capacity((cw * ch * 4) as usize);
    for y in cy0..=cy1 {
        let s = ((y * pw + cx0) * 4) as usize;
        crop.extend_from_slice(&filled[s..s + (cw * 4) as usize]);
    }
    Some(Preview {
        region: Region::new((cx0 * k) as i32, (cy0 * k) as i32, cw * k, ch * k),
        width: cw,
        height: ch,
        rgba: crop,
        scale: 1.0 / k as f32,
    })
}

// ───────────────────────── content-aware move ─────────────────────────

/// Move (the selection leaves a filled hole) or Extend (the source stays).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MoveMode {
    #[default]
    Move,
    Extend,
}

impl MoveMode {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "move" => Self::Move,
            "extend" => Self::Extend,
            _ => return None,
        })
    }
}

/// The Content-Aware Move tool's options (Photoshop's tool bar).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MoveOptions {
    pub mode: MoveMode,
    /// 1–7: how strictly the moved patch keeps its own structure at its
    /// edge (7 = only a 1-px seam is re-synthesised; 1 = a wide band).
    pub structure: u8,
    /// 0–10: how strongly the moved patch's tone adapts to its new place.
    pub colour: u8,
    /// Transform on drop: scale (1 = none) and rotation (degrees) about the
    /// selection's centre.
    pub scale: f32,
    pub angle_deg: f32,
    pub seed: u64,
}

impl Default for MoveOptions {
    fn default() -> Self {
        Self {
            mode: MoveMode::Move,
            structure: 4,
            colour: 4,
            scale: 1.0,
            angle_deg: 0.0,
            seed: 0x5EED_CAFE,
        }
    }
}

impl MoveOptions {
    fn fill_colour(&self) -> ColourAdaptation {
        match self.colour {
            0 => ColourAdaptation::None,
            1..=3 => ColourAdaptation::Default,
            4..=7 => ColourAdaptation::High,
            _ => ColourAdaptation::VeryHigh,
        }
    }
}

fn dilate(mask: &[u8], w: u32, h: u32, r: i32) -> Vec<u8> {
    if r <= 0 {
        return mask.to_vec();
    }
    let (wi, hi) = (w as i32, h as i32);
    let mut tmp = vec![0u8; mask.len()];
    for y in 0..hi {
        let mut last: i32 = -1_000_000;
        for x in 0..wi {
            if mask[(y * wi + x) as usize] != 0 {
                last = x;
            }
            if x - last <= r {
                tmp[(y * wi + x) as usize] = 255;
            }
        }
        let mut next: i32 = 1_000_000;
        for x in (0..wi).rev() {
            if mask[(y * wi + x) as usize] != 0 {
                next = x;
            }
            if next - x <= r {
                tmp[(y * wi + x) as usize] = 255;
            }
        }
    }
    let mut out = vec![0u8; mask.len()];
    for x in 0..wi {
        let mut last: i32 = -1_000_000;
        for y in 0..hi {
            if tmp[(y * wi + x) as usize] != 0 {
                last = y;
            }
            if y - last <= r {
                out[(y * wi + x) as usize] = 255;
            }
        }
        let mut next: i32 = 1_000_000;
        for y in (0..hi).rev() {
            if tmp[(y * wi + x) as usize] != 0 {
                next = y;
            }
            if next - y <= r {
                out[(y * wi + x) as usize] = 255;
            }
        }
    }
    out
}

fn erode(mask: &[u8], w: u32, h: u32, r: i32) -> Vec<u8> {
    let inv: Vec<u8> = mask.iter().map(|&m| if m == 0 { 255 } else { 0 }).collect();
    dilate(&inv, w, h, r)
        .into_iter()
        .map(|m| if m == 0 { 255 } else { 0 })
        .collect()
}

/// CONTENT-AWARE MOVE: move (or extend) the selected pixels by `(dx, dy)`
/// under the transform on drop, fill the hole they leave, adapt their tone
/// to the destination and re-synthesise the seam.
///
/// `coverage` is the selection (0–255 per pixel). Returns the new canvas,
/// or `None` when there is nothing selected, the move is the identity, or
/// the fill finds nothing to fill from.
pub fn content_aware_move(
    rgba: &[u8],
    w: u32,
    h: u32,
    coverage: &[u8],
    dx: f32,
    dy: f32,
    o: &MoveOptions,
) -> Option<Vec<u8>> {
    let n = (w as usize) * (h as usize);
    if rgba.len() < n * 4 || coverage.len() < n {
        return None;
    }
    let sel = binarise(coverage, 128);
    let (x0, y0, x1, y1) = mask_bbox(&sel, w, h)?;
    let scale = if o.scale.is_finite() && o.scale > 0.0 {
        o.scale.clamp(0.05, 20.0)
    } else {
        1.0
    };
    let angle = if o.angle_deg.is_finite() {
        o.angle_deg.to_radians()
    } else {
        0.0
    };
    if dx.round() == 0.0 && dy.round() == 0.0 && scale == 1.0 && angle == 0.0 {
        return None;
    }
    let (cx, cy) = ((x0 + x1) as f32 / 2.0, (y0 + y1) as f32 / 2.0);
    let (sn, cs) = angle.sin_cos();
    // Forward: q = c + d + s·R·(p − c). Inverse: p = c + R⁻¹(q − c − d)/s.
    let fwd = |px: f32, py: f32| {
        let (ux, uy) = (px - cx, py - cy);
        (
            cx + dx + scale * (cs * ux - sn * uy),
            cy + dy + scale * (sn * ux + cs * uy),
        )
    };
    let inv = |qx: f32, qy: f32| {
        let (ux, uy) = ((qx - cx - dx) / scale, (qy - cy - dy) / scale);
        (cx + cs * ux + sn * uy, cy - sn * ux + cs * uy)
    };
    // The destination's box: the transformed corners.
    let corners = [
        fwd(x0 as f32, y0 as f32),
        fwd(x1 as f32 + 1.0, y0 as f32),
        fwd(x0 as f32, y1 as f32 + 1.0),
        fwd(x1 as f32 + 1.0, y1 as f32 + 1.0),
    ];
    let qx0 = corners
        .iter()
        .map(|c| c.0)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let qy0 = corners
        .iter()
        .map(|c| c.1)
        .fold(f32::INFINITY, f32::min)
        .floor()
        .max(0.0) as u32;
    let qx1 = (corners
        .iter()
        .map(|c| c.0)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil() as i64)
        .clamp(0, i64::from(w) - 1) as u32;
    let qy1 = (corners
        .iter()
        .map(|c| c.1)
        .fold(f32::NEG_INFINITY, f32::max)
        .ceil() as i64)
        .clamp(0, i64::from(h) - 1) as u32;

    // The moved layer: colour and coverage at each destination pixel.
    let mut moved = vec![0u8; n * 4];
    let mut arrive = vec![0u8; n];
    if qx0 <= qx1 && qy0 <= qy1 {
        for qy in qy0..=qy1 {
            for qx in qx0..=qx1 {
                let (px, py) = inv(qx as f32, qy as f32);
                let (ix, iy) = (px.round() as i64, py.round() as i64);
                if ix < 0 || iy < 0 || ix >= i64::from(w) || iy >= i64::from(h) {
                    continue;
                }
                let si = (iy as usize) * w as usize + ix as usize;
                let cov = coverage[si];
                if cov == 0 {
                    continue;
                }
                let qi = (qy * w + qx) as usize;
                let v = crate::clone_source::sample_rgba8(rgba, w, h, px, py);
                moved[qi * 4..qi * 4 + 4].copy_from_slice(&v);
                arrive[qi] = cov;
            }
        }
    }
    let dest = binarise(&arrive, 128);

    // 1. MOVE leaves a hole: fill it from everything that will remain
    //    (not the selection, not where the moved pixels will land). The
    //    hole is grown by a pixel so an antialiased rim does not survive
    //    as a ghost outline.
    let mut out = rgba.to_vec();
    let fill_opts = FillOptions {
        colour: o.fill_colour(),
        rotation: RotationAdaptation::None,
        scale: false,
        mirror: false,
        seed: o.seed,
    };
    if o.mode == MoveMode::Move {
        let hole = dilate(&sel, w, h, 1);
        let hole: Vec<u8> = hole
            .iter()
            .zip(&dest)
            .map(|(&hh, &d)| if hh != 0 && d == 0 { 255 } else { 0 })
            .collect();
        if hole.iter().any(|&b| b != 0) {
            let avoid = dilate(&dest, w, h, 1);
            let sample: Vec<u8> = (0..n)
                .map(|i| {
                    if hole[i] == 0 && avoid[i] == 0 && rgba[i * 4 + 3] != 0 {
                        255
                    } else {
                        0
                    }
                })
                .collect();
            out = patchmatch::fill_cpu(&out, w, h, &hole, &sample, &fill_opts)?;
        }
    }

    // 2. TONE: the moved pixels take on the destination's tone, by the
    //    healing membrane over the destination's box, scaled by `colour`.
    let before = out.clone();
    for i in 0..n {
        let a = u32::from(arrive[i]);
        if a == 0 {
            continue;
        }
        for c in 0..4 {
            let b = u32::from(out[i * 4 + c]);
            let m = u32::from(moved[i * 4 + c]);
            out[i * 4 + c] = ((b * (255 - a) + m * a + 127) / 255) as u8;
        }
    }
    if o.colour > 0 && qx0 <= qx1 && qy0 <= qy1 {
        let margin = 4u32;
        let bx0 = qx0.saturating_sub(margin);
        let by0 = qy0.saturating_sub(margin);
        let bx1 = (qx1 + margin).min(w - 1);
        let by1 = (qy1 + margin).min(h - 1);
        let (bw, bh) = ((bx1 - bx0 + 1) as usize, (by1 - by0 + 1) as usize);
        let mut dwin = vec![0u8; bw * bh * 4];
        let mut swin = vec![0u8; bw * bh * 4];
        let mut inside = vec![0u8; bw * bh];
        let core = erode(&dest, w, h, 1);
        for y in 0..bh {
            for x in 0..bw {
                let gi = (by0 as usize + y) * w as usize + bx0 as usize + x;
                let li = y * bw + x;
                dwin[li * 4..li * 4 + 4].copy_from_slice(&before[gi * 4..gi * 4 + 4]);
                swin[li * 4..li * 4 + 4].copy_from_slice(&out[gi * 4..gi * 4 + 4]);
                if core[gi] != 0 {
                    inside[li] = 255;
                } else if dest[gi] != 0 {
                    // The rim pixel's own mismatch is the boundary value.
                    swin[li * 4..li * 4 + 4].copy_from_slice(&moved[gi * 4..gi * 4 + 4]);
                }
            }
        }
        if let Some(field) = crate::heal::correction_field(&dwin, &swin, &inside, bw, bh) {
            let k = f32::from(o.colour.min(10)) / 10.0;
            for y in 0..bh {
                for x in 0..bw {
                    let gi = (by0 as usize + y) * w as usize + bx0 as usize + x;
                    if dest[gi] == 0 {
                        continue;
                    }
                    let li = y * bw + x;
                    for c in 0..3 {
                        let v = f32::from(out[gi * 4 + c]) + field[li * 3 + c] * 255.0 * k;
                        out[gi * 4 + c] = v.round().clamp(0.0, 255.0) as u8;
                    }
                }
            }
        }
    }

    // 3. THE SEAM: a band across the destination's edge is re-synthesised
    //    from everything else, so the patch's structure meets the
    //    destination's. Structure 7 keeps all but a 1-px seam; 1 rebuilds a
    //    band seven times as wide (scaled with the patch's size).
    let size_k = ((qx1.saturating_sub(qx0)).max(qy1.saturating_sub(qy0)) / 64).max(1) as i32;
    let band = (8 - i32::from(o.structure.clamp(1, 7))) * size_k;
    let outer = dilate(&dest, w, h, (band + 1) / 2);
    let inner = erode(&dest, w, h, band / 2 + 1);
    let seam: Vec<u8> = (0..n)
        .map(|i| {
            if outer[i] != 0 && inner[i] == 0 {
                255
            } else {
                0
            }
        })
        .collect();
    if seam.iter().any(|&b| b != 0) {
        let sample: Vec<u8> = (0..n)
            .map(|i| {
                if seam[i] == 0 && out[i * 4 + 3] != 0 {
                    255
                } else {
                    0
                }
            })
            .collect();
        if let Some(blended) = patchmatch::fill_cpu(&out, w, h, &seam, &sample, &fill_opts) {
            out = blended;
        }
    }
    Some(out)
}

// ─────────────────────────────── remove ───────────────────────────────

/// The Remove tool's stroke as a hole: discs of `size` diameter along the
/// polyline `points` (x, y pairs, image px), grown by two pixels so the
/// object's soft edge goes with it.
pub fn stroke_hole(w: u32, h: u32, points: &[f32], size: f32) -> Vec<u8> {
    let n = (w as usize) * (h as usize);
    let mut hole = vec![0u8; n];
    let r = (size.max(1.0) / 2.0) + 2.0;
    let stamp = |hole: &mut Vec<u8>, cx: f32, cy: f32| {
        let (x0, y0) = (
            ((cx - r).floor() as i64).max(0),
            ((cy - r).floor() as i64).max(0),
        );
        let (x1, y1) = (
            ((cx + r).ceil() as i64).min(i64::from(w) - 1),
            ((cy + r).ceil() as i64).min(i64::from(h) - 1),
        );
        for y in y0..=y1 {
            for x in x0..=x1 {
                let (ddx, ddy) = (x as f32 - cx, y as f32 - cy);
                if ddx * ddx + ddy * ddy <= r * r {
                    hole[(y as usize) * w as usize + x as usize] = 255;
                }
            }
        }
    };
    let pts: Vec<(f32, f32)> = points
        .as_chunks::<2>()
        .0
        .iter()
        .filter(|p| p[0].is_finite() && p[1].is_finite())
        .map(|p| (p[0], p[1]))
        .collect();
    for (i, &(x, y)) in pts.iter().enumerate() {
        stamp(&mut hole, x, y);
        if let Some(&(nx, ny)) = pts.get(i + 1) {
            let len = ((nx - x).powi(2) + (ny - y).powi(2)).sqrt();
            let steps = (len / (r * 0.5).max(1.0)).ceil() as usize;
            for s in 1..steps {
                let t = s as f32 / steps as f32;
                stamp(&mut hole, x + (nx - x) * t, y + (ny - y) * t);
            }
        }
    }
    hole
}

/// REMOVE: fill the stroke's hole from its surroundings (the automatic
/// sampling area), with Default colour adaptation. `None` when the stroke
/// covers nothing or there is nothing to fill from.
pub fn remove(rgba: &[u8], w: u32, h: u32, hole: &[u8], seed: u64) -> Option<Vec<u8>> {
    let sample = patchmatch::sampling_area(rgba, w, h, hole, SamplingArea::Auto);
    patchmatch::fill_cpu(
        rgba,
        w,
        h,
        hole,
        &sample,
        &FillOptions {
            seed,
            ..FillOptions::default()
        },
    )
}

// ───────────────────────────── spot healing ─────────────────────────────

/// The spot healing brush's CONTENT-AWARE and CREATE-TEXTURE sources over
/// a window: the window with its hole synthesised. Content-aware samples
/// the window around the hole; create-texture samples only a ring around
/// it (twice the stroke's extent, at least 24 px), at any orientation and mirrored — texture
/// without the surroundings' structure. `None` when nothing can be
/// synthesised.
pub fn spot_source(
    window: &[u8],
    w: u32,
    h: u32,
    hole: &[u8],
    kind: crate::clone_source::SpotType,
) -> Option<Vec<u8>> {
    use crate::clone_source::SpotType;
    match kind {
        SpotType::ProximityMatch => None,
        SpotType::ContentAware => {
            let sample: Vec<u8> = hole.iter().map(|&m| if m == 0 { 255 } else { 0 }).collect();
            patchmatch::fill_cpu(window, w, h, hole, &sample, &FillOptions::default())
        }
        SpotType::CreateTexture => {
            let (x0, y0, x1, y1) = mask_bbox(hole, w, h)?;
            // Wide enough to hold a rotated patch's whole window (≈ 13 px).
            let reach = (2 * (x1 - x0 + 1).max(y1 - y0 + 1) as i32).max(24);
            let ring = dilate(hole, w, h, reach);
            let sample: Vec<u8> = (0..hole.len())
                .map(|i| if ring[i] != 0 && hole[i] == 0 { 255 } else { 0 })
                .collect();
            patchmatch::fill_cpu(
                window,
                w,
                h,
                hole,
                &sample,
                &FillOptions {
                    rotation: RotationAdaptation::Full,
                    mirror: true,
                    ..FillOptions::default()
                },
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let c = f(x, y);
                v.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        v
    }

    fn rect(w: u32, h: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> Vec<u8> {
        let mut d = vec![0u8; (w * h) as usize];
        for y in y0..y1 {
            for x in x0..x1 {
                d[(y * w + x) as usize] = 255;
            }
        }
        d
    }

    fn texture(x: u32, y: u32) -> [u8; 3] {
        let v = 90 + ((x * 13 + y * 7) % 9) as u8 * 4;
        [v, v, v]
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_move_relocates_the_object_and_fills_where_it_was__feat__image_editor_content_aware_move() {
        let (w, h) = (128u32, 80u32);
        // A red square object on a grey texture.
        let src = img(w, h, |x, y| {
            if (20..36).contains(&x) && (30..46).contains(&y) {
                [220, 30, 30]
            } else {
                texture(x, y)
            }
        });
        let sel = rect(w, h, 18, 28, 38, 48);
        let out = content_aware_move(&src, w, h, &sel, 60.0, 0.0, &MoveOptions::default())
            .expect("moved");
        let red = |px: &[u8], x: u32, y: u32| {
            let i = ((y * w + x) * 4) as usize;
            px[i] > 150 && px[i + 1] < 90
        };
        // The object arrived (its middle survives the seam band).
        assert!(red(&out, 88, 38), "the object is at its destination");
        // And it is gone from where it was: no red left there.
        let mut left = 0;
        for y in 28..48 {
            for x in 18..38 {
                if red(&out, x, y) {
                    left += 1;
                }
            }
        }
        assert_eq!(left, 0, "{left} red pixels remain at the origin");
    }

    #[test]
    #[allow(non_snake_case)]
    fn extend_keeps_the_original__feat__image_editor_content_aware_move() {
        let (w, h) = (128u32, 80u32);
        let src = img(w, h, |x, y| {
            if (20..36).contains(&x) && (30..46).contains(&y) {
                [220, 30, 30]
            } else {
                texture(x, y)
            }
        });
        let sel = rect(w, h, 18, 28, 38, 48);
        let out = content_aware_move(
            &src,
            w,
            h,
            &sel,
            60.0,
            0.0,
            &MoveOptions {
                mode: MoveMode::Extend,
                ..MoveOptions::default()
            },
        )
        .expect("extended");
        let i = ((38 * w + 28) * 4) as usize;
        assert_eq!(
            &out[i..i + 4],
            &src[i..i + 4],
            "the source stays where it was"
        );
        let j = ((38 * w + 88) * 4) as usize;
        assert!(out[j] > 150, "and a copy arrives");
    }

    #[test]
    #[allow(non_snake_case)]
    fn transform_on_drop_scales_the_moved_pixels__feat__image_editor_content_aware_move() {
        let (w, h) = (160u32, 96u32);
        let src = img(w, h, |x, y| {
            if (20..36).contains(&x) && (30..46).contains(&y) {
                [220, 30, 30]
            } else {
                texture(x, y)
            }
        });
        let sel = rect(w, h, 18, 28, 38, 48);
        let out = content_aware_move(
            &src,
            w,
            h,
            &sel,
            80.0,
            0.0,
            &MoveOptions {
                scale: 2.0,
                structure: 7,
                ..MoveOptions::default()
            },
        )
        .expect("moved");
        // The doubled square spans ~32 px around (108, 38): red well beyond
        // the original half-width of 8.
        let i = ((38 * w + 108 + 12) * 4) as usize;
        assert!(out[i] > 150 && out[i + 1] < 90, "scaled up on drop");
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_move_with_nothing_selected_or_no_offset_is_none__feat__image_editor_content_aware_move() {
        let (w, h) = (32u32, 32u32);
        let src = img(w, h, texture);
        let none = vec![0u8; (w * h) as usize];
        assert!(content_aware_move(&src, w, h, &none, 5.0, 0.0, &MoveOptions::default()).is_none());
        let sel = rect(w, h, 8, 8, 12, 12);
        assert!(content_aware_move(&src, w, h, &sel, 0.2, -0.3, &MoveOptions::default()).is_none());
    }

    #[test]
    #[allow(non_snake_case)]
    fn remove_erases_a_stroked_object_from_a_texture__feat__image_editor_content_aware_move() {
        let (w, h) = (96u32, 64u32);
        let truth = img(w, h, texture);
        let mut src = truth.clone();
        // A dark diagonal scratch.
        for t in 0..30 {
            let (x, y) = (30 + t, 20 + t / 2);
            for d in 0..3 {
                let i = (((y + d) * w + x) * 4) as usize;
                src[i..i + 3].copy_from_slice(&[10, 10, 10]);
            }
        }
        let hole = stroke_hole(w, h, &[30.0, 21.0, 60.0, 36.0], 4.0);
        let out = remove(&src, w, h, &hole, 1).expect("removed");
        let mut dark = 0;
        for (i, &m) in hole.iter().enumerate() {
            if m != 0 && out[i * 4] < 60 {
                dark += 1;
            }
        }
        assert_eq!(dark, 0, "the scratch is gone");
    }

    #[test]
    #[allow(non_snake_case)]
    fn spot_types_synthesise_or_defer__feat__image_editor_spot_heal() {
        use crate::clone_source::SpotType;
        let (w, h) = (64u32, 64u32);
        let mut src = img(w, h, texture);
        let hole = rect(w, h, 28, 28, 36, 36);
        for (i, &m) in hole.iter().enumerate() {
            if m != 0 {
                src[i * 4..i * 4 + 3].copy_from_slice(&[0, 0, 0]);
            }
        }
        for kind in [SpotType::ContentAware, SpotType::CreateTexture] {
            let out = spot_source(&src, w, h, &hole, kind).expect("synthesised");
            for (i, &m) in hole.iter().enumerate() {
                if m != 0 {
                    assert!(out[i * 4] >= 80, "{kind:?}: the blemish is replaced");
                }
            }
        }
        assert!(spot_source(&src, w, h, &hole, SpotType::ProximityMatch).is_none());
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_preview_is_a_reduced_crop_around_the_hole__feat__image_editor_content_aware_move() {
        let (w, h) = (512u32, 256u32);
        let src = img(w, h, texture);
        let hole = rect(w, h, 200, 100, 260, 160);
        let sample = sampling_mask(&src, w, h, &hole, &Sampling::Auto);
        let p = preview(&src, w, h, &hole, &sample, &FillOptions::default(), 128).expect("preview");
        assert!(p.scale < 1.0, "reduced");
        assert_eq!(p.rgba.len() as u32, p.width * p.height * 4);
        assert!(p.region.x <= 200 && p.region.right() >= 260);
        let full =
            preview(&src, w, h, &hole, &sample, &FillOptions::default(), 4096).expect("full");
        assert_eq!(full.scale, 1.0);
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_overlay_tints_only_the_sampling_area__feat__image_editor_content_aware_move() {
        let rgba = vec![100u8, 100, 100, 255, 100, 100, 100, 255];
        let out = sampling_overlay(&rgba, &[255, 0], [0, 200, 0], 0.5);
        assert_eq!(&out[0..4], &[50, 150, 50, 255]);
        assert_eq!(&out[4..8], &[100, 100, 100, 255]);
        let custom = sampling_mask(&rgba, 2, 1, &[0, 255], &Sampling::Custom(&[255, 255]));
        assert_eq!(
            custom,
            vec![255, 0],
            "a painted area never includes the hole"
        );
    }
}
