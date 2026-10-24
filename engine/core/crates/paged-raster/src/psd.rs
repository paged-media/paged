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

//! PSD and PSB through `paged-psd`: the probe reads its summary (no pixel
//! copied), the decode its merged composite.
//!
//! The composite is the one paged.image opens a flat PSD with
//! (`image-js`'s ingest): RGB and Grayscale through
//! `PsdFile::composite_rgba8`, CMYK through `PsdFile::composite_cmyk8`
//! (straight ink, un-matted), 8 and 16 bits (16 reduced to the high
//! byte), RAW and RLE. The CMYK ink converts in [`crate::to_rgba8`] with
//! the file's own profile (resource 1039) through the caller's
//! [`crate::ColourConvert`]; without one, the device formula.

use paged_psd::model::{ColorMode, ImageResourceBlock, ImageResources};
use paged_psd::{PsdError, PsdFile};

use crate::shrink;
use crate::{
    Alpha, ColorModel, DecodeOptions, Error, Format, RasterImage, RasterInfo, Result, SampleFormat,
    Samples,
};

/// Image resource ids read into [`RasterInfo`].
const RES_IPTC: u16 = 1028;
const RES_XMP: u16 = 1060;

fn error(err: PsdError) -> Error {
    match err {
        PsdError::Unsupported(what) => Error::Unsupported {
            format: Format::Psd,
            what,
        },
        other => Error::Malformed {
            format: Format::Psd,
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

pub(crate) fn probe(bytes: &[u8], page: usize) -> Result<RasterInfo> {
    single_page(page)?;
    let s = paged_psd::summary(bytes).map_err(error)?;
    info(
        &s.header,
        &s.resources,
        s.layers.layers.len(),
        s.layers.transparency_in_merged,
    )
}

fn info(
    header: &paged_psd::model::FileHeader,
    resources: &ImageResources,
    layer_count: usize,
    transparency: bool,
) -> Result<RasterInfo> {
    let color_model = match header.color_mode {
        ColorMode::Rgb => ColorModel::Rgb,
        // Bitmap is 1-bit gray; a duotone stores its gray plane.
        ColorMode::Grayscale | ColorMode::Bitmap | ColorMode::Duotone => ColorModel::Gray,
        ColorMode::Cmyk => ColorModel::Cmyk,
        ColorMode::Lab => ColorModel::Lab,
        ColorMode::Indexed => ColorModel::Palette,
        ColorMode::Multichannel => {
            return Err(Error::Unsupported {
                format: Format::Psd,
                what: "the multichannel colour mode".into(),
            })
        }
    };
    let photoshop_irb = (!resources.blocks.is_empty()).then(|| {
        resources
            .blocks
            .iter()
            .filter_map(|b| b.raw_block.as_deref())
            .flatten()
            .copied()
            .collect()
    });
    Ok(RasterInfo {
        format: Format::Psd,
        width: header.width,
        height: header.height,
        channels: header.channels,
        bits_per_sample: header.depth,
        sample_format: if header.depth == 32 {
            SampleFormat::Float
        } else {
            SampleFormat::UInt
        },
        color_model,
        // The decode un-mattes the composite: straight colour.
        alpha: if transparency {
            Alpha::Unassociated
        } else {
            Alpha::None
        },
        icc: resources.icc_profile().map(<[u8]>::to_vec),
        xmp: resource(resources, RES_XMP),
        iptc: resource(resources, RES_IPTC),
        photoshop_irb,
        has_layers: layer_count > 0,
        layer_count: Some(layer_count),
        resolution: resources.resolution().map(|r| (r.h_ppi(), r.v_ppi())),
        orientation: 1,
        page_count: 1,
    })
}

/// The data of the first resource block with `id`.
fn resource(resources: &ImageResources, id: u16) -> Option<Vec<u8>> {
    resources
        .blocks
        .iter()
        .find(|b| b.id == id)
        .and_then(block_data)
        .map(<[u8]>::to_vec)
}

/// A resource block's data: after the signature, the id, the Pascal name
/// (padded to an even total) and the u32 size.
fn block_data(block: &ImageResourceBlock) -> Option<&[u8]> {
    let raw = block.raw_block.as_deref()?;
    let name_len = usize::from(*raw.get(6)?);
    let at = 6 + (1 + name_len).next_multiple_of(2);
    let size = u32::from_be_bytes(raw.get(at..at + 4)?.try_into().ok()?) as usize;
    raw.get(at + 4..at + 4 + size)
}

pub(crate) fn decode(bytes: &[u8], opts: DecodeOptions) -> Result<RasterImage> {
    single_page(opts.page)?;
    let file = PsdFile::parse(bytes).map_err(error)?;
    let transparency = file.layer_mask.transparency_in_merged;
    let layer_count = paged_psd::summary(bytes)
        .map(|s| s.layers.layers.len())
        .unwrap_or(file.layer_mask.layers.len());
    let info = info(&file.header, &file.resources, layer_count, transparency)?;
    let (width, height) = (file.header.width, file.header.height);

    let (model, data) = match file.header.color_mode {
        ColorMode::Cmyk => {
            let c = file.composite_cmyk8().map_err(error)?;
            let data = match &c.alpha {
                Some(alpha) => c
                    .cmyk
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .zip(alpha)
                    .flat_map(|(ink, &a)| [ink[0], ink[1], ink[2], ink[3], a])
                    .collect(),
                None => c.cmyk,
            };
            (ColorModel::Cmyk, data)
        }
        mode => {
            let c = file.composite_rgba8().map_err(error)?;
            let gray = mode == ColorMode::Grayscale;
            let keep = |px: &[u8; 4], out: &mut Vec<u8>| {
                if gray {
                    out.push(px[0]);
                } else {
                    out.extend_from_slice(&px[..3]);
                }
                if transparency {
                    out.push(px[3]);
                }
            };
            let mut data = Vec::with_capacity(c.rgba.len());
            for px in c.rgba.as_chunks::<4>().0 {
                keep(px, &mut data);
            }
            let model = if gray {
                ColorModel::Gray
            } else {
                ColorModel::Rgb
            };
            (model, data)
        }
    };
    let alpha = if transparency {
        Alpha::Unassociated
    } else {
        Alpha::None
    };
    let channels = model.colour_channels() + usize::from(transparency);
    let k = shrink::factor(width, height, opts.max_dim);
    let (data, out_w, out_h) = shrink::shrink(Samples::U8(data), width, height, channels, k);
    Ok(RasterImage {
        info,
        width: out_w,
        height: out_h,
        model,
        alpha,
        data,
    })
}
