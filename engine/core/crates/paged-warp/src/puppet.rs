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

//! PUPPET WARP: a triangle mesh over what a layer covers, bent
//! AS-RIGIDLY-AS-POSSIBLE so its pins land where they are dragged (WP5.6).
//!
//! # The mesh
//!
//! [`PuppetMesh::from_alpha`] lays a grid of cells of about `spacing` px
//! over the layer and keeps every cell within `expansion` px of a covered
//! pixel (alpha above a threshold); each kept cell is two triangles.
//! Photoshop's mesh follows the outline more closely; a grid is this
//! crate's choice (it is regular, so the solve is well conditioned, and
//! the expansion keeps the outline's antialiasing inside the mesh).
//!
//! # The solve
//!
//! The local/global iteration of Sorkine and Alexa, "As-Rigid-As-Possible
//! Surface Modeling" (SGP 2007), in the plane. With cotangent edge weights
//! `w_ij` (Pinkall and Polthier 1993; clamped below so a right angle's
//! zero weight cannot disconnect the grid), the energy
//! `Σ_i Σ_j w_ij ‖(p'_i − p'_j) − T_i (p_i − p_j)‖²` is minimised by
//! alternating:
//!
//! - LOCAL: each vertex's best `T_i` for the current positions, from
//!   `S_i = Σ_j w_ij e'_ij e_ijᵀ`: a rotation (`Rigid`: the angle
//!   `atan2(S₁₀ − S₀₁, S₀₀ + S₁₁)`), a rotation and a uniform scale
//!   (`Normal`: as-similar-as-possible) or any linear map (`Distort`:
//!   `S_i (Σ_j w_ij e eᵀ)⁻¹`);
//! - GLOBAL: the positions minimising the energy for those `T_i`, a
//!   sparse Laplace system `Σ_j w_ij (p'_i − p'_j) = Σ_j w_ij/2 (T_i +
//!   T_j)(p_i − p_j)` with the pinned vertices held, solved for x and y by
//!   preconditioned conjugate gradients.
//!
//! The start is the global step with every `T_i` the identity (the
//! harmonic deformation), then [`ITERATIONS`] rounds. A pin holds the mesh
//! vertex nearest to it; a connected part of the mesh without a pin stays
//! where it is. These modes are this crate's reading of Photoshop's
//! Rigid / Normal / Distort, not Photoshop's solver.
//!
//! # The raster
//!
//! [`backward_field`] rasterises the bent triangles: every output pixel
//! whose centre lies in one reads the barycentric point of the rest
//! triangle — a dense [`crate::field::Field`] (step 1). A pixel no bent
//! triangle covers reads nothing (transparent). Where the mesh folds over
//! itself the later triangle wins.

use crate::field::Field;

/// The rounds of local and global steps after the harmonic start.
pub const ITERATIONS: usize = 12;

/// How freely the mesh may bend (Photoshop's Puppet Warp modes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PuppetMode {
    /// Each neighbourhood only turns.
    Rigid,
    /// Each neighbourhood turns and scales uniformly.
    #[default]
    Normal,
    /// Each neighbourhood takes any linear map.
    Distort,
}

impl PuppetMode {
    /// The mode of wire code `n` (0 rigid, 1 normal, 2 distort).
    pub fn from_code(n: u32) -> Option<Self> {
        [PuppetMode::Rigid, PuppetMode::Normal, PuppetMode::Distort]
            .get(n as usize)
            .copied()
    }
}

/// A triangle mesh in pixel coordinates.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PuppetMesh {
    pub vertices: Vec<[f64; 2]>,
    pub triangles: Vec<[u32; 3]>,
}

/// A pin: the point it holds (rest position) and where it is now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pin {
    pub at: [f64; 2],
    pub to: [f64; 2],
}

impl PuppetMesh {
    /// A grid of cells over `width`×`height`, about `spacing` px each
    /// (stretched so whole cells fit), keeping cell `(cx, cy)` when `keep`
    /// says so; each kept cell is two triangles.
    pub fn grid(
        width: u32,
        height: u32,
        spacing: f64,
        keep: impl Fn(u32, u32, [f64; 4]) -> bool,
    ) -> Self {
        let spacing = spacing.max(2.0);
        let cols = ((f64::from(width) / spacing).round() as u32).max(1);
        let rows = ((f64::from(height) / spacing).round() as u32).max(1);
        let (sx, sy) = (
            f64::from(width) / f64::from(cols),
            f64::from(height) / f64::from(rows),
        );
        let mut index = vec![u32::MAX; ((cols + 1) * (rows + 1)) as usize];
        let mut mesh = PuppetMesh::default();
        let mut vertex = |mesh: &mut PuppetMesh, i: u32, j: u32| -> u32 {
            let k = (j * (cols + 1) + i) as usize;
            if index[k] == u32::MAX {
                index[k] = mesh.vertices.len() as u32;
                mesh.vertices.push([f64::from(i) * sx, f64::from(j) * sy]);
            }
            index[k]
        };
        for cy in 0..rows {
            for cx in 0..cols {
                let rect = [
                    f64::from(cx) * sx,
                    f64::from(cy) * sy,
                    f64::from(cx + 1) * sx,
                    f64::from(cy + 1) * sy,
                ];
                if !keep(cx, cy, rect) {
                    continue;
                }
                let a = vertex(&mut mesh, cx, cy);
                let b = vertex(&mut mesh, cx + 1, cy);
                let c = vertex(&mut mesh, cx + 1, cy + 1);
                let d = vertex(&mut mesh, cx, cy + 1);
                mesh.triangles.push([a, b, c]);
                mesh.triangles.push([a, c, d]);
            }
        }
        mesh
    }

    /// The grid over what a layer covers: a cell is kept when a pixel of
    /// `alpha` (one byte per pixel, `width`×`height`) above `threshold`
    /// lies within `expansion` px of it.
    pub fn from_alpha(
        alpha: &[u8],
        width: u32,
        height: u32,
        spacing: f64,
        expansion: f64,
        threshold: u8,
    ) -> Self {
        let (w, h) = (width as usize, height as usize);
        // A summed-area table of the covered pixels.
        let mut sat = vec![0u32; (w + 1) * (h + 1)];
        for y in 0..h {
            let mut row = 0u32;
            for x in 0..w {
                row += u32::from(alpha.get(y * w + x).is_some_and(|&a| a > threshold));
                sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
            }
        }
        let count = |x0: f64, y0: f64, x1: f64, y1: f64| -> u32 {
            let cl = |v: f64, n: usize| (v.max(0.0) as usize).min(n);
            let (x0, y0) = (cl(x0.floor(), w), cl(y0.floor(), h));
            let (x1, y1) = (cl(x1.ceil(), w), cl(y1.ceil(), h));
            if x1 <= x0 || y1 <= y0 {
                return 0;
            }
            sat[y1 * (w + 1) + x1] + sat[y0 * (w + 1) + x0]
                - sat[y0 * (w + 1) + x1]
                - sat[y1 * (w + 1) + x0]
        };
        let e = expansion.max(0.0);
        Self::grid(width, height, spacing, |_, _, r| {
            count(r[0] - e, r[1] - e, r[2] + e, r[3] + e) > 0
        })
    }

    /// The index of the vertex nearest to `p`, or `None` for an empty
    /// mesh.
    pub fn nearest(&self, p: [f64; 2]) -> Option<usize> {
        self.vertices
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| {
                let da = (a[0] - p[0]).powi(2) + (a[1] - p[1]).powi(2);
                let db = (b[0] - p[0]).powi(2) + (b[1] - p[1]).powi(2);
                da.total_cmp(&db)
            })
            .map(|(i, _)| i)
    }

    /// Every edge once, with its cotangent weight (clamped below).
    fn edges(&self) -> Vec<(u32, u32, f64)> {
        use std::collections::BTreeMap;
        let mut m: BTreeMap<(u32, u32), f64> = BTreeMap::new();
        for t in &self.triangles {
            for k in 0..3 {
                let (i, j, o) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                let (pi, pj, po) = (
                    self.vertices[i as usize],
                    self.vertices[j as usize],
                    self.vertices[o as usize],
                );
                let u = [pi[0] - po[0], pi[1] - po[1]];
                let v = [pj[0] - po[0], pj[1] - po[1]];
                let cross = (u[0] * v[1] - u[1] * v[0]).abs();
                let cot = if cross > 1e-12 {
                    (u[0] * v[0] + u[1] * v[1]) / cross
                } else {
                    0.0
                };
                *m.entry((i.min(j), i.max(j))).or_insert(0.0) += 0.5 * cot;
            }
        }
        m.into_iter()
            .map(|((i, j), w)| (i, j, w.max(0.05)))
            .collect()
    }
}

type M2 = [[f64; 2]; 2];

fn local_map(mode: PuppetMode, s: M2, cov: M2) -> M2 {
    match mode {
        PuppetMode::Rigid | PuppetMode::Normal => {
            let a = s[0][0] + s[1][1];
            let b = s[1][0] - s[0][1];
            let th = b.atan2(a);
            let (sn, cs) = th.sin_cos();
            let k = if mode == PuppetMode::Normal {
                let tr = cov[0][0] + cov[1][1];
                if tr > 1e-12 {
                    a.hypot(b) / tr
                } else {
                    1.0
                }
            } else {
                1.0
            };
            [[k * cs, -k * sn], [k * sn, k * cs]]
        }
        PuppetMode::Distort => {
            let det = cov[0][0] * cov[1][1] - cov[0][1] * cov[1][0];
            if det.abs() < 1e-12 {
                return [[1.0, 0.0], [0.0, 1.0]];
            }
            let inv = [
                [cov[1][1] / det, -cov[0][1] / det],
                [-cov[1][0] / det, cov[0][0] / det],
            ];
            [
                [
                    s[0][0] * inv[0][0] + s[0][1] * inv[1][0],
                    s[0][0] * inv[0][1] + s[0][1] * inv[1][1],
                ],
                [
                    s[1][0] * inv[0][0] + s[1][1] * inv[1][0],
                    s[1][0] * inv[0][1] + s[1][1] * inv[1][1],
                ],
            ]
        }
    }
}

/// The solver's sparse system: the weighted graph over the vertices.
struct System {
    /// Per vertex: `(neighbour, weight)`.
    adj: Vec<Vec<(usize, f64)>>,
    /// Held vertices (pinned, or in a part without a pin).
    fixed: Vec<bool>,
}

impl System {
    fn diag(&self, i: usize) -> f64 {
        self.adj[i].iter().map(|&(_, w)| w).sum()
    }

    /// `y = L_ff x` over the free vertices (held ones read 0).
    fn apply(&self, x: &[f64], y: &mut [f64]) {
        for i in 0..x.len() {
            if self.fixed[i] {
                y[i] = 0.0;
                continue;
            }
            let mut v = self.diag(i) * x[i];
            for &(j, w) in &self.adj[i] {
                if !self.fixed[j] {
                    v -= w * x[j];
                }
            }
            y[i] = v;
        }
    }

    /// Solve `L_ff x = b` by Jacobi-preconditioned conjugate gradients,
    /// starting from `x` (warm start). Held entries are left alone.
    fn solve(&self, b: &[f64], x: &mut [f64]) {
        let n = x.len();
        let mut r = vec![0.0; n];
        let mut ax = vec![0.0; n];
        self.apply(x, &mut ax);
        let inv_d: Vec<f64> = (0..n)
            .map(|i| {
                let d = self.diag(i);
                if self.fixed[i] || d <= 0.0 {
                    0.0
                } else {
                    1.0 / d
                }
            })
            .collect();
        for i in 0..n {
            r[i] = if self.fixed[i] { 0.0 } else { b[i] - ax[i] };
        }
        let mut z: Vec<f64> = (0..n).map(|i| r[i] * inv_d[i]).collect();
        let mut p = z.clone();
        let mut rz: f64 = (0..n).map(|i| r[i] * z[i]).sum();
        let b_norm = b.iter().map(|v| v * v).sum::<f64>().sqrt().max(1e-12);
        let mut ap = vec![0.0; n];
        for _ in 0..(4 * n).max(50) {
            let r_norm = r.iter().map(|v| v * v).sum::<f64>().sqrt();
            if r_norm <= 1e-10 * b_norm {
                break;
            }
            self.apply(&p, &mut ap);
            let pap: f64 = (0..n).map(|i| p[i] * ap[i]).sum();
            if pap.abs() < 1e-300 {
                break;
            }
            let alpha = rz / pap;
            for i in 0..n {
                if !self.fixed[i] {
                    x[i] += alpha * p[i];
                    r[i] -= alpha * ap[i];
                }
            }
            for i in 0..n {
                z[i] = r[i] * inv_d[i];
            }
            let rz_new: f64 = (0..n).map(|i| r[i] * z[i]).sum();
            let beta = rz_new / rz;
            rz = rz_new;
            for i in 0..n {
                p[i] = z[i] + beta * p[i];
            }
        }
    }
}

/// Bend `mesh` so each pin's vertex lands on its `to`. Returns the bent
/// vertex positions (the rest positions where nothing pulls).
pub fn solve(mesh: &PuppetMesh, pins: &[Pin], mode: PuppetMode) -> Vec<[f64; 2]> {
    let n = mesh.vertices.len();
    let rest = &mesh.vertices;
    let mut out = rest.clone();
    if n == 0 || pins.is_empty() {
        return out;
    }
    let edges = mesh.edges();
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for &(i, j, w) in &edges {
        adj[i as usize].push((j as usize, w));
        adj[j as usize].push((i as usize, w));
    }
    // The held vertices: each pin's nearest vertex (a later pin on the
    // same vertex wins) …
    let mut fixed = vec![false; n];
    for pin in pins {
        if let Some(k) = mesh.nearest(pin.at) {
            fixed[k] = true;
            out[k] = pin.to;
        }
    }
    // … and every vertex of a connected part without one.
    let mut part = vec![usize::MAX; n];
    let mut parts: Vec<Vec<usize>> = Vec::new();
    for s in 0..n {
        if part[s] != usize::MAX {
            continue;
        }
        let id = parts.len();
        let mut stack = vec![s];
        part[s] = id;
        let mut members = Vec::new();
        while let Some(v) = stack.pop() {
            members.push(v);
            for &(u, _) in &adj[v] {
                if part[u] == usize::MAX {
                    part[u] = id;
                    stack.push(u);
                }
            }
        }
        parts.push(members);
    }
    for members in &parts {
        if !members.iter().any(|&v| fixed[v]) {
            for &v in members {
                fixed[v] = true;
            }
        }
    }
    let sys = System { adj, fixed };
    let identity: M2 = [[1.0, 0.0], [0.0, 1.0]];
    let mut maps = vec![identity; n];
    let mut xs: Vec<f64> = out.iter().map(|p| p[0]).collect();
    let mut ys: Vec<f64> = out.iter().map(|p| p[1]).collect();
    for round in 0..=ITERATIONS {
        if round > 0 {
            // LOCAL: each vertex's best map for the current positions.
            for i in 0..n {
                let mut s = [[0.0; 2]; 2];
                let mut cov = [[0.0; 2]; 2];
                for &(j, w) in &sys.adj[i] {
                    let e = [rest[i][0] - rest[j][0], rest[i][1] - rest[j][1]];
                    let f = [xs[i] - xs[j], ys[i] - ys[j]];
                    for a in 0..2 {
                        for b in 0..2 {
                            s[a][b] += w * f[a] * e[b];
                            cov[a][b] += w * e[a] * e[b];
                        }
                    }
                }
                maps[i] = local_map(mode, s, cov);
            }
        }
        // GLOBAL: the positions for those maps, held vertices on the
        // right-hand side.
        let mut bx = vec![0.0; n];
        let mut by = vec![0.0; n];
        for i in 0..n {
            if sys.fixed[i] {
                continue;
            }
            for &(j, w) in &sys.adj[i] {
                let e = [rest[i][0] - rest[j][0], rest[i][1] - rest[j][1]];
                let (ti, tj) = (maps[i], maps[j]);
                let t = [
                    [ti[0][0] + tj[0][0], ti[0][1] + tj[0][1]],
                    [ti[1][0] + tj[1][0], ti[1][1] + tj[1][1]],
                ];
                bx[i] += 0.5 * w * (t[0][0] * e[0] + t[0][1] * e[1]);
                by[i] += 0.5 * w * (t[1][0] * e[0] + t[1][1] * e[1]);
                if sys.fixed[j] {
                    bx[i] += w * xs[j];
                    by[i] += w * ys[j];
                }
            }
        }
        sys.solve(&bx, &mut xs);
        sys.solve(&by, &mut ys);
    }
    for i in 0..n {
        out[i] = [xs[i], ys[i]];
    }
    out
}

/// Rasterise the bent mesh into a dense backward field over
/// `width`×`height` (step 1; NaN where no bent triangle covers a pixel
/// centre).
pub fn backward_field(mesh: &PuppetMesh, bent: &[[f64; 2]], width: u32, height: u32) -> Field {
    let mut field = Field::new(width, height, 1);
    field.d.fill([f32::NAN; 2]);
    let (w, h) = (i64::from(width), i64::from(height));
    for t in &mesh.triangles {
        let [a, b, c] = t.map(|k| bent[k as usize]);
        let [ra, rb, rc] = t.map(|k| mesh.vertices[k as usize]);
        let det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        if det.abs() < 1e-12 {
            continue;
        }
        let min_x = a[0].min(b[0]).min(c[0]);
        let max_x = a[0].max(b[0]).max(c[0]);
        let min_y = a[1].min(b[1]).min(c[1]);
        let max_y = a[1].max(b[1]).max(c[1]);
        let x0 = ((min_x - 0.5).ceil() as i64).max(0);
        let x1 = ((max_x - 0.5).floor() as i64).min(w - 1);
        let y0 = ((min_y - 0.5).ceil() as i64).max(0);
        let y1 = ((max_y - 0.5).floor() as i64).min(h - 1);
        for py in y0..=y1 {
            let cy = py as f64 + 0.5;
            for px in x0..=x1 {
                let cx = px as f64 + 0.5;
                let l1 = ((b[0] - cx) * (c[1] - cy) - (c[0] - cx) * (b[1] - cy)) / det;
                let l2 = ((c[0] - cx) * (a[1] - cy) - (a[0] - cx) * (c[1] - cy)) / det;
                let l3 = 1.0 - l1 - l2;
                const EPS: f64 = -1e-9;
                if l1 < EPS || l2 < EPS || l3 < EPS {
                    continue;
                }
                let sx = l1 * ra[0] + l2 * rb[0] + l3 * rc[0];
                let sy = l1 * ra[1] + l2 * rb[1] + l3 * rc[1];
                field.d[(py * w + px) as usize] = [(sx - cx) as f32, (sy - cy) as f32];
            }
        }
    }
    field
}

/// The mesh spacing of Photoshop's Density choice over a `width`×`height`
/// layer: 0 fewer points, 1 normal, 2 more points.
pub fn spacing_for(width: u32, height: u32, density: u32) -> f64 {
    let long = f64::from(width.max(height).max(1));
    let cells = match density {
        0 => 16.0,
        2 => 48.0,
        _ => 28.0,
    };
    (long / cells).max(4.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(n: u32) -> PuppetMesh {
        PuppetMesh::grid(n, n, f64::from(n) / 8.0, |_, _, _| true)
    }

    fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
        (a[0] - b[0]).hypot(a[1] - b[1])
    }

    #[test]
    fn the_grid_keeps_what_the_alpha_covers() {
        let (w, h) = (64u32, 64u32);
        let mut alpha = vec![0u8; (w * h) as usize];
        for y in 20..30 {
            for x in 20..30 {
                alpha[(y * w + x) as usize] = 255;
            }
        }
        let m = PuppetMesh::from_alpha(&alpha, w, h, 8.0, 2.0, 0);
        assert!(!m.triangles.is_empty());
        assert!(m.triangles.len() < 2 * 64, "only cells near the square");
        for v in &m.vertices {
            assert!(
                v[0] >= 8.0 && v[0] <= 40.0 && v[1] >= 8.0 && v[1] <= 40.0,
                "{v:?}"
            );
        }
        assert!(
            PuppetMesh::from_alpha(&vec![0; 64 * 64], 64, 64, 8.0, 2.0, 0)
                .triangles
                .is_empty()
        );
    }

    #[test]
    fn pins_where_they_are_change_nothing() {
        let m = square(80);
        let pins = [
            Pin {
                at: [10.0, 10.0],
                to: [10.0, 10.0],
            },
            Pin {
                at: [70.0, 70.0],
                to: [70.0, 70.0],
            },
        ];
        for mode in [PuppetMode::Rigid, PuppetMode::Normal, PuppetMode::Distort] {
            let bent = solve(&m, &pins, mode);
            for (a, b) in bent.iter().zip(&m.vertices) {
                assert!(dist(*a, *b) < 1e-6, "{mode:?}: {a:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn one_pin_translates_the_whole_part() {
        let m = square(80);
        let k = m.nearest([40.0, 40.0]).unwrap();
        let at = m.vertices[k];
        let bent = solve(
            &m,
            &[Pin {
                at,
                to: [at[0] + 7.0, at[1] - 3.0],
            }],
            PuppetMode::Rigid,
        );
        for (a, b) in bent.iter().zip(&m.vertices) {
            assert!((a[0] - b[0] - 7.0).abs() < 1e-3 && (a[1] - b[1] + 3.0).abs() < 1e-3);
        }
    }

    #[test]
    fn a_rigid_bend_keeps_edge_lengths_better_than_the_harmonic_start() {
        // A bar held at its left end and its right end lifted: ARAP keeps
        // the lengths far better than a plain Laplace interpolation would.
        let m = PuppetMesh::grid(160, 20, 10.0, |_, _, _| true);
        let left = m.nearest([0.0, 10.0]).unwrap();
        let right = m.nearest([160.0, 10.0]).unwrap();
        let pins = [
            Pin {
                at: m.vertices[left],
                to: m.vertices[left],
            },
            Pin {
                at: m.vertices[right],
                to: [120.0, 90.0],
            },
        ];
        let bent = solve(&m, &pins, PuppetMode::Rigid);
        assert!(dist(bent[right], [120.0, 90.0]) < 1e-6);
        let stretch = |p: &[[f64; 2]]| -> f64 {
            m.edges()
                .iter()
                .map(|&(i, j, _)| {
                    let (i, j) = (i as usize, j as usize);
                    (dist(p[i], p[j]) / dist(m.vertices[i], m.vertices[j]) - 1.0).abs()
                })
                .sum::<f64>()
                / m.edges().len() as f64
        };
        assert!(
            stretch(&bent) < 0.08,
            "mean edge stretch {}",
            stretch(&bent)
        );
    }

    #[test]
    fn the_backward_field_maps_through_the_bent_mesh() {
        let m = square(40);
        let k = m.nearest([20.0, 20.0]).unwrap();
        let at = m.vertices[k];
        let bent = solve(
            &m,
            &[Pin {
                at,
                to: [at[0] + 5.0, at[1]],
            }],
            PuppetMode::Rigid,
        );
        let f = backward_field(&m, &bent, 40, 40);
        // A pure translation by +5: output pixel x reads source x − 5, and
        // the five leftmost columns read nothing.
        let (dx, dy) = f.displacement(20.0, 20.0).unwrap();
        assert!((dx + 5.0).abs() < 1e-4 && dy.abs() < 1e-4, "{dx}, {dy}");
        assert!(f.displacement(2.0, 20.0).is_none());
    }

    #[test]
    fn spacing_follows_the_density() {
        assert!(spacing_for(560, 300, 0) > spacing_for(560, 300, 1));
        assert!(spacing_for(560, 300, 1) > spacing_for(560, 300, 2));
        assert_eq!(PuppetMode::from_code(2), Some(PuppetMode::Distort));
        assert_eq!(PuppetMode::from_code(3), None);
    }
}
