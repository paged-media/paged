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

//! Layouts and colour models no encoder writes, from [`crate::raw_tiff`].

use std::io::Write;

use paged_raster::{
    decode, probe, to_rgba8, Alpha, ColorModel, DecodeOptions, Error, NaiveColour, Samples,
};

use crate::raw_tiff::{base, set, write, Page, V};

fn value(x: u32, y: u32, c: u32) -> u8 {
    ((x * 7 + y * 13 + c * 50) % 256) as u8
}

fn rgb8(w: u32, h: u32) -> Vec<u8> {
    let mut v = Vec::new();
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                v.push(value(x, y, c));
            }
        }
    }
    v
}

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn tiled(w: u32, h: u32, compress: bool) -> Vec<u8> {
    let t = 16u32;
    let mut tags = base(w, h, &[8, 8, 8], 2);
    tags.push((322, V::Long(vec![t])));
    tags.push((323, V::Long(vec![t])));
    if compress {
        set(&mut tags, 259, V::Short(vec![8]));
    }
    let mut chunks = Vec::new();
    for ty in 0..h.div_ceil(t) {
        for tx in 0..w.div_ceil(t) {
            let mut tile = Vec::new();
            for y in 0..t {
                for x in 0..t {
                    let (px, py) = (tx * t + x, ty * t + y);
                    for c in 0..3 {
                        tile.push(if px < w && py < h {
                            value(px, py, c)
                        } else {
                            0
                        });
                    }
                }
            }
            chunks.push(if compress { zlib(&tile) } else { tile });
        }
    }
    write(&[Page::tiles(tags, chunks)], true)
}

#[test]
fn tiles_uncompressed_and_deflated__feat__images_graphics_tiff_raster() {
    for compress in [false, true] {
        let bytes = tiled(20, 18, compress);
        let back = decode(&bytes, DecodeOptions::default()).unwrap();
        assert_eq!((back.width, back.height), (20, 18));
        assert_eq!(back.data, Samples::U8(rgb8(20, 18)), "deflate={compress}");
    }
}

#[test]
fn planar_layouts_interleave__feat__images_graphics_tiff_raster() {
    let (w, h) = (7u32, 5u32);
    let mut tags = base(w, h, &[8, 8, 8], 2);
    tags.push((284, V::Short(vec![2])));
    let planes: Vec<Vec<u8>> = (0..3)
        .map(|c| {
            (0..h)
                .flat_map(|y| (0..w).map(move |x| value(x, y, c)))
                .collect()
        })
        .collect();
    let bytes = write(&[Page::strips(tags, planes)], true);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(back.data, Samples::U8(rgb8(w, h)));

    let mut tags = base(w, h, &[16, 16, 16], 2);
    tags.push((284, V::Short(vec![2])));
    let planes: Vec<Vec<u8>> = (0..3u32)
        .map(|c| {
            (0..h)
                .flat_map(|y| (0..w).map(move |x| u16::from(value(x, y, c)) * 257))
                .flat_map(u16::to_le_bytes)
                .collect()
        })
        .collect();
    let bytes = write(&[Page::strips(tags, planes)], true);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(
        back.data,
        Samples::U16(rgb8(w, h).into_iter().map(|v| u16::from(v) * 257).collect())
    );
}

#[test]
fn bilevel_and_four_bit_gray() {
    // 10 pixels per row: 2 bytes, the last 6 bits padding.
    let rows: [[u8; 2]; 2] = [[0b1010_0000, 0b1100_0000], [0b0000_1111, 0b0000_0000]];
    let expect: Vec<u8> = [
        [1, 0, 1, 0, 0, 0, 0, 0, 1, 1],
        [0, 0, 0, 0, 1, 1, 1, 1, 0, 0],
    ]
    .concat()
    .into_iter()
    .map(|b| b * 255)
    .collect();
    let strip: Vec<u8> = rows.concat();
    let bytes = write(
        &[Page::strips(base(10, 2, &[1], 1), vec![strip.clone()])],
        true,
    );
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(back.model, ColorModel::Gray);
    assert_eq!(back.data, Samples::U8(expect.clone()));

    // WhiteIsZero inverts.
    let bytes = write(&[Page::strips(base(10, 2, &[1], 0), vec![strip])], true);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(
        back.data,
        Samples::U8(expect.iter().map(|v| 255 - v).collect())
    );

    let bytes = write(
        &[Page::strips(base(3, 1, &[4], 1), vec![vec![0x0F, 0x80]])],
        true,
    );
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(back.data, Samples::U8(vec![0, 255, 136]));
}

fn colour_map(entries: usize) -> Vec<u16> {
    let mut map = Vec::new();
    for c in 0..3u32 {
        for i in 0..entries as u32 {
            map.push(((i * 4099 + c * 20000) % 65536) as u16);
        }
    }
    map
}

#[test]
fn palette_expands_through_the_colour_map__feat__images_graphics_tiff_raster() {
    let map = colour_map(256);
    let indices: Vec<u8> = (0..12u8).map(|i| i * 21).collect();
    let mut tags = base(4, 3, &[8], 3);
    tags.push((320, V::Short(map.clone())));
    let bytes = write(&[Page::strips(tags, vec![indices.clone()])], true);
    let info = probe(&bytes).unwrap();
    assert_eq!(info.color_model, ColorModel::Palette);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(back.model, ColorModel::Rgb);
    let expect: Vec<u16> = indices
        .iter()
        .flat_map(|&i| {
            let i = usize::from(i);
            [map[i], map[256 + i], map[512 + i]]
        })
        .collect();
    assert_eq!(back.data, Samples::U16(expect));

    // 4-bit indices, two per byte.
    let map = colour_map(16);
    let mut tags = base(4, 1, &[4], 3);
    tags.push((320, V::Short(map.clone())));
    let bytes = write(&[Page::strips(tags, vec![vec![0x01, 0xF7]])], true);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    let expect: Vec<u16> = [0usize, 1, 15, 7]
        .iter()
        .flat_map(|&i| [map[i], map[16 + i], map[32 + i]])
        .collect();
    assert_eq!(back.data, Samples::U16(expect));
}

#[test]
fn ycbcr_converts_to_rgb() {
    let mut tags = base(3, 1, &[8, 8, 8], 6);
    tags.push((530, V::Short(vec![1, 1])));
    // Gray, BT.601 red, BT.601 blue.
    let strip = vec![128, 128, 128, 76, 85, 255, 29, 255, 107];
    let bytes = write(&[Page::strips(tags, vec![strip])], true);
    assert_eq!(probe(&bytes).unwrap().color_model, ColorModel::YCbCr);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(back.model, ColorModel::Rgb);
    let Samples::U8(v) = back.data else {
        panic!("8-bit")
    };
    assert_eq!(&v[..3], &[128, 128, 128]);
    let close = |a: &[u8], b: [u8; 3]| a.iter().zip(b).all(|(x, y)| x.abs_diff(y) <= 2);
    assert!(close(&v[3..6], [254, 0, 0]), "red {:?}", &v[3..6]);
    assert!(close(&v[6..9], [0, 0, 255]), "blue {:?}", &v[6..9]);
}

#[test]
fn jpeg_compressed_ycbcr_decodes() {
    let (w, h) = (16u32, 16u32);
    let src = image::RgbImage::from_fn(w, h, |x, _| {
        if x < 8 {
            image::Rgb([200, 30, 30])
        } else {
            image::Rgb([30, 30, 200])
        }
    });
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode_image(&src)
        .unwrap();
    let mut tags = base(w, h, &[8, 8, 8], 6);
    set(&mut tags, 259, V::Short(vec![7]));
    tags.push((530, V::Short(vec![2, 2])));
    let bytes = write(&[Page::strips(tags, vec![jpeg])], true);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    let rgba = to_rgba8(&back, &NaiveColour).unwrap();
    let px = |x: u32, y: u32| &rgba.data[((y * w + x) * 4) as usize..][..3];
    for (x, want) in [(2, [200, 30, 30]), (13, [30, 30, 200])] {
        let got = px(x, 8);
        assert!(
            got.iter().zip(want).all(|(a, b)| a.abs_diff(b) <= 16),
            "x={x}: {got:?} vs {want:?}"
        );
    }
}

#[test]
fn icc_lab_and_cie_lab_read_as_lab() {
    // L* 100 a* 0 b* 0 is white, L* 0 is black, in both encodings.
    let icc = write(
        &[Page::strips(
            base(2, 1, &[8, 8, 8], 9),
            vec![vec![255, 128, 128, 0, 128, 128]],
        )],
        true,
    );
    let cie = write(
        &[Page::strips(
            base(2, 1, &[8, 8, 8], 8),
            vec![vec![255, 0, 0, 0, 0, 0]],
        )],
        true,
    );
    for bytes in [icc, cie] {
        let back = decode(&bytes, DecodeOptions::default()).unwrap();
        assert_eq!(back.model, ColorModel::Lab);
        assert_eq!(
            back.data,
            Samples::F32(vec![100.0, 0.0, 0.0, 0.0, 0.0, 0.0])
        );
        let rgba = to_rgba8(&back, &NaiveColour).unwrap();
        assert_eq!(rgba.data, vec![255, 255, 255, 255, 0, 0, 0, 255]);
    }
    // CIE Lab's a* and b* are signed: 0xEC is -20.
    let cie = write(
        &[Page::strips(
            base(1, 1, &[8, 8, 8], 8),
            vec![vec![128, 0xEC, 20]],
        )],
        true,
    );
    let back = decode(&cie, DecodeOptions::default()).unwrap();
    let Samples::F32(v) = back.data else {
        panic!("floats")
    };
    assert_eq!(&v[1..], &[-20.0, 20.0]);
}

#[test]
fn big_endian_files_decode() {
    let (w, h) = (5u32, 3u32);
    let bytes = write(
        &[Page::strips(base(w, h, &[8, 8, 8], 2), vec![rgb8(w, h)])],
        false,
    );
    assert!(bytes.starts_with(b"MM\0*"));
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(back.data, Samples::U8(rgb8(w, h)));
}

#[test]
fn associated_alpha_is_divided_out() {
    let mut tags = base(2, 1, &[8, 8, 8, 8], 2);
    tags.push((338, V::Short(vec![1])));
    // Straight (200, 100, 50) at alpha 128, premultiplied.
    let strip = vec![100, 50, 25, 128, 0, 0, 0, 0];
    let bytes = write(&[Page::strips(tags, vec![strip])], true);
    let back = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(back.alpha, Alpha::Associated);
    let rgba = to_rgba8(&back, &NaiveColour).unwrap();
    assert_eq!(&rgba.data[..4], &[199, 100, 50, 128]);
    assert_eq!(&rgba.data[4..], &[0, 0, 0, 0]);
}

#[test]
fn unsupported_files_name_what_is_missing() {
    let expect = |tags: Vec<(u16, V)>, needle: &str| {
        let bytes = write(&[Page::strips(tags, vec![vec![0; 16]])], true);
        match decode(&bytes, DecodeOptions::default()) {
            Err(Error::Unsupported { what, .. }) => {
                assert!(what.contains(needle), "{what:?} names {needle:?}")
            }
            other => panic!("{needle}: {other:?}"),
        }
    };
    let with = |tag: u16, v: u16, photometric: u16| {
        let mut t = base(2, 2, &[8], photometric);
        set(&mut t, tag, V::Short(vec![v]));
        t
    };
    expect(with(259, 6, 1), "old-style JPEG");
    expect(with(259, 3, 1), "Group 3");
    expect(with(259, 34712, 1), "JPEG 2000");
    expect(with(259, 50000, 1), "Zstandard");
    expect(base(2, 2, &[8], 32844), "LogLuv");
    expect(base(2, 2, &[8], 10), "ITU Lab");
    assert!(matches!(
        paged_raster::probe(b"not an image"),
        Err(Error::UnknownFormat)
    ));
}
