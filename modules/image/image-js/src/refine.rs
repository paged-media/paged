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

//! SELECT AND MASK — refining a selection's edge against the image
//! (image ADR 470). Classical matting, no model:
//!
//! 1. A TRIMAP from the selection: definite foreground inside, definite
//!    background outside, UNKNOWN in a band around the edge. The band is
//!    the edge-detection RADIUS wide on each side; with SMART RADIUS it
//!    adapts to the edge: where the image contrast across the edge is
//!    high (a hard, well-defined edge) the band narrows to a quarter of
//!    the radius, where it is low (hair, fur, blur) it keeps the full
//!    radius. The Refine Edge brush adds painted pixels to the band.
//! 2. In the band, ALPHA by colour projection: the local foreground and
//!    background colours are the means of the known pixels in a window
//!    around the pixel, and α = ((I − B)·(F − B)) / |F − B|² (the
//!    closed-form estimate behind Ruzon–Tomasi and Bayesian matting,
//!    with their distributions collapsed to their means). Where F and B
//!    are indistinguishable the original coverage stands. A MATTING HOOK
//!    ([`MattingHook`]) may replace this step; the default is none (the
//!    ML provider arrives with WP8.2).
//! 3. The global adjustments, in Photoshop's order: SMOOTH (blur of the
//!    alpha by up to σ = 3 px, re-thresholded softly), FEATHER (Gaussian
//!    σ px), CONTRAST (a linear steepening about ½, 100 % = hard), SHIFT
//!    EDGE (grey dilation / erosion by |shift| · max(radius, 4) px).
//! 4. DECONTAMINATE COLOURS: in the soft edge, the pixel's colour is
//!    replaced by its estimated FOREGROUND colour,
//!    F = (I − (1 − α)·B) / α, extrapolated from the interior where α is
//!    too small to divide by, mixed in by the amount.
//!
//! Mask preparation and one colour estimate per pixel: CPU, like every
//! other coverage operation here.

use image_gpu::SelectionCoverage;

/// The workspace's sliders.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RefineParams {
    /// Edge detection radius, px (0 = no band: the selection as is).
    pub radius: f32,
    /// Adapt the radius to the edge's contrast.
    pub smart_radius: bool,
    /// Smooth, 0…100.
    pub smooth: f32,
    /// Feather, px (Gaussian σ).
    pub feather: f32,
    /// Contrast, 0…100 %.
    pub contrast: f32,
    /// Shift edge, −100…100 %.
    pub shift_edge: f32,
    /// Decontaminate colours.
    pub decontaminate: bool,
    /// Decontamination amount, 0…100 %.
    pub amount: f32,
}

impl Default for RefineParams {
    fn default() -> Self {
        RefineParams {
            radius: 0.0,
            smart_radius: false,
            smooth: 0.0,
            feather: 0.0,
            contrast: 0.0,
            shift_edge: 0.0,
            decontaminate: false,
            amount: 100.0,
        }
    }
}

/// The trimap the alpha solve sees: 0 background, 128 unknown, 255
/// foreground.
pub type Trimap = Vec<u8>;

/// A matting provider (WP8.2's ML matting plugs in here). Given the
/// image and the trimap, it answers an alpha for every pixel, or `None`
/// to leave the classical solve in charge.
pub trait MattingHook {
    fn solve(&self, rgba: &[u8], width: u32, height: u32, trimap: &[u8]) -> Option<Vec<u8>>;
}

/// The default hook: no provider, the classical solve runs.
pub struct NoMatting;

impl MattingHook for NoMatting {
    fn solve(&self, _: &[u8], _: u32, _: u32, _: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

/// What a refine produces.
#[derive(Debug, Clone)]
pub struct Refined {
    pub alpha: SelectionCoverage,
    /// The decontaminated colours (straight RGBA8), when asked for.
    pub decontaminated: Option<Vec<u8>>,
    pub trimap: Trimap,
}

fn luma(p: &[u8]) -> f32 {
    (0.299 * f32::from(p[0]) + 0.587 * f32::from(p[1]) + 0.114 * f32::from(p[2])) / 255.0
}

/// Sobel gradient magnitude of the luma, 0…~1.
fn gradient(rgba: &[u8], w: usize, h: usize) -> Vec<f32> {
    let l: Vec<f32> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .take(w * h)
        .map(|p| luma(p))
        .collect();
    let at = |x: isize, y: isize| {
        l[(y.clamp(0, h as isize - 1) as usize) * w + x.clamp(0, w as isize - 1) as usize]
    };
    let mut g = vec![0f32; w * h];
    for y in 0..h as isize {
        for x in 0..w as isize {
            let gx = at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x - 1, y)
                - at(x - 1, y + 1);
            let gy = at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1)
                - at(x - 1, y - 1)
                - 2.0 * at(x, y - 1)
                - at(x + 1, y - 1);
            g[y as usize * w + x as usize] = (gx * gx + gy * gy).sqrt() / 4.0;
        }
    }
    g
}

/// Summed-area table of `w`×`h` values.
fn integral(v: &[f64], w: usize, h: usize) -> Vec<f64> {
    let mut s = vec![0f64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0f64;
        for x in 0..w {
            row += v[y * w + x];
            s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
        }
    }
    s
}

fn rect_sum(s: &[f64], w: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> f64 {
    // [x0, x1) × [y0, y1)
    let ww = w + 1;
    s[y1 * ww + x1] - s[y0 * ww + x1] - s[y1 * ww + x0] + s[y0 * ww + x0]
}

/// Local means of the KNOWN foreground / background colours: per pixel
/// `(F, B)`, each `None` when the window (grown up to 4× when empty)
/// holds no such pixel.
struct LocalMeans {
    w: usize,
    h: usize,
    sums: [Vec<f64>; 8],
}

impl LocalMeans {
    fn new(rgba: &[u8], trimap: &[u8], w: usize, h: usize) -> Self {
        let mut chans: Vec<Vec<f64>> = vec![vec![0f64; w * h]; 8];
        for i in 0..w * h {
            let side = match trimap[i] {
                255 => 0,
                0 => 4,
                _ => continue,
            };
            for k in 0..3 {
                chans[side + k][i] = f64::from(rgba[i * 4 + k]);
            }
            chans[side + 3][i] = 1.0;
        }
        let sums: Vec<Vec<f64>> = chans.iter().map(|c| integral(c, w, h)).collect();
        LocalMeans {
            w,
            h,
            sums: sums.try_into().expect("eight channels"),
        }
    }

    fn mean(&self, side: usize, x: usize, y: usize, r: usize) -> Option<[f32; 3]> {
        let mut r = r.max(1);
        for _ in 0..3 {
            let (x0, y0) = (x.saturating_sub(r), y.saturating_sub(r));
            let (x1, y1) = ((x + r + 1).min(self.w), (y + r + 1).min(self.h));
            let n = rect_sum(&self.sums[side + 3], self.w, x0, y0, x1, y1);
            if n >= 1.0 {
                let c =
                    |k: usize| (rect_sum(&self.sums[side + k], self.w, x0, y0, x1, y1) / n) as f32;
                return Some([c(0), c(1), c(2)]);
            }
            r *= 2;
        }
        None
    }
}

fn gaussian(alpha: &mut [f32], w: usize, h: usize, sigma: f32) {
    if sigma <= 0.0 {
        return;
    }
    let r = (sigma * 3.0).ceil() as isize;
    let k: Vec<f32> = (-r..=r)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let norm: f32 = k.iter().sum();
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let xx = (x as isize + j as isize - r).clamp(0, w as isize - 1) as usize;
                acc += kv * alpha[y * w + xx];
            }
            tmp[y * w + x] = acc / norm;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (j, kv) in k.iter().enumerate() {
                let yy = (y as isize + j as isize - r).clamp(0, h as isize - 1) as usize;
                acc += kv * tmp[yy * w + x];
            }
            alpha[y * w + x] = acc / norm;
        }
    }
}

/// Grey dilation (`grow`) or erosion of `a` by a square of radius `r`.
fn grey_morph(a: &mut [f32], w: usize, h: usize, r: usize, grow: bool) {
    if r == 0 {
        return;
    }
    let pick = |p: f32, q: f32| if grow { p.max(q) } else { p.min(q) };
    let mut tmp = a.to_vec();
    for y in 0..h {
        for x in 0..w {
            let mut v = a[y * w + x];
            for xx in x.saturating_sub(r)..=(x + r).min(w - 1) {
                v = pick(v, a[y * w + xx]);
            }
            tmp[y * w + x] = v;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let mut v = tmp[y * w + x];
            for yy in y.saturating_sub(r)..=(y + r).min(h - 1) {
                v = pick(v, tmp[yy * w + x]);
            }
            a[y * w + x] = v;
        }
    }
}

/// The trimap of `cov` for the params (and the painted refine band).
pub fn trimap(
    rgba: &[u8],
    cov: &SelectionCoverage,
    band: Option<&[u8]>,
    p: &RefineParams,
) -> Trimap {
    let (w, h) = (cov.width() as usize, cov.height() as usize);
    let data = cov.data();
    let mut tri: Trimap = data
        .iter()
        .map(|&c| if c >= 128 { 255 } else { 0 })
        .collect();
    // An already-soft pixel is unknown whatever the radius.
    for (t, &c) in tri.iter_mut().zip(data) {
        if c > 8 && c < 247 {
            *t = 128;
        }
    }
    if p.radius > 0.0 {
        let to_in = crate::selection::distance_to(cov, |c| c >= 128);
        let to_out = crate::selection::distance_to(cov, |c| c < 128);
        // The edge contrast: the gradient, smoothed over the radius, at
        // its 95th percentile as "hard".
        let grad = if p.smart_radius {
            let mut g = gradient(rgba, w, h);
            gaussian(&mut g, w, h, (p.radius / 2.0).max(1.0));
            let mut s = g.clone();
            s.sort_by(f32::total_cmp);
            let top = s[((s.len() - 1) as f32 * 0.95) as usize].max(1e-4);
            Some((g, top))
        } else {
            None
        };
        for i in 0..w * h {
            let d = if data[i] >= 128 { to_out[i] } else { to_in[i] };
            let r = match &grad {
                Some((g, top)) => p.radius * (1.0 - 0.75 * (g[i] / top).min(1.0)),
                None => p.radius,
            };
            if d <= r {
                tri[i] = 128;
            }
        }
    }
    if let Some(b) = band {
        for (t, &m) in tri.iter_mut().zip(b) {
            if m >= 128 {
                *t = 128;
            }
        }
    }
    tri
}

/// Refine `cov` against `rgba` (straight RGBA8 at the coverage's size).
pub fn refine(
    rgba: &[u8],
    cov: &SelectionCoverage,
    band: Option<&[u8]>,
    p: &RefineParams,
    hook: &dyn MattingHook,
) -> Refined {
    let (wu, hu) = (cov.width(), cov.height());
    let (w, h) = (wu as usize, hu as usize);
    let tri = trimap(rgba, cov, band, p);
    let window = (p.radius.max(2.0) * 2.0).ceil() as usize;
    let means = LocalMeans::new(rgba, &tri, w, h);
    let mut alpha: Vec<f32> = match hook.solve(rgba, wu, hu, &tri) {
        Some(a) if a.len() == w * h => a.iter().map(|&v| f32::from(v) / 255.0).collect(),
        _ => (0..w * h)
            .map(|i| match tri[i] {
                255 => 1.0,
                0 => 0.0,
                _ => {
                    let (x, y) = (i % w, i / w);
                    let orig = f32::from(cov.data()[i]) / 255.0;
                    match (means.mean(0, x, y, window), means.mean(4, x, y, window)) {
                        (Some(f), Some(b)) => {
                            let fb = [f[0] - b[0], f[1] - b[1], f[2] - b[2]];
                            let n2 = fb.iter().map(|v| v * v).sum::<f32>();
                            if n2 < 400.0 {
                                orig
                            } else {
                                let ib = [
                                    f32::from(rgba[i * 4]) - b[0],
                                    f32::from(rgba[i * 4 + 1]) - b[1],
                                    f32::from(rgba[i * 4 + 2]) - b[2],
                                ];
                                ((ib[0] * fb[0] + ib[1] * fb[1] + ib[2] * fb[2]) / n2)
                                    .clamp(0.0, 1.0)
                            }
                        }
                        _ => orig,
                    }
                }
            })
            .collect(),
    };
    // Smooth: blur, then pull back towards a crisp edge.
    if p.smooth > 0.0 {
        gaussian(&mut alpha, w, h, p.smooth.clamp(0.0, 100.0) / 100.0 * 3.0);
        for a in &mut alpha {
            *a = ((*a - 0.5) * 1.5 + 0.5).clamp(0.0, 1.0);
        }
    }
    if p.feather > 0.0 {
        gaussian(&mut alpha, w, h, p.feather);
    }
    if p.contrast > 0.0 {
        let c = p.contrast.clamp(0.0, 100.0) / 100.0;
        let k = if c >= 1.0 { 1e6 } else { 1.0 / (1.0 - c) };
        for a in &mut alpha {
            *a = ((*a - 0.5) * k + 0.5).clamp(0.0, 1.0);
        }
    }
    if p.shift_edge != 0.0 {
        let s = p.shift_edge.clamp(-100.0, 100.0) / 100.0;
        let r = (s.abs() * p.radius.max(4.0)).round() as usize;
        grey_morph(&mut alpha, w, h, r, s > 0.0);
    }
    let bytes: Vec<u8> = alpha.iter().map(|a| (a * 255.0).round() as u8).collect();
    let decontaminated = p.decontaminate.then(|| {
        let amount = p.amount.clamp(0.0, 100.0) / 100.0;
        let mut out = rgba.to_vec();
        for i in 0..w * h {
            let a = alpha[i];
            if a >= 0.999 || tri[i] == 255 {
                continue;
            }
            let (x, y) = (i % w, i / w);
            let (Some(f), b) = (means.mean(0, x, y, window), means.mean(4, x, y, window)) else {
                continue;
            };
            for k in 0..3 {
                let c = f32::from(rgba[i * 4 + k]);
                let est = match b {
                    Some(b) if a > 0.2 => ((c - (1.0 - a) * b[k]) / a).clamp(0.0, 255.0),
                    _ => f[k],
                };
                out[i * 4 + k] = (c + (est - c) * amount).round().clamp(0.0, 255.0) as u8;
            }
        }
        out
    });
    Refined {
        alpha: SelectionCoverage::from_data(wu, hu, bytes)
            .unwrap_or_else(|| SelectionCoverage::empty(wu, hu)),
        decontaminated,
        trimap: tri,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 16×8: white on the left, black on the right, with a soft 4-px
    /// ramp in the middle (columns 6…9).
    fn ramp() -> Vec<u8> {
        let mut px = Vec::new();
        for _ in 0..8 {
            for x in 0..16u32 {
                let v = match x {
                    0..=5 => 255,
                    10.. => 0,
                    _ => (255 - (x - 5) * 51) as u8,
                };
                px.extend_from_slice(&[v, v, v, 255]);
            }
        }
        px
    }

    /// A hard selection of the left 8 columns.
    fn left_half() -> SelectionCoverage {
        SelectionCoverage::rasterize_rect(16, 8, 0.0, 0.0, 8.0, 8.0)
    }

    #[test]
    #[allow(non_snake_case)]
    fn the_band_solves_alpha_from_the_colours__feat__image_selection_select_and_mask() {
        let px = ramp();
        let none = refine(
            &px,
            &left_half(),
            None,
            &RefineParams::default(),
            &NoMatting,
        );
        assert_eq!(
            none.alpha.data(),
            left_half().data(),
            "radius 0 keeps the selection"
        );
        let p = RefineParams {
            radius: 4.0,
            ..RefineParams::default()
        };
        let r = refine(&px, &left_half(), None, &p, &NoMatting);
        assert_eq!(r.trimap[3 * 16 + 1], 255, "deep inside is foreground");
        assert_eq!(r.trimap[3 * 16 + 7], 128, "the edge is unknown");
        assert_eq!(r.trimap[3 * 16 + 15], 0, "deep outside is background");
        // The ramp's grey is its alpha between white and black.
        let a = |x: u32| r.alpha.coverage_at(x, 3);
        assert_eq!(a(2), 255);
        assert!(a(6) > 180 && a(6) < 220, "{}", a(6));
        assert!(a(8) > 60 && a(8) < 110, "{}", a(8));
        assert_eq!(a(14), 0);
    }

    #[test]
    fn contrast_feather_and_shift_edge() {
        let px = ramp();
        let soft = RefineParams {
            radius: 4.0,
            ..RefineParams::default()
        };
        let hard = RefineParams {
            contrast: 100.0,
            ..soft
        };
        let r = refine(&px, &left_half(), None, &hard, &NoMatting);
        assert!(
            r.alpha.data().iter().all(|&v| v == 0 || v == 255),
            "100% contrast is hard"
        );
        let f = refine(
            &px,
            &left_half(),
            None,
            &RefineParams {
                feather: 2.0,
                ..RefineParams::default()
            },
            &NoMatting,
        );
        let e = f.alpha.coverage_at(8, 3);
        assert!(e > 0 && e < 128, "feathered just outside the edge: {e}");
        let grown = refine(
            &px,
            &left_half(),
            None,
            &RefineParams {
                shift_edge: 50.0,
                ..RefineParams::default()
            },
            &NoMatting,
        );
        assert_eq!(
            grown.alpha.coverage_at(9, 3),
            255,
            "the edge moved out by 2 px"
        );
        assert_eq!(grown.alpha.coverage_at(10, 3), 0);
        let shrunk = refine(
            &px,
            &left_half(),
            None,
            &RefineParams {
                shift_edge: -50.0,
                ..RefineParams::default()
            },
            &NoMatting,
        );
        assert_eq!(shrunk.alpha.coverage_at(5, 3), 255);
        assert_eq!(shrunk.alpha.coverage_at(6, 3), 0, "and in by 2 px");
    }

    #[test]
    fn smart_radius_narrows_on_hard_edges_and_the_brush_widens() {
        // A hard edge: white | black at column 8.
        let mut px = Vec::new();
        for _ in 0..8 {
            for x in 0..16u32 {
                let v = if x < 8 { 255 } else { 0 };
                px.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let p = RefineParams {
            radius: 6.0,
            ..RefineParams::default()
        };
        let plain = trimap(&px, &left_half(), None, &p);
        let smart = trimap(
            &px,
            &left_half(),
            None,
            &RefineParams {
                smart_radius: true,
                ..p
            },
        );
        let unknown = |t: &[u8]| t.iter().filter(|&&v| v == 128).count();
        assert!(
            unknown(&smart) < unknown(&plain),
            "a hard edge narrows the band"
        );
        // The refine brush marks a pixel far from the edge as unknown.
        let mut band = vec![0u8; 16 * 8];
        band[3 * 16 + 1] = 255;
        let painted = trimap(&px, &left_half(), Some(&band), &RefineParams::default());
        assert_eq!(painted[3 * 16 + 1], 128);
    }

    #[test]
    fn decontamination_pulls_edge_colours_to_the_foreground() {
        // Red foreground on a green background with a mixed edge column.
        let mut px = Vec::new();
        for _ in 0..8 {
            for x in 0..16u32 {
                let c = match x {
                    0..=6 => [255, 0, 0],
                    7 => [128, 127, 0],
                    _ => [0, 255, 0],
                };
                px.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
        }
        let p = RefineParams {
            radius: 3.0,
            decontaminate: true,
            ..RefineParams::default()
        };
        let r = refine(&px, &left_half(), None, &p, &NoMatting);
        let d = r.decontaminated.expect("asked for");
        let at = |x: usize| &d[(3 * 16 + x) * 4..(3 * 16 + x) * 4 + 3];
        assert!(at(7)[1] < 40, "the green spill is gone: {:?}", at(7));
        assert!(at(7)[0] > 200, "{:?}", at(7));
        assert_eq!(at(2), &[255, 0, 0], "the interior is untouched");
    }

    #[test]
    fn a_matting_hook_replaces_the_solve() {
        struct Half;
        impl MattingHook for Half {
            fn solve(&self, _: &[u8], w: u32, h: u32, _: &[u8]) -> Option<Vec<u8>> {
                Some(vec![128; (w * h) as usize])
            }
        }
        let r = refine(
            &ramp(),
            &left_half(),
            None,
            &RefineParams {
                radius: 2.0,
                ..RefineParams::default()
            },
            &Half,
        );
        assert!(r.alpha.data().iter().all(|&v| v == 128));
    }
}
