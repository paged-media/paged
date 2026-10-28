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

//! PHOTOSHOP-WRITTEN ADJUSTMENT BLOCKS, read and re-written.
//! `scripts/photoshop/probes/adjustment-layers.jsx` and
//! `adjustment-layers-ext.jsx` had Photoshop 27.10 make one adjustment
//! layer of each kind with known parameters. For each: paged-psd reads the
//! block(s) to exactly those parameters, and writes them back BYTE FOR
//! BYTE as Photoshop wrote them (`Adjustment::to_blocks`, image ADR 478) —
//! so a layer paged writes is the block Photoshop would.

use std::path::PathBuf;

use image_psd::adjustment::{Adjustment, FilterColor};
use image_psd::model::AdditionalLayerInfo;
use image_psd::PsdFile;

fn layer(rel: &str) -> Vec<AdditionalLayerInfo> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/photoshop")
        .join(rel);
    let file = PsdFile::parse(&std::fs::read(p).expect("fixture")).expect("parse");
    // The adjustment layer is the top record.
    file.layer_mask.layers.last().expect("layers").addl.clone()
}

fn payload(a: &AdditionalLayerInfo) -> &[u8] {
    let raw = a.raw_block.as_deref().expect("as read");
    let n = u32::from_be_bytes(raw[8..12].try_into().expect("4")) as usize;
    &raw[12..12 + n]
}

fn check(rel: &str, want: impl Fn(&Adjustment) -> bool) -> Adjustment {
    let addl = layer(rel);
    let adj = Adjustment::from_blocks(addl.iter().map(|a| (&a.key, payload(a))))
        .expect("reads")
        .unwrap_or_else(|| panic!("{rel}: no adjustment"));
    assert!(want(&adj), "{rel}: read {adj:?}");
    assert_eq!(adj.unmodelled(), None, "{rel}");
    // Written back as Photoshop wrote it.
    for (key, bytes) in adj.to_blocks() {
        let theirs = addl
            .iter()
            .find(|a| a.key == key)
            .unwrap_or_else(|| panic!("{rel}: Photoshop wrote no {key:?}"));
        assert_eq!(
            bytes,
            payload(theirs),
            "{rel}: {} differs from Photoshop's",
            String::from_utf8_lossy(&key)
        );
    }
    adj
}

#[test]
#[allow(non_snake_case)]
fn photoshop_adjustment_blocks_read_and_write_back_byte_for_byte__feat__image_psd_mutatable() {
    check("adjustment-layers-ext/vibrance.psd", |a| {
        *a == Adjustment::Vibrance {
            vibrance: 40,
            saturation: -20,
        }
    });
    check("adjustment-layers-ext/color-balance.psd", |a| {
        *a == Adjustment::ColorBalance {
            shadows: [10, -20, 30],
            midtones: [-15, 25, 0],
            highlights: [5, 0, -40],
            preserve_luminosity: true,
        }
    });
    check("adjustment-layers-ext/black-white.psd", |a| {
        matches!(a, Adjustment::BlackWhite { weights, tint: false, .. }
            if *weights == [40, 60, 40, 60, 20, 80])
    });
    check("adjustment-layers-ext/channel-mixer.psd", |a| {
        *a == Adjustment::ChannelMixer {
            rows: [[80, 20, 0, 0], [10, 70, 20, 5], [0, -10, 110, -5]],
            monochrome: false,
        }
    });
    check("adjustment-layers-ext/channel-mixer-mono.psd", |a| {
        *a == Adjustment::ChannelMixer {
            rows: [[30, 59, 11, 0], [0; 4], [0; 4]],
            monochrome: true,
        }
    });
    check("adjustment-layers-ext/posterize.psd", |a| {
        *a == Adjustment::Posterize { levels: 5 }
    });
    check("adjustment-layers-ext/threshold.psd", |a| {
        *a == Adjustment::Threshold { level: 140 }
    });
    for (rel, reversed, n) in [
        ("adjustment-layers-ext/gradient-map.psd", false, 3),
        ("adjustment-layers-ext/gradient-map-reversed.psd", true, 2),
    ] {
        check(rel, |a| {
            matches!(a, Adjustment::GradientMap { stops, reverse, method, .. }
                if *reverse == reversed && stops.len() == n && method == b"Gcls")
        });
    }
    let g = check("adjustment-layers-ext/gradient-map.psd", |_| true);
    let Adjustment::GradientMap { stops, .. } = g else {
        unreachable!()
    };
    let rgb: Vec<[u8; 3]> = stops
        .iter()
        .map(|s| s.rgb16.map(|v| ((u32::from(v) + 128) / 257) as u8))
        .collect();
    assert_eq!(rgb, [[20, 10, 80], [200, 60, 40], [250, 240, 200]]);
    assert_eq!(
        stops.iter().map(|s| s.location).collect::<Vec<_>>(),
        [0, 2048, 4096]
    );
    check("adjustment-layers-ext/selective-color.psd", |a| {
        let mut ranges = [[0i16; 4]; 9];
        ranges[0] = [10, -20, 30, 0];
        ranges[7] = [-5, 0, 15, 10];
        ranges[8] = [0, 0, 0, 20];
        *a == Adjustment::SelectiveColor {
            ranges,
            absolute: false,
        }
    });
    check("adjustment-layers-ext/selective-color-absolute.psd", |a| {
        let mut ranges = [[0i16; 4]; 9];
        ranges[4] = [25, 0, -25, 0];
        ranges[6] = [0, 10, 0, 0];
        *a == Adjustment::SelectiveColor {
            ranges,
            absolute: true,
        }
    });
    check("adjustment-layers/brightness-contrast.psd", |a| {
        *a == Adjustment::BrightnessContrast {
            brightness: 30,
            contrast: 40,
            mean: 127,
            lab: false,
            legacy: false,
            auto: false,
        }
    });
    check("adjustment-layers/photo-filter.psd", |a| {
        matches!(
            a,
            Adjustment::PhotoFilter {
                color: FilterColor::Lab(_),
                density: 50,
                preserve_luminosity: true,
            }
        )
    });
    // Curves: the legacy section, the `Crv ` extension, the even pad.
    for rel in [
        "adjustment-layers/curves-channels.psd",
        "adjustment-layers/curves-composite.psd",
    ] {
        check(rel, |a| matches!(a, Adjustment::Curves { .. }));
    }
    for rel in [
        "adjustment-layers/levels-channels.psd",
        "adjustment-layers/exposure-offset-gamma.psd",
        "adjustment-layers/invert.psd",
        "adjustment-layers/hue-sat-reds.psd",
    ] {
        let addl = layer(rel);
        let adj = Adjustment::from_blocks(addl.iter().map(|a| (&a.key, payload(a))))
            .expect("reads")
            .expect("an adjustment");
        // Written blocks read back to the same adjustment (Levels:
        // Photoshop adds an extension the reader does not need, so the
        // bytes are compared through a re-read).
        let blocks = adj.to_blocks();
        let back = Adjustment::from_blocks(blocks.iter().map(|(k, v)| (k, v.as_slice())))
            .expect("re-reads")
            .expect("an adjustment");
        assert_eq!(back, adj, "{rel}");
    }
}

/// The Photo Filter colour Photoshop stores as Lab is the one paged's
/// sRGB→Lab(D50) conversion gives for the dialog's RGB (236, 138, 0):
/// within 0.6 of each component (the write path's Lab).
#[test]
#[allow(non_snake_case)]
fn the_photo_filter_lab_matches_photoshops__feat__image_psd_mutatable() {
    let addl = layer("adjustment-layers/photo-filter.psd");
    let Some(Adjustment::PhotoFilter {
        color: FilterColor::Lab(theirs),
        ..
    }) = Adjustment::from_blocks(addl.iter().map(|a| (&a.key, payload(a)))).expect("reads")
    else {
        panic!("a Lab photo filter")
    };
    let ours = paged_color::lab::srgb_to_lab_d50([236.0 / 255.0, 138.0 / 255.0, 0.0]);
    for k in 0..3 {
        assert!(
            (f64::from(ours[k]) - theirs[k]).abs() < 0.6,
            "{ours:?} vs Photoshop {theirs:?}"
        );
    }
}
