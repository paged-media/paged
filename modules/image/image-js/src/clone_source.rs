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

//! THE CLONE SOURCE — what the clone stamp, the healing brush and the spot
//! healing brush read from (Photoshop's Clone Source panel).
//!
//! * **Sample**: the current layer (the stroke's own base), the current
//!   layer and everything below it, or every visible layer. The two
//!   composite modes hand the stroke a canvas-sized composite; the stroke
//!   still PAINTS the active layer — which is how retouching onto an empty
//!   layer above the photo works.
//! * **Transform**: the source is read through `M = R(angle) · S(w, h)`,
//!   so a copy can be scaled, rotated and flipped (a negative width or
//!   height is a flip). The destination anchor is where the stroke's first
//!   dab lands (or the anchor plus a typed offset); a dab at `p` reads the
//!   source at `anchor + M·(p − destination anchor)`. Identity reads stay
//!   integer copies, exactly as before.
//! * **Overlay**: the transformed source shown over the image under the
//!   cursor, at an opacity, optionally clipped to the brush and inverted.
//! * **Diffusion** (healing): how far the tone correction spreads from the
//!   dab's edge into it (`crate::heal::correction_field_diffused`).
//! * **Spot type** (spot healing): content-aware, create texture or
//!   proximity match.
//!
//! Building the source window is input preparation on the CPU (a copy, or
//! a bilinear read under the transform); the composite that lands it is
//! the stroke's registered `PaintMode::Sample` dispatch, as it always was.

use std::sync::Arc;

use image_core::Region;

/// Which pixels a sampling tool reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SampleMode {
    /// The active layer (the stroke's own base).
    #[default]
    Current,
    /// The active layer composited over everything below it.
    CurrentAndBelow,
    /// Every visible layer.
    All,
}

impl SampleMode {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "current" => Self::Current,
            "below" | "current-and-below" => Self::CurrentAndBelow,
            "all" => Self::All,
            _ => return None,
        })
    }
}

/// The spot healing brush's three ways of finding replacement pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SpotType {
    /// Synthesise the stroke area from its surroundings (PatchMatch), then
    /// heal its tone.
    #[default]
    ContentAware,
    /// Fill the stroke area with texture synthesised from a ring around it,
    /// any orientation — texture without structure.
    CreateTexture,
    /// Copy one nearby offset (the exemplar search's most frequent shift)
    /// and heal it — the spot healing brush as it first shipped.
    ProximityMatch,
}

impl SpotType {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "content-aware" => Self::ContentAware,
            "create-texture" => Self::CreateTexture,
            "proximity" | "proximity-match" => Self::ProximityMatch,
            _ => return None,
        })
    }
}

/// Scale (signed: negative = flipped) and rotation of the clone source.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CloneTransform {
    pub scale_x: f32,
    pub scale_y: f32,
    pub angle_deg: f32,
}

impl Default for CloneTransform {
    fn default() -> Self {
        Self {
            scale_x: 1.0,
            scale_y: 1.0,
            angle_deg: 0.0,
        }
    }
}

impl CloneTransform {
    /// Sanitised: a zero (or non-finite) scale would collapse the source
    /// to a point, so it is held to ±1 % … ±400 %, sign kept.
    pub fn new(scale_x: f32, scale_y: f32, angle_deg: f32) -> Self {
        let s = |v: f32| {
            if !v.is_finite() || v == 0.0 {
                1.0
            } else {
                v.signum() * v.abs().clamp(0.01, 4.0)
            }
        };
        Self {
            scale_x: s(scale_x),
            scale_y: s(scale_y),
            angle_deg: if angle_deg.is_finite() {
                angle_deg
            } else {
                0.0
            },
        }
    }

    pub fn is_identity(&self) -> bool {
        self.scale_x == 1.0 && self.scale_y == 1.0 && self.angle_deg.rem_euclid(360.0) == 0.0
    }

    /// `M = R(angle) · S(scale_x, scale_y)`, row-major: a destination
    /// offset `d` from the destination anchor reads the source at
    /// `anchor + M·d`.
    pub fn matrix(&self) -> [f32; 4] {
        let (s, c) = self.angle_deg.to_radians().sin_cos();
        [
            c * self.scale_x,
            -s * self.scale_y,
            s * self.scale_x,
            c * self.scale_y,
        ]
    }
}

/// Everything the sampling tools add to a stroke besides its anchor.
#[derive(Clone, Debug, Default)]
pub struct Sampling {
    /// The canvas the source window reads (a composite for the layered
    /// sample modes); `None` reads the stroke's own base.
    pub pixels: Option<Arc<[u8]>>,
    pub transform: CloneTransform,
    /// Healing diffusion 1–7; `None` is the pure membrane (7).
    pub diffusion: Option<u8>,
    pub spot: SpotType,
}

fn tap(src: &[u8], w: u32, h: u32, x: i64, y: i64) -> [f32; 4] {
    if x < 0 || y < 0 || x >= i64::from(w) || y >= i64::from(h) {
        return [0.0; 4];
    }
    let i = ((y as usize) * w as usize + x as usize) * 4;
    [
        f32::from(src[i]),
        f32::from(src[i + 1]),
        f32::from(src[i + 2]),
        f32::from(src[i + 3]),
    ]
}

/// A bilinear read of straight RGBA8 at a real position; outside the canvas
/// is transparent black (the clone stamp's rule: copying from nowhere copies
/// nothing). Each tap is weighted by its alpha so a transparent neighbour
/// does not darken an edge.
pub fn sample_rgba8(src: &[u8], w: u32, h: u32, x: f32, y: f32) -> [u8; 4] {
    let (fx, fy) = (x.floor(), y.floor());
    let (tx, ty) = (x - fx, y - fy);
    let (ix, iy) = (fx as i64, fy as i64);
    let taps = [
        (tap(src, w, h, ix, iy), (1.0 - tx) * (1.0 - ty)),
        (tap(src, w, h, ix + 1, iy), tx * (1.0 - ty)),
        (tap(src, w, h, ix, iy + 1), (1.0 - tx) * ty),
        (tap(src, w, h, ix + 1, iy + 1), tx * ty),
    ];
    let mut rgb = [0f32; 3];
    let mut a = 0f32;
    for (p, wt) in taps {
        let pa = p[3] * wt;
        for c in 0..3 {
            rgb[c] += p[c] * pa;
        }
        a += pa;
    }
    if a <= 0.0 {
        return [0; 4];
    }
    [
        (rgb[0] / a).round().clamp(0.0, 255.0) as u8,
        (rgb[1] / a).round().clamp(0.0, 255.0) as u8,
        (rgb[2] / a).round().clamp(0.0, 255.0) as u8,
        a.round().clamp(0.0, 255.0) as u8,
    ]
}

/// The SOURCE WINDOW for `region` of a sampling stroke: what each pixel of
/// the region reads, as tightly packed straight RGBA8.
///
/// `offset` is `source anchor − destination anchor`. With the identity
/// transform this is the integer shifted copy the clone stamp always made
/// (bit-exact); otherwise each pixel reads `anchor + M·(p − (anchor −
/// offset))` bilinearly.
pub fn source_window(
    src: &[u8],
    w: u32,
    h: u32,
    region: Region,
    anchor: (f32, f32),
    offset: (f32, f32),
    t: &CloneTransform,
) -> Vec<u8> {
    let (rw, rh) = (region.w as usize, region.h as usize);
    let mut out = vec![0u8; rw * rh * 4];
    if t.is_identity() {
        let (dx, dy) = (offset.0.round() as i64, offset.1.round() as i64);
        for y in 0..rh {
            let sy = i64::from(region.y) + y as i64 + dy;
            if sy < 0 || sy >= i64::from(h) {
                continue;
            }
            for x in 0..rw {
                let sx = i64::from(region.x) + x as i64 + dx;
                if sx < 0 || sx >= i64::from(w) {
                    continue;
                }
                let si = ((sy as usize) * w as usize + sx as usize) * 4;
                let di = (y * rw + x) * 4;
                out[di..di + 4].copy_from_slice(&src[si..si + 4]);
            }
        }
        return out;
    }
    let m = t.matrix();
    let (ax, ay) = anchor;
    let (dax, day) = (anchor.0 - offset.0, anchor.1 - offset.1);
    for y in 0..rh {
        for x in 0..rw {
            // Pixel centres: the transform pivots on the anchor pixel's
            // centre, so a 1:1 transform reads exactly what the integer copy
            // does.
            let px = region.x as f32 + x as f32 - dax;
            let py = region.y as f32 + y as f32 - day;
            let sx = ax + m[0] * px + m[1] * py;
            let sy = ay + m[2] * px + m[3] * py;
            let v = sample_rgba8(src, w, h, sx, sy);
            let di = (y * rw + x) * 4;
            out[di..di + 4].copy_from_slice(&v);
        }
    }
    out
}

/// The CLONE SOURCE OVERLAY: `base` with the transformed source shown over
/// it at `opacity`, as if a stroke started at `cursor` (or at the typed
/// `offset` when one is set). `clip` restricts it to a circle of that
/// radius around the cursor (Photoshop's "Clipped"); `invert` shows the
/// source's colours inverted (to line up edges). Returns the whole canvas.
#[allow(clippy::too_many_arguments)]
pub fn overlay(
    base: &[u8],
    src: &[u8],
    w: u32,
    h: u32,
    cursor: (f32, f32),
    anchor: (f32, f32),
    offset: Option<(f32, f32)>,
    t: &CloneTransform,
    opacity: f32,
    invert: bool,
    clip: Option<f32>,
) -> Vec<u8> {
    let mut out = base.to_vec();
    let opacity = opacity.clamp(0.0, 1.0);
    if opacity == 0.0 {
        return out;
    }
    let off = offset.unwrap_or((anchor.0 - cursor.0, anchor.1 - cursor.1));
    let (x0, y0, x1, y1) = match clip {
        Some(r) => (
            ((cursor.0 - r).floor() as i64).max(0),
            ((cursor.1 - r).floor() as i64).max(0),
            ((cursor.0 + r).ceil() as i64).min(i64::from(w) - 1),
            ((cursor.1 + r).ceil() as i64).min(i64::from(h) - 1),
        ),
        None => (0, 0, i64::from(w) - 1, i64::from(h) - 1),
    };
    if x1 < x0 || y1 < y0 {
        return out;
    }
    let region = Region::new(
        x0 as i32,
        y0 as i32,
        (x1 - x0 + 1) as u32,
        (y1 - y0 + 1) as u32,
    );
    let win = source_window(src, w, h, region, anchor, off, t);
    let rw = region.w as usize;
    for y in y0..=y1 {
        for x in x0..=x1 {
            if let Some(r) = clip {
                let (dx, dy) = (x as f32 - cursor.0, y as f32 - cursor.1);
                if dx * dx + dy * dy > r * r {
                    continue;
                }
            }
            let wi = (((y - y0) as usize) * rw + (x - x0) as usize) * 4;
            let s = &win[wi..wi + 4];
            let k = opacity * f32::from(s[3]) / 255.0;
            if k == 0.0 {
                continue;
            }
            let o = ((y as usize) * w as usize + x as usize) * 4;
            for c in 0..3 {
                let sv = if invert { 255 - s[c] } else { s[c] };
                let b = f32::from(out[o + c]);
                out[o + c] = (b + (f32::from(sv) - b) * k).round() as u8;
            }
            let ba = f32::from(out[o + 3]);
            out[o + 3] = (ba + (255.0 - ba) * k).round() as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::new();
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&[(x * 4) as u8, (y * 4) as u8, 100, 255]);
            }
        }
        v
    }

    #[test]
    #[allow(non_snake_case)]
    fn an_identity_transform_is_the_integer_copy__feat__image_editor_clone_stamp() {
        let src = ramp(32, 32);
        let r = Region::new(4, 4, 6, 6);
        let a = source_window(
            &src,
            32,
            32,
            r,
            (20.0, 20.0),
            (10.0, 3.0),
            &CloneTransform::default(),
        );
        // Pixel (4,4) reads (14,7).
        assert_eq!(&a[0..4], &[56, 28, 100, 255]);
        // Off canvas reads transparent.
        let off = source_window(
            &src,
            32,
            32,
            r,
            (0.0, 0.0),
            (-20.0, 0.0),
            &CloneTransform::default(),
        );
        assert!(off.iter().all(|&b| b == 0));
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_flipped_source_reads_mirrored_about_the_anchor__feat__image_editor_clone_stamp() {
        let src = ramp(32, 32);
        let t = CloneTransform::new(-1.0, 1.0, 0.0);
        // Destination anchor (8, 8) maps to source anchor (20, 20); one
        // pixel right of the destination anchor reads one pixel LEFT of the
        // source anchor.
        let r = Region::new(9, 8, 1, 1);
        let v = source_window(&src, 32, 32, r, (20.0, 20.0), (12.0, 12.0), &t);
        assert_eq!(v[0], 19 * 4);
        assert_eq!(v[1], 20 * 4);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_half_scale_source_reads_at_half_the_distance__feat__image_editor_clone_stamp() {
        let src = ramp(64, 64);
        let t = CloneTransform::new(0.5, 0.5, 0.0);
        // Four pixels right of the destination anchor reads two right of
        // the source anchor.
        let r = Region::new(14, 10, 1, 1);
        let v = source_window(&src, 64, 64, r, (30.0, 30.0), (20.0, 20.0), &t);
        assert_eq!(v[0], 32 * 4);
        assert_eq!(v[1], 30 * 4);
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_quarter_turn_reads_rotated__feat__image_editor_clone_stamp() {
        let src = ramp(64, 64);
        let t = CloneTransform::new(1.0, 1.0, 90.0);
        // d = (3, 0) → M·d = (0, 3).
        let r = Region::new(13, 10, 1, 1);
        let v = source_window(&src, 64, 64, r, (30.0, 30.0), (20.0, 20.0), &t);
        assert_eq!(v[0], 30 * 4);
        assert_eq!(v[1], 33 * 4);
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_overlay_shows_the_source_at_its_opacity_and_respects_the_clip__feat__image_editor_clone_stamp(
    ) {
        let (w, h) = (32u32, 32u32);
        let base = vec![0u8; (w * h * 4) as usize]
            .chunks(4)
            .flat_map(|_| [0u8, 0, 0, 255])
            .collect::<Vec<u8>>();
        let src: Vec<u8> = (0..w * h).flat_map(|_| [200u8, 200, 200, 255]).collect();
        let o = overlay(
            &base,
            &src,
            w,
            h,
            (16.0, 16.0),
            (16.0, 16.0),
            None,
            &CloneTransform::default(),
            0.5,
            false,
            Some(4.0),
        );
        let at = |v: &[u8], x: u32, y: u32| v[((y * w + x) * 4) as usize];
        assert_eq!(at(&o, 16, 16), 100, "half of the source over black");
        assert_eq!(at(&o, 2, 2), 0, "outside the clip the image shows as it is");
        let inv = overlay(
            &base,
            &src,
            w,
            h,
            (16.0, 16.0),
            (16.0, 16.0),
            None,
            &CloneTransform::default(),
            1.0,
            true,
            None,
        );
        assert_eq!(at(&inv, 2, 2), 55, "inverted, unclipped");
    }

    #[test]
    fn transforms_are_sanitised() {
        let t = CloneTransform::new(0.0, f32::NAN, f32::INFINITY);
        assert!(t.is_identity());
        assert_eq!(CloneTransform::new(-9.0, 1.0, 0.0).scale_x, -4.0);
        assert_eq!(SampleMode::from_wire("all"), Some(SampleMode::All));
        assert_eq!(
            SpotType::from_wire("proximity"),
            Some(SpotType::ProximityMatch)
        );
        assert_eq!(SpotType::from_wire("nope"), None);
    }
}
