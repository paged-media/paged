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

//! The files the Photoshop oracle opens (ADR 1038), generated: shared by
//! `examples/oracle_files.rs` (which writes them for the probe) and the
//! replay test (which regenerates them and checks them against the
//! recorded copies). Nothing here is a third-party image: the layered
//! PSD is paged-psd's synthetic fixture, the scene-linear files are
//! patches of chosen values.

use std::io::Cursor;

use paged_raster::{psd_to_layered_tiff, TiffCompression, TiffEncodeOptions};

/// paged-psd's synthetic three-layer RGB document (400 x 300).
pub const LAYERED_PSD: &[u8] =
    include_bytes!("../../../paged-psd/tests/fixtures/annual-layers.psd");

/// The scene-linear patches: 8 columns by 2 rows of 8 x 16 pixels each,
/// grey ramps from black to 16 times white, then colours, some brighter
/// than white and some far darker.
pub const PATCHES: [[[f32; 3]; 8]; 2] = [
    [
        [0.0, 0.0, 0.0],
        [0.05, 0.05, 0.05],
        [0.18, 0.18, 0.18],
        [0.5, 0.5, 0.5],
        [1.0, 1.0, 1.0],
        [1.5, 1.5, 1.5],
        [4.0, 4.0, 4.0],
        [16.0, 16.0, 16.0],
    ],
    [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [2.0, 1.0, 0.5],
        [0.25, 0.5, 0.75],
        [8.0, 0.125, 0.125],
        [0.001, 0.002, 0.004],
        [0.75, 0.75, 0.75],
    ],
];

/// The size of one patch, and of the image.
pub const PATCH: (u32, u32) = (8, 16);
pub const SIZE: (u32, u32) = (64, 32);

/// The patch at a pixel.
pub fn patch_at(x: u32, y: u32) -> [f32; 3] {
    PATCHES[(y / PATCH.1) as usize][(x / PATCH.0) as usize]
}

fn scene() -> image::Rgb32FImage {
    image::Rgb32FImage::from_fn(SIZE.0, SIZE.1, |x, y| image::Rgb(patch_at(x, y)))
}

/// The alpha of the RGBA OpenEXR file: a left-to-right ramp per row.
pub fn alpha_at(x: u32, _y: u32) -> f32 {
    x as f32 / (SIZE.0 - 1) as f32
}

fn written(img: image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, format).unwrap();
    out.into_inner()
}

/// `(file name, bytes)` of every file the probe opens.
pub fn oracle_files() -> Vec<(&'static str, Vec<u8>)> {
    let layered = psd_to_layered_tiff(
        LAYERED_PSD,
        TiffEncodeOptions {
            compression: TiffCompression::Lzw,
            predictor: false,
            rows_per_strip: None,
        },
    )
    .unwrap();
    let rgba = image::Rgba32FImage::from_fn(SIZE.0, SIZE.1, |x, y| {
        let [r, g, b] = patch_at(x, y);
        image::Rgba([r, g, b, alpha_at(x, y)])
    });
    let mut files = vec![
        ("layered.tif", layered),
        (
            "scene.hdr",
            written(
                image::DynamicImage::ImageRgb32F(scene()),
                image::ImageFormat::Hdr,
            ),
        ),
    ];
    // `image`'s OpenEXR encoder is there with paged-raster's `exr` feature.
    if cfg!(feature = "exr") {
        files.push((
            "scene.exr",
            written(
                image::DynamicImage::ImageRgb32F(scene()),
                image::ImageFormat::OpenExr,
            ),
        ));
        files.push((
            "scene-alpha.exr",
            written(
                image::DynamicImage::ImageRgba32F(rgba),
                image::ImageFormat::OpenExr,
            ),
        ));
    }
    files
}
