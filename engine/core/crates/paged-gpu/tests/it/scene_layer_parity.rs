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

#![cfg(all(
    feature = "vello-backend",
    feature = "cpu",
    not(target_arch = "wasm32")
))]

//! Engine ADR 1046 — a plugin scene layer paints inside its frame's object
//! group and effect layers. The renderer emits it there; these tests hold
//! the two lanes (engine ADR 146) to each other on exactly those shapes: a
//! scene layer (a clipped fill, a gradient and an RGBA image) inside a
//! frame's 50 % Multiply group over its box, and inside a Gaussian-blur and
//! a colour-adjustment layer.

use paged_compose::{
    emit_scene_layer, BlendMode, Color, DisplayCommand as Cmd, DisplayList, LayerEffect, Paint,
    PathData, PathSegment, Rect, SceneGradient, SceneGradientStop, SceneItem, SceneLayer,
    ScenePaint, ScenePathSeg, Transform as XF,
};
use paged_gpu::{vello_rs::VelloRasterizer, CpuRasterizer, PathRasterizer, RasterOptions};
use paged_test_resources::{skip, Resource};

fn square(x: f32, y: f32, w: f32, h: f32) -> Vec<ScenePathSeg> {
    vec![
        ScenePathSeg::MoveTo { x, y },
        ScenePathSeg::LineTo { x: x + w, y },
        ScenePathSeg::LineTo { x: x + w, y: y + h },
        ScenePathSeg::LineTo { x, y: y + h },
        ScenePathSeg::Close,
    ]
}

/// A sheet-grid-like layer: a red cell, a gradient band overflowing the
/// content box (the clip cuts it), and a small RGBA picture.
fn layer() -> SceneLayer {
    let mut rgba = Vec::new();
    for y in 0..4u8 {
        for x in 0..4u8 {
            rgba.extend_from_slice(&[x * 60, y * 60, 200, 255]);
        }
    }
    SceneLayer {
        items: vec![
            SceneItem::FillPath {
                path: square(4.0, 4.0, 20.0, 16.0),
                paint: ScenePaint {
                    r: 0.9,
                    g: 0.1,
                    b: 0.1,
                    a: 1.0,
                },
            },
            SceneItem::FillPathGradient {
                path: square(-10.0, 24.0, 80.0, 8.0),
                gradient: SceneGradient::Linear {
                    x0: 0.0,
                    y0: 0.0,
                    x1: 40.0,
                    y1: 0.0,
                    stops: vec![
                        SceneGradientStop {
                            offset: 0.0,
                            r: 0.1,
                            g: 0.6,
                            b: 0.2,
                            a: 1.0,
                        },
                        SceneGradientStop {
                            offset: 1.0,
                            r: 0.9,
                            g: 0.8,
                            b: 0.1,
                            a: 1.0,
                        },
                    ],
                },
            },
            SceneItem::Image {
                rgba: rgba.into(),
                width: 4,
                height: 4,
                x: 28.0,
                y: 4.0,
                w: 12.0,
                h: 12.0,
            },
        ],
    }
}

fn unit_rect(list: &mut DisplayList) -> paged_compose::PathId {
    let mut p = PathData::default();
    p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
    p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
    p.segments.push(PathSegment::Close);
    list.paths.push_anon(p)
}

/// A 48 × 36 pt frame at `(x, y)`: a light box, then the scene layer, the
/// two wrapped in `open` / its closer as the renderer wraps a frame body.
fn frame(list: &mut DisplayList, x: f32, y: f32, open: Option<Cmd>) {
    let close = match &open {
        Some(Cmd::BeginBlendGroup { .. }) => Some(Cmd::EndBlendGroup(XF::IDENTITY)),
        Some(Cmd::PushLayer { .. }) => Some(Cmd::PopLayer(XF::IDENTITY)),
        _ => None,
    };
    if let Some(o) = open {
        list.push(o);
    }
    let r = unit_rect(list);
    list.push(Cmd::FillPath {
        path_id: r,
        paint: Paint::Solid(Color::rgba(0.7, 0.8, 0.95, 1.0)),
        transform: XF([48.0, 0.0, 0.0, 36.0, x, y]),
    });
    emit_scene_layer(
        list,
        &layer(),
        XF([1.0, 0.0, 0.0, 1.0, x, y]),
        (48.0, 36.0),
        |_, _, _| {},
    );
    if let Some(c) = close {
        list.push(c);
    }
}

fn bounds(x: f32, y: f32) -> Rect {
    Rect {
        x: x - 0.5,
        y: y - 0.5,
        w: 49.0,
        h: 37.0,
    }
}

fn scene() -> DisplayList {
    let mut list = DisplayList::new();
    // A backdrop the group's blend mode reads.
    let r = unit_rect(&mut list);
    list.push(Cmd::FillPath {
        path_id: r,
        paint: Paint::Solid(Color::rgba(0.95, 0.85, 0.3, 1.0)),
        transform: XF([200.0, 0.0, 0.0, 30.0, 0.0, 0.0]),
    });
    frame(
        &mut list,
        6.0,
        8.0,
        Some(Cmd::BeginBlendGroup {
            bounds: bounds(6.0, 8.0),
            blend_mode: BlendMode::Multiply,
            opacity: 0.5,
            isolated: false,
            knockout: false,
            transform: XF::IDENTITY,
        }),
    );
    frame(
        &mut list,
        74.0,
        8.0,
        Some(Cmd::PushLayer {
            bounds: Rect {
                x: 60.0,
                y: 0.0,
                w: 76.0,
                h: 60.0,
            },
            effect: LayerEffect::GaussianBlur { sigma_pt: 3.0 },
            blend_mode: BlendMode::Normal,
            opacity: 0.8,
            transform: XF::IDENTITY,
        }),
    );
    frame(
        &mut list,
        142.0,
        8.0,
        Some(Cmd::PushLayer {
            bounds: bounds(142.0, 8.0),
            effect: LayerEffect::ColorAdjust {
                brightness: 0.1,
                contrast: 0.2,
                saturation: -0.6,
                hue_deg: 30.0,
            },
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
            transform: XF::IDENTITY,
        }),
    );
    list
}

#[test]
#[allow(non_snake_case)]
fn both_lanes_draw_a_scene_layer_inside_its_frames_group_and_effects_alike__feat__effects_transparency_scene_layer_effects(
) {
    let mut opts = RasterOptions::new(200.0, 60.0);
    opts.dpi = 144.0;
    let list = scene();
    let cpu = CpuRasterizer.rasterize(&list, &opts);
    let gpu = VelloRasterizer::new().rasterize(&list, &opts);
    if paged_test_resources::gpu_forced_off() {
        skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
    }
    if gpu.iter().all(|b| *b == 0) {
        skip!(
            Resource::Gpu,
            "no wgpu adapter: Vello returned its zero-fill fallback"
        );
    }
    // The scene layer drew on the CPU: the red cell inside the plain-
    // opacity group is lighter than the opaque red (it is faded).
    let (w, _) = opts.pixel_size();
    let at = |buf: &[u8], x: f32, y: f32| {
        let i = (((y * 2.0) as u32 * w + (x * 2.0) as u32) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2]]
    };
    let red = at(&cpu, 6.0 + 14.0, 8.0 + 12.0);
    assert!(red[0] > red[1] + 40, "the cell is red: {red:?}");
    // Measured on Metal: worst channel delta 2. The budget is the effect
    // lanes' own (`SHADOW_WORST` in `vello_rs`), room for another adapter's
    // rounding, not for a layer drawn outside its group.
    let worst = cpu
        .iter()
        .zip(gpu.iter())
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    assert!(worst <= 24, "worst channel delta {worst} between the lanes");
}
