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

use super::*;
use std::collections::HashMap;

struct Names(HashMap<String, SheetId>);
impl SheetResolver for Names {
    fn resolve(&self, name: &str) -> Option<SheetId> {
        self.0.get(name).copied()
    }
}
fn names() -> Names {
    let mut m = HashMap::new();
    m.insert("Sheet1".to_string(), 0u16);
    m.insert("Data".to_string(), 1u16);
    Names(m)
}

const NS: &str = r#"xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

fn wrap(plot_area: &str) -> Vec<u8> {
    format!(r#"<c:chartSpace {NS}><c:chart><c:plotArea>{plot_area}</c:plotArea></c:chart></c:chartSpace>"#).into_bytes()
}

const SER: &str = r#"<c:ser><c:idx val="0"/><c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser>"#;

fn model(xml: &[u8]) -> ChartModel {
    parse(xml, 0, &names()).unwrap().model
}

fn kind(plot: &str) -> (ChartKind, Grouping, bool) {
    let m = model(&wrap(plot));
    (m.kind(), m.grouping(), m.flattened_3d)
}

#[test]
fn parses_column_chart_series_title_legend_color() {
    let xml = format!(
        r#"<c:chartSpace {NS}><c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Q1 Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:barChart><c:barDir val="col"/>
      <c:ser><c:idx val="0"/>
        <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:spPr><a:solidFill><a:srgbClr val="3366CC"/></a:solidFill></c:spPr>
        <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f></c:strRef></c:cat>
        <c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f></c:numRef></c:val>
      </c:ser></c:barChart></c:plotArea>
    <c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>"#
    );
    let m = model(xml.as_bytes());
    assert_eq!(m.kind(), ChartKind::Column);
    assert_eq!(m.title.as_deref(), Some("Q1 Revenue"));
    assert_eq!(m.legend.as_ref().unwrap().position, LegendPosition::Bottom);
    let s = m.series().next().unwrap();
    assert_eq!(s.name.as_deref(), Some("Revenue"));
    assert_eq!(s.fill, Some(color_rgb(0x3366CC)));
    assert_eq!(
        (s.values.start.row, s.values.start.col, s.values.end.row),
        (1, 1, 3)
    );
    assert_eq!(s.categories.unwrap().start.col, 0);
    assert_eq!(s.name_ref.unwrap().start.row, 0);
}

#[test]
fn every_element_maps_to_its_own_kind__feat__sheet_chart_kinds() {
    let g = |dir: &str, grp: &str| {
        format!(r#"<c:barChart><c:barDir val="{dir}"/><c:grouping val="{grp}"/>{SER}</c:barChart>"#)
    };
    assert_eq!(
        kind(&g("col", "clustered")),
        (ChartKind::Column, Grouping::Standard, false)
    );
    assert_eq!(
        kind(&g("col", "stacked")),
        (ChartKind::Column, Grouping::Stacked, false)
    );
    assert_eq!(
        kind(&g("bar", "percentStacked")),
        (ChartKind::Bar, Grouping::PercentStacked, false)
    );
    // Lines and areas stack now (they were drawn unstacked before W4).
    assert_eq!(
        kind(&format!(
            r#"<c:lineChart><c:grouping val="stacked"/>{SER}</c:lineChart>"#
        )),
        (ChartKind::Line, Grouping::Stacked, false)
    );
    assert_eq!(
        kind(&format!(
            r#"<c:areaChart><c:grouping val="percentStacked"/>{SER}</c:areaChart>"#
        )),
        (ChartKind::Area, Grouping::PercentStacked, false)
    );
    for (el, k) in [
        ("pieChart", ChartKind::Pie),
        ("doughnutChart", ChartKind::Donut),
        ("scatterChart", ChartKind::Scatter),
        ("bubbleChart", ChartKind::Bubble),
        ("radarChart", ChartKind::Radar),
        ("stockChart", ChartKind::Stock),
        ("surfaceChart", ChartKind::Surface),
        ("ofPieChart", ChartKind::PieOfPie),
    ] {
        assert_eq!(kind(&format!("<c:{el}>{SER}</c:{el}>")).0, k, "{el}");
    }
    assert_eq!(
        kind(&format!(
            r#"<c:radarChart><c:radarStyle val="filled"/>{SER}</c:radarChart>"#
        ))
        .0,
        ChartKind::FilledRadar
    );
    assert_eq!(
        kind(&format!(
            r#"<c:ofPieChart><c:ofPieType val="bar"/>{SER}</c:ofPieChart>"#
        ))
        .0,
        ChartKind::BarOfPie
    );
}

#[test]
fn three_d_is_flagged_never_a_silent_column__feat__sheet_chart_kinds() {
    for (el, k) in [
        ("pie3DChart", ChartKind::Pie),
        ("line3DChart", ChartKind::Line),
        ("area3DChart", ChartKind::Area),
        ("surface3DChart", ChartKind::Surface),
    ] {
        let m = model(&wrap(&format!("<c:{el}>{SER}</c:{el}>")));
        assert_eq!(m.kind(), k, "{el}");
        assert!(m.flattened_3d, "{el} is flagged");
        assert_eq!(m.source.as_deref(), Some(el));
    }
    let m = model(&wrap(&format!(
        r#"<c:bar3DChart><c:barDir val="bar"/>{SER}</c:bar3DChart>"#
    )));
    assert_eq!((m.kind(), m.flattened_3d), (ChartKind::Bar, true));
    // An element nothing draws is a labelled placeholder.
    let m = model(&wrap(&format!("<c:futureChart>{SER}</c:futureChart>")));
    assert_eq!(m.kind(), ChartKind::Unsupported);
    assert_eq!(m.source.as_deref(), Some("futureChart"));
}

#[test]
fn a_combo_keeps_its_plots_and_secondary_axis__feat__sheet_chart_combo() {
    let xml = wrap(&format!(
        r##"<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>{SER}<c:axId val="1"/><c:axId val="2"/></c:barChart>
<c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="1"/><c:val><c:numRef><c:f>Sheet1!$C$1:$C$3</c:f></c:numRef></c:val></c:ser><c:marker val="1"/><c:axId val="3"/><c:axId val="4"/></c:lineChart>
<c:catAx><c:axId val="1"/><c:crossAx val="2"/></c:catAx>
<c:valAx><c:axId val="2"/><c:majorGridlines/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:crossAx val="1"/></c:valAx>
<c:catAx><c:axId val="3"/><c:delete val="1"/><c:crossAx val="4"/></c:catAx>
<c:valAx><c:axId val="4"/><c:scaling><c:logBase val="10"/><c:orientation val="maxMin"/><c:max val="1000"/></c:scaling><c:crosses val="max"/><c:crossAx val="3"/></c:valAx>"##
    ));
    let m = model(&xml);
    assert_eq!(m.plots.len(), 2);
    assert_eq!(m.plots[0].kind, ChartKind::Column);
    assert!(!m.plots[0].secondary);
    assert_eq!(m.plots[1].kind, ChartKind::Line);
    assert!(m.plots[1].secondary);
    assert!(m.val_axis.major_gridlines.is_some());
    assert_eq!(m.val_axis.format.as_deref(), Some("#,##0"));
    let sec = m.sec_val_axis.as_ref().unwrap();
    assert_eq!(
        (sec.log_base, sec.reversed, sec.max, sec.crosses),
        (Some(10.0), true, Some(1000.0), Crosses::Max)
    );
    assert!(m.sec_cat_axis.as_ref().unwrap().deleted);
}

#[test]
fn series_features_are_read__feat__sheet_chart_series_features() {
    let xml = wrap(
        r#"<c:scatterChart><c:scatterStyle val="lineMarker"/><c:ser><c:idx val="0"/>
<c:spPr><a:ln w="28575"><a:solidFill><a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr></a:solidFill><a:prstDash val="dash"/></a:ln></c:spPr>
<c:marker><c:symbol val="triangle"/><c:size val="8"/></c:marker>
<c:dLbls><c:numFmt formatCode="0.0" sourceLinked="0"/><c:dLblPos val="t"/><c:showVal val="1"/><c:showCatName val="0"/></c:dLbls>
<c:trendline><c:trendlineType val="poly"/><c:order val="3"/><c:forward val="2"/><c:dispRSqr val="1"/><c:dispEq val="1"/></c:trendline>
<c:errBars><c:errDir val="y"/><c:errBarType val="plus"/><c:errValType val="cust"/><c:plus><c:numRef><c:f>Data!$D$1:$D$3</c:f></c:numRef></c:plus></c:errBars>
<c:xVal><c:numRef><c:f>Data!$A$1:$A$3</c:f></c:numRef></c:xVal><c:yVal><c:numRef><c:f>Data!$B$1:$B$3</c:f></c:numRef></c:yVal><c:smooth val="1"/></c:ser>
<c:axId val="1"/><c:axId val="2"/></c:scatterChart>
<c:valAx><c:axId val="1"/><c:crossAx val="2"/></c:valAx><c:valAx><c:axId val="2"/><c:crossAx val="1"/></c:valAx>"#,
    );
    let m = model(&xml);
    assert_eq!(m.kind(), ChartKind::Scatter);
    assert_eq!(m.cat_axis.kind, AxisKind::Value);
    let s = m.series().next().unwrap();
    assert_eq!(s.x_values.unwrap().start.sheet, 1);
    assert_eq!(s.values.start.col, 1);
    let l = s.line.as_ref().unwrap();
    assert_eq!(l.color, Some(color_scheme(5, -0.25)));
    assert_eq!((l.width_pt, l.dash.as_deref()), (Some(2.25), Some("dash")));
    let mk = s.marker.as_ref().unwrap();
    assert_eq!((mk.symbol, mk.size), (MarkerSymbol::Triangle, 8.0));
    let dl = s.labels.as_ref().unwrap();
    assert!(dl.show_value && !dl.show_category);
    assert_eq!(
        (dl.position, dl.format.as_deref()),
        (Some(LabelPosition::Top), Some("0.0"))
    );
    let t = &s.trendlines[0];
    assert_eq!(
        (t.kind, t.forward, t.display_r2, t.display_equation),
        (TrendKind::Polynomial(3), 2.0, true, true)
    );
    let e = &s.error_bars[0];
    assert_eq!(e.bar_type, ErrorBarType::Plus);
    assert!(
        matches!(&e.value, ErrorValue::Custom { plus: Some(r), minus: None } if r.start.col == 3)
    );
    assert!(s.smooth);
}

#[test]
fn chart_ex_parts_are_read__feat__sheet_chart_chartex() {
    let xml = br#"<cx:chartSpace xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex">
<cx:chartData><cx:data id="0"><cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$6</cx:f></cx:strDim><cx:numDim type="val"><cx:f>Sheet1!$B$2:$B$6</cx:f></cx:numDim></cx:data></cx:chartData>
<cx:chart><cx:plotArea><cx:plotAreaRegion>
<cx:series layoutId="clusteredColumn" uniqueId="{a}"><cx:dataId val="0"/><cx:layoutPr><cx:aggregation/><cx:binning intervalClosed="l" overflow="9"><cx:binCount val="4"/></cx:binning></cx:layoutPr></cx:series>
<cx:series layoutId="paretoLine" ownerIdx="0" uniqueId="{b}"><cx:axisId val="2"/></cx:series>
</cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>"#;
    let c = parse(xml, 0, &names()).unwrap();
    assert!(c.chart_ex);
    let m = c.model;
    assert_eq!(m.kind(), ChartKind::Pareto);
    assert_eq!(m.plots.len(), 1, "the pareto line is the owner's layout");
    let b = &m.plots[0].ex.bins;
    assert!(b.by_category && b.closed_left);
    assert_eq!((b.count, b.overflow), (Some(4), Some(9.0)));
    assert_eq!(m.series().next().unwrap().values.end.row, 5);
    for (layout, k) in [
        ("waterfall", ChartKind::Waterfall),
        ("funnel", ChartKind::Funnel),
        ("treemap", ChartKind::Treemap),
        ("sunburst", ChartKind::Sunburst),
        ("boxWhisker", ChartKind::BoxWhisker),
        ("regionMap", ChartKind::Unsupported),
    ] {
        let x = format!(
            r#"<cx:chartSpace xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="{layout}"/></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>"#
        );
        let m = model(x.as_bytes());
        assert_eq!(m.kind(), k, "{layout}");
    }
}

#[test]
fn document_references_return_only_while_the_value_holds__feat__sheet_chart_style_roles() {
    let mk = |rgb: &str| {
        format!(
            r#"<c:chartSpace {NS}><c:chart><c:plotArea><c:barChart><c:barDir val="col"/>
<c:ser><c:idx val="0"/><c:spPr><a:solidFill><a:srgbClr val="{rgb}"/></a:solidFill></c:spPr>{}</c:ser></c:barChart></c:plotArea></c:chart>
<c:extLst><c:ext uri="{PAGED_EXT_URI}" xmlns:pg="{PAGED_EXT_NS}"><pg:refs><pg:ref role="series/0/fill" rgb="00A0E0" swatch="Color/Brand"/><pg:ref role="title" paragraph="ParagraphStyle/Head"/></pg:refs></c:ext></c:extLst></c:chartSpace>"#,
            r#"<c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val>"#
        )
        .into_bytes()
    };
    let same = model(&mk("00A0E0"));
    let fill = same.series().next().unwrap().fill.clone().unwrap();
    assert_eq!(
        fill.doc.as_ref().map(|d| d.id.as_str()),
        Some("Color/Brand")
    );
    assert_eq!(
        same.title_style.doc_para_style.as_deref(),
        Some("ParagraphStyle/Head")
    );
    // Recoloured in Excel: the concrete value wins, the reference is dropped.
    let changed = model(&mk("FF0000"));
    assert_eq!(
        changed.series().next().unwrap().fill.as_ref().unwrap().doc,
        None
    );
}

#[test]
fn a_reference_keeps_its_colour_model_and_the_chart_its_palette__feat__sheet_chart_style_roles() {
    let x = format!(
        r#"<c:chartSpace {NS}><c:chart><c:plotArea><c:barChart><c:barDir val="col"/>
<c:ser><c:idx val="0"/><c:spPr><a:solidFill><a:srgbClr val="00A0E0"/></a:solidFill></c:spPr><c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart>
<c:extLst><c:ext uri="{PAGED_EXT_URI}" xmlns:pg="{PAGED_EXT_NS}"><pg:refs><pg:ref role="series/0/fill" rgb="00A0E0" swatch="Color/Brand" model="spot"/></pg:refs><pg:palette group="ColorGroup/Brand"><pg:swatch ref="Color/A|cmyk|0A141E"/><pg:swatch ref="Color/B|lab|28323C"/></pg:palette></c:ext></c:extLst></c:chartSpace>"#
    );
    let m = model(x.as_bytes());
    let fill = m.series().next().unwrap().fill.clone().unwrap();
    assert_eq!(fill.doc.as_ref().unwrap().model, DocColorModel::Spot);
    let p = m.palette.as_ref().unwrap();
    assert_eq!(p.group, "ColorGroup/Brand");
    assert_eq!(p.swatches.len(), 2);
    assert_eq!(p.swatches[0].model, DocColorModel::Cmyk);
    assert_eq!(p.swatches[1].fallback_rgb, (0x28, 0x32, 0x3C));
}

#[test]
fn unknown_sheet_falls_back_to_host_and_quotes_resolve() {
    let m = parse(&wrap(r#"<c:barChart><c:ser><c:val><c:numRef><c:f>Ghost!$B$2:$B$4</c:f></c:numRef></c:val></c:ser></c:barChart>"#), 3, &names())
        .unwrap()
        .model;
    assert_eq!(m.series().next().unwrap().values.start.sheet, 3);
    assert_eq!(
        split_sheet_ref("'My Sheet'!$A$1:$A$3"),
        (Some("My Sheet".to_string()), "$A$1:$A$3")
    );
    assert_eq!(split_sheet_ref("$B$2"), (None, "$B$2"));
}

#[test]
fn titles_are_whole_and_automatic_titles_name_the_series() {
    let xml = format!(
        r#"<c:chartSpace {NS}><c:chart>
  <c:title><c:tx><c:rich><a:p><a:r><a:t>North </a:t></a:r><a:r><a:rPr sz="1600" b="1"/><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title>
  <c:plotArea><c:pieChart><c:ser><c:tx><c:v>Units</c:v></c:tx><c:val><c:numRef><c:f>$A$1:$A$3</c:f></c:numRef></c:val></c:ser></c:pieChart>
</c:plotArea></c:chart></c:chartSpace>"#
    );
    let m = model(xml.as_bytes());
    assert_eq!(m.title.as_deref(), Some("North Sales"));
    assert_eq!(m.title_style.font.size, Some(16.0));
    assert!(m.title_style.font.bold);
    // No c:title, one series, not deleted: Excel titles it with the series.
    let auto = format!(
        r#"<c:chartSpace {NS}><c:chart><c:autoTitleDeleted val="0"/><c:plotArea><c:pieChart><c:ser><c:tx><c:v>Units</c:v></c:tx><c:val><c:numRef><c:f>$A$1:$A$3</c:f></c:numRef></c:val></c:ser></c:pieChart></c:plotArea></c:chart></c:chartSpace>"#
    );
    assert_eq!(model(auto.as_bytes()).title.as_deref(), Some("Units"));
}

#[test]
fn malformed_is_error_not_panic() {
    if let Ok(c) = parse(b"<c:chartSpace><c:chart>", 0, &names()) {
        assert_eq!(c.model.series_count(), 0);
    }
}

/// A column chart whose series, one point, plot area and chart area carry
/// DrawingML beyond one colour, as Excel's styled charts write it.
fn styled_chart() -> Vec<u8> {
    format!(
        r#"<c:chartSpace {NS}><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
      <c:ser><c:idx val="0"/>
        <c:spPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="accent1"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="accent1"><a:alpha val="40000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
          <a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw><a:reflection blurRad="6350" stA="50000" endA="300" endPos="55000" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst></c:spPr>
        <c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:effectLst><a:glow rad="63500"><a:srgbClr val="FFC000"><a:alpha val="40000"/></a:srgbClr></a:glow></a:effectLst></c:spPr></c:dPt>
        <c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser>
      </c:barChart>
      <c:spPr><a:solidFill><a:srgbClr val="F2F2F2"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:effectLst><a:innerShdw blurRad="63500" dist="50800" dir="13500000"><a:prstClr val="black"><a:alpha val="50000"/></a:prstClr></a:innerShdw></a:effectLst></c:spPr>
    </c:plotArea></c:chart>
    <c:spPr><a:pattFill prst="pct50"><a:fgClr><a:srgbClr val="000000"/></a:fgClr><a:bgClr><a:srgbClr val="FFFFFF"/></a:bgClr></a:pattFill><a:effectLst><a:softEdge rad="63500"/></a:effectLst></c:spPr>
    </c:chartSpace>"#
    )
    .into_bytes()
}

#[test]
fn gradients_and_effects_are_read_as_authored__feat__sheet_chart_native_effects() {
    let m = model(&styled_chart());
    let s = m.series().next().unwrap();
    let fx = s.fx.as_deref().expect("series fx");
    assert!(matches!(
        fx.fill,
        Some(paged_ooxml::drawingml::Fill::Gradient(_))
    ));
    assert!(fx.effects.outer_shadow.is_some() && fx.effects.reflection.is_some());
    // The colour a reader without effects draws is the first stop.
    assert!(s.fill.is_some());
    assert_eq!(s.point_fx.len(), 1);
    assert_eq!(s.point_fx[0].0, 1);
    assert!(s.point_fx[0].1.fill.is_none() && s.point_fx[0].1.effects.glow.is_some());
    let pa = m.plot_area.fx.as_deref().unwrap();
    assert!(matches!(
        pa.fill,
        Some(paged_ooxml::drawingml::Fill::Solid(_))
    ));
    assert!(pa.effects.inner_shadow.is_some());
    let ca = m.chart_area.fx.as_deref().unwrap();
    assert!(matches!(
        ca.fill,
        Some(paged_ooxml::drawingml::Fill::Pattern(_))
    ));
    assert_eq!(ca.effects.soft_edge, Some(63500));
}

#[test]
fn styled_charts_lower_onto_native_items_through_the_shared_mapper__feat__sheet_chart_native_effects(
) {
    use sheet_chart::{generate, PlotData, Primitive};
    let m = sheet_chart::style::effective(&model(&styled_chart()), &Default::default());
    let data = PlotData::of(
        vec![vec![3.0, 5.0, 2.0]],
        vec!["a".into(), "b".into(), "c".into()],
    );
    let g = generate(&m, &data, 360.0, 240.0);
    let fx_of = |p: &Primitive| match p {
        Primitive::Rect { fx, .. } => fx.clone(),
        _ => None,
    };
    let rects: Vec<&Primitive> = g
        .prims
        .iter()
        .filter(|p| matches!(p, Primitive::Rect { .. }))
        .collect();
    // The chart area: the pattern's mixed colour, feathered.
    let Primitive::Rect { fill, .. } = rects[0] else {
        unreachable!()
    };
    assert_eq!(fill.as_deref(), Some("#808080"));
    assert_eq!(fx_of(rects[0]).unwrap().feather, Some(5.0));
    // The plot area: half opaque, with an inner shadow up-left.
    let pa = fx_of(rects[1]).unwrap();
    assert_eq!(pa.opacity, Some(50.0));
    let i = pa.inner_shadow.unwrap();
    assert_eq!((i.angle, i.color.as_str()), (135.0, "#000000"));
    assert!((i.distance - 4.0).abs() < 2e-3);
    // The bars: the series' gradient (accent 1 resolved with its
    // transforms), fading through its alpha stop, and its shadow.
    let bars: Vec<_> = rects.iter().filter_map(|p| fx_of(p)).skip(2).collect();
    assert_eq!(bars.len(), 3, "{:?}", g.prims);
    let b0 = &bars[0];
    let gr = b0.gradient.as_ref().unwrap();
    assert_eq!((gr.kind, gr.angle), ("linear", Some(-90.0)));
    assert_eq!(gr.stops[1], (100.0, "#4472C4".to_string()));
    assert_eq!(
        b0.gradient_feather.as_ref().unwrap().stops[1],
        (100.0, 40.0)
    );
    let sh = b0.drop_shadow.as_ref().unwrap();
    assert_eq!((sh.y_offset, sh.size, sh.opacity), (1.5, 2.25, 63.0));
    // Point 1: its own glow, its own solid red, no gradient.
    let b1 = &bars[1];
    assert!(b1.gradient.is_none() && b1.drop_shadow.is_none());
    assert_eq!(b1.outer_glow.as_ref().unwrap().color, "#FFC000");
    // What the page cannot hold is said once per kind.
    assert!(
        g.losses.iter().any(|l| l.contains("reflection")),
        "{:?}",
        g.losses
    );
    assert!(
        g.losses.iter().any(|l| l.contains("pattern")),
        "{:?}",
        g.losses
    );
    assert_eq!(
        g.losses.iter().filter(|l| l.contains("reflection")).count(),
        1
    );
}

#[test]
fn a_document_colour_wins_over_the_files_gradient__feat__sheet_chart_native_effects() {
    let mut m = model(&styled_chart());
    let s = &mut m.plots[0].series[0];
    s.fill = Some(sheet_chart::style::swatch_color(&doc_swatch(
        "Color/Brand",
        0x123456,
    )));
    let e = sheet_chart::style::effective(&m, &Default::default());
    let fx = e.series().next().unwrap().fx.as_deref().unwrap();
    assert!(fx.fill.is_none(), "the swatch paints, not the gradient");
    assert!(fx.effects.outer_shadow.is_some(), "the effects stay");
}

#[test]
fn colours_read_through_the_shared_drawingml_reader() {
    let el = |x: &str| {
        paged_ooxml::tree::parse(
            format!(
                r#"<a:x xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">{x}</a:x>"#
            )
            .as_bytes(),
        )
        .unwrap()
        .children[0]
            .clone()
    };
    // A scheme slot stays a theme reference with its Excel tint.
    let c = color_of(&el(
        r#"<a:schemeClr val="accent2"><a:lumMod val="75000"/></a:schemeClr>"#,
    ))
    .unwrap();
    assert_eq!(c, color_scheme(5, -0.25));
    // Every other colour resolves exactly.
    assert_eq!(
        color_of(&el(
            r#"<a:srgbClr val="808080"><a:lumMod val="50000"/></a:srgbClr>"#
        )),
        Some(color_rgb(0x404040))
    );
    assert_eq!(
        color_of(&el(r#"<a:prstClr val="dkBlue"/>"#)),
        Some(color_rgb(0x00008B))
    );
    assert_eq!(color_of(&el(r#"<a:prstClr val="nonsense"/>"#)), None);
    assert_eq!(
        color_of(&el(r#"<a:sysClr val="window" lastClr="FFFFFF"/>"#)),
        Some(color_rgb(0xFFFFFF))
    );
    assert_eq!(
        color_of(&el(r#"<a:hslClr hue="0" sat="100000" lum="50000"/>"#)),
        Some(color_rgb(0xFF0000))
    );
}
