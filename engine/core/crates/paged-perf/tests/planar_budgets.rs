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

//! WORK budgets of the planar arrangement (engine ADR 1019): Pathfinder
//! Divide over 100 overlapping shapes — the input Illustrator 30.1
//! divided into 1057 pieces (the `divide-many` oracle) — and the
//! refusals that keep a hopeless input from hanging the worker.
//!
//! The counts are the arrangement's own (`PlanarStats`): deterministic,
//! so they gate on any runner. A budget is the measured value when it
//! was written; lower it when an optimisation lands, never raise it to
//! make a change pass. Wall-clock is in `benches/planar.rs`.

use paged_mutate::planar::{
    build_arrangement, build_arrangement_with, PlanarError, PlanarLimits, PlanarStage,
};
use paged_perf::planar::divide;

#[test]
fn divide_over_100_shapes_stays_in_its_work_budget() {
    let inputs = divide(100);
    let mut stages = Vec::new();
    let arr = build_arrangement_with(&inputs, &PlanarLimits::default(), &mut |p| {
        stages.push(p.stage)
    })
    .expect("arrangement");
    assert!(arr.complete, "the faces tile the union");
    // Illustrator's answer for the same input is 1057 pieces, nine of
    // them its own slivers under 0.01 pt² (below the 1/64 pt grid); the
    // rest match one for one (`paged-mutate`'s `divide_many_oracle`).
    assert_eq!(arr.faces.len(), 1049);
    let s = arr.stats;
    eprintln!("divide(100): {s:?}");
    assert!(
        s.collision_pairs <= BUDGET_PAIRS,
        "collision pairs {}",
        s.collision_pairs
    );
    assert!(s.edges <= BUDGET_EDGES, "edges {}", s.edges);
    assert!(
        s.elementary_faces <= BUDGET_FACES,
        "elementary faces {}",
        s.elementary_faces
    );
    assert_eq!(
        s.signature_corrections, 0,
        "the edge toggles agree with the point tests"
    );
    // Progress was reported for every stage, in order.
    for stage in [PlanarStage::Collide, PlanarStage::Walk, PlanarStage::Faces] {
        assert!(stages.contains(&stage), "no progress for {stage:?}");
    }
}

#[test]
fn a_thousand_inputs_arrange_within_the_budget() {
    // A 40 × 25 lattice of overlapping squares: 1000 inputs, every one
    // crossing its neighbours.
    let corner = |x: f32, y: f32| paged_model::PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    let inputs: Vec<(Vec<paged_model::PathAnchor>, Vec<usize>)> = (0..1000)
        .map(|i| {
            let (x, y) = ((i % 40) as f32 * 15.0, (i / 40) as f32 * 15.0);
            (
                vec![
                    corner(x, y),
                    corner(x + 20.0, y),
                    corner(x + 20.0, y + 20.0),
                    corner(x, y + 20.0),
                ],
                vec![0],
            )
        })
        .collect();
    let arr = build_arrangement(&inputs).expect("1000 inputs arrange");
    assert!(arr.complete);
    eprintln!("lattice(1000): {} faces, {:?}", arr.faces.len(), arr.stats);
    assert!(arr.faces.len() > 1000);
}

#[test]
fn a_hopeless_input_is_refused_before_the_collision_pass() {
    // 600 near-identical circles: every curve's box overlaps every
    // other's, ~2.9 M pairs, past a 1 M budget — refused up front.
    let k = 0.552_284_8_f32;
    let inputs: Vec<(Vec<paged_model::PathAnchor>, Vec<usize>)> = (0..600)
        .map(|i| {
            let (cx, cy, r) = (300.0 + i as f32 * 0.25, 300.0, 200.0);
            let p = |x: f32, y: f32| (x, y);
            (
                vec![
                    paged_model::PathAnchor {
                        anchor: p(cx, cy - r),
                        left: p(cx - k * r, cy - r),
                        right: p(cx + k * r, cy - r),
                    },
                    paged_model::PathAnchor {
                        anchor: p(cx + r, cy),
                        left: p(cx + r, cy - k * r),
                        right: p(cx + r, cy + k * r),
                    },
                    paged_model::PathAnchor {
                        anchor: p(cx, cy + r),
                        left: p(cx + k * r, cy + r),
                        right: p(cx - k * r, cy + r),
                    },
                    paged_model::PathAnchor {
                        anchor: p(cx - r, cy),
                        left: p(cx - r, cy + k * r),
                        right: p(cx - r, cy - k * r),
                    },
                ],
                vec![0],
            )
        })
        .collect();
    let limits = PlanarLimits {
        max_collision_pairs: 1_000_000,
        ..PlanarLimits::default()
    };
    let started = std::time::Instant::now();
    let err = build_arrangement_with(&inputs, &limits, &mut |_| {}).unwrap_err();
    assert!(
        matches!(
            err,
            PlanarError::OverBudget {
                stage: PlanarStage::Collide,
                ..
            }
        ),
        "{err:?}"
    );
    assert!(err.to_string().contains("over its budget"), "{err}");
    // Refused by counting, not by trying: well under a second.
    assert!(started.elapsed().as_secs_f64() < 2.0);
}

// Measured 2026-10-25 (the eprintln above): budgets = measured.
const BUDGET_PAIRS: u64 = 2391;
const BUDGET_EDGES: usize = 2508;
const BUDGET_FACES: usize = 1061;
