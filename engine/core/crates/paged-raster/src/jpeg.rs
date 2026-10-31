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

//! JPEG through zune-jpeg (the decoder `image` uses too), so a CMYK or
//! YCCK JPEG keeps its inks instead of arriving as `image`'s RGB guess:
//! [`decode`] returns Gray, RGB or CMYK samples, and the CMYK ones convert
//! through the file's profile like a CMYK TIFF. [`jpeg_header`] is the
//! header read a JPEG pass-through needs (the PDF export).
//!
//! **The Adobe inversion.** Photoshop and InDesign write CMYK and YCCK
//! JPEGs with an APP14 `Adobe` segment and store inverted inks (`255 -
//! ink`). The decoder re-inverts exactly when APP14 is present; YCCK is
//! first taken to inverted CMY with the JFIF YCbCr matrix. A 4-component
//! JPEG without APP14 is read as plain CMYK.

use zune_core::bytestream::ZCursor;
use zune_core::colorspace::ColorSpace;
use zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

use crate::meta::jpeg_segments;
use crate::{
    Alpha, ColorModel, DecodeOptions, Error, Format, RasterImage, RasterInfo, Result, SampleFormat,
    Samples,
};

/// What a JPEG's markers say before the scan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JpegHeader {
    pub width: u32,
    pub height: u32,
    /// Components in the frame: 1 gray, 3 YCbCr or RGB, 4 CMYK or YCCK.
    pub components: u8,
    /// The APP14 `Adobe` segment's colour transform (0 none/CMYK,
    /// 1 YCbCr, 2 YCCK) when the segment is present.
    pub adobe_transform: Option<u8>,
    /// Bits per sample (8, or 12 for an extended-precision file).
    pub precision: u8,
}

/// Read a JPEG's frame header and APP14 segment. `None` when the bytes
/// are not a JPEG or carry no frame header before the scan.
pub fn jpeg_header(bytes: &[u8]) -> Option<JpegHeader> {
    let mut adobe = None;
    let mut frame = None;
    for seg in jpeg_segments(bytes) {
        let p = seg.payload;
        match seg.marker {
            0xEE if p.starts_with(b"Adobe") && p.len() >= 12 => adobe = Some(p[11]),
            // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
            0xC0..=0xCF if !matches!(seg.marker, 0xC4 | 0xC8 | 0xCC) && p.len() >= 6 => {
                frame.get_or_insert(JpegHeader {
                    precision: p[0],
                    height: u32::from(u16::from_be_bytes([p[1], p[2]])),
                    width: u32::from(u16::from_be_bytes([p[3], p[4]])),
                    components: p[5],
                    adobe_transform: None,
                });
            }
            _ => {}
        }
    }
    frame.map(|f| JpegHeader {
        adobe_transform: adobe,
        ..f
    })
}

fn malformed(detail: impl std::fmt::Display) -> Error {
    Error::Malformed {
        format: Format::Jpeg,
        detail: detail.to_string(),
    }
}

pub(crate) fn probe(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    if page != 0 {
        return Err(Error::PageOutOfRange { page, count: 1 });
    }
    let header = jpeg_header(bytes).ok_or_else(|| malformed("no frame header"))?;
    if header.width == 0 || header.height == 0 {
        return Err(malformed("zero image dimension"));
    }
    let meta = crate::meta::read_metadata(bytes);
    let orientation = meta
        .exif
        .as_deref()
        .and_then(|e| crate::exif::Exif::parse(e).orientation)
        .map_or(1, crate::exif::Orientation::tag);
    let color_model = match header.components {
        1 => ColorModel::Gray,
        // JFIF's 3 components are YCbCr; Adobe transform 0 says RGB.
        3 if header.adobe_transform == Some(0) => ColorModel::Rgb,
        3 => ColorModel::YCbCr,
        4 => ColorModel::Cmyk,
        n => {
            return Err(Error::Unsupported {
                format: Format::Jpeg,
                what: format!("{n} components"),
            })
        }
    };
    Ok(RasterInfo {
        format: Format::Jpeg,
        width: header.width,
        height: header.height,
        channels: u16::from(header.components),
        bits_per_sample: u16::from(header.precision),
        sample_format: SampleFormat::UInt,
        color_model,
        alpha: Alpha::None,
        resolution: crate::meta::jpeg_ppi(bytes, meta.exif.as_deref()),
        icc: meta.icc,
        xmp: meta.xmp,
        iptc: meta.iptc,
        exif: meta.exif,
        photoshop_irb: meta.photoshop_irb,
        has_layers: false,
        layer_count: Some(0),
        orientation,
        page_count: 1,
    })
}

pub(crate) fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    let info = probe(bytes, opts.page)?;
    let adobe = jpeg_header(bytes).and_then(|h| h.adobe_transform);
    let mut headers = JpegDecoder::new(ZCursor::new(bytes));
    headers.decode_headers().map_err(malformed)?;
    let input = headers
        .input_colorspace()
        .ok_or_else(|| malformed("no colour space after the headers"))?;
    let (out_cs, model) = match input {
        ColorSpace::Luma => (ColorSpace::Luma, ColorModel::Gray),
        ColorSpace::YCbCr | ColorSpace::RGB => (ColorSpace::RGB, ColorModel::Rgb),
        ColorSpace::CMYK => (ColorSpace::CMYK, ColorModel::Cmyk),
        ColorSpace::YCCK => (ColorSpace::YCCK, ColorModel::Cmyk),
        other => {
            return Err(Error::Unsupported {
                format: Format::Jpeg,
                what: format!("colour space {other:?}"),
            })
        }
    };
    let options = DecoderOptions::default()
        .jpeg_set_out_colorspace(out_cs)
        .set_max_width(1 << 16)
        .set_max_height(1 << 16);
    let mut dec = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    let mut data = dec.decode().map_err(malformed)?;
    let (width, height) = (info.width, info.height);
    let expect = width as usize * height as usize * model.colour_channels();
    if data.len() != expect {
        return Err(malformed(format!(
            "decoded {} samples, expected {expect}",
            data.len()
        )));
    }
    match input {
        ColorSpace::YCCK => {
            for px in data.as_chunks_mut::<4>().0 {
                let (r, g, b) = ycbcr_to_rgb(px[0], px[1], px[2]);
                // r, g, b are the stored (inverted) C, M, Y.
                *px = if adobe.is_some() {
                    [255 - r, 255 - g, 255 - b, 255 - px[3]]
                } else {
                    [r, g, b, px[3]]
                };
            }
        }
        ColorSpace::CMYK if adobe.is_some() => {
            for v in &mut data {
                *v = 255 - *v;
            }
        }
        _ => {}
    }
    let img = RasterImage {
        info,
        width,
        height,
        model,
        alpha: Alpha::None,
        data: Samples::U8(data),
    };
    Ok(crate::shrink_image(img, opts.max_dim))
}

/// Full-range JFIF (ITU-T T.871) YCbCr to RGB.
fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8) -> (u8, u8, u8) {
    let y = f32::from(y);
    let cb = f32::from(cb) - 128.0;
    let cr = f32::from(cr) - 128.0;
    let c = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    (
        c(y + 1.402 * cr),
        c(y - 0.344_136 * cb - 0.714_136 * cr),
        c(y + 1.772 * cb),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SOI, an optional APP14, a SOF0 with `components`, EOI.
    fn markers(adobe: Option<u8>, components: u8) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8];
        if let Some(t) = adobe {
            b.extend_from_slice(&[0xFF, 0xEE, 0, 14]);
            b.extend_from_slice(b"Adobe");
            b.extend_from_slice(&[0, 100, 0, 0, 0, 0, t]);
        }
        let len = 8 + 3 * u16::from(components);
        b.extend_from_slice(&[0xFF, 0xC0]);
        b.extend_from_slice(&len.to_be_bytes());
        b.extend_from_slice(&[8, 0, 2, 0, 3, components]);
        for i in 0..components {
            b.extend_from_slice(&[i + 1, 0x11, 0]);
        }
        b.extend_from_slice(&[0xFF, 0xD9]);
        b
    }

    #[test]
    fn the_header_names_components_size_and_the_adobe_transform() {
        let h = jpeg_header(&markers(Some(2), 4)).unwrap();
        assert_eq!(
            h,
            JpegHeader {
                width: 3,
                height: 2,
                components: 4,
                adobe_transform: Some(2),
                precision: 8,
            }
        );
        assert_eq!(
            jpeg_header(&markers(None, 3)).unwrap().adobe_transform,
            None
        );
        assert_eq!(jpeg_header(b"\x89PNG"), None);
    }

    #[test]
    fn ycbcr_matrix_is_full_range() {
        assert_eq!(ycbcr_to_rgb(255, 128, 128), (255, 255, 255));
        assert_eq!(ycbcr_to_rgb(0, 128, 128), (0, 0, 0));
        assert_eq!(ycbcr_to_rgb(76, 85, 255), (254, 0, 0));
    }
}
