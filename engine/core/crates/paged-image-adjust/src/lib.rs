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

//! Engine ADR 1037 — an image frame's filter stack, evaluated: the one
//! evaluator of the renderer, paged.sheet's grid and paged.image's actions
//! (amendment 2026-11-11).
//!
//! Every op runs on the CPU through the shipped kernel twins of
//! `paged-kernels` (the curve through paged-pixel's natural spline), over
//! premultiplied `f32` pixels, the working space those twins are written
//! for. The result is a raster the display list carries like any decoded
//! picture, so both rasterizers draw the same pixels (ADR 146's rule: one
//! builder for both lanes) and the PDF export embeds them.

pub mod develop;
pub mod tables;

use paged_kernels::cpu;
use paged_kernels::families::adjust::SelectiveColorParams;
use paged_kernels::families::develop::DevelopSettings;
use paged_kernels::params::{
    AdjustBlackWhiteParams, AdjustBrightnessContrastParams, AdjustChannelMixerParams,
    AdjustColorBalanceParams, AdjustExposureParams, AdjustGradientMapParams,
    AdjustHueSaturationParams, AdjustPhotoFilterParams, AdjustPosterizeParams,
    AdjustSaturationParams, AdjustThresholdParams, AdjustVibranceParams, AdjustWhiteBalanceParams,
    ConvGaussianParams, ConvUnsharpParams, GAUSSIAN_MAX_RADIUS,
};
use paged_kernels::Px;
use paged_model::{LevelsRecord, RasterOp};

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
    apply_px(&mut px, width, height, ops, scale);
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

/// Applies `ops`, in order, to premultiplied `f32` pixels of `width ×
/// height` (the working space of the twins).
pub fn apply_px(px: &mut [Px], width: u32, height: u32, ops: &[RasterOp], scale: f32) {
    let (w, h) = (width as usize, height as usize);
    for op in ops {
        apply_op(px, w, h, op, scale);
    }
}

fn point(px: &mut [Px], f: impl Fn(Px) -> Px) {
    for p in px.iter_mut() {
        *p = f(*p);
    }
}

/// An 8-bit table at a straight value, interpolated between its entries
/// (at an 8-bit input, the entry itself).
fn table_at(lut: &[u8; 256], x: f32) -> f32 {
    let t = x.clamp(0.0, 1.0) * 255.0;
    let lo = t.floor() as usize;
    let hi = (lo + 1).min(255);
    let f = t - t.floor();
    (f32::from(lut[lo]) * (1.0 - f) + f32::from(lut[hi]) * f) / 255.0
}

/// Per-channel tables (red, green, blue) and then a composite one, on the
/// straight colour: Photoshop's order for Levels and Curves.
fn apply_tables(px: &mut [Px], channels: Option<[[u8; 256]; 3]>, composite: Option<[u8; 256]>) {
    if channels.is_none() && composite.is_none() {
        return;
    }
    point(px, |a| {
        let al = a.0[3];
        if al == 0.0 {
            return a;
        }
        let mut c = [a.0[0] / al, a.0[1] / al, a.0[2] / al];
        if let Some(t) = &channels {
            for (k, v) in c.iter_mut().enumerate() {
                *v = table_at(&t[k], *v);
            }
        }
        if let Some(t) = &composite {
            for v in c.iter_mut() {
                *v = table_at(t, *v);
            }
        }
        Px([c[0] * al, c[1] * al, c[2] * al, al])
    });
}

/// A table that is not the identity, or none.
fn non_identity(t: [u8; 256]) -> Option<[u8; 256]> {
    (t != tables::identity_table()).then_some(t)
}

/// The tables of a Levels op: per channel, then the composite; `None` where
/// a record is the identity.
pub fn levels_tables(
    master: &LevelsRecord,
    channels: Option<&[LevelsRecord; 3]>,
) -> (Option<[[u8; 256]; 3]>, Option<[u8; 256]>) {
    let rgb = channels
        .filter(|c| c.iter().any(|r| *r != LevelsRecord::IDENTITY))
        .map(|c| c.map(|r| tables::levels_table(&r)));
    let comp = (*master != LevelsRecord::IDENTITY).then(|| tables::levels_table(master));
    (rgb, comp)
}

/// The tables of a Curves op: per channel (an empty list the identity),
/// then the composite; `None` where there is no curve.
pub fn curves_tables(
    points: &[[f32; 2]],
    channels: Option<&[Vec<[f32; 2]>; 3]>,
) -> (Option<[[u8; 256]; 3]>, Option<[u8; 256]>) {
    let table = |p: &[[f32; 2]]| {
        if p.is_empty() {
            tables::identity_table()
        } else {
            tables::curve_table(p)
        }
    };
    let rgb = channels
        .filter(|c| c.iter().any(|p| !p.is_empty()))
        .map(|c| [table(&c[0]), table(&c[1]), table(&c[2])]);
    let comp = (!points.is_empty()).then(|| tables::curve_table(points));
    (rgb, comp)
}

/// The `adjust.hue_saturation` block of a Hue/Saturation op.
pub fn hue_saturation_params(
    master: [f32; 3],
    ranges: Option<&[[f32; 3]; 6]>,
    colorize: Option<[f32; 3]>,
) -> AdjustHueSaturationParams {
    let mut p = AdjustHueSaturationParams::identity();
    p.master = [master[0], master[1], master[2], 0.0];
    if let Some(r) = ranges {
        for (k, t) in r.iter().enumerate() {
            p.ranges[k] = [t[0], t[1], t[2], 0.0];
        }
    }
    if let Some(c) = colorize {
        p.colorize = [1.0, c[0].rem_euclid(360.0), c[1], c[2]];
    }
    p
}

/// The channel mixer's block; a monochrome mixer is its red row on every
/// output.
pub fn channel_mixer_params(
    red: [f32; 4],
    green: [f32; 4],
    blue: [f32; 4],
    monochrome: bool,
) -> AdjustChannelMixerParams {
    if monochrome {
        AdjustChannelMixerParams::new(red, red, red)
    } else {
        AdjustChannelMixerParams::new(red, green, blue)
    }
}

/// The `adjust.gradient_map` block of a gradient map.
pub fn gradient_map_params(
    stops: &[paged_model::GradientMapStop],
    reverse: bool,
) -> AdjustGradientMapParams {
    let ramp = tables::gradient_ramp(stops, reverse);
    AdjustGradientMapParams::from_fn(|t| ramp[((t * 255.0).round() as usize).min(255)])
}

/// The `adjust.selective_color` blocks of a Selective Color op: one per
/// range that changes anything, in range order.
pub fn selective_color_params(ranges: &[[f32; 4]; 9], absolute: bool) -> Vec<SelectiveColorParams> {
    ranges
        .iter()
        .enumerate()
        .filter(|(_, r)| r.iter().any(|v| *v != 0.0))
        .map(|(k, r)| SelectiveColorParams::new(k as u32, r[0], r[1], r[2], r[3], absolute))
        .collect()
}

/// A Develop op's settings, clamped to the controls' ranges; `None` for a
/// block of the wrong length.
pub fn develop_settings(settings: &[f32]) -> Option<DevelopSettings> {
    DevelopSettings::from_values(settings)
}

fn apply_op(px: &mut [Px], w: usize, h: usize, op: &RasterOp, scale: f32) {
    match *op {
        RasterOp::Exposure { ev, offset, gamma } => {
            if offset == 0.0 && gamma == 1.0 {
                let p = AdjustExposureParams::encoded(ev);
                point(px, |a| cpu::exposure(a, &p));
            } else {
                // Photoshop's offset and gamma: its measured table.
                apply_tables(
                    px,
                    None,
                    non_identity(tables::exposure_table(ev, offset, gamma)),
                );
            }
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
            ref channels,
        } => {
            let master = LevelsRecord {
                in_black,
                in_white,
                gamma,
                out_black,
                out_white,
            };
            let (rgb, comp) = levels_tables(&master, channels.as_ref());
            apply_tables(px, rgb, comp);
        }
        RasterOp::Curves {
            ref points,
            ref channels,
        } => {
            let (rgb, comp) = curves_tables(points, channels.as_ref());
            apply_tables(px, rgb, comp);
        }
        RasterOp::HueSaturation {
            hue,
            saturation,
            lightness,
            ref ranges,
            colorize,
        } => {
            let p = hue_saturation_params([hue, saturation, lightness], ranges.as_ref(), colorize);
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
        RasterOp::ChannelMixer {
            red,
            green,
            blue,
            monochrome,
        } => {
            // Clamped after the mix, as Photoshop's and CSS's mixers are:
            // the next op sees colours in the gamut.
            let p = channel_mixer_params(red, green, blue, monochrome);
            point(px, |a| {
                let m = cpu::channel_mixer(a, &p);
                let al = m.0[3];
                Px([
                    m.0[0].clamp(0.0, al),
                    m.0[1].clamp(0.0, al),
                    m.0[2].clamp(0.0, al),
                    al,
                ])
            });
        }
        RasterOp::ColorReplace {
            from,
            to,
            alpha,
            tolerance,
        } => {
            point(px, |a| cpu::color_replace(a, from, to, alpha, tolerance));
        }
        RasterOp::Vibrance {
            vibrance,
            saturation,
        } => {
            // Vibrance first: it reads the chroma before the saturation.
            if vibrance != 0.0 {
                let p = AdjustVibranceParams::new(vibrance, 0.0);
                point(px, |a| cpu::vibrance(a, &p));
            }
            if saturation != 0.0 {
                let p = AdjustSaturationParams::new(1.0 + saturation);
                point(px, |a| cpu::saturation(a, &p));
            }
        }
        RasterOp::ColorBalance {
            shadows,
            midtones,
            highlights,
            ..
        } => {
            if [shadows, midtones, highlights]
                .iter()
                .any(|t| t.iter().any(|v| *v != 0.0))
            {
                let p = AdjustColorBalanceParams::new(shadows, midtones, highlights);
                point(px, |a| cpu::color_balance(a, &p));
            }
        }
        RasterOp::PhotoFilter {
            color,
            density,
            preserve_luminosity,
        } => {
            if density != 0.0 {
                let p = AdjustPhotoFilterParams::new(color, density, preserve_luminosity);
                point(px, |a| cpu::photo_filter(a, &p));
            }
        }
        RasterOp::SelectiveColor {
            ref ranges,
            absolute,
        } => {
            for p in selective_color_params(ranges, absolute) {
                point(px, |a| cpu::selective_color(a, &p));
            }
        }
        RasterOp::GradientMap { ref stops, reverse } => {
            let p = gradient_map_params(stops, reverse);
            point(px, |a| cpu::gradient_map(a, &p));
        }
        RasterOp::ColorLookup { size, ref cube, .. } => {
            point(px, |a| cpu::lut3d_cube(a, cube, size as usize));
        }
        RasterOp::Develop { ref settings } => {
            let Some(s) = develop_settings(settings) else {
                return;
            };
            let (wu, hu) = (w as u32, h as u32);
            if !s.tone_is_identity() {
                let p = s.tone_params();
                let src = px.to_vec();
                for y in 0..hu {
                    for x in 0..wu {
                        px[(y * wu + x) as usize] = develop::tone(&src, wu, hu, x, y, &p);
                    }
                }
            }
            if !s.detail_is_identity() {
                let p = s.detail_params();
                let src = px.to_vec();
                for y in 0..hu {
                    for x in 0..wu {
                        px[(y * wu + x) as usize] = develop::detail(&src, wu, hu, x, y, &p);
                    }
                }
            }
        }
        RasterOp::WhiteBalance { temperature, tint } => {
            if temperature != 0.0 || tint != 0.0 {
                let p = AdjustWhiteBalanceParams::new(temperature, tint);
                point(px, |a| cpu::white_balance(a, &p));
            }
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

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__` suffixes link the cockpit feature row.
mod tests {
    use super::*;

    fn grey(v: u8) -> Vec<u8> {
        vec![v, v, v, 255]
    }

    #[test]
    fn a_channel_mixer_mixes_and_clamps__feat__images_graphics_image_filter_stack() {
        // CSS `grayscale(1)`: every row the Rec. 709 luma.
        let luma = [0.2126, 0.7152, 0.0722, 0.0];
        let op = RasterOp::channel_mixer(luma, luma, luma);
        let out = apply_rgba8(&[255, 0, 0, 255], 1, 1, &[op], 1.0);
        assert_eq!(out, vec![54, 54, 54, 255]);
        // A gain past the gamut clamps before the next op.
        let gain = RasterOp::channel_mixer(
            [2.0, 0.0, 0.0, 0.0],
            [0.0, 2.0, 0.0, 0.0],
            [0.0, 0.0, 2.0, 0.0],
        );
        let out = apply_rgba8(&grey(200), 1, 1, &[gain, RasterOp::Invert], 1.0);
        assert_eq!(out, vec![0, 0, 0, 255]);
    }

    #[test]
    fn a_colour_replace_makes_one_colour_transparent__feat__images_graphics_image_filter_stack() {
        let op = RasterOp::ColorReplace {
            from: [1.0, 1.0, 1.0],
            to: [1.0, 1.0, 1.0],
            alpha: 0.0,
            tolerance: 0.0,
        };
        let src = [255, 255, 255, 255, 10, 20, 30, 255];
        let out = apply_rgba8(&src, 2, 1, &[op], 1.0);
        assert_eq!(out, vec![0, 0, 0, 0, 10, 20, 30, 255]);
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
        let out = apply_rgba8(&grey(128), 1, 1, &[RasterOp::exposure(1.0)], 1.0);
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
        let lift = RasterOp::curves(vec![[0.0, 0.0], [0.5, 0.75], [1.0, 1.0]]);
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

    #[test]
    fn the_develop_block_is_the_kernels__feat__images_graphics_image_filter_stack() {
        assert_eq!(
            paged_model::image_adjust::DEVELOP_SETTINGS,
            paged_kernels::families::develop::DEVELOP_LEN
        );
        assert_eq!(
            paged_model::image_adjust::COLOR_LOOKUP_MAX_SIZE as usize,
            65,
            "a 64-point cube and its closing edge"
        );
    }

    #[test]
    fn levels_apply_the_channel_record_then_the_composite__feat__images_graphics_image_filter_stack(
    ) {
        let rec = |ib: f32, ob: f32| LevelsRecord {
            in_black: ib,
            in_white: 1.0,
            gamma: 1.0,
            out_black: ob,
            out_white: 1.0,
        };
        let op = RasterOp::Levels {
            in_black: 0.0,
            in_white: 1.0,
            gamma: 1.0,
            out_black: 0.5,
            out_white: 1.0,
            channels: Some([
                rec(0.5, 0.0),
                LevelsRecord::IDENTITY,
                LevelsRecord::IDENTITY,
            ]),
        };
        // Red 128: the channel record takes it to 1 (level 1 of 255 after
        // the input black of 127.5), then the composite lifts its black to
        // 128; green and blue only see the composite.
        let out = apply_rgba8(&[128, 0, 255, 255], 1, 1, &[op], 1.0);
        assert!((i32::from(out[0]) - 128).abs() <= 1, "{out:?}");
        assert_eq!(out[1], 128);
        assert_eq!(out[2], 255);
    }

    #[test]
    fn photoshop_exposure_with_offset_and_gamma_is_its_table__feat__images_graphics_image_filter_stack(
    ) {
        let op = RasterOp::Exposure {
            ev: 0.4,
            offset: -0.03,
            gamma: 1.2,
        };
        let src: Vec<u8> = (0..=255u8).flat_map(|v| [v, v, v, 255]).collect();
        let out = apply_rgba8(&src, 256, 1, &[op], 1.0);
        let t = tables::exposure_table(0.4, -0.03, 1.2);
        for v in 0..256 {
            assert_eq!(out[v * 4], t[v], "level {v}");
        }
    }

    #[test]
    fn per_channel_curves_leave_the_other_channels__feat__images_graphics_image_filter_stack() {
        let op = RasterOp::Curves {
            points: vec![],
            channels: Some([vec![[0.0, 0.0], [0.5, 0.75], [1.0, 1.0]], vec![], vec![]]),
        };
        let out = apply_rgba8(&grey(128), 1, 1, &[op], 1.0);
        assert!(out[0] > 180 && out[1] == 128 && out[2] == 128, "{out:?}");
    }

    #[test]
    fn vibrance_white_balance_and_photo_filter_move_colour__feat__images_graphics_image_filter_stack(
    ) {
        let dull = [140, 120, 110, 255];
        let v = apply_rgba8(
            &dull,
            1,
            1,
            &[RasterOp::Vibrance {
                vibrance: 0.8,
                saturation: 0.0,
            }],
            1.0,
        );
        assert!(i32::from(v[0]) - i32::from(v[2]) > 30, "more chroma: {v:?}");
        let wb = apply_rgba8(
            &grey(128),
            1,
            1,
            &[RasterOp::WhiteBalance {
                temperature: 0.2,
                tint: 0.0,
            }],
            1.0,
        );
        assert!(wb[0] > 128 && wb[2] < 128, "warmer: {wb:?}");
        let pf = apply_rgba8(
            &grey(128),
            1,
            1,
            &[RasterOp::PhotoFilter {
                color: [1.0, 0.5, 0.0],
                density: 0.5,
                preserve_luminosity: false,
            }],
            1.0,
        );
        assert!(pf[0] > pf[2], "a warm gel: {pf:?}");
    }

    #[test]
    fn a_colour_lookup_of_any_size_and_selective_color__feat__images_graphics_image_filter_stack() {
        // A 2³ cube that swaps red and blue.
        let mut cube = Vec::new();
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    cube.extend_from_slice(&[b as f32, g as f32, r as f32]);
                }
            }
        }
        let op = RasterOp::ColorLookup {
            name: "swap".into(),
            size: 2,
            cube,
        };
        assert!(op.is_valid());
        let out = apply_rgba8(&[200, 100, 20, 255], 1, 1, &[op], 1.0);
        assert_eq!(out, vec![20, 100, 200, 255]);
        let mut ranges = [[0.0f32; 4]; 9];
        ranges[0] = [0.5, 0.0, 0.0, 0.0];
        let sc = RasterOp::SelectiveColor {
            ranges,
            absolute: true,
        };
        let out = apply_rgba8(&[204, 51, 51, 255, 51, 51, 204, 255], 2, 1, &[sc], 1.0);
        assert!(out[0] < 180, "the red loses red: {out:?}");
        assert_eq!(&out[4..], &[51, 51, 204, 255], "the blue is not a red");
    }

    #[test]
    fn develop_at_its_defaults_is_the_identity_and_exposure_lifts__feat__images_graphics_image_filter_stack(
    ) {
        let src: Vec<u8> = (0..16u8)
            .flat_map(|i| [i * 16, 128, 255 - i * 16, 255])
            .collect();
        let id = DevelopSettings::identity().0.to_vec();
        assert_eq!(
            apply_rgba8(
                &src,
                4,
                4,
                &[RasterOp::Develop {
                    settings: id.clone()
                }],
                1.0
            ),
            src
        );
        let mut lift = id;
        lift[2] = 1.0;
        let out = apply_rgba8(&src, 4, 4, &[RasterOp::Develop { settings: lift }], 1.0);
        let sum = |v: &[u8]| v.iter().map(|&x| u32::from(x)).sum::<u32>();
        assert!(sum(&out) > sum(&src), "brighter");
    }

    #[test]
    fn a_gradient_map_maps_luminance_to_its_stops__feat__images_graphics_image_filter_stack() {
        let op = RasterOp::GradientMap {
            stops: vec![
                paged_model::GradientMapStop {
                    at: 0.0,
                    color: [0.2, 0.0, 0.4],
                },
                paged_model::GradientMapStop {
                    at: 1.0,
                    color: [1.0, 0.8, 0.0],
                },
            ],
            reverse: false,
        };
        let out = apply_rgba8(&[0, 0, 0, 255, 255, 255, 255, 255], 2, 1, &[op], 1.0);
        assert_eq!(&out[..4], &[51, 0, 102, 255]);
        assert_eq!(&out[4..], &[255, 204, 0, 255]);
    }
}
