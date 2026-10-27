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

//! Type layers (WP5.10): created, edited, moved, saved, rasterized and
//! warped as one undo step each.

use std::sync::Arc;

use super::*;

const W: u32 = 32;
const H: u32 = 16;

fn grey() -> LayerStack {
    let px: Vec<u8> = (0..W * H).flat_map(|_| [90, 90, 90, 255]).collect();
    LayerStack::from_image(W, H, Arc::from(px.into_boxed_slice())).expect("stack")
}

fn source(text: &str) -> TypeSource {
    TypeSource::from_json(&format!(
        r#"{{"text":"{text}","frame":{{"kind":"point","x":4,"y":12}},"runs":[{{"length":{},"font":"Inter","size":10,"color":[255,0,0]}}]}}"#,
        text.len()
    ))
    .expect("source")
}

/// A "render": a red 6 × 4 block at (x, y), on the canvas.
fn render(x: i32, y: i32) -> Vec<u8> {
    type_layer::TypeRender {
        rgba: (0..24).flat_map(|_| [255, 0, 0, 255]).collect(),
        x,
        y,
        w: 6,
        h: 4,
    }
    .place(W, H)
    .expect("place")
}

fn alpha_at(s: &LayerStack, i: usize, x: u32, y: u32) -> u8 {
    s.layers()[i].rgba.canvas().to_rgba8()[((y * W + x) * 4 + 3) as usize]
}

#[test]
#[allow(non_snake_case)]
fn a_type_layer_is_added_and_edited_as_one_step_each__feat__image_layers_type() {
    let mut s = grey();
    let i = s
        .recorded("New Type Layer", None, |s| {
            s.add_type_layer("", source("Hello"), render(2, 2))
        })
        .expect("add");
    assert_eq!(s.layers()[i].name, "Hello");
    assert_eq!(s.layers()[i].kind_name(), "type");
    assert_eq!(alpha_at(&s, i, 3, 3), 255);
    // Two writes of one editing session merge into one step.
    for t in ["Hellos", "Hellos!"] {
        s.recorded("Edit Type", Some("type:1:s1"), |s| {
            s.set_type(i, source(t), render(10, 6))
        })
        .expect("edit");
    }
    assert_eq!(s.layers()[i].type_layer().unwrap().source.text, "Hellos!");
    assert_eq!(alpha_at(&s, i, 3, 3), 0);
    s.undo().expect("undo the session");
    assert_eq!(s.layers()[i].type_layer().unwrap().source.text, "Hello");
    s.undo().expect("undo the add");
    assert_eq!(s.len(), 1);
}

#[test]
#[allow(non_snake_case)]
fn painting_a_type_layer_is_refused_and_rasterize_makes_it_pixels__feat__image_layers_type() {
    let mut s = grey();
    let i = s
        .recorded("New Type Layer", None, |s| {
            s.add_type_layer("T", source("T"), render(0, 0))
        })
        .expect("add");
    let px = crate::pixels::Pixels::from_rgba8(Arc::from(
        vec![0u8; (W * H * 4) as usize].into_boxed_slice(),
    ));
    let err = s
        .edit_active("p", image_core::Region::new(0, 0, W, H), px)
        .expect_err("refused");
    assert!(format!("{err}").contains("rasterize"), "{err}");
    s.recorded("Rasterize", None, |s| s.rasterize(i))
        .expect("rasterize");
    assert_eq!(s.layers()[i].kind_name(), "pixels");
    assert_eq!(alpha_at(&s, i, 1, 1), 255, "the render is kept");
}

#[test]
#[allow(non_snake_case)]
fn moving_and_cropping_carry_the_frame__feat__image_layers_type() {
    let mut s = grey();
    let i = s
        .recorded("New Type Layer", None, |s| {
            s.add_type_layer("T", source("T"), render(0, 0))
        })
        .expect("add");
    s.translate(&[i], 3, 2).expect("move");
    let t = s.layers()[i].type_layer().unwrap();
    assert_eq!(t.source.frame, TypeFrame::Point { x: 7.0, y: 14.0 });
    assert!(t.stale, "a move re-renders");
    s.transform_canvas(CanvasOp::Crop {
        x: 2,
        y: 1,
        width: 20,
        height: 10,
    })
    .expect("crop");
    let t = s.layers()[i].type_layer().unwrap();
    assert_eq!(t.source.frame, TypeFrame::Point { x: 5.0, y: 13.0 });
    s.transform_canvas(CanvasOp::RotateCw).expect("rotate");
    assert_eq!(
        s.layers()[i].kind_name(),
        "pixels",
        "upright type cannot follow a rotation"
    );
}

#[test]
#[allow(non_snake_case)]
fn a_type_layer_survives_the_session_manifest__feat__image_layers_type() {
    let mut s = grey();
    s.recorded("New Type Layer", None, |s| {
        s.add_type_layer("T", source("Saved"), render(1, 1))
    })
    .expect("add");
    let (manifest, buffers) = s.export();
    let back = LayerStack::import(&manifest, &buffers).expect("import");
    let t = back.layers()[1].type_layer().expect("still type");
    assert_eq!(t.source.text, "Saved");
    // An older manifest version carries the render as pixels.
    let (old, old_buffers) = s.export_with(4);
    let back = LayerStack::import(&old, &old_buffers).expect("import v4");
    assert_eq!(back.layers()[1].kind_name(), "pixels");
}

#[test]
#[allow(non_snake_case)]
fn warp_text_bends_the_render_on_the_gpu__feat__image_layers_type() {
    let Some(ctx) = image_gpu::test_support::device_or_skip("warp text") else {
        return;
    };
    let r = type_layer::TypeRender {
        rgba: (0..20 * 6).flat_map(|_| [0, 0, 0, 255]).collect(),
        x: 6,
        y: 5,
        w: 20,
        h: 6,
    };
    let flat = r.place(W, H).unwrap();
    let warp = TypeWarp {
        style: "arc".into(),
        bend: 0.8,
        ..TypeWarp::default()
    };
    let bent = pollster::block_on(r.warped(Some(ctx), &warp, W, H)).expect("warp");
    let a = |px: &[u8], x: u32, y: u32| px[((y * W + x) * 4 + 3) as usize];
    // Flat: the block's corner is solid, nothing below it. Bent upward:
    // the middle keeps its place and the ends curl down below the block.
    assert_eq!(a(&flat, 6, 5), 255);
    assert_eq!(a(&flat, 9, 13), 0);
    assert!(a(&bent, 16, 7) > 128, "the middle stays");
    assert!(a(&bent, 6, 5) < 128, "the left end left its corner");
    assert!(
        a(&bent, 9, 13) > 128,
        "and curled down: {}",
        a(&bent, 9, 13)
    );
    // No warp: the plain placement.
    let none = pollster::block_on(r.warped(Some(ctx), &TypeWarp::default(), W, H)).unwrap();
    assert_eq!(none, flat);
}
