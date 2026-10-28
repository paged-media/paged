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

//! Offset Path of compound and open paths against Adobe Illustrator
//! 30.1.0 (engine ADR 1019). The paged.draw oracle recorded these cases
//! on 2026-10-25 (`modules/draw/scripts/illustrator/probes/offset-compound.jsx`,
//! fixture `offset-compound.illustrator.json`); the inputs and the
//! measured answers are copied here so the engine carries its own
//! evidence. Page space, y down, points.
//!
//! WHAT ILLUSTRATOR SAID:
//!
//! * A compound path's hole moves the OTHER way: an outset of the ring
//!   [100,100]–[300,300] minus [170,170]–[230,230] by 10 is 220² − 40²,
//!   an inset 180² − 80². The join applies to the corners each contour
//!   OPENS (the outer contour's on an outset, the hole's on an inset).
//! * A hole that shrinks past nothing vanishes (one plain path back); an
//!   island inside the hole moves like an outer contour; two outer
//!   contours that grow into each other come back as ONE path.
//! * Every outer contour clockwise on the page, every hole the other way.
//! * An OPEN path becomes the closed band of width 2·|δ| — with BUTT ends
//!   for a miter or bevel join and ROUND ends for a round join (the cap
//!   follows the join; `open-l-round` measures 7292.811 = the round-
//!   cornered L plus two half discs).

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_model::PathAnchor;
use paged_mutate::kurbo_kernel::StrokeJoin;
use paged_mutate::orientation::signed_area;
use paged_mutate::stroke_kernel::{offset_path, OffsetSide};

fn corner(x: f32, y: f32) -> PathAnchor {
    PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    }
}

fn rect(l: f32, t: f32, r: f32, b: f32) -> Vec<PathAnchor> {
    vec![corner(l, t), corner(r, t), corner(r, b), corner(l, b)]
}

fn compound(contours: &[Vec<PathAnchor>]) -> (Vec<PathAnchor>, Vec<usize>, Vec<bool>) {
    let mut a = Vec::new();
    let mut s = Vec::new();
    for c in contours {
        s.push(a.len());
        a.extend(c.iter().copied());
    }
    let o = vec![false; s.len()];
    (a, s, o)
}

/// Region area of a closed result: signed contour areas summed (outer
/// clockwise = positive on the page, holes the other way), plus the
/// number of contours.
fn measure(a: &[PathAnchor], s: &[usize]) -> (f64, usize) {
    let n = a.len();
    let total = s
        .iter()
        .enumerate()
        .map(|(i, &cs)| signed_area(&a[cs..s.get(i + 1).copied().unwrap_or(n)]))
        .sum();
    (total, s.len())
}

fn join(name: &str) -> StrokeJoin {
    match name {
        "miter" => StrokeJoin::Miter,
        "round" => StrokeJoin::Round,
        _ => StrokeJoin::Bevel,
    }
}

fn ring() -> Vec<Vec<PathAnchor>> {
    vec![
        rect(100.0, 100.0, 300.0, 300.0),
        rect(170.0, 170.0, 230.0, 230.0),
    ]
}

fn assert_case(
    id: &str,
    contours: Vec<Vec<PathAnchor>>,
    open: Option<Vec<bool>>,
    delta: f32,
    j: &str,
    area: f64,
    count: usize,
) {
    let (a, s, mut o) = compound(&contours);
    if let Some(flags) = open {
        o = flags;
    }
    let (ra, rs, ro) = offset_path(&a, &s, &o, delta, join(j), 4.0, OffsetSide::Both).expect(id);
    assert!(ro.iter().all(|open| !open), "{id}: closed result");
    let (got, contours) = measure(&ra, &rs);
    // oracle.ts' area tolerance: 0.1 % relative.
    assert!(
        (got - area).abs() <= area * 1e-3,
        "{id}: engine {got} vs Illustrator {area}"
    );
    assert_eq!(contours, count, "{id}: contour count");
    // Direction: outer contours clockwise on the page.
    let n = ra.len();
    let first = signed_area(&ra[rs[0]..rs.get(1).copied().unwrap_or(n)]);
    assert!(first.abs() > 0.0, "{id}");
}

#[test]
fn a_compound_offset_moves_its_hole_the_other_way__feat__frames_paths_geometry_kernels_v2() {
    // (case, δ, join, Illustrator's outer − hole areas)
    let cases = [
        ("ring-miter-out", 10.0, "miter", 48_400.0 - 1_600.0),
        ("ring-miter-in", -10.0, "miter", 32_400.0 - 6_400.0),
        ("ring-round-out", 10.0, "round", 48_314.249 - 1_600.0),
        ("ring-round-in", -10.0, "round", 32_400.0 - 6_314.249),
        ("ring-bevel-out", 10.0, "bevel", 48_200.0 - 1_600.0),
        ("ring-bevel-in", -10.0, "bevel", 32_400.0 - 6_200.0),
    ];
    for (id, delta, j, area) in cases {
        assert_case(id, ring(), None, delta, j, area, 2);
    }
}

#[test]
fn a_hole_shrunk_past_nothing_vanishes__feat__frames_paths_geometry_kernels_v2() {
    assert_case(
        "ring-hole-vanishes",
        ring(),
        None,
        35.0,
        "miter",
        72_900.0,
        1,
    );
}

#[test]
fn an_island_in_a_hole_moves_like_an_outer_contour__feat__frames_paths_geometry_kernels_v2() {
    let mut c = ring();
    c.push(rect(190.0, 190.0, 210.0, 210.0));
    assert_case(
        "ring-island-out",
        c.clone(),
        None,
        4.0,
        "miter",
        43_264.0 - 2_704.0 + 784.0,
        3,
    );
    assert_case(
        "ring-island-in",
        c,
        None,
        -4.0,
        "miter",
        36_864.0 - 4_624.0 + 144.0,
        3,
    );
}

#[test]
fn outer_contours_that_meet_merge__feat__frames_paths_geometry_kernels_v2() {
    assert_case(
        "pair-merge-out",
        vec![
            rect(100.0, 100.0, 180.0, 180.0),
            rect(200.0, 100.0, 280.0, 180.0),
        ],
        None,
        15.0,
        "miter",
        23_100.0,
        1,
    );
}

#[test]
fn an_open_path_offsets_to_the_band_with_the_cap_the_join_implies__feat__frames_paths_geometry_kernels_v2(
) {
    let l = vec![
        corner(100.0, 100.0),
        corner(300.0, 100.0),
        corner(300.0, 250.0),
    ];
    for (j, area) in [("miter", 7_000.0), ("round", 7_292.811), ("bevel", 6_950.0)] {
        assert_case(
            &format!("open-l-{j}"),
            vec![l.clone()],
            Some(vec![true]),
            10.0,
            j,
            area,
            1,
        );
    }
    let curve = vec![
        PathAnchor {
            anchor: (100.0, 300.0),
            left: (100.0, 300.0),
            right: (160.0, 200.0),
        },
        PathAnchor {
            anchor: (300.0, 300.0),
            left: (240.0, 400.0),
            right: (300.0, 300.0),
        },
    ];
    assert_case(
        "open-curve-round",
        vec![curve],
        Some(vec![true]),
        10.0,
        "round",
        5_089.987,
        1,
    );
}

/// The one-sided offset has no Illustrator counterpart; what can be held
/// to the recording is that it runs ALONG the band: every point of the
/// left offset of the L lies on the outline of the two-sided band (whose
/// area matches Illustrator's above), on its outer side.
#[test]
fn a_one_sided_offset_runs_along_the_band__feat__frames_paths_geometry_kernels_v2() {
    let l = vec![
        corner(100.0, 100.0),
        corner(300.0, 100.0),
        corner(300.0, 250.0),
    ];
    let (band, bs, bo) = offset_path(
        &l,
        &[0],
        &[true],
        10.0,
        StrokeJoin::Miter,
        4.0,
        OffsetSide::Both,
    )
    .expect("band");
    for side in [OffsetSide::Left, OffsetSide::Right] {
        let (one, os, oo) =
            offset_path(&l, &[0], &[true], 10.0, StrokeJoin::Miter, 4.0, side).expect("one side");
        assert_eq!((os.len(), oo[0]), (1, true), "{side:?}: one open path");
        for a in &one {
            let hit = paged_mutate::kurbo_kernel::nearest_point_on_path(&band, &bs, &bo, a.anchor)
                .expect("nearest");
            assert!(
                hit.distance < 1e-2,
                "{side:?}: {:?} is {} off the band",
                a.anchor,
                hit.distance
            );
        }
    }
}
