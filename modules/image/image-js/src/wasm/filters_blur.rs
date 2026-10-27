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

//! WP5.2 filter doors — BLUR GALLERY (Field, Iris, Tilt-Shift, Path,
//! Spin) and the FILTER GALLERY breadth operations (strokes, chrome,
//! plastic wrap). Each runs its kernel through the parent's
//! `apply_point_kernel` (selection mask, active layer, one journal step).
//! Geometry is in image px. Out-of-range input is REFUSED with a reason,
//! never clamped silently.

use super::*;

use image_kernels::families::blurgal::{
    BlurFieldParams, BlurIrisParams, BlurPathParams, BlurSpinParams, BlurTiltShiftParams,
    BLUR_FIELD, BLUR_IRIS, BLUR_MAX_POINTS, BLUR_MAX_PX, BLUR_PATH, BLUR_SPIN, BLUR_TILT_SHIFT,
};
use image_kernels::families::gallery_ext::{
    GalleryChromeParams, GalleryPlasticWrapParams, GalleryStrokesParams, GALLERY_CHROME,
    GALLERY_PLASTIC_WRAP, GALLERY_STROKES, STROKES_MAX_LENGTH,
};

fn refuse(msg: String) -> JsValue {
    JsValue::from_str(&msg)
}

fn within(what: &str, v: f32, lo: f32, hi: f32) -> Result<(), JsValue> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(())
    } else {
        Err(refuse(format!("{what} {v} is outside {lo}..{hi}")))
    }
}

fn finite(what: &str, vs: &[f32]) -> Result<(), JsValue> {
    match vs.iter().find(|v| !v.is_finite()) {
        None => Ok(()),
        Some(v) => Err(refuse(format!("{what}: {v} is not a finite number"))),
    }
}

fn blur_radius(what: &str, v: f32) -> Result<(), JsValue> {
    within(what, v, 0.0, BLUR_MAX_PX)
}

/// BLUR GALLERY — Field Blur: `pins` are `(x, y, blur_px)` triples,
/// 1..=8 of them; the radius between them is inverse-distance weighted.
#[wasm_bindgen]
pub async fn apply_blur_field(
    handle: u32,
    pins: &[f32],
    light_bokeh: f32,
) -> Result<DecodedHandle, JsValue> {
    if pins.is_empty() || !pins.len().is_multiple_of(3) || pins.len() / 3 > BLUR_MAX_POINTS {
        return Err(refuse(format!(
            "field blur takes 1..={BLUR_MAX_POINTS} pins as (x, y, blur) triples, got {} values",
            pins.len()
        )));
    }
    finite("field blur pins", pins)?;
    let triples: Vec<(f32, f32, f32)> = pins
        .as_chunks::<3>()
        .0
        .iter()
        .map(|c| (c[0], c[1], c[2]))
        .collect();
    for (_, _, b) in &triples {
        blur_radius("field blur pin blur", *b)?;
    }
    within("light bokeh", light_bokeh, 0.0, 1.0)?;
    let p = BlurFieldParams::new(&triples, light_bokeh);
    apply_point_kernel(handle, &BLUR_FIELD, p.as_bytes()).await
}

/// BLUR GALLERY — Iris Blur: sharp inside the ellipse, blurred outside;
/// `feather` is the sharp core as a fraction of the ellipse.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn apply_blur_iris(
    handle: u32,
    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    rotation_deg: f32,
    blur_px: f32,
    feather: f32,
    light_bokeh: f32,
) -> Result<DecodedHandle, JsValue> {
    finite("iris centre and rotation", &[cx, cy, rotation_deg])?;
    within("iris radius x", rx, 1.0, f32::MAX)?;
    within("iris radius y", ry, 1.0, f32::MAX)?;
    blur_radius("iris blur", blur_px)?;
    within("iris feather", feather, 0.0, 1.0)?;
    within("light bokeh", light_bokeh, 0.0, 1.0)?;
    let p = BlurIrisParams::new(cx, cy, rx, ry, rotation_deg, blur_px, feather, light_bokeh);
    apply_point_kernel(handle, &BLUR_IRIS, p.as_bytes()).await
}

/// BLUR GALLERY — Tilt-Shift: a sharp band through `(cx, cy)` at
/// `angle_deg`; `symmetric` false blurs only the side the normal points to.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn apply_blur_tilt_shift(
    handle: u32,
    cx: f32,
    cy: f32,
    angle_deg: f32,
    sharp_px: f32,
    feather_px: f32,
    blur_px: f32,
    symmetric: bool,
    light_bokeh: f32,
) -> Result<DecodedHandle, JsValue> {
    finite("tilt-shift centre and angle", &[cx, cy, angle_deg])?;
    within("tilt-shift sharp band", sharp_px, 0.0, f32::MAX)?;
    within("tilt-shift feather", feather_px, 0.0, f32::MAX)?;
    blur_radius("tilt-shift blur", blur_px)?;
    within("light bokeh", light_bokeh, 0.0, 1.0)?;
    let p = BlurTiltShiftParams::new(
        cx,
        cy,
        angle_deg,
        sharp_px,
        feather_px,
        blur_px,
        symmetric,
        light_bokeh,
    );
    apply_point_kernel(handle, &BLUR_TILT_SHIFT, p.as_bytes()).await
}

/// BLUR GALLERY — Path Blur: `points` are `(x, y)` pairs of one polyline,
/// 2..=8 of them; `speed_px` the blur length.
#[wasm_bindgen]
pub async fn apply_blur_path(
    handle: u32,
    points: &[f32],
    speed_px: f32,
    taper: f32,
    centered: bool,
) -> Result<DecodedHandle, JsValue> {
    if !points.len().is_multiple_of(2) || points.len() / 2 < 2 || points.len() / 2 > BLUR_MAX_POINTS
    {
        return Err(refuse(format!(
            "path blur takes 2..={BLUR_MAX_POINTS} points as (x, y) pairs, got {} values",
            points.len()
        )));
    }
    finite("path blur points", points)?;
    blur_radius("path blur speed", speed_px)?;
    within("path blur taper", taper, 0.0, 1.0)?;
    let pairs: Vec<(f32, f32)> = points
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| (c[0], c[1]))
        .collect();
    let p = BlurPathParams::new(&pairs, speed_px, taper, centered);
    apply_point_kernel(handle, &BLUR_PATH, p.as_bytes()).await
}

/// BLUR GALLERY — Spin Blur: a rotational blur of `angle_deg` inside the
/// ellipse, faded across the rim band `feather`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn apply_blur_spin(
    handle: u32,
    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    rotation_deg: f32,
    angle_deg: f32,
    feather: f32,
) -> Result<DecodedHandle, JsValue> {
    finite("spin centre and rotation", &[cx, cy, rotation_deg])?;
    within("spin radius x", rx, 1.0, f32::MAX)?;
    within("spin radius y", ry, 1.0, f32::MAX)?;
    within("spin angle", angle_deg, 0.0, 360.0)?;
    within("spin feather", feather, 0.0, 1.0)?;
    let p = BlurSpinParams::new(cx, cy, rx, ry, rotation_deg, angle_deg, feather);
    apply_point_kernel(handle, &BLUR_SPIN, p.as_bytes()).await
}

/// FILTER GALLERY — strokes (Angled / Dark / Sprayed Strokes, Sumi-e,
/// Colored Pencil, …): `mode` 0 fixed angle, 1 follow edges, 2 angled.
#[wasm_bindgen]
pub async fn apply_gallery_strokes(
    handle: u32,
    seed: u32,
    angle_deg: f32,
    length_px: f32,
    mode: u32,
    darkness: f32,
    amount: f32,
) -> Result<DecodedHandle, JsValue> {
    finite("stroke angle", &[angle_deg])?;
    within("stroke length", length_px, 0.0, STROKES_MAX_LENGTH)?;
    if mode > 2 {
        return Err(refuse(format!(
            "stroke mode {mode} is unknown (0 fixed angle | 1 follow edges | 2 angled)"
        )));
    }
    within("stroke darkness", darkness, -1.0, 1.0)?;
    within("amount", amount, 0.0, 1.0)?;
    let p = GalleryStrokesParams::new(seed, angle_deg, length_px, mode, darkness, amount);
    apply_point_kernel(handle, &GALLERY_STROKES, p.as_bytes()).await
}

/// FILTER GALLERY — Chrome.
#[wasm_bindgen]
pub async fn apply_gallery_chrome(
    handle: u32,
    detail: f32,
    smoothness: f32,
    amount: f32,
) -> Result<DecodedHandle, JsValue> {
    within("chrome detail", detail, 0.0, 10.0)?;
    within("chrome smoothness", smoothness, 0.0, 10.0)?;
    within("amount", amount, 0.0, 1.0)?;
    let p = GalleryChromeParams::new(detail, smoothness, amount);
    apply_point_kernel(handle, &GALLERY_CHROME, p.as_bytes()).await
}

/// FILTER GALLERY — Plastic Wrap.
#[wasm_bindgen]
pub async fn apply_gallery_plastic_wrap(
    handle: u32,
    strength: f32,
    detail: f32,
    smoothness: f32,
    amount: f32,
) -> Result<DecodedHandle, JsValue> {
    within("plastic wrap strength", strength, 0.0, 20.0)?;
    within("plastic wrap detail", detail, 1.0, 15.0)?;
    within("plastic wrap smoothness", smoothness, 1.0, 15.0)?;
    within("amount", amount, 0.0, 1.0)?;
    let p = GalleryPlasticWrapParams::new(strength, detail, smoothness, amount);
    apply_point_kernel(handle, &GALLERY_PLASTIC_WRAP, p.as_bytes()).await
}
