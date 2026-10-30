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

//! Raster / vector image decoding: format sniffing (JPEG, SVG),
//! DCT-scaled JPEG decode for oversized rasters, SVG rasterisation,
//! and lazy dimension peeking. RGBA conversion lives in
//! [`super::image_convert`]. TIFF, PSD/PSB, DNG, AVIF, JPEG XL, Radiance
//! HDR, OpenEXR and an EPS's preview decode through `paged-raster`, the
//! same call paged-gpu makes at raster time on wasm32, so a CMYK or Lab
//! TIFF and a CMYK PSD convert through paged-color with their embedded
//! profile. A PSD/PSB draws its merged composite, an EPS its TIFF or EPSI
//! preview (engine ADR 1005).

use super::*;

/// Track 1a: longest-edge cap for raster decode. JPEGs whose declared
/// dimensions exceed this on either axis are decoded through
/// `jpeg-decoder`'s DCT scaling (1/2, 1/4, or 1/8) so we never
/// materialise the full RGBA8 buffer — the annual-report-template
/// cover JPEG is 5760×9000 ≈ 198MB at RGBA8, which the previous
/// `image::load_from_memory` path allocated in one shot. 4096px keeps
/// us safely under one rasteriser tile target while still hitting
/// 300dpi for any frame up to ~13.6" on the longest edge.
const DECODE_MAX_RASTER_PX: u32 = 4096;

/// An Encapsulated PostScript file: PostScript text, or the DOS EPS
/// binary container. Only its preview is drawn (no interpreter).
pub(super) fn is_eps(bytes: &[u8]) -> bool {
    paged_raster::sniff(bytes) == Some(paged_raster::Format::Eps)
}

/// Decode raw image bytes to RGBA8. Routes oversized JPEGs through
/// `jpeg-decoder`'s DCT scaling so we never materialise a multi-
/// hundred-MB RGBA8 buffer; everything else (PNG / WebP / small JPEGs)
/// goes through `image::load_from_memory`. Returns `None` for any
/// decode or buffer-shape failure — including an EPS without a TIFF or
/// EPSI preview, which would need a PostScript interpreter.
///
/// `rendering` is the intent and black-point compensation the picture's
/// colours convert with (the frame's `ImageRenderingIntent` or the
/// document's Color Settings, [`super::images::image_rendering`]); on
/// wasm32 it rides on the lazy image to the raster-time decode.
pub(super) fn decode_image_bytes(
    bytes: &[u8],
    rendering: paged_color::cms::Rendering,
) -> Option<paged_compose::DecodedImage> {
    paged_compose::perf::count(|c| c.pipeline_image_decodes += 1);
    // wasm32 has a hard 4 GB address-space cap. Eagerly decoding
    // every embedded image to RGBA8 during `build_document` bloats
    // the heap (envato megapacks ship 50+ MB of images that expand
    // to 1-2 GB decoded). Defer the decode to render time — the
    // rasterizer materialises one image at a time and drops after.
    //
    // Native targets have 64-bit addressing; eager decode is cheap
    // there and avoids decoding the same image twice when a page
    // re-renders.
    #[cfg(target_arch = "wasm32")]
    {
        peek_image_lazy(bytes, DECODE_MAX_RASTER_PX, rendering)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        decode_image_bytes_with(bytes, DECODE_MAX_RASTER_PX, rendering)
    }
}

/// Lazy variant: returns a `DecodedImage` whose `rgba` is empty and
/// whose `encoded` carries the original bytes. The rasterizer
/// detects the empty `rgba` and runs the full decoder on demand.
/// Width / height come from header peeks where possible (PNG, JPEG,
/// SVG) so the display-list transform stays accurate without paying
/// for the pixel decode. Only the wasm32 path defers decode this way.
#[cfg(target_arch = "wasm32")]
fn peek_image_lazy(
    bytes: &[u8],
    max_px: u32,
    rendering: paged_color::cms::Rendering,
) -> Option<paged_compose::DecodedImage> {
    // An EPS without a preview it can draw fails here, not at raster time.
    if is_eps(bytes) && paged_raster::probe(bytes).is_err() {
        return None;
    }
    // SVGs always go through the eager path even on wasm32: usvg's
    // parse is fast (XML-only, no pixel buffer) and we'd parse twice
    // anyway in lazy mode. The cost of the actual rasterize stays
    // bounded — vector → bitmap at the configured max_px.
    if is_svg_magic(bytes) {
        return decode_svg_bytes(bytes, max_px);
    }
    let (width, height) = peek_image_dimensions(bytes, max_px)?;
    Some(paged_compose::DecodedImage {
        width,
        height,
        encoded: bytes::Bytes::copy_from_slice(bytes),
        rgba: bytes::Bytes::new(),
        icc: extract_icc(bytes),
        rendering: Some(rendering),
    })
}

/// Sniff for SVG: skip BOM + leading whitespace, then look for the
/// XML preamble or a bare `<svg` root. Adobe-embedded SVGs always
/// carry the XML declaration; loose-format SVGs in arbitrary IDMLs
/// may not.
pub(super) fn is_svg_magic(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(512)];
    let Ok(s) = std::str::from_utf8(head) else {
        return false;
    };
    let s = s.trim_start_matches('\u{FEFF}').trim_start();
    s.starts_with("<?xml") || s.starts_with("<svg") || s.starts_with("<!DOCTYPE svg")
}

/// Decode an SVG: usvg parses it and `paged_gpu::svg` draws it with
/// vello_cpu into RGBA8. The image is scaled so its longest edge lands
/// at most `max_px` (matching the DCT-scale cap for raster images),
/// preserving aspect.
fn decode_svg_bytes(bytes: &[u8], max_px: u32) -> Option<paged_compose::DecodedImage> {
    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_data(bytes, &opt).ok()?;
    let svg_w: f32 = tree.size().width().ceil().max(1.0);
    let svg_h: f32 = tree.size().height().ceil().max(1.0);
    let longest = svg_w.max(svg_h);
    let scale: f32 = if (longest as u32) > max_px {
        (max_px as f32) / longest
    } else {
        1.0
    };
    let w = ((svg_w * scale).ceil() as u32).max(1);
    let h = ((svg_h * scale).ceil() as u32).max(1);
    let rgba = paged_gpu::svg::rasterize_svg(&tree, w, h, scale)?;
    Some(paged_compose::DecodedImage {
        width: w,
        height: h,
        encoded: bytes::Bytes::copy_from_slice(bytes),
        rgba: bytes::Bytes::from(rgba),
        icc: None,
        rendering: None,
    })
}

/// An SVG's raster at one pixel per user unit (the longest edge capped
/// as every placed raster is), for a placed SVG whose vectors a placement
/// cannot follow exactly (`placed_svg`).
pub(super) fn decode_svg_raster(bytes: &[u8]) -> Option<paged_compose::DecodedImage> {
    decode_svg_bytes(bytes, DECODE_MAX_RASTER_PX)
}

/// Read width / height from the image header without materialising
/// the pixel buffer. For JPEGs we apply the same DCT-scale logic as
/// the eager decoder so the displayed dimensions match what the
/// rasterizer will actually produce. Only used by the wasm32 lazy path
/// (built natively for its tests).
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn peek_image_dimensions(bytes: &[u8], max_px: u32) -> Option<(u32, u32)> {
    if is_jpeg_magic(bytes) {
        let (src_w, src_h) = peek_jpeg_dimensions(bytes)?;
        if src_w == 0 || src_h == 0 {
            return None;
        }
        let longest = src_w.max(src_h);
        // Mirror decode_jpeg_scaled's DCT-factor pick (1..8 / 8).
        let k = if longest <= max_px {
            8u32
        } else {
            let mut best: u32 = 1;
            for k in 1..=8u32 {
                if longest * k / 8 <= max_px {
                    best = k;
                }
            }
            best
        };
        let w = (src_w * k / 8).max(1);
        let h = (src_h * k / 8).max(1);
        return Some((w, h));
    }
    // A TIFF or PSD reports the size its capped decode will have.
    if reads_through_raster(bytes) {
        if let Ok(info) = paged_raster::probe(bytes) {
            return Some(paged_raster::shrunk_dimensions(
                info.width,
                info.height,
                Some(max_px),
            ));
        }
    }
    // PNG / WebP / etc — header read via the image crate's lazy
    // dimension probe, which doesn't materialise pixels.
    let cursor = std::io::Cursor::new(bytes);
    let guessed = image::ImageReader::new(cursor)
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok());
    // A TGA has no magic the image crate guesses by; paged-raster sniffs
    // its header and reads the size (the decode at raster time is its
    // too). Without a size the lazy image was dropped and drew nothing.
    guessed.or_else(|| {
        paged_raster::probe(bytes)
            .ok()
            .map(|info| (info.width, info.height))
    })
}

/// Same as [`decode_image_bytes`] but with a caller-supplied
/// longest-edge cap. Used by the streaming JPEG path and by the
/// fallback retry on decode failure. JPEGs above the cap are
/// decoded via `jpeg-decoder` with DCT scaling chosen so the longest
/// edge ends up ≤ `max_px`; other formats and small JPEGs fall
/// through to `image::load_from_memory`.
// Native-only: the wasm32 build cfg's out the raster-decode path (the
// engine receives pre-decoded images), so this and `decode_jpeg_scaled`
// are dead there. The lint stays active on native.
#[cfg(test)]
pub(super) fn decode_image_bytes_with_target_max(
    bytes: &[u8],
    max_px: u32,
) -> Option<paged_compose::DecodedImage> {
    decode_image_bytes_with(bytes, max_px, paged_color::cms::Rendering::default())
}

/// Decode at a caller-supplied longest-edge cap, converting a CMYK raster
/// with `rendering`.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(super) fn decode_image_bytes_with(
    bytes: &[u8],
    max_px: u32,
    rendering: paged_color::cms::Rendering,
) -> Option<paged_compose::DecodedImage> {
    if is_svg_magic(bytes) {
        return decode_svg_bytes(bytes, max_px);
    }
    if is_jpeg_magic(bytes) {
        if let Some((src_w, src_h)) = peek_jpeg_dimensions(bytes) {
            if src_w.max(src_h) > max_px {
                if let Some(d) = decode_jpeg_scaled(bytes, max_px, rendering) {
                    return Some(d);
                }
                tracing::debug!(
                    src_w,
                    src_h,
                    max_px,
                    "streaming JPEG decoder rejected oversized payload; falling back to image crate"
                );
            }
        }
    }
    if reads_through_raster(bytes) {
        if let Some(d) = decode_raster(bytes, max_px, rendering) {
            return Some(d);
        }
    }
    let img = image::load_from_memory(bytes).ok()?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Some(paged_compose::DecodedImage {
        width,
        height,
        encoded: bytes::Bytes::copy_from_slice(bytes),
        rgba: bytes::Bytes::from(rgba.into_raw()),
        icc: extract_icc(bytes),
        rendering: None,
    })
}

/// The formats `paged-raster` reads itself rather than through `image`:
/// TIFF, PSD/PSB (its merged composite, through paged-psd), an EPS's
/// preview, DNG, AVIF, JPEG XL, Radiance HDR and OpenEXR
/// (`paged_raster::reads_natively`).
fn reads_through_raster(bytes: &[u8]) -> bool {
    paged_raster::sniff(bytes).is_some_and(paged_raster::reads_natively)
}

/// A raster `paged-raster` reads, shrunk to `max_px` and converted with
/// paged-color with `rendering`. `None` lets the caller try the `image` crate, the decoder
/// TIFFs used before (it reads none of the others, so one this crate
/// cannot decode stays undecoded: a PSD's Lab, indexed or ZIP composite,
/// an EPS without a preview).
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
fn decode_raster(
    bytes: &[u8],
    max_px: u32,
    rendering: paged_color::cms::Rendering,
) -> Option<paged_compose::DecodedImage> {
    let img = match paged_raster::decode(
        bytes,
        paged_raster::DecodeOptions {
            page: 0,
            max_dim: Some(max_px),
        },
    ) {
        Ok(img) => img,
        Err(err) => {
            tracing::warn!(error = %err, "raster decode failed; trying the image crate");
            return None;
        }
    };
    let rgba = paged_raster::to_rgba8(&img, &paged_raster::PagedColour::new(rendering)).ok()?;
    Some(paged_compose::DecodedImage {
        width: rgba.width,
        height: rgba.height,
        encoded: bytes::Bytes::copy_from_slice(bytes),
        rgba: bytes::Bytes::from(rgba.data),
        icc: raster_icc(&img.info),
        rendering: None,
    })
}

/// The profile a decoded TIFF or PSD carries on: the embedded one, except
/// a Lab image's, whose pixels arrive as sRGB (the PDF export tags an RGB
/// raster with any three-channel profile it is given; a CMYK profile it
/// leaves off the converted pixels, as it does a CMYK JPEG's).
fn raster_icc(info: &paged_raster::RasterInfo) -> Option<bytes::Bytes> {
    if info.color_model == paged_raster::ColorModel::Lab {
        return None;
    }
    info.icc.clone().map(bytes::Bytes::from)
}

/// Extract an embedded ICC profile from JPEG (APP2 `ICC_PROFILE`
/// segments, reassembled in chunk order), PNG (`iCCP` chunk,
/// zlib-inflated), TIFF (tag 34675) or PSD (resource 1039); not for a Lab
/// image, see [`raster_icc`]. Header-only scans — no pixel decode. The PDF
/// exporter tags the image's /ColorSpace with this; the rasterizer
/// keeps using its own decode-time conversion.
pub(super) fn extract_icc(bytes: &[u8]) -> Option<bytes::Bytes> {
    if reads_through_raster(bytes) {
        return raster_icc(&paged_raster::probe(bytes).ok()?);
    }
    paged_raster::extract_icc(bytes).map(bytes::Bytes::from)
}

fn is_jpeg_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
}

/// Cheap pre-flight: read just the JPEG headers via `jpeg-decoder` to
/// discover declared dimensions without decoding pixel data. Returns
/// `None` if the headers are malformed or the file isn't a JPEG.
fn peek_jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut decoder = jpeg_decoder::Decoder::new(bytes);
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    Some((info.width as u32, info.height as u32))
}

/// Decode a JPEG via `jpeg-decoder`, using its DCT-scaled output mode
/// to land the longest edge ≤ `max_px`. Scaling is restricted to the
/// JPEG-native factors (1, 1/2, 1/4, 1/8); the decoder picks the
/// smallest factor whose output is ≥ the requested target.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
fn decode_jpeg_scaled(
    bytes: &[u8],
    max_px: u32,
    rendering: paged_color::cms::Rendering,
) -> Option<paged_compose::DecodedImage> {
    use jpeg_decoder::{Decoder, PixelFormat};
    let mut decoder = Decoder::new(bytes);
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    let src_w = info.width as u32;
    let src_h = info.height as u32;
    if src_w == 0 || src_h == 0 {
        return None;
    }
    let longest = src_w.max(src_h);
    // jpeg-decoder picks the smallest DCT scale `k` (1..=8 in 1/8ths
    // of full resolution) whose output ≥ the requested dimensions,
    // so requesting `max_px` directly would round UP past the cap.
    // Instead, pick the largest `k` where `longest * k / 8 ≤ max_px`
    // ourselves and request the resulting size verbatim — the
    // decoder then returns exactly that scale. When no scale fits
    // (`max_px` < `longest / 8`) we fall back to `k = 1` (1/8 — the
    // smallest DCT-supported output) and accept the cap overshoot.
    let k = if longest <= max_px {
        8
    } else {
        let mut best: u32 = 1;
        for k in 1..=8u32 {
            if longest * k / 8 <= max_px {
                best = k;
            }
        }
        best
    };
    let target_w = (src_w * k / 8).max(1).min(u16::MAX as u32) as u16;
    let target_h = (src_h * k / 8).max(1).min(u16::MAX as u32) as u16;
    let (final_w, final_h) = decoder.scale(target_w, target_h).ok()?;
    let pixels = decoder.decode().ok()?;
    let info_after = decoder.info()?;
    let icc_profile = decoder.icc_profile();
    let w = final_w as u32;
    let h = final_h as u32;
    let rgba = match info_after.pixel_format {
        PixelFormat::L8 => l8_to_rgba(&pixels, w, h)?,
        PixelFormat::L16 => l16_to_rgba(&pixels, w, h)?,
        PixelFormat::RGB24 => rgb24_to_rgba(&pixels, w, h)?,
        PixelFormat::CMYK32 => cmyk32_to_rgba(&pixels, w, h, icc_profile.as_deref(), rendering)?,
    };
    Some(paged_compose::DecodedImage {
        width: w,
        height: h,
        encoded: bytes::Bytes::copy_from_slice(bytes),
        rgba: bytes::Bytes::from(rgba),
        icc: icc_profile.map(bytes::Bytes::from),
        rendering: None,
    })
}

#[cfg(test)]
mod peek_tests {
    /// An uncompressed 24-bit TGA, `w` × `h`.
    fn tga(w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![0u8; 18 + usize::from(w) * usize::from(h) * 3];
        b[2] = 2;
        b[12..14].copy_from_slice(&w.to_le_bytes());
        b[14..16].copy_from_slice(&h.to_le_bytes());
        b[16] = 24;
        b
    }

    #[test]
    fn the_lazy_path_sizes_a_tga_the_image_crate_cannot_guess() {
        assert_eq!(super::peek_image_dimensions(&tga(8, 4), 4096), Some((8, 4)));
    }
}
