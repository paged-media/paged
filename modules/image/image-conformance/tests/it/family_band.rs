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

//! gpu↔ref parity for the band family (channel plumbing): copy,
//! extract, set_alpha, broadcast_alpha. All four are pure lane
//! rearrangements ⇒ bit-exact. feat: band.copy / band.extract /
//! band.set_alpha / band.broadcast_alpha (registry/kernels.yaml).

use image_conformance::harness::{assert_within, parity, RefTile};
use image_conformance::Px;
use image_kernels::families::band::{
    band_blend_if, band_broadcast_alpha, band_copy, band_extract, band_fade_neutral,
    band_set_alpha, band_take, BandBlendIfParams, BandBroadcastAlphaParams, BandCopyParams,
    BandExtractParams, BandFadeNeutralParams, BandSetAlphaParams, BandTakeParams, BAND_BLEND_IF,
    BAND_BROADCAST_ALPHA, BAND_COPY, BAND_EXTRACT, BAND_FADE_NEUTRAL, BAND_SET_ALPHA, BAND_TAKE,
};

/// A gradient where the four channels carry visibly distinct values —
/// so channel selection / broadcast can't pass by coincidence. Alpha
/// crosses the 0.5 line across the tile (the boolean-truthiness probe
/// other families lean on; harmless here but keeps the lane uniform).
fn gradient_tile(w: u32, h: u32) -> RefTile {
    RefTile::from_fn(w, h, |x, y| {
        Px([
            x as f32 / w as f32,
            y as f32 / h as f32,
            (x + y) as f32 / (w + h) as f32,
            (x + 1) as f32 / w as f32, // 1/w .. 1.0 — straddles 0.5
        ])
    })
}

/// A handful of explicit edge-case texels: opaque, transparent, and the
/// exact 0.5 alpha boundary, with each channel a distinct constant.
fn edge_tile() -> RefTile {
    let rows = [
        Px([0.0, 0.25, 0.5, 1.0]),   // fully opaque
        Px([0.75, 1.0, 0.125, 0.0]), // fully transparent
        Px([0.1, 0.2, 0.3, 0.5]),    // exactly on the 0.5 line
        Px([1.0, 0.0, 1.0, 0.0]),    // channels maximally separated
    ];
    RefTile::from_fn(4, rows.len() as u32, |x, y| {
        let _ = x;
        rows[y as usize]
    })
}

#[test]
fn band_copy_parity() {
    let tile = gradient_tile(image_core::TILE, image_core::TILE);
    let p = BandCopyParams::new();
    match parity(&BAND_COPY, band_copy, &[&tile], &p) {
        Some(r) => assert_within(r, &BAND_COPY),
        None => eprintln!("SKIP: no GPU adapter"),
    }
}

#[test]
fn band_extract_parity() {
    // Oracle is per-channel (vips), so prove every channel selects.
    for channel in 0u32..4 {
        let tile = gradient_tile(image_core::TILE, image_core::TILE);
        let p = BandExtractParams::new(channel);
        match parity(&BAND_EXTRACT, band_extract, &[&tile], &p) {
            Some(r) => assert_within(r, &BAND_EXTRACT),
            None => {
                eprintln!("SKIP: no GPU adapter");
                break;
            }
        }
    }
}

#[test]
fn band_extract_edge_parity() {
    for channel in 0u32..4 {
        let tile = edge_tile();
        let p = BandExtractParams::new(channel);
        match parity(&BAND_EXTRACT, band_extract, &[&tile], &p) {
            Some(r) => assert_within(r, &BAND_EXTRACT),
            None => {
                eprintln!("SKIP: no GPU adapter");
                break;
            }
        }
    }
}

#[test]
fn band_set_alpha_parity() {
    let tile = gradient_tile(image_core::TILE, image_core::TILE);
    // A value that is NOT already present in the alpha gradient and that
    // is exact in f16, so the override is observable and bit-stable.
    let p = BandSetAlphaParams::new(0.375);
    match parity(&BAND_SET_ALPHA, band_set_alpha, &[&tile], &p) {
        Some(r) => assert_within(r, &BAND_SET_ALPHA),
        None => eprintln!("SKIP: no GPU adapter"),
    }
}

#[test]
fn band_set_alpha_edge_parity() {
    let tile = edge_tile();
    let p = BandSetAlphaParams::new(1.0);
    match parity(&BAND_SET_ALPHA, band_set_alpha, &[&tile], &p) {
        Some(r) => assert_within(r, &BAND_SET_ALPHA),
        None => eprintln!("SKIP: no GPU adapter"),
    }
}

#[test]
fn band_broadcast_alpha_parity() {
    let tile = gradient_tile(image_core::TILE, image_core::TILE);
    let p = BandBroadcastAlphaParams::new();
    match parity(&BAND_BROADCAST_ALPHA, band_broadcast_alpha, &[&tile], &p) {
        Some(r) => assert_within(r, &BAND_BROADCAST_ALPHA),
        None => eprintln!("SKIP: no GPU adapter"),
    }
}

#[test]
fn band_broadcast_alpha_edge_parity() {
    let tile = edge_tile();
    let p = BandBroadcastAlphaParams::new();
    match parity(&BAND_BROADCAST_ALPHA, band_broadcast_alpha, &[&tile], &p) {
        Some(r) => assert_within(r, &BAND_BROADCAST_ALPHA),
        None => eprintln!("SKIP: no GPU adapter"),
    }
}

/// A second tile, so a binary kernel cannot pass by reading `a` twice.
fn other_tile(w: u32, h: u32) -> RefTile {
    RefTile::from_fn(w, h, |x, y| {
        let a = (y + 1) as f32 / h as f32;
        Px([
            a * ((x * 7 % w) as f32 / w as f32),
            a * 0.5,
            a * ((w - 1 - x) as f32 / w as f32),
            a,
        ])
    })
}

#[test]
fn band_take_parity() {
    let a = gradient_tile(image_core::TILE, image_core::TILE);
    let b = other_tile(image_core::TILE, image_core::TILE);
    match parity(&BAND_TAKE, band_take, &[&a, &b], &BandTakeParams::new()) {
        Some(r) => assert_within(r, &BAND_TAKE),
        None => eprintln!("SKIP: no GPU adapter"),
    }
}

#[test]
fn band_fade_neutral_parity() {
    let a = other_tile(image_core::TILE, image_core::TILE);
    for (neutral, fill) in [(0.0, 0.4), (1.0, 0.25), (0.5, 0.7), (0.5, 1.0), (1.0, 0.0)] {
        let p = BandFadeNeutralParams::new(neutral, fill);
        match parity(&BAND_FADE_NEUTRAL, band_fade_neutral, &[&a], &p) {
            Some(r) => assert_within(r, &BAND_FADE_NEUTRAL),
            None => {
                eprintln!("SKIP: no GPU adapter");
                return;
            }
        }
    }
}

/// The fade's two ends: fill 1 is the identity, fill 0 is the neutral at
/// the texel's own alpha.
#[test]
fn band_fade_neutral_ends_are_the_source_and_the_neutral() {
    let px = Px([0.2, 0.4, 0.1, 0.5]);
    let same = band_fade_neutral(px, Px([0.0; 4]), &BandFadeNeutralParams::new(1.0, 1.0));
    assert_eq!(same, px);
    let grey = band_fade_neutral(px, Px([0.0; 4]), &BandFadeNeutralParams::new(0.5, 0.0));
    assert_eq!(grey, Px([0.25, 0.25, 0.25, 0.5]));
}

/// Every ramp open (k = 0, o = 1): the coverage is one everywhere.
fn open_ramps() -> BandBlendIfParams {
    let mut p = BandBlendIfParams::new(
        0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0,
    );
    p._abi_pad = 0;
    p
}

#[test]
fn band_blend_if_parity() {
    let a = gradient_tile(image_core::TILE, image_core::TILE);
    let b = other_tile(image_core::TILE, image_core::TILE);
    let open = open_ramps();
    // This Layer's gray from 64 (split to 128); Underlying red under 200.
    let mut cut = open;
    cut.slk0 = 255.0 / 65.0;
    cut.slo0 = -63.0 / 65.0;
    cut.dhk1 = -255.0;
    cut.dho1 = 201.0;
    for p in [open, cut] {
        match parity(&BAND_BLEND_IF, band_blend_if, &[&a, &b], &p) {
            Some(r) => assert_within(r, &BAND_BLEND_IF),
            None => {
                eprintln!("SKIP: no GPU adapter");
                return;
            }
        }
    }
}

#[test]
fn band_blend_if_open_ramps_cover_everything() {
    let p = open_ramps();
    let c = band_blend_if(Px([0.1, 0.9, 0.3, 1.0]), Px([0.0, 0.0, 0.0, 0.0]), &p);
    assert_eq!(c, Px([1.0; 4]));
}
