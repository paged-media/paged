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
//!
//! Engine ADR 1096: a preset shape is the engine's live preset. Each item of
//! a preset carries its [`PresetShape`] (the box it is drawn for, relative to
//! the anchor box), its anchors are what the engine draws for that box (the
//! flips mirror them in the box), and a rotation is the item's transform,
//! not baked into the anchors, so a resize or an adjust handle keeps it a
//! preset. A custom geometry (and a preset whose paths do not split into the
//! engine's parts) is drawn as before, turned in the anchors.

use paged_model::live_shape::{PresetPart, PresetShape};
use paged_model::OfficeLineEnd;
use sheet_chart::native::{LossEntry, LossSeverity};
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
    /// Engine ADR 1096 — the preset the anchors are drawn from, its box
    /// (`frame`) relative to the anchor box: the host offsets the box with
    /// the anchors and sets it (`frameShapePreset`). `None` for a custom
    /// geometry and a preset drawn turned in its anchors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<PresetShape>,
    /// Engine ADR 1093 (amendment 2) — Office's line ends of an open item
    /// (`a:headEnd` at its first anchor, `a:tailEnd` at its last).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_head: Option<OfficeLineEnd>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_head: Option<OfficeLineEnd>,
    /// The InDesign arrowhead nearest each Office head (`frameStrokeStart
    /// Arrowhead` / `…EndArrowhead` tokens), set beside it for IDML.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_arrowhead: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_arrowhead: Option<String>,
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
    /// Engine ADR 1096 — the items' transform `[a, b, c, d, tx, ty]` in the
    /// anchor box's coordinates: the shape's rotation about the box's
    /// centre, for a preset whose anchors are drawn upright. `None` when
    /// the shape is not turned or its anchors are turned already.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transform: Option<[f64; 6]>,
    /// Fill, outline, opacity and effects (colours as `#RRGGBB`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fx: Option<sheet_chart::native::NativeFx>,
    /// What the page cannot hold of the shape, one entry per kind.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub losses: Vec<LossEntry>,
    /// The URL its click action opens (`a:hlinkClick`, sheet ADR 531).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// Contours grouped into items, one per `a:path` (several contours as
/// `subpath_starts`), each mapped by `map`.
fn group(
    subpaths: &[dml_geom::SubPath],
    map: impl Fn((f64, f64)) -> [f64; 2],
) -> Vec<(usize, Vec<usize>, ShapeItem)> {
    let mut items: Vec<(usize, Vec<usize>, ShapeItem)> = Vec::new();
    for (k, sub) in subpaths.iter().enumerate() {
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
        match items.iter_mut().find(|(path, _, _)| *path == sub.path) {
            Some((_, subs, item)) => {
                if item.subpath_starts.is_empty() {
                    item.subpath_starts.push(0);
                }
                item.subpath_starts.push(item.anchors.len());
                item.anchors.extend(anchors);
                item.closed &= sub.closed;
                subs.push(k);
            }
            None => items.push((
                sub.path,
                vec![k],
                ShapeItem {
                    anchors,
                    subpath_starts: Vec::new(),
                    closed: sub.closed,
                    filled: sub.filled,
                    stroked: sub.stroked,
                    preset: None,
                    start_head: None,
                    end_head: None,
                    start_arrowhead: None,
                    end_arrowhead: None,
                },
            )),
        }
    }
    items
}

/// The engine part each item of a preset is (engine ADR 1096: one item draws
/// every path, or the filled paths and the stroke-only detail paths over
/// them), or `None` when the items do not split so.
fn parts_of(
    subpaths: &[dml_geom::SubPath],
    items: &[(usize, Vec<usize>, ShapeItem)],
) -> Option<Vec<PresetPart>> {
    let drawn: Vec<usize> = (0..subpaths.len())
        .filter(|&k| subpaths[k].points.len() >= 2)
        .collect();
    if items.len() == 1 {
        return (items[0].1 == drawn).then(|| vec![PresetPart::All]);
    }
    let fill: Vec<usize> = drawn
        .iter()
        .copied()
        .filter(|&k| subpaths[k].filled)
        .collect();
    let detail: Vec<usize> = drawn
        .iter()
        .copied()
        .filter(|&k| !subpaths[k].filled && subpaths[k].stroked)
        .collect();
    items
        .iter()
        .map(|(_, subs, _)| {
            if *subs == fill {
                Some(PresetPart::Fill)
            } else if *subs == detail {
                Some(PresetPart::Detail)
            } else {
                None
            }
        })
        .collect()
}

/// The items of a preset shape drawn as the engine's live preset: upright in
/// the `w` × `h` shape box centred in the `aw` × `ah` anchor box, mirrored
/// by the flips, each with its part of the program; and the rotation about
/// the box's centre as the items' transform. `None` for a name that is no
/// preset or paths that do not split into the engine's parts.
fn live_items(
    shape: &SheetShape,
    name: &str,
    adjust: &[(String, String)],
    (w, h, aw, ah): (f64, f64, f64, f64),
) -> Option<(Vec<ShapeItem>, Option<[f64; 6]>)> {
    let evaluated = dml_geom::preset_evaluated(name, adjust, w, h)?;
    let (bx, by) = ((aw - w) / 2.0, (ah - h) / 2.0);
    let base = PresetShape {
        name: name.to_string(),
        adjusts: adjust.to_vec(),
        frame: [bx as f32, by as f32, w as f32, h as f32],
        flip_h: shape.flip_h,
        flip_v: shape.flip_v,
        part: PresetPart::All,
        key: Some(shape.id.clone()),
        connector: None,
    };
    let subs = &evaluated.outline.subpaths;
    let grouped = group(subs, |p| [p.0, p.1]);
    let parts = parts_of(subs, &grouped)?;
    let mut items = Vec::with_capacity(grouped.len());
    for ((_, _, mut item), part) in grouped.into_iter().zip(parts) {
        let preset = PresetShape {
            part,
            ..base.clone()
        };
        // The anchors the engine draws for the box: its own evaluation,
        // so the item is live by construction.
        let drawn = paged_preset_geom::model::subpaths_in_box(&preset)?;
        let mut anchors = Vec::new();
        let mut starts = Vec::new();
        for s in drawn.iter().filter(|s| !s.points.is_empty()) {
            starts.push(anchors.len());
            anchors.extend(s.points.iter().map(|p| ShapeAnchor {
                anchor: [p.anchor.0 + bx, p.anchor.1 + by],
                left: [p.left.0 + bx, p.left.1 + by],
                right: [p.right.0 + bx, p.right.1 + by],
            }));
        }
        if starts.len() <= 1 {
            starts.clear();
        }
        if anchors.len() != item.anchors.len() || starts != item.subpath_starts {
            return None;
        }
        item.anchors = anchors;
        item.preset = Some(preset);
        items.push(item);
    }
    let transform = (shape.rot % 21_600_000 != 0).then(|| {
        use dml_geom::place::{mul, orient, translate};
        let turn = orient(shape.rot as f64 / 60_000.0, false, false);
        mul(
            &translate(aw / 2.0, ah / 2.0),
            &mul(&turn, &translate(-aw / 2.0, -ah / 2.0)),
        )
    });
    Some((items, transform))
}

/// The outline of `shape` in its `w` × `h` box, flipped and turned about the
/// box's centre, as items in the anchor box of size `aw` × `ah` (the shape
/// box centred in it), with the items' transform when the rotation is kept
/// out of the anchors (a live preset).
fn items_of(
    shape: &SheetShape,
    w: f64,
    h: f64,
    aw: f64,
    ah: f64,
) -> (Vec<ShapeItem>, Option<[f64; 6]>) {
    let outline = match &shape.geometry {
        ShapeGeometry::Preset { name, adjust } => {
            if let Some(live) = live_items(shape, name, adjust, (w, h, aw, ah)) {
                return live;
            }
            dml_geom::preset(name, adjust, w, h).or_else(|| dml_geom::preset("rect", &[], w, h))
        }
        ShapeGeometry::Custom(c) => Some(dml_geom::custom(c, w, h)),
    };
    let Some(outline) = outline else {
        return (Vec::new(), None);
    };
    // The shape box sits centred in the anchor box; it turns and flips
    // about that centre, as every DrawingML placement does.
    use dml_geom::place::{apply, mul, orient, translate};
    let turn = orient(shape.rot as f64 / 60_000.0, shape.flip_h, shape.flip_v);
    let m = mul(
        &translate(aw / 2.0, ah / 2.0),
        &mul(&turn, &translate(-w / 2.0, -h / 2.0)),
    );
    let map = |p: (f64, f64)| -> [f64; 2] {
        let (x, y) = apply(&m, p);
        [x, y]
    };
    let items = group(&outline.subpaths, map)
        .into_iter()
        .map(|(_, _, i)| i)
        .collect();
    (items, None)
}

/// Office's line ends on the open items of `shape` (`a:headEnd` at the first
/// anchor, `a:tailEnd` at the last), with the nearest InDesign arrowhead
/// for IDML; a line end Office does not define is a loss.
fn put_heads(shape: &SheetShape, items: &mut [ShapeItem], losses: &mut Vec<LossEntry>) {
    let Some(line) = shape.props.line.as_ref() else {
        return;
    };
    let mut end = |e: Option<&paged_ooxml::drawingml::LineEnd>| -> Option<OfficeLineEnd> {
        match dml_geom::heads::office_end(e?) {
            Ok(o) => o,
            Err(kind) => {
                losses.push(LossEntry::new(
                    "xlsx.shape.lineEnd",
                    LossSeverity::Dropped,
                    format!("a line end of type \u{201c}{kind}\u{201d} is not drawn"),
                ));
                None
            }
        }
    };
    let (head, tail) = (end(line.head.as_ref()), end(line.tail.as_ref()));
    if head.is_none() && tail.is_none() {
        return;
    }
    for item in items.iter_mut().filter(|i| !i.closed) {
        item.start_head = head;
        item.end_head = tail;
        item.start_arrowhead = head.map(|h| h.nearest_arrowhead().as_idml().to_string());
        item.end_arrowhead = tail.map(|t| t.nearest_arrowhead().as_idml().to_string());
    }
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
                    losses.push(LossEntry::new(
                        "xlsx.shape.text",
                        LossSeverity::Dropped,
                        "the text of a shape is not drawn on the page yet",
                    ));
                }
                let (mut items, transform) = items_of(&s, w, h, aw, ah);
                put_heads(&s, &mut items, &mut losses);
                PageShape {
                    items,
                    transform,
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
                    link: s.link,
                }
            })
            .collect())
    }
}

impl SheetSession {
    /// Engine ADR 1096 — the page's preset of shape `id` written into the
    /// workbook's drawing (`a:prstGeom` with `adjusts` as its `a:avLst`), so
    /// an adjust handle moved on the page reaches the saved xlsx. The size
    /// and place of the shape (its cell anchor) are not written. `false`
    /// when the drawing already says so.
    pub fn set_shape_preset(
        &mut self,
        id: &str,
        name: &str,
        adjusts: &[(String, String)],
    ) -> Result<bool, SessionError> {
        self.doc
            .set_shape_preset(id, name, adjusts)
            .map_err(|e| SessionError(e.to_string()))
    }
}
