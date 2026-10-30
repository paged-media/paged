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

//! Ingest of every format paged-raster decodes (ADR 468): TIFF (CMYK,
//! 16-bit), 16-bit gray PNG, WebP, Radiance HDR (clipped, stated). The
//! fixtures are encoded here through paged-raster itself.

use image_js::display::DisplayTreatment;
use image_js::ingest::decode_rgba8;
use paged_raster::{encode, Alpha, ColorModel, EncodeFormat, EncodeOptions, RasterImage, Samples};

fn file(img: &RasterImage, f: EncodeFormat) -> Vec<u8> {
    encode(img, f, &EncodeOptions::default()).unwrap()
}

#[test]
fn a_cmyk_tiff_opens_converted_and_says_so__feat__image_codec_core_codecs() {
    // Paper white and full black ink.
    let img = RasterImage::from_samples(
        2,
        1,
        ColorModel::Cmyk,
        Alpha::None,
        Samples::U8(vec![0, 0, 0, 0, 0, 0, 0, 255]),
    );
    let d = decode_rgba8(&file(&img, EncodeFormat::Tiff)).unwrap();
    assert_eq!((d.width, d.height), (2, 1));
    assert_eq!(d.display, DisplayTreatment::CmykUncalibrated);
    let px = d.rgba.to_rgba8();
    assert_eq!(&px[..4], &[255, 255, 255, 255]);
    assert!(px[4] < 20 && px[5] < 20 && px[6] < 20, "{:?}", &px[4..8]);
}

#[test]
fn sixteen_bit_tiff_and_gray_png_stay_sixteen_bit__feat__image_codec_core_codecs() {
    let rgb16 = RasterImage::from_samples(
        2,
        1,
        ColorModel::Rgb,
        Alpha::None,
        Samples::U16(vec![1, 2, 3, 65535, 32768, 0]),
    );
    let d = decode_rgba8(&file(&rgb16, EncodeFormat::Tiff)).unwrap();
    assert!(d.rgba.is_16bit() && !d.depth_reduced);
    assert_eq!(d.rgba.sample16(1, 1), 32768);
    let gray16 = RasterImage::from_samples(
        2,
        1,
        ColorModel::Gray,
        Alpha::None,
        Samples::U16(vec![1000, 60000]),
    );
    let d = decode_rgba8(&file(&gray16, EncodeFormat::Png)).unwrap();
    assert!(d.rgba.is_16bit());
    assert_eq!(
        (0..4).map(|c| d.rgba.sample16(1, c)).collect::<Vec<_>>(),
        vec![60000, 60000, 60000, 65535]
    );
}

#[test]
fn webp_opens_exactly__feat__image_codec_core_codecs() {
    let rgba = vec![10, 20, 30, 40, 200, 100, 50, 255];
    let img = RasterImage::from_samples(
        2,
        1,
        ColorModel::Rgb,
        Alpha::Unassociated,
        Samples::U8(rgba.clone()),
    );
    let d = decode_rgba8(&file(&img, EncodeFormat::WebP)).unwrap();
    assert_eq!(&d.rgba.to_rgba8()[..], &rgba[..]);
}

#[test]
fn radiance_hdr_opens_as_32bit_float_and_says_so__feat__image_codec_core_codecs() {
    // A flat (uncompressed) 2x1 RGBE file: 0.5 grey and 4.0 (over white).
    // It opens as 32-bit float, linear light (image ADR 483): 4.0 is kept,
    // and only the display view clips it.
    let mut hdr = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n".to_vec();
    hdr.extend_from_slice(&[128, 128, 128, 128, 128, 128, 128, 131]);
    let d = decode_rgba8(&hdr).unwrap();
    assert_eq!(d.display, DisplayTreatment::Float32);
    assert!(d.rgba.is_float());
    let lin = d.rgba.to_f32_linear();
    assert_eq!(&lin[..4], &[0.5, 0.5, 0.5, 1.0]);
    assert_eq!(&lin[4..8], &[4.0, 4.0, 4.0, 1.0], "4.0 is kept");
    let px = d.rgba.to_rgba8();
    assert_eq!(
        &px[4..8],
        &[255, 255, 255, 255],
        "the view clips 4.0 to white"
    );
    assert!(
        px[0] > 150 && px[0] < 210,
        "0.5 linear is ~188 sRGB: {}",
        px[0]
    );
}

#[test]
fn an_unknown_container_is_refused_by_name__feat__image_codec_core_codecs() {
    let err = decode_rgba8(b"not an image at all").unwrap_err();
    assert!(err.to_string().contains("unrecognized"), "{err}");
}
