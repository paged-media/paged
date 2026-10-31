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

//! Shared builders.

use paged_raster::{Alpha, ColorModel, Format, RasterImage, RasterInfo, SampleFormat, Samples};

/// Header facts for a generated image: no metadata.
pub fn info(w: u32, h: u32) -> RasterInfo {
    RasterInfo {
        format: Format::Tiff,
        width: w,
        height: h,
        channels: 0,
        bits_per_sample: 0,
        sample_format: SampleFormat::UInt,
        color_model: ColorModel::Rgb,
        alpha: Alpha::None,
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
    }
}

/// A deterministic pattern of `n` values below `modulus`.
pub fn pattern(n: usize, modulus: u32, seed: u32) -> Vec<u32> {
    let mut s = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    (0..n)
        .map(|i| {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s.wrapping_add(i as u32 * 7)) % modulus
        })
        .collect()
}

/// A `w` x `h` image of `model` with `alpha`, 8 or 16 bits, patterned.
pub fn image(
    w: u32,
    h: u32,
    model: ColorModel,
    alpha: Alpha,
    sixteen: bool,
    seed: u32,
) -> RasterImage {
    let ch = model.colour_channels() + usize::from(alpha != Alpha::None);
    let n = w as usize * h as usize * ch;
    let mut data = if sixteen {
        Samples::U16(
            pattern(n, 65536, seed)
                .into_iter()
                .map(|v| v as u16)
                .collect(),
        )
    } else {
        Samples::U8(pattern(n, 256, seed).into_iter().map(|v| v as u8).collect())
    };
    if alpha == Alpha::Associated {
        // Premultiplied colour never exceeds its alpha.
        match &mut data {
            Samples::U8(v) => v.chunks_exact_mut(ch).for_each(|px| {
                let a = px[ch - 1];
                px[..ch - 1].iter_mut().for_each(|c| *c = (*c).min(a));
            }),
            Samples::U16(v) => v.chunks_exact_mut(ch).for_each(|px| {
                let a = px[ch - 1];
                px[..ch - 1].iter_mut().for_each(|c| *c = (*c).min(a));
            }),
            Samples::F32(_) => {}
        }
    }
    let mut info = info(w, h);
    info.color_model = model;
    info.alpha = alpha;
    RasterImage {
        info,
        width: w,
        height: h,
        model,
        alpha,
        data,
    }
}
