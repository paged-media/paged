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

//! The TypeScript twins held to this crate. The editor's Width tool and
//! Envelope Mesh tool draw their live previews in TypeScript
//! (`@paged-media/vector-geometry`'s `widthFactorAt`,
//! `normalizeWidthPoints` and `envelopePoint`): a pointer move cannot wait
//! for an engine round trip. What they compute is this crate's (and
//! `paged-model`'s) width profile and envelope map, so the numbers are
//! pinned here and in `platform/shared/vector-geometry/test/vector-fx-parity.spec.ts`,
//! both reading `fixtures/ts_twins.json`.
//!
//! The arc-length walk is the third twin: `vector-geometry`'s `along-path`
//! (`measureAnchorRun`, `pointAtFraction`), which the Width tool's preview
//! and draw's Blend and Objects on Path recipes compute with, is held
//! to `paged_geom::trim`'s exact arc length (`run_length`, `point_along`),
//! the measure the engine's line ends are cut with. The twin flattens each
//! segment into 24 chords, so the spec compares to a tolerance of 2e-3 of
//! the run's length.
//!
//! `PAGED_WRITE_TS_TWINS=1 cargo test -p paged-vector-fx --test it ts_twins`
//! writes the fixture from this crate; without it the test fails when the
//! fixture and the crate disagree.

use paged_geom::trim::{point_along, run_length};
use paged_model::vector_effect::{WidthPoint, WidthProfileParams};
use paged_model::PathAnchor;
use paged_vector_fx::envelope::envelope_point;
use serde_json::{json, Value};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/it/fixtures/ts_twins.json"
);

fn profile(points: &[(f32, f32)]) -> WidthProfileParams {
    WidthProfileParams {
        points: points
            .iter()
            .map(|&(t, width)| WidthPoint { t, width })
            .collect(),
    }
}

/// The profile library (`WIDTH_PROFILE_PRESETS`) and two hand-made ones.
fn profiles() -> Vec<(&'static str, Vec<(f32, f32)>)> {
    vec![
        ("uniform", vec![]),
        ("lens", vec![(0.0, 0.0), (0.5, 1.0), (1.0, 0.0)]),
        ("taperEnd", vec![(0.0, 1.0), (1.0, 0.0)]),
        ("bulge", vec![(0.0, 0.5), (0.5, 1.5), (1.0, 0.5)]),
        ("pinch", vec![(0.0, 1.0), (0.5, 0.2), (1.0, 1.0)]),
        ("teardrop", vec![(0.0, 0.0), (0.25, 1.0), (1.0, 0.0)]),
        (
            "inner",
            vec![(0.125, 2.0), (0.375, 0.25), (0.625, 3.5), (0.875, 1.0)],
        ),
        (
            "coincident",
            vec![(0.25, 1.0), (0.5, 2.0), (0.5, 0.5), (0.75, 1.0)],
        ),
    ]
}

/// Unnormalised point lists (out of range, out of order).
fn raw_lists() -> Vec<Vec<(f32, f32)>> {
    vec![
        vec![(0.75, 2.0), (-0.5, 1.0), (0.25, 150.0)],
        vec![(1.5, -3.0), (0.5, 0.5)],
        vec![],
    ]
}

/// A `rows` × `columns` net over the unit square, each control point moved
/// by a deterministic amount (multiples of 1/64, exact in `f32`).
fn net(rows: u32, columns: u32) -> Vec<[f32; 2]> {
    let (nr, nc) = (3 * rows + 1, 3 * columns + 1);
    let mut out = Vec::new();
    for i in 0..nr {
        for j in 0..nc {
            let k = (i * 7 + j * 13) % 9;
            let dx = (k as f32 - 4.0) / 64.0;
            let dy = ((k * 5) % 9) as f32 / 64.0 - 4.0 / 64.0;
            out.push([
                j as f32 / (nc - 1) as f32 + dx,
                i as f32 / (nr - 1) as f32 + dy,
            ]);
        }
    }
    out
}

fn corner(x: f32, y: f32) -> PathAnchor {
    PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    }
}

fn smooth(anchor: (f32, f32), left: (f32, f32), right: (f32, f32)) -> PathAnchor {
    PathAnchor {
        anchor,
        left,
        right,
    }
}

/// Runs to walk: straight chords, curves, a doubled anchor, closed shapes.
fn runs() -> Vec<(&'static str, Vec<PathAnchor>, bool)> {
    let k = 100.0 * paged_geom::KAPPA_F32;
    vec![
        (
            "zigzag",
            vec![corner(0.0, 0.0), corner(30.0, 40.0), corner(60.0, 0.0)],
            false,
        ),
        (
            "quarterCircle",
            vec![
                smooth((100.0, 0.0), (100.0, 0.0), (100.0, k)),
                smooth((0.0, 100.0), (k, 100.0), (0.0, 100.0)),
            ],
            false,
        ),
        (
            "sCurve",
            vec![
                smooth((0.0, 0.0), (0.0, 0.0), (40.0, -60.0)),
                smooth((80.0, 0.0), (40.0, 60.0), (120.0, -60.0)),
                smooth((160.0, 10.0), (130.0, 70.0), (160.0, 10.0)),
            ],
            false,
        ),
        (
            "doubledAnchor",
            vec![
                corner(0.0, 0.0),
                corner(50.0, 0.0),
                corner(50.0, 0.0),
                corner(50.0, 50.0),
            ],
            false,
        ),
        (
            "circle",
            vec![
                smooth((100.0, 0.0), (100.0, -k), (100.0, k)),
                smooth((0.0, 100.0), (k, 100.0), (-k, 100.0)),
                smooth((-100.0, 0.0), (-100.0, k), (-100.0, -k)),
                smooth((0.0, -100.0), (-k, -100.0), (k, -100.0)),
            ],
            true,
        ),
        (
            "triangle",
            vec![corner(0.0, 0.0), corner(90.0, 0.0), corner(45.0, 60.0)],
            true,
        ),
    ]
}

/// A closed run walked as an open one: the first anchor again at its end.
fn walked(run: &[PathAnchor], closed: bool) -> Vec<PathAnchor> {
    let mut out = run.to_vec();
    if closed {
        out.push(run[0]);
    }
    out
}

fn build() -> Value {
    let ts: Vec<f32> = (-2..=18).map(|i| i as f32 / 16.0).collect();
    let width: Vec<Value> = profiles()
        .into_iter()
        .map(|(id, pts)| {
            let p = profile(&pts);
            let factors: Vec<f64> = ts.iter().map(|&t| f64::from(p.factor_at(t))).collect();
            json!({ "id": id, "points": pts, "t": ts, "factor": factors })
        })
        .collect();
    let normalized: Vec<Value> = raw_lists()
        .into_iter()
        .map(|pts| {
            let out: Vec<(f32, f32)> = profile(&pts)
                .normalized()
                .points
                .iter()
                .map(|p| (p.t, p.width))
                .collect();
            json!({ "points": pts, "normalized": out })
        })
        .collect();
    let uv: Vec<f64> = (-1..=9).map(|i| f64::from(i) / 8.0).collect();
    let envelope: Vec<Value> = [(1u32, 1u32), (2, 3), (3, 2)]
        .into_iter()
        .map(|(rows, columns)| {
            let n = net(rows, columns);
            let mut samples = Vec::new();
            for &v in &uv {
                for &u in &uv {
                    let (x, y) = envelope_point(&n, rows, columns, u, v);
                    samples.push(json!([u, v, x, y]));
                }
            }
            json!({ "rows": rows, "columns": columns, "net": n, "samples": samples })
        })
        .collect();
    // `point_along` answers short of the end only (the end has nothing
    // left to trim), so the samples stop at 15/16; the twin's end is exact.
    let along: Vec<Value> = runs()
        .into_iter()
        .map(|(id, run, closed)| {
            let open = walked(&run, closed);
            let length = run_length(&open);
            let samples: Vec<Value> = (0..16)
                .map(|i| {
                    let u = i as f32 / 16.0;
                    let (x, y) = point_along(&open, u * length).expect("short of the end");
                    json!([u, x, y])
                })
                .collect();
            let anchors: Vec<Value> = run
                .iter()
                .map(|a| json!({ "anchor": a.anchor, "left": a.left, "right": a.right }))
                .collect();
            json!({ "id": id, "closed": closed, "anchors": anchors, "length": length, "samples": samples })
        })
        .collect();
    json!({
        "note": "Written by paged-vector-fx tests/it/ts_twins.rs (PAGED_WRITE_TS_TWINS=1); read by vector-geometry test/vector-fx-parity.spec.ts.",
        "width": width,
        "normalized": normalized,
        "envelope": envelope,
        "alongPath": along,
    })
}

#[test]
fn the_typescript_twins_fixture_is_this_crates_numbers() {
    let want = build();
    if std::env::var_os("PAGED_WRITE_TS_TWINS").is_some() {
        let text = serde_json::to_string_pretty(&want).unwrap() + "\n";
        std::fs::write(FIXTURE, text).unwrap();
        return;
    }
    let got: Value = serde_json::from_str(&std::fs::read_to_string(FIXTURE).unwrap()).unwrap();
    assert!(
        same(&got, &want),
        "fixtures/ts_twins.json is stale: rerun with PAGED_WRITE_TS_TWINS=1 and check the TypeScript twins"
    );
}

/// Equal values, numbers to the last bits a decimal round trip keeps.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= 1e-12 * x.abs().max(1.0)
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}
