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

// The GENERATED-PIXELS doors (image ADR 485, WP8.2): where the image
// module's ML features land what the host's ML service answered. The
// models run in the host (its ML worker or the local generative host,
// extensions ADR 1100); none of them is in this wasm. These doors only
// take canvas-extent buffers and record them as ONE undo step:
//
//   · `ml_layer_add`   — a new pixel layer with an optional layer mask
//                        (Generative Fill, Generate Image, the neural
//                        filters' output);
//   · `ml_land_hole`   — pixels landed in the active layer inside a hole
//                        (Remove over a selection);
//   · `ml_layer_mask`  — a layer's mask from coverage (Remove Background);
//   · `ml_expand`      — the canvas grown and a masked border layer
//                        added (Generative Expand).
//
// A child of `mod wasm`, like `retouch_doors`, so it shares the realm's
// images, stack and selection without widening any of them.

use std::sync::Arc;

use image_core::Region;
use wasm_bindgen::prelude::*;

use super::{
    ingest_err, read_depth_reduced, read_display, set_image_extent, set_image_pixels,
    with_stack_async, DecodedHandle, GPU, LAYERS, SELECTION,
};

fn bound(handle: u32) -> Result<(), JsValue> {
    let ok = LAYERS.with(|l| l.borrow().as_ref().map(|d| d.handle)) == Some(handle);
    if ok {
        Ok(())
    } else {
        Err(JsValue::from_str(
            "a generated layer needs the image's layer stack (layers_open first)",
        ))
    }
}

fn answer(handle: u32, w: u32, h: u32) -> DecodedHandle {
    DecodedHandle {
        handle,
        width: w,
        height: h,
        display: read_display(handle),
        depth_reduced: read_depth_reduced(handle),
    }
}

fn no_gpu_refusal(stack: &crate::layers::LayerStack, has_gpu: bool) -> Result<(), JsValue> {
    if !has_gpu && !stack.composite_runs_without_gpu() {
        return Err(JsValue::from_str(
            "this layered image composites only on the GPU (a layer style or a direct \
             adjustment) — open it where WebGPU runs",
        ));
    }
    Ok(())
}

/// A NEW PIXEL LAYER above the active one: `rgba` is canvas-extent
/// straight RGBA8, `mask` canvas-extent coverage (empty = no mask). One
/// undo step labelled `label`; the layer is named `name` and made active.
#[wasm_bindgen]
pub async fn ml_layer_add(
    handle: u32,
    label: String,
    name: String,
    rgba: Vec<u8>,
    mask: Vec<u8>,
) -> Result<DecodedHandle, JsValue> {
    bound(handle)?;
    let ctx = GPU.with(|g| g.borrow().clone());
    let px: Arc<[u8]> = Arc::from(rgba.into_boxed_slice());
    with_stack_async(|mut doc| async move {
        let result = async {
            no_gpu_refusal(&doc.stack, ctx.is_some())?;
            let mask = (!mask.is_empty()).then_some(mask);
            doc.stack
                .add_generated(&label, &name, px, mask)
                .map_err(ingest_err)?;
            let (w, h) = (doc.stack.width(), doc.stack.height());
            let out = doc
                .stack
                .composite_px(ctx.as_deref(), None)
                .await
                .map_err(ingest_err)?;
            set_image_pixels(doc.handle, out)?;
            Ok(answer(doc.handle, w, h))
        }
        .await;
        (doc, result)
    })
    .await
}

/// Land `filled` (canvas-extent RGBA8) in the ACTIVE layer where `hole`
/// (one byte per pixel) is set — Remove over a selection with a model's
/// answer. One undo step labelled `label`.
#[wasm_bindgen]
pub async fn ml_land_hole(
    handle: u32,
    label: String,
    filled: Vec<u8>,
    hole: Vec<u8>,
) -> Result<DecodedHandle, JsValue> {
    bound(handle)?;
    let ctx = GPU.with(|g| g.borrow().clone());
    with_stack_async(|mut doc| async move {
        let result = async {
            let (w, h) = (doc.stack.width(), doc.stack.height());
            let n = w as usize * h as usize;
            if filled.len() != n * 4 || hole.len() != n {
                return Err(JsValue::from_str(
                    "the model's pixels or the hole do not match the image",
                ));
            }
            doc.stack.active_is_editable().map_err(ingest_err)?;
            let mut on_layer = doc.stack.active().rgba.to_rgba8().into_owned();
            let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
            for (i, &m) in hole.iter().enumerate() {
                if m >= 128 {
                    on_layer[i * 4..i * 4 + 4].copy_from_slice(&filled[i * 4..i * 4 + 4]);
                    let (x, y) = ((i % w as usize) as u32, (i / w as usize) as u32);
                    x0 = x0.min(x);
                    y0 = y0.min(y);
                    x1 = x1.max(x);
                    y1 = y1.max(y);
                }
            }
            if x1 < x0 {
                return Err(JsValue::from_str("the hole covers nothing on the image"));
            }
            let damage = Region::new(x0 as i32, y0 as i32, x1 - x0 + 1, y1 - y0 + 1);
            let px: Arc<[u8]> = Arc::from(on_layer.into_boxed_slice());
            doc.stack
                .edit_active(&label, damage, px.into())
                .map_err(ingest_err)?;
            let out = doc
                .stack
                .composite_px(ctx.as_deref(), None)
                .await
                .map_err(ingest_err)?;
            set_image_pixels(doc.handle, out)?;
            Ok(answer(doc.handle, w, h))
        }
        .await;
        (doc, result)
    })
    .await
}

/// Layer `index`'s MASK from `mask` (canvas-extent coverage), replacing
/// one it had: Remove Background. One undo step labelled `label`.
#[wasm_bindgen]
pub async fn ml_layer_mask(
    handle: u32,
    label: String,
    index: usize,
    mask: Vec<u8>,
) -> Result<DecodedHandle, JsValue> {
    bound(handle)?;
    let ctx = GPU.with(|g| g.borrow().clone());
    with_stack_async(|mut doc| async move {
        let result = async {
            no_gpu_refusal(&doc.stack, ctx.is_some())?;
            doc.stack
                .set_generated_mask(&label, index, mask)
                .map_err(ingest_err)?;
            let (w, h) = (doc.stack.width(), doc.stack.height());
            let out = doc
                .stack
                .composite_px(ctx.as_deref(), None)
                .await
                .map_err(ingest_err)?;
            set_image_pixels(doc.handle, out)?;
            Ok(answer(doc.handle, w, h))
        }
        .await;
        (doc, result)
    })
    .await
}

/// GENERATIVE EXPAND: the canvas grows to `width`×`height` at the anchor
/// (0 left/top, 1 centre, 2 right/bottom) and a layer named `name` holds
/// `rgba` (RGBA8 at the new extent) masked by `mask` (the new border).
/// One undo step labelled `label`. Returns `[width, height]`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn ml_expand(
    handle: u32,
    label: String,
    name: String,
    width: u32,
    height: u32,
    anchor_x: u8,
    anchor_y: u8,
    rgba: Vec<u8>,
    mask: Vec<u8>,
) -> Result<Vec<u32>, JsValue> {
    bound(handle)?;
    let ctx = GPU.with(|g| g.borrow().clone());
    with_stack_async(|mut doc| async move {
        let result = async {
            no_gpu_refusal(&doc.stack, ctx.is_some())?;
            let px: Arc<[u8]> = Arc::from(rgba.into_boxed_slice());
            doc.stack
                .expand_generated(&label, &name, width, height, anchor_x, anchor_y, px, mask)
                .map_err(ingest_err)?;
            doc.stack
                .refresh_fills(ctx.as_deref())
                .await
                .map_err(ingest_err)?;
            let out = doc
                .stack
                .composite_px(ctx.as_deref(), None)
                .await
                .map_err(ingest_err)?;
            let (w, h) = (doc.stack.width(), doc.stack.height());
            set_image_extent(doc.handle, w, h, out)?;
            // The selection was of the old canvas: it goes, as the expand
            // replaced what it described (the step keeps it for undo).
            SELECTION.with(|s| s.borrow_mut().clear());
            doc.stack
                .sync_selection(SELECTION.with(|s| s.borrow().coverage().cloned()));
            Ok(vec![w, h])
        }
        .await;
        (doc, result)
    })
    .await
}
