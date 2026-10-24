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

//! DNG, built in the test: a synthetic scene of flat colour patches,
//! mosaiced through an RGGB pattern (or stored as LinearRaw), with a
//! black and white level, an as-shot neutral and a colour matrix that
//! makes camera RGB linear sRGB, so the developed patches are known.
//! The lossless JPEG tiles come from a small encoder below.

use paged_raster::{decode, probe, sniff, ColorModel, DecodeOptions, Error, Format, Samples};

use crate::raw_tiff::{self, Page, V};

/// Lossless JPEG (SOF3) of `w` x `h` pixels of `nc` interleaved samples,
/// `precision` bits, with `predictor` and every symbol coded in 5 bits.
pub fn lj92(
    samples: &[u16],
    w: usize,
    h: usize,
    nc: usize,
    precision: u8,
    predictor: u8,
) -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8];
    // DHT: table 0, 17 symbols (categories 0..=16) of length 5.
    out.extend([0xFF, 0xC4, 0, 2 + 1 + 16 + 17, 0x00]);
    let mut counts = [0u8; 16];
    counts[4] = 17;
    out.extend(counts);
    out.extend(0u8..=16);
    // SOF3.
    let sof_len = 8 + 3 * nc as u16;
    out.extend([0xFF, 0xC3]);
    out.extend(sof_len.to_be_bytes());
    out.push(precision);
    out.extend((h as u16).to_be_bytes());
    out.extend((w as u16).to_be_bytes());
    out.push(nc as u8);
    for c in 0..nc {
        out.extend([c as u8 + 1, 0x11, 0]);
    }
    // SOS.
    out.extend([0xFF, 0xDA]);
    out.extend((6 + 2 * nc as u16).to_be_bytes());
    out.push(nc as u8);
    for c in 0..nc {
        out.extend([c as u8 + 1, 0x00]);
    }
    out.extend([predictor, 0, 0]);
    // Entropy-coded data.
    let mut acc: u64 = 0;
    let mut n = 0u32;
    let put = |out: &mut Vec<u8>, v: u32, bits: u32, acc: &mut u64, n: &mut u32| {
        *acc = (*acc << bits) | u64::from(v & ((1u64 << bits) - 1) as u32);
        *n += bits;
        while *n >= 8 {
            *n -= 8;
            let b = (*acc >> *n) as u8;
            out.push(b);
            if b == 0xFF {
                out.push(0);
            }
        }
    };
    let mask = (1i32 << precision) - 1;
    let row = w * nc;
    for y in 0..h {
        for x in 0..w {
            for c in 0..nc {
                let i = y * row + x * nc + c;
                let s = |j: usize| i32::from(samples[j]);
                let pred = if y == 0 && x == 0 {
                    1 << (precision - 1)
                } else if y == 0 {
                    s(i - nc)
                } else if x == 0 {
                    s(i - row)
                } else {
                    let (a, b, cc) = (s(i - nc), s(i - row), s(i - row - nc));
                    match predictor {
                        1 => a,
                        2 => b,
                        3 => cc,
                        4 => a + b - cc,
                        5 => a + ((b - cc) >> 1),
                        6 => b + ((a - cc) >> 1),
                        _ => (a + b) >> 1,
                    }
                };
                // The difference modulo 2^16, as T.81 takes it.
                let mut diff = (s(i) - pred) & mask;
                if diff >= (mask + 1) / 2 {
                    diff -= mask + 1;
                }
                let diff = diff.clamp(-32768, 32767);
                let ssss = if diff == 0 {
                    0
                } else {
                    32 - diff.unsigned_abs().leading_zeros()
                };
                put(&mut out, ssss, 5, &mut acc, &mut n);
                if ssss > 0 && ssss < 16 {
                    let v = if diff < 0 {
                        diff + (1 << ssss) - 1
                    } else {
                        diff
                    };
                    put(&mut out, v as u32, ssss, &mut acc, &mut n);
                }
            }
        }
    }
    if n > 0 {
        let pad = 8 - n;
        put(&mut out, (1 << pad) - 1, pad, &mut acc, &mut n);
    }
    out.extend([0xFF, 0xD9]);
    out
}

/// The scene: four 8x8 patches of linear sRGB.
const PATCHES: [[f32; 3]; 4] = [
    [0.50, 0.10, 0.05],
    [0.05, 0.40, 0.10],
    [0.10, 0.10, 0.60],
    [0.30, 0.30, 0.30],
];
const W: usize = 16;
const H: usize = 16;
const BLACK: f32 = 64.0;
const WHITE: f32 = 4095.0;
const NEUTRAL: [f32; 3] = [0.5, 1.0, 0.8];

fn scene(x: usize, y: usize) -> [f32; 3] {
    PATCHES[(y / 8) * 2 + x / 8]
}

/// Raw camera value of colour `c` at a pixel: the scene times the
/// neutral (what the camera sees of it), black to white.
fn raw(x: usize, y: usize, c: usize) -> u16 {
    (BLACK + scene(x, y)[c] * NEUTRAL[c] * (WHITE - BLACK)).round() as u16
}

/// RGGB.
fn colour_at(x: usize, y: usize) -> usize {
    match (y % 2, x % 2) {
        (0, 0) => 0,
        (1, 1) => 2,
        _ => 1,
    }
}

/// XYZ to camera so that camera RGB is linear sRGB: the inverse of
/// sRGB-to-XYZ, as SRATIONALs over 10000.
fn colour_matrix() -> V {
    let m = [
        [3.240_479f64, -1.537_150, -0.498_535],
        [-0.969_256, 1.875_992, 0.041_556],
        [0.055_648, -0.204_043, 1.057_311],
    ];
    V::SRational(
        m.iter()
            .flatten()
            .map(|v| ((v * 10000.0).round() as i32, 10000))
            .collect(),
    )
}

fn dng_tags(w: u32, h: u32, photometric: u16, spp: u16) -> Vec<(u16, V)> {
    let mut t = raw_tiff::base(w, h, &vec![16; spp as usize], photometric);
    raw_tiff::set(&mut t, 254, V::Long(vec![0]));
    raw_tiff::set(&mut t, 50706, V::Byte(vec![1, 4, 0, 0]));
    raw_tiff::set(&mut t, 50714, V::Long(vec![BLACK as u32]));
    raw_tiff::set(&mut t, 50717, V::Long(vec![WHITE as u32]));
    raw_tiff::set(&mut t, 50721, colour_matrix());
    raw_tiff::set(&mut t, 50778, V::Short(vec![21]));
    raw_tiff::set(
        &mut t,
        50728,
        V::Rational(
            NEUTRAL
                .iter()
                .map(|v| ((v * 1000.0) as u32, 1000))
                .collect(),
        ),
    );
    if photometric == 32803 {
        raw_tiff::set(&mut t, 33421, V::Short(vec![2, 2]));
        raw_tiff::set(&mut t, 33422, V::Byte(vec![0, 1, 1, 2]));
    }
    t
}

fn cfa_samples() -> Vec<u16> {
    (0..H)
        .flat_map(|y| (0..W).map(move |x| raw(x, y, colour_at(x, y))))
        .collect()
}

fn le16(v: &[u16]) -> Vec<u8> {
    v.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn cfa_dng() -> Vec<u8> {
    raw_tiff::write(
        &[Page::strips(
            dng_tags(W as u32, H as u32, 32803, 1),
            vec![le16(&cfa_samples())],
        )],
        true,
    )
}

fn srgb(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Every pixel at least one away from a patch edge develops to its patch.
fn assert_patches(samples: &Samples, w: usize, tolerance: f32) {
    let Samples::U16(v) = samples else {
        panic!("16-bit samples expected");
    };
    for y in 0..H {
        for x in 0..W {
            let interior = (x % 8) >= 1 && (x % 8) <= 6 && (y % 8) >= 1 && (y % 8) <= 6;
            if !interior {
                continue;
            }
            for c in 0..3 {
                let got = f32::from(v[(y * w + x) * 3 + c]) / 65535.0;
                let want = srgb(scene(x, y)[c]);
                assert!(
                    (got - want).abs() <= tolerance,
                    "pixel {x},{y} channel {c}: {got} vs {want}"
                );
            }
        }
    }
}

#[test]
fn cfa_dng_develops_to_the_scene__feat__images_graphics_format_extensions() {
    let bytes = cfa_dng();
    assert_eq!(sniff(&bytes), Some(Format::Dng));
    let info = probe(&bytes).unwrap();
    assert_eq!(
        (info.format, info.width, info.height),
        (Format::Dng, 16, 16)
    );
    assert_eq!(info.color_model, ColorModel::Rgb);
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(
        (img.width, img.height, img.model),
        (16, 16, ColorModel::Rgb)
    );
    assert_patches(&img.data, W, 0.01);
}

#[test]
fn lossless_jpeg_tiles_decode_as_the_uncompressed_strips() {
    let plain = decode(&cfa_dng(), DecodeOptions::default()).unwrap();
    let samples = cfa_samples();
    // Two 8x16 tiles, each coded as a 4-wide frame of 2 components, the
    // way DNG writers code CFA tiles.
    let mut tiles = Vec::new();
    for tx in 0..2 {
        let tile: Vec<u16> = (0..H)
            .flat_map(|y| samples[y * W + tx * 8..y * W + tx * 8 + 8].to_vec())
            .collect();
        tiles.push(lj92(&tile, 4, H, 2, 16, 1));
    }
    let mut tags = dng_tags(W as u32, H as u32, 32803, 1);
    raw_tiff::set(&mut tags, 259, V::Short(vec![7]));
    raw_tiff::set(&mut tags, 322, V::Long(vec![8]));
    raw_tiff::set(&mut tags, 323, V::Long(vec![H as u32]));
    let bytes = raw_tiff::write(&[Page::tiles(tags, tiles)], true);
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(img.data, plain.data);
}

#[test]
fn raw_image_in_a_sub_ifd_behind_a_preview() {
    // IFD0 a small RGB preview (NewSubFileType 1) naming the raw IFD as
    // its SubIFD; the colour tags live on IFD0.
    let mut preview = raw_tiff::base(2, 2, &[8, 8, 8], 2);
    raw_tiff::set(&mut preview, 254, V::Long(vec![1]));
    raw_tiff::set(&mut preview, 50706, V::Byte(vec![1, 4, 0, 0]));
    raw_tiff::set(&mut preview, 50721, colour_matrix());
    raw_tiff::set(
        &mut preview,
        50728,
        V::Rational(
            NEUTRAL
                .iter()
                .map(|v| ((v * 1000.0) as u32, 1000))
                .collect(),
        ),
    );
    let mut raw_tags = dng_tags(W as u32, H as u32, 32803, 1);
    raw_tags.retain(|(t, _)| !matches!(*t, 50706 | 50721 | 50728 | 50778));
    // Crop one pixel off each edge.
    raw_tiff::set(&mut raw_tags, 50719, V::Long(vec![1, 1]));
    raw_tiff::set(&mut raw_tags, 50720, V::Long(vec![14, 14]));
    let build = |sub: u32| {
        let mut p = preview.clone();
        raw_tiff::set(&mut p, 330, V::Long(vec![sub]));
        raw_tiff::write(
            &[
                Page::strips(p, vec![vec![200; 12]]),
                Page::strips(raw_tags.clone(), vec![le16(&cfa_samples())]),
            ],
            true,
        )
    };
    // The second IFD's offset does not depend on the SubIFDs value.
    let first = build(0);
    let h = u32::from_le_bytes(first[4..8].try_into().unwrap()) as usize;
    let n = u16::from_le_bytes(first[h..h + 2].try_into().unwrap()) as usize;
    let second = u32::from_le_bytes(first[h + 2 + n * 12..h + 6 + n * 12].try_into().unwrap());
    let bytes = build(second);
    let info = probe(&bytes).unwrap();
    assert_eq!((info.width, info.height), (14, 14));
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!((img.width, img.height), (14, 14));
    // The crop shifts the patches by one pixel; the centre of the first
    // patch is still its colour.
    let Samples::U16(v) = &img.data else { panic!() };
    let got = f32::from(v[(3 * 14 + 3) * 3]) / 65535.0;
    assert!((got - srgb(PATCHES[0][0])).abs() < 0.01, "{got}");
}

#[test]
fn linear_raw_dng_skips_the_demosaic() {
    let samples: Vec<u16> = (0..H)
        .flat_map(|y| (0..W).flat_map(move |x| (0..3).map(move |c| raw(x, y, c))))
        .collect();
    let bytes = raw_tiff::write(
        &[Page::strips(
            dng_tags(W as u32, H as u32, 34892, 3),
            vec![le16(&samples)],
        )],
        true,
    );
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    let Samples::U16(v) = &img.data else { panic!() };
    // No interpolation: every pixel, edges included, is its patch.
    for y in 0..H {
        for x in 0..W {
            for c in 0..3 {
                let got = f32::from(v[(y * W + x) * 3 + c]) / 65535.0;
                assert!((got - srgb(scene(x, y)[c])).abs() < 0.005);
            }
        }
    }
    let half = decode(
        &bytes,
        DecodeOptions {
            page: 0,
            max_dim: Some(8),
        },
    )
    .unwrap();
    assert_eq!((half.width, half.height), (8, 8));
}

#[test]
fn twelve_bit_packed_samples_unpack() {
    // The same mosaic stored as packed 12-bit big-endian samples.
    let samples = cfa_samples();
    let mut packed = Vec::new();
    for pair in samples.chunks(2) {
        let (a, b) = (u32::from(pair[0]), u32::from(pair[1]));
        let v = (a << 12) | b;
        packed.extend([(v >> 16) as u8, (v >> 8) as u8, v as u8]);
    }
    let mut tags = dng_tags(W as u32, H as u32, 32803, 1);
    raw_tiff::set(&mut tags, 258, V::Short(vec![12]));
    let bytes = raw_tiff::write(&[Page::strips(tags, vec![packed])], false);
    let plain = decode(&cfa_dng(), DecodeOptions::default()).unwrap();
    assert_eq!(
        decode(&bytes, DecodeOptions::default()).unwrap().data,
        plain.data
    );
}

#[test]
fn unsupported_compressions_are_named() {
    let mut tags = dng_tags(W as u32, H as u32, 32803, 1);
    raw_tiff::set(&mut tags, 259, V::Short(vec![52546]));
    let bytes = raw_tiff::write(&[Page::strips(tags, vec![vec![0; 16]])], true);
    match decode(&bytes, DecodeOptions::default()) {
        Err(Error::Unsupported { format, what }) => {
            assert_eq!(format, Format::Dng);
            assert!(what.contains("JPEG XL"), "{what}");
        }
        other => panic!("{other:?}"),
    }
}
