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

//! Doc ADR 628 — charts as Word writes them: a `w:drawing` whose graphic is
//! a `c:chart` naming a chart part (`word/charts/chartN.xml`) with its cached
//! values, the part's own relationship to the embedded workbook.
//! `dump-fixture <out> charts` writes the document.

use crate::{zip_parts, ROOT_RELS, THEME_CONTENT_TYPES, THEME_STYLES, THEME_XML};

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart""#;

/// The bar chart's title, series and categories.
pub const CHART_TITLE: &str = "Quarterly sales";
pub const CHART_SERIES: [&str; 2] = ["East", "West"];
pub const CHART_CATEGORIES: [&str; 3] = ["Q1", "Q2", "Q3"];

/// The bytes the embedded workbook part holds (not a workbook: nothing
/// reads it, it is only carried).
pub const CHART_WORKBOOK: &[u8] = b"PK not a workbook, carried as it is";

fn graphic(id: u32, rid: &str, cx: i64, cy: i64, anchored: Option<(i64, i64)>) -> String {
    let data = format!(
        r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="{rid}"/></a:graphicData></a:graphic>"#
    );
    match anchored {
        Some((x, y)) => format!(
            r#"<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>{x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>{y}</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="{id}" name="Chart {id}"/><wp:cNvGraphicFramePr/>{data}</wp:anchor></w:drawing></w:r>"#
        ),
        None => format!(
            r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Chart {id}"/><wp:cNvGraphicFramePr/>{data}</wp:inline></w:drawing></w:r>"#
        ),
    }
}

fn str_cache(f: &str, values: &[&str]) -> String {
    let pts: String = values
        .iter()
        .enumerate()
        .map(|(i, v)| format!(r#"<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>"#))
        .collect();
    format!(
        r#"<c:strRef><c:f>{f}</c:f><c:strCache><c:ptCount val="{}"/>{pts}</c:strCache></c:strRef>"#,
        values.len()
    )
}

fn num_cache(f: &str, values: &[f64]) -> String {
    let pts: String = values
        .iter()
        .enumerate()
        .map(|(i, v)| format!(r#"<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>"#))
        .collect();
    format!(
        r#"<c:numRef><c:f>{f}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="{}"/>{pts}</c:numCache></c:numRef>"#,
        values.len()
    )
}

fn chart_space(plot: &str, title: &str, legend: bool) -> String {
    let legend = if legend {
        r#"<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>"#
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace {NS}><c:date1904 val="0"/><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{title}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>{plot}</c:plotArea>{legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill></a:ln></c:spPr><c:externalData r:id="rWb"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>"#
    )
}

/// The clustered column chart: two series over three quarters, a title, a
/// legend, value gridlines.
pub fn bar_chart_xml() -> String {
    let series = |i: usize, col: &str, values: &[f64]| {
        format!(
            r#"<c:ser><c:idx val="{i}"/><c:order val="{i}"/><c:tx>{}</c:tx><c:spPr><a:solidFill><a:schemeClr val="accent{}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/><c:cat>{}</c:cat><c:val>{}</c:val></c:ser>"#,
            str_cache(&format!("Sheet1!${col}$1"), &[CHART_SERIES[i]]),
            i + 1,
            str_cache("Sheet1!$A$2:$A$4", &CHART_CATEGORIES),
            num_cache(&format!("Sheet1!${col}$2:${col}$4"), values),
        )
    };
    let plot = format!(
        r#"<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>{}{}<c:gapWidth val="219"/><c:overlap val="-27"/><c:axId val="10"/><c:axId val="20"/></c:barChart><c:catAx><c:axId val="10"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="20"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="20"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="10"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>"#,
        series(0, "B", &[4.3, 2.5, 3.5]),
        series(1, "C", &[2.4, 4.4, 1.8]),
    );
    chart_space(&plot, CHART_TITLE, true)
}

/// The pie chart: one series of three slices, each its own colour.
pub fn pie_chart_xml() -> String {
    let plot = format!(
        r#"<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx>{}</c:tx><c:cat>{}</c:cat><c:val>{}</c:val></c:ser><c:firstSliceAng val="0"/></c:pieChart>"#,
        str_cache("Sheet1!$B$1", &["Share"]),
        str_cache("Sheet1!$A$2:$A$4", &CHART_CATEGORIES),
        num_cache("Sheet1!$B$2:$B$4", &[50.0, 30.0, 20.0]),
    );
    chart_space(&plot, "Share", true)
}

/// A document with an inline column chart, an anchored pie chart and a
/// chart in a table cell (which is not placed), each after a line of text.
/// The two body charts share no part; the cell's chart reuses the bar
/// chart's part.
pub fn charts_docx() -> Vec<u8> {
    let bar = graphic(1, "rChart1", 4_572_000, 2_743_200, None);
    let pie = graphic(2, "rChart2", 2_743_200, 2_286_000, Some((3_200_400, 0)));
    let cell = graphic(3, "rChart1", 2_286_000, 1_371_600, None);
    let body = format!(
        r#"<w:p><w:r><w:t>Chart bar</w:t></w:r></w:p><w:p>{bar}</w:p><w:p><w:r><w:t>Chart pie</w:t></w:r>{pie}</w:p><w:p><w:r><w:t>after the pie</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="9360" w:type="dxa"/></w:tcPr><w:p>{cell}</w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>the end</w:t></w:r></w:p>"#
    );
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let mut types =
        paged_ooxml::ContentTypes::parse(THEME_CONTENT_TYPES.as_bytes()).expect("types");
    types.add_default(
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    for n in [1, 2] {
        types.add_override(
            &format!("/word/charts/chart{n}.xml"),
            "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
        );
    }
    let content_types = types.render();
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/><Relationship Id="rChart2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart2.xml"/></Relationships>"#;
    let chart_rels = |n: u32| {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rWb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet{n}.xlsx"/></Relationships>"#
        )
    };
    let settings = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2" w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/></w:settings>"#;
    let (bar_xml, pie_xml) = (bar_chart_xml(), pie_chart_xml());
    let (rels1, rels2) = (chart_rels(1), chart_rels(2));
    zip_parts(&[
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/styles.xml", THEME_STYLES.as_bytes()),
        ("word/settings.xml", settings.as_bytes()),
        ("word/theme/theme1.xml", THEME_XML.as_bytes()),
        ("word/charts/chart1.xml", bar_xml.as_bytes()),
        ("word/charts/_rels/chart1.xml.rels", rels1.as_bytes()),
        ("word/charts/chart2.xml", pie_xml.as_bytes()),
        ("word/charts/_rels/chart2.xml.rels", rels2.as_bytes()),
        (
            "word/embeddings/Microsoft_Excel_Worksheet1.xlsx",
            CHART_WORKBOOK,
        ),
        (
            "word/embeddings/Microsoft_Excel_Worksheet2.xlsx",
            CHART_WORKBOOK,
        ),
    ])
}

/// The chart parts and their relationships, which every save keeps.
pub const CHART_PARTS: [&str; 6] = [
    "word/charts/chart1.xml",
    "word/charts/_rels/chart1.xml.rels",
    "word/charts/chart2.xml",
    "word/charts/_rels/chart2.xml.rels",
    "word/embeddings/Microsoft_Excel_Worksheet1.xlsx",
    "word/embeddings/Microsoft_Excel_Worksheet2.xlsx",
];
