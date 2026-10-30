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

//! View modes (editor ADR 287): how a rasterizer draws a display list on
//! the editor's screen, as opposed to what the list says.
//!
//! The rewrite is a display-list → display-list pass, run at the door of
//! both lanes ([`crate::vcpu`] and [`crate::vello_rs`] / the surface
//! presenter), so the two cannot disagree about what Outline or a knockout
//! view draws: they rasterise the same rewritten list (engine ADR 146).
//! The document, its build and its digest (ADR 101) are untouched — the
//! view is a property of the raster, never of the model, and an export
//! never asks for one.
//!
//! * [`RasterView::Composite`] — the list as built: overprint is
//!   simulated (the CPU lane's ink planes), effects drawn. Exports, the
//!   fidelity gates and snapshots use it.
//! * [`RasterView::Knockout`] — `FillPathOverprint` / `StrokePathOverprint`
//!   drawn as the plain fill / stroke they were before
//!   `rewrite_tail_for_overprint` marked them: exactly the list a build
//!   that never marked them would have produced. The screen with
//!   Overprint Preview off.
//! * [`RasterView::Outline`] — every filled or stroked path as a one-pixel
//!   black hairline of its geometry; a placed image as its box with both
//!   diagonals; effects, blend groups, transparency layers and soft-mask
//!   sources dropped; clips kept (a clipped item's outline is cut by its
//!   frame, as Illustrator's Outline view cuts it).

use std::borrow::Cow;

use paged_compose::{
    Color, DashPattern, DisplayCommand, DisplayList, LineCap, LineJoin, Paint, PathData,
    PathSegment, Stroke, Transform,
};

/// How a rasterizer draws the list (see the module docs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum RasterView {
    /// The list as built — overprint simulated, effects drawn.
    #[default]
    Composite,
    /// Overprints drawn as knockouts.
    Knockout,
    /// Hairline outlines only.
    Outline,
}

/// The outline colour (linear RGB black, opaque).
pub const OUTLINE_COLOR: Color = Color {
    r: 0.0,
    g: 0.0,
    b: 0.0,
    a: 1.0,
};

/// The hairline's width in device pixels.
pub const OUTLINE_WIDTH_PX: f32 = 1.0;

/// Rewrite `list` for `view`. `px_per_pt` is the device scale the list
/// will be drawn at (`dpi / 72` for a raster, the camera's scale times
/// the device-pixel ratio for the screen); Outline needs it to keep its
/// hairline one device pixel wide at every zoom. A list the view does not
/// change is borrowed, not copied.
pub fn apply_view(list: &DisplayList, view: RasterView, px_per_pt: f32) -> Cow<'_, DisplayList> {
    match view {
        RasterView::Composite => Cow::Borrowed(list),
        RasterView::Knockout => knockout(list),
        RasterView::Outline => Cow::Owned(outline(list, px_per_pt)),
    }
}

fn has_overprint(list: &DisplayList) -> bool {
    list.commands.iter().any(|c| {
        matches!(
            c,
            DisplayCommand::FillPathOverprint { .. } | DisplayCommand::StrokePathOverprint { .. }
        )
    })
}

fn knockout(list: &DisplayList) -> Cow<'_, DisplayList> {
    if !has_overprint(list) {
        return Cow::Borrowed(list);
    }
    let mut out = list.clone();
    for cmd in out.commands.iter_mut() {
        match *cmd {
            DisplayCommand::FillPathOverprint {
                path_id,
                paint,
                transform,
            } => {
                *cmd = DisplayCommand::FillPath {
                    path_id,
                    paint,
                    transform,
                };
            }
            DisplayCommand::StrokePathOverprint {
                path_id,
                paint,
                stroke,
                transform,
            } => {
                *cmd = DisplayCommand::StrokePath {
                    path_id,
                    paint,
                    stroke,
                    transform,
                };
            }
            _ => {}
        }
    }
    Cow::Owned(out)
}

fn hairline(width: f32) -> Stroke {
    Stroke {
        width,
        cap: LineCap::Butt,
        join: LineJoin::Miter,
        miter_limit: 4.0,
        dash: DashPattern::default(),
    }
}

/// The local stroke width that draws `OUTLINE_WIDTH_PX` device pixels
/// under `transform` at `px_per_pt`: the transform's area scale stands
/// in for its (possibly anisotropic) linear scale.
fn local_hairline_width(transform: &Transform, px_per_pt: f32) -> f32 {
    let [a, b, c, d, _, _] = transform.0;
    let linear = (a * d - b * c).abs().sqrt();
    let scale = (linear * px_per_pt).max(1e-6);
    OUTLINE_WIDTH_PX / scale
}

fn apply_point(m: [f32; 6], x: f32, y: f32) -> (f32, f32) {
    Transform(m).apply(x, y)
}

/// A placed image's box and both diagonals, in PAGE space (the image's
/// transform maps the unit square onto the page), so the hairline stays
/// one pixel wide however the image is stretched.
fn image_cross(transform: &Transform) -> PathData {
    let m = transform.0;
    let p = [
        apply_point(m, 0.0, 0.0),
        apply_point(m, 1.0, 0.0),
        apply_point(m, 1.0, 1.0),
        apply_point(m, 0.0, 1.0),
    ];
    let mv = |(x, y): (f32, f32)| PathSegment::MoveTo { x, y };
    let ln = |(x, y): (f32, f32)| PathSegment::LineTo { x, y };
    PathData {
        segments: vec![
            mv(p[0]),
            ln(p[1]),
            ln(p[2]),
            ln(p[3]),
            PathSegment::Close,
            mv(p[0]),
            ln(p[2]),
            mv(p[1]),
            ln(p[3]),
        ],
        ..PathData::default()
    }
}

fn outline(list: &DisplayList, px_per_pt: f32) -> DisplayList {
    let mut out = DisplayList {
        paths: list.paths.clone(),
        commands: Vec::with_capacity(list.commands.len()),
        // Images and gradients stay so ids keep resolving; Outline draws
        // none of them.
        gradients: list.gradients.clone(),
        radial_gradients: list.radial_gradients.clone(),
        sweep_gradients: list.sweep_gradients.clone(),
        meshes: list.meshes.clone(),
        images: Vec::new(),
        spot_inks: list.spot_inks.clone(),
        glyph_runs: None,
        link_regions: None,
        symbol_forms: Vec::new(),
    };
    let paint = Paint::Solid(OUTLINE_COLOR);
    // Inside a soft mask's SOURCE (between `BeginSoftMask` and
    // `BeginMaskedContent`): the mask's own artwork is not an object on
    // the page, so it draws nothing. Depth, because masks nest.
    let mut mask_source_depth = 0usize;
    // Stack of "is this soft mask's source still open" for each open
    // `BeginSoftMask`, so `BeginMaskedContent` and `EndSoftMask` pair up.
    let mut masks: Vec<bool> = Vec::new();
    for cmd in &list.commands {
        match cmd {
            DisplayCommand::BeginSoftMask { .. } => {
                masks.push(true);
                mask_source_depth += 1;
                continue;
            }
            DisplayCommand::BeginMaskedContent(_) => {
                if let Some(open) = masks.last_mut() {
                    if *open {
                        *open = false;
                        mask_source_depth = mask_source_depth.saturating_sub(1);
                    }
                }
                continue;
            }
            DisplayCommand::EndSoftMask(_) => {
                if let Some(open) = masks.pop() {
                    if open {
                        mask_source_depth = mask_source_depth.saturating_sub(1);
                    }
                }
                continue;
            }
            _ => {}
        }
        if mask_source_depth > 0 {
            continue;
        }
        match cmd {
            DisplayCommand::FillPath {
                path_id, transform, ..
            }
            | DisplayCommand::FillPathBlend {
                path_id, transform, ..
            }
            | DisplayCommand::FillPathOverprint {
                path_id, transform, ..
            }
            | DisplayCommand::StrokePath {
                path_id, transform, ..
            }
            | DisplayCommand::StrokePathOverprint {
                path_id, transform, ..
            } => out.commands.push(DisplayCommand::StrokePath {
                path_id: *path_id,
                paint,
                stroke: hairline(local_hairline_width(transform, px_per_pt)),
                transform: *transform,
            }),
            DisplayCommand::Image { transform, .. } => {
                let path_id = out.paths.push_anon(image_cross(transform));
                out.commands.push(DisplayCommand::StrokePath {
                    path_id,
                    paint,
                    stroke: hairline(OUTLINE_WIDTH_PX / px_per_pt.max(1e-6)),
                    transform: Transform::IDENTITY,
                });
            }
            DisplayCommand::PushClip { .. } | DisplayCommand::PopClip(_) => {
                out.commands.push(cmd.clone());
            }
            // Effects, shadows, feathers, blend groups, transparency
            // layers and mesh shadings (engine ADR 1040; the frame's own
            // outline is its path) are appearance, not geometry: Outline
            // draws none.
            DisplayCommand::MeshShade { .. }
            | DisplayCommand::DropShadow { .. }
            | DisplayCommand::PathShadow { .. }
            | DisplayCommand::BeginBlendGroup { .. }
            | DisplayCommand::EndBlendGroup(_)
            | DisplayCommand::InnerShadow { .. }
            | DisplayCommand::OuterGlow { .. }
            | DisplayCommand::InnerGlow { .. }
            | DisplayCommand::BevelEmboss { .. }
            | DisplayCommand::Satin { .. }
            | DisplayCommand::Feather { .. }
            | DisplayCommand::DirectionalFeather { .. }
            | DisplayCommand::GradientFeather { .. }
            | DisplayCommand::BeginFeatheredObject { .. }
            | DisplayCommand::PushLayer { .. }
            | DisplayCommand::PopLayer(_)
            // Engine ADR 1039 — the copy between the markers is outlined
            // like any other artwork.
            | DisplayCommand::BeginSymbol { .. }
            | DisplayCommand::EndSymbol(_) => {}
            DisplayCommand::BeginSoftMask { .. }
            | DisplayCommand::BeginMaskedContent(_)
            | DisplayCommand::EndSoftMask(_) => unreachable!("handled above"),
        }
    }
    out
}

/// Draw `list` under `options`' view through `draw` — a lane's own
/// composite raster of a (rewritten) list. With Pixel Preview on, the
/// lane draws the page at 72 ppi and the result is enlarged to
/// `options.pixel_size()` by [`nearest_upscale`]; at 72 dpi that is the
/// raster itself.
#[cfg(any(feature = "cpu", feature = "vello-backend"))]
pub(crate) fn draw_with_view(
    list: &DisplayList,
    options: &crate::RasterOptions,
    draw: impl FnOnce(&DisplayList, &crate::RasterOptions) -> Vec<u8>,
) -> Vec<u8> {
    let mut inner = *options;
    inner.view = RasterView::Composite;
    inner.pixel_preview = false;
    if options.pixel_preview && (options.dpi - 72.0).abs() > f32::EPSILON {
        inner.dpi = 72.0;
        let viewed = apply_view(list, options.view, 1.0);
        let (sw, sh) = inner.pixel_size();
        let src = draw(&viewed, &inner);
        let (dw, dh) = options.pixel_size();
        return nearest_upscale(&src, sw, sh, dw, dh);
    }
    let viewed = apply_view(list, options.view, options.dpi / 72.0);
    draw(&viewed, &inner)
}

/// The camera scale Outline builds a cached screen scene for: the scale
/// rounded to a quarter-octave step, so a zoom gesture rebuilds the scene
/// a few times per doubling rather than every frame, and the hairline
/// stays within ±9 % of one device pixel.
pub fn outline_scale_bucket(px_per_pt: f32) -> f32 {
    let s = px_per_pt.max(1e-3);
    let step = (s.log2() * 4.0).round();
    (step / 4.0).exp2()
}

/// Pixel Preview (editor ADR 287): the page as a 72 ppi raster — one
/// device pixel per point — enlarged with nearest-neighbour sampling to
/// `dst_w × dst_h`. `src` is the 72 ppi RGBA8 raster (`src_w × src_h`);
/// destination pixel `(x, y)` shows source pixel
/// `(⌊x · src_w / dst_w⌋, ⌊y · src_h / dst_h⌋)`.
pub fn nearest_upscale(src: &[u8], src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> Vec<u8> {
    let mut out = vec![0u8; (dst_w as usize) * (dst_h as usize) * 4];
    if src_w == 0 || src_h == 0 || src.len() < (src_w as usize) * (src_h as usize) * 4 {
        return out;
    }
    let cols: Vec<usize> = (0..dst_w)
        .map(|x| ((x as u64 * src_w as u64) / dst_w.max(1) as u64).min(src_w as u64 - 1) as usize)
        .collect();
    for y in 0..dst_h as usize {
        let sy = ((y as u64 * src_h as u64) / dst_h.max(1) as u64).min(src_h as u64 - 1) as usize;
        let src_row = &src[sy * src_w as usize * 4..(sy + 1) * src_w as usize * 4];
        let dst_row = &mut out[y * dst_w as usize * 4..(y + 1) * dst_w as usize * 4];
        for (x, &sx) in cols.iter().enumerate() {
            dst_row[x * 4..x * 4 + 4].copy_from_slice(&src_row[sx * 4..sx * 4 + 4]);
        }
    }
    out
}

/// How the GPU screen draws Pixel Preview for one frame: the visible part
/// of the document drawn at one texel per point into a `width × height`
/// texture whose texel `(0, 0)` is the point `origin` (whole points, so a
/// page placed on whole points has its pixel grid on texel edges), then
/// enlarged onto the surface by sampling texel
/// `⌊surface_to_texel · (x, y)⌋` for each surface pixel centre — nearest
/// neighbour under any zoom and view rotation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PixelPlan {
    pub origin: [f32; 2],
    pub width: u32,
    pub height: u32,
    /// Document space (pt) → texel space.
    pub doc_to_texel: [f32; 6],
    /// Surface pixel → texel space.
    pub surface_to_texel: [f32; 6],
}

/// The largest texture side the plan asks for.
pub const PIXEL_PLAN_MAX_SIDE: u32 = 8192;

/// Plan Pixel Preview for a `viewport_w × viewport_h` surface under
/// `camera` (document pt → surface px). `None` below one device pixel per
/// point — Pixel Preview only enlarges — or when the camera is singular
/// or the texture would exceed [`PIXEL_PLAN_MAX_SIDE`]; the caller then
/// presents normally.
pub fn pixel_preview_plan(camera: [f32; 6], viewport_w: u32, viewport_h: u32) -> Option<PixelPlan> {
    let [a, b, c, d, _, _] = camera;
    let scale = (a * d - b * c).abs().sqrt();
    if !scale.is_finite() || scale < 1.0 {
        return None;
    }
    let inv = Transform(camera).inverse()?.0;
    let (w, h) = (viewport_w as f32, viewport_h as f32);
    let corners = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)].map(|(x, y)| apply_point(inv, x, y));
    let min_x = corners.iter().map(|p| p.0).fold(f32::INFINITY, f32::min);
    let min_y = corners.iter().map(|p| p.1).fold(f32::INFINITY, f32::min);
    let max_x = corners
        .iter()
        .map(|p| p.0)
        .fold(f32::NEG_INFINITY, f32::max);
    let max_y = corners
        .iter()
        .map(|p| p.1)
        .fold(f32::NEG_INFINITY, f32::max);
    let origin = [min_x.floor() - 1.0, min_y.floor() - 1.0];
    let width = (max_x.ceil() + 1.0 - origin[0]).max(1.0) as u32;
    let height = (max_y.ceil() + 1.0 - origin[1]).max(1.0) as u32;
    if width > PIXEL_PLAN_MAX_SIDE || height > PIXEL_PLAN_MAX_SIDE {
        return None;
    }
    let doc_to_texel = [1.0, 0.0, 0.0, 1.0, -origin[0], -origin[1]];
    Some(PixelPlan {
        origin,
        width,
        height,
        doc_to_texel,
        surface_to_texel: Transform(doc_to_texel).compose(&Transform(inv)).0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use paged_compose::DecodedImage;

    fn rect_path(
        list: &mut DisplayList,
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
    ) -> paged_compose::PathId {
        list.paths.push_anon(PathData {
            segments: vec![
                PathSegment::MoveTo { x: x0, y: y0 },
                PathSegment::LineTo { x: x1, y: y0 },
                PathSegment::LineTo { x: x1, y: y1 },
                PathSegment::LineTo { x: x0, y: y1 },
                PathSegment::Close,
            ],
            ..PathData::default()
        })
    }

    fn red() -> Paint {
        Paint::Solid(Color::rgba(1.0, 0.0, 0.0, 1.0))
    }

    #[test]
    fn composite_borrows_the_list_unchanged() {
        let mut list = DisplayList::new();
        let p = rect_path(&mut list, 0.0, 0.0, 10.0, 10.0);
        list.push(DisplayCommand::FillPathOverprint {
            path_id: p,
            paint: red(),
            transform: Transform::IDENTITY,
        });
        assert!(matches!(
            apply_view(&list, RasterView::Composite, 1.0),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn knockout_turns_overprints_back_into_plain_draws() {
        let mut list = DisplayList::new();
        let p = rect_path(&mut list, 0.0, 0.0, 10.0, 10.0);
        list.push(DisplayCommand::FillPathOverprint {
            path_id: p,
            paint: red(),
            transform: Transform::IDENTITY,
        });
        list.push(DisplayCommand::StrokePathOverprint {
            path_id: p,
            paint: red(),
            stroke: hairline(2.0),
            transform: Transform::IDENTITY,
        });
        let out = apply_view(&list, RasterView::Knockout, 1.0);
        assert!(matches!(out.commands[0], DisplayCommand::FillPath { .. }));
        assert!(matches!(out.commands[1], DisplayCommand::StrokePath { .. }));
        // A list without overprints is borrowed.
        let mut plain = DisplayList::new();
        let p = rect_path(&mut plain, 0.0, 0.0, 10.0, 10.0);
        plain.push(DisplayCommand::FillPath {
            path_id: p,
            paint: red(),
            transform: Transform::IDENTITY,
        });
        assert!(matches!(
            apply_view(&plain, RasterView::Knockout, 1.0),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn outline_strokes_every_path_with_a_device_pixel_hairline() {
        let mut list = DisplayList::new();
        let p = rect_path(&mut list, 0.0, 0.0, 10.0, 10.0);
        list.push(DisplayCommand::FillPath {
            path_id: p,
            paint: red(),
            transform: Transform([2.0, 0.0, 0.0, 2.0, 5.0, 5.0]),
        });
        list.push(DisplayCommand::StrokePath {
            path_id: p,
            paint: red(),
            stroke: hairline(8.0),
            transform: Transform::IDENTITY,
        });
        let out = apply_view(&list, RasterView::Outline, 4.0);
        assert_eq!(out.commands.len(), 2);
        let DisplayCommand::StrokePath { paint, stroke, .. } = &out.commands[0] else {
            panic!("fill becomes a stroke: {:?}", out.commands[0]);
        };
        assert_eq!(*paint, Paint::Solid(OUTLINE_COLOR));
        // 1 px at 4 px/pt under a 2× transform → 1/8 local unit.
        assert!((stroke.width - 0.125).abs() < 1e-6, "{}", stroke.width);
        let DisplayCommand::StrokePath { stroke, .. } = &out.commands[1] else {
            panic!();
        };
        assert!(
            (stroke.width - 0.25).abs() < 1e-6,
            "the 8 pt stroke draws its centre line"
        );
    }

    #[test]
    fn outline_draws_an_image_as_its_box_with_a_cross_and_drops_effects() {
        let mut list = DisplayList::new();
        list.images.push(DecodedImage {
            width: 2,
            height: 2,
            encoded: Default::default(),
            rgba: vec![255u8; 16].into(),
            icc: None,
            rendering: None,
        });
        let p = rect_path(&mut list, 0.0, 0.0, 10.0, 10.0);
        list.push(DisplayCommand::BeginBlendGroup {
            bounds: paged_compose::Rect {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            blend_mode: paged_compose::BlendMode::Multiply,
            opacity: 0.5,
            isolated: false,
            knockout: false,
            transform: Transform::IDENTITY,
        });
        list.push(DisplayCommand::Image {
            image_id: paged_compose::ImageId(0),
            transform: Transform([20.0, 0.0, 0.0, 10.0, 0.0, 0.0]),
        });
        list.push(DisplayCommand::EndBlendGroup(Transform::IDENTITY));
        list.push(DisplayCommand::PushClip {
            path_id: p,
            transform: Transform::IDENTITY,
        });
        list.push(DisplayCommand::PopClip(Transform::IDENTITY));
        let out = apply_view(&list, RasterView::Outline, 1.0);
        assert_eq!(out.commands.len(), 3, "{:?}", out.commands);
        let DisplayCommand::StrokePath { path_id, .. } = &out.commands[0] else {
            panic!();
        };
        let segs = &out.paths.get(*path_id).expect("cross path").segments;
        // The box closes and both diagonals follow: three MoveTos.
        assert_eq!(
            segs.iter()
                .filter(|s| matches!(s, PathSegment::MoveTo { .. }))
                .count(),
            3
        );
        assert!(segs.contains(&PathSegment::LineTo { x: 20.0, y: 10.0 }));
        assert!(matches!(out.commands[1], DisplayCommand::PushClip { .. }));
        assert!(matches!(out.commands[2], DisplayCommand::PopClip(_)));
        assert!(out.images.is_empty());
    }

    #[test]
    fn outline_skips_a_soft_mask_source_but_keeps_the_masked_content() {
        let mut list = DisplayList::new();
        let p = rect_path(&mut list, 0.0, 0.0, 10.0, 10.0);
        let fill = |list: &mut DisplayList| {
            list.push(DisplayCommand::FillPath {
                path_id: p,
                paint: red(),
                transform: Transform::IDENTITY,
            })
        };
        list.push(DisplayCommand::BeginSoftMask {
            mask_type: paged_compose::SoftMaskType::Luminosity,
            invert: false,
            transform: Transform::IDENTITY,
        });
        fill(&mut list); // the mask's source
        list.push(DisplayCommand::BeginMaskedContent(Transform::IDENTITY));
        fill(&mut list); // the content
        list.push(DisplayCommand::EndSoftMask(Transform::IDENTITY));
        fill(&mut list); // after the mask
        let out = apply_view(&list, RasterView::Outline, 1.0);
        assert_eq!(out.commands.len(), 2);
    }

    #[test]
    fn the_outline_scale_bucket_is_a_quarter_octave() {
        assert_eq!(outline_scale_bucket(1.0), 1.0);
        assert_eq!(outline_scale_bucket(2.0), 2.0);
        let b = outline_scale_bucket(1.1);
        assert!((b - 2f32.powf(0.25)).abs() < 1e-5, "{b}");
        assert!((outline_scale_bucket(1.02) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn the_pixel_plan_puts_whole_points_on_texel_edges() {
        // 4 device px per pt, document origin at surface (10.5, 3.25).
        let camera = [4.0, 0.0, 0.0, 4.0, 10.5, 3.25];
        let plan = pixel_preview_plan(camera, 400, 200).expect("zoomed in");
        // Texel space is document space shifted by whole points.
        assert_eq!(plan.origin[0].fract(), 0.0);
        assert_eq!(plan.origin[1].fract(), 0.0);
        // The surface pixel centre over document point (2.3, 7.6) samples
        // the texel of point (2, 7).
        let s = apply_point(camera, 2.3, 7.6);
        let t = apply_point(plan.surface_to_texel, s.0, s.1);
        assert_eq!(t.0.floor(), 2.0 - plan.origin[0]);
        assert_eq!(t.1.floor(), 7.0 - plan.origin[1]);
        // The texture covers the viewport.
        let far = apply_point(plan.surface_to_texel, 400.0, 200.0);
        assert!(far.0 < plan.width as f32 && far.1 < plan.height as f32);
        let near = apply_point(plan.surface_to_texel, 0.0, 0.0);
        assert!(near.0 >= 0.0 && near.1 >= 0.0);
    }

    #[test]
    fn the_pixel_plan_follows_a_rotated_view_and_refuses_to_shrink() {
        let (s, c) = 30f32.to_radians().sin_cos();
        let k = 3.0;
        let camera = [k * c, k * s, -k * s, k * c, 200.0, 50.0];
        let plan = pixel_preview_plan(camera, 300, 300).expect("zoomed in");
        let p = apply_point(camera, 12.7, 40.2);
        let t = apply_point(plan.surface_to_texel, p.0, p.1);
        assert!((t.0 - (12.7 - plan.origin[0])).abs() < 1e-3);
        assert!((t.1 - (40.2 - plan.origin[1])).abs() < 1e-3);
        assert!(pixel_preview_plan([0.5, 0.0, 0.0, 0.5, 0.0, 0.0], 100, 100).is_none());
    }

    #[test]
    fn nearest_upscale_repeats_each_source_pixel() {
        // 2×1: red, blue → 6×2.
        let src = [255, 0, 0, 255, 0, 0, 255, 255];
        let out = nearest_upscale(&src, 2, 1, 6, 2);
        let px = |x: usize, y: usize| &out[(y * 6 + x) * 4..(y * 6 + x) * 4 + 4];
        for y in 0..2 {
            for x in 0..3 {
                assert_eq!(px(x, y), &[255, 0, 0, 255]);
            }
            for x in 3..6 {
                assert_eq!(px(x, y), &[0, 0, 255, 255]);
            }
        }
    }
}
