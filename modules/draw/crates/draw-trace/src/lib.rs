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

//! # paged.draw — IMAGE TRACE v0
//!
//! RGBA8 pixels in, cubic contour REGIONS out, in pixel space. Host-free
//! and wasm-free: [`trace-js`](../trace_js/index.html) is the
//! wasm-bindgen surface, draw-bundle is the document lowering.
//!
//! ## What this is
//!
//! [`visioncortex`] (MIT/Apache-2.0, the library under vtracer) does the
//! actual work: hierarchical colour clustering (`color_clusters`),
//! boundary walking + polygon simplification (`path::walker` /
//! `path::simplify`), subdivide-smoothing and Schneider curve fitting
//! (`path::smooth` / `path::spline`), and hole-aware compound assembly
//! (`path::compound`). This crate is the adapter: parameters in, caps
//! enforced, geometry lowered into the engine's anchor-triple shape,
//! regions ordered and gated.
//!
//! ## What this is NOT (v0, stated so the command title can be honest)
//!
//! * **Not Illustrator's Image Trace.** There are no presets, no
//!   live/expandable trace object, no re-trace-on-edit, and no
//!   centreline/stroke detection — every region is a FILLED shape.
//! * **Not a palette extractor.** Colour mode emits one region per
//!   CLUSTER, filled with that cluster's mean colour, and each colour
//!   becomes its own document swatch. There is no palette reduction to a
//!   target count and no "limited palette" mode.
//! * **Not transparency-aware.** Alpha is composited onto WHITE before
//!   luminance/clustering; a traced PNG with a transparent background
//!   behaves like one on a white page.
//! * **Not incremental.** A trace is a one-shot lowering into ordinary
//!   page items. Undo is the only "un-trace".
//!
//! ## Blocking — say it plainly
//!
//! [`trace_rgba`] is synchronous and CPU-bound, and the bundle calls it
//! on the thread it is called from. In the editor that is the MAIN
//! (UI) thread: the wasm is loaded in the bundle realm, not in a worker,
//! so a trace at the [`MAX_PIXELS`] cap **stalls the UI for the duration**
//! — hundreds of milliseconds up to seconds on a busy image. That is a
//! real v0 cost, not a rounding error; moving the call behind
//! `host.workers` is named as the v1 step and is not done here.
//!
//! ## Caps
//!
//! [`MAX_DIMENSION`] and [`MAX_PIXELS`] are HARD REFUSALS
//! ([`TraceError::TooLarge`]) — over-cap pixels are never traced, so a
//! 6000×4000 photo cannot wedge the bundle. The DECODER downsamples to
//! fit before calling in, and reports the factor, so such a photo is
//! still traceable at a stated loss of detail.

mod contour;
mod options;

pub use contour::{contours_of, Anchor, Contour};
pub use options::{
    PathMode, TraceMode, TraceOptions, MAX_DIMENSION, MAX_PIXELS, WHITE_CHANNEL_FLOOR,
};

use serde::Serialize;
use visioncortex::color_clusters::{Runner, RunnerConfig, HIERARCHICAL_MAX};
use visioncortex::{Color, ColorImage, PathSimplifyMode};

/// One traced region: an outer boundary, its holes, and the colour the
/// pixels under it averaged to.
///
/// `contours[0]` is the OUTER boundary; `contours[1..]` are holes. The
/// bundle merges them into one compound path — holes must be re-wound
/// against the outer or the engine's NON-ZERO fill paints a coin instead
/// of a ring — via draw-geometry's `mergeCompound` +
/// `orientForNonZeroHoles`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    /// Straight sRGB, 0..=255. Alpha is dropped (composited onto white on
    /// the way in) because a document swatch has no alpha channel.
    pub color: [u8; 3],
    /// Cluster area in PIXELS — what [`TraceOptions::filter_speckle`]
    /// gates and what the region ordering sorts on.
    pub pixels: usize,
    /// Outer boundary first, then holes.
    pub contours: Vec<Contour>,
}

/// The result of a trace, in PIXEL space (origin top-left, +y down — the
/// raster's own frame). The bundle maps it into page space.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub width: u32,
    pub height: u32,
    /// Emitted regions, largest first.
    pub regions: Vec<Region>,
    /// Clusters the tracer found before the speckle filter and the
    /// region cap — so a caller can say "512 of 4 118" honestly.
    pub clusters: usize,
    /// Regions dropped by [`TraceOptions::max_regions`]. Non-zero means
    /// the result is INCOMPLETE and the command says so.
    pub truncated: usize,
    /// Regions dropped by [`TraceOptions::filter_speckle`].
    pub speckles: usize,
}

/// Why a trace produced nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceError {
    /// The raster is over [`MAX_DIMENSION`] / [`MAX_PIXELS`]. Carries the
    /// offending size so the caller can name it.
    TooLarge { width: u32, height: u32 },
    /// `pixels.len()` is not `width * height * 4`, or a dimension is 0.
    BadRaster { expected: usize, got: usize },
}

impl std::fmt::Display for TraceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { width, height } => write!(
                f,
                "image trace refused {width}×{height}: over the {MAX_DIMENSION} px edge / \
                 {MAX_PIXELS} px area cap (downsample before tracing — the decoder does)"
            ),
            Self::BadRaster { expected, got } => write!(
                f,
                "image trace refused the raster: expected {expected} RGBA bytes, got {got}"
            ),
        }
    }
}

impl std::error::Error for TraceError {}

/// Rec. 709 luminance of a pixel already composited onto white.
fn luma(color: Color) -> f64 {
    let a = color.a as f64 / 255.0;
    let over = |c: u8| c as f64 * a + 255.0 * (1.0 - a);
    0.2126 * over(color.r) + 0.7152 * over(color.g) + 0.0722 * over(color.b)
}

/// Is this colour "paper" for [`TraceOptions::ignore_white`]? A
/// heuristic, and named as one — see the option's docs.
fn is_paper(color: Color) -> bool {
    color.r >= WHITE_CHANNEL_FLOOR
        && color.g >= WHITE_CHANNEL_FLOOR
        && color.b >= WHITE_CHANNEL_FLOOR
}

/// Composite RGBA8 onto WHITE — the one alpha decision this v0 makes,
/// named in the module docs.
fn flatten_onto_white(pixels: &[u8], width: u32, height: u32) -> ColorImage {
    let mut image = ColorImage::new_w_h(width as usize, height as usize);
    for i in 0..(width as usize * height as usize) {
        let s = i * 4;
        let a = pixels[s + 3] as u32;
        let over = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        image.set_pixel_at(
            i,
            &Color::new_rgba(
                over(pixels[s]),
                over(pixels[s + 1]),
                over(pixels[s + 2]),
                255,
            ),
        );
    }
    image
}

fn check_raster(pixels: &[u8], width: u32, height: u32) -> Result<(), TraceError> {
    if width == 0 || height == 0 {
        return Err(TraceError::BadRaster {
            expected: 0,
            got: pixels.len(),
        });
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS {
        return Err(TraceError::TooLarge { width, height });
    }
    let expected = width as usize * height as usize * 4;
    if pixels.len() < expected {
        return Err(TraceError::BadRaster {
            expected,
            got: pixels.len(),
        });
    }
    Ok(())
}

/// Order regions largest-first and apply the region cap. Returns the
/// number dropped.
fn cap_regions(regions: &mut Vec<Region>, max: usize) -> usize {
    regions.sort_by(|a, b| b.pixels.cmp(&a.pixels));
    if regions.len() <= max {
        return 0;
    }
    let dropped = regions.len() - max;
    regions.truncate(max);
    dropped
}

/// Trace `pixels` (RGBA8, row-major, `width * height * 4` bytes).
///
/// **Synchronous and CPU-bound — see the module docs on blocking.** The
/// caps are refusals, not clamps.
pub fn trace_rgba(
    pixels: &[u8],
    width: u32,
    height: u32,
    options: TraceOptions,
) -> Result<TraceResult, TraceError> {
    check_raster(pixels, width, height)?;
    let options = options.sanitized();
    let image = flatten_onto_white(pixels, width, height);
    let mut result = match options.mode {
        TraceMode::Color => trace_color(image, options),
        TraceMode::Bw => trace_bw(&image, options),
    };
    result.width = width;
    result.height = height;
    Ok(result)
}

fn simplify_mode(options: TraceOptions) -> PathSimplifyMode {
    match options.path_mode {
        PathMode::Polygon => PathSimplifyMode::Polygon,
        PathMode::Spline => PathSimplifyMode::Spline,
    }
}

/// Hierarchical COLOUR clustering — the real tracer.
fn trace_color(image: ColorImage, options: TraceOptions) -> TraceResult {
    let (width, height) = (image.width as u32, image.height as u32);
    let config = RunnerConfig {
        diagonal: false,
        hierarchical: HIERARCHICAL_MAX,
        batch_size: 25_600,
        good_min_area: options.filter_speckle,
        good_max_area: (width as usize) * (height as usize),
        is_same_color_a: options.same_color_shift(),
        is_same_color_b: 1,
        deepen_diff: options.layer_difference,
        hollow_neighbours: 1,
        key_color: Color::default(),
        keying_action: Default::default(),
    };
    let clusters = Runner::new(config, image).run();
    let view = clusters.view();
    let corner = options.corner_threshold_deg.to_radians();
    let splice = options.splice_threshold_deg.to_radians();
    // `hole = !stacked`: CUT OUT carves each cluster's children out of it
    // (disjoint regions, z-order-independent); STACKED keeps the parent
    // whole and relies on paint order.
    let hole = !options.stacked;

    let mut regions: Vec<Region> = Vec::new();
    let mut found = 0usize;
    let mut speckles = 0usize;
    // `ClustersView::to_color_image` paints `clusters_output` in REVERSE,
    // so the output order is front-to-back. Emitting in reverse puts the
    // finest clusters LAST, which is also last-inserted = topmost in the
    // document's z-order — the same stacking the source image has.
    let ordered: Vec<&visioncortex::color_clusters::Cluster> = view.iter().collect();
    for cluster in ordered.into_iter().rev() {
        found += 1;
        if cluster.area() < options.filter_speckle {
            speckles += 1;
            continue;
        }
        let compound = cluster.to_compound_path(
            &view,
            hole,
            simplify_mode(options),
            corner,
            options.segment_length,
            options.max_iterations,
            splice,
        );
        let contours = contours_of(&compound);
        if contours.is_empty() {
            continue;
        }
        // RESIDUE colour, not the cluster mean: a hierarchical cluster's
        // `color()` averages its children in too, so a red half plus a
        // blue half would come back as one purple parent with a red hole.
        // `residue_color()` is the mean of the pixels this region ACTUALLY
        // paints — the same colour visioncortex's own
        // `render_to_color_image` uses.
        let color = cluster.residue_color();
        if options.ignore_white && is_paper(color) {
            continue;
        }
        regions.push(Region {
            color: [color.r, color.g, color.b],
            pixels: cluster.area(),
            contours,
        });
    }
    let truncated = cap_regions(&mut regions, options.max_regions);
    TraceResult {
        width,
        height,
        regions,
        clusters: found,
        truncated,
        speckles,
    }
}

/// One luminance threshold, then binary clustering — the honest, cheap
/// mode for line art and scans.
fn trace_bw(image: &ColorImage, options: TraceOptions) -> TraceResult {
    let (width, height) = (image.width as u32, image.height as u32);
    let threshold = options.bw_threshold as f64;
    let corner = options.corner_threshold_deg.to_radians();
    let splice = options.splice_threshold_deg.to_radians();

    // Two passes over the same threshold: the DARK side always, the LIGHT
    // side only when `ignore_white` is off (Illustrator's "Ignore White").
    let mut sides: Vec<(bool, [u8; 3])> = vec![(true, [0, 0, 0])];
    if !options.ignore_white {
        sides.push((false, [255, 255, 255]));
    }

    let mut regions: Vec<Region> = Vec::new();
    let mut found = 0usize;
    let mut speckles = 0usize;
    for (dark, color) in sides {
        let binary = image.to_binary_image(|c| (luma(c) < threshold) == dark);
        for cluster in binary.to_clusters(false).iter() {
            found += 1;
            if cluster.size() < options.filter_speckle {
                speckles += 1;
                continue;
            }
            let compound = cluster.to_compound_path(
                simplify_mode(options),
                corner,
                options.segment_length,
                options.max_iterations,
                splice,
            );
            let contours = contours_of(&compound);
            if contours.is_empty() {
                continue;
            }
            regions.push(Region {
                color,
                pixels: cluster.size(),
                contours,
            });
        }
    }
    let truncated = cap_regions(&mut regions, options.max_regions);
    TraceResult {
        width,
        height,
        regions,
        clusters: found,
        truncated,
        speckles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `w × h` white raster with `paint` applied per pixel.
    fn raster(w: u32, h: u32, paint: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut out = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let p = paint(x, y);
                let i = ((y * w + x) * 4) as usize;
                out[i..i + 4].copy_from_slice(&p);
            }
        }
        out
    }

    const WHITE: [u8; 4] = [255, 255, 255, 255];
    const BLACK: [u8; 4] = [0, 0, 0, 255];

    /// A black RING on white: a 40×40 square with a 16×16 hole. The
    /// canonical hole fixture — the whole point of compound output.
    fn ring(size: u32) -> Vec<u8> {
        raster(size, size, |x, y| {
            let inside = x >= 8 && x < size - 8 && y >= 8 && y < size - 8;
            let hole = x >= 18 && x < size - 18 && y >= 18 && y < size - 18;
            if inside && !hole {
                BLACK
            } else {
                WHITE
            }
        })
    }

    #[test]
    fn bw_traces_a_ring_as_one_region_with_a_hole() {
        let size = 48;
        let out = trace_rgba(
            &ring(size),
            size,
            size,
            TraceOptions {
                mode: TraceMode::Bw,
                path_mode: PathMode::Polygon,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((out.width, out.height), (size, size));
        assert_eq!(out.regions.len(), 1, "ignore_white keeps only the ink");
        let region = &out.regions[0];
        assert_eq!(region.color, [0, 0, 0]);
        // TWO contours: the outer boundary and the hole. This is the
        // assertion the whole compound-path lowering exists for.
        assert_eq!(region.contours.len(), 2);
        // …and visioncortex walks them with OPPOSITE windings (the outer
        // clockwise, holes counter-clockwise — `image_to_paths` passes
        // `i == 0` as its `clockwise` flag).
        assert!(
            region.contours[0].area.signum() != region.contours[1].area.signum(),
            "outer {} hole {}",
            region.contours[0].area,
            region.contours[1].area
        );
        // The outer encloses more than the hole.
        assert!(region.contours[0].area.abs() > region.contours[1].area.abs());
    }

    #[test]
    fn bw_with_ignore_white_off_also_emits_the_paper() {
        let size = 48;
        let out = trace_rgba(
            &ring(size),
            size,
            size,
            TraceOptions {
                mode: TraceMode::Bw,
                path_mode: PathMode::Polygon,
                ignore_white: false,
                ..Default::default()
            },
        )
        .unwrap();
        // The ink ring, plus the white background AND the white hole
        // (two separate light clusters).
        assert!(out.regions.len() >= 2, "got {}", out.regions.len());
        assert!(out.regions.iter().any(|r| r.color == [255, 255, 255]));
        assert!(out.regions.iter().any(|r| r.color == [0, 0, 0]));
        // Largest first — the paper outweighs the ring.
        assert!(out.regions[0].pixels >= out.regions[1].pixels);
    }

    #[test]
    fn spline_mode_produces_real_curve_handles() {
        let size = 48;
        let out = trace_rgba(
            &ring(size),
            size,
            size,
            TraceOptions {
                mode: TraceMode::Bw,
                path_mode: PathMode::Spline,
                ..Default::default()
            },
        )
        .unwrap();
        let anchors = &out.regions[0].contours[0].anchors;
        assert!(anchors.len() >= 4);
        let curved = anchors
            .iter()
            .any(|a| a.right != a.anchor || a.left != a.anchor);
        assert!(curved, "spline mode emitted only corner anchors");
    }

    #[test]
    fn polygon_mode_produces_only_corner_anchors() {
        let size = 48;
        let out = trace_rgba(
            &ring(size),
            size,
            size,
            TraceOptions {
                mode: TraceMode::Bw,
                path_mode: PathMode::Polygon,
                ..Default::default()
            },
        )
        .unwrap();
        for contour in &out.regions[0].contours {
            for a in &contour.anchors {
                assert_eq!(a.left, a.anchor);
                assert_eq!(a.right, a.anchor);
            }
        }
    }

    #[test]
    fn color_mode_separates_two_flat_colors() {
        let (w, h) = (64u32, 32u32);
        let pixels = raster(w, h, |x, _| {
            if x < 32 {
                [200, 30, 40, 255]
            } else {
                [30, 60, 200, 255]
            }
        });
        let out = trace_rgba(&pixels, w, h, TraceOptions::default()).unwrap();
        assert!(out.regions.len() >= 2, "got {}", out.regions.len());
        // Each region carries the MEAN colour of its cluster — flat input
        // means the mean is the input colour.
        let reds = out.regions.iter().filter(|r| r.color[0] > 150).count();
        let blues = out.regions.iter().filter(|r| r.color[2] > 150).count();
        assert!(
            reds >= 1 && blues >= 1,
            "{:?}",
            out.regions.iter().map(|r| r.color).collect::<Vec<_>>()
        );
    }

    #[test]
    fn color_mode_ignore_white_drops_the_paper_and_keeps_the_ink() {
        let (w, h) = (48u32, 48u32);
        let pixels = raster(w, h, |x, y| {
            if (8..40).contains(&x) && (8..40).contains(&y) {
                [20, 120, 220, 255]
            } else {
                WHITE
            }
        });
        let kept = trace_rgba(&pixels, w, h, TraceOptions::default()).unwrap();
        assert!(
            kept.regions.iter().all(|r| r.color != [255, 255, 255]),
            "{:?}",
            kept.regions.iter().map(|r| r.color).collect::<Vec<_>>()
        );
        assert!(kept.regions.iter().any(|r| r.color[2] > 150));

        let all = trace_rgba(
            &pixels,
            w,
            h,
            TraceOptions {
                ignore_white: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(all.regions.len() > kept.regions.len());
        assert!(all.regions.iter().any(|r| r.color == [255, 255, 255]));
    }

    #[test]
    fn the_speckle_filter_drops_lone_pixels_and_reports_them() {
        let (w, h) = (32u32, 32u32);
        // One 10×10 block plus three isolated pixels.
        let pixels = raster(w, h, |x, y| {
            let block = (4..14).contains(&x) && (4..14).contains(&y);
            let speck = (x, y) == (25, 3) || (x, y) == (27, 9) || (x, y) == (20, 28);
            if block || speck {
                BLACK
            } else {
                WHITE
            }
        });
        let out = trace_rgba(
            &pixels,
            w,
            h,
            TraceOptions {
                mode: TraceMode::Bw,
                path_mode: PathMode::Polygon,
                filter_speckle: 4,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.regions.len(), 1);
        assert_eq!(out.speckles, 3);
        assert_eq!(out.clusters, 4);
    }

    #[test]
    fn the_region_cap_truncates_largest_first_and_reports_the_drop() {
        let (w, h) = (64u32, 8u32);
        // Eight separate blocks of DIFFERENT widths so the ordering is
        // unambiguous: block k is (k+1) columns wide.
        let pixels = raster(w, h, |x, y| {
            let slot = x / 8;
            let within = x % 8;
            if (1..7).contains(&y) && within <= slot {
                BLACK
            } else {
                WHITE
            }
        });
        let out = trace_rgba(
            &pixels,
            w,
            h,
            TraceOptions {
                mode: TraceMode::Bw,
                path_mode: PathMode::Polygon,
                filter_speckle: 1,
                max_regions: 3,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(out.regions.len(), 3);
        assert_eq!(out.truncated, 5);
        assert_eq!(out.clusters, 8);
        // Largest first.
        assert!(out.regions[0].pixels >= out.regions[1].pixels);
        assert!(out.regions[1].pixels >= out.regions[2].pixels);
    }

    #[test]
    fn alpha_is_composited_onto_white_not_treated_as_ink() {
        let (w, h) = (16u32, 16u32);
        // Fully TRANSPARENT black — after compositing onto white this is
        // paper, so `ignore_white` leaves nothing to trace.
        let pixels = raster(w, h, |_, _| [0, 0, 0, 0]);
        let out = trace_rgba(
            &pixels,
            w,
            h,
            TraceOptions {
                mode: TraceMode::Bw,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.regions.is_empty(), "{:?}", out.regions.len());
    }

    #[test]
    fn the_caps_are_refusals_and_they_name_the_size() {
        let err = trace_rgba(&[], MAX_DIMENSION + 1, 8, TraceOptions::default()).unwrap_err();
        assert_eq!(
            err,
            TraceError::TooLarge {
                width: MAX_DIMENSION + 1,
                height: 8
            }
        );
        assert!(err.to_string().contains("4097×8"));
        // Both edges legal, area over cap.
        assert!(matches!(
            trace_rgba(&[], 4096, 2048, TraceOptions::default()),
            Err(TraceError::TooLarge { .. })
        ));
        // 2048² is exactly at the cap and is NOT refused for size (it
        // fails on the short buffer instead).
        assert!(matches!(
            trace_rgba(&[], 2048, 2048, TraceOptions::default()),
            Err(TraceError::BadRaster { .. })
        ));
    }

    #[test]
    fn a_short_or_empty_raster_is_refused_never_panics() {
        assert!(matches!(
            trace_rgba(&[0, 0, 0], 4, 4, TraceOptions::default()),
            Err(TraceError::BadRaster {
                expected: 64,
                got: 3
            })
        ));
        assert!(matches!(
            trace_rgba(&[], 0, 8, TraceOptions::default()),
            Err(TraceError::BadRaster { .. })
        ));
    }

    #[test]
    fn a_blank_raster_traces_to_nothing_rather_than_a_page_rectangle() {
        let out = trace_rgba(
            &raster(16, 16, |_, _| WHITE),
            16,
            16,
            TraceOptions {
                mode: TraceMode::Bw,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.regions.is_empty());
    }

    #[test]
    fn the_result_serialises_as_the_camel_case_json_the_bundle_reads() {
        let out = trace_rgba(
            &ring(48),
            48,
            48,
            TraceOptions {
                mode: TraceMode::Bw,
                path_mode: PathMode::Polygon,
                ..Default::default()
            },
        )
        .unwrap();
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"regions\""));
        assert!(json.contains("\"contours\""));
        assert!(json.contains("\"anchor\""));
        assert!(json.contains("\"truncated\""));
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back["regions"][0]["contours"].as_array().unwrap().len(), 2);
    }
}
