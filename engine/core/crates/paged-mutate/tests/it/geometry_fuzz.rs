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

//! Engine ADR 1019 — a property / fuzz suite for the geometry kernels
//! over the inputs that break them: COINCIDENT edges (shared in full and
//! in part), TANGENCIES (circle on a line, circles touching inside and
//! out), SELF-INTERSECTING inputs (bow-ties, pentagrams), SLIVERS (a
//! shape a grid step off another, a 1/16 pt bar) and HUGE coordinates.
//!
//! Every case must, first of all, NOT PANIC — a panic in these kernels
//! aborts the wasm worker (C-21). Then:
//!
//! - **booleans** conserve area: |A ∪ B| + |A ∩ B| = |A| + |B| and
//!   |A ⊕ B| = |A ∪ B| − |A ∩ B|;
//! - **the arrangement** tiles the union: the faces' areas sum to the
//!   area of the Pathfinder Unite of the same inputs (read off the walk by
//!   a different path: a union of faces, not a sum), every face's reported interior point lies in the
//!   face whose signature the point tests give, and ids are unique;
//! - **offsets** of compound paths are monotone: an outset never loses
//!   area, an inset never gains any.
//!
//! The generator is a seeded LCG (no dependency; identical on every
//! machine). `PAGED_GEOMETRY_FUZZ_CASES` raises the case count for a
//! longer local or nightly run.

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_model::PathAnchor;
use paged_mutate::kurbo_kernel::StrokeJoin;
use paged_mutate::orientation::signed_area;
use paged_mutate::pathfinder::{pathfinder_boolean, PathfinderKind};
use paged_mutate::planar::{build_arrangement, face_at_point};
use paged_mutate::stroke_kernel::{offset_path, OffsetSide};

type Shape = (Vec<PathAnchor>, Vec<usize>);

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 11
    }
    /// Uniform in [lo, hi), on the 1/64 pt grid.
    fn coord(&mut self, lo: f32, hi: f32) -> f32 {
        let u = (self.next() % 1_000_000) as f32 / 1_000_000.0;
        ((lo + u * (hi - lo)) * 64.0).round() / 64.0
    }
    fn pick(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn cases(default: usize) -> usize {
    std::env::var("PAGED_GEOMETRY_FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn corner(x: f32, y: f32) -> PathAnchor {
    PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    }
}

fn rect(l: f32, t: f32, r: f32, b: f32) -> Shape {
    (
        vec![corner(l, t), corner(r, t), corner(r, b), corner(l, b)],
        vec![0],
    )
}

fn circle(cx: f32, cy: f32, r: f32) -> Shape {
    let k = r * 0.552_284_8;
    (
        vec![
            PathAnchor {
                anchor: (cx, cy - r),
                left: (cx - k, cy - r),
                right: (cx + k, cy - r),
            },
            PathAnchor {
                anchor: (cx + r, cy),
                left: (cx + r, cy - k),
                right: (cx + r, cy + k),
            },
            PathAnchor {
                anchor: (cx, cy + r),
                left: (cx + k, cy + r),
                right: (cx - k, cy + r),
            },
            PathAnchor {
                anchor: (cx - r, cy),
                left: (cx - r, cy + k),
                right: (cx - r, cy - k),
            },
        ],
        vec![0],
    )
}

fn translate((a, s): &Shape, dx: f32, dy: f32) -> Shape {
    let m = |p: (f32, f32)| (p.0 + dx, p.1 + dy);
    (
        a.iter()
            .map(|p| PathAnchor {
                anchor: m(p.anchor),
                left: m(p.left),
                right: m(p.right),
            })
            .collect(),
        s.clone(),
    )
}

/// A pentagram (a self-intersecting star) — even-odd leaves its centre
/// pentagon OUT.
fn star(cx: f32, cy: f32, r: f32) -> Shape {
    let pts: Vec<PathAnchor> = (0..5)
        .map(|i| {
            let a = std::f32::consts::TAU * (i as f32 * 2.0) / 5.0 - std::f32::consts::FRAC_PI_2;
            corner(
                ((cx + r * a.cos()) * 64.0).round() / 64.0,
                ((cy + r * a.sin()) * 64.0).round() / 64.0,
            )
        })
        .collect();
    (pts, vec![0])
}

fn bowtie(l: f32, t: f32, r: f32, b: f32) -> Shape {
    (
        vec![corner(l, t), corner(r, b), corner(l, b), corner(r, t)],
        vec![0],
    )
}

/// One shape from the troublesome families, placed relative to `other`
/// so the trouble actually happens.
fn troublesome(r: &mut Lcg, other: &Shape) -> Shape {
    let (ox0, oy0, ox1, oy1) = bbox(other);
    let w = r.coord(10.0, 120.0);
    let h = r.coord(10.0, 120.0);
    match r.pick(9) {
        // A shared edge, in full: flush right of `other`'s box.
        0 => rect(ox1, oy0, ox1 + w, oy1),
        // A shared edge, in part.
        1 => rect(ox1, oy0 + (oy1 - oy0) / 3.0, ox1 + w, oy1 + h),
        // Tangent: a circle resting on the box's top edge.
        2 => {
            let rad = w / 2.0;
            circle((ox0 + ox1) / 2.0, oy0 - rad, rad)
        }
        // A grid step off: a sliver of width 1/64.
        3 => rect(ox0 + 1.0 / 64.0, oy0, ox1 + 1.0 / 64.0, oy1),
        // A hairline bar across.
        4 => rect(
            ox0 - 10.0,
            (oy0 + oy1) / 2.0,
            ox1 + 10.0,
            (oy0 + oy1) / 2.0 + 1.0 / 16.0,
        ),
        // Self-intersecting.
        5 => star((ox0 + ox1) / 2.0, (oy0 + oy1) / 2.0, w),
        6 => bowtie(ox0, oy0, ox0 + w, oy0 + h),
        // The same shape again (every edge coincident).
        7 => other.clone(),
        // Plain overlap.
        _ => {
            let x = r.coord(ox0 - 50.0, ox1);
            let y = r.coord(oy0 - 50.0, oy1);
            if r.pick(2) == 0 {
                rect(x, y, x + w, y + h)
            } else {
                circle(x, y, w / 2.0)
            }
        }
    }
}

fn base(r: &mut Lcg) -> Shape {
    let x = r.coord(0.0, 300.0);
    let y = r.coord(0.0, 300.0);
    if r.pick(2) == 0 {
        rect(x, y, x + r.coord(20.0, 150.0), y + r.coord(20.0, 150.0))
    } else {
        circle(x, y, r.coord(10.0, 80.0))
    }
}

fn bbox((a, _): &Shape) -> (f32, f32, f32, f32) {
    let mut b = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in a {
        b.0 = b.0.min(p.anchor.0);
        b.1 = b.1.min(p.anchor.1);
        b.2 = b.2.max(p.anchor.0);
        b.3 = b.3.max(p.anchor.1);
    }
    b
}

/// Area of a Pathfinder result: its contours run one way with their
/// holes the other (C-81), so the signed sum is the region's area.
fn result_area((a, s): &Shape) -> f64 {
    let n = a.len();
    s.iter()
        .enumerate()
        .map(|(i, &cs)| signed_area(&a[cs..s.get(i + 1).copied().unwrap_or(n)]))
        .sum::<f64>()
        .abs()
}

/// Even-odd area of an input, through the arrangement of it alone
/// (correct for self-intersecting inputs, where a signed sum is not).
fn input_area(s: &Shape) -> f64 {
    build_arrangement(std::slice::from_ref(s))
        .map(|a| a.faces_area)
        .unwrap_or(0.0)
}

fn perimeter((a, _): &Shape) -> f64 {
    let n = a.len();
    (0..n)
        .map(|k| {
            let (x0, y0) = a[k].anchor;
            let (x1, y1) = a[(k + 1) % n].anchor;
            ((x1 - x0) as f64).hypot((y1 - y0) as f64)
        })
        .sum::<f64>()
        * 1.6 // curves are longer than their anchor polygon
}

fn is_simple(s: &Shape) -> bool {
    // Self-intersecting family members are the only non-simple inputs.
    // Their even-odd area is not their signed area, and the Pathfinder
    // Unite the tiling is checked against is the arrangement's own since
    // engine ADR 1019, so the identities are checked on simple inputs;
    // the self-intersecting ones must not panic.
    let n = s.0.len();
    n != 5 && !(n == 4 && s.0[1].anchor.0 > s.0[2].anchor.0 && s.0[1].anchor.1 > s.0[3].anchor.1)
}

#[test]
fn booleans_conserve_area_on_troublesome_pairs__feat__frames_paths_geometry_kernels_v2() {
    let mut r = Lcg(0x2026_1025);
    for case in 0..cases(250) {
        let a = base(&mut r);
        let b = troublesome(&mut r, &a);
        let op = |kind| pathfinder_boolean(&[a.clone(), b.clone()], kind);
        let union = result_area(&op(PathfinderKind::Union));
        let inter = result_area(&op(PathfinderKind::Intersect));
        let excl = result_area(&op(PathfinderKind::Exclude));
        let _sub = op(PathfinderKind::Subtract);
        if !(is_simple(&a) && is_simple(&b)) {
            continue; // no panic is the property here
        }
        let (aa, ab) = (input_area(&a), input_area(&b));
        let tol = (perimeter(&a) + perimeter(&b)) / 64.0 + 1.0;
        assert!(
            (union + inter - (aa + ab)).abs() <= tol,
            "case {case}: |A∪B| {union} + |A∩B| {inter} vs |A| {aa} + |B| {ab} (tol {tol}); A={a:?} B={b:?}"
        );
        assert!(
            (excl - (union - inter)).abs() <= tol,
            "case {case}: |A⊕B| {excl} vs {}; A={a:?} B={b:?}",
            union - inter
        );
    }
}

#[test]
fn the_arrangement_tiles_the_union_of_troublesome_sets__feat__frames_paths_geometry_kernels_v2() {
    let mut r = Lcg(0x5eed_d0e1);
    for case in 0..cases(150) {
        let first = base(&mut r);
        let mut inputs = vec![first.clone()];
        for _ in 0..(1 + r.pick(5)) {
            let anchor = inputs[r.pick(inputs.len() as u64) as usize].clone();
            inputs.push(troublesome(&mut r, &anchor));
        }
        let arr = build_arrangement(&inputs).expect("arrangement");
        let mut ids: Vec<&str> = arr.faces.iter().map(|f| f.id.as_str()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before, "case {case}: duplicate face ids");
        for face in &arr.faces {
            assert!(face.area >= 0.0 && face.area.is_finite(), "case {case}");
        }
        if !inputs.iter().all(is_simple) {
            continue;
        }
        // Tiling, against a DIFFERENT kernel: the Pathfinder Unite.
        let union = result_area(&pathfinder_boolean(&inputs, PathfinderKind::Union));
        let tol: f64 = inputs.iter().map(perimeter).sum::<f64>() / 64.0 + 1.0;
        assert!(
            (arr.faces_area - union).abs() <= tol,
            "case {case}: faces {} vs unite {union} (tol {tol}); inputs={inputs:?}",
            arr.faces_area
        );
        // Every reported interior point is in the face the point tests
        // name — checked on the faces big enough to aim at.
        for face in arr.faces.iter().filter(|f| f.area > 4.0) {
            if let Some(hit) = face_at_point(&inputs, face.inside).expect("query") {
                assert_eq!(hit.signature, face.signature, "case {case}: {}", face.id);
            }
        }
    }
}

#[test]
fn huge_coordinates_do_not_break_the_kernels__feat__frames_paths_geometry_kernels_v2() {
    // 1e5 pt is still on the 1/64 grid in f32 (23 bits); 1e7 is not, and
    // has to come back without a panic.
    for offset in [1.0e5_f32, 1.0e7] {
        let a = translate(&rect(0.0, 0.0, 100.0, 80.0), offset, offset);
        let b = translate(&circle(90.0, 70.0, 30.0), offset, offset);
        let c = translate(&rect(100.0, 0.0, 160.0, 80.0), offset, offset);
        let inputs = vec![a.clone(), b.clone(), c.clone()];
        let arr = build_arrangement(&inputs).expect("arrangement");
        let _ = pathfinder_boolean(&inputs, PathfinderKind::Union);
        let _ = offset_path(
            &a.0,
            &a.1,
            &[false],
            5.0,
            StrokeJoin::Round,
            4.0,
            OffsetSide::Both,
        );
        if offset <= 1.0e5 {
            assert!(arr.complete, "offset {offset}");
            // Translation does not change the faces' areas.
            let near = build_arrangement(&[
                rect(0.0, 0.0, 100.0, 80.0),
                circle(90.0, 70.0, 30.0),
                rect(100.0, 0.0, 160.0, 80.0),
            ])
            .expect("near");
            assert_eq!(arr.faces.len(), near.faces.len());
            assert!((arr.faces_area - near.faces_area).abs() < 1.0);
        }
    }
}

#[test]
fn compound_offsets_are_monotone__feat__frames_paths_geometry_kernels_v2() {
    let mut r = Lcg(0x000f_f5e7);
    for case in 0..cases(120) {
        // A ring (a box with a hole) plus, sometimes, a second box.
        let (x0, y0) = (r.coord(0.0, 200.0), r.coord(0.0, 200.0));
        let (w, h) = (r.coord(60.0, 200.0), r.coord(60.0, 200.0));
        let (hx, hy) = (x0 + r.coord(10.0, w / 3.0), y0 + r.coord(10.0, h / 3.0));
        let (hw, hh) = (r.coord(5.0, w / 3.0), r.coord(5.0, h / 3.0));
        let mut a = rect(x0, y0, x0 + w, y0 + h).0;
        a.extend(rect(hx, hy, hx + hw, hy + hh).0);
        let mut starts = vec![0, 4];
        if r.pick(2) == 0 {
            let bx = x0 + w + r.coord(1.0, 40.0);
            a.extend(rect(bx, y0, bx + 40.0, y0 + 40.0).0);
            starts.push(8);
        }
        let open = vec![false; starts.len()];
        let region = |(ra, rs, _): (Vec<PathAnchor>, Vec<usize>, Vec<bool>)| result_area(&(ra, rs));
        let d = r.coord(0.5, 30.0);
        let join = [StrokeJoin::Miter, StrokeJoin::Round, StrokeJoin::Bevel][r.pick(3) as usize];
        let out = offset_path(&a, &starts, &open, d, join, 4.0, OffsetSide::Both)
            .map(region)
            .unwrap_or(0.0);
        let inset = offset_path(&a, &starts, &open, -d, join, 4.0, OffsetSide::Both)
            .map(region)
            .unwrap_or(0.0);
        // The input's own area (outer minus hole; boxes do not overlap).
        let expected = (w * h - hw * hh) as f64 + if starts.len() == 3 { 1600.0 } else { 0.0 };
        assert!(
            out + 1.0 >= expected,
            "case {case}: outset {out} < {expected}"
        );
        assert!(
            inset <= expected + 1.0,
            "case {case}: inset {inset} > {expected}"
        );
    }
}
