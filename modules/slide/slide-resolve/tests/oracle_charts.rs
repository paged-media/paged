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

//! Charts against PowerPoint's own drawing (ADR 705): every rectangle
//! PowerPoint painted inside a corpus chart (recorded by
//! `scripts/ppt-chart-probe.py` into `oracle/primary.charts.json`) has a
//! bar in our layout within 3 pt on every edge.
//!
//! Why 3 pt: the plot area starts right of the value labels, and their
//! width is the label font's digit advance, which the importer does not
//! measure (it reads no font files). The estimate (0.6 × size) is off by up
//! to 0.09 × size per digit: Space Mono runs 0.51, Montserrat 0.66.

use std::path::Path;

use slide_resolve::model::{Item, ItemKind, Paint};

const TOLERANCE: f64 = 3.0;

/// Page-space boxes of the filled four-corner shapes under `it`.
fn rects(it: &Item, out: &mut Vec<(f64, f64, f64, f64)>) {
    match &it.kind {
        ItemKind::Group { children } => children.iter().for_each(|c| rects(c, out)),
        ItemKind::Shape { outline, fill, .. }
            if outline.len() == 1
                && outline[0].points.len() == 4
                && !matches!(fill, Paint::None) =>
        {
            let m = &it.transform;
            let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for p in &outline[0].points {
                let (x, y) = (
                    m[0] * p.anchor.0 + m[2] * p.anchor.1 + m[4],
                    m[1] * p.anchor.0 + m[3] * p.anchor.1 + m[5],
                );
                b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
            }
            out.push(b);
        }
        _ => {}
    }
}

#[test]
fn corpus_chart_bars_land_where_powerpoint_draws_them() {
    let base = std::env::var_os("PAGED_CORPUS")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus"));
    let packs = base.join("pptx/packs");
    if !packs.is_dir() {
        assert!(
            std::env::var("PAGED_REQUIRE_CORPUS").as_deref() != Ok("1"),
            "PAGED_REQUIRE_CORPUS=1 but no corpus"
        );
        eprintln!("SKIP: no pptx corpus");
        return;
    }
    let mut checked = 0;
    let mut misses = Vec::new();
    for entry in std::fs::read_dir(&packs).unwrap().filter_map(|e| e.ok()) {
        let oracle = entry.path().join("oracle/primary.charts.json");
        let Ok(text) = std::fs::read(&oracle) else {
            continue;
        };
        let answers: serde_json::Value = serde_json::from_slice(&text).unwrap();
        let bytes = std::fs::read(entry.path().join("primary.pptx")).unwrap();
        let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
        for c in answers["charts"].as_array().unwrap() {
            let slide = &deck.slides[c["slide"].as_u64().unwrap() as usize - 1];
            let name = c["name"].as_str().unwrap();
            let Some(group) = slide.items.iter().find(|i| i.name == name) else {
                misses.push(format!(
                    "{}: chart {name} not resolved",
                    entry.path().display()
                ));
                continue;
            };
            let mut ours = Vec::new();
            rects(group, &mut ours);
            for r in c["rects"].as_array().unwrap() {
                let v: Vec<f64> = r
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().unwrap())
                    .collect();
                let (l, t, rr, b) = (v[0], v[1], v[0] + v[2], v[1] + v[3]);
                checked += 1;
                let hit = ours.iter().any(|o| {
                    (o.0 - l).abs() <= TOLERANCE
                        && (o.1 - t).abs() <= TOLERANCE
                        && (o.2 - rr).abs() <= TOLERANCE
                        && (o.3 - b).abs() <= TOLERANCE
                });
                if !hit {
                    let d = |o: &(f64, f64, f64, f64)| {
                        (o.0 - l).abs() + (o.1 - t).abs() + (o.2 - rr).abs() + (o.3 - b).abs()
                    };
                    let near = ours.iter().min_by(|a, b| d(a).total_cmp(&d(b)));
                    misses.push(format!(
                        "{} slide {}: PowerPoint bar {:.1?}, nearest ours {:.1?}",
                        entry.file_name().to_string_lossy(),
                        c["slide"],
                        (l, t, rr, b),
                        near
                    ));
                }
            }
        }
    }
    eprintln!("charts: {checked} bars checked");
    assert!(misses.is_empty(), "{}", misses.join("\n"));
}
