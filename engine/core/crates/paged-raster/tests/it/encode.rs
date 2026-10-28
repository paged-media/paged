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

//! The encoders (`paged_raster::encode`): a round trip per format with
//! its metadata, ICC embed and read-back, CMYK JPEG decode keeping inks,
//! and the CMYK conversion of an export. Linked to the image module's
//! `image.codec.core-codecs` row.

use paged_raster::{
    decode, encode, jpeg_header, probe, read_metadata, resize, rgb_to_cmyk, srgb_icc, Alpha,
    ColorModel, DecodeOptions, EncodeFormat, EncodeOptions, Format, Intent, Metadata, RasterImage,
    Samples, TiffCompression, TiffEncodeOptions,
};

fn rgb8(w: u32, h: u32) -> RasterImage {
    let mut v = Vec::new();
    for y in 0..h {
        for x in 0..w {
            v.extend_from_slice(&[(x * 37) as u8, (y * 53) as u8, ((x + y) * 11) as u8]);
        }
    }
    RasterImage::from_samples(w, h, ColorModel::Rgb, Alpha::None, Samples::U8(v))
}

fn meta() -> Metadata {
    Metadata {
        icc: Some(srgb_icc()),
        // Orientation 6 in a big-endian IFD0.
        exif: Some(b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0".to_vec()),
        xmp: Some(b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>".to_vec()),
        iptc: Some(b"\x1c\x02\x05\0\x04Name".to_vec()),
        photoshop_irb: None,
    }
}

fn opts() -> EncodeOptions {
    EncodeOptions {
        quality: 95,
        ppi: Some((300.0, 150.0)),
        metadata: meta(),
        tiff: TiffEncodeOptions {
            compression: TiffCompression::Lzw,
            predictor: true,
            rows_per_strip: None,
        },
    }
}

#[test]
fn every_format_round_trips_with_its_metadata__feat__image_codec_core_codecs() {
    let img = rgb8(9, 7);
    for format in [
        EncodeFormat::Png,
        EncodeFormat::Jpeg,
        EncodeFormat::WebP,
        EncodeFormat::Tiff,
    ] {
        let bytes = encode(&img, format, &opts()).unwrap();
        assert_eq!(
            paged_raster::sniff(&bytes),
            Some(format.format()),
            "{format:?}"
        );
        let info = probe(&bytes).unwrap();
        assert_eq!((info.width, info.height), (9, 7), "{format:?}");
        let m = read_metadata(&bytes);
        assert_eq!(m.icc, Some(srgb_icc()), "{format:?} ICC");
        assert_eq!(m.xmp, meta().xmp, "{format:?} XMP");
        match format {
            EncodeFormat::Tiff | EncodeFormat::Jpeg => {
                assert_eq!(m.iptc, meta().iptc, "{format:?} IPTC")
            }
            _ => {}
        }
        if format != EncodeFormat::Tiff {
            let exif = m.exif.expect("EXIF");
            assert_eq!(exif.len(), meta().exif.unwrap().len(), "{format:?}");
            // Written upright.
            assert_eq!(probe(&bytes).unwrap().orientation, 1, "{format:?}");
            let _ = exif;
        }
        if format != EncodeFormat::WebP {
            let (x, y) = info.resolution.expect("resolution");
            assert!(
                (x - 300.0).abs() < 0.5 && (y - 150.0).abs() < 0.5,
                "{format:?} {x} {y}"
            );
        }
        let back = decode(&bytes, DecodeOptions::default()).unwrap();
        assert_eq!(back.model, ColorModel::Rgb, "{format:?}");
        let (Samples::U8(a), Samples::U8(b)) = (&img.data, &back.data) else {
            panic!("{format:?} not 8-bit")
        };
        if format == EncodeFormat::Jpeg {
            let mae: f64 = a
                .iter()
                .zip(b)
                .map(|(x, y)| f64::from(x.abs_diff(*y)))
                .sum::<f64>()
                / a.len() as f64;
            assert!(mae < 6.0, "JPEG q95 mean error {mae}");
        } else {
            assert_eq!(a, b, "{format:?} is lossless");
        }
    }
}

#[test]
fn sixteen_bit_png_and_tiff_keep_their_samples__feat__image_codec_core_codecs() {
    let v: Vec<u16> = (0..5 * 3 * 4).map(|i| (i * 1301) as u16).collect();
    let img =
        RasterImage::from_samples(5, 3, ColorModel::Rgb, Alpha::Unassociated, Samples::U16(v));
    for format in [EncodeFormat::Png, EncodeFormat::Tiff] {
        let bytes = encode(&img, format, &EncodeOptions::default()).unwrap();
        let back = decode(&bytes, DecodeOptions::default()).unwrap();
        assert_eq!(back.data, img.data, "{format:?}");
        assert_ne!(back.alpha, Alpha::None);
    }
}

#[test]
fn cmyk_goes_to_tiff_only_and_converts_naively_without_a_profile__feat__image_codec_core_codecs() {
    let red = RasterImage::from_samples(
        1,
        1,
        ColorModel::Rgb,
        Alpha::None,
        Samples::U8(vec![255, 0, 0]),
    );
    let (cmyk, managed) = rgb_to_cmyk(&red, None, Intent::RelativeColorimetric).unwrap();
    assert!(!managed);
    assert_eq!(cmyk.data, Samples::U8(vec![0, 255, 255, 0]));
    let tif = encode(&cmyk, EncodeFormat::Tiff, &EncodeOptions::default()).unwrap();
    assert_eq!(probe(&tif).unwrap().color_model, ColorModel::Cmyk);
    for f in [EncodeFormat::Png, EncodeFormat::Jpeg, EncodeFormat::WebP] {
        assert!(
            encode(&cmyk, f, &EncodeOptions::default()).is_err(),
            "{f:?}"
        );
    }
    // A garbage profile is not a profile: naive again.
    let (_, managed) = rgb_to_cmyk(&red, Some(b"not icc"), Intent::Perceptual).unwrap();
    assert!(!managed);
}

#[test]
fn cmyk_profile_conversion_uses_the_profile_when_one_is_available__feat__image_codec_core_codecs() {
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        eprintln!("unavailable: CMYK profile: none installed or in the corpus");
        return;
    };
    let red = RasterImage::from_samples(
        1,
        1,
        ColorModel::Rgb,
        Alpha::None,
        Samples::U8(vec![255, 0, 0]),
    );
    let (cmyk, managed) = rgb_to_cmyk(&red, Some(&profile), Intent::RelativeColorimetric).unwrap();
    assert!(managed);
    let Samples::U8(v) = cmyk.data else { panic!() };
    // Coated red: little cyan, heavy magenta and yellow.
    assert!(v[0] < 40 && v[1] > 200 && v[2] > 200, "{v:?}");
}

#[test]
fn resize_keeps_depth_and_model__feat__image_codec_core_codecs() {
    let img = rgb8(8, 8);
    let small = resize(&img, 4, 2).unwrap();
    assert_eq!(
        (small.width, small.height, small.model),
        (4, 2, ColorModel::Rgb)
    );
    assert_eq!(small.data.len(), 4 * 2 * 3);
    assert!(resize(&img, 0, 2).is_err());
}

/// A 2x2 CMYK JPEG with Adobe APP14 (inverted inks), built with `image`'s
/// own pieces is not possible (it writes RGB), so the header is checked on
/// a real encode and the inks through a synthetic stream.
#[test]
fn jpeg_header_and_metadata_of_an_encoded_file__feat__image_codec_core_codecs() {
    let bytes = encode(&rgb8(16, 8), EncodeFormat::Jpeg, &opts()).unwrap();
    let h = jpeg_header(&bytes).unwrap();
    assert_eq!(
        (h.width, h.height, h.components, h.precision),
        (16, 8, 3, 8)
    );
    assert_eq!(h.adobe_transform, None);
    let info = probe(&bytes).unwrap();
    assert_eq!(info.format, Format::Jpeg);
    assert!(info.exif.is_some() && info.xmp.is_some() && info.iptc.is_some());
}
