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

//! 32-bit float through the layer stack (image ADR 483): a float layer
//! holds linear light, the fold blends the linear values (as Photoshop's
//! 32-bit documents do) and keeps values above 1, the display view is the
//! sRGB encoding, and Image ▸ Mode ▸ 32 Bits/Channel is one undo step.

#![allow(non_snake_case)]

use std::sync::Arc;

use image_core::{Region, SampleDepth};

use super::*;
use crate::pixels::Pixels;

fn solid(w: u32, h: u32, rgba: [f32; 4]) -> Pixels {
    Pixels::from_rgba32f(&rgba.repeat((w * h) as usize))
}

fn two_layers(bottom: [f32; 4], top: [f32; 4], blend: &str, opacity: f32) -> LayerStack {
    let mut s = LayerStack::from_image_px(4, 2, solid(4, 2, bottom)).expect("open");
    assert_eq!(s.depth(), SampleDepth::F32);
    let at = s.add("Top");
    assert!(s.layers()[at].rgba.depth() == SampleDepth::F32, "a new layer is float");
    s.layer_at_mut(at).expect("top").rgba = solid(4, 2, top).into();
    s.set_blend(at, blend).expect("blend");
    s.set_opacity(at, opacity).expect("opacity");
    s
}

fn first(px: &Pixels) -> Vec<f32> {
    px.to_f32_linear()[..4].to_vec()
}

fn close(a: &[f32], b: &[f32], tol: f32) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
}

#[test]
fn a_float_document_blends_linear_light_and_keeps_values_above_one__feat__image_io_depth_color_modes(
) {
    // Normal at 50 %: the mix of the linear values (an 8-bit document
    // would mix the encoded ones and land darker).
    let s = two_layers([0.8, 0.2, 0.1, 1.0], [0.0, 0.5, 0.0, 1.0], "normal", 0.5);
    let out = pollster::block_on(s.composite_px(None, None)).expect("cpu fold");
    assert!(out.is_float());
    let got = first(&out);
    assert!(close(&got, &[0.4, 0.35, 0.05, 1.0], 2e-3), "{got:?}");
    // A scene-referred value above 1 goes through the fold unclipped
    // (Normal over it). Linear Dodge itself still clips its sum at 1 —
    // the compose kernels' formula; Photoshop's 32-bit Add does not
    // (`color_modes_photoshop.rs` states it).
    let s = two_layers([2.5, 0.2, 0.1, 1.0], [0.8, 0.5, 0.0, 1.0], "normal", 0.5);
    let got = first(&pollster::block_on(s.composite_px(None, None)).expect("fold"));
    assert!(close(&got, &[1.65, 0.35, 0.05, 1.0], 4e-3), "{got:?}");
    // The display view encodes and clips.
    let view = pollster::block_on(s.composite(None, None)).expect("view");
    assert_eq!(view[0], 255);
    assert_eq!(view[1], (paged_color::math::linear_to_srgb(0.35) * 255.0).round() as u8);
}

#[test]
fn mode_32_bits_is_one_undo_step_and_round_trips_8bit_pixels__feat__image_io_depth_color_modes() {
    let src: Vec<u8> = (0..32u8).flat_map(|i| [i * 8, 255 - i * 8, i * 3, 255]).collect();
    let mut s = LayerStack::from_image(8, 4, Arc::from(src.clone())).expect("open");
    assert!(s.set_depth(SampleDepth::F32).expect("to 32"));
    assert_eq!(s.depth(), SampleDepth::F32);
    assert!(!s.set_depth(SampleDepth::F32).expect("again"), "same depth records nothing");
    let view = pollster::block_on(s.composite(None, None)).expect("view");
    assert_eq!(&view[..], &src[..], "8 → 32 changes no colour on screen");
    assert!(s.set_depth(SampleDepth::U8).expect("back to 8"));
    assert_eq!(s.layers()[0].rgba.canvas().raw(), &src[..]);
    s.undo().expect("undo 8");
    s.undo().expect("undo 32");
    assert_eq!(s.depth(), SampleDepth::U8);
    // Modes without a float encoding refuse 32 bits, and the reverse.
    s.set_mode(crate::color_mode::DocMode {
        mode: crate::color_mode::ColorMode::Lab,
        cmyk_profile: None,
        table: None,
    })
    .expect("lab");
    assert!(s.set_depth(SampleDepth::F32).is_err());
}

#[test]
fn an_8bit_brush_edit_on_a_float_layer_keeps_the_untouched_hdr_pixels__feat__image_io_depth_color_modes(
) {
    let (w, h) = (6u32, 3u32);
    let mut s = LayerStack::from_image_px(w, h, solid(w, h, [3.0, 0.5, 0.25, 1.0])).expect("open");
    // The tool paints the display view with one white pixel at (2,1);
    // its damage is a 3 × 3 box around it.
    let mut edit = s.active().rgba.canvas().to_rgba8().into_owned();
    let i = (w as usize + 2) * 4;
    edit[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
    s.edit_active("Brush", Region::new(1, 0, 3, 3), Pixels::from_rgba8(Arc::from(edit)))
        .expect("edit");
    let after = s.active().rgba.canvas().to_f32_linear();
    for p in 0..(w * h) as usize {
        let want: &[f32] = if p == w as usize + 2 {
            &[1.0, 1.0, 1.0, 1.0]
        } else {
            &[3.0, 0.5, 0.25, 1.0]
        };
        assert!(close(&after[p * 4..p * 4 + 4], want, 1e-6), "pixel {p}: {:?}", &after[p * 4..p * 4 + 4]);
    }
}

#[test]
fn a_float_grayscale_document_keeps_linear_luminance__feat__image_io_depth_color_modes() {
    let mut s = LayerStack::from_image_px(2, 1, solid(2, 1, [2.0, 0.0, 0.0, 1.0])).expect("open");
    s.set_mode(crate::color_mode::DocMode {
        mode: crate::color_mode::ColorMode::Gray,
        cmyk_profile: None,
        table: None,
    })
    .expect("gray");
    let got = first(s.layers()[0].rgba.canvas());
    assert!(close(&got, &[0.445, 0.445, 0.445, 1.0], 1e-3), "{got:?}");
}

#[test]
fn a_float_layer_and_a_mode_table_are_persisted__feat__image_io_depth_color_modes() {
    let mut s = LayerStack::from_image_px(4, 2, solid(4, 2, [2.5, 0.25, 0.0, 1.0])).expect("open");
    let (manifest, buffers) = s.export();
    let back = LayerStack::import(&manifest, &buffers).expect("import");
    assert_eq!(back.depth(), SampleDepth::F32);
    assert_eq!(
        back.layers()[0].rgba.canvas().to_f32_linear(),
        s.layers()[0].rgba.canvas().to_f32_linear()
    );
    s.set_depth(SampleDepth::U8).expect("8 bits");
    let m = crate::color_mode::DocMode::multichannel_from(crate::color_mode::ColorMode::Rgb)
        .expect("from RGB");
    pollster::block_on(s.convert_flat(None, m.clone())).expect("multichannel");
    let (manifest, buffers) = s.export();
    let back = LayerStack::import(&manifest, &buffers).expect("import");
    assert_eq!(back.mode(), &m, "the channels come back");
    let indexed = crate::color_mode::DocMode::indexed(crate::color_mode::web_palette());
    s.set_mode(crate::color_mode::DocMode::rgb()).expect("rgb");
    pollster::block_on(s.convert_flat(None, indexed.clone())).expect("indexed");
    let (manifest, buffers) = s.export();
    let back = LayerStack::import(&manifest, &buffers).expect("import");
    assert_eq!(back.mode(), &indexed, "the table comes back");
}
