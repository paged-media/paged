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

//! AVIF, JPEG XL and the small formats `image` reads.
//!
//! The AVIF and JPEG XL files under `tests/fixtures` are made for these
//! tests from one generated 16x8 image (red, green, blue and white bars
//! over a gray half; the right column at half alpha): `avifenc
//! --lossless` and `avifenc -q 80 -d 10 -y 420` (libavif 1.4), `cjxl -d 0`
//! and `cjxl -d 1` of its opaque copy (libjxl 0.12). The other formats are
//! written in the test with `image`'s encoders.

use paged_raster::{decode, decode_rgba8, probe, sniff, DecodeOptions, Format};
#[cfg(feature = "avif")]
use paged_raster::{Alpha, ColorModel, Samples};

fn bars(x: u32, y: u32) -> [u8; 4] {
    let c = if y < 4 {
        [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]][x as usize / 4]
    } else {
        [128, 128, 128]
    };
    [c[0], c[1], c[2], if x == 15 { 128 } else { 255 }]
}

fn bars_rgba() -> Vec<u8> {
    (0..8)
        .flat_map(|y| (0..16).flat_map(move |x| bars(x, y)))
        .collect()
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/tests/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

/// The largest per-sample difference of two RGBA buffers, alpha
/// included when `alpha`.
#[cfg(feature = "jxl")]
fn max_diff(a: &[u8], b: &[u8], alpha: bool) -> u8 {
    a.as_chunks::<4>()
        .0
        .iter()
        .zip(b.as_chunks::<4>().0)
        .flat_map(|(p, q)| (0..if alpha { 4 } else { 3 }).map(move |c| p[c].abs_diff(q[c])))
        .max()
        .unwrap()
}

#[cfg(feature = "avif")]
#[test]
fn lossless_avif_decodes_exactly__feat__images_graphics_format_extensions() {
    let bytes = fixture("bars-lossless.avif");
    assert_eq!(sniff(&bytes), Some(Format::Avif));
    let info = probe(&bytes).unwrap();
    assert_eq!(
        (info.format, info.width, info.height),
        (Format::Avif, 16, 8)
    );
    assert_eq!(info.alpha, Alpha::Unassociated);
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(
        (img.model, img.alpha),
        (ColorModel::Rgb, Alpha::Unassociated)
    );
    assert!(matches!(img.data, Samples::U8(_)));
    assert_eq!(decode_rgba8(&bytes, None).unwrap().data, bars_rgba());
}

#[cfg(feature = "avif")]
#[test]
fn ten_bit_420_avif_decodes_close() {
    let bytes = fixture("bars-420-10bit.avif");
    let info = probe(&bytes).unwrap();
    assert_eq!(info.bits_per_sample, 10);
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert!(matches!(img.data, Samples::U16(_)), "10 bits arrive as 16");
    let rgba = decode_rgba8(&bytes, None).unwrap();
    assert_eq!((rgba.width, rgba.height), (16, 8));
    // Lossy, chroma at half resolution: the patch centres hold.
    let want = bars_rgba();
    for (x, y) in [(1, 1), (5, 1), (9, 1), (13, 1), (6, 6)] {
        let i = (y * 16 + x) * 4;
        for c in 0..3 {
            let d = rgba.data[i + c].abs_diff(want[i + c]);
            assert!(
                d <= 40,
                "pixel {x},{y} channel {c}: {} vs {}",
                rgba.data[i + c],
                want[i + c]
            );
        }
    }
    let shrunk = decode_rgba8(&bytes, Some(8)).unwrap();
    assert_eq!((shrunk.width, shrunk.height), (8, 4));
}

#[cfg(feature = "jxl")]
#[test]
fn jpeg_xl_decodes() {
    let lossless = fixture("bars-lossless.jxl");
    assert_eq!(sniff(&lossless), Some(Format::Jxl));
    let info = probe(&lossless).unwrap();
    assert_eq!((info.format, info.width, info.height), (Format::Jxl, 16, 8));
    assert_eq!(decode_rgba8(&lossless, None).unwrap().data, bars_rgba());

    let lossy = fixture("bars-lossy.jxl");
    let rgba = decode_rgba8(&lossy, None).unwrap();
    assert_eq!((rgba.width, rgba.height), (16, 8));
    let mut want = bars_rgba();
    want.as_chunks_mut::<4>()
        .0
        .iter_mut()
        .for_each(|p| p[3] = 255);
    // Ringing at the bars' edges: libjxl's own decode of this file is up
    // to 54 levels off the source.
    assert!(max_diff(&rgba.data, &want, true) <= 64);
}

fn encode(format: image::ImageFormat, img: &image::DynamicImage) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, format).unwrap();
    out.into_inner()
}

#[test]
fn small_formats_through_image() {
    let rgba = image::RgbaImage::from_raw(16, 8, bars_rgba()).unwrap();
    let dynamic = image::DynamicImage::ImageRgba8(rgba.clone());
    for (format, ours) in [
        (image::ImageFormat::Tga, Format::Tga),
        (image::ImageFormat::Qoi, Format::Qoi),
        (image::ImageFormat::Ico, Format::Ico),
    ] {
        let bytes = encode(format, &dynamic);
        assert_eq!(sniff(&bytes), Some(ours), "{format:?}");
        let info = probe(&bytes).unwrap();
        assert_eq!((info.format, info.width, info.height), (ours, 16, 8));
        assert_eq!(decode_rgba8(&bytes, None).unwrap().data, rgba.as_raw()[..]);
        let img = decode(&bytes, DecodeOptions::default()).unwrap();
        assert_eq!((img.width, img.height), (16, 8));
    }
}

#[test]
fn scene_linear_formats_are_srgb_encoded() {
    // Linear 0.214 is sRGB 0.5 (128), and 4.0 clips to white.
    let linear = image::Rgb32FImage::from_fn(4, 2, |x, _| {
        if x < 2 {
            image::Rgb([0.214f32, 0.214, 0.214])
        } else {
            image::Rgb([4.0, 0.0, 0.0])
        }
    });
    let dynamic = image::DynamicImage::ImageRgb32F(linear);
    let hdr = encode(image::ImageFormat::Hdr, &dynamic);
    #[allow(unused_mut)]
    let mut cases = vec![(hdr, Format::Hdr)];
    #[cfg(feature = "exr")]
    cases.push((encode(image::ImageFormat::OpenExr, &dynamic), Format::Exr));
    for (bytes, format) in cases {
        assert_eq!(sniff(&bytes), Some(format));
        assert!(format.is_scene_linear());
        let info = probe(&bytes).unwrap();
        assert_eq!((info.width, info.height), (4, 2));
        let rgba = decode_rgba8(&bytes, None).unwrap();
        assert!(
            rgba.data[0].abs_diff(128) <= 2,
            "{format:?}: {}",
            rgba.data[0]
        );
        assert_eq!(&rgba.data[8..12], &[255, 0, 0, 255], "{format:?}");
    }
}

#[cfg(not(all(feature = "avif", feature = "jxl")))]
#[test]
fn a_build_without_a_decoder_names_the_feature() {
    for (name, format) in [
        ("bars-lossless.avif", Format::Avif),
        ("bars-lossless.jxl", Format::Jxl),
    ] {
        let bytes = fixture(name);
        assert_eq!(sniff(&bytes), Some(format));
        match decode(&bytes, DecodeOptions::default()) {
            Ok(_) => {}
            Err(paged_raster::Error::Unsupported { what, .. }) => {
                assert!(what.contains("feature is off"), "{what}")
            }
            Err(other) => panic!("{other:?}"),
        }
    }
}
