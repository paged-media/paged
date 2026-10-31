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

//! Engine ADR 1043 — an item with several fills and strokes is drawn as
//! the commands the renderer emits for it (`pipeline/appearance.rs`): the
//! item's group (its opacity and blend mode) around one part per layer —
//! the frame's fill, an extra fill in a group of its own (a blend mode and
//! an opacity), the frame's stroke, a wide extra stroke. Both lanes
//! (engine ADR 146) draw that alike.

use paged_compose::{
    BlendMode, Color, DisplayCommand as Cmd, DisplayList, Paint, PathData, PathSegment, Rect,
    Stroke, Transform as XF,
};
use paged_gpu::CpuRasterizer;
use paged_gpu::{PathRasterizer, RasterOptions};

fn square(list: &mut DisplayList) -> paged_compose::PathId {
    let mut p = PathData::default();
    p.segments.push(PathSegment::MoveTo { x: 30.0, y: 30.0 });
    p.segments.push(PathSegment::LineTo { x: 70.0, y: 30.0 });
    p.segments.push(PathSegment::LineTo { x: 70.0, y: 70.0 });
    p.segments.push(PathSegment::LineTo { x: 30.0, y: 70.0 });
    p.segments.push(PathSegment::Close);
    list.paths.push_anon(p)
}

fn group(blend_mode: BlendMode, opacity: f32) -> Cmd {
    Cmd::BeginBlendGroup {
        bounds: Rect {
            x: 10.0,
            y: 10.0,
            w: 80.0,
            h: 80.0,
        },
        blend_mode,
        opacity,
        isolated: false,
        knockout: false,
        transform: XF::IDENTITY,
    }
}

fn solid(r: f32, g: f32, b: f32) -> Paint {
    Paint::Solid(Color::rgba(r, g, b, 1.0))
}

/// The appearance of a yellow square: yellow (the frame's fill), red at
/// 60 % Screen, the frame's 2 pt black stroke, a blue 10 pt stroke — all
/// inside the item's 80 % Multiply group, over a grey backdrop.
fn scene() -> DisplayList {
    let mut list = DisplayList::new();
    let sq = square(&mut list);
    let mut back = PathData::default();
    back.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
    back.segments.push(PathSegment::LineTo { x: 100.0, y: 0.0 });
    back.segments
        .push(PathSegment::LineTo { x: 100.0, y: 50.0 });
    back.segments.push(PathSegment::LineTo { x: 0.0, y: 50.0 });
    back.segments.push(PathSegment::Close);
    let back = list.paths.push_anon(back);
    list.push(Cmd::FillPath {
        path_id: back,
        paint: solid(0.6, 0.6, 0.6),
        transform: XF::IDENTITY,
    });
    list.push(group(BlendMode::Multiply, 0.8));
    list.push(Cmd::FillPath {
        path_id: sq,
        paint: solid(1.0, 1.0, 0.0),
        transform: XF::IDENTITY,
    });
    list.push(group(BlendMode::Screen, 0.6));
    list.push(Cmd::FillPath {
        path_id: sq,
        paint: solid(1.0, 0.0, 0.0),
        transform: XF::IDENTITY,
    });
    list.push(Cmd::EndBlendGroup(XF::IDENTITY));
    list.push(Cmd::StrokePath {
        path_id: sq,
        paint: solid(0.0, 0.0, 0.0),
        stroke: Stroke::new(2.0),
        transform: XF::IDENTITY,
    });
    list.push(Cmd::StrokePath {
        path_id: sq,
        paint: solid(0.0, 0.0, 1.0),
        stroke: Stroke::new(10.0),
        transform: XF::IDENTITY,
    });
    list.push(Cmd::EndBlendGroup(XF::IDENTITY));
    list
}

fn at(img: &[u8], w: usize, x: usize, y: usize) -> [u8; 4] {
    let i = (y * w + x) * 4;
    [img[i], img[i + 1], img[i + 2], img[i + 3]]
}

#[test]
#[allow(non_snake_case)]
fn the_cpu_lane_composites_the_layers__feat__frames_paths_native_appearance() {
    let mut opts = RasterOptions::new(100.0, 100.0);
    opts.dpi = 72.0;
    let img = CpuRasterizer.rasterize(&scene(), &opts);
    let px = |x: f32, y: f32| at(&img, 100, x as usize, y as usize);
    // Inside, over white: Screen red over yellow is still yellow-red
    // (R full, G above 0), then Multiply with white at 80 %.
    let inside = px(50.0, 60.0);
    assert!(
        inside[0] > 240 && inside[1] > 60 && inside[2] < 80,
        "{inside:?}"
    );
    // The blue stroke's outer half, outside the square.
    let edge = px(27.0, 60.0);
    assert!(edge[2] > edge[0] && edge[2] > 120, "{edge:?}");
}

#[cfg(feature = "vello-backend")]
#[test]
#[allow(non_snake_case)]
fn both_lanes_draw_an_appearance_alike__feat__frames_paths_native_appearance() {
    use paged_gpu::vello_rs::VelloRasterizer;
    use paged_test_resources::{skip, Resource};
    let opts = RasterOptions::new(100.0, 100.0);
    let cpu = CpuRasterizer.rasterize(&scene(), &opts);
    let gpu = VelloRasterizer::new().rasterize(&scene(), &opts);
    if paged_test_resources::gpu_forced_off() {
        skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
    }
    if gpu.iter().all(|b| *b == 0) {
        skip!(
            Resource::Gpu,
            "no wgpu adapter: Vello returned its zero-fill fallback"
        );
    }
    let worst = cpu
        .iter()
        .zip(gpu.iter())
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    let differ = cpu
        .chunks(4)
        .zip(gpu.chunks(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 8))
        .count();
    // Anti-aliased edges may round apart; the composited areas may not.
    assert!(
        differ * 100 < (cpu.len() / 4),
        "{differ} pixels differ by more than 8 (worst {worst})"
    );
}
