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

//! CONTENT-AWARE SCALE: seam carving (image ADR 483, WP5.6).
//!
//! A SEAM is a connected path of one pixel per row (a vertical seam; a
//! horizontal one is the same on the transposed picture) whose removal
//! disturbs the picture least. Shrinking removes the cheapest seam, one
//! at a time; enlarging finds the `k` cheapest seams of the picture and
//! doubles each (the pixel and its right neighbour averaged in), at most
//! half the width per pass, so content is stretched where it matters
//! least instead of everywhere. Avidan and Shamir, "Seam Carving for
//! Content-Aware Image Resizing" (SIGGRAPH 2007), §3 and §4.2.
//!
//! The cost is FORWARD energy (Rubinstein, Shamir and Avidan, "Improved
//! Seam Carving for Video Retargeting", SIGGRAPH 2008, §5): the luminance
//! difference a removal brings together, accumulated by dynamic
//! programming over the rows. The luminance is that of the PREMULTIPLIED
//! colour, so transparent margins are free to remove. A PROTECT mask (one
//! byte per pixel) adds its value times [`PROTECT_COST`] to every pixel's
//! cost: a seam passes through protected pixels only where every other
//! path is dearer. Width first, then height. Sequential by nature (each
//! seam depends on the last), so it runs on the CPU — the class of the
//! PatchMatch search (image ADR 469).

use crate::{check_source, check_target, ResampleError};

/// The cost a fully protected pixel adds (a few hundred times the largest
/// luminance step).
pub const PROTECT_COST: f32 = 1.0e5 / 255.0;

#[derive(Clone)]
struct Plane {
    w: usize,
    h: usize,
    px: Vec<[u8; 4]>,
    lum: Vec<f32>,
    prot: Vec<f32>,
}

impl Plane {
    fn new(src: &[u8], w: usize, h: usize, protect: Option<&[u8]>) -> Self {
        let px: Vec<[u8; 4]> = src.as_chunks::<4>().0.to_vec();
        let lum = px.iter().map(luma).collect();
        let prot = (0..w * h)
            .map(|i| protect.map_or(0.0, |m| f32::from(m.get(i).copied().unwrap_or(0))))
            .collect();
        Self {
            w,
            h,
            px,
            lum,
            prot,
        }
    }

    fn transposed(&self) -> Self {
        let (w, h) = (self.w, self.h);
        let mut out = Self {
            w: h,
            h: w,
            px: vec![[0; 4]; w * h],
            lum: vec![0.0; w * h],
            prot: vec![0.0; w * h],
        };
        for y in 0..h {
            for x in 0..w {
                let (s, d) = (y * w + x, x * h + y);
                out.px[d] = self.px[s];
                out.lum[d] = self.lum[s];
                out.prot[d] = self.prot[s];
            }
        }
        out
    }

    /// The cheapest vertical seam: one column per row.
    fn seam(&self) -> Vec<usize> {
        let (w, h) = (self.w, self.h);
        let l = |x: usize, y: usize| self.lum[y * w + x];
        let mut m = vec![0f32; w * h];
        let mut from = vec![0i8; w * h];
        for (mx, p) in m.iter_mut().zip(&self.prot).take(w) {
            *mx = p * PROTECT_COST;
        }
        for y in 1..h {
            for x in 0..w {
                let left = l(x.saturating_sub(1), y);
                let right = l((x + 1).min(w - 1), y);
                let up = l(x, y - 1);
                let cu = (right - left).abs();
                let mut best = m[(y - 1) * w + x] + cu;
                let mut dir = 0i8;
                if x > 0 {
                    let cl = cu + (up - left).abs();
                    let v = m[(y - 1) * w + x - 1] + cl;
                    if v < best {
                        best = v;
                        dir = -1;
                    }
                }
                if x + 1 < w {
                    let cr = cu + (up - right).abs();
                    let v = m[(y - 1) * w + x + 1] + cr;
                    if v < best {
                        best = v;
                        dir = 1;
                    }
                }
                m[y * w + x] = best + self.prot[y * w + x] * PROTECT_COST;
                from[y * w + x] = dir;
            }
        }
        let last = &m[(h - 1) * w..h * w];
        let mut x = (0..w)
            .min_by(|&a, &b| last[a].total_cmp(&last[b]))
            .unwrap_or(0);
        let mut seam = vec![0usize; h];
        for y in (0..h).rev() {
            seam[y] = x;
            if y > 0 {
                x = (x as i64 + i64::from(from[y * w + x])) as usize;
            }
        }
        seam
    }

    fn remove(&mut self, seam: &[usize]) {
        let (w, h) = (self.w, self.h);
        let mut k = 0;
        for (y, &cut) in seam.iter().enumerate().take(h) {
            for x in 0..w {
                if x == cut {
                    continue;
                }
                let s = y * w + x;
                self.px[k] = self.px[s];
                self.lum[k] = self.lum[s];
                self.prot[k] = self.prot[s];
                k += 1;
            }
        }
        self.w -= 1;
        let n = self.w * h;
        self.px.truncate(n);
        self.lum.truncate(n);
        self.prot.truncate(n);
    }

    /// Shrink or grow to `tw` columns.
    fn carve_to(mut self, tw: usize) -> Self {
        while self.w > tw {
            let s = self.seam();
            self.remove(&s);
        }
        while self.w < tw {
            let k = (tw - self.w).min((self.w / 2).max(1));
            self = self.insert(k);
        }
        self
    }

    /// Double the `k` cheapest seams (found by removing them from a copy
    /// and remembering which original columns they ran through).
    fn insert(self, k: usize) -> Self {
        let (w, h) = (self.w, self.h);
        let mut work = self.clone();
        // The original column of every pixel of `work`.
        let mut orig: Vec<usize> = (0..w * h).map(|i| i % w).collect();
        let mut doubled = vec![false; w * h];
        for _ in 0..k {
            let s = work.seam();
            for (y, &x) in s.iter().enumerate() {
                doubled[y * w + orig[y * work.w + x]] = true;
            }
            let mut j = 0;
            for y in 0..h {
                for x in 0..work.w {
                    if x != s[y] {
                        orig[j] = orig[y * work.w + x];
                        j += 1;
                    }
                }
            }
            orig.truncate(j);
            work.remove(&s);
        }
        let nw = w + k;
        let mut out = Self {
            w: nw,
            h,
            px: Vec::with_capacity(nw * h),
            lum: Vec::with_capacity(nw * h),
            prot: Vec::with_capacity(nw * h),
        };
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                out.px.push(self.px[i]);
                out.lum.push(self.lum[i]);
                out.prot.push(self.prot[i]);
                if doubled[i] {
                    let n = y * w + (x + 1).min(w - 1);
                    let p = average(self.px[i], self.px[n]);
                    out.px.push(p);
                    out.lum.push(luma(&p));
                    out.prot.push(self.prot[i]);
                }
            }
        }
        out
    }
}

fn luma(p: &[u8; 4]) -> f32 {
    let a = f32::from(p[3]) / 255.0;
    (0.299 * f32::from(p[0]) + 0.587 * f32::from(p[1]) + 0.114 * f32::from(p[2])) * a
}

/// Two straight-alpha pixels averaged on premultiplied values.
fn average(a: [u8; 4], b: [u8; 4]) -> [u8; 4] {
    let (aa, ba) = (f32::from(a[3]), f32::from(b[3]));
    let alpha = (aa + ba) / 2.0;
    if alpha <= 0.0 {
        return [0; 4];
    }
    let c = |i: usize| {
        let v = (f32::from(a[i]) * aa + f32::from(b[i]) * ba) / 2.0 / alpha;
        v.round().clamp(0.0, 255.0) as u8
    };
    [c(0), c(1), c(2), alpha.round() as u8]
}

/// Resize a straight-alpha RGBA8 picture to `out_w`×`out_h` by seam
/// carving (see the module note). `protect`, when given, is one byte per
/// source pixel (255 = keep). The same size is the identity.
pub fn seam_carve_rgba8(
    src: &[u8],
    width: u32,
    height: u32,
    out_w: u32,
    out_h: u32,
    protect: Option<&[u8]>,
) -> Result<Vec<u8>, ResampleError> {
    check_source(src, width, height)?;
    check_target(out_w, out_h)?;
    if let Some(m) = protect {
        let expected = width as usize * height as usize;
        if m.len() != expected {
            return Err(ResampleError::Size {
                expected,
                got: m.len(),
            });
        }
    }
    let mut p = Plane::new(src, width as usize, height as usize, protect);
    if out_w as usize != p.w {
        p = p.carve_to(out_w as usize);
    }
    if out_h as usize != p.h {
        p = p.transposed().carve_to(out_h as usize).transposed();
    }
    Ok(p.px.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A grey field with a red, strongly textured square at `(sx, sy)`, `s` wide
    /// (textured: a flat square would be as cheap to cut as the field).
    fn scene(w: u32, h: u32, sx: u32, sy: u32, s: u32) -> Vec<u8> {
        let mut out = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let inside = x >= sx && x < sx + s && y >= sy && y < sy + s;
                // A faint texture, so the background is not perfectly
                // flat (ties would hide a wrong seam choice).
                let g = 120 + ((x * 7 + y * 13) % 5) as u8;
                let r = (60 + (x * 53 + y * 31) % 190) as u8;
                let px = if inside {
                    [r, 30, 30, 255]
                } else {
                    [g, g, g, 255]
                };
                out.extend_from_slice(&px);
            }
        }
        out
    }

    fn red_columns(px: &[u8], w: u32, h: u32) -> u32 {
        (0..w)
            .filter(|&x| (0..h).any(|y| px[((y * w + x) * 4 + 1) as usize] == 30))
            .count() as u32
    }

    #[test]
    fn the_same_size_is_the_identity() {
        let src = scene(20, 12, 5, 3, 4);
        assert_eq!(seam_carve_rgba8(&src, 20, 12, 20, 12, None).unwrap(), src);
    }

    #[test]
    fn shrinking_takes_the_background_and_keeps_the_object() {
        let (w, h) = (48, 24);
        let src = scene(w, h, 20, 8, 8);
        let out = seam_carve_rgba8(&src, w, h, 32, h, None).unwrap();
        assert_eq!(out.len(), 32 * 24 * 4);
        assert_eq!(red_columns(&out, 32, h), 8, "the square keeps its width");
        let tall = seam_carve_rgba8(&src, w, h, w, 16, None).unwrap();
        assert_eq!(tall.len(), (w * 16 * 4) as usize);
    }

    #[test]
    fn enlarging_stretches_the_background_and_keeps_the_object() {
        let (w, h) = (40, 20);
        let src = scene(w, h, 16, 6, 8);
        let out = seam_carve_rgba8(&src, w, h, 56, h, None).unwrap();
        assert_eq!(red_columns(&out, 56, h), 8);
    }

    #[test]
    fn a_protect_mask_steers_seams_away() {
        // A flat picture: without protection the cheapest seams are
        // anywhere; protect the left half and they all come from the right.
        let (w, h) = (32u32, 8u32);
        let mut src = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let v = if x < 16 { (x * 9 + y) as u8 } else { 200 };
                src.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let protect: Vec<u8> = (0..w * h)
            .map(|i| if i % w < 16 { 255 } else { 0 })
            .collect();
        let out = seam_carve_rgba8(&src, w, h, 24, h, Some(&protect)).unwrap();
        for y in 0..h {
            for x in 0..16 {
                let (i, j) = (((y * 24 + x) * 4) as usize, ((y * w + x) * 4) as usize);
                assert_eq!(out[i..i + 4], src[j..j + 4], "({x},{y}) kept");
            }
        }
        assert!(seam_carve_rgba8(&src, w, h, 24, h, Some(&[0; 3])).is_err());
    }
}
