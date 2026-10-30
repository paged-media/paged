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

//! SMART OBJECTS (image ADR 482): the doors of the transform, the smart
//! filters' GPU pass, the contents (Edit Contents as a NESTED document,
//! Replace, Relink, Export), and new smart layers from pixels or page
//! items.
//!
//! The smart filters run in the bundle, through the Filter dialog's
//! catalogue, on a DETACHED handle:
//!
//! 1. [`layers_smart_filter_base`] registers the object's unfiltered
//!    render (canvas-sized) as a new flat handle;
//! 2. the bundle runs each live filter's `FilterDef.run` on it, fading a
//!    result over its input with [`layers_smart_filter_fade`] where the
//!    filter's opacity is below 100 %;
//! 3. [`layers_smart_filter_land`] lands the last result through the
//!    filter mask as the layer's pixels — no undo step of its own: it
//!    finishes the step that made the filters pending.

use super::*;

/// The whole state of smart object `index`, as JSON for the panel.
#[wasm_bindgen]
pub fn layers_smart_info(index: usize) -> Result<String, JsValue> {
    with_stack(|d| {
        let l = d
            .stack
            .layers()
            .get(index)
            .ok_or_else(|| JsValue::from_str(&format!("no layer {index}")))?;
        let s = l
            .smart_source()
            .ok_or_else(|| JsValue::from_str(&format!("layer {index} is not a smart object")))?;
        let file = s.file.as_ref().map(|f| {
            serde_json::json!({
                "name": f.name,
                "type": String::from_utf8_lossy(&f.file_type).trim().to_string(),
                "linked": f.link.is_some(),
                "path": f.link,
                "available": f.is_available(),
                "bytes": f.bytes.len(),
            })
        });
        Ok(serde_json::json!({
            "quad": s.quad().to_vec(),
            "width": s.width,
            "height": s.height,
            "scale": s.scale,
            "file": file,
            "vector": s.vector.as_ref().map(|v| serde_json::json!({
                "items": v.items, "region": v.region.to_vec(), "pxPerPt": v.px_per_pt,
            })),
            "filters": s.filters.as_ref().map(|f| f.to_json()),
            "pendingFilters": s.pending_filters,
            "warped": s.warped,
            "nested": PARKED.with(|p| p.borrow().len()),
        })
        .to_string())
    })
}

/// TRANSFORM smart object `index` onto `quad` (eight numbers: the
/// corners top-left, top-right, bottom-right, bottom-left, canvas px).
/// One undo step. Answers whether its smart filters still have to run.
#[wasm_bindgen]
pub fn layers_smart_transform(index: usize, quad: &[f64]) -> Result<bool, JsValue> {
    let q: crate::smart::Quad = quad
        .try_into()
        .map_err(|_| JsValue::from_str("a placement is eight numbers"))?;
    with_stack(|d| d.stack.smart_place(index, q).map_err(ingest_err))
}

/// The layers whose smart filters still have to run.
#[wasm_bindgen]
pub fn layers_smart_pending() -> Vec<u32> {
    LAYERS.with(|l| {
        l.borrow().as_ref().map_or_else(Vec::new, |d| {
            d.stack
                .smart_pending()
                .into_iter()
                .map(|i| i as u32)
                .collect()
        })
    })
}

/// Step 1 of the filter pass: the unfiltered render of `index` as a new
/// flat handle (the caller frees it).
#[wasm_bindgen]
pub fn layers_smart_filter_base(index: usize) -> Result<DecodedHandle, JsValue> {
    let (w, h, px) = with_stack(|d| {
        let px = d.stack.smart_base(index).map_err(ingest_err)?;
        Ok((d.stack.width(), d.stack.height(), px))
    })?;
    register_px(
        w,
        h,
        crate::pixels::Pixels::from_rgba8(Arc::from(px.into_boxed_slice())),
    )
}

/// Step 2's fade: `output` over `input` at `opacity` (a filter's blending
/// options), as a new flat handle.
#[wasm_bindgen]
pub fn layers_smart_filter_fade(
    input: u32,
    output: u32,
    opacity: f32,
) -> Result<DecodedHandle, JsValue> {
    let get = |h: u32| {
        IMAGES
            .with(|m| {
                m.borrow()
                    .get(&h)
                    .map(|i| (i.width, i.height, i.rgba.to_rgba8().into_owned()))
            })
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {h}")))
    };
    let (w, h, a) = get(input)?;
    let (w2, h2, b) = get(output)?;
    if (w, h) != (w2, h2) {
        return Err(JsValue::from_str("a smart filter keeps the canvas"));
    }
    let out = crate::smart::fade(&a, &b, opacity);
    register_px(
        w,
        h,
        crate::pixels::Pixels::from_rgba8(Arc::from(out.into_boxed_slice())),
    )
}

/// The blurs of step 2 run over associated colour
/// (`smart::ASSOCIATED_FILTERS`): `handle` associated (`dissociate`
/// false) or back, as a new flat handle.
#[wasm_bindgen]
pub fn layers_smart_filter_associate(
    handle: u32,
    dissociate: bool,
) -> Result<DecodedHandle, JsValue> {
    let (w, h, px) = IMAGES
        .with(|m| {
            m.borrow()
                .get(&handle)
                .map(|i| (i.width, i.height, i.rgba.to_rgba8().into_owned()))
        })
        .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
    let out = if dissociate {
        crate::smart::dissociate(&px)
    } else {
        crate::smart::associate(&px)
    };
    register_px(
        w,
        h,
        crate::pixels::Pixels::from_rgba8(Arc::from(out.into_boxed_slice())),
    )
}

/// Step 3: land `result` (the filters run over `base`) through the
/// filter mask as the layer's pixels.
#[wasm_bindgen]
pub fn layers_smart_filter_land(index: usize, base: u32, result: u32) -> Result<(), JsValue> {
    let get = |h: u32| {
        IMAGES
            .with(|m| m.borrow().get(&h).map(|i| i.rgba.to_rgba8().into_owned()))
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {h}")))
    };
    let (b, r) = (get(base)?, get(result)?);
    with_stack(|d| {
        d.stack
            .smart_land_filters(index, &b, &r)
            .map_err(ingest_err)
    })
}

/// SET the smart filters of `index` from the panel's JSON (`{enabled,
/// maskEnabled, filters: [{id, values, enabled, opacity, mode, name,
/// from?}]}`), as one undo step named `label`. Answers whether the
/// filters now have to run.
#[wasm_bindgen]
pub fn layers_smart_set_filters(label: &str, index: usize, json: &str) -> Result<bool, JsValue> {
    with_stack(|d| {
        let old = d
            .stack
            .layers()
            .get(index)
            .and_then(|l| l.smart_source())
            .and_then(|s| s.filters.clone());
        let stack = crate::smart::SmartFilterStack::from_json(json, old.as_deref())
            .map_err(|e| JsValue::from_str(&e))?;
        d.stack
            .smart_set_filters(label, index, stack)
            .map_err(ingest_err)
    })
}

/// The FILTER MASK of `index`: `"selection"` (the selection's coverage
/// becomes it), `"invert"`, `"clear"` (all white: no mask), `"hide-all"`.
/// One undo step.
#[wasm_bindgen]
pub fn layers_smart_filter_mask(index: usize, op: &str) -> Result<bool, JsValue> {
    let sel = SELECTION.with(|s| s.borrow().coverage().cloned());
    with_stack(|d| {
        let (w, h) = (d.stack.width(), d.stack.height());
        let old = d
            .stack
            .layers()
            .get(index)
            .and_then(|l| l.smart_source())
            .and_then(|s| s.filters.clone())
            .ok_or_else(|| JsValue::from_str("the layer has no smart filters"))?;
        let mut stack = (*old).clone();
        let canvas = |data: Vec<u8>| {
            image_gpu::SelectionCoverage::from_data(w, h, data).map(|c| Arc::new(c).into())
        };
        stack.mask = match op {
            "selection" => {
                let c = sel.ok_or_else(|| JsValue::from_str("there is no selection"))?;
                canvas(c.data().to_vec())
            }
            "invert" => {
                let cur = stack
                    .mask
                    .as_ref()
                    .map(|m| m.to_canvas().data().to_vec())
                    .unwrap_or_else(|| vec![255; (w * h) as usize]);
                canvas(cur.iter().map(|v| 255 - v).collect())
            }
            "hide-all" => canvas(vec![0; (w * h) as usize]),
            "clear" => None,
            other => {
                return Err(JsValue::from_str(&format!(
                    "filter mask: unknown op {other}"
                )))
            }
        };
        if op == "clear" {
            stack.mask_enabled = true;
        }
        d.stack
            .smart_set_filters("Filter Mask", index, stack)
            .map_err(ingest_err)
    })
}

/// REPLACE the contents of `index` with a file's bytes (Layer ▸ Smart
/// Objects ▸ Replace Contents). `link` names the file for a LINKED
/// object (Relink / Update Modified Content keep it linked); empty embeds.
#[wasm_bindgen]
pub fn layers_smart_replace(
    index: usize,
    bytes: &[u8],
    name: &str,
    link: &str,
) -> Result<bool, JsValue> {
    let file_type = image_psd::smart_object::file_type_of(bytes);
    let current = with_stack(|d| {
        Ok(d.stack
            .layers()
            .get(index)
            .and_then(|l| l.smart_source())
            .and_then(|s| s.file.as_ref().map(|f| (f.uuid.clone(), f.link.clone()))))
    })?;
    let uuid = current.as_ref().map_or_else(
        || crate::smart::new_uuid(name.as_bytes()),
        |(u, _)| u.clone(),
    );
    let same_link = current
        .as_ref()
        .and_then(|(_, l)| l.as_deref())
        .is_some_and(|l| !link.is_empty() && l == link);
    let file = crate::smart::SmartFile::new(
        uuid,
        name,
        file_type,
        Arc::from(bytes.to_vec().into_boxed_slice()),
        (!link.is_empty()).then(|| link.to_string()),
    );
    // Decode up front: a file paged cannot read changes nothing.
    file.raster().map_err(ingest_err)?;
    // Reading the same link again is Update Modified Content.
    let label = match (link.is_empty(), same_link) {
        (true, _) => "Replace Contents",
        (false, true) => "Update Modified Content",
        (false, false) => "Relink",
    };
    with_stack(|d| {
        d.stack
            .smart_replace_source(label, index, file)
            .map_err(ingest_err)
    })
}

/// Layer ▸ Smart Objects ▸ Embed Linked: the linked file's bytes (read
/// by the bundle) become the embedded source.
#[wasm_bindgen]
pub fn layers_smart_embed(index: usize) -> Result<bool, JsValue> {
    let file = with_stack(|d| {
        d.stack
            .layers()
            .get(index)
            .and_then(|l| l.smart_source())
            .and_then(|s| s.file.clone())
            .ok_or_else(|| JsValue::from_str("the layer has no source file"))
    })?;
    if file.link.is_none() {
        return Ok(false);
    }
    if !file.is_available() {
        return Err(JsValue::from_str(
            "the linked file is missing: relink it first",
        ));
    }
    let embedded = crate::smart::SmartFile::new(
        file.uuid.clone(),
        file.name.clone(),
        file.file_type,
        Arc::clone(&file.bytes),
        None,
    );
    with_stack(|d| {
        d.stack
            .smart_replace_source("Embed Linked", index, embedded)
            .map_err(ingest_err)
    })
}

/// The source file's bytes (Export Contents), and its name.
#[wasm_bindgen]
pub fn layers_smart_contents(index: usize) -> Result<js_sys::Uint8Array, JsValue> {
    with_stack(|d| {
        let s = d
            .stack
            .layers()
            .get(index)
            .and_then(|l| l.smart_source())
            .ok_or_else(|| JsValue::from_str(&format!("layer {index} is not a smart object")))?;
        if let Some(f) = s.file.as_ref().filter(|f| !f.bytes.is_empty()) {
            return Ok(js_sys::Uint8Array::from(&f.bytes[..]));
        }
        // Pixels without a file: their PNG.
        let r = s.raster().map_err(ingest_err)?;
        let png = crate::saveback::encode_rgba8(
            &r.rgba,
            r.width,
            r.height,
            crate::saveback::RasterFormat::Png,
        )
        .map_err(ingest_err)?;
        Ok(js_sys::Uint8Array::from(&png[..]))
    })
}

/// A NEW smart layer from straight RGBA8 pixels placed on `quad` — a
/// VECTOR smart object when `items` (JSON `{items, region, pxPerPt}`) is
/// given: page items the host drew (`render.snapshot@2`), drawn again
/// at a higher resolution when the placement grows past it.
#[wasm_bindgen]
pub fn layers_smart_add(
    name: &str,
    rgba: &[u8],
    width: u32,
    height: u32,
    quad: &[f64],
    items: &str,
) -> Result<usize, JsValue> {
    if rgba.len() != width as usize * height as usize * 4 || width == 0 || height == 0 {
        return Err(JsValue::from_str(
            "a smart layer's source is width×height RGBA8",
        ));
    }
    let q: crate::smart::Quad = quad
        .try_into()
        .map_err(|_| JsValue::from_str("a placement is eight numbers"))?;
    let mut src = crate::layers::SmartSource::from_pixels(
        Arc::from(rgba.to_vec().into_boxed_slice()),
        width,
        height,
    );
    src.placement = Some(q);
    if !items.is_empty() {
        let v: serde_json::Value = serde_json::from_str(items)
            .map_err(|e| JsValue::from_str(&format!("vector source: {e}")))?;
        let region = v
            .get("region")
            .and_then(|r| r.as_array())
            .map(|r| {
                let mut a = [0.0; 4];
                for (o, x) in a.iter_mut().zip(r) {
                    *o = x.as_f64().unwrap_or(0.0);
                }
                a
            })
            .unwrap_or([0.0; 4]);
        src.vector = Some(Arc::new(crate::smart::VectorSource {
            items: v
                .get("items")
                .and_then(|i| i.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            region,
            px_per_pt: v.get("pxPerPt").and_then(|x| x.as_f64()).unwrap_or(1.0),
        }));
    }
    with_stack(|d| {
        d.stack
            .add_smart_layer("Place as smart object", name, src)
            .map_err(ingest_err)
    })
}

/// A vector smart object's items drawn again at `px_per_pt`.
#[wasm_bindgen]
pub fn layers_smart_vector_source(
    index: usize,
    rgba: &[u8],
    width: u32,
    height: u32,
    px_per_pt: f64,
) -> Result<bool, JsValue> {
    with_stack(|d| {
        d.stack
            .smart_vector_source(
                index,
                Arc::from(rgba.to_vec().into_boxed_slice()),
                width,
                height,
                px_per_pt,
            )
            .map_err(ingest_err)
    })
}

// ─────────────────────── Edit Contents (nested) ───────────────────────

/// A parent document parked while one of its smart objects' contents is
/// open as a NESTED document.
struct Parked {
    doc: LayerDoc,
    /// The smart object's stable layer id in the parent.
    layer_id: u32,
    /// The contents' file (its uuid, name, type and link).
    file: Option<Arc<crate::smart::SmartFile>>,
    /// The contents opened from a PSD/PSB: the retained parse the save
    /// writes the nested stack into.
    psd: Option<image_psd::PsdFile>,
    /// What the nested document started as, to tell an unchanged one.
    opened_generation: u64,
}

thread_local! {
    static PARKED: RefCell<Vec<Parked>> = const { RefCell::new(Vec::new()) };
}

/// How deep the open contents are nested (0: the document itself).
#[wasm_bindgen]
pub fn smart_contents_depth() -> u32 {
    PARKED.with(|p| p.borrow().len() as u32)
}

/// EDIT CONTENTS: open the source of smart object `index` as a NESTED
/// document. The parent is parked (its stack, its undo list, its handle)
/// and the contents become the bound stack — a PSD/PSB with its layers,
/// any other file as one layer — on a new image handle, which is
/// returned. Every door then works on the contents until
/// [`smart_contents_close`].
#[wasm_bindgen]
pub async fn smart_contents_open(index: usize) -> Result<DecodedHandle, JsValue> {
    let (layer_id, src) = with_stack(|d| {
        let l = d
            .stack
            .layers()
            .get(index)
            .ok_or_else(|| JsValue::from_str(&format!("no layer {index}")))?;
        let s = l
            .smart_source()
            .ok_or_else(|| JsValue::from_str(&format!("layer {index} is not a smart object")))?;
        if s.vector.is_some() {
            return Err(JsValue::from_str(
                "a vector smart object's contents are page items: edit them on the page",
            ));
        }
        Ok((l.id, s.clone()))
    })?;
    let file = src.file.clone();
    let bytes = file
        .as_ref()
        .map(|f| Arc::clone(&f.bytes))
        .filter(|b| !b.is_empty());
    // Decode the contents.
    let (img, psd) = match bytes.as_deref() {
        Some(b) if paged_raster::sniff(b) == Some(paged_raster::Format::Psd) => {
            let img = crate::ingest::decode_rgba8(b).map_err(ingest_err)?;
            let psd =
                image_psd::PsdFile::parse(b).map_err(|e| JsValue::from_str(&e.to_string()))?;
            (img, Some(psd))
        }
        Some(b) => (crate::ingest::decode_rgba8(b).map_err(ingest_err)?, None),
        None => {
            let r = src.raster().map_err(ingest_err)?;
            (
                crate::ingest::DecodedImage {
                    width: r.width,
                    height: r.height,
                    rgba: crate::pixels::Pixels::from_rgba8(Arc::clone(&r.rgba)),
                    display: crate::display::DisplayTreatment::AssumedSrgb,
                    depth_reduced: false,
                },
                None,
            )
        }
    };
    let (w, h) = (img.width, img.height);
    let nested = register_px(w, h, img.rgba.clone())?;
    // The contents' stack: the PSD's layers when they open, else one.
    let mut stack = None;
    if let Some(file) = &psd {
        if let Ok(import) = file.layer_plates_rgba8() {
            if let Ok(s) = LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers))
            {
                let mut s = s;
                s.adopt_psd_smart_objects(file);
                stack = Some(s);
            }
        }
    }
    let stack = match stack {
        Some(s) => s,
        None => LayerStack::from_image(w, h, img.rgba.to_rgba8().into_owned().into())
            .map_err(ingest_err)?,
    };
    let generation = stack.structure_generation();
    let parent = LAYERS
        .with(|l| l.borrow_mut().take())
        .ok_or_else(|| JsValue::from_str("no layer stack open"))?;
    PARKED.with(|p| {
        p.borrow_mut().push(Parked {
            doc: parent,
            layer_id,
            file,
            psd,
            opened_generation: generation,
        })
    });
    LAYERS.with(|l| {
        *l.borrow_mut() = Some(LayerDoc {
            handle: nested.handle,
            stack,
        })
    });
    SELECTION.with(|s| s.borrow_mut().bind(nested.handle, w, h));
    // The composite of the contents in their handle.
    let ctx = GPU.with(|g| g.borrow().clone());
    with_stack_async(|doc| async move {
        let r = match doc.stack.composite_px(ctx.as_deref(), None).await {
            Ok(px) => set_image_pixels(doc.handle, px),
            Err(e) => Err(ingest_err(e)),
        };
        (doc, r)
    })
    .await?;
    Ok(nested)
}

/// CLOSE the open contents. With `save`, the contents are written back
/// into the parent's smart object — a PSD/PSB keeps its layers (the
/// layered save), any other file becomes a PSB of the contents — and the
/// object re-renders from them: ONE undo step in the parent ("Edit
/// Contents"). Without `save` (or unchanged), the parent is as it was.
/// The nested image handle is freed; the parent's handle is returned.
#[wasm_bindgen]
pub async fn smart_contents_close(save: bool) -> Result<DecodedHandle, JsValue> {
    let parked = PARKED
        .with(|p| p.borrow_mut().pop())
        .ok_or_else(|| JsValue::from_str("no smart object's contents are open"))?;
    let nested = LAYERS
        .with(|l| l.borrow_mut().take())
        .ok_or_else(|| JsValue::from_str("no layer stack open"))?;
    let ctx = GPU.with(|g| g.borrow().clone());
    let changed = nested.stack.structure_generation() != parked.opened_generation
        || nested.stack.undo_label().is_some();
    let mut saved: Result<Option<crate::smart::SmartFile>, JsValue> = Ok(None);
    if save && changed {
        saved = async {
            let composite = nested
                .stack
                .composite_px(ctx.as_deref(), None)
                .await
                .map_err(ingest_err)?
                .to_rgba8()
                .into_owned();
            let (w, h) = (nested.stack.width(), nested.stack.height());
            let bytes = crate::smart::contents_bytes(&nested.stack, parked.psd.clone(), &composite)
                .map_err(ingest_err)?;
            let old = parked.file.as_deref();
            let file = crate::smart::SmartFile::new(
                old.map_or_else(|| crate::smart::new_uuid(b"contents"), |f| f.uuid.clone()),
                old.map_or_else(
                    || "contents.psb".to_string(),
                    |f| crate::smart::psb_name(&f.name, &f.file_type),
                ),
                image_psd::smart_object::file_type_of(&bytes),
                Arc::from(bytes.into_boxed_slice()),
                old.and_then(|f| f.link.clone()),
            )
            .with_raster(crate::smart::SourceRaster {
                width: w,
                height: h,
                rgba: Arc::from(composite.into_boxed_slice()),
            });
            Ok(Some(file))
        }
        .await;
    }
    // The parent comes back whatever happened to the save.
    IMAGES.with(|m| m.borrow_mut().remove(&nested.handle));
    PYRAMIDS.with(|p| p.borrow_mut().remove(&nested.handle));
    let Parked { doc, layer_id, .. } = parked;
    let (handle, w, h) = (doc.handle, doc.stack.width(), doc.stack.height());
    LAYERS.with(|l| *l.borrow_mut() = Some(doc));
    SELECTION.with(|s| s.borrow_mut().bind(handle, w, h));
    if let Some(file) = saved? {
        with_stack(|d| {
            let index = d
                .stack
                .layers()
                .iter()
                .position(|l| l.id == layer_id)
                .ok_or_else(|| JsValue::from_str("the smart object is gone from its document"))?;
            d.stack
                .smart_replace_source("Edit Contents", index, file)
                .map_err(ingest_err)
        })?;
    }
    let display = IMAGES.with(|m| m.borrow().get(&handle).map(|i| display_code(i.display)));
    Ok(DecodedHandle {
        handle,
        width: w,
        height: h,
        display: display.unwrap_or(1),
        depth_reduced: false,
    })
}
