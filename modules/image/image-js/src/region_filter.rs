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

//! A filter on a region: the adjustment chain applied to part of a
//! straight RGBA8 image, in place, through a coverage mask.
//!
//! The part is a [`SelectionCoverage`] at image resolution: a rectangle
//! ([`region_coverage`]), or a mask given as data ([`RegionMask`]:
//! polygons in image pixels with an optional feather, and/or an 8-bit
//! alpha mask, clipped to a rectangle; [`mask_coverage`]). Building it is
//! mask preparation, the CPU work ADR 450 allows; partial coverage blends
//! the filtered and the original pixel, as a feathered selection does in
//! the editor.
//!
//! Two lanes, one chain ([`adjust_stages`]):
//!
//! - where a GPU device exists, [`filter_masked_gpu`] runs the chain on
//!   the pipeline with the coverage as the selection — the same path as
//!   "Apply" within a selection;
//! - where none does (the Node CLI, a headless host), [`filter_masked_cpu`]
//!   runs the shipped CPU twins of the same kernels
//!   (`image_kernels::cpu`; ADR 465, the exception to ADR 450).
//!
//! The CPU lane models the GPU lane, not an idealised filter: the input
//! is bridged to f16 as the pipeline's decode bridge does (`v / 255`),
//! every stage's output is stored as f16 (the rgba16float texture between
//! dispatches), every stage is masked by the coverage (`mix(a, result, m)`
//! with `m` the coverage lowered to f16 as `mask_window_f16` lowers it,
//! so a window that reaches past the mask reads unfiltered pixels, as on
//! the GPU), a window repeats the image's edge pixel, and the result
//! leaves through the sink's `clamp(v, 0, 1) · 255 + 0.5` round. The
//! curves table runs last, blended by the same coverage, as
//! `adjust_rgba8` does. Pixels the coverage leaves at 0 are never written
//! by either lane.

use std::sync::Arc;

use half::f16;
use image_gpu::{CombineMode, GpuContext, SelectionCoverage};
use image_kernels::cpu::{self, Px};
use image_kernels::families::conv::{ConvGaussianParams, GAUSSIAN_MAX_RADIUS};

use crate::ingest::{
    adjust_rgba8_uncached, adjust_stages, apply_curve_luts_masked, AdjustParams, AdjustStage,
    DecodedImage,
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

/// The widest feather a mask takes (σ in image pixels). The feather is a
/// separable Gaussian over the whole mask; past this it is a different
/// tool.
pub const MAX_FEATHER: f32 = 250.0;

/// How the polygons of a mask fill (`fillRule`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FillRule {
    /// Each polygon filled on its own (even–odd within itself), the
    /// results unioned: overlapping polygons never cut each other. What a
    /// mask without a fill rule does.
    #[default]
    Union,
    /// The polygons filled together as one path by winding number: a
    /// point is inside where the polygons' signed crossings do not cancel,
    /// so an inner polygon wound the other way cuts a hole.
    NonZero,
    /// The polygons filled together as one path, even–odd: a point is
    /// inside where it lies within an odd number of polygons, so a
    /// polygon inside another cuts a hole whatever its winding.
    EvenOdd,
}

impl FillRule {
    /// Decode the wire discriminant (0 = union, 1 = non-zero, 2 = even–odd).
    pub fn from_u8(v: u8) -> Option<FillRule> {
        match v {
            0 => Some(FillRule::Union),
            1 => Some(FillRule::NonZero),
            2 => Some(FillRule::EvenOdd),
            _ => None,
        }
    }
}

/// How one polygon folds into the mask (`op`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PolygonOp {
    /// Part of the shape: the add polygons are filled together under the
    /// fill rule.
    #[default]
    Add,
    /// Cut out of the shape: `shape · (1 − polygon)`.
    Subtract,
    /// Keep only what lies within the polygon too: `min(shape, polygon)`.
    Intersect,
}

impl PolygonOp {
    /// Decode the wire discriminant (0 = add, 1 = subtract, 2 = intersect).
    pub fn from_u8(v: u8) -> Option<PolygonOp> {
        match v {
            0 => Some(PolygonOp::Add),
            1 => Some(PolygonOp::Subtract),
            2 => Some(PolygonOp::Intersect),
            _ => None,
        }
    }
}

/// A mask given as data — what a selection is when there is no session to
/// hold one. Every part given narrows the filtered area: the polygons'
/// shape, intersected with the alpha mask, feathered, then clipped to
/// the region.
///
/// The polygons' shape: the `Add` polygons filled under `fill_rule`
/// (all of them together, or each alone and unioned), then every
/// `Subtract` and `Intersect` polygon folded in, in order, each filled
/// alone (even–odd, or by the fill rule when one is given). Without an
/// `Add` polygon the shape starts as the whole image, as a mask without
/// polygons does.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RegionMask {
    /// Closed polygons in image pixels (`(x, y)`, fractional allowed),
    /// anti-aliased. Empty: no polygon constraint.
    pub polygons: Vec<Vec<(f32, f32)>>,
    /// Each polygon's op, in `polygons` order. Empty: every polygon adds.
    pub ops: Vec<PolygonOp>,
    /// How the add polygons fill together.
    pub fill_rule: FillRule,
    /// A Gaussian feather of the mask's edge, σ in image pixels (0: none).
    pub feather: f32,
    /// An 8-bit coverage, `width · height` bytes row-major (0 = untouched,
    /// 255 = fully filtered). `None`: no alpha constraint.
    pub alpha: Option<Vec<u8>>,
}

impl RegionMask {
    /// Whether the mask constrains nothing (the region alone decides).
    pub fn is_empty(&self) -> bool {
        self.polygons.is_empty() && self.alpha.is_none()
    }

    fn op(&self, i: usize) -> PolygonOp {
        self.ops.get(i).copied().unwrap_or_default()
    }
}

/// Rasterise closed polygons filled TOGETHER as one path under `rule`
/// (`NonZero` or `EvenOdd`; `Union` is treated as `EvenOdd` per path),
/// anti-aliased as the lasso is (`SelectionCoverage::rasterize_polygon`):
/// four sub-scanlines per pixel row, each crossed with every edge, the
/// inside spans accumulating analytic x-coverage at ¼ weight.
pub fn rasterize_polygons(
    width: u32,
    height: u32,
    polygons: &[&[(f32, f32)]],
    rule: FillRule,
) -> SelectionCoverage {
    let mut acc = vec![0.0f32; (width as usize) * (height as usize)];
    // (x, winding direction) per crossing of one sub-scanline.
    let mut xs: Vec<(f32, i32)> = Vec::with_capacity(16);
    for y in 0..height {
        for sub in 0..4u32 {
            let sy = y as f32 + (sub as f32 * 2.0 + 1.0) / 8.0;
            xs.clear();
            for poly in polygons.iter().filter(|p| p.len() >= 3) {
                let n = poly.len();
                for i in 0..n {
                    let (x0, y0) = poly[i];
                    let (x1, y1) = poly[(i + 1) % n];
                    // Half-open in y, as the lasso's rasteriser: a vertex
                    // on the scanline counts once.
                    let dir = if y0 <= sy && sy < y1 {
                        1
                    } else if y1 <= sy && sy < y0 {
                        -1
                    } else {
                        continue;
                    };
                    let t = (sy - y0) / (y1 - y0);
                    xs.push((x0 + t * (x1 - x0), dir));
                }
            }
            xs.sort_by(|a, b| a.0.partial_cmp(&b.0).expect("finite intersections"));
            let mut winding = 0i32;
            for k in 0..xs.len() {
                winding += xs[k].1;
                let inside = match rule {
                    FillRule::NonZero => winding != 0,
                    FillRule::EvenOdd | FillRule::Union => (k + 1) % 2 == 1,
                };
                if !inside || k + 1 == xs.len() {
                    continue;
                }
                let (xa, xb) = (xs[k].0.max(0.0), xs[k + 1].0.min(width as f32));
                if xb <= xa {
                    continue;
                }
                let first = xa.floor() as u32;
                let last = (xb.ceil() as u32).min(width);
                for px in first..last {
                    let cover = (xb.min(px as f32 + 1.0) - xa.max(px as f32)).max(0.0);
                    acc[(y * width + px) as usize] += cover * 0.25;
                }
            }
        }
    }
    let data = acc
        .iter()
        .map(|a| (a.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect();
    SelectionCoverage::from_data(width, height, data).expect("width · height bytes")
}

/// The polygons' shape (see [`RegionMask`]), or `None` without polygons.
fn polygon_shape(
    width: u32,
    height: u32,
    mask: &RegionMask,
) -> Result<Option<SelectionCoverage>, String> {
    if mask.polygons.is_empty() {
        return Ok(None);
    }
    if !mask.ops.is_empty() && mask.ops.len() != mask.polygons.len() {
        return Err(format!(
            "{} polygons name {} ops; give every polygon an op, or none",
            mask.polygons.len(),
            mask.ops.len()
        ));
    }
    for (i, poly) in mask.polygons.iter().enumerate() {
        if poly.len() < 3 {
            return Err(format!(
                "polygon {i} has {} points; a polygon needs at least 3",
                poly.len()
            ));
        }
        if poly.iter().any(|(x, y)| !x.is_finite() || !y.is_finite()) {
            return Err(format!("polygon {i} has a point that is not a number"));
        }
    }
    let adds: Vec<&[(f32, f32)]> = (0..mask.polygons.len())
        .filter(|&i| mask.op(i) == PolygonOp::Add)
        .map(|i| mask.polygons[i].as_slice())
        .collect();
    let mut shape = if adds.is_empty() {
        SelectionCoverage::full(width, height)
    } else if mask.fill_rule == FillRule::Union {
        let mut cov = SelectionCoverage::empty(width, height);
        for poly in &adds {
            cov.combine(
                &SelectionCoverage::rasterize_polygon(width, height, poly),
                CombineMode::Add,
            );
        }
        cov
    } else {
        rasterize_polygons(width, height, &adds, mask.fill_rule)
    };
    for (i, poly) in mask.polygons.iter().enumerate() {
        let mode = match mask.op(i) {
            PolygonOp::Add => continue,
            PolygonOp::Subtract => CombineMode::Subtract,
            PolygonOp::Intersect => CombineMode::Intersect,
        };
        let one = rasterize_polygons(width, height, &[poly.as_slice()], mask.fill_rule);
        shape.combine(&one, mode);
    }
    Ok(Some(shape))
}

/// Rasterise `mask` over a `width × height` image, clipped to `rect`.
/// The rectangle is a hard clip (pixel-exact, applied after the feather);
/// coverage outside it is 0. Errors name what is wrong with the mask.
pub fn mask_coverage(
    width: u32,
    height: u32,
    rect: PixelRect,
    mask: &RegionMask,
) -> Result<SelectionCoverage, String> {
    if let Some(why) = rect.problem(width, height) {
        return Err(why);
    }
    if !mask.feather.is_finite() || !(0.0..=MAX_FEATHER).contains(&mask.feather) {
        return Err(format!(
            "a feather is 0 to {MAX_FEATHER} pixels, got {}",
            mask.feather
        ));
    }
    let mut cov = polygon_shape(width, height, mask)?;
    if let Some(alpha) = &mask.alpha {
        let expected = width as usize * height as usize;
        if alpha.len() != expected {
            return Err(format!(
                "an alpha mask is {width}×{height} = {expected} bytes (one per pixel), got {}",
                alpha.len()
            ));
        }
        let a = SelectionCoverage::from_data(width, height, alpha.clone())
            .ok_or_else(|| "the alpha mask does not fit the image".to_string())?;
        match &mut cov {
            Some(c) => c.combine(&a, CombineMode::Intersect),
            None => cov = Some(a),
        }
    }
    let mut cov = cov.unwrap_or_else(|| SelectionCoverage::full(width, height));
    if mask.feather > 0.0 {
        cov.feather(mask.feather);
    }
    cov.combine(
        &region_coverage(width, height, rect),
        CombineMode::Intersect,
    );
    Ok(cov)
}

/// The f16 store between stages.
fn q(p: Px) -> Px {
    Px(p.0.map(|c| f16::from_f32(c).to_f32()))
}

/// A coverage byte as the GPU reads it: `c / 255` in an r16float texel.
fn mask_weights() -> [f32; 256] {
    std::array::from_fn(|c| f16::from_f32(c as f32 / 255.0).to_f32())
}

/// WGSL `mix(a, r, m)` per channel.
fn mix(a: Px, r: Px, m: f32) -> Px {
    Px(std::array::from_fn(|c| a.0[c] * (1.0 - m) + r.0[c] * m))
}

/// The coverage's non-zero bounding box, as a rectangle.
fn bounds_of(cov: &SelectionCoverage) -> Option<PixelRect> {
    cov.bounds().map(|r| PixelRect {
        x: r.x as u32,
        y: r.y as u32,
        w: r.w,
        h: r.h,
    })
}

/// The working window: the mask's bounds grown by the widest stage
/// window, clamped to the image. Pixels outside the mask stay unfiltered
/// at every stage, so a window centred in it never needs more.
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

    fn index(&self, x: u32, y: u32) -> usize {
        ((y - self.y0) * self.w + (x - self.x0)) as usize
    }
}

/// Where a stage writes: the mask's bounds, its coverage and the f16
/// weight of each coverage byte.
struct Mask<'a> {
    bounds: PixelRect,
    cov: &'a SelectionCoverage,
    weight: [f32; 256],
}

impl Mask<'_> {
    /// Every masked pixel `(x, y, m)` with `m > 0`.
    fn each(&self, mut f: impl FnMut(u32, u32, f32)) {
        let b = self.bounds;
        for y in b.y..b.y + b.h {
            for x in b.x..b.x + b.w {
                let c = self.cov.coverage_at(x, y);
                if c != 0 {
                    f(x, y, self.weight[c as usize]);
                }
            }
        }
    }
}

/// One masked Gaussian pass over `src`: under the mask the convolution
/// mixed by coverage, elsewhere the input as is.
fn gaussian_pass(src: &Work, mask: &Mask, p: &ConvGaussianParams, horizontal: bool) -> Work {
    let weights = cpu::gaussian_weights(p);
    let mut px = src.px.clone();
    mask.each(|x, y, m| {
        let (xi, yi) = (x as i32, y as i32);
        let v = if horizontal {
            cpu::gaussian_axis(|i| src.at(xi + i, yi), &weights)
        } else {
            cpu::gaussian_axis(|i| src.at(xi, yi + i), &weights)
        };
        let i = src.index(x, y);
        px[i] = q(mix(src.px[i], v, m));
    });
    Work { px, ..*src }
}

fn blur(src: &Work, mask: &Mask, p: &ConvGaussianParams) -> Work {
    let h = gaussian_pass(src, mask, p, true);
    gaussian_pass(&h, mask, p, false)
}

fn check_size(width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(format!(
            "expected {}×{} RGBA8 ({} bytes), got {}",
            width,
            height,
            width as usize * height as usize * 4,
            rgba.len()
        ));
    }
    Ok(())
}

fn check_coverage(width: u32, height: u32, cov: &SelectionCoverage) -> Result<PixelRect, String> {
    if cov.width() != width || cov.height() != height {
        return Err(format!(
            "the mask is {}×{}, the image {width}×{height}",
            cov.width(),
            cov.height()
        ));
    }
    bounds_of(cov).ok_or_else(|| "the mask covers no pixel".to_string())
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
    filter_masked_cpu(
        width,
        height,
        rgba,
        params,
        &region_coverage(width, height, rect),
    )
}

/// The chain on the CPU under `cov` (a coverage at image resolution), in
/// place: each stage's result mixed with its input by the coverage.
/// Pixels with coverage 0 are untouched.
pub fn filter_masked_cpu(
    width: u32,
    height: u32,
    rgba: &mut [u8],
    params: &AdjustParams,
    cov: &SelectionCoverage,
) -> Result<(), String> {
    check_size(width, height, rgba)?;
    let bounds = check_coverage(width, height, cov)?;
    let mask = Mask {
        bounds,
        cov,
        weight: mask_weights(),
    };
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
        let x0 = bounds.x.saturating_sub(margin);
        let y0 = bounds.y.saturating_sub(margin);
        let x1 = (bounds.x + bounds.w + margin).min(width);
        let y1 = (bounds.y + bounds.h + margin).min(height);
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
            work = run_stage(work, &mask, stage);
        }
        let out = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        mask.each(|x, y, _| {
            let p = work.px[work.index(x, y)];
            let o = (y as usize * width as usize + x as usize) * 4;
            for c in 0..4 {
                rgba[o + c] = out(p.0[c]);
            }
        });
    }
    if let Some(luts) = params.effective_curves() {
        apply_curve_luts_masked(rgba, &luts, cov);
    }
    Ok(())
}

/// The adjustment chain on the CPU over a straight rgba16float window,
/// as [`crate::ingest::adjust_f16`] runs it on the device: every stage
/// mixed with its input by `selection` (full coverage when `None`), the
/// f16 store between stages, the curves last. The layer fold's CPU path
/// (image ADR 480) folds an adjustment layer through it.
pub(crate) fn adjust_f16_cpu(
    width: u32,
    height: u32,
    straight_f16: &[u8],
    params: &AdjustParams,
    selection: Option<&SelectionCoverage>,
) -> Vec<u8> {
    if params.is_identity() {
        return straight_f16.to_vec();
    }
    let full;
    let cov = match selection {
        Some(c) => c,
        None => {
            full = SelectionCoverage::full(width, height);
            &full
        }
    };
    let mut work = Work {
        x0: 0,
        y0: 0,
        w: width,
        h: height,
        px: straight_f16
            .as_chunks::<8>()
            .0
            .iter()
            .map(|t| {
                Px(std::array::from_fn(|c| {
                    f16::from_le_bytes([t[c * 2], t[c * 2 + 1]]).to_f32()
                }))
            })
            .collect(),
    };
    if let Some(bounds) = bounds_of(cov) {
        let mask = Mask {
            bounds,
            cov,
            weight: mask_weights(),
        };
        for stage in &adjust_stages(params) {
            work = run_stage(work, &mask, stage);
        }
    }
    let mut out = Vec::with_capacity(straight_f16.len());
    for p in &work.px {
        for c in 0..4 {
            out.extend_from_slice(&f16::from_f32(p.0[c]).to_le_bytes());
        }
    }
    if let Some(luts) = params.effective_curves() {
        crate::ingest::apply_curve_lut_f16(&mut out, &luts, selection, width, height);
    }
    out
}

/// Apply one stage under the mask.
fn run_stage(mut work: Work, mask: &Mask, stage: &AdjustStage) -> Work {
    use AdjustStage as S;
    let point = |work: &mut Work, f: &dyn Fn(Px) -> Px| {
        mask.each(|x, y, m| {
            let i = work.index(x, y);
            let a = work.px[i];
            work.px[i] = q(mix(a, f(a), m));
        });
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
        S::Blur(p) => work = blur(&work, mask, p),
        S::Sharpen(g, u) => {
            // The GPU masks the blur's two passes too, then the unsharp.
            let blurred = blur(&work, mask, g);
            mask.each(|x, y, m| {
                let i = work.index(x, y);
                let a = work.px[i];
                work.px[i] = q(mix(a, cpu::unsharp(a, blurred.px[i], u), m));
            });
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
    filter_masked_gpu(
        ctx,
        width,
        height,
        rgba,
        params,
        region_coverage(width, height, rect),
    )
    .await
}

/// The chain on the GPU pipeline under `cov` — "Apply" within a
/// selection. Pixels with coverage 0 are left as they were.
pub async fn filter_masked_gpu(
    ctx: &GpuContext,
    width: u32,
    height: u32,
    rgba: &mut [u8],
    params: &AdjustParams,
    cov: SelectionCoverage,
) -> Result<(), String> {
    check_size(width, height, rgba)?;
    let bounds = check_coverage(width, height, &cov)?;
    if params.is_identity() {
        return Ok(());
    }
    let img = DecodedImage::from_rgba8(width, height, rgba.to_vec()).map_err(|e| e.to_string())?;
    let cov = Arc::new(cov);
    let out = adjust_rgba8_uncached(ctx, &img, params, Some(Arc::clone(&cov)))
        .await
        .map_err(|e| e.to_string())?;
    for y in bounds.y..bounds.y + bounds.h {
        for x in bounds.x..bounds.x + bounds.w {
            if cov.coverage_at(x, y) != 0 {
                let o = (y as usize * width as usize + x as usize) * 4;
                rgba[o..o + 4].copy_from_slice(&out[o..o + 4]);
            }
        }
    }
    Ok(())
}
