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

//! The LAYERED PSD save (image ADR 478) over files Photoshop wrote
//! (`image-conformance/fixtures/photoshop/`): an unedited layer is written
//! as the record it was read from, byte for byte — smart objects, 16-bit,
//! CMYK and PSB documents included; an edited one keeps every block its
//! edit leaves true; and every adjustment kind Photoshop has a layer for
//! is written and read back.

use std::path::PathBuf;
use std::sync::Arc;

use image_core::Region;
use image_js::layers::{Adjustment, LayerStack, ADJUSTMENT_KINDS};
use image_js::pixels::Pixels;
use image_js::saveback::{psd_write_stack, PsdSaveBackShape};
use image_psd::model::{ColorMode, Compression, LayerRecord};
use image_psd::{Container, PsdFile};

fn fixture(rel: &str) -> PsdFile {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../image-conformance/fixtures/photoshop")
        .join(rel);
    PsdFile::parse(&std::fs::read(&p).expect("fixture")).expect("parse")
}

/// The layered import, as `layers_open_from_psd` makes it (CMYK through
/// the document's profile).
fn open(file: &PsdFile) -> LayerStack {
    let import = if file.header.color_mode == ColorMode::Cmyk {
        let ink = image_js::ingest::psd_ink_transform(file);
        file.layer_plates_rgba8_via(&|c| ink.to_rgba8(c))
    } else {
        file.layer_plates_rgba8()
    }
    .expect("imports as layers");
    LayerStack::from_psd_plates_with(&import, Some(&file.layer_mask.layers)).expect("stack")
}

fn composite(file: &PsdFile) -> Vec<u8> {
    vec![128u8; file.header.width as usize * file.header.height as usize * 4]
}

fn save(file: &PsdFile, stack: &LayerStack) -> PsdFile {
    let mut out = file.clone();
    assert_eq!(
        psd_write_stack(&mut out, stack, &composite(file)).expect("layered save"),
        PsdSaveBackShape::Layered
    );
    PsdFile::parse(&out.write().expect("bytes")).expect("the save parses")
}

fn key_names(r: &LayerRecord) -> Vec<String> {
    r.addl
        .iter()
        .map(|a| String::from_utf8_lossy(&a.key).into_owned())
        .collect()
}

const UNEDITED: [&str; 6] = [
    "psd-containers/smart-embedded.psd",
    "psd-containers/sixteen-bit.psd",
    "psd-containers/cmyk.psd",
    "psd-containers/psb.psb",
    "adjustment-layers-ext/channel-mixer.psd",
    "adjustment-layers/curves-channels.psd",
];

/// Opened as layers and saved WITHOUT an edit, every record Photoshop
/// wrote comes back unchanged — its smart-object, adjustment, metadata
/// and every other block, its channel payloads — and the document blocks
/// (`lnk2`) stay.
#[test]
fn unedited_photoshop_layers_are_written_as_read__feat__image_psd_mutatable() {
    for rel in UNEDITED {
        let file = fixture(rel);
        let back = save(&file, &open(&file));
        assert_eq!(back.container, file.container, "{rel}");
        assert_eq!(back.header.depth, file.header.depth, "{rel}");
        assert_eq!(back.header.color_mode, file.header.color_mode, "{rel}");
        assert_eq!(back.layer_mask.deep_key, file.layer_mask.deep_key, "{rel}");
        assert_eq!(back.layer_mask.layers.len(), file.layer_mask.layers.len());
        for (a, b) in back.layer_mask.layers.iter().zip(&file.layer_mask.layers) {
            assert_eq!(a.extra_raw, b.extra_raw, "{rel}: {}", b.name());
            assert_eq!(a.channel_data, b.channel_data, "{rel}: {}", b.name());
            assert_eq!(a.channels, b.channels, "{rel}: {}", b.name());
        }
        let keys = |f: &PsdFile| -> Vec<[u8; 4]> {
            f.layer_mask.addl_global.iter().map(|a| a.key).collect()
        };
        assert_eq!(keys(&back), keys(&file), "{rel}: document blocks");
    }
}

/// A smart object whose opacity and name change keeps its placement and
/// source (`PlLd`, `SoLd`) and its pixels; painting on it makes it the
/// pixels it now has.
#[test]
fn an_edited_smart_object_keeps_its_source_until_its_pixels_change__feat__image_psd_mutatable() {
    let file = fixture("psd-containers/smart-embedded.psd");
    let mut stack = open(&file);
    let i = stack
        .layers()
        .iter()
        .position(|l| l.name == "square")
        .expect("the smart object");
    stack.set_opacity(i, 0.5).expect("opacity");
    stack.set_name(i, "square, renamed").expect("name");
    let back = save(&file, &stack);
    let (was, rec) = (&file.layer_mask.layers[i], &back.layer_mask.layers[i]);
    assert_eq!(rec.opacity, 128);
    assert_eq!(rec.name(), "square, renamed");
    assert!(
        key_names(rec).contains(&"PlLd".into()),
        "{:?}",
        key_names(rec)
    );
    assert!(key_names(rec).contains(&"SoLd".into()));
    assert_eq!(rec.channel_data, was.channel_data, "the pixels are kept");
    assert_eq!(
        key_names(rec).len(),
        key_names(was).len(),
        "nothing else moved"
    );

    stack.set_active(i).expect("active");
    let (w, h) = (stack.width(), stack.height());
    let red: Vec<u8> = (0..w * h).flat_map(|_| [255u8, 0, 0, 255]).collect();
    stack
        .edit_active(
            "paint",
            Region::new(0, 0, w, h),
            Pixels::from_rgba8(Arc::from(red.into_boxed_slice())),
        )
        .expect("paint");
    let back = save(&file, &stack);
    let rec = &back.layer_mask.layers[i];
    let keys = key_names(rec);
    assert!(
        !keys.contains(&"PlLd".into()) && !keys.contains(&"SoLd".into()),
        "{keys:?}"
    );
    assert!(keys.contains(&"lyid".into()), "its id stays: {keys:?}");
    let import = back.layer_plates_rgba8().expect("imports");
    let plate = &import.layers[i];
    assert!(!plate.smart, "a pixel layer now");
    assert_eq!(&plate.rgba[..4], &[255, 0, 0, 255]);
}

/// A 16-bit document's edited layer is written at 16 bits into its
/// `Lr16` block (ZIP with prediction), the composite RAW.
#[test]
fn a_sixteen_bit_document_is_written_at_sixteen_bits__feat__image_psd_mutatable() {
    let file = fixture("psd-containers/sixteen-bit.psd");
    let mut stack = open(&file);
    let i = stack
        .layers()
        .iter()
        .position(|l| l.name == "square")
        .expect("the square");
    stack.set_active(i).expect("active");
    let (w, h) = (stack.width(), stack.height());
    let px: Vec<u8> = (0..w * h).flat_map(|_| [10u8, 20, 30, 255]).collect();
    stack
        .edit_active(
            "paint",
            Region::new(0, 0, w, h),
            Pixels::from_rgba8(Arc::from(px.into_boxed_slice())),
        )
        .expect("paint");
    let back = save(&file, &stack);
    assert_eq!(back.header.depth, 16);
    assert_eq!(back.layer_mask.deep_key, Some(*b"Lr16"));
    assert_eq!(back.composite.compression, Compression::Raw.code());
    let rec = &back.layer_mask.layers[i];
    let green = rec.channels.iter().position(|c| c.id == 1).expect("green");
    let cd = &rec.channel_data[green];
    assert_eq!(cd.compression, Compression::ZipPrediction);
    let rows = (rec.bottom - rec.top) as u32;
    let cols = (rec.right - rec.left) as u32;
    let samples = cd.decode_samples16(rows, cols).expect("16-bit samples");
    assert!(samples.iter().all(|&s| s == 20 * 257));
    // The unedited background is the record Photoshop wrote.
    assert_eq!(
        back.layer_mask.layers[0].channel_data,
        file.layer_mask.layers[0].channel_data
    );
}

/// A CMYK document's edited layer is converted to ink through the
/// document's profile and stored inverted.
#[test]
fn a_cmyk_documents_new_pixels_are_written_as_ink__feat__image_psd_mutatable() {
    let file = fixture("psd-containers/cmyk.psd");
    let mut stack = open(&file);
    let i = stack
        .layers()
        .iter()
        .position(|l| l.name == "square")
        .expect("the square");
    stack.set_active(i).expect("active");
    let (w, h) = (stack.width(), stack.height());
    let px: Vec<u8> = (0..w * h).flat_map(|_| [255u8, 255, 255, 255]).collect();
    stack
        .edit_active(
            "paint",
            Region::new(0, 0, w, h),
            Pixels::from_rgba8(Arc::from(px.into_boxed_slice())),
        )
        .expect("paint");
    let back = save(&file, &stack);
    assert_eq!(back.header.color_mode, ColorMode::Cmyk);
    assert_eq!(back.header.channels, 5);
    let rec = &back.layer_mask.layers[i];
    let ids: Vec<i16> = rec.channels.iter().map(|c| c.id).collect();
    assert_eq!(ids, [-1, 0, 1, 2, 3]);
    let rows = (rec.bottom - rec.top) as u32;
    let cols = (rec.right - rec.left) as u32;
    // White is no ink: every plane stored 255.
    for k in 1..5 {
        let plane = rec.channel_data[k]
            .decode(Container::Psd, rows, cols, 8)
            .expect("plane");
        assert!(plane.iter().all(|&v| v >= 254), "plane {k}");
    }
    // And it reopens as layers, white.
    let again = open(&back);
    let l = &again.layers()[i];
    assert!(l
        .rgba
        .to_rgba8()
        .chunks(4)
        .all(|p| p[0] >= 250 && p[3] == 255));
}

/// A PSB stays a PSB: its edited layer is written with the widened fields.
#[test]
fn a_psb_is_written_as_a_psb__feat__image_psd_mutatable() {
    let file = fixture("psd-containers/psb.psb");
    assert_eq!(file.container, Container::Psb);
    let mut stack = open(&file);
    stack.set_opacity(1, 0.25).expect("opacity");
    stack.add("new");
    let back = save(&file, &stack);
    assert_eq!(back.container, Container::Psb);
    assert_eq!(back.layer_mask.layers[1].opacity, 64);
    assert_eq!(
        back.layer_mask.layers.len(),
        file.layer_mask.layers.len() + 1
    );
    let again = open(&back);
    assert_eq!(again.layers().len(), stack.layers().len());
}

/// Every adjustment kind Photoshop has an adjustment layer for is written
/// and reads back as the same adjustment.
#[test]
fn every_adjustment_kind_round_trips_through_a_layered_psd__feat__image_psd_mutatable() {
    let solid = Arc::from(vec![90u8; 4 * 2 * 4].into_boxed_slice());
    let mut s = LayerStack::from_image(4, 2, solid).expect("stack");
    let mut kinds = Vec::new();
    for kind in ADJUSTMENT_KINDS {
        if matches!(kind, "develop" | "colorLookup") {
            continue;
        }
        let mut a = Adjustment::default_for(kind).expect("kind");
        // Off the defaults where a default would hide a field.
        match &mut a {
            Adjustment::BrightnessContrast {
                brightness,
                contrast,
            } => {
                *brightness = 30.0;
                *contrast = -20.0;
            }
            Adjustment::Vibrance {
                vibrance,
                saturation,
            } => {
                *vibrance = 40.0;
                *saturation = -15.0;
            }
            Adjustment::ColorBalance { midtones, .. } => *midtones = [10.0, -20.0, 30.0],
            Adjustment::ChannelMixer { rows, .. } => rows[1] = [10.0, 70.0, 20.0, 5.0],
            Adjustment::SelectiveColor { ranges, absolute } => {
                ranges[0] = [10.0, -20.0, 30.0, 0.0];
                ranges[8] = [0.0, 0.0, 0.0, 20.0];
                *absolute = true;
            }
            Adjustment::Posterize { levels } => *levels = 6.0,
            Adjustment::Threshold { level } => *level = 140.0,
            _ => {}
        }
        s.add_adjustment_layer("", a.clone(), None);
        kinds.push(a);
    }
    let file = {
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"8BPS\x00\x01\x00\x00\x00\x00\x00\x00\x00\x03");
        b.extend_from_slice(&2u32.to_be_bytes());
        b.extend_from_slice(&4u32.to_be_bytes());
        b.extend_from_slice(&8u16.to_be_bytes());
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&[0; 12]);
        b.extend_from_slice(&[0, 0]);
        b.extend_from_slice(&[9u8; 24]);
        PsdFile::parse(&b).expect("seed")
    };
    let back = save(&file, &s);
    // Read through paged-psd's reader and the stack's mapping (the import
    // DRAWS only the kinds it reproduces; every kind is read).
    assert_eq!(back.layer_mask.layers.len(), kinds.len() + 1);
    for (rec, want) in back.layer_mask.layers[1..].iter().zip(&kinds) {
        let blocks: Vec<([u8; 4], Vec<u8>)> = rec
            .addl
            .iter()
            .filter_map(|a| {
                let raw = a.raw_block.as_deref()?;
                let n = u32::from_be_bytes(raw[8..12].try_into().ok()?) as usize;
                Some((a.key, raw[12..12 + n].to_vec()))
            })
            .collect();
        let psd = image_psd::adjustment::Adjustment::from_blocks(
            blocks.iter().map(|(k, v)| (k, v.as_slice())),
        )
        .expect("reads")
        .unwrap_or_else(|| panic!("{} has no adjustment", rec.name()));
        assert_eq!(psd.unmodelled(), None, "{}", rec.name());
        let got = image_js::layers::psd_adjustment(&psd);
        match (&got, want) {
            // Through Lab and back: within a level.
            (
                Adjustment::PhotoFilter { color: a, .. },
                Adjustment::PhotoFilter { color: b, .. },
            ) => assert!(
                a.iter().zip(b).all(|(x, y)| x.abs_diff(*y) <= 1),
                "{a:?} {b:?}"
            ),
            (g, w) => assert_eq!(g, w),
        }
    }
}
