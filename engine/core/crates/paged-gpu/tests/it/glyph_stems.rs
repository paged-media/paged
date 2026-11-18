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

#![cfg(all(feature = "cpu", not(target_arch = "wasm32")))]

//! A glyph whose outline is a rectangle is text, not a rule: both I's of a
//! line keep the stem the font gives them, on both lanes, wherever they
//! fall on the pixel grid.
//!
//! The editor's business-card template sets "NORTHWIND PRINT" in Inter at
//! 12 pt; Inter's I is one rectangle. Its display list carries no glyph-run
//! table, so stroke adjustment took both I's for rectangle fills: the GPU
//! lane's page-space scene snapped their sides to whole POINTS before the
//! presenter magnified it (NORTHWIND's I 2 pt wide, PRINT's 1 pt, the true
//! stem 1.11 pt), and the CPU lane to whole device pixels. The line here is
//! the template's two I's where the headline sets them, as the text emitter
//! emits a glyph: the outline in font units, interned as a glyph, under a
//! y-flipping transform.

use paged_compose::PathSegment::{Close, LineTo, MoveTo};
use paged_compose::{
    Color, DisplayCommand, DisplayList, GlyphCacheKey, Paint, PathData, Transform,
};
use paged_gpu::{CpuRasterizer, PathRasterizer, RasterOptions};

/// The card, pt.
const PAGE: (f32, f32) = (252.0, 144.0);
/// Inter's em, and its I: x 180 .. 370, y 0 .. 1490 (font units).
const UPEM: f32 = 2048.0;
const STEM: (f32, f32) = (180.0, 370.0);
const CAP: f32 = 1490.0;
const SIZE_PT: f32 = 12.0;
/// The headline's first baseline and the I's origins on it: the frame's
/// left edge (24 pt) plus Inter's advances of "NORTHW" and of
/// "NORTHWIND PR".
const BASELINE: f32 = 23.625;
const ORIGINS: [f32; 2] = [
    24.0 + 9289.0 * SIZE_PT / UPEM,
    24.0 + 16062.0 * SIZE_PT / UPEM,
];

fn headline_is() -> DisplayList {
    let mut list = DisplayList::new();
    let (id, _) = list.paths.intern_glyph(
        GlyphCacheKey {
            font_id: 1,
            glyph_id: 197,
        },
        PathData::new(vec![
            MoveTo { x: STEM.0, y: 0.0 },
            LineTo { x: STEM.1, y: 0.0 },
            LineTo { x: STEM.1, y: CAP },
            LineTo { x: STEM.0, y: CAP },
            Close,
        ]),
    );
    let s = SIZE_PT / UPEM;
    for x in ORIGINS {
        list.push(DisplayCommand::FillPath {
            path_id: id,
            paint: Paint::Solid(Color::BLACK),
            transform: Transform([s, 0.0, 0.0, -s, x, BASELINE]),
        });
    }
    assert!(list.glyph_runs.is_none(), "as the editor builds it");
    list
}

/// The ink across each I's stem, in device pixels: the coverage summed
/// along the row through the middle of the stem, a few pixels either side
/// of it. An exactly drawn stem sums to its width.
fn stem_widths(rgba: &[u8], width_px: u32, px_per_pt: f32) -> Vec<f32> {
    let s = SIZE_PT / UPEM;
    let row = ((BASELINE - CAP * s * 0.5) * px_per_pt) as u32;
    ORIGINS
        .iter()
        .map(|x| {
            let x0 = ((x + STEM.0 * s) * px_per_pt).floor() as u32 - 3;
            let x1 = ((x + STEM.1 * s) * px_per_pt).ceil() as u32 + 3;
            (x0..x1)
                .map(|c| {
                    let i = ((row * width_px + c) * 4) as usize;
                    (255.0 - rgba[i] as f32) / 255.0
                })
                .sum()
        })
        .collect()
}

fn options(px_per_pt: f32) -> RasterOptions {
    let mut opts = RasterOptions::new(PAGE.0, PAGE.1);
    opts.dpi = 72.0 * px_per_pt;
    opts.background = Color::WHITE;
    opts
}

/// The editor's still (335 % on a 2× screen) and 100 % on a 2× screen.
const SCALES: [f32; 2] = [3.35 * 2.0, 2.0];

fn assert_true_stems(lane: &str, widths: &[f32], px_per_pt: f32) {
    let stem = (STEM.1 - STEM.0) * SIZE_PT / UPEM * px_per_pt;
    for (w, word) in widths.iter().zip(["NORTHWIND", "PRINT"]) {
        assert!(
            (w - stem).abs() < 0.1,
            "{lane} at {px_per_pt} px/pt: {word}'s I is {w:.3} px wide, its stem {stem:.3} px"
        );
    }
}

#[test]
fn both_is_keep_their_stem_on_the_cpu_lane() {
    let list = headline_is();
    for px_per_pt in SCALES {
        let opts = options(px_per_pt);
        let rgba = CpuRasterizer.rasterize(&list, &opts);
        let widths = stem_widths(&rgba, opts.pixel_size().0, px_per_pt);
        assert_true_stems("cpu", &widths, px_per_pt);
    }
}

/// The GPU lane as the editor's screen draws a page: its page-space scene
/// (`screen_page_scene`), placed at the device scale afterwards.
#[cfg(feature = "vello-backend")]
#[test]
fn both_is_keep_their_stem_in_the_screen_scene() {
    use paged_gpu::vello_rs::VelloRasterizer;
    use paged_test_resources::{skip, Resource};

    if paged_test_resources::gpu_forced_off() {
        skip!(Resource::Gpu, "PAGED_FORCE_NO_GPU=1");
    }
    let list = headline_is();
    let gpu = VelloRasterizer::new();
    for px_per_pt in SCALES {
        let opts = options(px_per_pt);
        let rgba = gpu.rasterize_screen_region(&list, PAGE, (0.0, 0.0), false, &opts);
        if rgba.iter().all(|b| *b == 0) {
            skip!(
                Resource::Gpu,
                "no wgpu adapter: Vello returned its zero-fill fallback"
            );
        }
        let widths = stem_widths(&rgba, opts.pixel_size().0, px_per_pt);
        assert_true_stems("gpu screen", &widths, px_per_pt);
    }
}
