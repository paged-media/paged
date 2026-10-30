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

/// A workbook whose first sheet carries a sparkline group over A2:E2 drawn
/// in F2 (an x14 `<extLst>`, as Excel writes one).
fn sparkline_workbook() -> Vec<u8> {
    let sheet = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>4</v></c><c r="C2"><v>-2</v></c><c r="D2"><v>5</v></c><c r="E2"><v>3</v></c></row></sheetData><extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup type="column" negative="1"><x14:colorSeries rgb="FF376092"/><x14:colorNegative rgb="FFD00000"/><x14:sparklines><x14:sparkline><xm:f>Sheet1!A2:E2</xm:f><xm:sqref>F2</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst></worksheet>"#;
    let base = corpus("01-minimal.xlsx");
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&base)).unwrap();
    let mut parts = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        if name == "xl/worksheets/sheet1.xml" {
            data = sheet.as_bytes().to_vec();
        }
        parts.push((name, data));
    }
    sheet_xlsx::write::write_package(parts.iter().map(|(n, d)| (n.as_str(), d.as_slice())))
}

#[test]
fn sparklines_draw_in_the_grid_scene__feat__sheet_chart_sparklines() {
    let bytes = sparkline_workbook();
    let s = SheetSession::load_xlsx(&bytes).unwrap();
    let list = s.list_sparklines(0);
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].row, list[0].col, list[0].kind), (1, 5, "column"));
    let scene = s
        .get_grid_scene(0, 0, 0, 600.0, 200.0, Default::default())
        .unwrap();
    assert_eq!(scene.sparklines.len(), 1);
    let sp = &scene.sparklines[0];
    assert_eq!((sp.row, sp.col), (1, 5));
    assert_eq!(sp.prims.len(), 5, "one column per value");
    // The negative value in the negative colour.
    let red = sp
        .prims
        .iter()
        .filter(
            |p| matches!(p, sheet_chart::Primitive::Rect { fill: Some(f), .. } if f == "#D00000"),
        )
        .count();
    assert_eq!(red, 1);
    // Scrolled past the cell: none.
    let away = s
        .get_grid_scene(0, 10, 0, 600.0, 200.0, Default::default())
        .unwrap();
    assert!(away.sparklines.is_empty());
    // The bytes round-trip with the group (the extLst is a captured child).
    let mut s = s;
    s.set_cell(0, 1, 0, "2").unwrap();
    let out = s.save_xlsx().unwrap();
    assert_eq!(
        SheetSession::load_xlsx(&out)
            .unwrap()
            .list_sparklines(0)
            .len(),
        1
    );
}

/// 09-chart.xlsx with its chart moved onto a chartsheet tab ("Chart1").
fn chartsheet_workbook() -> Vec<u8> {
    let base = corpus("09-chart.xlsx");
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&base)).unwrap();
    let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        let text = String::from_utf8_lossy(&data).into_owned();
        let data = match name.as_str() {
            "xl/workbook.xml" => text
                .replace(r#"r:id="rId1"/></sheets>"#, r#"r:id="rId1"/><sheet name="Chart1" sheetId="2" r:id="rId9"/></sheets>"#)
                .into_bytes(),
            "xl/_rels/workbook.xml.rels" => text
                .replace("</Relationships>", r#"<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>"#)
                .into_bytes(),
            "xl/worksheets/sheet1.xml" => text.replace(r#"<drawing r:id="rId1"/>"#, "").into_bytes(),
            "xl/worksheets/_rels/sheet1.xml.rels" => continue,
            "[Content_Types].xml" => text
                .replace("</Types>", r#"<Override PartName="/xl/chartsheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/></Types>"#)
                .into_bytes(),
            _ => data,
        };
        parts.push((name, data));
    }
    parts.push((
        "xl/chartsheets/sheet1.xml".into(),
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"/></sheetViews><drawing r:id="rId1"/></chartsheet>"#
            .to_vec(),
    ));
    parts.push((
        "xl/chartsheets/_rels/sheet1.xml.rels".into(),
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>"#
            .to_vec(),
    ));
    sheet_xlsx::write::write_package(parts.iter().map(|(n, d)| (n.as_str(), d.as_slice())))
}

#[test]
fn a_chartsheet_is_a_tab_kind__feat__sheet_chart_chartsheets() {
    let mut s = SheetSession::load_xlsx(&chartsheet_workbook()).unwrap();
    let sheets = s.list_sheets();
    assert_eq!(sheets.len(), 2);
    assert_eq!((sheets[0].kind, sheets[0].chart), ("worksheet", None));
    assert_eq!((sheets[1].kind, sheets[1].chart), ("chartsheet", Some(0)));
    let tabs = s.list_chartsheets();
    assert_eq!(
        (tabs[0].sheet, tabs[0].name.as_str(), tabs[0].chart),
        (1, "Chart1", Some(0))
    );
    let c = &s.list_charts()[0];
    assert!(c.chartsheet);
    assert_eq!(c.kind, "column");
    // Its series still read Sheet1's cells; the tab's chart is edited and
    // written back in place, and stays when deleted (the tab is the chart).
    assert!(s.chart_specs()[0].series[0].values.starts_with("Sheet1!"));
    s.update_chart(
        0,
        ChartPatch {
            title: Some(Some("On its tab".into())),
            ..Default::default()
        },
    )
    .unwrap();
    let out = s.save_xlsx().unwrap();
    let r = SheetSession::load_xlsx(&out).unwrap();
    assert_eq!(r.list_charts()[0].title.as_deref(), Some("On its tab"));
    assert_eq!(r.list_sheets()[1].kind, "chartsheet");
}

/// `bytes` with part `name` replaced by `xml`.
fn with_part(bytes: &[u8], name: &str, xml: &str) -> Vec<u8> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let n = f.name().unwrap().to_string();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        if n == name {
            data = xml.as_bytes().to_vec();
        }
        parts.push((n, data));
    }
    sheet_xlsx::write::write_package(parts.iter().map(|(n, d)| (n.as_str(), d.as_slice())))
}

/// A column chart whose series and plot area Excel styled with a gradient,
/// a translucent fill and effects (sheet ADR 527), written into a package
/// Paged saved: the DrawingML is synthetic, the package Paged's own.
pub(crate) fn styled_chart_workbook() -> Vec<u8> {
    let mut s = data_session();
    s.add_chart(0, "B2:B5", "A2:A5", "column", "T", "").unwrap();
    let bytes = s.save_xlsx().unwrap();
    let xml = part(&bytes, "xl/charts/chart1.xml").unwrap();
    let ser = r#"<c:order val="0"/><c:spPr><a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="accent1"/></a:gs><a:gs pos="100000"><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000" algn="tl" rotWithShape="0"><a:prstClr val="black"><a:alpha val="40000"/></a:prstClr></a:outerShdw></a:effectLst></c:spPr>"#;
    let plot = r#"</c:valAx><c:spPr><a:solidFill><a:schemeClr val="bg1"><a:alpha val="60000"/></a:schemeClr></a:solidFill><a:effectLst><a:innerShdw blurRad="63500" dist="50800" dir="13500000"><a:prstClr val="black"><a:alpha val="50000"/></a:prstClr></a:innerShdw><a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst></c:spPr></c:plotArea>"#;
    assert!(xml.contains(r#"<c:order val="0"/>"#) && xml.contains("</c:valAx></c:plotArea>"));
    let xml =
        xml.replacen(r#"<c:order val="0"/>"#, ser, 1)
            .replacen("</c:valAx></c:plotArea>", plot, 1);
    with_part(&bytes, "xl/charts/chart1.xml", &xml)
}

/// The edit the effects survive: a document swatch on the plot area (the
/// open-check lane runs it too).
pub(crate) fn swatch_on_the_plot_area(s: &mut SheetSession) {
    let patch: ChartPatch = serde_json::from_value(serde_json::json!({
        "roles": { "plotArea": { "swatch": "Color/Paper" } }
    }))
    .unwrap();
    s.update_chart(0, patch).unwrap();
}

#[test]
fn chart_effects_reach_the_geometry_and_survive_an_edit__feat__sheet_chart_native_effects() {
    let bytes = styled_chart_workbook();
    let mut s = SheetSession::load_xlsx(&bytes).unwrap();
    let g = s.get_chart_geometry(0, 360.0, 240.0).unwrap();
    let fxs: Vec<_> = g
        .prims
        .iter()
        .filter_map(|p| match p {
            sheet_chart::Primitive::Rect { fx: Some(fx), .. } => Some(fx.clone()),
            _ => None,
        })
        .collect();
    // The plot area, then four bars.
    assert_eq!(fxs.len(), 5, "{:?}", g.prims);
    assert_eq!(fxs[0].opacity, Some(60.0));
    assert!(fxs[0].inner_shadow.is_some());
    let bar = &fxs[1];
    let gr = bar.gradient.as_ref().unwrap();
    assert_eq!(gr.angle, Some(-90.0));
    assert_eq!(gr.stops[0].1, "#4472C4");
    assert_eq!(bar.drop_shadow.as_ref().unwrap().opacity, 40.0);
    // The plot area's reflection rides its effect stack (engine ADR 1008).
    assert!(g.losses.is_empty(), "{:?}", g.losses);
    assert!(
        fxs[0].effect_stack.iter().any(|e| e.kind == "reflection"),
        "{:?}",
        fxs[0]
    );
    // A document swatch on the plot area: its fill is the swatch, its
    // effects stay in the file.
    swatch_on_the_plot_area(&mut s);
    let out = s.save_xlsx().unwrap();
    let xml = part(&out, "xl/charts/chart1.xml").unwrap();
    let pa = &xml[xml.rfind("</c:valAx>").unwrap()..];
    assert!(
        pa.contains("<a:innerShdw") && pa.contains("<a:reflection"),
        "{pa}"
    );
    assert!(
        !pa.contains(r#"<a:alpha val="60000"/>"#),
        "the old fill went: {pa}"
    );
    // The series was not edited: its gradient and shadow are as read.
    assert!(xml.contains(r#"<a:lin ang="5400000" scaled="0"/>"#));
    assert!(xml.contains("<a:outerShdw"));
    let r = SheetSession::load_xlsx(&out).unwrap();
    let g = r.get_chart_geometry(0, 360.0, 240.0).unwrap();
    let pa_fx = g.prims.iter().find_map(|p| match p {
        sheet_chart::Primitive::Rect {
            fx: Some(fx),
            fill_swatch_ref: Some(sw),
            ..
        } if sw == "Color/Paper" => Some(fx.clone()),
        _ => None,
    });
    let pa_fx = pa_fx.expect("the plot area keeps its effects under the swatch");
    assert!(pa_fx.inner_shadow.is_some());
}
