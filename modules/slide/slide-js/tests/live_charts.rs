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

//! Live charts (ADR 715) through slide-js: the import reports every chart
//! with its workbook, and a chart frame redrawn from an edited workbook is
//! a page-item snippet the engine pastes in place of the old group.

// Test names carry their feature (`__feat__…`, the cockpit's test map).
#![allow(non_snake_case)]

use std::path::PathBuf;

fn fixture() -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../slide-conformance/fixtures/charts.pptx"),
    )
    .unwrap()
}

#[test]
fn the_import_reports_each_chart_with_its_workbook__feat__plugin_slide_charts() {
    let bytes = fixture();
    let (_, report, _, workbooks) = slide_js::import_all(&bytes, "charts").unwrap();
    assert_eq!(report.charts.len(), 5);
    let pkg = paged_ooxml::OpcPackage::read(&bytes).unwrap();
    for c in &report.charts {
        let xlsx = &workbooks[c.offset..c.offset + c.length];
        assert!(xlsx.starts_with(b"PK"), "{}", c.part);
        match c.origin {
            // An embedded workbook is kept as the deck has it.
            slide_sheet::Origin::Embedded => assert_eq!(
                Some(xlsx),
                c.embedded_part.as_deref().and_then(|p| pkg.part(p))
            ),
            slide_sheet::Origin::Synthesized => assert_eq!(c.part, "ppt/charts/chart5.xml"),
        }
    }
    let by = |p: &str| report.charts.iter().find(|c| c.part == p).unwrap().drawn_by;
    assert_eq!(by("ppt/charts/chart2.xml"), "slide");
    assert_eq!(by("ppt/charts/chart4.xml"), "sheet");
}

#[test]
fn a_redrawn_chart_is_a_snippet_of_its_frame__feat__plugin_slide_charts() {
    let bytes = fixture();
    let deck = pptx_import::import_pptx(&bytes).unwrap();
    let pkg = paged_ooxml::OpcPackage::read(&bytes).unwrap();
    let (mut charts, _) = slide_sheet::DeckCharts::open(&pkg, &deck);
    let part = "ppt/charts/chart1.xml";
    charts
        .books
        .get_mut(part)
        .unwrap()
        .enter("Sheet1", 2, 1, "9.25")
        .unwrap();
    // Moved and resized since import.
    let json = slide_js::live_snippet(
        &deck,
        &charts,
        part,
        "ppt/slides/slide1.xml",
        11,
        (100.0, 70.0, 500.0, 300.0),
    )
    .unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["format"], "paged.snippet/1");
    let b: Vec<f64> = v["bounds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect();
    assert_eq!(b, vec![70.0, 100.0, 370.0, 600.0]);
    // One root group, carrying the chart label with its new box.
    let roots = v["spread"]["frames_in_order"].as_array().unwrap();
    assert_eq!(roots.len(), 1);
    let labels = v["spread"]["labels"].to_string();
    assert!(labels.contains("ppt/charts/chart1.xml"), "{labels}");
    assert!(labels.contains("[100.0,70.0,500.0,300.0]"), "{labels}");
    assert!(labels.contains("ppt/slides/slide1.xml#11"), "{labels}");
    assert!(v["spread"]["pages"].as_array().is_none_or(|p| p.is_empty()));
}

#[test]
fn a_line_chart_without_line_paints_is_stroked_in_its_automatic_colours() {
    let deck = pptx_import::import_pptx(&fixture()).unwrap();
    let c = &deck.charts["ppt/charts/chart2.xml"];
    let series: Vec<_> = slide_chart::layout(c, 560.0, 360.0)
        .into_iter()
        .filter_map(|p| match p {
            slide_chart::Prim::Path {
                points,
                line,
                smooth: true,
                ..
            } if points.len() == 4 => Some(line),
            _ => None,
        })
        .collect();
    assert_eq!(series.len(), 3);
    assert!(series
        .iter()
        .all(|l| l.as_ref().is_some_and(|l| l.width == Some(28_575))));
}
