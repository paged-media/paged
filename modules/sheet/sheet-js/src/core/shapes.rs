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

//! Shapes of a sheet on the page (sheet ADR 530): the `xdr:sp` / `xdr:cxnSp`
//! of its drawings, their outlines evaluated by `dml-geom` (the preset and
//! custom geometry paged.slide lowers with) in the shape's box, flipped and
//! turned, and their paint by the shared DrawingML mapper (`dml-native`,
//! through `sheet_chart::native::shape_look`). The host places each contour
//! as a path on the page over the table, like a picture.

use sheet_xlsx::parts::shapes::{ShapeGeometry, SheetShape};

use super::annotations::{place_anchor, Placed};
use super::{SessionError, SheetSession};

/// One anchor of a contour with its control points, in pt relative to the
/// shape's anchor box.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct ShapeAnchor {
    pub anchor: [f64; 2],
    pub left: [f64; 2],
    pub right: [f64; 2],
}

/// One path item of a shape: its contours (`subpath_starts` names where each
/// begins when there are several) with what the geometry paints of them.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShapeItem {
    pub anchors: Vec<ShapeAnchor>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subpath_starts: Vec<usize>,
    pub closed: bool,
    pub filled: bool,
    pub stroked: bool,
}

/// One shape placed over a page table: its anchor cell (sheet indices), the
/// anchor box and the outline in it.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageShape {
    pub id: String,
    pub name: String,
    pub row: u32,
    pub col: u32,
    pub dx: f64,
    pub dy: f64,
    pub w_pt: f64,
    pub h_pt: f64,
    pub items: Vec<ShapeItem>,
    /// Fill, outline, opacity and effects (colours as `#RRGGBB`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fx: Option<sheet_chart::native::NativeFx>,
    /// What the page cannot hold of the shape, one line per kind.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub losses: Vec<String>,
}

/// The outline of `shape` in its `w` × `h` box, flipped and turned about the
/// box's centre, as items in the anchor box of size `aw` × `ah` (the shape
/// box centred in it).
fn items_of(shape: &SheetShape, w: f64, h: f64, aw: f64, ah: f64) -> Vec<ShapeItem> {
    let outline = match &shape.geometry {
        ShapeGeometry::Preset { name, adjust } => {
            dml_geom::preset(name, adjust, w, h).or_else(|| dml_geom::preset("rect", &[], w, h))
        }
        ShapeGeometry::Custom(c) => Some(dml_geom::custom(c, w, h)),
    };
    let Some(outline) = outline else {
        return Vec::new();
    };
    let (ox, oy) = ((aw - w) / 2.0, (ah - h) / 2.0);
    let (cx, cy) = (aw / 2.0, ah / 2.0);
    let theta = (shape.rot as f64 / 60_000.0).to_radians();
    let (sin, cos) = theta.sin_cos();
    let map = |p: (f64, f64)| -> [f64; 2] {
        let x = if shape.flip_h { w - p.0 } else { p.0 } + ox;
        let y = if shape.flip_v { h - p.1 } else { p.1 } + oy;
        let (dx, dy) = (x - cx, y - cy);
        [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
    };
    let mut items: Vec<(usize, ShapeItem)> = Vec::new();
    for sub in &outline.subpaths {
        if sub.points.len() < 2 {
            continue;
        }
        // A flip reverses the curve's handedness: the control points follow
        // their anchors, so nothing else changes.
        let anchors: Vec<ShapeAnchor> = sub
            .points
            .iter()
            .map(|p| ShapeAnchor {
                anchor: map(p.anchor),
                left: map(p.left),
                right: map(p.right),
            })
            .collect();
        match items.iter_mut().find(|(path, _)| *path == sub.path) {
            Some((_, item)) => {
                if item.subpath_starts.is_empty() {
                    item.subpath_starts.push(0);
                }
                item.subpath_starts.push(item.anchors.len());
                item.anchors.extend(anchors);
                item.closed &= sub.closed;
            }
            None => items.push((
                sub.path,
                ShapeItem {
                    anchors,
                    subpath_starts: Vec::new(),
                    closed: sub.closed,
                    filled: sub.filled,
                    stroked: sub.stroked,
                },
            )),
        }
    }
    items.into_iter().map(|(_, i)| i).collect()
}

impl SheetSession {
    /// The shapes anchored in a page lowering's cells (tracks and frame
    /// pages: sheet indices), their outlines placed in their anchor boxes.
    pub fn page_shapes(&self, sheet: u16, content: &sheet_lower::LoweredContent) -> Vec<PageShape> {
        self.list_shapes(sheet)
            .unwrap_or_default()
            .into_iter()
            .filter(|s| {
                content.rows.iter().any(|r| r.index == s.row)
                    && content.cols.iter().any(|c| c.index == s.col)
            })
            .collect()
    }

    /// Every shape of a sheet, lowered (sheet ADR 530).
    pub fn list_shapes(&self, sheet: u16) -> Result<Vec<PageShape>, SessionError> {
        self.validate_sheet(sheet)?;
        let ws = self.engine().model().sheets.get(sheet as usize);
        let theme = self
            .doc
            .chart_theme
            .unwrap_or(sheet_chart::colors::OFFICE_THEME);
        Ok(self
            .doc
            .shapes_of(sheet)
            .into_iter()
            .map(|s| {
                let Placed {
                    w: aw,
                    h: ah,
                    row,
                    col,
                    dx,
                    dy,
                    ..
                } = place_anchor(ws, &s.anchor);
                // A turned shape states its own size: its anchor is the box
                // the turned shape fills.
                let (w, h) = match s.ext {
                    Some((cx, cy)) if s.rot % 21_600_000 != 0 => (
                        cx as f64 / sheet_xlsx::parts::pictures::EMU_PER_PT,
                        cy as f64 / sheet_xlsx::parts::pictures::EMU_PER_PT,
                    ),
                    _ => (aw, ah),
                };
                let (fx, mut losses) = sheet_chart::native::shape_look(&theme, &s.props, w, h);
                if !s.text.is_empty() {
                    losses.push("the text of a shape is not drawn on the page yet".into());
                }
                if s.arrowheads {
                    losses.push("a line's arrowheads are not drawn on the page yet".into());
                }
                PageShape {
                    items: items_of(&s, w, h, aw, ah),
                    id: s.id,
                    name: s.name,
                    row,
                    col,
                    dx,
                    dy,
                    w_pt: aw,
                    h_pt: ah,
                    fx,
                    losses,
                }
            })
            .collect())
    }
}
