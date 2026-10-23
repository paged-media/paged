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

//! The Excel OPEN-CHECK lane: Excel opens what Paged saves after an edit
//! without a repair prompt, and keeps what it holds.
//!
//! Three steps, the middle one a maintainer's (macOS + Excel; respect the
//! Excel lock of the oracle README):
//!
//! ```text
//! PAGED_ORACLE_BUILD=<dir> cargo nextest run -p sheet-conformance \
//!     --run-ignored only excel_opencheck::write_the_paged_files
//! PAGED_ORACLE_BUILD=<dir> PAGED_ORACLE_SCRIPT=opencheck.applescript \
//!     sheet-conformance/oracle/excel/drive.sh
//! PAGED_ORACLE_BUILD=<dir> cargo nextest run -p sheet-conformance \
//!     --run-ignored only excel_opencheck::record_what_excel_made_of_them
//! ```
//!
//! The recording (`oracle/excel/recorded/opencheck.tsv`) is committed; CI
//! replays it here: every Paged-written case opened, unrepaired, with the
//! conditional formats, validations, tables, notes and cell values it was
//! saved with. A deliberately broken control file proves the lane sees a
//! repair. (Excel scripted with alerts off answers a file it would repair
//! with error -50 instead of a prompt; three generated fixtures — 05, 11,
//! 13 — are refused by Excel as generated, so the cases made from them are
//! recorded but not gated.)

use std::path::PathBuf;

use sheet_js::core::{ChartPatch, SeriesArg, SheetSession, StructuralEdit, CHART_KIND_TAGS};

fn corpus(name: &str) -> Vec<u8> {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../corpus/xlsx-corpus")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

fn build_dir() -> PathBuf {
    std::env::var_os("PAGED_ORACLE_BUILD")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/excel/build/opencheck")
        })
}

fn recorded() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("oracle/excel/recorded/opencheck.tsv")
}

/// One edit scenario: the fixture and what is done to it before the save.
type Step = fn(&mut SheetSession);

fn scenarios() -> Vec<(&'static str, &'static str, Step)> {
    let mut v: Vec<(&'static str, &'static str, Step)> = vec![
        ("saveloss-edit", "15-saveloss.xlsx", |s| {
            s.set_cell(0, 3, 0, "edited").unwrap();
            s.set_cell(0, 0, 2, "6").unwrap();
        }),
        ("saveloss-structure", "15-saveloss.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::InsertRows, 1, 2)
                .unwrap();
            s.structural_edit(0, StructuralEdit::InsertCols, 0, 1)
                .unwrap();
        }),
        ("structure-edit", "16-structure.xlsx", |s| {
            s.set_cell(0, 1, 1, "13").unwrap();
        }),
        ("structure-insert-rows", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::InsertRows, 1, 2)
                .unwrap();
        }),
        ("structure-table-column", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::InsertCols, 8, 1)
                .unwrap();
        }),
        ("structure-delete-column", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::DeleteCols, 1, 1)
                .unwrap();
        }),
        ("structure-delete-table", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::DeleteCols, 7, 3)
                .unwrap();
        }),
        ("structure-delete-rows", "16-structure.xlsx", |s| {
            s.structural_edit(0, StructuralEdit::DeleteRows, 2, 2)
                .unwrap();
        }),
    ];
    for f in [
        "01-minimal.xlsx",
        "02-formulas.xlsx",
        "03-styles.xlsx",
        "05-unknown-subtrees.xlsx",
        "06-multisheet-1904.xlsx",
        "07-tables.xlsx",
        "08-condfmt.xlsx",
        "11-freeze.xlsx",
        "12-datavalidation.xlsx",
        "13-comments.xlsx",
        "14-textstyles.xlsx",
    ] {
        v.push((f.trim_end_matches(".xlsx"), f, |s| {
            let row = s.model().sheets[0].used_range().map_or(0, |u| u.row1 + 2);
            s.set_cell(0, row, 0, "edited").unwrap();
            s.structural_edit(0, StructuralEdit::InsertRows, 0, 1)
                .unwrap();
        }));
    }
    // Charts (W4.3, ADR 519): authored charts generated, a read chart
    // spliced, a kind change, a delete.
    v.push(("chart-authored-classic", "01-minimal.xlsx", |s| {
        chart_data(s);
        for tag in CHART_KIND_TAGS.iter().filter(|t| !chart_ex_tag(t)) {
            s.add_chart(0, "B12:D16", "A12:A16", tag, tag, "").unwrap();
        }
    }));
    v.push(("chart-authored-chartex", "01-minimal.xlsx", |s| {
        chart_data(s);
        for tag in CHART_KIND_TAGS.iter().filter(|t| chart_ex_tag(t)) {
            s.add_chart(0, "B12:D16", "A12:A16", tag, tag, "").unwrap();
        }
    }));
    v.push(("chart-edited", "16-structure.xlsx", |s| {
        let spec = s.chart_specs()[0].clone();
        let first = &spec.series[0];
        s.update_chart(
            0,
            ChartPatch {
                title: Some(Some("Edited in Paged".into())),
                series: Some(vec![SeriesArg {
                    values: first.values.clone(),
                    categories: first.categories.clone().unwrap_or_default(),
                    name: "Renamed".into(),
                    color: "#00A0E0".into(),
                    color_swatch: "Color/Brand".into(),
                    ..Default::default()
                }]),
                value_axis_max: Some(Some(1000.0)),
                legend_position: Some("b".into()),
                data_labels: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        // Charts authored beside it go into the sheet's existing drawing.
        for (kind, title) in [("line", "Added line"), ("funnel", "Added funnel")] {
            let i = s
                .add_chart(spec.host_sheet, "A1:A2", "", kind, title, "")
                .unwrap();
            s.update_chart(
                i,
                ChartPatch {
                    series: Some(vec![SeriesArg {
                        values: first.values.clone(),
                        categories: first.categories.clone().unwrap_or_default(),
                        ..Default::default()
                    }]),
                    ..Default::default()
                },
            )
            .unwrap();
        }
    }));
    v.push(("chart-kind-change", "16-structure.xlsx", |s| {
        s.update_chart(
            0,
            ChartPatch {
                kind: Some("stackedArea".into()),
                ..Default::default()
            },
        )
        .unwrap();
    }));
    v.push(("chart-kind-pie", "16-structure.xlsx", |s| {
        s.update_chart(
            0,
            ChartPatch {
                kind: Some("pie".into()),
                ..Default::default()
            },
        )
        .unwrap();
    }));
    v.push(("chart-deleted", "16-structure.xlsx", |s| {
        s.delete_chart(0).unwrap();
    }));
    v
}

fn chart_ex_tag(t: &str) -> bool {
    matches!(
        t,
        "waterfall" | "funnel" | "treemap" | "sunburst" | "histogram" | "pareto" | "boxWhisker"
    )
}

/// A block of numbers with labels at A11:D16 for the authored charts.
fn chart_data(s: &mut SheetSession) {
    let rows = [
        ["", "North", "South", "East"],
        ["Q1", "10", "4", "3"],
        ["Q2", "20", "6", "5"],
        ["Q3", "15", "9", "4"],
        ["Q4", "25", "7", "6"],
        ["Q5", "18", "8", "7"],
    ];
    for (r, row) in rows.iter().enumerate() {
        for (c, v) in row.iter().enumerate() {
            if !v.is_empty() {
                s.set_cell(0, 10 + r as u32, c as u32, v).unwrap();
            }
        }
    }
}

/// A package Excel must repair: rows out of order.
fn broken_control() -> Vec<u8> {
    let mut s = SheetSession::load_xlsx(&corpus("01-minimal.xlsx")).unwrap();
    s.set_cell(0, 5, 0, "x").unwrap();
    let out = s.save_xlsx().unwrap();
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&out)).unwrap();
    let mut parts = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut data).unwrap();
        if name == "xl/worksheets/sheet1.xml" {
            let x = String::from_utf8(data).unwrap();
            let x = x.replace(
                "<sheetData>",
                r#"<sheetData><row r="9"><c r="A9"><v>1</v></c></row>"#,
            );
            data = x.into_bytes();
        }
        parts.push((name, data));
    }
    sheet_xlsx::write::write_package(parts.iter().map(|(n, d)| (n.as_str(), d.as_slice())))
}

#[test]
#[ignore = "maintainer: writes the open-check lane's Paged files"]
fn write_the_paged_files() {
    let dir = build_dir();
    std::fs::create_dir_all(&dir).unwrap();
    for (name, fixture, step) in scenarios() {
        let mut s = SheetSession::load_xlsx(&corpus(fixture)).unwrap();
        step(&mut s);
        std::fs::write(dir.join(format!("{name}.xlsx")), s.save_xlsx().unwrap()).unwrap();
        // The fixture as generated, for a baseline.
        std::fs::write(dir.join(format!("orig-{fixture}")), corpus(fixture)).unwrap();
    }
    std::fs::write(dir.join("control-broken.xlsx"), broken_control()).unwrap();
}

/// What a package holds, read through Paged's own reader.
fn inventory(bytes: &[u8]) -> String {
    let doc = sheet_xlsx::XlsxDocument::open(bytes).expect("Paged reads it");
    let s = SheetSession::load_xlsx(bytes).expect("Paged loads it");
    let sheets = s.list_sheets();
    let mut cf = 0;
    let mut dv = 0;
    let mut notes = 0;
    let mut tables = 0;
    for i in 0..sheets.len() as u16 {
        cf += doc
            .conditional_formats
            .get(&i)
            .map_or(0, |c| c.blocks.len());
        dv += doc.data_validations_of(i).map_or(0, |d| d.rules.len());
        notes += doc.comments_of(i).map_or(0, |c| c.comments.len());
        tables += s.model().sheets[i as usize].tables.len();
    }
    // Every non-empty cell value of every sheet, as displayed.
    let mut cells = 0usize;
    let mut digest = 0u64;
    for (si, ws) in s.model().sheets.iter().enumerate() {
        for (&(r, c), _) in ws.iter_cells() {
            let d = s.get_cell_display(si as u16, r, c);
            if d.is_empty() {
                continue;
            }
            cells += 1;
            for b in format!("{si}:{r}:{c}={d}").bytes() {
                digest = digest.wrapping_mul(1_000_003).wrapping_add(u64::from(b));
            }
        }
    }
    // The charts: count, then each one's kind, series count and title.
    let charts: Vec<String> = s
        .list_charts()
        .iter()
        .map(|c| {
            format!(
                "{}:{}:{}",
                c.kind,
                c.series_count,
                c.title.as_deref().unwrap_or("")
            )
        })
        .collect();
    let charts = if charts.is_empty() {
        String::new()
    } else {
        format!(" charts={}[{}]", charts.len(), charts.join("|"))
    };
    format!(
        "cf={cf} dv={dv} tables={tables} notes={notes} cells={cells} digest={digest:016x}{charts}"
    )
}

#[test]
#[ignore = "maintainer: records the open-check lane after drive.sh"]
fn record_what_excel_made_of_them() {
    let dir = build_dir();
    let mut rows =
        vec!["case\topened\trepaired\tbaseline\tpaged\texcel\texcel-chart-types".to_string()];
    // Whether Excel opened the fixture a case was made from, as generated.
    let baseline = |case: &str| -> &'static str {
        let fixture = if case.starts_with("saveloss-") {
            "15-saveloss".to_string()
        } else if case.starts_with("structure-") {
            "16-structure".to_string()
        } else if case.starts_with("chart-authored") {
            "01-minimal".to_string()
        } else if case.starts_with("chart-") {
            "16-structure".to_string()
        } else {
            case.to_string()
        };
        let meta =
            std::fs::read_to_string(dir.join(format!("orig-{fixture}.meta"))).unwrap_or_default();
        if meta.contains(" OK name=") {
            "opens"
        } else {
            "refused"
        }
    };
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".xlsx") && !n.ends_with(".excel.xlsx"))
        .collect();
    names.sort();
    for n in names {
        let case = n.trim_end_matches(".xlsx");
        let paged = std::fs::read(dir.join(&n)).unwrap();
        let meta = std::fs::read_to_string(dir.join(format!("{case}.meta"))).unwrap_or_default();
        let excel = std::fs::read(dir.join(format!("{case}.excel.xlsx"))).ok();
        let opened = meta.contains(" OK name=");
        let repaired = !opened || meta.contains("Repaired") || meta.contains("repaired");
        let paged_inv = if case == "control-broken" {
            "-".to_string()
        } else {
            inventory(&paged)
        };
        let excel_inv = match &excel {
            Some(b) if case != "control-broken" => inventory(b),
            Some(_) => "-".to_string(),
            None => "-".to_string(),
        };
        let base = if case.starts_with("orig-") || case == "control-broken" {
            "-"
        } else {
            baseline(case)
        };
        // The chart types Excel itself reports, in sheet and anchor order.
        let types = meta
            .split(" charts=")
            .nth(1)
            .map(|t| t.trim().trim_end_matches(';').to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "-".into());
        rows.push(format!(
            "{case}\t{}\t{}\t{base}\t{paged_inv}\t{excel_inv}\t{types}",
            if opened { "yes" } else { "no" },
            if repaired { "yes" } else { "no" }
        ));
    }
    std::fs::write(recorded(), rows.join("\n") + "\n").unwrap();
}

/// CI: the recording says Excel opened every Paged-written file without a
/// repair and kept what Paged wrote; the broken control was caught.
#[test]
fn excel_opens_what_paged_saves_without_repair__feat__sheet_calc_rewrite_structural_door() {
    let text = std::fs::read_to_string(recorded()).expect("recorded/opencheck.tsv");
    let mut paged_cases = 0;
    let mut control = false;
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split('\t').collect();
        let (case, opened, repaired, base, paged, excel) = (f[0], f[1], f[2], f[3], f[4], f[5]);
        if case == "control-broken" {
            assert_eq!(repaired, "yes", "the lane must see Excel's repair");
            control = true;
            continue;
        }
        if case.starts_with("orig-") || base == "refused" {
            // A fixture as generated is a baseline, not a gate; and a case
            // made from a fixture Excel already refuses proves nothing.
            continue;
        }
        paged_cases += 1;
        assert_eq!((opened, repaired), ("yes", "no"), "{case}: {line}");
        // Excel's re-save keeps the content: the same conditional formats,
        // validations, tables and notes, and every cell showing the same.
        assert_eq!(paged, excel, "{case}");
    }
    assert!(control, "the broken control was not recorded");
    assert!(paged_cases >= 16, "{paged_cases} cases");
}

/// The chart type Excel reports for a Paged kind tag (Excel's AppleScript
/// names), as a prefix: a line or radar may carry its markers.
fn excel_type_of(kind: &str) -> &'static str {
    match kind {
        "column" => "column clustered",
        "stackedColumn" => "column stacked",
        "percentStackedColumn" => "column stacked 100",
        "bar" => "bar clustered",
        "stackedBar" => "bar stacked",
        "percentStackedBar" => "bar stacked 100",
        "line" => "line",
        "stackedLine" => "line",
        "percentStackedLine" => "line",
        "area" => "area chart",
        "stackedArea" => "area stacked",
        "percentStackedArea" => "area stacked 100",
        "scatter" => "xyscatter",
        "bubble" => "bubble",
        "pie" => "pie chart",
        "donut" => "doughnut",
        "pieOfPie" => "pie of pie",
        "barOfPie" => "bar of pie",
        "radar" => "radar",
        "filledRadar" => "radar filled",
        "stock" => "stock",
        "surface" => "surface",
        "waterfall" => "waterfall",
        "funnel" => "funnel",
        "treemap" => "treemap",
        "sunburst" => "sunburst",
        "histogram" => "histogram",
        "pareto" => "pareto",
        "boxWhisker" => "boxwhisker",
        _ => "?",
    }
}

/// CI: Excel opens every chart Paged wrote (authored, spliced, re-kinded,
/// deleted) without a repair, sees as many charts as Paged wrote, each of
/// the type Paged wrote; and its re-save reads back to the same charts.
#[test]
fn excel_opens_the_charts_paged_writes__feat__sheet_chart_writer() {
    let text = std::fs::read_to_string(recorded()).expect("recorded/opencheck.tsv");
    let mut cases = 0;
    for line in text.lines().skip(1) {
        let f: Vec<&str> = line.split('\t').collect();
        let case = f[0];
        if !case.starts_with("chart-") {
            continue;
        }
        cases += 1;
        assert_eq!((f[1], f[2]), ("yes", "no"), "{case}: {line}");
        assert_eq!(f[4], f[5], "{case}: Excel's re-save reads back the same");
        let kinds: Vec<&str> = f[4]
            .split("charts=")
            .nth(1)
            .and_then(|c| {
                c.split_once('[')
                    .map(|(_, rest)| rest.trim_end_matches(']'))
            })
            .map(|c| c.split('|').map(|e| e.split(':').next().unwrap()).collect())
            .unwrap_or_default();
        let types: Vec<&str> = match f.get(6) {
            Some(&"-") | None => Vec::new(),
            Some(t) => t.split(';').collect(),
        };
        assert_eq!(kinds.len(), types.len(), "{case}: chart count");
        for (k, t) in kinds.iter().zip(&types) {
            assert!(t.starts_with(excel_type_of(k)), "{case}: {k} opened as {t}");
        }
    }
    assert!(cases >= 6, "{cases} chart cases");
}
