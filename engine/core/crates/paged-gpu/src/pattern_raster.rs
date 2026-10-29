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

//! Engine ADR 1041 — a pattern's period, rasterised once per display
//! scale and shared by both lanes.
//!
//! [`pattern_raster`] draws the tile's period (every copy that reaches
//! into it, in paint order, clipped by the raster's edge) with
//! `vello_cpu` at the display scale rounded up to a quarter-octave
//! bucket, its pixel grid an exact multiple of the period so a repeat
//! has no seam. Both rasterisers repeat the result as an image brush
//! (`Extend::Repeat`), so they receive the same pixels and GPU/CPU parity
//! (ADR 146) holds as it does for a placed picture. The rasters are
//! cached process-wide by `(tile hash, bucket)`.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use paged_compose::PatternTile;

/// One rasterised period.
#[derive(Debug)]
pub(crate) struct PatternRaster {
    pub width: u32,
    pub height: u32,
    /// `width × height × 4` bytes, sRGB-encoded, PREMULTIPLIED alpha.
    pub rgba: Arc<Vec<u8>>,
    /// Pixel → pattern-space scale per axis (`period / size`).
    pub px_to_pattern: (f64, f64),
    /// `(tile hash, scale bucket)`.
    pub key: (u64, i32),
}

/// The longest side and the most pixels one period gets; a larger
/// period at a deep zoom halves its scale until it fits.
const MAX_SIDE: u32 = 2048;
const MAX_PIXELS: u64 = 4 * 1024 * 1024;
const CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct Cache {
    entries: VecDeque<Arc<PatternRaster>>,
    bytes: usize,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// The period of `tile` rasterised at about `px_per_unit` device pixels
/// per pattern unit (rounded up to a quarter octave).
pub(crate) fn pattern_raster(tile: &PatternTile, px_per_unit: f32) -> Option<Arc<PatternRaster>> {
    if !tile.is_drawable() || !px_per_unit.is_finite() || px_per_unit <= 0.0 {
        return None;
    }
    let (pw, ph) = (tile.period.0 as f64, tile.period.1 as f64);
    let mut bucket = ((px_per_unit as f64).log2() * 4.0).ceil() as i32;
    let size = |bucket: i32| -> (u32, u32) {
        let s = 2f64.powf(bucket as f64 / 4.0);
        (
            (pw * s).ceil().clamp(1.0, 1e9) as u32,
            (ph * s).ceil().clamp(1.0, 1e9) as u32,
        )
    };
    let (mut w, mut h) = size(bucket);
    while (w > MAX_SIDE || h > MAX_SIDE || u64::from(w) * u64::from(h) > MAX_PIXELS) && bucket > -64
    {
        bucket -= 4;
        (w, h) = size(bucket);
    }
    let key = (tile.hash, bucket);
    {
        let mut guard = CACHE.lock().ok()?;
        let cache = guard.get_or_insert_with(Cache::default);
        if let Some(at) = cache.entries.iter().position(|r| r.key == key) {
            let hit = cache.entries.remove(at)?;
            cache.entries.push_back(hit.clone());
            return Some(hit);
        }
    }
    let raster = Arc::new(render(tile, w, h, key)?);
    let mut guard = CACHE.lock().ok()?;
    let cache = guard.get_or_insert_with(Cache::default);
    cache.bytes += raster.rgba.len();
    cache.entries.push_back(raster.clone());
    while cache.bytes > CACHE_BYTES && cache.entries.len() > 1 {
        if let Some(old) = cache.entries.pop_front() {
            cache.bytes -= old.rgba.len();
        }
    }
    Some(raster)
}

#[cfg(any(feature = "cpu", feature = "svg"))]
fn render(tile: &PatternTile, w: u32, h: u32, key: (u64, i32)) -> Option<PatternRaster> {
    use crate::vello_map::{kurbo_stroke, linear_to_peniko, path_to_bez};
    use paged_compose::{FillRule, Paint, Transform};
    use vello_cpu::kurbo::Affine;
    use vello_cpu::peniko::{Fill, ImageAlphaType};
    use vello_cpu::{
        Level, Pixmap, RasterizerSettings, RenderContext, RenderMode, RenderSettings, Resources,
        TargetInit,
    };

    let (w16, h16) = (u16::try_from(w).ok()?, u16::try_from(h).ok()?);
    let (sx, sy) = (
        f64::from(w) / tile.period.0 as f64,
        f64::from(h) / tile.period.1 as f64,
    );
    let mut ctx = RenderContext::new_with(
        w16,
        h16,
        RenderSettings {
            level: Level::try_detect().unwrap_or(Level::baseline()),
            num_threads: 0,
        },
    );
    let color = |p: &Paint| match p {
        Paint::Solid(c) => Some(linear_to_peniko(*c)),
        Paint::Cmyk { rgb, .. } => Some(linear_to_peniko(*rgb)),
        _ => None,
    };
    for &(cx, cy) in &tile.copies {
        ctx.set_transform(
            Affine::scale_non_uniform(sx, sy) * Affine::translate((cx as f64, cy as f64)),
        );
        for item in &tile.items {
            let path = path_to_bez(&item.path, &Transform::IDENTITY);
            if let Some(c) = item.fill.as_ref().and_then(color) {
                ctx.set_paint(c);
                ctx.set_fill_rule(match item.path.fill_rule {
                    FillRule::NonZero => Fill::NonZero,
                    FillRule::EvenOdd => Fill::EvenOdd,
                });
                ctx.fill_path(&path);
            }
            if let Some((p, s)) = &item.stroke {
                if let Some(c) = color(p) {
                    ctx.set_paint(c);
                    ctx.set_stroke(kurbo_stroke(s));
                    ctx.stroke_path(&path);
                }
            }
        }
    }
    ctx.flush();
    let mut pix = Pixmap::new(w16, h16);
    let mut res = Resources::new();
    ctx.render_with(
        pix.as_mut(),
        &mut res,
        RasterizerSettings {
            render_mode: RenderMode::OptimizeSpeed,
            target_init: TargetInit::Clear(vello_cpu::color::AlphaColor::TRANSPARENT),
            ..RasterizerSettings::default()
        },
    );
    Some(PatternRaster {
        width: w,
        height: h,
        rgba: Arc::new(pix.take_rgba8(ImageAlphaType::AlphaPremultiplied)),
        px_to_pattern: (1.0 / sx, 1.0 / sy),
        key,
    })
}

/// Without `vello_cpu` there is no rasteriser for the period; the
/// pattern draws nothing.
#[cfg(not(any(feature = "cpu", feature = "svg")))]
fn render(_tile: &PatternTile, _w: u32, _h: u32, _key: (u64, i32)) -> Option<PatternRaster> {
    None
}

#[cfg(all(test, feature = "cpu"))]
mod tests {
    use super::*;
    use paged_compose::{Color, Paint, PathData, PathSegment, PatternShape};

    fn square_tile(period: (f32, f32), copies: Vec<(f32, f32)>) -> PatternTile {
        let p = PathData::new(vec![
            PathSegment::MoveTo { x: 0.0, y: 0.0 },
            PathSegment::LineTo { x: 5.0, y: 0.0 },
            PathSegment::LineTo { x: 5.0, y: 5.0 },
            PathSegment::LineTo { x: 0.0, y: 5.0 },
            PathSegment::Close,
        ]);
        PatternTile::new(
            period,
            vec![PatternShape {
                path: p,
                fill: Some(Paint::Solid(Color::rgba(1.0, 0.0, 0.0, 1.0))),
                stroke: None,
            }],
            copies,
        )
    }

    #[test]
    fn the_period_is_rasterised_on_an_exact_grid_and_cached() {
        let tile = square_tile((10.0, 10.0), vec![(0.0, 0.0)]);
        let r = pattern_raster(&tile, 4.0).expect("raster");
        assert_eq!((r.width, r.height), (40, 40));
        // Top-left quarter red, bottom-right transparent.
        let at = |x: u32, y: u32| {
            let i = ((y * r.width + x) * 4) as usize;
            [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]]
        };
        assert_eq!(at(5, 5), [255, 0, 0, 255]);
        assert_eq!(at(30, 30)[3], 0);
        let again = pattern_raster(&tile, 3.9).expect("raster");
        assert!(Arc::ptr_eq(&r, &again), "one raster per bucket");
    }

    #[test]
    fn an_oversized_period_is_drawn_softer_not_refused() {
        let tile = square_tile((1000.0, 1000.0), vec![(0.0, 0.0)]);
        let r = pattern_raster(&tile, 50.0).expect("raster");
        assert!(r.width <= MAX_SIDE && r.height <= MAX_SIDE);
    }
}
