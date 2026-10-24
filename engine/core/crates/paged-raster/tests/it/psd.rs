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

//! PSD and PSB through paged-psd: the probe's facts, the merged
//! composite in RGB, Grayscale and CMYK (through the file's profile),
//! transparency, 16 bits, the shrink, the layer count of a PSD and of a
//! layered TIFF. The files are written by paged-psd's own writer.

use paged_psd::model::{
    ColorMode, ColorModeData, FileHeader, GlobalImageData, ImageResourceBlock, ImageResources,
    LayerAndMaskInfo, PascalString, PsdFile, ResourceBody,
};
use paged_psd::Container;
use paged_raster::{
    decode, decode_rgba8, probe, Alpha, ColorModel, DecodeOptions, Error, Format, SampleFormat,
    Samples,
};
use paged_test_resources::{skip, Resource};

use crate::raw_tiff::{base, write, Page, V};

const ANNUAL: &[u8] = include_bytes!("../../../paged-psd/tests/fixtures/annual-layers.psd");

/// A PSD (or PSB) with no layers whose RAW composite holds `planes`
/// (one per channel, each `w * h` samples of `depth / 8` bytes, big-endian).
pub fn psd(
    container: Container,
    mode: ColorMode,
    depth: u16,
    w: u32,
    h: u32,
    planes: &[Vec<u8>],
    transparency: bool,
    icc: Option<Vec<u8>>,
) -> Vec<u8> {
    let blocks = icc
        .map(|p| ImageResourceBlock {
            id: 1039,
            name: PascalString::new(""),
            body: ResourceBody::IccProfile(p),
            raw_block: None,
        })
        .into_iter()
        .collect();
    PsdFile {
        container,
        header: FileHeader {
            channels: planes.len() as u16,
            height: h,
            width: w,
            depth,
            color_mode: mode,
        },
        color_mode: ColorModeData::default(),
        resources: ImageResources { blocks },
        // The transparency flag is the sign of the layer count, so a file
        // that has it needs layers: the annual fixture's lend theirs.
        layer_mask: if transparency {
            LayerAndMaskInfo {
                transparency_in_merged: true,
                section_raw: None,
                ..PsdFile::parse(ANNUAL).unwrap().layer_mask
            }
        } else {
            LayerAndMaskInfo::default()
        },
        composite: GlobalImageData {
            compression: 0,
            raw: planes.concat(),
        },
    }
    .write()
    .unwrap()
}

fn rgba(bytes: &[u8]) -> Vec<u8> {
    decode_rgba8(bytes, None).unwrap().data
}

#[test]
fn a_psd_probes_and_decodes_its_merged_composite__feat__images_graphics_placed_psd() {
    let bytes = psd(
        Container::Psd,
        ColorMode::Rgb,
        8,
        2,
        1,
        &[vec![10, 20], vec![30, 40], vec![50, 60]],
        false,
        None,
    );
    let info = probe(&bytes).unwrap();
    assert_eq!(info.format, Format::Psd);
    assert_eq!((info.width, info.height), (2, 1));
    assert_eq!((info.channels, info.bits_per_sample), (3, 8));
    assert_eq!(info.sample_format, SampleFormat::UInt);
    assert_eq!(info.color_model, ColorModel::Rgb);
    assert_eq!(info.alpha, Alpha::None);
    assert!(!info.has_layers);
    assert_eq!(info.layer_count, Some(0));
    assert_eq!(info.page_count, 1);

    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!((img.model, img.alpha), (ColorModel::Rgb, Alpha::None));
    assert_eq!(img.data, Samples::U8(vec![10, 30, 50, 20, 40, 60]));
    assert_eq!(rgba(&bytes), [10, 30, 50, 255, 20, 40, 60, 255]);
}

#[test]
fn a_psb_decodes_the_same_way__feat__images_graphics_placed_psd() {
    let planes = [vec![1, 2, 3, 4], vec![5, 6, 7, 8], vec![9, 10, 11, 12]];
    let psb = psd(
        Container::Psb,
        ColorMode::Rgb,
        8,
        2,
        2,
        &planes,
        false,
        None,
    );
    assert_eq!(&psb[4..6], &[0, 2], "a PSB (version 2)");
    let flat = psd(
        Container::Psd,
        ColorMode::Rgb,
        8,
        2,
        2,
        &planes,
        false,
        None,
    );
    assert_eq!(probe(&psb).unwrap().format, Format::Psd);
    assert_eq!(rgba(&psb), rgba(&flat));
}

#[test]
fn transparency_is_straight_alpha_and_the_white_matte_is_undone() {
    // One pixel at alpha 128, stored matted against white: 0 red becomes
    // 255 * (1 - 128/255) = 127.
    let bytes = psd(
        Container::Psd,
        ColorMode::Rgb,
        8,
        1,
        1,
        &[vec![127], vec![255], vec![255], vec![128]],
        true,
        None,
    );
    let info = probe(&bytes).unwrap();
    assert_eq!(info.alpha, Alpha::Unassociated);
    assert_eq!(info.layer_count, Some(3));
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(img.channels(), 4);
    assert_eq!(rgba(&bytes), [0, 255, 255, 128]);
}

#[test]
fn a_sixteen_bit_gray_psd_is_reduced_to_its_high_bytes() {
    let plane = [0x12u8, 0x34, 0xAB, 0xCD].to_vec();
    let bytes = psd(
        Container::Psd,
        ColorMode::Grayscale,
        16,
        2,
        1,
        &[plane],
        false,
        None,
    );
    let info = probe(&bytes).unwrap();
    assert_eq!(
        (info.color_model, info.bits_per_sample),
        (ColorModel::Gray, 16)
    );
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(img.model, ColorModel::Gray);
    assert_eq!(img.data, Samples::U8(vec![0x12, 0xAB]));
    assert_eq!(rgba(&bytes), [0x12, 0x12, 0x12, 255, 0xAB, 0xAB, 0xAB, 255]);
}

/// CMYK planes are stored inverted (255 = no ink).
fn cmyk_psd(ink: [u8; 4], icc: Option<Vec<u8>>) -> Vec<u8> {
    let planes: Vec<Vec<u8>> = ink.iter().map(|&v| vec![255 - v; 4]).collect();
    psd(
        Container::Psd,
        ColorMode::Cmyk,
        8,
        2,
        2,
        &planes,
        false,
        icc,
    )
}

#[test]
fn a_profile_less_cmyk_psd_takes_the_device_formula() {
    let bytes = cmyk_psd([255, 0, 0, 0], None);
    let img = decode(&bytes, DecodeOptions::default()).unwrap();
    assert_eq!(img.model, ColorModel::Cmyk);
    assert_eq!(&rgba(&bytes)[..4], &[0, 255, 255, 255]);
}

#[test]
fn a_cmyk_psd_converts_through_its_embedded_profile__feat__images_graphics_placed_psd() {
    let Some(profile) = paged_color::test_profiles::read_cmyk_profile(env!("CARGO_MANIFEST_DIR"))
    else {
        skip!(
            Resource::Icc,
            "{}",
            paged_color::test_profiles::NO_PROFILE_HINT
        );
    };
    let ink = [20u8, 180, 60, 30];
    let bytes = cmyk_psd(ink, Some(profile.clone()));
    assert_eq!(probe(&bytes).unwrap().icc.as_deref(), Some(&profile[..]));
    let mut want = [[0u8; 3]];
    paged_color::IccTransform::cmyk_to_linear_rgb(&profile)
        .unwrap()
        .cmyk_bytes_to_rgb_bytes(&[ink], &mut want);
    assert_eq!(&rgba(&bytes)[..3], &want[0]);
}

#[test]
fn a_large_psd_is_shrunk_to_max_dim() {
    let plane: Vec<u8> = (0..16).map(|i| i * 10).collect();
    let bytes = psd(
        Container::Psd,
        ColorMode::Grayscale,
        8,
        4,
        4,
        &[plane],
        false,
        None,
    );
    let img = decode(
        &bytes,
        DecodeOptions {
            page: 0,
            max_dim: Some(2),
        },
    )
    .unwrap();
    assert_eq!((img.width, img.height), (2, 2));
    assert_eq!((img.info.width, img.info.height), (4, 4));
    // The top-left box: 0, 10, 40, 50.
    assert_eq!(img.data, Samples::U8(vec![25, 45, 105, 125]));
    assert_eq!(decode_rgba8(&bytes, Some(2)).unwrap().width, 2);
}

#[test]
fn a_layered_psd_reports_its_layers_and_decodes_its_composite__feat__images_graphics_placed_psd() {
    let info = probe(ANNUAL).unwrap();
    assert!(info.has_layers);
    assert_eq!(info.layer_count, Some(3));
    assert_eq!((info.width, info.height), (400, 300));
    let want = PsdFile::parse(ANNUAL).unwrap().composite_rgba8().unwrap();
    assert_eq!(rgba(ANNUAL), want.rgba);
}

#[test]
fn what_the_composite_decoder_does_not_read_is_refused_by_name() {
    let lab = psd(
        Container::Psd,
        ColorMode::Lab,
        8,
        1,
        1,
        &[vec![50], vec![128], vec![128]],
        false,
        None,
    );
    assert_eq!(probe(&lab).unwrap().color_model, ColorModel::Lab);
    match decode(&lab, DecodeOptions::default()) {
        Err(Error::Unsupported { format, what }) => {
            assert_eq!(format, Format::Psd);
            assert!(what.contains("Lab"), "{what}");
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        decode(
            &lab,
            DecodeOptions {
                page: 1,
                max_dim: None
            }
        ),
        Err(Error::PageOutOfRange { page: 1, count: 1 })
    ));
    assert!(matches!(
        decode(b"8BPS\0\x01rest", DecodeOptions::default()),
        Err(Error::Malformed { .. })
    ));
}

/// The annual fixture's layer info body (after its length field).
fn annual_layer_info() -> &'static [u8] {
    let u32_at = |at: usize| u32::from_be_bytes(ANNUAL[at..at + 4].try_into().unwrap()) as usize;
    let mut at = 26;
    at += 4 + u32_at(at);
    at += 4 + u32_at(at);
    let len = u32_at(at + 4);
    &ANNUAL[at + 8..at + 8 + len]
}

fn layered_tiff(source_data: Vec<u8>) -> Vec<u8> {
    let mut tags = base(2, 2, &[8], 1);
    tags.push((37724, V::Undefined(source_data)));
    write(&[Page::strips(tags, vec![vec![1, 2, 3, 4]])], false)
}

#[test]
fn a_layered_tiff_reports_the_layers_of_its_image_source_data__feat__images_graphics_placed_psd() {
    let body = annual_layer_info();
    let mut data = paged_psd::IMAGE_SOURCE_DATA_SIGNATURE.to_vec();
    data.extend_from_slice(b"8BIMLayr");
    data.extend_from_slice(&(body.len() as u32).to_be_bytes());
    data.extend_from_slice(body);
    while !data.len().is_multiple_of(4) {
        data.push(0);
    }
    let tiff = layered_tiff(data);
    let info = probe(&tiff).unwrap();
    assert!(info.has_layers);
    assert_eq!(info.layer_count, Some(3));
    // The TIFF's own (flattened) image is what decodes.
    let img = decode(&tiff, DecodeOptions::default()).unwrap();
    assert_eq!(img.data, Samples::U8(vec![1, 2, 3, 4]));
}

#[test]
fn unreadable_tiff_layer_data_is_reported_as_unknown() {
    let mut data = paged_psd::IMAGE_SOURCE_DATA_SIGNATURE.to_vec();
    data.extend_from_slice(b"MIB8ryaL\0\0\0\0");
    let info = probe(&layered_tiff(data)).unwrap();
    assert!(info.has_layers);
    assert_eq!(info.layer_count, None);
    let plain = layered_tiff(paged_psd::IMAGE_SOURCE_DATA_SIGNATURE.to_vec());
    assert_eq!(probe(&plain).unwrap().layer_count, Some(0));
}
