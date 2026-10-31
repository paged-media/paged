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

//! Engine ADR 1037 — an image frame's filter stack, evaluated.
//!
//! Every op runs on the CPU through the shipped kernel twins of
//! `paged-kernels` (the curve through paged-pixel's natural spline), over
//! premultiplied `f32` pixels, the working space those twins are written
//! for. The result is a raster the display list carries like any decoded
//! picture, so both rasterizers draw the same pixels (ADR 146's rule: one
//! builder for both lanes) and the PDF export embeds them.

use paged_kernels::cpu;
use paged_kernels::params::{
    AdjustBlackWhiteParams, AdjustBrightnessContrastParams, AdjustChannelMixerParams,
    AdjustExposureParams, AdjustGradientMapParams, AdjustHueSaturationParams, AdjustLevelsParams,
    AdjustPosterizeParams, AdjustThresholdParams, ConvGaussianParams, ConvUnsharpParams,
    GAUSSIAN_MAX_RADIUS,
};
use paged_kernels::Px;
use paged_model::RasterOp;

/// Applies `ops`, in order, to a straight-alpha RGBA8 raster of `width ×
/// height`. `scale` is the raster's pixels per pixel of the source picture
/// (below 1 when it was reduced to its display size): a radius, given in
/// source pixels, is scaled by it, so a reduced picture blurs alike.
pub fn apply_rgba8(rgba: &[u8], width: u32, height: u32, ops: &[RasterOp], scale: f32) -> Vec<u8> {
    let mut px: Vec<Px> = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| {
            let a = f32::from(c[3]) / 255.0;
            Px([
                f32::from(c[0]) / 255.0 * a,
                f32::from(c[1]) / 255.0 * a,
                f32::from(c[2]) / 255.0 * a,
                a,
            ])
        })
        .collect();
    let (w, h) = (width as usize, height as usize);
    for op in ops {
        apply_op(&mut px, w, h, op, scale);
    }
    let mut out = vec![0u8; px.len() * 4];
    for (p, o) in px.iter().zip(out.as_chunks_mut::<4>().0) {
        let a = p.0[3].clamp(0.0, 1.0);
        if a <= 0.0 {
            continue;
        }
        for (dst, src) in o.iter_mut().zip(&p.0[..3]) {
            *dst = ((src / a).clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        o[3] = (a * 255.0).round() as u8;
    }
    out
}

fn point(px: &mut [Px], f: impl Fn(Px) -> Px) {
    for p in px.iter_mut() {
        *p = f(*p);
    }
}

fn apply_op(px: &mut [Px], w: usize, h: usize, op: &RasterOp, scale: f32) {
    match *op {
        RasterOp::Exposure { ev } => {
            let p = AdjustExposureParams::encoded(ev);
            point(px, |a| cpu::exposure(a, &p));
        }
        RasterOp::BrightnessContrast {
            brightness,
            contrast,
        } => {
            let p = AdjustBrightnessContrastParams::new(brightness, contrast);
            point(px, |a| cpu::brightness_contrast(a, &p));
        }
        RasterOp::Levels {
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
        } => {
            let p = AdjustLevelsParams::new(in_black, in_white, gamma, out_black, out_white);
            point(px, |a| cpu::levels(a, &p));
        }
        RasterOp::Curves { ref points } => {
            if points.is_empty() {
                return;
            }
            let pts: Vec<(f32, f32)> = points.iter().map(|p| (p[0], p[1])).collect();
            let lut = paged_pixel::curve_natural_f32(&pts);
            let at = |x: f32| {
                let t = x.clamp(0.0, 1.0) * 255.0;
                let lo = t.floor() as usize;
                let hi = (lo + 1).min(255);
                let f = t - t.floor();
                lut[lo] * (1.0 - f) + lut[hi] * f
            };
            point(px, |a| {
                let al = a.0[3];
                if al == 0.0 {
                    return a;
                }
                Px([
                    at(a.0[0] / al) * al,
                    at(a.0[1] / al) * al,
                    at(a.0[2] / al) * al,
                    al,
                ])
            });
        }
        RasterOp::HueSaturation {
            hue,
            saturation,
            lightness,
        } => {
            let mut p = AdjustHueSaturationParams::identity();
            p.master = [hue, saturation, lightness, 0.0];
            point(px, |a| cpu::hue_saturation(a, &p));
        }
        RasterOp::Recolor {
            hue,
            saturation,
            lightness,
        } => {
            let mut p = AdjustHueSaturationParams::identity();
            p.colorize = [1.0, hue, saturation, lightness];
            point(px, |a| cpu::hue_saturation(a, &p));
        }
        RasterOp::Duotone { shadow, highlight } => {
            let p = AdjustGradientMapParams::two_stop(shadow, highlight);
            point(px, |a| cpu::gradient_map(a, &p));
        }
        RasterOp::BlackWhite {
            reds,
            yellows,
            greens,
            cyans,
            blues,
            magentas,
        } => {
            let p = AdjustBlackWhiteParams::new(reds, yellows, greens, cyans, blues, magentas);
            point(px, |a| cpu::black_white(a, &p));
        }
        RasterOp::Posterize { levels } => {
            let p = AdjustPosterizeParams::new(levels);
            point(px, |a| cpu::posterize(a, &p));
        }
        RasterOp::Threshold { level } => {
            let p = AdjustThresholdParams::new(level);
            point(px, |a| cpu::threshold(a, &p));
        }
        RasterOp::Invert => {
            // `1 − c` per colour channel: the channel mixer with a negated
            // identity and a constant of one.
            let p = AdjustChannelMixerParams::new(
                [-1.0, 0.0, 0.0, 1.0],
                [0.0, -1.0, 0.0, 1.0],
                [0.0, 0.0, -1.0, 1.0],
            );
            point(px, |a| cpu::channel_mixer(a, &p));
        }
        RasterOp::Blur { radius } => {
            let blurred = gaussian(px, w, h, radius * scale);
            px.copy_from_slice(&blurred);
        }
        RasterOp::Sharpen { amount, radius } => {
            let blurred = gaussian(px, w, h, radius * scale);
            let p = ConvUnsharpParams::new(amount, 0.0);
            for (a, b) in px.iter_mut().zip(&blurred) {
                *a = cpu::unsharp(*a, *b, &p);
            }
        }
    }
}

/// A Gaussian blur of `sigma` pixels through the separable twins, the
/// edge clamped as the image pipeline's window clamps it. One pass's
/// window ends at [`GAUSSIAN_MAX_RADIUS`] (3σ ≤ 24): a wider blur runs as
/// `n` passes of σ/√n, whose variances add up to σ².
fn gaussian(px: &[Px], w: usize, h: usize, sigma: f32) -> Vec<Px> {
    let mut cur = px.to_vec();
    // A NaN σ fails `>` too: no blur.
    if sigma.partial_cmp(&0.05) != Some(std::cmp::Ordering::Greater) || w == 0 || h == 0 {
        return cur;
    }
    let max_sigma = f32::from(GAUSSIAN_MAX_RADIUS) / 3.0;
    let n = ((sigma / max_sigma).powi(2)).ceil().max(1.0) as usize;
    let s = sigma / (n as f32).sqrt();
    let radius = ((3.0 * s).ceil() as u32).min(u32::from(GAUSSIAN_MAX_RADIUS));
    let weights = cpu::gaussian_weights(&ConvGaussianParams::new(s, radius));
    let mut tmp = vec![Px([0.0; 4]); cur.len()];
    for _ in 0..n {
        for y in 0..h {
            let row = &cur[y * w..(y + 1) * w];
            for x in 0..w {
                tmp[y * w + x] = cpu::gaussian_axis(
                    |i| row[(x as i64 + i64::from(i)).clamp(0, w as i64 - 1) as usize],
                    &weights,
                );
            }
        }
        for y in 0..h {
            for x in 0..w {
                cur[y * w + x] = cpu::gaussian_axis(
                    |i| tmp[(y as i64 + i64::from(i)).clamp(0, h as i64 - 1) as usize * w + x],
                    &weights,
                );
            }
        }
    }
    cur
}

/// The scale a filter stack is evaluated at: 1 (the picture's own pixels)
/// when the build names no display density, else the density's share of
/// them, `px_per_pt · pt_per_px`, rounded UP to a power of two (1, ½, ¼ …)
/// so that zooming does not evaluate the stack again for every step.
pub(super) fn display_scale(px_per_pt: Option<f32>, pt_per_px: f32) -> f32 {
    let Some(density) = px_per_pt else {
        return 1.0;
    };
    let want = density * pt_per_px;
    if !(want.is_finite() && want > 0.0) || want >= 1.0 {
        return 1.0;
    }
    // 2^ceil(log2 want), never below 1/1024.
    (2f32).powi(want.log2().ceil().max(-10.0) as i32)
}

/// The cache key of a picture's adjusted twin: the picture, the stack (its
/// `Debug` form, hashed) and the scale.
pub(super) fn cache_key(picture: &str, ops: &[RasterOp], scale: f32) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    format!("{ops:?}").hash(&mut h);
    format!("{picture}#adjust:{:016x}@{scale}", h.finish())
}

/// The adjusted twin of a decoded picture at `scale`: decoded (a lazily
/// decoded picture, the wasm32 build's, now), reduced to `scale` of its
/// size with the Lanczos-3 of paged-resample, run through `ops`. Kept
/// RGBA-only (no `encoded` bytes), so every consumer draws and embeds the
/// adjusted pixels; the source's ICC profile stays with them.
pub(super) fn adjust_decoded(
    src: &paged_compose::DecodedImage,
    ops: &[RasterOp],
    scale: f32,
) -> Option<paged_compose::DecodedImage> {
    if src.width == 0 || src.height == 0 {
        return None;
    }
    let tw = ((src.width as f32 * scale).round() as u32).max(1);
    let th = ((src.height as f32 * scale).round() as u32).max(1);
    let decoded;
    let (rgba, bw, bh): (&[u8], u32, u32) = if src.rgba.is_empty() {
        decoded = super::image_decode::decode_image_bytes_with(
            &src.encoded,
            tw.max(th),
            src.rendering.unwrap_or_default(),
        )?;
        (&decoded.rgba, decoded.width, decoded.height)
    } else {
        (&src.rgba, src.width, src.height)
    };
    if rgba.len() != (bw as usize) * (bh as usize) * 4 {
        return None;
    }
    let reduced;
    let (pixels, w, h) = if bw > tw || bh > th {
        reduced =
            paged_resample::resize_rgba8(rgba, bw, bh, tw, th, paged_resample::Filter::Lanczos3)
                .ok()?;
        (reduced.as_slice(), tw, th)
    } else {
        (rgba, bw, bh)
    };
    let eval_scale = w as f32 / src.width as f32;
    let out = apply_rgba8(pixels, w, h, ops, eval_scale);
    Some(paged_compose::DecodedImage {
        width: w,
        height: h,
        encoded: bytes::Bytes::new(),
        rgba: bytes::Bytes::from(out),
        icc: src.icc.clone(),
        rendering: None,
    })
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature row.
mod tests {
    use super::*;

    fn grey(v: u8) -> Vec<u8> {
        vec![v, v, v, 255]
    }

    #[test]
    fn an_empty_stack_is_the_identity__feat__images_graphics_image_filter_stack() {
        let src: Vec<u8> = (0..64u8)
            .flat_map(|i| [i * 4, 255 - i * 4, i, 255])
            .collect();
        assert_eq!(apply_rgba8(&src, 8, 8, &[], 1.0), src);
    }

    #[test]
    fn exposure_doubles_the_light__feat__images_graphics_image_filter_stack() {
        // 2.2-encoded 0.5 is light 0.2176; doubled 0.4353; encoded 0.6849.
        let out = apply_rgba8(&grey(128), 1, 1, &[RasterOp::Exposure { ev: 1.0 }], 1.0);
        assert!((i32::from(out[0]) - 175).abs() <= 1, "{out:?}");
        assert_eq!(out[3], 255);
    }

    #[test]
    fn invert_and_threshold__feat__images_graphics_image_filter_stack() {
        let out = apply_rgba8(&[10, 200, 30, 255], 1, 1, &[RasterOp::Invert], 1.0);
        assert_eq!(out, vec![245, 55, 225, 255]);
        let t = apply_rgba8(&grey(100), 1, 1, &[RasterOp::Threshold { level: 0.5 }], 1.0);
        assert_eq!(t, grey(0));
        let t = apply_rgba8(&grey(200), 1, 1, &[RasterOp::Threshold { level: 0.5 }], 1.0);
        assert_eq!(t, grey(255));
    }

    #[test]
    fn duotone_maps_black_and_white_to_its_inks__feat__images_graphics_image_filter_stack() {
        let op = RasterOp::Duotone {
            shadow: [0.2, 0.0, 0.4],
            highlight: [1.0, 0.8, 0.0],
        };
        let src = [0, 0, 0, 255, 255, 255, 255, 255];
        let out = apply_rgba8(&src, 2, 1, &[op], 1.0);
        assert_eq!(&out[..4], &[51, 0, 102, 255]);
        assert_eq!(&out[4..], &[255, 204, 0, 255]);
    }

    #[test]
    fn recolor_and_black_white_leave_no_other_hue__feat__images_graphics_image_filter_stack() {
        let bw = apply_rgba8(
            &[200, 40, 40, 255],
            1,
            1,
            &[RasterOp::BlackWhite {
                reds: 0.4,
                yellows: 0.6,
                greens: 0.4,
                cyans: 0.6,
                blues: 0.2,
                magentas: 0.8,
            }],
            1.0,
        );
        assert!(bw[0] == bw[1] && bw[1] == bw[2], "{bw:?}");
        let rc = apply_rgba8(
            &[60, 200, 90, 255],
            1,
            1,
            &[RasterOp::Recolor {
                hue: 0.0,
                saturation: 0.5,
                lightness: 0.0,
            }],
            1.0,
        );
        assert!(rc[0] > rc[1] && rc[1] == rc[2], "a red tint: {rc:?}");
    }

    #[test]
    fn curves_follow_their_points__feat__images_graphics_image_filter_stack() {
        let lift = RasterOp::Curves {
            points: vec![[0.0, 0.0], [0.5, 0.75], [1.0, 1.0]],
        };
        let out = apply_rgba8(&grey(128), 1, 1, &[lift], 1.0);
        assert!((i32::from(out[0]) - 191).abs() <= 2, "{out:?}");
    }

    #[test]
    fn blur_spreads_and_keeps_the_mean__feat__images_graphics_image_filter_stack() {
        // One white column in a black 9×1 strip.
        let mut src = vec![0u8; 9 * 4];
        for x in 0..9 {
            src[x * 4 + 3] = 255;
        }
        src[4 * 4..4 * 4 + 3].copy_from_slice(&[255, 255, 255]);
        let out = apply_rgba8(&src, 9, 1, &[RasterOp::Blur { radius: 1.0 }], 1.0);
        assert!(out[4 * 4] < 255 && out[3 * 4] > 0, "{out:?}");
        let sum: u32 = (0..9).map(|x| u32::from(out[x * 4])).sum();
        assert!(
            (sum as i32 - 255).abs() <= 6,
            "the blur keeps the light: {sum}"
        );
        // A reduced raster blurs by the reduced radius: at scale 0 nothing moves.
        assert_eq!(
            apply_rgba8(&src, 9, 1, &[RasterOp::Blur { radius: 1.0 }], 0.0),
            src
        );
    }

    #[test]
    fn a_wide_blur_runs_in_passes__feat__images_graphics_image_filter_stack() {
        let mut src = vec![0u8; 101 * 4];
        for x in 0..101 {
            src[x * 4 + 3] = 255;
        }
        src[50 * 4..50 * 4 + 3].copy_from_slice(&[255, 255, 255]);
        let out = apply_rgba8(&src, 101, 1, &[RasterOp::Blur { radius: 20.0 }], 1.0);
        // σ = 20 reaches 30 px out with a visible tail (one pass ends at 24).
        assert!(
            out[(50 + 30) * 4] > 0 || out[(50 + 26) * 4] > 0,
            "{:?}",
            &out[300..]
        );
    }

    #[test]
    fn the_display_scale_is_a_power_of_two__feat__images_graphics_image_filter_stack() {
        assert_eq!(display_scale(None, 0.1), 1.0);
        assert_eq!(display_scale(Some(2.0), 1.0), 1.0);
        assert_eq!(display_scale(Some(2.0), 0.24), 0.5);
        assert_eq!(display_scale(Some(2.0), 0.2), 0.5);
        assert_eq!(display_scale(Some(2.0), 0.12), 0.25);
        let ops = [RasterOp::Invert];
        assert_ne!(cache_key("a", &ops, 1.0), cache_key("a", &ops, 0.5));
        assert_ne!(cache_key("a", &ops, 1.0), cache_key("b", &ops, 1.0));
        assert_ne!(
            cache_key("a", &ops, 1.0),
            cache_key("a", &[RasterOp::Blur { radius: 1.0 }], 1.0)
        );
    }

    #[test]
    fn a_picture_is_reduced_before_it_is_adjusted__feat__images_graphics_image_filter_stack() {
        let src = paged_compose::DecodedImage {
            width: 8,
            height: 4,
            encoded: bytes::Bytes::new(),
            rgba: bytes::Bytes::from(vec![200u8; 8 * 4 * 4]),
            icc: None,
            rendering: None,
        };
        let d = adjust_decoded(&src, &[RasterOp::Invert], 0.5).unwrap();
        assert_eq!((d.width, d.height), (4, 2));
        assert!(d.encoded.is_empty());
        assert!(d.rgba.chunks(4).all(|p| p[0] == 55));
    }

    #[test]
    fn sharpen_raises_an_edge__feat__images_graphics_image_filter_stack() {
        let src: Vec<u8> = (0..8)
            .flat_map(|x| if x < 4 { grey(80) } else { grey(160) })
            .collect();
        let out = apply_rgba8(
            &src,
            8,
            1,
            &[RasterOp::Sharpen {
                amount: 1.0,
                radius: 1.0,
            }],
            1.0,
        );
        assert!(out[3 * 4] < 80 && out[4 * 4] > 160, "{out:?}");
    }
}
