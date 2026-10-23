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
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

#![allow(non_snake_case)]

//! Every chart in the real corpus renders with its real kind (W4 acceptance,
//! ADR 518): each plot element of every chart part maps to the kind it
//! names (a 3-D element to its 2-D kind, flagged), no chart Paged can draw
//! is a placeholder, and every chart produces geometry through the session.
//!
//! OPT-IN (private corpus): `PAGED_CORPUS_DIR=<root> cargo nextest run
//! -p sheet-conformance --run-ignored only chart_corpus`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sheet_chart::ChartKind;
use sheet_js::core::SheetSession;
use sheet_xlsx::XlsxDocument;

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|e| e == "xlsx" || e == "xlsm") {
            out.push(p);
        }
    }
}

/// The kind a plot element names (the census side of the comparison).
fn kind_named(element: &str, xml: &str) -> Option<ChartKind> {
    Some(match element {
        "barChart" | "bar3DChart" => {
            if xml.contains(r#"barDir val="bar""#) {
                ChartKind::Bar
            } else {
                ChartKind::Column
            }
        }
        "lineChart" | "line3DChart" => ChartKind::Line,
        "areaChart" | "area3DChart" => ChartKind::Area,
        "pieChart" | "pie3DChart" => ChartKind::Pie,
        "doughnutChart" => ChartKind::Donut,
        "scatterChart" => ChartKind::Scatter,
        "bubbleChart" => ChartKind::Bubble,
        "radarChart" => ChartKind::Radar,
        "stockChart" => ChartKind::Stock,
        "surfaceChart" | "surface3DChart" => ChartKind::Surface,
        "ofPieChart" => ChartKind::PieOfPie,
        _ => return None,
    })
}

#[test]
#[ignore = "corpus: xlsx"]
fn every_corpus_chart_renders_with_its_kind__feat__sheet_chart_kinds() {
    let Some(root) = paged_test_resources::corpus("xlsx", &["PAGED_XLSX_CORPUS"]) else {
        return;
    };
    let mut files = Vec::new();
    walk(&root, &mut files);
    files.sort();
    let mut census: BTreeMap<String, usize> = BTreeMap::new();
    let mut charts = 0usize;
    let mut failures: Vec<String> = Vec::new();
    for path in &files {
        let bytes = std::fs::read(path).unwrap();
        let Ok(doc) = XlsxDocument::open(&bytes) else {
            continue;
        };
        if doc.charts.is_empty() {
            continue;
        }
        let Ok(session) = SheetSession::load_xlsx(&bytes) else {
            failures.push(format!("{}: session refused", path.display()));
            continue;
        };
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        for (i, c) in doc.charts.iter().enumerate() {
            charts += 1;
            let name = format!(
                "{} #{i}",
                path.strip_prefix(&root).unwrap_or(path).display()
            );
            let xml = c
                .part
                .as_ref()
                .and_then(|p| {
                    let mut f = zip.by_name(p).ok()?;
                    let mut s = String::new();
                    std::io::Read::read_to_string(&mut f, &mut s).ok()?;
                    Some(s)
                })
                .unwrap_or_default();
            // The plot elements of the part, in order.
            let elements: Vec<String> = xml
                .match_indices("<c:")
                .filter_map(|(at, _)| {
                    let rest = &xml[at + 3..];
                    let end = rest.find(|ch: char| !ch.is_ascii_alphanumeric())?;
                    let el = &rest[..end];
                    el.ends_with("Chart").then(|| el.to_string())
                })
                .filter(|e| e != "chart")
                .collect();
            let first_known = elements.iter().find_map(|e| kind_named(e, &xml));
            for e in &elements {
                *census.entry(e.clone()).or_default() += 1;
            }
            let k = c.model.kind();
            *census
                .entry(format!(
                    "=> {k:?}{}",
                    if c.model.flattened_3d { " (3-D)" } else { "" }
                ))
                .or_default() += 1;
            if k == ChartKind::Unsupported && !c.chart_ex {
                failures.push(format!("{name}: unsupported ({:?})", c.model.source));
            }
            if let Some(want) = first_known {
                let got = if k == ChartKind::Donut && want == ChartKind::Pie {
                    want
                } else {
                    k
                };
                if got != want && !(want == ChartKind::PieOfPie && k == ChartKind::BarOfPie) {
                    failures.push(format!("{name}: {elements:?} drawn as {k:?}"));
                }
            }
            if elements.iter().any(|e| e.contains("3D")) && !c.model.flattened_3d {
                failures.push(format!("{name}: 3-D not flagged"));
            }
            match session.get_chart_geometry(i as u32, 360.0, 240.0) {
                Ok(g) if !g.prims.is_empty() => {}
                // A chart without series or title (Excel shows an empty area).
                Ok(_) if c.model.series_count() == 0 && c.model.title.is_none() => {}
                Ok(_) => failures.push(format!("{name}: no geometry")),
                Err(e) => failures.push(format!("{name}: {e:?}")),
            }
        }
    }
    println!("{charts} chart(s) in the corpus");
    for (k, n) in &census {
        println!("  {k:<24} {n}");
    }
    assert!(
        failures.is_empty(),
        "{} failure(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
