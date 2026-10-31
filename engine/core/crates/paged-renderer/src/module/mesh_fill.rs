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

//! Engine ADR 1048 — a frame's gradient mesh or freeform gradient.
//!
//! The model's [`MeshFill`] (points in the frame's inner coordinates,
//! colours inline) becomes a [`MeshShading`] in the display list's mesh
//! pool — its colours resolved through the document's colour pipeline,
//! as a swatch's are — painted by one `MeshShade` inside a `PushClip` of
//! the frame's outline, under the frame's outer transform.

use paged_compose::{
    Color, DisplayCommand, FreeformShading, FreeformSource, MeshShading, PathData, PathId,
    PathSegment, Rect, ShadePatch, Transform,
};
use paged_model::{MeshColor, MeshFill};

use super::{Geometry, ResolvedFrame};
use crate::pipeline::{
    color_entry_to_paint, ellipse_outline_path, paint_as_solid_with_icc, BuiltPage, ColorCtx,
};

/// A mesh colour as a display-list colour: resolved as an unnamed
/// swatch of its space and value would be, its opacity on the alpha.
fn resolve(c: &MeshColor, color_ctx: ColorCtx<'_>) -> Color {
    let mut color = color_entry_to_paint(&c.as_entry(), color_ctx)
        .and_then(|p| paint_as_solid_with_icc(p, color_ctx))
        .unwrap_or(Color::BLACK);
    color.a = c.opacity();
    color
}

/// The display-list shading of `fill` on a frame whose box is `bbox`
/// (inner coordinates). `None` when it paints nothing.
pub(crate) fn mesh_shading(
    fill: &MeshFill,
    bbox: Rect,
    color_ctx: ColorCtx<'_>,
) -> Option<MeshShading> {
    let shading = match fill {
        MeshFill::Mesh(mesh) => {
            let mut patches = Vec::new();
            for grid in &mesh.grids {
                for p in grid.patches() {
                    patches.push(ShadePatch {
                        points: p.points.map(|row| row.map(|[x, y]| (x, y))),
                        colors: p.colors.map(|c| resolve(c, color_ctx)),
                        tensor: p.tensor,
                    });
                }
            }
            if patches.is_empty() {
                return None;
            }
            MeshShading::patches(patches)
        }
        MeshFill::Freeform(ff) => {
            let diag = bbox.w.hypot(bbox.h);
            let source = |i: usize| {
                ff.points.get(i).map(|p| FreeformSource {
                    at: (p.point[0], p.point[1]),
                    color: resolve(&p.color, color_ctx),
                    spread: p.spread() * diag,
                })
            };
            let on_line: std::collections::HashSet<u32> =
                ff.lines.iter().flatten().copied().collect();
            let points: Vec<FreeformSource> = (0..ff.points.len())
                .filter(|i| !on_line.contains(&(*i as u32)))
                .filter_map(source)
                .collect();
            let lines: Vec<Vec<FreeformSource>> = ff
                .lines
                .iter()
                .map(|l| {
                    l.iter()
                        .filter_map(|&i| source(i as usize))
                        .collect::<Vec<_>>()
                })
                .filter(|l| !l.is_empty())
                .collect();
            if points.is_empty() && lines.is_empty() {
                return None;
            }
            MeshShading::freeform(FreeformShading {
                bounds: bbox,
                points,
                lines,
            })
        }
    };
    shading.bounds().is_some().then_some(shading)
}

/// The frame's outline in its inner coordinates, for the clip: the
/// interned fill path when the orchestrator made one (a rounded
/// rectangle, a polygon), else the box or the ellipse.
fn outline(
    frame: &ResolvedFrame<'_>,
    page: &mut BuiltPage,
    fill_path: Option<PathId>,
) -> Option<PathId> {
    if let Some(id) = fill_path {
        return Some(id);
    }
    let data = match frame.geometry {
        Geometry::Rect { rect } | Geometry::TextFrameRect { rect } => PathData::new(vec![
            PathSegment::MoveTo {
                x: rect.x,
                y: rect.y,
            },
            PathSegment::LineTo {
                x: rect.x + rect.w,
                y: rect.y,
            },
            PathSegment::LineTo {
                x: rect.x + rect.w,
                y: rect.y + rect.h,
            },
            PathSegment::LineTo {
                x: rect.x,
                y: rect.y + rect.h,
            },
            PathSegment::Close,
        ]),
        Geometry::Oval { rect } => ellipse_outline_path(rect),
        Geometry::Polygon { .. } | Geometry::Line { .. } => return None,
    };
    Some(page.list.paths.push_anon(data))
}

/// Emit `frame`'s mesh fill: `PushClip` (the outline), `MeshShade`,
/// `PopClip`, under `outer`. Returns whether it painted (a mesh with
/// nothing to paint leaves the frame to its swatch).
pub(crate) fn emit_mesh_fill(
    frame: &ResolvedFrame<'_>,
    page: &mut BuiltPage,
    color_ctx: ColorCtx<'_>,
    outer: Transform,
    fill_path: Option<PathId>,
) -> bool {
    let Some(fill) = frame.fill_mesh.filter(|f| !f.is_empty()) else {
        return false;
    };
    let bbox = match frame.geometry {
        Geometry::Rect { rect }
        | Geometry::TextFrameRect { rect }
        | Geometry::Oval { rect }
        | Geometry::Polygon { bbox: rect, .. } => rect,
        Geometry::Line { .. } => return false,
    };
    let Some(shading) = mesh_shading(fill, bbox, color_ctx) else {
        return false;
    };
    let Some(bounds) = shading.bounds() else {
        return false;
    };
    let Some(clip) = outline(frame, page, fill_path) else {
        return false;
    };
    let mesh_id = page.list.push_mesh(shading);
    page.list.push(DisplayCommand::PushClip {
        path_id: clip,
        transform: outer,
    });
    page.list.push(DisplayCommand::MeshShade {
        mesh_id,
        bounds,
        transform: outer,
    });
    page.list.push(DisplayCommand::PopClip(outer));
    true
}
