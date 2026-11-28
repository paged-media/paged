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

//! Resolved positions against PowerPoint's own (ADR 705): every top-level
//! item of every fixture slide lands where PowerPoint's geometry probe says
//! the shape is — placeholders included, which is where inheritance from
//! the layout and master decides the answer.

use std::path::Path;

use slide_resolve::model::{Item, ItemKind};

fn bbox(it: &Item) -> (f64, f64, f64, f64) {
    let m = &it.transform;
    let pts = [(0.0, 0.0), (it.w, 0.0), (it.w, it.h), (0.0, it.h)]
        .map(|(x, y)| (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]));
    let xs = pts.iter().map(|p| p.0);
    let ys = pts.iter().map(|p| p.1);
    (
        xs.clone().fold(f64::MAX, f64::min),
        ys.clone().fold(f64::MAX, f64::min),
        xs.fold(f64::MIN, f64::max),
        ys.fold(f64::MIN, f64::max),
    )
}

fn path_bbox(it: &Item) -> (f64, f64, f64, f64) {
    let ItemKind::Shape { outline, .. } = &it.kind else {
        return bbox(it);
    };
    let m = &it.transform;
    let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for sp in outline {
        for p in &sp.points {
            let (x, y) = (
                m[0] * p.anchor.0 + m[2] * p.anchor.1 + m[4],
                m[1] * p.anchor.0 + m[3] * p.anchor.1 + m[5],
            );
            b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
        }
    }
    b
}

/// (matched, misplaced lines) for one fixture.
fn compare(name: &str) -> (usize, Vec<String>) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    compare_files(
        name,
        &dir.join(format!("{name}.pptx")),
        &dir.join(format!("{name}.ppt.json")),
    )
}

fn compare_files(name: &str, deck: &Path, oracle: &Path) -> (usize, Vec<String>) {
    let deck = pptx_import::import_pptx(&std::fs::read(deck).unwrap()).unwrap();
    let resolved = slide_resolve::resolve(&deck);
    let oracle: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(oracle).unwrap()).unwrap();
    let mut matched = 0;
    let mut bad = Vec::new();
    for (i, slide) in resolved.slides.iter().enumerate() {
        let Some(shapes) = oracle["shapes"][(i + 1).to_string()].as_array() else {
            continue;
        };
        for it in &slide.items {
            // A shape, a picture, a table, or a graphic frame drawn as a
            // group (a chart, a diagram): what PowerPoint reports a box of
            // its own for. A plain group's box is its members' union.
            let framed = matches!(it.kind, ItemKind::Group { .. }) && it.meta.frame.is_some();
            if !framed
                && !matches!(
                    it.kind,
                    ItemKind::Shape { .. } | ItemKind::Picture { .. } | ItemKind::Table(_)
                )
            {
                continue;
            }
            // By position in the shape tree: PowerPoint's scripting reports
            // English placeholder names ("Title 3") where the file stores the
            // UI language's ("Titel 3").
            let Some(o) = shapes
                .iter()
                .find(|s| s["index"].as_u64() == Some(it.meta.order as u64))
            else {
                continue;
            };
            let rotated = o["rotation"].as_f64().unwrap_or(0.0) != 0.0;
            let (l, t, r, b) = if rotated {
                // PowerPoint reports a rotated shape's box as it stood
                // before the rotation: the same size, about the same centre.
                let m = &it.transform;
                let (cx, cy) = (
                    m[0] * it.w / 2.0 + m[2] * it.h / 2.0 + m[4],
                    m[1] * it.w / 2.0 + m[3] * it.h / 2.0 + m[5],
                );
                (
                    cx - it.w / 2.0,
                    cy - it.h / 2.0,
                    cx + it.w / 2.0,
                    cy + it.h / 2.0,
                )
            } else if it.meta.preset.as_ref().is_some_and(|(p, _)| p == "arc") {
                // PowerPoint's scripting reports an arc's drawn bounds, not its box.
                path_bbox(it)
            } else {
                bbox(it)
            };
            let (ol, ot) = (o["left"].as_f64().unwrap(), o["top"].as_f64().unwrap());
            let (ow, oh) = (o["width"].as_f64().unwrap(), o["height"].as_f64().unwrap());
            let off = [
                (l - ol).abs(),
                (t - ot).abs(),
                (r - l - ow).abs(),
                (b - t - oh).abs(),
            ];
            matched += 1;
            if off.iter().any(|d| *d > 1.0) {
                bad.push(format!("{name} slide {} {:?}: ours ({l:.1},{t:.1} {:.1}x{:.1}) PowerPoint ({ol:.1},{ot:.1} {ow:.1}x{oh:.1})", i + 1, it.name, r - l, b - t));
            }
        }
    }
    (matched, bad)
}

/// Every deck in `slide-conformance/fixtures` PowerPoint's geometry probe was
/// recorded for (`<name>.ppt.json` beside `<name>.pptx`), by name.
fn recorded_decks() -> Vec<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            let name = file.strip_suffix(".ppt.json")?;
            dir.join(format!("{name}.pptx"))
                .is_file()
                .then(|| name.to_string())
        })
        .collect();
    names.sort();
    names
}

#[test]
fn fixtures_land_where_powerpoint_puts_them() {
    let decks = recorded_decks();
    // The decks recorded when this was written; a recording that goes
    // missing is a comparison lost, not a shorter list.
    assert!(decks.len() >= 17, "recorded decks missing: {decks:?}");
    let mut total = 0;
    let mut all_bad = Vec::new();
    for name in &decks {
        let (m, bad) = compare(name);
        eprintln!(
            "{name}: {m} shapes compared, {} off by more than 1 pt",
            bad.len()
        );
        // A deck none of whose shapes is compared measures nothing.
        assert!(m > 0, "{name}: no shape compared with PowerPoint's");
        total += m;
        all_bad.extend(bad);
    }
    for b in &all_bad {
        eprintln!("  {b}");
    }
    assert!(total > 300, "too few shapes compared: {total}");
    assert!(all_bad.is_empty(), "{} shapes misplaced", all_bad.len());
}

/// The corpus decks against their recordings (the private corpus,
/// `corpus: pptx`: `PAGED_CORPUS_DIR`, or the `<repo root>/corpus` link;
/// reports `unavailable` without it, fails instead under
/// `PAGED_REQUIRE_CORPUS=1`; docs/development/testing.md).
#[test]
#[ignore = "corpus: pptx"]
fn corpus_decks_land_where_powerpoint_puts_them() {
    let Some(pptx) = paged_test_resources::corpus("pptx", &["PAGED_CORPUS"]) else {
        return;
    };
    let packs = pptx.join("packs");
    if !packs.is_dir() {
        paged_test_resources::skip!(
            paged_test_resources::Resource::Corpus,
            "{} is not a directory",
            packs.display()
        );
    }
    let (mut total, mut bad_total) = (0, 0);
    let mut dirs: Vec<_> = std::fs::read_dir(&packs)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        let (deck, oracle) = (d.join("primary.pptx"), d.join("oracle/primary.ppt.json"));
        if !deck.is_file() || !oracle.is_file() {
            continue;
        }
        let name = d.file_name().unwrap().to_string_lossy().to_string();
        let (m, bad) = compare_files(&name, &deck, &oracle);
        eprintln!("{name}: {m} compared, {} off by more than 1 pt", bad.len());
        for b in bad.iter().take(5) {
            eprintln!("  {b}");
        }
        total += m;
        bad_total += bad.len();
    }
    let ok = total - bad_total;
    eprintln!("corpus: {ok}/{total} within 1 pt");
    assert!(total > 500, "too few shapes compared: {total}");
    assert!(
        ok as f64 >= 0.95 * total as f64,
        "only {ok}/{total} within 1 pt"
    );
}
