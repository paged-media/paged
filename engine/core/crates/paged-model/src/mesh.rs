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

//! Engine ADR 1040 — the gradient mesh and the freeform gradient: two
//! native fills no swatch can hold.
//!
//! Both are per-object (their points sit on the object, in the frame's
//! inner coordinates), so they live on the frame as
//! [`MeshFill`], next to the swatch reference they replace while set.
//!
//! * A **gradient mesh** is one or more grids of patches. A grid of
//!   `rows × cols` patches has `(rows + 1) × (cols + 1)` nodes; each node
//!   has a position, a colour (with an opacity) and four handles, the
//!   inner control points of the edges that leave it towards the
//!   previous column, the next column, the previous row and the next
//!   row. A patch is a Coons patch of its four edges, or a tensor patch
//!   when the grid carries its four interior control points
//!   ([`MeshGrid::tensor`], what a PDF type-7 shading reads as).
//! * A **freeform gradient** is a set of coloured points, each with a
//!   spread, and lines through some of them; the colour between them is
//!   a smooth blend (`paged_compose::mesh` evaluates it).
//!
//! Colours are inline (`space` + `value`, as a [`ColorEntry`] has them)
//! with an optional opacity, the way paint v2's stops carry theirs.

use serde::{Deserialize, Serialize};

use crate::{ColorEntry, ColorModel, ColorSpace};

/// The native fill a frame shows instead of its swatch while set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MeshFill {
    /// A gradient mesh (Illustrator's Mesh tool, PDF shadings 6 and 7).
    Mesh(GradientMesh),
    /// A freeform gradient (Illustrator's points and lines).
    Freeform(FreeformGradient),
}

/// A gradient mesh: one grid, or several (a PDF shading whose patches
/// form no single grid imports as one grid per patch).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GradientMesh {
    pub grids: Vec<MeshGrid>,
}

/// `rows × cols` patches over `(rows + 1) × (cols + 1)` nodes, row-major
/// from the top-left node.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MeshGrid {
    pub rows: u32,
    pub cols: u32,
    pub nodes: Vec<MeshNode>,
    /// Per patch (row-major), its four interior control points `p11`,
    /// `p12`, `p21`, `p22` — a tensor-product patch. Empty: every patch
    /// is a Coons patch, its interior derived from its edges.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tensor: Vec<[[f32; 2]; 4]>,
}

/// Which of a node's four handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshHandle {
    /// Towards the previous column.
    Left = 0,
    /// Towards the next column.
    Right = 1,
    /// Towards the previous row.
    Up = 2,
    /// Towards the next row.
    Down = 3,
}

/// One mesh point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeshNode {
    /// The node's position in the frame's inner coordinates.
    pub point: [f32; 2],
    /// The edge control points that leave the node: towards the
    /// previous column, the next column, the previous row and the next
    /// row ([`MeshHandle`]). A handle on the mesh's outside has no edge
    /// and is not read.
    pub handles: [[f32; 2]; 4],
    pub color: MeshColor,
}

/// A mesh point's or freeform point's colour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeshColor {
    pub space: ColorSpace,
    /// Channel values in `space` (CMYK percent, RGB 0..=255, Lab
    /// `L* a* b*`, Gray percent).
    pub value: Vec<f32>,
    /// 0..=100; `None` is 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity_pct: Option<f32>,
}

impl MeshColor {
    /// An opaque RGB colour, `value` in 0..=255.
    pub fn rgb(r: f32, g: f32, b: f32) -> Self {
        MeshColor {
            space: ColorSpace::Rgb,
            value: vec![r, g, b],
            opacity_pct: None,
        }
    }

    /// The opacity as a 0..=1 factor.
    pub fn opacity(&self) -> f32 {
        self.opacity_pct
            .map(|o| (o / 100.0).clamp(0.0, 1.0))
            .unwrap_or(1.0)
    }

    /// The colour as an unnamed process [`ColorEntry`], so every
    /// resolver that reads swatches reads it alike.
    pub fn as_entry(&self) -> ColorEntry {
        ColorEntry {
            self_id: String::new(),
            name: None,
            space: self.space,
            value: self.value.clone(),
            model: ColorModel::Process,
            alternate_space: None,
            alternate_value: Vec::new(),
            tint: None,
            alpha: None,
        }
    }
}

/// A freeform gradient.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FreeformGradient {
    pub points: Vec<FreeformPoint>,
    /// Lines, each through two or more of `points` (by index), in order.
    /// The colour runs along a line from point to point; a point on a
    /// line colours the area through the line only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<Vec<u32>>,
}

/// One freeform colour point.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FreeformPoint {
    /// The point's position in the frame's inner coordinates.
    pub point: [f32; 2],
    pub color: MeshColor,
    /// How far the point's colour holds before it starts to blend, as a
    /// percentage (0..=100) of the frame's box diagonal; `None` is 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spread_pct: Option<f32>,
}

impl FreeformPoint {
    /// The spread as a 0..=1 fraction of the box diagonal.
    pub fn spread(&self) -> f32 {
        self.spread_pct
            .map(|s| (s / 100.0).clamp(0.0, 1.0))
            .unwrap_or(0.0)
    }
}

/// One patch of a grid, its sixteen control points `p[i][j]` (`i` down
/// the rows, `j` across the columns; the corners are the grid's nodes)
/// and its corner colours `[c00, c03, c30, c33]`.
#[derive(Debug, Clone, PartialEq)]
pub struct MeshPatch<'a> {
    pub points: [[[f32; 2]; 4]; 4],
    pub colors: [&'a MeshColor; 4],
    /// Whether the interior came from the grid's tensor points (a
    /// tensor patch) rather than from the edges (a Coons patch).
    pub tensor: bool,
}

impl MeshGrid {
    /// The node at `(row, col)`.
    pub fn node(&self, row: u32, col: u32) -> Option<&MeshNode> {
        self.nodes.get((row * (self.cols + 1) + col) as usize)
    }

    /// Whether the node count matches `rows × cols` and every tensor
    /// entry has its patch.
    pub fn is_well_formed(&self) -> bool {
        self.rows > 0
            && self.cols > 0
            && self.nodes.len() == ((self.rows + 1) * (self.cols + 1)) as usize
            && (self.tensor.is_empty() || self.tensor.len() == (self.rows * self.cols) as usize)
    }

    /// The patch at `(row, col)`, `None` when the grid is malformed.
    pub fn patch(&self, row: u32, col: u32) -> Option<MeshPatch<'_>> {
        if !self.is_well_formed() || row >= self.rows || col >= self.cols {
            return None;
        }
        let a = self.node(row, col)?;
        let b = self.node(row, col + 1)?;
        let c = self.node(row + 1, col)?;
        let d = self.node(row + 1, col + 1)?;
        let (l, r, u, dn) = (
            MeshHandle::Left as usize,
            MeshHandle::Right as usize,
            MeshHandle::Up as usize,
            MeshHandle::Down as usize,
        );
        let mut p = [[[0.0f32; 2]; 4]; 4];
        p[0] = [a.point, a.handles[r], b.handles[l], b.point];
        p[3] = [c.point, c.handles[r], d.handles[l], d.point];
        p[1][0] = a.handles[dn];
        p[2][0] = c.handles[u];
        p[1][3] = b.handles[dn];
        p[2][3] = d.handles[u];
        let tensor = match self.tensor.get((row * self.cols + col) as usize) {
            Some(t) => {
                p[1][1] = t[0];
                p[1][2] = t[1];
                p[2][1] = t[2];
                p[2][2] = t[3];
                true
            }
            None => {
                let [p11, p12, p21, p22] = coons_interior(&p);
                p[1][1] = p11;
                p[1][2] = p12;
                p[2][1] = p21;
                p[2][2] = p22;
                false
            }
        };
        Some(MeshPatch {
            points: p,
            colors: [&a.color, &b.color, &c.color, &d.color],
            tensor,
        })
    }

    /// Every patch, row-major.
    pub fn patches(&self) -> Vec<MeshPatch<'_>> {
        let mut out = Vec::with_capacity((self.rows * self.cols) as usize);
        for r in 0..self.rows {
            for c in 0..self.cols {
                if let Some(p) = self.patch(r, c) {
                    out.push(p);
                }
            }
        }
        out
    }

    /// A one-patch grid over the box `[left, top, right, bottom]`, its
    /// edges straight (handles at the thirds), every corner `color`.
    pub fn rect(bounds: [f32; 4], color: &MeshColor) -> Self {
        let [l, t, r, b] = bounds;
        let corner = |x: f32, y: f32| MeshNode {
            point: [x, y],
            handles: [[x, y]; 4],
            color: color.clone(),
        };
        let mut grid = MeshGrid {
            rows: 1,
            cols: 1,
            nodes: vec![corner(l, t), corner(r, t), corner(l, b), corner(r, b)],
            tensor: Vec::new(),
        };
        grid.straighten_handles();
        grid
    }

    /// Put every handle a third of the way along the straight line to
    /// its neighbour (on the outside, on its own node).
    pub fn straighten_handles(&mut self) {
        let cols = self.cols + 1;
        let rows = self.rows + 1;
        let at = |nodes: &[MeshNode], r: u32, c: u32| nodes[(r * cols + c) as usize].point;
        let third =
            |a: [f32; 2], b: [f32; 2]| [a[0] + (b[0] - a[0]) / 3.0, a[1] + (b[1] - a[1]) / 3.0];
        let snapshot = self.nodes.clone();
        for r in 0..rows {
            for c in 0..cols {
                let p = at(&snapshot, r, c);
                let n = &mut self.nodes[(r * cols + c) as usize];
                n.handles[MeshHandle::Left as usize] = if c > 0 {
                    third(p, at(&snapshot, r, c - 1))
                } else {
                    p
                };
                n.handles[MeshHandle::Right as usize] = if c + 1 < cols {
                    third(p, at(&snapshot, r, c + 1))
                } else {
                    p
                };
                n.handles[MeshHandle::Up as usize] = if r > 0 {
                    third(p, at(&snapshot, r - 1, c))
                } else {
                    p
                };
                n.handles[MeshHandle::Down as usize] = if r + 1 < rows {
                    third(p, at(&snapshot, r + 1, c))
                } else {
                    p
                };
            }
        }
    }
}

/// The interior control points `[p11, p12, p21, p22]` that make a
/// tensor patch the Coons patch of its boundary (ISO 32000-1, 8.7.4.5.8).
pub fn coons_interior(p: &[[[f32; 2]; 4]; 4]) -> [[f32; 2]; 4] {
    let f = |k: usize| -> [f32; 4] {
        let g = |i: usize, j: usize| p[i][j][k];
        [
            (-4.0 * g(0, 0) + 6.0 * (g(0, 1) + g(1, 0)) - 2.0 * (g(0, 3) + g(3, 0))
                + 3.0 * (g(3, 1) + g(1, 3))
                - g(3, 3))
                / 9.0,
            (-4.0 * g(0, 3) + 6.0 * (g(0, 2) + g(1, 3)) - 2.0 * (g(0, 0) + g(3, 3))
                + 3.0 * (g(3, 2) + g(1, 0))
                - g(3, 0))
                / 9.0,
            (-4.0 * g(3, 0) + 6.0 * (g(3, 1) + g(2, 0)) - 2.0 * (g(3, 3) + g(0, 0))
                + 3.0 * (g(0, 1) + g(2, 3))
                - g(0, 3))
                / 9.0,
            (-4.0 * g(3, 3) + 6.0 * (g(3, 2) + g(2, 3)) - 2.0 * (g(3, 0) + g(0, 3))
                + 3.0 * (g(0, 2) + g(2, 0))
                - g(0, 0))
                / 9.0,
        ]
    };
    let (x, y) = (f(0), f(1));
    [[x[0], y[0]], [x[1], y[1]], [x[2], y[2]], [x[3], y[3]]]
}

impl MeshFill {
    /// Whether the fill has anything to paint.
    pub fn is_empty(&self) -> bool {
        match self {
            MeshFill::Mesh(m) => !m.grids.iter().any(MeshGrid::is_well_formed),
            MeshFill::Freeform(f) => f.points.is_empty(),
        }
    }

    /// Every colour the fill names.
    pub fn colors(&self) -> Vec<&MeshColor> {
        match self {
            MeshFill::Mesh(m) => m
                .grids
                .iter()
                .flat_map(|g| g.nodes.iter().map(|n| &n.color))
                .collect(),
            MeshFill::Freeform(f) => f.points.iter().map(|p| &p.color).collect(),
        }
    }

    /// Whether any colour is less than fully opaque.
    pub fn is_translucent(&self) -> bool {
        self.colors().iter().any(|c| c.opacity() < 1.0)
    }

    /// The fill carried from the box `from` to the box `to` (each
    /// `[top, left, bottom, right]`, a frame's `GeometricBounds`): every
    /// point, handle and tensor point keeps its place relative to the box,
    /// as Illustrator's mesh follows its object. A degenerate side
    /// translates only.
    pub fn map_box(&mut self, from: [f32; 4], to: [f32; 4]) {
        let [t0, l0, b0, r0] = from;
        let [t1, l1, b1, r1] = to;
        let sx = if (r0 - l0).abs() > 1e-6 {
            (r1 - l1) / (r0 - l0)
        } else {
            1.0
        };
        let sy = if (b0 - t0).abs() > 1e-6 {
            (b1 - t1) / (b0 - t0)
        } else {
            1.0
        };
        self.map_points(|p| {
            p[0] = l1 + (p[0] - l0) * sx;
            p[1] = t1 + (p[1] - t0) * sy;
        });
    }

    /// The fill moved by `(dx, dy)` — every point, handle and tensor
    /// point (a frame whose inner coordinates move with its box).
    pub fn translate(&mut self, dx: f32, dy: f32) {
        self.map_points(|p| {
            p[0] += dx;
            p[1] += dy;
        });
    }

    fn map_points(&mut self, mv: impl Fn(&mut [f32; 2])) {
        match self {
            MeshFill::Mesh(m) => {
                for g in &mut m.grids {
                    for n in &mut g.nodes {
                        mv(&mut n.point);
                        n.handles.iter_mut().for_each(&mv);
                    }
                    for t in &mut g.tensor {
                        t.iter_mut().for_each(&mv);
                    }
                }
            }
            MeshFill::Freeform(f) => {
                for p in &mut f.points {
                    mv(&mut p.point);
                }
            }
        }
    }
}

/// Whether a frame's path is the ordinary axis-aligned box its
/// `GeometricBounds` describe — no anchors, or one closed contour of four
/// corner anchors on two x and two y values with no curved handles — so
/// it is DRAWN from its box (the renderer's pick, which moving or sizing
/// the box therefore moves). Anything else is drawn from its anchors.
pub fn path_is_plain_box(
    anchors: &[crate::PathAnchor],
    subpath_starts: &[usize],
    subpath_open: &[bool],
) -> bool {
    if anchors.is_empty() {
        return true;
    }
    if subpath_starts.len() > 1 || subpath_open.iter().any(|&o| o) {
        return false;
    }
    if anchors.len() != 4 {
        return false;
    }
    let eq = |a: f32, b: f32| (a - b).abs() < 1e-3;
    for a in anchors {
        if !eq(a.left.0, a.anchor.0)
            || !eq(a.left.1, a.anchor.1)
            || !eq(a.right.0, a.anchor.0)
            || !eq(a.right.1, a.anchor.1)
        {
            return false;
        }
    }
    let mut xs: Vec<f32> = anchors.iter().map(|a| a.anchor.0).collect();
    let mut ys: Vec<f32> = anchors.iter().map(|a| a.anchor.1).collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    eq(xs[0], xs[1]) && eq(xs[2], xs[3]) && eq(ys[0], ys[1]) && eq(ys[2], ys[3])
}

/// One patch as a reader hands it over (a PDF type-6/7 shading's patch,
/// mapped into the frame's inner coordinates): its sixteen control points
/// in [`MeshPatch::points`]' layout, its corner colours `[c00, c03, c30,
/// c33]`, and whether its interior points are its own (type 7).
#[derive(Debug, Clone, PartialEq)]
pub struct PatchInput {
    pub points: [[[f32; 2]; 4]; 4],
    pub colors: [MeshColor; 4],
    pub tensor: bool,
}

impl GradientMesh {
    /// A mesh from free patches: ONE editable grid when the patches tile
    /// one (each shares its edges' control points and its corners'
    /// colours with its neighbours, as a PDF writer's row-by-row mesh
    /// does), else one one-patch grid per patch, painted in order.
    pub fn from_patches(patches: Vec<PatchInput>) -> GradientMesh {
        if let Some(grid) = tile(&patches) {
            return GradientMesh { grids: vec![grid] };
        }
        GradientMesh {
            grids: patches
                .iter()
                .map(|p| tile(std::slice::from_ref(p)).unwrap_or_default())
                .collect(),
        }
    }
}

const TILE_EPS: f32 = 1e-3;

fn same(a: [f32; 2], b: [f32; 2]) -> bool {
    (a[0] - b[0]).abs() <= TILE_EPS && (a[1] - b[1]).abs() <= TILE_EPS
}

/// The grid `patches` tile, row-major from the patch whose top-left
/// corner no other patch touches; `None` when they tile no single grid.
fn tile(patches: &[PatchInput]) -> Option<MeshGrid> {
    let n = patches.len();
    if n == 0 {
        return None;
    }
    let right_of = |a: &PatchInput, b: &PatchInput| {
        (0..4).all(|i| same(a.points[i][3], b.points[i][0]))
            && a.colors[1] == b.colors[0]
            && a.colors[3] == b.colors[2]
    };
    let below = |a: &PatchInput, b: &PatchInput| {
        (0..4).all(|j| same(a.points[3][j], b.points[0][j]))
            && a.colors[2] == b.colors[0]
            && a.colors[3] == b.colors[1]
    };
    let origin = (0..n).find(|&i| {
        !(0..n).any(|k| {
            k != i && (right_of(&patches[k], &patches[i]) || below(&patches[k], &patches[i]))
        })
    })?;
    let mut used = vec![false; n];
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let mut row_start = Some(origin);
    while let Some(start) = row_start {
        if used[start] {
            return None;
        }
        let mut row = vec![start];
        used[start] = true;
        let mut cur = start;
        while let Some(next) = (0..n).find(|&k| !used[k] && right_of(&patches[cur], &patches[k])) {
            used[next] = true;
            row.push(next);
            cur = next;
        }
        row_start = (0..n).find(|&k| !used[k] && below(&patches[start], &patches[k]));
        rows.push(row);
    }
    let cols = rows[0].len();
    if rows.iter().any(|r| r.len() != cols) || used.iter().any(|u| !u) {
        return None;
    }
    for r in 1..rows.len() {
        for c in 0..cols {
            if !below(&patches[rows[r - 1][c]], &patches[rows[r][c]]) {
                return None;
            }
        }
    }
    let nrows = rows.len();
    let at = |r: usize, c: usize| &patches[rows[r][c]];
    let mut nodes = Vec::with_capacity((nrows + 1) * (cols + 1));
    for r in 0..=nrows {
        for c in 0..=cols {
            // The patch this node is the top-left corner of, or the
            // neighbour that has it as another corner.
            let (pr, pc) = (r.min(nrows - 1), c.min(cols - 1));
            let p = at(pr, pc);
            let (i, j) = (
                if r == nrows { 3 } else { 0 },
                if c == cols { 3 } else { 0 },
            );
            let point = p.points[i][j];
            let color = p.colors[(i / 3) * 2 + j / 3].clone();
            let mut handles = [point; 4];
            if c > 0 {
                let q = at(pr, c - 1);
                handles[MeshHandle::Left as usize] = q.points[i][2];
            }
            if c < cols {
                handles[MeshHandle::Right as usize] = at(pr, c).points[i][1];
            }
            if r > 0 {
                let q = at(r - 1, pc);
                handles[MeshHandle::Up as usize] = q.points[2][j];
            }
            if r < nrows {
                handles[MeshHandle::Down as usize] = at(r, pc).points[1][j];
            }
            nodes.push(MeshNode {
                point,
                handles,
                color,
            });
        }
    }
    let tensor = if patches.iter().any(|p| p.tensor) {
        rows.iter()
            .flatten()
            .map(|&k| {
                let p = &patches[k].points;
                if patches[k].tensor {
                    [p[1][1], p[1][2], p[2][1], p[2][2]]
                } else {
                    coons_interior(p)
                }
            })
            .collect()
    } else {
        Vec::new()
    };
    Some(MeshGrid {
        rows: nrows as u32,
        cols: cols as u32,
        nodes,
        tensor,
    })
}

/// The label key the IDML export keeps a frame's [`MeshFill`] under, as
/// JSON; the IDML import restores the fill from it and drops the entry.
pub const MESH_FILL_LABEL_KEY: &str = "paged:fillMesh";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rect_grid_is_one_coons_patch_with_straight_edges() {
        let g = MeshGrid::rect([0.0, 0.0, 90.0, 30.0], &MeshColor::rgb(255.0, 0.0, 0.0));
        assert!(g.is_well_formed());
        let p = g.patch(0, 0).unwrap();
        assert!(!p.tensor);
        assert_eq!(
            p.points[0],
            [[0.0, 0.0], [30.0, 0.0], [60.0, 0.0], [90.0, 0.0]]
        );
        assert_eq!(p.points[3][0], [0.0, 30.0]);
        assert_eq!(p.points[1][0], [0.0, 10.0]);
        // A bilinear patch's Coons interior is its own third points.
        let close =
            |a: [f32; 2], b: [f32; 2]| (a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4;
        assert!(close(p.points[1][1], [30.0, 10.0]));
        assert!(close(p.points[2][2], [60.0, 20.0]));
    }

    #[test]
    fn the_fill_round_trips_through_json() {
        let fill = MeshFill::Freeform(FreeformGradient {
            points: vec![FreeformPoint {
                point: [1.0, 2.0],
                color: MeshColor::rgb(1.0, 2.0, 3.0),
                spread_pct: Some(20.0),
            }],
            lines: vec![],
        });
        let json = serde_json::to_string(&fill).unwrap();
        assert!(json.contains("\"kind\":\"freeform\""), "{json}");
        assert!(!json.contains("lines"), "{json}");
        let back: MeshFill = serde_json::from_str(&json).unwrap();
        assert_eq!(back, fill);
    }

    fn input(g: &MeshGrid) -> Vec<PatchInput> {
        g.patches()
            .into_iter()
            .map(|p| PatchInput {
                points: p.points,
                colors: p.colors.map(MeshColor::clone),
                tensor: p.tensor,
            })
            .collect()
    }

    fn two_by_three() -> MeshGrid {
        let c = |r: f32| MeshColor::rgb(r, 0.0, 0.0);
        let mut nodes = Vec::new();
        for r in 0..3 {
            for k in 0..4 {
                nodes.push(MeshNode {
                    point: [
                        k as f32 * 10.0 + if r == 1 { 2.0 } else { 0.0 },
                        r as f32 * 10.0,
                    ],
                    handles: [[0.0; 2]; 4],
                    color: c((r * 4 + k) as f32),
                });
            }
        }
        let mut g = MeshGrid {
            rows: 2,
            cols: 3,
            nodes,
            tensor: Vec::new(),
        };
        g.straighten_handles();
        // A bent edge, to prove handles travel.
        g.nodes[5].handles[MeshHandle::Right as usize] = [16.0, 13.0];
        g
    }

    #[test]
    fn patches_that_tile_a_grid_come_back_as_that_grid() {
        let g = two_by_three();
        let mesh = GradientMesh::from_patches(input(&g));
        assert_eq!(mesh.grids.len(), 1);
        assert_eq!(mesh.grids[0], g);
        // Shuffled, the same grid.
        let mut shuffled = input(&g);
        shuffled.reverse();
        assert_eq!(GradientMesh::from_patches(shuffled).grids[0], g);
    }

    #[test]
    fn tensor_patches_keep_their_interior() {
        let mut g = two_by_three();
        let mut tensor: Vec<[[f32; 2]; 4]> = g
            .patches()
            .iter()
            .map(|p| {
                [
                    p.points[1][1],
                    p.points[1][2],
                    p.points[2][1],
                    p.points[2][2],
                ]
            })
            .collect();
        tensor[4][0] = [25.0, 15.0];
        g.tensor = tensor;
        let mesh = GradientMesh::from_patches(input(&g));
        assert_eq!(mesh.grids, vec![g]);
    }

    #[test]
    fn patches_that_tile_no_grid_stay_apart() {
        let g = two_by_three();
        let mut patches = input(&g);
        patches.remove(1);
        let mesh = GradientMesh::from_patches(patches.clone());
        assert_eq!(mesh.grids.len(), 5);
        let back: Vec<_> = mesh.grids.iter().flat_map(input).collect();
        assert_eq!(back, patches);
    }

    #[test]
    fn a_malformed_grid_has_no_patches() {
        let mut g = MeshGrid::rect([0.0, 0.0, 10.0, 10.0], &MeshColor::rgb(0.0, 0.0, 0.0));
        g.nodes.pop();
        assert!(g.patches().is_empty());
        assert!(MeshFill::Mesh(GradientMesh { grids: vec![g] }).is_empty());
    }
}
