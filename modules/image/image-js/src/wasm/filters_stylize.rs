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

//! WP5.2 filter doors (`filters_stylize`): each runs its kernel through the parent's
//! `apply_point_kernel` (selection mask, active layer, one journal step).

use super::*;

use image_kernels::families::pixelate::{
    PixelateColorHalftoneParams, PixelateCrystallizeParams, PixelateMezzotintParams,
    PixelatePointillizeParams, CELL_MAX, CELL_MIN, PIXELATE_COLOR_HALFTONE, PIXELATE_CRYSTALLIZE,
    PIXELATE_MEZZOTINT, PIXELATE_POINTILLIZE,
};
use image_kernels::families::stylize::{
    StylizeExtrudeParams, StylizeSolarizeParams, StylizeTilesParams, StylizeTraceContourParams,
    StylizeWindParams, STYLIZE_EXTRUDE, STYLIZE_SOLARIZE, STYLIZE_TILES, STYLIZE_TRACE_CONTOUR,
    STYLIZE_WIND,
};

fn refuse(what: &str) -> JsValue {
    JsValue::from_str(what)
}

fn rgb3(name: &str, c: &[f32]) -> Result<[f32; 3], JsValue> {
    match c {
        [r, g, b] if c.iter().all(|v| v.is_finite()) => Ok([*r, *g, *b]),
        _ => Err(refuse(&format!(
            "{name} must be 3 finite floats (straight rgb in 0..1)"
        ))),
    }
}

fn in_range(name: &str, v: f32, lo: f32, hi: f32) -> Result<f32, JsValue> {
    if v.is_finite() && (lo..=hi).contains(&v) {
        Ok(v)
    } else {
        Err(refuse(&format!("{name} {v} is outside {lo}..{hi}")))
    }
}

/// STYLIZE — Wind (`stylize.wind`): `method` 0 wind, 1 blast, 2 stagger;
/// `from_left` false = the wind blows from the right.
#[wasm_bindgen]
pub async fn apply_wind(
    handle: u32,
    method: u32,
    from_left: bool,
    seed: u32,
) -> Result<DecodedHandle, JsValue> {
    if method > 2 {
        return Err(refuse(&format!(
            "unknown wind method {method} (0 wind | 1 blast | 2 stagger)"
        )));
    }
    let p = StylizeWindParams::new(0, 0, seed, method, from_left, 1.0);
    apply_point_kernel(handle, &STYLIZE_WIND, p.as_bytes()).await
}

/// STYLIZE — Extrude (`stylize.extrude`): blocks or pyramids of
/// `size_px` (2..255), `depth` 1..255, random or level-based.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn apply_extrude(
    handle: u32,
    pyramids: bool,
    size_px: f32,
    depth: f32,
    level_based: bool,
    solid_front: bool,
    mask_incomplete: bool,
    seed: u32,
) -> Result<DecodedHandle, JsValue> {
    let size_px = in_range("extrude size", size_px, 2.0, 255.0)?;
    let depth = in_range("extrude depth", depth, 1.0, 255.0)?;
    let p = StylizeExtrudeParams::new(
        0,
        0,
        seed,
        pyramids,
        size_px,
        depth,
        level_based,
        solid_front,
        mask_incomplete,
        1.0,
    );
    apply_point_kernel(handle, &STYLIZE_EXTRUDE, p.as_bytes()).await
}

/// STYLIZE — Tiles (`stylize.tiles`): `tiles` 1..99 across the shorter
/// side, `max_offset` 0..1 of a tile, `fill` 0 background, 1 foreground,
/// 2 inverse image, 3 unaltered image.
#[wasm_bindgen]
pub async fn apply_tiles(
    handle: u32,
    tiles: u32,
    max_offset: f32,
    fill: u32,
    fg: &[f32],
    bg: &[f32],
    seed: u32,
) -> Result<DecodedHandle, JsValue> {
    if !(1..=99).contains(&tiles) {
        return Err(refuse(&format!("tiles {tiles} is outside 1..99")));
    }
    if fill > 3 {
        return Err(refuse(&format!(
            "unknown tiles fill {fill} (0 background | 1 foreground | 2 inverse | 3 unaltered)"
        )));
    }
    let max_offset = in_range("tiles offset", max_offset, 0.0, 1.0)?;
    let p = StylizeTilesParams::new(
        0,
        0,
        seed,
        tiles,
        max_offset,
        fill,
        rgb3("foreground", fg)?,
        rgb3("background", bg)?,
        1.0,
    );
    apply_point_kernel(handle, &STYLIZE_TILES, p.as_bytes()).await
}

/// STYLIZE — Solarize (`stylize.solarize`).
#[wasm_bindgen]
pub async fn apply_solarize(handle: u32) -> Result<DecodedHandle, JsValue> {
    let p = StylizeSolarizeParams::new(1.0);
    apply_point_kernel(handle, &STYLIZE_SOLARIZE, p.as_bytes()).await
}

/// STYLIZE — Trace Contour (`stylize.trace_contour`): `level` 0..1,
/// `upper` outlines the side at or above it.
#[wasm_bindgen]
pub async fn apply_trace_contour(
    handle: u32,
    level: f32,
    upper: bool,
) -> Result<DecodedHandle, JsValue> {
    let level = in_range("contour level", level, 0.0, 1.0)?;
    let p = StylizeTraceContourParams::new(level, upper, 1.0);
    apply_point_kernel(handle, &STYLIZE_TRACE_CONTOUR, p.as_bytes()).await
}

/// PIXELATE — Crystallize (`pixelate.crystallize`), cell 3..300 px.
#[wasm_bindgen]
pub async fn apply_crystallize(
    handle: u32,
    cell_px: f32,
    seed: u32,
) -> Result<DecodedHandle, JsValue> {
    let cell_px = in_range("crystallize cell", cell_px, CELL_MIN, CELL_MAX)?;
    let p = PixelateCrystallizeParams::new(0, 0, seed, cell_px, 1.0);
    apply_point_kernel(handle, &PIXELATE_CRYSTALLIZE, p.as_bytes()).await
}

/// PIXELATE — Pointillize (`pixelate.pointillize`), cell 3..300 px, dots
/// on `bg`.
#[wasm_bindgen]
pub async fn apply_pointillize(
    handle: u32,
    cell_px: f32,
    bg: &[f32],
    seed: u32,
) -> Result<DecodedHandle, JsValue> {
    let cell_px = in_range("pointillize cell", cell_px, CELL_MIN, CELL_MAX)?;
    let p = PixelatePointillizeParams::new(0, 0, seed, cell_px, rgb3("background", bg)?, 1.0);
    apply_point_kernel(handle, &PIXELATE_POINTILLIZE, p.as_bytes()).await
}

/// PIXELATE — Mezzotint (`pixelate.mezzotint`): `kind` 0..9 (fine,
/// medium, grainy, coarse dots; short, medium, long lines; short,
/// medium, long strokes).
#[wasm_bindgen]
pub async fn apply_mezzotint(handle: u32, kind: u32, seed: u32) -> Result<DecodedHandle, JsValue> {
    if kind > 9 {
        return Err(refuse(&format!("unknown mezzotint type {kind} (0..9)")));
    }
    let p = PixelateMezzotintParams::new(0, 0, seed, kind, 1.0);
    apply_point_kernel(handle, &PIXELATE_MEZZOTINT, p.as_bytes()).await
}

/// PIXELATE — Color Halftone (`pixelate.color_halftone`): `max_radius_px`
/// 4..127 and the four screen angles in degrees (RGB uses the first three).
#[wasm_bindgen]
pub async fn apply_color_halftone(
    handle: u32,
    max_radius_px: f32,
    angles: &[f32],
) -> Result<DecodedHandle, JsValue> {
    let r = in_range("halftone radius", max_radius_px, 4.0, 127.0)?;
    let a: [f32; 4] = match angles {
        [a, b, c, d] if angles.iter().all(|v| v.is_finite()) => [*a, *b, *c, *d],
        _ => return Err(refuse("halftone angles must be 4 finite degrees")),
    };
    let p = PixelateColorHalftoneParams::new(0, 0, r, a, 1.0);
    apply_point_kernel(handle, &PIXELATE_COLOR_HALFTONE, p.as_bytes()).await
}
