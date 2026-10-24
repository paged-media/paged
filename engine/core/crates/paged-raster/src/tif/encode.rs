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

//! TIFF encode through the `tiff` crate.

use std::io::{Cursor, Seek, Write};

use ::tiff::encoder::colortype::{self, ColorType};
use ::tiff::encoder::{Compression, DeflateLevel, Rational, TiffEncoder, TiffValue};
use ::tiff::tags::{ExtraSamples, Predictor, ResolutionUnit, Tag, Type};
use ::tiff::Directory;

use crate::{Alpha, ColorModel, Error, RasterImage, Result, Samples};

/// How the strips are compressed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TiffCompression {
    #[default]
    None,
    Lzw,
    Deflate,
}

/// Options of [`encode_tiff`]. The image's own [`crate::RasterInfo`]
/// supplies the metadata written with it: `icc`, `xmp` and `resolution`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TiffEncodeOptions {
    pub compression: TiffCompression,
    /// Apply the horizontal differencing predictor (LZW and Deflate). Not
    /// applied to an image with alpha: `tiff` 0.11's encoder differences
    /// across the colour samples only and would write a pixel stride that
    /// misses the extra sample.
    pub predictor: bool,
    /// Rows per strip; `tiff` picks about 1 MB strips when `None`.
    pub rows_per_strip: Option<u32>,
}

/// Encode one image as a TIFF: Gray, RGB or CMYK at 8 or 16 bits, with
/// or without alpha (written as ExtraSamples, associated or not).
pub fn encode_tiff(img: &RasterImage, opts: TiffEncodeOptions) -> Result<Vec<u8>> {
    encode_tiff_pages(&[img], opts)
}

/// Encode several images as the pages of one TIFF.
pub fn encode_tiff_pages(pages: &[&RasterImage], opts: TiffEncodeOptions) -> Result<Vec<u8>> {
    if pages.is_empty() {
        return Err(Error::Encode("no pages".into()));
    }
    let mut out = Cursor::new(Vec::new());
    {
        let compression = match opts.compression {
            TiffCompression::None => Compression::Uncompressed,
            TiffCompression::Lzw => Compression::Lzw,
            TiffCompression::Deflate => Compression::Deflate(DeflateLevel::Balanced),
        };
        let mut enc = TiffEncoder::new(&mut out)
            .map_err(enc_err)?
            .with_compression(compression);
        for img in pages {
            let predict = opts.predictor
                && opts.compression != TiffCompression::None
                && img.alpha == Alpha::None;
            enc = enc.with_predictor(if predict {
                Predictor::Horizontal
            } else {
                Predictor::None
            });
            write_page(&mut enc, img, opts)?;
        }
    }
    Ok(out.into_inner())
}

fn enc_err(e: ::tiff::TiffError) -> Error {
    Error::Encode(e.to_string())
}

fn write_page<W: Write + Seek>(
    enc: &mut TiffEncoder<W>,
    img: &RasterImage,
    opts: TiffEncodeOptions,
) -> Result<()> {
    if img.data.len() != img.width as usize * img.height as usize * img.channels() {
        return Err(Error::Encode("sample count does not match the size".into()));
    }
    let extra = match img.alpha {
        Alpha::None => None,
        Alpha::Associated => Some(ExtraSamples::AssociatedAlpha),
        Alpha::Unassociated => Some(ExtraSamples::UnassociatedAlpha),
    };
    match (&img.data, img.model) {
        (Samples::U8(d), ColorModel::Gray) => page::<_, colortype::Gray8>(enc, img, d, extra, opts),
        (Samples::U16(d), ColorModel::Gray) => {
            page::<_, colortype::Gray16>(enc, img, d, extra, opts)
        }
        (Samples::U8(d), ColorModel::Rgb) => page::<_, colortype::RGB8>(enc, img, d, extra, opts),
        (Samples::U16(d), ColorModel::Rgb) => page::<_, colortype::RGB16>(enc, img, d, extra, opts),
        (Samples::U8(d), ColorModel::Cmyk) => page::<_, colortype::CMYK8>(enc, img, d, extra, opts),
        (Samples::U16(d), ColorModel::Cmyk) => {
            page::<_, colortype::CMYK16>(enc, img, d, extra, opts)
        }
        (data, model) => Err(Error::Encode(format!(
            "{model:?} with {} samples",
            match data {
                Samples::U8(_) => "8-bit",
                Samples::U16(_) => "16-bit",
                Samples::F32(_) => "float",
            }
        ))),
    }
}

fn page<W: Write + Seek, C: ColorType>(
    enc: &mut TiffEncoder<W>,
    img: &RasterImage,
    data: &[C::Inner],
    extra: Option<ExtraSamples>,
    opts: TiffEncodeOptions,
) -> Result<()>
where
    [C::Inner]: TiffValue,
{
    let mut image = enc.new_image::<C>(img.width, img.height).map_err(enc_err)?;
    if let Some(e) = extra {
        image.extra_samples(&[e]).map_err(enc_err)?;
    }
    if let Some(rows) = opts.rows_per_strip {
        image.rows_per_strip(rows.max(1)).map_err(enc_err)?;
    }
    if let Some((x, y)) = img.info.resolution {
        image.resolution_unit(ResolutionUnit::Inch);
        image.x_resolution(rational(x));
        image.y_resolution(rational(y));
    }
    let dir = image.encoder();
    let mut blobs = Directory::empty();
    for (tag, ty, bytes) in [
        (super::ICC, Type::UNDEFINED, img.info.icc.as_deref()),
        (super::XMP, Type::BYTE, img.info.xmp.as_deref()),
        (super::IPTC, Type::UNDEFINED, img.info.iptc.as_deref()),
        (
            super::PHOTOSHOP,
            Type::UNDEFINED,
            img.info.photoshop_irb.as_deref(),
        ),
    ] {
        if let Some(bytes) = bytes.filter(|b| !b.is_empty()) {
            let entry = dir.write_entry_bytes(ty, bytes).map_err(enc_err)?;
            blobs.extend([(Tag::from_u16_exhaustive(tag), entry)]);
        }
    }
    dir.extend_from(&blobs);
    image.write_data(data).map_err(enc_err)
}

/// Pixels per inch as a TIFF RATIONAL, to a thousandth.
fn rational(ppi: f64) -> Rational {
    let d = 1000u32;
    let n = (ppi.max(0.0) * f64::from(d))
        .round()
        .min(f64::from(u32::MAX)) as u32;
    Rational { n, d }
}
