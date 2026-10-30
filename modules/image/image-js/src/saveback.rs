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

//! SAVE-BACK — turn the ADJUSTED full-resolution pixels into file bytes.
//!
//! Two lanes, one contract (`bytes in → bytes out`, no host I/O here —
//! the bundle hands the result to the exporter registry):
//!
//! * **PSD** ([`psd_write_adjusted`]) — the composite is re-encoded into
//!   the retained parse's merged-image section, and the LAYER structure
//!   is handled per [`PsdSaveBackShape`]. Everything the model does not
//!   touch (resources, ICC, unmodeled blocks) still rides the
//!   preservation writer verbatim.
//! * **PNG / JPEG / WebP / TIFF** ([`encode_rgba8`]) — a straight re-encode
//!   through the `image-codecs` targets over `paged-raster` (CPU entropy
//!   coding, spec §1). The metadata-keeping save-back and Export As are
//!   `crate::export`.
//!
//! # HONEST SCOPE (stated in the panel string, never silently)
//!
//! * PSD save-back is **8-bit RGB only**. 16/32-bit, Grayscale, CMYK,
//!   Lab and Indexed answer a clean `Unsupported` — the same cut the
//!   composite DECODE already declares.
//! * PSD save-back is **single-layer / flattened**. A file whose only
//!   content layer already covers the canvas gets that layer's channels
//!   replaced in place ([`PsdSaveBackShape::LayerReplaced`] — the
//!   `replace_channel_pixels` path, nothing else moves). A MULTI-layer
//!   file cannot have adjusted pixels attributed to any one layer
//!   without a layer graph (a recorded deferral), so it is flattened
//!   into a NEW single-layer PSD ([`PsdSaveBackShape::Flattened`]) —
//!   announced in the UI, never silent.
//! * Spot / extra channels beyond RGB+alpha are dropped by the flatten
//!   (the header channel count is normalized to what we actually write).
//! * The **zero-edit guarantee is untouched**: nothing here runs unless
//!   the user explicitly asks for a save-back, so a plain PSD export is
//!   still byte-identical.

use image_codecs::{ImageTarget, JpegTarget, PngTarget, TargetInfo};
use image_core::{
    AlphaMode, ChannelLayout, ColorSpaceRef, NamedSpace, PixelFormat, Region, SampleDepth,
    TileSliceRef, Transfer,
};
use image_psd::model::{
    BlendRanges, ChannelData, ChannelInfo, ColorMode, Compression, GlobalImageData, LayerRecord,
    PascalString, PsdFile,
};

use crate::ingest::IngestError;

/// What the PSD save-back did to the layer structure — the panel turns
/// this into the sentence the user reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PsdSaveBackShape {
    /// The file's single canvas-sized content layer had its channel
    /// pixels replaced (`image_psd::edit::replace_channel_pixels`); every
    /// other record, resource and unmodeled block is untouched.
    LayerReplaced,
    /// The file had multiple layers, or no addressable canvas-sized
    /// content layer at all (a layer that does not cover the canvas,
    /// channels we cannot address, or an extra-channel header): the
    /// adjusted composite was written into a NEW single-layer PSD. Any
    /// original layer structure is GONE — the caller MUST say so.
    Flattened,
    /// The session's layer STACK was written as the file's layers: pixel
    /// layers (smart objects as their rendered pixels), masks, groups,
    /// opacity, blend, visibility and clipping, plus a fresh composite.
    Layered,
}

impl PsdSaveBackShape {
    /// The user-facing sentence (the panel/status string).
    pub fn describe(self) -> &'static str {
        match self {
            PsdSaveBackShape::LayerReplaced => {
                "the adjusted pixels were written into the file's single content layer \
                 (layer structure preserved)"
            }
            PsdSaveBackShape::Flattened => {
                "the adjusted composite was FLATTENED into a NEW single-layer PSD — \
                 any original layer structure is NOT in this file"
            }
            PsdSaveBackShape::Layered => {
                "the layers were written as the file's layers: unedited layers exactly as \
                 they were read (text, smart objects and vector masks included), edited and \
                 new ones with their pixels, masks, vector masks and shape layers, the paths, groups, opacity, fill opacity, blend, \
                 Blend If, knockout, locks, colour labels, visibility, clipping, styles, \
                 colour and gradient fill layers (pattern fills as their rendered pixels) \
                 and adjustment layers"
            }
        }
    }
}

/// The raster re-encode formats the non-PSD lane offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterFormat {
    Png,
    Jpeg,
    /// Lossless WebP (paged-raster has no lossy WebP encoder).
    WebP,
    /// TIFF, LZW-compressed, RGB(A) at 8 bits.
    Tiff,
}

impl RasterFormat {
    pub fn from_wire(s: &str) -> Option<RasterFormat> {
        Some(match s {
            "png" => RasterFormat::Png,
            "jpeg" | "jpg" => RasterFormat::Jpeg,
            "webp" => RasterFormat::WebP,
            "tiff" | "tif" => RasterFormat::Tiff,
            _ => return None,
        })
    }

    pub fn extension(self) -> &'static str {
        match self {
            RasterFormat::Png => ".png",
            RasterFormat::Jpeg => ".jpg",
            RasterFormat::WebP => ".webp",
            RasterFormat::Tiff => ".tif",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            RasterFormat::Png => "image/png",
            RasterFormat::Jpeg => "image/jpeg",
            RasterFormat::WebP => "image/webp",
            RasterFormat::Tiff => "image/tiff",
        }
    }

    /// The engine encoder's name for it.
    pub fn encode_format(self) -> paged_raster::EncodeFormat {
        match self {
            RasterFormat::Png => paged_raster::EncodeFormat::Png,
            RasterFormat::Jpeg => paged_raster::EncodeFormat::Jpeg,
            RasterFormat::WebP => paged_raster::EncodeFormat::WebP,
            RasterFormat::Tiff => paged_raster::EncodeFormat::Tiff,
        }
    }
}

/// WebP and TIFF through the engine's encoder (straight RGBA8 in; an
/// opaque frame is written without its alpha).
fn encode_other(
    rgba: &[u8],
    width: u32,
    height: u32,
    format: RasterFormat,
) -> Result<Vec<u8>, IngestError> {
    let spec = crate::export::ExportSpec {
        keep_metadata: false,
        embed_profile: false,
        ..crate::export::ExportSpec::save_back(format.encode_format(), JPEG_QUALITY_DEFAULT, None)
    };
    crate::export::export(crate::export::Rgba::U8(rgba), width, height, &spec, None)
        .map(|e| e.bytes)
}

/// The fixed v0 JPEG quality for the save-back lane. A quality slider is
/// a follow-up; 90 is the conventional "visually lossless enough for a
/// working file" point.
pub const JPEG_QUALITY_DEFAULT: u8 = 90;

/// The straight-RGBA8 format the save-back speaks (the ingest slice's
/// working shape).
const RGBA8: PixelFormat = PixelFormat {
    channels: ChannelLayout::Rgba,
    depth: SampleDepth::U8,
    alpha: AlphaMode::Straight,
    transfer: Transfer::Linear,
    space: ColorSpaceRef::Named(NamedSpace::LinearSrgb),
};

/// Re-encode straight RGBA8 as PNG or JPEG through the codec targets.
/// One full-frame strip (the targets accumulate and encode at `finish`).
/// What a buffer can be re-expressed as WITHOUT losing a bit.
///
/// Two of these are `ChannelLayout` arms; the third is not, and that
/// asymmetry is the point.
///
/// `ChannelLayout` has no three-channel RGB and is frozen — so dropping
/// a constant-opaque alpha looked unbuildable, and RFI E-6 was filed
/// proposing to amend the enum. Then the type's own doc-comment turned
/// out to prescribe the answer: the spec set (§5.1) omits RGB **on
/// purpose**, and "codec-native layouts that don't appear here (e.g.
/// interleaved RGB without alpha) are described by the codec's
/// `SourceInfo` and converted at the slice boundary". So `Rgb` here is
/// an ENCODE-TIME shape, honoured by `PngTarget::drop_opaque_alpha`,
/// and the frozen type never moves. Reading the comment on the thing I
/// was about to change would have saved filing the row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LosslessShape {
    /// r == g == b everywhere AND every alpha is 255 — one byte per
    /// pixel instead of four.
    Gray,
    /// r == g == b everywhere, alpha varies — two instead of four.
    GrayA,
    /// Colour, but every alpha is 255 — three bytes instead of four.
    /// Not a `ChannelLayout`; the codec converts at the slice boundary.
    Rgb,
    /// Nothing to reduce.
    Rgba,
}

/// Classify a straight-RGBA8 buffer. One pass, and it stops early on
/// the first pixel that rules both reductions out — the common case
/// (a colour photograph) exits within a few pixels.
pub fn lossless_shape(rgba: &[u8]) -> LosslessShape {
    let mut grey = true;
    let mut opaque = true;
    for px in rgba.as_chunks::<4>().0 {
        if px[0] != px[1] || px[1] != px[2] {
            grey = false;
        }
        if px[3] != 255 {
            opaque = false;
        }
        // Both ruled out: nothing further can change the answer.
        if !grey && !opaque {
            return LosslessShape::Rgba;
        }
    }
    match (grey, opaque) {
        (true, true) => LosslessShape::Gray,
        (true, false) => LosslessShape::GrayA,
        (false, true) => LosslessShape::Rgb,
        (false, false) => LosslessShape::Rgba,
    }
}

/// [`encode_rgba8`] with the two knobs the fixed-quality version has
/// not got: a JPEG `quality`, and a LOSSLESS channel reduction for PNG.
///
/// The reduction is not a quality setting — it re-expresses a buffer
/// that was already greyscale in a layout that says so, so the decoded
/// pixels are identical byte for byte. It pays on exactly the images
/// that are largest and most often greyscale: scans, masks, line art,
/// alpha mattes.
pub fn encode_rgba8_opt(
    rgba: &[u8],
    width: u32,
    height: u32,
    format: RasterFormat,
    quality: u8,
    reduce: bool,
) -> Result<Vec<u8>, IngestError> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        return Err(IngestError::Decode(format!(
            "encode: {} bytes for {width}x{height} (expected {expected})",
            rgba.len()
        )));
    }
    if matches!(format, RasterFormat::WebP | RasterFormat::Tiff) {
        return encode_other(rgba, width, height, format);
    }
    let err = |e: image_codecs::CodecError| IngestError::Decode(e.to_string());
    let region = Region::new(0, 0, width, height);

    // JPEG has no alpha and no indexed mode, so the reduction is a PNG
    // affair; quality is the JPEG one. Neither knob crosses over.
    if format == RasterFormat::Jpeg {
        let info = TargetInfo {
            width,
            height,
            format: RGBA8,
            icc: None,
        };
        let slice = TileSliceRef {
            region,
            format: RGBA8,
            row_stride: width as usize * 4,
            bytes: rgba,
        };
        let mut t = JpegTarget::new(quality.clamp(1, 100));
        t.begin(info).map_err(err)?;
        t.write_strip(region, &slice).map_err(err)?;
        t.finish().map_err(err)?;
        return Ok(t.into_bytes());
    }

    let shape = if reduce {
        lossless_shape(rgba)
    } else {
        LosslessShape::Rgba
    };
    let (channels, packed) = match shape {
        // Rgb is not a ChannelLayout: the buffer stays RGBA here and
        // the CODEC drops the plane, per the slice-boundary rule.
        LosslessShape::Rgb | LosslessShape::Rgba => (ChannelLayout::Rgba, None),
        LosslessShape::Gray => (
            ChannelLayout::Gray,
            Some(
                rgba.as_chunks::<4>()
                    .0
                    .iter()
                    .map(|p| p[0])
                    .collect::<Vec<u8>>(),
            ),
        ),
        LosslessShape::GrayA => (
            ChannelLayout::GrayA,
            Some(
                rgba.as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|p| [p[0], p[3]])
                    .collect::<Vec<u8>>(),
            ),
        ),
    };
    let fmt = PixelFormat { channels, ..RGBA8 };
    let bytes: &[u8] = packed.as_deref().unwrap_or(rgba);
    let info = TargetInfo {
        width,
        height,
        format: fmt,
        icc: None,
    };
    let slice = TileSliceRef {
        region,
        format: fmt,
        row_stride: width as usize * usize::from(channels.count()),
        bytes,
    };
    let mut t = PngTarget::new().drop_opaque_alpha(shape == LosslessShape::Rgb);
    t.begin(info).map_err(err)?;
    t.write_strip(region, &slice).map_err(err)?;
    t.finish().map_err(err)?;
    Ok(t.into_bytes())
}

pub fn encode_rgba8(
    rgba: &[u8],
    width: u32,
    height: u32,
    format: RasterFormat,
) -> Result<Vec<u8>, IngestError> {
    let expected = (width as usize) * (height as usize) * 4;
    if rgba.len() != expected {
        return Err(IngestError::Decode(format!(
            "encode: {} bytes for {width}x{height} (expected {expected})",
            rgba.len()
        )));
    }
    let info = TargetInfo {
        width,
        height,
        format: RGBA8,
        icc: None,
    };
    let region = Region::new(0, 0, width, height);
    let slice = TileSliceRef {
        region,
        format: RGBA8,
        row_stride: width as usize * 4,
        bytes: rgba,
    };
    let err = |e: image_codecs::CodecError| IngestError::Decode(e.to_string());
    match format {
        RasterFormat::Png => {
            let mut t = PngTarget::new();
            t.begin(info).map_err(err)?;
            t.write_strip(region, &slice).map_err(err)?;
            t.finish().map_err(err)?;
            Ok(t.into_bytes())
        }
        RasterFormat::Jpeg => {
            let mut t = JpegTarget::new(JPEG_QUALITY_DEFAULT);
            t.begin(info).map_err(err)?;
            t.write_strip(region, &slice).map_err(err)?;
            t.finish().map_err(err)?;
            Ok(t.into_bytes())
        }
        RasterFormat::WebP | RasterFormat::Tiff => encode_other(rgba, width, height, format),
    }
}

/// Split interleaved straight RGBA8 into the planar channels the PSD
/// sections want: `[R, G, B]`, plus `A` when `with_alpha`.
fn planes_from_rgba8(rgba: &[u8], n: usize, with_alpha: bool) -> Vec<Vec<u8>> {
    let count = if with_alpha { 4 } else { 3 };
    let mut planes = vec![vec![0u8; n]; count];
    for (c, plane) in planes.iter_mut().enumerate() {
        for (i, out) in plane.iter_mut().enumerate().take(n) {
            *out = rgba[i * 4 + c];
        }
    }
    planes
}

/// Encode the MERGED composite section: one compression tag for ALL
/// channels, then — for RLE — a single row-count table covering
/// `channels · height` scanlines, then the packed rows in channel-major
/// order (`image_psd::composite` documents the read side).
fn encode_composite_rle(
    planes: &[Vec<u8>],
    file: &PsdFile,
    width: u32,
    height: u32,
) -> Result<GlobalImageData, IngestError> {
    let mut counts: Vec<u8> = Vec::new();
    let mut rows_out: Vec<u8> = Vec::new();
    for plane in planes {
        let cd = ChannelData::encode_rle(plane, file.container, height, width)
            .map_err(|e| IngestError::Decode(e.to_string()))?;
        // `encode_rle` emits [count table | packed rows] for ONE plane;
        // the composite section wants ALL count tables first, so split at
        // the table width (`rows · count_width`).
        let cw = match file.container {
            image_psd::Container::Psb => 4usize,
            _ => 2usize,
        };
        let split = (height as usize) * cw;
        if cd.bytes.len() < split {
            return Err(IngestError::Decode(
                "composite RLE encode produced a short count table".into(),
            ));
        }
        counts.extend_from_slice(&cd.bytes[..split]);
        rows_out.extend_from_slice(&cd.bytes[split..]);
    }
    counts.extend_from_slice(&rows_out);
    Ok(GlobalImageData {
        compression: Compression::Rle.code(),
        raw: counts,
    })
}

/// Is this record a section divider / folder marker rather than pixel
/// content? (`lsct` kinds — a folder open/closed record or its bounding
/// divider carries no meaningful canvas pixels.)
fn is_divider(layer: &LayerRecord) -> bool {
    layer.addl.iter().any(|a| a.lsct().is_some())
}

/// Build the ONE layer record a flattened save-back emits.
fn single_layer(
    planes: &[Vec<u8>],
    file_container: image_psd::Container,
    width: u32,
    height: u32,
    with_alpha: bool,
) -> Result<LayerRecord, IngestError> {
    // Conventional order: transparency (-1) first, then R/G/B (0/1/2).
    let mut ids: Vec<i16> = Vec::new();
    let mut order: Vec<usize> = Vec::new();
    if with_alpha {
        ids.push(-1);
        order.push(3);
    }
    for (k, id) in [0i16, 1, 2].iter().enumerate() {
        ids.push(*id);
        order.push(k);
    }
    let mut channels = Vec::with_capacity(ids.len());
    let mut channel_data = Vec::with_capacity(ids.len());
    for (id, plane_idx) in ids.iter().zip(order.iter()) {
        let cd = ChannelData::encode_rle(&planes[*plane_idx], file_container, height, width)
            .map_err(|e| IngestError::Decode(e.to_string()))?;
        channels.push(ChannelInfo {
            id: *id,
            data_len: 2 + cd.bytes.len() as u64,
        });
        channel_data.push(cd);
    }
    Ok(LayerRecord {
        top: 0,
        left: 0,
        bottom: height as i32,
        right: width as i32,
        channels,
        blend_sig: *b"8BIM",
        blend_key: *b"norm",
        opacity: 255,
        clipping: 0,
        flags: 0,
        filler: 0,
        mask: None,
        blend_ranges: BlendRanges::default(),
        name_legacy: PascalString::new("Adjusted"),
        addl: Vec::new(),
        extra_raw: None,
        channel_data,
    })
}

/// Write the ADJUSTED full-resolution `rgba` (straight RGBA8, row-major)
/// back into the retained PSD parse. Returns the shape the caller must
/// report to the user. The file is left ready for
/// `image_psd::PsdFile::write` (the preservation writer).
///
/// Rejects — cleanly, never a wrong-looking file — anything outside the
/// 8-bit RGB cut or a dimension mismatch against the parsed header.
pub fn psd_write_adjusted(
    file: &mut PsdFile,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<PsdSaveBackShape, IngestError> {
    if file.header.depth != 8 {
        return Err(IngestError::Unsupported(format!(
            "PSD save-back at depth {} (8-bit only)",
            file.header.depth
        )));
    }
    if file.header.color_mode != ColorMode::Rgb {
        return Err(IngestError::Unsupported(format!(
            "PSD save-back for color mode {:?} (RGB only; Grayscale/CMYK/Lab are the \
             M2 cast lane)",
            file.header.color_mode
        )));
    }
    if file.header.width != width || file.header.height != height {
        return Err(IngestError::Unsupported(format!(
            "PSD save-back size mismatch: the engine image is {width}x{height}, the PSD \
             is {}x{} (crop/resize the PSD lane is a follow-up)",
            file.header.width, file.header.height
        )));
    }
    let n = (width as usize) * (height as usize);
    if rgba.len() != n * 4 {
        return Err(IngestError::Decode(format!(
            "PSD save-back: {} bytes for {width}x{height} (expected {})",
            rgba.len(),
            n * 4
        )));
    }

    // Alpha travels only when the parse already declared a merged
    // transparency channel (the layer-count sign flag) — inventing one
    // would change how every reader interprets the extra plane.
    let with_alpha = file.header.channels >= 4 && file.layer_mask.transparency_in_merged;
    let planes = planes_from_rgba8(rgba, n, with_alpha);
    let plane_count = planes.len() as u16;

    // Can the single-layer in-place path run? It needs exactly ONE
    // content record, covering the canvas, whose channel ids we can all
    // address, and a header channel count that already matches what we
    // write (a spot-channel file cannot keep its composite consistent).
    let content: Vec<usize> = file
        .layer_mask
        .layers
        .iter()
        .enumerate()
        .filter(|(_, l)| !is_divider(l))
        .map(|(i, _)| i)
        .collect();
    let in_place = content.len() == 1 && file.header.channels == plane_count && {
        let l = &file.layer_mask.layers[content[0]];
        l.top == 0
            && l.left == 0
            && l.right == width as i32
            && l.bottom == height as i32
            && l.channels.iter().all(|c| (-1..=2).contains(&c.id))
            && l.channels.len() == planes.len()
    };

    // The merged composite is rewritten in EVERY path — it is the file's
    // own render oracle, and a stale one would show the un-adjusted image
    // in every reader that trusts it.
    file.composite = encode_composite_rle(&planes, file, width, height)?;
    file.header.channels = plane_count;

    if in_place {
        let idx = content[0];
        let ids: Vec<i16> = file.layer_mask.layers[idx]
            .channels
            .iter()
            .map(|c| c.id)
            .collect();
        for (ci, id) in ids.iter().enumerate() {
            let plane = match id {
                0 => &planes[0],
                1 => &planes[1],
                2 => &planes[2],
                -1 => &planes[3],
                other => {
                    return Err(IngestError::Decode(format!(
                        "unexpected layer channel id {other} after the in-place gate"
                    )))
                }
            };
            image_psd::edit::replace_channel_pixels(
                file,
                idx,
                ci,
                plane,
                Compression::Rle,
                height,
                width,
            )
            .map_err(|e| IngestError::Decode(e.to_string()))?;
        }
        return Ok(PsdSaveBackShape::LayerReplaced);
    }

    // Flatten: ONE synthesized canvas-sized layer carrying the adjusted
    // pixels replaces the record list. The header/resources (ICC!) and
    // every document-level block survive; the layer TREE does not — the
    // caller announces that.
    let layer = single_layer(&planes, file.container, width, height, with_alpha)?;
    file.layer_mask.layers = vec![layer];
    file.layer_mask.transparency_in_merged = with_alpha;
    file.layer_mask.section_raw = None;
    Ok(PsdSaveBackShape::Flattened)
}

pub use crate::psd_write::psd_write_stack;

#[cfg(test)]
mod tests {
    use super::*;
    use image_gpu::SelectionCoverage;
    use image_psd::model::SectionKind;

    /// A 2×1 8-bit RGB PSD (RAW composite, no layers) — the same shape
    /// the glue's `psdBytes()` fixture builds.
    fn flat_psd() -> Vec<u8> {
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"8BPS");
        b.extend_from_slice(&1u16.to_be_bytes()); // version
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&3u16.to_be_bytes()); // channels
        b.extend_from_slice(&1u32.to_be_bytes()); // height
        b.extend_from_slice(&2u32.to_be_bytes()); // width
        b.extend_from_slice(&8u16.to_be_bytes()); // depth
        b.extend_from_slice(&3u16.to_be_bytes()); // RGB
        b.extend_from_slice(&0u32.to_be_bytes()); // color mode data
        b.extend_from_slice(&0u32.to_be_bytes()); // resources
        b.extend_from_slice(&0u32.to_be_bytes()); // layer & mask
        b.extend_from_slice(&0u16.to_be_bytes()); // RAW
        b.extend_from_slice(&[10, 20, 30, 40, 50, 60]); // R, G, B planes
        b
    }

    // feat: image.editor.saveback — the PSD lane writes the adjusted
    // composite and (with no addressable single layer) flattens.
    #[test]
    fn image_editor_saveback_psd_round_trips_the_adjusted_pixels() {
        let mut file = PsdFile::parse(&flat_psd()).expect("parse");
        // Adjusted pixels: (1,2,3,255) and (4,5,6,255).
        let rgba = vec![1u8, 2, 3, 255, 4, 5, 6, 255];
        let shape = psd_write_adjusted(&mut file, 2, 1, &rgba).expect("save-back");
        assert_eq!(
            shape,
            PsdSaveBackShape::Flattened,
            "a layerless PSD gains the synthesized single layer"
        );
        let bytes = file.write().expect("write");
        let back = PsdFile::parse(&bytes).expect("reparse");
        let comp = back.composite_rgba8().expect("composite");
        assert_eq!(
            comp.rgba, rgba,
            "the merged composite carries the adjustment"
        );
        assert_eq!(back.layer_mask.layers.len(), 1, "single-layer result");
        assert_eq!(back.layer_mask.layers[0].name(), "Adjusted");
    }

    #[test]
    fn image_editor_saveback_psd_replaces_a_single_full_canvas_layer_in_place() {
        // Build a PSD with exactly one canvas-sized RGB layer, then adjust.
        let mut file = PsdFile::parse(&flat_psd()).expect("parse");
        let planes = planes_from_rgba8(&[9u8, 9, 9, 255, 9, 9, 9, 255], 2, false);
        let layer = single_layer(&planes, file.container, 2, 1, false).expect("layer");
        file.layer_mask.layers = vec![layer];
        file.layer_mask.section_raw = None;
        let bytes = file.write().expect("write seed");
        let mut seeded = PsdFile::parse(&bytes).expect("reparse seed");

        let rgba = vec![7u8, 8, 9, 255, 10, 11, 12, 255];
        let shape = psd_write_adjusted(&mut seeded, 2, 1, &rgba).expect("save-back");
        assert_eq!(shape, PsdSaveBackShape::LayerReplaced);
        assert_eq!(
            seeded.layer_mask.layers.len(),
            1,
            "no records added/removed"
        );
        let out = seeded.write().expect("write");
        let back = PsdFile::parse(&out).expect("reparse");
        assert_eq!(back.composite_rgba8().expect("composite").rgba, rgba);
        assert_eq!(back.layer_mask.layers[0].name(), "Adjusted", "name kept");
    }

    #[test]
    fn image_editor_saveback_psd_rejects_a_size_mismatch() {
        let mut file = PsdFile::parse(&flat_psd()).expect("parse");
        let err = psd_write_adjusted(&mut file, 4, 4, &[0u8; 64]).unwrap_err();
        assert!(matches!(err, IngestError::Unsupported(_)), "got {err:?}");
    }

    // feat: image.editor.saveback — the PNG/JPEG lane.
    #[test]
    fn image_editor_saveback_png_encodes_a_readable_png() {
        let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255];
        let png = encode_rgba8(&rgba, 2, 1, RasterFormat::Png).expect("png");
        assert_eq!(&png[..4], &[0x89, b'P', b'N', b'G'], "PNG magic");
        // And it decodes back to the same pixels through the ingest lane.
        let back = crate::ingest::decode_rgba8(&png).expect("decode");
        assert_eq!((back.width, back.height), (2, 1));
        assert_eq!(&back.rgba.to_rgba8()[..], &rgba[..]);
    }

    #[test]
    fn image_editor_saveback_jpeg_encodes_a_readable_jpeg() {
        let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255];
        let jpg = encode_rgba8(&rgba, 2, 1, RasterFormat::Jpeg).expect("jpeg");
        assert_eq!(&jpg[..3], &[0xFF, 0xD8, 0xFF], "JPEG SOI");
        // Lossy: assert it DECODES at the right size, not bit equality.
        let back = crate::ingest::decode_rgba8(&jpg).expect("decode");
        assert_eq!((back.width, back.height), (2, 1));
    }

    #[test]
    fn image_editor_saveback_encode_rejects_a_length_mismatch() {
        assert!(encode_rgba8(&[0u8; 6], 2, 1, RasterFormat::Png).is_err());
    }

    #[test]
    fn image_editor_saveback_raster_format_names_round_trip() {
        assert_eq!(RasterFormat::from_wire("png"), Some(RasterFormat::Png));
        assert_eq!(RasterFormat::from_wire("jpg"), Some(RasterFormat::Jpeg));
        assert_eq!(RasterFormat::from_wire("jpeg"), Some(RasterFormat::Jpeg));
        assert_eq!(RasterFormat::from_wire("webp"), Some(RasterFormat::WebP));
        assert_eq!(RasterFormat::from_wire("tif"), Some(RasterFormat::Tiff));
        assert_eq!(RasterFormat::from_wire("bmp"), None);
        assert_eq!(RasterFormat::Png.extension(), ".png");
        assert_eq!(RasterFormat::Jpeg.mime(), "image/jpeg");
        assert_eq!(RasterFormat::Tiff.extension(), ".tif");
    }

    #[test]
    #[allow(non_snake_case)]
    fn webp_and_tiff_reencode_losslessly__feat__image_codec_core_codecs() {
        let rgba: Vec<u8> = (0..4 * 3 * 4).map(|i| (i * 7) as u8 | 1).collect();
        let rgba: Vec<u8> = rgba
            .chunks(4)
            .flat_map(|p| [p[0], p[1], p[2], 200])
            .collect();
        for f in [RasterFormat::WebP, RasterFormat::Tiff] {
            let bytes = encode_rgba8(&rgba, 4, 3, f).unwrap();
            let back = crate::ingest::decode_rgba8(&bytes).unwrap();
            assert_eq!((back.width, back.height), (4, 3), "{f:?}");
            assert_eq!(&back.rgba.to_rgba8()[..], &rgba[..], "{f:?}");
        }
    }

    /// A 4×2 stack: background, a grouped + clipped + masked layer, a
    /// hidden one — every property the layered save writes.
    fn layered_stack() -> crate::layers::LayerStack {
        use crate::layers::LayerStack;
        use image_core::Region;
        let solid = |v: u8| std::sync::Arc::from(vec![v; 4 * 2 * 4].into_boxed_slice());
        let mut s = LayerStack::from_image(4, 2, solid(40)).expect("stack");
        s.add("Grain ✓");
        s.edit_active(
            "p",
            Region::new(0, 0, 4, 2),
            crate::pixels::Pixels::from_rgba8(solid(200)),
        )
        .expect("paint");
        s.set_opacity(1, 0.5).expect("o");
        s.set_blend(1, "multiply").expect("b");
        s.set_clipped(1, true).expect("c");
        let cov =
            image_gpu::SelectionCoverage::from_data(4, 2, vec![255, 0, 255, 0, 255, 0, 255, 0])
                .expect("cov");
        s.set_mask(1, std::sync::Arc::new(cov)).expect("m");
        s.add("Hidden");
        s.set_visible(2, false).expect("v");
        s.group_range(1, 2, "Look").expect("g");
        s
    }

    fn psd_4x2() -> Vec<u8> {
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"8BPS");
        b.extend_from_slice(&1u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 6]);
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&2u32.to_be_bytes()); // height
        b.extend_from_slice(&4u32.to_be_bytes()); // width
        b.extend_from_slice(&8u16.to_be_bytes());
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u16.to_be_bytes());
        b.extend_from_slice(&[9u8; 24]);
        b
    }

    fn write_layered() -> Vec<u8> {
        let s = layered_stack();
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        let composite = vec![77u8; 4 * 2 * 4];
        assert_eq!(
            psd_write_stack(&mut f, &s, &composite).expect("write"),
            PsdSaveBackShape::Layered
        );
        f.write().expect("serialize")
    }

    #[test]
    #[allow(non_snake_case)]
    fn a_layer_stack_is_written_as_psd_layers__feat__image_io_save_back() {
        let bytes = write_layered();
        let f = PsdFile::parse(&bytes).expect("the written file parses");
        let names: Vec<String> = f
            .layer_mask
            .layers
            .iter()
            .map(|l| {
                l.addl
                    .iter()
                    .find_map(|a| a.unicode_name())
                    .unwrap_or_default()
            })
            .collect();
        // Bottom-first: background, the group's closing divider, its
        // members, then the folder record above them.
        assert_eq!(
            names,
            vec!["Background", "</Layer group>", "Grain ✓", "Hidden", "Look"]
        );
        let kinds: Vec<Option<SectionKind>> = f
            .layer_mask
            .layers
            .iter()
            .map(|l| l.addl.iter().find_map(|a| a.lsct()).map(|d| d.kind))
            .collect();
        assert_eq!(kinds[1], Some(SectionKind::BoundingDivider));
        assert_eq!(kinds[4], Some(SectionKind::OpenFolder));
        let grain = &f.layer_mask.layers[2];
        assert_eq!(grain.opacity, 128);
        assert_eq!(&grain.blend_key, b"mul ");
        assert_eq!(grain.clipping, 1);
        assert!(grain.mask.is_some());
        assert!(
            grain.channels.iter().any(|c| c.id == -2),
            "the mask channel"
        );
        assert_eq!(f.layer_mask.layers[3].flags & 0x02, 0x02, "hidden");
        assert_eq!(
            &f.layer_mask.layers[4].blend_key, b"pass",
            "pass-through group"
        );
        assert!(f.layer_mask.transparency_in_merged);
        // Writing the parsed file again changes nothing.
        assert_eq!(f.write().expect("rewrite"), bytes);
    }

    /// What the writer stores, the import reads back: the group (name,
    /// pass-through, members), the user mask, clipping, blend, opacity
    /// and visibility — a layered PSD round-trips through Paged.
    #[test]
    #[allow(non_snake_case)]
    fn a_written_layered_psd_imports_back_as_the_same_stack__feat__image_psd_layer_import() {
        let bytes = write_layered();
        let f = PsdFile::parse(&bytes).expect("parse");
        let import = f.layer_plates_rgba8().expect("groups and masks import");
        let back = crate::layers::LayerStack::from_psd_plates(&import).expect("stack");
        let orig = layered_stack();
        assert_eq!(back.layers().len(), orig.layers().len());
        assert_eq!(back.groups().len(), 1);
        let g = &back.groups()[0];
        assert_eq!(g.name, "Look");
        assert!(g.pass_through);
        for (a, b) in back.layers().iter().zip(orig.layers()) {
            assert_eq!(a.name, b.name);
            assert_eq!(a.visible, b.visible);
            assert_eq!(a.clipped, b.clipped);
            assert_eq!(a.blend.id, b.blend.id);
            assert!((a.opacity - b.opacity).abs() <= 0.5 / 255.0 + 1e-6);
            assert_eq!(a.group.is_some(), b.group.is_some(), "{}", a.name);
            assert_eq!(
                a.mask.as_ref().map(|m| m.canvas().data().to_vec()),
                b.mask.as_ref().map(|m| m.canvas().data().to_vec()),
                "{}",
                a.name
            );
        }
    }

    /// The colour records of a written file, top-level pixel layers only:
    /// (record, the decoded planes by channel id).
    fn pixel_planes(f: &PsdFile, rec: usize) -> Vec<(i16, Vec<u16>)> {
        let r = &f.layer_mask.layers[rec];
        let (rows, cols) = ((r.bottom - r.top) as u32, (r.right - r.left) as u32);
        r.channels
            .iter()
            .zip(&r.channel_data)
            .filter(|(c, _)| c.id >= -1)
            .map(|(c, d)| {
                let v: Vec<u16> = if f.header.depth == 16 {
                    d.decode_samples16(rows, cols).expect("16-bit plane")
                } else {
                    d.decode(f.container, rows, cols, 8)
                        .expect("8-bit plane")
                        .into_iter()
                        .map(u16::from)
                        .collect()
                };
                (c.id, v)
            })
            .collect()
    }

    /// Image ▸ Mode, then the layered save: the file is written in the
    /// document's NEW mode and depth — header, every layer's channels as
    /// that mode's samples, the profile its values are in (image ADR 481).
    #[test]
    #[allow(non_snake_case)]
    fn a_converted_document_is_saved_in_its_new_mode_and_depth__feat__image_io_depth_color_modes() {
        use crate::color_mode::{ColorMode as M, DocMode, ModeTransform};
        use image_core::SampleDepth;
        use image_psd::model::ColorMode as P;
        for (mode, depth, psd, ids) in [
            (M::Gray, SampleDepth::U8, P::Grayscale, vec![-1, 0]),
            (M::Gray, SampleDepth::U16, P::Grayscale, vec![-1, 0]),
            (M::Lab, SampleDepth::U8, P::Lab, vec![-1, 0, 1, 2]),
            (M::Lab, SampleDepth::U16, P::Lab, vec![-1, 0, 1, 2]),
            (M::Rgb, SampleDepth::U16, P::Rgb, vec![-1, 0, 1, 2]),
        ] {
            let mut s = layered_stack();
            s.set_depth(depth).expect("depth");
            let doc = DocMode {
                mode,
                cmyk_profile: None,
                table: None,
            };
            s.set_mode(doc.clone()).expect("mode");
            let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
            assert_eq!(
                psd_write_stack(&mut f, &s, &[90u8; 32]).expect("written"),
                PsdSaveBackShape::Layered
            );
            let f = PsdFile::parse(&f.write().expect("bytes")).expect("reparse");
            let sixteen = depth == SampleDepth::U16;
            assert_eq!(f.header.color_mode, psd, "{mode:?}");
            assert_eq!(f.header.depth, if sixteen { 16 } else { 8 });
            assert_eq!(f.header.channels as usize, ids.len());
            assert_eq!(f.layer_mask.deep_key.is_some(), sixteen);
            match mode {
                M::Gray => assert_eq!(
                    &f.resources.icc_profile().expect("grey ICC")[16..20],
                    b"GRAY"
                ),
                M::Lab => assert!(
                    f.resources.icc_profile().is_none(),
                    "Lab carries no profile"
                ),
                _ => assert!(f.resources.icc_profile().is_none()),
            }
            // The painted layer ("Grain ✓", 200 grey) in every channel.
            let rec = f
                .layer_mask
                .layers
                .iter()
                .position(|r| r.name_legacy.raw.windows(5).any(|w| w == b"Grain"))
                .expect("the painted layer's record");
            let planes = pixel_planes(&f, rec);
            let got: Vec<i16> = planes.iter().map(|(id, _)| *id).collect();
            assert_eq!(got, ids, "{mode:?} channel ids");
            let px = s.layers()[1].rgba.canvas().clone();
            let full = if sixteen { 65535.0 } else { 255.0 };
            let rgb: Vec<f32> = (0..3)
                .map(|c| f32::from(px.sample16(0, c)) / 65535.0)
                .collect();
            let want: Vec<f32> = match ModeTransform::new(&doc).expect("t") {
                Some(t) => {
                    let d = t.device_of(&rgb);
                    match mode {
                        M::Lab if sixteen => {
                            vec![
                                d[0] / 100.0 * full,
                                d[1] * 256.0 + 32768.0,
                                d[2] * 256.0 + 32768.0,
                            ]
                        }
                        M::Lab => vec![d[0] / 100.0 * full, d[1] + 128.0, d[2] + 128.0],
                        _ => vec![d[0] * full],
                    }
                }
                None => rgb.iter().map(|v| v * full).collect(),
            };
            for (k, w) in want.iter().enumerate() {
                let v = f32::from(planes[k + 1].1[0]);
                assert!(
                    (v - w).abs() <= 1.0,
                    "{mode:?} {depth:?} channel {k}: {v} vs {w}"
                );
            }
        }
    }

    /// A 32-bit document (image ADR 483) is saved as one: depth 32, its
    /// layers in `Lr32` as linear floats, the composite RAW floats — and
    /// reads back through the import as the floats it wrote.
    #[test]
    #[allow(non_snake_case)]
    fn a_32bit_document_is_saved_and_reopened_as_floats__feat__image_io_depth_color_modes() {
        let mut s = layered_stack();
        s.set_depth(image_core::SampleDepth::F32).expect("32 bits");
        let composite = pollster::block_on(s.composite_px(None, None)).expect("fold");
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        crate::psd_write::psd_write_stack_px(&mut f, &s, &composite).expect("written");
        let f = PsdFile::parse(&f.write().expect("bytes")).expect("reparse");
        assert_eq!(f.header.depth, 32);
        assert_eq!(f.layer_mask.deep_key, Some(*b"Lr32"));
        let merged = f.composite_samples().expect("float composite");
        assert_eq!(merged.depth, 32);
        let want = composite.to_f32_linear();
        let alpha = merged.alpha.expect("transparency");
        for i in 0..8 {
            assert!((alpha[i] - want[i * 4 + 3]).abs() < 1e-6);
        }
        let import = f.layer_plates_rgba8().expect("float layers import");
        let back = crate::layers::LayerStack::from_psd_plates_with(
            &import,
            Some(&f.layer_mask.layers),
        )
        .expect("stack");
        assert_eq!(back.depth(), image_core::SampleDepth::F32);
        for (a, b) in back.layers().iter().zip(s.layers()) {
            assert_eq!(
                a.rgba.canvas().to_f32_linear(),
                b.rgba.canvas().to_f32_linear(),
                "{}",
                b.name
            );
        }
    }

    /// Indexed Color… and Multichannel (image ADR 483): the stack is
    /// flattened into its mode as one undo step, an edit stays in the
    /// table's colours, and the save writes the one image Photoshop keeps —
    /// the colour table or the named inks, no layer records — which
    /// decodes back to the composite.
    #[test]
    #[allow(non_snake_case)]
    fn indexed_and_multichannel_documents_flatten_and_save_as_one_image__feat__image_io_depth_color_modes(
    ) {
        use crate::color_mode::{web_palette, ColorMode as M, DocMode};
        let mut s = layered_stack();
        let steps = s.history().depth;
        assert!(pollster::block_on(s.convert_flat(None, DocMode::indexed(web_palette())))
            .expect("indexed"));
        assert_eq!(s.history().depth, steps + 1, "one undo step");
        assert_eq!(s.len(), 1, "flattened");
        assert_eq!(s.mode().mode, M::Indexed);
        let web = web_palette();
        let on_table = |px: &crate::pixels::Pixels| {
            px.to_rgba8()
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| web.contains(&[p[0], p[1], p[2]]))
        };
        assert!(on_table(s.layers()[0].rgba.canvas()));
        // A brush colour lands as the nearest table colour.
        let paint = std::sync::Arc::from(vec![17u8, 200, 99, 255].repeat(8).into_boxed_slice());
        s.edit_active(
            "Brush",
            image_core::Region::new(0, 0, 4, 2),
            crate::pixels::Pixels::from_rgba8(paint),
        )
        .expect("paint");
        assert!(on_table(s.layers()[0].rgba.canvas()));
        assert_eq!(&s.layers()[0].rgba.canvas().to_rgba8()[..3], &[0, 204, 102]);
        let composite = pollster::block_on(s.composite_px(None, None)).expect("composite");
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        crate::psd_write::psd_write_stack_px(&mut f, &s, &composite).expect("written");
        let bytes = f.write().expect("bytes");
        let f = PsdFile::parse(&bytes).expect("reparse");
        assert_eq!(f.header.color_mode, image_psd::model::ColorMode::Indexed);
        assert_eq!((f.header.channels, f.header.depth), (1, 8));
        assert!(f.layer_mask.layers.is_empty());
        assert_eq!(f.indexed_palette().expect("table").count, Some(216));
        let img = crate::ingest::decode_rgba8(&bytes).expect("decodes");
        assert_eq!(&*img.rgba.to_rgba8(), &*composite.to_rgba8());
        assert_eq!(DocMode::of_psd(&f).expect("mode"), s.mode().clone());

        // Multichannel from RGB: three inks, the RGB values (flattened
        // over white first, as the conversion flattens).
        let mut s = layered_stack();
        pollster::block_on(s.flatten(None)).expect("flatten");
        let before = pollster::block_on(s.composite(None, None)).expect("composite");
        let m = DocMode::multichannel_from(M::Rgb).expect("from RGB");
        assert!(pollster::block_on(s.convert_flat(None, m)).expect("multichannel"));
        let composite = pollster::block_on(s.composite_px(None, None)).expect("composite");
        assert_eq!(&*composite.to_rgba8(), &*before, "its inks change no colour");
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        crate::psd_write::psd_write_stack_px(&mut f, &s, &composite).expect("written");
        let bytes = f.write().expect("bytes");
        let f = PsdFile::parse(&bytes).expect("reparse");
        assert_eq!(f.header.color_mode, image_psd::model::ColorMode::Multichannel);
        assert_eq!(f.header.channels, 3);
        assert_eq!(crate::color_mode::spot_names(&f), ["Cyan", "Magenta", "Yellow"]);
        let img = crate::ingest::decode_rgba8(&bytes).expect("decodes");
        assert_eq!(&*img.rgba.to_rgba8(), &*before);
        assert_eq!(DocMode::of_psd(&f).expect("mode"), s.mode().clone());
        // Converting it back to RGB is a plain mode change.
        assert!(s.set_mode(DocMode::rgb()).expect("rgb"));
        // Duotone has no conversion (its inks' format is undocumented).
        assert!(s
            .set_mode(DocMode {
                mode: M::Duotone,
                cmyk_profile: None,
                table: None,
            })
            .is_err());
    }

    /// What the stack evaluates in RGB is refused in a converted mode, so
    /// the caller flattens and says why: an adjustment layer (Photoshop
    /// applies it to the mode's channels) and Blend If (per channel).
    #[test]
    #[allow(non_snake_case)]
    fn a_converted_document_refuses_what_rgb_evaluates__feat__image_io_depth_color_modes() {
        use crate::color_mode::{ColorMode as M, DocMode};
        let gray = DocMode {
            mode: M::Gray,
            cmyk_profile: None,
            table: None,
        };
        let mut s = layered_stack();
        s.add_adjustment_layer(
            "",
            crate::layers::Adjustment::default_for("vibrance").expect("kind"),
            None,
        );
        s.set_mode(gray.clone()).expect("mode");
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        let err = psd_write_stack(&mut f, &s, &[0u8; 32]).expect_err("refused");
        assert!(
            err.to_string().contains("converted to another colour mode"),
            "{err}"
        );
        // Only the depth changed: an adjustment layer is written.
        let mut s = layered_stack();
        s.add_adjustment_layer(
            "",
            crate::layers::Adjustment::default_for("vibrance").expect("kind"),
            None,
        );
        s.set_depth(image_core::SampleDepth::U16).expect("depth");
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        assert_eq!(
            psd_write_stack(&mut f, &s, &[0u8; 32]).expect("written"),
            PsdSaveBackShape::Layered
        );
    }

    /// A GROUP's mask is written on its folder record and read back,
    /// switch included.
    #[test]
    #[allow(non_snake_case)]
    fn a_group_mask_is_written_and_imports_back__feat__image_psd_layer_import() {
        let mut s = layered_stack();
        let id = s.groups()[0].id;
        let cov = SelectionCoverage::from_data(4, 2, vec![255, 200, 100, 0, 0, 50, 150, 255])
            .expect("cov");
        s.set_group_mask(id, Some(std::sync::Arc::new(cov.clone())), false)
            .expect("group mask");
        let mut file = PsdFile::parse(&psd_4x2()).expect("seed");
        let composite = vec![0u8; 4 * 2 * 4];
        psd_write_stack(&mut file, &s, &composite).expect("written");
        let bytes = file.write().expect("bytes");
        let f = PsdFile::parse(&bytes).expect("parse");
        let import = f.layer_plates_rgba8().expect("a masked group imports");
        let back = crate::layers::LayerStack::from_psd_plates(&import).expect("stack");
        let g = &back.groups()[0];
        assert_eq!(
            g.mask.as_deref().map(|m| m.data().to_vec()),
            Some(cov.data().to_vec())
        );
        assert!(!g.mask_enabled, "the switch survives");
    }

    /// An adjustment kind Photoshop has no adjustment layer for refuses the
    /// layered save (so the caller flattens and says why); every other
    /// kind is written.
    #[test]
    #[allow(non_snake_case)]
    fn an_unwritable_adjustment_layer_is_refused_for_the_flatten_fallback__feat__image_io_save_back(
    ) {
        use crate::layers::Adjustment;
        // Develop (WP5.2) has no Photoshop adjustment layer (its Camera
        // Raw Filter is a smart filter), and Color Lookup's look is a
        // profile Photoshop compiles itself: the flatten fallback.
        for (kind, name) in [("develop", "Develop"), ("colorLookup", "Color Lookup")] {
            let mut s = layered_stack();
            s.add_adjustment_layer("", Adjustment::default_for(kind).expect("kind"), None);
            let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
            let err = psd_write_stack(&mut f, &s, &[0u8; 32]).expect_err("refused");
            assert!(
                err.to_string().contains(&format!("is a {name} layer")),
                "{err}"
            );
        }
        let mut s = layered_stack();
        s.add_adjustment_layer("", Adjustment::default_for("vibrance").expect("kind"), None);
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        assert_eq!(
            psd_write_stack(&mut f, &s, &[0u8; 32]).expect("written"),
            PsdSaveBackShape::Layered
        );
    }

    /// Fill layers, the five readable adjustment kinds and the parity
    /// properties (fill opacity, Blend If, knockout, locks, colour label)
    /// survive a layered save and the layered import.
    #[test]
    #[allow(non_snake_case)]
    fn fill_and_adjustment_layers_and_blending_options_round_trip_through_a_psd__feat__image_layers_photoshop_parity(
    ) {
        use crate::layers::{
            Adjustment, BlendIf, ColorStop, FillLayer, FillSource, GradientFill, Knockout,
            LayerKind, LayerStack,
        };
        let solid = |v: u8| std::sync::Arc::from(vec![v; 4 * 2 * 4].into_boxed_slice());
        let mut s = LayerStack::from_image(4, 2, solid(40)).expect("stack");
        let fills = [
            FillSource::Solid { rgb: [200, 10, 30] },
            FillSource::Gradient(GradientFill {
                style: crate::fill::GradientKind::Linear,
                angle: 45.0,
                scale: 100.0,
                reverse: false,
                offset: (0.0, 0.0),
                stops: vec![
                    ColorStop {
                        at: 0.0,
                        rgb: [0, 0, 0],
                    },
                    ColorStop {
                        at: 1.0,
                        rgb: [255, 255, 0],
                    },
                ],
            }),
        ];
        for f in &fills {
            let i = s.add_fill_layer("", f.clone());
            let l = s.layer_at_mut(i).expect("layer");
            l.kind = LayerKind::Fill(Box::new(FillLayer {
                source: f.clone(),
                stale: false,
            }));
            l.rgba = crate::pixels::Pixels::from_rgba8(solid(120)).into();
        }
        let mut curves = Adjustment::default_for("curves").expect("curves");
        if let Adjustment::Curves { curves: c } = &mut curves {
            c[0] = vec![(0, 0), (128, 150), (255, 255)];
            c[3] = vec![(0, 20), (255, 230)];
        }
        let mut levels = Adjustment::default_for("levels").expect("levels");
        if let Adjustment::Levels { records } = &mut levels {
            records[0] = [10.0, 240.0, 1.2, 5.0, 250.0];
            records[2] = [0.0, 200.0, 0.8, 0.0, 255.0];
        }
        let typed = [
            curves,
            levels,
            Adjustment::Exposure {
                exposure: 0.5,
                offset: -0.02,
                gamma: 1.1,
            },
            Adjustment::Invert,
            Adjustment::HueSaturation {
                colorize: false,
                colorize_hsl: [0.0, 25.0, 0.0],
                master: [30.0, -20.0, 5.0],
                ranges: [[0.0; 3]; 6],
            },
        ];
        for a in &typed {
            s.add_adjustment_layer("", a.clone(), None);
        }
        let mut bi = BlendIf::default();
        bi.channels[0].under = [0, 0, 180, 220];
        s.set_fill_opacity(1, 0.6).expect("fill");
        s.set_blend_if(1, Some(bi)).expect("blend if");
        s.set_color(1, 2).expect("label");
        let l1 = s.layer_at_mut(1).expect("layer");
        l1.ext.locks.position = true;
        s.set_knockout(2, Knockout::Shallow).expect("knockout");
        s.layer_at_mut(2).expect("layer").locked = true;
        let mut f = PsdFile::parse(&psd_4x2()).expect("parse");
        assert_eq!(
            psd_write_stack(&mut f, &s, &[0u8; 32]).expect("written"),
            PsdSaveBackShape::Layered
        );
        let bytes = f.write().expect("bytes");
        let f = PsdFile::parse(&bytes).expect("the written file parses");
        let import = f.layer_plates_rgba8().expect("imports as layers");
        let back =
            LayerStack::from_psd_plates_with(&import, Some(&f.layer_mask.layers)).expect("stack");
        assert_eq!(back.len(), s.len());
        for (k, want) in fills.iter().enumerate() {
            let l = &back.layers()[1 + k];
            assert_eq!(l.fill().map(|f| &f.source), Some(want), "{}", l.name);
            assert!(
                !l.fill().expect("fill").stale,
                "Photoshop's stored render is kept"
            );
        }
        for (k, want) in typed.iter().enumerate() {
            let l = &back.layers()[3 + k];
            let got = l.adjustment().expect("an adjustment layer");
            assert_eq!(got.kind_name(), want.kind_name());
            assert_eq!(got.to_chain(), want.to_chain(), "{}", l.name);
        }
        let l1 = &back.layers()[1];
        assert!((l1.ext.fill_opacity - 0.6).abs() < 0.003);
        assert_eq!(l1.ext.blend_if.as_deref(), Some(&bi));
        assert_eq!(l1.ext.color, 2);
        assert!(l1.ext.locks.position);
        assert_eq!(back.layers()[2].ext.knockout, Knockout::Shallow);
        assert!(back.layers()[2].locked);
    }

    /// psd-tools (an independent reader) sees the same layer tree. Opt in:
    /// `PAGED_PSD_ORACLE=1` with the repo's `.venv` (see CLAUDE.md).
    #[test]
    #[ignore = "needs PAGED_PSD_ORACLE=1 and .venv with psd-tools"]
    #[allow(non_snake_case)]
    fn psd_tools_reads_the_layered_save__feat__image_io_save_back() {
        if std::env::var("PAGED_PSD_ORACLE").as_deref() != Ok("1") {
            paged_test_resources::skip!(
                paged_test_resources::Resource::Tools,
                "psd-tools oracle: PAGED_PSD_ORACLE != 1 (and .venv with psd-tools)"
            );
        }
        let path = std::env::temp_dir().join("paged-layered-save-oracle.psd");
        std::fs::write(&path, write_layered()).expect("write");
        let py = concat!(env!("CARGO_MANIFEST_DIR"), "/../.venv/bin/python");
        let script = r#"
import sys
from psd_tools import PSDImage
psd = PSDImage.open(sys.argv[1])
def walk(layers, depth):
    for l in layers:
        print(f"{depth}|{l.name}|{l.kind}|{l.visible}|{l.opacity}|{l.blend_mode}|{l.clipping}|{l.has_mask()}")
        if l.is_group():
            walk(l, depth + 1)
walk(psd, 0)
"#;
        let out = std::process::Command::new(py)
            .args(["-c", script, path.to_str().expect("path")])
            .output()
            .expect("run psd-tools");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let text = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 4, "{text}");
        assert!(
            lines[0].starts_with("0|Background|pixel|True|255|"),
            "{text}"
        );
        assert!(
            lines[1].starts_with("0|Look|group|True|255|BlendMode.PASS_THROUGH"),
            "{text}"
        );
        assert!(
            lines[2].starts_with("1|Grain ✓|pixel|True|128|BlendMode.MULTIPLY|True|True"),
            "{text}"
        );
        assert!(lines[3].starts_with("1|Hidden|pixel|False|"), "{text}");
    }
}
