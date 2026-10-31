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

//! The doubly-connected edge list behind [`crate::planar`] (engine ADR
//! 1019).
//!
//! `flo_curves`' [`GraphPath`] does the hard numerical part — it splits
//! every input curve at every crossing (`self_collide`, a bounding-box
//! sweep plus curve clipping) — but it exposes no cyclic order of the
//! edges around a vertex, so it cannot be face-walked. This module reads
//! the collided graph ONCE and builds what a face walk needs:
//!
//! 1. **Vertices.** The graph's points, with points closer than
//!    [`MERGE_EPS`] merged (a crossing found twice from two curves lands
//!    a hair apart) and zero-length edges dropped.
//! 2. **Edges.** Each a cubic between two vertices carrying the set of
//!    inputs it TOGGLES. Coincident edges (two inputs sharing an outline,
//!    or one input's two contours touching) collapse into one edge whose
//!    set is the symmetric difference of theirs; an edge that toggles
//!    nothing separates nothing and is dropped, and so are the dangling
//!    chains that leaves.
//! 3. **Half-edges with angular order.** Every vertex sorts its outgoing
//!    half-edges by the direction in which each curve first leaves a
//!    small circle around the vertex. Non-crossing curves leave any such
//!    circle in their true cyclic order, so the order is right for
//!    tangent curves too, where the tangent alone would tie.
//! 4. **Cycles.** `next(h)` is the outgoing half-edge clockwise-adjacent
//!    to `twin(h)`; following it walks every face with the face on the
//!    left. Bounded faces come out with positive signed area, and each
//!    connected component has exactly one negative cycle, its outer
//!    boundary.
//! 5. **Nesting.** A component that lies inside a bounded face of
//!    another becomes a hole of that face: the smallest bounded cycle
//!    containing one of its vertices.
//! 6. **Signatures.** Crossing an edge flips membership of exactly the
//!    inputs the edge toggles (even-odd, `flo_curves`' convention), so
//!    one breadth-first pass from the unbounded face (signature `{}`)
//!    labels every face. No ray casting, no booleans.
//!
//! Everything after the collision pass is O(E log E) (the vertex sorts),
//! plus the nesting test, which is linear in the bounded faces per
//! component.

use std::collections::{HashMap, VecDeque};

use flo_curves::bezier::path::{GraphPath, PathLabel};
use flo_curves::bezier::BezierCurve;
use flo_curves::{Coord2, Coordinate2D};

/// A point in f64.
pub(crate) type P = (f64, f64);

/// Points closer than this (pt) are one vertex. Well below the 1/64 pt
/// boolean grid every input sits on, and above the noise of a crossing
/// computed from two different curves.
pub(crate) const MERGE_EPS: f64 = 1.0 / 512.0;

/// Two edges between the same vertices whose curves stay this close
/// (pt) at their quarter points are one edge. The grid step: anything
/// thinner is a lens no face can be resolved in anyway.
const COINCIDENT_EPS: f64 = 2.0 / 64.0;

/// A vertex this close (pt) to an edge lies ON it: half the 1/64 pt grid.
const ON_EDGE_EPS: f64 = 1.0 / 128.0;

/// Maximum chord deviation (pt) of the flattened polylines the
/// containment tests run on.
const FLATTEN_DEVIATION: f64 = 0.002;

/// The unbounded face.
pub(crate) const UNBOUNDED: u32 = u32::MAX;

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Cubic {
    pub p0: P,
    pub c1: P,
    pub c2: P,
    pub p3: P,
}

impl Cubic {
    pub fn eval(&self, t: f64) -> P {
        let mt = 1.0 - t;
        let (b0, b1, b2, b3) = (mt * mt * mt, 3.0 * mt * mt * t, 3.0 * mt * t * t, t * t * t);
        (
            self.p0.0 * b0 + self.c1.0 * b1 + self.c2.0 * b2 + self.p3.0 * b3,
            self.p0.1 * b0 + self.c1.1 * b1 + self.c2.1 * b2 + self.p3.1 * b3,
        )
    }

    pub fn deriv(&self, t: f64) -> P {
        let mt = 1.0 - t;
        let (d0, d1, d2) = (3.0 * mt * mt, 6.0 * mt * t, 3.0 * t * t);
        (
            (self.c1.0 - self.p0.0) * d0
                + (self.c2.0 - self.c1.0) * d1
                + (self.p3.0 - self.c2.0) * d2,
            (self.c1.1 - self.p0.1) * d0
                + (self.c2.1 - self.c1.1) * d1
                + (self.p3.1 - self.c2.1) * d2,
        )
    }

    pub fn reversed(&self) -> Cubic {
        Cubic {
            p0: self.p3,
            c1: self.c2,
            c2: self.c1,
            p3: self.p0,
        }
    }

    /// `½ ∫ (x dy − y dx)` over the curve. The integrand is degree 5 in
    /// `t`, so 3-point Gauss–Legendre is EXACT; summed over a closed
    /// cycle it is the enclosed signed area.
    pub fn area_term(&self) -> f64 {
        const NODES: [f64; 3] = [
            0.5 - 0.5 * 0.774_596_669_241_483_4,
            0.5,
            0.5 + 0.5 * 0.774_596_669_241_483_4,
        ];
        const WEIGHTS: [f64; 3] = [5.0 / 18.0, 8.0 / 18.0, 5.0 / 18.0];
        let mut total = 0.0;
        for (t, w) in NODES.iter().zip(WEIGHTS.iter()) {
            let (x, y) = self.eval(*t);
            let (dx, dy) = self.deriv(*t);
            total += w * (x * dy - y * dx);
        }
        total / 2.0
    }

    /// The largest distance of a control point from the chord — how far
    /// the curve can stray from a straight line.
    fn bulge(&self) -> f64 {
        let (ax, ay) = self.p0;
        let (bx, by) = self.p3;
        let (dx, dy) = (bx - ax, by - ay);
        let len = (dx * dx + dy * dy).sqrt();
        let dist = |p: P| -> f64 {
            if len < 1e-12 {
                ((p.0 - ax).powi(2) + (p.1 - ay).powi(2)).sqrt()
            } else {
                ((dx * (ay - p.1) - (ax - p.0) * dy) / len).abs()
            }
        };
        dist(self.c1).max(dist(self.c2))
    }

    /// De Casteljau split at `t`.
    pub fn split(&self, t: f64) -> (Cubic, Cubic) {
        let lerp = |a: P, b: P| (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
        let (p01, p12, p23) = (
            lerp(self.p0, self.c1),
            lerp(self.c1, self.c2),
            lerp(self.c2, self.p3),
        );
        let (p012, p123) = (lerp(p01, p12), lerp(p12, p23));
        let m = lerp(p012, p123);
        (
            Cubic {
                p0: self.p0,
                c1: p01,
                c2: p012,
                p3: m,
            },
            Cubic {
                p0: m,
                c1: p123,
                c2: p23,
                p3: self.p3,
            },
        )
    }

    /// The curve as a polyline within [`FLATTEN_DEVIATION`], both ends
    /// included.
    pub fn flatten(&self) -> Vec<P> {
        let bulge = self.bulge();
        let n = if bulge < 1e-9 {
            1
        } else {
            ((bulge / FLATTEN_DEVIATION).sqrt().ceil() as usize).clamp(2, 512)
        };
        (0..=n).map(|i| self.eval(i as f64 / n as f64)).collect()
    }
}

fn dist(a: P, b: P) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Distance from `p` to a polyline.
fn dist_to_polyline(p: P, poly: &[P]) -> f64 {
    let mut best = f64::INFINITY;
    for w in poly.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len2 = dx * dx + dy * dy;
        let t = if len2 < 1e-24 {
            0.0
        } else {
            (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
        };
        best = best.min(dist(p, (a.0 + t * dx, a.1 + t * dy)));
    }
    if poly.len() == 1 {
        best = dist(p, poly[0]);
    }
    best
}

/// A horizontal or vertical straight edge of an input: `at` is its x
/// (vertical) or y (horizontal), `from..=to` its extent along the line.
#[derive(Debug, Clone, Copy)]
pub(crate) struct AxisLine {
    pub vertical: bool,
    pub at: f64,
    pub from: f64,
    pub to: f64,
}

/// One edge of the arrangement.
#[derive(Debug, Clone)]
pub(crate) struct Edge {
    /// Forward geometry, `v0` → `v1`.
    pub cubic: Cubic,
    pub v0: u32,
    pub v1: u32,
    /// Inputs whose membership flips across this edge (sorted, odd
    /// multiplicity only).
    pub toggles: Vec<u32>,
    /// `cubic` flattened, forward.
    pub flat: Vec<P>,
}

#[derive(Debug, Clone)]
pub(crate) struct Cycle {
    pub hes: Vec<u32>,
    pub area: f64,
    pub bbox: [f64; 4],
    pub component: u32,
}

/// An elementary bounded face: one positive cycle minus the outer
/// boundaries of the components nested directly inside it.
#[derive(Debug, Clone)]
pub(crate) struct Face {
    pub cycle: u32,
    pub holes: Vec<u32>,
    pub area: f64,
    pub signature: Vec<u32>,
}

/// Why the DCEL could not be built within its budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DcelError {
    TooManyEdges { edges: usize, cap: usize },
    TooManyFaces { faces: usize, cap: usize },
}

#[derive(Debug, Clone)]
pub(crate) struct Dcel {
    pub verts: Vec<P>,
    pub edges: Vec<Edge>,
    pub next: Vec<u32>,
    pub cycle_of: Vec<u32>,
    pub cycles: Vec<Cycle>,
    pub faces: Vec<Face>,
    /// Face per half-edge; [`UNBOUNDED`] for the outside.
    pub he_face: Vec<u32>,
    /// The outer cycles of the components not nested in any face.
    pub top_level: Vec<u32>,
    /// `false` when the walk met an inconsistency it had to route around
    /// (a half-edge whose cycle never closed).
    pub consistent: bool,
}

struct UnionFind(Vec<u32>);
impl UnionFind {
    fn new(n: usize) -> Self {
        UnionFind((0..n as u32).collect())
    }
    fn find(&mut self, mut x: u32) -> u32 {
        while self.0[x as usize] != x {
            let parent = self.0[x as usize];
            self.0[x as usize] = self.0[parent as usize];
            x = parent;
        }
        x
    }
    fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // Smaller index wins, so representatives are deterministic.
            if ra < rb {
                self.0[rb as usize] = ra;
            } else {
                self.0[ra as usize] = rb;
            }
        }
    }
}

fn toggle(set: &mut Vec<u32>, label: u32) {
    match set.binary_search(&label) {
        Ok(i) => {
            set.remove(i);
        }
        Err(i) => set.insert(i, label),
    }
}

fn xor(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = a.to_vec();
    for l in b {
        toggle(&mut out, *l);
    }
    out
}

impl Dcel {
    /// Half-edge `h`'s origin vertex.
    pub fn origin(&self, h: u32) -> u32 {
        let e = &self.edges[(h >> 1) as usize];
        if h & 1 == 0 {
            e.v0
        } else {
            e.v1
        }
    }

    /// Half-edge `h`'s geometry, oriented from its origin.
    pub fn cubic(&self, h: u32) -> Cubic {
        let c = self.edges[(h >> 1) as usize].cubic;
        if h & 1 == 0 {
            c
        } else {
            c.reversed()
        }
    }

    /// Half-edge `h` flattened, from its origin, both ends included.
    fn flat_iter(&self, h: u32) -> Box<dyn Iterator<Item = P> + '_> {
        let flat = &self.edges[(h >> 1) as usize].flat;
        if h & 1 == 0 {
            Box::new(flat.iter().copied())
        } else {
            Box::new(flat.iter().rev().copied())
        }
    }

    /// Build from a collided `GraphPath`. `max_edges` / `max_faces` are
    /// the budget: past either the build stops with a [`DcelError`]
    /// instead of carrying on.
    pub fn build(
        graph: &GraphPath<Coord2, PathLabel>,
        axis_lines: &[AxisLine],
        max_edges: usize,
        max_faces: usize,
    ) -> Result<Dcel, DcelError> {
        // --- 1. points and raw edges -------------------------------------
        let npoints = graph.num_points();
        let points: Vec<P> = (0..npoints)
            .map(|i| {
                let p = graph.point_position(i);
                (p.x(), p.y())
            })
            .collect();
        struct Raw {
            a: u32,
            b: u32,
            cubic: Cubic,
            label: u32,
        }
        let mut raw: Vec<Raw> = Vec::new();
        for edge in graph.all_edges() {
            let (c1, c2) = edge.control_points();
            let s = edge.start_point();
            let e = edge.end_point();
            let PathLabel(label) = edge.label();
            raw.push(Raw {
                a: edge.start_point_index() as u32,
                b: edge.end_point_index() as u32,
                cubic: Cubic {
                    p0: (s.x(), s.y()),
                    c1: (c1.x(), c1.y()),
                    c2: (c2.x(), c2.y()),
                    p3: (e.x(), e.y()),
                },
                label,
            });
        }
        if raw.len() > max_edges {
            return Err(DcelError::TooManyEdges {
                edges: raw.len(),
                cap: max_edges,
            });
        }

        // --- 2. merge near-coincident points ------------------------------
        let mut uf = UnionFind::new(npoints);
        {
            let cell = |p: P| -> (i64, i64) {
                (
                    (p.0 / MERGE_EPS).floor() as i64,
                    (p.1 / MERGE_EPS).floor() as i64,
                )
            };
            let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
            for (i, p) in points.iter().enumerate() {
                let (cx, cy) = cell(*p);
                for dx in -1..=1 {
                    for dy in -1..=1 {
                        if let Some(list) = grid.get(&(cx + dx, cy + dy)) {
                            for j in list {
                                if dist(points[*j as usize], *p) < MERGE_EPS {
                                    uf.union(i as u32, *j);
                                }
                            }
                        }
                    }
                }
                grid.entry((cx, cy)).or_default().push(i as u32);
            }
        }
        // Zero-length edges are collision artefacts: their ends are one
        // vertex.
        for r in &raw {
            let reach = dist(r.cubic.p0, r.cubic.c1)
                .max(dist(r.cubic.p0, r.cubic.c2))
                .max(dist(r.cubic.p0, r.cubic.p3));
            if reach < MERGE_EPS {
                uf.union(r.a, r.b);
            }
        }

        // Compact the vertex ids.
        let mut vid: Vec<u32> = vec![u32::MAX; npoints];
        let mut verts: Vec<P> = Vec::new();
        for i in 0..npoints {
            let root = uf.find(i as u32) as usize;
            if vid[root] == u32::MAX {
                vid[root] = verts.len() as u32;
                verts.push(points[root]);
            }
            vid[i] = vid[root];
        }

        // A crossing on an input's horizontal or vertical straight edge is
        // computed along the OTHER curve and lands a hair off the line
        // (200.00066 for 200); it lies on the line by construction, so it
        // is put back there — the coordinate the line has exactly.
        if !axis_lines.is_empty() {
            const SNAP: f64 = 1e-3;
            let key = |c: f64| (c * 64.0).round() as i64;
            let mut vertical: HashMap<i64, Vec<&AxisLine>> = HashMap::new();
            let mut horizontal: HashMap<i64, Vec<&AxisLine>> = HashMap::new();
            for l in axis_lines {
                if l.vertical {
                    vertical.entry(key(l.at)).or_default().push(l);
                } else {
                    horizontal.entry(key(l.at)).or_default().push(l);
                }
            }
            let fits = |l: &AxisLine, c: f64, along: f64| {
                (c - l.at).abs() < SNAP && along >= l.from - SNAP && along <= l.to + SNAP
            };
            for v in verts.iter_mut() {
                if let Some(ls) = vertical.get(&key(v.0)) {
                    if let Some(l) = ls.iter().find(|l| fits(l, v.0, v.1)) {
                        v.0 = l.at;
                    }
                }
                if let Some(ls) = horizontal.get(&key(v.1)) {
                    if let Some(l) = ls.iter().find(|l| fits(l, v.1, v.0)) {
                        v.1 = l.at;
                    }
                }
            }
        }

        // --- 3a. T-junctions -------------------------------------------
        // `flo_curves` works to the 1/64 pt grid: where an edge runs
        // within a grid step of another's vertex it may neither cross it
        // nor split there, leaving two edges that overlap with no shared
        // vertex — not a planar graph. Split every edge at each vertex
        // lying ON it (within half a grid step: a vertex a whole step away
        // is a neighbour, and splitting there would make the two edges
        // cross); the coincident pieces then collapse below.
        let mut pieces: Vec<(u32, u32, Cubic, u32)> = Vec::with_capacity(raw.len());
        {
            const CELL: f64 = 8.0;
            let key = |p: P| ((p.0 / CELL).floor() as i64, (p.1 / CELL).floor() as i64);
            let mut grid: HashMap<(i64, i64), Vec<u32>> = HashMap::new();
            for (i, p) in verts.iter().enumerate() {
                grid.entry(key(*p)).or_default().push(i as u32);
            }
            for r in &raw {
                let (a, b) = (vid[r.a as usize], vid[r.b as usize]);
                let mut cubic = r.cubic;
                cubic.p0 = verts[a as usize];
                cubic.p3 = verts[b as usize];
                let flat = cubic.flatten();
                let (mut x0, mut y0, mut x1, mut y1) = (
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                );
                for q in &flat {
                    x0 = x0.min(q.0);
                    y0 = y0.min(q.1);
                    x1 = x1.max(q.0);
                    y1 = y1.max(q.1);
                }
                let (k0, k1) = (
                    key((x0 - COINCIDENT_EPS, y0 - COINCIDENT_EPS)),
                    key((x1 + COINCIDENT_EPS, y1 + COINCIDENT_EPS)),
                );
                let mut splits: Vec<(f64, u32)> = Vec::new();
                if (k1.0 - k0.0 + 1) * (k1.1 - k0.1 + 1) <= 4096 {
                    for cx in k0.0..=k1.0 {
                        for cy in k0.1..=k1.1 {
                            let Some(list) = grid.get(&(cx, cy)) else {
                                continue;
                            };
                            for v in list {
                                if *v == a || *v == b {
                                    continue;
                                }
                                let p = verts[*v as usize];
                                if dist_to_polyline(p, &flat) >= ON_EDGE_EPS {
                                    continue;
                                }
                                let t = nearest_t(&cubic, p);
                                if t > 1e-6 && t < 1.0 - 1e-6 {
                                    splits.push((t, *v));
                                }
                            }
                        }
                    }
                }
                splits.sort_by(|x, y| x.0.total_cmp(&y.0));
                let mut rest = cubic;
                let mut from = a;
                let mut consumed = 0.0;
                for (t, v) in splits {
                    // Re-parametrise the split onto what is left.
                    let local = ((t - consumed) / (1.0 - consumed)).clamp(0.0, 1.0);
                    let (mut head, mut tail) = rest.split(local);
                    head.p3 = verts[v as usize];
                    tail.p0 = verts[v as usize];
                    pieces.push((from, v, head, r.label));
                    rest = tail;
                    from = v;
                    consumed = t;
                }
                pieces.push((from, b, rest, r.label));
            }
        }

        // --- 3b. edges, coincident ones collapsed -------------------------
        let mut edges: Vec<Edge> = Vec::new();
        let mut by_pair: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
        for (a, b, cubic, label) in pieces {
            let reach = dist(cubic.p0, cubic.c1)
                .max(dist(cubic.p0, cubic.c2))
                .max(dist(cubic.p0, cubic.p3));
            // A loop no wider than the grid is what `flo_curves` leaves
            // when it merges the ends of a grid-step edge (its accuracy is
            // the 1/64 pt grid): it encloses nothing.
            if a == b && reach < COINCIDENT_EPS {
                continue;
            }
            let key = (a.min(b), a.max(b));
            let list = by_pair.entry(key).or_default();
            let mut merged = false;
            for &k in list.iter() {
                let other = &edges[k];
                // GEOMETRIC coincidence, not parametric: two pieces of
                // one straight edge with collapsed handles trace the same
                // line at different speeds, so equal `t` lands on
                // different points. Each curve's quarter points must lie
                // on the other curve.
                let mine = cubic.flatten();
                let theirs = other.cubic.flatten();
                let on = |c: &Cubic, poly: &[P]| {
                    [0.25, 0.5, 0.75]
                        .iter()
                        .all(|t| dist_to_polyline(c.eval(*t), poly) < COINCIDENT_EPS)
                };
                if on(&cubic, &theirs) && on(&other.cubic, &mine) {
                    toggle(&mut edges[k].toggles, label);
                    merged = true;
                    break;
                }
            }
            if !merged {
                list.push(edges.len());
                edges.push(Edge {
                    cubic,
                    v0: a,
                    v1: b,
                    toggles: vec![label],
                    flat: Vec::new(),
                });
            }
        }
        // An edge that toggles nothing separates two regions of the same
        // signature: it is not a boundary.
        edges.retain(|e| !e.toggles.is_empty());

        // --- 4. prune dangling chains -------------------------------------
        let mut degree = vec![0usize; verts.len()];
        for e in &edges {
            degree[e.v0 as usize] += 1;
            degree[e.v1 as usize] += 1;
        }
        let mut alive = vec![true; edges.len()];
        let mut incident: Vec<Vec<usize>> = vec![Vec::new(); verts.len()];
        for (i, e) in edges.iter().enumerate() {
            incident[e.v0 as usize].push(i);
            if e.v1 != e.v0 {
                incident[e.v1 as usize].push(i);
            }
        }
        let mut queue: Vec<usize> = (0..verts.len()).filter(|v| degree[*v] == 1).collect();
        while let Some(v) = queue.pop() {
            if degree[v] != 1 {
                continue;
            }
            if let Some(&e) = incident[v].iter().find(|e| alive[**e]) {
                alive[e] = false;
                let other = if edges[e].v0 as usize == v {
                    edges[e].v1
                } else {
                    edges[e].v0
                } as usize;
                degree[v] -= 1;
                degree[other] -= 1;
                if degree[other] == 1 {
                    queue.push(other);
                }
            }
        }
        let mut keep = alive.iter();
        edges.retain(|_| *keep.next().unwrap_or(&false));
        for e in edges.iter_mut() {
            e.flat = e.cubic.flatten();
        }

        // --- 5. angular order at each vertex ------------------------------
        let nhe = edges.len() * 2;
        let mut out: Vec<Vec<u32>> = vec![Vec::new(); verts.len()];
        for (i, e) in edges.iter().enumerate() {
            out[e.v0 as usize].push((2 * i) as u32);
            out[e.v1 as usize].push((2 * i + 1) as u32);
        }
        let mut dcel = Dcel {
            verts,
            edges,
            next: vec![u32::MAX; nhe],
            cycle_of: vec![u32::MAX; nhe],
            cycles: Vec::new(),
            faces: Vec::new(),
            he_face: vec![UNBOUNDED; nhe],
            top_level: Vec::new(),
            consistent: true,
        };
        let mut pos_in_out = vec![0usize; nhe];
        for (v, list) in out.iter_mut().enumerate() {
            if list.is_empty() {
                continue;
            }
            let origin = dcel.verts[v];
            // The radius every incident curve is sure to leave: half the
            // smallest reach.
            let reach = |h: u32| -> f64 {
                dcel.flat_iter(h)
                    .map(|p| dist(p, origin))
                    .fold(0.0_f64, f64::max)
            };
            let r = list.iter().map(|h| reach(*h)).fold(f64::INFINITY, f64::min) * 0.5;
            let mut keyed: Vec<(f64, u32)> = list
                .iter()
                .map(|h| {
                    let c = dcel.cubic(*h);
                    let p = exit_point(&c, origin, r);
                    ((p.1 - origin.1).atan2(p.0 - origin.0), *h)
                })
                .collect();
            keyed.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
            *list = keyed.into_iter().map(|(_, h)| h).collect();
            for (i, h) in list.iter().enumerate() {
                pos_in_out[*h as usize] = i;
            }
        }

        // --- 6. next pointers and cycles ----------------------------------
        for h in 0..nhe as u32 {
            let twin = h ^ 1;
            let v = dcel.origin(twin) as usize;
            let list = &out[v];
            let i = pos_in_out[twin as usize];
            let deg = list.len();
            dcel.next[h as usize] = list[(i + deg - 1) % deg];
        }
        let mut comp = UnionFind::new(dcel.verts.len());
        for e in &dcel.edges {
            comp.union(e.v0, e.v1);
        }
        for start in 0..nhe as u32 {
            if dcel.cycle_of[start as usize] != u32::MAX {
                continue;
            }
            let id = dcel.cycles.len() as u32;
            let mut hes = Vec::new();
            let mut h = start;
            let mut closed = false;
            for _ in 0..=nhe {
                if dcel.cycle_of[h as usize] != u32::MAX {
                    closed = h == start;
                    break;
                }
                dcel.cycle_of[h as usize] = id;
                hes.push(h);
                h = dcel.next[h as usize];
            }
            if !closed {
                dcel.consistent = false;
            }
            let area: f64 = hes.iter().map(|h| dcel.cubic(*h).area_term()).sum();
            let mut bbox = [
                f64::INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
            ];
            for h in &hes {
                for p in dcel.flat_iter(*h) {
                    bbox[0] = bbox[0].min(p.0);
                    bbox[1] = bbox[1].min(p.1);
                    bbox[2] = bbox[2].max(p.0);
                    bbox[3] = bbox[3].max(p.1);
                }
            }
            let component = comp.find(dcel.origin(start));
            dcel.cycles.push(Cycle {
                hes,
                area,
                bbox,
                component,
            });
        }

        // --- 7. outer cycle per component; the rest are faces -------------
        let mut outer_of: HashMap<u32, u32> = HashMap::new();
        for (i, c) in dcel.cycles.iter().enumerate() {
            let entry = outer_of.entry(c.component).or_insert(i as u32);
            if c.area < dcel.cycles[*entry as usize].area {
                *entry = i as u32;
            }
        }
        let is_outer: Vec<bool> = (0..dcel.cycles.len())
            .map(|i| outer_of.get(&dcel.cycles[i].component) == Some(&(i as u32)))
            .collect();
        let mut face_of_cycle: Vec<u32> = vec![UNBOUNDED; dcel.cycles.len()];
        for (i, c) in dcel.cycles.iter().enumerate() {
            if is_outer[i] {
                continue;
            }
            face_of_cycle[i] = dcel.faces.len() as u32;
            dcel.faces.push(Face {
                cycle: i as u32,
                holes: Vec::new(),
                area: c.area,
                signature: Vec::new(),
            });
            if dcel.faces.len() > max_faces {
                return Err(DcelError::TooManyFaces {
                    faces: dcel.faces.len(),
                    cap: max_faces,
                });
            }
        }
        for (i, c) in dcel.cycles.iter().enumerate() {
            if !is_outer[i] {
                for h in &c.hes {
                    dcel.he_face[*h as usize] = face_of_cycle[i];
                }
            }
        }

        // --- 8. nesting ---------------------------------------------------
        // Faces by ascending area: the first one containing a component's
        // vertex is the innermost.
        let mut by_area: Vec<u32> = (0..dcel.faces.len() as u32).collect();
        by_area.sort_by(|a, b| {
            dcel.faces[*a as usize]
                .area
                .total_cmp(&dcel.faces[*b as usize].area)
                .then(a.cmp(b))
        });
        let mut outers: Vec<u32> = outer_of.values().copied().collect();
        outers.sort_unstable();
        for o in outers {
            let comp_id = dcel.cycles[o as usize].component;
            let probe = dcel.verts[dcel.origin(dcel.cycles[o as usize].hes[0]) as usize];
            let mut host = UNBOUNDED;
            for f in &by_area {
                let cyc = &dcel.cycles[dcel.faces[*f as usize].cycle as usize];
                if cyc.component == comp_id
                    || probe.0 < cyc.bbox[0]
                    || probe.0 > cyc.bbox[2]
                    || probe.1 < cyc.bbox[1]
                    || probe.1 > cyc.bbox[3]
                {
                    continue;
                }
                if dcel.winding(dcel.faces[*f as usize].cycle, probe) != 0 {
                    host = *f;
                    break;
                }
            }
            for h in &dcel.cycles[o as usize].hes {
                dcel.he_face[*h as usize] = host;
            }
            if host == UNBOUNDED {
                dcel.top_level.push(o);
            } else {
                let hole_area = dcel.cycles[o as usize].area.abs();
                let face = &mut dcel.faces[host as usize];
                face.holes.push(o);
                face.area -= hole_area;
            }
        }

        // --- 9. signatures by toggling across edges -----------------------
        let mut assigned = vec![false; dcel.faces.len()];
        let mut queue: VecDeque<u32> = VecDeque::new();
        queue.push_back(UNBOUNDED);
        while let Some(f) = queue.pop_front() {
            let (sig, cycles): (Vec<u32>, Vec<u32>) = if f == UNBOUNDED {
                (Vec::new(), dcel.top_level.clone())
            } else {
                let face = &dcel.faces[f as usize];
                let mut cycles = vec![face.cycle];
                cycles.extend(face.holes.iter().copied());
                (face.signature.clone(), cycles)
            };
            for c in cycles {
                for h in dcel.cycles[c as usize].hes.clone() {
                    let g = dcel.he_face[(h ^ 1) as usize];
                    if g == UNBOUNDED || assigned[g as usize] {
                        continue;
                    }
                    assigned[g as usize] = true;
                    dcel.faces[g as usize].signature =
                        xor(&sig, &dcel.edges[(h >> 1) as usize].toggles);
                    queue.push_back(g);
                }
            }
        }
        if assigned.iter().any(|a| !a) {
            dcel.consistent = false;
        }
        Ok(dcel)
    }

    /// Nonzero winding number of `cycle` around `p`, on the flattened
    /// geometry.
    pub fn winding(&self, cycle: u32, p: P) -> i32 {
        let mut w = 0;
        for h in &self.cycles[cycle as usize].hes {
            let mut prev: Option<P> = None;
            for q in self.flat_iter(*h) {
                if let Some(a) = prev {
                    w += crossing(a, q, p);
                }
                prev = Some(q);
            }
        }
        w
    }

    /// Is `p` inside elementary face `f` (inside its cycle, outside its
    /// holes)?
    pub fn face_contains(&self, f: u32, p: P) -> bool {
        let face = &self.faces[f as usize];
        if self.winding(face.cycle, p) == 0 {
            return false;
        }
        face.holes.iter().all(|h| self.winding(*h, p) == 0)
    }

    /// A point strictly inside elementary face `f`, or `None` for a
    /// face too thin to place one in. Steps off the longest edges along
    /// the inward (left) normal at shrinking distances.
    pub fn interior_point(&self, f: u32) -> Option<P> {
        let face = &self.faces[f as usize];
        let cyc = &self.cycles[face.cycle as usize];
        let diag = ((cyc.bbox[2] - cyc.bbox[0]).powi(2) + (cyc.bbox[3] - cyc.bbox[1]).powi(2))
            .sqrt()
            .max(1e-3);
        let mut candidates: Vec<(f64, u32)> = cyc
            .hes
            .iter()
            .map(|h| {
                let c = self.cubic(*h);
                (dist(c.p0, c.p3) + dist(c.p0, c.c1) + dist(c.c2, c.p3), *h)
            })
            .collect();
        candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        candidates.truncate(8);
        let mut scale = 0.05_f64;
        for _ in 0..10 {
            for (_, h) in &candidates {
                let c = self.cubic(*h);
                for t in [0.5, 0.25, 0.75] {
                    let m = c.eval(t);
                    let d = c.deriv(t);
                    let len = (d.0 * d.0 + d.1 * d.1).sqrt();
                    if !len.is_finite() || len < 1e-12 {
                        continue;
                    }
                    // The face is on the LEFT of its half-edges.
                    let n = (-d.1 / len, d.0 / len);
                    let eps = diag * scale;
                    let probe = (m.0 + n.0 * eps, m.1 + n.1 * eps);
                    if self.face_contains(f, probe) {
                        return Some(probe);
                    }
                }
            }
            scale /= 3.0;
        }
        None
    }

    /// The closed cycles bounding each GROUP of elementary faces, all
    /// groups in one pass. `group(f)` names the group of face `f` (and
    /// of the outside, [`UNBOUNDED`]); [`UNBOUNDED`] means "in no
    /// group". A boundary half-edge has its group on the left and a
    /// different one on the right; consecutive ones are chained by
    /// turning around the shared vertex past the half-edges interior to
    /// the group. Shared boundaries inside a group dissolve. Returns
    /// `(group, half-edges)` per cycle.
    pub fn boundary_walk(&self, group: &dyn Fn(u32) -> u32) -> Vec<(u32, Vec<u32>)> {
        let nhe = self.next.len();
        let g_of: Vec<u32> = (0..nhe).map(|h| group(self.he_face[h])).collect();
        let is_boundary = |h: u32| {
            let g = g_of[h as usize];
            g != UNBOUNDED && g != g_of[(h ^ 1) as usize]
        };
        let mut used = vec![false; nhe];
        let mut out = Vec::new();
        for start in 0..nhe as u32 {
            if used[start as usize] || !is_boundary(start) {
                continue;
            }
            let g = g_of[start as usize];
            let mut cycle = Vec::new();
            let mut h = start;
            for _ in 0..=nhe {
                if used[h as usize] {
                    break;
                }
                used[h as usize] = true;
                cycle.push(h);
                // `next(h)` leaves the end vertex inside the same face;
                // while the half-edge it lands on is interior to the
                // group, step across it into the neighbouring face.
                let mut c = self.next[h as usize];
                let mut guard = 0;
                while g_of[(c ^ 1) as usize] == g && guard <= nhe {
                    c = self.next[(c ^ 1) as usize];
                    guard += 1;
                }
                h = c;
            }
            out.push((g, cycle));
        }
        out
    }

    /// Signed area of a half-edge cycle.
    pub fn cycle_area(&self, hes: &[u32]) -> f64 {
        hes.iter().map(|h| self.cubic(*h).area_term()).sum()
    }

    /// Nonzero winding number of an arbitrary half-edge cycle around `p`.
    pub fn winding_of(&self, hes: &[u32], p: P) -> i32 {
        let mut w = 0;
        for h in hes {
            let mut prev: Option<P> = None;
            for q in self.flat_iter(*h) {
                if let Some(a) = prev {
                    w += crossing(a, q, p);
                }
                prev = Some(q);
            }
        }
        w
    }
}

/// The parameter of the point of `c` nearest to `p`: a coarse scan,
/// then a golden-section refinement around the best sample.
fn nearest_t(c: &Cubic, p: P) -> f64 {
    const STEPS: usize = 128;
    let mut best = (f64::INFINITY, 0.0);
    for i in 0..=STEPS {
        let t = i as f64 / STEPS as f64;
        let d = dist(c.eval(t), p);
        if d < best.0 {
            best = (d, t);
        }
    }
    let (mut lo, mut hi) = (
        (best.1 - 1.0 / STEPS as f64).max(0.0),
        (best.1 + 1.0 / STEPS as f64).min(1.0),
    );
    for _ in 0..60 {
        let m1 = lo + (hi - lo) / 3.0;
        let m2 = hi - (hi - lo) / 3.0;
        if dist(c.eval(m1), p) < dist(c.eval(m2), p) {
            hi = m2;
        } else {
            lo = m1;
        }
    }
    0.5 * (lo + hi)
}

/// Signed crossing of segment `a → b` with the rightward ray from `p`
/// (the winding-number increment).
fn crossing(a: P, b: P, p: P) -> i32 {
    let is_left = (b.0 - a.0) * (p.1 - a.1) - (p.0 - a.0) * (b.1 - a.1);
    if a.1 <= p.1 {
        if b.1 > p.1 && is_left > 0.0 {
            return 1;
        }
    } else if b.1 <= p.1 && is_left < 0.0 {
        return -1;
    }
    0
}

/// Where `c` (starting at `origin`) first leaves the circle of radius
/// `r` around it; the curve's end when it never does.
fn exit_point(c: &Cubic, origin: P, r: f64) -> P {
    const STEPS: usize = 64;
    let mut lo = 0.0;
    let mut found = None;
    for i in 1..=STEPS {
        let t = i as f64 / STEPS as f64;
        if dist(c.eval(t), origin) >= r {
            found = Some(t);
            break;
        }
        lo = t;
    }
    let Some(mut hi) = found else {
        return c.p3;
    };
    for _ in 0..40 {
        let mid = 0.5 * (lo + hi);
        if dist(c.eval(mid), origin) >= r {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    c.eval(hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_square_cycle_has_positive_area_term() {
        // (0,0) → (10,0) → (10,10) → (0,10): ½∮(x dy − y dx) = +100.
        let line = |a: P, b: P| Cubic {
            p0: a,
            c1: (a.0 + (b.0 - a.0) / 3.0, a.1 + (b.1 - a.1) / 3.0),
            c2: (a.0 + (b.0 - a.0) * 2.0 / 3.0, a.1 + (b.1 - a.1) * 2.0 / 3.0),
            p3: b,
        };
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let area: f64 = (0..4)
            .map(|i| line(pts[i], pts[(i + 1) % 4]).area_term())
            .sum();
        assert!((area - 100.0).abs() < 1e-9, "{area}");
    }

    #[test]
    fn crossing_counts_a_square_around_its_centre() {
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let w: i32 = (0..4)
            .map(|i| crossing(pts[i], pts[(i + 1) % 4], (5.0, 5.0)))
            .sum();
        assert_eq!(w.abs(), 1);
        let outside: i32 = (0..4)
            .map(|i| crossing(pts[i], pts[(i + 1) % 4], (15.0, 5.0)))
            .sum();
        assert_eq!(outside, 0);
    }
}
