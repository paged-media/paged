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

//! WP9.4's codecs (ADR 1038): the GIF, BMP, TGA, JPEG XL and AVIF
//! encoders, the scene-linear floats of OpenEXR and Radiance HDR, and the
//! layered TIFF. A round trip per codec and a refusal that names what is
//! not written. Linked to `images-graphics.codecs-long-tail`.

use paged_psd::model::ColorMode;
use paged_psd::Container;
use paged_raster::{
    decode, encode, encode_layered_tiff, probe, psd_to_layered_tiff, sniff, Alpha, ColorModel,
    DecodeOptions, EncodeFormat, EncodeOptions, Error, Format, RasterImage, SampleFormat, Samples,
    TiffCompression, TiffEncodeOptions,
};
#[cfg(feature = "avif-encode")]
use paged_raster::{decode_rgba8, Metadata};

#[cfg(feature = "exr")]
use crate::oracle_files::alpha_at;
use crate::oracle_files::{oracle_files, patch_at, LAYERED_PSD, SIZE};

fn file(name: &str) -> Vec<u8> {
    oracle_files()
        .into_iter()
        .find(|(n, _)| *n == name)
        .unwrap()
        .1
}

/// An 8-bit image of `model` with or without alpha, `n` distinct colours
/// at most (a palette of `n` cycled over the pixels).
fn image(w: u32, h: u32, model: ColorModel, alpha: bool, n: u32) -> RasterImage {
    let ch = model.colour_channels() + usize::from(alpha);
    let mut v = Vec::with_capacity((w * h) as usize * ch);
    for i in 0..w * h {
        let k = (i * 7 + i / w) % n;
        let c = [(k * 37) as u8, (k * 91 + 7) as u8, (k * 151 + 3) as u8, 0];
        v.extend_from_slice(&c[..model.colour_channels()]);
        if alpha {
            // Opaque or clear: GIF holds one bit of alpha.
            v.push(if k.is_multiple_of(5) { 0 } else { 255 });
        }
    }
    let alpha = if alpha {
        Alpha::Unassociated
    } else {
        Alpha::None
    };
    RasterImage::from_samples(w, h, model, alpha, Samples::U8(v))
}

fn u8s(img: &RasterImage) -> &[u8] {
    match &img.data {
        Samples::U8(v) => v,
        other => panic!("not 8-bit: {other:?}"),
    }
}

/// Straight RGBA of an 8-bit Gray or RGB image, for comparing a file
/// that widened Gray to RGB.
fn rgba(img: &RasterImage) -> Vec<[u8; 4]> {
    let ch = img.channels();
    u8s(img)
        .chunks_exact(ch)
        .map(|p| match (img.model, ch) {
            (ColorModel::Gray, 1) => [p[0], p[0], p[0], 255],
            (ColorModel::Gray, 2) => [p[0], p[0], p[0], p[1]],
            (ColorModel::Rgb, 3) => [p[0], p[1], p[2], 255],
            (ColorModel::Rgb, 4) => [p[0], p[1], p[2], p[3]],
            _ => panic!("{:?} {ch}", img.model),
        })
        .collect()
}

/// Equal pixels, a fully transparent pixel's colour ignored.
fn same_pixels(a: &[[u8; 4]], b: &[[u8; 4]]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x[3] == y[3] && (x[3] == 0 || x[..3] == y[..3]))
}

#[test]
fn format_names_read_back__feat__images_graphics_codecs_long_tail() {
    for f in EncodeFormat::ALL {
        assert_eq!(EncodeFormat::from_name(f.name()), Some(f));
        assert_eq!(EncodeFormat::from_name(&f.name().to_uppercase()), Some(f));
    }
    assert_eq!(EncodeFormat::from_name("tif"), Some(EncodeFormat::Tiff));
    assert_eq!(EncodeFormat::from_name("heic"), None);
    assert!(EncodeFormat::Gif.available() && EncodeFormat::Tga.available());
    assert_eq!(
        EncodeFormat::Avif.available(),
        cfg!(feature = "avif-encode")
    );
}

#[test]
fn bmp_tga_and_jxl_are_lossless_in_gray_and_rgb_with_and_without_alpha__feat__images_graphics_codecs_long_tail(
) {
    let mut formats = vec![EncodeFormat::Bmp, EncodeFormat::Tga];
    if EncodeFormat::Jxl.available() {
        formats.push(EncodeFormat::Jxl);
    }
    for format in formats {
        for model in [ColorModel::Gray, ColorModel::Rgb] {
            for alpha in [false, true] {
                let img = image(13, 9, model, alpha, 1000);
                let bytes = encode(&img, format, &EncodeOptions::default())
                    .unwrap_or_else(|e| panic!("{format:?} {model:?} {alpha}: {e}"));
                assert_eq!(sniff(&bytes), Some(format.format()), "{format:?}");
                let info = probe(&bytes).unwrap();
                assert_eq!((info.width, info.height), (13, 9), "{format:?}");
                let back = decode(&bytes, DecodeOptions::default()).unwrap();
                assert!(
                    same_pixels(&rgba(&back), &rgba(&img)),
                    "{format:?} {model:?} alpha {alpha}"
                );
            }
        }
    }
}

#[test]
fn jxl_keeps_sixteen_bit_samples__feat__images_graphics_codecs_long_tail() {
    if !EncodeFormat::Jxl.available() {
        return;
    }
    let v: Vec<u16> = (0..7 * 5 * 3).map(|i| (i * 977 % 65536) as u16).collect();
    let img =
        RasterImage::from_samples(7, 5, ColorModel::Rgb, Alpha::None, Samples::U16(v.clone()));
    let bytes = encode(&img, EncodeFormat::Jxl, &EncodeOptions::default()).unwrap();
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    let got: Vec<u16> = match back.data {
        Samples::U16(g) => g,
        // jxl-oxide renders to floats: back to 16 bits.
        Samples::F32(f) => f.iter().map(|s| (s * 65535.0).round() as u16).collect(),
        Samples::U8(_) => panic!("narrowed to 8 bits"),
    };
    assert_eq!(got, v);
}

#[test]
fn gif_keeps_up_to_256_colours_exactly_and_quantizes_more__feat__images_graphics_codecs_long_tail()
{
    for (model, alpha) in [
        (ColorModel::Rgb, false),
        (ColorModel::Rgb, true),
        (ColorModel::Gray, false),
    ] {
        let img = image(16, 16, model, alpha, 200);
        let bytes = encode(&img, EncodeFormat::Gif, &EncodeOptions::default()).unwrap();
        assert_eq!(sniff(&bytes), Some(Format::Gif));
        let back = decode(&bytes, DecodeOptions::default()).unwrap();
        assert!(
            same_pixels(&rgba(&back), &rgba(&img)),
            "{model:?} alpha {alpha}: 200 colours are kept"
        );
    }
    // A gradient of 4096 colours: quantized, close.
    let mut v = Vec::new();
    for y in 0..64u32 {
        for x in 0..64u32 {
            v.extend_from_slice(&[(x * 4) as u8, (y * 4) as u8, 128]);
        }
    }
    let img = RasterImage::from_samples(64, 64, ColorModel::Rgb, Alpha::None, Samples::U8(v));
    let bytes = encode(&img, EncodeFormat::Gif, &EncodeOptions::default()).unwrap();
    let back = rgba(&decode(&bytes, DecodeOptions::default()).unwrap());
    let mae = back
        .iter()
        .zip(rgba(&img))
        .flat_map(|(a, b)| (0..3).map(move |i| f64::from(a[i].abs_diff(b[i]))))
        .sum::<f64>()
        / (64.0 * 64.0 * 3.0);
    assert!(mae < 8.0, "quantized mean error {mae}");
}

#[test]
fn bmp_states_its_resolution__feat__images_graphics_codecs_long_tail() {
    let img = image(4, 4, ColorModel::Rgb, false, 16);
    let opts = EncodeOptions {
        ppi: Some((300.0, 72.0)),
        ..EncodeOptions::default()
    };
    let bytes = encode(&img, EncodeFormat::Bmp, &opts).unwrap();
    let ppm = |at: usize| i32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    assert_eq!((ppm(38), ppm(42)), (11811, 2835));
}

#[test]
fn a_model_a_format_cannot_hold_is_refused_by_name__feat__images_graphics_codecs_long_tail() {
    let cmyk = image(4, 4, ColorModel::Cmyk, false, 16);
    for format in [
        EncodeFormat::Gif,
        EncodeFormat::Bmp,
        EncodeFormat::Tga,
        EncodeFormat::Jxl,
        EncodeFormat::Avif,
    ] {
        match encode(&cmyk, format, &EncodeOptions::default()) {
            Err(Error::Encode(what)) => assert!(
                what.contains("Cmyk") || what.contains("feature"),
                "{format:?}: {what}"
            ),
            other => panic!("{format:?}: {other:?}"),
        }
    }
}

#[cfg(feature = "avif-encode")]
#[test]
fn avif_round_trips_within_its_quality_with_alpha_and_exif__feat__images_graphics_codecs_long_tail()
{
    let mut v = Vec::new();
    for y in 0..32u32 {
        for x in 0..48u32 {
            v.extend_from_slice(&[(x * 5) as u8, (y * 7) as u8, 160, (x * 5) as u8]);
        }
    }
    let img =
        RasterImage::from_samples(48, 32, ColorModel::Rgb, Alpha::Unassociated, Samples::U8(v));
    let exif = b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0".to_vec();
    let opts = EncodeOptions {
        quality: 90,
        metadata: Metadata {
            exif: Some(exif),
            ..Metadata::default()
        },
        ..EncodeOptions::default()
    };
    let bytes = encode(&img, EncodeFormat::Avif, &opts).unwrap();
    assert_eq!(sniff(&bytes), Some(Format::Avif));
    let back = decode_rgba8(&bytes, None).unwrap();
    assert_eq!((back.width, back.height), (48, 32));
    let want = rgba(&img);
    let mae = back
        .data
        .as_chunks::<4>()
        .0
        .iter()
        .zip(&want)
        .flat_map(|(a, b)| (0..4).map(move |i| f64::from(a[i].abs_diff(b[i]))))
        .sum::<f64>()
        / (48.0 * 32.0 * 4.0);
    assert!(mae < 4.0, "AVIF q90 mean error {mae}");
}

#[cfg(not(feature = "avif-encode"))]
#[test]
fn a_build_without_the_avif_encoder_names_the_feature__feat__images_graphics_codecs_long_tail() {
    let img = image(4, 4, ColorModel::Rgb, false, 16);
    match encode(&img, EncodeFormat::Avif, &EncodeOptions::default()) {
        Err(Error::Encode(what)) => assert!(what.contains("`avif-encode`"), "{what}"),
        other => panic!("{other:?}"),
    }
}

fn floats(img: &RasterImage) -> &[f32] {
    match &img.data {
        Samples::F32(v) => v,
        other => panic!("not float: {other:?}"),
    }
}

#[test]
fn openexr_and_radiance_hdr_decode_to_scene_linear_floats__feat__images_graphics_codecs_long_tail()
{
    for (name, format, tolerance) in [
        ("scene.exr", Format::Exr, 0.0),
        // RGBE keeps 8 bits of mantissa under a shared exponent.
        ("scene.hdr", Format::Hdr, 1.0 / 128.0),
    ] {
        if format == Format::Exr && !cfg!(feature = "exr") {
            continue;
        }
        let bytes = file(name);
        let info = probe(&bytes).unwrap();
        assert_eq!(info.format, format);
        assert_eq!(info.sample_format, SampleFormat::Float, "{name}");
        assert_eq!(info.bits_per_sample, 32, "{name}");
        let img = decode(&bytes, DecodeOptions::default()).unwrap();
        assert_eq!((img.model, img.alpha), (ColorModel::Rgb, Alpha::None));
        assert_eq!((img.width, img.height), SIZE);
        let px = floats(&img);
        for y in 0..SIZE.1 {
            for x in 0..SIZE.0 {
                let want = patch_at(x, y);
                let at = ((y * SIZE.0 + x) * 3) as usize;
                for c in 0..3 {
                    let got = px[at + c];
                    // Relative to the largest channel (the shared exponent).
                    let scale = want.iter().cloned().fold(0.0f32, f32::max).max(1e-6);
                    assert!(
                        (got - want[c]).abs() <= tolerance * scale,
                        "{name} ({x},{y})[{c}]: {got} for {}",
                        want[c]
                    );
                }
            }
        }
    }
}

#[cfg(feature = "exr")]
#[test]
fn an_openexr_alpha_channel_is_associated__feat__images_graphics_codecs_long_tail() {
    // OpenEXR colour is premultiplied by its alpha: the samples are kept
    // as stored and said to be associated.
    let bytes = file("scene-alpha.exr");
    assert_eq!(probe(&bytes).unwrap().alpha, Alpha::Associated);
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!((img.model, img.alpha), (ColorModel::Rgb, Alpha::Associated));
    let px = floats(&img);
    for (i, p) in px.as_chunks::<4>().0.iter().enumerate() {
        let (x, y) = (i as u32 % SIZE.0, i as u32 / SIZE.0);
        assert_eq!(p[3], alpha_at(x, y));
        assert_eq!(&p[..3], &patch_at(x, y));
    }
}

#[cfg(feature = "exr")]
#[test]
fn deep_and_non_rgb_openexr_files_are_refused_by_name__feat__images_graphics_codecs_long_tail() {
    // The version field's bit 11 says the file holds deep data.
    let mut deep = file("scene.exr");
    deep[5] |= 0x08;
    // The channel list B, G, R renamed B, G, Y (still sorted): no R.
    let mut luma = file("scene.exr");
    let list = luma.windows(7).position(|w| w == b"chlist\0").unwrap();
    let r = list + luma[list..].windows(2).position(|w| w == b"R\0").unwrap();
    luma[r] = b'Y';
    for (bytes, says) in [(deep, "deep data"), (luma, "without R, G and B")] {
        for result in [
            probe(&bytes).map(|_| ()),
            decode(&bytes, DecodeOptions::default()).map(|_| ()),
        ] {
            match result {
                Err(Error::Unsupported { format, what }) => {
                    assert_eq!(format, Format::Exr);
                    assert!(what.contains(says), "{what}");
                }
                other => panic!("{says}: {other:?}"),
            }
        }
    }
}

fn layered(compression: TiffCompression) -> Vec<u8> {
    psd_to_layered_tiff(
        LAYERED_PSD,
        TiffEncodeOptions {
            compression,
            predictor: false,
            rows_per_strip: None,
        },
    )
    .unwrap()
}

#[test]
fn a_psd_becomes_a_big_endian_layered_tiff_whose_layers_read_back__feat__images_graphics_codecs_long_tail(
) {
    let psd = paged_psd::PsdFile::parse(LAYERED_PSD).unwrap();
    let composite = decode(LAYERED_PSD, DecodeOptions::default()).unwrap();
    for compression in [
        TiffCompression::None,
        TiffCompression::Lzw,
        TiffCompression::Deflate,
    ] {
        let tiff = layered(compression);
        assert!(tiff.starts_with(b"MM\0\x2a"), "{compression:?}");
        let info = probe(&tiff).unwrap();
        assert!(info.has_layers);
        assert_eq!(info.layer_count, Some(3));
        assert_eq!(info.resolution, Some((72.0, 72.0)));
        assert_eq!(
            info.photoshop_irb.as_deref(),
            Some(&paged_psd::image_resource_blocks(&psd)[..])
        );
        // The TIFF's own image is the PSD's merged composite.
        let img = decode(&tiff, DecodeOptions::default()).unwrap();
        assert_eq!(img.data, composite.data, "{compression:?}");
        // Its layers are the PSD's, channel data included.
        let data = image_source_data_of(&tiff);
        let list = paged_psd::image_source_data_layers(&data).unwrap();
        assert_eq!(list.layers, psd.layer_mask.layers, "{compression:?}");
    }
}

/// Tag 37724's bytes in a big-endian TIFF with one directory.
pub fn image_source_data_of(tiff: &[u8]) -> Vec<u8> {
    let be16 = |at: usize| u16::from_be_bytes([tiff[at], tiff[at + 1]]) as usize;
    let be32 = |at: usize| u32::from_be_bytes(tiff[at..at + 4].try_into().unwrap()) as usize;
    let ifd = be32(4);
    (0..be16(ifd))
        .map(|e| ifd + 2 + e * 12)
        .find(|&at| be16(at) == 37724)
        .map(|at| tiff[be32(at + 8)..be32(at + 8) + be32(at + 4)].to_vec())
        .expect("tag 37724")
}

#[test]
fn a_layered_tiff_refuses_what_its_layers_cannot_match__feat__images_graphics_codecs_long_tail() {
    let opts = TiffEncodeOptions::default();
    // A 16-bit document: the composite would not match its Lr16 layers.
    let sixteen = crate::psd::psd(
        Container::Psd,
        ColorMode::Rgb,
        16,
        2,
        2,
        &[vec![0; 8], vec![0; 8], vec![0; 8]],
        false,
        None,
    );
    match psd_to_layered_tiff(&sixteen, opts) {
        Err(Error::Unsupported { what, .. }) => assert!(what.contains("16-bit"), "{what}"),
        other => panic!("{other:?}"),
    }
    // A flat document has no layers to carry.
    let flat = crate::psd::psd(
        Container::Psd,
        ColorMode::Rgb,
        8,
        2,
        2,
        &[vec![0; 4], vec![0; 4], vec![0; 4]],
        false,
        None,
    );
    match psd_to_layered_tiff(&flat, opts) {
        Err(Error::Unsupported { what, .. }) => assert!(what.contains("without layers"), "{what}"),
        other => panic!("{other:?}"),
    }
    // Floats, and a payload that is not ImageSourceData.
    let img =
        RasterImage::from_samples(1, 1, ColorModel::Gray, Alpha::None, Samples::F32(vec![0.5]));
    let data =
        paged_psd::image_source_data(&paged_psd::PsdFile::parse(LAYERED_PSD).unwrap()).unwrap();
    assert!(
        matches!(encode_layered_tiff(&img, &data, opts), Err(Error::Encode(w)) if w.contains("8-bit"))
    );
    let gray = RasterImage::from_samples(1, 1, ColorModel::Gray, Alpha::None, Samples::U8(vec![9]));
    assert!(
        matches!(encode_layered_tiff(&gray, b"layers", opts), Err(Error::Encode(w)) if w.contains("Adobe Photoshop Document Data Block"))
    );
}
