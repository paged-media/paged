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

//! TIFF probe and decode through the `tiff` crate.

pub(crate) mod encode;
mod raw;

use std::borrow::Cow;
use std::io::Cursor;

use ::tiff::decoder::{Decoder, DecodingResult, Limits};
use ::tiff::tags::Tag;
use ::tiff::TiffError;

use self::raw::Header;
use crate::shrink;
use crate::{
    Alpha, ColorModel, DecodeOptions, Error, Format, RasterImage, RasterInfo, Result, SampleFormat,
    Samples,
};

const PHOTOMETRIC: u16 = 262;
const COMPRESSION: u16 = 259;
const SAMPLES_PER_PIXEL: u16 = 277;
const BITS_PER_SAMPLE: u16 = 258;
const SAMPLE_FORMAT: u16 = 339;
const EXTRA_SAMPLES: u16 = 338;
const ORIENTATION: u16 = 274;
const RESOLUTION_UNIT: u16 = 296;
const YCBCR_COEFFICIENTS: u16 = 529;
pub(crate) const XMP: u16 = 700;
pub(crate) const IPTC: u16 = 33723;
pub(crate) const PHOTOSHOP: u16 = 34377;
pub(crate) const ICC: u16 = 34675;
const IMAGE_SOURCE_DATA: u16 = 37724;

fn malformed(detail: impl Into<String>) -> Error {
    Error::Malformed {
        format: Format::Tiff,
        detail: detail.into(),
    }
}

fn unsupported(what: impl Into<String>) -> Error {
    Error::Unsupported {
        format: Format::Tiff,
        what: what.into(),
    }
}

fn map_err(err: TiffError) -> Error {
    match err {
        TiffError::UnsupportedError(e) => unsupported(e.to_string()),
        TiffError::LimitsExceeded => unsupported("an image larger than the decode limits"),
        other => malformed(other.to_string()),
    }
}

/// The compressions `tiff` decodes (with the features this crate enables).
fn compression_supported(code: u32) -> bool {
    matches!(code, 1 | 4 | 5 | 7 | 8 | 32773 | 32946)
}

fn compression_name(code: u32) -> String {
    match code {
        2 => "compression CCITT modified Huffman RLE (2)".into(),
        3 => "compression CCITT Group 3 fax (3)".into(),
        6 => "compression old-style JPEG (6)".into(),
        32809 => "compression ThunderScan (32809)".into(),
        34661 => "compression JBIG (34661)".into(),
        34712 => "compression JPEG 2000 (34712)".into(),
        34887 => "compression LERC (34887)".into(),
        34925 => "compression LZMA (34925)".into(),
        50000 => "compression Zstandard (50000)".into(),
        50001 => "compression WebP (50001)".into(),
        50002 => "compression JPEG XL (50002)".into(),
        n => format!("compression {n}"),
    }
}

/// The photometric interpretation as a colour model.
fn model_of(photometric: u32) -> Result<ColorModel> {
    Ok(match photometric {
        0 | 1 => ColorModel::Gray,
        2 => ColorModel::Rgb,
        3 => ColorModel::Palette,
        5 => ColorModel::Cmyk,
        6 => ColorModel::YCbCr,
        8 | 9 => ColorModel::Lab,
        4 => return Err(unsupported("photometric transparency mask (4)")),
        10 => return Err(unsupported("photometric ITU Lab (10)")),
        32844 | 32845 => return Err(unsupported(format!("photometric LogLuv ({photometric})"))),
        32803 => return Err(unsupported("photometric CFA (32803)")),
        34892 => return Err(unsupported("photometric linear raw (34892)")),
        n => return Err(unsupported(format!("photometric {n}"))),
    })
}

/// One page of a TIFF, located and with its header facts read.
struct Page<'b> {
    bytes: &'b [u8],
    header: Header,
    ifd: u64,
    page: usize,
    page_count: usize,
    photometric: u32,
}

impl<'b> Page<'b> {
    fn locate(bytes: &'b [u8], page: usize) -> Result<Page<'b>> {
        let header = Header::read(bytes).ok_or_else(|| malformed("bad header"))?;
        let ifds = header.ifds(bytes);
        let Some(&ifd) = ifds.get(page) else {
            if ifds.is_empty() {
                return Err(malformed("no image file directory"));
            }
            return Err(Error::PageOutOfRange {
                page,
                count: ifds.len(),
            });
        };
        let photometric = header
            .short(bytes, ifd, PHOTOMETRIC)
            .ok_or_else(|| malformed("no PhotometricInterpretation"))?;
        Ok(Page {
            bytes,
            header,
            ifd,
            page,
            page_count: ifds.len(),
            photometric,
        })
    }

    fn short(&self, tag: u16) -> Option<u32> {
        self.header.short(self.bytes, self.ifd, tag)
    }

    fn blob(&self, tag: u16) -> Option<Vec<u8>> {
        self.header
            .value(self.bytes, self.ifd, tag)
            .filter(|v| !v.is_empty())
            .map(<[u8]>::to_vec)
    }

    fn compression(&self) -> u32 {
        self.short(COMPRESSION).unwrap_or(1)
    }

    /// A `tiff` decoder on this page. Palette and Lab pages are read from
    /// a copy whose PhotometricInterpretation says gray and RGB: `tiff`
    /// refuses them, but their samples are plain integers that [`decode`]
    /// finishes itself.
    fn decoder(&self) -> Result<Decoder<Cursor<Cow<'b, [u8]>>>> {
        let stand_in = match self.photometric {
            3 => Some(1),
            8 | 9 => Some(2),
            _ => None,
        };
        let data: Cow<'b, [u8]> = match stand_in {
            Some(v) => {
                let mut copy = self.bytes.to_vec();
                let entry = self
                    .header
                    .entry(self.bytes, self.ifd, PHOTOMETRIC)
                    .ok_or_else(|| malformed("no PhotometricInterpretation"))?;
                if !self.header.patch_short(&mut copy, entry, v) {
                    return Err(malformed("PhotometricInterpretation is not a SHORT"));
                }
                Cow::Owned(copy)
            }
            None => Cow::Borrowed(self.bytes),
        };
        let mut limits = Limits::default();
        // Metadata blobs (an ICC profile, Photoshop resources) are often
        // larger than the 1 MiB default.
        limits.ifd_value_size = 256 << 20;
        limits.decoding_buffer_size = 1 << 30;
        let mut dec = Decoder::new(Cursor::new(data))
            .map_err(map_err)?
            .with_limits(limits);
        if self.page > 0 {
            dec.seek_to_image(self.page).map_err(map_err)?;
        }
        Ok(dec)
    }

    fn info(&self, width: u32, height: u32) -> Result<RasterInfo> {
        let model = model_of(self.photometric)?;
        let channels = self.short(SAMPLES_PER_PIXEL).unwrap_or(1);
        let bits = self.short(BITS_PER_SAMPLE).unwrap_or(1);
        let sample_format = match self.short(SAMPLE_FORMAT).unwrap_or(1) {
            2 => SampleFormat::Int,
            3 => SampleFormat::Float,
            _ => SampleFormat::UInt,
        };
        let (alpha, _) = self.alpha(model);
        let resolution = self.resolution();
        Ok(RasterInfo {
            format: Format::Tiff,
            width,
            height,
            channels: u16::try_from(channels).unwrap_or(u16::MAX),
            bits_per_sample: u16::try_from(bits).unwrap_or(u16::MAX),
            sample_format,
            color_model: model,
            alpha,
            icc: self.blob(ICC),
            xmp: self.blob(XMP),
            iptc: self.blob(IPTC),
            photoshop_irb: self.blob(PHOTOSHOP),
            has_layers: self
                .header
                .entry(self.bytes, self.ifd, IMAGE_SOURCE_DATA)
                .is_some(),
            layer_count: self.layer_count(),
            resolution,
            orientation: self
                .short(ORIENTATION)
                .and_then(|o| u16::try_from(o).ok())
                .filter(|o| (1..=8).contains(o))
                .unwrap_or(1),
            page_count: self.page_count,
        })
    }

    /// The layer records in Photoshop's layer data (tag 37724), read
    /// through `paged-psd` without their pixels; `Some(0)` without the
    /// tag, `None` when the data is there but not readable.
    fn layer_count(&self) -> Option<usize> {
        let Some(data) = self.header.value(self.bytes, self.ifd, IMAGE_SOURCE_DATA) else {
            return Some(0);
        };
        match paged_psd::image_source_data_records(data) {
            Ok(list) => Some(list.layers.len()),
            Err(err) => {
                tracing::debug!(error = %err, "TIFF layer data not read");
                None
            }
        }
    }

    /// The alpha kind and the index of the alpha sample within a pixel.
    fn alpha(&self, model: ColorModel) -> (Alpha, Option<usize>) {
        let extras: Vec<u16> = self
            .header
            .value(self.bytes, self.ifd, EXTRA_SAMPLES)
            .map(|raw| {
                raw.as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| {
                        if self.header_le() {
                            u16::from_le_bytes(*c)
                        } else {
                            u16::from_be_bytes(*c)
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let colour = model.colour_channels();
        for (j, kind) in extras.iter().enumerate() {
            match kind {
                1 => return (Alpha::Associated, Some(colour + j)),
                2 => return (Alpha::Unassociated, Some(colour + j)),
                _ => {}
            }
        }
        // An RGB or CMYK file with one sample more than its model and no
        // ExtraSamples: readers treat it as alpha, and so does `tiff`.
        let spp = self.short(SAMPLES_PER_PIXEL).unwrap_or(1) as usize;
        if extras.is_empty() && matches!(model, ColorModel::Rgb | ColorModel::Cmyk) && spp > colour
        {
            return (Alpha::Unassociated, Some(colour));
        }
        (Alpha::None, None)
    }

    fn header_le(&self) -> bool {
        self.bytes.starts_with(b"II")
    }

    /// Pixels per inch from XResolution / YResolution / ResolutionUnit.
    fn resolution(&self) -> Option<(f64, f64)> {
        let rational = |tag: u16| -> Option<f64> {
            let raw = self.header.value(self.bytes, self.ifd, tag)?;
            let word = |at: usize| -> Option<u32> {
                let s: [u8; 4] = raw.get(at..at + 4)?.try_into().ok()?;
                Some(if self.header_le() {
                    u32::from_le_bytes(s)
                } else {
                    u32::from_be_bytes(s)
                })
            };
            let (n, d) = (word(0)?, word(4)?);
            (d != 0).then(|| f64::from(n) / f64::from(d))
        };
        let per_inch = match self.short(RESOLUTION_UNIT).unwrap_or(2) {
            2 => 1.0,
            3 => 2.54,
            _ => return None,
        };
        let x = rational(282)?;
        let y = rational(283).unwrap_or(x);
        (x > 0.0 && y > 0.0).then_some((x * per_inch, y * per_inch))
    }
}

pub(crate) fn probe(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    let page = Page::locate(bytes, page)?;
    let mut dec = page.decoder()?;
    let (w, h) = dec.dimensions().map_err(map_err)?;
    page.info(w, h)
}

/// The ICC profile of page 0, from the container alone.
pub(crate) fn icc(bytes: &[u8]) -> Option<Vec<u8>> {
    Page::locate(bytes, 0).ok()?.blob(ICC)
}

/// Samples as `tiff` delivered them, narrowed to the three types this
/// crate carries.
enum Raw {
    U8(Vec<u8>),
    U16(Vec<u16>),
    F32(Vec<f32>),
}

pub(crate) fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    let page = Page::locate(bytes, opts.page)?;
    let compression = page.compression();
    if !compression_supported(compression) {
        return Err(unsupported(compression_name(compression)));
    }
    let model = model_of(page.photometric)?;
    let mut dec = page.decoder()?;
    let (width, height) = dec.dimensions().map_err(map_err)?;
    let info = page.info(width, height)?;
    let spp = usize::from(info.channels.max(1));
    let bits = u32::from(info.bits_per_sample);
    if info.sample_format == SampleFormat::Int {
        return Err(unsupported("signed integer samples"));
    }

    let mut result = DecodingResult::U8(Vec::new());
    let layout = dec.read_image_to_buffer(&mut result).map_err(map_err)?;
    let planes = layout.planes.max(1);
    if planes > 1 && result.as_buffer(0).as_bytes().len() < layout.complete_len {
        return Err(unsupported("a planar image larger than the decode limits"));
    }
    let pixels = width as usize * height as usize;

    let raw = match result {
        DecodingResult::U8(v) if bits < 8 => {
            if planes > 1 {
                return Err(unsupported(format!("planar {bits}-bit samples")));
            }
            let stride = layout
                .row_stride
                .map(|s| s.get())
                .unwrap_or_else(|| (width as usize * spp * bits as usize).div_ceil(8));
            Raw::U8(unpack(
                &v,
                width as usize * spp,
                height as usize,
                stride,
                bits,
            ))
        }
        DecodingResult::U8(v) => Raw::U8(v),
        DecodingResult::U16(v) => Raw::U16(v),
        DecodingResult::U32(v) => Raw::U16(v.into_iter().map(|s| (s >> 16) as u16).collect()),
        DecodingResult::U64(v) => Raw::U16(v.into_iter().map(|s| (s >> 48) as u16).collect()),
        DecodingResult::F16(v) => Raw::F32(v.into_iter().map(f32::from).collect()),
        DecodingResult::F32(v) => Raw::F32(v),
        DecodingResult::F64(v) => Raw::F32(v.into_iter().map(|s| s as f32).collect()),
        _ => return Err(unsupported("signed integer samples")),
    };
    let raw = if planes > 1 {
        match raw {
            Raw::U8(v) => Raw::U8(interleave(v, planes, pixels)?),
            Raw::U16(v) => Raw::U16(interleave(v, planes, pixels)?),
            Raw::F32(v) => Raw::F32(interleave(v, planes, pixels)?),
        }
    } else {
        raw
    };
    let len = match &raw {
        Raw::U8(v) => v.len(),
        Raw::U16(v) => v.len(),
        Raw::F32(v) => v.len(),
    };
    if len < pixels * spp {
        return Err(malformed(format!(
            "{len} samples for {width}x{height} at {spp} per pixel"
        )));
    }

    let (alpha, alpha_at) = page.alpha(model);
    let colour = model.colour_channels();
    if spp < colour {
        return Err(unsupported(format!(
            "{spp} samples per pixel for {model:?}"
        )));
    }
    let mut keep: Vec<usize> = (0..colour).collect();
    if let Some(a) = alpha_at.filter(|a| *a < spp) {
        keep.push(a);
    }
    let alpha = if keep.len() > colour {
        alpha
    } else {
        Alpha::None
    };

    let (out_model, data) = match model {
        ColorModel::Gray | ColorModel::Rgb | ColorModel::Cmyk => {
            let data = match raw {
                Raw::U8(v) => {
                    let mut v = pick(&v, spp, &keep, pixels);
                    if bits < 8 {
                        // 1, 2 and 4-bit levels to full scale.
                        let max = (1u32 << bits) - 1;
                        v.iter_mut()
                            .for_each(|s| *s = (u32::from(*s) * 255 / max) as u8);
                    }
                    Samples::U8(v)
                }
                Raw::U16(v) => Samples::U16(pick(&v, spp, &keep, pixels)),
                Raw::F32(v) => Samples::F32(pick(&v, spp, &keep, pixels)),
            };
            (model, data)
        }
        ColorModel::Palette => (
            ColorModel::Rgb,
            expand_palette(&mut dec, raw, spp, &keep, pixels, bits)?,
        ),
        ColorModel::YCbCr => (
            ColorModel::Rgb,
            ycbcr_to_rgb(&page, raw, spp, &keep, pixels)?,
        ),
        ColorModel::Lab => (
            ColorModel::Lab,
            lab_values(raw, spp, &keep, pixels, page.photometric == 8)?,
        ),
    };

    let channels = out_model.colour_channels() + usize::from(alpha != Alpha::None);
    let k = shrink::factor(width, height, opts.max_dim);
    let (data, out_w, out_h) = shrink::shrink(data, width, height, channels, k);
    Ok(RasterImage {
        info,
        width: out_w,
        height: out_h,
        model: out_model,
        alpha,
        data,
    })
}

/// Unpack MSB-first `bits`-bit samples, `per_row` to a row of `stride`
/// bytes, into one byte each.
fn unpack(src: &[u8], per_row: usize, rows: usize, stride: usize, bits: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(per_row * rows);
    let mask = ((1u16 << bits) - 1) as u8;
    for r in 0..rows {
        let row = src.get(r * stride..).unwrap_or(&[]);
        for i in 0..per_row {
            let bit = i * bits as usize;
            let byte = row.get(bit / 8).copied().unwrap_or(0);
            let shift = 8 - bits as usize - bit % 8;
            out.push((byte >> shift) & mask);
        }
    }
    out
}

/// Planar samples (each plane `pixels` long, planes back to back) as
/// interleaved pixels.
fn interleave<T: Copy + Default>(v: Vec<T>, planes: usize, pixels: usize) -> Result<Vec<T>> {
    let stride = v.len() / planes;
    if stride < pixels {
        return Err(malformed("planar data shorter than its planes"));
    }
    let mut out = vec![T::default(); pixels * planes];
    for p in 0..planes {
        let plane = &v[p * stride..p * stride + pixels];
        for (i, s) in plane.iter().enumerate() {
            out[i * planes + p] = *s;
        }
    }
    Ok(out)
}

/// The samples `keep` names from each `spp`-sample pixel.
fn pick<T: Copy>(src: &[T], spp: usize, keep: &[usize], pixels: usize) -> Vec<T> {
    if keep.len() == spp && keep.iter().enumerate().all(|(i, k)| i == *k) {
        return src[..pixels * spp].to_vec();
    }
    let mut out = Vec::with_capacity(pixels * keep.len());
    for px in src.chunks_exact(spp).take(pixels) {
        out.extend(keep.iter().map(|&k| px[k]));
    }
    out
}

/// A palette image's indices through its ColorMap, as 16-bit RGB.
fn expand_palette<R: std::io::Read + std::io::Seek>(
    dec: &mut Decoder<R>,
    raw: Raw,
    spp: usize,
    keep: &[usize],
    pixels: usize,
    bits: u32,
) -> Result<Samples> {
    let map = dec
        .get_tag_u16_vec(Tag::ColorMap)
        .map_err(|_| malformed("palette image without a ColorMap"))?;
    let entries = map.len() / 3;
    if entries == 0 {
        return Err(malformed("empty ColorMap"));
    }
    let (r, rest) = map.split_at(entries);
    let (g, b) = rest.split_at(entries);
    let samples: Vec<u32> = match raw {
        Raw::U8(v) => pick(&v, spp, keep, pixels)
            .into_iter()
            .map(u32::from)
            .collect(),
        Raw::U16(v) => pick(&v, spp, keep, pixels)
            .into_iter()
            .map(u32::from)
            .collect(),
        Raw::F32(_) => return Err(unsupported("floating-point palette indices")),
    };
    let has_alpha = keep.len() > 1;
    let alpha_scale = if bits <= 8 { 257 } else { 1 };
    let mut out = Vec::with_capacity(pixels * (3 + usize::from(has_alpha)));
    for px in samples.chunks_exact(keep.len()) {
        let i = (px[0] as usize).min(entries - 1);
        out.extend_from_slice(&[r[i], g[i], b[i]]);
        if has_alpha {
            out.push((px[1] * alpha_scale).min(65535) as u16);
        }
    }
    Ok(Samples::U16(out))
}

/// YCbCr (no subsampling, or JPEG-decoded) to RGB with the file's
/// YCbCrCoefficients (default ITU-R BT.601).
fn ycbcr_to_rgb(
    page: &Page,
    raw: Raw,
    spp: usize,
    keep: &[usize],
    pixels: usize,
) -> Result<Samples> {
    let Raw::U8(v) = raw else {
        return Err(unsupported("YCbCr deeper than 8 bits"));
    };
    let (lr, lg, lb) = page
        .header
        .value(page.bytes, page.ifd, YCBCR_COEFFICIENTS)
        .and_then(|raw| {
            let le = page.header_le();
            let word = |at: usize| -> Option<f32> {
                let s: [u8; 4] = raw.get(at..at + 4)?.try_into().ok()?;
                Some(if le {
                    u32::from_le_bytes(s)
                } else {
                    u32::from_be_bytes(s)
                } as f32)
            };
            let r = |i: usize| -> Option<f32> {
                let d = word(i * 8 + 4)?;
                (d != 0.0).then(|| word(i * 8).unwrap_or(0.0) / d)
            };
            Some((r(0)?, r(1)?, r(2)?))
        })
        .unwrap_or((0.299, 0.587, 0.114));
    let v = pick(&v, spp, keep, pixels);
    let n = keep.len();
    let mut out = Vec::with_capacity(v.len());
    let clamp = |x: f32| x.round().clamp(0.0, 255.0) as u8;
    for px in v.chunks_exact(n) {
        let y = f32::from(px[0]);
        let cb = f32::from(px[1]) - 128.0;
        let cr = f32::from(px[2]) - 128.0;
        let r = y + (2.0 - 2.0 * lr) * cr;
        let b = y + (2.0 - 2.0 * lb) * cb;
        let g = (y - lr * r - lb * b) / lg;
        out.extend_from_slice(&[clamp(r), clamp(g), clamp(b)]);
        if n > 3 {
            out.push(px[3]);
        }
    }
    Ok(Samples::U8(out))
}

/// Lab samples as L* (0..=100), a*, b* floats, alpha 0..=1. ICC Lab
/// stores a* and b* offset by 128 (or 32768); CIE Lab stores them signed.
fn lab_values(
    raw: Raw,
    spp: usize,
    keep: &[usize],
    pixels: usize,
    signed: bool,
) -> Result<Samples> {
    let n = keep.len();
    let mut out = Vec::with_capacity(pixels * n);
    match raw {
        Raw::U8(v) => {
            for px in pick(&v, spp, keep, pixels).chunks_exact(n) {
                let ab = |s: u8| {
                    if signed {
                        f32::from(s as i8)
                    } else {
                        f32::from(s) - 128.0
                    }
                };
                out.extend_from_slice(&[f32::from(px[0]) * 100.0 / 255.0, ab(px[1]), ab(px[2])]);
                if n > 3 {
                    out.push(f32::from(px[3]) / 255.0);
                }
            }
        }
        Raw::U16(v) => {
            for px in pick(&v, spp, keep, pixels).chunks_exact(n) {
                let ab = |s: u16| {
                    if signed {
                        f32::from(s as i16) / 256.0
                    } else {
                        f32::from(s) / 256.0 - 128.0
                    }
                };
                out.extend_from_slice(&[f32::from(px[0]) * 100.0 / 65535.0, ab(px[1]), ab(px[2])]);
                if n > 3 {
                    out.push(f32::from(px[3]) / 65535.0);
                }
            }
        }
        Raw::F32(_) => return Err(unsupported("floating-point Lab")),
    }
    Ok(Samples::F32(out))
}
