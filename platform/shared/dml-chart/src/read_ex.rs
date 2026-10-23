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

//! `cx:chartSpace` (the Office 2016 chartEx part: waterfall, funnel,
//! treemap, sunburst, histogram, pareto, box & whisker, region map) →
//! [`Chart`]. Each `cx:series` becomes a plot whose element is
//! `cx:<layoutId>`, its data dimensions (`cx:data` by `cx:dataId`) become
//! the series' references and cached values, and `cx:layoutPr` becomes the
//! plot's [`ExLayout`].
//!
//! A pareto chart is a `clusteredColumn` series with binning plus a
//! `paretoLine` series owned by it (`ownerIdx`); both are read as written.

use paged_ooxml::tree::{El, Ns};

use crate::model::{
    Axis, Chart, ChartTitle, DataLabels, ExLayout, Legend, Plot, PlotKind, PlotOptions, Series,
    SeriesRefs,
};
use crate::read::Props;

fn attr_f64(el: &El, name: &str) -> Option<f64> {
    el.attr(name).and_then(|v| v.trim().parse().ok())
}

fn bool_attr(el: Option<&El>, name: &str) -> Option<bool> {
    el.and_then(|e| e.attr_bool(name))
}

/// The text of a `cx:tx` (`cx:txData/cx:v`, or rich `cx:rich` runs).
fn tx_text(tx: &El) -> (String, Option<String>) {
    if let Some(d) = tx.child(Ns::Cx, "txData") {
        let f = d.child(Ns::Cx, "f").map(El::deep_text);
        let v = d.child(Ns::Cx, "v").map(El::deep_text).unwrap_or_default();
        return (v, f);
    }
    if let Some(r) = tx.child(Ns::Cx, "rich") {
        let t = r
            .children_named(Ns::A, "p")
            .map(|p| p.deep_text())
            .collect::<Vec<_>>()
            .join("\n");
        return (t, None);
    }
    (String::new(), None)
}

/// One data dimension: its formula, levels (innermost first) and format.
struct Dim<'a> {
    kind: String,
    f: Option<String>,
    levels: Vec<&'a El>,
}

fn dims(data: &El) -> Vec<Dim<'_>> {
    data.children
        .iter()
        .filter(|d| d.ns == Ns::Cx && (d.local == "numDim" || d.local == "strDim"))
        .map(|d| Dim {
            kind: d.attr("type").unwrap_or("val").to_string(),
            f: d.child(Ns::Cx, "f").map(El::deep_text),
            levels: d.children_named(Ns::Cx, "lvl").collect(),
        })
        .collect()
}

fn level_strings(l: &El) -> Vec<String> {
    let n = l.attr_u32("ptCount").unwrap_or(0) as usize;
    let mut out = vec![String::new(); n];
    for p in l.children_named(Ns::Cx, "pt") {
        let i = p.attr_u32("idx").unwrap_or(0) as usize;
        if i >= out.len() {
            out.resize(i + 1, String::new());
        }
        out[i] = p.deep_text();
    }
    out
}

/// Read a chartEx part's root element.
pub fn chart_ex<P: Props>(root: &El, props: &P) -> Chart<P::Shape, P::Text> {
    let mut out: Chart<P::Shape, P::Text> = Chart {
        title: None,
        plots: Vec::new(),
        cat_axis: None,
        val_axis: None,
        legend: None,
        area: root
            .child(Ns::Cx, "spPr")
            .map(|sp| props.shape(sp))
            .unwrap_or_default(),
        plot_area: P::Shape::default(),
        text: None,
        style: None,
        axes: Vec::new(),
        blanks: None,
        view_3d: false,
        chart_ex: true,
    };
    let datas: Vec<(u32, &El)> = root
        .child(Ns::Cx, "chartData")
        .map(|cd| {
            cd.children_named(Ns::Cx, "data")
                .map(|d| (d.attr_u32("id").unwrap_or(0), d))
                .collect()
        })
        .unwrap_or_default();
    let Some(c) = root.child(Ns::Cx, "chart") else {
        return out;
    };
    if let Some(t) = c.child(Ns::Cx, "title") {
        let text = t
            .child(Ns::Cx, "tx")
            .map(|tx| tx_text(tx).0)
            .unwrap_or_default();
        out.title = Some(ChartTitle {
            text,
            props: None,
            overlay: t.attr_bool("overlay").unwrap_or(false),
        });
    }
    if let Some(pa) = c.child(Ns::Cx, "plotArea") {
        if let Some(region) = pa.child(Ns::Cx, "plotAreaRegion") {
            for s in region.children_named(Ns::Cx, "series") {
                let layout = s.attr("layoutId").unwrap_or("clusteredColumn").to_string();
                let (name, name_ref) = s.child(Ns::Cx, "tx").map(tx_text).unwrap_or_default();
                let data_id = s.child(Ns::Cx, "dataId").and_then(|d| d.attr_u32("val"));
                let data = data_id.and_then(|id| datas.iter().find(|d| d.0 == id).map(|d| d.1));
                let mut refs = SeriesRefs {
                    name: name_ref,
                    ..SeriesRefs::default()
                };
                let mut categories = Vec::new();
                let mut values = Vec::new();
                let mut format = None;
                if let Some(d) = data {
                    for dim in dims(d) {
                        match dim.kind.as_str() {
                            "cat" | "colorStr" if refs.categories.is_none() => {
                                refs.categories = dim.f.clone();
                                if P::CACHES {
                                    categories = dim
                                        .levels
                                        .first()
                                        .map(|l| level_strings(l))
                                        .unwrap_or_default();
                                }
                            }
                            "size" | "val" | "x" | "y" | "colorVal" if refs.values.is_none() => {
                                refs.values = dim.f.clone();
                                if let Some(l) = dim.levels.first() {
                                    format = l.attr("formatCode").map(str::to_string);
                                    if P::CACHES {
                                        values = level_strings(l)
                                            .iter()
                                            .map(|v| v.trim().parse::<f64>().ok())
                                            .collect();
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                let lp = s.child(Ns::Cx, "layoutPr");
                let binning = lp.and_then(|l| l.child(Ns::Cx, "binning"));
                let vis = lp.and_then(|l| l.child(Ns::Cx, "visibility"));
                let ex = ExLayout {
                    subtotals: lp
                        .and_then(|l| l.child(Ns::Cx, "subtotals"))
                        .map(|st| {
                            st.children_named(Ns::Cx, "idx")
                                .filter_map(|i| i.attr_u32("val"))
                                .collect()
                        })
                        .unwrap_or_default(),
                    bin_size: binning
                        .and_then(|b| b.child(Ns::Cx, "binSize"))
                        .and_then(|b| attr_f64(b, "val")),
                    bin_count: binning
                        .and_then(|b| b.child(Ns::Cx, "binCount"))
                        .and_then(|b| b.attr_u32("val")),
                    interval_closed: binning
                        .and_then(|b| b.attr("intervalClosed"))
                        .map(str::to_string),
                    underflow: binning
                        .and_then(|b| b.attr("underflow"))
                        .map(str::to_string),
                    overflow: binning.and_then(|b| b.attr("overflow")).map(str::to_string),
                    aggregation: lp.and_then(|l| l.child(Ns::Cx, "aggregation")).is_some(),
                    quartile_method: lp
                        .and_then(|l| l.child(Ns::Cx, "statistics"))
                        .and_then(|st| st.attr("quartileMethod"))
                        .map(str::to_string),
                    mean_line: bool_attr(vis, "meanLine"),
                    mean_marker: bool_attr(vis, "meanMarker"),
                    nonoutliers: bool_attr(vis, "nonoutliers"),
                    outliers: bool_attr(vis, "outliers"),
                    parent_label_layout: lp
                        .and_then(|l| l.child(Ns::Cx, "parentLabelLayout"))
                        .and_then(|p| p.attr("val"))
                        .map(str::to_string),
                    owner_idx: s.attr_u32("ownerIdx"),
                };
                let labels = s.child(Ns::Cx, "dataLabels").map(|d| {
                    let v = d.child(Ns::Cx, "visibility");
                    DataLabels {
                        show_value: bool_attr(v, "value").unwrap_or(v.is_none()),
                        show_category: bool_attr(v, "categoryName").unwrap_or(false),
                        show_series: bool_attr(v, "seriesName").unwrap_or(false),
                        show_percent: false,
                        position: d.attr("pos").map(str::to_string),
                        text: None,
                        format: d
                            .child(Ns::Cx, "numFmt")
                            .and_then(|f| f.attr("formatCode"))
                            .map(str::to_string),
                        show_bubble_size: false,
                        separator: None,
                    }
                });
                let series = Series {
                    index: out.plots.len() as u32,
                    name,
                    props: s
                        .child(Ns::Cx, "spPr")
                        .map(|sp| props.shape(sp))
                        .unwrap_or_default(),
                    categories,
                    values,
                    labels,
                    format,
                    refs,
                    points: s
                        .children_named(Ns::Cx, "dataPt")
                        .map(|p| {
                            (
                                p.attr_u32("idx").unwrap_or(0),
                                p.child(Ns::Cx, "spPr")
                                    .map(|sp| props.shape(sp))
                                    .unwrap_or_default(),
                            )
                        })
                        .collect(),
                    smooth: false,
                    marker: None,
                    marker_size: None,
                    marker_props: None,
                    trendlines: Vec::new(),
                    error_bars: Vec::new(),
                    explosion: None,
                    invert_if_negative: false,
                };
                let kind = PlotKind::Other(layout.clone());
                out.plots.push(Plot {
                    kind,
                    vary_colors: false,
                    series: vec![series],
                    labels: None,
                    element: format!("cx:{layout}"),
                    options: PlotOptions {
                        ex,
                        ..PlotOptions::default()
                    },
                    axis_ids: Vec::new(),
                });
            }
        }
        for a in pa.children_named(Ns::Cx, "axis") {
            let val = a.child(Ns::Cx, "valScaling");
            let cat = a.child(Ns::Cx, "catScaling");
            let axis: Axis<P::Shape, P::Text> = Axis {
                id: a.attr_u32("id").unwrap_or(0),
                element: if val.is_some() {
                    "valAx".into()
                } else {
                    "catAx".into()
                },
                deleted: a.attr_bool("hidden").unwrap_or(false),
                major_gridlines: a.child(Ns::Cx, "majorGridlines").map(|g| {
                    g.child(Ns::Cx, "spPr")
                        .map(|sp| props.shape(sp))
                        .unwrap_or_default()
                }),
                minor_gridlines: a.child(Ns::Cx, "minorGridlines").map(|g| {
                    g.child(Ns::Cx, "spPr")
                        .map(|sp| props.shape(sp))
                        .unwrap_or_default()
                }),
                min: val.and_then(|v| attr_f64(v, "min")),
                max: val.and_then(|v| attr_f64(v, "max")),
                major_unit: val.and_then(|v| attr_f64(v, "majorUnit")),
                minor_unit: val.and_then(|v| attr_f64(v, "minorUnit")),
                title: a.child(Ns::Cx, "title").map(|t| ChartTitle {
                    text: t
                        .child(Ns::Cx, "tx")
                        .map(|tx| tx_text(tx).0)
                        .unwrap_or_default(),
                    props: None,
                    overlay: false,
                }),
                format: a
                    .child(Ns::Cx, "numFmt")
                    .and_then(|f| f.attr("formatCode"))
                    .map(str::to_string),
                tick_labels: if a.child(Ns::Cx, "tickLabels").is_some() {
                    "nextTo".into()
                } else {
                    "none".into()
                },
                cross_ax: 0,
                log_base: None,
                crosses: None,
                crosses_at: None,
                base_time_unit: None,
                position: String::new(),
                line: a
                    .child(Ns::Cx, "spPr")
                    .map(|sp| props.shape(sp))
                    .unwrap_or_default(),
                text: None,
                reversed: cat.and_then(|c| c.attr("orientation")) == Some("maxMin"),
            };
            if axis.element == "valAx" && out.val_axis.is_none() {
                out.val_axis = Some(axis.clone());
            } else if axis.element == "catAx" && out.cat_axis.is_none() {
                out.cat_axis = Some(axis.clone());
            }
            out.axes.push(axis);
        }
    }
    if let Some(l) = c.child(Ns::Cx, "legend") {
        out.legend = Some(Legend {
            position: l.attr("pos").unwrap_or("r").to_string(),
            overlay: l.attr_bool("overlay").unwrap_or(false),
            text: None,
        });
    }
    out
}

/// The levels of a multi-level category dimension, outermost first, as the
/// part caches them (for a reader that draws from the caches).
pub fn category_levels(root: &El, data_id: u32) -> Vec<Vec<String>> {
    let Some(d) = root.child(Ns::Cx, "chartData").and_then(|cd| {
        cd.children_named(Ns::Cx, "data")
            .find(|d| d.attr_u32("id") == Some(data_id))
    }) else {
        return Vec::new();
    };
    dims(d)
        .into_iter()
        .find(|d| d.kind == "cat")
        .map(|d| d.levels.iter().rev().map(|l| level_strings(l)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const WATERFALL: &str = r#"<cx:chartSpace xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex">
<cx:chartData><cx:data id="0">
<cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$4</cx:f><cx:lvl ptCount="3"><cx:pt idx="0">Start</cx:pt><cx:pt idx="1">Up</cx:pt><cx:pt idx="2">End</cx:pt></cx:lvl></cx:strDim>
<cx:numDim type="val"><cx:f>Sheet1!$B$2:$B$4</cx:f><cx:lvl ptCount="3" formatCode="General"><cx:pt idx="0">10</cx:pt><cx:pt idx="1">5</cx:pt><cx:pt idx="2">15</cx:pt></cx:lvl></cx:numDim>
</cx:data></cx:chartData>
<cx:chart><cx:title><cx:tx><cx:txData><cx:v>Bridge</cx:v></cx:txData></cx:tx></cx:title>
<cx:plotArea><cx:plotAreaRegion><cx:series layoutId="waterfall" uniqueId="{1}"><cx:tx><cx:txData><cx:f>Sheet1!$B$1</cx:f><cx:v>Amount</cx:v></cx:txData></cx:tx><cx:dataId val="0"/><cx:layoutPr><cx:subtotals><cx:idx val="2"/></cx:subtotals></cx:layoutPr></cx:series></cx:plotAreaRegion>
<cx:axis id="0"><cx:catScaling gapWidth="0.5"/><cx:tickLabels/></cx:axis><cx:axis id="1"><cx:valScaling/><cx:majorGridlines/><cx:tickLabels/></cx:axis></cx:plotArea>
<cx:legend pos="t" align="ctr" overlay="0"/></cx:chart></cx:chartSpace>"#;

    #[test]
    fn reads_a_waterfall() {
        let root = paged_ooxml::tree::parse(WATERFALL.as_bytes()).unwrap();
        let c = chart_ex(&root, &());
        assert!(c.chart_ex);
        assert_eq!(c.title.as_ref().unwrap().text, "Bridge");
        assert_eq!(c.plots.len(), 1);
        let p = &c.plots[0];
        assert_eq!(p.element, "cx:waterfall");
        assert_eq!(p.options.ex.subtotals, vec![2]);
        let s = &p.series[0];
        assert_eq!(s.name, "Amount");
        assert_eq!(s.refs.name.as_deref(), Some("Sheet1!$B$1"));
        assert_eq!(s.refs.categories.as_deref(), Some("Sheet1!$A$2:$A$4"));
        assert_eq!(s.refs.values.as_deref(), Some("Sheet1!$B$2:$B$4"));
        assert_eq!(s.values, vec![Some(10.0), Some(5.0), Some(15.0)]);
        assert_eq!(s.categories[2], "End");
        assert_eq!(c.axes.len(), 2);
        assert!(c.val_axis.as_ref().unwrap().major_gridlines.is_some());
        assert_eq!(c.legend.as_ref().unwrap().position, "t");
    }
}
