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

//! WP5.2 filter doors — DISTORT (Displace, Polar Coordinates, Ripple,
//! Shear, ZigZag) and RENDER (Clouds, Difference Clouds, Fibers, Lens
//! Flare, Lighting Effects). Each runs its kernel through the parent's
//! `apply_point_kernel` / `apply_binary_kernel` (selection mask, active
//! layer, one journal step). Out-of-range input is REFUSED with a reason,
//! never clamped silently.

use super::*;

use image_kernels::families::distort::{
    DistortDisplaceParams, DistortPolarParams, DistortRippleParams, DistortShearParams,
    DistortZigzagParams, DISTORT_DISPLACE, DISTORT_POLAR, DISTORT_RIPPLE, DISTORT_SHEAR,
    DISTORT_ZIGZAG, EDGE_REPEAT, EDGE_WRAP, SHEAR_POINTS,
};
use image_kernels::families::render::{
    RenderCloudsParams, RenderFibersParams, RenderLensFlareParams, RenderLightingParams,
    LIGHTING_SETTINGS, RENDER_CLOUDS, RENDER_FIBERS, RENDER_LENS_FLARE, RENDER_LIGHTING,
};

fn err(msg: String) -> JsValue {
    JsValue::from_str(&msg)
}

fn rgb3(what: &str, v: &[f32]) -> Result<[f32; 3], JsValue> {
    match v {
        [r, g, b] => Ok([*r, *g, *b]),
        _ => Err(err(format!(
            "{what} must be 3 floats (rgb in 0..1), got {}",
            v.len()
        ))),
    }
}

fn in_range(what: &str, v: f32, lo: f32, hi: f32) -> Result<(), JsValue> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(())
    } else {
        Err(err(format!("{what} {v} is outside {lo}..{hi}")))
    }
}

/// The canvas a filter on `handle` runs at (the layer stack's when bound).
fn canvas_size(handle: u32) -> Result<(u32, u32), JsValue> {
    let (img, _, _, _) = fill_prelude(handle)?;
    Ok((img.width, img.height))
}

/// Bilinear (pixel-centre) resample of straight rgba8 to `w`×`h`.
fn resample_rgba8(src: &[u8], sw: u32, sh: u32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    let at = |x: i64, y: i64, c: usize| -> f32 {
        let x = x.clamp(0, sw as i64 - 1) as usize;
        let y = y.clamp(0, sh as i64 - 1) as usize;
        f32::from(src[(y * sw as usize + x) * 4 + c])
    };
    for y in 0..h {
        let sy = (y as f32 + 0.5) * sh as f32 / h as f32 - 0.5;
        let y0 = sy.floor();
        let fy = sy - y0;
        for x in 0..w {
            let sx = (x as f32 + 0.5) * sw as f32 / w as f32 - 0.5;
            let x0 = sx.floor();
            let fx = sx - x0;
            let (ix, iy) = (x0 as i64, y0 as i64);
            for c in 0..4 {
                let top = at(ix, iy, c) * (1.0 - fx) + at(ix + 1, iy, c) * fx;
                let bot = at(ix, iy + 1, c) * (1.0 - fx) + at(ix + 1, iy + 1, c) * fx;
                out.push((top * (1.0 - fy) + bot * fy).round().clamp(0.0, 255.0) as u8);
            }
        }
    }
    out
}

/// DISTORT — Displace: shift each pixel by the displacement map
/// `map_handle` (any engine-held image: another layer's pixels or a
/// file). Red drives x, green y, 50 % grey is no shift; `scale_*_px` is
/// the shift at full deflection (Photoshop's percent × 128 / 100). `fit`
/// 0 STRETCHES the map to the canvas (resampled here, bilinear), 1 TILES
/// it at its own size; `edge` 0 wraps, 1 repeats edge pixels.
#[wasm_bindgen]
pub async fn apply_displace(
    handle: u32,
    map_handle: u32,
    scale_x_px: f32,
    scale_y_px: f32,
    fit: u32,
    edge: u32,
) -> Result<DecodedHandle, JsValue> {
    in_range("horizontal scale", scale_x_px, -4096.0, 4096.0)?;
    in_range("vertical scale", scale_y_px, -4096.0, 4096.0)?;
    let edge = match edge {
        0 => EDGE_WRAP,
        1 => EDGE_REPEAT,
        other => {
            return Err(err(format!(
                "unknown edge policy {other} (0 wrap | 1 repeat)"
            )))
        }
    };
    let (w, h) = canvas_size(handle)?;
    let map = IMAGES
        .with(|m| m.borrow().get(&map_handle).cloned())
        .ok_or_else(|| err(format!("unknown displacement map handle {map_handle}")))?;
    if map.width == 0 || map.height == 0 {
        return Err(err("the displacement map is empty".into()));
    }
    match fit {
        0 => {
            let px = resample_rgba8(&map.rgba.to_rgba8(), map.width, map.height, w, h);
            let tmp = register(w, h, px)?;
            let params = DistortDisplaceParams::new(w, h, scale_x_px, scale_y_px, edge);
            let out =
                apply_binary_kernel(handle, tmp.handle, &DISTORT_DISPLACE, params.as_bytes()).await;
            free_image(tmp.handle);
            out
        }
        1 => {
            // The binary lane crops a larger map to the canvas; the
            // kernel tiles what is left at its real extent.
            let params = DistortDisplaceParams::new(
                map.width.min(w),
                map.height.min(h),
                scale_x_px,
                scale_y_px,
                edge,
            );
            apply_binary_kernel(handle, map_handle, &DISTORT_DISPLACE, params.as_bytes()).await
        }
        other => Err(err(format!("unknown map fit {other} (0 stretch | 1 tile)"))),
    }
}

/// DISTORT — Polar Coordinates, rectangular → polar (`to_polar`) or back.
#[wasm_bindgen]
pub async fn apply_polar(handle: u32, to_polar: bool) -> Result<DecodedHandle, JsValue> {
    let params = DistortPolarParams::new(to_polar);
    apply_point_kernel(handle, &DISTORT_POLAR, params.as_bytes()).await
}

/// DISTORT — Ripple. `amount` −999..999 (0 is the identity), `size` 0
/// small, 1 medium, 2 large.
#[wasm_bindgen]
pub async fn apply_ripple(handle: u32, amount: f32, size: u32) -> Result<DecodedHandle, JsValue> {
    in_range("ripple amount", amount, -999.0, 999.0)?;
    if size > 2 {
        return Err(err(format!(
            "unknown ripple size {size} (0 small | 1 medium | 2 large)"
        )));
    }
    let params = DistortRippleParams::new(amount, size);
    apply_point_kernel(handle, &DISTORT_RIPPLE, params.as_bytes()).await
}

/// DISTORT — Shear: `offsets` are the curve's 16 horizontal offsets in
/// px, top to bottom; `wrap` wraps the edges (else repeats them).
#[wasm_bindgen]
pub async fn apply_shear(
    handle: u32,
    offsets: &[f32],
    wrap: bool,
) -> Result<DecodedHandle, JsValue> {
    let curve: [f32; SHEAR_POINTS] = offsets.try_into().map_err(|_| {
        err(format!(
            "the shear curve takes exactly {SHEAR_POINTS} offsets, got {}",
            offsets.len()
        ))
    })?;
    for v in curve {
        in_range("shear offset", v, -8192.0, 8192.0)?;
    }
    let params = DistortShearParams::new(curve, wrap);
    apply_point_kernel(handle, &DISTORT_SHEAR, params.as_bytes()).await
}

/// DISTORT — ZigZag. `amount` −100..100, `ridges` 0..20, `style` 0
/// around centre, 1 out from centre, 2 pond ripples.
#[wasm_bindgen]
pub async fn apply_zigzag(
    handle: u32,
    amount: f32,
    ridges: f32,
    style: u32,
) -> Result<DecodedHandle, JsValue> {
    in_range("zigzag amount", amount, -100.0, 100.0)?;
    in_range("zigzag ridges", ridges, 0.0, 20.0)?;
    if style > 2 {
        return Err(err(format!(
            "unknown zigzag style {style} (0 around centre | 1 out from centre | 2 pond ripples)"
        )));
    }
    let params = DistortZigzagParams::new(amount, ridges, style);
    apply_point_kernel(handle, &DISTORT_ZIGZAG, params.as_bytes()).await
}

/// RENDER — Clouds (foreground → background), or Difference Clouds
/// (`|image − clouds|`). The same `seed` reproduces the same clouds.
#[wasm_bindgen]
pub async fn apply_clouds(
    handle: u32,
    seed: u32,
    fg: &[f32],
    bg: &[f32],
    difference: bool,
) -> Result<DecodedHandle, JsValue> {
    let (fg, bg) = (rgb3("foreground", fg)?, rgb3("background", bg)?);
    let (w, h) = canvas_size(handle)?;
    let params = RenderCloudsParams::new(
        seed,
        fg,
        bg,
        difference,
        RenderCloudsParams::scale_for(w, h),
    );
    apply_point_kernel(handle, &RENDER_CLOUDS, params.as_bytes()).await
}

/// RENDER — Fibers: `variance` and `strength` 1..64.
#[wasm_bindgen]
pub async fn apply_fibers(
    handle: u32,
    seed: u32,
    variance: f32,
    strength: f32,
    fg: &[f32],
    bg: &[f32],
) -> Result<DecodedHandle, JsValue> {
    in_range("fibers variance", variance, 1.0, 64.0)?;
    in_range("fibers strength", strength, 1.0, 64.0)?;
    let (fg, bg) = (rgb3("foreground", fg)?, rgb3("background", bg)?);
    let params = RenderFibersParams::new(seed, variance, strength, fg, bg);
    apply_point_kernel(handle, &RENDER_FIBERS, params.as_bytes()).await
}

/// RENDER — Lens Flare at a NORMALISED centre (`cx`, `cy` 0..1),
/// `brightness` 10..300 %, `kind` 0 50–300 mm zoom, 1 35 mm prime,
/// 2 105 mm prime, 3 movie prime.
#[wasm_bindgen]
pub async fn apply_lens_flare(
    handle: u32,
    cx: f32,
    cy: f32,
    brightness: f32,
    kind: u32,
) -> Result<DecodedHandle, JsValue> {
    in_range("flare centre x", cx, 0.0, 1.0)?;
    in_range("flare centre y", cy, 0.0, 1.0)?;
    in_range("flare brightness", brightness, 10.0, 300.0)?;
    if kind > 3 {
        return Err(err(format!("unknown lens type {kind} (0..3)")));
    }
    let (w, h) = canvas_size(handle)?;
    let params = RenderLensFlareParams::new(cx * w as f32, cy * h as f32, brightness / 100.0, kind);
    apply_point_kernel(handle, &RENDER_LENS_FLARE, params.as_bytes()).await
}

/// RENDER — Lighting Effects: `s` is the 19 settings of
/// `RenderLightingParams::from_settings` (type, position, height,
/// direction, cone, intensity, colour, gloss, metallic, exposure,
/// ambience, texture channel, bump height, white is high, focus,
/// elevation).
#[wasm_bindgen]
pub async fn apply_lighting(handle: u32, s: &[f32]) -> Result<DecodedHandle, JsValue> {
    let s: [f32; LIGHTING_SETTINGS] = s.try_into().map_err(|_| {
        err(format!(
            "lighting takes exactly {LIGHTING_SETTINGS} settings, got {}",
            s.len()
        ))
    })?;
    if s.iter().any(|v| !v.is_finite()) {
        return Err(err("a lighting setting is not a finite number".into()));
    }
    if s[0] < 0.0 || s[0] > 2.0 || s[0].fract() != 0.0 {
        return Err(err(format!(
            "unknown light type {} (0 spot | 1 point | 2 infinite)",
            s[0]
        )));
    }
    if s[14] < 0.0 || s[14] > 5.0 || s[14].fract() != 0.0 {
        return Err(err(format!("unknown texture channel {} (0..5)", s[14])));
    }
    let (w, h) = canvas_size(handle)?;
    let params = RenderLightingParams::from_settings(&s, w, h);
    apply_point_kernel(handle, &RENDER_LIGHTING, params.as_bytes()).await
}
