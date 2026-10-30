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

//! The adapters: the frozen [`ImageSource`] / [`ImageTarget`] over the
//! engine's one raster crate, `paged-raster` (ADR 468, PM-0014).
//!
//! **Decode** ([`RasterSource`]) reads every format `paged-raster` does —
//! PNG, JPEG (CMYK and YCCK inks kept), TIFF (strips, tiles, planar,
//! 1–32-bit, Gray/RGB/CMYK/Lab/palette, a layered TIFF's composite), PSD
//! and PSB composites, WebP, GIF (first frame), BMP, TGA, QOI, ICO, HDR and
//! OpenEXR, AVIF, JPEG XL, DNG and an EPS preview — and maps the result
//! onto the spec's `ChannelLayout` set at the slice boundary:
//!
//! | decoded | delivered |
//! |---|---|
//! | Gray, Gray + alpha | `Gray`, `GrayA` |
//! | RGB, RGB + alpha | `Rgba` (opaque alpha synthesised) |
//! | CMYK, CMYK + alpha | `Cmyk`, `Cmyka` (inks, 0 = none) |
//! | 8-bit / 16-bit integers | `U8` / `U16` (native-endian pairs) |
//! | Lab, or float samples (HDR, EXR, 32-bit TIFF) | `Rgba` `U8` through `paged_raster::to_rgba8`: Lab through the CMS, scene-linear floats **clipped** to 0..1 and sRGB-encoded (no tone mapping) |
//!
//! Premultiplied (associated) alpha is un-multiplied, so every layout is
//! straight. The decode is whole-image: `probe` decodes once and caches,
//! `read_region` serves windows by copy (`native_shrink == [1]`).
//!
//! **Encode** ([`RasterTarget`]) collects strips and hands the frame to
//! `paged_raster::encode`: PNG (iCCP, eXIf, XMP iTXt, pHYs), JPEG (APP2
//! ICC, APP1 EXIF and XMP, APP13 IPTC, JFIF density, quality), WebP
//! (lossless only; ICCP, EXIF, XMP) and TIFF (Gray/RGB/CMYK at 8/16 bits,
//! LZW/Deflate, ICC, XMP, IPTC, resolution). `TargetInfo.icc` is
//! embedded; the frozen `TargetInfo` has no field for the rest, so the
//! target carries it ([`RasterTarget::with_metadata`], [`RasterTarget::with_ppi`]).

use image_core::{
    AlphaMode, ChannelLayout, ColorSpaceRef, NamedSpace, PixelFormat, Region, SampleDepth,
    TileSliceMut, TileSliceRef, Transfer, TransferCurve,
};
use paged_raster::{
    Alpha, ColorModel, DecodeOptions, EncodeFormat, EncodeOptions, Format, Metadata, RasterImage,
    RasterInfo, Samples, TiffCompression, TiffEncodeOptions,
};

use crate::{
    ByteSource, CodecError, EncodedStats, ImageSource, ImageTarget, Result, SourceInfo, TargetInfo,
};

/// The name a format goes by in errors.
pub fn format_name(f: Format) -> &'static str {
    match f {
        Format::Tiff => "tiff",
        Format::Png => "png",
        Format::Jpeg => "jpeg",
        Format::WebP => "webp",
        Format::Gif => "gif",
        Format::Bmp => "bmp",
        Format::Psd => "psd",
        Format::Eps => "eps",
        Format::Dng => "dng",
        Format::Avif => "avif",
        Format::Jxl => "jxl",
        Format::Tga => "tga",
        Format::Qoi => "qoi",
        Format::Ico => "ico",
        Format::Hdr => "hdr",
        Format::Exr => "exr",
    }
}

fn raster_err(format: &'static str, e: paged_raster::Error) -> CodecError {
    match e {
        paged_raster::Error::Unsupported { what, .. } => CodecError::Unsupported {
            format,
            detail: what,
        },
        paged_raster::Error::Encode(detail) => CodecError::Unsupported { format, detail },
        other => CodecError::Malformed {
            format,
            detail: other.to_string(),
        },
    }
}

/// The format the adapters decode into: sRGB-encoded (or device inks),
/// straight alpha. Only `channels` and `depth` vary.
pub(crate) const fn decoded_format(channels: ChannelLayout, depth: SampleDepth) -> PixelFormat {
    // 32-bit float is linear light (image ADR 483); the integer depths
    // are sRGB-encoded.
    let float = matches!(depth, SampleDepth::F32);
    PixelFormat {
        channels,
        depth,
        alpha: AlphaMode::Straight,
        transfer: if float {
            Transfer::Linear
        } else {
            Transfer::Gamma(TransferCurve::Srgb)
        },
        space: ColorSpaceRef::Named(if float {
            NamedSpace::LinearSrgb
        } else {
            NamedSpace::Srgb
        }),
    }
}

/// The file's own sample layout, as `SourceInfo.native_format` states it.
fn native_name(info: &RasterInfo) -> &'static str {
    let alpha = info.alpha != Alpha::None;
    let float = info.sample_format == paged_raster::SampleFormat::Float;
    let bits = match info.bits_per_sample {
        0..=8 => 8,
        9..=16 => 16,
        _ => 32,
    };
    macro_rules! pick {
        ($a8:literal, $aa8:literal, $a16:literal, $aa16:literal, $a32:literal, $aa32:literal) => {
            match (alpha, bits, float) {
                (false, 8, _) => $a8,
                (true, 8, _) => $aa8,
                (false, 16, false) => $a16,
                (true, 16, false) => $aa16,
                (false, _, _) => $a32,
                (true, _, _) => $aa32,
            }
        };
    }
    match info.color_model {
        ColorModel::Gray => pick!("gray8", "graya8", "gray16", "graya16", "gray32", "graya32"),
        ColorModel::Rgb => pick!("rgb8", "rgba8", "rgb16", "rgba16", "rgb32", "rgba32"),
        ColorModel::Cmyk => pick!("cmyk8", "cmyka8", "cmyk16", "cmyka16", "cmyk32", "cmyka32"),
        ColorModel::Lab => pick!("lab8", "laba8", "lab16", "laba16", "lab32", "laba32"),
        ColorModel::YCbCr => {
            pick!("ycbcr8", "ycbcra8", "ycbcr16", "ycbcra16", "ycbcr32", "ycbcra32")
        }
        ColorModel::Palette => {
            if alpha {
                "palette+alpha"
            } else {
                "palette"
            }
        }
    }
}

struct Decoded {
    info: SourceInfo,
    file: RasterInfo,
    pixels: Vec<u8>,
    /// The file stored more bits than `pixels` delivers.
    reduced: bool,
}

/// [`ImageSource`] over `paged-raster`: every format it decodes.
pub struct RasterSource<B: ByteSource> {
    bytes: B,
    expect: Option<Format>,
    decoded: Option<Decoded>,
}

impl<B: ByteSource> RasterSource<B> {
    /// A source for whatever format the bytes are in.
    pub fn new(bytes: B) -> Self {
        RasterSource {
            bytes,
            expect: None,
            decoded: None,
        }
    }

    /// A source that refuses bytes of any format but `format`.
    pub fn expecting(bytes: B, format: Format) -> Self {
        RasterSource {
            bytes,
            expect: Some(format),
            decoded: None,
        }
    }

    /// The file stored more bits per sample than the source delivers (a
    /// 32-bit float or a Lab image arrives as 8-bit RGBA; a PSD's 16-bit
    /// composite arrives as 8-bit). False before `probe`.
    pub fn depth_reduced(&self) -> bool {
        self.decoded.as_ref().is_some_and(|d| d.reduced)
    }

    /// Compatibility name of [`Self::depth_reduced`] for the PNG lane.
    pub fn source_was_16bit(&self) -> bool {
        self.depth_reduced()
    }

    /// The file's header facts (after `probe`): resolution, XMP, IPTC,
    /// layer count, orientation, the original colour model.
    pub fn raster_info(&self) -> Option<&RasterInfo> {
        self.decoded.as_ref().map(|d| &d.file)
    }

    /// The file's metadata, for an export that keeps it (after `probe`).
    pub fn metadata(&self) -> Option<Metadata> {
        self.decoded.as_ref().map(|d| Metadata {
            icc: d.file.icc.clone(),
            exif: d.file.exif.clone(),
            xmp: d.file.xmp.clone(),
            iptc: d.file.iptc.clone(),
            photoshop_irb: d.file.photoshop_irb.clone(),
        })
    }

    fn decode(&mut self) -> Result<&Decoded> {
        if self.decoded.is_none() {
            let mut raw = vec![0u8; self.bytes.len() as usize];
            self.bytes.read_at(0, &mut raw)?;
            let format = paged_raster::sniff(&raw).ok_or(CodecError::Unsupported {
                format: "raster",
                detail: "not a recognised raster format".into(),
            })?;
            let name = format_name(format);
            if let Some(want) = self.expect {
                if want != format {
                    return Err(CodecError::Malformed {
                        format: format_name(want),
                        detail: format!("the bytes are {name}"),
                    });
                }
            }
            let img = paged_raster::decode(&raw, DecodeOptions::default())
                .map_err(|e| raster_err(name, e))?;
            self.decoded = Some(to_layout(img, name)?);
        }
        Ok(self.decoded.as_ref().expect("decoded above"))
    }
}

/// Map a decoded image onto a `ChannelLayout` and depth.
fn to_layout(img: RasterImage, name: &'static str) -> Result<Decoded> {
    let file = img.info.clone();
    let (w, h) = (img.width, img.height);
    let n = w as usize * h as usize;
    let alpha = img.alpha != Alpha::None;
    let premul = img.alpha == Alpha::Associated;
    let source_bits = file.bits_per_sample;
    // Floats in RGB or grey are handed over as 32-bit float, linear light
    // (image ADR 483); Lab, and floats in another model, through RGBA8.
    let float = matches!(img.data, Samples::F32(_))
        && matches!(img.model, ColorModel::Rgb | ColorModel::Gray);
    let via_rgba8 =
        matches!(img.model, ColorModel::Lab) || (matches!(img.data, Samples::F32(_)) && !float);
    let (channels, depth, pixels) = if via_rgba8 {
        let rgba = paged_raster::to_rgba8(&img, &paged_raster::PagedColour::default())
            .map_err(|e| raster_err(name, e))?;
        (ChannelLayout::Rgba, SampleDepth::U8, rgba.data)
    } else {
        let layout = match (img.model, alpha) {
            (ColorModel::Gray, false) => ChannelLayout::Gray,
            (ColorModel::Gray, true) => ChannelLayout::GrayA,
            (ColorModel::Rgb, _) => ChannelLayout::Rgba,
            (ColorModel::Cmyk, false) => ChannelLayout::Cmyk,
            (ColorModel::Cmyk, true) => ChannelLayout::Cmyka,
            (other, _) => {
                return Err(CodecError::Unsupported {
                    format: name,
                    detail: format!("decoded colour model {other:?}"),
                })
            }
        };
        let ch = img.channels();
        match img.data {
            Samples::U8(mut v) => {
                if premul {
                    unpremultiply(&mut v, ch, 255);
                }
                let v = if img.model == ColorModel::Rgb && !alpha {
                    v.as_chunks::<3>()
                        .0
                        .iter()
                        .flat_map(|p| [p[0], p[1], p[2], 255])
                        .collect()
                } else {
                    v
                };
                (layout, SampleDepth::U8, v)
            }
            Samples::U16(mut v) => {
                if premul {
                    unpremultiply(&mut v, ch, u16::MAX);
                }
                let v: Vec<u16> = if img.model == ColorModel::Rgb && !alpha {
                    v.as_chunks::<3>()
                        .0
                        .iter()
                        .flat_map(|p| [p[0], p[1], p[2], u16::MAX])
                        .collect()
                } else {
                    v
                };
                let bytes = v.iter().flat_map(|s| s.to_ne_bytes()).collect();
                (layout, SampleDepth::U16, bytes)
            }
            Samples::F32(v) => {
                // Straight RGBA floats, whatever the source's layout.
                let k = ch;
                let mut out = Vec::with_capacity(n * 16);
                for p in v.chunks_exact(k) {
                    let (rgb, a) = match (img.model, alpha) {
                        (ColorModel::Gray, false) => ([p[0]; 3], 1.0),
                        (ColorModel::Gray, true) => ([p[0]; 3], p[1]),
                        (_, false) => ([p[0], p[1], p[2]], 1.0),
                        (_, true) => ([p[0], p[1], p[2]], p[3]),
                    };
                    let un = |c: f32| if premul && a > 0.0 { c / a } else { c };
                    for c in [un(rgb[0]), un(rgb[1]), un(rgb[2]), a.clamp(0.0, 1.0)] {
                        out.extend_from_slice(&c.to_ne_bytes());
                    }
                }
                (ChannelLayout::Rgba, SampleDepth::F32, out)
            }
        }
    };
    let format = decoded_format(channels, depth);
    let expect = n * format.bytes_per_pixel();
    if pixels.len() != expect {
        return Err(CodecError::Malformed {
            format: name,
            detail: format!("decoded {} bytes, expected {expect}", pixels.len()),
        });
    }
    let delivered_bits = u16::from(depth.bytes()) * 8;
    Ok(Decoded {
        info: SourceInfo {
            width: w,
            height: h,
            format,
            native_format: native_name(&file),
            icc: file.icc.clone(),
            exif: file.exif.clone(),
            native_mips: Vec::new(),
        },
        reduced: source_bits > delivered_bits || via_rgba8 && source_bits > 8,
        file,
        pixels,
    })
}

/// Straight colour from premultiplied: every sample but the last of each
/// pixel divided by its alpha.
fn unpremultiply<T>(v: &mut [T], ch: usize, max: T)
where
    T: Copy + Into<u32> + TryFrom<u32>,
{
    let max32: u32 = max.into();
    for px in v.chunks_exact_mut(ch) {
        let a: u32 = px[ch - 1].into();
        if a == 0 || a == max32 {
            continue;
        }
        for s in &mut px[..ch - 1] {
            let c: u32 = (*s).into();
            let u = ((c * max32 + a / 2) / a).min(max32);
            if let Ok(t) = T::try_from(u) {
                *s = t;
            }
        }
    }
}

impl<B: ByteSource> ImageSource for RasterSource<B> {
    fn probe(&mut self) -> Result<SourceInfo> {
        Ok(self.decode()?.info.clone())
    }

    fn native_shrink(&self) -> &[u32] {
        &[1]
    }

    fn read_region(&mut self, roi: Region, shrink: u32, out: &mut TileSliceMut<'_>) -> Result<()> {
        let d = self.decode()?;
        let name = "raster";
        if shrink != 1 {
            return Err(CodecError::Unsupported {
                format: name,
                detail: format!("shrink {shrink} (native_shrink is [1])"),
            });
        }
        if out.format != d.info.format {
            return Err(CodecError::Unsupported {
                format: name,
                detail: "format mismatch (no implicit conversions)".into(),
            });
        }
        let full = Region::new(0, 0, d.info.width, d.info.height);
        if roi.intersect(full) != Some(roi) || !out.validate() || out.region != roi {
            return Err(CodecError::Malformed {
                format: name,
                detail: format!("roi {roi:?} out of bounds or slice mismatch"),
            });
        }
        let bpp = d.info.format.bytes_per_pixel();
        let src_stride = d.info.width as usize * bpp;
        let row_bytes = roi.w as usize * bpp;
        for row in 0..roi.h as usize {
            let sy = (roi.y as usize + row) * src_stride + roi.x as usize * bpp;
            let dy = row * out.row_stride;
            out.bytes[dy..dy + row_bytes].copy_from_slice(&d.pixels[sy..sy + row_bytes]);
        }
        Ok(())
    }
}

// ── encode ─────────────────────────────────────────────────────────────

/// [`ImageTarget`] over `paged_raster::encode`.
pub struct RasterTarget {
    format: EncodeFormat,
    options: EncodeOptions,
    drop_opaque_alpha: bool,
    sink: Vec<u8>,
    state: State,
}

enum State {
    Idle,
    Open {
        info: TargetInfo,
        buffer: Vec<u8>,
        rows_filled: u32,
    },
    Done,
}

impl RasterTarget {
    /// A target writing `format` with default options (JPEG quality 90,
    /// TIFF uncompressed, no metadata but `TargetInfo.icc`).
    pub fn new(format: EncodeFormat) -> Self {
        RasterTarget {
            format,
            options: EncodeOptions::default(),
            drop_opaque_alpha: false,
            sink: Vec::new(),
            state: State::Idle,
        }
    }

    /// JPEG quality, 1 to 100.
    pub fn quality(mut self, quality: u8) -> Self {
        self.options.quality = quality.clamp(1, 100);
        self
    }

    /// EXIF, XMP, IPTC and Photoshop resources to write (its ICC is used
    /// only when `TargetInfo.icc` is `None`).
    pub fn with_metadata(mut self, metadata: Metadata) -> Self {
        self.options.metadata = metadata;
        self
    }

    /// Pixels per inch, horizontal and vertical.
    pub fn with_ppi(mut self, ppi: Option<(f64, f64)>) -> Self {
        self.options.ppi = ppi;
        self
    }

    /// TIFF compression (LZW or Deflate take the predictor).
    pub fn tiff_compression(mut self, compression: TiffCompression) -> Self {
        self.options.tiff = TiffEncodeOptions {
            compression,
            predictor: compression != TiffCompression::None,
            rows_per_strip: None,
        };
        self
    }

    /// Write RGB instead of RGBA when every pixel of an RGBA frame is
    /// opaque. Off by default: a caller asking for RGBA gets RGBA.
    pub fn drop_opaque_alpha(mut self, yes: bool) -> Self {
        self.drop_opaque_alpha = yes;
        self
    }

    /// The encoded bytes (empty until `finish`).
    pub fn into_bytes(self) -> Vec<u8> {
        self.sink
    }

    fn name(&self) -> &'static str {
        format_name(self.format.format())
    }
}

impl ImageTarget for RasterTarget {
    fn begin(&mut self, info: TargetInfo) -> Result<()> {
        if !matches!(self.state, State::Idle) {
            return Err(CodecError::Sequencing("begin called twice"));
        }
        if !matches!(info.format.depth, SampleDepth::U8 | SampleDepth::U16) {
            return Err(CodecError::Unsupported {
                format: self.name(),
                detail: format!("depth {:?} (8 and 16 bits are written)", info.format.depth),
            });
        }
        let cmyk = matches!(
            info.format.channels,
            ChannelLayout::Cmyk | ChannelLayout::Cmyka
        );
        if cmyk && self.format != EncodeFormat::Tiff {
            return Err(CodecError::Unsupported {
                format: self.name(),
                detail: format!("{:?} is written as TIFF only", info.format.channels),
            });
        }
        let len = info
            .width
            .checked_mul(info.height)
            .and_then(|px| (px as usize).checked_mul(info.format.bytes_per_pixel()))
            .ok_or_else(|| CodecError::Malformed {
                format: self.name(),
                detail: "target extent overflows usize".into(),
            })?;
        self.state = State::Open {
            info,
            buffer: vec![0u8; len],
            rows_filled: 0,
        };
        Ok(())
    }

    fn write_strip(&mut self, region: Region, data: &TileSliceRef<'_>) -> Result<()> {
        let name = self.name();
        let State::Open {
            info,
            buffer,
            rows_filled,
        } = &mut self.state
        else {
            return Err(CodecError::Sequencing(
                "write_strip before begin / after finish",
            ));
        };
        if data.format != info.format {
            return Err(CodecError::Unsupported {
                format: name,
                detail: "strip format mismatch (no implicit conversions)".into(),
            });
        }
        if region.x != 0 || region.w != info.width {
            return Err(CodecError::Sequencing("strip not full-width"));
        }
        if region.y as i64 != i64::from(*rows_filled) {
            return Err(CodecError::Sequencing("strip out of order / gapped"));
        }
        if region.bottom() > i64::from(info.height) {
            return Err(CodecError::Malformed {
                format: name,
                detail: format!("strip {region:?} exceeds target height {}", info.height),
            });
        }
        let bpp = info.format.bytes_per_pixel();
        let row_bytes = info.width as usize * bpp;
        if data.region != region
            || data.row_stride < row_bytes
            || data.bytes.len() < data.row_stride * region.h.saturating_sub(1) as usize + row_bytes
        {
            return Err(CodecError::Malformed {
                format: name,
                detail: "strip region/slice mismatch".into(),
            });
        }
        for row in 0..region.h {
            let dy = (region.y as usize + row as usize) * row_bytes;
            buffer[dy..dy + row_bytes].copy_from_slice(data.row(row));
        }
        *rows_filled += region.h;
        Ok(())
    }

    fn finish(&mut self) -> Result<EncodedStats> {
        let name = self.name();
        let State::Open {
            info,
            buffer,
            rows_filled,
        } = std::mem::replace(&mut self.state, State::Done)
        else {
            return Err(CodecError::Sequencing("finish before begin / called twice"));
        };
        if rows_filled != info.height {
            return Err(CodecError::Sequencing("finish before full coverage"));
        }
        let (model, mut alpha) = match info.format.channels {
            ChannelLayout::Gray => (ColorModel::Gray, false),
            ChannelLayout::GrayA => (ColorModel::Gray, true),
            ChannelLayout::Rgba => (ColorModel::Rgb, true),
            ChannelLayout::Cmyk => (ColorModel::Cmyk, false),
            ChannelLayout::Cmyka => (ColorModel::Cmyk, true),
            // The interleaved encoders take what a raster file stores
            // (PixelFormat amendment 1, image ADR 481: Lab and planes are
            // the stack's, not a target's).
            ChannelLayout::Lab | ChannelLayout::LabA | ChannelLayout::Planes { .. } => {
                return Err(CodecError::Unsupported {
                    format: self.name(),
                    detail: format!(
                        "{:?} pixels (encode RGB, grey or CMYK)",
                        info.format.channels
                    ),
                })
            }
        };
        let mut data = match info.format.depth {
            SampleDepth::U16 => Samples::U16(
                buffer
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|p| u16::from_ne_bytes(*p))
                    .collect(),
            ),
            _ => Samples::U8(buffer),
        };
        if self.drop_opaque_alpha && info.format.channels == ChannelLayout::Rgba {
            data = match data {
                Samples::U8(v) if v.as_chunks::<4>().0.iter().all(|p| p[3] == 255) => {
                    alpha = false;
                    Samples::U8(
                        v.as_chunks::<4>()
                            .0
                            .iter()
                            .flat_map(|p| [p[0], p[1], p[2]])
                            .collect(),
                    )
                }
                Samples::U16(v) if v.as_chunks::<4>().0.iter().all(|p| p[3] == u16::MAX) => {
                    alpha = false;
                    Samples::U16(
                        v.as_chunks::<4>()
                            .0
                            .iter()
                            .flat_map(|p| [p[0], p[1], p[2]])
                            .collect(),
                    )
                }
                other => other,
            };
        }
        let img = RasterImage::from_samples(
            info.width,
            info.height,
            model,
            if alpha {
                if info.format.alpha == AlphaMode::Premultiplied {
                    Alpha::Associated
                } else {
                    Alpha::Unassociated
                }
            } else {
                Alpha::None
            },
            data,
        );
        let mut options = self.options.clone();
        if info.icc.is_some() {
            options.metadata.icc = info.icc.clone();
        }
        self.sink =
            paged_raster::encode(&img, self.format, &options).map_err(|e| raster_err(name, e))?;
        Ok(EncodedStats {
            bytes_written: self.sink.len() as u64,
        })
    }
}

/// The per-format names the module has always exported: each a
/// [`RasterSource`] that expects its format and a [`RasterTarget`] that
/// writes it.
macro_rules! per_format {
    ($source:ident, $target:ident, $fmt:expr, $enc:expr, $doc:literal) => {
        #[doc = concat!("[`RasterSource`] for ", $doc, " bytes.")]
        pub struct $source<B: ByteSource>(RasterSource<B>);

        impl<B: ByteSource> $source<B> {
            pub fn new(bytes: B) -> Self {
                $source(RasterSource::expecting(bytes, $fmt))
            }
            /// See [`RasterSource::depth_reduced`].
            pub fn source_was_16bit(&self) -> bool {
                self.0.depth_reduced()
            }
            /// The underlying source.
            pub fn raster(&self) -> &RasterSource<B> {
                &self.0
            }
        }

        impl<B: ByteSource> ImageSource for $source<B> {
            fn probe(&mut self) -> Result<SourceInfo> {
                self.0.probe()
            }
            fn native_shrink(&self) -> &[u32] {
                self.0.native_shrink()
            }
            fn read_region(
                &mut self,
                roi: Region,
                shrink: u32,
                out: &mut TileSliceMut<'_>,
            ) -> Result<()> {
                self.0.read_region(roi, shrink, out)
            }
        }

        #[doc = concat!("[`RasterTarget`] writing ", $doc, ".")]
        pub struct $target(RasterTarget);

        impl std::ops::Deref for $target {
            type Target = RasterTarget;
            fn deref(&self) -> &RasterTarget {
                &self.0
            }
        }

        impl $target {
            /// See [`RasterTarget::with_metadata`].
            pub fn with_metadata(self, m: Metadata) -> Self {
                $target(self.0.with_metadata(m))
            }
            /// See [`RasterTarget::with_ppi`].
            pub fn with_ppi(self, ppi: Option<(f64, f64)>) -> Self {
                $target(self.0.with_ppi(ppi))
            }
            /// See [`RasterTarget::drop_opaque_alpha`].
            pub fn drop_opaque_alpha(self, yes: bool) -> Self {
                $target(self.0.drop_opaque_alpha(yes))
            }
            /// The encoded bytes (empty until `finish`).
            pub fn into_bytes(self) -> Vec<u8> {
                self.0.into_bytes()
            }
        }

        impl ImageTarget for $target {
            fn begin(&mut self, info: TargetInfo) -> Result<()> {
                self.0.begin(info)
            }
            fn write_strip(&mut self, region: Region, data: &TileSliceRef<'_>) -> Result<()> {
                self.0.write_strip(region, data)
            }
            fn finish(&mut self) -> Result<EncodedStats> {
                self.0.finish()
            }
        }
    };
}

per_format!(PngSource, PngTarget, Format::Png, EncodeFormat::Png, "PNG");
per_format!(
    JpegSource,
    JpegTarget,
    Format::Jpeg,
    EncodeFormat::Jpeg,
    "JPEG"
);
per_format!(
    TiffSource,
    TiffTarget,
    Format::Tiff,
    EncodeFormat::Tiff,
    "TIFF"
);
per_format!(
    WebpSource,
    WebpTarget,
    Format::WebP,
    EncodeFormat::WebP,
    "WebP"
);

impl PngTarget {
    pub fn new() -> Self {
        PngTarget(RasterTarget::new(EncodeFormat::Png))
    }
}

impl Default for PngTarget {
    fn default() -> Self {
        Self::new()
    }
}

impl JpegTarget {
    /// A JPEG writer at `quality` (1 to 100).
    pub fn new(quality: u8) -> Self {
        JpegTarget(RasterTarget::new(EncodeFormat::Jpeg).quality(quality))
    }
}

impl TiffTarget {
    /// A TIFF writer with `compression`.
    pub fn new(compression: TiffCompression) -> Self {
        TiffTarget(RasterTarget::new(EncodeFormat::Tiff).tiff_compression(compression))
    }
}

impl WebpTarget {
    /// A lossless WebP writer (there is no lossy encoder, see
    /// `paged_raster::WEBP_LOSSY`).
    pub fn new() -> Self {
        WebpTarget(RasterTarget::new(EncodeFormat::WebP))
    }
}

impl Default for WebpTarget {
    fn default() -> Self {
        Self::new()
    }
}
