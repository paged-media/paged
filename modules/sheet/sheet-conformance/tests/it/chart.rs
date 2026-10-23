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

//! Chart conformance (M2 charts track, spec §8.4). Test-fn names are the
//! registry pointers for `registry/features/chart.yaml` (the coverage gate
//! greps these prefixes). Covers: the frozen chart MODEL, the XLSX chart-part
//! parse + round-trip preservation (`corpus/xlsx-corpus/09-chart.xlsx`), the
//! pure geometry generator for every curated kind, the geometry IR wire shape
//! the paged.draw TS lowering consumes, the grid-view projection (the same
//! generator), and live-to-recalc regeneration.
//!
//! The geometry generator is PURE Rust (`sheet_chart::generate`); its
//! `paged.draw` LOWERING half is the TS `chartGeometryToMutations`
//! (`packages/sheet-host-model/test/chart.spec.ts`, the registry's vitest
//! pointer). This file proves the Rust contract that lowering translates.

use std::path::PathBuf;

use sheet_chart::model::{ChartKind, ChartModel, ColorRef, Grouping, Legend, Series};
use sheet_chart::{generate, ChartGeometry, PlotData, Primitive};
use sheet_core::{CellRef, RangeRef};
use sheet_js::core::SheetSession;
use sheet_xlsx::XlsxDocument;

// ── fixtures ────────────────────────────────────────────────────────────────

/// Path to `corpus/xlsx-corpus/` (sibling of the conformance crate).
fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("corpus")
        .join("xlsx-corpus")
}

fn load(name: &str) -> Vec<u8> {
    let p = corpus_dir().join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read fixture {}: {e}", p.display()))
}

/// A `RangeRef` on sheet 0 from 0-based corners.
fn rr(r0: u32, c0: u32, r1: u32, c1: u32) -> RangeRef {
    let cr = |row, col| CellRef {
        sheet: 0,
        row,
        col,
        row_abs: false,
        col_abs: false,
    };
    RangeRef {
        start: cr(r0, c0),
        end: cr(r1, c1),
    }
}

fn count<F: Fn(&Primitive) -> bool>(g: &ChartGeometry, f: F) -> usize {
    g.prims.iter().filter(|p| f(p)).count()
}

// ── sheet.chart.model ───────────────────────────────────────────────────────

/// The chart MODEL: plots (kind, grouping, series bound to ranges), axes,
/// legend. A model is the IR the geometry generator projects.
#[test]
fn sheet_chart_model() {
    let mut s = Series::of(rr(1, 1, 3, 1));
    s.name = Some("Revenue".into());
    s.categories = Some(rr(1, 0, 3, 0));
    s.fill = ColorRef::from_hex("#3366CC");
    let mut m = ChartModel::single(ChartKind::Column, Grouping::Standard, vec![s]);
    m.title = Some("Q1 Revenue".into());
    m.val_axis.title = Some("EUR".into());
    m.val_axis.min = Some(0.0);
    m.legend = Some(Legend::default());
    assert_eq!(m.kind(), ChartKind::Column);
    assert_eq!(m.series_count(), 1);
    let s = m.series().next().unwrap();
    assert_eq!(s.values.rows(), 3);
    assert_eq!(s.fill, Some(sheet_chart::model::color_rgb(0x3366CC)));
    assert!(m.legend.is_some());
    assert_eq!(m.val_axis.min, Some(0.0));
}

// ── sheet.chart.xlsx-part ───────────────────────────────────────────────────

/// The XLSX chart part parses into the chart model through the
/// worksheet→drawing→chart chain; the parts stay OPAQUE so a zero-edit
/// round-trip is byte-identical (preservation invariant).
#[test]
fn sheet_chart_xlsx_part() {
    let doc = XlsxDocument::open(&load("09-chart.xlsx")).expect("open 09-chart");
    assert_eq!(
        doc.charts.len(),
        1,
        "one chart discovered via the rels chain"
    );
    let chart = &doc.charts[0];
    assert_eq!(chart.host_sheet, 0, "anchored to Sheet1");
    assert_eq!(chart.part.as_deref(), Some("xl/charts/chart1.xml"));

    let m = &chart.model;
    assert_eq!(m.kind(), ChartKind::Column);
    assert_eq!(m.title.as_deref(), Some("Q1 Revenue"));
    assert!(m.legend.is_some(), "the <c:legend> is present");
    assert_eq!(m.series_count(), 1);
    let s = m.series().next().unwrap();
    assert_eq!(s.name.as_deref(), Some("Revenue"));
    assert_eq!(s.fill, Some(sheet_chart::model::color_rgb(0x3366CC)));
    assert_eq!(
        (s.values.start.row, s.values.start.col, s.values.end.row),
        (1, 1, 3)
    );
    let cats = s.categories.expect("categories range");
    assert_eq!((cats.start.col, cats.end.row), (0, 3));

    let out = doc.save().expect("save");
    let orig = unzip(&load("09-chart.xlsx"));
    let saved = unzip(&out);
    for part in ["xl/charts/chart1.xml", "xl/drawings/drawing1.xml"] {
        let a = orig.iter().find(|(n, _)| n == part).map(|(_, b)| b);
        let b = saved.iter().find(|(n, _)| n == part).map(|(_, b)| b);
        assert_eq!(a, b, "{part} must round-trip byte-identical (preservation)");
    }
    let doc2 = XlsxDocument::open(&out).expect("reopen saved 09-chart");
    assert_eq!(doc2.charts.len(), 1);
    assert_eq!(doc2.charts[0].model.kind(), ChartKind::Column);
}

/// Unzip a package to `(name, bytes)` (skips dirs).
fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("valid zip");
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        if f.is_dir() {
            continue;
        }
        let name = f.name().unwrap().into_owned();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        out.push((name, data));
    }
    out
}

// ── sheet.chart.geometry.* ──────────────────────────────────────────────────

/// A 3-category, single-series model + its resolved data (10, 20, 30).
fn three_value_model(kind: ChartKind, grouping: Grouping) -> (ChartModel, PlotData) {
    let mut s = Series::of(rr(1, 1, 3, 1));
    s.name = Some("S".into());
    s.categories = Some(rr(1, 0, 3, 0));
    s.fill = ColorRef::from_hex("#4E79A7");
    let model = ChartModel::single(kind, grouping, vec![s]);
    let data = PlotData::of(
        vec![vec![10.0, 20.0, 30.0]],
        vec!["Q1".into(), "Q2".into(), "Q3".into()],
    );
    (model, data)
}

/// Bar/column geometry: one bar Rect per (series, category) carrying the
/// series' colour, the category axis rule, and labels.
#[test]
fn sheet_chart_geometry_bar_column() {
    for kind in [ChartKind::Column, ChartKind::Bar] {
        let (model, data) = three_value_model(kind, Grouping::Standard);
        let g = generate(&model, &data, 300.0, 200.0);
        assert_eq!(
            count(&g, |p| matches!(p, Primitive::Rect { .. })),
            3,
            "{kind:?}: 3 bars"
        );
        assert_eq!(
            count(&g, |p| matches!(p, Primitive::Line { .. })),
            1,
            "{kind:?}: the category axis rule"
        );
        let colored = g
            .prims
            .iter()
            .filter(|p| matches!(p, Primitive::Rect { fill: Some(f), .. } if f == "#4E79A7"))
            .count();
        assert_eq!(colored, 3, "{kind:?}: bars use the series colour");
    }
}

/// Line/area geometry: a polyline per series; area fills a closed polygon.
#[test]
fn sheet_chart_geometry_line_area() {
    let (mut line_model, data) = three_value_model(ChartKind::Line, Grouping::Standard);
    line_model.plots[0].series[0].marker = Some(sheet_chart::Marker {
        symbol: sheet_chart::MarkerSymbol::None,
        ..Default::default()
    });
    let gl = generate(&line_model, &data, 300.0, 200.0);
    // The axis rule + the series polyline; no fill polygon.
    assert_eq!(count(&gl, |p| matches!(p, Primitive::Line { .. })), 2);
    assert_eq!(count(&gl, |p| matches!(p, Primitive::Polygon { .. })), 0);

    let (area_model, data) = three_value_model(ChartKind::Area, Grouping::Standard);
    let ga = generate(&area_model, &data, 300.0, 200.0);
    assert_eq!(count(&ga, |p| matches!(p, Primitive::Polygon { .. })), 1);
}

/// Pie/donut geometry: one Wedge per slice with proportional angles; a donut
/// is ring segments (an inner radius), not a pie under a page-white disc.
#[test]
fn sheet_chart_geometry_pie_donut() {
    let (pie_model, data) = three_value_model(ChartKind::Pie, Grouping::Standard);
    let gp = generate(&pie_model, &data, 200.0, 200.0);
    let wedges: Vec<(f64, f64)> = gp
        .prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Wedge {
                start_deg, end_deg, ..
            } => Some((*start_deg, *end_deg)),
            _ => None,
        })
        .collect();
    assert_eq!(wedges.len(), 3, "pie: one wedge per slice");
    assert!((wedges[0].1 - 60.0).abs() < 1e-6);
    assert!((wedges[2].1 - 360.0).abs() < 1e-6, "full sweep");

    let (donut_model, data) = three_value_model(ChartKind::Donut, Grouping::Standard);
    let gd = generate(&donut_model, &data, 200.0, 200.0);
    let rings = count(
        &gd,
        |p| matches!(p, Primitive::Wedge { inner_r: Some(r), .. } if *r > 0.0),
    );
    assert_eq!(rings, 3);
    assert_eq!(
        count(&gd, |p| matches!(p, Primitive::Wedge { .. })),
        3,
        "no hole disc"
    );
}

/// Scatter geometry: a marker per (x, y) point; X from the series' own X
/// range, several series each with their own.
#[test]
fn sheet_chart_geometry_scatter() {
    let mut a = Series::of(rr(0, 1, 2, 1));
    a.x_values = Some(rr(0, 0, 2, 0));
    a.line = Some(sheet_chart::model::LineStyle {
        none: true,
        ..Default::default()
    });
    a.marker = Some(sheet_chart::Marker {
        symbol: sheet_chart::MarkerSymbol::Diamond,
        ..Default::default()
    });
    let mut b = a.clone();
    b.values = rr(0, 2, 2, 2);
    let model = ChartModel::single(ChartKind::Scatter, Grouping::Standard, vec![a, b]);
    let mut data = PlotData::of(vec![vec![4.0, 5.0, 6.0], vec![1.0, 2.0, 3.0]], vec![]);
    data.x_values = vec![Some(vec![1.0, 2.0, 3.0]), Some(vec![1.5, 2.5, 3.5])];
    let g = generate(&model, &data, 300.0, 200.0);
    assert_eq!(
        count(&g, |p| matches!(p, Primitive::Polygon { .. })),
        6,
        "a marker per point, both series"
    );
}

/// Stacked geometry (`sheet.chart.geometry.stacked`, Excel's rule since W4):
/// the segments share one bar per category; positive values stack up,
/// negative down; percent-stacked fills 100%.
#[test]
fn sheet_chart_geometry_stacked() {
    let (mut model, _) = three_value_model(ChartKind::Column, Grouping::Stacked);
    let mut s2 = Series::of(rr(1, 2, 3, 2));
    s2.fill = ColorRef::from_hex("#F28E2B");
    model.plots[0].series.push(s2);
    let data = PlotData::of(
        vec![vec![10.0, 20.0, 30.0], vec![5.0, 10.0, 15.0]],
        vec!["Q1".into(), "Q2".into(), "Q3".into()],
    );
    let gc = generate(&model, &data, 300.0, 200.0);
    let rects: Vec<(f64, f64, f64, f64)> = gc
        .prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Rect { x, y, w, h, .. } if *w > 8.0 => Some((*x, *y, *w, *h)),
            _ => None,
        })
        .collect();
    assert_eq!(rects.len(), 6, "one Rect per (series, category)");
    // Series 0 then series 1, category by category within each series.
    let (q1a, q1b) = (rects[0], rects[3]);
    assert!((q1a.0 - q1b.0).abs() < 1e-6, "shared x");
    assert!((q1a.2 - q1b.2).abs() < 1e-6, "shared width");
    assert!(((q1b.1 + q1b.3) - q1a.1).abs() < 1e-6, "stacks");
    let q3 = rects[2].3 + rects[5].3;
    let q1 = q1a.3 + q1b.3;
    assert!((q3 / q1 - 3.0).abs() < 1e-6, "45/15 of the stack height");

    model.plots[0].kind = ChartKind::Bar;
    let gb = generate(&model, &data, 300.0, 200.0);
    let bars: Vec<(f64, f64, f64, f64)> = gb
        .prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Rect { x, y, w, h, .. } if *h > 8.0 => Some((*x, *y, *w, *h)),
            _ => None,
        })
        .collect();
    assert_eq!(bars.len(), 6);
    assert!((bars[0].1 - bars[3].1).abs() < 1e-6, "shared y");
    assert!(
        ((bars[0].0 + bars[0].2) - bars[3].0).abs() < 1e-6,
        "runs right"
    );
}

/// Radar geometry: a polar grid, one spoke per category, a closed outline
/// per series.
#[test]
fn sheet_chart_geometry_radar() {
    let (mut model, data) = three_value_model(ChartKind::Radar, Grouping::Standard);
    model.plots[0].series[0].marker = Some(sheet_chart::Marker {
        symbol: sheet_chart::MarkerSymbol::None,
        ..Default::default()
    });
    let g = generate(&model, &data, 300.0, 240.0);
    assert_eq!(count(&g, |p| matches!(p, Primitive::Polygon { .. })), 0);
    assert_eq!(count(&g, |p| matches!(p, Primitive::Wedge { .. })), 0);
    let lines: Vec<&Vec<(f64, f64)>> = g
        .prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Line { pts, .. } => Some(pts),
            _ => None,
        })
        .collect();
    let series = lines[lines.len() - 1];
    assert_eq!(series.len(), 4);
    assert_eq!(series[0], series[3], "the series outline closes");
    let spoke = lines[lines.len() - 2];
    let center = spoke[0];
    let radius = |p: (f64, f64)| (p.0 - center.0).hypot(p.1 - center.1);
    assert!(radius(series[0]) < radius(series[1]) && radius(series[1]) < radius(series[2]));
    assert!(
        (radius(series[0]) * 3.0 - radius(series[2])).abs() < 1e-6,
        "10 at a third of 30"
    );
}

/// Axis titles (`sheet.chart.axis-titles`): drawn on every cartesian kind;
/// the Bar family transposes which runs along the bottom.
#[test]
fn sheet_chart_axis_titles() {
    for (kind, grouping) in [
        (ChartKind::Column, Grouping::Standard),
        (ChartKind::Bar, Grouping::Standard),
        (ChartKind::Column, Grouping::Stacked),
        (ChartKind::Bar, Grouping::Stacked),
        (ChartKind::Line, Grouping::Standard),
        (ChartKind::Area, Grouping::Standard),
        (ChartKind::Scatter, Grouping::Standard),
    ] {
        let (mut model, data) = three_value_model(kind, grouping);
        model.cat_axis.title = Some("Quarter".into());
        model.val_axis.title = Some("EUR".into());
        let titled = generate(&model, &data, 300.0, 200.0);
        let labels: Vec<&str> = titled
            .prims
            .iter()
            .filter_map(|p| match p {
                Primitive::Text { s, .. } => Some(s.as_str()),
                _ => None,
            })
            .collect();
        assert!(labels.contains(&"Quarter"), "{kind:?}");
        assert!(labels.contains(&"EUR"), "{kind:?}");
    }
}

// ── sheet.chart.xlsx.grouping ───────────────────────────────────────────────

/// `c:grouping` selects the grouping on bars, lines and areas, and every
/// plot element maps to its own kind (never a silent column).
#[test]
fn sheet_chart_xlsx_grouping() {
    use sheet_xlsx::parts::chart::{parse, SheetResolver};
    struct NoNames;
    impl SheetResolver for NoNames {
        fn resolve(&self, _: &str) -> Option<u16> {
            Some(0)
        }
    }
    let plot = |body: &str| {
        let xml = format!(
            r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea>{body}</c:plotArea></c:chart></c:chartSpace>"#
        );
        let m = parse(xml.as_bytes(), 0, &NoNames).expect("parse").model;
        (m.kind(), m.grouping())
    };
    let ser = r#"<c:ser><c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser>"#;
    let bar = |dir: &str, g: &str| {
        plot(&format!(
            r#"<c:barChart><c:barDir val="{dir}"/><c:grouping val="{g}"/>{ser}</c:barChart>"#
        ))
    };
    assert_eq!(
        bar("col", "clustered"),
        (ChartKind::Column, Grouping::Standard)
    );
    assert_eq!(
        bar("col", "stacked"),
        (ChartKind::Column, Grouping::Stacked)
    );
    assert_eq!(
        bar("col", "percentStacked"),
        (ChartKind::Column, Grouping::PercentStacked)
    );
    assert_eq!(bar("bar", "stacked"), (ChartKind::Bar, Grouping::Stacked));
    assert_eq!(
        plot(&format!("<c:radarChart>{ser}</c:radarChart>")).0,
        ChartKind::Radar
    );
    assert_eq!(
        plot(&format!(
            r#"<c:lineChart><c:grouping val="stacked"/>{ser}</c:lineChart>"#
        )),
        (ChartKind::Line, Grouping::Stacked)
    );
}

/// The showcase kind battery: `annual-charts.xlsx` carries ten charts and
/// the importer reads each kind from its encoding.
#[test]
fn sheet_chart_xlsx_part_kind_battery() {
    let doc = XlsxDocument::open(&load("annual-charts.xlsx")).expect("open annual-charts");
    let kinds: Vec<(ChartKind, Grouping)> = doc
        .charts
        .iter()
        .map(|c| (c.model.kind(), c.model.grouping()))
        .collect();
    assert_eq!(
        kinds,
        [
            (ChartKind::Column, Grouping::Standard),
            (ChartKind::Bar, Grouping::Standard),
            (ChartKind::Column, Grouping::Stacked),
            (ChartKind::Bar, Grouping::Stacked),
            (ChartKind::Line, Grouping::Standard),
            (ChartKind::Area, Grouping::Standard),
            (ChartKind::Pie, Grouping::Standard),
            (ChartKind::Donut, Grouping::Standard),
            (ChartKind::Scatter, Grouping::Standard),
            (ChartKind::Radar, Grouping::Standard),
        ],
        "ten charts in drawing-rel order"
    );
    for c in &doc.charts {
        assert!(
            c.model.series_count() > 0,
            "{:?} has series",
            c.model.kind()
        );
    }
    let scatter = &doc.charts[8].model;
    let s = scatter.series().next().unwrap();
    assert!(
        s.x_values.is_some(),
        "scatter keeps its X range beside the values"
    );
}

// ── sheet.chart.lower.paged-draw ────────────────────────────────────────────

/// The geometry IR serializes to the camelCase wire shape the TS lowering
/// consumes.
#[test]
fn sheet_chart_lower_paged_draw() {
    let (model, data) = three_value_model(ChartKind::Pie, Grouping::Standard);
    let g = generate(&model, &data, 200.0, 200.0);
    let json = serde_json::to_value(&g).expect("serialize geometry");
    assert_eq!(json["widthPt"], 200.0);
    assert_eq!(json["heightPt"], 200.0);
    let prims = json["prims"].as_array().expect("prims array");
    let wedge = prims
        .iter()
        .find(|p| p["kind"] == "wedge")
        .expect("a wedge prim");
    assert!(wedge.get("startDeg").is_some() && wedge.get("endDeg").is_some());
    let (bar_model, bar_data) = three_value_model(ChartKind::Column, Grouping::Standard);
    let bjson = serde_json::to_value(generate(&bar_model, &bar_data, 300.0, 200.0)).unwrap();
    let rect = bjson["prims"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["kind"] == "rect")
        .expect("a rect prim");
    assert!(rect.get("strokeW").is_some() && rect.get("fill").is_some());
}

// ── sheet.chart.grid-view ───────────────────────────────────────────────────

/// The grid view and the page draw the same generator's IR, resolved
/// against the live model.
#[test]
fn sheet_chart_grid_view() {
    let session = SheetSession::load_xlsx(&load("09-chart.xlsx")).expect("load 09-chart");
    let charts = session.list_charts();
    assert_eq!(charts.len(), 1);
    assert_eq!(charts[0].kind, "column");
    assert_eq!(charts[0].series_count, 1);
    assert_eq!(charts[0].title.as_deref(), Some("Q1 Revenue"));
    assert!(!charts[0].flattened3d);
    let g = session
        .get_chart_geometry(0, 300.0, 200.0)
        .expect("geometry");
    let bars = count(&g, |p| matches!(p, Primitive::Rect { w, .. } if *w > 7.5));
    assert_eq!(bars, 3, "3 bars for the 3 resolved values");
    assert!(session.get_chart_geometry(9, 100.0, 100.0).is_err());
}

// ── sheet.chart.recalc-live ─────────────────────────────────────────────────

/// Charts are LIVE to recalculation.
#[test]
fn sheet_chart_recalc_live() {
    let mut session = SheetSession::load_xlsx(&load("09-chart.xlsx")).expect("load 09-chart");
    let before = session.get_chart_geometry(0, 300.0, 200.0).expect("geom");
    session.set_cell(0, 3, 1, "100").expect("set B4");
    let after = session.get_chart_geometry(0, 300.0, 200.0).expect("geom2");
    assert_ne!(before, after, "chart geometry tracks recalculated values");
    // 100 now dominates: the tallest bar is far taller than the next one.
    let mut hs: Vec<f64> = after
        .prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Rect { w, h, .. } if *w > 7.5 => Some(*h),
            _ => None,
        })
        .collect();
    hs.sort_by(|a, b| b.total_cmp(a));
    assert!(hs[0] > hs[1] * 4.0, "{hs:?}");
}

// ── sheet.chart.authoring ───────────────────────────────────────────────────

/// AUTHOR a chart over live data: add_chart builds a model the same
/// generator serves.
#[test]
fn sheet_chart_authoring_add_chart_generates() {
    let mut session = SheetSession::load_xlsx(&load("09-chart.xlsx")).expect("load 09-chart");
    let before = session.list_charts().len();
    let idx = session
        .add_chart(0, "B2:C4", "A2:A4", "line", "Authored", "columns")
        .expect("author a chart");
    assert_eq!(idx as usize, before, "appended at the end");
    let charts = session.list_charts();
    let authored = &charts[idx as usize];
    assert_eq!(authored.kind, "line");
    assert_eq!(authored.series_count, 2);
    assert_eq!(authored.title.as_deref(), Some("Authored"));
    let g = session
        .get_chart_geometry(idx, 300.0, 200.0)
        .expect("geometry");
    assert!(!g.prims.is_empty());
    assert!(session
        .add_chart(0, "B2:C4", "", "hexagon", "", "")
        .is_err());
    assert!(session.add_chart(9, "B2:C4", "", "line", "", "").is_err());
}

/// EVERY kind tag the engine advertises is authorable and renders
/// (`sheet.chart.kind-set`).
#[test]
fn sheet_chart_kind_set_every_advertised_kind_authors_and_renders() {
    use sheet_js::core::CHART_KIND_TAGS;
    for want in [
        "column",
        "stackedColumn",
        "bar",
        "stackedBar",
        "line",
        "area",
        "scatter",
        "pie",
        "radar",
        "bubble",
        "stock",
        "waterfall",
        "funnel",
        "treemap",
        "sunburst",
        "histogram",
        "pareto",
        "boxWhisker",
        "pieOfPie",
        "barOfPie",
        "filledRadar",
        "surface",
    ] {
        assert!(
            CHART_KIND_TAGS.contains(&want),
            "{want:?} is missing from the kind set"
        );
    }
    let mut session = SheetSession::load_xlsx(&load("09-chart.xlsx")).expect("load 09-chart");
    for tag in CHART_KIND_TAGS {
        let idx = session
            .add_chart(0, "B2:C4", "A2:A4", tag, "", "columns")
            .unwrap_or_else(|e| panic!("author {tag}: {e:?}"));
        assert_eq!(session.list_charts()[idx as usize].kind, *tag);
        let g = session
            .get_chart_geometry(idx, 320.0, 240.0)
            .unwrap_or_else(|e| panic!("geometry {tag}: {e:?}"));
        assert!(!g.prims.is_empty(), "{tag} draws primitives");
    }
}

/// TRANSPOSE ROWS/COLUMNS (`sheet.chart.series-orientation`).
#[test]
fn sheet_chart_series_orientation_transposes_rows_and_columns() {
    let mut session = SheetSession::load_xlsx(&load("09-chart.xlsx")).expect("load 09-chart");
    let by_col = session
        .add_chart(0, "B2:C4", "A2:A4", "column", "", "columns")
        .expect("columns");
    let by_row = session
        .add_chart(0, "B2:C4", "A2:A4", "column", "", "rows")
        .expect("rows");
    let charts = session.list_charts();
    assert_eq!(charts[by_col as usize].series_count, 2, "2 columns");
    assert_eq!(charts[by_row as usize].series_count, 3, "3 rows");
    let default = session
        .add_chart(0, "B2:C4", "A2:A4", "column", "", "")
        .expect("default");
    assert_eq!(session.list_charts()[default as usize].series_count, 2);
    let bars = |g: &ChartGeometry| count(g, |p| matches!(p, Primitive::Rect { w, .. } if *w > 8.0));
    // Column C of the fixture is empty: its cells are gaps (Excel draws no
    // bar for a blank), so only column B's three values draw.
    assert_eq!(
        bars(&session.get_chart_geometry(by_col, 300.0, 200.0).unwrap()),
        3
    );
    assert!(session
        .add_chart(0, "B2:C4", "", "column", "", "diagonal")
        .is_err());
}
