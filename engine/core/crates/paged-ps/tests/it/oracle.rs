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

//! paged-ps against Illustrator: the EPS programs of
//! `modules/draw/scripts/illustrator/probes/eps-import.jsx`, recorded in
//! `tests/fixtures/eps-import.illustrator.json` (Illustrator placed and
//! embedded each one, which interprets its PostScript), run through the
//! interpreter here. Every painted path the interpreter draws matches a
//! recorded path's bounds (image space: points, y down from the box's
//! top-left) within 0.05 pt, and an RGB fill its colour; a recorded path
//! nothing here matches is unpainted (a clip).

use paged_ps::{Color, Element, Options};
use serde_json::Value;

const FIXTURE: &str = include_str!("../fixtures/eps-import.illustrator.json");
const TOL: f64 = 0.05;

/// The programs the probe sends, by case id (the probe's `cases`), and
/// where Illustrator's embedded art sits relative to the box (dx, dy, pt).
///
/// Convention, recorded: Illustrator embeds the arc case 0.08 pt right of
/// and 0.08 pt below the box (circle bounds 60.08..140.08 x 10.08..90.08
/// against the program's 60..140 x 10..90); every other case lies on it.
const CASES: [(&str, f64, f64); 6] = [
    ("rgb-rect", 0.0, 0.0),
    ("cmyk-triangle", 0.0, 0.0),
    ("circle-arc", 0.08, 0.08),
    ("evenodd-ring", 0.0, 0.0),
    ("transformed-curve", 0.0, 0.0),
    ("stroked-line", 0.0, 0.0),
];

struct Recorded {
    bounds: [f64; 4],
    painted: bool,
    fill: Option<[f64; 3]>,
}

/// The recorded paths, a compound path's subpaths united.
fn recorded(case: &Value) -> Vec<Recorded> {
    let mut out: Vec<Recorded> = Vec::new();
    let mut compound: std::collections::HashMap<i64, usize> = Default::default();
    for p in case["measured"]["paths"].as_array().unwrap() {
        let b: Vec<f64> = p["bounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        let bounds = [b[0], b[1], b[2], b[3]];
        let painted = p["filled"].as_bool() == Some(true) || p["stroked"].as_bool() == Some(true);
        let fill = p["fill"].as_array().map(|f| {
            let v: Vec<f64> = f.iter().map(|x| x.as_f64().unwrap()).collect();
            [v[0], v[1], v[2]]
        });
        if let Some(ci) = p["compound"].as_i64() {
            if let Some(&k) = compound.get(&ci) {
                let r = &mut out[k].bounds;
                *r = [
                    r[0].min(bounds[0]),
                    r[1].min(bounds[1]),
                    r[2].max(bounds[2]),
                    r[3].max(bounds[3]),
                ];
                continue;
            }
            compound.insert(ci, out.len());
        }
        out.push(Recorded {
            bounds,
            painted,
            fill,
        });
    }
    out
}

#[test]
fn eps_programs_match_illustrators_reading__feat__images_graphics_eps_postscript() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    let ids: Vec<&str> = cases.iter().map(|c| c["id"].as_str().unwrap()).collect();
    let names: Vec<&str> = CASES.iter().map(|c| c.0).collect();
    assert_eq!(ids, names, "the probe and this replay list the same cases");
    for (case, (id, dx, dy)) in cases.iter().zip(CASES) {
        let eps = case["parameters"]["eps"].as_str().unwrap();
        let art = paged_ps::interpret(eps.as_bytes(), &Options::default()).unwrap();
        let [x0, _, _, y1] = art.bbox;
        let to_image = |b: [f64; 4]| {
            [
                b[0] - x0 + dx,
                y1 - b[3] + dy,
                b[2] - x0 + dx,
                y1 - b[1] + dy,
            ]
        };
        let rec = recorded(case);
        let mut used = vec![false; rec.len()];
        for e in &art.elements {
            let (bounds, color) = match e {
                Element::Fill { path, paint, .. } => (crate::bbox(path), Some(paint.color)),
                Element::Stroke {
                    path,
                    transform,
                    paint,
                    ..
                } => (crate::bbox(&(*transform * path.clone())), Some(paint.color)),
                _ => continue,
            };
            let ours = to_image(bounds);
            let hit = rec
                .iter()
                .enumerate()
                .find(|(k, r)| !used[*k] && r.painted && crate::near(r.bounds, ours, TOL));
            let Some((k, r)) = hit else {
                panic!(
                    "{id}: no recorded path with bounds {ours:?}; recorded {:?}",
                    rec.iter().map(|r| r.bounds).collect::<Vec<_>>()
                );
            };
            used[k] = true;
            if let (Some(Color::Rgb(c)), Some(f)) = (color, r.fill) {
                for ch in 0..3 {
                    assert!(
                        (c[ch] as f64 * 255.0 - f[ch]).abs() <= 1.0,
                        "{id}: colour {c:?} vs {f:?}"
                    );
                }
            }
        }
        for (k, r) in rec.iter().enumerate() {
            assert!(
                used[k] || !r.painted,
                "{id}: Illustrator painted {:?}, paged-ps did not",
                r.bounds
            );
        }
    }
}
