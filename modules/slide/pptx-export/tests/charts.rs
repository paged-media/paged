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

//! Live charts (ADR 715) on the `charts` fixture (PowerPoint-saved: a
//! column, line, pie and scatter chart with embedded workbooks, and a
//! column chart without one): workbooks read and made, the binding, the
//! export of an edited chart and its zero-edit identity.

// Test names carry their feature (`__feat__…`, the cockpit's test map).
#![allow(non_snake_case)]

use std::collections::BTreeMap;
use std::path::PathBuf;

use base64::Engine as _;
use paged_ooxml::OpcPackage;
use paged_scene::Document;
use pptx_export::{export_with, native, ChartPlan, ExportPlan, Exported, SlidePlan};
use slide_sheet::{ChartBook, DeckCharts, Origin};

fn fixture() -> Vec<u8> {
    let p =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures/charts.pptx");
    std::fs::read(p).unwrap()
}

fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(format!("{name}.pptx")), bytes).unwrap();
    }
}

/// The deck's native document as import builds it, the charts' values
/// first applied from `charts` when given (a redraw from edited data).
fn document(bytes: &[u8], charts: &DeckCharts, live: bool) -> Document {
    let mut ir = pptx_import::import_pptx(bytes).unwrap();
    if live {
        for (part, book) in &charts.books {
            if let Some(c) = ir.charts.get_mut(part) {
                book.apply(c);
            }
        }
    }
    let deck = slide_resolve::resolve_with(&ir, &|p, w, h| charts.draw(p, w, h));
    let pkg = OpcPackage::read(bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, "deck").document
}

fn plan(doc: &Document, charts: Vec<ChartPlan>) -> ExportPlan {
    ExportPlan {
        slides: doc
            .spreads
            .iter()
            .filter_map(|s| {
                let page = s.spread.pages.first()?;
                let id = page.self_id.clone()?;
                let st = native::page_state(&s.spread, &id);
                Some(SlidePlan {
                    source_part: st["part"].as_str().unwrap_or("").to_string(),
                    hidden: st["hidden"].as_bool().unwrap_or(false),
                    notes: st["notes"].as_str().map(str::to_string),
                    page_id: Some(id),
                    ..SlidePlan::default()
                })
            })
            .collect(),
        charts,
    }
}

fn export(bytes: &[u8], doc: &Document, charts: Vec<ChartPlan>) -> Exported {
    let paged = paged_store::package::wrap_document(doc, "deck", 960.0, 540.0).unwrap();
    export_with(bytes, &plan(doc, charts), Some(&paged)).unwrap()
}

fn open(bytes: &[u8]) -> DeckCharts {
    let pkg = OpcPackage::read(bytes).unwrap();
    let ir = pptx_import::import_pptx(bytes).unwrap();
    let (charts, diagnostics) = DeckCharts::open(&pkg, &ir);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    charts
}

fn parts(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let pkg = OpcPackage::read(bytes).unwrap();
    pkg.file_names()
        .map(|n| (n.to_string(), pkg.part(n).unwrap().to_vec()))
        .collect()
}

const COL: &str = "ppt/charts/chart1.xml";
const SCATTER: &str = "ppt/charts/chart4.xml";
const BARE: &str = "ppt/charts/chart5.xml";

#[test]
fn an_embedded_workbook_is_read_and_binds_the_series__feat__plugin_slide_charts() {
    let charts = open(&fixture());
    assert_eq!(charts.books.len(), 5);
    let book = &charts.books[COL];
    assert_eq!(book.origin(), Origin::Embedded);
    let s = book.series();
    assert_eq!(s.len(), 3);
    assert_eq!(s[0].name.as_deref(), Some("North"));
    assert_eq!(
        s[0].categories.as_deref(),
        Some(&["Q1", "Q2", "Q3", "Q4"].map(String::from)[..])
    );
    assert_eq!(
        s[0].values.as_deref(),
        Some(&[Some(4.3), Some(2.5), Some(3.5), Some(4.5)][..])
    );
    // The chart part's caches say the same (the workbook is the data).
    let ir = pptx_import::import_pptx(&fixture()).unwrap();
    let cached = &ir.charts[COL].plots[0].series[0];
    assert_eq!(cached.values, s[0].values.clone().unwrap());
    // Who draws: the column chart PowerPoint's way, the scatter by paged.sheet.
    assert!(charts.slide_drawn.contains(COL));
    assert!(!charts.slide_drawn.contains(SCATTER));
    assert!(charts
        .draw(SCATTER, 400.0, 300.0)
        .is_some_and(|p| !p.is_empty()));
}

#[test]
fn a_chart_without_a_workbook_gets_one_made_from_its_caches__feat__plugin_slide_charts() {
    let mut charts = open(&fixture());
    let book = charts.books.get_mut(BARE).unwrap();
    assert_eq!(book.origin(), Origin::Synthesized);
    let s = book.series();
    assert_eq!(s.len(), 2);
    assert_eq!(s[1].name.as_deref(), Some("South"));
    assert_eq!(
        s[1].values.as_deref(),
        Some(&[Some(2.4), Some(4.4), Some(1.8), Some(2.8)][..])
    );
    // PowerPoint's sheet layout: categories in A, series from B.
    let grid = book.grid();
    let cell = |r: u32, c: u32| {
        grid[0]
            .cells
            .iter()
            .find(|x| x.row == r && x.col == c)
            .map(|x| x.text.clone())
    };
    assert_eq!(cell(0, 1).as_deref(), Some("North"));
    assert_eq!(cell(1, 0).as_deref(), Some("Q1"));
    assert_eq!(cell(4, 2).as_deref(), Some("2.8"));
    // The made workbook reopens as itself.
    let xlsx = book.save_xlsx().unwrap();
    let pkg = OpcPackage::read(&fixture()).unwrap();
    let again = ChartBook::reopen(&xlsx, pkg.part(BARE).unwrap(), Origin::Synthesized).unwrap();
    assert_eq!(again.series(), s);
}

#[test]
fn a_formula_cell_feeds_the_chart__feat__plugin_slide_charts() {
    let mut charts = open(&fixture());
    let book = charts.books.get_mut(COL).unwrap();
    book.enter("Sheet1", 1, 1, "=C2*10").unwrap();
    assert_eq!(book.series()[0].values.as_ref().unwrap()[0], Some(24.0));
    book.enter("Sheet1", 1, 2, "1").unwrap();
    assert_eq!(book.series()[0].values.as_ref().unwrap()[0], Some(10.0));
}

#[test]
fn an_unedited_chart_deck_exports_its_own_bytes__feat__plugin_slide_charts() {
    let bytes = fixture();
    let charts = open(&bytes);
    let out = export(&bytes, &document(&bytes, &charts, false), Vec::new());
    assert!(out.bytes == bytes, "{:?}", out.not_exported);
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
}

fn edited_plan(charts: &mut DeckCharts, part: &str) -> ChartPlan {
    let book = charts.books.get_mut(part).unwrap();
    ChartPlan {
        part: part.into(),
        origin: book.origin(),
        workbook: base64::engine::general_purpose::STANDARD.encode(book.save_xlsx().unwrap()),
    }
}

#[test]
fn an_edited_chart_is_written_with_its_workbook_and_reads_back__feat__plugin_slide_charts() {
    let bytes = fixture();
    let mut charts = open(&bytes);
    charts
        .books
        .get_mut(COL)
        .unwrap()
        .enter("Sheet1", 2, 1, "9.25")
        .unwrap();
    charts
        .books
        .get_mut(COL)
        .unwrap()
        .enter("Sheet1", 0, 2, "Coast")
        .unwrap();
    // The document as the redraw leaves it: the chart's frame drawn anew.
    let doc = document(&bytes, &charts, true);
    let plans = vec![edited_plan(&mut charts, COL)];
    let out = export(&bytes, &doc, plans);
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    keep(&out.bytes, "chart-edited");
    // Only the chart, its workbook and the redrawn slide changed.
    let (a, b) = (parts(&bytes), parts(&out.bytes));
    let changed: Vec<&String> = b.keys().filter(|k| a.get(*k) != b.get(*k)).collect();
    assert!(
        changed.iter().all(|k| k.as_str() == COL
            || k.starts_with("ppt/embeddings/")
            || k.as_str() == "ppt/slides/slide1.xml"),
        "{changed:?}"
    );
    assert!(changed.iter().any(|k| k.as_str() == COL));
    // Read back: the chart part's caches and the workbook say the edit.
    let ir = pptx_import::import_pptx(&out.bytes).unwrap();
    let s = &ir.charts[COL].plots[0].series;
    assert_eq!(s[0].values[1], Some(9.25));
    assert_eq!(s[1].name, "Coast");
    let again = open(&out.bytes);
    let live = again.books[COL].series();
    assert_eq!(live[0].values.as_ref().unwrap()[1], Some(9.25));
    assert_eq!(live[1].name.as_deref(), Some("Coast"));
    // The other charts keep their bytes.
    for p in ["ppt/charts/chart2.xml", SCATTER, BARE] {
        assert_eq!(a.get(p), b.get(p), "{p}");
    }
}

#[test]
fn an_edited_chart_without_a_workbook_gets_one_embedded__feat__plugin_slide_charts() {
    let bytes = fixture();
    let mut charts = open(&bytes);
    charts
        .books
        .get_mut(BARE)
        .unwrap()
        .enter("Sheet1", 1, 1, "7")
        .unwrap();
    let doc = document(&bytes, &charts, true);
    let plans = vec![edited_plan(&mut charts, BARE)];
    let out = export(&bytes, &doc, plans);
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    keep(&out.bytes, "chart-made-workbook");
    let pkg = OpcPackage::read(&out.bytes).unwrap();
    let (part, _) = slide_sheet::embedded_part(&pkg, BARE).expect("embedded now");
    assert!(part.starts_with("ppt/embeddings/"), "{part}");
    let ct = String::from_utf8(pkg.part("[Content_Types].xml").unwrap().to_vec()).unwrap();
    assert!(ct.to_ascii_lowercase().contains(r#"extension="xlsx""#));
    let again = open(&out.bytes);
    let book = &again.books[BARE];
    assert_eq!(book.origin(), Origin::Embedded);
    assert_eq!(book.series()[0].values.as_ref().unwrap()[0], Some(7.0));
}
