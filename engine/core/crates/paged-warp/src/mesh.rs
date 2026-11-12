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

//! THE PUPPET MESH OF AN OUTLINE: a constrained Delaunay triangulation of
//! closed rings (the flattened contours of the selected paths), the mesh
//! the vector Puppet Warp bends through [`crate::puppet::solve`] — the
//! same solve that bends a raster layer's grid.
//!
//! 1. every ring is RESAMPLED so no edge is longer than `spacing`;
//! 2. Steiner points fill the inside on a staggered (hexagonal) lattice of
//!    the same spacing, at least half a spacing off the outline so no
//!    sliver triangles form against it;
//! 3. Bowyer–Watson builds the Delaunay triangulation of all the points
//!    inside a super-triangle (the predicates run on a deterministically
//!    jittered copy: resampled outlines and lattices are full of
//!    cocircular quadruples);
//! 4. every outline edge is made a mesh edge by Sloan's edge flips ("A
//!    fast algorithm for generating constrained Delaunay triangulations",
//!    1993). Two CROSSING constraints (two overlapping shapes) cannot both
//!    be recovered; the later is left and counted in `unrecovered`;
//! 5. the super-triangle's triangles and every triangle whose centroid is
//!    outside the rings (even-odd, so a hole stays a hole) are removed.
//!
//! Deterministic and free of randomness: the jitter and the lattice
//! stagger are hashes and fixed offsets.

use std::collections::HashMap;

use crate::puppet::PuppetMesh;

type P = [f64; 2];

/// A ring mesh: the triangles, and which vertices are the outline.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RingMesh {
    pub mesh: PuppetMesh,
    /// The resampled outline's vertex indices, per input ring.
    pub boundary: Vec<Vec<u32>>,
    /// Outline edges the flips could not insert (crossing constraints).
    pub unrecovered: u32,
}

/// The default vertex cap: the spacing grows until the mesh fits.
pub const MAX_VERTICES: usize = 600;

fn orient(a: P, b: P, c: P) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// The crossing-number test of one polygon.
pub fn point_in_polygon(p: P, poly: &[P]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if (yi > p[1]) != (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Even-odd over the rings: inside an odd number of them.
pub fn point_in_rings(p: P, rings: &[Vec<P>]) -> bool {
    rings
        .iter()
        .fold(false, |inside, r| inside ^ point_in_polygon(p, r))
}

fn segment_distance(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len_sq = dx * dx + dy * dy;
    if len_sq == 0.0 {
        return (p[0] - a[0]).hypot(p[1] - a[1]);
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len_sq).clamp(0.0, 1.0);
    (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy))
}

/// Resample a closed ring so no edge exceeds `spacing`; consecutive
/// duplicates dropped.
pub fn resample_ring(ring: &[P], spacing: f64) -> Vec<P> {
    let mut out: Vec<P> = Vec::new();
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        let l = (b[0] - a[0]).hypot(b[1] - a[1]);
        let k = (l / spacing).ceil().max(1.0) as usize;
        for s in 0..k {
            let t = s as f64 / k as f64;
            let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            if out
                .last()
                .is_none_or(|q| (p[0] - q[0]).hypot(p[1] - q[1]) > spacing * 1e-3)
            {
                out.push(p);
            }
        }
    }
    if out.len() > 1 {
        let (f, l) = (out[0], out[out.len() - 1]);
        if (f[0] - l[0]).hypot(f[1] - l[1]) <= spacing * 1e-3 {
            out.pop();
        }
    }
    out
}

/// An integer hash of `i` onto [−0.5, 0.5).
fn unit_hash(i: u32) -> f64 {
    let mut h = (i ^ 0x9e37_79b9).wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    f64::from(h) / 4_294_967_296.0 - 0.5
}

fn circumcircle_contains(a: P, b: P, c: P, p: P) -> bool {
    let (ax, ay) = (a[0] - p[0], a[1] - p[1]);
    let (bx, by) = (b[0] - p[0], b[1] - p[1]);
    let (cx, cy) = (c[0] - p[0], c[1] - p[1]);
    let det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay)
        + (cx * cx + cy * cy) * (ax * by - bx * ay);
    if orient(a, b, c) > 0.0 {
        det > 0.0
    } else {
        det < 0.0
    }
}

type Tri = [u32; 3];

/// Delaunay triangulation of `pts` (Bowyer–Watson); every triangle is
/// counter-clockwise (`orient > 0`).
pub fn delaunay(pts: &[P]) -> Vec<Tri> {
    let n = pts.len() as u32;
    delaunay_with_super(pts)
        .1
        .into_iter()
        .filter(|t| t.iter().all(|&v| v < n))
        .collect()
}

/// Bowyer–Watson keeping the super-triangle: the points are `pts` and then
/// its three corners, which the constraint flips may still need.
fn delaunay_with_super(pts: &[P]) -> (Vec<P>, Vec<Tri>) {
    let n = pts.len();
    if n < 3 {
        return (pts.to_vec(), Vec::new());
    }
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let size = (x1 - x0).max(y1 - y0).max(1.0);
    let d = size * 20.0;
    let (mx, my) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let supers = [[mx - d, my - d], [mx + d, my - d], [mx, my + d]];
    let jit = size * 1e-6;
    let mut all: Vec<P> = pts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let i = i as u32;
            [
                p[0] + unit_hash(i.wrapping_mul(2)) * jit,
                p[1] + unit_hash(i.wrapping_mul(2).wrapping_add(1)) * jit,
            ]
        })
        .collect();
    all.extend(supers);
    let s0 = n as u32;
    let mut tris: Vec<Tri> = if orient(all[n], all[n + 1], all[n + 2]) < 0.0 {
        vec![[s0, s0 + 2, s0 + 1]]
    } else {
        vec![[s0, s0 + 1, s0 + 2]]
    };
    for i in 0..n {
        let p = all[i];
        let mut bad: Vec<Tri> = Vec::new();
        let mut keep: Vec<Tri> = Vec::new();
        for t in tris {
            if circumcircle_contains(
                all[t[0] as usize],
                all[t[1] as usize],
                all[t[2] as usize],
                p,
            ) {
                bad.push(t);
            } else {
                keep.push(t);
            }
        }
        // The cavity's boundary: edges of bad triangles not shared by two
        // (in first-seen order, the last-seen direction).
        let mut order: Vec<(u32, u32)> = Vec::new();
        let mut seen: HashMap<(u32, u32), (u32, [u32; 2])> = HashMap::new();
        for t in &bad {
            for e in 0..3 {
                let (a, b) = (t[e], t[(e + 1) % 3]);
                let k = (a.min(b), a.max(b));
                let entry = seen.entry(k).or_insert_with(|| {
                    order.push(k);
                    (0, [a, b])
                });
                entry.0 += 1;
                entry.1 = [a, b];
            }
        }
        for k in order {
            let (count, [a, b]) = seen[&k];
            if count != 1 {
                continue;
            }
            let ii = i as u32;
            keep.push(if orient(all[a as usize], all[b as usize], p) < 0.0 {
                [b, a, ii]
            } else {
                [a, b, ii]
            });
        }
        tris = keep;
    }
    let mut original = pts.to_vec();
    original.extend(supers);
    (original, tris)
}

fn ekey(a: u32, b: u32) -> (u32, u32) {
    (a.min(b), a.max(b))
}

fn segments_cross(a: P, b: P, c: P, d: P) -> bool {
    orient(a, b, c) * orient(a, b, d) < 0.0 && orient(c, d, a) * orient(c, d, b) < 0.0
}

/// Make `(u, v)` an edge of `tris` by flipping the edges that cross it
/// (Sloan 1993). True when it is (or already was) an edge.
fn recover_edge(
    tris: &mut [Tri],
    pts: &[P],
    u: u32,
    v: u32,
    fixed: &std::collections::HashSet<(u32, u32)>,
) -> bool {
    let has = |tris: &[Tri]| tris.iter().any(|t| t.contains(&u) && t.contains(&v));
    if has(tris) {
        return true;
    }
    let (a, b) = (pts[u as usize], pts[v as usize]);
    for _ in 0..2000 {
        // Every edge with its triangles, in first-seen order.
        let mut order: Vec<(u32, u32)> = Vec::new();
        let mut owners: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
        for (ti, t) in tris.iter().enumerate() {
            for e in 0..3 {
                let k = ekey(t[e], t[(e + 1) % 3]);
                owners
                    .entry(k)
                    .or_insert_with(|| {
                        order.push(k);
                        Vec::new()
                    })
                    .push(ti);
            }
        }
        let mut flipped = false;
        let mut crossing = 0;
        for k in order {
            let list = &owners[&k];
            if list.len() != 2 || fixed.contains(&k) {
                continue;
            }
            let (p, q) = k;
            if p == u || p == v || q == u || q == v {
                continue;
            }
            if !segments_cross(a, b, pts[p as usize], pts[q as usize]) {
                continue;
            }
            crossing += 1;
            let (t1, t2) = (tris[list[0]], tris[list[1]]);
            let r = *t1.iter().find(|&&x| x != p && x != q).expect("a triangle");
            let s = *t2.iter().find(|&&x| x != p && x != q).expect("a triangle");
            // Flip only a strictly convex quad (p, r, q, s).
            if !segments_cross(
                pts[p as usize],
                pts[q as usize],
                pts[r as usize],
                pts[s as usize],
            ) {
                continue;
            }
            let ccw = |t: Tri, alt: Tri| {
                if orient(pts[t[0] as usize], pts[t[1] as usize], pts[t[2] as usize]) < 0.0 {
                    alt
                } else {
                    t
                }
            };
            tris[list[0]] = ccw([r, s, p], [s, r, p]);
            tris[list[1]] = ccw([s, r, q], [r, s, q]);
            flipped = true;
            break;
        }
        if has(tris) {
            return true;
        }
        if !flipped || crossing == 0 {
            return false;
        }
    }
    has(tris)
}

/// The constrained mesh of `rings` (closed polygons) at about `spacing`
/// per edge, the spacing grown by 35 % until at most `max_vertices` fit.
/// A ring of fewer than 3 points is ignored.
pub fn triangulate_rings(rings: &[Vec<P>], spacing: f64, max_vertices: usize) -> RingMesh {
    let mut spacing = spacing.max(1e-3);
    for _ in 0..12 {
        if let Some(m) = build_mesh(rings, spacing, max_vertices) {
            return m;
        }
        spacing *= 1.35;
    }
    build_mesh(rings, spacing, usize::MAX).unwrap_or_default()
}

fn build_mesh(rings: &[Vec<P>], spacing: f64, cap: usize) -> Option<RingMesh> {
    let valid: Vec<Vec<P>> = rings.iter().filter(|r| r.len() >= 3).cloned().collect();
    let resampled: Vec<Vec<P>> = valid.iter().map(|r| resample_ring(r, spacing)).collect();
    let mut vertices: Vec<P> = Vec::new();
    let mut boundary: Vec<Vec<u32>> = Vec::new();
    for ring in &resampled {
        if ring.len() < 3 {
            continue;
        }
        let ids = (0..ring.len())
            .map(|k| (vertices.len() + k) as u32)
            .collect();
        vertices.extend(ring.iter().copied());
        boundary.push(ids);
    }
    if vertices.len() > cap {
        return None;
    }
    if vertices.len() < 3 {
        return Some(RingMesh {
            mesh: PuppetMesh {
                vertices,
                triangles: Vec::new(),
            },
            boundary,
            unrecovered: 0,
        });
    }
    // The Steiner lattice.
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in &vertices {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let row_h = spacing * 0.866_025_4;
    let edges: Vec<(P, P)> = resampled
        .iter()
        .flat_map(|r| (0..r.len()).map(move |i| (r[i], r[(i + 1) % r.len()])))
        .collect();
    let mut row = 0u32;
    let mut y = y0 + row_h * 0.5 + spacing * 1e-3;
    while y < y1 {
        let off = if row % 2 == 1 { spacing * 0.5 } else { 0.0 };
        let mut x = x0 + off + spacing * 0.5 + spacing * 7e-4;
        while x < x1 {
            let p = [x, y];
            if point_in_rings(p, &valid)
                && !edges
                    .iter()
                    .any(|&(a, b)| segment_distance(p, a, b) < spacing * 0.5)
            {
                vertices.push(p);
                if vertices.len() > cap {
                    return None;
                }
            }
            x += spacing;
        }
        row += 1;
        y += row_h;
    }
    let (all, mut tris) = delaunay_with_super(&vertices);
    let mut fixed = std::collections::HashSet::new();
    let mut unrecovered = 0;
    for ids in &boundary {
        for i in 0..ids.len() {
            let (u, v) = (ids[i], ids[(i + 1) % ids.len()]);
            if recover_edge(&mut tris, &all, u, v, &fixed) {
                fixed.insert(ekey(u, v));
            } else {
                unrecovered += 1;
            }
        }
    }
    let n = vertices.len() as u32;
    let triangles: Vec<Tri> = tris
        .into_iter()
        .filter(|t| {
            if t.iter().any(|&v| v >= n) {
                return false;
            }
            let [a, b, c] = t.map(|k| vertices[k as usize]);
            if orient(a, b, c).abs() < spacing * spacing * 1e-6 {
                return false;
            }
            point_in_rings(
                [(a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0],
                &valid,
            )
        })
        .collect();
    // Drop the vertices no triangle uses, re-index in first-use order.
    let mut used = vec![u32::MAX; n as usize];
    let mut kept: Vec<P> = Vec::new();
    for t in &triangles {
        for &i in t {
            if used[i as usize] == u32::MAX {
                used[i as usize] = kept.len() as u32;
                kept.push(vertices[i as usize]);
            }
        }
    }
    Some(RingMesh {
        mesh: PuppetMesh {
            vertices: kept,
            triangles: triangles
                .iter()
                .map(|t| t.map(|k| used[k as usize]))
                .collect(),
        },
        boundary: boundary
            .iter()
            .map(|ids| {
                ids.iter()
                    .map(|&i| used[i as usize])
                    .filter(|&i| i != u32::MAX)
                    .collect()
            })
            .collect(),
        unrecovered,
    })
}

/// Barycentric coordinates of `p` in `(a, b, c)`.
pub fn barycentric(p: P, a: P, b: P, c: P) -> [f64; 3] {
    let d = orient(a, b, c);
    if d.abs() < 1e-12 {
        return [1.0, 0.0, 0.0];
    }
    let l1 = orient(p, b, c) / d;
    let l2 = orient(a, p, c) / d;
    [l1, l2, 1.0 - l1 - l2]
}

/// Where a point sits in a mesh: its triangle and barycentric weights.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Located {
    pub triangle: u32,
    pub weights: [f64; 3],
}

/// The triangle of `vertices`/`triangles` holding `p`, or — outside the
/// mesh (a handle can stick out of the outline) — the triangle with the
/// nearest centroid and the EXTRAPOLATED weights, so the point follows
/// that triangle's affine map. `None` for an empty mesh.
pub fn locate(vertices: &[P], triangles: &[Tri], p: P) -> Option<Located> {
    let mut best: Option<Located> = None;
    let mut best_score = f64::NEG_INFINITY;
    for (i, t) in triangles.iter().enumerate() {
        let [a, b, c] = t.map(|k| vertices[k as usize]);
        let w = barycentric(p, a, b, c);
        if w[0].min(w[1]).min(w[2]) >= -1e-9 {
            return Some(Located {
                triangle: i as u32,
                weights: w,
            });
        }
        let (cx, cy) = ((a[0] + b[0] + c[0]) / 3.0, (a[1] + b[1] + c[1]) / 3.0);
        let score = -(p[0] - cx).hypot(p[1] - cy);
        if score > best_score {
            best_score = score;
            best = Some(Located {
                triangle: i as u32,
                weights: w,
            });
        }
    }
    best
}

/// `located` (found in the rest mesh) mapped into the bent vertices.
pub fn map_located(triangles: &[Tri], bent: &[P], located: Located) -> P {
    let t = triangles[located.triangle as usize];
    let [a, b, c] = located.weights;
    let [p0, p1, p2] = t.map(|k| bent[k as usize]);
    [
        a * p0[0] + b * p1[0] + c * p2[0],
        a * p0[1] + b * p1[1] + c * p2[1],
    ]
}

/// Every vertex's neighbours along mesh edges, ascending.
pub fn neighbours(mesh: &PuppetMesh) -> Vec<Vec<u32>> {
    let mut nb: Vec<std::collections::BTreeSet<u32>> =
        vec![Default::default(); mesh.vertices.len()];
    for t in &mesh.triangles {
        for e in 0..3 {
            let (a, b) = (t[e], t[(e + 1) % 3]);
            nb[a as usize].insert(b);
            nb[b as usize].insert(a);
        }
    }
    nb.into_iter().map(|s| s.into_iter().collect()).collect()
}

/// The neighbour a turned pin also holds: its farthest one-ring vertex
/// (the longest lever, the best-conditioned angle).
pub fn anchor_neighbour(mesh: &PuppetMesh, nb: &[Vec<u32>], vertex: u32) -> Option<u32> {
    let p = mesh.vertices[vertex as usize];
    let mut best = None;
    let mut best_d = -1.0;
    for &q in &nb[vertex as usize] {
        let v = mesh.vertices[q as usize];
        let d = (v[0] - p[0]).hypot(v[1] - p[1]);
        if d > best_d {
            best_d = d;
            best = Some(q);
        }
    }
    best
}

/// Illustrator's AUTOMATIC pins: `count` vertices spread over the shape —
/// the vertex nearest the vertices' centroid first, then repeatedly the
/// vertex farthest from every pin so far (farthest-point sampling).
pub fn auto_pins(mesh: &PuppetMesh, count: usize) -> Vec<u32> {
    let v = &mesh.vertices;
    if v.is_empty() {
        return Vec::new();
    }
    let (mut cx, mut cy) = (0.0, 0.0);
    for p in v {
        cx += p[0];
        cy += p[1];
    }
    cx /= v.len() as f64;
    cy /= v.len() as f64;
    let mut first = 0usize;
    let mut first_d = f64::INFINITY;
    for (i, p) in v.iter().enumerate() {
        let d = (p[0] - cx).hypot(p[1] - cy);
        if d < first_d {
            first_d = d;
            first = i;
        }
    }
    let mut pins = vec![first as u32];
    let mut dmin: Vec<f64> = v
        .iter()
        .map(|p| (p[0] - v[first][0]).hypot(p[1] - v[first][1]))
        .collect();
    while pins.len() < count.min(v.len()) {
        let mut best = None;
        let mut best_d = -1.0;
        for (i, &d) in dmin.iter().enumerate() {
            if d > best_d {
                best_d = d;
                best = Some(i);
            }
        }
        let Some(b) = best.filter(|_| best_d > 0.0) else {
            break;
        };
        pins.push(b as u32);
        for (i, p) in v.iter().enumerate() {
            dmin[i] = dmin[i].min((p[0] - v[b][0]).hypot(p[1] - v[b][1]));
        }
    }
    pins
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<P> {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    fn area(m: &PuppetMesh) -> f64 {
        m.triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|k| m.vertices[k as usize]);
                orient(a, b, c).abs() / 2.0
            })
            .sum()
    }

    #[test]
    fn a_rectangle_is_filled_and_its_outline_kept() {
        let m = triangulate_rings(&[rect(0.0, 0.0, 100.0, 50.0)], 10.0, MAX_VERTICES);
        assert!(
            (area(&m.mesh) - 5000.0).abs() < 1e-6,
            "area {}",
            area(&m.mesh)
        );
        assert_eq!(m.unrecovered, 0);
        assert_eq!(m.boundary.len(), 1);
        assert!(m.boundary[0].len() >= 30);
        // Every triangle counter-clockwise (orient > 0).
        for t in &m.mesh.triangles {
            let [a, b, c] = t.map(|k| m.mesh.vertices[k as usize]);
            assert!(orient(a, b, c) > 0.0);
        }
        // Interior Steiner points exist.
        assert!(m.mesh.vertices.len() > m.boundary[0].len());
    }

    #[test]
    fn a_hole_stays_a_hole() {
        let rings = [rect(0.0, 0.0, 100.0, 100.0), rect(30.0, 30.0, 70.0, 70.0)];
        let m = triangulate_rings(&rings, 8.0, MAX_VERTICES);
        assert!((area(&m.mesh) - (10000.0 - 1600.0)).abs() < 1e-6);
        assert!(locate(&m.mesh.vertices, &m.mesh.triangles, [50.0, 50.0])
            .is_some_and(|l| l.weights.iter().any(|&w| w < -1e-6)));
    }

    #[test]
    fn a_concave_outline_keeps_its_notch() {
        // An L: the notch's corner edges must be mesh edges.
        let l = vec![
            [0.0, 0.0],
            [100.0, 0.0],
            [100.0, 40.0],
            [40.0, 40.0],
            [40.0, 100.0],
            [0.0, 100.0],
        ];
        let m = triangulate_rings(&[l], 9.0, MAX_VERTICES);
        assert_eq!(m.unrecovered, 0);
        assert!((area(&m.mesh) - (100.0 * 40.0 + 40.0 * 60.0)).abs() < 1e-6);
    }

    #[test]
    fn the_cap_coarsens_the_mesh() {
        let m = triangulate_rings(&[rect(0.0, 0.0, 300.0, 300.0)], 2.0, 200);
        assert!(m.mesh.vertices.len() <= 200);
        assert!(!m.mesh.triangles.is_empty());
    }

    #[test]
    fn locate_and_map_follow_the_affine_map() {
        let m = triangulate_rings(&[rect(0.0, 0.0, 60.0, 60.0)], 12.0, MAX_VERTICES);
        let moved: Vec<P> = m
            .mesh
            .vertices
            .iter()
            .map(|p| [p[0] * 2.0 + 5.0, p[1] - 3.0])
            .collect();
        for p in [[10.0, 20.0], [59.0, 1.0], [-10.0, 30.0]] {
            let loc = locate(&m.mesh.vertices, &m.mesh.triangles, p).unwrap();
            let q = map_located(&m.mesh.triangles, &moved, loc);
            assert!((q[0] - (p[0] * 2.0 + 5.0)).abs() < 1e-9 && (q[1] - (p[1] - 3.0)).abs() < 1e-9);
        }
    }

    #[test]
    fn delaunay_is_empty_below_three_points_and_deterministic() {
        assert!(delaunay(&[[0.0, 0.0], [1.0, 0.0]]).is_empty());
        // A 7 × 6 grid: a cocircular worst case the jitter resolves.
        let pts: Vec<P> = (0..42)
            .map(|i| [f64::from(i % 7) * 3.0, f64::from(i / 7) * 3.0])
            .collect();
        let a = delaunay(&pts);
        assert_eq!(a, delaunay(&pts));
        assert_eq!(a.len(), 2 * 6 * 5, "a grid's triangles");
        let m = PuppetMesh {
            vertices: pts.clone(),
            triangles: a.clone(),
        };
        assert!((area(&m) - 18.0 * 15.0).abs() < 1e-9);
        // No point inside another triangle's circumcircle (beyond rounding).
        for t in &a {
            let [p, q, r] = t.map(|k| pts[k as usize]);
            for (i, s) in pts.iter().enumerate() {
                if t.contains(&(i as u32)) {
                    continue;
                }
                let (ax, ay, bx, by, cx, cy) = (
                    p[0] - s[0],
                    p[1] - s[1],
                    q[0] - s[0],
                    q[1] - s[1],
                    r[0] - s[0],
                    r[1] - s[1],
                );
                let det = (ax * ax + ay * ay) * (bx * cy - cx * by)
                    - (bx * bx + by * by) * (ax * cy - cx * ay)
                    + (cx * cx + cy * cy) * (ax * by - bx * ay);
                assert!(det <= 1e-6, "{t:?} holds {i}");
            }
        }
    }

    #[test]
    fn auto_pins_spread_from_the_centre() {
        let m = triangulate_rings(&[rect(0.0, 0.0, 200.0, 20.0)], 10.0, MAX_VERTICES);
        let pins = auto_pins(&m.mesh, 3);
        assert_eq!(pins.len(), 3);
        let x = |k: u32| m.mesh.vertices[k as usize][0];
        assert!((x(pins[0]) - 100.0).abs() < 10.0);
        let (lo, hi) = (x(pins[1]).min(x(pins[2])), x(pins[1]).max(x(pins[2])));
        assert!(lo < 5.0 && hi > 195.0, "{lo} {hi}");
        assert!(auto_pins(&PuppetMesh::default(), 3).is_empty());
    }

    #[test]
    fn the_anchor_neighbour_is_the_farthest_one_ring_vertex() {
        let m = triangulate_rings(&[rect(0.0, 0.0, 50.0, 50.0)], 10.0, MAX_VERTICES);
        let nb = neighbours(&m.mesh);
        let q = anchor_neighbour(&m.mesh, &nb, 0).unwrap();
        assert!(nb[0].contains(&q));
    }
}
