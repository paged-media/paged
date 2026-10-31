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

//! WP5.6 doors — TRANSFORM AND WARP ON PIXELS (image ADR 483): Warp (the
//! fifteen styles and a custom mesh, `geom.warp_mesh`), Liquify and Puppet
//! Warp (`geom.warp_field` through `paged-warp`'s fields) and Content-Aware
//! Scale (seam carving). The Perspective Crop is a canvas op
//! (`layers_perspective_crop`); Free Transform with Distort and
//! Perspective is `apply_projective`. Each door works on the active layer
//! (the image without a stack) and lands ONE journaled undo step over the
//! whole canvas. The CPU preparation lives in `crate::warps`.

use super::*;

use image_core::Region;
use image_kernels::families::warp::{WarpMeshParams, GEOM_WARP_FIELD, GEOM_WARP_MESH};
use paged_warp::envelope::{self, Warp, WarpStyle};
use paged_warp::field::{self, Field};

use crate::pixels::Pixels;
use crate::warps;

fn err(msg: impl Into<String>) -> JsValue {
    JsValue::from_str(&msg.into())
}

/// The coverage of the selection at `(x, y)`, 0..1 (1 without one).
fn coverage(sel: &Option<Arc<SelectionCoverage>>, x: u32, y: u32) -> f32 {
    sel.as_ref()
        .map_or(1.0, |c| f32::from(c.coverage_at(x, y)) / 255.0)
}

/// Premultiplied rgba16float back to pixels at the layer's depth.
fn readback(out: &[u8], deep: bool) -> Pixels {
    if deep {
        Pixels::from_rgba16(&crate::fill::f16_to_rgba16_unpremul(out))
    } else {
        Pixels::from_rgba8(Arc::from(crate::fill::f16_to_rgba8_unpremul(out)))
    }
}

/// Land a warp's result in the active layer (one undo step labelled
/// `label`, the whole canvas journaled: a warp moves pixels anywhere), or
/// as a new image without a stack.
async fn land_warp(
    label: &'static str,
    width: u32,
    height: u32,
    pixels: Pixels,
    layered: bool,
) -> Result<DecodedHandle, JsValue> {
    if !layered {
        return register_px(width, height, pixels);
    }
    let ctx = GPU.with(|g| g.borrow().clone());
    with_stack_async(|mut doc| async move {
        let result = async {
            doc.stack
                .edit_active(label, Region::new(0, 0, width, height), pixels)
                .map_err(ingest_err)?;
            let rgba = doc
                .stack
                .composite_px(ctx.as_deref(), None)
                .await
                .map_err(ingest_err)?;
            set_image_pixels(doc.handle, rgba)?;
            Ok(DecodedHandle {
                handle: doc.handle,
                width,
                height,
                display: read_display(doc.handle),
                depth_reduced: read_depth_reduced(doc.handle),
            })
        }
        .await;
        (doc, result)
    })
    .await
}

/// The sixteen control points of a Warp style over the rectangle `x, y,
/// w, h` (image px): `style` is a wire name (`arc`, `flag`, … `twist`,
/// `none`), `bend` and the two distortions −1..1, `vertical` Photoshop's
/// vertical orientation. Flat `[x0, y0, … x15, y15]`, row-major. The
/// mesh the Warp dialog draws and `apply_mesh_warp` takes.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn warp_style_mesh(
    style: &str,
    bend: f32,
    horizontal: f32,
    vertical_distortion: f32,
    vertical: bool,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) -> Result<Vec<f32>, JsValue> {
    let style = WarpStyle::from_name(style)
        .ok_or_else(|| err(format!("unknown warp style \"{style}\"")))?;
    for (what, v) in [
        ("bend", bend),
        ("horizontal distortion", horizontal),
        ("vertical distortion", vertical_distortion),
    ] {
        if !v.is_finite() || !(-1.0..=1.0).contains(&v) {
            return Err(err(format!("warp {what} {v} is outside -1..1")));
        }
    }
    let warp = Warp {
        style,
        bend: f64::from(bend),
        horizontal_distortion: f64::from(horizontal),
        vertical_distortion: f64::from(vertical_distortion),
        vertical,
    };
    let rect = envelope::Rect {
        x: f64::from(x),
        y: f64::from(y),
        w: f64::from(w),
        h: f64::from(h),
    };
    Ok(envelope::mesh(&warp, rect)
        .iter()
        .flat_map(|p| [p[0] as f32, p[1] as f32])
        .collect())
}

/// What a Warp, Puppet Warp or Content-Aware Scale of `handle` works on,
/// `[x, y, w, h]` in image px: the selection's bounds, else the active
/// layer's content (what it covers), else the canvas.
#[wasm_bindgen]
pub fn warp_bounds(handle: u32) -> Result<Vec<u32>, JsValue> {
    let (img, _, sel, _) = fill_prelude(handle)?;
    if let Some(r) = sel.as_ref().and_then(|c| c.bounds()) {
        return Ok(vec![r.x.max(0) as u32, r.y.max(0) as u32, r.w, r.h]);
    }
    let (x, y, w, h) = warps::content_bounds(&img.rgba, img.width, img.height)
        .unwrap_or((0, 0, img.width, img.height));
    Ok(vec![x, y, w, h])
}

/// WARP (Edit ▸ Transform ▸ Warp, `geom.warp_mesh`): the rectangle `rect`
/// (`[x, y, w, h]`, image px) of the active layer bent through the
/// sixteen control points `mesh` (`warp_style_mesh`, or a custom mesh).
/// With a selection only its pixels float and bend; the rest stay.
/// Outside the bent patch is transparent. One undo step.
#[wasm_bindgen]
pub async fn apply_mesh_warp(
    handle: u32,
    mesh: Vec<f32>,
    rect: Vec<u32>,
) -> Result<DecodedHandle, JsValue> {
    let (img, ctx, sel, layered) = fill_prelude(handle)?;
    let (w, h) = (img.width, img.height);
    if mesh.len() != 32 || mesh.iter().any(|v| !v.is_finite()) {
        return Err(err(format!(
            "a warp mesh is 16 finite control points (32 numbers), got {}",
            mesh.len()
        )));
    }
    let &[rx, ry, rw, rh] = rect.as_slice() else {
        return Err(err("the warp rectangle is [x, y, w, h]"));
    };
    if rw == 0 || rh == 0 || rx.saturating_add(rw) > w || ry.saturating_add(rh) > h {
        return Err(err(format!(
            "the warp rectangle {rx},{ry} {rw}×{rh} is not inside the {w}×{h} canvas"
        )));
    }
    let inside = |x: u32, y: u32| x >= rx && y >= ry && x < rx + rw && y < ry + rh;
    let float = |x: u32, y: u32| {
        if inside(x, y) {
            coverage(&sel, x, y)
        } else {
            0.0
        }
    };
    let win = warps::premul_window(&img.rgba, w, (rx, ry, rw, rh), float);
    let pts: [[f64; 2]; 16] =
        std::array::from_fn(|i| [f64::from(mesh[2 * i]), f64::from(mesh[2 * i + 1])]);
    let params = WarpMeshParams::new(&pts, rw, rh);
    let mut out = image_gpu::execute_windowed_once_async(
        &ctx,
        &GEOM_WARP_MESH,
        &win,
        rw,
        rh,
        params.as_bytes(),
        None,
        w,
        h,
    )
    .await
    .map_err(|e| err(e.to_string()))?;
    warps::float_over(&mut out, &img.rgba, w, h, float);
    land_warp("Warp", w, h, readback(&out, img.rgba.is_16bit()), layered).await
}

/// One `geom.warp_field` pass over the active layer: the field and the
/// layer in one window; with a selection the result lands through it.
async fn field_pass(
    handle: u32,
    field: &Field,
    label: &'static str,
) -> Result<DecodedHandle, JsValue> {
    let (img, ctx, sel, layered) = fill_prelude(handle)?;
    let (w, h) = (img.width, img.height);
    if (field.width, field.height) != (w, h) {
        return Err(err(format!(
            "the field covers {}×{}, the canvas is {w}×{h}",
            field.width, field.height
        )));
    }
    let max = ctx.device.limits().max_texture_dimension_2d;
    let (win, mut params, ww, wh) =
        warps::field_window(&img.rgba, w, h, field, max).ok_or_else(|| {
            err(format!(
                "a {w}×{h} warp does not fit the GPU's {max} px textures"
            ))
        })?;
    params.masked = u32::from(sel.is_some());
    let mask = sel.as_ref().map(|cov| {
        image_gpu::selection::SelectionMask::from_fn(w, h, |x, y| {
            f32::from(cov.coverage_at(x, y)) / 255.0
        })
        .bytes()
        .to_vec()
    });
    let out = image_gpu::execute_windowed_once_async(
        &ctx,
        &GEOM_WARP_FIELD,
        &win,
        ww,
        wh,
        params.as_bytes(),
        mask.as_deref(),
        w,
        h,
    )
    .await
    .map_err(|e| err(e.to_string()))?;
    land_warp(label, w, h, readback(&out, img.rgba.is_16bit()), layered).await
}

/// LIQUIFY (Filter ▸ Liquify, `geom.warp_field`): the strokes, replayed
/// on a fresh mesh (`paged_warp::field`), warp the active layer. `strokes`
/// is the flat wire form — per stroke `[tool, size, pressure, density,
/// rate, n, x0, y0, …]`, positions and size in image px, tool 0 forward
/// warp · 1 reconstruct · 2 smooth · 3 twirl clockwise · 4 twirl
/// counter-clockwise · 5 pucker · 6 bloat · 7 push left · 8 freeze ·
/// 9 thaw. With a selection, what lies outside it is frozen. One undo
/// step.
#[wasm_bindgen]
pub async fn apply_liquify(handle: u32, strokes: Vec<f32>) -> Result<DecodedHandle, JsValue> {
    let (w, h) = {
        let (img, _, _, _) = fill_prelude(handle)?;
        (img.width, img.height)
    };
    let strokes = field::parse_strokes(&strokes)
        .ok_or_else(|| err("malformed Liquify strokes (see apply_liquify)"))?;
    let liquify = field::replay(w, h, warps::LIQUIFY_NODES, &strokes);
    field_pass(handle, &liquify.field, "Liquify").await
}

/// PUPPET WARP (Edit ▸ Puppet Warp, `geom.warp_field`): a mesh over what
/// the active layer covers (`expansion` px out; `density` 0 fewer / 1
/// normal / 2 more points), bent as rigidly as `mode` allows (0 rigid,
/// 1 normal, 2 distort) so each pin `[at_x, at_y, to_x, to_y]` lands
/// where it is dragged. One undo step.
#[wasm_bindgen]
pub async fn apply_puppet_warp(
    handle: u32,
    pins: Vec<f32>,
    mode: u32,
    density: u32,
    expansion: f32,
) -> Result<DecodedHandle, JsValue> {
    let field = {
        let (img, _, _, _) = fill_prelude(handle)?;
        let pins = warps::parse_pins(&pins).map_err(err)?;
        warps::puppet_field(
            &img.rgba, img.width, img.height, &pins, mode, density, expansion,
        )
        .map_err(err)?
        .2
    };
    field_pass(handle, &field, "Puppet warp").await
}

/// The bent Puppet Warp mesh's edges for the overlay, flat `[x0, y0, x1,
/// y1, …]` in image px (empty when the layer covers nothing).
#[wasm_bindgen]
pub fn puppet_mesh_edges(
    handle: u32,
    pins: Vec<f32>,
    mode: u32,
    density: u32,
    expansion: f32,
) -> Result<Vec<f32>, JsValue> {
    let (img, _, _, _) = fill_prelude(handle)?;
    let pins = warps::parse_pins(&pins).map_err(err)?;
    match warps::puppet_field(
        &img.rgba, img.width, img.height, &pins, mode, density, expansion,
    ) {
        Ok((mesh, bent, _)) => Ok(warps::mesh_edges(&mesh, &bent)),
        Err(_) => Ok(Vec::new()),
    }
}

/// Where the point `(x, y)` of the bent layer rests in the unbent one
/// (the backward field of the current pins), so a pin added on bent
/// content holds what is under the pointer. `[x, y]`; the point itself
/// where the mesh does not reach.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn puppet_rest_point(
    handle: u32,
    pins: Vec<f32>,
    mode: u32,
    density: u32,
    expansion: f32,
    x: f32,
    y: f32,
) -> Result<Vec<f32>, JsValue> {
    let (img, _, _, _) = fill_prelude(handle)?;
    let pins = warps::parse_pins(&pins).map_err(err)?;
    if pins.is_empty() {
        return Ok(vec![x, y]);
    }
    let rest = warps::puppet_field(
        &img.rgba, img.width, img.height, &pins, mode, density, expansion,
    )
    .ok()
    .and_then(|(_, _, f)| f.source(f64::from(x) - 0.5, f64::from(y) - 0.5))
    .map_or([x, y], |(sx, sy)| [(sx + 0.5) as f32, (sy + 0.5) as f32]);
    Ok(rest.to_vec())
}

/// CONTENT-AWARE SCALE (Edit ▸ Content-Aware Scale): what the active
/// layer covers scaled by `sx`×`sy` about its centre, `amount` (0..1) of
/// the change by seam carving and the rest by an ordinary resize; with
/// `protect` the selection keeps seams off what it covers. One undo step.
#[wasm_bindgen]
pub async fn apply_content_aware_scale(
    handle: u32,
    sx: f32,
    sy: f32,
    amount: f32,
    protect: bool,
) -> Result<DecodedHandle, JsValue> {
    let (img, _, sel, layered) = fill_prelude(handle)?;
    let (w, h) = (img.width, img.height);
    let mask = protect
        .then(|| sel.as_ref().map(|c| c.data().to_vec()))
        .flatten();
    let out =
        warps::content_aware_scale(&img.rgba.to_rgba8(), w, h, sx, sy, amount, mask.as_deref())
            .map_err(err)?;
    land_warp(
        "Content-aware scale",
        w,
        h,
        Pixels::from_rgba8(Arc::from(out)),
        layered,
    )
    .await
}
