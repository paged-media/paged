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

// The RETOUCHING doors (WP5.8): Content-Aware Fill (workspace, preview,
// overlay, outputs), Content-Aware Move, Remove, and the clone source's
// sampling, transform and overlay for the clone / heal / spot heal
// strokes.
//
// A child of `mod wasm`, so it shares the realm's state (images, the
// layer stack, the selection, the stroke) without widening any of it. The
// pixel work lives in the natively tested modules (`patchmatch`,
// `content_aware`, `clone_source`); these doors only fetch the inputs and
// land the result as ONE journaled undo step.
//
// None of them needs a GPU for a one-layer document: the search is CPU,
// the vote dispatches `geom.patch_vote` when a device exists and runs its
// CPU twin when not, and a one-layer composite is the identity fold.

use std::sync::Arc;

use image_core::Region;
use wasm_bindgen::prelude::*;

use super::{
    ingest_err, read_depth_reduced, read_display, register, set_image_pixels, with_stack_async,
    DecodedHandle, GPU, IMAGES, LAYERS, SELECTION, STROKE,
};
use crate::clone_source::{CloneTransform, SampleMode, Sampling as StrokeSampling, SpotType};
use crate::content_aware::{self, MoveMode, MoveOptions, Sampling};
use crate::patchmatch::{self, ColourAdaptation, FillOptions, RotationAdaptation};

/// The active layer's pixels (or the image's, without a stack), its size,
/// and whether a stack is bound.
fn target(handle: u32) -> Result<(Vec<u8>, u32, u32, bool), JsValue> {
    let img = IMAGES
        .with(|m| m.borrow().get(&handle).cloned())
        .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
    LAYERS.with(|l| match l.borrow().as_ref() {
        Some(d) if d.handle == handle => {
            d.stack.active_is_editable().map_err(ingest_err)?;
            Ok((
                d.stack.active().rgba.to_rgba8().into_owned(),
                d.stack.width(),
                d.stack.height(),
                true,
            ))
        }
        _ => Ok((img.rgba.to_rgba8().into_owned(), img.width, img.height, false)),
    })
}

/// The composite the image currently shows (all visible layers).
fn composite(handle: u32) -> Result<Vec<u8>, JsValue> {
    IMAGES.with(|m| {
        m.borrow()
            .get(&handle)
            .map(|i| i.rgba.to_rgba8().into_owned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))
    })
}

/// The selection as a hole (coverage ≥ 50 %), or an honest error.
fn hole(handle: u32, what: &str) -> Result<Vec<u8>, JsValue> {
    let sel = SELECTION.with(|s| s.borrow().mask_for(handle)).ok_or_else(|| {
        JsValue::from_str(&format!(
            "{what} needs a selection — select the area to replace first"
        ))
    })?;
    Ok(content_aware::binarise(sel.data(), 128))
}

/// The pixels a sampling tool reads in `mode` (`None` = the layer itself).
async fn sample_pixels(handle: u32, mode: SampleMode) -> Result<Option<Arc<[u8]>>, JsValue> {
    let bound = LAYERS.with(|l| l.borrow().as_ref().map(|d| d.handle)) == Some(handle);
    match mode {
        SampleMode::Current => Ok(None),
        SampleMode::All => Ok(Some(Arc::from(composite(handle)?.into_boxed_slice()))),
        SampleMode::CurrentAndBelow if bound => {
            let ctx = GPU.with(|g| g.borrow().clone());
            with_stack_async(|doc| async move {
                let out = doc
                    .stack
                    .composite_through_active(ctx.as_deref())
                    .await
                    .map(Some)
                    .map_err(ingest_err);
                (doc, out)
            })
            .await
        }
        SampleMode::CurrentAndBelow => Ok(None),
    }
}

fn fill_options(
    colour: &str,
    rotation: &str,
    scale: bool,
    mirror: bool,
    seed: u32,
) -> Result<FillOptions, JsValue> {
    Ok(FillOptions {
        colour: ColourAdaptation::from_wire(colour).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown colour adaptation \"{colour}\" (none | default | high | very-high)"
            ))
        })?,
        rotation: RotationAdaptation::from_wire(rotation).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown rotation adaptation \"{rotation}\" (none | low | medium | high | full)"
            ))
        })?,
        scale,
        mirror,
        seed: u64::from(seed),
    })
}

/// The sampling area: `custom` when it is non-empty, else automatic.
fn sampling_for(rgba: &[u8], w: u32, h: u32, hole: &[u8], custom: &[u8]) -> Vec<u8> {
    if custom.len() == hole.len() && custom.iter().any(|&b| b != 0) {
        content_aware::sampling_mask(rgba, w, h, hole, &Sampling::Custom(custom))
    } else {
        content_aware::sampling_mask(rgba, w, h, hole, &Sampling::Auto)
    }
}

/// Land `pixels` in the active layer as one step labelled `label`, with
/// `damage` journaled (the stack re-composited into the same handle); a
/// handle without a stack gets a new image.
async fn land(
    label: &'static str,
    w: u32,
    h: u32,
    pixels: Vec<u8>,
    layered: bool,
    damage: Region,
) -> Result<DecodedHandle, JsValue> {
    if !layered {
        return register(w, h, pixels);
    }
    let ctx = GPU.with(|g| g.borrow().clone());
    let pixels: Arc<[u8]> = Arc::from(pixels.into_boxed_slice());
    with_stack_async(|mut doc| async move {
        let result = async {
            doc.stack
                .edit_active(label, damage, pixels.into())
                .map_err(ingest_err)?;
            recomposite(&doc.stack, doc.handle, ctx.as_deref(), w, h).await
        }
        .await;
        (doc, result)
    })
    .await
}

async fn recomposite(
    stack: &crate::layers::LayerStack,
    handle: u32,
    ctx: Option<&image_gpu::GpuContext>,
    w: u32,
    h: u32,
) -> Result<DecodedHandle, JsValue> {
    let rgba = stack.composite_px(ctx, None).await.map_err(ingest_err)?;
    set_image_pixels(handle, rgba)?;
    Ok(DecodedHandle {
        handle,
        width: w,
        height: h,
        display: read_display(handle),
        depth_reduced: read_depth_reduced(handle),
    })
}

/// The bounding box of a mask, as the journal's damage.
fn damage_of(mask: &[u8], w: u32, h: u32) -> Region {
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            if mask[(y * w + x) as usize] != 0 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
        }
    }
    if x1 < x0 {
        return Region::new(0, 0, 0, 0);
    }
    Region::new(x0 as i32, y0 as i32, x1 - x0 + 1, y1 - y0 + 1)
}

/// The changed pixels' box between two canvases.
fn changed_box(a: &[u8], b: &[u8], w: u32, h: u32) -> Region {
    let mask: Vec<u8> = a
        .as_chunks::<4>()
        .0
        .iter()
        .zip(b.as_chunks::<4>().0.iter())
        .map(|(p, q)| u8::from(p != q))
        .collect();
    damage_of(&mask, w, h)
}

// ───────────────────────── content-aware fill ─────────────────────────

/// The automatic sampling area for the current selection: `kind` ∈
/// `auto | rect`. One byte per pixel (255 = sampled).
#[wasm_bindgen]
pub fn caf_sampling_area(handle: u32, kind: &str) -> Result<Vec<u8>, JsValue> {
    let area = patchmatch::SamplingArea::from_wire(kind).ok_or_else(|| {
        JsValue::from_str(&format!("unknown sampling area \"{kind}\" (auto | rect)"))
    })?;
    let hole = hole(handle, "content-aware fill")?;
    let (rgba, w, h, _) = target(handle)?;
    Ok(patchmatch::sampling_area(&rgba, w, h, &hole, area))
}

/// The workspace's on-canvas overlay: the composite with the sampling
/// area tinted green at `opacity`.
#[wasm_bindgen]
pub fn caf_overlay(handle: u32, sample: Vec<u8>, opacity: f32) -> Result<Vec<u8>, JsValue> {
    let rgba = composite(handle)?;
    if sample.len() * 4 != rgba.len() {
        return Err(JsValue::from_str("sampling area does not match the image"));
    }
    Ok(content_aware::sampling_overlay(&rgba, &sample, [40, 200, 60], opacity))
}

/// A CAF preview: the fill of a crop around the selection, computed on a
/// reduced copy when the image's longer side exceeds `max_side`.
#[wasm_bindgen]
pub struct CafPreview {
    x: i32,
    y: i32,
    region_w: u32,
    region_h: u32,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[wasm_bindgen]
impl CafPreview {
    /// The crop's place in IMAGE pixels.
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> i32 {
        self.x
    }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> i32 {
        self.y
    }
    #[wasm_bindgen(getter)]
    pub fn region_w(&self) -> u32 {
        self.region_w
    }
    #[wasm_bindgen(getter)]
    pub fn region_h(&self) -> u32 {
        self.region_h
    }
    /// The preview's own pixel size.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    #[wasm_bindgen(getter)]
    pub fn rgba(&self) -> Vec<u8> {
        self.rgba.clone()
    }
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn caf_preview(
    handle: u32,
    sample: Vec<u8>,
    colour: &str,
    rotation: &str,
    scale: bool,
    mirror: bool,
    seed: u32,
    max_side: u32,
    sample_all: bool,
) -> Result<CafPreview, JsValue> {
    let opts = fill_options(colour, rotation, scale, mirror, seed)?;
    let hole = hole(handle, "content-aware fill")?;
    let (layer, w, h, _) = target(handle)?;
    let rgba = if sample_all { composite(handle)? } else { layer };
    let area = sampling_for(&rgba, w, h, &hole, &sample);
    let p = content_aware::preview(&rgba, w, h, &hole, &area, &opts, max_side).ok_or_else(|| {
        JsValue::from_str(
            "nothing to fill from — the sampling area holds no whole patch; widen it",
        )
    })?;
    Ok(CafPreview {
        x: p.region.x,
        y: p.region.y,
        region_w: p.region.w,
        region_h: p.region.h,
        width: p.width,
        height: p.height,
        rgba: p.rgba,
    })
}

/// CONTENT-AWARE FILL with the workspace's settings. `sample` is the
/// painted sampling area (empty = automatic); `output` ∈ `current |
/// new-layer | duplicate`. One undo step ("Content-Aware Fill").
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn content_aware_fill_ex(
    handle: u32,
    sample: Vec<u8>,
    colour: String,
    rotation: String,
    scale: bool,
    mirror: bool,
    seed: u32,
    output: String,
    sample_all: bool,
) -> Result<DecodedHandle, JsValue> {
    let opts = fill_options(&colour, &rotation, scale, mirror, seed)?;
    let hole = hole(handle, "content-aware fill")?;
    let (layer, w, h, layered) = target(handle)?;
    let source = if sample_all { composite(handle)? } else { layer.clone() };
    let area = sampling_for(&source, w, h, &hole, &sample);
    run_fill(&layer, &source, w, h, layered, &hole, &area, &opts, &output).await
}

#[allow(clippy::too_many_arguments)]
async fn run_fill(
    layer: &[u8],
    source: &[u8],
    w: u32,
    h: u32,
    layered: bool,
    hole: &[u8],
    area: &[u8],
    opts: &FillOptions,
    output: &str,
) -> Result<DecodedHandle, JsValue> {
    let ctx = GPU.with(|g| g.borrow().clone());
    let filled = patchmatch::fill(ctx.as_deref(), source, w, h, hole, area, opts)
        .await
        .ok_or_else(|| {
            JsValue::from_str(
                "nothing to fill, or nothing to fill FROM (an empty selection, or a \
                 sampling area with no room for a single patch)",
            )
        })?;
    // Only the hole changes: the layer keeps every other byte.
    let mut on_layer = layer.to_vec();
    let mut only = vec![0u8; layer.len()];
    for (i, &m) in hole.iter().enumerate() {
        if m != 0 {
            on_layer[i * 4..i * 4 + 4].copy_from_slice(&filled[i * 4..i * 4 + 4]);
            only[i * 4..i * 4 + 4].copy_from_slice(&filled[i * 4..i * 4 + 4]);
        }
    }
    const LABEL: &str = "Content-Aware Fill";
    match output {
        "current" => land(LABEL, w, h, on_layer, layered, damage_of(hole, w, h)).await,
        "new-layer" | "duplicate" if layered => {
            let ctx = GPU.with(|g| g.borrow().clone());
            // A second layer makes the composite a real fold, which is a
            // GPU dispatch: refuse BEFORE the stack changes rather than
            // leave a layer the canvas cannot show.
            if ctx.is_none() {
                return Err(JsValue::from_str(
                    "a new or duplicated layer needs the GPU to composite it — \
                     output to the current layer, or open the image where WebGPU runs",
                ));
            }
            let dup = output == "duplicate";
            let px: Arc<[u8]> = Arc::from(if dup { on_layer } else { only }.into_boxed_slice());
            with_stack_async(|mut doc| async move {
                let result = async {
                    if dup {
                        let at = doc.stack.active_index();
                        doc.stack
                            .duplicate_with_pixels(LABEL, at, px)
                            .map_err(ingest_err)?;
                    } else {
                        doc.stack
                            .add_with_pixels(LABEL, "Content-Aware Fill", px)
                            .map_err(ingest_err)?;
                    }
                    recomposite(&doc.stack, doc.handle, ctx.as_deref(), w, h).await
                }
                .await;
                (doc, result)
            })
            .await
        }
        "new-layer" | "duplicate" => Err(JsValue::from_str(
            "a new or duplicated layer needs a layer stack (layers_open first)",
        )),
        other => Err(JsValue::from_str(&format!(
            "unknown output \"{other}\" (current | new-layer | duplicate)"
        ))),
    }
}

/// Edit ▸ Fill ▸ Content-Aware (the one-click fill): the whole image
/// minus the selection as the sampling area, default settings, into the
/// active layer.
pub(super) async fn fill_whole(handle: u32) -> Result<DecodedHandle, JsValue> {
    let hole = hole(handle, "content-aware fill")?;
    let (layer, w, h, layered) = target(handle)?;
    let area: Vec<u8> = hole
        .iter()
        .enumerate()
        .map(|(i, &m)| if m == 0 && layer[i * 4 + 3] != 0 { 255 } else { 0 })
        .collect();
    run_fill(
        &layer,
        &layer,
        w,
        h,
        layered,
        &hole,
        &area,
        &FillOptions::default(),
        "current",
    )
    .await
}

// ───────────────────────── content-aware move ─────────────────────────

/// CONTENT-AWARE MOVE the selection by `(dx, dy)` with the tool's options
/// (`mode` ∈ `move | extend`, structure 1–7, colour 0–10, the transform on
/// drop). One undo step ("Content-Aware Move").
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn content_aware_move(
    handle: u32,
    dx: f32,
    dy: f32,
    mode: String,
    structure: u8,
    colour: u8,
    scale: f32,
    angle_deg: f32,
    sample_all: bool,
) -> Result<DecodedHandle, JsValue> {
    let mode = MoveMode::from_wire(&mode)
        .ok_or_else(|| JsValue::from_str(&format!("unknown move mode \"{mode}\" (move | extend)")))?;
    let sel = SELECTION
        .with(|s| s.borrow().mask_for(handle))
        .ok_or_else(|| {
            JsValue::from_str(
                "content-aware move needs a selection — select the object to move first",
            )
        })?;
    let (layer, w, h, layered) = target(handle)?;
    let source = if sample_all { composite(handle)? } else { layer.clone() };
    let opts = MoveOptions {
        mode,
        structure: structure.clamp(1, 7),
        colour: colour.min(10),
        scale,
        angle_deg,
        ..MoveOptions::default()
    };
    let out = content_aware::content_aware_move(&source, w, h, sel.data(), dx, dy, &opts)
        .ok_or_else(|| {
            JsValue::from_str(
                "nothing to move — an empty selection, a zero move, or no room to fill \
                 the hole it leaves",
            )
        })?;
    let damage = changed_box(&source, &out, w, h);
    // Onto the layer: every pixel the move changed, from the result.
    let mut on_layer = layer;
    for i in 0..(w as usize * h as usize) {
        if out[i * 4..i * 4 + 4] != source[i * 4..i * 4 + 4] {
            on_layer[i * 4..i * 4 + 4].copy_from_slice(&out[i * 4..i * 4 + 4]);
        }
    }
    land("Content-Aware Move", w, h, on_layer, layered, damage).await
}

// ─────────────────────────────── remove ───────────────────────────────

/// The Remove tool's hole for a stroke (`points` = x, y pairs in image px,
/// `size` = brush diameter) — what an `ml.inpaint` provider is handed.
#[wasm_bindgen]
pub fn remove_hole(handle: u32, points: Vec<f32>, size: f32) -> Result<Vec<u8>, JsValue> {
    let (_, w, h, _) = target(handle)?;
    Ok(content_aware::stroke_hole(w, h, &points, size))
}

/// REMOVE the stroked object: the classical PatchMatch fill of the
/// stroke's hole from its surroundings. One undo step ("Remove").
#[wasm_bindgen]
pub async fn remove_stroke(
    handle: u32,
    points: Vec<f32>,
    size: f32,
    sample_all: bool,
    seed: u32,
) -> Result<DecodedHandle, JsValue> {
    let (layer, w, h, layered) = target(handle)?;
    let hole = content_aware::stroke_hole(w, h, &points, size);
    if !hole.iter().any(|&b| b != 0) {
        return Err(JsValue::from_str("the stroke covers nothing on the image"));
    }
    let source = if sample_all { composite(handle)? } else { layer.clone() };
    let filled = content_aware::remove(&source, w, h, &hole, u64::from(seed)).ok_or_else(|| {
        JsValue::from_str("nothing to fill from around the stroke — it covers too much")
    })?;
    land_hole("Remove", layer, &filled, &hole, w, h, layered).await
}

/// Land pixels an `ml.inpaint` provider returned for the stroke's hole
/// (`filled` is canvas-extent RGBA8; only the hole is taken). One undo step.
#[wasm_bindgen]
pub async fn remove_with_pixels(
    handle: u32,
    filled: Vec<u8>,
    points: Vec<f32>,
    size: f32,
) -> Result<DecodedHandle, JsValue> {
    let (layer, w, h, layered) = target(handle)?;
    if filled.len() != layer.len() {
        return Err(JsValue::from_str("the inpainted pixels do not match the image"));
    }
    let hole = content_aware::stroke_hole(w, h, &points, size);
    land_hole("Remove", layer, &filled, &hole, w, h, layered).await
}

async fn land_hole(
    label: &'static str,
    layer: Vec<u8>,
    filled: &[u8],
    hole: &[u8],
    w: u32,
    h: u32,
    layered: bool,
) -> Result<DecodedHandle, JsValue> {
    let mut on_layer = layer;
    for (i, &m) in hole.iter().enumerate() {
        if m != 0 {
            on_layer[i * 4..i * 4 + 4].copy_from_slice(&filled[i * 4..i * 4 + 4]);
        }
    }
    land(label, w, h, on_layer, layered, damage_of(hole, w, h)).await
}

// ───────────────────────────── clone source ─────────────────────────────

/// Set the IN-FLIGHT clone / heal / spot heal stroke's sampling (WP5.8):
/// `mode` ∈ `current | below | all`; the source transform (a negative
/// scale flips); an explicit `source − destination` offset (`has_offset`);
/// the healing `diffusion` 1–7 (0 = the pure membrane); the spot type
/// `content-aware | create-texture | proximity`. Call between
/// `brush_stroke_begin` and the first extend.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn brush_stroke_set_sampling(
    mode: String,
    scale_x: f32,
    scale_y: f32,
    angle_deg: f32,
    has_offset: bool,
    offset_x: f32,
    offset_y: f32,
    diffusion: u8,
    spot: String,
) -> Result<(), JsValue> {
    let mode = SampleMode::from_wire(&mode).ok_or_else(|| {
        JsValue::from_str(&format!("unknown sample mode \"{mode}\" (current | below | all)"))
    })?;
    let spot = SpotType::from_wire(&spot).ok_or_else(|| {
        JsValue::from_str(&format!(
            "unknown spot type \"{spot}\" (content-aware | create-texture | proximity)"
        ))
    })?;
    let handle = STROKE
        .with(|s| s.borrow().as_ref().map(|x| (x.handle(), x.params().tool)))
        .ok_or_else(|| JsValue::from_str("no stroke in progress"))?;
    if !handle.1.samples_image() {
        return Err(JsValue::from_str(
            "only the clone, healing and spot healing tools take sampling options",
        ));
    }
    let pixels = sample_pixels(handle.0, mode).await?;
    STROKE.with(|s| {
        let mut slot = s.borrow_mut();
        let session = slot
            .as_mut()
            .ok_or_else(|| JsValue::from_str("no stroke in progress"))?;
        session.set_sampling(StrokeSampling {
            pixels,
            transform: CloneTransform::new(scale_x, scale_y, angle_deg),
            diffusion: (1..=7).contains(&diffusion).then_some(diffusion),
            spot,
        });
        if has_offset {
            session.set_clone_offset(offset_x, offset_y);
        }
        Ok(())
    })
}

/// The in-flight stroke's fixed `source − destination` offset, `[dx, dy]`
/// (empty before its first dab) — what an Aligned clone carries into the
/// next stroke.
#[wasm_bindgen]
pub fn brush_stroke_source_offset() -> Vec<f32> {
    STROKE.with(|s| {
        s.borrow()
            .as_ref()
            .and_then(|x| x.resolved_offset())
            .map(|(dx, dy)| vec![dx, dy])
            .unwrap_or_default()
    })
}

/// The CLONE SOURCE OVERLAY over the composite: the source (read in `mode`
/// through the transform) shown at the cursor at `opacity`, clipped to a
/// circle of `clip_radius` (≤ 0 = unclipped), optionally inverted.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn clone_overlay(
    handle: u32,
    cursor_x: f32,
    cursor_y: f32,
    anchor_x: f32,
    anchor_y: f32,
    has_offset: bool,
    offset_x: f32,
    offset_y: f32,
    scale_x: f32,
    scale_y: f32,
    angle_deg: f32,
    opacity: f32,
    invert: bool,
    clip_radius: f32,
    mode: String,
) -> Result<Vec<u8>, JsValue> {
    let mode = SampleMode::from_wire(&mode).ok_or_else(|| {
        JsValue::from_str(&format!("unknown sample mode \"{mode}\" (current | below | all)"))
    })?;
    let base = composite(handle)?;
    let (layer, w, h, _) = target(handle)?;
    let src = match sample_pixels(handle, mode).await? {
        Some(px) => px.to_vec(),
        None => layer,
    };
    Ok(crate::clone_source::overlay(
        &base,
        &src,
        w,
        h,
        (cursor_x, cursor_y),
        (anchor_x, anchor_y),
        has_offset.then_some((offset_x, offset_y)),
        &CloneTransform::new(scale_x, scale_y, angle_deg),
        opacity,
        invert,
        (clip_radius > 0.0).then_some(clip_radius),
    ))
}
