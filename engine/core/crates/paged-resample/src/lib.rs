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

//! CPU resampling of straight-alpha RGBA8 rasters (image ADR 467).
//!
//! Two operations, both pure Rust, single-threaded and deterministic (the
//! same input gives the same bytes on a platform; the only transcendental
//! is the Lanczos `sin`, evaluated in f64, so platforms agree after the
//! 8-bit round):
//!
//! - [`resize_rgba8`] — a separable resize, Lanczos-3 (the default) or
//!   bilinear.
//! - [`rotate_crop_rgba8`] — a straightened crop: the picture turned
//!   about the crop rectangle's centre and the rectangle cut out,
//!   bilinear.
//!
//! # Coordinate model
//!
//! The model of paged.image's GPU kernels (`resample.*`,
//! `geom.rotate_bilinear`), so the two backends sample the same points:
//! output pixel `o` on an axis samples the continuous source coordinate
//! `s = (o + 0.5) · inv − 0.5` with `inv = src / dst`. A tap `i` weighs
//! `k((s − i) / f)`, where `f = max(inv, 1)` is the filter scale: 1 when
//! enlarging, the shrink factor when reducing, so a reduction averages
//! every source pixel it passes over instead of point-sampling (no
//! aliasing). Unlike the GPU kernels the scale is not capped. Taps outside
//! the picture repeat its edge pixel (clamp-to-edge), and the weights of
//! each output pixel are normalised to sum to one. An axis whose size does
//! not change is copied, so a resize to the same size is the identity.
//!
//! # Alpha
//!
//! Filtering runs on premultiplied values (`c · a / 255`), so a colour
//! beside a transparent pixel keeps its hue instead of being darkened
//! towards the transparent pixel's (usually black) colour. The result is
//! un-premultiplied and rounded; a pixel whose alpha rounds to 0 is
//! `0, 0, 0, 0`. Lanczos' negative lobes are clamped: alpha to `[0, 255]`,
//! each premultiplied colour to `[0, alpha]`.
//!
//! Colour values are filtered as they are stored (sRGB-encoded), as the
//! GPU kernels filter them.

#![forbid(unsafe_code)]

use std::fmt;

/// The reconstruction filter of a resize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Filter {
    /// The tent `max(0, 1 − |t|)`, support 1: bilinear when enlarging, an
    /// area-weighted average when reducing.
    Bilinear,
    /// `sinc(t) · sinc(t / 3)` for `|t| < 3`, support 3. The default.
    #[default]
    Lanczos3,
}

impl Filter {
    /// The filter by name: `"bilinear"` or `"lanczos3"`.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "bilinear" => Some(Self::Bilinear),
            "lanczos3" => Some(Self::Lanczos3),
            _ => None,
        }
    }

    /// The name [`Filter::parse`] reads.
    pub fn name(self) -> &'static str {
        match self {
            Self::Bilinear => "bilinear",
            Self::Lanczos3 => "lanczos3",
        }
    }

    fn support(self) -> f64 {
        match self {
            Self::Bilinear => 1.0,
            Self::Lanczos3 => 3.0,
        }
    }

    fn weight(self, t: f64) -> f64 {
        let x = t.abs();
        match self {
            Self::Bilinear => (1.0 - x).max(0.0),
            Self::Lanczos3 => {
                if x < 3.0 {
                    sinc(t) * sinc(t / 3.0)
                } else {
                    0.0
                }
            }
        }
    }
}

fn sinc(u: f64) -> f64 {
    if u == 0.0 {
        1.0
    } else {
        let pu = std::f64::consts::PI * u;
        pu.sin() / pu
    }
}

/// The largest picture either operation writes, in pixels (16384²): the
/// output is allocated whole, and a wasm32 realm has 4 GB at most.
pub const MAX_PIXELS: u64 = 1 << 28;

/// Why a resample was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResampleError {
    /// A source or target dimension is 0.
    Empty,
    /// The source buffer is not `width · height · 4` bytes.
    Size { expected: usize, got: usize },
    /// The output would exceed [`MAX_PIXELS`].
    TooLarge { width: u32, height: u32 },
    /// The crop rectangle does not lie inside the picture.
    Outside { rect: Rect, width: u32, height: u32 },
    /// The angle is not a finite number.
    Angle,
}

impl fmt::Display for ResampleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "a resample needs a non-empty source and target"),
            Self::Size { expected, got } => {
                write!(f, "expected {expected} bytes of RGBA8, got {got}")
            }
            Self::TooLarge { width, height } => write!(
                f,
                "a {width}×{height} result exceeds the {MAX_PIXELS}-pixel limit"
            ),
            Self::Outside {
                rect,
                width,
                height,
            } => write!(
                f,
                "the rectangle {},{} {}×{} does not lie inside the {width}×{height} picture",
                rect.x, rect.y, rect.w, rect.h
            ),
            Self::Angle => write!(f, "the angle is not a finite number of degrees"),
        }
    }
}

impl std::error::Error for ResampleError {}

/// An integer pixel rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

fn check_source(src: &[u8], width: u32, height: u32) -> Result<(), ResampleError> {
    if width == 0 || height == 0 {
        return Err(ResampleError::Empty);
    }
    let expected = width as usize * height as usize * 4;
    if src.len() != expected {
        return Err(ResampleError::Size {
            expected,
            got: src.len(),
        });
    }
    Ok(())
}

fn check_target(width: u32, height: u32) -> Result<(), ResampleError> {
    if width == 0 || height == 0 {
        return Err(ResampleError::Empty);
    }
    if width as u64 * height as u64 > MAX_PIXELS {
        return Err(ResampleError::TooLarge { width, height });
    }
    Ok(())
}

/// The taps of one axis: for each output index, a run of
/// `(source index, normalised weight)`.
struct Taps {
    spans: Vec<(usize, usize)>,
    idx: Vec<usize>,
    w: Vec<f32>,
}

impl Taps {
    fn new(src: u32, dst: u32, filter: Filter) -> Self {
        let mut taps = Taps {
            spans: Vec::with_capacity(dst as usize),
            idx: Vec::new(),
            w: Vec::new(),
        };
        if src == dst {
            for o in 0..dst as usize {
                taps.spans.push((o, 1));
                taps.idx.push(o);
                taps.w.push(1.0);
            }
            return taps;
        }
        let inv = src as f64 / dst as f64;
        let f = inv.max(1.0);
        let reach = filter.support() * f;
        let last = src as i64 - 1;
        let mut ws: Vec<(usize, f64)> = Vec::new();
        for o in 0..dst {
            let s = (o as f64 + 0.5) * inv - 0.5;
            let lo = (s - reach).floor() as i64 + 1;
            let hi = (s + reach).floor() as i64;
            ws.clear();
            let mut sum = 0.0;
            for i in lo..=hi {
                let wv = filter.weight((s - i as f64) / f);
                if wv != 0.0 {
                    ws.push((i.clamp(0, last) as usize, wv));
                    sum += wv;
                }
            }
            let start = taps.idx.len();
            if ws.is_empty() || sum == 0.0 {
                // Not reached by either filter (the tap nearest `s` always
                // weighs more than 0); the nearest pixel keeps it total.
                taps.idx.push((s.round() as i64).clamp(0, last) as usize);
                taps.w.push(1.0);
            } else {
                for &(i, wv) in &ws {
                    taps.idx.push(i);
                    taps.w.push((wv / sum) as f32);
                }
            }
            taps.spans.push((start, taps.idx.len() - start));
        }
        taps
    }

    fn of(&self, o: usize) -> impl Iterator<Item = (usize, f32)> + '_ {
        let (start, n) = self.spans[o];
        self.idx[start..start + n]
            .iter()
            .copied()
            .zip(self.w[start..start + n].iter().copied())
    }

    fn min_of(&self, o: usize) -> usize {
        let (start, n) = self.spans[o];
        self.idx[start..start + n]
            .iter()
            .copied()
            .min()
            .unwrap_or(0)
    }
}

#[inline]
fn premultiply(px: &[u8]) -> [f32; 4] {
    let a = px[3] as f32;
    [
        px[0] as f32 * a / 255.0,
        px[1] as f32 * a / 255.0,
        px[2] as f32 * a / 255.0,
        a,
    ]
}

#[inline]
fn unpremultiply(p: [f32; 4], out: &mut [u8]) {
    let a = p[3].clamp(0.0, 255.0);
    let a8 = a.round();
    if a8 <= 0.0 {
        out.copy_from_slice(&[0, 0, 0, 0]);
        return;
    }
    for c in 0..3 {
        let v = p[c].clamp(0.0, a) * 255.0 / a;
        out[c] = v.round().clamp(0.0, 255.0) as u8;
    }
    out[3] = a8 as u8;
}

/// Resize a straight-alpha RGBA8 picture of `width × height` to
/// `out_w × out_h` with `filter`, premultiplied (see the crate docs).
///
/// Separable: each source row is filtered horizontally once, when the
/// first output row needs it, and dropped when no later one does, so the
/// working memory is the output plus a window of rows.
pub fn resize_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    out_w: u32,
    out_h: u32,
    filter: Filter,
) -> Result<Vec<u8>, ResampleError> {
    check_source(src, width, height)?;
    check_target(out_w, out_h)?;
    if (width, height) == (out_w, out_h) {
        return Ok(src.to_vec());
    }
    let tx = Taps::new(width, out_w, filter);
    let ty = Taps::new(height, out_h, filter);
    let (w, ow, oh) = (width as usize, out_w as usize, out_h as usize);

    // Horizontally filtered rows (premultiplied, `ow · 4` floats), by
    // source row; `None` until needed and again once passed.
    let mut rows: Vec<Option<Vec<f32>>> = vec![None; height as usize];
    let mut premul = vec![[0f32; 4]; w];
    let mut out = vec![0u8; ow * oh * 4];
    let mut acc = vec![0f32; ow * 4];
    let mut dropped = 0usize;
    for oy in 0..oh {
        // Rows below every remaining tap are done (the minimum tap only
        // grows with `oy`).
        let keep_from = ty.min_of(oy);
        while dropped < keep_from {
            rows[dropped] = None;
            dropped += 1;
        }
        acc.fill(0.0);
        for (sy, wy) in ty.of(oy) {
            if rows[sy].is_none() {
                let line = &src[sy * w * 4..(sy + 1) * w * 4];
                for (p, px) in premul.iter_mut().zip(line.as_chunks::<4>().0.iter()) {
                    *p = premultiply(px);
                }
                let mut row = vec![0f32; ow * 4];
                for (ox, dst) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                    let mut s = [0f32; 4];
                    for (sx, wx) in tx.of(ox) {
                        let p = premul[sx];
                        for c in 0..4 {
                            s[c] += p[c] * wx;
                        }
                    }
                    dst.copy_from_slice(&s);
                }
                rows[sy] = Some(row);
            }
            let row = rows[sy].as_ref().expect("filled above");
            for (a, v) in acc.iter_mut().zip(row) {
                *a += v * wy;
            }
        }
        let line = &mut out[oy * ow * 4..(oy + 1) * ow * 4];
        for (dst, p) in line
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(acc.as_chunks::<4>().0.iter())
        {
            unpremultiply([p[0], p[1], p[2], p[3]], dst);
        }
    }
    Ok(out)
}

/// The sine and cosine of `degrees`, exact at the quarter turns (so a
/// turn by 90° samples pixel centres exactly and moves pixels unchanged).
fn sin_cos_degrees(degrees: f64) -> (f64, f64) {
    if degrees % 90.0 == 0.0 {
        match (degrees / 90.0).rem_euclid(4.0) as u8 {
            0 => (0.0, 1.0),
            1 => (1.0, 0.0),
            2 => (0.0, -1.0),
            _ => (-1.0, 0.0),
        }
    } else {
        degrees.to_radians().sin_cos()
    }
}

/// A STRAIGHTENED CROP of a straight-alpha RGBA8 picture: the picture
/// turned by `−degrees` about the centre of `rect` (so content inside a
/// frame drawn turned by `+degrees` lands upright), then `rect` cut out.
/// Positive degrees are clockwise on screen (y grows down), as in
/// paged.image's `geom.rotate_bilinear`.
///
/// Each output pixel's centre is mapped back into the source and sampled
/// bilinearly from its four neighbours, premultiplied; where the turn
/// swings past the picture the edge pixel repeats (clamp-to-edge, the GPU
/// kernel's rule). At 0° this is the plain crop, byte for byte.
pub fn rotate_crop_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    rect: Rect,
    degrees: f64,
) -> Result<Vec<u8>, ResampleError> {
    check_source(src, width, height)?;
    check_target(rect.w, rect.h)?;
    if !degrees.is_finite() {
        return Err(ResampleError::Angle);
    }
    if rect.x as u64 + rect.w as u64 > width as u64 || rect.y as u64 + rect.h as u64 > height as u64
    {
        return Err(ResampleError::Outside {
            rect,
            width,
            height,
        });
    }
    let (w, rw, rh) = (width as usize, rect.w as usize, rect.h as usize);
    let mut out = vec![0u8; rw * rh * 4];
    if degrees == 0.0 {
        for (oy, line) in out.chunks_exact_mut(rw * 4).enumerate() {
            let start = ((rect.y as usize + oy) * w + rect.x as usize) * 4;
            line.copy_from_slice(&src[start..start + rw * 4]);
        }
        return Ok(out);
    }
    // The backward map of a turn by θ = −degrees about c (source and
    // destination centre alike): src = R(−θ)·(dst − c) + c.
    let (sin, cos) = sin_cos_degrees(-degrees);
    let cx = rect.x as f64 + rect.w as f64 / 2.0;
    let cy = rect.y as f64 + rect.h as f64 / 2.0;
    let (lx, ly) = (width as i64 - 1, height as i64 - 1);
    let tap = |x: i64, y: i64| {
        let i = (y.clamp(0, ly) as usize * w + x.clamp(0, lx) as usize) * 4;
        premultiply(&src[i..i + 4])
    };
    let mix = |a: [f32; 4], b: [f32; 4], t: f32| {
        [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
            a[3] + (b[3] - a[3]) * t,
        ]
    };
    for oy in 0..rh {
        let dy = rect.y as f64 + oy as f64 + 0.5 - cy;
        for ox in 0..rw {
            let dx = rect.x as f64 + ox as f64 + 0.5 - cx;
            let sx = cos * dx + sin * dy + cx - 0.5;
            let sy = -sin * dx + cos * dy + cy - 0.5;
            let (x0, y0) = (sx.floor(), sy.floor());
            let (fx, fy) = ((sx - x0) as f32, (sy - y0) as f32);
            let (x0, y0) = (x0 as i64, y0 as i64);
            let top = mix(tap(x0, y0), tap(x0 + 1, y0), fx);
            let bot = mix(tap(x0, y0 + 1), tap(x0 + 1, y0 + 1), fx);
            let i = (oy * rw + ox) * 4;
            unpremultiply(mix(top, bot, fy), &mut out[i..i + 4]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic, varied opaque-and-translucent picture.
    fn noise(w: u32, h: u32, opaque: bool) -> Vec<u8> {
        let mut state = 0x2545_f491_u32;
        let mut px = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..w * h {
            for c in 0..4 {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                let v = (state >> 24) as u8;
                // Alpha is never 0: a transparent pixel's colour is not
                // kept (it becomes 0, 0, 0, 0), which the quarter-turn
                // test would otherwise read as a change.
                px.push(match (c, opaque) {
                    (3, true) => 255,
                    (3, false) => v | 1,
                    _ => v,
                });
            }
        }
        px
    }

    fn grey_row(values: &[u8]) -> Vec<u8> {
        values.iter().flat_map(|&v| [v, v, v, 255]).collect()
    }

    fn reds(px: &[u8]) -> Vec<u8> {
        px.as_chunks::<4>().0.iter().map(|p| p[0]).collect()
    }

    #[test]
    #[allow(non_snake_case)]
    fn scale_one_is_the_identity__feat__image_actions_cpu_resample() {
        for opaque in [true, false] {
            let src = noise(13, 7, opaque);
            for f in [Filter::Bilinear, Filter::Lanczos3] {
                assert_eq!(resize_rgba8(&src, 13, 7, 13, 7, f).unwrap(), src);
            }
        }
        // One axis unchanged is copied along that axis: a 1-row picture
        // resized in x only keeps its height and its one row's taps in y.
        let src = noise(9, 1, true);
        let out = resize_rgba8(&src, 9, 1, 9, 3, Filter::Lanczos3).unwrap();
        for row in out.as_chunks::<36>().0 {
            assert_eq!(row, &src[..]);
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_constant_colour_stays_that_colour__feat__image_actions_cpu_resample() {
        for (rgba, f) in [
            ([200u8, 17, 90, 255], Filter::Lanczos3),
            ([200, 17, 90, 255], Filter::Bilinear),
            ([12, 250, 140, 77], Filter::Lanczos3),
            ([12, 250, 140, 77], Filter::Bilinear),
        ] {
            let src: Vec<u8> = (0..31 * 17).flat_map(|_| rgba).collect();
            for (ow, oh) in [(7, 5), (64, 40), (31, 3), (1, 1)] {
                let out = resize_rgba8(&src, 31, 17, ow, oh, f).unwrap();
                assert_eq!(out.len(), (ow * oh * 4) as usize);
                for p in out.as_chunks::<4>().0.iter() {
                    assert_eq!(*p, rgba, "{f:?} to {ow}×{oh}");
                }
            }
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn bilinear_matches_the_hand_computed_values__feat__image_actions_cpu_resample() {
        // 2× down of 0 0 255 255: s = 0.5 and 2.5, the tent widened to
        // reach 2: weights ¼ ¾ ¾ ¼ over (−1→0, 0, 1, 2), normalised by 2.
        let out = resize_rgba8(&grey_row(&[0, 0, 255, 255]), 4, 1, 2, 1, Filter::Bilinear);
        assert_eq!(reds(&out.unwrap()), [32, 223]);
        // 2× up of 0 255: s = −¼, ¼, ¾, 1¼ — 0, 63.75, 191.25, 255.
        let out = resize_rgba8(&grey_row(&[0, 255]), 2, 1, 4, 1, Filter::Bilinear);
        assert_eq!(reds(&out.unwrap()), [0, 64, 191, 255]);
    }

    #[test]
    #[allow(non_snake_case)]
    fn lanczos_matches_reference_values__feat__image_actions_cpu_resample() {
        // 2× up of a step: Lanczos rings (its overshoot clamped) and is
        // symmetric about the step. The values are the formula evaluated
        // independently (f64, outside this crate) and rounded.
        let out = resize_rgba8(
            &grey_row(&[0, 0, 0, 255, 255, 255]),
            6,
            1,
            12,
            1,
            Filter::Lanczos3,
        )
        .unwrap();
        let r = reds(&out);
        assert_eq!(r, [0, 2, 8, 0, 0, 54, 201, 255, 255, 247, 253, 255]);
        for i in 0..6 {
            assert_eq!(r[i] as u16 + r[11 - i] as u16, 255, "symmetry at {i}");
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_reduction_averages_instead_of_aliasing__feat__image_actions_cpu_resample() {
        // A one-pixel checkerboard halved: every interior output pixel
        // is the mid grey, not the board's phase.
        let (w, h) = (40u32, 40u32);
        let src: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let v = if (i % w + i / w) % 2 == 0 { 0 } else { 255 };
                [v, v, v, 255]
            })
            .collect();
        for f in [Filter::Bilinear, Filter::Lanczos3] {
            let out = resize_rgba8(&src, w, h, 20, 20, f).unwrap();
            for y in 3..17 {
                for x in 3..17 {
                    let v = out[(y * 20 + x) * 4];
                    assert!((127..=128).contains(&v), "{f:?} at {x},{y}: {v}");
                }
            }
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn alpha_is_premultiplied_so_edges_keep_their_colour__feat__image_actions_cpu_resample() {
        // Opaque red beside transparent black: straight filtering would
        // pull the edge towards black; premultiplied it stays pure red at
        // partial alpha.
        let (w, h) = (16u32, 4u32);
        let src: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                if (i % w) < 7 {
                    [255, 0, 0, 255]
                } else {
                    [0, 0, 0, 0]
                }
            })
            .collect();
        for f in [Filter::Bilinear, Filter::Lanczos3] {
            for (ow, oh) in [(5u32, 2u32), (37, 9)] {
                let out = resize_rgba8(&src, w, h, ow, oh, f).unwrap();
                let mut partial = 0;
                for p in out.as_chunks::<4>().0.iter() {
                    if p[3] == 0 {
                        assert_eq!(*p, [0, 0, 0, 0]);
                    } else {
                        assert_eq!(&p[..3], [255, 0, 0], "{f:?} {ow}×{oh}: {p:?}");
                        partial += usize::from(p[3] < 255);
                    }
                }
                assert!(partial > 0, "the edge is blended");
            }
            let back = rotate_crop_rgba8(
                &src,
                w,
                h,
                Rect {
                    x: 2,
                    y: 0,
                    w: 12,
                    h: 4,
                },
                7.5,
            );
            for p in back.unwrap().as_chunks::<4>().0.iter() {
                assert!(p[3] == 0 || p[..3] == [255, 0, 0], "{p:?}");
            }
        }
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_quarter_turn_is_a_transpose_of_the_mirrored_picture__feat__image_actions_cpu_resample() {
        let n = 9u32;
        let src = noise(n, n, false);
        let whole = Rect {
            x: 0,
            y: 0,
            w: n,
            h: n,
        };
        let at = |px: &[u8], x: u32, y: u32| {
            let i = ((y * n + x) * 4) as usize;
            px[i..i + 4].to_vec()
        };
        let turned = rotate_crop_rgba8(&src, n, n, whole, 90.0).unwrap();
        // The content turns back by 90°: out(x, y) = in(n − 1 − y, x),
        // i.e. the transpose of the picture mirrored left to right. Every
        // pixel moves unchanged (alpha included: no resampling at all).
        for y in 0..n {
            for x in 0..n {
                assert_eq!(at(&turned, x, y), at(&src, n - 1 - y, x), "at {x},{y}");
            }
        }
        // Four quarter turns, and a turn and its inverse, are the identity.
        let mut px = src.clone();
        for _ in 0..4 {
            px = rotate_crop_rgba8(&px, n, n, whole, 90.0).unwrap();
        }
        assert_eq!(px, src);
        let back = rotate_crop_rgba8(&turned, n, n, whole, -90.0).unwrap();
        assert_eq!(back, src);
        assert_eq!(rotate_crop_rgba8(&src, n, n, whole, 360.0).unwrap(), src);
    }

    #[test]
    #[allow(non_snake_case)]
    fn zero_degrees_is_the_plain_crop_and_refusals_say_why__feat__image_actions_cpu_resample() {
        let src = noise(10, 6, false);
        let r = Rect {
            x: 3,
            y: 1,
            w: 4,
            h: 5,
        };
        let out = rotate_crop_rgba8(&src, 10, 6, r, 0.0).unwrap();
        for y in 0..5usize {
            let s = ((1 + y) * 10 + 3) * 4;
            assert_eq!(&out[y * 16..y * 16 + 16], &src[s..s + 16]);
        }
        assert_eq!(
            rotate_crop_rgba8(&src, 10, 6, Rect { x: 8, ..r }, 3.0),
            Err(ResampleError::Outside {
                rect: Rect { x: 8, ..r },
                width: 10,
                height: 6
            })
        );
        assert_eq!(
            rotate_crop_rgba8(&src, 10, 6, r, f64::NAN),
            Err(ResampleError::Angle)
        );
        assert_eq!(
            resize_rgba8(&src, 10, 6, 0, 3, Filter::Bilinear),
            Err(ResampleError::Empty)
        );
        assert_eq!(
            resize_rgba8(&src[1..], 10, 6, 3, 3, Filter::Bilinear),
            Err(ResampleError::Size {
                expected: 240,
                got: 239
            })
        );
        assert!(matches!(
            resize_rgba8(&src, 10, 6, 20_000, 20_000, Filter::Bilinear),
            Err(ResampleError::TooLarge { .. })
        ));
        assert_eq!(Filter::parse("lanczos3"), Some(Filter::Lanczos3));
        assert_eq!(Filter::parse("mitchell"), None);
        assert_eq!(Filter::default().name(), "lanczos3");
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_small_turn_keeps_the_centre_and_is_deterministic__feat__image_actions_cpu_resample() {
        let src = noise(33, 21, true);
        let r = Rect {
            x: 4,
            y: 3,
            w: 25,
            h: 15,
        };
        let a = rotate_crop_rgba8(&src, 33, 21, r, 3.25).unwrap();
        let b = rotate_crop_rgba8(&src, 33, 21, r, 3.25).unwrap();
        assert_eq!(a, b);
        // An odd-sized rectangle's centre pixel samples the source pixel
        // centre it sits on, whatever the angle.
        let centre = ((7 * 25 + 12) * 4) as usize;
        let s = ((10 * 33 + 16) * 4) as usize;
        assert_eq!(&a[centre..centre + 4], &src[s..s + 4]);
        let big = noise(301, 207, false);
        assert_eq!(
            resize_rgba8(&big, 301, 207, 97, 64, Filter::Lanczos3).unwrap(),
            resize_rgba8(&big, 301, 207, 97, 64, Filter::Lanczos3).unwrap()
        );
    }
}
