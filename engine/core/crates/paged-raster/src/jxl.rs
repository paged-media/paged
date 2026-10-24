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

//! JPEG XL through `jxl-oxide` (pure Rust, single-threaded here).
//!
//! The first keyframe renders with its orientation applied. An image
//! coded in XYB or with an enumerated colour encoding renders to sRGB
//! (jxl-oxide converts); one that stores an ICC profile renders in that
//! profile's space and carries the profile on, as a TIFF does. Gray and
//! RGB, with alpha (straight, or premultiplied when the header says so),
//! at 8 bits for an 8-bit image and 16 bits otherwise. CMYK images are
//! refused.

use crate::{DecodeOptions, Error, Format, RasterImage, RasterInfo, Result};

#[cfg(feature = "jxl")]
mod imp {
    use super::*;
    use crate::{Alpha, ColorModel, SampleFormat, Samples};
    use jxl_oxide::{EnumColourEncoding, JxlImage, PixelFormat, RenderingIntent};

    fn malformed(detail: impl std::fmt::Display) -> Error {
        Error::Malformed {
            format: Format::Jxl,
            detail: detail.to_string(),
        }
    }

    pub(super) struct Opened {
        image: JxlImage,
        info: RasterInfo,
    }

    pub(super) fn open(bytes: &[u8]) -> Result<Opened> {
        let mut image = JxlImage::builder().read(bytes).map_err(malformed)?;
        let icc = image.original_icc().map(<[u8]>::to_vec);
        if icc.is_none() {
            image.request_color_encoding(EnumColourEncoding::srgb(RenderingIntent::Relative));
        }
        let format = image.pixel_format();
        if format.has_black() {
            return Err(Error::Unsupported {
                format: Format::Jxl,
                what: "a CMYK JPEG XL".into(),
            });
        }
        let premultiplied = image
            .image_header()
            .metadata
            .ec_info
            .iter()
            .any(|ec| ec.is_alpha() && ec.alpha_associated() == Some(true));
        let alpha = match (format.has_alpha(), premultiplied) {
            (false, _) => Alpha::None,
            (true, true) => Alpha::Associated,
            (true, false) => Alpha::Unassociated,
        };
        let bits = image.image_header().metadata.bit_depth.bits_per_sample();
        // The rendered size: orientations 5 to 8 swap the edges.
        let (mut width, mut height) = (image.width(), image.height());
        if (5..=8).contains(&image.image_header().metadata.orientation) {
            std::mem::swap(&mut width, &mut height);
        }
        let info = RasterInfo {
            format: Format::Jxl,
            width,
            height,
            channels: format.channels() as u16,
            bits_per_sample: bits as u16,
            sample_format: SampleFormat::UInt,
            color_model: if format.is_grayscale() {
                ColorModel::Gray
            } else {
                ColorModel::Rgb
            },
            alpha,
            icc,
            xmp: None,
            iptc: None,
            photoshop_irb: None,
            has_layers: false,
            layer_count: Some(0),
            resolution: None,
            orientation: 1,
            page_count: 1,
        };
        Ok(Opened { image, info })
    }

    pub(super) fn probe(bytes: &[u8]) -> Result<RasterInfo> {
        Ok(open(bytes)?.info)
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<RasterImage> {
        let Opened { image, mut info } = open(bytes)?;
        let render = image.render_frame(0).map_err(malformed)?;
        let mut stream = render.stream();
        let (w, h, ch) = (stream.width(), stream.height(), stream.channels() as usize);
        let n = w as usize * h as usize * ch;
        let data = if info.bits_per_sample <= 8 {
            let mut buf = vec![0u8; n];
            stream.write_to_buffer(&mut buf);
            Samples::U8(buf)
        } else {
            let mut buf = vec![0u16; n];
            stream.write_to_buffer(&mut buf);
            Samples::U16(buf)
        };
        let format = image.pixel_format();
        if ch != format.channels() {
            return Err(malformed(format!("{ch} rendered channels for {format:?}")));
        }
        info.width = w;
        info.height = h;
        let model = if format == PixelFormat::Gray || format == PixelFormat::Graya {
            ColorModel::Gray
        } else {
            ColorModel::Rgb
        };
        Ok(RasterImage {
            alpha: info.alpha,
            info,
            width: w,
            height: h,
            model,
            data,
        })
    }
}

fn single_page(page: usize) -> Result<()> {
    if page == 0 {
        Ok(())
    } else {
        Err(Error::PageOutOfRange { page, count: 1 })
    }
}

#[cfg(feature = "jxl")]
pub(crate) fn probe(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    single_page(page)?;
    imp::probe(bytes)
}

#[cfg(feature = "jxl")]
pub(crate) fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    single_page(opts.page)?;
    Ok(crate::shrink_image(imp::decode(bytes)?, opts.max_dim))
}

#[cfg(not(feature = "jxl"))]
pub(crate) fn probe(_: &[u8], page: usize) -> Result<RasterInfo> {
    single_page(page)?;
    Err(missing())
}

#[cfg(not(feature = "jxl"))]
pub(crate) fn decode(_: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    single_page(opts.page)?;
    Err(missing())
}

#[cfg(not(feature = "jxl"))]
fn missing() -> Error {
    Error::Unsupported {
        format: Format::Jxl,
        what: "JPEG XL (this build has no JPEG XL decoder: the `jxl` feature is off)".into(),
    }
}
