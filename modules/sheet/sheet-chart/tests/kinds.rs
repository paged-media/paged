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

#![allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)

//! Geometry snapshots, one per chart kind and per W4 feature: each fixture's
//! geometry JSON is compared with `tests/snapshots/<name>.json`. A change
//! that moves a chart shows up as a snapshot diff to review; re-record with
//! `UPDATE_SNAPSHOTS=1 cargo nextest run -p sheet-chart`. With
//! `PAGED_CHART_SVG=<dir>` every fixture is also written as an SVG for a
//! visual check.

use std::path::PathBuf;

use sheet_chart::model::*;
use sheet_chart::{generate, sparkline, ChartGeometry, PlotData, Primitive};
use sheet_core::{CellRef, RangeRef};

fn rr(c: u32) -> RangeRef {
    let cr = |row| CellRef {
        sheet: 0,
        row,
        col: c,
        row_abs: false,
        col_abs: false,
    };
    RangeRef {
        start: cr(0),
        end: cr(3),
    }
}

fn ser(name: &str, col: u32) -> Series {
    let mut s = Series::of(rr(col));
    s.name = Some(name.into());
    s
}

fn chart(kind: ChartKind, grouping: Grouping, n: usize) -> ChartModel {
    let series = (0..n)
        .map(|i| ser(&format!("S{}", i + 1), i as u32 + 1))
        .collect();
    let mut m = ChartModel::single(kind, grouping, series);
    m.title = Some(format!("{kind:?}").into());
    m.legend = Some(Legend::default());
    m.val_axis.major_gridlines = Some(LineStyle::default());
    m
}

fn cats(n: usize) -> Vec<String> {
    ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"][..n]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn data(series: Vec<Vec<f64>>) -> PlotData {
    let n = series.iter().map(Vec::len).max().unwrap_or(0);
    PlotData::of(series, cats(n.min(6)))
}

fn fixtures() -> Vec<(&'static str, ChartModel, PlotData)> {
    let two = || {
        data(vec![
            vec![10.0, 20.0, 30.0, 25.0],
            vec![15.0, 5.0, 12.0, 18.0],
        ])
    };
    let neg = || {
        data(vec![
            vec![10.0, -8.0, 30.0, 25.0],
            vec![-4.0, 5.0, 12.0, -6.0],
        ])
    };
    let mut v: Vec<(&'static str, ChartModel, PlotData)> = vec![
        (
            "column",
            chart(ChartKind::Column, Grouping::Standard, 2),
            two(),
        ),
        (
            "column-stacked",
            chart(ChartKind::Column, Grouping::Stacked, 2),
            neg(),
        ),
        (
            "column-percent",
            chart(ChartKind::Column, Grouping::PercentStacked, 2),
            two(),
        ),
        ("bar", chart(ChartKind::Bar, Grouping::Standard, 2), two()),
        (
            "bar-stacked",
            chart(ChartKind::Bar, Grouping::Stacked, 2),
            two(),
        ),
        ("line", chart(ChartKind::Line, Grouping::Standard, 2), two()),
        (
            "line-stacked",
            chart(ChartKind::Line, Grouping::Stacked, 2),
            two(),
        ),
        ("area", chart(ChartKind::Area, Grouping::Standard, 2), two()),
        (
            "area-percent",
            chart(ChartKind::Area, Grouping::PercentStacked, 2),
            two(),
        ),
        (
            "pie",
            chart(ChartKind::Pie, Grouping::Standard, 1),
            data(vec![vec![10.0, 20.0, 30.0]]),
        ),
        (
            "donut",
            chart(ChartKind::Donut, Grouping::Standard, 2),
            two(),
        ),
        (
            "radar",
            chart(ChartKind::Radar, Grouping::Standard, 2),
            two(),
        ),
        (
            "radar-filled",
            chart(ChartKind::FilledRadar, Grouping::Standard, 2),
            two(),
        ),
        (
            "pie-of-pie",
            chart(ChartKind::PieOfPie, Grouping::Standard, 1),
            data(vec![vec![40.0, 25.0, 20.0, 8.0, 5.0, 2.0]]),
        ),
        (
            "bar-of-pie",
            chart(ChartKind::BarOfPie, Grouping::Standard, 1),
            data(vec![vec![40.0, 25.0, 20.0, 8.0, 5.0, 2.0]]),
        ),
        (
            "surface",
            chart(ChartKind::Surface, Grouping::Standard, 3),
            data(vec![
                vec![1.0, 4.0, 2.0, 5.0],
                vec![3.0, 6.0, 4.0, 2.0],
                vec![2.0, 3.0, 7.0, 4.0],
            ]),
        ),
        (
            "waterfall",
            {
                let mut m = chart(ChartKind::Waterfall, Grouping::Standard, 1);
                m.plots[0].ex.subtotals = vec![4];
                m
            },
            PlotData::of(
                vec![vec![100.0, 30.0, -20.0, 15.0, 125.0]],
                ["Start", "A", "B", "C", "End"].map(String::from).to_vec(),
            ),
        ),
        (
            "funnel",
            chart(ChartKind::Funnel, Grouping::Standard, 1),
            PlotData::of(
                vec![vec![500.0, 320.0, 180.0, 60.0]],
                ["Leads", "Calls", "Offers", "Won"]
                    .map(String::from)
                    .to_vec(),
            ),
        ),
        (
            "histogram",
            chart(ChartKind::Histogram, Grouping::Standard, 1),
            PlotData::of(
                vec![vec![
                    1.0, 2.0, 2.5, 3.0, 3.2, 4.0, 4.1, 4.4, 5.0, 7.5, 8.0, 9.0,
                ]],
                Vec::new(),
            ),
        ),
        (
            "pareto",
            chart(ChartKind::Pareto, Grouping::Standard, 1),
            PlotData::of(
                vec![vec![12.0, 30.0, 5.0, 18.0, 30.0]],
                ["Late", "Damaged", "Lost", "Wrong", "Late"]
                    .map(String::from)
                    .to_vec(),
            ),
        ),
        (
            "box-whisker",
            chart(ChartKind::BoxWhisker, Grouping::Standard, 2),
            PlotData::of(
                vec![
                    vec![1.0, 3.0, 4.0, 5.0, 9.0, 2.0, 6.0, 7.0, 8.0, 30.0],
                    vec![2.0, 2.5, 3.0, 4.0, 6.0, 5.0, 5.5, 6.5, 7.0, 7.5],
                ],
                ["A", "A", "A", "A", "A", "B", "B", "B", "B", "B"]
                    .map(String::from)
                    .to_vec(),
            ),
        ),
        (
            "unsupported",
            {
                let mut m = chart(ChartKind::Unsupported, Grouping::Standard, 1);
                m.source = Some("cx:regionMap".into());
                m
            },
            data(vec![vec![1.0]]),
        ),
    ];
    // Scatter (two series with their own X), bubble, stock.
    let mut sc = chart(ChartKind::Scatter, Grouping::Standard, 2);
    sc.plots[0].series[0].line = Some(LineStyle {
        none: true,
        ..Default::default()
    });
    let mut scd = data(vec![vec![2.0, 4.0, 3.0, 7.0], vec![1.0, 3.0, 6.0, 8.0]]);
    scd.x_values = vec![
        Some(vec![1.0, 2.5, 4.0, 6.0]),
        Some(vec![0.5, 2.0, 3.0, 5.5]),
    ];
    scd.categories.clear();
    v.push(("scatter", sc, scd));
    let bu = chart(ChartKind::Bubble, Grouping::Standard, 1);
    let mut bud = data(vec![vec![2.0, 4.0, 3.0, 7.0]]);
    bud.x_values = vec![Some(vec![1.0, 2.0, 3.0, 4.0])];
    bud.sizes = vec![Some(vec![10.0, 40.0, 20.0, 5.0])];
    v.push(("bubble", bu, bud));
    let st = chart(ChartKind::Stock, Grouping::Standard, 4);
    v.push((
        "stock-ohlc",
        st,
        data(vec![
            vec![20.0, 24.0, 22.0, 27.0],
            vec![26.0, 27.0, 28.0, 30.0],
            vec![18.0, 21.0, 20.0, 24.0],
            vec![24.0, 22.0, 27.0, 28.0],
        ]),
    ));
    let st3 = chart(ChartKind::Stock, Grouping::Standard, 3);
    v.push((
        "stock-hlc",
        st3,
        data(vec![
            vec![26.0, 27.0, 28.0, 30.0],
            vec![18.0, 21.0, 20.0, 24.0],
            vec![24.0, 22.0, 27.0, 28.0],
        ]),
    ));
    // Treemap / sunburst over a two-level hierarchy.
    let mut hd = PlotData::of(vec![vec![10.0, 5.0, 8.0, 3.0, 6.0, 4.0]], Vec::new());
    hd.category_levels = vec![
        ["Fruit", "", "", "Veg", "", ""].map(String::from).to_vec(),
        ["Apple", "Pear", "Plum", "Leek", "Kale", "Bean"]
            .map(String::from)
            .to_vec(),
    ];
    hd.categories = hd.category_levels[1].clone();
    v.push((
        "treemap",
        chart(ChartKind::Treemap, Grouping::Standard, 1),
        hd.clone(),
    ));
    v.push((
        "sunburst",
        chart(ChartKind::Sunburst, Grouping::Standard, 1),
        hd,
    ));
    // A combo: stacked columns + a line on the secondary axis.
    let mut combo = chart(ChartKind::Column, Grouping::Stacked, 2);
    let mut line = ser("Margin", 3);
    line.kind = Some(ChartKind::Line);
    line.secondary = true;
    let series: Vec<Series> = combo.series().cloned().chain([line]).collect();
    combo.set_series(series, ChartKind::Column, Grouping::Stacked);
    combo.sec_val_axis = Some(Axis {
        format: Some("0%".into()),
        ..Axis::default()
    });
    v.push((
        "combo-secondary",
        combo,
        data(vec![
            vec![10.0, 20.0, 30.0, 25.0],
            vec![15.0, 5.0, 12.0, 18.0],
            vec![0.12, 0.18, 0.15, 0.22],
        ]),
    ));
    // Features: markers, labels, trendlines, error bars, log axis, legend
    // positions, style refs.
    let mut feat = chart(ChartKind::Line, Grouping::Standard, 1);
    feat.plots[0].series[0].marker = Some(Marker {
        symbol: MarkerSymbol::Circle,
        size: 6.0,
        ..Default::default()
    });
    feat.plots[0].series[0].labels = Some(DataLabels {
        show_value: true,
        position: Some(LabelPosition::Top),
        ..Default::default()
    });
    let mut tl = Trendline::of(TrendKind::Linear);
    tl.display_equation = true;
    tl.display_r2 = true;
    tl.forward = 1.0;
    feat.plots[0].series[0].trendlines = vec![tl];
    feat.plots[0].series[0].error_bars = vec![ErrorBars {
        along_x: false,
        bar_type: ErrorBarType::Both,
        value: ErrorValue::Percentage(10.0),
        no_end_cap: false,
        line: None,
    }];
    feat.legend = Some(Legend {
        position: LegendPosition::Bottom,
        ..Default::default()
    });
    v.push(("line-features", feat, data(vec![vec![3.0, 5.0, 4.0, 8.0]])));
    let mut log = chart(ChartKind::Column, Grouping::Standard, 1);
    log.val_axis.log_base = Some(10.0);
    log.legend = Some(Legend {
        position: LegendPosition::Top,
        ..Default::default()
    });
    v.push((
        "column-log",
        log,
        data(vec![vec![3.0, 40.0, 700.0, 9000.0]]),
    ));
    let mut refs = chart(ChartKind::Column, Grouping::Standard, 2);
    refs.plots[0].series[0].fill =
        Some(color_rgb(0x00A0E0).with_doc(doc_swatch("Color/Brand Blue", 0x00A0E0)));
    refs.title_style.doc_para_style = Some("ParagraphStyle/Chart Title".into());
    refs.plots[0].labels = Some(DataLabels {
        show_value: true,
        ..Default::default()
    });
    refs.plot_area.fill = Some(color_scheme(3, 0.0).with_doc(doc_swatch("Color/Paper", 0xE7E6E6)));
    v.push(("column-style-refs", refs, two()));
    v
}

fn snapshots() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots")
}

fn svg(g: &ChartGeometry) -> String {
    let mut s = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><rect width="100%" height="100%" fill="white"/>"#,
        w = g.width_pt,
        h = g.height_pt
    );
    let pts = |p: &[(f64, f64)]| {
        p.iter()
            .map(|(x, y)| format!("{x:.2},{y:.2}"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let paint = |c: &Option<String>| c.clone().unwrap_or_else(|| "none".into());
    for p in &g.prims {
        match p {
            Primitive::Rect { x, y, w, h, fill, stroke, stroke_w, .. } => s.push_str(&format!(
                r#"<rect x="{x:.2}" y="{y:.2}" width="{w:.2}" height="{h:.2}" fill="{}" stroke="{}" stroke-width="{stroke_w}"/>"#,
                paint(fill), paint(stroke)
            )),
            Primitive::Line { pts: p, stroke, stroke_w, dash, .. } => s.push_str(&format!(
                r#"<polyline points="{}" fill="none" stroke="{stroke}" stroke-width="{stroke_w}"{}/>"#,
                pts(p),
                if dash.is_some() { r#" stroke-dasharray="2,2""# } else { "" }
            )),
            Primitive::Polygon { pts: p, fill, stroke, stroke_w, .. } => s.push_str(&format!(
                r#"<polygon points="{}" fill="{}" stroke="{}" stroke-width="{stroke_w}"/>"#,
                pts(p), paint(fill), paint(stroke)
            )),
            Primitive::Wedge { cx, cy, r, start_deg, end_deg, fill, stroke, inner_r, .. } => {
                let at = |rad: f64, d: f64| {
                    let a = d.to_radians();
                    (cx + rad * a.sin(), cy - rad * a.cos())
                };
                let large = if end_deg - start_deg > 180.0 { 1 } else { 0 };
                let full = end_deg - start_deg >= 359.999;
                let (e0, e1) = if full { (*start_deg, end_deg - 0.01) } else { (*start_deg, *end_deg) };
                let (ax, ay) = at(*r, e0);
                let (bx, by) = at(*r, e1);
                let d = match inner_r {
                    Some(ir) => {
                        let (cx2, cy2) = at(*ir, e1);
                        let (dx, dy) = at(*ir, e0);
                        format!("M{ax},{ay} A{r},{r} 0 {large} 1 {bx},{by} L{cx2},{cy2} A{ir},{ir} 0 {large} 0 {dx},{dy} Z")
                    }
                    None => format!("M{cx},{cy} L{ax},{ay} A{r},{r} 0 {large} 1 {bx},{by} Z"),
                };
                s.push_str(&format!(r#"<path d="{d}" fill="{}" stroke="{}" stroke-width="0.75"/>"#, paint(fill), paint(stroke)));
            }
            Primitive::Text { x, y, s: t, size_pt, anchor, color, bold, .. } => {
                let a = match anchor {
                    sheet_chart::TextAnchor::Start => "start",
                    sheet_chart::TextAnchor::Middle => "middle",
                    sheet_chart::TextAnchor::End => "end",
                };
                let t = t.replace('&', "&amp;").replace('<', "&lt;");
                s.push_str(&format!(
                    r#"<text x="{x:.2}" y="{y:.2}" font-size="{size_pt}" font-family="Helvetica" text-anchor="{a}" fill="{}"{}>{t}</text>"#,
                    color.clone().unwrap_or_else(|| "#595959".into()),
                    if *bold { r#" font-weight="bold""# } else { "" }
                ));
            }
        }
    }
    s.push_str("</svg>");
    s
}

#[test]
fn every_kind_matches_its_snapshot__feat__sheet_chart_kinds() {
    let update = std::env::var_os("UPDATE_SNAPSHOTS").is_some();
    let svg_dir = std::env::var_os("PAGED_CHART_SVG").map(PathBuf::from);
    let mut failed = Vec::new();
    for (name, model, data) in fixtures() {
        let g = generate(&model, &data, 360.0, 240.0);
        assert!(!g.prims.is_empty(), "{name} draws nothing");
        // Deterministic.
        assert_eq!(g, generate(&model, &data, 360.0, 240.0), "{name}");
        // Everything inside the chart box.
        for p in &g.prims {
            let inside =
                |x: f64, y: f64| (-1.0..=361.0).contains(&x) && (-1.0..=241.0).contains(&y);
            match p {
                Primitive::Rect { x, y, w, h, .. } => {
                    assert!(inside(*x, *y) && inside(x + w, y + h), "{name}: {p:?}")
                }
                Primitive::Line { pts, .. } | Primitive::Polygon { pts, .. } => {
                    assert!(pts.iter().all(|(x, y)| inside(*x, *y)), "{name}: {p:?}")
                }
                _ => {}
            }
        }
        let json = serde_json::to_string_pretty(&g).unwrap() + "\n";
        if let Some(dir) = &svg_dir {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(format!("{name}.svg")), svg(&g)).unwrap();
        }
        let path = snapshots().join(format!("{name}.json"));
        if update {
            std::fs::create_dir_all(snapshots()).unwrap();
            std::fs::write(&path, &json).unwrap();
        } else {
            match std::fs::read_to_string(&path) {
                Ok(want) if want == json => {}
                _ => failed.push(name),
            }
        }
    }
    assert!(
        failed.is_empty(),
        "geometry differs from the snapshot: {failed:?} (UPDATE_SNAPSHOTS=1 re-records)"
    );
}

fn texts(g: &ChartGeometry) -> Vec<String> {
    g.prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Text { s, .. } => Some(s.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn percent_stacked_columns_fill_the_axis__feat__sheet_chart_stacking() {
    let m = chart(ChartKind::Column, Grouping::PercentStacked, 2);
    let d = data(vec![vec![1.0, 3.0], vec![3.0, 1.0]]);
    let g = generate(&m, &d, 300.0, 200.0);
    let t = texts(&g);
    assert!(
        t.contains(&"100%".to_string()) && t.contains(&"0%".to_string()),
        "{t:?}"
    );
    // Each category's two segments together reach the 100% line.
    let bars: Vec<(f64, f64, f64)> = g
        .prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Rect {
                x,
                y,
                h,
                fill: Some(_),
                w,
                ..
            } if *w > 10.0 => Some((*x, *y, *h)),
            _ => None,
        })
        .collect();
    let first: f64 = bars
        .iter()
        .filter(|b| (b.0 - bars[0].0).abs() < 1e-6)
        .map(|b| b.2)
        .sum();
    let second: f64 = bars
        .iter()
        .filter(|b| (b.0 - bars[0].0).abs() > 1e-6)
        .map(|b| b.2)
        .sum();
    assert!((first - second).abs() < 1e-6, "{bars:?}");
}

#[test]
fn stacked_lines_accumulate__feat__sheet_chart_stacking() {
    let flat = generate(
        &chart(ChartKind::Line, Grouping::Standard, 2),
        &data(vec![vec![1.0, 1.0], vec![1.0, 1.0]]),
        300.0,
        200.0,
    );
    let stacked = generate(
        &chart(ChartKind::Line, Grouping::Stacked, 2),
        &data(vec![vec![1.0, 1.0], vec![1.0, 1.0]]),
        300.0,
        200.0,
    );
    let series_ys = |g: &ChartGeometry| -> Vec<f64> {
        g.prims
            .iter()
            .filter_map(|p| match p {
                Primitive::Line { pts, stroke_w, .. } if *stroke_w > 2.0 => Some(pts[0].1),
                _ => None,
            })
            .collect()
    };
    let f = series_ys(&flat);
    let s = series_ys(&stacked);
    assert_eq!(f.len(), 2);
    assert!((f[0] - f[1]).abs() < 1e-9, "unstacked lines coincide");
    assert!(s[1] < s[0], "the second stacked line sits above the first");
}

#[test]
fn style_refs_ride_beside_the_colour__feat__sheet_chart_style_roles() {
    let fx = fixtures();
    let (_, m, d) = fx.iter().find(|f| f.0 == "column-style-refs").unwrap();
    let g = generate(m, d, 360.0, 240.0);
    let json = serde_json::to_string(&g).unwrap();
    assert!(json.contains(r#""fillSwatchRef":"Color/Brand Blue""#));
    assert!(json.contains(r#""fillSwatchRef":"Color/Paper""#));
    assert!(json.contains(r##""fill":"#00A0E0""##));
    assert!(json.contains(r#""paragraphStyle":"ParagraphStyle/Chart Title""#));
    // A chart without references serialises without the optional fields.
    let plain = generate(
        &chart(ChartKind::Column, Grouping::Standard, 1),
        &data(vec![vec![1.0, 2.0]]),
        300.0,
        200.0,
    );
    let pj = serde_json::to_string(&plain).unwrap();
    assert!(!pj.contains("SwatchRef") && !pj.contains("innerR") && !pj.contains("flattened3d"));
}

#[test]
fn donut_rings_are_ring_segments__feat__sheet_chart_kinds() {
    let g = generate(
        &chart(ChartKind::Donut, Grouping::Standard, 2),
        &data(vec![vec![1.0, 1.0], vec![1.0, 3.0]]),
        300.0,
        200.0,
    );
    let rings: Vec<(f64, f64)> = g
        .prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Wedge {
                r,
                inner_r: Some(i),
                ..
            } => Some((*i, *r)),
            _ => None,
        })
        .collect();
    assert_eq!(
        rings.len(),
        4,
        "two rings of two segments, no page-white disc"
    );
    assert!(
        rings[2].0 >= rings[0].1 - 1e-9,
        "the second ring sits outside the first"
    );
}

#[test]
fn flattened_3d_is_flagged__feat__sheet_chart_kinds() {
    let mut m = chart(ChartKind::Pie, Grouping::Standard, 1);
    m.flattened_3d = true;
    let g = generate(&m, &data(vec![vec![1.0, 2.0]]), 300.0, 200.0);
    assert!(g.flattened_3d);
    assert!(serde_json::to_string(&g)
        .unwrap()
        .contains(r#""flattened3d":true"#));
}

#[test]
fn empty_data_never_panics__feat__sheet_chart_kinds() {
    for (name, model, _) in fixtures() {
        for (w, h) in [(0.0, 0.0), (20.0, 10.0), (360.0, 240.0)] {
            let g = generate(&model, &PlotData::default(), w, h);
            assert_eq!(g.width_pt, w, "{name}");
        }
    }
}

#[test]
fn sparklines_draw_in_their_cell__feat__sheet_chart_sparklines() {
    let g = SparklineGroup {
        kind: SparklineKind::Column,
        show_negative: true,
        negative: Some(color_rgb(0xFF0000)),
        ..Default::default()
    };
    let prims = sparkline(&g, &[1.0, -1.0, 2.0], 40.0, 12.0, None);
    assert_eq!(prims.len(), 3);
    let fills: Vec<String> = prims
        .iter()
        .filter_map(|p| match p {
            Primitive::Rect { fill, .. } => fill.clone(),
            _ => None,
        })
        .collect();
    assert_eq!(fills[1], "#FF0000");
}

#[test]
fn a_chart_without_series_still_draws_its_axes__feat__sheet_chart_kinds() {
    let mut m = ChartModel::single(ChartKind::Column, Grouping::Stacked, Vec::new());
    m.val_axis.major_gridlines = Some(LineStyle::default());
    let g = generate(&m, &PlotData::default(), 360.0, 240.0);
    assert!(!g.prims.is_empty(), "{g:?}");
}
