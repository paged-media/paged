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

//! Editor ADR 287 — the view modes draw alike on both lanes (engine ADR
//! 146): Outline's hairlines and image crosses, and Pixel Preview's
//! 72 ppi blocks, come out of the same rewrite on the CPU and on Vello.

use paged_compose::{
    Color, DecodedImage, DisplayCommand as Cmd, DisplayList, ImageId, Paint, PathData, PathSegment,
    Transform as XF,
};
use paged_gpu::{
    vello_rs::VelloRasterizer, CpuRasterizer, PathRasterizer, RasterOptions, RasterView,
};
use paged_test_resources::{skip, Resource};

fn rect(list: &mut DisplayList) -> paged_compose::PathId {
    let mut p = PathData::default();
    p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
    p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
    p.segments.push(PathSegment::Close);
    list.paths.push_anon(p)
}

fn scene() -> DisplayList {
    let mut list = DisplayList::new();
    let r = rect(&mut list);
    list.commands.push(Cmd::FillPath {
        path_id: r,
        paint: Paint::Solid(Color::rgba(0.8, 0.1, 0.1, 1.0)),
        transform: XF([40.0, 0.0, 0.0, 30.0, 10.0, 10.0]),
    });
    list.images.push(DecodedImage {
        width: 2,
        height: 2,
        encoded: Default::default(),
        rgba: vec![0u8, 120, 255, 255].repeat(4).into(),
        icc: None,
    });
    list.commands.push(Cmd::Image {
        image_id: ImageId(0),
        transform: XF([30.0, 0.0, 0.0, 30.0, 60.0, 10.0]),
    });
    list
}

fn px(buf: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

fn dark(p: [u8; 4]) -> bool {
    p[0] < 140 && p[1] < 140 && p[2] < 140
}

fn white(p: [u8; 4]) -> bool {
    p[0] > 235 && p[1] > 235 && p[2] > 235
}

macro_rules! gpu_or_skip {
    ($buf:expr) => {
        if paged_test_resources::gpu_forced_off() {
            skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
        }
        if $buf.iter().all(|b| *b == 0) {
            skip!(
                Resource::Gpu,
                "no wgpu adapter: Vello returned its zero-fill fallback"
            );
        }
    };
}

#[test]
#[allow(non_snake_case)]
fn outline_draws_the_same_hairlines_on_both_lanes__feat__the_renderer_view_modes() {
    let list = scene();
    let mut opts = RasterOptions::new(100.0, 50.0);
    opts.dpi = 144.0;
    opts.view = RasterView::Outline;
    let cpu = CpuRasterizer.rasterize(&list, &opts);
    let gpu = VelloRasterizer::new().rasterize(&list, &opts);
    gpu_or_skip!(gpu);
    let (w, _) = opts.pixel_size();
    for (name, buf) in [("cpu", &cpu), ("gpu", &gpu)] {
        // The fill is gone: its middle is paper.
        assert!(white(px(buf, w, 60, 50)), "{name}: fill middle");
        // Its top edge (y = 10 pt = 20 px) is a dark hairline.
        assert!(
            (19..=21).any(|y| dark(px(buf, w, 60, y))),
            "{name}: top edge"
        );
        // The image is a box with a cross: its centre (75, 25 pt) is on
        // both diagonals, and a point off them is paper, not blue.
        assert!(
            (-1i32..=1).any(|d| dark(px(buf, w, 150, (50 + d) as u32))),
            "{name}: image cross centre"
        );
        assert!(white(px(buf, w, 150, 30)), "{name}: image body");
    }
    // The lanes agree pixel for pixel within anti-aliasing noise.
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

#[test]
fn pixel_preview_draws_72_ppi_blocks_on_both_lanes() {
    let list = scene();
    let mut opts = RasterOptions::new(100.0, 50.0);
    opts.dpi = 288.0; // 4 device pixels per point
    opts.pixel_preview = true;
    let cpu = CpuRasterizer.rasterize(&list, &opts);
    let gpu = VelloRasterizer::new().rasterize(&list, &opts);
    gpu_or_skip!(gpu);
    let (w, _) = opts.pixel_size();
    for (name, buf) in [("cpu", &cpu), ("gpu", &gpu)] {
        // Every 4 × 4 block is one colour.
        for (bx, by) in [(10u32, 10u32), (12, 3), (24, 7), (40, 12)] {
            let first = px(buf, w, bx * 4, by * 4);
            for dy in 0..4 {
                for dx in 0..4 {
                    assert_eq!(
                        px(buf, w, bx * 4 + dx, by * 4 + dy),
                        first,
                        "{name}: block ({bx}, {by})"
                    );
                }
            }
        }
    }
}
