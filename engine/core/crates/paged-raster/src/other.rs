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

//! PNG, JPEG, WebP, GIF and BMP, read through `image`; and TGA, QOI, ICO
//! (its largest entry, as `image` picks it), Radiance HDR and OpenEXR
//! (the `exr` feature), each decoded with its format named, since TGA has
//! no magic number `image` could guess from.

use image::{DynamicImage, ImageDecoder, ImageFormat};

use crate::{
    Alpha, ColorModel, DecodeOptions, Error, Format, RasterImage, RasterInfo, Result, Rgba8,
    SampleFormat, Samples,
};

fn malformed(format: Format, err: image::ImageError) -> Error {
    exr_error(format, image_error(format, err))
}

fn image_error(format: Format, err: image::ImageError) -> Error {
    match err {
        image::ImageError::Unsupported(u) => Error::Unsupported {
            format,
            what: u.to_string(),
        },
        other => Error::Malformed {
            format,
            detail: other.to_string(),
        },
    }
}

fn single_page(page: usize) -> Result<()> {
    if page == 0 {
        Ok(())
    } else {
        Err(Error::PageOutOfRange { page, count: 1 })
    }
}

/// The `image` format of one of this module's formats.
fn image_format(format: Format) -> Option<ImageFormat> {
    Some(match format {
        Format::Png => ImageFormat::Png,
        Format::Jpeg => ImageFormat::Jpeg,
        Format::WebP => ImageFormat::WebP,
        Format::Gif => ImageFormat::Gif,
        Format::Bmp => ImageFormat::Bmp,
        Format::Tga => ImageFormat::Tga,
        Format::Qoi => ImageFormat::Qoi,
        Format::Ico => ImageFormat::Ico,
        Format::Hdr => ImageFormat::Hdr,
        Format::Exr => ImageFormat::OpenExr,
        _ => return None,
    })
}

fn load(bytes: &[u8], format: Format) -> Result<DynamicImage> {
    let f = image_format(format).ok_or(Error::UnknownFormat)?;
    exr_supported(bytes, format)?;
    image::load_from_memory_with_format(bytes, f).map_err(|e| malformed(format, e))
}

/// The OpenEXR variants `image` does not read, refused by name: deep data
/// (the version field's bit 11) and an image without R, G and B channels
/// (luminance and chroma, or channels of other names). Every part of a
/// multi-part file is looked at; the first with R, G and B is read.
fn exr_supported(bytes: &[u8], format: Format) -> Result<()> {
    if format != Format::Exr {
        return Ok(());
    }
    let unsupported = |what: &str| Error::Unsupported {
        format,
        what: what.into(),
    };
    if bytes.len() >= 8 && bytes[5] & 0x08 != 0 {
        return Err(unsupported(
            "deep data (an OpenEXR 2 deep image; flat images are read)",
        ));
    }
    Ok(())
}

/// `image`'s refusal of an OpenEXR without R, G and B channels, as an
/// [`Error::Unsupported`] that says so.
fn exr_error(format: Format, err: Error) -> Error {
    match err {
        Error::Malformed { detail, .. }
            if format == Format::Exr && detail.contains("rgb channels") =>
        {
            Error::Unsupported {
                format,
                what: "an OpenEXR image without R, G and B channels (luminance and chroma, \
                       or channels of other names)"
                    .into(),
            }
        }
        other => other,
    }
}

pub(crate) fn probe(bytes: &[u8], format: Format, page: usize) -> Result<RasterInfo> {
    single_page(page)?;
    exr_supported(bytes, format)?;
    let f = image_format(format).ok_or(Error::UnknownFormat)?;
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), f);
    let mut decoder = reader.into_decoder().map_err(|e| malformed(format, e))?;
    let (width, height) = decoder.dimensions();
    let colour = decoder.color_type();
    let icc = match format {
        Format::Jpeg | Format::Png => crate::icc::extract_icc(bytes),
        _ => decoder.icc_profile().ok().flatten(),
    };
    let (color_model, alpha, sample_format) = describe(colour);
    let alpha = exr_alpha(format, alpha);
    let meta = match format {
        Format::Png | Format::WebP => crate::meta::read_metadata(bytes),
        _ => crate::meta::Metadata::default(),
    };
    let resolution = match format {
        Format::Png => crate::meta::png_ppi(bytes),
        _ => None,
    };
    Ok(RasterInfo {
        format,
        width,
        height,
        channels: u16::from(colour.channel_count()),
        bits_per_sample: colour.bits_per_pixel() / u16::from(colour.channel_count()),
        sample_format,
        color_model,
        alpha,
        icc,
        xmp: meta.xmp,
        iptc: None,
        exif: meta.exif,
        photoshop_irb: None,
        has_layers: false,
        layer_count: Some(0),
        resolution,
        orientation: 1,
        page_count: 1,
    })
}

fn describe(colour: image::ColorType) -> (ColorModel, Alpha, SampleFormat) {
    let model = if colour.has_color() {
        ColorModel::Rgb
    } else {
        ColorModel::Gray
    };
    let alpha = if colour.has_alpha() {
        Alpha::Unassociated
    } else {
        Alpha::None
    };
    let format = match colour {
        image::ColorType::Rgb32F | image::ColorType::Rgba32F => SampleFormat::Float,
        _ => SampleFormat::UInt,
    };
    (model, alpha, format)
}

pub(crate) fn decode(bytes: &[u8], format: Format, opts: DecodeOptions) -> Result<RasterImage> {
    let info = probe(bytes, format, opts.page)?;
    let img = load(bytes, format)?;
    let (width, height) = (img.width(), img.height());
    let (model, alpha, data) = match img {
        DynamicImage::ImageLuma8(b) => (ColorModel::Gray, Alpha::None, Samples::U8(b.into_raw())),
        DynamicImage::ImageLumaA8(b) => (
            ColorModel::Gray,
            Alpha::Unassociated,
            Samples::U8(b.into_raw()),
        ),
        DynamicImage::ImageRgb8(b) => (ColorModel::Rgb, Alpha::None, Samples::U8(b.into_raw())),
        DynamicImage::ImageRgba8(b) => (
            ColorModel::Rgb,
            Alpha::Unassociated,
            Samples::U8(b.into_raw()),
        ),
        DynamicImage::ImageLuma16(b) => (ColorModel::Gray, Alpha::None, Samples::U16(b.into_raw())),
        DynamicImage::ImageLumaA16(b) => (
            ColorModel::Gray,
            Alpha::Unassociated,
            Samples::U16(b.into_raw()),
        ),
        DynamicImage::ImageRgb16(b) => (ColorModel::Rgb, Alpha::None, Samples::U16(b.into_raw())),
        DynamicImage::ImageRgba16(b) => (
            ColorModel::Rgb,
            Alpha::Unassociated,
            Samples::U16(b.into_raw()),
        ),
        DynamicImage::ImageRgb32F(b) => (ColorModel::Rgb, Alpha::None, Samples::F32(b.into_raw())),
        DynamicImage::ImageRgba32F(b) => (
            ColorModel::Rgb,
            Alpha::Unassociated,
            Samples::F32(b.into_raw()),
        ),
        other => (
            ColorModel::Rgb,
            Alpha::Unassociated,
            Samples::U8(other.to_rgba8().into_raw()),
        ),
    };
    Ok(RasterImage {
        info,
        width,
        height,
        model,
        alpha: exr_alpha(format, alpha),
        data,
    })
}

/// OpenEXR stores colour premultiplied by its alpha (the format's
/// convention, and how Photoshop reads it: ADR 1038's oracle), so an
/// OpenEXR alpha is associated; `image` hands the samples over as stored.
fn exr_alpha(format: Format, alpha: Alpha) -> Alpha {
    if format == Format::Exr && alpha != Alpha::None {
        Alpha::Associated
    } else {
        alpha
    }
}

/// Exactly what the renderer did before this crate: `image`'s decode and
/// its RGBA8 conversion (for bytes no format sniffs, `image`'s guess).
pub(crate) fn decode_rgba8(bytes: &[u8]) -> Result<Rgba8> {
    let img = match crate::sniff(bytes) {
        Some(format) if image_format(format).is_some() => load(bytes, format)?,
        _ => image::load_from_memory(bytes).map_err(|e| malformed(Format::Png, e))?,
    };
    let rgba = img.to_rgba8();
    Ok(Rgba8 {
        width: rgba.width(),
        height: rgba.height(),
        data: rgba.into_raw(),
    })
}
