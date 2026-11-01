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

//! Engine ADR 1041 — the pattern swatch: a tile of vector items repeated
//! over a lattice, used as a fill or a stroke like a colour or a gradient.
//!
//! A pattern lives in the palette ([`crate::Graphic::patterns`]) under a
//! `Pattern/<id>` key, and a frame shows it by naming that key in its
//! `fill_color` or `stroke_color`, as it names a gradient. The tile is a
//! rectangle `0..width × 0..height` in pattern space; its items are paths
//! in the same space (they may reach past the rectangle: the copies then
//! overlap, and [`PatternLayout`]'s overlap order says which is in front).
//!
//! The lattice ([`PatternLayout`]) places one copy of the items per
//! lattice point: a grid, bricks by row or by column (each row or column
//! shifted by a fraction of the pitch), or hexagons by column or by row.
//! Every lattice repeats with a rectangular **period**, the smallest
//! rectangle whose translates tile the plane with the same picture; the
//! period and the copies that touch it ([`PatternEntry::cell`]) are what
//! every consumer draws (the rasterisers' cached tile, PDF's tiling
//! pattern), so they cannot drift.
//!
//! The pattern's own placement ([`PatternPlacement`]: offset, scale and
//! rotation) takes pattern space to the frame's box, whose top-left is
//! the origin; a frame's `pattern_transform` moves it further for that
//! frame alone (Illustrator's "transform patterns").

use serde::{Deserialize, Serialize};

use crate::{ColorEntry, FillRule, Graphic, InlineStopColor, PathAnchor};

/// The key prefix of a pattern swatch in the palette.
pub const PATTERN_ID_PREFIX: &str = "Pattern/";

/// The frame label the IDML export keeps a frame's fill pattern in.
pub const PATTERN_FILL_LABEL_KEY: &str = "paged:fillPattern";

/// The frame label the IDML export keeps a frame's stroke pattern in.
pub const PATTERN_STROKE_LABEL_KEY: &str = "paged:strokePattern";

/// The most copies one period may hold. A lattice whose period would need
/// more (an extreme brick fraction, a tiny pitch under huge items) draws
/// the first ones; the cap keeps a malformed pattern from stalling a
/// render.
pub const MAX_CELL_COPIES: usize = 4096;

/// A pattern swatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternEntry {
    /// The palette key, `Pattern/<id>`.
    pub self_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The tile rectangle's width in pattern units (pt before scaling).
    pub width: f32,
    /// The tile rectangle's height.
    pub height: f32,
    #[serde(default)]
    pub layout: PatternLayout,
    #[serde(default)]
    pub placement: PatternPlacement,
    /// The tile's artwork, bottom first.
    pub items: Vec<PatternItem>,
}

/// How copies of the tile are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternLayout {
    #[serde(default)]
    pub kind: PatternTileKind,
    /// The shift of each brick row (column) as a fraction of the
    /// horizontal (vertical) pitch, `0..1`; `0.5` by default.
    /// Illustrator offers 1/2, 1/3, 1/4 and 1/5 (and their
    /// complements); any fraction is snapped to the nearest `p / q` with
    /// `q ≤ 16`, so the lattice has a period.
    #[serde(default = "half")]
    pub brick_offset: f32,
    /// Extra space between columns (negative overlaps), in pattern units.
    #[serde(default)]
    pub h_spacing: f32,
    /// Extra space between rows.
    #[serde(default)]
    pub v_spacing: f32,
    #[serde(default)]
    pub h_overlap: HorizontalOverlap,
    #[serde(default)]
    pub v_overlap: VerticalOverlap,
}

fn half() -> f32 {
    0.5
}

impl Default for PatternLayout {
    fn default() -> Self {
        PatternLayout {
            kind: PatternTileKind::Grid,
            brick_offset: 0.5,
            h_spacing: 0.0,
            v_spacing: 0.0,
            h_overlap: HorizontalOverlap::LeftInFront,
            v_overlap: VerticalOverlap::TopInFront,
        }
    }
}

/// Illustrator's Pattern Options "Tile Type".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PatternTileKind {
    #[default]
    Grid,
    BrickByRow,
    BrickByColumn,
    /// Columns `¾·width` apart, every other one shifted half a row.
    HexByColumn,
    /// Rows `¾·height` apart, every other one shifted half a column.
    HexByRow,
}

impl PatternTileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PatternTileKind::Grid => "Grid",
            PatternTileKind::BrickByRow => "BrickByRow",
            PatternTileKind::BrickByColumn => "BrickByColumn",
            PatternTileKind::HexByColumn => "HexByColumn",
            PatternTileKind::HexByRow => "HexByRow",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "" | "Grid" => PatternTileKind::Grid,
            "BrickByRow" => PatternTileKind::BrickByRow,
            "BrickByColumn" => PatternTileKind::BrickByColumn,
            "HexByColumn" => PatternTileKind::HexByColumn,
            "HexByRow" => PatternTileKind::HexByRow,
            _ => return None,
        })
    }
}

/// Which of two horizontally overlapping copies is in front.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum HorizontalOverlap {
    #[default]
    LeftInFront,
    RightInFront,
}

/// Which of two vertically overlapping copies is in front. The vertical
/// order is the outer one: rows are painted as a whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum VerticalOverlap {
    #[default]
    TopInFront,
    BottomInFront,
}

/// Where pattern space sits on the frame: `offset` after `rotation_deg`
/// (clockwise on the page) after `scale`, about the tile's origin.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternPlacement {
    #[serde(default)]
    pub offset: [f32; 2],
    #[serde(default = "unit_scale")]
    pub scale: [f32; 2],
    #[serde(default)]
    pub rotation_deg: f32,
}

fn unit_scale() -> [f32; 2] {
    [1.0, 1.0]
}

impl Default for PatternPlacement {
    fn default() -> Self {
        PatternPlacement {
            offset: [0.0, 0.0],
            scale: [1.0, 1.0],
            rotation_deg: 0.0,
        }
    }
}

impl PatternPlacement {
    /// The placement as an affine `[a b c d tx ty]` (pattern space → the
    /// frame's box space).
    pub fn matrix(&self) -> [f32; 6] {
        let (s, c) = self.rotation_deg.to_radians().sin_cos();
        let [sx, sy] = self.scale;
        [
            c * sx,
            s * sx,
            -s * sy,
            c * sy,
            self.offset[0],
            self.offset[1],
        ]
    }
}

/// One path of the tile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternItem {
    pub anchors: Vec<PathAnchor>,
    /// Indices into `anchors` where each contour starts; empty is one
    /// contour from 0.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subpath_starts: Vec<usize>,
    /// Per contour, whether it is open; missing entries are closed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subpath_open: Vec<bool>,
    #[serde(default, skip_serializing_if = "FillRule::is_non_zero")]
    pub fill_rule: FillRule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<PatternColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<PatternColor>,
    /// The stroke's width in pattern units.
    #[serde(default)]
    pub stroke_weight: f32,
}

impl PartialEq for PathAnchor {
    fn eq(&self, other: &Self) -> bool {
        self.anchor == other.anchor && self.left == other.left && self.right == other.right
    }
}

/// An item's colour: a palette swatch, or its own colour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PatternColor {
    Swatch(String),
    Inline(InlineStopColor),
}

impl PatternColor {
    /// The colour as a palette entry (an inline colour reads as an
    /// unnamed process swatch, as paint v2's stops do).
    pub fn resolve(&self, palette: &Graphic) -> Option<ColorEntry> {
        match self {
            PatternColor::Swatch(id) => palette.resolve(id).cloned(),
            PatternColor::Inline(c) => Some(c.as_entry("")),
        }
    }
}

/// The contours of an item: `(first anchor, end anchor, open)`.
pub fn contours(item: &PatternItem) -> Vec<(usize, usize, bool)> {
    let n = item.anchors.len();
    let mut starts: Vec<usize> = if item.subpath_starts.is_empty() {
        vec![0]
    } else {
        item.subpath_starts.clone()
    };
    starts.retain(|s| *s < n);
    starts.sort_unstable();
    starts.dedup();
    let mut out = Vec::with_capacity(starts.len());
    for (k, s) in starts.iter().enumerate() {
        let e = starts.get(k + 1).copied().unwrap_or(n);
        if e > *s {
            out.push((*s, e, item.subpath_open.get(k).copied().unwrap_or(false)));
        }
    }
    out
}

/// The repeating cell of a pattern: its size and the copies that touch it.
#[derive(Debug, Clone, PartialEq)]
pub struct PatternCell {
    /// The period's width and height, in pattern units.
    pub period: (f32, f32),
    /// The tile origin of every copy that reaches into the period
    /// rectangle `0..period.0 × 0..period.1`, in paint order (back first).
    pub copies: Vec<(f32, f32)>,
}

impl PatternEntry {
    /// Whether the pattern can paint: a positive, finite tile and at
    /// least one item.
    pub fn is_drawable(&self) -> bool {
        self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
            && !self.items.is_empty()
    }

    /// The box the items cover (control points included), in tile
    /// space; the tile rectangle when there are none.
    pub fn items_bounds(&self) -> [f32; 4] {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for item in &self.items {
            let pad = if item.stroke.is_some() {
                item.stroke_weight.max(0.0) * 0.5 + 0.5
            } else {
                0.0
            };
            for a in &item.anchors {
                for (x, y) in [a.anchor, a.left, a.right] {
                    x0 = x0.min(x - pad);
                    y0 = y0.min(y - pad);
                    x1 = x1.max(x + pad);
                    y1 = y1.max(y + pad);
                }
            }
        }
        if x0 > x1 || !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
            return [0.0, 0.0, self.width, self.height];
        }
        [x0, y0, x1, y1]
    }

    /// The lattice basis `(a, b)` and its rectangular period.
    pub fn lattice(&self) -> ([f32; 2], [f32; 2], (f32, f32)) {
        let l = &self.layout;
        let w = self.width.max(1e-3);
        let h = self.height.max(1e-3);
        let px = (w + l.h_spacing).max(w * 0.01);
        let py = (h + l.v_spacing).max(h * 0.01);
        match l.kind {
            PatternTileKind::Grid => ([px, 0.0], [0.0, py], (px, py)),
            PatternTileKind::BrickByRow => {
                let (p, q) = snap_fraction(l.brick_offset);
                (
                    [px, 0.0],
                    [px * p as f32 / q as f32, py],
                    (px, py * q as f32),
                )
            }
            PatternTileKind::BrickByColumn => {
                let (p, q) = snap_fraction(l.brick_offset);
                (
                    [px, py * p as f32 / q as f32],
                    [0.0, py],
                    (px * q as f32, py),
                )
            }
            PatternTileKind::HexByColumn => {
                let cx = (0.75 * w + l.h_spacing).max(w * 0.01);
                ([cx, py * 0.5], [0.0, py], (cx * 2.0, py))
            }
            PatternTileKind::HexByRow => {
                let ry = (0.75 * h + l.v_spacing).max(h * 0.01);
                ([px * 0.5, ry], [px, 0.0], (px, ry * 2.0))
            }
        }
    }

    /// The repeating cell: the period and every copy that reaches into
    /// it, in paint order (rows by the vertical overlap rule, then
    /// columns by the horizontal one).
    pub fn cell(&self) -> PatternCell {
        let (a, b, (pw, ph)) = self.lattice();
        let [bx0, by0, bx1, by1] = self.items_bounds();
        // A copy at `o` covers `o + [bx0, bx1] × [by0, by1]`; it touches
        // the period when that box meets `0..pw × 0..ph`.
        let det = a[0] * b[1] - a[1] * b[0];
        let mut copies: Vec<(f32, f32)> = Vec::new();
        if det.abs() > 1e-9 {
            // The lattice coordinates of the region the origins can be in:
            // `[-bx1, pw - bx0] × [-by1, ph - by0]`; bound i, j over its corners.
            let (ox0, oy0, ox1, oy1) = (-bx1, -by1, pw - bx0, ph - by0);
            let inv = |x: f32, y: f32| -> (f32, f32) {
                ((x * b[1] - y * b[0]) / det, (a[0] * y - a[1] * x) / det)
            };
            let (mut i0, mut j0, mut i1, mut j1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for (x, y) in [(ox0, oy0), (ox1, oy0), (ox0, oy1), (ox1, oy1)] {
                let (i, j) = inv(x, y);
                i0 = i0.min(i);
                j0 = j0.min(j);
                i1 = i1.max(i);
                j1 = j1.max(j);
            }
            let (i0, i1) = (i0.floor() as i64 - 1, i1.ceil() as i64 + 1);
            let (j0, j1) = (j0.floor() as i64 - 1, j1.ceil() as i64 + 1);
            if (i1 - i0 + 1).saturating_mul(j1 - j0 + 1) <= (MAX_CELL_COPIES as i64) * 16 {
                for j in j0..=j1 {
                    for i in i0..=i1 {
                        let x = i as f32 * a[0] + j as f32 * b[0];
                        let y = i as f32 * a[1] + j as f32 * b[1];
                        let eps = 1e-4;
                        if x + bx1 > eps
                            && x + bx0 < pw - eps
                            && y + by1 > eps
                            && y + by0 < ph - eps
                        {
                            copies.push((x, y));
                        }
                    }
                }
            }
        }
        let l = &self.layout;
        copies.sort_by(|p, q| {
            let vy = match l.v_overlap {
                // Top in front: the top row paints last.
                VerticalOverlap::TopInFront => q.1.total_cmp(&p.1),
                VerticalOverlap::BottomInFront => p.1.total_cmp(&q.1),
            };
            vy.then_with(|| match l.h_overlap {
                HorizontalOverlap::LeftInFront => q.0.total_cmp(&p.0),
                HorizontalOverlap::RightInFront => p.0.total_cmp(&q.0),
            })
        });
        copies.truncate(MAX_CELL_COPIES);
        PatternCell {
            period: (pw, ph),
            copies,
        }
    }
}

/// `f` (wrapped into `0..1`) as the nearest `p / q` with `q ≤ 16`, the
/// smallest such `q` within 1/1000.
pub fn snap_fraction(f: f32) -> (u32, u32) {
    let f = if f.is_finite() {
        f.rem_euclid(1.0)
    } else {
        0.5
    };
    let mut best = (0u32, 1u32, f32::MAX);
    for q in 1..=16u32 {
        let p = (f * q as f32).round() as u32;
        let err = (f - p as f32 / q as f32).abs();
        if err < 1e-3 {
            return (p % q, q);
        }
        if err < best.2 {
            best = (p % q, q, err);
        }
    }
    (best.0, best.1)
}

impl Graphic {
    /// The pattern swatch `id` names, if it is one.
    pub fn pattern(&self, id: &str) -> Option<&PatternEntry> {
        self.patterns.get(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f32, y: f32, s: f32) -> PatternItem {
        let p = |x: f32, y: f32| PathAnchor {
            anchor: (x, y),
            left: (x, y),
            right: (x, y),
        };
        PatternItem {
            anchors: vec![p(x, y), p(x + s, y), p(x + s, y + s), p(x, y + s)],
            subpath_starts: vec![],
            subpath_open: vec![],
            fill_rule: FillRule::NonZero,
            fill: Some(PatternColor::Swatch("Color/Black".into())),
            stroke: None,
            stroke_weight: 0.0,
        }
    }

    fn entry(kind: PatternTileKind, items: Vec<PatternItem>) -> PatternEntry {
        PatternEntry {
            self_id: "Pattern/t".into(),
            name: None,
            width: 10.0,
            height: 10.0,
            layout: PatternLayout {
                kind,
                ..Default::default()
            },
            placement: PatternPlacement::default(),
            items,
        }
    }

    #[test]
    fn a_grid_tile_inside_its_rect_has_one_copy_per_period() {
        let e = entry(PatternTileKind::Grid, vec![square(2.0, 2.0, 5.0)]);
        let c = e.cell();
        assert_eq!(c.period, (10.0, 10.0));
        assert_eq!(c.copies, vec![(0.0, 0.0)]);
    }

    #[test]
    fn a_brick_by_row_period_is_two_rows_tall_at_half() {
        let e = entry(PatternTileKind::BrickByRow, vec![square(0.0, 0.0, 10.0)]);
        let c = e.cell();
        assert_eq!(c.period, (10.0, 20.0));
        // Row 0 at x 0; row 1 shifted by 5 → copies at x 5 and x −5.
        let mut xs: Vec<(i32, i32)> = c
            .copies
            .iter()
            .map(|(x, y)| (x.round() as i32, y.round() as i32))
            .collect();
        xs.sort();
        assert_eq!(xs, vec![(-5, 10), (0, 0), (5, 10)]);
    }

    #[test]
    fn a_third_brick_offset_needs_three_rows() {
        let mut e = entry(PatternTileKind::BrickByColumn, vec![square(0.0, 0.0, 10.0)]);
        e.layout.brick_offset = 1.0 / 3.0;
        assert_eq!(e.cell().period, (30.0, 10.0));
        assert_eq!(snap_fraction(0.2), (1, 5));
        assert_eq!(snap_fraction(0.75), (3, 4));
    }

    #[test]
    fn hex_lattices_have_a_two_step_period() {
        let e = entry(PatternTileKind::HexByColumn, vec![square(0.0, 0.0, 10.0)]);
        assert_eq!(e.cell().period, (15.0, 10.0));
        let e = entry(PatternTileKind::HexByRow, vec![square(0.0, 0.0, 10.0)]);
        assert_eq!(e.cell().period, (10.0, 15.0));
    }

    #[test]
    fn overlapping_copies_paint_by_the_overlap_order() {
        // An item twice the tile: neighbours overlap.
        let mut e = entry(PatternTileKind::Grid, vec![square(0.0, 0.0, 15.0)]);
        let c = e.cell();
        // Top in front, left in front: the last copy is the top-left one.
        let last = *c.copies.last().unwrap();
        let min_y = c.copies.iter().map(|p| p.1).fold(f32::MAX, f32::min);
        assert_eq!(last.1, min_y);
        e.layout.v_overlap = VerticalOverlap::BottomInFront;
        let c = e.cell();
        let max_y = c.copies.iter().map(|p| p.1).fold(f32::MIN, f32::max);
        assert_eq!(c.copies.last().unwrap().1, max_y);
    }

    #[test]
    fn negative_spacing_overlaps_and_the_period_shrinks() {
        let mut e = entry(PatternTileKind::Grid, vec![square(0.0, 0.0, 10.0)]);
        e.layout.h_spacing = -4.0;
        let c = e.cell();
        assert_eq!(c.period, (6.0, 10.0));
        assert!(c.copies.len() >= 2);
    }

    #[test]
    fn a_pattern_round_trips_through_json() {
        let mut e = entry(PatternTileKind::HexByRow, vec![square(1.0, 1.0, 3.0)]);
        e.items[0].stroke = Some(PatternColor::Inline(InlineStopColor {
            space: crate::ColorSpace::Rgb,
            value: vec![255.0, 0.0, 0.0],
        }));
        e.items[0].stroke_weight = 0.5;
        e.placement.rotation_deg = 30.0;
        let json = serde_json::to_string(&e).unwrap();
        let back: PatternEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn placement_scales_then_turns_then_moves() {
        let p = PatternPlacement {
            offset: [5.0, 7.0],
            scale: [2.0, 2.0],
            rotation_deg: 90.0,
        };
        let m = p.matrix();
        // (1, 0) → scaled (2, 0) → turned clockwise in y-down (0, 2) → + offset.
        let x = m[0] * 1.0 + m[4];
        let y = m[1] * 1.0 + m[5];
        assert!((x - 5.0).abs() < 1e-5 && (y - 9.0).abs() < 1e-5);
    }
}
