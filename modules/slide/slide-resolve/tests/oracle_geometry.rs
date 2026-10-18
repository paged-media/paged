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
            if !matches!(it.kind, ItemKind::Shape { .. } | ItemKind::Picture { .. }) {
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
            if o["rotation"].as_f64().unwrap_or(0.0) != 0.0 {
                continue;
            }
            // PowerPoint's scripting reports an arc's drawn bounds, not its box.
            let (l, t, r, b) = if it.meta.preset.as_ref().is_some_and(|(p, _)| p == "arc") {
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

#[test]
fn fixtures_land_where_powerpoint_puts_them() {
    let mut total = 0;
    let mut all_bad = Vec::new();
    for name in ["geometry", "text", "placeholders", "motion"] {
        let (m, bad) = compare(name);
        eprintln!(
            "{name}: {m} shapes compared, {} off by more than 1 pt",
            bad.len()
        );
        total += m;
        all_bad.extend(bad);
    }
    for b in &all_bad {
        eprintln!("  {b}");
    }
    assert!(total > 300, "too few shapes compared: {total}");
    assert!(all_bad.is_empty(), "{} shapes misplaced", all_bad.len());
}

/// The corpus decks against their recordings (private corpus beside this
/// repo, or `PAGED_CORPUS`; skips without it unless `PAGED_REQUIRE_CORPUS=1`).
#[test]
fn corpus_decks_land_where_powerpoint_puts_them() {
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
