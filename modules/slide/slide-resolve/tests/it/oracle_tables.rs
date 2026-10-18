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

//! Table styles against PowerPoint's own drawing (ADR 705): every cell of
//! every table in the `tables` and `tablestyles` fixtures (all 74 built-in
//! styles, each with header, total, first/last column and banded rows, and
//! with banded columns) resolves to the colour PowerPoint's page shows there
//! and to its text's weight and colour. Answers recorded by
//! `scripts/ppt-table-probe.py`.

use std::collections::BTreeMap;
use std::path::Path;

use slide_resolve::model::{Item, ItemKind, Paint, Table};

/// RGB units a colour may differ by: rounding, and up to 4 near the end of
/// a theme gradient (Themed Style 2 - Accent 4's last row reads 1,151,210 in
/// PowerPoint and 1,149,206 here, the stop's saturation boost rounding
/// differently).
const TOLERANCE: i32 = 4;

fn tables(items: &[Item], out: &mut BTreeMap<String, Table>) {
    for it in items {
        match &it.kind {
            ItemKind::Table(t) => {
                out.insert(it.name.clone(), t.clone());
            }
            ItemKind::Group { children } => tables(children, out),
            _ => {}
        }
    }
}

fn rgb(p: &Paint) -> Option<[i32; 3]> {
    match p {
        Paint::Solid { rgb, .. } => Some([rgb[0] as i32, rgb[1] as i32, rgb[2] as i32]),
        _ => None,
    }
}

fn close(a: [i32; 3], b: &serde_json::Value) -> bool {
    (0..3).all(|k| (a[k] - b[k].as_i64().unwrap() as i32).abs() <= TOLERANCE)
}

fn check(fixture: &str) -> Vec<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    let bytes = std::fs::read(dir.join(format!("{fixture}.pptx"))).unwrap();
    let answers: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join(format!("{fixture}.tables.json"))).unwrap())
            .unwrap();
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
    let mut ours = BTreeMap::new();
    for s in &deck.slides {
        tables(&s.items, &mut ours);
    }
    let mut misses = Vec::new();
    for (name, want) in answers["tables"].as_object().unwrap() {
        let Some(t) = ours.get(name) else {
            misses.push(format!("{name}: not resolved"));
            continue;
        };
        for (r, row) in want["cells"].as_array().unwrap().iter().enumerate() {
            for (c, cell) in row.as_array().unwrap().iter().enumerate() {
                let got = &t.rows[r].1[c];
                // Where a cell has no fill the table background shows (read
                // where the probe sampled: three quarters across, half way
                // down), and where that is empty too, the white slide.
                let x: f64 = t.columns[..c].iter().sum::<f64>() + 0.75 * t.columns[c];
                let y: f64 = t.rows[..r].iter().map(|r| r.0).sum::<f64>() + 0.5 * t.rows[r].0;
                let fill = rgb(&got.fill)
                    .or_else(|| {
                        t.backdrop_at(x, y)
                            .map(|c| [c[0] as i32, c[1] as i32, c[2] as i32])
                    })
                    .unwrap_or([255, 255, 255]);
                if !close(fill, &cell["fill"]) {
                    misses.push(format!(
                        "{name} ({r},{c}): fill {fill:?}, PowerPoint {}",
                        cell["fill"]
                    ));
                }
                let Some(text) = cell["text"].as_object() else {
                    continue;
                };
                let run = got
                    .text
                    .as_ref()
                    .and_then(|tf| tf.paragraphs.first())
                    .and_then(|p| p.runs.first());
                let Some(run) = run else {
                    misses.push(format!("{name} ({r},{c}): no text"));
                    continue;
                };
                if run.bold != text["bold"].as_bool().unwrap() {
                    misses.push(format!(
                        "{name} ({r},{c}): bold {}, PowerPoint {}",
                        run.bold, text["bold"]
                    ));
                }
                let col = [run.rgb[0] as i32, run.rgb[1] as i32, run.rgb[2] as i32];
                if !close(col, &text["rgb"]) {
                    misses.push(format!(
                        "{name} ({r},{c}): text {col:?}, PowerPoint {}",
                        text["rgb"]
                    ));
                }
            }
        }
    }
    misses
}

/// What PowerPoint drew across the midpoint of a cell edge: (width, rgb) of
/// a stroke, or of the thin bars a compound line is drawn with.
fn drawn_at(
    borders: &[serde_json::Value],
    x: f64,
    y: f64,
    horizontal: bool,
) -> Option<(f64, [i32; 3])> {
    let f = |v: &serde_json::Value| v.as_f64().unwrap();
    let col = |b: &serde_json::Value| {
        let c = b["rgb"].as_array()?;
        Some([
            c[0].as_i64()? as i32,
            c[1].as_i64()? as i32,
            c[2].as_i64()? as i32,
        ])
    };
    let mut best: Option<(f64, [i32; 3])> = None;
    for b in borders {
        if let Some(bar) = b["bar"].as_array() {
            let (bx, by, bw, bh) = (f(&bar[0]), f(&bar[1]), f(&bar[2]), f(&bar[3]));
            let hit = if horizontal {
                bw > bh && bx - 0.5 <= x && x <= bx + bw + 0.5 && (by + bh / 2.0 - y).abs() <= 3.0
            } else {
                bh > bw && by - 0.5 <= y && y <= by + bh + 0.5 && (bx + bw / 2.0 - x).abs() <= 3.0
            };
            if hit {
                let w = best.map(|(w, _)| w).unwrap_or(0.0) + bw.min(bh);
                best = Some((w, col(b)?));
            }
            continue;
        }
        let (x0, y0, x1, y1) = (
            f(&b["from"][0]),
            f(&b["from"][1]),
            f(&b["to"][0]),
            f(&b["to"][1]),
        );
        let w = f(&b["width"]);
        let hit = if horizontal {
            (y0 - y1).abs() < 0.1
                && (y0 - y).abs() <= 1.0
                && x0.min(x1) - 0.5 <= x
                && x <= x0.max(x1) + 0.5
        } else {
            (x0 - x1).abs() < 0.1
                && (x0 - x).abs() <= 1.0
                && y0.min(y1) - 0.5 <= y
                && y <= y0.max(y1) + 0.5
        };
        if hit && best.is_none_or(|(bw, _)| w > bw) {
            best = Some((w, col(b)?));
        }
    }
    best
}

fn check_borders(fixture: &str) -> Vec<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    let bytes = std::fs::read(dir.join(format!("{fixture}.pptx"))).unwrap();
    let answers: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join(format!("{fixture}.tables.json"))).unwrap())
            .unwrap();
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
    let mut ours = BTreeMap::new();
    for s in &deck.slides {
        tables(&s.items, &mut ours);
    }
    let mut misses = Vec::new();
    for (name, want) in answers["tables"].as_object().unwrap() {
        let Some(t) = ours.get(name) else { continue };
        let borders = want["borders"].as_array().unwrap();
        let xs: Vec<f64> = (0..=t.columns.len())
            .map(|i| t.columns[..i].iter().sum())
            .collect();
        let ys: Vec<f64> = (0..=t.rows.len())
            .map(|i| t.rows[..i].iter().map(|r| r.0).sum())
            .collect();
        for (r, (_, cells)) in t.rows.iter().enumerate() {
            for (c, cell) in cells.iter().enumerate() {
                // left, right, top, bottom: (midpoint, horizontal?)
                let edges = [
                    (xs[c], (ys[r] + ys[r + 1]) / 2.0, false),
                    (xs[c + 1], (ys[r] + ys[r + 1]) / 2.0, false),
                    ((xs[c] + xs[c + 1]) / 2.0, ys[r], true),
                    ((xs[c] + xs[c + 1]) / 2.0, ys[r + 1], true),
                ];
                for (k, (x, y, h)) in edges.into_iter().enumerate() {
                    let drawn = drawn_at(borders, x, y, h);
                    let ours = cell.borders[k]
                        .as_ref()
                        .and_then(|s| Some((s.width, rgb(&s.paint)?)));
                    let side = ["left", "right", "top", "bottom"][k];
                    match (ours, drawn) {
                        (None, None) => {}
                        (Some((w, c0)), Some((pw, pc))) => {
                            let ok_col = (0..3).all(|i| (c0[i] - pc[i]).abs() <= 8);
                            if !ok_col || (w - pw).abs() > 0.75 {
                                misses.push(format!("{name} ({r},{c}) {side}: ours {w:.2}pt {c0:?}, PowerPoint {pw:.2}pt {pc:?}"));
                            }
                        }
                        (o, d) => misses.push(format!(
                            "{name} ({r},{c}) {side}: ours {o:?}, PowerPoint {d:?}"
                        )),
                    }
                }
            }
        }
    }
    misses
}

#[test]
fn table_style_borders_resolve_as_powerpoint_draws_them() {
    let mut misses = check_borders("tables");
    misses.extend(check_borders("tablestyles"));
    assert!(
        misses.is_empty(),
        "{} misses:\n{}",
        misses.len(),
        misses.join("\n")
    );
}

#[test]
fn built_in_table_styles_resolve_as_powerpoint_draws_them() {
    let mut misses = check("tables");
    misses.extend(check("tablestyles"));
    assert!(
        misses.is_empty(),
        "{} misses:\n{}",
        misses.len(),
        misses.join("\n")
    );
}
