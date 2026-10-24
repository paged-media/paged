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

//! Photoshop layer parity (WP5.3): fill layers, typed adjustment layers,
//! the blending options, the locks, the Layer menu's verbs and layer comps
//! — through the GPU fold (Metal locally; the software adapter in CI).
//! Every verb is asserted to be ONE undo step.

use std::sync::Arc;

use image_core::Region;
use image_gpu::{GpuContext, SelectionCoverage};

use super::*;
use crate::ingest::AdjustParams;

fn device() -> Option<&'static GpuContext> {
    image_gpu::test_support::device_or_skip("layer parity")
}

fn solid(w: u32, h: u32, c: [u8; 4]) -> Arc<[u8]> {
    Arc::from(
        (0..w * h)
            .flat_map(|_| c)
            .collect::<Vec<u8>>()
            .into_boxed_slice(),
    )
}

/// A stack over an opaque grey background.
fn grey(w: u32, h: u32, v: u8) -> LayerStack {
    LayerStack::from_image(w, h, solid(w, h, [v, v, v, 255])).expect("stack")
}

fn paint(s: &mut LayerStack, px: Arc<[u8]>) {
    let (w, h) = (s.width(), s.height());
    s.edit_active(
        "p",
        Region::new(0, 0, w, h),
        crate::pixels::Pixels::from_rgba8(px),
    )
    .expect("paint");
}

fn fold(s: &LayerStack, ctx: &GpuContext) -> Arc<[u8]> {
    pollster::block_on(s.composite(Some(ctx), None)).expect("composite")
}

fn close(a: &[u8], b: &[u8], tol: u8) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.abs_diff(*y) <= tol)
}

const W: u32 = 8;
const H: u32 = 4;

/// The left half black, the right half white, opaque.
fn halves() -> Arc<[u8]> {
    Arc::from(
        (0..W * H)
            .flat_map(|i| {
                let v = if i % W < W / 2 { 0 } else { 255 };
                [v, v, v, 255]
            })
            .collect::<Vec<u8>>()
            .into_boxed_slice(),
    )
}

#[test]
#[allow(non_snake_case)]
fn a_fill_layer_renders_its_source_and_re_renders_on_edit__feat__image_layers_photoshop_parity() {
    let Some(ctx) = device() else { return };
    let mut s = grey(W, H, 40);
    let i = s
        .recorded("New Fill Layer", None, |s| {
            Ok(s.add_fill_layer("", FillSource::Solid { rgb: [200, 20, 10] }))
        })
        .expect("add");
    assert_eq!(s.layers()[i].name, "Color Fill 1");
    assert!(!s.composite_is_trivial(), "a stale fill needs the GPU");
    let out = fold(&s, ctx);
    assert!(out.chunks(4).all(|p| p == [200, 20, 10, 255]));
    assert!(pollster::block_on(s.refresh_fills(Some(ctx))).expect("render"));
    assert!(!s.layers()[i].fill().expect("fill").stale);
    s.recorded("Fill", None, |s| {
        s.set_fill(i, FillSource::Solid { rgb: [0, 0, 255] })
    })
    .expect("edit");
    assert!(fold(&s, ctx).chunks(4).all(|p| p == [0, 0, 255, 255]));
    // One undo step each: back to the red fill, then to no fill at all.
    s.undo().expect("undo edit");
    assert!(fold(&s, ctx).chunks(4).all(|p| p == [200, 20, 10, 255]));
    s.undo().expect("undo add");
    assert_eq!(s.len(), 1);
}

#[test]
#[allow(non_snake_case)]
fn a_typed_layer_folds_like_the_chain_it_stands_for__feat__image_layers_photoshop_parity() {
    let Some(ctx) = device() else { return };
    let mut chain = grey(W, H, 60);
    chain.add_adjustment_layer(
        "",
        Adjustment::Chain(AdjustParams {
            invert: true,
            exposure_ev: 0.0,
            ..AdjustParams::default()
        }),
        None,
    );
    let mut typed = grey(W, H, 60);
    typed.add_adjustment_layer("", Adjustment::Invert, None);
    assert_eq!(typed.layers()[1].name, "Invert 1");
    assert_eq!(fold(&chain, ctx)[..], fold(&typed, ctx)[..]);
    assert!(fold(&typed, ctx)
        .chunks(4)
        .all(|p| p == [195, 195, 195, 255]));
}

/// Gradient Map, Selective Color and Color Lookup run on the resident
/// accumulator: a black-to-red map turns a mid grey into a mid red; an
/// identity lookup and an all-zero selective colour change nothing.
#[test]
#[allow(non_snake_case)]
fn the_direct_adjustment_kinds_run_on_the_accumulator__feat__image_layers_photoshop_parity() {
    let Some(ctx) = device() else { return };
    let mut s = grey(W, H, 128);
    let base = fold(&s, ctx);
    s.add_adjustment_layer(
        "",
        Adjustment::GradientMap {
            stops: vec![
                ColorStop {
                    at: 0.0,
                    rgb: [0, 0, 0],
                },
                ColorStop {
                    at: 1.0,
                    rgb: [255, 0, 0],
                },
            ],
            reverse: false,
        },
        None,
    );
    let mapped = fold(&s, ctx);
    assert!(mapped
        .chunks(4)
        .all(|p| p[0].abs_diff(128) <= 2 && p[1] == 0 && p[2] == 0));
    // At half opacity the map mixes with the grey beneath.
    s.set_opacity(1, 0.5).expect("opacity");
    let half = fold(&s, ctx);
    assert!(
        half.chunks(4).all(|p| p[1].abs_diff(64) <= 2),
        "{:?}",
        &half[..4]
    );
    s.remove(1).expect("remove");
    for kind in ["colorLookup", "selectiveColor"] {
        s.add_adjustment_layer("", Adjustment::default_for(kind).expect("kind"), None);
        assert!(close(&fold(&s, ctx), &base, 1), "{kind} at its identity");
        s.remove(s.len() - 1).expect("remove");
    }
}

/// Fill opacity is opacity again on a normal layer; on a special mode it
/// acts inside the blend — fill 0 leaves the backdrop exactly, opacity
/// and fill at the same value give different pictures.
#[test]
#[allow(non_snake_case)]
fn fill_opacity_multiplies_on_normal_and_fades_to_neutral_on_special_modes__feat__image_layers_photoshop_parity(
) {
    let Some(ctx) = device() else { return };
    let layered = |opacity: f32, fill: f32, blend: &str| {
        let mut s = grey(W, H, 90);
        s.add("top");
        paint(&mut s, solid(W, H, [200, 100, 50, 255]));
        s.set_blend(1, blend).expect("blend");
        s.set_opacity(1, opacity).expect("opacity");
        s.set_fill_opacity(1, fill).expect("fill");
        s
    };
    let a = fold(&layered(1.0, 0.5, "normal"), ctx);
    let b = fold(&layered(0.5, 1.0, "normal"), ctx);
    assert_eq!(a[..], b[..], "normal: fill is opacity");
    let backdrop = fold(&grey(W, H, 90), ctx);
    let dodge0 = fold(&layered(1.0, 0.0, "linear_dodge"), ctx);
    assert!(
        close(&dodge0, &backdrop, 1),
        "fill 0 on a special mode is the backdrop"
    );
    let by_fill = fold(&layered(1.0, 0.5, "linear_dodge"), ctx);
    let by_opacity = fold(&layered(0.5, 1.0, "linear_dodge"), ctx);
    // Linear dodge: fill halves the source (90 + 100), opacity halves the
    // result's distance from the backdrop (90 + (255 − 90) / 2).
    assert!(by_fill[0].abs_diff(190) <= 2, "{}", by_fill[0]);
    assert!(by_opacity[0].abs_diff(173) <= 2, "{}", by_opacity[0]);
}

/// Blend If: This Layer's black slider at 128 drops the layer's dark
/// half, so the backdrop shows there; the Underlying Layer's white slider
/// below the backdrop's value hides the layer everywhere.
#[test]
#[allow(non_snake_case)]
fn blend_if_hides_a_layer_by_its_own_and_the_underlying_values__feat__image_layers_photoshop_parity(
) {
    let Some(ctx) = device() else { return };
    let mut s = grey(W, H, 100);
    s.add("halves");
    paint(&mut s, halves());
    let mut bi = BlendIf::default();
    bi.channels[0].this = [128, 128, 255, 255];
    s.set_blend_if(1, Some(bi)).expect("blend if");
    let out = fold(&s, ctx);
    for (i, p) in out.chunks(4).enumerate() {
        let want = if i as u32 % W < W / 2 { 100 } else { 255 };
        assert!(p[0].abs_diff(want) <= 1, "pixel {i}: {p:?}");
    }
    let mut under = BlendIf::default();
    under.channels[0].under = [0, 0, 80, 80];
    s.set_blend_if(1, Some(under)).expect("blend if");
    assert!(close(&fold(&s, ctx), &fold(&grey(W, H, 100), ctx), 1));
    // A split slider partly shows the layer.
    let mut split = BlendIf::default();
    split.channels[0].under = [0, 0, 50, 150];
    s.set_blend_if(1, Some(split)).expect("blend if");
    let mid = fold(&s, ctx);
    let v = mid[(W as usize - 1) * 4];
    assert!(v > 110 && v < 245, "a partial blend, got {v}");
    // Undo the three edits.
    assert!(s.set_blend_if(1, None).is_ok());
}

/// KNOCKOUT: a deep knockout at fill 0 cuts through every layer down to
/// the Background; a shallow one in a pass-through group stops at the
/// group's start.
#[test]
#[allow(non_snake_case)]
fn knockout_cuts_down_to_the_background_or_the_groups_start__feat__image_layers_photoshop_parity() {
    let Some(ctx) = device() else { return };
    let mut s = grey(W, H, 30);
    s.add("middle");
    paint(&mut s, solid(W, H, [0, 200, 0, 255]));
    s.add("hole");
    paint(&mut s, halves());
    s.set_fill_opacity(2, 0.0).expect("fill");
    s.set_knockout(2, Knockout::Deep).expect("knockout");
    let out = fold(&s, ctx);
    assert!(
        out.chunks(4).all(|p| p == [30, 30, 30, 255]),
        "the Background shows wherever the knockout layer has pixels"
    );
    // Shallow, in a pass-through group with the middle layer: the hole
    // reaches the group's start — the Background again here; with the
    // middle layer OUTSIDE the group beneath it, the hole stops at it.
    s.group_range(2, 2, "G").expect("group");
    s.set_knockout(2, Knockout::Shallow).expect("knockout");
    let shallow = fold(&s, ctx);
    assert!(
        shallow.chunks(4).all(|p| p == [0, 200, 0, 255]),
        "{:?}",
        &shallow[..4]
    );
    s.set_knockout(2, Knockout::None).expect("off");
    let plain = fold(&s, ctx);
    assert!(
        plain.chunks(4).all(|p| p == [0, 200, 0, 255]),
        "fill 0, no knockout: invisible"
    );
}

#[test]
#[allow(non_snake_case)]
fn the_locks_guard_alpha_position_and_everything__feat__image_layers_photoshop_parity() {
    let mut s = grey(4, 1, 10);
    s.add("half");
    paint(
        &mut s,
        Arc::from(vec![
            50, 50, 50, 255, 50, 50, 50, 0, 0, 0, 0, 0, 9, 9, 9, 128,
        ]),
    );
    s.set_locks(
        1,
        false,
        LayerLocks {
            transparency: true,
            ..LayerLocks::default()
        },
    )
    .expect("lock");
    paint(&mut s, solid(4, 1, [200, 0, 0, 255]));
    let a: Vec<u8> = s.layers()[1]
        .rgba
        .to_rgba8()
        .chunks(4)
        .map(|p| p[3])
        .collect();
    assert_eq!(a, vec![255, 0, 0, 128], "the alpha stays");
    assert_eq!(s.layers()[1].rgba.to_rgba8()[0], 200, "the colour lands");
    s.set_locks(
        1,
        false,
        LayerLocks {
            position: true,
            ..LayerLocks::default()
        },
    )
    .expect("lock");
    assert!(s.translate(&[1], 1, 0).is_err(), "position locked");
    s.set_locks(
        1,
        false,
        LayerLocks {
            all: true,
            ..LayerLocks::default()
        },
    )
    .expect("lock");
    assert!(s.set_opacity(1, 0.5).is_err());
    assert!(s.set_blend(1, "multiply").is_err());
    assert!(s.active_is_editable().is_err());
    assert!(s.set_visible(1, false).is_ok(), "visibility is not locked");
}

/// Merge Down, Merge Visible, Stamp Visible and Merge Group leave the
/// composite as it was; Flatten puts it over white; each is one undo step.
#[test]
#[allow(non_snake_case)]
fn the_merges_keep_the_picture_and_are_one_undo_step__feat__image_layers_photoshop_parity() {
    let Some(ctx) = device() else { return };
    let build = || {
        let mut s = grey(W, H, 80);
        s.add("a");
        paint(&mut s, halves());
        s.set_blend(1, "multiply").expect("blend");
        s.add("b");
        paint(&mut s, solid(W, H, [0, 0, 255, 255]));
        s.set_opacity(2, 0.4).expect("opacity");
        s.add_adjustment_layer("", Adjustment::Invert, None);
        s.set_visible(3, false).expect("hidden");
        s
    };
    let mut s = build();
    let before = fold(&s, ctx);
    // Merge Down keeps the picture when the lower layer blends normally
    // (onto a Multiply layer the merged pixels multiply, as in Photoshop),
    // and the lower layer's name and mode stay.
    s.set_blend(1, "normal").expect("normal");
    let normal = fold(&s, ctx);
    s.set_active(2).expect("active");
    let at = pollster::block_on(s.merge_down(Some(ctx))).expect("merge down");
    assert_eq!((at, s.len()), (1, 3));
    assert_eq!(s.layers()[1].name, "a");
    assert!(
        close(&fold(&s, ctx), &normal, 2),
        "merge down keeps the picture"
    );
    s.undo().expect("one step");
    assert_eq!(s.len(), 4);
    assert_eq!(fold(&s, ctx)[..], normal[..]);
    s.set_blend(1, "multiply").expect("multiply");

    let at = pollster::block_on(s.merge_visible(Some(ctx))).expect("merge visible");
    assert_eq!(s.len(), 2, "the merged layer and the hidden one");
    assert!(s.layers()[at].visible && !s.layers()[1 - at].visible);
    assert!(close(&fold(&s, ctx), &before, 1));
    s.undo().expect("one step");
    assert_eq!(s.len(), 4);

    let at = pollster::block_on(s.stamp_visible(Some(ctx))).expect("stamp");
    assert_eq!(s.len(), 5);
    assert_eq!(&s.layers()[at].rgba.to_rgba8()[..], &before[..]);
    s.undo().expect("one step");

    // An ISOLATED group's merge is its picture (a pass-through group's
    // members blend with what is below, which a merged layer cannot).
    s.group_range(1, 2, "G").expect("group");
    let gid = s.groups()[0].id;
    s.set_group_pass_through(gid, false).expect("isolated");
    s.set_group_opacity(gid, 0.7).expect("opacity");
    let grouped = fold(&s, ctx);
    let at = pollster::block_on(s.merge_group(gid, Some(ctx))).expect("merge group");
    assert_eq!(s.layers()[at].name, "G");
    assert!(
        (s.layers()[at].opacity - 0.7).abs() < 1e-6,
        "the group's opacity moves on"
    );
    assert!(s.groups().is_empty());
    assert!(close(&fold(&s, ctx), &grouped, 2));
    s.undo().expect("one step");
    assert_eq!(s.groups().len(), 1);
    s.ungroup(gid).expect("ungroup");

    pollster::block_on(s.flatten(Some(ctx))).expect("flatten");
    assert_eq!(s.len(), 1);
    assert_eq!(s.layers()[0].name, BACKGROUND_LAYER_NAME);
    assert!(
        close(&s.layers()[0].rgba.to_rgba8(), &before, 1),
        "opaque already"
    );
    s.undo().expect("one step");
    assert_eq!(s.len(), 4);
}

#[test]
#[allow(non_snake_case)]
fn flatten_puts_transparency_over_white__feat__image_layers_photoshop_parity() {
    let Some(ctx) = device() else { return };
    let mut s = LayerStack::from_image(2, 1, solid(2, 1, [0, 0, 0, 0])).expect("stack");
    s.add("dot");
    paint(&mut s, Arc::from(vec![255, 0, 0, 255, 0, 0, 0, 0]));
    pollster::block_on(s.flatten(Some(ctx))).expect("flatten");
    assert_eq!(
        &s.layers()[0].rgba.to_rgba8()[..],
        &[255, 0, 0, 255, 255, 255, 255, 255]
    );
}

/// Layer via Copy duplicates the selected pixels onto a new layer; via
/// Cut also takes them out, so the two layers still make the original.
#[test]
#[allow(non_snake_case)]
fn layer_via_copy_and_cut_split_the_selection_off__feat__image_layers_photoshop_parity() {
    let mut s = grey(4, 1, 0);
    s.add("paint");
    paint(&mut s, solid(4, 1, [10, 20, 30, 255]));
    let sel = SelectionCoverage::from_data(4, 1, vec![255, 255, 0, 128]).expect("sel");
    let copy = s.layer_via(&sel, false).expect("copy");
    assert_eq!(s.len(), 3);
    let a: Vec<u8> = s.layers()[copy]
        .rgba
        .to_rgba8()
        .chunks(4)
        .map(|p| p[3])
        .collect();
    assert_eq!(a, vec![255, 255, 0, 128]);
    s.undo().expect("one step");
    assert_eq!(s.len(), 2);
    s.set_active(1).expect("active");
    let cut = s.layer_via(&sel, true).expect("cut");
    let rest: Vec<u8> = s.layers()[1]
        .rgba
        .to_rgba8()
        .chunks(4)
        .map(|p| p[3])
        .collect();
    assert_eq!(rest, vec![0, 0, 255, 127]);
    assert_eq!(s.layers()[cut].name, "Layer 1");
    s.undo().expect("one step");
    assert_eq!(
        s.layers()[1]
            .rgba
            .to_rgba8()
            .chunks(4)
            .map(|p| p[3])
            .collect::<Vec<_>>(),
        vec![255; 4]
    );
    let empty = SelectionCoverage::from_data(4, 1, vec![0; 4]).expect("sel");
    assert!(s.layer_via(&empty, false).is_err(), "nothing selected");
}

#[test]
#[allow(non_snake_case)]
fn a_layer_comp_records_and_restores_visibility_position_and_appearance__feat__image_layers_photoshop_parity(
) {
    let mut s = grey(4, 1, 0);
    s.add("logo");
    paint(
        &mut s,
        Arc::from(vec![9, 9, 9, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    );
    let a = s
        .recorded("New Layer Comp", None, |s| {
            Ok(s.new_comp("Left", true, true, true))
        })
        .expect("comp");
    s.translate(&[1], 2, 0).expect("move");
    s.set_opacity(1, 0.3).expect("opacity");
    s.set_visible(0, false).expect("hide");
    let moved = s.layers()[1].rgba.to_rgba8().to_vec();
    assert_eq!(&moved[8..12], &[9, 9, 9, 255]);
    s.recorded("Apply Layer Comp", None, |s| s.apply_comp(a))
        .expect("apply");
    assert_eq!(&s.layers()[1].rgba.to_rgba8()[0..4], &[9, 9, 9, 255]);
    assert_eq!(s.layers()[1].opacity, 1.0);
    assert!(s.layers()[0].visible);
    s.undo().expect("one step");
    assert_eq!(s.layers()[1].rgba.to_rgba8().to_vec(), moved);
    s.recorded("Rename Layer Comp", None, |s| s.rename_comp(a, "Logo left"))
        .expect("rename");
    assert_eq!(s.comps()[0].name, "Logo left");
    s.recorded("Delete Layer Comp", None, |s| s.delete_comp(a))
        .expect("delete");
    assert!(s.comps().is_empty());
    s.undo().expect("one step");
    assert_eq!(s.comps().len(), 1);
}

#[test]
#[allow(non_snake_case)]
fn linked_layers_move_together_and_align_and_distribute__feat__image_layers_photoshop_parity() {
    let mut s = LayerStack::from_image(10, 1, solid(10, 1, [0, 0, 0, 0])).expect("stack");
    let dot = |x: usize| {
        let mut v = vec![0u8; 40];
        v[x * 4..x * 4 + 4].copy_from_slice(&[1, 2, 3, 255]);
        Arc::from(v.into_boxed_slice())
    };
    for x in [1, 2, 7] {
        s.add("dot");
        paint(&mut s, dot(x));
    }
    let link = s.link(&[1, 2]).expect("link");
    assert_eq!(s.with_links(1), vec![1, 2]);
    s.translate(&s.with_links(1), 1, 0).expect("move");
    assert_eq!(s.content_bounds(1).map(|b| b.x), Some(2));
    assert_eq!(s.content_bounds(2).map(|b| b.x), Some(3));
    s.align(&[1, 2, 3], AlignEdge::Left, Region::new(0, 0, 10, 1))
        .expect("align");
    assert!((1..=3).all(|i| s.content_bounds(i).map(|b| b.x) == Some(0)));
    s.align(&[1], AlignEdge::Right, Region::new(0, 0, 10, 1))
        .expect("align");
    assert_eq!(s.content_bounds(1).map(|b| b.x), Some(9));
    s.translate(&[2], 4, 0).expect("move");
    s.distribute(&[1, 2, 3], Axis::Horizontal)
        .expect("distribute");
    let xs: Vec<i32> = (1..=3)
        .map(|i| s.content_bounds(i).expect("dot").x)
        .collect();
    assert_eq!(xs, vec![9, 5, 0], "centres evenly spaced");
    s.unlink(1).expect("unlink");
    assert_eq!(
        s.linked(link),
        Vec::<usize>::new(),
        "a link of one dissolves"
    );
}

/// Everything a parity stack carries survives the manifest (version 4),
/// and a version-3 manifest's one-stage chain opens as its typed layer.
#[test]
#[allow(non_snake_case)]
fn the_parity_properties_round_trip_the_manifest__feat__image_layers_photoshop_parity() {
    let mut s = grey(W, H, 10);
    s.add_fill_layer(
        "",
        FillSource::Pattern(PatternFill {
            name: "dots".into(),
            tile: solid(2, 2, [5, 6, 7, 255]),
            width: 2,
            height: 2,
            scale: 50.0,
            angle: 15.0,
        }),
    );
    s.add_adjustment_layer(
        "",
        Adjustment::ColorLookup {
            name: "look".into(),
            cube: identity_cube(),
        },
        None,
    );
    s.add_adjustment_layer("", Adjustment::Posterize { levels: 6.0 }, None);
    let mut bi = BlendIf::default();
    bi.channels[2].this = [10, 20, 240, 250];
    s.set_blend_if(1, Some(bi)).expect("bi");
    s.set_fill_opacity(1, 0.25).expect("fill");
    s.set_knockout(1, Knockout::Deep).expect("ko");
    s.set_color(1, 4).expect("label");
    s.set_locks(
        1,
        true,
        LayerLocks {
            transparency: true,
            position: false,
            all: true,
        },
    )
    .expect("locks");
    s.link(&[0, 1]).expect("link");
    s.group_range(2, 3, "Grade").expect("group");
    let gid = s.groups()[0].id;
    s.set_group_color(gid, 3).expect("group label");
    s.new_comp("A", true, true, true);
    let (m, bufs) = s.export();
    let back = LayerStack::import(&m, &bufs).expect("import");
    let (m2, bufs2) = back.export();
    assert_eq!(m, m2, "byte for byte");
    assert_eq!(bufs.len(), bufs2.len());
    let l = &back.layers()[1];
    assert_eq!(l.ext, s.layers()[1].ext);
    assert_eq!(l.fill(), s.layers()[1].fill());
    assert_eq!(back.layers()[2].adjustment(), s.layers()[2].adjustment());
    assert_eq!(back.groups()[0].color, 3);
    assert_eq!(back.comps().len(), 1);
    assert!(back.comps()[0].entries[0].pixels.is_some());

    // Version 3 knew one kind of adjustment layer: the chain.
    let mut old = grey(W, H, 10);
    old.add_adjustment_layer(
        "",
        Adjustment::Chain(AdjustParams {
            invert: true,
            ..AdjustParams::default()
        }),
        None,
    );
    let (m3, b3) = old.export_with(3);
    let migrated = LayerStack::import(&m3, &b3).expect("v3 opens");
    assert_eq!(migrated.layers()[1].adjustment(), Some(&Adjustment::Invert));
}
