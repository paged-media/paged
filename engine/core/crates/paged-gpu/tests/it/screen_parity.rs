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

//! Engine ADR 1306 — the editor's screen shows the same bleed and the same
//! pasteboard on both lanes (engine ADR 146). The CPU lane draws a page's
//! screen extent as a tile on a transparent ground and lays it over the
//! paper of the trim, as the worker's render loop does; the GPU lane draws
//! the page's screen scene (`screen_page_scene`, the presenter's) over the
//! surround. A page whose artwork bleeds past its trim, and one item past
//! the pasteboard's reach, must come out alike: the bleed drawn, the item
//! past the reach cut, the paper white, the surround untouched.

use paged_compose::Transform as XF;
use paged_compose::{Color, DisplayCommand as Cmd, DisplayList, Paint, PathData, PathSegment};
use paged_gpu::screen::screen_extent;
use paged_gpu::{vello_rs::VelloRasterizer, CpuRasterizer, PathRasterizer, RasterOptions};
use paged_test_resources::{skip, Resource};

const PAGE: (f32, f32) = (100.0, 80.0);
/// The region compared, page-local pt: from 160 pt left of the trim and
/// 20 pt above it, 260 × 120 pt, one pixel per point.
const ORIGIN: (f32, f32) = (-160.0, -20.0);
const SIZE: (u32, u32) = (260, 120);

fn page() -> DisplayList {
    let mut list = DisplayList::new();
    let mut p = PathData::default();
    p.segments.push(PathSegment::MoveTo { x: 0.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 0.0 });
    p.segments.push(PathSegment::LineTo { x: 1.0, y: 1.0 });
    p.segments.push(PathSegment::LineTo { x: 0.0, y: 1.0 });
    p.segments.push(PathSegment::Close);
    let unit = list.paths.push_anon(p);
    // A red panel bleeding 9 pt past the top-left corner.
    list.commands.push(Cmd::FillPath {
        path_id: unit,
        paint: Paint::Solid(Color::rgba(1.0, 0.0, 0.0, 1.0)),
        transform: XF([59.0, 0.0, 0.0, 49.0, -9.0, -9.0]),
    });
    // A blue square 130 pt left of the trim: past the pasteboard's reach
    // (one page width).
    list.commands.push(Cmd::FillPath {
        path_id: unit,
        paint: Paint::Solid(Color::rgba(0.0, 0.0, 1.0, 1.0)),
        transform: XF([20.0, 0.0, 0.0, 20.0, -150.0, 30.0]),
    });
    list
}

/// The CPU lane's screen of the region: the surround, the paper over the
/// trim, the tile over its extent (source-over, as `drawImage` lays it).
fn cpu_screen(list: &DisplayList, surround: [u8; 4]) -> Vec<u8> {
    let extent = screen_extent(list, PAGE.0, PAGE.1).rect;
    let shifted = list.translated_for_raster(-extent.x, -extent.y);
    let mut opts = RasterOptions::new(extent.w, extent.h);
    opts.dpi = 72.0;
    opts.background = Color::rgba(0.0, 0.0, 0.0, 0.0);
    let tile = CpuRasterizer.rasterize(&shifted, &opts);
    let (tw, th) = opts.pixel_size();
    let (w, h) = SIZE;
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let (px, py) = (x as f32 + ORIGIN.0 + 0.5, y as f32 + ORIGIN.1 + 0.5);
            let in_trim = px >= 0.0 && py >= 0.0 && px < PAGE.0 && py < PAGE.1;
            let mut dst = if in_trim {
                [255, 255, 255, 255]
            } else {
                surround
            };
            let (tx, ty) = (px - extent.x, py - extent.y);
            if tx >= 0.0 && ty >= 0.0 && (tx as u32) < tw && (ty as u32) < th {
                let i = ((ty as u32 * tw + tx as u32) * 4) as usize;
                // The rasterizer leaves premultiplied RGBA on a
                // transparent ground.
                let a = tile[i + 3] as u32;
                for c in 0..3 {
                    dst[c] = (tile[i + c] as u32 + dst[c] as u32 * (255 - a) / 255).min(255) as u8;
                }
            }
            out.extend_from_slice(&dst);
        }
    }
    out
}

fn px(buf: &[u8], x: f32, y: f32) -> [u8; 4] {
    let (ix, iy) = ((x - ORIGIN.0) as u32, (y - ORIGIN.1) as u32);
    let i = ((iy * SIZE.0 + ix) * 4) as usize;
    [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}

fn near(a: [u8; 4], b: [u8; 4]) -> bool {
    a.iter()
        .zip(b.iter())
        .take(3)
        .all(|(x, y)| x.abs_diff(*y) <= 24)
}

#[test]
fn both_lanes_show_the_bleed_and_cut_at_the_pasteboards_reach() {
    if paged_test_resources::gpu_forced_off() {
        skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
    }
    let list = page();
    let extent = screen_extent(&list, PAGE.0, PAGE.1);
    assert!(extent.clipped, "the blue square lies past the reach");
    assert_eq!(extent.edges(), [-100.0, -10.0, 100.0, 80.0]);

    let mut opts = RasterOptions::new(SIZE.0 as f32, SIZE.1 as f32);
    opts.dpi = 72.0;
    opts.background = Color::rgba(0.5, 0.5, 0.5, 1.0);
    let gpu = VelloRasterizer::new().rasterize_screen_region(&list, PAGE, ORIGIN, false, &opts);
    if gpu.iter().all(|b| *b == 0) {
        skip!(
            Resource::Gpu,
            "no wgpu adapter: Vello returned its zero-fill fallback"
        );
    }
    // The surround as the GPU lane clears it, read where nothing is drawn.
    let surround = px(&gpu, -150.0, -15.0);
    let cpu = cpu_screen(&list, surround);

    let red = [255, 0, 0, 255];
    let white = [255, 255, 255, 255];
    for (name, buf) in [("cpu", &cpu), ("gpu", &gpu)] {
        assert!(near(px(buf, -5.0, -5.0), red), "{name}: the bleed is drawn");
        assert!(near(px(buf, 20.0, 20.0), red), "{name}: the panel");
        assert!(near(px(buf, 70.0, 60.0), white), "{name}: the paper");
        assert!(
            near(px(buf, -140.0, 40.0), surround),
            "{name}: past the reach nothing is drawn"
        );
        assert!(
            near(px(buf, -5.0, 60.0), surround),
            "{name}: the pasteboard beside the bleed"
        );
    }
    // And pixel for pixel, within anti-aliasing at the edges.
    let differ = cpu
        .chunks(4)
        .zip(gpu.chunks(4))
        .filter(|(a, b)| {
            a.iter()
                .zip(b.iter())
                .take(3)
                .any(|(x, y)| x.abs_diff(*y) > 96)
        })
        .count();
    assert!(
        differ * 200 < cpu.len() / 4,
        "{differ} pixels differ between the lanes"
    );
}
