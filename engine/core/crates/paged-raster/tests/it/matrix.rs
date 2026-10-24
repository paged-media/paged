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

//! The strip matrix: every model, depth, alpha kind, compression,
//! predictor and strip size `encode_tiff` writes, decoded back.

use paged_raster::{
    decode, encode_tiff, probe, Alpha, ColorModel, DecodeOptions, SampleFormat, Samples,
    TiffCompression, TiffEncodeOptions,
};

use crate::support::image;

#[test]
fn every_model_depth_alpha_and_compression_round_trips__feat__images_graphics_tiff_raster() {
    let models = [ColorModel::Gray, ColorModel::Rgb, ColorModel::Cmyk];
    let alphas = [Alpha::None, Alpha::Associated, Alpha::Unassociated];
    let compressions = [
        TiffCompression::None,
        TiffCompression::Lzw,
        TiffCompression::Deflate,
    ];
    let mut cases = 0;
    for (mi, model) in models.into_iter().enumerate() {
        for (ai, alpha) in alphas.into_iter().enumerate() {
            for sixteen in [false, true] {
                for compression in compressions {
                    for predictor in [false, true] {
                        for rows_per_strip in [None, Some(3)] {
                            let seed = (mi * 100 + ai * 10 + usize::from(sixteen)) as u32;
                            let img = image(13, 7, model, alpha, sixteen, seed);
                            let opts = TiffEncodeOptions {
                                compression,
                                predictor,
                                rows_per_strip,
                            };
                            let bytes = encode_tiff(&img, opts).unwrap();
                            let label = format!(
                                "{model:?} {alpha:?} 16={sixteen} {compression:?} \
                                 pred={predictor} rows={rows_per_strip:?}"
                            );
                            let info = probe(&bytes).unwrap_or_else(|e| panic!("{label}: {e}"));
                            assert_eq!((info.width, info.height), (13, 7), "{label}");
                            assert_eq!(info.color_model, model, "{label}");
                            assert_eq!(info.alpha, alpha, "{label}");
                            assert_eq!(info.bits_per_sample, if sixteen { 16 } else { 8 });
                            assert_eq!(info.sample_format, SampleFormat::UInt);
                            assert_eq!(info.page_count, 1);
                            let back = decode(&bytes, DecodeOptions::default())
                                .unwrap_or_else(|e| panic!("{label}: {e}"));
                            assert_eq!(back.model, model, "{label}");
                            assert_eq!(back.alpha, alpha, "{label}");
                            assert_eq!(back.data, img.data, "{label}");
                            cases += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(cases, 3 * 3 * 2 * 3 * 2 * 2);
}

/// PackBits, 32-bit integer and 32-bit float samples, written with `tiff`'s
/// own encoder (paged-raster's encoder does not offer them).
#[test]
fn packbits_and_wide_samples_decode() {
    use tiff::encoder::{colortype, Compression, TiffEncoder};
    let (w, h) = (9u32, 5u32);
    let n = (w * h) as usize;

    let rgb: Vec<u8> = crate::support::pattern(n * 3, 256, 7)
        .into_iter()
        .map(|v| v as u8)
        .collect();
    let mut out = std::io::Cursor::new(Vec::new());
    TiffEncoder::new(&mut out)
        .unwrap()
        .with_compression(Compression::Packbits)
        .write_image::<colortype::RGB8>(w, h, &rgb)
        .unwrap();
    let back = decode(out.get_ref(), DecodeOptions::default()).unwrap();
    assert_eq!(back.data, Samples::U8(rgb));

    let gray32: Vec<u32> = (0..n as u32).map(|i| i * 0x0101_0101).collect();
    let mut out = std::io::Cursor::new(Vec::new());
    TiffEncoder::new(&mut out)
        .unwrap()
        .write_image::<colortype::Gray32>(w, h, &gray32)
        .unwrap();
    let back = decode(out.get_ref(), DecodeOptions::default()).unwrap();
    assert_eq!(back.info.bits_per_sample, 32);
    assert_eq!(
        back.data,
        Samples::U16(gray32.iter().map(|v| (v >> 16) as u16).collect())
    );

    let float: Vec<f32> = (0..n * 3).map(|i| i as f32 / (n * 3) as f32).collect();
    let mut out = std::io::Cursor::new(Vec::new());
    TiffEncoder::new(&mut out)
        .unwrap()
        .write_image::<colortype::RGB32Float>(w, h, &float)
        .unwrap();
    let info = probe(out.get_ref()).unwrap();
    assert_eq!(info.sample_format, SampleFormat::Float);
    let back = decode(out.get_ref(), DecodeOptions::default()).unwrap();
    assert_eq!(back.data, Samples::F32(float));
    let rgba = paged_raster::to_rgba8(&back, &paged_raster::NaiveColour).unwrap();
    assert_eq!(&rgba.data[..4], &[0, 2, 4, 255]);
}

#[test]
fn pages_are_selected_by_index__feat__images_graphics_tiff_raster() {
    let a = image(4, 3, ColorModel::Gray, Alpha::None, false, 1);
    let b = image(6, 2, ColorModel::Rgb, Alpha::Unassociated, true, 2);
    let c = image(5, 5, ColorModel::Cmyk, Alpha::None, false, 3);
    let bytes =
        paged_raster::encode_tiff_pages(&[&a, &b, &c], TiffEncodeOptions::default()).unwrap();
    assert_eq!(probe(&bytes).unwrap().page_count, 3);
    for (page, img) in [&a, &b, &c].into_iter().enumerate() {
        let back = decode(
            &bytes,
            DecodeOptions {
                page,
                max_dim: None,
            },
        )
        .unwrap();
        assert_eq!((back.width, back.height), (img.width, img.height));
        assert_eq!(back.model, img.model);
        assert_eq!(back.data, img.data, "page {page}");
        assert_eq!(
            paged_raster::probe_page(&bytes, page).unwrap().color_model,
            img.model
        );
    }
    let err = decode(
        &bytes,
        DecodeOptions {
            page: 3,
            max_dim: None,
        },
    )
    .unwrap_err();
    assert!(matches!(
        err,
        paged_raster::Error::PageOutOfRange { page: 3, count: 3 }
    ));
}

#[test]
fn bigtiff_decodes() {
    use tiff::encoder::{colortype, TiffEncoder};
    let rgb: Vec<u8> = (0..4 * 4 * 3).map(|i| i as u8 * 5).collect();
    let mut out = std::io::Cursor::new(Vec::new());
    TiffEncoder::new_big(&mut out)
        .unwrap()
        .write_image::<colortype::RGB8>(4, 4, &rgb)
        .unwrap();
    assert!(out.get_ref().starts_with(b"II+\0"));
    assert!(paged_raster::is_tiff(out.get_ref()));
    let back = decode(out.get_ref(), DecodeOptions::default()).unwrap();
    assert_eq!(back.data, Samples::U8(rgb));
}

#[test]
fn max_dim_box_shrinks() {
    let img = image(100, 40, ColorModel::Rgb, Alpha::None, false, 9);
    let bytes = encode_tiff(&img, TiffEncodeOptions::default()).unwrap();
    let back = decode(
        &bytes,
        DecodeOptions {
            page: 0,
            max_dim: Some(50),
        },
    )
    .unwrap();
    assert_eq!((back.width, back.height), (50, 20));
    assert_eq!(
        paged_raster::shrunk_dimensions(100, 40, Some(50)),
        (back.width, back.height)
    );
    assert_eq!(back.info.width, 100, "info keeps the file's size");
    let Samples::U8(src) = &img.data else {
        unreachable!()
    };
    let Samples::U8(out) = &back.data else {
        panic!("U8 stays U8")
    };
    let mean = (u32::from(src[0]) + u32::from(src[3]) + u32::from(src[300]) + u32::from(src[303]))
        as f32
        / 4.0;
    assert_eq!(out[0], mean.round() as u8);
    let rgba = paged_raster::decode_rgba8(&bytes, Some(50)).unwrap();
    assert_eq!((rgba.width, rgba.height), (50, 20));
}
