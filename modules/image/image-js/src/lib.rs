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

//! The wasm-bindgen surface consumed by `glue/` — the bundle's compute
//! artifact (manifest `capabilities.wasm[0]`).
//!
//! ARCHITECTURE NOTE (BREAKAGE I-07): a module loaded via
//! `loadBundleWasm` has no ambient authority — no `navigator.gpu`. So
//! this crate is loaded through its wasm-bindgen JS glue in the bundle
//! realm (the `@paged-media/sdk` pattern), where WebGPU IS reachable;
//! the engines' GPU device lives behind this surface (`init_gpu`).
//!
//! M4 ingest slice: `decode_image` (PSD/PNG/JPEG → an engine-held RGBA8
//! handle) + `adjust_image` (Engine A adjustments via the ASYNC GPU
//! sink → RGBA8 bytes for the C-1 Stage-A image scene item). Pixels
//! held between calls stay engine-side behind handles (spec §2.1.3);
//! the one RGBA buffer `adjust_image` returns is the Stage-A render
//! payload destined for the HOST scene channel — the narrowed §2.1.3
//! contract the C-1 spike records.
//!
//! THE LAYER GRAPH (`layers_*`) is bound the same way the selection is:
//! one stack per realm, tied to an engine-held image handle, whose
//! COMPOSITE is written back into that same handle. So paint, fills and
//! bakes land in the ACTIVE LAYER (journaled — `layers_undo`), while
//! every other lane here keeps addressing one handle and never has to
//! learn what a layer is.
//!
//! The release-build guarantee proven by CI: NO reference code
//! (image-conformance / `image-kernels` feature `reference`) is
//! reachable from this crate (cargo-tree guard, spec §4 dep rule 2).

pub mod adjust_readouts;
pub mod brushes;
pub mod channels;
pub mod clone_source;
pub mod cmyk;
// Engine work counters (thread-local, always on) — budgets count these.
pub mod color_mode;
pub mod content_aware;
pub mod counters;
pub mod display;
pub mod export;
pub mod fill;
pub mod focus;
pub mod heal;
pub mod ingest;
pub mod inpaint;
pub mod layers;
pub mod magnetic;
pub mod masking;
pub mod mip;
pub mod patchmatch;
pub mod paths;
pub mod pixels;
pub mod planes;
pub mod preset_files;
pub mod psd_layer_ext;
pub mod psd_source;
pub mod psd_vector_mask;
pub mod psd_write;
pub mod readouts;
pub mod refine;
pub mod region_filter;
pub mod retouch;
pub mod saveback;
pub mod selection;
pub mod stroke;
pub mod text;
pub mod vectors;

/// The frozen kernel ABI version this artifact was built against.
pub fn abi_version() -> u32 {
    image_kernels::ABI_VERSION
}

/// Registered kernel count (dispatch-table probe).
pub fn kernel_count() -> usize {
    image_kernels::registry().len()
}

// GATE — a `#[wasm_bindgen]` export is never called from Rust, so a
// missing attribute makes the function dead code rather than a compile
// error, and it silently does not reach JS at all. That is not
// hypothetical: nine kernel entry points shipped without the attribute
// on 2026-08-09 and the TS side was calling functions that did not
// exist on the wasm module. The compiler had said so in a warning
// nobody was obliged to read, so make it binding. Anything genuinely
// unused in here is either an export missing its attribute or a helper
// that should be deleted; both deserve to stop the build.
#[cfg(target_arch = "wasm32")]
#[deny(dead_code)]
mod wasm {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::sync::Arc;

    use image_gpu::{CombineMode, GpuContext, SelectionCoverage};
    use wasm_bindgen::prelude::*;

    use crate::fill::{fill_rgba8, FillSpec, GradientKind};
    use crate::ingest::{
        adjust_rgba8, crop_rgba8, decode_rgba8, straighten_crop_rgba8, AdjustParams, DecodedImage,
        IngestError, LevelsParams,
    };
    use crate::layers::LayerStack;
    use crate::mip::MipPyramid;
    use crate::saveback::{encode_rgba8, psd_write_adjusted, RasterFormat};
    use crate::selection::SessionSelection;
    use crate::stroke::{blend_kernel, blend_names, StrokeParams, StrokeSession, StrokeTool};
    use image_gpu::dab::PressureTarget;

    // WP5.2 filter doors: one child module per family group (`src/wasm/`).
    // Each reaches this module's private helpers (`apply_point_kernel`,
    // `fill_prelude`, the landing) as a descendant.
    mod filters_adjust;
    mod filters_blur;
    mod filters_chain;
    mod filters_distort;
    mod filters_stylize;

    thread_local! {
        /// The bundle-realm GPU device (I-07: created HERE, where
        /// `navigator.gpu` is reachable; the wasm sandbox has none).
        static GPU: RefCell<Option<Rc<GpuContext>>> = const { RefCell::new(None) };
        /// Decoded images held engine-side behind handles (§2.1.3).
        static IMAGES: RefCell<HashMap<u32, DecodedImage>> =
            RefCell::new(HashMap::new());
        static NEXT_HANDLE: Cell<u32> = const { Cell::new(1) };
        /// Engine-B mip pyramids built lazily for the `level > 0` tile
        /// window path, cached per image handle (build once, sample many).
        /// Dropped when the image is freed.
        static PYRAMIDS: RefCell<HashMap<u32, Rc<MipPyramid>>> =
            RefCell::new(HashMap::new());
        /// The per-session SELECTION (one per wasm realm — the session's
        /// active source image binds it via `selection_bind`). The adjust
        /// chain reads it through `SessionSelection::mask_for`.
        static SELECTION: RefCell<SessionSelection> =
            RefCell::new(SessionSelection::new());
    }

    #[wasm_bindgen(start)]
    pub fn init() {
        console_error_panic_hook::set_once();
    }

    #[wasm_bindgen]
    pub fn abi_version() -> u32 {
        super::abi_version()
    }

    #[wasm_bindgen]
    pub fn kernel_count() -> usize {
        super::kernel_count()
    }

    /// The hash of the sources this wasm was built from
    /// (`tooling/js/source-hash.mjs`, stamped by `scripts/build-wasm.sh`;
    /// "unstamped" for any other build). `glue/test/wasm-fresh.spec.ts`
    /// compares it with the checkout, so a stale committed wasm fails
    /// the suite instead of being tested in place of the code.
    /// Engine + GPU work counters since the last reset, as JSON
    /// (`{engine:{…}, gpu:{…}}`, see `counters::to_json`). What the
    /// bundle's performance budgets count.
    #[wasm_bindgen]
    pub fn perf_counters() -> String {
        crate::counters::to_json()
    }

    /// Zero the engine and GPU work counters.
    #[wasm_bindgen]
    pub fn perf_counters_reset() {
        crate::counters::reset();
    }

    #[wasm_bindgen]
    pub fn engine_source_hash() -> String {
        option_env!("IMAGE_JS_SOURCE_HASH")
            .unwrap_or("unstamped")
            .to_string()
    }

    /// Does the embedding realm expose WebGPU (`navigator.gpu`)? Probed
    /// BEFORE touching wgpu so a GPU-less realm (Node tests, an old
    /// browser) gets a clean rejection instead of a wasm panic that
    /// would poison the instance for the still-valid decode lanes.
    fn has_webgpu() -> bool {
        let global = js_sys::global();
        let Ok(navigator) = js_sys::Reflect::get(&global, &JsValue::from_str("navigator")) else {
            return false;
        };
        if navigator.is_undefined() || navigator.is_null() {
            return false;
        }
        js_sys::Reflect::get(&navigator, &JsValue::from_str("gpu"))
            .map(|gpu| !gpu.is_undefined() && !gpu.is_null())
            .unwrap_or(false)
    }

    /// Request the WebGPU adapter/device for kernel execution.
    /// Idempotent. Rejects when the environment has no WebGPU — the
    /// honest no-GPU state (no CPU kernel path ships, spec §6).
    #[wasm_bindgen]
    pub async fn init_gpu() -> Result<(), JsValue> {
        if GPU.with(|g| g.borrow().is_some()) {
            return Ok(());
        }
        if !has_webgpu() {
            return Err(JsValue::from_str(
                "WebGPU unavailable in this realm (no navigator.gpu)",
            ));
        }
        let ctx = GpuContext::new()
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        GPU.with(|g| *g.borrow_mut() = Some(Rc::new(ctx)));
        Ok(())
    }

    /// Whether `init_gpu` succeeded (the glue probes this to gate the
    /// adjust controls honestly).
    #[wasm_bindgen]
    pub fn gpu_ready() -> bool {
        GPU.with(|g| g.borrow().is_some())
    }

    /// A filter on a region (ADR 465): the adjustment chain whose
    /// parameters are the adjustment-layer wire block (`AdjustParams::
    /// to_wire`) applied to the rectangle `x, y, w, h` of a straight
    /// RGBA8 image, narrowed by a mask given as data; returns the whole
    /// image. The mask: `polygons` (flat `x, y` pairs in image pixels,
    /// `polygon_lens` points each), their ops (`polygon_ops`, one byte
    /// per polygon or empty: 0 add, 1 subtract, 2 intersect) and how the
    /// add polygons fill (`fill_rule`: 0 each alone, unioned; 1 non-zero;
    /// 2 even–odd), `alpha` (`width · height`
    /// coverage bytes, empty for none; intersected) and `feather` (σ px,
    /// 0 for none) — `region_filter::mask_coverage`. Partial coverage
    /// blends filtered and original pixels. On the GPU when `init_gpu`
    /// succeeded, otherwise on the shipped CPU twins of the same kernels
    /// — the one place a kernel runs without a device. Pixels the mask
    /// leaves at 0 are returned unchanged.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn filter_region_rgba8(
        width: u32,
        height: u32,
        rgba: Vec<u8>,
        wire: Vec<f32>,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        polygons: Vec<f32>,
        polygon_lens: Vec<u32>,
        polygon_ops: Vec<u8>,
        fill_rule: u8,
        alpha: Vec<u8>,
        feather: f32,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        use crate::region_filter::{
            filter_masked_cpu, filter_masked_gpu, mask_coverage, FillRule, PixelRect, PolygonOp,
            RegionMask,
        };
        let params =
            AdjustParams::from_wire(&wire).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let rect = PixelRect { x, y, w, h };
        if rgba.len() != width as usize * height as usize * 4 {
            return Err(JsValue::from_str(&format!(
                "expected {width}×{height} RGBA8, got {} bytes",
                rgba.len()
            )));
        }
        let total: usize = polygon_lens.iter().map(|&n| n as usize).sum();
        if total * 2 != polygons.len() {
            return Err(JsValue::from_str(&format!(
                "polygon_lens name {total} points, polygons carries {} numbers",
                polygons.len()
            )));
        }
        let ops = polygon_ops
            .iter()
            .map(|&o| PolygonOp::from_u8(o))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| {
                JsValue::from_str("a polygon op is 0 (add), 1 (subtract) or 2 (intersect)")
            })?;
        let fill_rule = FillRule::from_u8(fill_rule).ok_or_else(|| {
            JsValue::from_str("a fill rule is 0 (union), 1 (non-zero) or 2 (even-odd)")
        })?;
        let mut pts = polygons.as_chunks::<2>().0.iter().map(|&[x, y]| (x, y));
        let mask = RegionMask {
            polygons: polygon_lens
                .iter()
                .map(|&n| pts.by_ref().take(n as usize).collect())
                .collect(),
            ops,
            fill_rule,
            feather,
            alpha: (!alpha.is_empty()).then_some(alpha),
        };
        let cov = mask_coverage(width, height, rect, &mask).map_err(|e| JsValue::from_str(&e))?;
        let mut px = rgba;
        let ctx = GPU.with(|g| g.borrow().clone());
        match ctx {
            Some(ctx) => filter_masked_gpu(&ctx, width, height, &mut px, &params, cov).await,
            None => filter_masked_cpu(width, height, &mut px, &params, &cov),
        }
        .map_err(|e| JsValue::from_str(&e))?;
        Ok(js_sys::Uint8Array::from(&px[..]))
    }

    /// A decoded image's identity on the surface: the handle keys the
    /// engine-held pixels; width/height are the natural extent.
    #[wasm_bindgen]
    #[derive(Clone, Copy)]
    pub struct DecodedHandle {
        pub handle: u32,
        pub width: u32,
        pub height: u32,
        /// CMS rung 1 — what the RGB display transform did at decode, as a
        /// discriminant the bundle maps to a label: 0 = ICC managed,
        /// 1 = sRGB assumed (no embedded profile), 2 = sRGB assumed
        /// because an embedded profile was rejected, 3 = CMYK converted to
        /// sRGB through its embedded profile, 4 = CMYK converted with the
        /// device formula (no usable profile). Surfaced so the panel
        /// can STATE the colour treatment instead of leaving the user to
        /// guess which numbers they are looking at.
        pub display: u8,
        /// The source was 16 bits per channel and was reduced to 8 at
        /// ingest. Same reason `display` is here: a lossy step the user
        /// can see stated is a different thing from one they cannot.
        pub depth_reduced: bool,
    }

    /// Map the Rust treatment onto the wire discriminant above.
    fn display_code(t: crate::display::DisplayTreatment) -> u8 {
        use crate::display::DisplayTreatment as D;
        match t {
            D::Managed => 0,
            D::AssumedSrgb => 1,
            D::ProfileRejected => 2,
            D::CmykConverted => 3,
            D::CmykUncalibrated => 4,
            D::HdrClipped => 5,
        }
    }

    /// The stored treatment for an engine-held image, defaulting to
    /// "sRGB assumed" for an unknown handle — a missing image is already
    /// an error on every path that calls this, and guessing "managed"
    /// would be the one dishonest answer.
    fn read_display(handle: u32) -> u8 {
        IMAGES
            .with(|m| m.borrow().get(&handle).map(|i| i.display))
            .map(display_code)
            .unwrap_or(1)
    }

    /// Whether an engine-held image was reduced from 16 bits at ingest.
    /// Defaults to `false` for an unknown handle — claiming a reduction
    /// that may not have happened would be the dishonest direction.
    fn read_depth_reduced(handle: u32) -> bool {
        IMAGES.with(|m| {
            m.borrow()
                .get(&handle)
                .map(|i| i.depth_reduced)
                .unwrap_or(false)
        })
    }

    /// Decode PSD/PNG/JPEG bytes (sniffed by magic) into an engine-held
    /// RGBA8 image. Free with `free_image`.
    #[wasm_bindgen]
    pub fn decode_image(bytes: &[u8]) -> Result<DecodedHandle, JsValue> {
        let img = decode_rgba8(bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let (width, height) = (img.width, img.height);
        let display = display_code(img.display);
        let depth_reduced = img.depth_reduced;
        IMAGES.with(|m| m.borrow_mut().insert(handle, img));
        Ok(DecodedHandle {
            handle,
            width,
            height,
            display,
            depth_reduced,
        })
    }

    /// K-3 (S-07 / I-02) — register a PRE-DECODED straight-RGBA8 buffer
    /// (from the decode worker pool, which ran the codec/PSD CPU lanes
    /// off-thread) as an engine-held image, returning a handle for the GPU
    /// adjust + tile paths. `bytes` must be exactly `width*height*4` RGBA8;
    /// a length mismatch is a clean error. Free with `free_image`.
    #[wasm_bindgen]
    pub fn ingest_rgba8(width: u32, height: u32, bytes: Vec<u8>) -> Result<DecodedHandle, JsValue> {
        let img = DecodedImage::from_rgba8(width, height, bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let display = display_code(img.display);
        // K-3 registers PRE-DECODED 8-bit bytes, so nothing was reduced
        // on this path — the worker that decoded them owns that fact.
        let depth_reduced = img.depth_reduced;
        IMAGES.with(|m| m.borrow_mut().insert(handle, img));
        Ok(DecodedHandle {
            handle,
            width,
            height,
            display,
            depth_reduced,
        })
    }

    /// [`ingest_rgba8`]'s 16-bit twin: straight RGBA at 16 bits per
    /// sample, `width*height*4` samples — what the decode worker hands
    /// over for a 16-bit source, so the off-thread decode keeps the depth
    /// the main-thread one does (image ADR 479).
    #[wasm_bindgen]
    pub fn ingest_rgba16(
        width: u32,
        height: u32,
        samples: Vec<u16>,
    ) -> Result<DecodedHandle, JsValue> {
        if width == 0 || height == 0 || samples.len() != width as usize * height as usize * 4 {
            return Err(JsValue::from_str(&format!(
                "ingest_rgba16: {} samples for {width}×{height} (expected {})",
                samples.len(),
                width as usize * height as usize * 4
            )));
        }
        let img = DecodedImage {
            width,
            height,
            rgba: crate::pixels::Pixels::from_rgba16(&samples),
            display: crate::display::DisplayTreatment::AssumedSrgb,
            depth_reduced: false,
        };
        let handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let display = display_code(img.display);
        IMAGES.with(|m| m.borrow_mut().insert(handle, img));
        Ok(DecodedHandle {
            handle,
            width,
            height,
            display,
            depth_reduced: false,
        })
    }

    /// An engine-held image's samples at 16 bits (an 8-bit image widened
    /// exactly) — the decode worker's hand-off of a 16-bit source.
    #[wasm_bindgen]
    pub fn image_samples16(handle: u32) -> Result<Vec<u16>, JsValue> {
        IMAGES.with(|m| {
            let map = m.borrow();
            let img = map
                .get(&handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
            let px = &img.rgba;
            Ok((0..px.pixel_count() * 4)
                .map(|i| px.sample16(i / 4, i % 4))
                .collect())
        })
    }

    /// Bits per channel an engine-held image holds: 8 or 16 (Image ▸
    /// Mode's checked depth).
    #[wasm_bindgen]
    pub fn image_bits(handle: u32) -> Result<u8, JsValue> {
        IMAGES.with(|m| {
            let map = m.borrow();
            let img = map
                .get(&handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
            Ok(if img.rgba.is_16bit() { 16 } else { 8 })
        })
    }

    /// Run the M4 adjustments chain on a decoded image and return the
    /// straight-RGBA8 result — the C-1 Stage-A scene-item payload.
    /// Identity params return the decode verbatim (no dispatch to run);
    /// anything else requires `init_gpu` to have succeeded.
    #[wasm_bindgen]
    pub async fn adjust_image(
        handle: u32,
        exposure_ev: f32,
        brightness: f32,
        contrast: f32,
        saturation: f32,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let params = AdjustParams {
            exposure_ev,
            brightness,
            contrast,
            saturation,
            ..Default::default()
        };
        run_adjust(handle, &img, params).await
    }

    /// The FULL adjustments pass — the levels/curves/white-balance panel's
    /// committed values. The 9 scalars are exposure/brightness/contrast/
    /// saturation (as `adjust_image`), white balance (temp/tint), and the
    /// composite levels in/gamma/out window; `curve_lut` is an OPTIONAL
    /// 256-byte tone LUT (the panel builds it from its curve control points
    /// via `image_core::curve_lut`; pass an empty array for no curve). The
    /// curves stage is a CPU LUT pass (no GPU LUT kernel yet — the honest
    /// deferral); everything else is the GPU adjust chain. Returns straight
    /// RGBA8 (the C-1 Stage-A scene payload).
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn adjust_image_full(
        handle: u32,
        exposure_ev: f32,
        brightness: f32,
        contrast: f32,
        saturation: f32,
        temp: f32,
        tint: f32,
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
        curve_lut: &[u8],
        blur_sigma: f32,
        sharpen_amount: f32,
        hue_degrees: f32,
        invert: bool,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        adjust_image_ext(
            handle,
            exposure_ev,
            brightness,
            contrast,
            saturation,
            temp,
            tint,
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
            curve_lut,
            blur_sigma,
            sharpen_amount,
            hue_degrees,
            invert,
            &[],
        )
        .await
    }

    /// [`adjust_image_full`] PLUS the EXTENDED (kernel-breadth) stages —
    /// vibrance, color balance, black & white, posterize, threshold,
    /// photo filter, channel mixer and per-channel levels — carried in
    /// ONE flat `f32` block so the boundary does not grow an argument
    /// per stage. `ext` is either EMPTY (every extended stage at
    /// identity — what `adjust_image_full` passes) or exactly
    /// `ingest::ADJUST_EXT_LEN` floats in the layout documented on that
    /// constant. The chain order is documented on `ingest::adjust_rgba8`;
    /// every stage is mask-aware (the bound selection rides `@group(2)`).
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn adjust_image_ext(
        handle: u32,
        exposure_ev: f32,
        brightness: f32,
        contrast: f32,
        saturation: f32,
        temp: f32,
        tint: f32,
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
        curve_lut: &[u8],
        blur_sigma: f32,
        sharpen_amount: f32,
        hue_degrees: f32,
        invert: bool,
        ext: &[f32],
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let params = build_adjust_params(
            exposure_ev,
            brightness,
            contrast,
            saturation,
            temp,
            tint,
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
            curve_lut,
            blur_sigma,
            sharpen_amount,
            hue_degrees,
            invert,
            ext,
        )?;
        run_adjust(handle, &img, params).await
    }

    /// Decode the flat adjust wire block into [`AdjustParams`]. Shared by
    /// `adjust_image_ext` (the re-runnable PREVIEW chain) and
    /// `layers_bake_adjust` (the DESTRUCTIVE per-layer bake) so the two
    /// can never interpret the same wire differently.
    #[allow(clippy::too_many_arguments)]
    fn build_adjust_params(
        exposure_ev: f32,
        brightness: f32,
        contrast: f32,
        saturation: f32,
        temp: f32,
        tint: f32,
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
        curve_lut: &[u8],
        blur_sigma: f32,
        sharpen_amount: f32,
        hue_degrees: f32,
        invert: bool,
        ext: &[f32],
    ) -> Result<AdjustParams, JsValue> {
        // 256 bytes: the composite curve. 1024: composite, then red, green
        // and blue channel curves. An identity composite in the 1024 form
        // is dropped, so only the channel curves run.
        let table = |b: &[u8]| -> [u8; 256] { std::array::from_fn(|i| b[i]) };
        let identity: [u8; 256] = std::array::from_fn(|i| i as u8);
        let (lut, curve_rgb) = match curve_lut.len() {
            0 => (None, None),
            256 => (Some(table(curve_lut)), None),
            1024 => {
                let comp = table(&curve_lut[..256]);
                (
                    (comp != identity).then_some(comp),
                    Some(Box::new([
                        table(&curve_lut[256..512]),
                        table(&curve_lut[512..768]),
                        table(&curve_lut[768..]),
                    ])),
                )
            }
            n => {
                return Err(JsValue::from_str(&format!(
                    "curve_lut must be 256 or 1024 bytes, or empty (got {n})"
                )))
            }
        };
        let mut params = AdjustParams {
            exposure_ev,
            brightness,
            contrast,
            saturation,
            temp,
            tint,
            levels: LevelsParams {
                in_black,
                in_white,
                gamma,
                out_black,
                out_white,
            },
            curve_lut: lut,
            curve_rgb,
            blur_sigma,
            sharpen_amount,
            hue_degrees,
            invert,
            ..Default::default()
        };
        params
            .apply_extended(ext)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(params)
    }

    /// Shared adjust runner: identity → the decode verbatim; otherwise the
    /// GPU chain (requires `init_gpu`) plus any CPU curve LUT. When the
    /// session SELECTION is bound to `handle` and non-trivial, its
    /// coverage masks EVERY dispatch (the §6.1 mask ABI) and the curve
    /// LUT pass — the adjustment lands only inside the selection.
    async fn run_adjust(
        handle: u32,
        img: &DecodedImage,
        params: AdjustParams,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        if params.is_identity() {
            return Ok(js_sys::Uint8Array::from(&img.rgba.to_rgba8()[..]));
        }
        let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
            JsValue::from_str(
                "GPU not initialized — await init_gpu() first (kernels are \
                 GPU-only; no CPU fallback ships)",
            )
        })?;
        let selection = SELECTION.with(|s| s.borrow().mask_for(handle));
        let out = adjust_rgba8(&ctx, img, &params, selection)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(js_sys::Uint8Array::from(&out[..]))
    }

    /// Compute the RGB + luma 256-bin histogram of an engine-held image as
    /// a flat `[r…, g…, b…, luma…]` 1024-`u32` array (the LEVELS / CURVES
    /// panel slices it into four channels). Pure CPU reduction over the
    /// straight-RGBA8 buffer (no GPU); deterministic.
    #[wasm_bindgen]
    pub fn image_histogram(handle: u32) -> Result<js_sys::Uint32Array, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let hist = image_gpu::histogram_rgba8(&img.rgba.to_rgba8());
        Ok(js_sys::Uint32Array::from(&hist.to_flat()[..]))
    }

    /// Compute the AUTO-ENHANCE adjustment parameters for an engine-held
    /// image and return them as `[in_black, in_white, temp, tint]` (4
    /// `f32`). A single "auto" estimate composing the EXISTING levels +
    /// white-balance kernels: it builds the RGB+luma histogram (the same
    /// `histogram_rgba8` reduction the panel reads), derives a percentile-
    /// clipped auto-levels black/white range (0.5%/99.5% of luma) and a
    /// gray-world white-balance `temp`/`tint`, and emits the params the
    /// LEVELS/WB panel commits through `adjust_image_full` (levels
    /// `in_black`/`in_white`, white-balance `temp`/`tint`; gamma/output
    /// range stay identity). Pure CPU readout/orchestration (spec §6) —
    /// deterministic, no GPU, no kernel dispatch row. A flat or already-
    /// neutral image yields the identity `[0, 1, 0, 0]` (a guaranteed
    /// no-op), never a wrong-looking auto-correction.
    #[wasm_bindgen]
    pub fn image_auto_enhance_params(handle: u32) -> Result<js_sys::Float32Array, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let hist = image_gpu::histogram_rgba8(&img.rgba.to_rgba8());
        let auto = image_gpu::auto_enhance(&hist);
        let out = [auto.in_black, auto.in_white, auto.temp, auto.tint];
        Ok(js_sys::Float32Array::from(&out[..]))
    }

    /// Commit a CROP: cut the integer pixel rectangle `(x, y, w, h)`
    /// (clamped to the image extent) out of an engine-held image and
    /// register the result as a NEW engine-held image, returning its
    /// handle. The source handle is left intact (the caller frees it). An
    /// out-of-bounds / empty rectangle is a clean error (never a torn
    /// image). This door is the AXIS-ALIGNED cut only — the straighten
    /// angle rides `straighten_crop_image`, which rotates first.
    #[wasm_bindgen]
    pub fn crop_image(
        handle: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<DecodedHandle, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let cropped =
            crop_rgba8(&img, x, y, w, h).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let new_handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let (width, height) = (cropped.width, cropped.height);
        let cropped_display = display_code(cropped.display);
        let cropped_reduced = cropped.depth_reduced;
        IMAGES.with(|m| m.borrow_mut().insert(new_handle, cropped));
        Ok(DecodedHandle {
            handle: new_handle,
            width,
            height,
            // A crop inherits the source image's treatment — and its
            // provenance: cutting a rectangle out does not un-reduce a
            // 16-bit source.
            display: cropped_display,
            depth_reduced: cropped_reduced,
        })
    }

    /// STRAIGHTEN + CROP commit: rotate the image by `−degrees` about
    /// the crop rectangle's centre (`geom.rotate_bilinear`, backward
    /// mapped, bilinear, clamp-to-edge) so the rotated FRAME the overlay
    /// previewed lands upright, then cut `(x, y, w, h)` out of the
    /// result and register it as a NEW engine-held image. The source
    /// handle is left intact.
    ///
    /// `degrees == 0` takes the pure-windowing [`crop_image`] path — no
    /// GPU, no resample, no interpolation blur for an axis-aligned crop.
    /// A non-zero angle IS a resample and so is GPU-only (`init_gpu`
    /// first); it rejects honestly without a device.
    #[wasm_bindgen]
    pub async fn straighten_crop_image(
        handle: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        degrees: f32,
    ) -> Result<DecodedHandle, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let out = if degrees == 0.0 {
            crop_rgba8(&img, x, y, w, h).map_err(|e| JsValue::from_str(&e.to_string()))?
        } else {
            let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
                JsValue::from_str(
                    "the straighten resample is GPU-only — call init_gpu first \
                     (an axis-aligned crop at 0° needs no device)",
                )
            })?;
            straighten_crop_rgba8(&ctx, &img, x, y, w, h, degrees)
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?
        };
        let (width, height) = (out.width, out.height);
        register(width, height, out.rgba.to_rgba8().into_owned())
    }

    // ── crop interaction GEOMETRY (pure view math; the TS crop machine
    // forwards pointer points + renders the frame the overlay draws) ──
    //
    // These wrap `image_core::crop` so the deterministic, Rust-tested
    // geometry is the ONE source of truth (the TS stays thin). A crop rect
    // crosses the boundary as `[x, y, w, h]`; the aspect lock is encoded as
    // `aspect_w`/`aspect_h` (0/0 = free, equal = square, else the ratio).

    /// Decode an aspect lock from the `(aspect_w, aspect_h)` wire pair:
    /// `(0, _)`/`(_, 0)` → free; otherwise the `w:h` ratio.
    fn decode_aspect(aspect_w: f32, aspect_h: f32) -> image_core::AspectLock {
        if aspect_w <= 0.0 || aspect_h <= 0.0 {
            image_core::AspectLock::Free
        } else {
            image_core::AspectLock::Ratio(aspect_w, aspect_h)
        }
    }

    /// Hit-test the crop chrome at `(px, py)` (image-px) against the rect
    /// `[x, y, w, h]` with grab radius `tol`. Returns the [`image_core::
    /// Handle`] discriminant (0..=7 grips, 8 = body Move) or `-1` for a
    /// miss — the TS machine maps it to a cursor + the active grip.
    #[wasm_bindgen]
    pub fn crop_hit_handle(x: f32, y: f32, w: f32, h: f32, px: f32, py: f32, tol: f32) -> i32 {
        let rect = image_core::CropRect { x, y, w, h };
        match image_core::hit_handle(&rect, (px, py), tol) {
            Some(handle) => handle as i32,
            None => -1,
        }
    }

    /// Apply a pointer drag from `(sx, sy)` to `(px, py)` (image-px) to the
    /// rect `[x, y, w, h]` at `handle` (the [`crop_hit_handle`]
    /// discriminant), with the aspect lock + image-extent clamp. Returns
    /// the new rect as `[x, y, w, h]`. An unknown handle returns the rect
    /// unchanged (defensive).
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub fn crop_apply_drag(
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        handle: i32,
        sx: f32,
        sy: f32,
        px: f32,
        py: f32,
        aspect_w: f32,
        aspect_h: f32,
        image_w: u32,
        image_h: u32,
    ) -> Vec<f32> {
        let rect = image_core::CropRect { x, y, w, h };
        let handle = match handle {
            0 => image_core::Handle::TopLeft,
            1 => image_core::Handle::Top,
            2 => image_core::Handle::TopRight,
            3 => image_core::Handle::Right,
            4 => image_core::Handle::BottomRight,
            5 => image_core::Handle::Bottom,
            6 => image_core::Handle::BottomLeft,
            7 => image_core::Handle::Left,
            8 => image_core::Handle::Move,
            _ => return vec![rect.x, rect.y, rect.w, rect.h],
        };
        let out = image_core::apply_drag(
            &rect,
            handle,
            (sx, sy),
            (px, py),
            decode_aspect(aspect_w, aspect_h),
            image_w,
            image_h,
        );
        vec![out.x, out.y, out.w, out.h]
    }

    /// The four corners of the crop FRAME rotated by the straighten
    /// `degrees`, as a flat `[x0,y0, x1,y1, x2,y2, x3,y3]` (TL, TR, BR, BL)
    /// the overlay draws as a closed polyline.
    #[wasm_bindgen]
    pub fn crop_frame_corners(x: f32, y: f32, w: f32, h: f32, degrees: f32) -> Vec<f32> {
        let rect = image_core::CropRect { x, y, w, h };
        let c = image_core::frame_corners(&rect, degrees);
        vec![
            c[0].0, c[0].1, c[1].0, c[1].1, c[2].0, c[2].1, c[3].0, c[3].1,
        ]
    }

    /// Build a 256-byte tone LUT from flat `[i0,o0, i1,o1, …]` curve
    /// control points in `[0,1]` (the CURVES editor's points) — the LUT
    /// `adjust_image_full` consumes. Wraps `image_core::curve_lut`.
    #[wasm_bindgen]
    pub fn curve_lut(points: &[f32]) -> Vec<u8> {
        let pts: Vec<(f32, f32)> = points.chunks_exact(2).map(|c| (c[0], c[1])).collect();
        image_core::curve_lut(&pts).to_vec()
    }

    /// C-6 (I-06) — copy a LEVEL-0 tile window `(x, y, w, h)` out of a
    /// decoded image as tightly packed RGBA8 (`w*h*4` bytes, row-major).
    /// Edge tiles are clamped to the image extent (the caller passes the
    /// requested grid origin + size; the returned buffer is the clipped
    /// intersection). This is the HONEST SUBSET of the resource provider:
    /// pure windowing of the already-decoded buffer (no resampling kernel,
    /// no GPU dispatch — orchestration, spec §6). The mip pyramid + the
    /// Engine B `(node, region, level)` window evaluation
    /// (`image_graph::BufferGraph::request`, rgba16float) are NOT yet
    /// wired across this wasm boundary — see the gap note in
    /// glue/src/tile-provider.ts. Returns an empty buffer when the window
    /// lies fully outside the image (a transparent miss the provider skips).
    #[wasm_bindgen]
    pub fn image_tile_rgba8(
        handle: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let (bytes, _tw, _th) = img.tile_window_rgba8(x, y, w, h);
        Ok(js_sys::Uint8Array::from(&bytes[..]))
    }

    /// C-6 (I-06) — copy a tile window `(x, y, w, h)` out of a decoded
    /// image at mip `level` as tightly packed RGBA8 (`w'*h'*4` bytes,
    /// clipped to the level extent, row-major). `level == 0` is the fast
    /// level-0 path ([`image_tile_rgba8`]'s pure windowing); `level > 0`
    /// routes through Engine B's tiled buffer graph
    /// (`image_graph::BufferGraph`): a 2×-box mip pyramid of rgba16float
    /// source tiles is built once per handle (cached) and the requested
    /// window is gathered from `(level, coord)` source reads and
    /// downconverted back to RGBA8. The coordinates are in the LEVEL's
    /// pixel space (already halved per level — the caller scales). No GPU
    /// is required (a source read carries no kernel dispatch). Returns an
    /// empty buffer when the window lies fully outside the level, or when
    /// `level` exceeds the pyramid top (a transparent miss the provider
    /// skips). `max_level` bounds the pyramid height built on first touch.
    #[wasm_bindgen]
    pub fn image_tile_rgba8_level(
        handle: u32,
        level: u32,
        x: u32,
        y: u32,
        size: u32,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        // Fast path: level 0 needs no pyramid (pure windowing of the
        // already-decoded buffer).
        if level == 0 {
            let img = IMAGES
                .with(|m| m.borrow().get(&handle).cloned())
                .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
            let (bytes, _tw, _th) = img.tile_window_rgba8(x, y, size, size);
            return Ok(js_sys::Uint8Array::from(&bytes[..]));
        }

        let level_u8: u8 = level
            .try_into()
            .map_err(|_| JsValue::from_str(&format!("mip level {level} out of range (max 255)")))?;

        // Build (or reuse the cached) pyramid for this handle. The pyramid
        // height is bounded by the requested level (built up to it).
        let pyramid = PYRAMIDS.with(|p| p.borrow().get(&handle).cloned());
        let pyramid = match pyramid {
            Some(p) if p.max_level() >= level_u8 => p,
            _ => {
                let img = IMAGES
                    .with(|m| m.borrow().get(&handle).cloned())
                    .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
                let built = Rc::new(MipPyramid::build(
                    img.width,
                    img.height,
                    &img.rgba.to_rgba8(),
                    level_u8,
                ));
                PYRAMIDS.with(|p| p.borrow_mut().insert(handle, Rc::clone(&built)));
                built
            }
        };

        let (bytes, _tw, _th) = pyramid.window_rgba8(level_u8, x, y, size, size);
        Ok(js_sys::Uint8Array::from(&bytes[..]))
    }

    /// Release an engine-held decoded image (its mip pyramid cache, and
    /// the layer stack bound to it — a stack whose composite target is
    /// gone has nowhere to land).
    #[wasm_bindgen]
    pub fn free_image(handle: u32) {
        IMAGES.with(|m| {
            m.borrow_mut().remove(&handle);
        });
        PYRAMIDS.with(|p| {
            p.borrow_mut().remove(&handle);
        });
        LAYERS.with(|l| {
            let drop_it = l.borrow().as_ref().map(|d| d.handle) == Some(handle);
            if drop_it {
                *l.borrow_mut() = None;
            }
        });
    }

    // ─────────────────────── SELECTION doors (§6.1) ───────────────────────
    //
    // The per-session selection: a u8 coverage field at the bound image's
    // resolution (image_gpu::SelectionCoverage — all mask PREP, inherently
    // CPU; consumption is GPU-only via the adjust chain's @group(2) r16float
    // mask, `out = mix(a, result, mask)` per dispatch). `mode` on the shape
    // doors is 0 = replace, 1 = add, 2 = subtract, 3 = intersect.
    // Semantics (selection.rs): no selection = everything (adjust runs
    // unmasked); subtract/intersect against no selection start from FULL;
    // `selection_clear` returns to "no selection"; re-binding to a
    // different handle/resolution drops the coverage.

    fn decode_mode(mode: u32) -> Result<CombineMode, JsValue> {
        CombineMode::from_u32(mode).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown selection mode {mode} (0 replace | 1 add | 2 subtract | 3 intersect)"
            ))
        })
    }

    fn with_selection<T>(
        f: impl FnOnce(&mut SessionSelection) -> Result<T, String>,
    ) -> Result<T, JsValue> {
        SELECTION
            .with(|s| f(&mut s.borrow_mut()))
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Bind the session selection to an engine-held image (the selection
    /// field takes ITS resolution; the magic wand floods ITS pixels; the
    /// adjust doors mask only when adjusting THIS handle). Re-binding to
    /// the same handle keeps the selection; a different handle (a crop /
    /// resize swap) or resolution drops it.
    #[wasm_bindgen]
    pub fn selection_bind(handle: u32) -> Result<(), JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        SELECTION.with(|s| s.borrow_mut().bind(handle, img.width, img.height));
        note_selection(None, None);
        Ok(())
    }

    /// Re-point the selection at a NEW image handle that holds the SAME
    /// extent, KEEPING the coverage — the door a destructive in-place
    /// edit (the generator FILL) uses so the selection survives its own
    /// result. Answers `true` when the coverage carried over, `false`
    /// when the extent changed (then it behaves exactly like
    /// `selection_bind`: the selection drops).
    #[wasm_bindgen]
    pub fn selection_transfer(handle: u32) -> Result<bool, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let kept = SELECTION.with(|s| s.borrow_mut().transfer(handle, img.width, img.height));
        note_selection(None, None);
        Ok(kept)
    }

    /// Marquee RECT: fold the anti-aliased rectangle `[x, x+w) × [y, y+h)`
    /// (image px; fractional coords carry the AA edge) into the selection
    /// under `mode`.
    #[wasm_bindgen]
    pub fn selection_set_rect(x: f32, y: f32, w: f32, h: f32, mode: u32) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        with_selection(|s| {
            let b = s.bound().ok_or("no image bound (selection_bind first)")?;
            let shape = SelectionCoverage::rasterize_rect(b.width, b.height, x, y, w, h);
            s.apply_shape(shape, mode)
        })?;
        note_selection(Some("Rectangular Marquee"), None);
        Ok(())
    }

    /// Marquee ELLIPSE: center `(cx, cy)`, radii `(rx, ry)` (image px),
    /// anti-aliased (4×4 supersampled edge), folded under `mode`.
    #[wasm_bindgen]
    pub fn selection_set_ellipse(
        cx: f32,
        cy: f32,
        rx: f32,
        ry: f32,
        mode: u32,
    ) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        with_selection(|s| {
            let b = s.bound().ok_or("no image bound (selection_bind first)")?;
            let shape = SelectionCoverage::rasterize_ellipse(b.width, b.height, cx, cy, rx, ry);
            s.apply_shape(shape, mode)
        })?;
        note_selection(Some("Elliptical Marquee"), None);
        Ok(())
    }

    /// LASSO polygon: `points_flat` is `[x0, y0, x1, y1, …]` image-px
    /// vertices of a closed polygon (the closing edge is implicit),
    /// scanline-rasterized with AA coverage, folded under `mode`. Fewer
    /// than 3 vertices is a clean error (nothing to select).
    #[wasm_bindgen]
    pub fn selection_set_polygon(points_flat: &[f32], mode: u32) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        if points_flat.len() < 6 || !points_flat.len().is_multiple_of(2) {
            return Err(JsValue::from_str(
                "polygon needs ≥ 3 (x, y) vertex pairs (flat, even length)",
            ));
        }
        let pts: Vec<(f32, f32)> = points_flat.chunks_exact(2).map(|c| (c[0], c[1])).collect();
        with_selection(|s| {
            let b = s.bound().ok_or("no image bound (selection_bind first)")?;
            let shape = SelectionCoverage::rasterize_polygon(b.width, b.height, &pts);
            s.apply_shape(shape, mode)
        })?;
        note_selection(Some("Lasso"), None);
        Ok(())
    }

    /// MAGIC WAND at `(x, y)`: color-distance flood over the BOUND
    /// image's straight-RGBA8 pixels — `contiguous` = 4-connected BFS
    /// from the seed; otherwise a global threshold. `tolerance` is the
    /// per-channel (Chebyshev) distance 0–255. Binary coverage (hard
    /// edges; `selection_feather` softens), folded under `mode`.
    #[wasm_bindgen]
    pub fn selection_magic_wand(
        x: u32,
        y: u32,
        tolerance: u8,
        contiguous: bool,
        mode: u32,
    ) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        let bound = SELECTION
            .with(|s| s.borrow().bound())
            .ok_or_else(|| JsValue::from_str("no image bound (selection_bind first)"))?;
        let img = IMAGES
            .with(|m| m.borrow().get(&bound.handle).cloned())
            .ok_or_else(|| {
                JsValue::from_str(&format!("bound image handle {} is gone", bound.handle))
            })?;
        if x >= img.width || y >= img.height {
            return Err(JsValue::from_str(&format!(
                "wand seed ({x},{y}) outside {}x{}",
                img.width, img.height
            )));
        }
        let shape = SelectionCoverage::magic_wand(
            img.width,
            img.height,
            &img.rgba.to_rgba8(),
            x,
            y,
            tolerance,
            contiguous,
        );
        selection_step("Magic Wand", |s| s.apply_shape(shape, mode))
    }

    /// Feather the selection: a Gaussian of `sigma` px on the COVERAGE
    /// (mask prep — CPU on the u8 mask by design, not image processing;
    /// the softened mask is still consumed GPU-side). Errors when no
    /// explicit selection exists.
    #[wasm_bindgen]
    pub fn selection_feather(sigma: f32) -> Result<(), JsValue> {
        selection_step("Feather", |s| s.feather(sigma))
    }

    /// Select ▸ Modify: `op` ∈ expand | contract | border | smooth, by
    /// `radius` px. Errors when there is no explicit selection.
    #[wasm_bindgen]
    pub fn selection_modify(op: &str, radius: f32) -> Result<(), JsValue> {
        let op = crate::selection::ModifyOp::from_wire(op).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown selection modification \"{op}\" (expand | contract | border | smooth)"
            ))
        })?;
        let label = match op {
            crate::selection::ModifyOp::Expand => "Expand",
            crate::selection::ModifyOp::Contract => "Contract",
            crate::selection::ModifyOp::Border => "Border",
            crate::selection::ModifyOp::Smooth => "Smooth",
        };
        selection_step(label, |s| s.modify(op, radius))
    }

    /// SELECTION → PATH: trace the live selection's coverage into closed
    /// polygons, as `[{outer, points: [[x, y], …]}]` in IMAGE pixel
    /// coordinates on pixel EDGES.
    ///
    /// `threshold` (0–255) is the cut at which partial coverage counts as
    /// selected, and it is a PARAMETER because it is a decision: a
    /// feathered or luminosity selection has no single right answer, and
    /// picking one silently would discard the anti-aliased boundary the
    /// selection tools produced. `tolerance` (image px) collapses
    /// near-collinear runs; `0` keeps every staircase step.
    ///
    /// An EMPTY array means "nothing selected" — a caller that wants to
    /// distinguish that from "no selection at all" reads
    /// `selection_stats`.
    #[wasm_bindgen]
    pub fn selection_to_paths(threshold: u8, tolerance: f32) -> Result<String, JsValue> {
        SELECTION.with(|s| {
            let sel = s.borrow();
            let bound = sel
                .bound()
                .ok_or_else(|| JsValue::from_str("no image bound (selection_bind first)"))?;
            let Some(cov) = sel.coverage() else {
                return Ok("[]".to_string());
            };
            Ok(crate::paths::trace_json(
                cov.data(),
                bound.width as usize,
                bound.height as usize,
                threshold,
                tolerance,
            ))
        })
    }

    /// The histogram AND the channels readout in one pass (see
    /// `channels::readout`): `{"histogram":[r…,g…,b…,luma…],"channels":[…]}`.
    /// What the panel refreshes after every recomposite; the two exports
    /// below stay for callers that want one of them.
    #[wasm_bindgen]
    pub fn image_readout(handle: u32) -> Result<String, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let (hist, channels) = crate::channels::readout(&img.rgba.to_rgba8());
        let flat: Vec<String> = hist.to_flat().iter().map(u32::to_string).collect();
        Ok(format!(
            "{{\"histogram\":[{}],\"channels\":{channels}}}",
            flat.join(",")
        ))
    }

    /// The CHANNELS readout for an engine-held image: `[{name, min, max,
    /// mean}]` for red/green/blue/alpha and the derived Rec.709 luma.
    /// Pure CPU reduction over the same straight-RGBA8 buffer
    /// `image_histogram` reads, so the two agree by construction.
    #[wasm_bindgen]
    pub fn image_channel_stats(handle: u32) -> Result<String, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        Ok(crate::channels::stats_json(&img.rgba.to_rgba8()))
    }

    /// LOAD A CHANNEL AS THE SELECTION — the operation a channels list
    /// exists to enable (luminosity masks, a PSD's alpha as a selection).
    ///
    /// The channel's bytes ARE the coverage representation, so this is a
    /// COPY and not a threshold: a 50%-grey channel yields a 50%-selected
    /// region, which is exactly what a luminosity mask means and what the
    /// masked kernel pipeline already honours at `@group(2)`.
    ///
    /// `channel` is one of `red`/`green`/`blue`/`alpha`/`luma`; an
    /// unknown name is an ERROR rather than a fallback, because masking
    /// on the wrong channel is a silent wrong answer.
    #[wasm_bindgen]
    pub fn selection_from_channel(handle: u32, channel: &str, mode: u32) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        let ch = crate::channels::Channel::from_name(channel)
            .ok_or_else(|| JsValue::from_str(&format!("unknown channel {channel:?}")))?;
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let bytes = crate::channels::channel_bytes(&img.rgba.to_rgba8(), ch);
        selection_step("Load Selection", |s| {
            let b = s.bound().ok_or("no image bound (selection_bind first)")?;
            let shape =
                SelectionCoverage::from_data(b.width, b.height, bytes).ok_or_else(|| {
                    format!(
                        "channel is {}×{} but the bound image is {}×{}",
                        img.width, img.height, b.width, b.height
                    )
                })?;
            s.apply_shape(shape, mode)
        })
    }

    /// SET THE SELECTION FROM COVERAGE BYTES (`width·height` of the bound
    /// image, row-major, 0 … 255), folded under `mode` (0 replace makes it
    /// exactly these bytes). The glue gives back a selection it kept as
    /// data — the one a frame had when its image closed — when that image
    /// opens again. A length other than the bound image's pixel count is
    /// an error, not a resample: where a selection lies on another size
    /// is the caller's decision.
    #[wasm_bindgen]
    pub fn selection_set_coverage(bytes: &[u8], mode: u32) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        with_selection(|s| s.apply_coverage(bytes, mode))?;
        // A selection given back (a frame's kept selection) is not a
        // step: the stack's mirror only follows it.
        note_selection(None, None);
        Ok(())
    }

    /// Select ALL explicitly (a full-extent selection in the readouts;
    /// the adjust chain still takes the trivial-mask fast path).
    #[wasm_bindgen]
    pub fn selection_select_all() -> Result<(), JsValue> {
        selection_step("Select All", |s| s.select_all())
    }

    /// Deselect: back to "no selection" (adjustments run unmasked).
    #[wasm_bindgen]
    pub fn selection_clear() {
        let had = SELECTION.with(|s| {
            let mut s = s.borrow_mut();
            let had = s.coverage().is_some();
            s.clear();
            had
        });
        if had {
            note_selection(Some("Deselect"), None);
        }
    }

    /// Invert the selection ("everything" inverts to the explicit EMPTY
    /// selection — adjust applies nowhere until reselected).
    #[wasm_bindgen]
    pub fn selection_invert() -> Result<(), JsValue> {
        selection_step("Inverse", |s| s.invert())
    }

    /// The bounding box of the selection's non-zero coverage as
    /// `[x, y, w, h]`; an EMPTY array when there is no explicit selection
    /// OR the selection is empty (distinguish via `selection_stats`).
    #[wasm_bindgen]
    pub fn selection_bounds() -> Vec<u32> {
        SELECTION.with(|s| match s.borrow().coverage().and_then(|c| c.bounds()) {
            Some(r) => vec![r.x as u32, r.y as u32, r.w, r.h],
            None => Vec::new(),
        })
    }

    /// Selection readout for the panel/tools, as 7 `f32`s:
    /// `[has_selection (0|1), x, y, w, h, coverage_fraction, revision]`.
    /// `has_selection == 0` ⇒ no explicit selection (everything, the
    /// unmasked default) and the box/fraction are 0. An explicit-but-
    /// empty selection reads `has == 1, w == h == 0, fraction == 0`.
    #[wasm_bindgen]
    pub fn selection_stats() -> Vec<f32> {
        SELECTION.with(|s| {
            let sel = s.borrow();
            let rev = sel.revision() as f32;
            match sel.coverage() {
                None => vec![0.0, 0.0, 0.0, 0.0, 0.0, 0.0, rev],
                Some(c) => {
                    let (x, y, w, h) = match c.bounds() {
                        Some(r) => (r.x as f32, r.y as f32, r.w as f32, r.h as f32),
                        None => (0.0, 0.0, 0.0, 0.0),
                    };
                    vec![1.0, x, y, w, h, c.selected_fraction() as f32, rev]
                }
            }
        })
    }

    /// The raw u8 coverage bytes (`width·height`, row-major) — the
    /// overlay/debug readout. Empty when no explicit selection exists.
    #[wasm_bindgen]
    pub fn selection_coverage_bytes() -> js_sys::Uint8Array {
        SELECTION.with(|s| match s.borrow().coverage() {
            Some(c) => js_sys::Uint8Array::from(c.data()),
            None => js_sys::Uint8Array::new_with_length(0),
        })
    }

    // ───────────── SELECTION & MASKING doors (ADR 470, WP5.5) ─────────────
    //
    // Every selection change made by a person is ONE undo step on the
    // layer stack's list (`note_selection(Some(label))`); a change that is
    // not a step (a kept selection restored, a rebind) only syncs the
    // stack's mirror (`note_selection(None)`), so the mirror always equals
    // the session selection. Undo and redo copy a restored selection back
    // (`history_step`).

    /// After a selection mutation: record it as a step (`label`) or sync
    /// the stack's mirror — only when the stack is bound to the image the
    /// selection is bound to.
    fn note_selection(label: Option<&str>, merge: Option<&str>) {
        let (handle, cov) = SELECTION.with(|s| {
            let s = s.borrow();
            (s.bound().map(|b| b.handle), s.coverage().cloned())
        });
        LAYERS.with(|l| {
            if let Some(d) = l.borrow_mut().as_mut() {
                if Some(d.handle) == handle {
                    match label {
                        Some(lb) => d.stack.record_selection(lb, merge, cov),
                        None => d.stack.sync_selection(cov),
                    }
                }
            }
        });
    }

    /// A selection mutation recorded as one undo step.
    fn selection_step<T>(
        label: &str,
        f: impl FnOnce(&mut SessionSelection) -> Result<T, String>,
    ) -> Result<T, JsValue> {
        let out = with_selection(f)?;
        note_selection(Some(label), None);
        Ok(out)
    }

    /// The bound image's straight RGBA8 pixels and extent.
    fn bound_pixels() -> Result<(u32, u32, Vec<u8>), JsValue> {
        let bound = SELECTION
            .with(|s| s.borrow().bound())
            .ok_or_else(|| JsValue::from_str("no image bound (selection_bind first)"))?;
        IMAGES.with(|m| {
            let m = m.borrow();
            let img = m.get(&bound.handle).ok_or_else(|| {
                JsValue::from_str(&format!("bound image handle {} is gone", bound.handle))
            })?;
            Ok((img.width, img.height, img.rgba.to_rgba8().into_owned()))
        })
    }

    fn coverage_of(w: u32, h: u32, data: Vec<u8>) -> Result<SelectionCoverage, JsValue> {
        SelectionCoverage::from_data(w, h, data)
            .ok_or_else(|| JsValue::from_str("internal: coverage is mis-sized"))
    }

    /// The Color Range param block from the dialog's flat values:
    /// `kind` 0 sampled | 1 hue | 2 tonal | 3 skin; `samples` = per
    /// sample `L, a, b, x, y`; `range` > 0 with `localized`; `hue` the
    /// preset's centre; `lower`/`upper` the tonal limits on 0…255 and
    /// `midtones` their two-sided width.
    #[allow(clippy::too_many_arguments)]
    fn color_range_params(
        kind: u32,
        fuzziness: f32,
        invert: bool,
        samples: &[f32],
        localized: bool,
        range: f32,
        hue: f32,
        lower: f32,
        upper: f32,
        midtones: bool,
    ) -> Result<image_kernels::families::select::ColorRangeParams, JsValue> {
        use image_kernels::families::select::{ColorRangeMode, ColorRangeParams};
        let mode = ColorRangeMode::from_u32(kind).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown Color Range kind {kind} (0 sampled | 1 hue | 2 tonal | 3 skin)"
            ))
        })?;
        Ok(match mode {
            ColorRangeMode::Sampled => {
                if !samples.len().is_multiple_of(5) {
                    return Err(JsValue::from_str("samples are L, a, b, x, y each"));
                }
                let s: Vec<([f32; 3], [f32; 2])> = samples
                    .as_chunks::<5>()
                    .0
                    .iter()
                    .map(|c| ([c[0], c[1], c[2]], [c[3], c[4]]))
                    .collect();
                ColorRangeParams::sampled(&s, fuzziness, invert, localized.then_some(range))
            }
            ColorRangeMode::Hue => ColorRangeParams::hue(hue, invert),
            ColorRangeMode::Tonal => {
                ColorRangeParams::tonal(lower, upper, fuzziness, midtones, invert)
            }
            ColorRangeMode::Skin => ColorRangeParams::skin(fuzziness, invert),
        })
    }

    /// Color Range's coverage over straight RGBA8: the `select.color_range`
    /// kernel on the GPU, its CPU twin where there is no device or the
    /// image exceeds the texture limit (ADR 470).
    async fn color_range_coverage(
        rgba: &[u8],
        w: u32,
        h: u32,
        p: &image_kernels::families::select::ColorRangeParams,
    ) -> Vec<u8> {
        use image_kernels::families::select::{color_range_rgba8, SELECT_COLOR_RANGE};
        if let Some(ctx) = GPU.with(|g| g.borrow().clone()) {
            let one = half::f16::ONE.to_le_bytes();
            let mut f16 = Vec::with_capacity(rgba.len() * 2);
            for px in rgba.as_chunks::<4>().0 {
                for &c in &px[..3] {
                    f16.extend_from_slice(&half::f16::from_f32(f32::from(c) / 255.0).to_le_bytes());
                }
                f16.extend_from_slice(&one);
            }
            if let Ok(out) = image_gpu::execute_tile_once_async(
                &ctx,
                &SELECT_COLOR_RANGE,
                &[image_gpu::TileInput { f16_bytes: &f16 }],
                p.as_bytes(),
                None,
                w,
                h,
            )
            .await
            {
                return out
                    .as_chunks::<8>()
                    .0
                    .iter()
                    .map(|t| {
                        let m = half::f16::from_le_bytes([t[0], t[1]]).to_f32();
                        (m.clamp(0.0, 1.0) * 255.0).round() as u8
                    })
                    .collect();
            }
        }
        color_range_rgba8(rgba, w, p)
    }

    /// The Lab (D50) of the bound image's pixel at `(x, y)` — what a
    /// Color Range eyedropper click samples.
    #[wasm_bindgen]
    pub fn color_range_sample(x: u32, y: u32) -> Result<Vec<f32>, JsValue> {
        let (w, h, px) = bound_pixels()?;
        if x >= w || y >= h {
            return Err(JsValue::from_str(&format!("({x}, {y}) is outside {w}×{h}")));
        }
        let i = ((y * w + x) * 4) as usize;
        let lab = image_kernels::families::select::to_lab([
            f32::from(px[i]) / 255.0,
            f32::from(px[i + 1]) / 255.0,
            f32::from(px[i + 2]) / 255.0,
        ]);
        Ok(lab.to_vec())
    }

    /// Color Range's coverage WITHOUT applying it — the dialog preview.
    /// It also becomes the coverage of the `matte` view.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn color_range_preview(
        kind: u32,
        fuzziness: f32,
        invert: bool,
        samples: Vec<f32>,
        localized: bool,
        range: f32,
        hue: f32,
        lower: f32,
        upper: f32,
        midtones: bool,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let p = color_range_params(
            kind, fuzziness, invert, &samples, localized, range, hue, lower, upper, midtones,
        )?;
        let (w, h, px) = bound_pixels()?;
        let cov = color_range_coverage(&px, w, h, &p).await;
        let out = js_sys::Uint8Array::from(&cov[..]);
        let cov = Arc::new(coverage_of(w, h, cov)?);
        VIEW.with(|v| v.borrow_mut().matte = Some(cov));
        Ok(out)
    }

    /// Select ▸ Color Range: fold the coverage into the selection under
    /// `mode`; one undo step.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn selection_color_range(
        kind: u32,
        fuzziness: f32,
        invert: bool,
        samples: Vec<f32>,
        localized: bool,
        range: f32,
        hue: f32,
        lower: f32,
        upper: f32,
        midtones: bool,
        mode: u32,
    ) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        let p = color_range_params(
            kind, fuzziness, invert, &samples, localized, range, hue, lower, upper, midtones,
        )?;
        let (w, h, px) = bound_pixels()?;
        let cov = coverage_of(w, h, color_range_coverage(&px, w, h, &p).await)?;
        selection_step("Color Range", |s| s.apply_shape(cov, mode))
    }

    /// Select ▸ Grow (`contiguous`) / Similar, by the wand's tolerance.
    #[wasm_bindgen]
    pub fn selection_grow(tolerance: u8, contiguous: bool) -> Result<(), JsValue> {
        let (_, _, px) = bound_pixels()?;
        let label = if contiguous { "Grow" } else { "Similar" };
        selection_step(label, |s| {
            let cov = s.coverage().ok_or("no selection to grow from")?;
            let grown = crate::selection::grow_coverage(cov, &px, tolerance, contiguous)
                .ok_or("nothing is selected — there is no colour range to grow from")?;
            s.apply_shape(grown, CombineMode::Replace)
        })
    }

    /// Select ▸ Focus Area: the in-focus regions (sharpness map, ADR 470),
    /// folded under `mode`; one undo step.
    #[wasm_bindgen]
    pub fn selection_focus_area(range: f32, noise: f32, mode: u32) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        let (w, h, px) = bound_pixels()?;
        let cov = crate::focus::focus_area(&px, w, h, crate::focus::FocusParams { range, noise });
        selection_step("Focus Area", |s| s.apply_shape(cov, mode))
    }

    /// Focus Area's coverage without applying it (the dialog preview; it
    /// becomes the `matte` view's coverage).
    #[wasm_bindgen]
    pub fn focus_area_preview(range: f32, noise: f32) -> Result<js_sys::Uint8Array, JsValue> {
        let (w, h, px) = bound_pixels()?;
        let cov = crate::focus::focus_area(&px, w, h, crate::focus::FocusParams { range, noise });
        let out = js_sys::Uint8Array::from(cov.data());
        VIEW.with(|v| v.borrow_mut().matte = Some(Arc::new(cov)));
        Ok(out)
    }

    // ── the display view ────────────────────────────────────────────

    struct ViewState {
        view: crate::masking::View,
        /// The coverage a `Matte` view shows (Color Range / Focus Area
        /// previews, Select and Mask).
        matte: Option<Arc<SelectionCoverage>>,
        /// Show the spot channels over the composite (the Channels
        /// panel's eye on a spot channel).
        spots: bool,
    }

    thread_local! {
        static VIEW: RefCell<ViewState> = const {
            RefCell::new(ViewState {
                view: crate::masking::View::Composite,
                matte: None,
                spots: false,
            })
        };
    }

    /// What the frame shows: `composite` | `component` (arg: red, green,
    /// blue, alpha, luma) | `channel` (arg: a channel id) | `quickMask` |
    /// `matte` (arg: overlay, onBlack, onWhite, blackWhite, onLayers;
    /// `opacity` for the overlay); `spots` shows spot channels over the
    /// composite. A display transform only — the document is untouched.
    #[wasm_bindgen]
    pub fn view_set(kind: &str, arg: &str, opacity: f32, spots: bool) -> Result<(), JsValue> {
        use crate::masking::{MatteMode, View};
        let view = match kind {
            "composite" => View::Composite,
            "component" => View::Component(
                crate::channels::Channel::from_name(arg)
                    .ok_or_else(|| JsValue::from_str(&format!("unknown channel {arg:?}")))?,
            ),
            "channel" => View::Channel(
                arg.parse()
                    .map_err(|_| JsValue::from_str(&format!("not a channel id: {arg:?}")))?,
            ),
            "quickMask" => View::QuickMask,
            "matte" => View::Matte(
                MatteMode::from_wire(arg, opacity)
                    .ok_or_else(|| JsValue::from_str(&format!("unknown matte {arg:?}")))?,
            ),
            k => return Err(JsValue::from_str(&format!("unknown view {k:?}"))),
        };
        VIEW.with(|v| {
            let mut v = v.borrow_mut();
            v.view = view;
            v.spots = spots;
        });
        Ok(())
    }

    /// Does the display differ from the composite (so the glue must pass
    /// it through `view_apply`)?
    #[wasm_bindgen]
    pub fn view_active() -> bool {
        let has_spots = LAYERS.with(|l| {
            l.borrow().as_ref().is_some_and(|d| {
                d.stack
                    .masking()
                    .channels
                    .iter()
                    .any(|c| matches!(c.kind, crate::masking::ChannelKind::Spot { .. }))
            })
        });
        let proofing = PROOF.with(|p| p.borrow().is_some());
        VIEW.with(|v| {
            let v = v.borrow();
            v.view != crate::masking::View::Composite || (v.spots && has_spots) || proofing
        })
    }

    /// Transform a `w`×`h` composite (straight RGBA8, possibly a preview
    /// proxy) into what the current view shows.
    #[wasm_bindgen]
    pub fn view_apply(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, JsValue> {
        use crate::masking::{matte, MatteMode, View, QUICK_MASK_OPACITY};
        if rgba.len() != (w as usize) * (h as usize) * 4 {
            return Err(JsValue::from_str("view_apply: rgba is not w·h·4 bytes"));
        }
        let (view, matte_cov, spots) = VIEW.with(|v| {
            let v = v.borrow();
            (v.view.clone(), v.matte.clone(), v.spots)
        });
        LAYERS.with(|l| {
            let b = l.borrow();
            let doc = b.as_ref().map(|d| &d.stack);
            let channel_data = |id: u32| -> Option<crate::masking::DocChannel> {
                let st = doc?;
                let mut ch = st.masking().channel(id)?.clone();
                if st.edit_channel().map(|c| c.id) == Some(id) {
                    if let Some(p) = st.channel_preview() {
                        ch.data = Arc::clone(p);
                    }
                }
                Some(ch)
            };
            let base = match (&view, doc) {
                (View::Composite, Some(st)) if spots => {
                    let s: Vec<&crate::masking::DocChannel> = st
                        .masking()
                        .channels
                        .iter()
                        .filter(|c| matches!(c.kind, crate::masking::ChannelKind::Spot { .. }))
                        .collect();
                    crate::masking::with_spots(rgba, w, h, &s)
                }
                (View::Composite, _) => rgba.to_vec(),
                (View::Component(c), _) => crate::channels::channel_bytes(rgba, *c)
                    .iter()
                    .flat_map(|&v| [v, v, v, 255])
                    .collect(),
                (View::Channel(id), _) => match channel_data(*id) {
                    Some(ch) => crate::masking::channel_view(w, h, &ch),
                    None => rgba.to_vec(),
                },
                (View::QuickMask, Some(st)) => match st.quick_mask().and_then(channel_data) {
                    Some(ch) => matte(rgba, w, h, &ch.data, MatteMode::Overlay(QUICK_MASK_OPACITY)),
                    None => rgba.to_vec(),
                },
                (View::QuickMask, None) => rgba.to_vec(),
                (View::Matte(m), _) => match &matte_cov {
                    Some(c) => matte(rgba, w, h, c, *m),
                    None => rgba.to_vec(),
                },
            };
            // Proof Colors / Gamut Warning (ADR 479): over the composite
            // view only — a channel shown as grey has no colours to proof.
            let base = if view == View::Composite {
                PROOF.with(|p| match p.borrow().as_ref() {
                    Some(proof) => proof.apply_rgba8(&base),
                    None => base,
                })
            } else {
                base
            };
            Ok(base)
        })
    }

    thread_local! {
        static PROOF: RefCell<Option<crate::color_mode::Proof>> = const { RefCell::new(None) };
    }

    /// VIEW ▸ PROOF COLORS and GAMUT WARNING on the image preview:
    /// `target` is `off`, `gray` (Gray Gamma 2.2) or `cmyk` (through
    /// `cmyk_profile`; empty: the document's own CMYK profile, refused
    /// when it has none). `colors` simulates the output, `gamut` paints
    /// the colours it cannot reproduce grey. A display transform, applied
    /// by `view_apply` — the document is untouched.
    #[wasm_bindgen]
    pub fn view_set_proof(
        target: &str,
        colors: bool,
        gamut: bool,
        cmyk_profile: &[u8],
    ) -> Result<(), JsValue> {
        if target == "off" || (!colors && !gamut) {
            PROOF.with(|p| *p.borrow_mut() = None);
            return Ok(());
        }
        let mode = crate::color_mode::ColorMode::from_name(target)
            .ok_or_else(|| JsValue::from_str(&format!("unknown proof target {target:?}")))?;
        let own = LAYERS.with(|l| {
            l.borrow()
                .as_ref()
                .and_then(|d| d.stack.mode().cmyk_profile.clone())
        });
        let profile: Option<&[u8]> = if cmyk_profile.is_empty() {
            own.as_deref()
        } else {
            Some(cmyk_profile)
        };
        let proof =
            crate::color_mode::Proof::new(mode, profile, colors, gamut).map_err(ingest_err)?;
        PROOF.with(|p| *p.borrow_mut() = Some(proof));
        Ok(())
    }

    /// The bound document's colour mode: `rgb`, `gray`, `cmyk` or `lab`
    /// (`rgb` with no stack open).
    #[wasm_bindgen]
    pub fn image_mode() -> String {
        LAYERS.with(|l| {
            l.borrow()
                .as_ref()
                .map_or("rgb", |d| d.stack.mode().mode.name())
                .to_string()
        })
    }

    /// IMAGE ▸ MODE ▸ Grayscale / RGB Color / CMYK Color / Lab Color over
    /// the bound stack (`LayerStack::set_mode`, one undo step), the
    /// composite landing in `handle`. `cmyk_profile` is the press a CMYK
    /// document converts through (empty: none, the plain ink formula,
    /// which changes no colour). Answers whether anything changed.
    #[wasm_bindgen]
    pub async fn image_set_mode(
        handle: u32,
        mode: &str,
        cmyk_profile: Vec<u8>,
    ) -> Result<bool, JsValue> {
        let mode = crate::color_mode::ColorMode::from_name(mode)
            .ok_or_else(|| JsValue::from_str(&format!("unknown colour mode {mode:?}")))?;
        if LAYERS.with(|l| l.borrow().as_ref().map(|d| d.handle)) != Some(handle) {
            return Err(JsValue::from_str(
                "no layer stack open on this image (layers_open first)",
            ));
        }
        let doc_mode = crate::color_mode::DocMode {
            mode,
            cmyk_profile: (mode == crate::color_mode::ColorMode::Cmyk && !cmyk_profile.is_empty())
                .then(|| Arc::from(cmyk_profile.into_boxed_slice())),
        };
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|mut doc| async move {
            let result = async {
                if !doc.stack.set_mode(doc_mode).map_err(ingest_err)? {
                    return Ok(false);
                }
                let rgba = doc
                    .stack
                    .composite_px(ctx.as_deref(), None)
                    .await
                    .map_err(ingest_err)?;
                set_image_pixels(doc.handle, rgba)?;
                Ok(true)
            }
            .await;
            (doc, result)
        })
        .await
    }

    // ── Quick Mask ──────────────────────────────────────────────────

    /// Enter Quick Mask: the selection becomes a temporary channel the
    /// brushes paint, shown as a red overlay. One undo step.
    #[wasm_bindgen]
    pub fn quick_mask_enter() -> Result<u32, JsValue> {
        let cov = SELECTION.with(|s| s.borrow().coverage().cloned());
        let id = with_stack(|d| {
            d.stack.sync_selection(cov.clone());
            d.stack.enter_quick_mask(cov.as_deref()).map_err(ingest_err)
        })?;
        VIEW.with(|v| v.borrow_mut().view = crate::masking::View::QuickMask);
        Ok(id)
    }

    /// Leave Quick Mask: the painted channel becomes the selection. One
    /// undo step (it brings the channel and the old selection back).
    #[wasm_bindgen]
    pub fn quick_mask_exit() -> Result<(), JsValue> {
        let sel = with_stack(|d| d.stack.exit_quick_mask().map_err(ingest_err))?;
        SELECTION.with(|s| s.borrow_mut().restore(Some(sel)));
        VIEW.with(|v| {
            let mut v = v.borrow_mut();
            if v.view == crate::masking::View::QuickMask {
                v.view = crate::masking::View::Composite;
            }
        });
        Ok(())
    }

    /// Is Quick Mask on?
    #[wasm_bindgen]
    pub fn quick_mask_active() -> bool {
        LAYERS.with(|l| {
            l.borrow()
                .as_ref()
                .is_some_and(|d| d.stack.quick_mask().is_some())
        })
    }

    // ── channels ────────────────────────────────────────────────────

    /// The Channels / Paths panels' readout (`MaskingDoc::list_json`, plus
    /// the channel being painted as `editChannel`).
    #[wasm_bindgen]
    pub fn masking_list() -> String {
        LAYERS.with(|l| match l.borrow().as_ref() {
            Some(d) => {
                let j = d.stack.masking().list_json();
                let edit = d
                    .stack
                    .edit_channel()
                    .map_or_else(|| "null".to_string(), |c| c.id.to_string());
                format!("{},\"editChannel\":{edit}}}", &j[..j.len() - 1])
            }
            None => {
                "{\"channels\":[],\"paths\":[],\"quickMask\":null,\"editChannel\":null}".to_string()
            }
        })
    }

    /// Select ▸ Save Selection: a new alpha channel (everything without a
    /// selection). One undo step; answers its id.
    #[wasm_bindgen]
    pub fn channel_save_selection(name: &str) -> Result<u32, JsValue> {
        let cov = SELECTION.with(|s| s.borrow().coverage().cloned());
        with_stack(|d| {
            d.stack
                .save_selection(name, cov.as_deref())
                .map_err(ingest_err)
        })
    }

    /// Select ▸ Load Selection: a channel folded into the selection under
    /// `mode` (replace, add, subtract, intersect). One undo step.
    #[wasm_bindgen]
    pub fn channel_load_selection(id: u32, invert: bool, mode: u32) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        let data = with_stack(|d| {
            d.stack
                .masking()
                .channel(id)
                .map(|c| Arc::clone(&c.data))
                .ok_or_else(|| JsValue::from_str(&format!("no channel {id}")))
        })?;
        let mut shape = (*data).clone();
        if invert {
            shape.invert();
        }
        selection_step("Load Selection", |s| s.apply_shape(shape, mode))
    }

    /// Delete / rename / duplicate a channel; one undo step each.
    #[wasm_bindgen]
    pub fn channel_delete(id: u32) -> Result<(), JsValue> {
        with_stack(|d| {
            if d.stack.quick_mask() == Some(id) {
                return Err(JsValue::from_str(
                    "Quick Mask's channel goes away by leaving Quick Mask",
                ));
            }
            if d.stack.edit_channel().map(|c| c.id) == Some(id) {
                d.stack.set_edit_channel(None).map_err(ingest_err)?;
            }
            d.stack
                .masking_edit("Delete channel", |m, _, _| m.remove_channel(id))
                .map_err(ingest_err)
        })
    }

    #[wasm_bindgen]
    pub fn channel_rename(id: u32, name: &str) -> Result<(), JsValue> {
        with_stack(|d| {
            d.stack
                .masking_edit("Rename channel", |m, _, _| m.rename_channel(id, name))
                .map_err(ingest_err)
        })
    }

    #[wasm_bindgen]
    pub fn channel_duplicate(id: u32) -> Result<u32, JsValue> {
        with_stack(|d| {
            d.stack
                .masking_edit("Duplicate channel", |m, _, _| m.duplicate_channel(id))
                .map_err(ingest_err)
        })
    }

    /// New Spot Channel: the selection (nothing without one) as the
    /// coverage of an ink of `r, g, b` at `solidity` (0…1). One step.
    #[wasm_bindgen]
    pub fn channel_new_spot(
        name: &str,
        r: u8,
        g: u8,
        b: u8,
        solidity: f32,
    ) -> Result<u32, JsValue> {
        let cov = SELECTION.with(|s| s.borrow().coverage().cloned());
        with_stack(|d| {
            let (w, h) = (d.stack.width(), d.stack.height());
            let data = match cov {
                Some(c) if c.width() == w && c.height() == h => (*c).clone(),
                _ => SelectionCoverage::empty(w, h),
            };
            d.stack
                .masking_edit("New spot channel", |m, _, _| {
                    Ok(m.add_channel(
                        name,
                        crate::masking::ChannelKind::Spot {
                            colour: [r, g, b],
                            solidity: solidity.clamp(0.0, 1.0),
                        },
                        data,
                    ))
                })
                .map_err(ingest_err)
        })
    }

    /// Change a channel's spot ink (an alpha channel becomes a spot one).
    #[wasm_bindgen]
    pub fn channel_set_spot(id: u32, r: u8, g: u8, b: u8, solidity: f32) -> Result<(), JsValue> {
        with_stack(|d| {
            d.stack
                .masking_edit("Channel options", |m, _, _| {
                    m.set_spot(id, [r, g, b], solidity)
                })
                .map_err(ingest_err)
        })
    }

    /// Paint channel `id` with the pixel tools (`-1`: back to the layers).
    #[wasm_bindgen]
    pub fn channel_set_edit(id: i32) -> Result<(), JsValue> {
        with_stack(|d| {
            d.stack
                .set_edit_channel(u32::try_from(id).ok())
                .map_err(ingest_err)
        })
    }

    /// The channel stroke in flight was cancelled: drop its preview.
    #[wasm_bindgen]
    pub fn channel_clear_preview() {
        LAYERS.with(|l| {
            if let Some(d) = l.borrow_mut().as_mut() {
                d.stack.clear_channel_preview();
            }
        });
    }

    // ── paths ───────────────────────────────────────────────────────

    /// Make Work Path: trace the selection (at `threshold`, simplified by
    /// `tolerance` px) into the work path (`name` empty) or a saved path
    /// named `name`. One undo step; answers the path id.
    #[wasm_bindgen]
    pub fn path_from_selection(name: &str, threshold: u8, tolerance: f32) -> Result<u32, JsValue> {
        let (cov, bound) = SELECTION.with(|s| {
            let s = s.borrow();
            (s.coverage().cloned(), s.bound())
        });
        let cov = cov.ok_or_else(|| JsValue::from_str("no selection to make a path from"))?;
        let b = bound.ok_or_else(|| JsValue::from_str("no image bound"))?;
        let contours = crate::paths::trace(
            cov.data(),
            b.width as usize,
            b.height as usize,
            threshold,
            tolerance,
        );
        if contours.is_empty() {
            return Err(JsValue::from_str(&format!(
                "nothing is selected at coverage ≥ {threshold}"
            )));
        }
        let subpaths = crate::masking::subpaths_from_contours(&contours);
        // Without a name it is Photoshop's Make Work Path: the WORK PATH,
        // made or replaced (ADR 476); with one, a saved path.
        with_stack(|d| {
            if name.trim().is_empty() {
                d.stack.set_work_path(subpaths).map_err(ingest_err)
            } else {
                d.stack.add_path(name, subpaths).map_err(ingest_err)
            }
        })
    }

    /// Store a path drawn elsewhere (a host shape's anchors): `closed`
    /// per subpath, `lens` anchors per subpath, `anchors` 6 floats each
    /// (point, in handle, out handle; image px). One step; answers its id.
    #[wasm_bindgen]
    pub fn path_add(
        name: &str,
        closed: Vec<u8>,
        lens: Vec<u32>,
        anchors: Vec<f32>,
    ) -> Result<u32, JsValue> {
        let mut at = 0usize;
        let mut flat = Vec::new();
        for &n in &lens {
            let end = at + n as usize * 6;
            let part = anchors
                .get(at..end)
                .ok_or_else(|| JsValue::from_str("anchors are shorter than the lengths say"))?;
            flat.push(part.to_vec());
            at = end;
        }
        let closed: Vec<bool> = closed.iter().map(|&c| c != 0).collect();
        let subpaths = crate::masking::subpaths_from_flat(&closed, &flat)
            .map_err(|e| JsValue::from_str(&e))?;
        with_stack(|d| d.stack.add_path(name, subpaths).map_err(ingest_err))
    }

    /// One stored path as JSON (`masking::path_json`).
    #[wasm_bindgen]
    pub fn path_get(id: u32) -> Result<String, JsValue> {
        with_stack(|d| {
            d.stack
                .masking()
                .path(id)
                .map(crate::masking::path_json)
                .ok_or_else(|| JsValue::from_str(&format!("no path {id}")))
        })
    }

    /// Make Selection from a stored path (nonzero winding, anti-aliased,
    /// feathered by `feather` px), folded under `mode`. One undo step.
    #[wasm_bindgen]
    pub fn path_make_selection(id: u32, feather: f32, mode: u32) -> Result<(), JsValue> {
        let mode = decode_mode(mode)?;
        let mut cov = with_stack(|d| {
            let (w, h) = (d.stack.width(), d.stack.height());
            d.stack
                .masking()
                .path(id)
                .map(|p| crate::masking::path_coverage(p, w, h))
                .ok_or_else(|| JsValue::from_str(&format!("no path {id}")))
        })?;
        if feather > 0.0 {
            cov.feather(feather);
        }
        selection_step("Make Selection", |s| s.apply_shape(cov, mode))
    }

    // ── vectors inside the image (ADR 476) ───────────────────────────

    /// Geometry in the glue's flat encoding: per subpath its `closed`
    /// flag, its anchor count in `lens`, its anchors as 6 floats each in
    /// `anchors` (point, in handle, out handle; image px) and, in `ops`,
    /// two numbers — the PSD operation (0–3, or 0xFFFF to continue the
    /// component before it) and fill rule (1 even-odd, 2 non-zero).
    /// `ops` may be empty: every subpath then combines.
    fn geometry(
        closed: &[u8],
        lens: &[u32],
        anchors: &[f32],
        ops: &[u32],
    ) -> Result<Vec<crate::masking::SubPath>, JsValue> {
        if closed.len() != lens.len() || !(ops.is_empty() || ops.len() == 2 * lens.len()) {
            return Err(JsValue::from_str(
                "a path is one closed flag, one length and (optionally) two op numbers per subpath",
            ));
        }
        let mut at = 0usize;
        let mut flat = Vec::new();
        for &n in lens {
            let end = at + n as usize * 6;
            let part = anchors
                .get(at..end)
                .ok_or_else(|| JsValue::from_str("anchors are shorter than the lengths say"))?;
            flat.push(part.to_vec());
            at = end;
        }
        if at != anchors.len() {
            return Err(JsValue::from_str("anchors are longer than the lengths say"));
        }
        let closed: Vec<bool> = closed.iter().map(|&c| c != 0).collect();
        let mut subpaths = crate::masking::subpaths_from_flat(&closed, &flat)
            .map_err(|e| JsValue::from_str(&e))?;
        for (k, sp) in subpaths.iter_mut().enumerate() {
            if let (Some(&op), Some(&rule)) = (ops.get(2 * k), ops.get(2 * k + 1)) {
                let op = u16::try_from(op).unwrap_or(1);
                sp.op = crate::masking::SubOp {
                    op: if op <= 3 || op == 0xFFFF { op } else { 1 },
                    rule: if rule == 2 {
                        2
                    } else if op == 0xFFFF {
                        0
                    } else {
                        1
                    },
                };
            }
        }
        Ok(subpaths)
    }

    /// One geometry as JSON: `{"closed":[…],"ops":[[op,rule],…],
    /// "anchors":[[x,y,ix,iy,ox,oy,…],…]}`.
    fn geometry_json(subpaths: &[crate::masking::SubPath]) -> String {
        let closed: Vec<&str> = subpaths
            .iter()
            .map(|s| if s.closed { "true" } else { "false" })
            .collect();
        let ops: Vec<String> = subpaths
            .iter()
            .map(|s| format!("[{},{}]", s.op.op, s.op.rule))
            .collect();
        let anchors: Vec<String> = subpaths
            .iter()
            .map(|s| {
                let v: Vec<String> = s
                    .anchors
                    .iter()
                    .flat_map(|a| [a.p[0], a.p[1], a.i[0], a.i[1], a.o[0], a.o[1]])
                    .map(|f| format!("{f}"))
                    .collect();
                format!("[{}]", v.join(","))
            })
            .collect();
        format!(
            "{{\"closed\":[{}],\"ops\":[{}],\"anchors\":[{}]}}",
            closed.join(","),
            ops.join(","),
            anchors.join(",")
        )
    }

    /// A stored path's geometry with its operations
    /// ([`geometry_json`]), plus its id, name and whether it is the work
    /// path.
    #[wasm_bindgen]
    pub fn path_geometry(id: u32) -> Result<String, JsValue> {
        with_stack(|d| {
            let p = d
                .stack
                .masking()
                .path(id)
                .ok_or_else(|| JsValue::from_str(&format!("no path {id}")))?;
            Ok(format!(
                "{{\"id\":{},\"name\":{},\"work\":{},\"geometry\":{}}}",
                p.id,
                json_escape(&p.name),
                p.work,
                geometry_json(&p.subpaths)
            ))
        })
    }

    /// Replace a stored path's geometry (the Pen, Direct Selection, Path
    /// Selection). One undo step.
    #[wasm_bindgen]
    pub fn path_set(
        id: u32,
        closed: Vec<u8>,
        lens: Vec<u32>,
        anchors: Vec<f32>,
        ops: Vec<u32>,
    ) -> Result<(), JsValue> {
        let g = geometry(&closed, &lens, &anchors, &ops)?;
        with_stack(|d| d.stack.set_path_subpaths(id, g).map_err(ingest_err))
    }

    /// Put geometry in the WORK PATH (created, or replaced). One undo
    /// step; answers its id.
    #[wasm_bindgen]
    pub fn path_set_work(
        closed: Vec<u8>,
        lens: Vec<u32>,
        anchors: Vec<f32>,
        ops: Vec<u32>,
    ) -> Result<u32, JsValue> {
        let g = geometry(&closed, &lens, &anchors, &ops)?;
        with_stack(|d| d.stack.set_work_path(g).map_err(ingest_err))
    }

    /// Save Path: the work path becomes a saved path (`name` empty: the
    /// next `Path n`). One undo step.
    #[wasm_bindgen]
    pub fn path_save(id: u32, name: &str) -> Result<(), JsValue> {
        with_stack(|d| d.stack.save_path(id, name).map_err(ingest_err))
    }

    /// FILL geometry with `color` (straight RGBA in `[0, 1]`) on the
    /// active layer through its drawing — Fill Path, and the shape tools'
    /// Pixels mode (`shape`). The paint is the ordinary masked solid fill
    /// (GPU-only). One undo step.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn fill_geometry(
        handle: u32,
        closed: Vec<u8>,
        lens: Vec<u32>,
        anchors: Vec<f32>,
        ops: Vec<u32>,
        color: Vec<f32>,
        shape: bool,
    ) -> Result<DecodedHandle, JsValue> {
        if color.len() != 4 {
            return Err(JsValue::from_str(
                "fill colour must be 4 floats (straight RGBA in [0,1])",
            ));
        }
        let g = geometry(&closed, &lens, &anchors, &ops)?;
        crate::vectors::check(&g).map_err(|e| JsValue::from_str(&e))?;
        let (img, ctx, _sel, layered) = fill_prelude(handle)?;
        let cov = crate::vectors::coverage(&g, img.width, img.height);
        let Some(damage) = cov.bounds() else {
            return Err(JsValue::from_str("the path encloses no pixel"));
        };
        let spec = FillSpec::Solid {
            color: [color[0], color[1], color[2], color[3]],
        };
        let out = fill_rgba8(&ctx, &img, &spec, Some(Arc::new(cov)))
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let label = if shape { "Shape (pixels)" } else { "Fill path" };
        land_fill_in(label, img.width, img.height, out, layered, damage).await
    }

    /// ADD A VECTOR MASK to layer `index`: `start` 0 reveal all, 1 hide
    /// all, 2 the given geometry. One undo step.
    #[wasm_bindgen]
    pub fn layers_vector_mask_add(
        index: usize,
        start: u32,
        closed: Vec<u8>,
        lens: Vec<u32>,
        anchors: Vec<f32>,
        ops: Vec<u32>,
    ) -> Result<(), JsValue> {
        let start = match start {
            0 => crate::layers::VectorMaskStart::RevealAll,
            1 => crate::layers::VectorMaskStart::HideAll,
            2 => crate::layers::VectorMaskStart::Paths(geometry(&closed, &lens, &anchors, &ops)?),
            s => {
                return Err(JsValue::from_str(&format!(
                    "vector mask start {s} (0, 1 or 2)"
                )))
            }
        };
        with_stack(|d| d.stack.add_vector_mask(index, start).map_err(ingest_err))
    }

    /// Replace the geometry of layer `index`'s vector mask. One step.
    #[wasm_bindgen]
    pub fn layers_vector_mask_set(
        index: usize,
        closed: Vec<u8>,
        lens: Vec<u32>,
        anchors: Vec<f32>,
        ops: Vec<u32>,
    ) -> Result<(), JsValue> {
        let g = geometry(&closed, &lens, &anchors, &ops)?;
        with_stack(|d| d.stack.set_vector_mask_paths(index, g).map_err(ingest_err))
    }

    /// Switch layer `index`'s vector mask (enabled, inverted). One step;
    /// answers whether anything changed.
    #[wasm_bindgen]
    pub fn layers_vector_mask_flags(
        index: usize,
        enabled: bool,
        invert: bool,
    ) -> Result<bool, JsValue> {
        with_stack(|d| {
            d.stack
                .set_vector_mask_flags(index, enabled, invert)
                .map_err(ingest_err)
        })
    }

    #[wasm_bindgen]
    pub fn layers_vector_mask_delete(index: usize) -> Result<(), JsValue> {
        with_stack(|d| d.stack.delete_vector_mask(index).map_err(ingest_err))
    }

    /// Rasterize layer `index`'s vector mask into its user mask. One step.
    #[wasm_bindgen]
    pub fn layers_vector_mask_rasterize(index: usize) -> Result<(), JsValue> {
        with_stack(|d| d.stack.rasterize_vector_mask(index).map_err(ingest_err))
    }

    /// Layer `index`'s vector mask: `{"enabled","invert","geometry"}`, or
    /// `null` without one.
    #[wasm_bindgen]
    pub fn layers_vector_mask_get(index: usize) -> Result<String, JsValue> {
        with_stack(|d| {
            Ok(d.stack.vector_mask(index).map_or_else(
                || "null".to_string(),
                |v| {
                    format!(
                        "{{\"enabled\":{},\"invert\":{},\"geometry\":{}}}",
                        v.enabled,
                        v.invert,
                        geometry_json(&v.subpaths)
                    )
                },
            ))
        })
    }

    /// A SHAPE LAYER: a solid fill of `rgb` (3 bytes) cut by the geometry,
    /// above the active layer. Rendered on the GPU before it returns. One
    /// undo step; answers its index.
    #[wasm_bindgen]
    pub async fn layers_add_shape(
        name: &str,
        rgb: Vec<u8>,
        closed: Vec<u8>,
        lens: Vec<u32>,
        anchors: Vec<f32>,
        ops: Vec<u32>,
    ) -> Result<usize, JsValue> {
        let [r, g, b] = rgb[..] else {
            return Err(JsValue::from_str("a shape's colour is 3 bytes"));
        };
        let geo = geometry(&closed, &lens, &anchors, &ops)?;
        let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
            JsValue::from_str("a shape layer renders on the GPU — call init_gpu first")
        })?;
        let name = name.to_string();
        with_stack_async(|mut doc| async move {
            let r = match doc.stack.add_shape_layer(&name, [r, g, b], geo) {
                Ok(i) => doc
                    .stack
                    .refresh_fills(Some(&ctx))
                    .await
                    .map(|_| i)
                    .map_err(ingest_err),
                Err(e) => Err(ingest_err(e)),
            };
            (doc, r)
        })
        .await
    }

    /// Read the PSD's paths (resources 2000–2997 and the work path 1025)
    /// into the open stack's Paths panel, without a step — the document
    /// had them all along. Only when the panel has no paths yet (a stored
    /// session's paths win). Answers `{"imported":n,"skipped":[…]}`.
    #[wasm_bindgen]
    pub fn psd_paths_into_stack(psd_handle: u32) -> Result<String, JsValue> {
        let (paths, skipped) = PSDS.with(|m| {
            m.borrow()
                .get(&psd_handle)
                .map(crate::vectors::paths_from_psd)
                .ok_or_else(|| JsValue::from_str(&format!("unknown psd handle {psd_handle}")))
        })?;
        with_stack(|d| {
            let n = if d.stack.masking().paths.is_empty() {
                let mut doc = d.stack.masking().clone();
                let n = paths.len();
                doc.import_paths(paths);
                d.stack.set_masking(doc);
                n
            } else {
                0
            };
            Ok(format!(
                "{{\"imported\":{n},\"skipped\":[{}]}}",
                skipped
                    .iter()
                    .map(|s| json_escape(s))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        })
    }

    #[wasm_bindgen]
    pub fn path_delete(id: u32) -> Result<(), JsValue> {
        with_stack(|d| {
            d.stack
                .masking_edit("Delete path", |m, _, _| m.remove_path(id))
                .map_err(ingest_err)
        })
    }

    #[wasm_bindgen]
    pub fn path_rename(id: u32, name: &str) -> Result<(), JsValue> {
        with_stack(|d| {
            d.stack
                .masking_edit("Rename path", |m, _, _| m.rename_path(id, name))
                .map_err(ingest_err)
        })
    }

    #[wasm_bindgen]
    pub fn path_duplicate(id: u32) -> Result<u32, JsValue> {
        with_stack(|d| {
            d.stack
                .masking_edit("Duplicate path", |m, _, _| m.duplicate_path(id))
                .map_err(ingest_err)
        })
    }

    // ── Select and Mask ─────────────────────────────────────────────

    struct SamState {
        base: Arc<SelectionCoverage>,
        params: crate::refine::RefineParams,
        band: Vec<u8>,
        /// An alpha a matting provider answered (the ML hook, WP8.2).
        matte: Option<Vec<u8>>,
        last: Option<crate::refine::Refined>,
    }

    thread_local! {
        static SAM: RefCell<Option<SamState>> = const { RefCell::new(None) };
    }

    /// The external matte as a hook.
    struct ProvidedMatte<'a>(Option<&'a [u8]>);

    impl crate::refine::MattingHook for ProvidedMatte<'_> {
        fn solve(&self, _: &[u8], _: u32, _: u32, _: &[u8]) -> Option<Vec<u8>> {
            self.0.map(<[u8]>::to_vec)
        }
    }

    /// Open the Select and Mask workspace over the current selection
    /// (everything without one is refused: there is no edge to refine).
    #[wasm_bindgen]
    pub fn sam_begin() -> Result<(), JsValue> {
        let cov = SELECTION
            .with(|s| s.borrow().coverage().cloned())
            .ok_or_else(|| JsValue::from_str("Select and Mask needs a selection to refine"))?;
        let n = cov.data().len();
        SAM.with(|s| {
            *s.borrow_mut() = Some(SamState {
                base: cov,
                params: crate::refine::RefineParams::default(),
                band: vec![0; n],
                matte: None,
                last: None,
            })
        });
        Ok(())
    }

    fn with_sam<T>(f: impl FnOnce(&mut SamState) -> Result<T, JsValue>) -> Result<T, JsValue> {
        SAM.with(|s| {
            let mut b = s.borrow_mut();
            let st = b
                .as_mut()
                .ok_or_else(|| JsValue::from_str("Select and Mask is not open (sam_begin)"))?;
            f(st)
        })
    }

    /// The workspace's sliders.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub fn sam_set_params(
        radius: f32,
        smart_radius: bool,
        smooth: f32,
        feather: f32,
        contrast: f32,
        shift_edge: f32,
        decontaminate: bool,
        amount: f32,
    ) -> Result<(), JsValue> {
        with_sam(|s| {
            s.params = crate::refine::RefineParams {
                radius,
                smart_radius,
                smooth,
                feather,
                contrast,
                shift_edge,
                decontaminate,
                amount,
            };
            s.last = None;
            Ok(())
        })
    }

    /// The Refine Edge brush: mark (or with `erase`, unmark) a disc of
    /// `radius` px at `(x, y)` as part of the band to re-solve.
    #[wasm_bindgen]
    pub fn sam_paint_band(x: f32, y: f32, radius: f32, erase: bool) -> Result<(), JsValue> {
        with_sam(|s| {
            let (w, h) = (s.base.width() as i64, s.base.height() as i64);
            let r = radius.max(0.5);
            let (x0, x1) = ((x - r).floor() as i64, (x + r).ceil() as i64);
            let (y0, y1) = ((y - r).floor() as i64, (y + r).ceil() as i64);
            for py in y0.max(0)..y1.min(h) {
                for px in x0.max(0)..x1.min(w) {
                    let (dx, dy) = (px as f32 + 0.5 - x, py as f32 + 0.5 - y);
                    if dx * dx + dy * dy <= r * r {
                        s.band[(py * w + px) as usize] = if erase { 0 } else { 255 };
                    }
                }
            }
            s.last = None;
            Ok(())
        })
    }

    /// The trimap the solve sees (0 / 128 / 255 per pixel) — what a
    /// matting provider is handed.
    #[wasm_bindgen]
    pub fn sam_trimap() -> Result<js_sys::Uint8Array, JsValue> {
        let (_, _, px) = bound_pixels()?;
        with_sam(|s| {
            let t = crate::refine::trimap(&px, &s.base, Some(&s.band), &s.params);
            Ok(js_sys::Uint8Array::from(&t[..]))
        })
    }

    /// A matting provider's alpha (WP8.2); an EMPTY array clears it and
    /// the classical solve runs again.
    #[wasm_bindgen]
    pub fn sam_set_matte(alpha: &[u8]) -> Result<(), JsValue> {
        with_sam(|s| {
            if alpha.is_empty() {
                s.matte = None;
            } else if alpha.len() == s.band.len() {
                s.matte = Some(alpha.to_vec());
            } else {
                return Err(JsValue::from_str("the matte must be one byte per pixel"));
            }
            s.last = None;
            Ok(())
        })
    }

    fn sam_refined() -> Result<crate::refine::Refined, JsValue> {
        let (_, _, px) = bound_pixels()?;
        with_sam(|s| {
            if s.last.is_none() {
                let hook = ProvidedMatte(s.matte.as_deref());
                s.last = Some(crate::refine::refine(
                    &px,
                    &s.base,
                    Some(&s.band),
                    &s.params,
                    &hook,
                ));
            }
            Ok(s.last.clone().expect("computed above"))
        })
    }

    /// The refined alpha (one byte per pixel); it becomes the coverage of
    /// the `matte` view.
    #[wasm_bindgen]
    pub fn sam_preview() -> Result<js_sys::Uint8Array, JsValue> {
        let r = sam_refined()?;
        let out = js_sys::Uint8Array::from(r.alpha.data());
        VIEW.with(|v| v.borrow_mut().matte = Some(Arc::new(r.alpha)));
        Ok(out)
    }

    /// OK: the refined edge to `output` — `selection`, `layerMask` (the
    /// active layer's mask) or `newLayerWithMask` (a masked copy, with the
    /// decontaminated colours when asked for). One undo step; the
    /// workspace closes.
    #[wasm_bindgen]
    pub fn sam_commit(output: &str) -> Result<(), JsValue> {
        let r = sam_refined()?;
        let alpha = Arc::new(r.alpha);
        match output {
            "selection" => {
                let a = (*alpha).clone();
                selection_step("Select and Mask", |s| {
                    s.apply_shape(a, CombineMode::Replace)
                })?;
            }
            "layerMask" => {
                recorded_edit("Select and Mask", None, |st| {
                    let i = st.active_index();
                    st.set_mask(i, Arc::clone(&alpha))
                })?;
            }
            "newLayerWithMask" => {
                let px = r
                    .decontaminated
                    .map(|d| Arc::<[u8]>::from(d.into_boxed_slice()));
                with_stack(|d| d.stack.add_masked_copy(px, alpha).map_err(ingest_err))?;
            }
            o => {
                return Err(JsValue::from_str(&format!(
                    "unknown output {o:?} (selection | layerMask | newLayerWithMask)"
                )))
            }
        }
        sam_cancel();
        Ok(())
    }

    /// Close the workspace without changing anything.
    #[wasm_bindgen]
    pub fn sam_cancel() {
        SAM.with(|s| *s.borrow_mut() = None);
        VIEW.with(|v| {
            let mut v = v.borrow_mut();
            v.matte = None;
            if matches!(v.view, crate::masking::View::Matte(_)) {
                v.view = crate::masking::View::Composite;
            }
        });
    }

    // ── the Magnetic Lasso ──────────────────────────────────────────

    thread_local! {
        static MAGNETIC: RefCell<Option<crate::magnetic::MagneticSession>> =
            const { RefCell::new(None) };
    }

    fn magnetic_outline_flat() -> Vec<f32> {
        MAGNETIC.with(|m| {
            m.borrow()
                .as_ref()
                .map(|s| s.outline().into_iter().flatten().collect())
                .unwrap_or_default()
        })
    }

    /// Start a magnetic gesture at `(x, y)` with the tool's options;
    /// answers the outline so far (flat x, y).
    #[wasm_bindgen]
    pub fn magnetic_begin(
        x: f32,
        y: f32,
        width: f32,
        contrast: f32,
        frequency: f32,
    ) -> Result<Vec<f32>, JsValue> {
        let (w, h, px) = bound_pixels()?;
        let s = crate::magnetic::MagneticSession::begin(
            &px,
            w,
            h,
            x,
            y,
            crate::magnetic::MagneticOptions {
                width,
                contrast,
                frequency,
            },
        )
        .ok_or_else(|| JsValue::from_str("no pixels to trace"))?;
        MAGNETIC.with(|m| *m.borrow_mut() = Some(s));
        Ok(magnetic_outline_flat())
    }

    fn with_magnetic(
        f: impl FnOnce(&mut crate::magnetic::MagneticSession),
    ) -> Result<Vec<f32>, JsValue> {
        MAGNETIC.with(|m| {
            let mut b = m.borrow_mut();
            let s = b
                .as_mut()
                .ok_or_else(|| JsValue::from_str("no magnetic gesture (magnetic_begin)"))?;
            f(s);
            Ok::<(), JsValue>(())
        })?;
        Ok(magnetic_outline_flat())
    }

    /// The pointer moved: the live wire follows (anchors auto-placed).
    #[wasm_bindgen]
    pub fn magnetic_move(x: f32, y: f32) -> Result<Vec<f32>, JsValue> {
        with_magnetic(|s| s.move_to(x, y))
    }

    /// A click: fix an anchor at the (snapped) point.
    #[wasm_bindgen]
    pub fn magnetic_anchor(x: f32, y: f32) -> Result<Vec<f32>, JsValue> {
        with_magnetic(|s| s.anchor_at(x, y))
    }

    /// Backspace: drop the newest anchor.
    #[wasm_bindgen]
    pub fn magnetic_undo_anchor() -> Result<Vec<f32>, JsValue> {
        with_magnetic(|s| s.undo_anchor())
    }

    /// The anchors placed so far (flat x, y pixel centres).
    #[wasm_bindgen]
    pub fn magnetic_anchors() -> Vec<f32> {
        MAGNETIC.with(|m| {
            m.borrow()
                .as_ref()
                .map(|s| {
                    s.anchors()
                        .iter()
                        .flat_map(|&(x, y)| [x as f32 + 0.5, y as f32 + 0.5])
                        .collect()
                })
                .unwrap_or_default()
        })
    }

    /// Close the outline back to the first anchor and fold it into the
    /// selection under `mode`; one undo step. False (nothing selected)
    /// when the outline is too short.
    #[wasm_bindgen]
    pub fn magnetic_close(mode: u32) -> Result<bool, JsValue> {
        let mode = decode_mode(mode)?;
        let poly = MAGNETIC.with(|m| m.borrow_mut().take().and_then(|mut s| s.close()));
        let Some(poly) = poly else {
            return Ok(false);
        };
        let pts: Vec<(f32, f32)> = poly.iter().map(|p| (p[0], p[1])).collect();
        selection_step("Magnetic Lasso", |s| {
            let b = s.bound().ok_or("no image bound (selection_bind first)")?;
            let shape = SelectionCoverage::rasterize_polygon(b.width, b.height, &pts);
            s.apply_shape(shape, mode)
        })?;
        Ok(true)
    }

    /// Escape: abandon the gesture.
    #[wasm_bindgen]
    pub fn magnetic_cancel() {
        MAGNETIC.with(|m| *m.borrow_mut() = None);
    }

    /// RESAMPLE an engine-held image to `out_w`×`out_h` and register the
    /// result as a NEW engine-held image (the source stays intact — the
    /// crop precedent). `filter` ∈ nearest | mitchell | lanczos3 (the T1
    /// resample kernels, GPU-only per spec §6 — requires `init_gpu`;
    /// there is no CPU fallback and this rejects honestly without one).
    /// Rides the async windowed dispatch (a blocking readback cannot
    /// pump the map callback on wasm).
    #[wasm_bindgen]
    pub async fn resize_image(
        handle: u32,
        out_w: u32,
        out_h: u32,
        filter: &str,
    ) -> Result<DecodedHandle, JsValue> {
        use half::f16;
        use image_kernels::families::resample::{
            ResampleParams, RESAMPLE_LANCZOS3, RESAMPLE_MITCHELL, RESAMPLE_NEAREST,
        };

        if out_w == 0 || out_h == 0 {
            return Err(JsValue::from_str("resize: target size must be non-zero"));
        }
        let ctx = GPU
            .with(|g| g.borrow().clone())
            .ok_or_else(|| JsValue::from_str("resize is GPU-only — call init_gpu first"))?;
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let def = match filter {
            "nearest" => &RESAMPLE_NEAREST,
            "mitchell" => &RESAMPLE_MITCHELL,
            "lanczos3" => &RESAMPLE_LANCZOS3,
            other => {
                return Err(JsValue::from_str(&format!(
                    "unknown resample filter \"{other}\" (nearest | mitchell | lanczos3)"
                )))
            }
        };
        let params = ResampleParams::new(
            img.width as f32 / out_w as f32,
            img.height as f32 / out_h as f32,
            0.0,
            0.0,
        );
        // RGBA8 → rgba16float window (straight /255 — the I-02 working
        // values, same as the decode bridge).
        let mut win = Vec::with_capacity(img.rgba.len() * 2);
        for &b in img.rgba.to_rgba8().iter() {
            win.extend_from_slice(&f16::from_f32(b as f32 / 255.0).to_le_bytes());
        }
        let out = image_gpu::execute_windowed_once_async(
            &ctx,
            def,
            &win,
            img.width,
            img.height,
            params.as_bytes(),
            None,
            out_w,
            out_h,
        )
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut rgba = Vec::with_capacity((out_w as usize) * (out_h as usize) * 4);
        for pair in out.chunks_exact(2) {
            let v = f16::from_le_bytes([pair[0], pair[1]]).to_f32();
            rgba.push((v.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        let resized = DecodedImage::from_rgba8(out_w, out_h, rgba)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let new_handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let resized_display = display_code(resized.display);
        let resized_reduced = resized.depth_reduced;
        IMAGES.with(|m| m.borrow_mut().insert(new_handle, resized));
        Ok(DecodedHandle {
            handle: new_handle,
            width: out_w,
            height: out_h,
            // A resize inherits the source image's treatment — and its
            // provenance: resampling 8-bit pixels does not un-reduce a
            // 16-bit source.
            display: resized_display,
            depth_reduced: resized_reduced,
        })
    }

    /// Register `rgba` (`width`×`height`) as a NEW engine-held image
    /// derived from `src`: it inherits the source's colour treatment and
    /// its depth provenance, as a crop and a resize do.
    fn register_derived(
        src: &DecodedImage,
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    ) -> DecodedHandle {
        let handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let (display, depth_reduced) = (display_code(src.display), src.depth_reduced);
        IMAGES.with(|m| {
            m.borrow_mut().insert(
                handle,
                DecodedImage {
                    width,
                    height,
                    rgba: rgba.into(),
                    display: src.display,
                    depth_reduced,
                },
            )
        });
        DecodedHandle {
            handle,
            width,
            height,
            display,
            depth_reduced,
        }
    }

    /// RESAMPLE on the CPU (image ADR 467): `paged_resample`'s separable,
    /// premultiplied resize of an engine-held image to `out_w`×`out_h`,
    /// registered as a NEW engine-held image (the source stays). `filter`
    /// ∈ lanczos3 | bilinear. Needs no device and gives the same bytes
    /// whether or not `init_gpu` succeeded: the supported backend of the
    /// headless and batch actions. The editor's interactive resize stays
    /// on the GPU kernels ([`resize_image`]).
    #[wasm_bindgen]
    pub fn resize_image_cpu(
        handle: u32,
        out_w: u32,
        out_h: u32,
        filter: &str,
    ) -> Result<DecodedHandle, JsValue> {
        let f = paged_resample::Filter::parse(filter).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown CPU resample filter \"{filter}\" (lanczos3 | bilinear)"
            ))
        })?;
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let out = paged_resample::resize_rgba8(
            &img.rgba.to_rgba8(),
            img.width,
            img.height,
            out_w,
            out_h,
            f,
        )
        .map_err(|e| JsValue::from_str(&format!("resize: {e}")))?;
        Ok(register_derived(&img, out_w, out_h, out))
    }

    /// STRAIGHTEN + CROP on the CPU (image ADR 467): turn the image by
    /// `−degrees` about the centre of the rectangle `(x, y, w, h)` and cut
    /// it out (`paged_resample::rotate_crop_rgba8`: bilinear,
    /// premultiplied, clamp-to-edge — the model of `geom.rotate_bilinear`),
    /// registered as a NEW engine-held image. The rectangle must lie
    /// inside the image. At 0° it is [`crop_image`]'s cut, byte for byte.
    /// Needs no device; the editor's crop tool stays on
    /// [`straighten_crop_image`].
    #[wasm_bindgen]
    pub fn straighten_crop_image_cpu(
        handle: u32,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        degrees: f64,
    ) -> Result<DecodedHandle, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let out = paged_resample::rotate_crop_rgba8(
            &img.rgba.to_rgba8(),
            img.width,
            img.height,
            paged_resample::Rect { x, y, w, h },
            degrees,
        )
        .map_err(|e| JsValue::from_str(&format!("straighten: {e}")))?;
        Ok(register_derived(&img, w, h, out))
    }

    // ─────────────────────── GENERATE / FILL doors ───────────────────
    //
    // The generator family's editor reach (`crate::fill`). Both doors
    // are DESTRUCTIVE by design: they paint into the working image and
    // register the result as a NEW engine-held image (the crop/resize
    // commit pattern — the source handle is left for the caller to
    // free). The paint is composited through the bound SELECTION
    // (`mix(original, generated, coverage)` on the GPU); with no
    // selection the whole image is filled. GPU-only — both passes are
    // registered WGSL kernels, so this rejects honestly without
    // `init_gpu`.

    /// Register `pixels` as a new engine-held image, returning its handle.
    /// [`register`] for a buffer that already knows its depth.
    fn register_px(
        width: u32,
        height: u32,
        pixels: crate::pixels::Pixels,
    ) -> Result<DecodedHandle, JsValue> {
        let expected = (width as usize) * (height as usize);
        if pixels.pixel_count() != expected {
            return Err(JsValue::from_str(&format!(
                "register: {} pixels for {width}x{height} (expected {expected})",
                pixels.pixel_count()
            )));
        }
        let img = DecodedImage {
            width,
            height,
            rgba: pixels,
            display: crate::display::DisplayTreatment::AssumedSrgb,
            depth_reduced: false,
        };
        let handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let img_display = display_code(img.display);
        IMAGES.with(|m| m.borrow_mut().insert(handle, img));
        Ok(DecodedHandle {
            handle,
            width,
            height,
            display: img_display,
            // Nothing was narrowed getting here — this door takes the
            // buffer at whatever depth it already had.
            depth_reduced: false,
        })
    }

    fn register(width: u32, height: u32, pixels: Vec<u8>) -> Result<DecodedHandle, JsValue> {
        let img = DecodedImage::from_rgba8(width, height, pixels)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let handle = NEXT_HANDLE.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        let img_display = display_code(img.display);
        IMAGES.with(|m| m.borrow_mut().insert(handle, img));
        Ok(DecodedHandle {
            handle,
            width,
            height,
            // Raw registered pixels carry no container, so no profile —
            // and no depth provenance either.
            display: img_display,
            depth_reduced: false,
        })
    }

    /// Shared head of the fill doors: the BACKDROP the generator paints
    /// over, the GPU context, and the mask bound to THIS handle.
    ///
    /// With a layer stack bound, the backdrop is the ACTIVE LAYER — a
    /// gradient laid on an empty layer above the photo covers nothing
    /// below it, which is the whole point of the stack. Without one it is
    /// the engine-held image (the pre-layer behaviour).
    #[allow(clippy::type_complexity)]
    fn fill_prelude(
        handle: u32,
    ) -> Result<
        (
            DecodedImage,
            Rc<GpuContext>,
            Option<Arc<SelectionCoverage>>,
            bool,
        ),
        JsValue,
    > {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
            JsValue::from_str(
                "fill is GPU-only — call init_gpu first (the generator and the \
                 composite are both WGSL kernels; no CPU fallback ships)",
            )
        })?;
        let sel = SELECTION.with(|s| s.borrow().mask_for(handle));
        let layered = LAYERS.with(|l| {
            let b = l.borrow();
            match b.as_ref() {
                Some(d) if d.handle == handle => {
                    d.stack.active_is_editable()?;
                    Ok(Some(DecodedImage {
                        width: d.stack.width(),
                        height: d.stack.height(),
                        rgba: d.stack.active().rgba.canvas().clone(),
                        // A layer view of an already-ingested image; the
                        // transform ran at decode, not per layer.
                        display: crate::display::DisplayTreatment::AssumedSrgb,
                        depth_reduced: false,
                    }))
                }
                _ => Ok(None),
            }
        });
        match layered.map_err(ingest_err)? {
            Some(layer) => Ok((layer, ctx, sel, true)),
            None => Ok((img, ctx, sel, false)),
        }
    }

    /// Land a fill result: into the ACTIVE LAYER (journaled, then
    /// re-composited into the same handle) when a stack is bound, else
    /// as a NEW engine-held image (the pre-layer destructive commit).
    /// [`land_fill`] for a buffer that already knows its depth.
    ///
    /// The FLAT path keeps whatever depth it was handed, so an
    /// adjustment chain on a 16-bit image no longer quantises between
    /// steps. The LAYERED path still narrows, because the layer edit
    /// journal is tile-granular over `Arc<[u8]>` — that is step 4 of
    /// `docs/design/16-bit-stack.md`, and narrowing HERE rather than pretending
    /// otherwise is what keeps `depth_reduced` honest.
    async fn land_fill_px(
        width: u32,
        height: u32,
        pixels: crate::pixels::Pixels,
        layered: bool,
    ) -> Result<DecodedHandle, JsValue> {
        if !layered {
            return register_px(width, height, pixels);
        }
        // The LAYERED path keeps its depth too, now that `edit_active`
        // and the undo journal are depth-aware: the journal stores
        // opaque tile handles and `FlatImage` always took
        // bytes-per-pixel as a parameter, so nothing in `image-graph`
        // had to change (docs/design/16-bit-stack.md step 4).
        let ctx = GPU.with(|g| g.borrow().clone());
        let damage = SELECTION
            .with(|s| s.borrow().coverage().and_then(|c| c.bounds()))
            .unwrap_or(image_core::Region::new(0, 0, width, height));
        with_stack_async(|mut doc| async move {
            let result = async {
                doc.stack
                    .edit_active("Fill", damage, pixels)
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

    async fn land_fill(
        width: u32,
        height: u32,
        pixels: Vec<u8>,
        layered: bool,
    ) -> Result<DecodedHandle, JsValue> {
        land_fill_as("Fill", width, height, pixels, layered).await
    }

    /// [`land_fill`] under an undo label of the caller's choosing.
    async fn land_fill_as(
        label: &'static str,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
        layered: bool,
    ) -> Result<DecodedHandle, JsValue> {
        // The damage is the SELECTION's box when there is one (the fill
        // cannot land outside it), else the whole canvas.
        let damage = SELECTION
            .with(|s| s.borrow().coverage().and_then(|c| c.bounds()))
            .unwrap_or(image_core::Region::new(0, 0, width, height));
        land_fill_in(label, width, height, pixels, layered, damage).await
    }

    /// [`land_fill_as`] with the damage rectangle given (a fill through a
    /// coverage that is not the selection: a path, a shape).
    async fn land_fill_in(
        label: &'static str,
        width: u32,
        height: u32,
        pixels: Vec<u8>,
        layered: bool,
        damage: image_core::Region,
    ) -> Result<DecodedHandle, JsValue> {
        if !layered {
            return register(width, height, pixels);
        }
        let ctx = GPU.with(|g| g.borrow().clone());
        let pixels: Arc<[u8]> = Arc::from(pixels.into_boxed_slice());
        with_stack_async(|mut doc| async move {
            let result = async {
                doc.stack
                    .edit_active(label, damage, pixels.into())
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
                    // The layer composite inherits the document image's treatment.
                    display: read_display(doc.handle),
                    depth_reduced: read_depth_reduced(doc.handle),
                })
            }
            .await;
            (doc, result)
        })
        .await
    }

    /// FILL the current selection (the whole image when none) with a
    /// fixed TWO-STOP gradient. `kind` ∈ `linear | radial | angular |
    /// reflected | diamond`; `c0`/`c1` are straight RGBA in `[0, 1]`
    /// (4 floats each). The gradient GEOMETRY is derived from the
    /// selection's bounding box — there is no on-canvas drag handle in
    /// v0 (`crate::fill` documents the derivation). Returns the NEW
    /// engine-held image's handle.
    #[wasm_bindgen]
    pub async fn fill_gradient(
        handle: u32,
        kind: String,
        c0: Vec<f32>,
        c1: Vec<f32>,
    ) -> Result<DecodedHandle, JsValue> {
        let kind = GradientKind::from_wire(&kind).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown gradient kind \"{kind}\" (linear | radial | angular | \
                 reflected | diamond)"
            ))
        })?;
        if c0.len() != 4 || c1.len() != 4 {
            return Err(JsValue::from_str(
                "gradient stops must be 4 floats each (straight RGBA in [0,1])",
            ));
        }
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let spec = FillSpec::Gradient {
            kind,
            c0: [c0[0], c0[1], c0[2], c0[3]],
            c1: [c1[0], c1[1], c1[2], c1[3]],
        };
        let out = fill_rgba8(&ctx, &img, &spec, sel)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        land_fill(img.width, img.height, out, layered).await
    }

    /// The GRADIENT TOOL: fill the selection (the whole image when none)
    /// with a two-stop gradient along the dragged line `(x0, y0)` →
    /// `(x1, y1)` in image pixels (`FillSpec::GradientLine`).
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn fill_gradient_line(
        handle: u32,
        kind: String,
        c0: Vec<f32>,
        c1: Vec<f32>,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
    ) -> Result<DecodedHandle, JsValue> {
        let kind = GradientKind::from_wire(&kind).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown gradient kind \"{kind}\" (linear | radial | angular | reflected | diamond)"
            ))
        })?;
        if c0.len() != 4 || c1.len() != 4 {
            return Err(JsValue::from_str(
                "gradient stops must be 4 floats each (straight RGBA in [0,1])",
            ));
        }
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let spec = FillSpec::GradientLine {
            kind,
            c0: [c0[0], c0[1], c0[2], c0[3]],
            c1: [c1[0], c1[1], c1[2], c1[3]],
            from: (x0, y0),
            to: (x1, y1),
        };
        let out = fill_rgba8(&ctx, &img, &spec, sel)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        land_fill(img.width, img.height, out, layered).await
    }

    /// FILL the current selection (the whole image when none) with
    /// deterministic monochrome noise — `amount` scales the hash
    /// amplitude, `seed` makes a repeat reproducible. Returns the NEW
    /// engine-held image's handle.
    #[wasm_bindgen]
    pub async fn fill_noise(handle: u32, amount: f32, seed: u32) -> Result<DecodedHandle, JsValue> {
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let out = fill_rgba8(&ctx, &img, &FillSpec::Noise { amount, seed }, sel)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        land_fill(img.width, img.height, out, layered).await
    }

    /// FILL the current selection (the whole image when none) with ONE
    /// colour — Edit ▸ Fill ▸ Foreground colour. `color` is straight RGBA
    /// in `[0, 1]`. Returns the engine-held image's handle.
    #[wasm_bindgen]
    pub async fn fill_solid(handle: u32, color: Vec<f32>) -> Result<DecodedHandle, JsValue> {
        if color.len() != 4 {
            return Err(JsValue::from_str(
                "fill colour must be 4 floats (straight RGBA in [0,1])",
            ));
        }
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let spec = FillSpec::Solid {
            color: [color[0], color[1], color[2], color[3]],
        };
        let out = fill_rgba8(&ctx, &img, &spec, sel)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        land_fill(img.width, img.height, out, layered).await
    }

    /// The PAINT BUCKET: flood from image pixel `(x, y)` over pixels within
    /// `tolerance` of it (connected ones only when `contiguous`), within
    /// the selection when there is one, and fill that with `color`
    /// (straight RGBA in `[0, 1]`). The flood samples the COMPOSITE —
    /// Photoshop's "sample all layers" — and paints the active layer.
    #[wasm_bindgen]
    pub async fn bucket_fill(
        handle: u32,
        x: u32,
        y: u32,
        tolerance: u8,
        contiguous: bool,
        color: Vec<f32>,
    ) -> Result<DecodedHandle, JsValue> {
        if color.len() != 4 {
            return Err(JsValue::from_str(
                "fill colour must be 4 floats (straight RGBA in [0,1])",
            ));
        }
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        if x >= img.width || y >= img.height {
            return Err(JsValue::from_str(
                "the paint bucket was clicked outside the image",
            ));
        }
        let mut flood = SelectionCoverage::magic_wand(
            img.width,
            img.height,
            &img.rgba.to_rgba8(),
            x,
            y,
            tolerance,
            contiguous,
        );
        if let Some(sel) = &sel {
            flood.combine(sel, CombineMode::Intersect);
        }
        let spec = FillSpec::Solid {
            color: [color[0], color[1], color[2], color[3]],
        };
        let out = fill_rgba8(&ctx, &img, &spec, Some(Arc::new(flood)))
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        land_fill(img.width, img.height, out, layered).await
    }

    /// RASTER TYPE: shape `text` with `font_bytes`, rasterize it, and
    /// paint it into the image at `(x, y)` in `rgba`.
    ///
    /// The glyph run becomes a `SelectionCoverage` and the paint is the
    /// ORDINARY masked solid fill — no new kernel and no new compositing
    /// path, because coverage is coverage. `(x, y)` is the run's
    /// BASELINE ORIGIN, which is where type is positioned from; the
    /// rasterizer reports its own ink offset and this places it.
    ///
    /// Returns the number of glyphs the font had no coverage for
    /// (`.notdef`), so a caller can say "3 characters are missing from
    /// this font" instead of silently dropping them.
    #[wasm_bindgen]
    pub async fn text_paint(
        handle: u32,
        font_bytes: &[u8],
        text: &str,
        size_px: f32,
        x: f32,
        y: f32,
        color: Vec<f32>,
        // `tracking_per_mille` — letter spacing in 1/1000 em (IDML's
        // unit, and unitless, so it needs no px/pt conversion at the
        // boundary). `leading_px` — baseline-to-baseline distance in
        // image px; non-positive or NaN means AUTO, the face's own line
        // height. Both are documented here rather than on the
        // parameters because rustc allows no doc comment there.
        tracking_per_mille: f32,
        leading_px: f32,
        // The remaining style axes, passed as a flat list rather than a
        // struct because wasm-bindgen would otherwise need a serde hop
        // for a handful of scalars. `h_scale`/`v_scale` are MULTIPLES
        // (1.0 = 100%); `align` is 0=left, 1=centre, 2=right; the three
        // flags are 0/1.
        baseline_shift_px: f32,
        h_scale: f32,
        v_scale: f32,
        skew_deg: f32,
        underline: u32,
        strikethrough: u32,
        ligatures: u32,
        align: u32,
    ) -> Result<usize, JsValue> {
        if color.len() != 4 {
            return Err(JsValue::from_str(
                "text colour must be 4 floats (straight RGBA in [0,1])",
            ));
        }
        let style = crate::text::RunStyle {
            tracking_per_mille: if tracking_per_mille.is_finite() {
                tracking_per_mille
            } else {
                0.0
            },
            leading_px: (leading_px.is_finite() && leading_px > 0.0).then_some(leading_px),
            baseline_shift_px: if baseline_shift_px.is_finite() {
                baseline_shift_px
            } else {
                0.0
            },
            // A scale of zero or NaN would rasterize nothing at all,
            // which reads as a broken renderer rather than as a bad
            // input — so it falls back to 100% at the boundary.
            h_scale: if h_scale.is_finite() && h_scale > 0.0 {
                h_scale
            } else {
                1.0
            },
            v_scale: if v_scale.is_finite() && v_scale > 0.0 {
                v_scale
            } else {
                1.0
            },
            skew_deg: if skew_deg.is_finite() { skew_deg } else { 0.0 },
            underline: underline != 0,
            strikethrough: strikethrough != 0,
            ligatures: ligatures != 0,
            align: match align {
                1 => crate::text::LineAlign::Center,
                2 => crate::text::LineAlign::Right,
                _ => crate::text::LineAlign::Left,
            },
        };
        let run =
            crate::text::rasterize_run(font_bytes, text, size_px, style).ok_or_else(|| {
                JsValue::from_str(
                    "could not shape this text: the font did not parse, or the size \
                 is not a positive finite number",
                )
            })?;
        if run.width == 0 || run.height == 0 {
            // Legal and empty — whitespace, or every glyph missing. The
            // caller still gets the missing count, which is the useful
            // half of the answer.
            return Ok(run.missing);
        }

        let (img, ctx, _sel, layered) = fill_prelude(handle)?;
        // Place the run's coverage on a canvas-extent field. Everything
        // outside it is zero, which is exactly "do not paint here".
        let (iw, ih) = (img.width as i64, img.height as i64);
        let mut field = vec![0u8; (iw as usize) * (ih as usize)];
        let ox = x.round() as i64 + run.dx as i64;
        let oy = y.round() as i64 + run.dy as i64;
        for ry in 0..run.height as i64 {
            let py = oy + ry;
            if py < 0 || py >= ih {
                continue;
            }
            for rx in 0..run.width as i64 {
                let px = ox + rx;
                if px < 0 || px >= iw {
                    continue;
                }
                field[(py * iw + px) as usize] =
                    run.coverage[(ry * run.width as i64 + rx) as usize];
            }
        }
        let coverage = SelectionCoverage::from_data(img.width, img.height, field)
            .ok_or_else(|| JsValue::from_str("text coverage did not match the image"))?;

        let out = fill_rgba8(
            &ctx,
            &img,
            &FillSpec::Solid {
                color: [color[0], color[1], color[2], color[3]],
            },
            Some(std::sync::Arc::new(coverage)),
        )
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        land_fill(img.width, img.height, out, layered).await?;
        Ok(run.missing)
    }

    /// CONTENT-AWARE FILL: synthesise the selection from the rest of the
    /// image (multi-resolution PatchMatch, `crate::patchmatch`).
    ///
    /// The SEARCH is CPU — it is sequential, not a dispatch — and the final
    /// VOTE is the registered `geom.patch_vote` kernel when a device exists
    /// (its CPU twin otherwise). The pixels land through the same journaled
    /// layer write as any other fill.
    ///
    /// Requires a SELECTION: with nothing selected there is no hole, and
    /// with everything selected there is no source. Both are errors
    /// rather than a silent no-op, because a fill that quietly did
    /// nothing would read as a broken button.
    #[wasm_bindgen]
    pub async fn fill_content_aware(handle: u32) -> Result<DecodedHandle, JsValue> {
        // WP5.8: the multi-resolution PatchMatch over the whole image
        // (`retouch_doors::fill_whole`) — no search window, and no GPU
        // needed for a one-layer document.
        retouch_doors::fill_whole(handle).await
    }

    /// PATCH: replace the SELECTION with the region `(dx, dy)` image px
    /// away from it, healed so it blends (`retouch::patch_rgba8`: the
    /// shifted source plus the membrane tone correction, composited
    /// through the selection's coverage on the GPU). Lands in the active
    /// layer as one journaled undo step ("Patch"). Needs a selection; a
    /// zero offset is refused rather than spending an undo step on the
    /// identity.
    #[wasm_bindgen]
    pub async fn patch_selection(handle: u32, dx: f32, dy: f32) -> Result<DecodedHandle, JsValue> {
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let coverage = sel.ok_or_else(|| {
            JsValue::from_str("patch needs a selection — select the area to replace first")
        })?;
        let out = crate::retouch::patch_rgba8(
            &ctx,
            &img.rgba.to_rgba8(),
            img.width,
            img.height,
            &coverage,
            dx.round() as i32,
            dy.round() as i32,
        )
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?
        .ok_or_else(|| {
            JsValue::from_str("nothing to patch — an empty selection, or a zero offset")
        })?;
        land_fill_as("Patch", img.width, img.height, out, layered).await
    }

    /// APPLY a gradient map — luminance through a two-stop colour ramp.
    /// A pixel edit into the active layer, journaled and selection-masked
    /// exactly like a fill, because that is what it is.
    #[wasm_bindgen]
    pub async fn apply_gradient_map(
        handle: u32,
        shadow: &[f32],
        highlight: &[f32],
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::adjust::{AdjustGradientMapParams, ADJUST_GRADIENT_MAP};
        if shadow.len() != 3 || highlight.len() != 3 {
            return Err(JsValue::from_str(
                "gradient map endpoints must be 3 floats each (rgb in 0..1)",
            ));
        }
        let params = AdjustGradientMapParams::two_stop(
            [shadow[0], shadow[1], shadow[2]],
            [highlight[0], highlight[1], highlight[2]],
        );
        apply_point_kernel(handle, &ADJUST_GRADIENT_MAP, params.as_bytes()).await
    }

    /// APPLY a parametric distortion (`geom.warp_backward`). `kind` is
    /// 0 pinch / 1 spherize / 2 twirl / 3 wave; `amount == 0` is the
    /// identity for every kind, so a UI slider needs no special cases.
    #[wasm_bindgen]
    pub async fn apply_warp(
        handle: u32,
        kind: u32,
        amount: f32,
        frequency: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::geom::{WarpBackwardParams, WarpKind, GEOM_WARP_BACKWARD};
        let k = match kind {
            0 => WarpKind::Pinch,
            1 => WarpKind::Spherize,
            2 => WarpKind::Twirl,
            3 => WarpKind::Wave,
            other => {
                return Err(JsValue::from_str(&format!(
                    "unknown warp kind {other} (0 pinch | 1 spherize | 2 twirl | 3 wave)"
                )))
            }
        };
        let (img, _, _, _) = fill_prelude(handle)?;
        let (cx, cy) = (img.width as f32 / 2.0, img.height as f32 / 2.0);
        let radius = (img.width.min(img.height) as f32) / 2.0;
        let params = WarpBackwardParams::new(k, amount, cx, cy, radius).with_frequency(frequency);
        apply_point_kernel(handle, &GEOM_WARP_BACKWARD, params.as_bytes()).await
    }

    /// STYLIZE — emboss. `angle_deg` is the light direction, `height`
    /// the relief strength; height 0 is the identity (flat mid-grey
    /// plus nothing).
    #[wasm_bindgen]
    pub async fn apply_emboss(
        handle: u32,
        angle_deg: f32,
        height: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvEmbossParams, CONV_EMBOSS};
        let params = ConvEmbossParams::new(angle_deg, height);
        apply_point_kernel(handle, &CONV_EMBOSS, params.as_bytes()).await
    }

    /// STYLIZE — find edges. `strength` scales the gradient before the
    /// inversion; the result is dark lines on white.
    #[wasm_bindgen]
    pub async fn apply_find_edges(handle: u32, strength: f32) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvFindEdgesParams, CONV_FIND_EDGES};
        let params = ConvFindEdgesParams::new(strength);
        apply_point_kernel(handle, &CONV_FIND_EDGES, params.as_bytes()).await
    }

    /// BLUR GALLERY — motion. `length_px` 0 is the identity.
    #[wasm_bindgen]
    pub async fn apply_motion_blur(
        handle: u32,
        angle_deg: f32,
        length_px: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvMotionParams, CONV_MOTION};
        let params = ConvMotionParams::new(angle_deg, length_px);
        apply_point_kernel(handle, &CONV_MOTION, params.as_bytes()).await
    }

    /// BLUR GALLERY — radial. `spin` picks the mode; `amount` 0 is the
    /// identity for both. The centre is NORMALISED (0..1) so it survives
    /// a resize, unlike a pixel centre which would drift.
    #[wasm_bindgen]
    pub async fn apply_radial_blur(
        handle: u32,
        cx: f32,
        cy: f32,
        amount: f32,
        spin: bool,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvRadialParams, CONV_RADIAL};
        let params = ConvRadialParams::new(cx, cy, amount, spin);
        apply_point_kernel(handle, &CONV_RADIAL, params.as_bytes()).await
    }

    /// PIXELATE — mosaic. `cell_px` <= 1 is the identity.
    #[wasm_bindgen]
    pub async fn apply_mosaic(handle: u32, cell_px: f32) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::geom::{MosaicParams, GEOM_MOSAIC};
        let params = MosaicParams::new(cell_px);
        apply_point_kernel(handle, &GEOM_MOSAIC, params.as_bytes()).await
    }

    /// NOISE — Median, 3×3 (the kernel's fixed comparator network; a
    /// larger radius needs a histogram method, which is a different
    /// kernel). Every output texel is one of the input samples.
    #[wasm_bindgen]
    pub async fn apply_median(handle: u32) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::morph::{MorphParams, RANK_MEDIAN3};
        apply_point_kernel(handle, &RANK_MEDIAN3, MorphParams::new().as_bytes()).await
    }

    /// NOISE — Median / OTHER — Maximum / Minimum AT A RADIUS (`kind`
    /// "median" | "max" | "min"); `round` picks a disc over the square.
    /// Radius 1 square runs the 3×3 kernels (the cheapest exact form);
    /// above it `rank.median_r` (radius ≤ 10) and `morph.dilate_r` /
    /// `morph.erode_r` (≤ 32). A radius past the bound is REJECTED, not
    /// clamped: asking for more is asking for a different filter.
    #[wasm_bindgen]
    pub async fn apply_rank_radius(
        handle: u32,
        kind: &str,
        radius: u32,
        round: bool,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::morph::{
            MorphParams, MorphRadiusParams, MEDIAN_MAX_RADIUS, MORPH_DILATE, MORPH_DILATE_R,
            MORPH_ERODE, MORPH_ERODE_R, MORPH_MAX_RADIUS, RANK_MEDIAN3, RANK_MEDIAN_R,
        };
        let (fixed, wide, bound) = match kind {
            "median" => (&RANK_MEDIAN3, &RANK_MEDIAN_R, MEDIAN_MAX_RADIUS),
            "max" => (&MORPH_DILATE, &MORPH_DILATE_R, MORPH_MAX_RADIUS),
            "min" => (&MORPH_ERODE, &MORPH_ERODE_R, MORPH_MAX_RADIUS),
            other => {
                return Err(JsValue::from_str(&format!(
                    "unknown rank filter \"{other}\" (median | max | min)"
                )))
            }
        };
        if radius > u32::from(bound) {
            return Err(JsValue::from_str(&format!(
                "{kind} radius {radius} is above the kernel's bound of {bound} px"
            )));
        }
        if radius == 1 && !round {
            return apply_point_kernel(handle, fixed, MorphParams::new().as_bytes()).await;
        }
        let params = MorphRadiusParams::new(radius, round);
        apply_point_kernel(handle, wide, params.as_bytes()).await
    }

    /// BLUR — Box Blur: the mean of the (2r+1)² square (`conv.box_r`,
    /// radius ≤ 32; above it is rejected). Radius 0 is the identity.
    #[wasm_bindgen]
    pub async fn apply_box_blur(handle: u32, radius: u32) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvBoxRadiusParams, BOX_MAX_RADIUS, CONV_BOX_R};
        if radius > u32::from(BOX_MAX_RADIUS) {
            return Err(JsValue::from_str(&format!(
                "box blur radius {radius} is above the kernel's bound of {BOX_MAX_RADIUS} px"
            )));
        }
        let params = ConvBoxRadiusParams::new(radius);
        apply_point_kernel(handle, &CONV_BOX_R, params.as_bytes()).await
    }

    /// BLUR — Surface Blur: an edge-preserving mean (`conv.surface`,
    /// radius ≤ 16). `threshold` is in channel units (levels / 255);
    /// 0 is the identity.
    #[wasm_bindgen]
    pub async fn apply_surface_blur(
        handle: u32,
        radius: u32,
        threshold: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvSurfaceParams, CONV_SURFACE, SURFACE_MAX_RADIUS};
        if radius > u32::from(SURFACE_MAX_RADIUS) {
            return Err(JsValue::from_str(&format!(
                "surface blur radius {radius} is above the kernel's bound of \
                 {SURFACE_MAX_RADIUS} px"
            )));
        }
        let params = ConvSurfaceParams::new(radius, threshold);
        apply_point_kernel(handle, &CONV_SURFACE, params.as_bytes()).await
    }

    /// OTHER — High Pass: the image minus its Gaussian blur of σ
    /// `radius_px` (≤ 32/3), re-centred on 50 % grey (`conv.high_pass`).
    #[wasm_bindgen]
    pub async fn apply_high_pass(handle: u32, radius_px: f32) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvHighPassParams, CONV_HIGH_PASS};
        let params = ConvHighPassParams::new(radius_px);
        apply_point_kernel(handle, &CONV_HIGH_PASS, params.as_bytes()).await
    }

    /// NOISE — Add Noise (`gen.add_noise`): `amount` 0 is the identity;
    /// `gaussian` picks the bell over the uniform distribution, `mono`
    /// one draw for R, G and B. `seed` makes it repeatable (the dialog
    /// keeps one seed per session, so a preview and its OK agree).
    #[wasm_bindgen]
    pub async fn apply_add_noise(
        handle: u32,
        seed: u32,
        amount: f32,
        gaussian: bool,
        mono: bool,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gen::{GenAddNoiseParams, GEN_ADD_NOISE};
        let params = GenAddNoiseParams::new(seed, amount, gaussian, mono);
        apply_point_kernel(handle, &GEN_ADD_NOISE, params.as_bytes()).await
    }

    /// BLUR — Average: fill the selection (everything without one) with
    /// the active layer's average colour under it. The mean is a CPU
    /// readout (`readouts::coverage_mean`, like the histogram); the fill
    /// is the `gen.solid` kernel through the ordinary fill landing.
    #[wasm_bindgen]
    pub async fn apply_average(handle: u32) -> Result<DecodedHandle, JsValue> {
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let rgba = img.rgba.to_rgba8();
        let color = crate::readouts::coverage_mean(&rgba, img.width, img.height, sel.as_deref())
            .ok_or_else(|| JsValue::from_str("nothing is selected to average"))?;
        let spec = FillSpec::Solid { color };
        let out = fill_rgba8(&ctx, &img, &spec, sel)
            .await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        land_fill(img.width, img.height, out, layered).await
    }

    /// Curves ▸ Auto: per-channel black and white points of the bound
    /// image (the composite) clipped at `clip` (0.001 = 0.1 %) — six
    /// numbers `[rb, rw, gb, gw, bb, bw]` in `[0, 1]`. A readout: the
    /// curve is built from them glue-side.
    #[wasm_bindgen]
    pub fn auto_contrast_levels(handle: u32, clip: f64) -> Result<Vec<f32>, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let lv = crate::readouts::auto_contrast_levels(&img.rgba.to_rgba8(), clip);
        Ok(lv.iter().flatten().copied().collect())
    }

    /// Image ▸ Trim's rectangle over the bound image (the composite):
    /// `by` ∈ transparent | top-left | bottom-right. Returns `[x, y, w,
    /// h]`, or `[]` when the trim would leave nothing.
    #[wasm_bindgen]
    pub fn trim_rect(handle: u32, by: &str) -> Result<Vec<u32>, JsValue> {
        let by = crate::readouts::TrimBy::from_wire(by).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown trim basis \"{by}\" (transparent | top-left | bottom-right)"
            ))
        })?;
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        Ok(
            crate::readouts::trim_rect(&img.rgba.to_rgba8(), img.width, img.height, by)
                .map(|(x, y, w, h)| vec![x, y, w, h])
                .unwrap_or_default(),
        )
    }

    /// The ppi a PNG or JPEG declares (`pHYs`, JFIF density), or
    /// undefined. Metadata only — read on open for Image Size.
    #[wasm_bindgen]
    pub fn read_ppi(bytes: &[u8]) -> Option<f32> {
        crate::readouts::read_ppi(bytes)
    }

    /// `bytes` (an encoded PNG or JPEG) declaring `ppi`; any other format
    /// comes back unchanged. The exporters call it with Image Size's
    /// resolution.
    #[wasm_bindgen]
    pub fn stamp_ppi(bytes: &[u8], ppi: f32) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(&crate::readouts::stamp_ppi(bytes, ppi)[..])
    }

    /// OTHER — Maximum (`kind` "max", grey dilation) or Minimum ("min",
    /// grey erosion), 3×3.
    #[wasm_bindgen]
    pub async fn apply_morph(handle: u32, kind: &str) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::morph::{MorphParams, MORPH_DILATE, MORPH_ERODE};
        let def = match kind {
            "max" => &MORPH_DILATE,
            "min" => &MORPH_ERODE,
            other => {
                return Err(JsValue::from_str(&format!(
                    "unknown morphology \"{other}\" (max | min)"
                )))
            }
        };
        apply_point_kernel(handle, def, MorphParams::new().as_bytes()).await
    }

    /// ADJUST — Color Lookup: a 9×9×9 RGB cube (`cube` = 729 rgb triples,
    /// red fastest, values 0–1), applied trilinearly. The panel resamples
    /// a .cube file of any size to this edge first.
    #[wasm_bindgen]
    pub async fn apply_lut3d(handle: u32, cube: &[f32]) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::adjust::{AdjustLut3dParams, ADJUST_LUT3D, LUT3D_EDGE};
        let n = LUT3D_EDGE * LUT3D_EDGE * LUT3D_EDGE;
        if cube.len() != n * 3 {
            return Err(JsValue::from_str(&format!(
                "colour lookup: {} values, expected {} ({LUT3D_EDGE}³ rgb)",
                cube.len(),
                n * 3
            )));
        }
        let mut p = AdjustLut3dParams::identity();
        for (i, e) in p.cube.iter_mut().enumerate() {
            *e = [cube[i * 3], cube[i * 3 + 1], cube[i * 3 + 2], 0.0];
        }
        apply_point_kernel(handle, &ADJUST_LUT3D, p.as_bytes()).await
    }

    /// RED-EYE removal inside the ellipse `(cx, cy, rx, ry)` (image px):
    /// only RED pixels change — the mask is the ellipse times each
    /// pixel's redness — and they become the average of their green and
    /// blue, darkened by `darken` (0–1). The channel mixer does the
    /// colour work under that mask; no new kernel.
    #[wasm_bindgen]
    pub async fn apply_red_eye(
        handle: u32,
        cx: f32,
        cy: f32,
        rx: f32,
        ry: f32,
        darken: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::adjust::{AdjustChannelMixerParams, ADJUST_CHANNEL_MIXER};
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let cov = crate::selection::red_eye_coverage(
            &img.rgba.to_rgba8(),
            img.width,
            img.height,
            (cx, cy, rx, ry),
        );
        let k = 1.0 - darken.clamp(0.0, 1.0);
        let params = AdjustChannelMixerParams::new(
            [0.0, 0.5 * k, 0.5 * k, 0.0],
            [0.0, k, 0.0, 0.0],
            [0.0, 0.0, k, 0.0],
        );
        apply_point_kernel_masked(
            handle,
            &ADJUST_CHANNEL_MIXER,
            params.as_bytes(),
            Some(Arc::new(cov)),
        )
        .await
    }

    /// ADJUST — selective colour. `range` 0..8; all-zero deltas are the
    /// identity for every range.
    #[wasm_bindgen]
    pub async fn apply_selective_color(
        handle: u32,
        range: u32,
        cyan: f32,
        magenta: f32,
        yellow: f32,
        black: f32,
        absolute: bool,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::adjust::{SelectiveColorParams, ADJUST_SELECTIVE_COLOR};
        if range > 8 {
            return Err(JsValue::from_str(&format!(
                "unknown selective-colour range {range} (0 reds .. 8 blacks)"
            )));
        }
        let params = SelectiveColorParams::new(range, cyan, magenta, yellow, black, absolute);
        apply_point_kernel(handle, &ADJUST_SELECTIVE_COLOR, params.as_bytes()).await
    }

    /// MOVE the SELECTED pixels — the Move tool with a live selection.
    ///
    /// Distinct from [`apply_offset`], which moves the whole layer. With
    /// a selection this is what a user means by "move": the selected
    /// pixels relocate and the region they came from is vacated.
    /// `vacate` is 0 transparent (plain drag) / 1 copy (alt-drag).
    /// dx=dy=0 is the identity under either.
    #[wasm_bindgen]
    pub async fn apply_move_selection(
        handle: u32,
        dx: f32,
        dy: f32,
        vacate: u32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::geom::{MoveSelectionParams, VacateMode, GEOM_MOVE_SELECTION};
        let mode = VacateMode::from_u32(vacate).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown vacate mode {vacate} (0 transparent | 1 copy)"
            ))
        })?;
        let params = MoveSelectionParams::new(dx, dy, mode);
        apply_point_kernel(handle, &GEOM_MOVE_SELECTION, params.as_bytes()).await
    }

    /// BLUR — SHAPE. Filter > Blur > Shape Blur: convolve with an
    /// ARBITRARY shape rather than a formula.
    ///
    /// `shape_handle` is an ordinary decoded-image handle, so any image
    /// the plugin can open is a blur shape. Coverage is read from RED,
    /// not alpha — a shape library ships white-on-black (where alpha is
    /// identically 1, and reading it would make every shape a box) or
    /// white-on-transparent (where premultiplied red equals alpha), and
    /// red is correct for both conventions.
    ///
    /// `radius_px` is the HALF-extent the shape is scaled to; below 0.5
    /// it is the identity, as is `amount == 0`.
    #[wasm_bindgen]
    pub async fn apply_shape_blur(
        handle: u32,
        shape_handle: u32,
        radius_px: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvShapeParams, CONV_SHAPE};
        let shape = IMAGES
            .with(|m| m.borrow().get(&shape_handle).cloned())
            .ok_or_else(|| {
                JsValue::from_str(&format!("unknown blur-shape handle {shape_handle}"))
            })?;
        let params = ConvShapeParams::new(radius_px, amount, shape.width, shape.height);
        apply_binary_kernel(handle, shape_handle, &CONV_SHAPE, params.as_bytes()).await
    }

    /// FILL with a PATTERN — Edit > Fill > Pattern, and the pattern
    /// half of the paint bucket.
    ///
    /// `tile_handle` is an ordinary decoded-image handle, so any image
    /// the plugin can open is a pattern; there is no separate pattern
    /// asset type and deliberately no SWATCH. The vector pattern-paint
    /// this is often confused with is RFI C-31 — core model + both
    /// renderers + an IDML round-trip decision — and none of it is
    /// needed to tile pixels into a raster layer.
    ///
    /// Selection-scoped like every other fill, so "fill the selection
    /// with a pattern" comes free from the ABI mask.
    /// `opacity == 0` is the identity.
    #[wasm_bindgen]
    pub async fn fill_pattern(
        handle: u32,
        tile_handle: u32,
        scale: f32,
        angle_deg: f32,
        offset_x: f32,
        offset_y: f32,
        opacity: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gen::{GenPatternParams, GEN_PATTERN};
        let tile = IMAGES
            .with(|m| m.borrow().get(&tile_handle).cloned())
            .ok_or_else(|| {
                JsValue::from_str(&format!("unknown pattern-tile handle {tile_handle}"))
            })?;
        let params = GenPatternParams::new(
            0,
            0,
            scale,
            angle_deg,
            offset_x,
            offset_y,
            opacity,
            tile.width,
            tile.height,
        );
        apply_binary_kernel(handle, tile_handle, &GEN_PATTERN, params.as_bytes()).await
    }

    // ───────────────── FILTER GALLERY (§18) ─────────────────
    //
    // Twelve primitives spanning the gallery's six families. They are
    // primitives rather than 47 near-duplicates because the gallery's
    // filters differ by PARAMETER, not by mechanism — Crosshatch and
    // Sumi-e are the same hatching with a different set count.
    //
    // Every one takes `amount`, and `amount == 0` is the identity, so a
    // slider needs no special cases and a preset cannot half-apply.
    //
    // The position-dependent ones take a tile origin in the kernel; the
    // JS door pins it to (0, 0) because this path dispatches the WHOLE
    // image in one go. Tiled dispatch would have to inject the real
    // origin or every tile restarts its lattice and the seams show.
    /// Painterly flattening (Kuwahara): the lowest-variance quadrant's mean,
    /// so a region moves toward paint while its boundary stays put. Serves
    /// Paint Daubs, Palette Knife, Watercolor, Underpainting, Dry Brush.
    #[wasm_bindgen]
    pub async fn apply_gallery_kuwahara(
        handle: u32,
        radius_px: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryKuwaharaParams, GALLERY_KUWAHARA};
        let params = GalleryKuwaharaParams::new(radius_px, amount);
        apply_point_kernel(handle, &GALLERY_KUWAHARA, params.as_bytes()).await
    }

    /// Posterised colour plus a darkened outline. The two halves are
    /// independent, which is what separates Cutout (flat, no ink) from Ink
    /// Outlines (ink, little flattening).
    #[wasm_bindgen]
    pub async fn apply_gallery_posterize_edges(
        handle: u32,
        levels: f32,
        edge_amount: f32,
        edge_threshold: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{
            GalleryPosterizeEdgesParams, GALLERY_POSTERIZE_EDGES,
        };
        let params = GalleryPosterizeEdgesParams::new(levels, edge_amount, edge_threshold, amount);
        apply_point_kernel(handle, &GALLERY_POSTERIZE_EDGES, params.as_bytes()).await
    }

    /// Edge magnitude colourised and boosted — keeps the source hue rather
    /// than going grey, which is the difference from an inverted find-edges.
    #[wasm_bindgen]
    pub async fn apply_gallery_glowing_edges(
        handle: u32,
        intensity: f32,
        smoothness: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryGlowingEdgesParams, GALLERY_GLOWING_EDGES};
        let params = GalleryGlowingEdgesParams::new(intensity, smoothness, amount);
        apply_point_kernel(handle, &GALLERY_GLOWING_EDGES, params.as_bytes()).await
    }

    /// Screen-angle halftone. Dot AREA carries the tone, not dot darkness —
    /// the property that lets a halftone survive a 1-bit output.
    #[wasm_bindgen]
    pub async fn apply_gallery_halftone(
        handle: u32,
        cell_px: f32,
        angle_deg: f32,
        contrast: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryHalftoneParams, GALLERY_HALFTONE};
        let params = GalleryHalftoneParams::new(0, 0, cell_px, angle_deg, contrast, amount);
        apply_point_kernel(handle, &GALLERY_HALFTONE, params.as_bytes()).await
    }

    /// Film grain. The noise is a deterministic hash of the coordinate and
    /// the seed, never host randomness, so undo/redo cannot shimmer.
    #[wasm_bindgen]
    pub async fn apply_gallery_grain(
        handle: u32,
        seed: u32,
        size_px: f32,
        mono: bool,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryGrainParams, GALLERY_GRAIN};
        let params = GalleryGrainParams::new(0, 0, seed, size_px, mono, amount);
        apply_point_kernel(handle, &GALLERY_GRAIN, params.as_bytes()).await
    }

    /// Random local displacement. `anisotropy` is the whole difference
    /// between Spatter (isotropic) and Sprayed Strokes (directional).
    #[wasm_bindgen]
    pub async fn apply_gallery_diffuse(
        handle: u32,
        seed: u32,
        radius_px: f32,
        angle_deg: f32,
        anisotropy: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryDiffuseParams, GALLERY_DIFFUSE};
        let params =
            GalleryDiffuseParams::new(0, 0, seed, radius_px, angle_deg, anisotropy, amount);
        apply_point_kernel(handle, &GALLERY_DIFFUSE, params.as_bytes()).await
    }

    /// Directional hatching modulated by luminance. `sets` alone separates
    /// three named gallery filters: 1 = Graphic Pen, 2 = Crosshatch,
    /// 3 = Sumi-e — which is why they are one kernel and not three.
    #[wasm_bindgen]
    pub async fn apply_gallery_crosshatch(
        handle: u32,
        angle_deg: f32,
        spacing_px: f32,
        strength: f32,
        sets: u32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryCrosshatchParams, GALLERY_CROSSHATCH};
        let params =
            GalleryCrosshatchParams::new(0, 0, angle_deg, spacing_px, strength, sets, amount);
        apply_point_kernel(handle, &GALLERY_CROSSHATCH, params.as_bytes()).await
    }

    /// Directional lighting over a luminance heightfield. Chrome and Plastic
    /// Wrap are APPROXIMATED at extreme settings, not genuinely modelled.
    #[wasm_bindgen]
    pub async fn apply_gallery_bas_relief(
        handle: u32,
        angle_deg: f32,
        elevation_deg: f32,
        height: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryBasReliefParams, GALLERY_BAS_RELIEF};
        let params = GalleryBasReliefParams::new(angle_deg, elevation_deg, height, amount);
        apply_point_kernel(handle, &GALLERY_BAS_RELIEF, params.as_bytes()).await
    }

    /// Luminance threshold with a soft ramp; the ramp width is what makes
    /// Stamp hard and Charcoal soft.
    #[wasm_bindgen]
    pub async fn apply_gallery_threshold_ink(
        handle: u32,
        threshold: f32,
        softness: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryThresholdInkParams, GALLERY_THRESHOLD_INK};
        let params = GalleryThresholdInkParams::new(threshold, softness, amount);
        apply_point_kernel(handle, &GALLERY_THRESHOLD_INK, params.as_bytes()).await
    }

    /// Cellular tiling with a border term. The border weight alone separates
    /// Crystallize (none) from Stained Glass (heavy).
    #[wasm_bindgen]
    pub async fn apply_gallery_stained_glass(
        handle: u32,
        seed: u32,
        cell_px: f32,
        border: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryStainedGlassParams, GALLERY_STAINED_GLASS};
        let params = GalleryStainedGlassParams::new(0, 0, seed, cell_px, border, amount);
        apply_point_kernel(handle, &GALLERY_STAINED_GLASS, params.as_bytes()).await
    }

    /// Refraction-style displacement through a procedural normal field.
    #[wasm_bindgen]
    pub async fn apply_gallery_glass(
        handle: u32,
        seed: u32,
        scale_px: f32,
        distortion: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryGlassParams, GALLERY_GLASS};
        let params = GalleryGlassParams::new(0, 0, seed, scale_px, distortion, amount);
        apply_point_kernel(handle, &GALLERY_GLASS, params.as_bytes()).await
    }

    /// Procedural surface texture modulating shading; `kind` picks the
    /// surface (Canvas / Burlap / Brick) rather than a kernel per material.
    #[wasm_bindgen]
    pub async fn apply_gallery_texturizer(
        handle: u32,
        seed: u32,
        kind: u32,
        scale_px: f32,
        relief: f32,
        angle_deg: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::gallery::{GalleryTexturizerParams, GALLERY_TEXTURIZER};
        let params =
            GalleryTexturizerParams::new(0, 0, seed, kind, scale_px, relief, angle_deg, amount);
        apply_point_kernel(handle, &GALLERY_TEXTURIZER, params.as_bytes()).await
    }

    /// NOISE — despeckle. `amount` 0 is the identity. The edge gate
    /// means this smooths speckle WITHOUT softening an edge, which a
    /// plain median cannot do.
    #[wasm_bindgen]
    pub async fn apply_despeckle(
        handle: u32,
        edge_threshold: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::morph::{RankDespeckleParams, RANK_DESPECKLE};
        let params = RankDespeckleParams::new(edge_threshold, amount);
        apply_point_kernel(handle, &RANK_DESPECKLE, params.as_bytes()).await
    }

    /// NOISE — dust & scratches. `threshold` 1.0 is the identity for
    /// display-referred data, and `radius` 0 is the unconditional one.
    /// The radius is CLAMPED to the kernel's declared ROI rather than
    /// silently reading outside it.
    #[wasm_bindgen]
    pub async fn apply_dust_scratches(
        handle: u32,
        radius: u32,
        threshold: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::morph::{
            RankDustScratchesParams, DUST_SCRATCHES_MAX_RADIUS, RANK_DUST_SCRATCHES,
        };
        // Reject rather than clamp at the JS boundary: a caller asking
        // for radius 12 wants a different filter than radius 4, and
        // quietly giving them 4 is the kind of answer that gets
        // mistaken for the kernel being weak.
        if radius > u32::from(DUST_SCRATCHES_MAX_RADIUS) {
            return Err(JsValue::from_str(&format!(
                "dust & scratches radius {radius} exceeds the kernel maximum {} \
                 (count-below median is O(n^2) in taps; a larger radius needs a \
                 histogram method, which is a different kernel)",
                DUST_SCRATCHES_MAX_RADIUS
            )));
        }
        let params = RankDustScratchesParams::new(radius, threshold);
        apply_point_kernel(handle, &RANK_DUST_SCRATCHES, params.as_bytes()).await
    }

    /// MOVE the pixels of the active layer by (dx, dy). `edge` is
    /// 0 transparent / 1 clamp / 2 wrap; dx=dy=0 is the identity for
    /// every policy. At edge=2 this is Photoshop's Filter > Other >
    /// Offset — one kernel, two surfaces.
    #[wasm_bindgen]
    pub async fn apply_offset(
        handle: u32,
        dx: f32,
        dy: f32,
        edge: u32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::geom::{EdgePolicy, OffsetParams, GEOM_OFFSET};
        // REJECTING decoder at the JS boundary. The clamping twin
        // exists for replaying stored param blocks whose producer may
        // be newer than this build; a live call with a bad policy is a
        // caller bug and should say so rather than silently clamp.
        let policy = EdgePolicy::from_u32(edge).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown edge policy {edge} (0 transparent | 1 clamp | 2 wrap)"
            ))
        })?;
        let params = OffsetParams::new(dx, dy, policy);
        apply_point_kernel(handle, &GEOM_OFFSET, params.as_bytes()).await
    }

    /// BLUR — lens / bokeh. `radius_px` below 0.5 is the identity.
    /// `threshold` is the luminance above which a pixel counts as a
    /// highlight and gets weighted up; `boost` is how hard.
    #[wasm_bindgen]
    pub async fn apply_lens_blur(
        handle: u32,
        radius_px: f32,
        threshold: f32,
        boost: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvLensParams, CONV_LENS};
        let params = ConvLensParams::new(radius_px, threshold, boost);
        apply_point_kernel(handle, &CONV_LENS, params.as_bytes()).await
    }

    /// NOISE — reduce noise (bilateral). `amount` 0 is the identity, and
    /// so is a `sigma_range` small enough that only the centre tap
    /// carries weight.
    #[wasm_bindgen]
    pub async fn apply_reduce_noise(
        handle: u32,
        radius_px: f32,
        sigma_range: f32,
        amount: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvBilateralParams, CONV_BILATERAL};
        let params = ConvBilateralParams::new(radius_px, sigma_range, amount);
        apply_point_kernel(handle, &CONV_BILATERAL, params.as_bytes()).await
    }

    /// SHARPEN — smart sharpen. `amount` 0 is the identity; regions
    /// whose local contrast is below `threshold` are left untouched
    /// whatever the amount, which is the point of the "smart".
    #[wasm_bindgen]
    pub async fn apply_smart_sharpen(
        handle: u32,
        radius_px: f32,
        amount: f32,
        threshold: f32,
        clamp_hi: f32,
    ) -> Result<DecodedHandle, JsValue> {
        use image_kernels::families::conv::{ConvSmartSharpenParams, CONV_SMART_SHARPEN};
        let params = ConvSmartSharpenParams::new(radius_px, amount, threshold, clamp_hi);
        apply_point_kernel(handle, &CONV_SMART_SHARPEN, params.as_bytes()).await
    }

    /// Shared body for "run ONE kernel over the whole image and land the
    /// result like a fill" — the same prelude, mask, journal and
    /// layered-vs-flat landing every fill already goes through, so a new
    /// effect cannot accidentally acquire different semantics.
    /// The two-input sibling of [`apply_point_kernel`], for kernels that
    /// read a SECOND image: `gen.pattern`'s tile and `conv.shape`'s
    /// blur silhouette.
    ///
    /// The padding is not an implementation detail to skim past.
    /// `execute_tile_once_async` sizes EVERY input texture at the output
    /// dims, so a tile smaller than the destination cannot be uploaded
    /// at its own size — it goes in zero-padded at the top-left and
    /// tells the kernel its real extent through the params. That is why
    /// `gen.pattern` carries `tile_w`/`tile_h` instead of asking
    /// `textureDimensions(in1)`, which would report the padded size and
    /// tile the padding along with the pattern.
    async fn apply_binary_kernel(
        handle: u32,
        tile_handle: u32,
        def: &'static image_kernels::KernelDef,
        params: &[u8],
    ) -> Result<DecodedHandle, JsValue> {
        use half::f16;
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let tile = IMAGES
            .with(|m| m.borrow().get(&tile_handle).cloned())
            .ok_or_else(|| {
                JsValue::from_str(&format!("unknown second-input handle {tile_handle}"))
            })?;
        let mask = sel.as_ref().map(|cov| {
            image_gpu::selection::SelectionMask::from_fn(img.width, img.height, |x, y| {
                f32::from(cov.coverage_at(x, y)) / 255.0
            })
            .bytes()
            .to_vec()
        });
        // Same alpha association as `apply_point_kernel` (RFI E-5), for
        // the same reason: `gen.pattern` composites source-over, which
        // is a premultiplied operation, and BOTH inputs have to be in
        // that space or a semi-transparent tile composites wrong.
        let img8 = img.rgba.to_rgba8();
        let tile8 = tile.rgba.to_rgba8();
        let associate = img8.chunks_exact(4).any(|px| px[3] != 255)
            || tile8.chunks_exact(4).any(|px| px[3] != 255);
        let assoc = |buf: &[u8], i: usize, c: usize| -> [u8; 2] {
            let v = buf[i + c] as f32 / 255.0;
            let a = buf[i + 3] as f32 / 255.0;
            f16::from_f32(if associate && c < 3 { v * a } else { v }).to_le_bytes()
        };
        // Over the 8-bit VIEW's length: on a 16-bit store `img.rgba.len()`
        // is twice as long, and indexing `img8` with it ran off the end.
        let mut win = Vec::with_capacity(img8.len() * 2);
        for i in (0..img8.len()).step_by(4) {
            for c in 0..4 {
                win.extend_from_slice(&assoc(&img8, i, c));
            }
        }
        // in1: the tile, zero-padded into a destination-sized buffer.
        let mut tile_win = vec![0u8; (img.width as usize) * (img.height as usize) * 4 * 2];
        let copy_w = tile.width.min(img.width) as usize;
        let copy_h = tile.height.min(img.height) as usize;
        for y in 0..copy_h {
            for x in 0..copy_w {
                let src = (y * tile.width as usize + x) * 4;
                let dst = (y * img.width as usize + x) * 4 * 2;
                for c in 0..4 {
                    let v = assoc(&tile8, src, c);
                    tile_win[dst + c * 2] = v[0];
                    tile_win[dst + c * 2 + 1] = v[1];
                }
            }
        }
        let out = image_gpu::execute_tile_once_async(
            &ctx,
            def,
            &[
                image_gpu::TileInput { f16_bytes: &win },
                image_gpu::TileInput {
                    f16_bytes: &tile_win,
                },
            ],
            params,
            mask.as_deref(),
            img.width,
            img.height,
        )
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let rgba = if associate {
            crate::fill::f16_to_rgba8_unpremul(&out)
        } else {
            crate::fill::f16_to_rgba8(&out)
        };
        land_fill(img.width, img.height, rgba, layered).await
    }

    async fn apply_point_kernel(
        handle: u32,
        def: &'static image_kernels::KernelDef,
        params: &[u8],
    ) -> Result<DecodedHandle, JsValue> {
        apply_point_kernel_masked(handle, def, params, None).await
    }

    /// [`apply_point_kernel`] under a mask of the caller's own instead of
    /// the session selection (a tool that makes its own coverage, such as
    /// red-eye removal).
    async fn apply_point_kernel_masked(
        handle: u32,
        def: &'static image_kernels::KernelDef,
        params: &[u8],
        mask_override: Option<Arc<SelectionCoverage>>,
    ) -> Result<DecodedHandle, JsValue> {
        use half::f16;
        let (img, ctx, sel, layered) = fill_prelude(handle)?;
        let sel = mask_override.or(sel);
        let mask = sel.as_ref().map(|cov| {
            image_gpu::selection::SelectionMask::from_fn(img.width, img.height, |x, y| {
                f32::from(cov.coverage_at(x, y)) / 255.0
            })
            .bytes()
            .to_vec()
        });

        // ALPHA ASSOCIATION — the fix for RFI E-5.
        //
        // `PixelFormat::GPU_WORKING` declares Premultiplied and the
        // whole `adjust.*` family is written to it (`unpremul_rgb(a)`
        // on read, `vec4(c * a.a, a.a)` on write). The decode bridge
        // does NOT associate alpha, so this door used to hand straight
        // bytes to kernels expecting premultiplied ones: the bracket
        // then computed `f(rgb/a)·a` rather than `f(rgb)` — the format
        // survives because the scalings cancel, but the adjustment
        // lands on a colour the pixel never had. Identical at `a = 1`,
        // which is why an opaque photograph looks right and this went
        // unnoticed.
        //
        // `fill.rs` already solved this for its own composite and this
        // is the same bracket, on the same `window_is_opaque` gate:
        // over a fully opaque backdrop `rgb·1 = rgb` and the round trip
        // is PROVABLY the identity, so the common case (a JPEG, a PSD
        // composite, most placed photographs) pays nothing.
        // Alpha association is a question about the ALPHA, so ask the
        // buffer at its own depth rather than a narrowed copy.
        let n_px = img.rgba.pixel_count();
        let associate = (0..n_px).any(|i| img.rgba.sample16(i, 3) != u16::MAX);
        // DEPTH-AGNOSTIC upload. `sample16` widens an 8-bit sample as
        // `(v << 8) | v`, which maps 255 to 65535 exactly, so an 8-bit
        // image produces byte-identical f16 to the old `/ 255.0` path
        // while a 16-bit one keeps every bit it has.
        let px_f16 = |px: usize, c: usize| -> [u8; 2] {
            let v = f32::from(img.rgba.sample16(px, c)) / 65535.0;
            let a = f32::from(img.rgba.sample16(px, 3)) / 65535.0;
            let v = if associate && c < 3 { v * a } else { v };
            f16::from_f32(v).to_le_bytes()
        };
        // WINDOWED kernels get an EXPANDED window and the windowed
        // dispatcher; everything else takes the one-shot lane.
        //
        // This is the fix for RFI E-4. `abi.rs` has always said a
        // Windowed kernel receives `in0` expanded by its radius, with
        // output (x,y) at window centre (x+rx, y+ry) — but this
        // function used to send every kernel through
        // `execute_tile_once_async`, which sizes the input at the
        // OUTPUT dims. So the contract said one thing and the only
        // dispatcher a panel button could reach did another, and the
        // kernels split into two camps that were each right about one
        // of them.
        //
        // `execute_windowed_once_async` already existed — the resample
        // doors ride it. Nothing needed amending; this call simply had
        // to pick the right lane. That also makes the halo the kernels
        // DERIVE come out as (rx, ry) instead of zero, so the edge band
        // is real image data rather than a clamp against the output
        // rectangle.
        let out = match def.class {
            image_kernels::KernelClass::Windowed { radius: (rx, ry) } => {
                let (rx, ry) = (u32::from(rx), u32::from(ry));
                let (ww, wh) = (img.width + 2 * rx, img.height + 2 * ry);
                let mut win = Vec::with_capacity((ww as usize) * (wh as usize) * 4 * 2);
                for wy in 0..wh {
                    // CLAMP into the halo. Zeroing it would darken every
                    // border pixel by the fraction of the window that
                    // fell outside — a visible dark frame on any blur,
                    // and the reason a convolution edge policy is never
                    // "just use zero".
                    let sy = (wy as i64 - ry as i64).clamp(0, img.height as i64 - 1) as usize;
                    for wx in 0..ww {
                        let sx = (wx as i64 - rx as i64).clamp(0, img.width as i64 - 1) as usize;
                        // PIXEL index, not a byte offset — `px_f16`
                        // reads through `sample16`, which is depth-aware
                        // and therefore cannot take a byte position.
                        let px = sy * img.width as usize + sx;
                        for c in 0..4 {
                            win.extend_from_slice(&px_f16(px, c));
                        }
                    }
                }
                image_gpu::execute_windowed_once_async(
                    &ctx,
                    def,
                    &win,
                    ww,
                    wh,
                    params,
                    mask.as_deref(),
                    img.width,
                    img.height,
                )
                .await
            }
            _ => {
                let mut win = Vec::with_capacity(n_px * 8);
                for px in 0..n_px {
                    for c in 0..4 {
                        win.extend_from_slice(&px_f16(px, c));
                    }
                }
                image_gpu::execute_tile_once_async(
                    &ctx,
                    def,
                    &[image_gpu::TileInput { f16_bytes: &win }],
                    params,
                    mask.as_deref(),
                    img.width,
                    img.height,
                )
                .await
            }
        }
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        // READ BACK AT THE SOURCE'S DEPTH. Narrowing a 16-bit image to
        // 8 here is exactly the quantisation a 16-bit pipeline exists to
        // avoid: the GPU already computes in f32 and stores rgba16float,
        // so this step was the ONLY place precision was ever lost — and
        // it was lost once per operation, so a chain of N adjustments
        // quantised N times.
        let landed = if img.rgba.is_16bit() {
            let s16 = if associate {
                crate::fill::f16_to_rgba16_unpremul(&out)
            } else {
                crate::fill::f16_to_rgba16(&out)
            };
            crate::pixels::Pixels::from_rgba16(&s16)
        } else {
            let s8 = if associate {
                crate::fill::f16_to_rgba8_unpremul(&out)
            } else {
                crate::fill::f16_to_rgba8(&out)
            };
            crate::pixels::Pixels::from_rgba8(Arc::from(s8))
        };
        land_fill_px(img.width, img.height, landed, layered).await
    }

    // ─────────────────────── LAYER doors (§6.2) ──────────────────────
    //
    // THE LAYER GRAPH. One stack per wasm realm, BOUND to an engine-held
    // image handle exactly like the selection is — `layers_open` seeds it
    // with that image's pixels as a single "Background" layer (an `Arc`
    // clone, so opening is O(1) and costs no extra memory).
    //
    // The bound image is the stack's COMPOSITE: `layers_composite` folds
    // the stack and writes the result back into the SAME handle, so every
    // downstream lane (the adjust chain, tiles, histogram, save-back,
    // export) keeps working against one handle and never has to learn
    // what a layer is. Pixel edits — paint, fill, bake — go into the
    // ACTIVE layer and are journaled tile-granularly (`layers_undo`).
    //
    // HONEST SCOPE, in the code as well as in the panel:
    //   * Layers are canvas-extent layers. Per-layer MASKS, ADJUSTMENT
    //     layers, SMART objects, CLIPPING and GROUPS all ship
    //     (2026-08-06), and smart filters fell out of clipping. NESTED
    //     groups and the pass-through mode this once listed as absent
    //     shipped the same wave — nesting needed a stack of parked
    //     accumulators keyed on the ancestor chain, not the tree this
    //     comment predicted.
    //   * The journal is a PIXEL log: add / remove / reorder / rename /
    //     opacity / blend / visibility are NOT undoable.
    //   * Canvas operations (crop, straighten, Image Size, rotate, trim)
    //     run over the stack in place on the same handle
    //     (`layers_canvas_op`), so they keep the layers.

    struct LayerDoc {
        /// The engine-held image this stack composites into.
        handle: u32,
        stack: LayerStack,
    }

    thread_local! {
        static LAYERS: RefCell<Option<LayerDoc>> = const { RefCell::new(None) };
    }

    /// WP5.8 — the retouching doors (content-aware fill / move, remove,
    /// the clone source's sampling and overlay).
    /// (`include!`d: an inline module's `#[path]` resolves under a
    /// directory that does not exist.)
    mod retouch_doors {
        include!("retouch_doors.rs");
    }

    /// Replace an engine-held image's pixels in place (same handle, same
    /// extent) and drop its mip pyramid, which the new pixels invalidate.
    /// [`set_image_pixels`] for a composite whose extent may differ from
    /// the bound image's (an undo or redo across a canvas operation): the
    /// image takes `w`x`h`, and when that changed, the selection is
    /// re-bound to it as a canvas operation does.
    fn set_image_extent(
        handle: u32,
        w: u32,
        h: u32,
        rgba: crate::pixels::Pixels,
    ) -> Result<(), JsValue> {
        let resized = IMAGES.with(|m| {
            let mut map = m.borrow_mut();
            let img = map
                .get_mut(&handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
            let resized = (img.width, img.height) != (w, h);
            img.width = w;
            img.height = h;
            img.rgba = rgba;
            Ok::<bool, JsValue>(resized)
        })?;
        PYRAMIDS.with(|p| p.borrow_mut().remove(&handle));
        if resized {
            SELECTION.with(|s| s.borrow_mut().bind(handle, w, h));
        }
        Ok(())
    }

    /// The open stack's canvas extent, `[width, height]` (`[0, 0]` with
    /// no stack open): what an undo or redo across a canvas operation
    /// leaves (finding IMG-1).
    #[wasm_bindgen]
    pub fn layers_extent() -> Vec<u32> {
        LAYERS.with(|l| {
            l.borrow()
                .as_ref()
                .map_or(vec![0, 0], |d| vec![d.stack.width(), d.stack.height()])
        })
    }

    /// Write a composite back into the bound image AT ITS DEPTH (a 16-bit
    /// document's composite keeps 16 bits in the image the adjust chain,
    /// export and save read).
    fn set_image_pixels(handle: u32, rgba: crate::pixels::Pixels) -> Result<(), JsValue> {
        IMAGES.with(|m| {
            let mut map = m.borrow_mut();
            let img = map
                .get_mut(&handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
            // The extent must match; the depth may not (Image ▸ Mode).
            if rgba.pixel_count() != img.rgba.pixel_count() {
                return Err(JsValue::from_str(
                    "internal: composite extent does not match the bound image",
                ));
            }
            img.rgba = rgba;
            Ok(())
        })?;
        PYRAMIDS.with(|p| {
            p.borrow_mut().remove(&handle);
        });
        Ok(())
    }

    /// Take the bound stack out of the `RefCell` (no borrow across an
    /// `await`), run `f`, put it back — restored even when `f` fails.
    /// A STRUCTURE edit as one undo step (`LayerStack::recorded`); edits
    /// sharing a `merge_key` in a row merge (a slider drag is one step).
    fn recorded_edit<T>(
        label: &str,
        merge_key: Option<String>,
        f: impl FnOnce(&mut LayerStack) -> Result<T, IngestError>,
    ) -> Result<T, JsValue> {
        with_stack(|d| {
            d.stack
                .recorded(label, merge_key.as_deref(), f)
                .map_err(ingest_err)
        })
    }

    async fn with_stack_async<T, F, Fut>(f: F) -> Result<T, JsValue>
    where
        F: FnOnce(LayerDoc) -> Fut,
        Fut: std::future::Future<Output = (LayerDoc, Result<T, JsValue>)>,
    {
        let doc = LAYERS
            .with(|l| l.borrow_mut().take())
            .ok_or_else(|| JsValue::from_str("no layer stack open (layers_open first)"))?;
        let (doc, out) = f(doc).await;
        LAYERS.with(|l| *l.borrow_mut() = Some(doc));
        out
    }

    /// Synchronous access to the bound stack.
    fn with_stack<T>(f: impl FnOnce(&mut LayerDoc) -> Result<T, JsValue>) -> Result<T, JsValue> {
        LAYERS.with(|l| {
            let mut b = l.borrow_mut();
            let doc = b
                .as_mut()
                .ok_or_else(|| JsValue::from_str("no layer stack open (layers_open first)"))?;
            f(doc)
        })
    }

    fn ingest_err(e: IngestError) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    /// OPEN a layer stack over an engine-held image: one full-canvas
    /// "Background" layer sharing that image's pixels. Re-opening on the
    /// SAME handle is a no-op (the stack survives); opening on a
    /// different handle replaces it with a fresh one-layer stack. (Crop,
    /// resize and straighten no longer swap handles: they run through
    /// `layers_canvas_op` and keep the stack.)
    #[wasm_bindgen]
    pub fn layers_open(handle: u32) -> Result<(), JsValue> {
        if LAYERS.with(|l| l.borrow().as_ref().map(|d| d.handle)) == Some(handle) {
            return Ok(());
        }
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        // At the image's own depth: a 16-bit image opens a 16-bit
        // Background layer (its pixels shared, not copied).
        let stack = LayerStack::from_image_px(img.width, img.height, img.rgba.clone())
            .map_err(ingest_err)?;
        LAYERS.with(|l| *l.borrow_mut() = Some(LayerDoc { handle, stack }));
        note_selection(None, None);
        Ok(())
    }

    /// IMAGE ▸ MODE ▸ 8 or 16 Bits/Channel (`bits` 8 | 16). With a layer
    /// stack bound to `handle`, every layer converts as one undo step
    /// (`LayerStack::set_depth`) and the composite lands at the new depth;
    /// without one the image itself converts. Answers whether anything
    /// changed. Narrowing rounds to the nearest level, widening is exact.
    #[wasm_bindgen]
    pub async fn image_set_bits(handle: u32, bits: u8) -> Result<bool, JsValue> {
        let depth = match bits {
            8 => image_core::SampleDepth::U8,
            16 => image_core::SampleDepth::U16,
            b => {
                return Err(JsValue::from_str(&format!(
                    "image_set_bits: {b} bits per channel (8 or 16)"
                )))
            }
        };
        let bound = LAYERS.with(|l| l.borrow().as_ref().map(|d| d.handle)) == Some(handle);
        if !bound {
            return IMAGES.with(|m| {
                let mut map = m.borrow_mut();
                let img = map
                    .get_mut(&handle)
                    .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
                if img.rgba.depth() == depth {
                    return Ok(false);
                }
                img.rgba = img.rgba.at_depth(depth);
                PYRAMIDS.with(|p| p.borrow_mut().remove(&handle));
                Ok(true)
            });
        }
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|mut doc| async move {
            let result = async {
                if !doc.stack.set_depth(depth).map_err(ingest_err)? {
                    return Ok(false);
                }
                let rgba = doc
                    .stack
                    .composite_px(ctx.as_deref(), None)
                    .await
                    .map_err(ingest_err)?;
                set_image_pixels(doc.handle, rgba)?;
                Ok(true)
            }
            .await;
            (doc, result)
        })
        .await
    }

    /// OPEN a layer stack from a retained PSD parse instead of from the
    /// flattened composite — the PSD's own layer tree, bottom-first, with
    /// its names, blend modes, opacities and visibility. Returns the
    /// layer count.
    ///
    /// This DECLINES (with the engine's stated reason) for every PSD
    /// whose structure the layer model does not reproduce, because
    /// swapping Photoshop's own composite for a different-looking one of
    /// ours would be worse than flattening. On a refusal the caller keeps
    /// `layers_open` (the flatten) and shows the reason.
    ///
    /// What is refused is listed in `image_psd::layer_pixels`; a refusal
    /// for a capability we since gained is a lie about ourselves, so the
    /// list is worth re-reading whenever the model grows.
    ///
    /// SMART OBJECTS arrive as their stored render, which can be stale.
    /// Before the stack is bound, a file with smart objects is composited
    /// once and every smart object's footprint is compared with the
    /// image this door is given — the file's merged composite
    /// (`layers::smart_renders_agree`); a disagreement declines the
    /// import and leaves the flatten in place. Async for that reason.
    ///
    /// A CMYK document is checked the same way: its plates go through
    /// the conversion the composite took, the stack blends them in RGB,
    /// and the flatten must agree with the converted composite
    /// (`layers::cmyk_flatten_agrees`) or the import declines.
    ///
    /// `image_handle` must be the composite already ingested from the
    /// same file (same extent); `psd_handle` is a `psd_open` handle.
    #[wasm_bindgen]
    pub async fn layers_open_from_psd(
        image_handle: u32,
        psd_handle: u32,
    ) -> Result<usize, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&image_handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {image_handle}")))?;
        let (import, stack) = PSDS.with(|m| {
            let map = m.borrow();
            let file = map
                .get(&psd_handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown psd handle {psd_handle}")))?;
            // A CMYK document's plates go through the SAME conversion
            // the merged composite took at ingest (`decode_psd`), so the
            // layered open and the flattened one agree; the stack then
            // works in RGB, which the image's treatment already states.
            let import = if file.header.color_mode == image_psd::model::ColorMode::Cmyk {
                let ink = crate::ingest::psd_ink_transform(file);
                file.layer_plates_rgba8_via(&|cmyk| ink.to_rgba8(cmyk))
            } else {
                file.layer_plates_rgba8()
            }
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
            if import.width != img.width || import.height != img.height {
                return Err(JsValue::from_str(&format!(
                    "PSD layer import is {}×{} but the ingested composite is {}×{}",
                    import.width, import.height, img.width, img.height
                )));
            }
            // The records too: blending ranges, fill opacity, locks and
            // fill content live there, not on the plates.
            let mut stack =
                LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers))
                    .map_err(ingest_err)?;
            // The document keeps the file's mode, so an edit lands in its
            // colours and the layered save writes the mode back.
            if let Some(mode) = crate::color_mode::DocMode::of_psd(file) {
                stack.adopt_mode(mode);
            }
            // A CMYK file's layers keep its own inks, which the ink fold
            // composites and the layered save writes (image ADR 481).
            if file.header.color_mode == image_psd::model::ColorMode::Cmyk {
                let through = |f: &dyn Fn(&[u8; 4]) -> [u8; 3]| {
                    move |ink: &[u8]| -> Vec<u8> {
                        ink.as_chunks::<4>()
                            .0
                            .iter()
                            .flat_map(|p| {
                                let c = f(p);
                                [c[0], c[1], c[2], 255]
                            })
                            .collect()
                    }
                };
                let cmy = file.layer_plates_rgba8_via(&through(&|p| [p[0], p[1], p[2]]));
                let k = file.layer_plates_rgba8_via(&through(&|p| [p[3]; 3]));
                if let (Ok(cmy), Ok(k)) = (cmy, k) {
                    stack.attach_inks(&cmy, &k);
                }
            }
            Ok::<_, JsValue>((import, stack))
        })?;
        let smart = import.layers.iter().any(|p| p.smart);
        if smart || import.converted_from_cmyk {
            let ctx = GPU.with(|g| g.borrow().clone());
            let ours = stack
                .composite(ctx.as_deref(), None)
                .await
                .map_err(ingest_err)?;
            let theirs = img.rgba.to_rgba8();
            if smart {
                crate::layers::smart_renders_agree(&import, &ours, &theirs).map_err(ingest_err)?;
            }
            // A CMYK document blended in RGB must still look like the
            // file: `theirs` is its merged composite through the same
            // conversion (`decode_psd`), so only the blend space is judged.
            if import.converted_from_cmyk {
                crate::layers::cmyk_flatten_agrees(&ours, &theirs).map_err(ingest_err)?;
            }
        }
        // A 16-bit layered import reduced every plate, and the image the
        // stack composites into inherits that fact — the panel's Depth
        // row reads it from the image, so a layered open must not lose
        // what the composite open already reported.
        if import.depth_reduced {
            IMAGES.with(|m| {
                if let Some(i) = m.borrow_mut().get_mut(&image_handle) {
                    i.depth_reduced = true;
                }
            });
        }
        let n = stack.len();
        LAYERS.with(|l| {
            *l.borrow_mut() = Some(LayerDoc {
                handle: image_handle,
                stack,
            })
        });
        Ok(n)
    }

    /// Drop the bound stack (and its undo history).
    #[wasm_bindgen]
    pub fn layers_close() {
        LAYERS.with(|l| *l.borrow_mut() = None);
    }

    /// The handle the stack is bound to, or `-1` when none is open.
    #[wasm_bindgen]
    pub fn layers_bound() -> i32 {
        LAYERS.with(|l| l.borrow().as_ref().map_or(-1, |d| d.handle as i32))
    }

    /// The eyedropper's "Current layer" sample: the window `(x, y, w, h)`
    /// of layer `index`'s OWN pixels — not the composite, so the layer's
    /// opacity, blend, mask and visibility do not enter it — as straight
    /// RGBA8 (`w'*h'*4` bytes, clipped to the canvas, row-major). A 16-bit
    /// layer narrows by its high byte, as `to_rgba8` does. An adjustment
    /// layer has no pixels of its own: the answer is empty, and the caller
    /// says so rather than sampling something else.
    #[wasm_bindgen]
    pub fn layers_window_rgba8(
        index: usize,
        x: u32,
        y: u32,
        w: u32,
        h: u32,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        with_stack(|d| {
            let (cw, ch) = (d.stack.width(), d.stack.height());
            let layer = d
                .stack
                .layers()
                .get(index)
                .ok_or_else(|| JsValue::from_str(&format!("no layer {index}")))?;
            if matches!(layer.kind, crate::layers::LayerKind::Adjustment(_)) {
                return Ok(js_sys::Uint8Array::new_with_length(0));
            }
            let x1 = x.saturating_add(w).min(cw);
            let y1 = y.saturating_add(h).min(ch);
            if x >= x1 || y >= y1 {
                return Ok(js_sys::Uint8Array::new_with_length(0));
            }
            let mut out = Vec::with_capacity(((x1 - x) * (y1 - y) * 4) as usize);
            // Read the pixels where they live: a bounded layer from its
            // rect (transparent outside), a canvas layer directly — never
            // expanding a bounded layer for a 1×1 sample.
            let (px, rx, ry, rw, rh) = match layer.rgba.bounded() {
                Some(b) => (&b.px, b.rect.x as i64, b.rect.y as i64, b.rect.w, b.rect.h),
                None => (layer.rgba.canvas(), 0, 0, cw, ch),
            };
            for py in y..y1 {
                for pxx in x..x1 {
                    let lx = i64::from(pxx) - rx;
                    let ly = i64::from(py) - ry;
                    if lx < 0 || ly < 0 || lx >= i64::from(rw) || ly >= i64::from(rh) {
                        out.extend_from_slice(&[0, 0, 0, 0]);
                        continue;
                    }
                    let i = (ly as usize) * rw as usize + lx as usize;
                    for c in 0..4 {
                        out.push((px.sample16(i, c) >> 8) as u8);
                    }
                }
            }
            Ok(js_sys::Uint8Array::from(&out[..]))
        })
    }

    /// The stack as JSON, BOTTOM-first:
    /// `{"active":i,"layers":[{index,id,name,visible,locked,opacity,blend}]}`.
    /// `opacity` is 0–1; `blend` is the `compose.*` wire name.
    #[wasm_bindgen]
    pub fn layers_list() -> String {
        LAYERS.with(|l| {
            let b = l.borrow();
            let Some(doc) = b.as_ref() else {
                return "{\"active\":-1,\"layers\":[]}".to_string();
            };
            let rows: Vec<String> = doc
                .stack
                .layers()
                .iter()
                .enumerate()
                .map(|(index, layer)| {
                    format!(
                        "{{\"index\":{index},\"id\":{},\"name\":{},\"visible\":{},\"locked\":{},\"opacity\":{},\"blend\":\"{}\",\"hasMask\":{},\"maskEnabled\":{},\"clipped\":{},\"group\":{},\"kind\":\"{}\"",
                        layer.id,
                        json_escape(&layer.name),
                        layer.visible,
                        layer.locked,
                        layer.opacity,
                        layer.blend_name(),
                        layer.mask.is_some(),
                        layer.mask_enabled,
                        layer.clipped,
                        layer
                            .group
                            .map_or_else(|| "null".to_string(), |g| g.to_string()),
                        layer.kind_name(),
                    ) + &layer_parity_json(layer)
                })
                .collect();
            let groups: Vec<String> = doc
                .stack
                .groups()
                .iter()
                .map(|g| {
                    format!(
                        "{{\"id\":{},\"name\":{},\"visible\":{},\"opacity\":{},\
                         \"blend\":\"{}\",\"passThrough\":{},\"isolates\":{},\"parent\":{},\
                         \"color\":\"{}\"}}",
                        g.id,
                        json_escape(&g.name),
                        g.visible,
                        g.opacity,
                        g.blend_name(),
                        g.pass_through,
                        // The EFFECTIVE mode, which is not always the
                        // declared one — opacity below 1 forces
                        // isolation, and the panel shows what will
                        // actually happen rather than what was asked for.
                        g.isolates(),
                        g.parent.map_or_else(|| "null".to_string(), |p| p.to_string()),
                        crate::layers::COLOR_LABELS[usize::from(g.color).min(7)]
                    )
                })
                .collect();
            let comps: Vec<String> = doc
                .stack
                .comps()
                .iter()
                .map(|c| {
                    format!(
                        "{{\"id\":{},\"name\":{},\"visibility\":{},\"position\":{},\"appearance\":{}}}",
                        c.id,
                        json_escape(&c.name),
                        c.visibility,
                        c.position,
                        c.appearance
                    )
                })
                .collect();
            format!(
                "{{\"active\":{},\"editTarget\":\"{}\",\"layers\":[{}],\"groups\":[{}],\"comps\":[{}]}}",
                doc.stack.active_index(),
                if doc.stack.edit_target_is_mask() {
                    "mask"
                } else {
                    "pixels"
                },
                rows.join(","),
                groups.join(","),
                comps.join(",")
            )
        })
    }

    /// The undo/redo readout as JSON — including the BOUND and how much
    /// of it is used, so "history is a window" is stated rather than
    /// discovered. `null` when no stack is open.
    #[wasm_bindgen]
    pub fn layers_history() -> String {
        LAYERS.with(|l| {
            let b = l.borrow();
            let Some(doc) = b.as_ref() else {
                return "null".to_string();
            };
            let h = doc.stack.history();
            let ids = doc.stack.step_ids();
            format!(
                "{{\"canUndo\":{},\"canRedo\":{},\"depth\":{},\"redoDepth\":{},\"bytes\":{},\"maxBytes\":{},\"maxEntries\":{},\"dropped\":{},\"generation\":{},\"undoLabel\":{},\"redoLabel\":{},\"undoSteps\":[{}],\"redoSteps\":[{}],\"undoIds\":[{}],\"redoIds\":[{}],\"snapshots\":[{}],\"snapshotBytes\":{}}}",
                h.can_undo,
                h.can_redo,
                h.depth,
                h.redo_depth,
                h.bytes,
                h.max_bytes,
                h.max_entries,
                h.dropped,
                h.generation,
                doc.stack
                    .undo_label()
                    .map_or_else(|| "null".to_string(), json_escape),
                doc.stack
                    .redo_label()
                    .map_or_else(|| "null".to_string(), json_escape),
                doc.stack
                    .undo_labels()
                    .iter()
                    .map(|l| json_escape(l))
                    .collect::<Vec<_>>()
                    .join(","),
                doc.stack
                    .redo_labels()
                    .iter()
                    .map(|l| json_escape(l))
                    .collect::<Vec<_>>()
                    .join(","),
                ids.0
                    .iter()
                    .map(u64::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
                ids.1
                    .iter()
                    .map(u64::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
                doc.stack
                    .snapshots()
                    .iter()
                    .map(|s| format!(
                        "{{\"id\":{},\"name\":{},\"width\":{},\"height\":{}}}",
                        s.id,
                        json_escape(&s.name),
                        s.width,
                        s.height
                    ))
                    .collect::<Vec<_>>()
                    .join(","),
                doc.stack.snapshot_bytes(),
            )
        })
    }

    /// HISTORY OPTIONS (ADR 477): the journal's depth (steps) and byte
    /// budget, for the open stack and every stack opened after. Clamped
    /// (1–1000 steps, 16 MiB–2 GiB); answers `{maxEntries, maxBytes}` as
    /// set. A tighter bound drops the oldest steps at once.
    #[wasm_bindgen]
    pub fn layers_set_history_budget(max_entries: u32, max_bytes: f64) -> String {
        let bytes = if max_bytes.is_finite() && max_bytes > 0.0 {
            max_bytes.min(usize::MAX as f64) as usize
        } else {
            0
        };
        let b = crate::layers::set_default_history_budget(max_entries as usize, bytes);
        LAYERS.with(|l| {
            if let Some(doc) = l.borrow_mut().as_mut() {
                doc.stack.set_history_budget(b.max_entries, b.max_bytes);
            }
        });
        format!(
            "{{\"maxEntries\":{},\"maxBytes\":{}}}",
            b.max_entries, b.max_bytes
        )
    }

    /// Name the current state as a SNAPSHOT (not an undo step). Answers
    /// its id.
    #[wasm_bindgen]
    pub fn layers_snapshot_take(name: &str) -> Result<u32, JsValue> {
        with_stack(|d| Ok(d.stack.take_snapshot(name)))
    }

    /// Rename snapshot `id` (an empty name is refused).
    #[wasm_bindgen]
    pub fn layers_snapshot_rename(id: u32, name: &str) -> Result<(), JsValue> {
        with_stack(|d| d.stack.rename_snapshot(id, name).map_err(ingest_err))
    }

    /// Delete snapshot `id`.
    #[wasm_bindgen]
    pub fn layers_snapshot_delete(id: u32) -> Result<(), JsValue> {
        with_stack(|d| d.stack.delete_snapshot(id).map_err(ingest_err))
    }

    /// RESTORE snapshot `id` as ONE undo step named `label`, then
    /// re-composite exactly as an undo does (extent, selection). Answers
    /// `label`.
    #[wasm_bindgen]
    pub async fn layers_snapshot_restore(id: u32, label: String) -> Result<String, JsValue> {
        with_stack_async(|mut doc| async move {
            match doc.stack.restore_snapshot(id, &label) {
                Ok(()) => {
                    let out = after_history_move(&mut doc, label).await;
                    (doc, out)
                }
                Err(e) => (doc, Err(ingest_err(e))),
            }
        })
        .await
    }

    /// Add an empty transparent layer above the active one (it becomes
    /// active). Returns its index.
    #[wasm_bindgen]
    pub fn layers_add(name: &str) -> Result<usize, JsValue> {
        recorded_edit("New layer", None, |st| Ok(st.add(name)))
    }

    /// Duplicate `index` above itself (the copy becomes active).
    #[wasm_bindgen]
    pub fn layers_duplicate(index: usize) -> Result<usize, JsValue> {
        recorded_edit("Duplicate layer", None, |st| {
            st.duplicate(index)
                .ok_or_else(|| IngestError::Unsupported(format!("no layer {index}")))
        })
    }

    /// Remove `index`. Removing the ONLY layer is refused (a document
    /// keeps at least one). One undo step (`LayerStack::remove`).
    #[wasm_bindgen]
    pub fn layers_remove(index: usize) -> Result<(), JsValue> {
        with_stack(|d| d.stack.remove(index).map_err(ingest_err))
    }

    /// Move a layer in stack order (0 = bottom).
    #[wasm_bindgen]
    pub fn layers_reorder(from: usize, to: usize) -> Result<(), JsValue> {
        recorded_edit("Move layer", None, |st| st.reorder(from, to))
    }

    #[wasm_bindgen]
    pub fn layers_set_active(index: usize) -> Result<(), JsValue> {
        with_stack(|d| d.stack.set_active(index).map_err(ingest_err))
    }

    #[wasm_bindgen]
    pub fn layers_set_visible(index: usize, visible: bool) -> Result<(), JsValue> {
        recorded_edit("Layer visibility", None, |st| {
            st.set_visible(index, visible)
        })
    }

    /// Lock a layer's PIXELS: paint / fill / bake refuse on it. Its
    /// properties stay editable — that is what the lock means.
    #[wasm_bindgen]
    pub fn layers_set_locked(index: usize, locked: bool) -> Result<(), JsValue> {
        recorded_edit("Lock layer", None, |st| st.set_locked(index, locked))
    }

    /// Set a layer's opacity (0–1, clamped).
    #[wasm_bindgen]
    pub fn layers_set_opacity(index: usize, opacity: f32) -> Result<(), JsValue> {
        recorded_edit("Layer opacity", Some(format!("opacity:{index}")), |st| {
            st.set_opacity(index, opacity)
        })
    }

    #[wasm_bindgen]
    pub fn layers_set_name(index: usize, name: &str) -> Result<(), JsValue> {
        recorded_edit("Rename layer", Some(format!("name:{index}")), |st| {
            st.set_name(index, name)
        })
    }

    /// Set a layer's blend by `compose.*` wire name (prefix optional).
    /// An unregistered name is a clean error, never a silent normal.
    #[wasm_bindgen]
    pub fn layers_set_blend(index: usize, blend: &str) -> Result<(), JsValue> {
        recorded_edit("Blend mode", None, |st| st.set_blend(index, blend))
    }

    /// Make the CURRENT SELECTION this layer's mask. The natural
    /// authoring path, and the reason layer masks needed no new
    /// authoring engine: the marquee / lasso / wand already produce
    /// exactly the coverage a mask is. Errors when nothing is selected —
    /// silently attaching an all-one mask would look like success and
    /// mask nothing.
    #[wasm_bindgen]
    pub fn layers_mask_from_selection(index: usize) -> Result<(), JsValue> {
        let coverage = SELECTION
            .with(|s| s.borrow().coverage().cloned())
            .ok_or_else(|| {
                JsValue::from_str("no selection to make a mask from — select an area first")
            })?;
        recorded_edit("Layer mask", None, |st| st.set_mask(index, coverage))
    }

    /// ADD LAYER MASK — REVEAL ALL (`reveal_all`, an all-white mask that
    /// changes nothing until painted) or HIDE ALL (all-black, the layer
    /// vanishes until painted back in). One undo step. The new mask
    /// becomes the EDIT TARGET, as Photoshop does, so the next stroke
    /// paints it. Refused when the layer already has a mask.
    #[wasm_bindgen]
    pub fn layers_add_mask(index: usize, reveal_all: bool) -> Result<(), JsValue> {
        let label = if reveal_all {
            "Add layer mask (reveal all)"
        } else {
            "Add layer mask (hide all)"
        };
        recorded_edit(label, None, |st| st.add_mask(index, reveal_all))?;
        with_stack(|d| d.stack.set_edit_target(index, true).map_err(ingest_err))
    }

    /// Make `index` active and choose what the paint tools write on it:
    /// its pixels, or (`mask`) its layer MASK. Selecting the mask of a
    /// layer with none is an error. Not an undo step — choosing a target
    /// changes nothing in the document.
    #[wasm_bindgen]
    pub fn layers_set_edit_target(index: usize, mask: bool) -> Result<(), JsValue> {
        with_stack(|d| d.stack.set_edit_target(index, mask).map_err(ingest_err))
    }

    /// DELETE the mask (the coverage is gone), as distinct from
    /// disabling it.
    #[wasm_bindgen]
    pub fn layers_clear_mask(index: usize) -> Result<(), JsValue> {
        recorded_edit("Delete layer mask", None, |st| st.clear_mask(index))
    }

    /// Toggle whether the attached mask applies, RETAINING it either way
    /// — losing painted coverage to a toggle would be a real loss.
    /// Clip a layer to the one beneath it — the mechanism "smart
    /// filters" wanted: an adjustment layer clipped to a smart object IS
    /// a smart filter. Confines the layer to its base's ALPHA, and
    /// multiplies with any mask it already has rather than replacing it.
    /// Group the CONTIGUOUS run `from..=to`. Returns the new group id.
    /// Refuses a range that is out of bounds or already grouped —
    /// nesting needs a tree and this stack is a list.
    #[wasm_bindgen]
    pub fn layers_group(from: usize, to: usize, name: &str) -> Result<u32, JsValue> {
        recorded_edit("Group layers", None, |st| st.group_range(from, to, name))
    }

    /// Dissolve a group. Its layers stay, in place and unchanged.
    #[wasm_bindgen]
    pub fn layers_ungroup(id: u32) -> Result<(), JsValue> {
        recorded_edit("Ungroup", None, |st| st.ungroup(id))
    }

    #[wasm_bindgen]
    pub fn layers_set_group_visible(id: u32, visible: bool) -> Result<(), JsValue> {
        recorded_edit("Group visibility", None, |st| {
            st.set_group_visible(id, visible)
        })
    }

    #[wasm_bindgen]
    pub fn layers_set_group_opacity(id: u32, opacity: f32) -> Result<(), JsValue> {
        recorded_edit("Group opacity", Some(format!("group-opacity:{id}")), |st| {
            st.set_group_opacity(id, opacity)
        })
    }

    #[wasm_bindgen]
    pub fn layers_set_group_name(id: u32, name: &str) -> Result<(), JsValue> {
        recorded_edit("Rename group", Some(format!("group-name:{id}")), |st| {
            st.set_group_name(id, name)
        })
    }

    /// Switch a group between PASS THROUGH (the default: members reach
    /// the stack below) and ISOLATED (members composite into their own
    /// buffer first). Note that an opacity below 1 forces isolation
    /// regardless — `layers_list`'s `isolates` reports the effective
    /// mode, `passThrough` the declared one.
    #[wasm_bindgen]
    pub fn layers_set_group_pass_through(id: u32, pass_through: bool) -> Result<(), JsValue> {
        recorded_edit("Group mode", None, |st| {
            st.set_group_pass_through(id, pass_through)
        })
    }

    #[wasm_bindgen]
    pub fn layers_set_group_blend(id: u32, blend: &str) -> Result<(), JsValue> {
        recorded_edit("Group blend", None, |st| st.set_group_blend(id, blend))
    }

    #[wasm_bindgen]
    pub fn layers_set_clipped(index: usize, clipped: bool) -> Result<(), JsValue> {
        recorded_edit("Clipping mask", None, |st| st.set_clipped(index, clipped))
    }

    #[wasm_bindgen]
    pub fn layers_set_mask_enabled(index: usize, enabled: bool) -> Result<(), JsValue> {
        recorded_edit("Enable layer mask", None, |st| {
            st.set_mask_enabled(index, enabled)
        })
    }

    // ─────────────── Photoshop layer parity (WP5.3) ───────────────
    //
    // Fill layers, typed adjustment layers, the blending options, the
    // locks, labels and links, the Layer menu's merges, Layer via Copy
    // and Cut, layer comps, and align/distribute. Each is ONE undo step
    // (`recorded_edit`, or `LayerStack::recorded` inside the async verbs);
    // the caller re-composites (`layers_composite`), which also renders a
    // fill layer whose source changed.

    /// The selection of the bound image, if any.
    fn bound_selection(handle: u32) -> Option<Arc<SelectionCoverage>> {
        SELECTION.with(|s| s.borrow().mask_for(handle))
    }

    /// Add a TYPED adjustment layer of `kind` above the active layer, in
    /// its group: `values` empty takes Photoshop's defaults
    /// (`Adjustment::default_for`), else they are the kind's block
    /// (`Adjustment::values`); `cube` is a Color Lookup's. With
    /// `mask_from_selection` and a selection, the selection becomes its
    /// mask (Photoshop's). Returns its index.
    #[wasm_bindgen]
    pub fn layers_add_typed_adjustment(
        kind: &str,
        name: &str,
        values: &[f32],
        cube: &[f32],
        label: &str,
        mask_from_selection: bool,
    ) -> Result<usize, JsValue> {
        use crate::layers::Adjustment;
        let adj = if values.is_empty() && cube.is_empty() {
            Adjustment::default_for(kind)
                .ok_or_else(|| JsValue::from_str(&format!("unknown adjustment kind \"{kind}\"")))?
        } else {
            Adjustment::from_wire(kind, values, cube, label).map_err(ingest_err)?
        };
        let handle = with_stack(|d| Ok(d.handle))?;
        let sel = mask_from_selection
            .then(|| bound_selection(handle))
            .flatten();
        recorded_edit("New Adjustment Layer", None, move |st| {
            let group = st.active().group;
            let i = st.add_adjustment_layer(name, adj, Some(group));
            if let Some(cov) = sel {
                st.set_mask(i, cov)?;
            }
            Ok(i)
        })
    }

    /// Retune a typed adjustment layer (its Properties). Consecutive edits
    /// of one layer merge into one undo step (a slider drag).
    #[wasm_bindgen]
    pub fn layers_set_typed_adjustment(
        index: usize,
        kind: &str,
        values: &[f32],
        cube: &[f32],
        label: &str,
    ) -> Result<(), JsValue> {
        let adj =
            crate::layers::Adjustment::from_wire(kind, values, cube, label).map_err(ingest_err)?;
        recorded_edit("Adjustment", Some(format!("adjust:{index}")), move |st| {
            st.set_adjustment_typed(index, adj)
        })
    }

    /// A layer's kind-specific parameters as JSON, for its Properties:
    /// `{"adjustment":kind,"values":[…],"label":…}` for an adjustment
    /// layer, `{"fill":kind,"values":[…],"name":…,"tile":[w,h]|null}` for a
    /// fill layer, `{}` otherwise.
    #[wasm_bindgen]
    pub fn layers_layer_params(index: usize) -> Result<String, JsValue> {
        with_stack(|d| {
            let l = d
                .stack
                .layers()
                .get(index)
                .ok_or_else(|| JsValue::from_str(&format!("no layer {index}")))?;
            let nums = |v: Vec<f32>| {
                v.iter()
                    .map(|x| format!("{x}"))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            Ok(if let Some(a) = l.adjustment() {
                format!(
                    "{{\"adjustment\":\"{}\",\"values\":[{}],\"label\":{}}}",
                    a.kind_name(),
                    nums(a.values()),
                    json_escape(a.label())
                )
            } else if let Some(f) = l.fill() {
                let (name, tile) = match &f.source {
                    crate::layers::FillSource::Pattern(p) => {
                        (p.name.clone(), format!("[{},{}]", p.width, p.height))
                    }
                    _ => (String::new(), "null".to_string()),
                };
                format!(
                    "{{\"fill\":\"{}\",\"values\":[{}],\"name\":{},\"tile\":{tile}}}",
                    f.source.kind_name(),
                    nums(f.source.values()),
                    json_escape(&name)
                )
            } else {
                "{}".to_string()
            })
        })
    }

    /// The pattern tile behind `tile_handle` (`-1`: none), as a fill's.
    fn tile_of(tile_handle: i32) -> Result<Option<(Arc<[u8]>, u32, u32)>, JsValue> {
        if tile_handle < 0 {
            return Ok(None);
        }
        let img = IMAGES
            .with(|m| m.borrow().get(&(tile_handle as u32)).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown pattern handle {tile_handle}")))?;
        Ok(Some((
            Arc::from(img.rgba.to_rgba8().into_owned().into_boxed_slice()),
            img.width,
            img.height,
        )))
    }

    /// Layer ▸ New Fill Layer: `kind` solid | gradient | pattern with its
    /// block (`FillSource::values`); a pattern's tile is the engine image
    /// `tile_handle`. Rendered on the GPU before it returns. With
    /// `mask_from_selection` and a selection, the selection is its mask.
    #[wasm_bindgen]
    pub async fn layers_add_fill(
        kind: &str,
        values: &[f32],
        tile_handle: i32,
        name: &str,
        mask_from_selection: bool,
    ) -> Result<usize, JsValue> {
        let source = crate::layers::FillSource::from_wire(kind, values, tile_of(tile_handle)?, "")
            .map_err(ingest_err)?;
        let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
            JsValue::from_str("a fill layer renders on the GPU — call init_gpu first")
        })?;
        let name = name.to_string();
        with_stack_async(|mut doc| async move {
            let sel = mask_from_selection
                .then(|| bound_selection(doc.handle))
                .flatten();
            let r = doc.stack.recorded("New Fill Layer", None, |st| {
                let i = st.add_fill_layer(&name, source);
                if let Some(cov) = sel {
                    st.set_mask(i, cov)?;
                }
                Ok(i)
            });
            let r = match r {
                Ok(i) => doc
                    .stack
                    .refresh_fills(Some(&ctx))
                    .await
                    .map(|_| i)
                    .map_err(ingest_err),
                Err(e) => Err(ingest_err(e)),
            };
            (doc, r)
        })
        .await
    }

    /// A fill layer's Properties: a new source (same block as
    /// `layers_add_fill`). Edits of one layer in a row merge.
    #[wasm_bindgen]
    pub async fn layers_set_fill(
        index: usize,
        kind: &str,
        values: &[f32],
        tile_handle: i32,
    ) -> Result<(), JsValue> {
        // A pattern keeps its tile unless a new one is given.
        let tile = match tile_of(tile_handle)? {
            Some(t) => Some(t),
            None => with_stack(|d| {
                Ok(d.stack.layers().get(index).and_then(|l| match l.fill() {
                    Some(crate::layers::FillLayer {
                        source: crate::layers::FillSource::Pattern(p),
                        ..
                    }) => Some((Arc::clone(&p.tile), p.width, p.height)),
                    _ => None,
                }))
            })?,
        };
        let pname = with_stack(|d| {
            Ok(d.stack.layers().get(index).and_then(|l| match l.fill() {
                Some(crate::layers::FillLayer {
                    source: crate::layers::FillSource::Pattern(p),
                    ..
                }) => Some(p.name.clone()),
                _ => None,
            }))
        })?
        .unwrap_or_default();
        let source =
            crate::layers::FillSource::from_wire(kind, values, tile, &pname).map_err(ingest_err)?;
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|mut doc| async move {
            let r = doc
                .stack
                .recorded("Fill Layer", Some(&format!("fill:{index}")), |st| {
                    st.set_fill(index, source)
                });
            let r = match r {
                Ok(()) => doc
                    .stack
                    .refresh_fills(ctx.as_deref())
                    .await
                    .map(|_| ())
                    .map_err(ingest_err),
                Err(e) => Err(ingest_err(e)),
            };
            (doc, r)
        })
        .await
    }

    /// Rasterize a fill layer or smart object (its render becomes pixels).
    #[wasm_bindgen]
    pub fn layers_rasterize(index: usize) -> Result<(), JsValue> {
        recorded_edit("Rasterize Layer", None, |st| st.rasterize(index))
    }

    /// Fill opacity 0–1 (a drag is one undo step).
    #[wasm_bindgen]
    pub fn layers_set_fill_opacity(index: usize, fill: f32) -> Result<(), JsValue> {
        recorded_edit(
            "Fill opacity",
            Some(format!("fill-opacity:{index}")),
            |st| st.set_fill_opacity(index, fill),
        )
    }

    /// Blend If: 32 sliders (gray, red, green, blue; each This Layer's
    /// black low/high and white low/high, then the Underlying Layer's), or
    /// empty to clear. A drag is one undo step.
    #[wasm_bindgen]
    pub fn layers_set_blend_if(index: usize, sliders: &[u8]) -> Result<(), JsValue> {
        let bi = match sliders.len() {
            0 => None,
            32 => Some(crate::layers::BlendIf::from_bytes(
                sliders.try_into().expect("32"),
            )),
            n => {
                return Err(JsValue::from_str(&format!(
                    "Blend If takes 32 slider values or none (got {n})"
                )))
            }
        };
        recorded_edit("Blend If", Some(format!("blend-if:{index}")), |st| {
            st.set_blend_if(index, bi)
        })
    }

    /// The layer's STYLE as JSON (`paged-psd`'s model; `null` for none).
    #[wasm_bindgen]
    pub fn layers_style(index: usize) -> Result<String, JsValue> {
        with_stack(|d| {
            let l = d
                .stack
                .layers()
                .get(index)
                .ok_or_else(|| JsValue::from_str(&format!("no layer {index}")))?;
            Ok(crate::layers::style_to_json(l.ext.style.as_deref()))
        })
    }

    /// Set the layer's style from JSON (`null` clears it). The dialog's
    /// edits merge into one undo step per layer.
    #[wasm_bindgen]
    pub fn layers_set_style(index: usize, json: &str) -> Result<(), JsValue> {
        let style = crate::layers::style_from_json(json).map_err(ingest_err)?;
        let label = if style.is_some() {
            "Layer Style"
        } else {
            "Clear Layer Style"
        };
        let key = style.is_some().then(|| format!("layer-style:{index}"));
        recorded_edit(label, key, |st| st.set_style(index, style))
    }

    /// Paste Layer Style onto several layers (one undo step).
    #[wasm_bindgen]
    pub fn layers_paste_style(indices: &[u32], json: &str) -> Result<(), JsValue> {
        let style = crate::layers::style_from_json(json)
            .map_err(ingest_err)?
            .ok_or_else(|| JsValue::from_str("nothing to paste: no layer style"))?;
        let idx: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
        recorded_edit("Paste Layer Style", None, |st| st.paste_style(&idx, &style))
    }

    /// The style switches of Blending Options (`StyleOptions::bits`).
    #[wasm_bindgen]
    pub fn layers_set_style_options(index: usize, bits: u8) -> Result<(), JsValue> {
        recorded_edit("Blending Options", None, |st| {
            st.set_style_options(index, crate::layers::StyleOptions::from_bits(bits))
        })
    }

    /// The document's Global Light: `[angle, altitude]` in degrees.
    #[wasm_bindgen]
    pub fn layers_global_light() -> Result<Vec<f32>, JsValue> {
        with_stack(|d| {
            let g = d.stack.style_doc().global_light;
            Ok(vec![g.angle, g.altitude])
        })
    }

    /// Layer ▸ Layer Style ▸ Global Light (a drag is one undo step).
    #[wasm_bindgen]
    pub fn layers_set_global_light(angle: f32, altitude: f32) -> Result<(), JsValue> {
        recorded_edit("Global Light", Some("global-light".into()), |st| {
            st.set_global_light(image_psd::effects::GlobalLight { angle, altitude })
        })
    }

    /// Layer ▸ Layer Style ▸ Scale Effects.
    #[wasm_bindgen]
    pub fn layers_scale_effects(index: usize, percent: f32) -> Result<(), JsValue> {
        recorded_edit("Scale Effects", None, |st| st.scale_effects(index, percent))
    }

    /// Layer ▸ Layer Style ▸ Hide / Show All Effects.
    #[wasm_bindgen]
    pub fn layers_set_effects_visible(index: usize, on: bool) -> Result<(), JsValue> {
        let label = if on {
            "Show All Effects"
        } else {
            "Hide All Effects"
        };
        recorded_edit(label, None, |st| st.set_effects_visible(index, on))
    }

    /// Add (or replace, by `name`) a pattern the styles can draw (Pattern
    /// Overlay, a pattern Stroke, a bevel's Texture): `rgba` is `width ×
    /// height` straight RGBA8.
    #[wasm_bindgen]
    pub fn layers_define_style_pattern(
        name: &str,
        rgba: &[u8],
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        let p = crate::layers::PatternFill {
            name: name.to_string(),
            tile: std::sync::Arc::from(rgba.to_vec().into_boxed_slice()),
            width,
            height,
            scale: 100.0,
            angle: 0.0,
        };
        // Document state, but not an edit of its own: the pattern is
        // defined by Edit ▸ Define Pattern, which has no undo step either;
        // the effect that draws it is the undoable edit.
        with_stack(|d| d.stack.define_style_pattern(p).map_err(ingest_err))
    }

    /// Knockout: "none", "shallow" or "deep".
    #[wasm_bindgen]
    pub fn layers_set_knockout(index: usize, knockout: &str) -> Result<(), JsValue> {
        let k = crate::layers::Knockout::from_wire(knockout).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown knockout \"{knockout}\" (none | shallow | deep)"
            ))
        })?;
        recorded_edit("Knockout", None, |st| st.set_knockout(index, k))
    }

    /// The four locks at once: image pixels, transparent pixels, position
    /// and all.
    #[wasm_bindgen]
    pub fn layers_set_locks(
        index: usize,
        pixels: bool,
        transparency: bool,
        position: bool,
        all: bool,
    ) -> Result<(), JsValue> {
        recorded_edit("Lock layer", None, |st| {
            st.set_locks(
                index,
                pixels,
                crate::layers::LayerLocks {
                    transparency,
                    position,
                    all,
                },
            )
        })
    }

    /// The colour label by name (`none`, `red`, … `gray`).
    #[wasm_bindgen]
    pub fn layers_set_color(index: usize, color: &str) -> Result<(), JsValue> {
        let c = color_code(color)?;
        recorded_edit("Color label", None, |st| st.set_color(index, c))
    }

    #[wasm_bindgen]
    pub fn layers_set_group_color(id: u32, color: &str) -> Result<(), JsValue> {
        let c = color_code(color)?;
        recorded_edit("Color label", None, |st| st.set_group_color(id, c))
    }

    fn color_code(color: &str) -> Result<u8, JsValue> {
        crate::layers::COLOR_LABELS
            .iter()
            .position(|c| *c == color)
            .map(|c| c as u8)
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "unknown colour label \"{color}\" ({})",
                    crate::layers::COLOR_LABELS.join(" | ")
                ))
            })
    }

    /// LINK the layers at `indices` (two or more). Returns the link id.
    #[wasm_bindgen]
    pub fn layers_link(indices: &[u32]) -> Result<u32, JsValue> {
        let idx: Vec<usize> = indices.iter().map(|&i| i as usize).collect();
        recorded_edit("Link Layers", None, move |st| st.link(&idx))
    }

    #[wasm_bindgen]
    pub fn layers_unlink(index: usize) -> Result<(), JsValue> {
        recorded_edit("Unlink Layer", None, |st| st.unlink(index))
    }

    /// A verb that may find nothing to do: one undo step only when it
    /// changed something (`LayerStack::recorded_if_changed`).
    fn recorded_changed(
        label: &str,
        f: impl FnOnce(&mut LayerStack) -> Result<bool, IngestError>,
    ) -> Result<(), JsValue> {
        with_stack(|d| {
            d.stack
                .recorded_if_changed(label, f)
                .map(|_| ())
                .map_err(ingest_err)
        })
    }

    /// Run one of the async merge verbs on the bound stack.
    async fn merge_verb<T: 'static>(
        f: impl for<'a> FnOnce(
                &'a mut LayerStack,
                Option<&'a GpuContext>,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<T, IngestError>> + 'a>,
            > + 'static,
    ) -> Result<T, JsValue> {
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|mut doc| async move {
            let r = f(&mut doc.stack, ctx.as_deref()).await.map_err(ingest_err);
            (doc, r)
        })
        .await
    }

    /// MERGE DOWN the active layer (GPU). Returns the merged layer's index.
    #[wasm_bindgen]
    pub async fn layers_merge_down() -> Result<usize, JsValue> {
        merge_verb(|st, ctx| Box::pin(st.merge_down(ctx))).await
    }

    /// MERGE VISIBLE (GPU). Returns the merged layer's index.
    #[wasm_bindgen]
    pub async fn layers_merge_visible() -> Result<usize, JsValue> {
        merge_verb(|st, ctx| Box::pin(st.merge_visible(ctx))).await
    }

    /// STAMP VISIBLE (GPU): a new layer of the composite above the active.
    #[wasm_bindgen]
    pub async fn layers_stamp_visible() -> Result<usize, JsValue> {
        merge_verb(|st, ctx| Box::pin(st.stamp_visible(ctx))).await
    }

    /// FLATTEN IMAGE (GPU): one Background layer over white.
    #[wasm_bindgen]
    pub async fn layers_flatten() -> Result<(), JsValue> {
        merge_verb(|st, ctx| Box::pin(st.flatten(ctx))).await
    }

    /// MERGE GROUP `id` (GPU). Returns the merged layer's index.
    #[wasm_bindgen]
    pub async fn layers_merge_group(id: u32) -> Result<usize, JsValue> {
        merge_verb(move |st, ctx| Box::pin(st.merge_group(id, ctx))).await
    }

    /// LAYER VIA COPY (`cut` false) or VIA CUT from the active layer and
    /// the selection. Returns the new layer's index.
    #[wasm_bindgen]
    pub fn layers_via(cut: bool) -> Result<usize, JsValue> {
        let handle = with_stack(|d| Ok(d.handle))?;
        let sel = SELECTION
            .with(|s| s.borrow().explicit_for(handle))
            .ok_or_else(|| {
                JsValue::from_str(
                    "select an area first — Layer via Copy and Cut take the selection",
                )
            })?;
        with_stack(|d| d.stack.layer_via(&sel, cut).map_err(ingest_err))
    }

    /// NEW LAYER COMP recording visibility / position / appearance.
    #[wasm_bindgen]
    pub fn layers_comp_new(
        name: &str,
        visibility: bool,
        position: bool,
        appearance: bool,
    ) -> Result<u32, JsValue> {
        recorded_edit("New Layer Comp", None, |st| {
            Ok(st.new_comp(name, visibility, position, appearance))
        })
    }

    #[wasm_bindgen]
    pub fn layers_comp_update(id: u32) -> Result<(), JsValue> {
        recorded_edit("Update Layer Comp", None, |st| st.update_comp(id))
    }

    #[wasm_bindgen]
    pub fn layers_comp_apply(id: u32) -> Result<(), JsValue> {
        recorded_edit("Apply Layer Comp", None, |st| st.apply_comp(id))
    }

    #[wasm_bindgen]
    pub fn layers_comp_delete(id: u32) -> Result<(), JsValue> {
        recorded_edit("Delete Layer Comp", None, |st| st.delete_comp(id))
    }

    #[wasm_bindgen]
    pub fn layers_comp_rename(id: u32, name: &str) -> Result<(), JsValue> {
        recorded_edit("Rename Layer Comp", Some(format!("comp-name:{id}")), |st| {
            st.rename_comp(id, name)
        })
    }

    /// MOVE the active layer — and every layer linked with it — by whole
    /// pixels, as one undo step.
    #[wasm_bindgen]
    pub fn layers_translate(dx: i32, dy: i32) -> Result<(), JsValue> {
        with_stack(|d| {
            d.stack
                .recorded_if_changed("Move", |st| {
                    let targets = st.with_links(st.active_index());
                    st.translate(&targets, dx, dy)
                })
                .map(|_| ())
                .map_err(ingest_err)
        })
    }

    /// ALIGN the active layer and its links: `edge` left | hcenter | right |
    /// top | vcenter | bottom, `to` "canvas", "selection" (its bounds) or
    /// "layers" (the targets' joint bounds).
    #[wasm_bindgen]
    pub fn layers_align(edge: &str, to: &str) -> Result<(), JsValue> {
        let edge = crate::layers::AlignEdge::from_wire(edge).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown edge \"{edge}\" (left | hcenter | right | top | vcenter | bottom)"
            ))
        })?;
        let handle = with_stack(|d| Ok(d.handle))?;
        let sel = bound_selection(handle).and_then(|c| c.bounds());
        let to = to.to_string();
        recorded_changed("Align Layers", move |st| {
            let targets = st.with_links(st.active_index());
            let canvas = image_core::Region::new(0, 0, st.width(), st.height());
            let reference = match to.as_str() {
                "selection" => sel.ok_or_else(|| {
                    IngestError::Unsupported("there is no selection to align to".into())
                })?,
                "layers" => {
                    let boxes: Vec<image_core::Region> = targets
                        .iter()
                        .filter_map(|&i| st.content_bounds(i))
                        .collect();
                    let x0 = boxes.iter().map(|b| b.x).min().unwrap_or(0);
                    let y0 = boxes.iter().map(|b| b.y).min().unwrap_or(0);
                    let x1 = boxes.iter().map(|b| b.x + b.w as i32).max().unwrap_or(0);
                    let y1 = boxes.iter().map(|b| b.y + b.h as i32).max().unwrap_or(0);
                    image_core::Region::new(
                        x0,
                        y0,
                        (x1 - x0).max(0) as u32,
                        (y1 - y0).max(0) as u32,
                    )
                }
                "canvas" => canvas,
                other => {
                    return Err(IngestError::Unsupported(format!(
                        "unknown alignment reference \"{other}\" (canvas | selection | layers)"
                    )))
                }
            };
            st.align(&targets, edge, reference)
        })
    }

    /// DISTRIBUTE the active layer and its links (three or more) along
    /// "horizontal" or "vertical".
    #[wasm_bindgen]
    pub fn layers_distribute(axis: &str) -> Result<(), JsValue> {
        let axis = match axis {
            "horizontal" => crate::layers::Axis::Horizontal,
            "vertical" => crate::layers::Axis::Vertical,
            other => {
                return Err(JsValue::from_str(&format!(
                    "unknown axis \"{other}\" (horizontal | vertical)"
                )))
            }
        };
        recorded_changed("Distribute Layers", move |st| {
            let targets = st.with_links(st.active_index());
            st.distribute(&targets, axis)
        })
    }

    /// COMPOSITE the stack bottom-up and write the result back into the
    /// bound engine-held image, returning the straight RGBA8 (the C-1
    /// Stage-A payload). GPU-only whenever there is anything to blend; a
    /// single plain visible layer short-circuits to its own pixels with
    /// no dispatch at all, so a one-layer document needs no device.
    #[wasm_bindgen]
    pub async fn layers_composite() -> Result<js_sys::Uint8Array, JsValue> {
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|mut doc| async move {
            // A fill layer due a render gets it here, so the stored stack
            // holds what it shows.
            if let Err(e) = doc.stack.refresh_fills(ctx.as_deref()).await {
                return (doc, Err(ingest_err(e)));
            }
            let result = match doc.stack.composite_px(ctx.as_deref(), None).await {
                Ok(rgba) => {
                    let view = js_sys::Uint8Array::from(&rgba.to_rgba8()[..]);
                    set_image_pixels(doc.handle, rgba).map(|()| view)
                }
                Err(e) => Err(ingest_err(e)),
            };
            (doc, result)
        })
        .await
    }

    /// IMAGE ▸ Rotate / Flip / Canvas Size / Image Size and the crop
    /// tool's commit, over the WHOLE stack (every layer, mask and smart
    /// source moves together; see `LayerStack::transform_canvas` and
    /// `transform_canvas_gpu`). `op` is "rotate-cw", "rotate-ccw",
    /// "rotate-180", "flip-h", "flip-v", "canvas" (`width`, `height` and
    /// the anchors), "crop" (`x`, `y`, `width`, `height`; `degrees` ≠ 0
    /// straightens first), "resample" (`width`, `height`, `filter` ∈
    /// nearest | mitchell | lanczos3) or "rotate" (`degrees`, positive
    /// clockwise: the canvas grows to the rotated bounds). Unused
    /// arguments are ignored.
    ///
    /// The bound image takes the new extent and the composite IN PLACE —
    /// the handle stays. Its mip pyramid goes; the selection is dropped
    /// by a canvas resize, a crop, a straighten, an arbitrary rotation and a
    /// resample (a selection does not survive a crop, as in Photoshop); a
    /// quarter turn or a flip carries it along with the pixels. It is ONE
    /// undo step and the history before it stays: undoing it restores
    /// the extent the older steps were recorded against.
    /// Returns `[width, height]`.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn layers_canvas_op(
        op: &str,
        width: u32,
        height: u32,
        anchor_x: u8,
        anchor_y: u8,
        x: u32,
        y: u32,
        degrees: f32,
        filter: &str,
    ) -> Result<Vec<u32>, JsValue> {
        use crate::layers::{CanvasOp, ResampleFilter};
        let op = match op {
            "rotate-cw" => CanvasOp::RotateCw,
            "rotate-ccw" => CanvasOp::RotateCcw,
            "rotate-180" => CanvasOp::Rotate180,
            "flip-h" => CanvasOp::FlipHorizontal,
            "flip-v" => CanvasOp::FlipVertical,
            "canvas" => CanvasOp::Resize {
                width,
                height,
                anchor_x,
                anchor_y,
            },
            "crop" if degrees == 0.0 => CanvasOp::Crop {
                x,
                y,
                width,
                height,
            },
            "crop" => CanvasOp::Straighten {
                x,
                y,
                width,
                height,
                degrees,
            },
            // Image ▸ Image Rotation ▸ Arbitrary (positive = clockwise);
            // a quarter or half turn is the exact op.
            "rotate" => CanvasOp::rotation(degrees)
                .ok_or_else(|| JsValue::from_str("a whole turn leaves the canvas as it is"))?,
            "resample" => CanvasOp::Resample {
                width,
                height,
                filter: ResampleFilter::from_wire(filter).ok_or_else(|| {
                    JsValue::from_str(&format!(
                        "unknown resample filter \"{filter}\" (nearest | mitchell | lanczos3)"
                    ))
                })?,
            },
            other => {
                return Err(JsValue::from_str(&format!(
                    "unknown canvas operation \"{other}\" (rotate-cw | rotate-ccw | \
                     rotate-180 | flip-h | flip-v | canvas | crop | resample | rotate)"
                )))
            }
        };
        let deselect = matches!(
            op,
            CanvasOp::Crop { .. }
                | CanvasOp::Straighten { .. }
                | CanvasOp::Resample { .. }
                | CanvasOp::RotateArbitrary { .. }
        );
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|mut doc| async move {
            let result = async {
                // Refuse BEFORE changing anything when the new composite
                // could not be computed: a transformed stack over an
                // untransformed image is the state this must never leave.
                if ctx.is_none() && !doc.stack.composite_runs_without_gpu() {
                    return Err(JsValue::from_str(
                        "a canvas operation on this layered image needs a GPU (a layer \
                         style or a direct adjustment composites only there) — call \
                         init_gpu first",
                    ));
                }
                doc.stack
                    .transform_canvas_gpu(ctx.as_deref(), op)
                    .await
                    .map_err(ingest_err)?;
                // Fill layers re-render at the new extent.
                doc.stack
                    .refresh_fills(ctx.as_deref())
                    .await
                    .map_err(ingest_err)?;
                let rgba = doc
                    .stack
                    .composite_px(ctx.as_deref(), None)
                    .await
                    .map_err(ingest_err)?;
                let (w, h) = (doc.stack.width(), doc.stack.height());
                IMAGES.with(|m| {
                    let mut map = m.borrow_mut();
                    let img = map.get_mut(&doc.handle).ok_or_else(|| {
                        JsValue::from_str(&format!("unknown image handle {}", doc.handle))
                    })?;
                    img.width = w;
                    img.height = h;
                    img.rgba = rgba;
                    Ok::<(), JsValue>(())
                })?;
                PYRAMIDS.with(|p| p.borrow_mut().remove(&doc.handle));
                SELECTION.with(|s| {
                    let mut sel = s.borrow_mut();
                    if deselect {
                        sel.clear();
                    }
                    // A quarter turn or a flip moves every pixel without
                    // resampling: the selection goes with them (it used to
                    // stay where it was — over other pixels — or drop).
                    sel.follow_canvas_op(&op, doc.handle, w, h);
                });
                // The op's step keeps the selection it was taken with (undo
                // brings it back); the mirror follows the deselect now.
                doc.stack
                    .sync_selection(SELECTION.with(|s| s.borrow().coverage().cloned()));
                Ok(vec![w, h])
            }
            .await;
            (doc, result)
        })
        .await
    }

    /// The open stack as bytes for storing in the document: element 0
    /// is the manifest, the rest are the buffers it refers to by slot
    /// (`LayerStack::export`). The history is not included.
    #[wasm_bindgen]
    pub fn layers_export() -> Result<js_sys::Array, JsValue> {
        with_stack(|d| {
            let (manifest, buffers) = d.stack.export();
            let out = js_sys::Array::new();
            out.push(&js_sys::Uint8Array::from(&manifest[..]));
            for b in buffers {
                out.push(&js_sys::Uint8Array::from(&b[..]));
            }
            Ok(out)
        })
    }

    /// Replace the open stack with one stored by `layers_export`, then
    /// composite it into the bound image (on the CPU fold without a device,
    /// unless a style or a direct adjustment needs one — ADR 480). The stored extent must equal the bound
    /// image's; the history starts empty.
    #[wasm_bindgen]
    pub async fn layers_import(manifest: &[u8], buffers: js_sys::Array) -> Result<(), JsValue> {
        let bufs: Vec<Arc<[u8]>> = buffers
            .iter()
            .map(|v| Arc::from(js_sys::Uint8Array::new(&v).to_vec().into_boxed_slice()))
            .collect();
        let stack = LayerStack::import(manifest, &bufs).map_err(ingest_err)?;
        let ctx = GPU.with(|g| g.borrow().clone());
        let out = with_stack_async(|mut doc| async move {
            let result = async {
                if (stack.width(), stack.height()) != (doc.stack.width(), doc.stack.height()) {
                    return Err(JsValue::from_str(&format!(
                        "stored layers are {}×{}, the image is {}×{}",
                        stack.width(),
                        stack.height(),
                        doc.stack.width(),
                        doc.stack.height()
                    )));
                }
                if ctx.is_none() && !stack.composite_runs_without_gpu() {
                    return Err(JsValue::from_str(
                        "reopening this layered image needs a GPU (a layer style or a \
                         direct adjustment composites only there) — call init_gpu first",
                    ));
                }
                let rgba = stack
                    .composite_px(ctx.as_deref(), None)
                    .await
                    .map_err(ingest_err)?;
                set_image_pixels(doc.handle, rgba)?;
                doc.stack = stack;
                Ok(())
            }
            .await;
            (doc, result)
        })
        .await;
        note_selection(None, None);
        out
    }

    /// CONVERT a pixel layer into a smart object, preserving its pixels
    /// as the source. One-way by design: going back would discard the
    /// source, which is the destructive move this exists to prevent.
    #[wasm_bindgen]
    pub fn layers_make_smart(index: usize) -> Result<(), JsValue> {
        recorded_edit("Convert to smart object", None, |st| st.make_smart(index))
    }

    /// RE-RENDER a smart object at `scale` — from its preserved SOURCE,
    /// never from the current cache, which is the whole point: scaling
    /// down and back up loses nothing.
    ///
    /// GPU-only (the resample is a kernel dispatch). The rendered result
    /// is letterboxed into the canvas extent, so the layer keeps its
    /// place in a stack whose layers are all canvas-sized.
    #[wasm_bindgen]
    pub async fn layers_render_smart(index: usize, scale: f32) -> Result<(), JsValue> {
        // `is_finite` first, so NaN is refused by NAME rather than by the
        // side effect of failing `> 0.0`. Same verdict, but a reader no
        // longer has to reconstruct why the comparison was negated.
        if !scale.is_finite() || scale <= 0.0 || scale > 16.0 {
            return Err(JsValue::from_str(
                "smart re-render scale must be in (0, 16]",
            ));
        }
        let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
            JsValue::from_str("smart re-render is GPU-only — call init_gpu first")
        })?;

        // Read the SOURCE (not the cached render) and the canvas extent.
        let (src, cw, ch) = LAYERS
            .with(|l| {
                let b = l.borrow();
                let d = b.as_ref()?;
                let layer = d.stack.layers().get(index)?;
                let s = layer.smart_source()?;
                Some((s.clone(), d.stack.width(), d.stack.height()))
            })
            .ok_or_else(|| JsValue::from_str(&format!("layer {index} is not a smart object")))?;

        let canvas = crate::layers::render_smart(
            &ctx,
            &src,
            scale,
            crate::layers::ResampleFilter::Mitchell,
            cw,
            ch,
        )
        .await
        .map_err(ingest_err)?;

        recorded_edit("Scale smart object", None, |st| {
            st.set_smart_render(index, Arc::from(canvas.into_boxed_slice()), scale)
        })
    }

    /// Insert an ADJUSTMENT LAYER carrying the panel's current chain.
    ///
    /// The non-destructive counterpart of `layers_bake_adjust` below: the
    /// bake writes the chain into the active layer's pixels and journals
    /// it; this stacks the chain ABOVE and touches no pixel at all, so
    /// deleting the layer restores the original exactly. Same wire block
    /// so the two can never disagree about what the panel meant.
    ///
    /// Refuses at identity — an adjustment layer that adjusts nothing is
    /// a row that does nothing, and adding one silently is worse than
    /// saying so.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub fn layers_add_adjustment(
        name: &str,
        exposure_ev: f32,
        brightness: f32,
        contrast: f32,
        saturation: f32,
        temp: f32,
        tint: f32,
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
        curve_lut: &[u8],
        blur_sigma: f32,
        sharpen_amount: f32,
        hue_degrees: f32,
        invert: bool,
        ext: &[f32],
    ) -> Result<usize, JsValue> {
        let params = build_adjust_params(
            exposure_ev,
            brightness,
            contrast,
            saturation,
            temp,
            tint,
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
            curve_lut,
            blur_sigma,
            sharpen_amount,
            hue_degrees,
            invert,
            ext,
        )?;
        if params.is_identity() {
            return Err(JsValue::from_str(
                "nothing to stack — the adjustment chain is at identity",
            ));
        }
        recorded_edit("New adjustment layer", None, |st| {
            Ok(st.add_adjustment(name, params))
        })
    }

    /// EDIT an adjustment layer's chain in place (same arguments as
    /// `layers_add_adjustment`, after the layer index). Identity is
    /// allowed here — an edited layer may be dialled back to nothing.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub fn layers_set_adjustment(
        index: usize,
        exposure_ev: f32,
        brightness: f32,
        contrast: f32,
        saturation: f32,
        temp: f32,
        tint: f32,
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
        curve_lut: &[u8],
        blur_sigma: f32,
        sharpen_amount: f32,
        hue_degrees: f32,
        invert: bool,
        ext: &[f32],
    ) -> Result<(), JsValue> {
        let params = build_adjust_params(
            exposure_ev,
            brightness,
            contrast,
            saturation,
            temp,
            tint,
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
            curve_lut,
            blur_sigma,
            sharpen_amount,
            hue_degrees,
            invert,
            ext,
        )?;
        recorded_edit("Adjustment", Some(format!("adjust:{index}")), |st| {
            st.set_adjustment(index, params)
        })
    }

    /// BAKE the adjustment chain into the ACTIVE layer — the DESTRUCTIVE
    /// per-layer adjustment (the panel's chain is otherwise a re-runnable
    /// PREVIEW of the composite and mutates nothing). Journaled over the
    /// whole canvas, so it is undoable; refuses on a locked layer and at
    /// identity. Arguments mirror `adjust_image_ext` minus the handle.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn layers_bake_adjust(
        exposure_ev: f32,
        brightness: f32,
        contrast: f32,
        saturation: f32,
        temp: f32,
        tint: f32,
        in_black: f32,
        in_white: f32,
        gamma: f32,
        out_black: f32,
        out_white: f32,
        curve_lut: &[u8],
        blur_sigma: f32,
        sharpen_amount: f32,
        hue_degrees: f32,
        invert: bool,
        ext: &[f32],
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let params = build_adjust_params(
            exposure_ev,
            brightness,
            contrast,
            saturation,
            temp,
            tint,
            in_black,
            in_white,
            gamma,
            out_black,
            out_white,
            curve_lut,
            blur_sigma,
            sharpen_amount,
            hue_degrees,
            invert,
            ext,
        )?;
        let ctx = GPU.with(|g| g.borrow().clone());
        let sel = LAYERS.with(|l| {
            l.borrow()
                .as_ref()
                .and_then(|d| SELECTION.with(|s| s.borrow().mask_for(d.handle)))
        });
        with_stack_async(|mut doc| async move {
            let result = bake_into_active(&mut doc, ctx.as_deref(), params, sel).await;
            (doc, result)
        })
        .await
    }

    /// The bake's body (split out so the stack is owned, not borrowed,
    /// across the awaits).
    async fn bake_into_active(
        doc: &mut LayerDoc,
        ctx: Option<&GpuContext>,
        params: AdjustParams,
        selection: Option<Arc<SelectionCoverage>>,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        doc.stack.active_is_editable().map_err(ingest_err)?;
        if params.is_identity() {
            return Err(JsValue::from_str(
                "nothing to bake — the adjustment chain is at identity",
            ));
        }
        let ctx = ctx.ok_or_else(|| {
            JsValue::from_str("baking an adjustment is GPU-only — call init_gpu first")
        })?;
        let (w, h) = (doc.stack.width(), doc.stack.height());
        let src = DecodedImage {
            width: w,
            height: h,
            rgba: doc.stack.active().rgba.canvas().clone(),
            // Same: the active layer's pixels are post-ingest.
            display: crate::display::DisplayTreatment::AssumedSrgb,
            depth_reduced: false,
        };
        // At the layer's depth: a 16-bit layer bakes at 16 bits.
        let out = crate::ingest::adjust_px(ctx, &src, &params, selection)
            .await
            .map_err(ingest_err)?;
        doc.stack
            .edit_active("Bake adjustments", image_core::Region::new(0, 0, w, h), out)
            .map_err(ingest_err)?;
        let rgba = doc
            .stack
            .composite_px(Some(ctx), None)
            .await
            .map_err(ingest_err)?;
        let view = js_sys::Uint8Array::from(&rgba.to_rgba8()[..]);
        set_image_pixels(doc.handle, rgba)?;
        Ok(view)
    }

    /// UNDO the newest journaled pixel edit (paint / fill / bake),
    /// re-composite, and answer the reverted edit's label — an EMPTY
    /// string when there is nothing to undo. Layer STRUCTURE changes are
    /// not journaled (see the section docs).
    #[wasm_bindgen]
    pub async fn layers_undo() -> Result<String, JsValue> {
        history_step(true).await
    }

    /// REDO the newest undone pixel edit.
    #[wasm_bindgen]
    pub async fn layers_redo() -> Result<String, JsValue> {
        history_step(false).await
    }

    async fn history_step(undo: bool) -> Result<String, JsValue> {
        with_stack_async(|mut doc| async move {
            let label = if undo {
                doc.stack.undo()
            } else {
                doc.stack.redo()
            };
            let Some(label) = label else {
                return (doc, Ok(String::new()));
            };
            let result = after_history_move(&mut doc, label).await;
            (doc, result)
        })
        .await
    }

    /// After the stack moved through its history (an undo, a redo, a
    /// snapshot restore): re-composite into the bound image at the
    /// stack's extent and put the selection back.
    async fn after_history_move(doc: &mut LayerDoc, label: String) -> Result<String, JsValue> {
        let ctx = GPU.with(|g| g.borrow().clone());
        // A step taken with another selection puts it back (ADR 470)
        // — after the extent is followed below, which rebinds.
        let sel_change = doc.stack.take_selection_change();
        // Finding IMG-1: a step across a canvas operation (rotate,
        // canvas size) changes the stack's EXTENT, so the bound image
        // takes the extent with the pixels — the 4x2 image came back
        // from an undone 90 degree turn as its bytes read as 2x4.
        let (w, h) = (doc.stack.width(), doc.stack.height());
        let result = match doc.stack.composite_px(ctx.as_deref(), None).await {
            Ok(rgba) => set_image_extent(doc.handle, w, h, rgba).map(|()| label),
            Err(e) => Err(ingest_err(e)),
        };
        match sel_change {
            Some(sel) => SELECTION.with(|s| s.borrow_mut().restore(sel)),
            // A rebind may have dropped the selection: the mirror follows.
            None => doc
                .stack
                .sync_selection(SELECTION.with(|s| s.borrow().coverage().cloned())),
        }
        result
    }

    // ───────────────────────── PAINT doors ───────────────────────────
    //
    // One in-flight stroke per wasm realm, mirroring the crop tool's
    // shape: begin → extend* → commit | cancel. The engine holds the
    // base snapshot and the coverage accumulator; the glue holds only
    // pointer samples, so a stroke is replayable from a recorded action.
    //
    // HONEST SCOPE — no layer graph. A stroke paints into the SINGLE
    // engine-held image behind `handle`. There is no paint layer and
    // nothing above the photo; `brush_stroke_commit` registers a NEW
    // engine-held image (the crop / fill commit pattern) and the caller
    // swaps handles. The DOCUMENT and the source file are untouched —
    // re-ingesting the frame is the only restore this plugin owns.
    //
    // LATENCY — every `brush_stroke_extend` reads the composited window
    // back to the CPU and returns the WHOLE image as RGBA8, because the
    // C-1 Stage-A scene item takes bytes (Stage B, the resident GPU
    // texture, is deferred by ADR-018 / RFI I-01). The dirty-rectangle
    // composite keeps the GPU work proportional to the dabs, but the
    // per-extend byte copy is proportional to the IMAGE. `crate::stroke`
    // records exactly what Engine B would have to expose to remove it.

    thread_local! {
        // The single in-flight stroke (one per realm, like the selection).
        static STROKE: RefCell<Option<StrokeSession>> = const { RefCell::new(None) };
        // Whether the in-flight stroke paints the active layer's MASK
        // (fixed at begin, like every other stroke parameter).
        static STROKE_ON_MASK: Cell<bool> = const { Cell::new(false) };
        // An undo label that overrides the tool's (the magic eraser
        // commits through the eraser's stroke).
        static STROKE_LABEL: Cell<Option<&'static str>> = const { Cell::new(None) };
    }

    /// The undo step's name for a committed stroke of `tool`.
    fn stroke_label(tool: StrokeTool) -> &'static str {
        match tool {
            StrokeTool::Smudge => "Smudge",
            StrokeTool::Mixer => "Mixer Brush",
            StrokeTool::History => "History Brush",
            StrokeTool::ArtHistory => "Art History Brush",
            StrokeTool::BackgroundEraser => "Background Eraser",
            StrokeTool::ColorReplace => "Color Replacement",
            _ => "Paint",
        }
    }

    /// Run `f` on the in-flight stroke (errors when there is none).
    fn with_stroke<T>(
        f: impl FnOnce(&mut StrokeSession) -> Result<T, JsValue>,
    ) -> Result<T, JsValue> {
        STROKE.with(|s| {
            let mut slot = s.borrow_mut();
            let session = slot
                .as_mut()
                .ok_or_else(|| JsValue::from_str("no stroke in progress"))?;
            f(session)
        })
    }

    /// The BRUSH ENGINE's settings keys, newline-separated, in the order
    /// `brush_stroke_set_dynamics` reads its values. The bundle packs by
    /// NAME against this list, so a key added here never shifts another.
    #[wasm_bindgen]
    pub fn brush_dynamics_keys() -> String {
        image_gpu::dynamics::DYNAMICS_KEYS.join("\n")
    }

    /// The texture / dual-brush combine modes, newline-separated, in
    /// ordinal order.
    #[wasm_bindgen]
    pub fn brush_combine_modes() -> String {
        image_gpu::brush::CombineKind::ALL
            .iter()
            .map(|m| m.as_wire())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Freeze BRUSH SETTINGS (every pane, the paint tools' options, the
    /// stroke's seed) into the in-flight stroke: `values[i]` is
    /// `brush_dynamics_keys()[i]`. Call between begin and the first
    /// extend. A smudge / mixer stroke that samples all layers reads the
    /// composite as it is now.
    #[wasm_bindgen]
    pub fn brush_stroke_set_dynamics(values: Vec<f32>) -> Result<(), JsValue> {
        let d = image_gpu::dynamics::BrushDynamics::from_values(&values);
        let composite = STROKE.with(|s| {
            s.borrow().as_ref().and_then(|session| {
                let t = session.params().tool;
                let all = (t == StrokeTool::Smudge && d.tools.smudge_sample_all)
                    || (t == StrokeTool::Mixer && d.tools.mixer_sample_all);
                all.then(|| session.handle())
            })
        });
        let composite = composite.and_then(|h| IMAGES.with(|m| m.borrow().get(&h).cloned()));
        with_stroke(|session| {
            session.set_dynamics(d);
            if let Some(img) = composite {
                let rgba: Arc<[u8]> =
                    Arc::from(img.rgba.to_rgba8().into_owned().into_boxed_slice());
                session.set_alt_source(rgba).map_err(ingest_err)?;
            }
            Ok(())
        })
    }

    fn tip_from(w: u32, h: u32, alpha: Vec<u8>) -> Result<Option<image_gpu::SampledTip>, JsValue> {
        if w == 0 || h == 0 {
            return Ok(None);
        }
        image_gpu::SampledTip::new(w, h, alpha)
            .map(Some)
            .ok_or_else(|| JsValue::from_str("tip bitmap: w × h does not match its bytes"))
    }

    /// The SAMPLED TIP for the in-flight stroke: a `w × h` coverage
    /// bitmap (255 = paint). `w = 0` returns to the computed tip.
    #[wasm_bindgen]
    pub fn brush_stroke_set_tip_bitmap(w: u32, h: u32, alpha: Vec<u8>) -> Result<(), JsValue> {
        let tip = tip_from(w, h, alpha)?;
        with_stroke(|session| {
            session.set_tip_bitmap(tip);
            Ok(())
        })
    }

    /// The DUAL BRUSH's sampled tip (`w = 0`: its computed tip).
    #[wasm_bindgen]
    pub fn brush_stroke_set_dual_bitmap(w: u32, h: u32, alpha: Vec<u8>) -> Result<(), JsValue> {
        let tip = tip_from(w, h, alpha)?;
        with_stroke(|session| {
            session.set_dual_bitmap(tip);
            Ok(())
        })
    }

    /// The TEXTURE: an engine-held image (the defined pattern) as the
    /// brush texture of the in-flight stroke.
    #[wasm_bindgen]
    pub fn brush_stroke_set_texture_image(handle: u32) -> Result<(), JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let rgba: Arc<[u8]> = Arc::from(img.rgba.to_rgba8().into_owned().into_boxed_slice());
        with_stroke(|session| {
            session
                .set_texture_source(img.width, img.height, rgba)
                .map_err(ingest_err)
        })
    }

    /// The HISTORY STATE the in-flight History / Art History stroke paints
    /// from: `open` (the active layer as opened — before its first edit
    /// this session), `previous` (before its newest edit), `step:<id>`
    /// (right after that undo or redo step) or `snapshot:<id>` (a named
    /// snapshot; ADR 477). Errors for any other tool, without a layer
    /// stack, or when the state no longer fits (another canvas size, a
    /// step no longer held, a layer that did not exist then).
    #[wasm_bindgen]
    pub fn brush_stroke_set_history_source(kind: &str) -> Result<(), JsValue> {
        let kind = crate::layers::HistoryKind::from_wire(kind).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown history state \"{kind}\" (open | previous | step:<id> | snapshot:<id>)"
            ))
        })?;
        let handle = with_stroke(|session| {
            if !session.params().tool.reads_history() {
                return Err(JsValue::from_str(
                    "only the history and art history brushes read a history state",
                ));
            }
            Ok(session.handle())
        })?;
        let src = LAYERS.with(|l| {
            l.borrow()
                .as_ref()
                .filter(|d| d.handle == handle)
                .map(|d| d.stack.history_source(kind))
        });
        let src = match src {
            None => {
                return Err(JsValue::from_str(
                    "the history brush paints a layer's earlier state, and this image has no layer stack",
                ))
            }
            Some(None) => {
                return Err(JsValue::from_str(
                    "that history state no longer fits: the canvas changed size, the step is no longer held, or the active layer has no pixels in it",
                ))
            }
            Some(Some(px)) => px,
        };
        with_stroke(|session| session.set_alt_source(src).map_err(ingest_err))
    }

    /// MAGIC ERASER: erase the colour region at `(x, y)` to transparency
    /// on the ACTIVE layer, in one undo step. The region is the magic
    /// wand's (`tolerance` 0–255 per channel, `contiguous`), read from
    /// the active layer or with `sample_all` from the composite;
    /// `antialias` softens its edge by a 0.6 px feather; `opacity` 0–1
    /// scales the erase. The current selection clips it.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn magic_erase(
        handle: u32,
        x: u32,
        y: u32,
        tolerance: u8,
        antialias: bool,
        contiguous: bool,
        sample_all: bool,
        opacity: f32,
    ) -> Result<DecodedHandle, JsValue> {
        let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
            JsValue::from_str("the magic eraser is GPU-only — call init_gpu first")
        })?;
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        if x >= img.width || y >= img.height {
            return Err(JsValue::from_str(&format!(
                "magic eraser click ({x},{y}) outside {}×{}",
                img.width, img.height
            )));
        }
        let layer = LAYERS.with(|l| {
            l.borrow()
                .as_ref()
                .filter(|d| d.handle == handle)
                .map(|d| d.stack.active().rgba.canvas().to_rgba8().into_owned())
        });
        let source = match (sample_all, layer) {
            (false, Some(px)) => px,
            _ => img.rgba.to_rgba8().into_owned(),
        };
        let mut field = SelectionCoverage::magic_wand(
            img.width, img.height, &source, x, y, tolerance, contiguous,
        );
        if antialias {
            field.feather(0.6);
        }
        brush_stroke_begin(
            handle,
            "eraser",
            1.0,
            1.0,
            opacity,
            1.0,
            0.25,
            "normal",
            vec![0.0, 0.0, 0.0, 1.0],
            "none",
        )?;
        let mut session = STROKE
            .with(|s| s.borrow_mut().take())
            .ok_or_else(|| JsValue::from_str("internal: the magic eraser's stroke did not open"))?;
        let painted = session.paint_field(&ctx, &field).await;
        STROKE.with(|s| *s.borrow_mut() = Some(session));
        if let Err(e) = painted {
            brush_stroke_cancel();
            return Err(JsValue::from_str(&e.to_string()));
        }
        STROKE_LABEL.with(|l| l.set(Some("Magic Eraser")));
        brush_stroke_commit().await
    }

    /// DEFINE BRUSH PRESET: the selection's pixels (the whole image when
    /// nothing is selected) as a brush-tip bitmap — `[w, h]` as two
    /// little-endian u32, then `w·h` coverage bytes. Coverage is
    /// Photoshop's rule: dark paints, white does not, transparent does
    /// not (`(255 − luma) · alpha`), times the selection's own coverage.
    /// Read from the composite; at most 2500 px a side.
    #[wasm_bindgen]
    pub fn brush_tip_from_selection(handle: u32) -> Result<Vec<u8>, JsValue> {
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let sel = SELECTION.with(|s| s.borrow().mask_for(handle));
        let rgba = img.rgba.to_rgba8();
        let out = crate::stroke::tip_from_pixels(img.width, img.height, &rgba, sel.as_deref())
            .ok_or_else(|| {
                JsValue::from_str(
                    "nothing to define a brush from — the selection is empty, or the area is \
                     blank (white or transparent everywhere)",
                )
            })?;
        Ok(out)
    }

    /// BEGIN a stroke on the engine-held image `handle`.
    ///
    /// `tool` ∈ `brush | pencil | eraser`; `blend` is a `compose.*`
    /// kernel name with the prefix optional (`"multiply"` or
    /// `"compose.multiply"`); `pressure_target` ∈
    /// `none | size | opacity | both` selects what the pen's pressure
    /// drives (default `both` — size AND opacity, the Photoshop pen
    /// preset). `color` is 4 straight RGBA floats in `[0, 1]`.
    ///
    /// PRESSURE, honestly: `PointerEvent.pressure` is a constant `0.5`
    /// for a mouse and a real reading only for a pen. The CALLER
    /// normalizes — the glue passes `1.0` for a mouse so a mouse stroke
    /// is not permanently half-size — and this door takes whatever it is
    /// given verbatim so a recorded stroke replays identically.
    ///
    /// Parameters are FROZEN for the stroke's duration: a stroke whose
    /// size changed halfway through would not be replayable.
    /// GPU-only — rejects without `init_gpu`.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub fn brush_stroke_begin(
        handle: u32,
        tool: &str,
        size: f32,
        hardness: f32,
        opacity: f32,
        flow: f32,
        spacing: f32,
        blend: &str,
        color: Vec<f32>,
        pressure_target: &str,
    ) -> Result<(), JsValue> {
        let tool = StrokeTool::from_wire(tool).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown paint tool \"{tool}\" \
                 (brush | pencil | eraser | clone | heal | dodge | burn | sponge | blur | sharpen | spot-heal \
                 | smudge | mixer | history | art-history | background-eraser | color-replace)"
            ))
        })?;
        let blend_kernel = blend_kernel(blend).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown blend mode \"{blend}\" (a compose.* kernel name)"
            ))
        })?;
        let pressure = PressureTarget::from_wire(pressure_target).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown pressure target \"{pressure_target}\" \
                 (none | size | opacity | both)"
            ))
        })?;
        if color.len() != 4 {
            return Err(JsValue::from_str(
                "brush colour must be 4 floats (straight RGBA in [0,1])",
            ));
        }
        let img = IMAGES
            .with(|m| m.borrow().get(&handle).cloned())
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        if !gpu_ready() {
            return Err(JsValue::from_str(
                "painting is GPU-only — call init_gpu first (the dab composite \
                 is a registered WGSL kernel dispatch; no CPU blend path ships)",
            ));
        }
        let params = StrokeParams {
            tool,
            size,
            hardness,
            opacity,
            flow,
            spacing,
            blend: blend_kernel,
            color: [color[0], color[1], color[2], color[3]],
            pressure,
        };
        // The selection is frozen at begin — a stroke never half-honours
        // a selection that changed mid-drag.
        let sel = SELECTION.with(|s| s.borrow().mask_for(handle));
        // THE LAYER GRAPH: when a stack is bound to this handle the
        // stroke opens on its ACTIVE LAYER, so paint lands there and the
        // layers below and above are untouched. Without a stack it opens
        // on the engine-held image (the pre-layer behaviour, kept so the
        // doors stay usable on their own).
        //
        // THE EDIT TARGET: when the active layer's MASK is the target the
        // stroke opens on the mask as an opaque grey plate instead, with
        // its paint re-aimed at a mask (`StrokeParams::for_mask_target`),
        // and the commit writes the result back into the mask.
        let base = LAYERS.with(|l| {
            let b = l.borrow();
            match b.as_ref() {
                Some(d) if d.handle == handle => {
                    d.stack.active_is_editable()?;
                    if d.stack.edit_target_is_mask() {
                        Ok(d.stack.active_mask_as_grey().map(|g| (g, true)))
                    } else {
                        Ok(Some((d.stack.active().rgba.raw_arc(), false)))
                    }
                }
                _ => Ok(None),
            }
        });
        let base: Option<(Arc<[u8]>, bool)> = base.map_err(ingest_err)?;
        let on_mask = base.as_ref().is_some_and(|(_, m)| *m);
        let params = if on_mask {
            params.for_mask_target()
        } else {
            params
        };
        let base = base.map(|(px, _)| px);
        let session = match base {
            Some(px) => StrokeSession::begin_on(handle, img.width, img.height, px, params, sel),
            None => StrokeSession::begin(handle, &img, params, sel),
        }
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        STROKE.with(|s| *s.borrow_mut() = Some(session));
        STROKE_ON_MASK.with(|m| m.set(on_mask));
        Ok(())
    }

    /// EXTEND the stroke with one pointer sample (image px + normalized
    /// pressure) and return the resulting straight RGBA8 for the WHOLE
    /// image — the C-1 Stage-A preview payload.
    ///
    /// Dabs are interpolated from the previous sample at
    /// `spacing · diameter` px of arc length (the residual carries across
    /// samples), so a fast drag paints a continuous stroke rather than
    /// one dot per pointer event. Only the dirty rectangle is
    /// re-composited, always FROM the base pixels, so extending is
    /// idempotent and the incremental result equals a from-scratch
    /// composite of the same samples.
    #[wasm_bindgen]
    pub async fn brush_stroke_extend(x: f32, y: f32, pressure: f32) -> Result<Vec<u8>, JsValue> {
        extend_with(image_gpu::dynamics::PenSample::at(x, y, pressure)).await
    }

    /// EXTEND with everything a PEN reports — the brush engine's door
    /// (`brush_stroke_extend` is this with no tilt, no rotation and the
    /// wheel at full). `tilt_x` / `tilt_y` in degrees −90..90 (Pointer
    /// Events), `rotation` the barrel twist in degrees 0..360, `wheel`
    /// the airbrush wheel 0..1. Taken verbatim, so a recorded stroke
    /// replays identically.
    #[wasm_bindgen]
    #[allow(clippy::too_many_arguments)]
    pub async fn brush_stroke_extend_pen(
        x: f32,
        y: f32,
        pressure: f32,
        tilt_x: f32,
        tilt_y: f32,
        rotation: f32,
        wheel: f32,
    ) -> Result<Vec<u8>, JsValue> {
        extend_with(image_gpu::dynamics::PenSample {
            x,
            y,
            pressure,
            tilt_x,
            tilt_y,
            rotation,
            wheel,
        })
        .await
    }

    async fn extend_with(pen: image_gpu::dynamics::PenSample) -> Result<Vec<u8>, JsValue> {
        let ctx = GPU
            .with(|g| g.borrow().clone())
            .ok_or_else(|| JsValue::from_str("painting is GPU-only — call init_gpu first"))?;
        // The session is taken out for the await (no RefCell across a
        // suspension point) and put back after.
        let mut session = STROKE
            .with(|s| s.borrow_mut().take())
            .ok_or_else(|| JsValue::from_str("no stroke in progress (brush_stroke_begin first)"))?;
        let result = session.extend_pen(&ctx, pen).await;
        let handle = session.handle();
        // Shared, not copied: the stroke copies on its next write only if
        // the fold still holds this handle.
        let painted = session.pixels_arc();
        STROKE.with(|s| *s.borrow_mut() = Some(session));
        result.map_err(|e| JsValue::from_str(&e.to_string()))?;
        // The preview is the WHOLE stack with the in-flight stroke
        // standing in for the active layer — otherwise painting on a
        // layer above the photo would preview as that layer alone. The
        // stack is NOT mutated; nothing is committed until release.
        // A one-layer document takes the trivial fold, which returns the
        // painted pixels themselves — the pre-layer latency, unchanged.
        let preview = if STROKE_ON_MASK.with(Cell::get) {
            preview_mask_through_stack(painted).await?
        } else {
            preview_through_stack(handle, painted).await?
        };
        Ok(preview.to_vec())
    }

    /// The preview of a MASK stroke: the stack folded with the painted
    /// grey plate standing in for the active layer's mask.
    async fn preview_mask_through_stack(painted: Arc<[u8]>) -> Result<Arc<[u8]>, JsValue> {
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|mut doc| async move {
            let (w, h) = (doc.stack.width(), doc.stack.height());
            let out = match crate::layers::mask_from_grey(w, h, &painted) {
                Some(mask) => doc
                    .stack
                    .composite_with_active_mask(ctx.as_deref(), Arc::new(mask))
                    .await
                    .map_err(ingest_err),
                None => Err(JsValue::from_str("internal: mask stroke is mis-sized")),
            };
            (doc, out)
        })
        .await
    }

    /// Fold the bound stack with `painted` overriding the active layer.
    /// No stack (or one bound to another handle) ⇒ the painted pixels.
    async fn preview_through_stack(handle: u32, painted: Arc<[u8]>) -> Result<Arc<[u8]>, JsValue> {
        let bound = LAYERS.with(|l| l.borrow().as_ref().map(|d| d.handle)) == Some(handle);
        if !bound {
            return Ok(painted);
        }
        let ctx = GPU.with(|g| g.borrow().clone());
        with_stack_async(|doc| async move {
            // The stroke paints 8-bit; the fold takes the override at
            // its own depth beside 16-bit layers.
            let painted = crate::pixels::Pixels::from_rgba8(painted);
            let out = doc
                .stack
                .composite(ctx.as_deref(), Some(&painted))
                .await
                .map_err(ingest_err);
            (doc, out)
        })
        .await
    }

    /// COMMIT the stroke.
    ///
    /// * **With a layer stack bound** (the normal case): the painted
    ///   pixels are written into the ACTIVE LAYER, the tiles the stroke's
    ///   bounding box covers are journaled first (so the stroke is
    ///   undoable, tile-granularly, within the journal's stated bound),
    ///   and the stack is re-composited into the SAME engine-held image.
    ///   The returned handle is therefore the handle you started with —
    ///   the caller must NOT free it.
    /// * **Without one**: the pre-layer behaviour — the painted pixels
    ///   are registered as a NEW engine-held image and the caller swaps
    ///   handles and frees the old one.
    ///
    /// Either way the result is the same size, so the caller may carry
    /// the selection over with `selection_transfer`.
    /// The rectangle the last `brush_stroke_extend` changed, as
    /// `[x, y, w, h]` in image px (empty when it painted nothing) — what a
    /// host that takes tiles needs to resend instead of the whole preview.
    #[wasm_bindgen]
    pub fn brush_stroke_dirty_rect() -> Vec<u32> {
        STROKE.with(|s| {
            s.borrow()
                .as_ref()
                .and_then(|session| session.last_dirty())
                .map(|r| vec![r.x.max(0) as u32, r.y.max(0) as u32, r.w, r.h])
                .unwrap_or_default()
        })
    }

    /// Point the IN-FLIGHT clone/heal stroke at its source (the
    /// alt-click anchor), in image px.
    ///
    /// Must be called between `brush_stroke_begin` and the first
    /// `brush_stroke_extend`: the source offset is fixed at the first
    /// dab, because an offset that moved mid-stroke would smear the copy
    /// instead of translating it. Calling it for a non-sampling tool is
    /// an ERROR rather than a no-op — silently accepting it would let a
    /// caller believe the brush was cloning.
    #[wasm_bindgen]
    pub fn brush_stroke_set_source(x: f32, y: f32, aligned: bool) -> Result<(), JsValue> {
        STROKE.with(|s| {
            let mut slot = s.borrow_mut();
            let session = slot
                .as_mut()
                .ok_or_else(|| JsValue::from_str("no stroke in progress"))?;
            if !session.params().tool.takes_source() {
                return Err(JsValue::from_str(
                    "only the clone and heal tools read from a source (the spot \
                     healing brush finds its own)",
                ));
            }
            session.set_clone_source(crate::stroke::CloneSource { x, y, aligned });
            Ok(())
        })
    }

    /// Set the IN-FLIGHT dodge / burn / sponge stroke's options:
    /// `range` ∈ `shadows | midtones | highlights` and `exposure` 0–1 for
    /// dodge and burn; `saturate` picks the sponge's direction (false =
    /// desaturate). Call between `brush_stroke_begin` and the first
    /// extend — the options are frozen with the stroke. An error for any
    /// other tool, so a caller cannot believe a brush is dodging.
    #[wasm_bindgen]
    pub fn brush_stroke_set_tone(
        range: &str,
        exposure: f32,
        saturate: bool,
    ) -> Result<(), JsValue> {
        let range = crate::stroke::ToneRange::from_wire(range).ok_or_else(|| {
            JsValue::from_str(&format!(
                "unknown tonal range \"{range}\" (shadows | midtones | highlights)"
            ))
        })?;
        STROKE.with(|s| {
            let mut slot = s.borrow_mut();
            let session = slot
                .as_mut()
                .ok_or_else(|| JsValue::from_str("no stroke in progress"))?;
            if !session.params().tool.takes_tone() {
                return Err(JsValue::from_str(
                    "only the dodge, burn and sponge tools take tone options",
                ));
            }
            session.set_tone(crate::stroke::ToneOptions {
                range,
                exposure,
                saturate,
            });
            Ok(())
        })
    }

    #[wasm_bindgen]
    pub async fn brush_stroke_commit() -> Result<DecodedHandle, JsValue> {
        let mut session = STROKE
            .with(|s| s.borrow_mut().take())
            .ok_or_else(|| JsValue::from_str("no stroke in progress"))?;
        // CATCH-UP AT END: a smoothed stroke lands on the pointer first.
        if let Some(ctx) = GPU.with(|g| g.borrow().clone()) {
            session
                .finish(&ctx)
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
        }
        let label = STROKE_LABEL
            .with(|l| l.take())
            .unwrap_or_else(|| stroke_label(session.params().tool));
        // The SPOT HEALING BRUSH deposits nothing while it is dragged; its
        // source is found and its heal composited here, on release.
        if session.params().tool == StrokeTool::SpotHeal {
            let ctx = GPU.with(|g| g.borrow().clone()).ok_or_else(|| {
                JsValue::from_str("the spot healing brush is GPU-only — call init_gpu first")
            })?;
            let healed = session
                .resolve_spot_heal(&ctx)
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            // No source cleared the hole: nothing is committed, so the
            // stroke costs no undo step and claims no paint.
            if !healed {
                return Err(JsValue::from_str(
                    "the spot healing brush found no source near the stroke that \
                     clears it, so nothing was healed — try a shorter stroke, or the \
                     healing brush with an Alt-click source",
                ));
            }
        }
        let (w, h) = (session.width(), session.height());
        let handle = session.handle();
        let bounds = session.stroke_bounds();
        let painted = session.commit();

        let bound = LAYERS.with(|l| l.borrow().as_ref().map(|d| d.handle)) == Some(handle);
        if !bound {
            return register(w, h, painted);
        }
        // Nothing landed on the canvas: no journal entry, no composite,
        // no change (an empty entry would spend an undo step on nothing).
        let Some(damage) = bounds else {
            return Ok(DecodedHandle {
                handle,
                width: w,
                height: h,
                // A no-op stroke commit leaves the treatment as it was.
                display: read_display(handle),
                depth_reduced: read_depth_reduced(handle),
            });
        };
        let ctx = GPU.with(|g| g.borrow().clone());
        let on_mask = STROKE_ON_MASK.with(|m| m.replace(false));
        let pixels: Arc<[u8]> = Arc::from(painted.into_boxed_slice());
        with_stack_async(|mut doc| async move {
            let result = if on_mask {
                commit_mask_stroke(&mut doc, ctx.as_deref(), damage, &pixels).await
            } else {
                commit_stroke_into_active(&mut doc, ctx.as_deref(), damage, pixels, label).await
            };
            (doc, result)
        })
        .await
    }

    async fn commit_stroke_into_active(
        doc: &mut LayerDoc,
        ctx: Option<&GpuContext>,
        damage: image_core::Region,
        pixels: Arc<[u8]>,
        label: &'static str,
    ) -> Result<DecodedHandle, JsValue> {
        let (w, h) = (doc.stack.width(), doc.stack.height());
        doc.stack
            .edit_active(label, damage, pixels.into())
            .map_err(ingest_err)?;
        let rgba = doc
            .stack
            .composite_px(ctx, None)
            .await
            .map_err(ingest_err)?;
        set_image_pixels(doc.handle, rgba)?;
        Ok(DecodedHandle {
            handle: doc.handle,
            width: w,
            height: h,
            // The stroke composite writes back into the same image.
            display: read_display(doc.handle),
            depth_reduced: read_depth_reduced(doc.handle),
        })
    }

    /// [`commit_stroke_into_active`] for a MASK stroke: the painted grey
    /// plate becomes the active layer's mask, journaled under the mask's
    /// scope (one undo step, on the same undo list as everything else).
    async fn commit_mask_stroke(
        doc: &mut LayerDoc,
        ctx: Option<&GpuContext>,
        damage: image_core::Region,
        grey: &[u8],
    ) -> Result<DecodedHandle, JsValue> {
        let (w, h) = (doc.stack.width(), doc.stack.height());
        let mask = crate::layers::mask_from_grey(w, h, grey)
            .ok_or_else(|| JsValue::from_str("internal: mask stroke is mis-sized"))?;
        doc.stack
            .edit_active_mask("Paint mask", damage, mask)
            .map_err(ingest_err)?;
        let rgba = doc
            .stack
            .composite_px(ctx, None)
            .await
            .map_err(ingest_err)?;
        set_image_pixels(doc.handle, rgba)?;
        Ok(DecodedHandle {
            handle: doc.handle,
            width: w,
            height: h,
            display: read_display(doc.handle),
            depth_reduced: read_depth_reduced(doc.handle),
        })
    }

    /// CANCEL the stroke: throw the painted pixels away. The engine-held
    /// source was never mutated, so this restores it exactly.
    /// PEN UP inside the stroke in flight: the next sample starts a new
    /// run (a dab where it lands, no segment from the last one) but the
    /// stroke — and its one undo step — goes on. Stroke Path strokes
    /// every subpath of a path as one stroke this way (ADR 476).
    #[wasm_bindgen]
    pub fn brush_stroke_lift() -> Result<(), JsValue> {
        with_stroke(|st| {
            st.lift();
            Ok(())
        })
    }

    #[wasm_bindgen]
    pub fn brush_stroke_cancel() {
        STROKE.with(|s| *s.borrow_mut() = None);
        channel_clear_preview();
        STROKE_ON_MASK.with(|m| m.set(false));
        STROKE_LABEL.with(|l| l.set(None));
    }

    /// Is a stroke in progress?
    #[wasm_bindgen]
    pub fn brush_stroke_active() -> bool {
        STROKE.with(|s| s.borrow().is_some())
    }

    /// The in-flight stroke's readout for the panel:
    /// `[dabs, x, y, w, h]` — the dab count and the stroke's bounding
    /// box in image px. Empty when no stroke is in progress or nothing
    /// has landed on the canvas yet.
    #[wasm_bindgen]
    pub fn brush_stroke_stats() -> Vec<f64> {
        STROKE.with(|s| {
            let b = s.borrow();
            let Some(session) = b.as_ref() else {
                return Vec::new();
            };
            let Some(r) = session.stroke_bounds() else {
                return Vec::new();
            };
            vec![
                session.dab_count() as f64,
                r.x as f64,
                r.y as f64,
                r.w as f64,
                r.h as f64,
            ]
        })
    }

    /// Every blend mode a stroke can paint through, newline-separated —
    /// derived from the `compose.*` registry so the panel's picker can
    /// never drift from the kernels that actually exist.
    #[wasm_bindgen]
    pub fn brush_blend_modes() -> String {
        blend_names().join("\n")
    }

    // ──────────────────────── SAVE-BACK doors ────────────────────────

    /// Re-encode straight RGBA8 as PNG or JPEG (`format` ∈ `png | jpeg`)
    /// — the NON-PSD save-back lane. Codec entropy coding is inherently
    /// CPU work (spec §1); JPEG rides the fixed v0 quality documented on
    /// `saveback::JPEG_QUALITY_DEFAULT`.
    #[wasm_bindgen]
    pub fn encode_image(
        rgba: &[u8],
        width: u32,
        height: u32,
        format: &str,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let fmt = RasterFormat::from_wire(format)
            .ok_or_else(|| JsValue::from_str(&format!("unknown encode format \"{format}\"")))?;
        let bytes = encode_rgba8(rgba, width, height, fmt)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(js_sys::Uint8Array::from(&bytes[..]))
    }

    /// [`encode_image`] with the two knobs it has not got: a JPEG
    /// `quality` (the plain door rides a fixed 90), and a LOSSLESS
    /// channel reduction for PNG.
    ///
    /// `reduce` is not a quality setting. It re-expresses a buffer that
    /// was ALREADY greyscale in a layout that says so — one byte per
    /// pixel instead of four when the alpha is constant-opaque, two
    /// when it is not — so the decoded pixels come back identical byte
    /// for byte. It pays on exactly the images that tend to be large
    /// and greyscale: scans, masks, line art, alpha mattes. On a colour
    /// photograph the classifier exits within a few pixels and nothing
    /// changes.
    ///
    /// What it deliberately does NOT do is drop a constant-opaque alpha
    /// to three channels, which would save a quarter of the raw bytes
    /// on every screenshot. `ChannelLayout` has no RGB arm and the type
    /// is frozen — RFI E-6.
    #[wasm_bindgen]
    pub fn encode_image_opt(
        rgba: &[u8],
        width: u32,
        height: u32,
        format: &str,
        quality: u8,
        reduce: bool,
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let fmt = RasterFormat::from_wire(format)
            .ok_or_else(|| JsValue::from_str(&format!("unknown encode format \"{format}\"")))?;
        let bytes = crate::saveback::encode_rgba8_opt(rgba, width, height, fmt, quality, reduce)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(js_sys::Uint8Array::from(&bytes[..]))
    }

    thread_local! {
        /// The notes of the last `export_image*` call (wire names).
        static EXPORT_NOTES: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
    }

    fn run_export(
        pixels: crate::export::Rgba<'_>,
        width: u32,
        height: u32,
        spec: &str,
        source: &[u8],
        cmyk_profile: &[u8],
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let mut spec =
            crate::export::ExportSpec::from_wire(spec).map_err(|e| JsValue::from_str(&e))?;
        if !cmyk_profile.is_empty() {
            spec.cmyk_profile = Some(cmyk_profile.to_vec());
        }
        let source = (!source.is_empty()).then_some(source);
        let out = crate::export::export(pixels, width, height, &spec, source)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        EXPORT_NOTES.with(|n| *n.borrow_mut() = out.notes.iter().map(|n| n.wire()).collect());
        Ok(js_sys::Uint8Array::from(&out.bytes[..]))
    }

    /// EXPORT AS (ADR 468): straight RGBA8 (`width*height*4`, the adjusted
    /// result) written as `spec` says (`export::ExportSpec::from_wire`:
    /// format, quality, size, ppi, metadata, profile, mode, bits,
    /// compression, intent). `source` is the file the session opened (its
    /// EXIF, XMP and IPTC are kept when the spec says `meta=1`; empty =
    /// none); `cmyk_profile` the CMYK output profile (empty = none). The
    /// notes are read with [`export_last_notes`].
    #[wasm_bindgen]
    pub fn export_image(
        rgba: &[u8],
        width: u32,
        height: u32,
        spec: &str,
        source: &[u8],
        cmyk_profile: &[u8],
    ) -> Result<js_sys::Uint8Array, JsValue> {
        run_export(
            crate::export::Rgba::U8(rgba),
            width,
            height,
            spec,
            source,
            cmyk_profile,
        )
    }

    /// [`export_image`] from an engine-held image, at ITS depth: a 16-bit
    /// session exports its own 16-bit samples (PNG, TIFF) instead of the
    /// 8-bit bytes the adjust door hands out.
    #[wasm_bindgen]
    pub fn export_image_handle(
        handle: u32,
        spec: &str,
        source: &[u8],
        cmyk_profile: &[u8],
    ) -> Result<js_sys::Uint8Array, JsValue> {
        let (w, h, px) = IMAGES
            .with(|m| {
                m.borrow()
                    .get(&handle)
                    .map(|i| (i.width, i.height, i.rgba.clone()))
            })
            .ok_or_else(|| JsValue::from_str(&format!("unknown image handle {handle}")))?;
        let pixels = if px.is_16bit() {
            crate::export::Rgba::U16(
                px.raw()
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|p| u16::from_ne_bytes(*p))
                    .collect(),
            )
        } else {
            let b = px.to_rgba8().into_owned();
            return run_export(
                crate::export::Rgba::U8(&b),
                w,
                h,
                spec,
                source,
                cmyk_profile,
            );
        };
        run_export(pixels, w, h, spec, source, cmyk_profile)
    }

    /// The notes of the last export, newline-separated wire names
    /// (`webp-lossless`, `cmyk-profile`, `cmyk-naive`, `widened`,
    /// `narrowed`, `alpha-dropped`, `gray-untagged`).
    #[wasm_bindgen]
    pub fn export_last_notes() -> String {
        EXPORT_NOTES.with(|n| n.borrow().join("\n"))
    }

    /// What a file carries besides its pixels, for the Export As dialog's
    /// metadata row: the byte length of its `[ICC, EXIF, XMP, IPTC]` (0 =
    /// absent).
    #[wasm_bindgen]
    pub fn image_metadata(bytes: &[u8]) -> Vec<u32> {
        let m = paged_raster::read_metadata(bytes);
        let len = |v: &Option<Vec<u8>>| v.as_ref().map_or(0, |b| b.len() as u32);
        vec![len(&m.icc), len(&m.exif), len(&m.xmp), len(&m.iptc)]
    }

    /// Write the open LAYER STACK into the retained PSD as its layers
    /// (`saveback::psd_write_stack`), with the bound image (the stack's
    /// composite) as the merged image. Refuses stacks with adjustment
    /// layers and non-8-bit-RGB files, so the caller can fall back to the
    /// flattened save. Returns the user-facing description.
    #[wasm_bindgen]
    pub fn psd_save_layers(psd_handle: u32) -> Result<String, JsValue> {
        LAYERS.with(|l| {
            let b = l.borrow();
            let doc = b
                .as_ref()
                .ok_or_else(|| JsValue::from_str("no layer stack is open"))?;
            let composite = IMAGES
                .with(|m| {
                    m.borrow()
                        .get(&doc.handle)
                        .map(|i| i.rgba.to_rgba8().into_owned())
                })
                .ok_or_else(|| JsValue::from_str("the layer stack's image is gone"))?;
            PSDS.with(|m| {
                let mut map = m.borrow_mut();
                let file = map.get_mut(&psd_handle).ok_or_else(|| {
                    JsValue::from_str(&format!("unknown psd handle {psd_handle}"))
                })?;
                let shape = crate::saveback::psd_write_stack(file, &doc.stack, &composite)
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                Ok(shape.describe().to_string())
            })
        })
    }

    /// PSD SAVE-BACK: write the ADJUSTED full-resolution `rgba` into the
    /// retained parse behind `psd_handle` (the merged composite is always
    /// rewritten; the layer structure is handled per the returned shape)
    /// and answer the honest description the panel shows —
    /// `"layer-replaced: …"` when the file's single canvas-sized content
    /// layer was updated in place via `replace_channel_pixels`, or
    /// `"flattened: …"` when a multi-layer file was flattened into a NEW
    /// single-layer PSD. Call `psd_save` afterwards for the bytes.
    ///
    /// 8-bit RGB only, and the size must match the parsed header —
    /// anything else is a clean error, never a wrong-looking file.
    #[wasm_bindgen]
    pub fn psd_apply_adjusted(
        psd_handle: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<String, JsValue> {
        PSDS.with(|m| {
            let mut map = m.borrow_mut();
            let file = map
                .get_mut(&psd_handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown psd handle {psd_handle}")))?;
            let shape = psd_write_adjusted(file, width, height, rgba)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            Ok(shape.describe().to_string())
        })
    }

    // ─────────────────────────── PSD doors ───────────────────────────
    //
    // The mutatable tier (image-psd edit.rs: opacity / rename / remove +
    // the preservation writer) was Rust-only — "Paged never destroys a
    // PSD" was a test-only property with no wasm reach (the coverage
    // spec's finding). These doors retain the PARSED PsdFile behind a
    // handle so the panel can list layers, apply record edits, and save
    // with full carry-through preservation. Pixel-level channel
    // replacement stays engine-side (its payload contract is a follow-up).

    thread_local! {
        static PSDS: RefCell<HashMap<u32, image_psd::PsdFile>> =
            RefCell::new(HashMap::new());
        static NEXT_PSD: Cell<u32> = const { Cell::new(1) };
    }

    /// Parse a `.psd`/`.psb` and retain the structural model behind a
    /// handle (independent of `decode_image`'s composite lane). Free with
    /// `psd_close`.
    #[wasm_bindgen]
    pub fn psd_open(bytes: &[u8]) -> Result<u32, JsValue> {
        let file =
            image_psd::PsdFile::parse(bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let handle = NEXT_PSD.with(|n| {
            let h = n.get();
            n.set(h + 1);
            h
        });
        PSDS.with(|m| m.borrow_mut().insert(handle, file));
        Ok(handle)
    }

    /// The layer list as JSON, in record order:
    /// `[{index, name, opacity, hidden, top, left, bottom, right}]`.
    /// `hidden` is PSD flags bit 1 (0x02).
    #[wasm_bindgen]
    pub fn psd_layer_list(handle: u32) -> Result<String, JsValue> {
        PSDS.with(|m| {
            let map = m.borrow();
            let file = map
                .get(&handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown psd handle {handle}")))?;
            let rows: Vec<String> = file
                .layer_mask
                .layers
                .iter()
                .enumerate()
                .map(|(index, l)| {
                    format!(
                        "{{\"index\":{index},\"name\":{},\"opacity\":{},\"hidden\":{},\"top\":{},\"left\":{},\"bottom\":{},\"right\":{}}}",
                        json_escape(&l.name()),
                        l.opacity,
                        (l.flags & 0x02) != 0,
                        l.top,
                        l.left,
                        l.bottom,
                        l.right,
                    )
                })
                .collect();
            Ok(format!("[{}]", rows.join(",")))
        })
    }

    /// Set a layer's opacity (0–255) through the mutatable tier.
    #[wasm_bindgen]
    pub fn psd_set_layer_opacity(handle: u32, layer: usize, opacity: u8) -> Result<(), JsValue> {
        with_psd_mut(handle, |file| {
            image_psd::edit::set_layer_opacity(file, layer, opacity)
        })
    }

    /// Rename a layer (updates the legacy Pascal name AND the canonical
    /// `luni` block).
    #[wasm_bindgen]
    pub fn psd_set_layer_name(handle: u32, layer: usize, name: &str) -> Result<(), JsValue> {
        with_psd_mut(handle, |file| {
            image_psd::edit::set_layer_name(file, layer, name)
        })
    }

    /// Remove a layer (balanced `lsct` group-divider bookkeeping engine-side).
    #[wasm_bindgen]
    pub fn psd_remove_layer(handle: u32, layer: usize) -> Result<(), JsValue> {
        with_psd_mut(handle, |file| image_psd::edit::remove_layer(file, layer))
    }

    /// Save the (possibly edited) PSD with full preservation: unmodeled
    /// blocks verbatim; a zero-edit save is byte-identical.
    #[wasm_bindgen]
    pub fn psd_save(handle: u32) -> Result<js_sys::Uint8Array, JsValue> {
        PSDS.with(|m| {
            let map = m.borrow();
            let file = map
                .get(&handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown psd handle {handle}")))?;
            let bytes = file
                .write()
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            Ok(js_sys::Uint8Array::from(&bytes[..]))
        })
    }

    #[wasm_bindgen]
    pub fn psd_close(handle: u32) {
        PSDS.with(|m| {
            m.borrow_mut().remove(&handle);
        });
    }

    /// Read a Photoshop `.abr` brush library and return its presets as
    /// JSON — the door that makes the `.abr` reader REACHABLE.
    ///
    /// Without a caller a wasm32 release build eliminates the whole
    /// parser, so this is the difference between a capability that
    /// exists in the repository and one that exists in the artifact.
    /// The projection (which parameters, and why the absent ones stay
    /// absent) lives in [`crate::brushes`], which is host-testable —
    /// `mod wasm` is `#[cfg(target_arch = "wasm32")]` and never is.
    #[wasm_bindgen]
    pub fn abr_presets(bytes: &[u8]) -> Result<String, JsValue> {
        crate::brushes::presets_json(bytes).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    // ── the Preset Manager's files (ADR 477; `crate::preset_files`) ──

    fn preset_err(e: IngestError) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    /// Photoshop `.grd` → `{gradients: [{display, gradient}], skipped}`.
    #[wasm_bindgen]
    pub fn presets_read_grd(bytes: &[u8]) -> Result<String, JsValue> {
        crate::preset_files::read_grd_json(bytes).map_err(preset_err)
    }

    /// `[gradient]` → `.grd` bytes.
    #[wasm_bindgen]
    pub fn presets_write_grd(json: &str) -> Result<Vec<u8>, JsValue> {
        crate::preset_files::write_grd_json(json).map_err(preset_err)
    }

    /// Photoshop `.pat` → `{patterns: [meta], skipped}`.
    #[wasm_bindgen]
    pub fn presets_read_pat(bytes: &[u8]) -> Result<String, JsValue> {
        crate::preset_files::read_pat_json(bytes).map_err(preset_err)
    }

    /// `.pat` → every pattern's RGBA8, in order.
    #[wasm_bindgen]
    pub fn presets_read_pat_pixels(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        crate::preset_files::read_pat_pixels(bytes).map_err(preset_err)
    }

    /// Pattern metadata and their RGBA8 → `.pat` bytes.
    #[wasm_bindgen]
    pub fn presets_write_pat(meta: &str, rgba: &[u8]) -> Result<Vec<u8>, JsValue> {
        crate::preset_files::write_pat_json(meta, rgba).map_err(preset_err)
    }

    /// Photoshop `.asl` → `{styles, patterns, skipped}`.
    #[wasm_bindgen]
    pub fn presets_read_asl(bytes: &[u8]) -> Result<String, JsValue> {
        crate::preset_files::read_asl_json(bytes).map_err(preset_err)
    }

    /// `.asl` → its patterns' RGBA8, in order.
    #[wasm_bindgen]
    pub fn presets_read_asl_pixels(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        crate::preset_files::read_asl_pixels(bytes).map_err(preset_err)
    }

    /// Style rows, pattern metadata and their RGBA8 → `.asl` bytes.
    #[wasm_bindgen]
    pub fn presets_write_asl(
        styles: &str,
        patterns: &str,
        rgba: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        crate::preset_files::write_asl_json(styles, patterns, rgba).map_err(preset_err)
    }

    /// The parity properties of one `layers_list` row (appended inside
    /// its object): fill opacity, knockout, locks, colour label, link,
    /// Blend If's 32 sliders (or null), and the kind detail.
    fn layer_parity_json(l: &crate::layers::Layer) -> String {
        let bi = l.live_blend_if().map_or_else(
            || "null".to_string(),
            |b| {
                format!(
                    "[{}]",
                    b.to_bytes()
                        .iter()
                        .map(u8::to_string)
                        .collect::<Vec<_>>()
                        .join(",")
                )
            },
        );
        format!(
            ",\"style\":[{}],\"styleOn\":{},\"styleOptions\":{},\"fillOpacity\":{},\"knockout\":\"{}\",\"locks\":{{\"transparency\":{},\"position\":{},\"all\":{}}},\"color\":\"{}\",\"link\":{},\"blendIf\":{bi},\"adjustKind\":{},\"fillKind\":{}}}",
            l.ext
                .style
                .as_ref()
                .map(|s| s
                    .enabled_keys()
                    .iter()
                    .map(|k| format!("\"{k}\""))
                    .collect::<Vec<_>>()
                    .join(","))
                .unwrap_or_default(),
            l.ext.style.as_ref().is_some_and(|s| s.enabled),
            l.ext.style_options.bits(),
            l.ext.fill_opacity,
            l.ext.knockout.as_wire(),
            l.ext.locks.transparency,
            l.ext.locks.position,
            l.ext.locks.all,
            crate::layers::COLOR_LABELS[usize::from(l.ext.color).min(7)],
            l.ext.link.map_or_else(|| "null".to_string(), |k| k.to_string()),
            l.adjustment()
                .map_or_else(|| "null".to_string(), |a| format!("\"{}\"", a.kind_name())),
            l.fill()
                .map_or_else(|| "null".to_string(), |f| format!("\"{}\"", f.source.kind_name())),
        )
        .trim_end_matches('}')
        .to_string()
            + &format!(
                ",\"vectorMask\":{}}}",
                l.ext.vector_mask.as_deref().map_or_else(
                    || "null".to_string(),
                    |v| format!(
                        "{{\"enabled\":{},\"invert\":{},\"subpaths\":{},\"anchors\":{}}}",
                        v.enabled,
                        v.invert,
                        v.subpaths.len(),
                        v.subpaths.iter().map(|s| s.anchors.len()).sum::<usize>()
                    )
                )
            )
    }

    /// The SAMPLED TIP `sample_index` of an `.abr` (a preset's
    /// `sampleIndex`) as `[w u32 LE, h u32 LE, alpha…]` — 8-bit
    /// coverage, 255 = paint; a 16-bit tip is reduced by the explicit
    /// lossy call. Stateless: the glue keeps the file's bytes.
    #[wasm_bindgen]
    pub fn abr_tip(bytes: &[u8], sample_index: u32) -> Result<Vec<u8>, JsValue> {
        crate::brushes::tip_bitmap(bytes, sample_index as usize)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    thread_local! {
        // The `.abr` export in progress (begin → add* → finish).
        static ABR_EXPORT: RefCell<Option<crate::brushes::AbrExport>> =
            const { RefCell::new(None) };
    }

    /// The per-preset values `abr_export_add` takes, newline-separated,
    /// in order — the glue packs by NAME from this list.
    #[wasm_bindgen]
    pub fn abr_export_keys() -> String {
        crate::brushes::EXPORT_KEYS.join("\n")
    }

    /// Start an `.abr` export (drops one left unfinished).
    #[wasm_bindgen]
    pub fn abr_export_begin() {
        ABR_EXPORT.with(|e| *e.borrow_mut() = Some(Default::default()));
    }

    /// Add one preset: `values` in `abr_export_keys` order; `w`/`h`/
    /// `alpha` its sampled tip, or `w = h = 0` for the round tip.
    #[wasm_bindgen]
    pub fn abr_export_add(
        name: &str,
        values: Vec<f32>,
        w: u32,
        h: u32,
        alpha: Vec<u8>,
    ) -> Result<(), JsValue> {
        ABR_EXPORT.with(|e| {
            let mut slot = e.borrow_mut();
            let export = slot
                .as_mut()
                .ok_or_else(|| JsValue::from_str("no export in progress (abr_export_begin)"))?;
            let bitmap = (w > 0 && h > 0).then_some((w, h, &alpha[..]));
            export
                .add(name, &values, bitmap)
                .map_err(|m| JsValue::from_str(&m))
        })
    }

    /// Finish the export: the `.abr` bytes (version 6.2).
    #[wasm_bindgen]
    pub fn abr_export_finish() -> Result<Vec<u8>, JsValue> {
        ABR_EXPORT.with(|e| {
            e.borrow_mut()
                .take()
                .map(|x| x.finish())
                .ok_or_else(|| JsValue::from_str("no export in progress (abr_export_begin)"))
        })
    }

    /// Minimal JSON string escape (quotes, backslash, control chars) —
    /// avoids a serde_json dependency for one field.
    fn json_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    out.push_str(&format!("\\u{:04x}", c as u32));
                }
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    fn with_psd_mut<F>(handle: u32, f: F) -> Result<(), JsValue>
    where
        F: FnOnce(&mut image_psd::PsdFile) -> image_psd::Result<()>,
    {
        PSDS.with(|m| {
            let mut map = m.borrow_mut();
            let file = map
                .get_mut(&handle)
                .ok_or_else(|| JsValue::from_str(&format!("unknown psd handle {handle}")))?;
            f(file).map_err(|e| JsValue::from_str(&e.to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn abi_and_registry_reachable() {
        assert_eq!(super::abi_version(), 1);
        assert!(super::kernel_count() >= 2);
    }
}
