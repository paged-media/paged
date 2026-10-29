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

//! 16 bits end to end through the layer stack (image ADR 479): a 16-bit
//! image opens a 16-bit stack, folds and reads back at 16 bits, takes an
//! 8-bit tool's edit inside its damage only, converts between 8 and 16
//! bits as one undo step, and bakes an adjustment at 16 bits.

#![allow(non_snake_case)]

use std::collections::HashSet;
use std::sync::Arc;

use image_core::{Region, SampleDepth};
use image_gpu::GpuContext;

use super::*;
use crate::ingest::{AdjustParams, DecodedImage};
use crate::pixels::{LayerPixels, Pixels};

fn device() -> Option<&'static GpuContext> {
    image_gpu::test_support::device_or_skip("16-bit stack")
}

/// A horizontal 16-bit ramp, `w` wide: every column its own level, far
/// more than 256 of them.
fn ramp16(w: u32, h: u32) -> Pixels {
    let mut s = Vec::with_capacity((w * h * 4) as usize);
    for _ in 0..h {
        for x in 0..w {
            let v = ((u64::from(x) * 65535) / u64::from(w - 1)) as u16;
            s.extend_from_slice(&[v, v, v, u16::MAX]);
        }
    }
    Pixels::from_rgba16(&s)
}

/// Distinct red values of a 16-bit buffer.
fn levels16(px: &Pixels) -> usize {
    assert!(px.is_16bit());
    (0..px.pixel_count())
        .map(|i| px.sample16(i, 0))
        .collect::<HashSet<_>>()
        .len()
}

#[test]
fn a_16bit_image_opens_a_16bit_stack_and_its_composite_is_the_image__feat__image_io_depth_color_modes(
) {
    let img = ramp16(64, 2);
    let s = LayerStack::from_image_px(64, 2, img.clone()).expect("open");
    assert_eq!(s.depth(), SampleDepth::U16);
    // One plain layer: the identity fold, no device, the same samples.
    let out = pollster::block_on(s.composite_px(None, None)).expect("composite");
    assert!(out.same(&img), "the composite is the image itself");
    // The display view is the high byte.
    let view = pollster::block_on(s.composite(None, None)).expect("view");
    assert_eq!(&view[..], &img.to_rgba8()[..]);
}

#[test]
fn a_new_layer_in_a_16bit_document_is_16bit__feat__image_io_depth_color_modes() {
    let mut s = LayerStack::from_image_px(8, 8, ramp16(8, 8)).expect("open");
    let at = s.add("Paint");
    assert!(s.layers()[at].rgba.is_16bit());
}

#[test]
fn an_8bit_edit_on_a_16bit_layer_lands_inside_its_damage_only__feat__image_io_depth_color_modes() {
    let (w, h) = (64u32, 4u32);
    let img = ramp16(w, h);
    let mut s = LayerStack::from_image_px(w, h, img.clone()).expect("open");
    // An 8-bit tool's result: the narrowed canvas with a white square.
    let mut edit = img.to_rgba8().into_owned();
    let damage = Region::new(8, 1, 4, 2);
    for y in 1..3 {
        for x in 8..12 {
            let i = (y * w as usize + x) * 4;
            edit[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    s.edit_active("Brush", damage, Pixels::from_rgba8(Arc::from(edit)))
        .expect("an 8-bit edit adopts the layer's depth");
    let after = s.active().rgba.canvas().clone();
    assert!(after.is_16bit(), "the layer stays 16-bit");
    for i in 0..(w * h) as usize {
        let (x, y) = (i % w as usize, i / w as usize);
        let inside = (8..12).contains(&x) && (1..3).contains(&y);
        for c in 0..4 {
            let want = if inside { u16::MAX } else { img.sample16(i, c) };
            assert_eq!(after.sample16(i, c), want, "pixel {x},{y} channel {c}");
        }
    }
    // Undo restores the 16-bit samples, low bytes and all.
    s.undo().expect("undo");
    let back = s.active().rgba.canvas().clone();
    assert_eq!(back.raw(), img.raw());
}

#[test]
fn mode_8_and_16_bits_convert_every_layer_as_one_undo_step__feat__image_io_depth_color_modes() {
    let mut s = LayerStack::from_image_px(64, 2, ramp16(64, 2)).expect("open");
    s.add("Empty");
    assert!(s.set_depth(SampleDepth::U8).expect("to 8"));
    assert_eq!(s.depth(), SampleDepth::U8);
    assert!(s.layers().iter().all(|l| !l.rgba.is_16bit()));
    // Rounded, not the high byte: 0xFF00 is 254.0 levels (its high byte
    // is 255), 0x8000 is 127.5 → 128.
    let probe = Pixels::from_rgba16(&[0xFF00, 0x8000, 0x0080, 0xFFFF]).at_depth(SampleDepth::U8);
    assert_eq!(probe.raw(), &[254, 128, 0, 255]);
    // The same depth again records nothing.
    assert!(!s.set_depth(SampleDepth::U8).expect("no-op"));
    // Undo brings back the 16-bit samples exactly.
    assert_eq!(s.undo().as_deref(), Some("8 Bits/Channel"));
    assert_eq!(s.depth(), SampleDepth::U16);
    assert_eq!(levels16(s.layers()[0].rgba.canvas()), 64);
    // 8 → 16 widens exactly (255 is 65535).
    let w = Pixels::from_rgba8(Arc::from(vec![255u8, 0, 128, 255])).at_depth(SampleDepth::U16);
    assert_eq!(
        (0..4).map(|c| w.sample16(0, c)).collect::<Vec<_>>(),
        [0xFFFF, 0, 0x8080, 0xFFFF]
    );
    assert!(
        s.set_depth(SampleDepth::F32).is_err(),
        "a stack holds 8 or 16 bits"
    );
}

#[test]
fn a_bounded_layer_keeps_its_bounds_through_a_depth_change__feat__image_io_depth_color_modes() {
    let canvas = LayerPixels::Bounded(
        crate::pixels::Bounded::new(
            Region::new(2, 2, 2, 2),
            Pixels::from_rgba8(Arc::from(vec![200u8; 16])),
            8,
            8,
        )
        .expect("inside"),
    );
    let wide = canvas.at_depth(SampleDepth::U16);
    let b = wide.bounded().expect("still bounded");
    assert_eq!(b.rect, Region::new(2, 2, 2, 2));
    assert!(b.px.is_16bit());
    assert_eq!(b.px.sample16(0, 0), 200 * 257);
}

#[test]
fn a_16bit_fold_keeps_more_than_256_levels__feat__image_io_depth_color_modes() {
    let Some(ctx) = device() else { return };
    let (w, h) = (1024u32, 2u32);
    let mut s = LayerStack::from_image_px(w, h, ramp16(w, h)).expect("open");
    // A half-opaque layer on top forces a real fold (no identity path).
    let top = s.add("Veil");
    let veil: Vec<u16> = (0..w * h).flat_map(|_| [0u16, 0, 0, 0x8000]).collect();
    s.edit_active("Fill", Region::new(0, 0, w, h), Pixels::from_rgba16(&veil))
        .expect("fill");
    assert_eq!(s.active, top);
    let out = pollster::block_on(s.composite_px(Some(ctx), None)).expect("fold");
    assert!(out.is_16bit(), "read back at the document's depth");
    // The ramp at half strength spans ~32768 codes over 1024 columns: an
    // 8-bit fold would leave at most 129 distinct values.
    let n = levels16(&out);
    assert!(n > 900, "{n} distinct levels survived the 16-bit fold");
    // The 8-bit view agrees with the 16-bit result's high bytes.
    let view = pollster::block_on(s.composite(Some(ctx), None)).expect("view");
    assert_eq!(&view[..], &out.to_rgba8()[..]);
}

#[test]
fn a_dirty_refold_of_a_16bit_stack_matches_the_full_fold__feat__image_io_depth_color_modes() {
    let Some(ctx) = device() else { return };
    let (w, h) = (300u32, 300u32);
    let mut s = LayerStack::from_image_px(w, h, ramp16(w, h)).expect("open");
    s.add("Paint");
    let first = pollster::block_on(s.composite_px(Some(ctx), None)).expect("first");
    // A small 16-bit edit on the top layer: the windowed refold path.
    let mut top = s.active().rgba.canvas().raw().to_vec();
    for y in 100..120usize {
        for x in 140..160usize {
            let i = (y * w as usize + x) * 8;
            for (c, v) in [0x1234u16, 0x5678, 0x9ABC, 0xC000].iter().enumerate() {
                top[i + c * 2..i + c * 2 + 2].copy_from_slice(&v.to_ne_bytes());
            }
        }
    }
    s.edit_active(
        "Brush",
        Region::new(140, 100, 20, 20),
        Pixels::from_raw(Arc::from(top), SampleDepth::U16),
    )
    .expect("edit");
    let incremental = pollster::block_on(s.composite_px(Some(ctx), None)).expect("refold");
    // The same stack folded from nothing.
    *s.fold.lock().expect("fold cache") = fold::FoldCache::default();
    let full = pollster::block_on(s.composite_px(Some(ctx), None)).expect("full");
    assert!(incremental.is_16bit() && full.is_16bit());
    assert_eq!(
        incremental.raw(),
        full.raw(),
        "the windowed refold is the full fold"
    );
    assert_ne!(incremental.raw(), first.raw(), "the edit shows");
}

#[test]
fn an_adjustment_bakes_at_16_bits__feat__image_io_depth_color_modes() {
    let Some(ctx) = device() else { return };
    let (w, h) = (1024u32, 1u32);
    let img = DecodedImage {
        width: w,
        height: h,
        rgba: ramp16(w, h),
        display: crate::display::DisplayTreatment::AssumedSrgb,
        depth_reduced: false,
    };
    let params = AdjustParams {
        exposure_ev: -1.0,
        ..AdjustParams::default()
    };
    let out =
        pollster::block_on(crate::ingest::adjust_px(ctx, &img, &params, None)).expect("adjust");
    assert!(out.is_16bit(), "the chain reads back at the image's depth");
    let n = levels16(&out);
    assert!(n > 400, "{n} distinct levels after a 16-bit exposure");
    // The panel's 8-bit preview of the same chain is that result's view.
    let preview =
        pollster::block_on(crate::ingest::adjust_rgba8(ctx, &img, &params, None)).expect("preview");
    let max_diff = preview
        .iter()
        .zip(out.to_rgba8().iter())
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    assert!(
        max_diff <= 1,
        "the preview is the 16-bit result narrowed (off by {max_diff})"
    );
}

// ───────────────────────────── colour modes ─────────────────────────────

fn colourful(w: u32, h: u32) -> Pixels {
    Pixels::from_rgba8(Arc::from(
        (0..w * h)
            .flat_map(|i| {
                [
                    (i * 37 % 256) as u8,
                    (i * 91 % 256) as u8,
                    (i * 13 % 256) as u8,
                    255,
                ]
            })
            .collect::<Vec<u8>>(),
    ))
}

fn neutral(px: &Pixels) -> bool {
    let b = px.to_rgba8();
    b.as_chunks::<4>()
        .0
        .iter()
        .all(|p| p[0].abs_diff(p[1]) <= 1 && p[1].abs_diff(p[2]) <= 1)
}

fn gray() -> crate::color_mode::DocMode {
    crate::color_mode::DocMode {
        mode: crate::color_mode::ColorMode::Gray,
        cmyk_profile: None,
    }
}

#[test]
fn grayscale_converts_every_layer_as_one_undo_step__feat__image_io_depth_color_modes() {
    let mut s = LayerStack::from_image_px(8, 8, colourful(8, 8)).expect("open");
    let before = s.layers()[0].rgba.canvas().clone();
    assert!(s.set_mode(gray()).expect("to grey"));
    assert_eq!(s.mode().mode, crate::color_mode::ColorMode::Gray);
    assert!(neutral(s.layers()[0].rgba.canvas()), "the layer is grey");
    assert!(
        !s.set_mode(gray()).expect("again"),
        "the same mode records nothing"
    );
    assert_eq!(s.undo().as_deref(), Some("Grayscale"));
    assert_eq!(s.mode().mode, crate::color_mode::ColorMode::Rgb);
    assert_eq!(
        s.layers()[0].rgba.canvas().raw(),
        before.raw(),
        "undo restores the colour"
    );
}

#[test]
fn an_edit_in_a_grayscale_document_lands_grey_inside_its_damage__feat__image_io_depth_color_modes()
{
    let (w, h) = (8u32, 8u32);
    let mut s = LayerStack::from_image_px(w, h, colourful(w, h)).expect("open");
    s.set_mode(gray()).expect("grey");
    let grey = s.layers()[0].rgba.canvas().clone();
    // A red square painted by a tool that knows nothing of the mode.
    let mut edit = grey.to_rgba8().into_owned();
    for y in 2..4usize {
        for x in 2..4usize {
            let i = (y * w as usize + x) * 4;
            edit[i..i + 4].copy_from_slice(&[255, 0, 0, 255]);
        }
    }
    s.edit_active(
        "Brush",
        Region::new(2, 2, 2, 2),
        Pixels::from_rgba8(Arc::from(edit)),
    )
    .expect("edit");
    let after = s.layers()[0].rgba.canvas().clone();
    assert!(neutral(&after), "the red landed grey");
    let p = (2 * w as usize + 2) * 4;
    assert!(
        after.raw()[p] < 200 && after.raw()[p] > 40,
        "red's grey: {:?}",
        &after.raw()[p..p + 4]
    );
    // Outside the damage: the grey document as it was.
    assert_eq!(&after.raw()[..16], &grey.raw()[..16]);
}

#[test]
fn the_colour_mode_is_persisted__feat__image_io_depth_color_modes() {
    let mut s = LayerStack::from_image_px(4, 4, colourful(4, 4)).expect("open");
    s.set_mode(crate::color_mode::DocMode {
        mode: crate::color_mode::ColorMode::Cmyk,
        cmyk_profile: Some(Arc::from(vec![1u8, 2, 3])),
    })
    .expect_err("a profile that is not a profile is refused");
    s.set_mode(crate::color_mode::DocMode {
        mode: crate::color_mode::ColorMode::Lab,
        cmyk_profile: None,
    })
    .expect("lab");
    let (manifest, buffers) = s.export();
    let back = LayerStack::import(&manifest, &buffers).expect("import");
    assert_eq!(back.mode().mode, crate::color_mode::ColorMode::Lab);
    // A version-5 manifest (before modes) opens as RGB.
    let (old, old_buffers) = s.export_with(5);
    let back5 = LayerStack::import(&old, &old_buffers).expect("v5");
    assert_eq!(back5.mode().mode, crate::color_mode::ColorMode::Rgb);
}
