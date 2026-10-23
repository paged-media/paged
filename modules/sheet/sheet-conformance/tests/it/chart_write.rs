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

//! The chart writer (W4.3, ADR 519): authored charts are generated into the
//! package, edited charts spliced, deleted charts removed — and every chart
//! keeps its index across a save and reload.

use std::io::Read;

use sheet_js::core::{ChartPatch, SeriesArg, SheetSession, CHART_KIND_TAGS};

fn corpus(name: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../corpus/xlsx-corpus")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn part(bytes: &[u8], name: &str) -> Option<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut f = z.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn names(bytes: &[u8]) -> Vec<String> {
    let z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    z.file_names()
        .filter_map(|n| n.ok().map(|n| n.to_string()))
        .collect()
}

/// A session over a small block of numbers with labels.
fn data_session() -> SheetSession {
    let mut s = SheetSession::new();
    let rows = [
        ["", "North", "South", "East"],
        ["Q1", "10", "4", "3"],
        ["Q2", "20", "6", "5"],
        ["Q3", "15", "9", "4"],
        ["Q4", "25", "7", "6"],
    ];
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            if !v.is_empty() {
                s.set_cell(0, r as u32, c as u32, v).unwrap();
            }
        }
    }
    s
}

#[test]
fn every_authored_kind_is_written_and_reads_back__feat__sheet_chart_writer() {
    let mut s = data_session();
    for tag in CHART_KIND_TAGS {
        s.add_chart(0, "B2:D5", "A2:A5", tag, &format!("T {tag}"), "")
            .unwrap();
    }
    let before = s.list_charts();
    let bytes = s.save_xlsx().unwrap();
    // The package carries the parts, the drawing and its relationships.
    let all = names(&bytes);
    assert!(all.iter().any(|n| n == "xl/drawings/drawing1.xml"));
    assert!(all
        .iter()
        .any(|n| n == "xl/drawings/_rels/drawing1.xml.rels"));
    assert!(all.iter().any(|n| n.starts_with("xl/charts/chartEx")));
    let ws = part(&bytes, "xl/worksheets/sheet1.xml").unwrap();
    assert!(ws.contains("<drawing "), "the worksheet names its drawing");
    let ct = part(&bytes, "[Content_Types].xml").unwrap();
    assert!(ct.contains("drawingml.chart+xml") && ct.contains("chartex+xml"));
    // Reloaded: the same charts at the same indexes.
    let r = SheetSession::load_xlsx(&bytes).unwrap();
    let after = r.list_charts();
    assert_eq!(after.len(), before.len());
    for (a, b) in after.iter().zip(&before) {
        assert_eq!(
            (a.index, a.kind, a.series_count),
            (b.index, b.kind, b.series_count),
            "{}",
            b.kind
        );
        assert_eq!(a.title, b.title);
        assert!(r.get_chart_geometry(a.index, 300.0, 200.0).is_ok());
    }
    // A second save writes nothing new.
    let mut r = r;
    let again = r.save_xlsx().unwrap();
    assert_eq!(names(&again).len(), all.len());
}

#[test]
fn an_edited_chart_is_spliced__feat__sheet_chart_writer() {
    let bytes = corpus("09-chart.xlsx");
    let orig = part(&bytes, "xl/charts/chart1.xml").unwrap();
    let mut s = SheetSession::load_xlsx(&bytes).unwrap();
    s.update_chart(
        0,
        ChartPatch {
            title: Some(Some("Edited".into())),
            series: Some(vec![SeriesArg {
                values: "B2:B4".into(),
                categories: "A2:A4".into(),
                name: "Revenue".into(),
                color: "#00A0E0".into(),
                color_swatch: "Color/Brand".into(),
                ..Default::default()
            }]),
            value_axis_max: Some(Some(100.0)),
            ..Default::default()
        },
    )
    .unwrap();
    let out = s.save_xlsx().unwrap();
    let spliced = part(&out, "xl/charts/chart1.xml").unwrap();
    assert_ne!(orig, spliced);
    assert!(spliced.contains("Edited"));
    assert!(spliced.contains(r#"<a:srgbClr val="00A0E0"/>"#));
    assert!(
        spliced.contains("Color/Brand"),
        "the reference rides in the extension"
    );
    // What was not edited keeps its place: the plot element. The part named
    // axes it never defined; they are written now.
    assert_eq!(spliced.matches("<c:barChart>").count(), 1);
    assert!(spliced.contains("<c:catAx>") && spliced.contains("<c:valAx>"));
    let r = SheetSession::load_xlsx(&out).unwrap();
    let spec = &r.chart_specs()[0];
    assert_eq!(spec.title.as_deref(), Some("Edited"));
    assert_eq!(spec.value_axis_max, Some(100.0));
    assert_eq!(spec.series[0].color.as_deref(), Some("#00A0E0"));
    assert_eq!(spec.series[0].color_swatch.as_deref(), Some("Color/Brand"));
}

#[test]
fn a_kind_change_replaces_the_plot_element__feat__sheet_chart_writer() {
    let mut s = SheetSession::load_xlsx(&corpus("09-chart.xlsx")).unwrap();
    s.update_chart(
        0,
        ChartPatch {
            kind: Some("stackedLine".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let out = s.save_xlsx().unwrap();
    let x = part(&out, "xl/charts/chart1.xml").unwrap();
    assert!(x.contains("<c:lineChart>") && !x.contains("<c:barChart>"));
    let r = SheetSession::load_xlsx(&out).unwrap();
    assert_eq!(r.list_charts()[0].kind, "stackedLine");
    // To a pie: the axis family changes, the plot area is regenerated.
    let mut s = SheetSession::load_xlsx(&corpus("09-chart.xlsx")).unwrap();
    s.update_chart(
        0,
        ChartPatch {
            kind: Some("pie".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let out = s.save_xlsx().unwrap();
    let x = part(&out, "xl/charts/chart1.xml").unwrap();
    assert!(x.contains("<c:pieChart>") && !x.contains("<c:catAx>"));
    assert_eq!(
        SheetSession::load_xlsx(&out).unwrap().list_charts()[0].kind,
        "pie"
    );
}

#[test]
fn a_deleted_chart_leaves_the_package_and_keeps_the_others_indexes__feat__sheet_chart_writer() {
    let mut s = SheetSession::load_xlsx(&corpus("annual-charts.xlsx")).unwrap();
    let before: Vec<(u32, &'static str)> =
        s.list_charts().iter().map(|c| (c.index, c.kind)).collect();
    s.delete_chart(3).unwrap();
    let out = s.save_xlsx().unwrap();
    // The slot a read chart leaves is a tombstone stored beside the bytes
    // (ADR 522) and re-opened after the load.
    let mut r = SheetSession::load_xlsx(&out).unwrap();
    r.restore_chart_slots(&s.chart_tombstones()).unwrap();
    let after: Vec<(u32, &'static str)> =
        r.list_charts().iter().map(|c| (c.index, c.kind)).collect();
    let want: Vec<(u32, &'static str)> = before.into_iter().filter(|(i, _)| *i != 3).collect();
    assert_eq!(after, want);
    assert!(r.get_chart_geometry(3, 100.0, 100.0).is_err());
    let charts = names(&out)
        .iter()
        .filter(|n| n.starts_with("xl/charts/chart"))
        .count();
    assert_eq!(charts, 9);
}

#[test]
fn an_authored_chart_keeps_its_index_beside_charts_of_a_later_sheet__feat__sheet_chart_writer() {
    // And with a read chart deleted before it: the authored chart records
    // the deleted slot, so the load re-opens it and the tombstone restore
    // finds it open.
    // annual-charts' charts sit on its second sheet; a chart authored on
    // the first would be discovered first on reload without its record.
    let mut s = SheetSession::load_xlsx(&corpus("annual-charts.xlsx")).unwrap();
    let n = s.list_charts().len() as u32;
    let i = s
        .add_chart(0, "B2:B4", "A2:A4", "funnel", "New", "")
        .unwrap();
    assert_eq!(i, n);
    let out = s.save_xlsx().unwrap();
    let r = SheetSession::load_xlsx(&out).unwrap();
    let list = r.list_charts();
    assert_eq!(list.len() as u32, n + 1);
    assert_eq!(list[n as usize].kind, "funnel");
    assert_eq!(list[0].kind, "column");
}

/// Maintainer probe: one workbook per chartEx kind, for the Excel lane
/// (`PAGED_ORACLE_BUILD=<dir>`), to see which one Excel refuses.
#[test]
#[ignore = "maintainer: chartEx probe files"]
fn write_chart_ex_probe_files() {
    let dir = std::path::PathBuf::from(std::env::var("PAGED_ORACLE_BUILD").unwrap());
    std::fs::create_dir_all(&dir).unwrap();
    for tag in [
        "waterfall",
        "funnel",
        "treemap",
        "sunburst",
        "histogram",
        "pareto",
        "boxWhisker",
    ] {
        let mut s = data_session();
        s.add_chart(0, "B2:D5", "A2:A5", tag, tag, "").unwrap();
        std::fs::write(dir.join(format!("{tag}.xlsx")), s.save_xlsx().unwrap()).unwrap();
    }
}

/// Excel's own chartEx output (`17-excel-chartex.xlsx`: the open-check
/// lane's `chart-authored-chartex` case as Excel re-saved it, its document
/// properties and absolute path removed). Excel writes a chartEx part's data
/// as hidden `_xlchart.v1.N` defined names and drops the caches; every chart
/// still reads with its kind and its live ranges.
#[test]
fn excel_written_chart_ex_reads_back__feat__sheet_chart_chartex() {
    let s = SheetSession::load_xlsx(&corpus("17-excel-chartex.xlsx")).unwrap();
    let kinds: Vec<&str> = s.list_charts().iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            "waterfall",
            "funnel",
            "treemap",
            "sunburst",
            "histogram",
            "pareto",
            "boxWhisker"
        ]
    );
    for spec in s.chart_specs() {
        assert!(
            spec.series[0].values.starts_with("Sheet1!B"),
            "{:?}",
            spec.series[0]
        );
        let g = s.get_chart_geometry(spec.index, 300.0, 200.0).unwrap();
        assert!(g.prims.len() > 3, "{}", spec.kind);
    }
    assert_eq!(
        s.chart_specs()[6].series.len(),
        3,
        "box & whisker keeps its series"
    );
}
