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

//! Encode a [`RasterImage`] as PNG, JPEG, WebP, TIFF, GIF, BMP, TGA,
//! JPEG XL or AVIF, with its metadata.
//!
//! One entry point, [`encode`], over the encoders the engine already
//! links: `image`'s PNG, JPEG, GIF, BMP and TGA encoders, image-webp's
//! WebP encoder, this crate's TIFF writer, zune-jpegxl (feature
//! `jxl-encode`, on by default) and ravif over rav1e (feature
//! `avif-encode`, off by default). What each writes:
//!
//! | | samples | ICC | EXIF | XMP | IPTC | resolution |
//! |---|---|---|---|---|---|---|
//! | PNG | Gray/RGB ± alpha, 8/16-bit | `iCCP` | `eXIf` | `iTXt` | — | `pHYs` |
//! | JPEG | Gray/RGB, 8-bit, quality 1–100 | APP2 | APP1 | APP1 | APP13 | JFIF |
//! | WebP | Gray/RGB ± alpha, 8-bit, lossless | `ICCP` | `EXIF` | `XMP ` | — | — |
//! | TIFF | Gray/RGB/CMYK ± alpha, 8/16-bit | 34675 | — | 700 | 33723 | 282/283 |
//! | GIF | RGB ± alpha, 8-bit, 256 colours | — | — | — | — | — |
//! | BMP | Gray/RGB ± alpha (Gray with alpha as RGBA), 8-bit | — | — | — | — | pels per metre |
//! | TGA | Gray/RGB ± alpha, 8-bit, RLE | — | — | — | — | — |
//! | JPEG XL | Gray/RGB ± alpha, 8/16-bit, lossless | — | — | — | — | — |
//! | AVIF | Gray/RGB ± alpha, 8-bit in, quality 1–100 | — | `Exif` | — | — | — |
//!
//! JPEG has no alpha (it is dropped); 16-bit samples are narrowed to 8 by
//! their high byte for the 8-bit formats. WebP is lossless only:
//! image-webp has no lossy (VP8) encoder. GIF holds 256 colours: an image
//! with at most 256 distinct colours (alpha included) keeps them exactly,
//! one with more is quantized (NeuQuant, `gif`'s), and alpha is one bit
//! (a pixel is transparent or not). Gray is written as RGB in GIF, and in
//! AVIF (ravif encodes RGB). JPEG XL is lossless (zune-jpegxl writes the
//! modular mode only). EXIF is written with Orientation 1
//! ([`crate::exif::with_upright_orientation`]): the pixels an editor
//! writes back were turned upright when they were opened.

use std::io::Cursor;

use image::ImageEncoder as _;

use crate::meta::{
    irb_with_iptc, png_chunk, png_chunks, png_xmp_chunk, Metadata, PHOTOSHOP_ID, XMP_ID,
};
use crate::{
    encode_tiff, Alpha, ColorModel, Error, Format, RasterImage, RasterInfo, Result, SampleFormat,
    Samples, TiffEncodeOptions,
};

/// The formats [`encode`] writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EncodeFormat {
    Png,
    Jpeg,
    WebP,
    Tiff,
    Gif,
    Bmp,
    Tga,
    /// Lossless JPEG XL (feature `jxl-encode`).
    Jxl,
    /// AVIF (feature `avif-encode`, off by default).
    Avif,
}

impl EncodeFormat {
    /// Every format, in the order a format menu lists them.
    pub const ALL: [EncodeFormat; 9] = [
        EncodeFormat::Png,
        EncodeFormat::Jpeg,
        EncodeFormat::WebP,
        EncodeFormat::Tiff,
        EncodeFormat::Gif,
        EncodeFormat::Bmp,
        EncodeFormat::Tga,
        EncodeFormat::Jxl,
        EncodeFormat::Avif,
    ];

    /// `png`, `jpeg` (or `jpg`), `webp`, `tiff` (or `tif`), `gif`, `bmp`,
    /// `tga`, `jxl`, `avif`.
    pub fn from_name(name: &str) -> Option<EncodeFormat> {
        Some(match name.to_ascii_lowercase().as_str() {
            "png" => EncodeFormat::Png,
            "jpeg" | "jpg" => EncodeFormat::Jpeg,
            "webp" => EncodeFormat::WebP,
            "tiff" | "tif" => EncodeFormat::Tiff,
            "gif" => EncodeFormat::Gif,
            "bmp" => EncodeFormat::Bmp,
            "tga" => EncodeFormat::Tga,
            "jxl" => EncodeFormat::Jxl,
            "avif" => EncodeFormat::Avif,
            _ => return None,
        })
    }

    /// The name [`EncodeFormat::from_name`] reads back.
    pub fn name(self) -> &'static str {
        match self {
            EncodeFormat::Png => "png",
            EncodeFormat::Jpeg => "jpeg",
            EncodeFormat::WebP => "webp",
            EncodeFormat::Tiff => "tiff",
            EncodeFormat::Gif => "gif",
            EncodeFormat::Bmp => "bmp",
            EncodeFormat::Tga => "tga",
            EncodeFormat::Jxl => "jxl",
            EncodeFormat::Avif => "avif",
        }
    }

    /// The container [`crate::sniff`] reads the result as.
    pub fn format(self) -> Format {
        match self {
            EncodeFormat::Png => Format::Png,
            EncodeFormat::Jpeg => Format::Jpeg,
            EncodeFormat::WebP => Format::WebP,
            EncodeFormat::Tiff => Format::Tiff,
            EncodeFormat::Gif => Format::Gif,
            EncodeFormat::Bmp => Format::Bmp,
            EncodeFormat::Tga => Format::Tga,
            EncodeFormat::Jxl => Format::Jxl,
            EncodeFormat::Avif => Format::Avif,
        }
    }

    /// This build carries the encoder: false for JPEG XL without the
    /// `jxl-encode` feature and for AVIF without `avif-encode`, whose
    /// [`encode`] refuses, naming the feature.
    pub fn available(self) -> bool {
        const JXL: bool = cfg!(feature = "jxl-encode");
        const AVIF: bool = cfg!(feature = "avif-encode");
        match self {
            EncodeFormat::Jxl => JXL,
            EncodeFormat::Avif => AVIF,
            _ => true,
        }
    }

    /// The encoder writes every sample as given (GIF quantizes beyond
    /// 256 colours, JPEG and AVIF are lossy).
    pub fn lossless(self) -> bool {
        !matches!(
            self,
            EncodeFormat::Jpeg | EncodeFormat::Avif | EncodeFormat::Gif
        )
    }
}

/// How [`encode`] writes a file.
#[derive(Clone, Debug, PartialEq)]
pub struct EncodeOptions {
    /// JPEG quality, 1 to 100 (other formats ignore it).
    pub quality: u8,
    /// Pixels per inch, horizontal and vertical.
    pub ppi: Option<(f64, f64)>,
    /// What to embed: the ICC profile of the pixels as written, and the
    /// EXIF, XMP, IPTC and Photoshop resources to carry. An empty
    /// [`Metadata`] writes a file without any.
    pub metadata: Metadata,
    /// TIFF compression and layout.
    pub tiff: TiffEncodeOptions,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        EncodeOptions {
            quality: 90,
            ppi: None,
            metadata: Metadata::default(),
            tiff: TiffEncodeOptions::default(),
        }
    }
}

/// WebP's lossy (VP8) encoding is not available: image-webp writes
/// lossless WebP only.
pub const WEBP_LOSSY: bool = false;

/// Encode `img` as `format`. See the module docs for what each format
/// carries; a colour model a format cannot hold (CMYK as PNG, JPEG or
/// WebP; Lab anywhere) is an [`Error::Encode`] naming it.
pub fn encode(img: &RasterImage, format: EncodeFormat, opts: &EncodeOptions) -> Result<Vec<u8>> {
    check_len(img)?;
    match format {
        EncodeFormat::Png => encode_png(img, opts),
        EncodeFormat::Jpeg => encode_jpeg(img, opts),
        EncodeFormat::WebP => encode_webp(img, opts),
        EncodeFormat::Gif => encode_gif(img),
        EncodeFormat::Bmp => encode_bmp(img, opts),
        EncodeFormat::Tga => encode_tga(img),
        EncodeFormat::Jxl => encode_jxl(img),
        EncodeFormat::Avif => encode_avif(img, opts),
        EncodeFormat::Tiff => {
            let m = &opts.metadata;
            let mut page = img.clone();
            page.info.icc = m.icc.clone();
            page.info.xmp = m.xmp.clone();
            page.info.iptc = m.iptc.clone();
            page.info.photoshop_irb = m.photoshop_irb.clone();
            page.info.resolution = opts.ppi;
            encode_tiff(&page, opts.tiff)
        }
    }
}

impl RasterImage {
    /// An image from samples alone (header facts derived from them), the
    /// shape [`encode`] takes for pixels that did not come from a file.
    pub fn from_samples(
        width: u32,
        height: u32,
        model: ColorModel,
        alpha: Alpha,
        data: Samples,
    ) -> RasterImage {
        let channels = model.colour_channels() + usize::from(alpha != Alpha::None);
        let (bits, sample_format) = match &data {
            Samples::U8(_) => (8, SampleFormat::UInt),
            Samples::U16(_) => (16, SampleFormat::UInt),
            Samples::F32(_) => (32, SampleFormat::Float),
        };
        RasterImage {
            info: RasterInfo {
                format: Format::Tiff,
                width,
                height,
                channels: channels as u16,
                bits_per_sample: bits,
                sample_format,
                color_model: model,
                alpha,
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
            },
            width,
            height,
            model,
            alpha,
            data,
        }
    }
}

fn check_len(img: &RasterImage) -> Result<()> {
    let want = img.width as usize * img.height as usize * img.channels();
    if img.data.len() != want || img.width == 0 || img.height == 0 {
        return Err(Error::Encode(format!(
            "{} samples for {}x{} at {} channels",
            img.data.len(),
            img.width,
            img.height,
            img.channels()
        )));
    }
    Ok(())
}

fn refuse(format: &str, img: &RasterImage) -> Error {
    Error::Encode(format!("{format} cannot hold a {:?} image", img.model))
}

/// 8-bit samples: U8 as they are, U16 by the high byte, floats clipped.
fn to_u8(data: &Samples) -> std::borrow::Cow<'_, [u8]> {
    match data {
        Samples::U8(v) => std::borrow::Cow::Borrowed(v),
        Samples::U16(v) => std::borrow::Cow::Owned(v.iter().map(|s| (s >> 8) as u8).collect()),
        Samples::F32(v) => std::borrow::Cow::Owned(
            v.iter()
                .map(|s| (s.clamp(0.0, 1.0) * 255.0).round() as u8)
                .collect(),
        ),
    }
}

/// The EXIF payload as written: upright.
fn exif_out(m: &Metadata) -> Option<Vec<u8>> {
    m.exif.as_deref().map(crate::exif::with_upright_orientation)
}

fn enc_err(e: impl std::fmt::Display) -> Error {
    Error::Encode(e.to_string())
}

fn encode_png(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    use image::ExtendedColorType as C;
    let alpha = img.alpha != Alpha::None;
    let sixteen = matches!(img.data, Samples::U16(_));
    let ct = match (img.model, alpha, sixteen) {
        (ColorModel::Gray, false, false) => C::L8,
        (ColorModel::Gray, true, false) => C::La8,
        (ColorModel::Rgb, false, false) => C::Rgb8,
        (ColorModel::Rgb, true, false) => C::Rgba8,
        (ColorModel::Gray, false, true) => C::L16,
        (ColorModel::Gray, true, true) => C::La16,
        (ColorModel::Rgb, false, true) => C::Rgb16,
        (ColorModel::Rgb, true, true) => C::Rgba16,
        _ => return Err(refuse("PNG", img)),
    };
    // 16-bit samples go to the encoder in native byte order (it swaps).
    let bytes: std::borrow::Cow<'_, [u8]> = match &img.data {
        Samples::U16(v) => {
            std::borrow::Cow::Owned(v.iter().flat_map(|s| s.to_ne_bytes()).collect())
        }
        other => to_u8(other),
    };
    let mut out = Vec::new();
    let mut enc = image::codecs::png::PngEncoder::new(&mut out);
    let m = &opts.metadata;
    if let Some(icc) = &m.icc {
        enc.set_icc_profile(icc.clone()).map_err(enc_err)?;
    }
    if let Some(exif) = exif_out(m) {
        enc.set_exif_metadata(exif).map_err(enc_err)?;
    }
    enc.write_image(&bytes, img.width, img.height, ct)
        .map_err(enc_err)?;

    // pHYs and the XMP iTXt go before the first IDAT.
    let mut extra = Vec::new();
    if let Some((x, y)) = opts.ppi {
        let ppm = |v: f64| (v / 0.0254).round().clamp(1.0, f64::from(u32::MAX)) as u32;
        let mut d = Vec::with_capacity(9);
        d.extend_from_slice(&ppm(x).to_be_bytes());
        d.extend_from_slice(&ppm(y).to_be_bytes());
        d.push(1);
        extra.extend_from_slice(&png_chunk(b"pHYs", &d));
    }
    if let Some(xmp) = &m.xmp {
        extra.extend_from_slice(&png_xmp_chunk(xmp));
    }
    if extra.is_empty() {
        return Ok(out);
    }
    let at = png_chunks(&out)
        .into_iter()
        .find(|(k, _, _)| k == b"IDAT")
        .map(|(_, _, at)| at)
        .ok_or_else(|| Error::Encode("PNG without IDAT".into()))?;
    out.splice(at..at, extra);
    Ok(out)
}

fn encode_jpeg(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    use image::codecs::jpeg::{JpegEncoder, PixelDensity, PixelDensityUnit};
    let n = img.width as usize * img.height as usize;
    let samples = to_u8(&img.data);
    let (ct, colour): (image::ExtendedColorType, Vec<u8>) = match (img.model, img.alpha) {
        (ColorModel::Gray, Alpha::None) => (image::ExtendedColorType::L8, samples.into_owned()),
        (ColorModel::Rgb, Alpha::None) => (image::ExtendedColorType::Rgb8, samples.into_owned()),
        // JPEG has no alpha: the colour samples are kept, alpha dropped.
        (ColorModel::Gray, _) => (
            image::ExtendedColorType::L8,
            samples.as_chunks::<2>().0.iter().map(|p| p[0]).collect(),
        ),
        (ColorModel::Rgb, _) => (
            image::ExtendedColorType::Rgb8,
            samples
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|p| [p[0], p[1], p[2]])
                .collect(),
        ),
        _ => return Err(refuse("JPEG", img)),
    };
    debug_assert_eq!(colour.len(), n * usize::from(ct.channel_count()));
    let mut out = Vec::new();
    let mut enc = JpegEncoder::new_with_quality(&mut out, opts.quality.clamp(1, 100));
    if let Some((x, y)) = opts.ppi {
        let d = |v: f64| v.round().clamp(1.0, f64::from(u16::MAX)) as u16;
        enc.set_pixel_density(PixelDensity {
            density: (d(x), d(y)),
            unit: PixelDensityUnit::Inches,
        });
    }
    let m = &opts.metadata;
    if let Some(icc) = &m.icc {
        enc.set_icc_profile(icc.clone()).map_err(enc_err)?;
    }
    if let Some(exif) = exif_out(m) {
        enc.set_exif_metadata(exif).map_err(enc_err)?;
    }
    enc.write_image(&colour, img.width, img.height, ct)
        .map_err(enc_err)?;

    // XMP (APP1) and the Photoshop resources with IPTC (APP13) follow the
    // encoder's own APP segments.
    let mut extra = Vec::new();
    let mut segment = |marker: u8, id: &[u8], body: &[u8]| -> Result<()> {
        let len = 2 + id.len() + body.len();
        if len > usize::from(u16::MAX) {
            return Err(Error::Encode(format!(
                "a {len}-byte APP{} segment exceeds JPEG's 64 KiB",
                marker - 0xE0
            )));
        }
        extra.extend_from_slice(&[0xFF, marker]);
        extra.extend_from_slice(&(len as u16).to_be_bytes());
        extra.extend_from_slice(id);
        extra.extend_from_slice(body);
        Ok(())
    };
    if let Some(xmp) = &m.xmp {
        segment(0xE1, XMP_ID, xmp)?;
    }
    let irb = m
        .photoshop_irb
        .clone()
        .or_else(|| m.iptc.as_deref().map(irb_with_iptc));
    if let Some(irb) = irb {
        segment(0xED, PHOTOSHOP_ID, &irb)?;
    }
    if extra.is_empty() {
        return Ok(out);
    }
    let at = crate::meta::jpeg_segments(&out)
        .iter()
        .take_while(|s| (0xE0..=0xEF).contains(&s.marker))
        .last()
        .map_or(2, |s| s.end);
    out.splice(at..at, extra);
    Ok(out)
}

fn encode_webp(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    use image_webp::ColorType as W;
    let ct = match (img.model, img.alpha != Alpha::None) {
        (ColorModel::Gray, false) => W::L8,
        (ColorModel::Gray, true) => W::La8,
        (ColorModel::Rgb, false) => W::Rgb8,
        (ColorModel::Rgb, true) => W::Rgba8,
        _ => return Err(refuse("WebP", img)),
    };
    let samples = to_u8(&img.data);
    let mut out = Vec::new();
    let mut enc = image_webp::WebPEncoder::new(Cursor::new(&mut out));
    let m = &opts.metadata;
    if let Some(icc) = &m.icc {
        enc.set_icc_profile(icc.clone());
    }
    if let Some(exif) = exif_out(m) {
        enc.set_exif_metadata(exif);
    }
    if let Some(xmp) = &m.xmp {
        enc.set_xmp_metadata(xmp.clone());
    }
    enc.encode(&samples, img.width, img.height, ct)
        .map_err(enc_err)?;
    Ok(out)
}

/// 8-bit samples of a Gray or RGB image, with or without alpha, as the
/// `image` colour type that names them.
fn gray_rgb8<'a>(
    format: &str,
    img: &'a RasterImage,
) -> Result<(image::ExtendedColorType, std::borrow::Cow<'a, [u8]>)> {
    use image::ExtendedColorType as C;
    let ct = match (img.model, img.alpha != Alpha::None) {
        (ColorModel::Gray, false) => C::L8,
        (ColorModel::Gray, true) => C::La8,
        (ColorModel::Rgb, false) => C::Rgb8,
        (ColorModel::Rgb, true) => C::Rgba8,
        _ => return Err(refuse(format, img)),
    };
    Ok((ct, to_u8(&img.data)))
}

/// 8-bit RGB or RGBA samples of a Gray or RGB image (Gray widened).
fn rgb8(format: &str, img: &RasterImage) -> Result<(bool, Vec<u8>)> {
    let (ct, samples) = gray_rgb8(format, img)?;
    use image::ExtendedColorType as C;
    Ok(match ct {
        C::L8 => (false, samples.iter().flat_map(|&v| [v, v, v]).collect()),
        C::La8 => (
            true,
            samples
                .as_chunks::<2>()
                .0
                .iter()
                .flat_map(|&[v, a]| [v, v, v, a])
                .collect(),
        ),
        C::Rgba8 => (true, samples.into_owned()),
        _ => (false, samples.into_owned()),
    })
}

fn encode_gif(img: &RasterImage) -> Result<Vec<u8>> {
    let (alpha, samples) = rgb8("GIF", img)?;
    let mut out = Vec::new();
    {
        // Speed 10: `gif`'s recommended trade-off for NeuQuant; an image
        // of at most 256 colours is written exactly at any speed.
        let mut enc = image::codecs::gif::GifEncoder::new_with_speed(&mut out, 10);
        let ct = if alpha {
            image::ExtendedColorType::Rgba8
        } else {
            image::ExtendedColorType::Rgb8
        };
        enc.encode(&samples, img.width, img.height, ct)
            .map_err(enc_err)?;
    }
    Ok(out)
}

fn encode_bmp(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    // Gray with alpha goes out as RGBA: the encoder's 32-bit gray file
    // has no alpha mask, so a reader drops the alpha.
    let (ct, samples) = if img.model == ColorModel::Gray && img.alpha != Alpha::None {
        let (_, rgba) = rgb8("BMP", img)?;
        (
            image::ExtendedColorType::Rgba8,
            std::borrow::Cow::Owned(rgba),
        )
    } else {
        gray_rgb8("BMP", img)?
    };
    let mut out = Vec::new();
    image::codecs::bmp::BmpEncoder::new(&mut out)
        .encode(&samples, img.width, img.height, ct)
        .map_err(enc_err)?;
    // The info header's pixels per metre (offsets 38 and 42, little
    // endian), which the encoder leaves 0.
    if let Some((x, y)) = opts.ppi {
        let ppm =
            |v: f64| ((v / 0.0254).round().clamp(0.0, f64::from(i32::MAX)) as i32).to_le_bytes();
        if out.len() >= 46 {
            out[38..42].copy_from_slice(&ppm(x));
            out[42..46].copy_from_slice(&ppm(y));
        }
    }
    Ok(out)
}

fn encode_tga(img: &RasterImage) -> Result<Vec<u8>> {
    let (ct, samples) = gray_rgb8("TGA", img)?;
    let mut out = Vec::new();
    image::codecs::tga::TgaEncoder::new(&mut out)
        .encode(&samples, img.width, img.height, ct)
        .map_err(enc_err)?;
    Ok(out)
}

#[cfg(feature = "jxl-encode")]
fn encode_jxl(img: &RasterImage) -> Result<Vec<u8>> {
    use zune_core::bit_depth::BitDepth;
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::EncoderOptions;
    let space = match (img.model, img.alpha != Alpha::None) {
        (ColorModel::Gray, false) => ColorSpace::Luma,
        (ColorModel::Gray, true) => ColorSpace::LumaA,
        (ColorModel::Rgb, false) => ColorSpace::RGB,
        (ColorModel::Rgb, true) => ColorSpace::RGBA,
        _ => return Err(refuse("JPEG XL", img)),
    };
    // 16-bit samples go in as native-endian byte pairs; floats are
    // narrowed to 8 bits (the encoder takes integers only).
    let (bytes, depth): (std::borrow::Cow<'_, [u8]>, BitDepth) = match &img.data {
        Samples::U16(v) => (
            std::borrow::Cow::Owned(v.iter().flat_map(|s| s.to_ne_bytes()).collect()),
            BitDepth::Sixteen,
        ),
        other => (to_u8(other), BitDepth::Eight),
    };
    let options = EncoderOptions::new(img.width as usize, img.height as usize, space, depth);
    let mut out = Vec::new();
    zune_jpegxl::JxlSimpleEncoder::new(&bytes, options)
        .encode(&mut out)
        .map_err(|e| Error::Encode(format!("JPEG XL: {e:?}")))?;
    Ok(out)
}

#[cfg(not(feature = "jxl-encode"))]
fn encode_jxl(_: &RasterImage) -> Result<Vec<u8>> {
    Err(Error::Encode(
        "JPEG XL encoding is not in this build (the `jxl-encode` feature is off)".into(),
    ))
}

#[cfg(feature = "avif-encode")]
fn encode_avif(img: &RasterImage, opts: &EncodeOptions) -> Result<Vec<u8>> {
    use ravif::{Encoder, Img, RGB8, RGBA8};
    let (alpha, samples) = rgb8("AVIF", img)?;
    let (w, h) = (img.width as usize, img.height as usize);
    let quality = f32::from(opts.quality.clamp(1, 100));
    let mut enc = Encoder::new()
        .with_quality(quality)
        .with_alpha_quality(quality)
        // Speed 6 of 1 (slowest) to 10: an export, not an archive.
        .with_speed(6)
        .with_num_threads(Some(1));
    let exif = exif_out(&opts.metadata);
    if let Some(exif) = exif {
        enc = enc.with_exif(exif);
    }
    let encoded = if alpha {
        let px: Vec<RGBA8> = samples
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&[r, g, b, a]| RGBA8::new(r, g, b, a))
            .collect();
        enc.encode_rgba(Img::new(&px[..], w, h))
    } else {
        let px: Vec<RGB8> = samples
            .as_chunks::<3>()
            .0
            .iter()
            .map(|&[r, g, b]| RGB8::new(r, g, b))
            .collect();
        enc.encode_rgb(Img::new(&px[..], w, h))
    }
    .map_err(|e| Error::Encode(format!("AVIF: {e}")))?;
    Ok(encoded.avif_file)
}

#[cfg(not(feature = "avif-encode"))]
fn encode_avif(_: &RasterImage, _: &EncodeOptions) -> Result<Vec<u8>> {
    Err(Error::Encode(
        "AVIF encoding is not in this build (the `avif-encode` feature is off)".into(),
    ))
}

/// The sRGB profile (moxcms's), for an export whose pixels are sRGB.
pub fn srgb_icc() -> Vec<u8> {
    moxcms::ColorProfile::new_srgb()
        .encode()
        .unwrap_or_default()
}

/// sRGB samples (8-bit, Gray or RGB, alpha kept) converted to CMYK for a
/// print export: through `profile` with `intent` when it is a usable CMYK
/// output profile, else with the naive formula (`k = 1 - max(r, g, b)`).
/// Returns the image and whether the profile was used.
pub fn rgb_to_cmyk(
    img: &RasterImage,
    profile: Option<&[u8]>,
    intent: paged_color::Intent,
) -> Result<(RasterImage, bool)> {
    check_len(img)?;
    let alpha = img.alpha != Alpha::None;
    let samples = to_u8(&img.data);
    let ch = img.channels();
    let rgb: Vec<[u8; 3]> = samples
        .chunks_exact(ch)
        .map(|p| match img.model {
            ColorModel::Gray => [p[0], p[0], p[0]],
            ColorModel::Rgb => [p[0], p[1], p[2]],
            _ => [0, 0, 0],
        })
        .collect();
    if !matches!(img.model, ColorModel::Gray | ColorModel::Rgb) {
        return Err(Error::Encode(format!(
            "CMYK conversion takes Gray or RGB, not {:?}",
            img.model
        )));
    }
    let mut cmyk = vec![[0u8; 4]; rgb.len()];
    let managed = profile.is_some_and(|p| {
        let mut cmm =
            paged_color::IccCmm::new(None, paged_color::DisplaySetup { intent, bpc: true });
        cmm.configure_export(Some(p), paged_color::ExportPolicy::ConvertToDestination);
        cmm.export_rgb8_to_cmyk8(&rgb, &mut cmyk)
    });
    if !managed {
        for (o, p) in cmyk.iter_mut().zip(&rgb) {
            let [r, g, b] = p.map(|v| f32::from(v) / 255.0);
            let k = 1.0 - r.max(g).max(b);
            let ink = |c: f32| {
                if k >= 1.0 {
                    0.0
                } else {
                    (1.0 - c - k) / (1.0 - k)
                }
            };
            let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
            *o = [q(ink(r)), q(ink(g)), q(ink(b)), q(k)];
        }
    }
    let mut data = Vec::with_capacity(rgb.len() * (4 + usize::from(alpha)));
    for (i, c) in cmyk.iter().enumerate() {
        data.extend_from_slice(c);
        if alpha {
            data.push(samples[i * ch + ch - 1]);
        }
    }
    let out = RasterImage::from_samples(
        img.width,
        img.height,
        ColorModel::Cmyk,
        img.alpha,
        Samples::U8(data),
    );
    Ok((out, managed))
}

/// `img` resampled to `width` x `height` (Lanczos 3), for an export at
/// another scale. 8- and 16-bit Gray or RGB with or without alpha, and
/// 8-bit CMYK; the header facts are kept.
pub fn resize(img: &RasterImage, width: u32, height: u32) -> Result<RasterImage> {
    use image::imageops::{resize, FilterType};
    use image::{ImageBuffer, Luma, LumaA, Rgb, Rgba};
    check_len(img)?;
    if width == 0 || height == 0 {
        return Err(Error::Encode(format!("cannot resize to {width}x{height}")));
    }
    if (width, height) == (img.width, img.height) {
        return Ok(img.clone());
    }
    let (w, h) = (img.width, img.height);
    let f = FilterType::Lanczos3;
    macro_rules! go {
        ($px:ident, $v:expr, $t:ty) => {{
            let buf: ImageBuffer<$px<$t>, Vec<$t>> = ImageBuffer::from_raw(w, h, $v.clone())
                .ok_or_else(|| Error::Encode("bad sample count".into()))?;
            resize(&buf, width, height, f).into_raw()
        }};
    }
    let data = match (&img.data, img.model, img.alpha != Alpha::None) {
        (Samples::U8(v), ColorModel::Gray, false) => Samples::U8(go!(Luma, v, u8)),
        (Samples::U8(v), ColorModel::Gray, true) => Samples::U8(go!(LumaA, v, u8)),
        (Samples::U8(v), ColorModel::Rgb, false) => Samples::U8(go!(Rgb, v, u8)),
        (Samples::U8(v), ColorModel::Rgb, true) => Samples::U8(go!(Rgba, v, u8)),
        // Four 8-bit channels resample alike, whatever they mean.
        (Samples::U8(v), ColorModel::Cmyk, false) => Samples::U8(go!(Rgba, v, u8)),
        (Samples::U16(v), ColorModel::Gray, false) => Samples::U16(go!(Luma, v, u16)),
        (Samples::U16(v), ColorModel::Gray, true) => Samples::U16(go!(LumaA, v, u16)),
        (Samples::U16(v), ColorModel::Rgb, false) => Samples::U16(go!(Rgb, v, u16)),
        (Samples::U16(v), ColorModel::Rgb, true) => Samples::U16(go!(Rgba, v, u16)),
        _ => {
            return Err(Error::Encode(format!(
                "cannot resize a {:?} image with these samples",
                img.model
            )))
        }
    };
    Ok(RasterImage {
        width,
        height,
        data,
        ..img.clone()
    })
}
