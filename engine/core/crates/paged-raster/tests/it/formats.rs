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

//! The formats read through `image`: unchanged behaviour, plus probe and
//! ICC extraction.

use image::ImageEncoder;
use paged_raster::{
    decode, decode_rgba8, extract_icc, probe, sniff, Alpha, ColorModel, DecodeOptions, Format,
    Samples,
};

fn png(img: &image::RgbaImage, icc: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = image::codecs::png::PngEncoder::new(&mut out);
    if let Some(icc) = icc {
        enc.set_icc_profile(icc.to_vec()).unwrap();
    }
    enc.write_image(
        img,
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgba8,
    )
    .unwrap();
    out
}

fn jpeg(img: &image::RgbImage, icc: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
    if let Some(icc) = icc {
        enc.set_icc_profile(icc.to_vec()).unwrap();
    }
    enc.write_image(
        img,
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgb8,
    )
    .unwrap();
    out
}

#[test]
fn png_and_jpeg_decode_exactly_as_image_does() {
    let rgba = image::RgbaImage::from_fn(9, 4, |x, y| {
        image::Rgba([x as u8 * 20, y as u8 * 50, 7, 200])
    });
    let bytes = png(&rgba, None);
    assert_eq!(sniff(&bytes), Some(Format::Png));
    let ours = decode_rgba8(&bytes, Some(2)).unwrap();
    assert_eq!((ours.width, ours.height), (9, 4), "max_dim is TIFF-only");
    assert_eq!(
        ours.data,
        image::load_from_memory(&bytes)
            .unwrap()
            .to_rgba8()
            .into_raw()
    );

    let rgb = image::RgbImage::from_fn(16, 8, |x, _| image::Rgb([x as u8 * 15, 90, 200]));
    let bytes = jpeg(&rgb, None);
    let ours = decode_rgba8(&bytes, None).unwrap();
    assert_eq!(
        ours.data,
        image::load_from_memory(&bytes)
            .unwrap()
            .to_rgba8()
            .into_raw()
    );
}

#[test]
fn probe_and_decode_read_the_web_formats() {
    let rgba = image::RgbaImage::from_fn(5, 3, |x, _| image::Rgba([x as u8, 1, 2, 3]));
    let icc = b"an icc profile".to_vec();
    let bytes = png(&rgba, Some(&icc));
    let info = probe(&bytes).unwrap();
    assert_eq!(info.format, Format::Png);
    assert_eq!((info.width, info.height, info.channels), (5, 3, 4));
    assert_eq!(info.color_model, ColorModel::Rgb);
    assert_eq!(info.alpha, Alpha::Unassociated);
    assert_eq!(info.icc.as_deref(), Some(&icc[..]));
    assert_eq!(extract_icc(&bytes).as_deref(), Some(&icc[..]));
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(img.data, Samples::U8(rgba.into_raw()));

    let rgb = image::RgbImage::from_pixel(8, 8, image::Rgb([10, 20, 30]));
    let bytes = jpeg(&rgb, Some(&icc));
    let info = probe(&bytes).unwrap();
    assert_eq!(info.format, Format::Jpeg);
    assert_eq!(info.alpha, Alpha::None);
    assert_eq!(extract_icc(&bytes).as_deref(), Some(&icc[..]));
    assert!(matches!(
        decode(
            &bytes,
            DecodeOptions {
                page: 1,
                max_dim: None
            }
        ),
        Err(paged_raster::Error::PageOutOfRange { page: 1, count: 1 })
    ));
}

/// Engine ADR 1311 — a JPEG asked for at a half or less of its size is
/// decoded at its DCT scale and resampled from there: the size asked, the
/// picture's colours, and the same result as the full decode resampled
/// within a few levels.
#[test]
fn a_large_jpeg_decodes_at_its_dct_scale_for_a_small_target() {
    let rgb = image::RgbImage::from_fn(256, 128, |x, y| {
        image::Rgb([(x / 2) as u8, (y * 2) as u8, 90])
    });
    let bytes = jpeg(&rgb, None);
    let small = paged_raster::decode_rgba8_at(&bytes, 32, 16).expect("decodes");
    assert_eq!(small.len(), 32 * 16 * 4);
    let full = decode_rgba8(&bytes, None).unwrap();
    let reference = paged_resample::resize_rgba8(
        &full.data,
        full.width,
        full.height,
        32,
        16,
        paged_resample::Filter::Bilinear,
    )
    .unwrap();
    let worst = small
        .iter()
        .zip(&reference)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    assert!(worst <= 8, "DCT-scaled decode drifts {worst} levels");
    assert!(small.chunks(4).all(|p| p[3] == 255));
    // A gray JPEG too; a target near full size takes the full decode.
    let gray = image::GrayImage::from_fn(64, 64, |x, _| image::Luma([x as u8 * 4]));
    let mut g = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut g, 90)
        .write_image(&gray, 64, 64, image::ExtendedColorType::L8)
        .unwrap();
    let px = paged_raster::decode_rgba8_at(&g, 8, 8).expect("decodes");
    assert_eq!(px.len(), 8 * 8 * 4);
    assert!(px.chunks(4).all(|p| p[0] == p[1] && p[1] == p[2]));
    let near = paged_raster::decode_rgba8_at(&g, 48, 48).expect("decodes");
    assert_eq!(near.len(), 48 * 48 * 4);
}
