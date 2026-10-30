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
    encode_pages(pages, opts, None)
}

/// Encode `img` as a layered TIFF: `img` is the flattened image every
/// TIFF reader shows, and `image_source_data` (tag 37724) the layers
/// Photoshop reopens, as [`paged_psd::image_source_data`] writes them.
/// The payload must start with its signature.
///
/// The file is big-endian (`MM`): Photoshop writes ImageSourceData in the
/// TIFF's byte order, and `paged-psd` writes (and reads) the big-endian
/// form. `tiff`'s encoder writes the machine's order, so the file is
/// turned big-endian after it is written; the samples are 8-bit, whose
/// strips are the same bytes in either order, so only the header and the
/// directory change. A 16-bit or float image is refused.
pub fn encode_layered_tiff(
    img: &RasterImage,
    image_source_data: &[u8],
    opts: TiffEncodeOptions,
) -> Result<Vec<u8>> {
    if !image_source_data.starts_with(paged_psd::IMAGE_SOURCE_DATA_SIGNATURE) {
        return Err(Error::Encode(
            "ImageSourceData must start with `Adobe Photoshop Document Data Block`".into(),
        ));
    }
    if !matches!(img.data, Samples::U8(_)) {
        return Err(Error::Encode(
            "a layered TIFF is written with 8-bit samples (Photoshop's layer data is \
             read in the TIFF's byte order)"
                .into(),
        ));
    }
    let mut bytes = encode_pages(&[img], opts, Some(image_source_data))?;
    to_big_endian(&mut bytes)?;
    Ok(bytes)
}

/// Turn a little-endian classic TIFF big-endian in place: the header,
/// every directory entry and the values entries point at, by their
/// type's element size. Strip data is left alone (correct for 8-bit
/// samples only). A file already big-endian is left as it is.
fn to_big_endian(b: &mut [u8]) -> Result<()> {
    let bad = |what: &str| Error::Encode(format!("byte-order rewrite: {what}"));
    if b.starts_with(b"MM") {
        return Ok(());
    }
    if !b.starts_with(b"II\x2a\0") {
        return Err(bad("not a little-endian classic TIFF"));
    }
    let rd16 = |b: &[u8], at: usize| u16::from_le_bytes([b[at], b[at + 1]]);
    let rd32 = |b: &[u8], at: usize| u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]);
    let swap = |b: &mut [u8], at: usize, n: usize| b[at..at + n].reverse();
    let mut ifd = rd32(b, 4) as usize;
    b[0..2].copy_from_slice(b"MM");
    swap(b, 2, 2);
    swap(b, 4, 4);
    let mut seen = 0;
    while ifd != 0 {
        seen += 1;
        if seen > 1024 || ifd + 2 > b.len() {
            return Err(bad("directory chain out of range"));
        }
        let count = rd16(b, ifd) as usize;
        swap(b, ifd, 2);
        let end = ifd + 2 + count * 12;
        if end + 4 > b.len() {
            return Err(bad("directory out of range"));
        }
        for e in 0..count {
            let at = ifd + 2 + e * 12;
            let ty = rd16(b, at + 2);
            let n = rd32(b, at + 4) as usize;
            // The element size, and how many swaps of it one value takes.
            let (size, per) = match ty {
                1 | 2 | 6 | 7 => (1, 1),   // BYTE, ASCII, SBYTE, UNDEFINED
                3 | 8 => (2, 1),           // SHORT, SSHORT
                4 | 9 | 11 | 13 => (4, 1), // LONG, SLONG, FLOAT, IFD
                5 | 10 => (4, 2),          // RATIONAL, SRATIONAL
                12 => (8, 1),              // DOUBLE
                _ => return Err(bad(&format!("type {ty}"))),
            };
            swap(b, at, 2);
            swap(b, at + 2, 2);
            swap(b, at + 4, 4);
            let len = n * size * per;
            let (data, inline) = if len <= 4 {
                (at + 8, true)
            } else {
                (rd32(b, at + 8) as usize, false)
            };
            if !inline {
                swap(b, at + 8, 4);
            }
            if data + len > b.len() {
                return Err(bad("value out of range"));
            }
            if size > 1 {
                for k in 0..n * per {
                    swap(b, data + k * size, size);
                }
            }
        }
        let next = rd32(b, end) as usize;
        swap(b, end, 4);
        ifd = next;
    }
    Ok(())
}

/// A PSD as a layered TIFF: its merged composite as the TIFF's image, its
/// layers as ImageSourceData (tag 37724), its image resources as the
/// Photoshop tag (34377), and its profile, XMP, IPTC and resolution in
/// their TIFF tags. 8-bit RGB, Grayscale and CMYK documents with layers;
/// a PSB, a 16- or 32-bit document (the composite reads at 8 bits, the
/// layers would not match it) and a document without layers are refused
/// by name.
pub fn psd_to_layered_tiff(psd: &[u8], opts: TiffEncodeOptions) -> Result<Vec<u8>> {
    let file = paged_psd::PsdFile::parse(psd).map_err(|e| Error::Malformed {
        format: crate::Format::Psd,
        detail: e.to_string(),
    })?;
    let unsupported = |what: String| Error::Unsupported {
        format: crate::Format::Psd,
        what,
    };
    if file.header.depth != 8 {
        return Err(unsupported(format!(
            "a {}-bit document as a layered TIFF (8-bit documents are written)",
            file.header.depth
        )));
    }
    let source_data = paged_psd::image_source_data(&file).map_err(|e| match e {
        paged_psd::PsdError::Unsupported(what) => unsupported(what),
        other => Error::Malformed {
            format: crate::Format::Psd,
            detail: other.to_string(),
        },
    })?;
    let mut img = crate::decode(psd, crate::DecodeOptions::default())?;
    img.info.photoshop_irb = Some(paged_psd::image_resource_blocks(&file));
    encode_layered_tiff(&img, &source_data, opts)
}

fn encode_pages(
    pages: &[&RasterImage],
    opts: TiffEncodeOptions,
    image_source_data: Option<&[u8]>,
) -> Result<Vec<u8>> {
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
            write_page(&mut enc, img, opts, image_source_data)?;
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
    layers: Option<&[u8]>,
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
        (Samples::U8(d), ColorModel::Gray) => {
            page::<_, colortype::Gray8>(enc, img, d, extra, opts, layers)
        }
        (Samples::U16(d), ColorModel::Gray) => {
            page::<_, colortype::Gray16>(enc, img, d, extra, opts, layers)
        }
        (Samples::U8(d), ColorModel::Rgb) => {
            page::<_, colortype::RGB8>(enc, img, d, extra, opts, layers)
        }
        (Samples::U16(d), ColorModel::Rgb) => {
            page::<_, colortype::RGB16>(enc, img, d, extra, opts, layers)
        }
        (Samples::U8(d), ColorModel::Cmyk) => {
            page::<_, colortype::CMYK8>(enc, img, d, extra, opts, layers)
        }
        (Samples::U16(d), ColorModel::Cmyk) => {
            page::<_, colortype::CMYK16>(enc, img, d, extra, opts, layers)
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
    layers: Option<&[u8]>,
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
        (super::IMAGE_SOURCE_DATA, Type::UNDEFINED, layers),
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
