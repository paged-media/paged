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

//! Engine ADR 1039 — a symbol instance is a copy of its definition's
//! commands between `BeginSymbol` / `EndSymbol`. Both lanes (engine ADR
//! 146) draw the copy and nothing for the markers: the bracketed list draws
//! exactly what the same list without markers draws, on the CPU and on
//! Vello, and the two lanes agree — for a gradient, an image and a 9-slice
//! style clipped copy.

use paged_compose::{
    Color, DecodedImage, DisplayCommand as Cmd, DisplayList, GradientId, GradientStop, ImageId,
    LinearGradient, Paint, PathData, PathSegment, Transform as XF,
};
use paged_gpu::CpuRasterizer;
use paged_gpu::{PathRasterizer, RasterOptions};

fn rect(list: &mut DisplayList) -> paged_compose::PathId {
    let mut p = PathData::default();
    p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
    p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
    p.segments.push(PathSegment::Close);
    list.paths.push_anon(p)
}

/// A gradient square, an image, and a clipped copy of the square — with or
/// without the symbol markers around the copies.
fn scene(markers: bool) -> DisplayList {
    let mut list = DisplayList::new();
    let r = rect(&mut list);
    list.gradients.push(LinearGradient {
        start: (0.0, 0.0),
        end: (1.0, 0.0),
        stops: vec![
            GradientStop {
                offset: 0.0,
                color: Color::rgba(0.9, 0.1, 0.1, 1.0),
            },
            GradientStop {
                offset: 1.0,
                color: Color::rgba(0.1, 0.1, 0.9, 1.0),
            },
        ],
    });
    list.images.push(DecodedImage {
        width: 2,
        height: 2,
        encoded: Default::default(),
        rgba: [0u8, 160, 60, 255].repeat(4).into(),
        icc: None,
        rendering: None,
    });
    let begin = |t: XF| Cmd::BeginSymbol {
        form: 0,
        transform: t,
    };
    let place = XF([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    if markers {
        list.push(begin(place));
    }
    list.push(Cmd::FillPath {
        path_id: r,
        paint: Paint::LinearGradient(GradientId(0)),
        transform: XF([40.0, 0.0, 0.0, 30.0, 10.0, 10.0]),
    });
    list.push(Cmd::Image {
        image_id: ImageId(0),
        transform: XF([20.0, 0.0, 0.0, 20.0, 55.0, 15.0]),
    });
    if markers {
        list.push(Cmd::EndSymbol(XF::IDENTITY));
    }
    // A 9-slice region: the copy clipped to a band.
    list.push(Cmd::PushClip {
        path_id: r,
        transform: XF([20.0, 0.0, 0.0, 10.0, 10.0, 50.0]),
    });
    if markers {
        list.push(begin(XF([1.0, 0.0, 0.0, 1.0, 0.0, 40.0])));
    }
    list.push(Cmd::FillPath {
        path_id: r,
        paint: Paint::LinearGradient(GradientId(0)),
        transform: XF([40.0, 0.0, 0.0, 30.0, 10.0, 50.0]),
    });
    if markers {
        list.push(Cmd::EndSymbol(XF::IDENTITY));
    }
    list.push(Cmd::PopClip(XF::IDENTITY));
    list
}

#[test]
#[allow(non_snake_case)]
fn the_cpu_lane_draws_a_symbol_copy_as_its_commands__feat__frames_paths_symbol_instance() {
    let opts = RasterOptions::new(100.0, 100.0);
    let with = CpuRasterizer.rasterize(&scene(true), &opts);
    let without = CpuRasterizer.rasterize(&scene(false), &opts);
    // vello_cpu rounds a gradient edge one level differently when the
    // command stream around it changes shape; nothing more may differ.
    let worst = with
        .iter()
        .zip(without.iter())
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap_or(0);
    assert!(
        worst <= 1,
        "the markers draw nothing (worst channel delta {worst})"
    );
    assert!(
        with.chunks(4).any(|p| p[0] > 150 && p[2] < 100),
        "the copy drew"
    );
}

#[cfg(feature = "vello-backend")]
#[test]
#[allow(non_snake_case)]
fn both_lanes_draw_a_symbol_copy_alike__feat__frames_paths_symbol_instance() {
    use paged_gpu::vello_rs::VelloRasterizer;
    use paged_test_resources::{skip, Resource};
    let opts = RasterOptions::new(100.0, 100.0);
    let cpu = CpuRasterizer.rasterize(&scene(true), &opts);
    let gpu = VelloRasterizer::new().rasterize(&scene(true), &opts);
    if paged_test_resources::gpu_forced_off() {
        skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
    }
    if gpu.iter().all(|b| *b == 0) {
        skip!(
            Resource::Gpu,
            "no wgpu adapter: Vello returned its zero-fill fallback"
        );
    }
    let plain = VelloRasterizer::new().rasterize(&scene(false), &opts);
    assert_eq!(gpu, plain, "the markers draw nothing on Vello either");
    let differ = cpu
        .chunks(4)
        .zip(gpu.chunks(4))
        .filter(|(a, b)| a.iter().zip(b.iter()).any(|(x, y)| x.abs_diff(*y) > 96))
        .count();
    assert!(
        differ * 100 < (cpu.len() / 4),
        "{differ} pixels differ between the lanes"
    );
}
