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

//! THE BRUSH ENGINE on the device: every Brush Settings pane and every
//! tool the engine adds, painted through `StrokeSession` on the real GPU
//! (Metal here), plus the deterministic DYNAMICS TAPES — a seeded stroke
//! with jitter, scatter, colour dynamics and symmetry replays to the same
//! bytes, and its incremental composite equals a from-scratch one built
//! from the same public planner.
//!
//! GPU-only (every pixel is a kernel dispatch); skips without a device
//! unless `PAGED_REQUIRE_GPU=1`.

use std::sync::Arc;

use image_core::Region;
use image_gpu::brush::{CombineKind, OrientedTip, StampSpec};
use image_gpu::dynamics::{
    plan_pen_segment, BaseBrush, BrushDynamics, ColorPane, Control, DabPlanner, DualPane, Jitter,
    PenDab, PenSample, Scatter, ShapeDynamics, Symmetry, SymmetryKind, TexturePane, ToolOptions,
    TransferPane,
};
use image_gpu::{
    composite_stroke_window, GpuContext, SampledTip, SelectionCoverage, StrokeAccumulator,
};
use image_js::stroke::{blend_kernel, StrokeParams, StrokeSession, StrokeTool};

const W: u32 = 64;
const H: u32 = 48;

fn ctx() -> Option<&'static GpuContext> {
    image_gpu::test_support::device_or_skip("brush engine")
}

fn solid(r: u8, g: u8, b: u8, a: u8) -> Arc<[u8]> {
    Arc::from(
        (0..W * H)
            .flat_map(|_| [r, g, b, a])
            .collect::<Vec<u8>>()
            .into_boxed_slice(),
    )
}

/// Left half red, right half blue — a colour edge for the wet tools.
fn split() -> Arc<[u8]> {
    Arc::from(
        (0..W * H)
            .flat_map(|i| {
                if i % W < W / 2 {
                    [220u8, 20, 20, 255]
                } else {
                    [20u8, 20, 220, 255]
                }
            })
            .collect::<Vec<u8>>()
            .into_boxed_slice(),
    )
}

fn px(buf: &[u8], x: u32, y: u32) -> [u8; 4] {
    let i = ((y * W + x) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

fn params(tool: StrokeTool, size: f32) -> StrokeParams {
    let mut p = StrokeParams::defaults(tool);
    p.size = size;
    p.hardness = 1.0;
    p.pressure = image_gpu::PressureTarget::None;
    p
}

fn paint(
    ctx: &GpuContext,
    base: &Arc<[u8]>,
    p: StrokeParams,
    d: BrushDynamics,
    samples: &[(f32, f32)],
    setup: impl FnOnce(&mut StrokeSession),
) -> Vec<u8> {
    let mut s = StrokeSession::begin_on(1, W, H, Arc::clone(base), p, None).expect("begin");
    s.set_dynamics(d);
    setup(&mut s);
    for &(x, y) in samples {
        pollster::block_on(s.extend_pen(ctx, PenSample::at(x, y, 1.0))).expect("extend");
    }
    pollster::block_on(s.finish(ctx)).expect("finish");
    s.commit()
}

fn line() -> Vec<(f32, f32)> {
    (0..=8).map(|i| (8.0 + i as f32 * 6.0, 24.0)).collect()
}

fn changed(a: &[u8], b: &[u8]) -> usize {
    a.chunks(4).zip(b.chunks(4)).filter(|(x, y)| x != y).count()
}

fn jitter(j: f32) -> Jitter {
    Jitter {
        jitter: j,
        ..Jitter::default()
    }
}

fn rich(seed: u32) -> BrushDynamics {
    BrushDynamics {
        seed,
        shape: Some(ShapeDynamics {
            size: jitter(0.6),
            min_diameter: 0.2,
            angle: jitter(0.5),
            roundness: jitter(0.5),
            min_roundness: 0.3,
            ..ShapeDynamics::default()
        }),
        scatter: Some(Scatter {
            amount: jitter(1.0),
            both_axes: true,
            count: 2,
            count_jitter: Jitter::default(),
        }),
        color: Some(ColorPane {
            fg_bg: jitter(0.5),
            hue: 0.3,
            per_tip: true,
            ..ColorPane::default()
        }),
        transfer: Some(TransferPane {
            opacity: jitter(0.4),
            flow: jitter(0.3),
        }),
        symmetry: Symmetry {
            kind: SymmetryKind::Vertical,
            cx: 0.5,
            cy: 0.5,
            angle: 0.0,
            segments: 2,
        },
        background: [0.0, 0.8, 0.2],
        ..BrushDynamics::default()
    }
}

// ── tapes ────────────────────────────────────────────────────────────

#[test]
#[allow(non_snake_case)]
fn a_seeded_dynamics_tape_replays_to_identical_bytes__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(240, 240, 240, 255);
    let p = params(StrokeTool::Brush, 10.0);
    let a = paint(ctx, &base, p, rich(11), &line(), |_| {});
    let b = paint(ctx, &base, p, rich(11), &line(), |_| {});
    assert!(a == b, "the same seed must replay bit-identically");
    let c = paint(ctx, &base, p, rich(12), &line(), |_| {});
    assert!(a != c, "another seed jitters differently");
    // Symmetry: the mirror half is painted too.
    assert!(changed(&a[..], &base[..]) > 50);
    let left = (0..W / 2).any(|x| (0..H).any(|y| px(&a, x, y) != px(&base, x, y)));
    let right = (W / 2..W).any(|x| (0..H).any(|y| px(&a, x, y) != px(&base, x, y)));
    assert!(left && right);
}

/// The accumulating lane's identity, with dynamics: the incremental
/// stroke equals ONE composite of the whole accumulated stroke, rebuilt
/// from the public planner, oriented tip and accumulator.
#[test]
#[allow(non_snake_case)]
fn incremental_dynamics_stroke_equals_from_scratch__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(200, 210, 220, 255);
    let mut p = params(StrokeTool::Brush, 9.0);
    p.hardness = 0.4;
    p.color = [0.1, 0.2, 0.9, 1.0];
    p.blend = blend_kernel("multiply").expect("multiply");
    let mut d = rich(5);
    d.color = None;
    let samples = line();
    let inc = paint(ctx, &base, p, d, &samples, |_| {});

    let p = p.sanitized();
    let mut planner = DabPlanner::new(
        d,
        BaseBrush {
            diameter: p.size,
            flow: p.flow,
            pressure: p.pressure,
            color: [p.color[0], p.color[1], p.color[2]],
        },
        W,
        H,
    );
    let mut acc = StrokeAccumulator::new(W, H);
    let mut residual = 0.0;
    let mut last: Option<PenSample> = None;
    for &(x, y) in &samples {
        let s = PenSample::at(x, y, 1.0);
        let mut pens = Vec::new();
        match last {
            None => pens.push(PenDab::of(s, 0.0)),
            Some(prev) => plan_pen_segment(&mut residual, prev, s, p.step_px(), &mut pens),
        }
        last = Some(s);
        let mut stamps = Vec::new();
        for pen in pens {
            planner.plan(pen, &mut stamps);
        }
        for st in stamps {
            let tip = OrientedTip {
                diameter: st.diameter,
                hardness: p.hardness,
                antialias: true,
                angle_deg: st.angle,
                roundness: st.roundness,
                flip_x: st.flip_x,
                flip_y: st.flip_y,
                bitmap: None,
            };
            acc.stamp_spec(&StampSpec {
                tip: &tip,
                cx: st.x,
                cy: st.y,
                flow: st.flow,
                ceiling: st.ceiling,
                color: None,
                modulate: None,
            });
        }
    }
    let mask = acc.mask_window_f16(Region::new(0, 0, W, H), p.opacity, None);
    let to_f16: Vec<u8> = base
        .iter()
        .flat_map(|&b| half::f16::from_f32(b as f32 / 255.0).to_le_bytes())
        .collect();
    let out = pollster::block_on(composite_stroke_window(
        ctx,
        &p.solid_paint_mode().expect("brush"),
        &to_f16,
        &mask,
        W,
        H,
    ))
    .expect("composite");
    let mut full = base.to_vec();
    for y in 0..H {
        for x in 0..W {
            if acc.effective_at(x, y, p.opacity, None) > 0.0 {
                let i = ((y * W + x) * 4) as usize;
                for c in 0..4 {
                    let j = (i + c) * 2;
                    let v = half::f16::from_le_bytes([out[j], out[j + 1]]).to_f32();
                    full[i + c] = (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                }
            }
        }
    }
    assert!(inc == full, "{} texels differ", changed(&inc, &full));
}

#[test]
#[allow(non_snake_case)]
fn a_plain_brush_through_the_engine_door_is_the_pre_engine_stroke__feat__image_editor_brush_engine()
{
    let Some(ctx) = ctx() else { return };
    let base = solid(240, 240, 240, 255);
    let p = params(StrokeTool::Brush, 8.0);
    let via_pen = paint(ctx, &base, p, BrushDynamics::default(), &line(), |_| {});
    let mut s = StrokeSession::begin_on(1, W, H, Arc::clone(&base), p, None).unwrap();
    for (x, y) in line() {
        pollster::block_on(s.extend(ctx, image_gpu::StrokeSample::new(x, y, 1.0))).unwrap();
    }
    assert!(via_pen == s.commit());
}

// ── panes ────────────────────────────────────────────────────────────

#[test]
#[allow(non_snake_case)]
fn tip_angle_and_roundness_paint_an_oriented_ellipse__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(255, 255, 255, 255);
    let p = params(StrokeTool::Brush, 30.0);
    let mut d = BrushDynamics::default();
    d.tip.angle = 90.0;
    d.tip.roundness = 0.25;
    let out = paint(ctx, &base, p, d, &[(32.0, 24.0)], |_| {});
    assert_eq!(px(&out, 32, 24 - 12)[0], 0, "long axis is vertical");
    assert_eq!(
        px(&out, 32 + 12, 24),
        px(&base, 32 + 12, 24),
        "short across"
    );
}

#[test]
#[allow(non_snake_case)]
fn a_sampled_tip_paints_its_bitmap__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(255, 255, 255, 255);
    // A bar along the top of an 8×8 bitmap.
    let mut alpha = vec![0u8; 64];
    alpha[..16].fill(255);
    let tip = SampledTip::new(8, 8, alpha).unwrap();
    let p = params(StrokeTool::Brush, 16.0);
    let out = paint(
        ctx,
        &base,
        p,
        BrushDynamics::default(),
        &[(32.0, 24.0)],
        |s| s.set_tip_bitmap(Some(tip)),
    );
    assert_eq!(px(&out, 32, 24 - 6)[0], 0, "the bar lands");
    assert_eq!(
        px(&out, 32, 24 + 4),
        px(&base, 32, 24 + 4),
        "the rest is clear"
    );
}

#[test]
#[allow(non_snake_case)]
fn texture_and_dual_tip_cut_the_coverage__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(255, 255, 255, 255);
    let p = params(StrokeTool::Brush, 20.0);
    let plain = paint(ctx, &base, p, BrushDynamics::default(), &line(), |_| {});
    // A 2×2 checker texture at depth 1, multiply: half the paint is cut.
    let pattern: Arc<[u8]> = Arc::from(
        vec![
            0u8, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
        ]
        .into_boxed_slice(),
    );
    let tex = BrushDynamics {
        texture: Some(TexturePane {
            scale: 2.0,
            mode: CombineKind::Multiply,
            depth: 1.0,
            each_tip: false,
            ..TexturePane::default()
        }),
        ..BrushDynamics::default()
    };
    let textured = paint(ctx, &base, p, tex, &line(), |s| {
        s.set_texture_source(2, 2, Arc::clone(&pattern)).unwrap()
    });
    assert!(changed(&textured, &base) < changed(&plain, &base));
    let dual = BrushDynamics {
        dual: Some(DualPane {
            mode: CombineKind::Multiply,
            diameter: 4.0,
            spacing: 3.0,
            count: 1,
            roundness: 1.0,
            ..DualPane::default()
        }),
        ..BrushDynamics::default()
    };
    let dualed = paint(ctx, &base, p, dual, &line(), |_| {});
    assert!(changed(&dualed, &base) < changed(&plain, &base) / 2);
}

#[test]
#[allow(non_snake_case)]
fn lock_transparent_pixels_keeps_the_layer_alpha__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    // Opaque left half, transparent right half.
    let base: Arc<[u8]> = Arc::from(
        (0..W * H)
            .flat_map(|i| {
                if i % W < W / 2 {
                    [255u8, 255, 255, 255]
                } else {
                    [0, 0, 0, 0]
                }
            })
            .collect::<Vec<u8>>()
            .into_boxed_slice(),
    );
    let p = params(StrokeTool::Brush, 12.0);
    let d = BrushDynamics {
        lock_alpha: true,
        ..BrushDynamics::default()
    };
    let out = paint(ctx, &base, p, d, &line(), |_| {});
    for x in 0..W {
        assert_eq!(px(&out, x, 24)[3], px(&base, x, 24)[3], "alpha at x={x}");
    }
    assert_eq!(px(&out, 20, 24)[0], 0, "the opaque half is painted");
    // The locked eraser paints the background colour instead.
    let e = BrushDynamics {
        lock_alpha: true,
        background: [1.0, 0.0, 0.0],
        ..BrushDynamics::default()
    };
    let erased = paint(
        ctx,
        &base,
        params(StrokeTool::Eraser, 12.0),
        e,
        &line(),
        |_| {},
    );
    assert_eq!(px(&erased, 20, 24), [255, 0, 0, 255]);
}

#[test]
#[allow(non_snake_case)]
fn wet_edges_and_build_up_change_the_deposit__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(255, 255, 255, 255);
    let p = params(StrokeTool::Brush, 20.0);
    let wet = BrushDynamics {
        wet_edges: true,
        ..BrushDynamics::default()
    };
    let out = paint(ctx, &base, p, wet, &[(32.0, 24.0)], |_| {});
    assert!(
        px(&out, 32, 24)[0] > 100,
        "the interior lands at about half"
    );
    let mut flow = params(StrokeTool::Brush, 20.0);
    flow.flow = 0.2;
    let air = BrushDynamics {
        build_up: true,
        ..BrushDynamics::default()
    };
    let once = paint(ctx, &base, flow, air, &[(32.0, 24.0)], |_| {});
    let held = paint(ctx, &base, flow, air, &[(32.0, 24.0); 6], |_| {});
    assert!(
        px(&held, 32, 24)[0] < px(&once, 32, 24)[0],
        "a held airbrush builds up"
    );
}

#[test]
#[allow(non_snake_case)]
fn smoothing_trails_the_pointer_and_catches_up_on_release__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(255, 255, 255, 255);
    let p = params(StrokeTool::Brush, 4.0);
    let mut d = BrushDynamics::default();
    d.smoothing.radius = 20.0;
    d.smoothing.catch_up_end = false;
    let short = paint(ctx, &base, p, d, &[(8.0, 24.0), (40.0, 24.0)], |_| {});
    assert_eq!(
        px(&short, 38, 24),
        px(&base, 38, 24),
        "the string has slack"
    );
    d.smoothing.catch_up_end = true;
    let caught = paint(ctx, &base, p, d, &[(8.0, 24.0), (40.0, 24.0)], |_| {});
    assert_ne!(
        px(&caught, 39, 24),
        px(&base, 39, 24),
        "release lands on the pointer"
    );
}

// ── tools ────────────────────────────────────────────────────────────

#[test]
#[allow(non_snake_case)]
fn smudge_drags_colour_across_an_edge__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = split();
    let d = BrushDynamics {
        tools: ToolOptions {
            smudge_strength: 0.8,
            ..ToolOptions::default()
        },
        ..BrushDynamics::default()
    };
    let stroke: Vec<(f32, f32)> = (0..12).map(|i| (16.0 + i as f32 * 3.0, 24.0)).collect();
    let out = paint(
        ctx,
        &base,
        params(StrokeTool::Smudge, 10.0),
        d,
        &stroke,
        |_| {},
    );
    let past = px(&out, 40, 24);
    assert!(past[0] > 60, "red dragged into the blue half: {past:?}");
    let again = paint(
        ctx,
        &base,
        params(StrokeTool::Smudge, 10.0),
        d,
        &stroke,
        |_| {},
    );
    assert!(out == again, "the wet lane replays too");
}

#[test]
#[allow(non_snake_case)]
fn the_mixer_brush_lays_its_load_and_picks_up_the_canvas__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = split();
    let mut p = params(StrokeTool::Mixer, 10.0);
    p.color = [0.0, 1.0, 0.0, 1.0];
    let d = BrushDynamics {
        tools: ToolOptions {
            mixer_wet: 0.5,
            mixer_load: 0.3,
            mixer_mix: 0.5,
            mixer_flow: 1.0,
            ..ToolOptions::default()
        },
        ..BrushDynamics::default()
    };
    let out = paint(ctx, &base, p, d, &line(), |_| {});
    let c = px(&out, 14, 24);
    assert!(c[1] > 60, "green from the reservoir: {c:?}");
    assert!(c[0] > 10, "mixed with the red under it: {c:?}");
}

#[test]
#[allow(non_snake_case)]
fn the_history_brush_paints_the_earlier_state_back__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let now = solid(0, 0, 0, 255);
    let then = solid(10, 200, 30, 255);
    let out = paint(
        ctx,
        &now,
        params(StrokeTool::History, 10.0),
        BrushDynamics::default(),
        &line(),
        |s| s.set_alt_source(Arc::clone(&then)).unwrap(),
    );
    assert_eq!(px(&out, 32, 24), [10, 200, 30, 255]);
    assert_eq!(px(&out, 32, 2), [0, 0, 0, 255], "only under the stroke");
}

#[test]
#[allow(non_snake_case)]
fn the_art_history_brush_paints_strokes_in_the_source_colours__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let now = solid(255, 255, 255, 255);
    let then = solid(200, 30, 30, 255);
    let mut d = BrushDynamics {
        seed: 3,
        ..BrushDynamics::default()
    };
    d.tools.art_area = 20.0;
    d.tools.art_fidelity = 1.0;
    let out = paint(
        ctx,
        &now,
        params(StrokeTool::ArtHistory, 6.0),
        d,
        &line(),
        |s| s.set_alt_source(Arc::clone(&then)).unwrap(),
    );
    let red = out
        .chunks(4)
        .filter(|c| c[0] > 150 && c[1] < 80 && c[2] < 80)
        .count();
    assert!(red > 30, "the source's red lands as strokes ({red})");
    // A tolerance above the difference paints nothing.
    d.tools.art_tolerance = 1.0;
    let none = paint(
        ctx,
        &now,
        params(StrokeTool::ArtHistory, 6.0),
        d,
        &line(),
        |s| s.set_alt_source(Arc::clone(&then)).unwrap(),
    );
    assert!(none == now.to_vec());
}

#[test]
#[allow(non_snake_case)]
fn the_background_eraser_erases_only_the_sampled_colour__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = split();
    let mut d = BrushDynamics::default();
    d.tools.erase_sampling = 1; // once — the red under the first dab
    d.tools.erase_limits = 0;
    d.tools.erase_tolerance = 0.2;
    let stroke: Vec<(f32, f32)> = (0..10).map(|i| (20.0 + i as f32 * 3.0, 24.0)).collect();
    let out = paint(
        ctx,
        &base,
        params(StrokeTool::BackgroundEraser, 14.0),
        d,
        &stroke,
        |_| {},
    );
    assert_eq!(px(&out, 24, 24)[3], 0, "red erased");
    assert_eq!(px(&out, 40, 24)[3], 255, "blue kept");
    // Protect foreground keeps the foreground colour.
    let mut p = params(StrokeTool::BackgroundEraser, 14.0);
    p.color = [220.0 / 255.0, 20.0 / 255.0, 20.0 / 255.0, 1.0];
    d.tools.erase_protect_fg = true;
    let kept = paint(ctx, &base, p, d, &stroke, |_| {});
    assert_eq!(px(&kept, 24, 24)[3], 255);
}

#[test]
#[allow(non_snake_case)]
fn colour_replacement_recolours_only_the_sampled_colour__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = split();
    let mut p = params(StrokeTool::ColorReplace, 14.0);
    p.blend = blend_kernel("hue").unwrap();
    p.color = [0.0, 0.8, 0.0, 1.0];
    let mut d = BrushDynamics::default();
    d.tools.replace_sampling = 1;
    d.tools.replace_tolerance = 0.2;
    let stroke: Vec<(f32, f32)> = (0..10).map(|i| (20.0 + i as f32 * 3.0, 24.0)).collect();
    let out = paint(ctx, &base, p, d, &stroke, |_| {});
    let c = px(&out, 24, 24);
    assert!(c[1] > c[0], "red turned green in hue: {c:?}");
    assert_eq!(px(&out, 40, 24), px(&base, 40, 24), "blue untouched");
}

#[test]
#[allow(non_snake_case)]
fn the_magic_eraser_field_erases_the_wand_region__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = split();
    let field = SelectionCoverage::magic_wand(W, H, &base, 4, 4, 10, true);
    let mut s = StrokeSession::begin_on(
        1,
        W,
        H,
        Arc::clone(&base),
        params(StrokeTool::Eraser, 1.0),
        None,
    )
    .unwrap();
    assert!(pollster::block_on(s.paint_field(ctx, &field)).unwrap());
    let out = s.commit();
    assert_eq!(px(&out, 10, 10)[3], 0);
    assert_eq!(px(&out, 50, 10)[3], 255);
}

#[test]
#[allow(non_snake_case)]
fn every_symmetry_kind_paints_its_copies__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(255, 255, 255, 255);
    let p = params(StrokeTool::Brush, 4.0);
    let single = paint(
        ctx,
        &base,
        p,
        BrushDynamics::default(),
        &[(44.0, 14.0)],
        |_| {},
    );
    for kind in [
        SymmetryKind::Vertical,
        SymmetryKind::Horizontal,
        SymmetryKind::Dual,
        SymmetryKind::Diagonal,
        SymmetryKind::Wavy,
        SymmetryKind::Circle,
        SymmetryKind::Spiral,
        SymmetryKind::Radial,
        SymmetryKind::Mandala,
    ] {
        let d = BrushDynamics {
            symmetry: Symmetry {
                kind,
                cx: 0.5,
                cy: 0.5,
                angle: 0.0,
                segments: 4,
            },
            ..BrushDynamics::default()
        };
        let out = paint(ctx, &base, p, d, &[(44.0, 14.0)], |_| {});
        assert!(
            changed(&out, &base) > changed(&single, &base),
            "{kind:?} paints more than one dab"
        );
    }
}

#[test]
#[allow(non_snake_case)]
fn pen_pressure_control_thins_the_stroke__feat__image_editor_brush_engine() {
    let Some(ctx) = ctx() else { return };
    let base = solid(255, 255, 255, 255);
    let d = BrushDynamics {
        shape: Some(ShapeDynamics {
            size: Jitter {
                control: Control::PenPressure,
                ..Jitter::default()
            },
            ..ShapeDynamics::default()
        }),
        ..BrushDynamics::default()
    };
    let mut s = StrokeSession::begin_on(
        1,
        W,
        H,
        Arc::clone(&base),
        params(StrokeTool::Brush, 20.0),
        None,
    )
    .unwrap();
    s.set_dynamics(d);
    pollster::block_on(s.extend_pen(ctx, PenSample::at(32.0, 24.0, 0.25))).unwrap();
    let light = s.commit();
    let heavy = paint(
        ctx,
        &base,
        params(StrokeTool::Brush, 20.0),
        d,
        &[(32.0, 24.0)],
        |_| {},
    );
    assert!(changed(&light, &base) * 4 < changed(&heavy, &base));
}
