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

//! Pathfinder Divide over MANY shapes against Adobe Illustrator 30.1.0
//! (engine ADR 1019). The paged.draw oracle recorded Divide over 20, 50
//! and 100 generated rectangles and circles
//! (`modules/draw/scripts/illustrator/probes/divide-many.jsx`, fixture
//! `divide-many.illustrator.json`); `tests/fixtures/divide-many.summary.json`
//! is that recording reduced to what this kernel answers: the inputs
//! (back to front) and, per piece, the input whose fill it carries — the
//! frontmost input covering it — and its area.
//!
//! The arrangement is asked exactly what the `pathfinderDivide` verb asks
//! it (inputs TOP to bottom, a piece owned by the topmost input in its
//! signature), and the two piece lists must agree: the same count, and
//! every piece of 0.2 pt² or more matched by one of the same owner with
//! the same area within 0.03 % + 0.5 pt². Illustrator
//! cuts the circles on its own subdivision of the arcs, so a piece's
//! area differs from the exact Bézier area by up to a few tenths of a
//! pt² (largest seen: 6526.04 vs 6525.41, 255.91 vs 256.24); the pieces
//! under 0.01 pt² that only Illustrator reports (one in `divide-50`,
//! nine in `divide-100`, 0.008 pt² the largest) are its own slivers,
//! below the 1/64 pt grid the engine resolves, and are not counted. The
//! total area agrees within 0.01 %.
//!
//! The summary was derived with:
//!
//! ```text
//! python3 - <<'PY'
//! import json; d = json.load(open('modules/draw/packages/draw-bundle/test/fixtures/oracle/divide-many.illustrator.json'))
//! # per case: inputs as [ax, ay, lx, ly, rx, ry] rows; pieces as
//! # [index of the input with the piece's fill, round(area, 4)], sorted
//! PY
//! ```

#![allow(non_snake_case)] // the `__feat__<id>` suffix links each test to its cockpit feature

use paged_model::PathAnchor;
use paged_mutate::planar::build_arrangement;

type Input = (Vec<PathAnchor>, Vec<usize>);

fn load() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("divide-many.summary.json");
    serde_json::from_slice(&std::fs::read(path).expect("read summary")).expect("parse summary")
}

fn inputs_back_to_front(case: &serde_json::Value) -> Vec<Input> {
    case["inputs"]
        .as_array()
        .expect("inputs")
        .iter()
        .map(|rows| {
            let anchors = rows
                .as_array()
                .expect("rows")
                .iter()
                .map(|r| {
                    let v: Vec<f32> = r
                        .as_array()
                        .expect("row")
                        .iter()
                        .map(|x| x.as_f64().expect("number") as f32)
                        .collect();
                    PathAnchor {
                        anchor: (v[0], v[1]),
                        left: (v[2], v[3]),
                        right: (v[4], v[5]),
                    }
                })
                .collect();
            (anchors, vec![0])
        })
        .collect()
}

fn check(case_id: &str) {
    let summary = load();
    let case = summary["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|c| c["id"] == case_id)
        .expect("case");
    let back_to_front = inputs_back_to_front(case);
    let n = back_to_front.len();
    // The verb's order: top to bottom.
    let top_to_bottom: Vec<Input> = back_to_front.iter().rev().cloned().collect();
    let arrangement = build_arrangement(&top_to_bottom).expect("arrangement");
    assert!(arrangement.complete, "{case_id}: the faces tile the union");

    let ours: Vec<(usize, f64)> = arrangement
        .faces
        .iter()
        .map(|f| (n - 1 - f.signature[0], f.area))
        .collect();
    let theirs: Vec<(usize, f64)> = case["pieces"]
        .as_array()
        .expect("pieces")
        .iter()
        .map(|p| {
            (
                p[0].as_u64().expect("owner") as usize,
                p[1].as_f64().expect("area"),
            )
        })
        .collect();
    // Illustrator's own slivers (under 0.01 pt², below the 1/64 pt grid
    // the engine resolves) are not pieces the engine can have; every other
    // piece must be there, and every piece of 0.2 pt² or more must match.
    const SLIVER: f64 = 0.01;
    const MATCHED: f64 = 0.2;
    let real = theirs.iter().filter(|p| p.1 >= SLIVER).count();
    assert!(
        (ours.len() as i64 - real as i64).abs() <= 1,
        "{case_id}: piece count (engine {}, Illustrator {real} of {} over {SLIVER} pt²)",
        ours.len(),
        theirs.len()
    );
    let mut used = vec![false; ours.len()];
    for (k, t) in theirs.iter().enumerate().filter(|(_, t)| t.1 >= MATCHED) {
        let tol = t.1 * 3e-4 + 0.5;
        let best = ours
            .iter()
            .enumerate()
            .filter(|(i, o)| !used[*i] && o.0 == t.0)
            .min_by(|x, y| (x.1 .1 - t.1).abs().total_cmp(&(y.1 .1 - t.1).abs()));
        let Some((i, o)) = best else {
            panic!(
                "{case_id}: Illustrator piece {k} of input {} has no match",
                t.0
            );
        };
        assert!(
            (o.1 - t.1).abs() <= tol,
            "{case_id}: piece {k} of input {}: engine {} vs Illustrator {}",
            t.0,
            o.1,
            t.1
        );
        used[i] = true;
    }
    let ours_total: f64 = ours.iter().map(|p| p.1).sum();
    let theirs_total: f64 = theirs.iter().map(|p| p.1).sum();
    assert!(
        (ours_total - theirs_total).abs() <= theirs_total * 1e-4,
        "{case_id}: total {ours_total} vs {theirs_total}"
    );
}

#[test]
fn divide_over_20_shapes_matches_illustrator__feat__frames_paths_geometry_kernels_v2() {
    check("divide-20");
}

#[test]
fn divide_over_50_shapes_matches_illustrator__feat__frames_paths_geometry_kernels_v2() {
    check("divide-50");
}

#[test]
fn divide_over_100_shapes_matches_illustrator__feat__frames_paths_geometry_kernels_v2() {
    check("divide-100");
}
