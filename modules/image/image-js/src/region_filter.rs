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

//! A filter on a region: the adjustment chain applied to a rectangle of
//! a straight RGBA8 image, in place.
//!
//! Two lanes, one chain ([`adjust_stages`]):
//!
//! - where a GPU device exists, [`filter_region_gpu`] runs the chain on
//!   the pipeline with the rectangle as the selection coverage — the
//!   same path as "Apply" within a rectangular selection;
//! - where none does (the Node CLI, a headless host), [`filter_region_cpu`]
//!   runs the shipped CPU twins of the same kernels
//!   (`image_kernels::cpu`; ADR 465, the exception to ADR 450).
//!
//! The CPU lane models the GPU lane, not an idealised filter: the input
//! is bridged to f16 as the pipeline's decode bridge does (`v / 255`),
//! every stage's output is stored as f16 (the rgba16float texture between
//! dispatches), every stage is masked by the region (`mix(a, result, m)`
//! with `m` 1 inside and 0 outside, so a window that reaches past the
//! region reads unfiltered pixels, as on the GPU), a window repeats the
//! image's edge pixel, and the result leaves through the sink's
//! `clamp(v, 0, 1) · 255 + 0.5` round. The curves table runs last over
//! the region, as `adjust_rgba8` does.

use std::sync::Arc;

use half::f16;
use image_gpu::{GpuContext, SelectionCoverage};
use image_kernels::cpu::{self, Px};
use image_kernels::families::conv::{ConvGaussianParams, GAUSSIAN_MAX_RADIUS};

use crate::ingest::{
    adjust_rgba8_uncached, adjust_stages, AdjustParams, AdjustStage, DecodedImage,
};

/// A pixel rectangle `[x, x + w) × [y, y + h)` of the image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl PixelRect {
    /// Why `self` is not a region of a `width × height` image, or `None`.
    pub fn problem(&self, width: u32, height: u32) -> Option<String> {
        if self.w == 0 || self.h == 0 {
            return Some("the region is empty".into());
        }
        let right = u64::from(self.x) + u64::from(self.w);
        let bottom = u64::from(self.y) + u64::from(self.h);
        if right > u64::from(width) || bottom > u64::from(height) {
            return Some(format!(
                "the region must lie inside the {width}×{height} image"
            ));
        }
        None
    }
}

/// The f16 store between stages.
fn q(p: Px) -> Px {
    Px(p.0.map(|c| f16::from_f32(c).to_f32()))
}

/// The working window: the region grown by the widest stage window,
/// clamped to the image. Pixels outside the region stay unfiltered at
/// every stage, so a window centred in the region never needs more.
struct Work {
    x0: u32,
    y0: u32,
    w: u32,
    h: u32,
    px: Vec<Px>,
}

impl Work {
    fn at(&self, x: i32, y: i32) -> Px {
        // The pipeline repeats the IMAGE's edge pixel; the window reaches
        // the image edge exactly where the clamp below bites.
        let x = x.clamp(self.x0 as i32, (self.x0 + self.w) as i32 - 1) as u32;
        let y = y.clamp(self.y0 as i32, (self.y0 + self.h) as i32 - 1) as u32;
        self.px[((y - self.y0) * self.w + (x - self.x0)) as usize]
    }
}

/// One masked Gaussian pass over `src`: inside `rect` the convolution,
/// outside the input as is.
fn gaussian_pass(src: &Work, rect: PixelRect, p: &ConvGaussianParams, horizontal: bool) -> Work {
    let weights = cpu::gaussian_weights(p);
    let mut px = src.px.clone();
    for y in rect.y..rect.y + rect.h {
        for x in rect.x..rect.x + rect.w {
            let (xi, yi) = (x as i32, y as i32);
            let v = if horizontal {
                cpu::gaussian_axis(|i| src.at(xi + i, yi), &weights)
            } else {
                cpu::gaussian_axis(|i| src.at(xi, yi + i), &weights)
            };
            px[((y - src.y0) * src.w + (x - src.x0)) as usize] = q(v);
        }
    }
    Work { px, ..*src }
}

fn blur(src: &Work, rect: PixelRect, p: &ConvGaussianParams) -> Work {
    let h = gaussian_pass(src, rect, p, true);
    gaussian_pass(&h, rect, p, false)
}

/// The chain on the CPU, over `rect` of a `width × height` straight
/// RGBA8 image, in place. Pixels outside `rect` are untouched.
pub fn filter_region_cpu(
    width: u32,
    height: u32,
    rgba: &mut [u8],
    params: &AdjustParams,
    rect: PixelRect,
) -> Result<(), String> {
    if let Some(why) = rect.problem(width, height) {
        return Err(why);
    }
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(format!(
            "expected {}×{} RGBA8 ({} bytes), got {}",
            width,
            height,
            width as usize * height as usize * 4,
            rgba.len()
        ));
    }
    let stages = adjust_stages(params);
    if !stages.is_empty() {
        let windowed = stages
            .iter()
            .any(|s| matches!(s, AdjustStage::Blur(_) | AdjustStage::Sharpen(..)));
        let margin = if windowed {
            u32::from(GAUSSIAN_MAX_RADIUS)
        } else {
            0
        };
        let x0 = rect.x.saturating_sub(margin);
        let y0 = rect.y.saturating_sub(margin);
        let x1 = (rect.x + rect.w + margin).min(width);
        let y1 = (rect.y + rect.h + margin).min(height);
        let (ww, wh) = (x1 - x0, y1 - y0);
        let mut work = Work {
            x0,
            y0,
            w: ww,
            h: wh,
            px: Vec::with_capacity(ww as usize * wh as usize),
        };
        for y in y0..y1 {
            for x in x0..x1 {
                let o = (y as usize * width as usize + x as usize) * 4;
                work.px.push(q(Px(std::array::from_fn(|c| {
                    f32::from(rgba[o + c]) / 255.0
                }))));
            }
        }
        for stage in &stages {
            work = run_stage(work, rect, stage);
        }
        let out = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        for y in rect.y..rect.y + rect.h {
            for x in rect.x..rect.x + rect.w {
                let p = work.px[((y - y0) * ww + (x - x0)) as usize];
                let o = (y as usize * width as usize + x as usize) * 4;
                for c in 0..4 {
                    rgba[o + c] = out(p.0[c]);
                }
            }
        }
    }
    if let Some(luts) = params.effective_curves() {
        for y in rect.y..rect.y + rect.h {
            for x in rect.x..rect.x + rect.w {
                let o = (y as usize * width as usize + x as usize) * 4;
                for (c, lut) in luts.iter().enumerate() {
                    rgba[o + c] = lut[rgba[o + c] as usize];
                }
            }
        }
    }
    Ok(())
}

/// Apply one stage inside `rect` (the mask is 1 there, 0 elsewhere).
fn run_stage(mut work: Work, rect: PixelRect, stage: &AdjustStage) -> Work {
    use AdjustStage as S;
    let point = |work: &mut Work, f: &dyn Fn(Px) -> Px| {
        for y in rect.y..rect.y + rect.h {
            for x in rect.x..rect.x + rect.w {
                let i = ((y - work.y0) * work.w + (x - work.x0)) as usize;
                work.px[i] = q(f(work.px[i]));
            }
        }
    };
    match stage {
        S::Exposure(p) => point(&mut work, &|a| cpu::exposure(a, p)),
        S::WhiteBalance(p) => point(&mut work, &|a| cpu::white_balance(a, p)),
        S::Levels(p) => point(&mut work, &|a| cpu::levels(a, p)),
        S::LevelsRgb(p) => point(&mut work, &|a| cpu::levels_rgb(a, p)),
        S::BrightnessContrast(p) => point(&mut work, &|a| cpu::brightness_contrast(a, p)),
        S::ColorBalance(p) => point(&mut work, &|a| cpu::color_balance(a, p)),
        S::PhotoFilter(p) => point(&mut work, &|a| cpu::photo_filter(a, p)),
        S::ChannelMixer(p) => point(&mut work, &|a| cpu::channel_mixer(a, p)),
        S::Vibrance(p) => point(&mut work, &|a| cpu::vibrance(a, p)),
        S::Saturation(p) => point(&mut work, &|a| cpu::saturation(a, p)),
        S::BlackWhite(p) => point(&mut work, &|a| cpu::black_white(a, p)),
        S::Posterize(p) => point(&mut work, &|a| cpu::posterize(a, p)),
        S::Threshold(p) => point(&mut work, &|a| cpu::threshold(a, p)),
        S::HueRotate(p) => point(&mut work, &|a| cpu::hue_rotate(a, p)),
        S::HueSaturation(p) => point(&mut work, &|a| cpu::hue_saturation(a, p)),
        S::Invert => point(&mut work, &cpu::invert_rgb),
        S::Blur(p) => work = blur(&work, rect, p),
        S::Sharpen(g, u) => {
            let blurred = blur(&work, rect, g);
            for y in rect.y..rect.y + rect.h {
                for x in rect.x..rect.x + rect.w {
                    let i = ((y - work.y0) * work.w + (x - work.x0)) as usize;
                    work.px[i] = q(cpu::unsharp(work.px[i], blurred.px[i], u));
                }
            }
        }
    }
    work
}

/// The rectangle as a selection coverage over the whole image (255
/// inside, 0 outside): the GPU lane's mask.
pub fn region_coverage(width: u32, height: u32, rect: PixelRect) -> SelectionCoverage {
    let mut data = vec![0u8; width as usize * height as usize];
    for y in rect.y..rect.y + rect.h {
        let row = y as usize * width as usize;
        data[row + rect.x as usize..row + (rect.x + rect.w) as usize].fill(255);
    }
    SelectionCoverage::from_data(width, height, data).expect("width·height coverage")
}

/// The chain on the GPU pipeline, masked to `rect` — "Apply" within a
/// rectangular selection. Pixels outside `rect` are left as they were.
pub async fn filter_region_gpu(
    ctx: &GpuContext,
    width: u32,
    height: u32,
    rgba: &mut [u8],
    params: &AdjustParams,
    rect: PixelRect,
) -> Result<(), String> {
    if let Some(why) = rect.problem(width, height) {
        return Err(why);
    }
    if params.is_identity() {
        return Ok(());
    }
    let img = DecodedImage::from_rgba8(width, height, rgba.to_vec()).map_err(|e| e.to_string())?;
    let coverage = Arc::new(region_coverage(width, height, rect));
    let out = adjust_rgba8_uncached(ctx, &img, params, Some(coverage))
        .await
        .map_err(|e| e.to_string())?;
    for y in rect.y..rect.y + rect.h {
        let a = (y as usize * width as usize + rect.x as usize) * 4;
        let b = a + rect.w as usize * 4;
        rgba[a..b].copy_from_slice(&out[a..b]);
    }
    Ok(())
}
