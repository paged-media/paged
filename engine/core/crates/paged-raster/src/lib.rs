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

//! Raster images for the engine: probe, decode, convert and encode.
//!
//! One crate owns what a placed picture's bytes mean, so the renderer's
//! build-time decode, paged-gpu's raster-time decode (the wasm32 lazy
//! path) and later the PDF export and the image module read a file the
//! same way.
//!
//! - [`probe`] reads the header only: size, sample layout, colour model,
//!   alpha, embedded metadata (ICC, XMP, IPTC, Photoshop resources),
//!   resolution, orientation and page count. [`RasterInfo`].
//! - [`decode`] returns the samples in the file's own colour model and
//!   depth ([`RasterImage`]); [`to_rgba8`] turns them into straight-alpha
//!   sRGB bytes, converting CMYK and Lab through a [`ColourConvert`].
//! - [`decode_rgba8`] (and [`decode_rgba8_with`], which takes the colour
//!   conversion) is the one call the render paths make.
//! - [`encode`] writes PNG, JPEG, WebP (lossless) and TIFF with the ICC
//!   profile, EXIF, XMP, IPTC and resolution of an [`EncodeOptions`];
//!   [`encode_tiff`] is the TIFF half (Gray, RGB and CMYK at 8 or 16 bits,
//!   with or without alpha, uncompressed, LZW or Deflate).
//! - [`read_metadata`] collects a file's ICC, EXIF, XMP, IPTC and
//!   Photoshop resources, so an edit can write them back.
//! - [`resize`] and [`rgb_to_cmyk`] prepare pixels for an export at
//!   another scale or in print colour.
//!
//! ## Formats
//!
//! TIFF (classic and BigTIFF) decodes through the `tiff` crate: strips and
//! tiles, chunky and planar layouts, 1/2/4/8/16/32/64-bit integer and
//! 16/32/64-bit float samples, Gray (BlackIsZero and WhiteIsZero), RGB,
//! CMYK, YCbCr, ICC Lab and CIE Lab, palette, associated and unassociated
//! alpha, every IFD of a multi-page file, and the compressions `tiff`
//! implements (none, LZW, Deflate, PackBits, JPEG, CCITT Group 4). A file
//! outside that set fails with an [`Error`] that names what is missing
//! (`compression OJPEG`, `photometric 32844`, ...).
//!
//! `tiff` refuses palette and Lab images although their samples are
//! ordinary integers. The decoder reads them by handing `tiff` a copy of
//! the file whose PhotometricInterpretation entry says gray (palette) or
//! RGB (Lab) and doing the last step itself: the ColorMap lookup, or the
//! L*a*b* scaling (a* and b* offset for ICC Lab, signed for CIE Lab).
//!
//! PNG, JPEG, WebP, GIF and BMP decode through `image`, exactly as the
//! renderer did before this crate existed: [`decode_rgba8`] on one of them
//! is `image::load_from_memory(..).to_rgba8()`, byte for byte. [`decode`]
//! reads a JPEG through zune-jpeg itself (the decoder `image` uses), so a
//! CMYK or YCCK JPEG keeps its inks (Adobe APP14 inversion undone) and
//! converts through its profile like a CMYK TIFF; [`jpeg_header`] is the
//! frame header and APP14 read a JPEG pass-through needs.
//!
//! PSD and PSB (`8BPS`) read through `paged-psd`: [`probe`] from its
//! summary (header, resources, layer records; no pixel copied), [`decode`]
//! from the merged composite, the image Photoshop stores beside the
//! layers ("maximize compatibility"). RGB, Grayscale and CMYK at 8 and 16
//! bits (16 reduced to 8, the composite decoder's rule), RAW and RLE, with
//! the composite's transparency when the document has it. CMYK converts
//! like a CMYK TIFF, through the file's own profile (resource 1039). The
//! layers themselves are the image module's; [`RasterInfo::layer_count`]
//! says how many there are.
//!
//! An EPS (a DOS EPS binary file, or PostScript text) is read for its
//! preview: the DOS file's TIFF through the TIFF reader, or an EPSI
//! `%%BeginPreview` bitmap (1/2/4/8-bit gray); [`eps_bounding_box`] gives
//! the area the artwork covers, in points. A metafile-only or preview-less
//! EPS is refused by name (there is no PostScript interpreter).
//!
//! A DNG (a TIFF with DNGVersion) is developed with a good default: its
//! raw IFD (CFA or LinearRaw; uncompressed or lossless JPEG), black and
//! white levels, a bilinear demosaic, AsShotNeutral white balance, the
//! ColorMatrix to linear sRGB and the sRGB curve, as 16-bit RGB. See the
//! `dng` module for what is not applied.
//!
//! AVIF (feature `avif`: `avif-parse` and rav1d) and JPEG XL (feature
//! `jxl`: `jxl-oxide`) decode in pure Rust on native and wasm32; TGA,
//! QOI, ICO, Radiance HDR and OpenEXR (feature `exr`) through `image`.
//! The scene-linear floats of HDR and EXR are clipped and sRGB-encoded by
//! [`to_rgba8`]. A build without a feature sniffs the format and refuses
//! it, naming the feature.
//!
//! ## Colour
//!
//! [`to_rgba8`] takes the conversion as a [`ColourConvert`] so a caller
//! with its own colour settings (a document's intent, a proofing setup,
//! the image module's CMS) supplies it. The crate depends on `paged-color`
//! all the same and ships [`PagedColour`], the conversion the render paths
//! use: paged-color is the engine's one CMS, it is wasm-safe (lcms2 on
//! native, moxcms on wasm32) and it is already in every tree that renders,
//! so the dependency costs nothing and lets native and wasm call one
//! function. A [`PagedColour`] carries a [`Rendering`] (the intent and
//! black-point compensation; the renderer passes the frame's), and
//! [`decode_rgba8_with`] takes one. Without a usable profile CMYK falls
//! back to the naive conversion `image` applies to TIFF, so a profile-less
//! CMYK TIFF renders as it did before.
//!
//! ## Not here yet
//!
//! Orientation is reported, not applied (the renderer never applied it).
//! Region decode, lossy WebP encoding, and gray or RGB ICC conversion
//! follow in later work. A layered TIFF
//! (tag 37724) decodes its flattened image; its layer records are read
//! through `paged-psd` for [`RasterInfo::layer_count`] only.

#![forbid(unsafe_code)]

mod avif;
mod convert;
mod dng;
mod encode;
mod eps;
pub mod exif;
mod icc;
mod jpeg;
mod jxl;
mod lj92;
mod meta;
mod other;
mod psd;
mod shrink;
mod tif;

pub use eps::bounding_box as eps_bounding_box;

pub use convert::{to_rgba8, ColourConvert, NaiveColour, PagedColour};
pub use encode::{encode, resize, rgb_to_cmyk, srgb_icc, EncodeFormat, EncodeOptions, WEBP_LOSSY};
pub use icc::extract_icc;
pub use jpeg::{jpeg_header, JpegHeader};
pub use meta::{extract_icc_any, read_metadata, Metadata};
/// The rendering intent of [`rgb_to_cmyk`] and of a placed raster's
/// conversion, with its black-point compensation ([`Rendering`]).
pub use paged_color::cms::{Intent, Rendering};
pub use paged_sniff::{sniff, Format};
pub use shrink::shrunk_dimensions;
pub use tif::encode::{encode_tiff, encode_tiff_pages, TiffCompression, TiffEncodeOptions};

/// Everything a header tells about one page of a raster file.
#[derive(Clone, Debug, PartialEq)]
pub struct RasterInfo {
    /// The container the bytes are in.
    pub format: Format,
    /// Pixel width.
    pub width: u32,
    /// Pixel height.
    pub height: u32,
    /// Samples per pixel in the file, colour and extra samples together.
    pub channels: u16,
    /// Bits of each sample in the file.
    pub bits_per_sample: u16,
    /// How each sample is stored in the file.
    pub sample_format: SampleFormat,
    /// The file's colour model (a palette image says `Palette` here even
    /// though [`decode`] expands it to RGB).
    pub color_model: ColorModel,
    /// What the alpha channel, if any, means.
    pub alpha: Alpha,
    /// The embedded ICC profile.
    pub icc: Option<Vec<u8>>,
    /// The embedded XMP packet.
    pub xmp: Option<Vec<u8>>,
    /// The embedded IPTC-NAA record (TIFF tag 33723).
    pub iptc: Option<Vec<u8>>,
    /// The embedded EXIF payload from its TIFF header on (JPEG APP1, PNG
    /// `eXIf`, WebP `EXIF`). A TIFF's own EXIF IFD is not collected.
    pub exif: Option<Vec<u8>>,
    /// The embedded Photoshop image resource blocks (TIFF tag 34377).
    pub photoshop_irb: Option<Vec<u8>>,
    /// Photoshop's layer data is present: a PSD/PSB with layer records, or
    /// a TIFF with tag 37724 (ImageSourceData).
    pub has_layers: bool,
    /// The layer records Photoshop stores (group open and close markers
    /// included), read through `paged-psd`: `Some(0)` for a file without
    /// layers, `None` when a TIFF's layer data is present but not readable
    /// (a little-endian payload, or a damaged one). Always `Some(0)` for
    /// the formats that have no layers.
    pub layer_count: Option<usize>,
    /// Pixels per inch, horizontal and vertical, when the file states a
    /// resolution in inches or centimetres.
    pub resolution: Option<(f64, f64)>,
    /// The TIFF/EXIF orientation, 1 to 8 (1 when the file names none).
    pub orientation: u16,
    /// Images in the file (TIFF IFDs; 1 for the other formats).
    pub page_count: usize,
}

/// How samples are stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleFormat {
    /// Unsigned integers.
    UInt,
    /// Signed integers.
    Int,
    /// IEEE floating point.
    Float,
}

/// A colour model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorModel {
    Gray,
    Rgb,
    Cmyk,
    /// CIE L*a*b* (D50).
    Lab,
    /// Indices into a colour map.
    Palette,
    YCbCr,
}

impl ColorModel {
    /// Colour channels, alpha not counted.
    pub fn colour_channels(self) -> usize {
        match self {
            ColorModel::Gray | ColorModel::Palette => 1,
            ColorModel::Rgb | ColorModel::Lab | ColorModel::YCbCr => 3,
            ColorModel::Cmyk => 4,
        }
    }
}

/// What an image's alpha channel means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alpha {
    /// No alpha channel.
    None,
    /// Colour is premultiplied by alpha (TIFF ExtraSamples 1).
    Associated,
    /// Colour is independent of alpha (TIFF ExtraSamples 2, PNG, WebP).
    Unassociated,
}

/// Decoded samples, interleaved, row by row from the top.
#[derive(Clone, Debug, PartialEq)]
pub enum Samples {
    U8(Vec<u8>),
    U16(Vec<u16>),
    /// Floats: 0..=1 for Gray, RGB, CMYK and alpha; L* 0..=100 and a*, b*
    /// as signed values for Lab.
    F32(Vec<f32>),
}

impl Samples {
    /// The number of samples.
    pub fn len(&self) -> usize {
        match self {
            Samples::U8(v) => v.len(),
            Samples::U16(v) => v.len(),
            Samples::F32(v) => v.len(),
        }
    }

    /// No samples.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Sample `i` as a fraction of full scale (0..=1 for integers).
    pub(crate) fn unit(&self, i: usize) -> f32 {
        match self {
            Samples::U8(v) => f32::from(v[i]) / 255.0,
            Samples::U16(v) => f32::from(v[i]) / 65535.0,
            Samples::F32(v) => v[i],
        }
    }
}

/// A decoded raster in its own colour model.
#[derive(Clone, Debug, PartialEq)]
pub struct RasterImage {
    /// The page's header facts. `width` and `height` are the file's.
    pub info: RasterInfo,
    /// Width of `data` (smaller than `info.width` after a `max_dim` shrink).
    pub width: u32,
    /// Height of `data`.
    pub height: u32,
    /// The colour model of `data`: the file's, except that palette and
    /// YCbCr arrive as RGB.
    pub model: ColorModel,
    /// What `data`'s alpha channel, if any, means.
    pub alpha: Alpha,
    /// The samples: `model.colour_channels()` per pixel, plus one when
    /// `alpha` is not `None`. Extra samples that are not alpha are dropped.
    pub data: Samples,
}

impl RasterImage {
    /// Samples per pixel in `data`.
    pub fn channels(&self) -> usize {
        self.model.colour_channels() + usize::from(self.alpha != Alpha::None)
    }
}

/// Straight-alpha sRGB bytes, 4 per pixel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rgba8 {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// What [`decode`] reads and how large it may return it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecodeOptions {
    /// The page (TIFF IFD) to decode, from 0.
    pub page: usize,
    /// When set, an image whose longer edge exceeds it is box-shrunk by
    /// the smallest whole factor that brings it within (see
    /// [`shrunk_dimensions`]). Honoured by the TIFF and PSD decoders; the
    /// formats read through `image` decode at full size.
    pub max_dim: Option<u32>,
}

/// Why a raster could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The bytes are not a raster format this crate recognises.
    #[error("not a recognised raster format")]
    UnknownFormat,
    /// A recognised file uses something this crate does not read (yet).
    #[error("{format:?}: {what} is not supported")]
    Unsupported { format: Format, what: String },
    /// The file asks for a page it does not have.
    #[error("page {page} requested, the file has {count}")]
    PageOutOfRange { page: usize, count: usize },
    /// The file is damaged or inconsistent.
    #[error("{format:?}: {detail}")]
    Malformed { format: Format, detail: String },
    /// An encode was asked for something it cannot write.
    #[error("cannot encode: {0}")]
    Encode(String),
}

/// `Result` with this crate's [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

/// Read one page's header facts without decoding pixels (page 0; see
/// [`probe_page`]).
pub fn probe(bytes: &[u8]) -> Result<RasterInfo> {
    probe_page(bytes, 0)
}

/// [`probe`] for a given page (TIFF IFD).
pub fn probe_page(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    match sniff(bytes) {
        Some(Format::Tiff) => tif::probe(bytes, page),
        Some(Format::Psd) => psd::probe(bytes, page),
        Some(Format::Eps) => eps::probe(bytes, page),
        Some(Format::Dng) => dng::probe(bytes, page),
        Some(Format::Avif) => avif::probe(bytes, page),
        Some(Format::Jxl) => jxl::probe(bytes, page),
        Some(Format::Jpeg) => jpeg::probe(bytes, page),
        Some(format) => other::probe(bytes, format, page),
        None => Err(Error::UnknownFormat),
    }
}

/// Decode a page into its own colour model.
pub fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    match sniff(bytes) {
        Some(Format::Tiff) => tif::decode(bytes, opts),
        Some(Format::Psd) => psd::decode(bytes, opts),
        Some(Format::Eps) => eps::decode(bytes, opts),
        Some(Format::Dng) => dng::decode(bytes, opts),
        Some(Format::Avif) => avif::decode(bytes, opts),
        Some(Format::Jxl) => jxl::decode(bytes, opts),
        Some(Format::Jpeg) => jpeg::decode(bytes, opts),
        Some(format) => other::decode(bytes, format, opts),
        None => Err(Error::UnknownFormat),
    }
}

/// A decoded image box-shrunk to `max_dim`, for the decoders that read
/// at full size first.
pub(crate) fn shrink_image(img: RasterImage, max_dim: Option<u32>) -> RasterImage {
    let k = shrink::factor(img.width, img.height, max_dim);
    if k <= 1 {
        return img;
    }
    let channels = img.channels();
    let (data, width, height) = shrink::shrink(img.data, img.width, img.height, channels, k);
    RasterImage {
        width,
        height,
        data,
        ..img
    }
}

/// Decode page 0 to straight-alpha sRGB bytes, converting colour with a
/// default [`PagedColour`] (relative colorimetric with BPC): the call the
/// render paths make, so native and wasm decode a picture the same way.
/// [`decode_rgba8_with`] takes the conversion.
pub fn decode_rgba8(bytes: &[u8], max_dim: Option<u32>) -> Result<Rgba8> {
    decode_rgba8_with(bytes, max_dim, &PagedColour::default())
}

/// [`decode_rgba8`] with the colour conversion given: a placed raster's
/// frame passes its rendering intent this way.
///
/// A TIFF decodes through this crate (shrunk to `max_dim` when given);
/// one it cannot read is handed to `image`, the decoder TIFFs used before.
/// A PSD/PSB decodes its merged composite, an EPS its preview, and DNG,
/// AVIF, JPEG XL, HDR and EXR through this crate (shrunk to `max_dim`).
/// Every other format is `image::load_from_memory(bytes)?.to_rgba8()`,
/// unchanged, at full size.
pub fn decode_rgba8_with(
    bytes: &[u8],
    max_dim: Option<u32>,
    conv: &dyn ColourConvert,
) -> Result<Rgba8> {
    match sniff(bytes) {
        Some(Format::Tiff) => tif::decode(bytes, DecodeOptions { page: 0, max_dim })
            .and_then(|img| to_rgba8(&img, conv))
            .or_else(|err| {
                tracing::warn!(error = %err, "TIFF decode failed; trying the image crate");
                other::decode_rgba8(bytes).map_err(|_| err)
            }),
        Some(
            Format::Psd
            | Format::Eps
            | Format::Dng
            | Format::Avif
            | Format::Jxl
            | Format::Hdr
            | Format::Exr,
        ) => decode(bytes, DecodeOptions { page: 0, max_dim }).and_then(|img| to_rgba8(&img, conv)),
        _ => other::decode_rgba8(bytes),
    }
}

/// [`decode_rgba8`] at exactly `width` x `height`: decoded within the
/// larger of the two (so a TIFF or PSD shrinks while it decodes), then
/// resampled (triangle filter) when the result is another size. The call
/// paged-gpu's raster-time decode makes, on both of its lanes.
pub fn decode_rgba8_at(bytes: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    decode_rgba8_at_with(bytes, width, height, &PagedColour::default())
}

/// [`decode_rgba8_at`] with the colour conversion given (the frame's
/// rendering intent, recorded on the lazy image).
pub fn decode_rgba8_at_with(
    bytes: &[u8],
    width: u32,
    height: u32,
    conv: &dyn ColourConvert,
) -> Option<Vec<u8>> {
    let decoded = decode_rgba8_with(bytes, Some(width.max(height)), conv).ok()?;
    if decoded.width == width && decoded.height == height {
        return Some(decoded.data);
    }
    let img = image::RgbaImage::from_raw(decoded.width, decoded.height, decoded.data)?;
    let raw = image::imageops::resize(&img, width, height, image::imageops::FilterType::Triangle);
    Some(raw.into_raw())
}

/// The formats [`decode_rgba8`] reads through this crate's own decoders
/// (shrunk to `max_dim`, colour through [`PagedColour`]) rather than as
/// `image::load_from_memory(..).to_rgba8()`: everything except PNG, JPEG,
/// WebP, GIF, BMP, TGA, QOI and ICO.
pub fn reads_natively(format: Format) -> bool {
    !matches!(
        format,
        Format::Png
            | Format::Jpeg
            | Format::WebP
            | Format::Gif
            | Format::Bmp
            | Format::Tga
            | Format::Qoi
            | Format::Ico
    )
}

/// The bytes are a TIFF (classic or BigTIFF, either byte order).
pub fn is_tiff(bytes: &[u8]) -> bool {
    sniff(bytes) == Some(Format::Tiff)
}
