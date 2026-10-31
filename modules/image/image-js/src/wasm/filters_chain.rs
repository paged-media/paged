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

//! FILTER CHAINS (WP5.2): several kernels, ONE undo step.
//!
//! A filter door lands its result in the active layer as a journal entry
//! of its own, so a Filter Gallery stack of three effects, or a Develop
//! pass of several kernels, would cost three steps if each ran on the
//! layer. Instead the chain runs DETACHED:
//!
//! 1. [`filter_source`] copies the active layer's pixels (the image's,
//!    with no layer stack) into a NEW flat handle. No selection is bound
//!    to it, so the kernels run unmasked there and each door returns a new
//!    flat handle rather than landing.
//! 2. The caller runs the chain's doors on that handle, one after the
//!    other (freeing each intermediate).
//! 3. [`filter_land`] lands the last result in the original handle:
//!    through the selection's coverage (`orig + (out - orig)·cov`, once,
//!    at the end, where each kernel would otherwise have masked on its
//!    own), into the active layer as ONE journal entry, re-composited —
//!    or, without a layer stack, as a new engine-held image, like every
//!    other door.

use super::*;

/// A detached, unmasked copy of what a filter on `handle` would read:
/// the active layer's pixels when a stack is bound, else the image. The
/// caller frees it.
#[wasm_bindgen]
pub fn filter_source(handle: u32) -> Result<DecodedHandle, JsValue> {
    let (img, _ctx, _sel, _layered) = fill_prelude(handle)?;
    register_px(img.width, img.height, img.rgba)
}

/// Land `result` (a handle from a chain that began at [`filter_source`])
/// in `handle`, through the selection, as one step. The result keeps its
/// depth; the caller frees `result`.
#[wasm_bindgen]
pub async fn filter_land(handle: u32, result: u32) -> Result<DecodedHandle, JsValue> {
    let (img, _ctx, sel, layered) = fill_prelude(handle)?;
    let out = IMAGES
        .with(|m| m.borrow().get(&result).cloned())
        .ok_or_else(|| JsValue::from_str(&format!("unknown result handle {result}")))?;
    if (out.width, out.height) != (img.width, img.height) {
        return Err(JsValue::from_str(&format!(
            "the chain's result is {}×{}, the image {}×{} — a filter chain keeps the canvas",
            out.width, out.height, img.width, img.height
        )));
    }
    let pixels = match sel {
        None => out.rgba,
        Some(cov) => through_coverage(&img.rgba, &out.rgba, img.width, &cov),
    };
    if !layered {
        return register_px(img.width, img.height, pixels);
    }
    let (width, height) = (img.width, img.height);
    let damage = SELECTION
        .with(|s| s.borrow().coverage().and_then(|c| c.bounds()))
        .unwrap_or(image_core::Region::new(0, 0, width, height));
    let ctx = GPU.with(|g| g.borrow().clone());
    with_stack_async(|mut doc| async move {
        let result = async {
            doc.stack
                .edit_active("Filter", damage, pixels)
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
                depth_reduced: false,
            })
        }
        .await;
        (doc, result)
    })
    .await
}

/// `orig + (out − orig)·coverage`, per sample, at the deeper of the two
/// depths (an 8-bit result over a 16-bit layer keeps the layer's depth).
fn through_coverage(
    orig: &crate::pixels::Pixels,
    out: &crate::pixels::Pixels,
    width: u32,
    cov: &SelectionCoverage,
) -> crate::pixels::Pixels {
    let n = orig.pixel_count();
    let w = width as usize;
    let cov_at = |i: usize| f32::from(cov.coverage_at((i % w) as u32, (i / w) as u32)) / 255.0;
    if orig.is_float() || out.is_float() {
        // 32-bit float: mix the linear values (unclamped).
        let (a, b) = (orig.to_f32_linear(), out.to_f32_linear());
        let s: Vec<f32> = (0..n * 4)
            .map(|j| {
                let k = cov_at(j / 4);
                a[j] + (b[j] - a[j]) * k
            })
            .collect();
        return crate::pixels::Pixels::from_rgba32f(&s);
    }
    if orig.is_16bit() || out.is_16bit() {
        let mut s = Vec::with_capacity(n * 4);
        for i in 0..n {
            let k = cov_at(i);
            for c in 0..4 {
                let a = f32::from(orig.sample16(i, c));
                let b = f32::from(out.sample16(i, c));
                s.push((a + (b - a) * k).round().clamp(0.0, 65535.0) as u16);
            }
        }
        crate::pixels::Pixels::from_rgba16(&s)
    } else {
        let (a8, b8) = (orig.to_rgba8(), out.to_rgba8());
        let mut s = Vec::with_capacity(n * 4);
        for i in 0..n {
            let k = cov_at(i);
            for c in 0..4 {
                let a = f32::from(a8[i * 4 + c]);
                let b = f32::from(b8[i * 4 + c]);
                s.push((a + (b - a) * k).round().clamp(0.0, 255.0) as u8);
            }
        }
        crate::pixels::Pixels::from_rgba8(std::sync::Arc::from(s.into_boxed_slice()))
    }
}
