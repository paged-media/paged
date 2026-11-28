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

//! Image XObjects — the quality differentiators (concept E7):
//! placed JPEGs pass through as DCTDecode WITHOUT re-encoding (no
//! generational loss); an 8-bit CMYK picture in another format (a
//! TIFF, a PSD) keeps its ink values as a FlateDecode CMYK image;
//! everything else embeds as FlateDecode from the decoded RGBA;
//! alpha rides as an /SMask; an embedded ICC profile (when the
//! decode retained it) tags the colour space.

use std::io::Write as _;

use paged_compose::DecodedImage;
use pdf_writer::{Finish, Name, Ref};

use crate::writer::DocState;
use crate::ExportDiagnostic;

// The JPEG facts a DCT passthrough needs come from paged-raster, the
// engine's one reader of image bytes (ADR 1005, C5).

fn is_jpeg(bytes: &[u8]) -> bool {
    paged_raster::sniff(bytes) == Some(paged_raster::Format::Jpeg)
}

/// Component count from the JPEG SOF header (1 = gray, 3 = YCbCr/RGB,
/// 4 = CMYK/YCCK). Determines the /ColorSpace a DCT passthrough must
/// carry — tagging a CMYK JPEG as RGB renders garbage.
fn jpeg_components(bytes: &[u8]) -> Option<u8> {
    paged_raster::jpeg_header(bytes).map(|h| h.components)
}

/// True when the JPEG carries Adobe's APP14 segment: Photoshop and
/// InDesign write CMYK / YCCK JPEGs with INVERTED channel values under
/// that marker, and a PDF consumer only un-inverts them when the image
/// dictionary says so (`/Decode [1 0 1 0 1 0 1 0]`). Without the array
/// every such image prints near-black — measured 2026-09-06 on the
/// annual's page 73, where the CMYK apples came out as a dark slab
/// while InDesign's own export showed the fruit.
fn jpeg_has_adobe_marker(bytes: &[u8]) -> bool {
    paged_raster::jpeg_header(bytes).is_some_and(|h| h.adobe_transform.is_some())
}

/// /N for an ICC stream, from the profile header's data colour
/// space field (bytes 16..20).
fn icc_component_count(icc: &[u8]) -> i32 {
    match icc.get(16..20) {
        Some(b"CMYK") => 4,
        Some(b"GRAY") => 1,
        _ => 3,
    }
}

/// The channel count an ICC profile's header states (its data colour
/// space, bytes 16..20), or `None` for a header too short or naming a
/// space this does not know.
pub(crate) fn icc_channels(icc: &[u8]) -> Option<i32> {
    match icc.get(16..20)? {
        b"GRAY" => Some(1),
        b"RGB " | b"Lab " | b"XYZ " | b"Luv " | b"YCbr" | b"Yxy " | b"HSV " | b"HLS " | b"CMY " => {
            Some(3)
        }
        b"CMYK" => Some(4),
        // The N-colour spaces: "2CLR" to "FCLR".
        [n, b'C', b'L', b'R'] => char::from(*n)
            .to_digit(16)
            .filter(|n| *n >= 2)
            .map(|n| n as i32),
        _ => None,
    }
}

/// The samples of a picture the file holds as 8-bit CMYK, in the
/// file's own ink values, with its alpha (straight, one byte a pixel)
/// when it has one. `None` for every other picture: one in another
/// colour model or depth, one whose alpha is premultiplied into the
/// inks, one whose size is not the size the display list drew.
///
/// The RGBA the renderer decoded for the screen went through a
/// CMYK to RGB conversion; writing that into a print PDF would turn
/// every ink value into another on the way back (pure black into a
/// four-colour black).
fn native_cmyk8(img: &DecodedImage) -> Option<(Vec<u8>, Option<Vec<u8>>)> {
    use paged_raster::{Alpha, ColorModel, Samples};
    if img.encoded.is_empty() {
        return None;
    }
    // The header first: most pictures are not CMYK, and decoding one
    // to find that out would read it twice.
    let info = paged_raster::probe(&img.encoded).ok()?;
    if info.color_model != ColorModel::Cmyk || info.bits_per_sample != 8 {
        return None;
    }
    let raster = paged_raster::decode(&img.encoded, paged_raster::DecodeOptions::default()).ok()?;
    if raster.model != ColorModel::Cmyk
        || raster.alpha == Alpha::Associated
        || raster.width != img.width
        || raster.height != img.height
    {
        return None;
    }
    let Samples::U8(data) = raster.data else {
        return None;
    };
    let n = (raster.width as usize).checked_mul(raster.height as usize)?;
    if raster.alpha == Alpha::None {
        return (data.len() == n.checked_mul(4)?).then_some((data, None));
    }
    if data.len() != n.checked_mul(5)? {
        return None;
    }
    let mut cmyk = Vec::with_capacity(n * 4);
    let mut alpha = Vec::with_capacity(n);
    for px in data.as_chunks::<5>().0 {
        cmyk.extend_from_slice(&px[..4]);
        alpha.push(px[4]);
    }
    let alpha = alpha.iter().any(|a| *a != 255).then_some(alpha);
    Some((cmyk, alpha))
}

/// One 8-bit grey FlateDecode image holding `alpha`, for an `/SMask`.
fn write_alpha_mask(state: &mut DocState, alpha: &[u8], width: u32, height: u32) -> Ref {
    let r = state.refs.alloc();
    let data = flate(alpha);
    let mut x = state.pdf.image_xobject(r, &data);
    x.width(width as i32);
    x.height(height as i32);
    x.bits_per_component(8);
    x.color_space().device_gray();
    x.filter(pdf_writer::Filter::FlateDecode);
    x.finish();
    r
}

fn flate(data: &[u8]) -> Vec<u8> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

/// Write one image (+ optional alpha SMask) and return its XObject
/// ref. Returns `None` when neither encoded nor decoded pixels are
/// available (a diagnostic is pushed).
/// Decide the PDF image-downsampling target. When the image's effective
/// placed resolution exceeds `target_ppi` by more than 25%, return the
/// `(w, h)` that lands the longest edge AT `target_ppi`; otherwise `None`
/// (passthrough — never upsample, never resample near/below target).
pub(crate) fn downsample_target(
    width: u32,
    height: u32,
    placed_size_pt: Option<(f32, f32)>,
    target_ppi: Option<f32>,
) -> Option<(u32, u32)> {
    let target = target_ppi?;
    let (pw, ph) = placed_size_pt?;
    if pw <= 0.0 || ph <= 0.0 {
        return None;
    }
    let eff = (width as f32 / (pw / 72.0)).max(height as f32 / (ph / 72.0));
    if eff > target * 1.25 {
        let scale = target / eff;
        let w = ((width as f32 * scale).round() as u32).max(1);
        let h = ((height as f32 * scale).round() as u32).max(1);
        Some((w, h))
    } else {
        None
    }
}

pub fn write_image(
    state: &mut DocState,
    img: &DecodedImage,
    image_index: u32,
    placed_size_pt: Option<(f32, f32)>,
    options: &crate::ImageOptions,
    diagnostics: &mut Vec<ExportDiagnostic>,
) -> Option<Ref> {
    // Downsampling (off by default): when the placed resolution
    // exceeds the target, resample and embed Flate — the DCT
    // passthrough is skipped for that image.
    let downsample_to = downsample_target(
        img.width,
        img.height,
        placed_size_pt,
        options.downsample_ppi,
    );

    // DCT passthrough — the original bytes, verbatim.
    if downsample_to.is_none() && !img.encoded.is_empty() && is_jpeg(&img.encoded) {
        // ICC stream first (separate borrow), then the XObject.
        let icc_ref = img
            .icc
            .as_ref()
            .filter(|icc| !icc.is_empty())
            .map(|icc| write_icc(state, icc));
        let components = jpeg_components(&img.encoded).unwrap_or(3);
        let img_ref = state.refs.alloc();
        let mut x = state.pdf.image_xobject(img_ref, &img.encoded);
        x.width(img.width as i32);
        x.height(img.height as i32);
        x.bits_per_component(8);
        // Colour space from the SOF component count — CMYK JPEGs
        // pass through as DeviceCMYK (viewers honour the in-stream
        // Adobe APP14 transform), gray as DeviceGray. ICC tagging
        // when the decode retained a profile.
        match icc_ref {
            Some(r) => {
                x.color_space().icc_based(r);
            }
            None => match components {
                4 => {
                    x.color_space().device_cmyk();
                }
                1 => {
                    x.color_space().device_gray();
                }
                _ => {
                    x.color_space().device_rgb();
                }
            },
        }
        if components == 4 && jpeg_has_adobe_marker(&img.encoded) {
            x.decode([1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0]);
        }
        x.filter(pdf_writer::Filter::DctDecode);
        x.finish();
        return Some(img_ref);
    }

    // A CMYK picture keeps its inks: the file's own samples, tagged
    // with the picture's CMYK profile when it carries one and
    // DeviceCMYK otherwise (the output intent's space in PDF/X-4).
    if downsample_to.is_none() {
        if let Some((cmyk, alpha)) = native_cmyk8(img) {
            let smask_ref =
                alpha.map(|alpha| write_alpha_mask(state, &alpha, img.width, img.height));
            let icc_ref = img
                .icc
                .as_ref()
                .filter(|icc| icc_channels(icc) == Some(4))
                .map(|icc| write_icc(state, icc));
            let img_ref = state.refs.alloc();
            let data = flate(&cmyk);
            let mut x = state.pdf.image_xobject(img_ref, &data);
            x.width(img.width as i32);
            x.height(img.height as i32);
            x.bits_per_component(8);
            match icc_ref {
                Some(r) => {
                    x.color_space().icc_based(r);
                }
                None => {
                    x.color_space().device_cmyk();
                }
            }
            x.filter(pdf_writer::Filter::FlateDecode);
            if let Some(s) = smask_ref {
                x.s_mask(s);
            }
            x.finish();
            return Some(img_ref);
        }
    }

    // Flate path from decoded RGBA (lazy-decode when only encoded
    // bytes exist — mirror the rasterizer's fallback).
    let rgba: bytes::Bytes = if !img.rgba.is_empty() {
        img.rgba.clone()
    } else if !img.encoded.is_empty() {
        match decode_encoded_rgba(img) {
            Some(rgba) => rgba,
            None => {
                diagnostics.push(ExportDiagnostic::ImageMissingBytes { image_index });
                return None;
            }
        }
    } else {
        diagnostics.push(ExportDiagnostic::ImageMissingBytes { image_index });
        return None;
    };

    let n = (img.width as usize) * (img.height as usize);
    if rgba.len() < n * 4 {
        diagnostics.push(ExportDiagnostic::ImageMissingBytes { image_index });
        return None;
    }

    // Bicubic resample to the downsampling target (Catmull-Rom),
    // premultiplied as every engine resample is.
    let (out_w, out_h, rgba) = match downsample_to {
        Some((w, h)) => {
            let resized = paged_resample::resize_rgba8(
                &rgba,
                img.width,
                img.height,
                w,
                h,
                paged_resample::Filter::CatmullRom,
            )
            .ok()?;
            (w, h, bytes::Bytes::from(resized))
        }
        None => (img.width, img.height, rgba),
    };

    let n = (out_w as usize) * (out_h as usize);
    let mut rgb = Vec::with_capacity(n * 3);
    let mut alpha = Vec::with_capacity(n);
    let mut has_alpha = false;
    for px in rgba.as_chunks::<4>().0 {
        rgb.extend_from_slice(&px[..3]);
        alpha.push(px[3]);
        if px[3] != 255 {
            has_alpha = true;
        }
    }

    let smask_ref = has_alpha.then(|| write_alpha_mask(state, &alpha, out_w, out_h));

    // The pixels are RGBA from the decode — a CMYK source profile
    // would mis-tag them, so only ICC-tag when the profile is RGB.
    let icc_ref = img
        .icc
        .as_ref()
        .filter(|icc| !icc.is_empty() && icc_component_count(icc) == 3)
        .map(|icc| write_icc(state, icc));
    let img_ref = state.refs.alloc();
    let data = flate(&rgb);
    let mut x = state.pdf.image_xobject(img_ref, &data);
    x.width(out_w as i32);
    x.height(out_h as i32);
    x.bits_per_component(8);
    match icc_ref {
        Some(r) => {
            x.color_space().icc_based(r);
        }
        None => {
            x.color_space().device_rgb();
        }
    }
    x.filter(pdf_writer::Filter::FlateDecode);
    if let Some(s) = smask_ref {
        x.s_mask(s);
    }
    x.finish();
    Some(img_ref)
}

/// RGBA8 of an image that carries only its encoded bytes, decoded as the
/// rasterizer decodes it (`paged_raster::decode_rgba8_at_with`, the frame's
/// rendering intent): a TIFF or PSD converts through its embedded profile
/// instead of arriving as `image`'s RGB guess. PNG, WebP and the other
/// formats `image` reads decode to the same bytes as before.
fn decode_encoded_rgba(img: &DecodedImage) -> Option<bytes::Bytes> {
    let conv = paged_raster::PagedColour::new(img.rendering.unwrap_or_default());
    paged_raster::decode_rgba8_at_with(&img.encoded, img.width, img.height, &conv)
        .map(bytes::Bytes::from)
}

fn write_icc(state: &mut DocState, icc: &[u8]) -> Ref {
    let r = state.refs.alloc();
    let mut s = state.pdf.icc_profile(r, icc);
    s.n(icc_component_count(icc));
    s.finish();
    r
}

/// Intern the image XObject name on the page resources.
pub fn image_resource_name(index: u32) -> String {
    format!("Im{index}")
}

#[allow(unused)]
fn _name_check(_: Name) {}

#[cfg(test)]
mod tests {
    use super::{decode_encoded_rgba, downsample_target};
    use paged_compose::DecodedImage;

    fn encoded_only(bytes: Vec<u8>, width: u32, height: u32) -> DecodedImage {
        DecodedImage {
            width,
            height,
            encoded: bytes::Bytes::from(bytes),
            rgba: bytes::Bytes::new(),
            icc: None,
            rendering: None,
        }
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([
                (x * 40) as u8,
                (y * 30) as u8,
                (x * y) as u8,
                200 + (x % 3) as u8,
            ])
        });
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    /// The lazy fallback decodes a PNG to the bytes `image` gave before.
    #[test]
    fn encoded_only_png_decodes_as_the_image_crate_did() {
        let bytes = png(7, 5);
        let old = image::load_from_memory(&bytes)
            .unwrap()
            .to_rgba8()
            .into_raw();
        let new = decode_encoded_rgba(&encoded_only(bytes, 7, 5)).unwrap();
        assert_eq!(new.as_ref(), old.as_slice());
    }

    /// A TIFF the file carries only encoded: with no profile its CMYK
    /// converts as `image` converted it; the bytes are unchanged.
    #[test]
    fn encoded_only_profile_less_cmyk_tiff_is_unchanged() {
        use paged_raster::{Alpha, ColorModel, RasterImage, RasterInfo, Samples};
        let (w, h) = (6u32, 4u32);
        let samples: Vec<u8> = (0..w * h * 4).map(|i| (i * 7 % 251) as u8).collect();
        let info = RasterInfo {
            format: paged_raster::Format::Tiff,
            width: w,
            height: h,
            channels: 4,
            bits_per_sample: 8,
            sample_format: paged_raster::SampleFormat::UInt,
            color_model: ColorModel::Cmyk,
            alpha: Alpha::None,
            icc: None,
            xmp: None,
            iptc: None,
            exif: None,
            photoshop_irb: None,
            has_layers: false,
            layer_count: Some(0),
            resolution: None,
            orientation: 1,
            page_count: 1,
        };
        let img = RasterImage {
            info,
            width: w,
            height: h,
            model: ColorModel::Cmyk,
            alpha: Alpha::None,
            data: Samples::U8(samples),
        };
        let bytes =
            paged_raster::encode_tiff(&img, paged_raster::TiffEncodeOptions::default()).unwrap();
        let old = image::load_from_memory(&bytes)
            .unwrap()
            .to_rgba8()
            .into_raw();
        let new = decode_encoded_rgba(&encoded_only(bytes, w, h)).unwrap();
        assert_eq!(new.as_ref(), old.as_slice());
    }

    // the-renderer.pdf-image-downsampling: bicubic resample of over-resolution
    // placed images down to the target ppi on PDF export.
    #[test]
    fn pdf_image_downsampling_caps_longest_edge_to_target_ppi() {
        // 400×400 px placed at 72×72 pt (1 inch) = 400 ppi; target 150 →
        // cap to 150×150 (the result lands AT 150 ppi).
        assert_eq!(
            downsample_target(400, 400, Some((72.0, 72.0)), Some(150.0)),
            Some((150, 150)),
        );
        // Non-square: 800×400 at 72×72 pt → longest edge (800) drives eff=800,
        // scale 150/800 → 150×75.
        assert_eq!(
            downsample_target(800, 400, Some((72.0, 72.0)), Some(150.0)),
            Some((150, 75)),
        );
        // Within 1.25× of target (160 ppi vs 150) → passthrough, never resample.
        assert_eq!(
            downsample_target(160, 160, Some((72.0, 72.0)), Some(150.0)),
            None,
        );
        // No target ppi, or zero placement → never resample.
        assert_eq!(downsample_target(400, 400, Some((72.0, 72.0)), None), None);
        assert_eq!(
            downsample_target(400, 400, Some((0.0, 72.0)), Some(150.0)),
            None,
        );
    }
}

#[cfg(test)]
mod adobe_marker_tests {
    use super::*;

    fn jpeg(with_adobe: bool, components: u8) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8];
        if with_adobe {
            // APP14 "Adobe": length 14, "Adobe", version, flags0, flags1, transform.
            b.extend_from_slice(&[0xFF, 0xEE, 0x00, 0x0E]);
            b.extend_from_slice(b"Adobe");
            b.extend_from_slice(&[0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00]);
        }
        // SOF0: length 8 + 3 × components, precision 8, 1 × 1 px.
        b.extend_from_slice(&[
            0xFF,
            0xC0,
            0x00,
            8 + 3 * components,
            8,
            0,
            1,
            0,
            1,
            components,
        ]);
        for c in 0..components {
            b.extend_from_slice(&[c + 1, 0x11, 0]);
        }
        b.extend_from_slice(&[0xFF, 0xD9]);
        b
    }

    #[test]
    fn the_adobe_marker_is_found_before_the_frame_header() {
        assert!(jpeg_has_adobe_marker(&jpeg(true, 4)));
        assert!(!jpeg_has_adobe_marker(&jpeg(false, 4)));
        assert_eq!(jpeg_components(&jpeg(true, 4)), Some(4));
        assert_eq!(jpeg_components(&jpeg(false, 3)), Some(3));
    }
}
