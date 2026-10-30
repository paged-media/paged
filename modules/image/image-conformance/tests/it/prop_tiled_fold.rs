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

//! The TILED fold against the whole one (image ADR 480).
//!
//! Past the device's texture or buffer limit the layer fold runs tile by
//! tile, each tile widened by the plan's halo. Its claim: every texel is
//! the whole fold's. Two identical stacks take the same random edits; one
//! folds whole, the other in tiles of 16 or 32 px, so a 70 × 45 canvas
//! has up to fifteen tiles and every style and blur crosses tile edges.
//! The tiled stack also keeps its last result and refolds only the tiles
//! a pixel or mask edit damaged, so the edits test that too.
//!
//! And a canvas WIDER than this device's texture limit, which only the
//! tiled fold can composite, against the blend's arithmetic.

#![allow(non_snake_case)]

use std::sync::Arc;

use image_core::Region;
use image_gpu::coverage::SelectionCoverage;
use image_gpu::GpuContext;
use image_js::fill::GradientKind;
use image_js::ingest::AdjustParams;
use image_js::layers::{ColorStop, FillSource, GradientFill, LayerStack, PatternFill};
use image_js::pixels::Pixels;
use image_psd::effects::{
    Bevel, BlendMode, ColorFill, Glow, GlowTechnique, GradientOverlay, LayerStyle,
    PatternFill as StylePattern, PatternOverlay, Satin, Shadow, Stroke, StrokeFill, StrokePosition,
};
use proptest::prelude::*;

fn device() -> Option<&'static GpuContext> {
    image_gpu::test_support::device_or_skip("prop_tiled_fold")
}

const BLENDS: &[&str] = &[
    "normal",
    "multiply",
    "screen",
    "overlay",
    "difference",
    "color",
];

fn pixels(w: u32, h: u32, seed: u32, alpha: u8) -> Arc<[u8]> {
    let mut v = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let s = seed.wrapping_mul(2654435761) ^ (x * 31 + y * 17);
            let a = match alpha {
                0 => 255,
                1 => 60 + (s % 150) as u8,
                // A blob: opaque inside an ellipse, transparent outside —
                // the shape a style draws around.
                _ => {
                    let (cx, cy) = ((seed % w) as f32, (seed / 7 % h) as f32);
                    let (dx, dy) = ((x as f32 - cx) / 14.0, (y as f32 - cy) / 9.0);
                    if dx * dx + dy * dy < 1.0 {
                        255
                    } else {
                        0
                    }
                }
            };
            v.extend_from_slice(&[
                (s % 251) as u8,
                (s / 7 % 253) as u8,
                (x * 9).wrapping_add(seed) as u8,
                a,
            ]);
        }
    }
    Arc::from(v)
}

fn mask(w: u32, h: u32, kind: u8) -> Arc<SelectionCoverage> {
    Arc::new(match kind {
        0 => SelectionCoverage::rasterize_rect(w, h, 5.0, 3.0, w as f32 / 2.0, h as f32 - 6.0),
        _ => SelectionCoverage::from_data(w, h, (0..w * h).map(|i| (i * 37 % 256) as u8).collect())
            .expect("mask"),
    })
}

fn style(kind: u8, noise: f32) -> LayerStyle {
    let mut s = LayerStyle::default();
    match kind {
        0 => {
            s.drop_shadows = vec![Shadow {
                noise,
                distance: 4.0,
                size: 5.0,
                ..Shadow::drop_default()
            }]
        }
        1 => {
            s.outer_glow = Some(Glow {
                size: 6.0,
                noise,
                ..Glow::default()
            });
            s.inner_shadows = vec![Shadow::inner_default()];
        }
        2 => {
            s.strokes = vec![Stroke {
                size: 3.0,
                position: StrokePosition::Outside,
                ..Stroke::default()
            }];
            s.inner_glow = Some(Glow {
                technique: GlowTechnique::Precise,
                size: 4.0,
                ..Glow::default()
            });
        }
        3 => {
            s.satin = Some(Satin::default());
            s.color_overlays = vec![ColorFill {
                color: [200, 40, 90],
                opacity: 50.0,
                ..ColorFill::default()
            }];
        }
        4 => {
            let mut g = GradientOverlay::default();
            g.fill.align = false;
            g.fill.angle = 30.0;
            s.gradient_overlays = vec![g];
            s.strokes = vec![Stroke {
                size: 2.0,
                position: StrokePosition::Center,
                fill: StrokeFill::Gradient(Default::default()),
                ..Stroke::default()
            }];
        }
        5 => {
            s.pattern_overlay = Some(PatternOverlay {
                fill: StylePattern {
                    pattern: image_psd::effects::PatternRef {
                        id: String::new(),
                        name: "dots".into(),
                    },
                    ..StylePattern::default()
                },
                opacity: 70.0,
                blend: BlendMode::Normal,
                ..PatternOverlay::default()
            });
        }
        _ => s.bevel = Some(Bevel::default()),
    }
    s
}

#[derive(Debug, Clone)]
enum LayerGen {
    Pixel {
        seed: u32,
        alpha: u8,
    },
    Bounded {
        seed: u32,
        x: u32,
        y: u32,
    },
    Styled {
        seed: u32,
        kind: u8,
        noise: bool,
    },
    Adjust {
        exposure: f32,
        blur: bool,
        sharpen: bool,
    },
    Gradient {
        kind: u8,
        angle: f32,
    },
}

#[derive(Debug, Clone)]
enum Edit {
    Opacity(usize, f32),
    Blend(usize, usize),
    Visible(usize, bool),
    Paint(usize, u32, u8),
    Mask(usize, u8),
    Clip(usize, bool),
    Group(usize, usize, bool, f32),
    /// A few small rectangles painted into layer k, each composited.
    Dabs(usize, u32, u8),
    Recomposite,
}

fn layer_gen() -> impl Strategy<Value = LayerGen> {
    prop_oneof![
        3 => (any::<u32>(), 0u8..3).prop_map(|(seed, alpha)| LayerGen::Pixel { seed, alpha }),
        1 => (any::<u32>(), 0u32..40, 0u32..30)
            .prop_map(|(seed, x, y)| LayerGen::Bounded { seed, x, y }),
        3 => (any::<u32>(), 0u8..7, any::<bool>())
            .prop_map(|(seed, kind, noise)| LayerGen::Styled { seed, kind, noise }),
        1 => (-1.0f32..1.0, any::<bool>(), any::<bool>())
            .prop_map(|(exposure, blur, sharpen)| LayerGen::Adjust { exposure, blur, sharpen }),
        1 => (0u8..5, 0.0f32..360.0).prop_map(|(kind, angle)| LayerGen::Gradient { kind, angle }),
    ]
}

fn edit_gen() -> impl Strategy<Value = Edit> {
    prop_oneof![
        1 => (0usize..8, 0.0f32..1.0).prop_map(|(i, o)| Edit::Opacity(i, o)),
        1 => (0usize..8, 0usize..BLENDS.len()).prop_map(|(i, b)| Edit::Blend(i, b)),
        1 => (0usize..8, any::<bool>()).prop_map(|(i, v)| Edit::Visible(i, v)),
        1 => (0usize..8, any::<u32>(), 0u8..3).prop_map(|(i, s, a)| Edit::Paint(i, s, a)),
        1 => (0usize..8, 0u8..2).prop_map(|(i, k)| Edit::Mask(i, k)),
        1 => (0usize..8, any::<bool>()).prop_map(|(i, c)| Edit::Clip(i, c)),
        1 => (0usize..8, 0usize..8, any::<bool>(), 0.3f32..1.0)
            .prop_map(|(a, b, p, o)| Edit::Group(a, b, p, o)),
        3 => (0usize..8, any::<u32>(), 1u8..4).prop_map(|(i, s, n)| Edit::Dabs(i, s, n)),
        1 => Just(Edit::Recomposite),
    ]
}

fn dots() -> PatternFill {
    let (w, h) = (5u32, 3u32);
    PatternFill {
        name: "dots".into(),
        tile: Arc::from(
            (0..w * h)
                .flat_map(|i| [(i * 50) as u8, 255 - (i * 30) as u8, 90, 255])
                .collect::<Vec<u8>>(),
        ),
        width: w,
        height: h,
        scale: 100.0,
        angle: 0.0,
    }
}

fn build(w: u32, h: u32, gens: &[LayerGen]) -> LayerStack {
    let mut s = LayerStack::from_image(w, h, pixels(w, h, 7, 0)).expect("stack");
    s.define_style_pattern(dots()).expect("pattern");
    for (i, g) in gens.iter().enumerate() {
        match g {
            LayerGen::Pixel { seed, alpha } => {
                s.add(&format!("L{i}"));
                s.edit_active(
                    "fill",
                    Region::new(0, 0, w, h),
                    Pixels::from_rgba8(pixels(w, h, *seed, *alpha)),
                )
                .expect("fill");
            }
            LayerGen::Bounded { seed, x, y } => {
                s.add(&format!("B{i}"));
                let full = pixels(w, h, *seed, 1);
                let mut v = vec![0u8; (w * h * 4) as usize];
                for yy in *y..(*y + 12).min(h) {
                    for xx in *x..(*x + 20).min(w) {
                        let o = ((yy * w + xx) * 4) as usize;
                        v[o..o + 4].copy_from_slice(&full[o..o + 4]);
                    }
                }
                s.edit_active(
                    "fill",
                    Region::new(0, 0, w, h),
                    Pixels::from_rgba8(Arc::from(v)),
                )
                .expect("fill");
                let k = s.active_index();
                s.shrink_to_content(k).expect("shrink");
            }
            LayerGen::Styled { seed, kind, noise } => {
                s.add(&format!("S{i}"));
                s.edit_active(
                    "fill",
                    Region::new(0, 0, w, h),
                    Pixels::from_rgba8(pixels(w, h, *seed, 2)),
                )
                .expect("fill");
                let k = s.active_index();
                let noise = if *noise { 30.0 } else { 0.0 };
                s.set_style(k, Some(style(*kind, noise))).expect("style");
            }
            LayerGen::Adjust {
                exposure,
                blur,
                sharpen,
            } => {
                s.add_adjustment(
                    &format!("A{i}"),
                    AdjustParams {
                        exposure_ev: *exposure,
                        blur_sigma: if *blur { 2.5 } else { 0.0 },
                        sharpen_amount: if *sharpen { 0.8 } else { 0.0 },
                        ..AdjustParams::default()
                    },
                );
            }
            LayerGen::Gradient { kind, angle } => {
                let style = [
                    GradientKind::Linear,
                    GradientKind::Radial,
                    GradientKind::Angular,
                    GradientKind::Reflected,
                    GradientKind::Diamond,
                ][*kind as usize];
                let k = s.add_fill_layer(
                    "",
                    FillSource::Gradient(GradientFill {
                        style,
                        angle: *angle,
                        scale: 80.0,
                        reverse: false,
                        offset: (10.0, -5.0),
                        stops: vec![
                            ColorStop {
                                at: 0.0,
                                rgb: [255, 0, 0],
                            },
                            ColorStop {
                                at: 1.0,
                                rgb: [0, 0, 255],
                            },
                        ],
                    }),
                );
                let _ = s.set_opacity(k, 0.6);
            }
        }
    }
    s
}

fn apply(s: &mut LayerStack, e: &Edit, w: u32, h: u32) {
    let n = s.len();
    let i = |k: usize| k % n;
    let _ = match e {
        Edit::Opacity(k, o) => s.set_opacity(i(*k), *o),
        Edit::Blend(k, b) => s.set_blend(i(*k), BLENDS[*b]),
        Edit::Visible(k, v) => s.set_visible(i(*k), *v),
        Edit::Paint(k, seed, a) => s.set_active(i(*k)).and_then(|()| {
            s.edit_active(
                "paint",
                Region::new(0, 0, w, h),
                Pixels::from_rgba8(pixels(w, h, *seed, *a)),
            )
            .map(|_| ())
        }),
        Edit::Mask(k, kind) => s.set_mask(i(*k), mask(w, h, *kind)),
        Edit::Clip(k, c) => s.set_clipped(i(*k), *c),
        Edit::Group(a, b, pass, o) => s.group_range(i(*a), i(*b), "G").and_then(|id| {
            s.set_group_pass_through(id, *pass)?;
            s.set_group_opacity(id, *o)
        }),
        Edit::Dabs(..) | Edit::Recomposite => Ok(()),
    };
}

/// One small rectangle painted into the active layer's pixels.
fn dab(s: &mut LayerStack, r: u32, w: u32, h: u32) {
    if !s.active().is_pixels() {
        return;
    }
    let (x0, y0) = (r % w, (r / 7) % h);
    let (rw, rh) = (1 + r % 9, 1 + (r / 3) % 6);
    let rect = Region::new(x0 as i32, y0 as i32, rw.min(w - x0), rh.min(h - y0));
    let mut px: Vec<u8> = s.active().rgba.canvas().to_rgba8().into_owned();
    for y in y0..(y0 + rh).min(h) {
        for x in x0..(x0 + rw).min(w) {
            let i = ((y * w + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&[(r % 256) as u8, 90, 200, (r % 3 * 120) as u8]);
        }
    }
    let _ = s.edit_active("dab", rect, Pixels::from_rgba8(Arc::from(px)));
}

fn check(
    ctx: &GpuContext,
    whole: &LayerStack,
    tiled: &LayerStack,
    step: &str,
) -> Result<(), TestCaseError> {
    let want = pollster::block_on(whole.composite(Some(ctx), None));
    let got = pollster::block_on(tiled.composite(Some(ctx), None));
    match (got, want) {
        (Ok(g), Ok(w)) => {
            let bad = g.iter().zip(w.iter()).filter(|(a, b)| a != b).count();
            prop_assert!(
                g.len() == w.len() && bad == 0,
                "{step}: the tiled fold differs from the whole fold in {bad} bytes"
            );
        }
        (Err(_), Err(_)) => {}
        (g, w) => prop_assert!(false, "{step}: tiled {g:?} vs whole {w:?}"),
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 40,
        max_shrink_iters: 1024,
        ..ProptestConfig::default()
    })]

    #[test]
    fn the_tiled_fold_equals_the_whole_fold_after_every_edit__feat__image_io_depth_color_modes(
        side in prop_oneof![Just(16u32), Just(32)],
        gens in prop::collection::vec(layer_gen(), 1..5),
        edits in prop::collection::vec(edit_gen(), 1..8),
    ) {
        let Some(ctx) = device() else { return Ok(()) };
        let (w, h) = (70u32, 45u32);
        let mut whole = build(w, h, &gens);
        let mut tiled = build(w, h, &gens);
        tiled.set_fold_tile(Some(side));
        check(ctx, &whole, &tiled, "built")?;
        for (n, e) in edits.iter().enumerate() {
            apply(&mut whole, e, w, h);
            apply(&mut tiled, e, w, h);
            if let Edit::Dabs(k, seed, count) = e {
                for s in [&mut whole, &mut tiled] {
                    let k = k % s.len();
                    let _ = s.set_active(k);
                }
                for d in 0..*count as u32 {
                    let r = seed.wrapping_add(d.wrapping_mul(7919));
                    dab(&mut whole, r, w, h);
                    dab(&mut tiled, r, w, h);
                    check(ctx, &whole, &tiled, &format!("edit {n} dab {d}"))?;
                }
            }
            check(ctx, &whole, &tiled, &format!("edit {n} {e:?}"))?;
        }
    }
}

/// The tiled stack refolds only the tiles a small edit touches.
#[test]
fn a_small_edit_refolds_only_the_tiles_it_touches__feat__image_io_depth_color_modes() {
    let Some(ctx) = device() else { return };
    let (w, h) = (128u32, 128u32);
    let mut s = build(w, h, &[LayerGen::Pixel { seed: 3, alpha: 1 }]);
    s.set_fold_tile(Some(32));
    pollster::block_on(s.composite(Some(ctx), None)).expect("first");
    let (_, e, _) = image_js::counters::measure(|| {
        pollster::block_on(s.composite(Some(ctx), None)).expect("again")
    });
    assert_eq!(e.fold_tiles, 0, "an unchanged stack hands its result back");
    // A dab inside one tile, away from its edges: one tile (no halo here).
    dab(&mut s, 8 * w / 7 * 7 + 40, w, h);
    let (out, e, _) =
        image_js::counters::measure(|| pollster::block_on(s.composite(Some(ctx), None)));
    out.expect("after the dab");
    assert!(
        (1..=2).contains(&e.fold_tiles),
        "a dab folds the tiles it touches, not all 16: {}",
        e.fold_tiles
    );
}

/// A canvas wider than this device can make a texture: only the tiled
/// fold composites it. A 50 % Multiply layer over a background, against
/// the blend's own arithmetic, and a gradient fill layer rendered in
/// bands across the whole width.
#[test]
fn a_canvas_past_the_texture_limit_composites_tile_by_tile__feat__image_io_depth_color_modes() {
    let Some(ctx) = device() else { return };
    let w = ctx.max_texture_dim() + 300;
    let h = 24u32;
    let bg: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let x = i % w;
            [(x % 256) as u8, 200, (x / 256 % 256) as u8, 255]
        })
        .collect();
    let top: Vec<u8> = (0..w * h)
        .flat_map(|i| {
            let y = i / w;
            [128, (y * 10) as u8, 255, 255]
        })
        .collect();
    let mut s = LayerStack::from_image(w, h, Arc::from(bg.clone())).expect("stack");
    s.add("top");
    s.edit_active(
        "fill",
        Region::new(0, 0, w, h),
        Pixels::from_rgba8(Arc::from(top.clone())),
    )
    .expect("fill");
    let k = s.active_index();
    s.set_blend(k, "multiply").expect("blend");
    s.set_opacity(k, 0.5).expect("opacity");
    let out = pollster::block_on(s.composite(Some(ctx), None)).expect("tiled composite");
    assert_eq!(out.len(), (w * h * 4) as usize);
    let mut worst = 0u8;
    for i in 0..(w * h) as usize {
        for c in 0..3 {
            let (b, t) = (f32::from(bg[i * 4 + c]), f32::from(top[i * 4 + c]));
            let want = b + (b * t / 255.0 - b) * 0.5;
            worst = worst.max((f32::from(out[i * 4 + c]) - want).abs().round() as u8);
        }
        assert_eq!(out[i * 4 + 3], 255);
    }
    assert!(worst <= 1, "multiply at 50 % off by {worst} levels");

    // A gradient fill layer across the whole width: rendered in bands, in
    // canvas coordinates, so it runs left to right without a seam.
    let f = s.add_fill_layer(
        "",
        FillSource::Gradient(GradientFill {
            style: GradientKind::Linear,
            angle: 0.0,
            scale: 100.0,
            reverse: false,
            offset: (0.0, 0.0),
            stops: vec![
                ColorStop {
                    at: 0.0,
                    rgb: [0, 0, 0],
                },
                ColorStop {
                    at: 1.0,
                    rgb: [255, 255, 255],
                },
            ],
        }),
    );
    assert!(f > 0);
    let out = pollster::block_on(s.composite(Some(ctx), None)).expect("with the fill");
    let row: Vec<u8> = (0..w as usize).map(|x| out[x * 4]).collect();
    assert!(row[0] <= 1 && row[w as usize - 1] >= 254, "black to white");
    assert!(
        row.windows(2).all(|p| p[1] >= p[0]),
        "the ramp never steps back (no band seam)"
    );
}

// ───────────────────────── the CPU fold ─────────────────────────

/// Layers the CPU fold covers (no style).
fn cpu_layer_gen() -> impl Strategy<Value = LayerGen> {
    prop_oneof![
        3 => (any::<u32>(), 0u8..3).prop_map(|(seed, alpha)| LayerGen::Pixel { seed, alpha }),
        1 => (any::<u32>(), 0u32..40, 0u32..30)
            .prop_map(|(seed, x, y)| LayerGen::Bounded { seed, x, y }),
        1 => (-1.0f32..1.0, any::<bool>(), any::<bool>())
            .prop_map(|(exposure, blur, sharpen)| LayerGen::Adjust { exposure, blur, sharpen }),
        1 => (0u8..5, 0.0f32..360.0).prop_map(|(kind, angle)| LayerGen::Gradient { kind, angle }),
    ]
}

/// Every blend mode a layer can take but the three that are THRESHOLDS:
/// Hard Mix on `cb + cs`, Darker and Lighter Color on which luminosity
/// is lower. A texel within an ulp of the threshold lands on either side
/// on two devices (measured: 120 and 74 levels on texels a sharpen put
/// there), as it may on two GPUs. Their twins are held to the shader by
/// the compose parity tests instead.
const ALL_BLENDS: &[&str] = &[
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color_dodge",
    "color_burn",
    "hard_light",
    "soft_light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
    "linear_burn",
    "linear_dodge",
    "vivid_light",
    "linear_light",
    "pin_light",
    "subtract",
    "divide",
];

#[derive(Debug, Clone)]
enum CpuEdit {
    Base(Edit),
    AnyBlend(usize, usize),
    Fill(usize, f32),
    Knockout(usize, bool),
    BlendIf(usize, u8),
}

fn cpu_edit_gen() -> impl Strategy<Value = CpuEdit> {
    prop_oneof![
        4 => edit_gen().prop_filter("no dabs", |e| !matches!(e, Edit::Dabs(..)))
            .prop_map(CpuEdit::Base),
        2 => (0usize..8, 0usize..ALL_BLENDS.len()).prop_map(|(i, b)| CpuEdit::AnyBlend(i, b)),
        1 => (0usize..8, 0.0f32..1.0).prop_map(|(i, f)| CpuEdit::Fill(i, f)),
        1 => (0usize..8, any::<bool>()).prop_map(|(i, d)| CpuEdit::Knockout(i, d)),
        1 => (0usize..8, 0u8..120).prop_map(|(i, lo)| CpuEdit::BlendIf(i, lo)),
    ]
}

fn cpu_apply(s: &mut LayerStack, e: &CpuEdit, w: u32, h: u32) {
    let n = s.len();
    let i = |k: usize| k % n;
    let _ = match e {
        CpuEdit::Base(e) => {
            apply(s, e, w, h);
            Ok(())
        }
        CpuEdit::AnyBlend(k, b) => s.set_blend(i(*k), ALL_BLENDS[*b]),
        CpuEdit::Fill(k, f) => s.set_fill_opacity(i(*k), *f),
        CpuEdit::Knockout(k, deep) => s.set_knockout(
            i(*k),
            if *deep {
                image_js::layers::Knockout::Deep
            } else {
                image_js::layers::Knockout::Shallow
            },
        ),
        CpuEdit::BlendIf(k, lo) => {
            let mut b = image_js::layers::BlendIf::default();
            b.channels[0].this = [*lo, *lo + 60, 255, 255];
            b.channels[0].under = [0, 0, 200 - *lo, 250 - *lo];
            s.set_blend_if(i(*k), Some(b))
        }
    };
}

/// Each texel's largest per-channel difference in 8-bit levels,
/// PREMULTIPLIED (colour times alpha): where a texel is nearly
/// transparent, the final unpremultiply divides a sub-level difference by
/// its alpha (measured: 2 levels of colour at alpha 30 of 255), which
/// says nothing about the fold.
fn diffs(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.as_chunks::<4>()
        .0
        .iter()
        .zip(b.as_chunks::<4>().0)
        .map(|(x, y)| {
            let pm = |p: &[u8; 4], c: usize| f32::from(p[c]) * f32::from(p[3]) / 255.0;
            let colour = (0..3)
                .map(|c| (pm(x, c) - pm(y, c)).abs())
                .fold(0.0f32, f32::max);
            (colour.round() as u8).max(x[3].abs_diff(y[3]))
        })
        .collect()
}

fn cpu_check(ctx: &GpuContext, s: &mut LayerStack, step: &str) -> Result<(), TestCaseError> {
    // The fill layers' renders are the device's (gen.*); the fold is what
    // is compared.
    let _ = pollster::block_on(s.refresh_fills(Some(ctx)));
    let gpu = pollster::block_on(s.composite(Some(ctx), None));
    let cpu = pollster::block_on(s.composite(None, None));
    match (cpu, gpu) {
        (Ok(c), Ok(g)) => {
            prop_assert_eq!(c.len(), g.len());
            let d = diffs(&c, &g);
            let worst = d.iter().copied().max().unwrap_or(0);
            let off = d.iter().filter(|&&v| v > CPU_LEVELS).count();
            // A dividing blend magnifies an ulp without bound where its
            // divisor nears zero (Divide, the dodges and burns, Vivid
            // Light; the non-separable four divide by a colour's range
            // and by its distance from its luminosity); there only the
            // 99 % holds.
            let divides = s.layers().iter().any(|l| {
                [
                    "compose.divide",
                    "compose.color_dodge",
                    "compose.color_burn",
                    "compose.vivid_light",
                    "compose.hue",
                    "compose.saturation",
                    "compose.color",
                    "compose.luminosity",
                ]
                .contains(&l.blend.id)
            });
            prop_assert!(
                (worst <= CPU_WORST || divides) && off * 100 <= d.len(),
                "{step}: the CPU fold is {worst} levels from the GPU fold, {off} of {} texels \
                 more than {CPU_LEVELS}",
                d.len()
            );
        }
        (Err(_), Err(_)) => {}
        (c, g) => prop_assert!(false, "{step}: cpu {c:?} vs gpu {g:?}"),
    }
    Ok(())
}

/// The bound the CPU fold keeps to the GPU fold, in premultiplied 8-bit
/// levels: each kernel's twin is within its `gpu_tolerance` (a few f16
/// ulps), and a stack chains a handful of them — two levels at 99 % of
/// the texels (an isolated group over a blur: 88 texels of 3150 at two),
/// and four at most, where a dividing blend (Divide, the dodges and
/// burns, Vivid Light) or a sharpen magnifies an ulp (measured: 3 levels,
/// Divide over a faded plate).
const CPU_LEVELS: u8 = 2;
const CPU_WORST: u8 = 4;

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 40,
        max_shrink_iters: 1024,
        ..ProptestConfig::default()
    })]

    #[test]
    fn the_cpu_fold_agrees_with_the_gpu_fold__feat__image_io_depth_color_modes(
        gens in prop::collection::vec(cpu_layer_gen(), 1..5),
        edits in prop::collection::vec(cpu_edit_gen(), 1..8),
    ) {
        let Some(ctx) = device() else { return Ok(()) };
        let (w, h) = (70u32, 45u32);
        let mut s = build(w, h, &gens);
        cpu_check(ctx, &mut s, "built")?;
        for (n, e) in edits.iter().enumerate() {
            cpu_apply(&mut s, e, w, h);
            cpu_check(ctx, &mut s, &format!("edit {n} {e:?}"))?;
        }
    }
}

/// Without a device a styled layer is refused by name, and a plain
/// stack folds: the CPU fold is what a headless template gets.
#[test]
fn the_cpu_fold_runs_without_a_device_and_names_what_it_cannot__feat__image_io_depth_color_modes() {
    let (w, h) = (40u32, 30u32);
    let mut s = build(
        w,
        h,
        &[
            LayerGen::Pixel { seed: 5, alpha: 1 },
            LayerGen::Adjust {
                exposure: 0.4,
                blur: true,
                sharpen: false,
            },
        ],
    );
    let out = pollster::block_on(s.composite(None, None)).expect("a CPU composite");
    assert_eq!(out.len(), (w * h * 4) as usize);
    s.add("styled");
    s.edit_active(
        "fill",
        Region::new(0, 0, w, h),
        Pixels::from_rgba8(pixels(w, h, 9, 2)),
    )
    .expect("fill");
    let k = s.active_index();
    s.set_style(k, Some(style(0, 0.0))).expect("style");
    let err = pollster::block_on(s.composite(None, None)).expect_err("a style needs a GPU");
    assert!(err.to_string().contains("layer style"), "{err}");
}
