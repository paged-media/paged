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

//! EXPORT AS — the session's pixels written as PNG, JPEG, WebP, TIFF,
//! GIF, BMP, TGA or JPEG XL with the choices the Export As dialog offers
//! (ADR 468; GIF, BMP, TGA and JPEG XL from engine ADR 1038):
//!
//! * **format** and, for JPEG, **quality**;
//! * **size** (the export is resampled, Lanczos 3; the session is not);
//! * **colour**: RGB, Grayscale, or CMYK (TIFF only) through a chosen CMYK
//!   output profile with an intent — or the naive formula without one,
//!   which the result says;
//! * **depth**: 8 or 16 bits (PNG, TIFF, JPEG XL); a 16-bit session exports its
//!   own samples, an 8-bit one is widened and says so;
//! * **metadata**: keep the source's EXIF, XMP and IPTC (EXIF written with
//!   Orientation 1, since the pixels were turned upright on open) or strip
//!   them;
//! * **embed profile**: the profile of the pixels AS WRITTEN — sRGB for RGB
//!   (the session's working space), the chosen CMYK profile for CMYK. Never
//!   the source's own profile: ingest converted out of it;
//! * **resolution** (ppi), written as pHYs / JFIF density / TIFF tags.
//!
//! The same function is the PNG and JPEG save-back: metadata kept, sRGB
//! embedded, the image's resolution written.

use paged_raster::{
    Alpha, ColorModel, EncodeFormat, EncodeOptions, Metadata, RasterImage, Samples,
    TiffCompression, TiffEncodeOptions,
};

use crate::ingest::IngestError;

/// The colour the export is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportMode {
    Rgb,
    Gray,
    Cmyk,
}

impl ExportMode {
    pub fn from_wire(s: &str) -> Option<ExportMode> {
        Some(match s {
            "rgb" => ExportMode::Rgb,
            "gray" | "grey" | "grayscale" => ExportMode::Gray,
            "cmyk" => ExportMode::Cmyk,
            _ => return None,
        })
    }
}

/// The Export As choices.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportSpec {
    pub format: EncodeFormat,
    /// JPEG quality, 1 to 100.
    pub quality: u8,
    /// The written size; `None` = the image's own.
    pub size: Option<(u32, u32)>,
    pub ppi: Option<f64>,
    pub keep_metadata: bool,
    pub embed_profile: bool,
    pub mode: ExportMode,
    /// 16 bits per channel (PNG, TIFF and JPEG XL; the other formats
    /// write 8).
    pub sixteen: bool,
    pub compression: TiffCompression,
    /// The CMYK output profile for [`ExportMode::Cmyk`].
    pub cmyk_profile: Option<Vec<u8>>,
    pub intent: paged_raster::Intent,
}

impl ExportSpec {
    /// A save-back's spec: the format at its default quality, metadata
    /// kept, sRGB embedded, 8-bit RGB, the given resolution.
    pub fn save_back(format: EncodeFormat, quality: u8, ppi: Option<f64>) -> ExportSpec {
        ExportSpec {
            format,
            quality,
            size: None,
            ppi,
            keep_metadata: true,
            embed_profile: true,
            mode: ExportMode::Rgb,
            sixteen: false,
            compression: TiffCompression::Lzw,
            cmyk_profile: None,
            intent: paged_raster::Intent::RelativeColorimetric,
        }
    }
}

impl ExportSpec {
    /// Parse the bundle's spec string: `;`-separated `key=value` pairs —
    /// `format` (png, jpeg, webp, tiff, gif, bmp, tga, jxl, avif;
    /// required), `quality` (1–100),
    /// `width` and `height` (both, or neither), `ppi`, `meta` and `icc`
    /// (`1`/`0`), `mode` (rgb, gray, cmyk), `bits` (8, 16), `compression`
    /// (none, lzw, deflate) and `intent` (perceptual, relativeColorimetric,
    /// saturation, absoluteColorimetric). An unknown key or a bad value is
    /// an error naming it, never a silent default.
    pub fn from_wire(spec: &str) -> Result<ExportSpec, String> {
        let mut out = ExportSpec::save_back(EncodeFormat::Png, 90, None);
        let mut format = None;
        let (mut w, mut h) = (None, None);
        for pair in spec.split(';').map(str::trim).filter(|p| !p.is_empty()) {
            let (k, v) = pair
                .split_once('=')
                .ok_or_else(|| format!("export spec: \"{pair}\" is not key=value"))?;
            let bad = || format!("export spec: bad {k} \"{v}\"");
            let flag = || match v {
                "1" | "true" => Ok(true),
                "0" | "false" => Ok(false),
                _ => Err(bad()),
            };
            match k {
                "format" => format = Some(EncodeFormat::from_name(v).ok_or_else(bad)?),
                "quality" => out.quality = v.parse::<u8>().map_err(|_| bad())?.clamp(1, 100),
                "width" => w = Some(v.parse::<u32>().map_err(|_| bad())?),
                "height" => h = Some(v.parse::<u32>().map_err(|_| bad())?),
                "ppi" => {
                    let p = v.parse::<f64>().map_err(|_| bad())?;
                    out.ppi = (p > 0.0 && p.is_finite()).then_some(p);
                }
                "meta" => out.keep_metadata = flag()?,
                "icc" => out.embed_profile = flag()?,
                "mode" => out.mode = ExportMode::from_wire(v).ok_or_else(bad)?,
                "bits" => {
                    out.sixteen = match v {
                        "8" => false,
                        "16" => true,
                        _ => return Err(bad()),
                    }
                }
                "compression" => {
                    out.compression = match v {
                        "none" => TiffCompression::None,
                        "lzw" => TiffCompression::Lzw,
                        "deflate" | "zip" => TiffCompression::Deflate,
                        _ => return Err(bad()),
                    }
                }
                "intent" => out.intent = paged_raster::Intent::from_name(v).ok_or_else(bad)?,
                _ => return Err(format!("export spec: unknown key \"{k}\"")),
            }
        }
        out.format = format.ok_or("export spec: no format")?;
        out.size = match (w, h) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
            (None, None) => None,
            _ => return Err("export spec: width and height go together".into()),
        };
        Ok(out)
    }
}

/// What the export did that the user should be told. The bundle words
/// each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportNote {
    /// WebP is written lossless (there is no lossy encoder).
    WebpLossless,
    /// CMYK through the chosen profile.
    CmykProfile,
    /// CMYK through the naive formula (no usable profile), none embedded.
    CmykNaive,
    /// 16 bits were asked of 8-bit pixels: widened, no new precision.
    Widened,
    /// The format holds 8 bits; 16-bit pixels were narrowed.
    Narrowed,
    /// JPEG has no alpha; transparency was dropped.
    AlphaDropped,
    /// Grayscale is written without a profile (no gray profile ships).
    GrayUntagged,
    /// GIF holds 256 colours and one bit of alpha: the image had more
    /// colours (quantized) or partial transparency (thresholded).
    GifPalette,
    /// JPEG XL is written lossless (the encoder writes no lossy mode).
    JxlLossless,
    /// The format carries no metadata or profile (GIF, BMP, TGA, JPEG
    /// XL): what was asked to be kept or embedded is not in the file.
    NoMetadata,
}

impl ExportNote {
    pub fn wire(self) -> &'static str {
        match self {
            ExportNote::WebpLossless => "webp-lossless",
            ExportNote::CmykProfile => "cmyk-profile",
            ExportNote::CmykNaive => "cmyk-naive",
            ExportNote::Widened => "widened",
            ExportNote::Narrowed => "narrowed",
            ExportNote::AlphaDropped => "alpha-dropped",
            ExportNote::GrayUntagged => "gray-untagged",
            ExportNote::GifPalette => "gif-palette",
            ExportNote::JxlLossless => "jxl-lossless",
            ExportNote::NoMetadata => "no-metadata",
        }
    }
}

/// The encoded file and its notes.
#[derive(Debug, Clone, PartialEq)]
pub struct Exported {
    pub bytes: Vec<u8>,
    pub notes: Vec<ExportNote>,
}

/// The session's straight RGBA, at 8 or 16 bits.
pub enum Rgba<'a> {
    U8(&'a [u8]),
    U16(Vec<u16>),
}

/// Write `pixels` (`width` x `height` straight RGBA) as `spec` says,
/// carrying `source`'s metadata (the bytes the session opened) when the
/// spec keeps it.
pub fn export(
    pixels: Rgba<'_>,
    width: u32,
    height: u32,
    spec: &ExportSpec,
    source: Option<&[u8]>,
) -> Result<Exported, IngestError> {
    let n = width as usize * height as usize;
    let mut notes = Vec::new();
    let err = |e: paged_raster::Error| IngestError::Decode(e.to_string());
    let holds16 = matches!(
        spec.format,
        EncodeFormat::Png | EncodeFormat::Tiff | EncodeFormat::Jxl
    );
    let want16 = spec.sixteen && holds16 && spec.mode != ExportMode::Cmyk;
    if spec.sixteen && !want16 {
        notes.push(ExportNote::Narrowed);
    }
    if spec.format == EncodeFormat::WebP {
        notes.push(ExportNote::WebpLossless);
    }
    if spec.format == EncodeFormat::Jxl {
        notes.push(ExportNote::JxlLossless);
    }
    if spec.mode == ExportMode::Cmyk && spec.format != EncodeFormat::Tiff {
        return Err(IngestError::Unsupported(
            "CMYK export is written as TIFF (the other formats hold Gray or RGB)".into(),
        ));
    }
    if !spec.format.available() {
        return Err(IngestError::Unsupported(format!(
            "{} export is not in this build",
            spec.format.name().to_uppercase()
        )));
    }
    let carries_none = matches!(
        spec.format,
        EncodeFormat::Gif | EncodeFormat::Bmp | EncodeFormat::Tga | EncodeFormat::Jxl
    );
    if carries_none && (spec.keep_metadata || spec.embed_profile) {
        notes.push(ExportNote::NoMetadata);
    }

    // Samples as the target depth, RGBA.
    let data = match pixels {
        Rgba::U8(b) => {
            if b.len() != n * 4 {
                return Err(IngestError::Decode(format!(
                    "export: {} bytes for {width}x{height}",
                    b.len()
                )));
            }
            if want16 {
                notes.push(ExportNote::Widened);
                Samples::U16(b.iter().map(|&v| u16::from(v) * 257).collect())
            } else {
                Samples::U8(b.to_vec())
            }
        }
        Rgba::U16(v) => {
            if v.len() != n * 4 {
                return Err(IngestError::Decode(format!(
                    "export: {} samples for {width}x{height}",
                    v.len()
                )));
            }
            if want16 {
                Samples::U16(v)
            } else {
                Samples::U8(v.iter().map(|s| (s >> 8) as u8).collect())
            }
        }
    };
    let opaque = match &data {
        Samples::U8(v) => v.as_chunks::<4>().0.iter().all(|p| p[3] == 255),
        Samples::U16(v) => v.as_chunks::<4>().0.iter().all(|p| p[3] == u16::MAX),
        Samples::F32(_) => true,
    };
    if !opaque && spec.format == EncodeFormat::Jpeg {
        notes.push(ExportNote::AlphaDropped);
    }
    if spec.format == EncodeFormat::Gif && !fits_a_gif_palette(&data) {
        notes.push(ExportNote::GifPalette);
    }
    let keep_alpha = !opaque && spec.format != EncodeFormat::Jpeg;
    let data = rgba_to(data, spec.mode == ExportMode::Gray, keep_alpha);
    let model = if spec.mode == ExportMode::Gray {
        ColorModel::Gray
    } else {
        ColorModel::Rgb
    };
    let alpha = if keep_alpha {
        Alpha::Unassociated
    } else {
        Alpha::None
    };
    let mut img = RasterImage::from_samples(width, height, model, alpha, data);
    if let Some((w, h)) = spec.size {
        if (w, h) != (width, height) {
            img = paged_raster::resize(&img, w, h).map_err(err)?;
        }
    }

    // Colour and the profile of the pixels as written.
    let mut icc = None;
    if spec.mode == ExportMode::Cmyk {
        // The chosen profile, else a CMYK source's own (a CMYK TIFF, PSD
        // or JPEG opened and edited goes back to its inks' space).
        let source_cmyk = source
            .and_then(paged_raster::extract_icc_any)
            .filter(|p| p.get(16..20) == Some(b"CMYK"));
        let profile = spec.cmyk_profile.clone().or(source_cmyk);
        let (cmyk, managed) =
            paged_raster::rgb_to_cmyk(&img, profile.as_deref(), spec.intent).map_err(err)?;
        img = cmyk;
        if managed {
            notes.push(ExportNote::CmykProfile);
            if spec.embed_profile {
                icc = profile;
            }
        } else {
            notes.push(ExportNote::CmykNaive);
        }
    } else if spec.embed_profile {
        if spec.mode == ExportMode::Gray {
            notes.push(ExportNote::GrayUntagged);
        } else {
            icc = Some(paged_raster::srgb_icc());
        }
    }

    let source_meta = match (spec.keep_metadata, source) {
        (true, Some(bytes)) => paged_raster::read_metadata(bytes),
        _ => Metadata::default(),
    };
    let metadata = Metadata {
        icc,
        exif: source_meta.exif,
        xmp: source_meta.xmp,
        // The IPTC record alone, rebuilt into resources of its own: a
        // source's other Photoshop resources (its resolution, its profile)
        // describe the source, not this file.
        iptc: source_meta.iptc,
        photoshop_irb: None,
    };
    let options = EncodeOptions {
        quality: spec.quality.clamp(1, 100),
        ppi: spec
            .ppi
            .filter(|p| p.is_finite() && *p > 0.0)
            .map(|p| (p, p)),
        metadata,
        tiff: TiffEncodeOptions {
            compression: spec.compression,
            predictor: spec.compression != TiffCompression::None,
            rows_per_strip: None,
        },
    };
    let bytes = paged_raster::encode(&img, spec.format, &options).map_err(err)?;
    Ok(Exported { bytes, notes })
}

/// At most 256 distinct RGBA colours and no partial alpha: what a GIF
/// holds exactly.
fn fits_a_gif_palette(data: &Samples) -> bool {
    let Samples::U8(v) = data else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    for p in v.as_chunks::<4>().0 {
        if p[3] != 0 && p[3] != 255 {
            return false;
        }
        // Every fully transparent pixel is the one transparent index.
        let key = if p[3] == 0 { [0; 4] } else { *p };
        if seen.insert(key) && seen.len() > 256 {
            return false;
        }
    }
    true
}

/// RGBA samples as Gray or RGB, with or without the alpha.
fn rgba_to(data: Samples, gray: bool, alpha: bool) -> Samples {
    fn go<T: Copy + Into<f64>>(
        v: &[T],
        gray: bool,
        alpha: bool,
        from: impl Fn(f64) -> T,
    ) -> Vec<T> {
        let per = match (gray, alpha) {
            (true, false) => 1,
            (true, true) => 2,
            (false, false) => 3,
            (false, true) => 4,
        };
        let mut out = Vec::with_capacity(v.len() / 4 * per);
        for p in v.as_chunks::<4>().0 {
            if gray {
                // Rec. 601 luma, the weights Photoshop's Grayscale mode
                // uses for an sRGB image.
                let y = 0.299 * p[0].into() + 0.587 * p[1].into() + 0.114 * p[2].into();
                out.push(from(y));
            } else {
                out.extend_from_slice(&p[..3]);
            }
            if alpha {
                out.push(p[3]);
            }
        }
        out
    }
    match data {
        Samples::U8(v) => Samples::U8(go(&v, gray, alpha, |y| y.round().clamp(0.0, 255.0) as u8)),
        Samples::U16(v) => Samples::U16(go(&v, gray, alpha, |y| {
            y.round().clamp(0.0, 65535.0) as u16
        })),
        f => f,
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // the `__feat__` suffix links each test to its cockpit row
mod tests {
    use super::*;
    use paged_raster::{probe, DecodeOptions};

    fn ramp(w: u32, h: u32, alpha: u8) -> Vec<u8> {
        let mut v = Vec::new();
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 128, alpha]);
            }
        }
        v
    }

    fn spec(format: EncodeFormat) -> ExportSpec {
        ExportSpec {
            sixteen: false,
            ..ExportSpec::save_back(format, 90, Some(300.0))
        }
    }

    /// A JPEG with EXIF (Orientation 6, 72 dpi) and XMP, as a camera or
    /// Photoshop writes it.
    fn source_jpeg() -> Vec<u8> {
        let img = RasterImage::from_samples(
            4,
            4,
            ColorModel::Rgb,
            Alpha::None,
            Samples::U8(vec![90; 48]),
        );
        let mut exif =
            b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0".to_vec();
        exif.truncate(26);
        let meta = Metadata {
            exif: Some(exif),
            xmp: Some(b"<x:xmpmeta xmlns:x='adobe:ns:meta/'>source</x:xmpmeta>".to_vec()),
            iptc: Some(b"\x1c\x02\x05\0\x05Title".to_vec()),
            ..Metadata::default()
        };
        paged_raster::encode(
            &img,
            EncodeFormat::Jpeg,
            &EncodeOptions {
                metadata: meta,
                ..EncodeOptions::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn the_spec_string_parses_and_refuses_by_name__feat__image_codec_core_codecs() {
        let s = ExportSpec::from_wire(
            "format=tiff;quality=80;width=10;height=5;ppi=300;meta=0;icc=1;mode=cmyk;bits=16;compression=deflate;intent=perceptual",
        )
        .unwrap();
        assert_eq!(s.format, EncodeFormat::Tiff);
        assert_eq!(s.quality, 80);
        assert_eq!(s.size, Some((10, 5)));
        assert_eq!(s.ppi, Some(300.0));
        assert!(!s.keep_metadata && s.embed_profile && s.sixteen);
        assert_eq!(s.mode, ExportMode::Cmyk);
        assert_eq!(s.compression, TiffCompression::Deflate);
        assert_eq!(s.intent, paged_raster::Intent::Perceptual);
        assert!(ExportSpec::from_wire("quality=80")
            .unwrap_err()
            .contains("no format"));
        assert!(ExportSpec::from_wire("format=heic")
            .unwrap_err()
            .contains("format"));
        assert!(ExportSpec::from_wire("format=png;width=3").is_err());
        assert!(ExportSpec::from_wire("format=png;colour=red")
            .unwrap_err()
            .contains("colour"));
    }

    #[test]
    fn save_back_keeps_exif_xmp_iptc_and_embeds_srgb__feat__image_codec_core_codecs() {
        let src = source_jpeg();
        for format in [
            EncodeFormat::Jpeg,
            EncodeFormat::Png,
            EncodeFormat::WebP,
            EncodeFormat::Tiff,
        ] {
            let out = export(Rgba::U8(&ramp(8, 6, 255)), 8, 6, &spec(format), Some(&src)).unwrap();
            let m = paged_raster::read_metadata(&out.bytes);
            assert_eq!(
                m.icc.as_deref(),
                Some(&paged_raster::srgb_icc()[..]),
                "{format:?} ICC"
            );
            assert!(
                m.xmp
                    .as_deref()
                    .is_some_and(|x| x.ends_with(b"source</x:xmpmeta>")),
                "{format:?} XMP"
            );
            if matches!(format, EncodeFormat::Jpeg | EncodeFormat::Tiff) {
                assert_eq!(
                    m.iptc.as_deref(),
                    Some(&b"\x1c\x02\x05\0\x05Title"[..]),
                    "{format:?} IPTC"
                );
            }
            if format != EncodeFormat::Tiff {
                let exif = m.exif.unwrap_or_else(|| panic!("{format:?} EXIF"));
                // Upright: the session turned the pixels on open.
                assert_eq!(
                    paged_raster::exif::Exif::parse(&exif).orientation,
                    Some(paged_raster::exif::Orientation::TopLeft)
                );
            }
            let info = probe(&out.bytes).unwrap();
            assert_eq!((info.width, info.height), (8, 6));
            if format != EncodeFormat::WebP {
                let (x, _) = info.resolution.unwrap_or_else(|| panic!("{format:?} ppi"));
                assert!((x - 300.0).abs() < 0.5, "{format:?} ppi {x}");
            }
        }
    }

    #[test]
    fn stripping_drops_everything_but_the_profile__feat__image_codec_core_codecs() {
        let src = source_jpeg();
        let s = ExportSpec {
            keep_metadata: false,
            ..spec(EncodeFormat::Jpeg)
        };
        let out = export(Rgba::U8(&ramp(8, 6, 255)), 8, 6, &s, Some(&src)).unwrap();
        let m = paged_raster::read_metadata(&out.bytes);
        assert!(m.exif.is_none() && m.xmp.is_none() && m.iptc.is_none());
        assert!(m.icc.is_some());
        let s = ExportSpec {
            embed_profile: false,
            ..s
        };
        let out = export(Rgba::U8(&ramp(8, 6, 255)), 8, 6, &s, Some(&src)).unwrap();
        assert!(paged_raster::read_metadata(&out.bytes).is_empty());
    }

    #[test]
    fn sixteen_bit_tiff_and_png_keep_the_samples__feat__image_codec_core_codecs() {
        let v: Vec<u16> = (0..6 * 4 * 4).map(|i| (i * 683) as u16).collect();
        let v: Vec<u16> = v
            .chunks(4)
            .flat_map(|p| [p[0], p[1], p[2], u16::MAX])
            .collect();
        for format in [EncodeFormat::Png, EncodeFormat::Tiff] {
            let s = ExportSpec {
                sixteen: true,
                ..spec(format)
            };
            let out = export(Rgba::U16(v.clone()), 6, 4, &s, None).unwrap();
            assert!(out.notes.is_empty(), "{:?}", out.notes);
            let img = paged_raster::decode(&out.bytes, DecodeOptions::default()).unwrap();
            let Samples::U16(got) = img.data else {
                panic!("{format:?} is not 16-bit")
            };
            let want: Vec<u16> = v.chunks(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
            assert_eq!(got, want, "{format:?}");
        }
        // 8-bit pixels asked for 16: widened, and said.
        let s = ExportSpec {
            sixteen: true,
            ..spec(EncodeFormat::Tiff)
        };
        let out = export(Rgba::U8(&ramp(4, 4, 255)), 4, 4, &s, None).unwrap();
        assert_eq!(out.notes, vec![ExportNote::Widened]);
    }

    #[test]
    fn cmyk_tiff_without_a_profile_is_naive_and_says_so__feat__image_codec_core_codecs() {
        let s = ExportSpec {
            mode: ExportMode::Cmyk,
            ..spec(EncodeFormat::Tiff)
        };
        let out = export(Rgba::U8(&[255, 0, 0, 255, 0, 0, 0, 255]), 2, 1, &s, None).unwrap();
        assert_eq!(out.notes, vec![ExportNote::CmykNaive]);
        let img = paged_raster::decode(&out.bytes, DecodeOptions::default()).unwrap();
        assert_eq!(img.model, ColorModel::Cmyk);
        assert_eq!(img.data, Samples::U8(vec![0, 255, 255, 0, 0, 0, 0, 255]));
        assert!(paged_raster::read_metadata(&out.bytes).icc.is_none());
        // CMYK is a TIFF affair.
        let s = ExportSpec {
            mode: ExportMode::Cmyk,
            ..spec(EncodeFormat::Jpeg)
        };
        assert!(export(Rgba::U8(&[0; 8]), 2, 1, &s, None).is_err());
    }

    #[test]
    fn size_gray_alpha_and_webp_notes__feat__image_codec_core_codecs() {
        let s = ExportSpec {
            size: Some((4, 3)),
            mode: ExportMode::Gray,
            ..spec(EncodeFormat::Png)
        };
        let out = export(Rgba::U8(&ramp(8, 6, 200)), 8, 6, &s, None).unwrap();
        assert_eq!(out.notes, vec![ExportNote::GrayUntagged]);
        let info = probe(&out.bytes).unwrap();
        assert_eq!((info.width, info.height), (4, 3));
        assert_eq!(info.color_model, ColorModel::Gray);
        assert_ne!(info.alpha, Alpha::None, "the alpha is kept");
        let out = export(
            Rgba::U8(&ramp(8, 6, 200)),
            8,
            6,
            &spec(EncodeFormat::Jpeg),
            None,
        )
        .unwrap();
        assert_eq!(out.notes, vec![ExportNote::AlphaDropped]);
        let out = export(
            Rgba::U8(&ramp(8, 6, 255)),
            8,
            6,
            &spec(EncodeFormat::WebP),
            None,
        )
        .unwrap();
        assert_eq!(out.notes, vec![ExportNote::WebpLossless]);
        let back = paged_raster::decode(&out.bytes, DecodeOptions::default()).unwrap();
        assert_eq!(
            back.data,
            Samples::U8(
                ramp(8, 6, 255)
                    .chunks(4)
                    .flat_map(|p| [p[0], p[1], p[2]])
                    .collect()
            ),
            "lossless"
        );
    }

    #[test]
    fn gif_bmp_tga_and_jxl_write_the_pixels_and_say_what_they_drop__feat__images_graphics_codecs_long_tail(
    ) {
        // An opaque 8 x 6 ramp: 48 colours, so GIF keeps them exactly.
        let px = ramp(8, 6, 255);
        let rgb: Vec<u8> = px.chunks(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
        for (format, extra) in [
            (EncodeFormat::Gif, None),
            (EncodeFormat::Bmp, None),
            (EncodeFormat::Tga, None),
            (EncodeFormat::Jxl, Some(ExportNote::JxlLossless)),
        ] {
            let out = export(Rgba::U8(&px), 8, 6, &spec(format), None).unwrap();
            let mut want: Vec<ExportNote> = extra.into_iter().collect();
            want.push(ExportNote::NoMetadata);
            assert_eq!(out.notes, want, "{format:?}");
            assert_eq!(paged_raster::sniff(&out.bytes), Some(format.format()));
            let back = paged_raster::decode(&out.bytes, DecodeOptions::default()).unwrap();
            let got: Vec<u8> = match (&back.data, back.channels()) {
                (Samples::U8(v), 3) => v.clone(),
                (Samples::U8(v), 4) => v.chunks(4).flat_map(|p| [p[0], p[1], p[2]]).collect(),
                other => panic!("{format:?}: {other:?}"),
            };
            assert_eq!(got, rgb, "{format:?} is lossless here");
        }
        // Stripping says nothing; more colours than a GIF palette are said.
        let quiet = ExportSpec {
            keep_metadata: false,
            embed_profile: false,
            ..spec(EncodeFormat::Gif)
        };
        let out = export(Rgba::U8(&ramp(32, 32, 255)), 32, 32, &quiet, None).unwrap();
        assert_eq!(out.notes, vec![ExportNote::GifPalette]);
        let out = export(Rgba::U8(&ramp(8, 6, 128)), 8, 6, &quiet, None).unwrap();
        assert_eq!(out.notes, vec![ExportNote::GifPalette], "partial alpha");
    }

    #[test]
    fn jxl_keeps_sixteen_bits_and_cmyk_stays_a_tiff_affair__feat__images_graphics_codecs_long_tail()
    {
        let v: Vec<u16> = (0..4 * 3 * 4)
            .map(|i| {
                if i % 4 == 3 {
                    u16::MAX
                } else {
                    (i * 4099) as u16
                }
            })
            .collect();
        let s = ExportSpec {
            sixteen: true,
            ..spec(EncodeFormat::Jxl)
        };
        let out = export(Rgba::U16(v.clone()), 4, 3, &s, None).unwrap();
        assert!(!out.notes.contains(&ExportNote::Narrowed));
        assert_eq!(probe(&out.bytes).unwrap().bits_per_sample, 16);
        for format in [EncodeFormat::Gif, EncodeFormat::Jxl, EncodeFormat::Bmp] {
            let s = ExportSpec {
                mode: ExportMode::Cmyk,
                ..spec(format)
            };
            match export(Rgba::U8(&ramp(2, 2, 255)), 2, 2, &s, None) {
                Err(IngestError::Unsupported(m)) => assert!(m.contains("TIFF"), "{m}"),
                other => panic!("{format:?}: {other:?}"),
            }
        }
        assert_eq!(
            ExportSpec::from_wire("format=gif").unwrap().format,
            EncodeFormat::Gif
        );
    }
}
