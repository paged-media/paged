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

//! `c:chartSpace` → [`Chart`]: the chart types, their series with cached
//! values and formula references, the axes, title and legend. A reader of
//! the element tree: an element it does not know is skipped, never an error.

use paged_ooxml::tree::{alternate, El, Ns};

use crate::model::{
    Axis, Chart, ChartTitle, DataLabels, ErrorBars, Legend, Plot, PlotKind, PlotOptions, Series,
    SeriesRefs, Trendline,
};

/// What a module reads of a chart's paints and text: the `S` and `T` of the
/// model. `()` reads neither.
pub trait Props {
    /// The shape properties of a `c:spPr`.
    type Shape: Default + Clone;
    /// The run properties of an `a:rPr` / `a:defRPr`.
    type Text: Clone;
    /// Read a `c:spPr` element.
    fn shape(&self, sp_pr: &El) -> Self::Shape;
    /// Read an `a:rPr` / `a:defRPr` element.
    fn text(&self, r_pr: &El) -> Self::Text;
    /// Each plot as it is read, before its series (paged.slide reports the
    /// chart types it draws flat or not at all).
    fn plot(&self, _element: &El, _kind: &PlotKind) {}
    /// Whether the module reads the cached names, categories and values
    /// (`c:strCache`, `c:numCache`, the literals). paged.sheet binds a series
    /// to the cells its formulas name instead, and leaves them out.
    const CACHES: bool = true;
    /// Whether the module reads the axes and the data labels.
    const AXES_AND_LABELS: bool = true;
}

impl Props for () {
    type Shape = ();
    type Text = ();
    fn shape(&self, _: &El) {}
    fn text(&self, _: &El) {}
}

/// Read a chart part's root element (`c:chartSpace`).
pub fn chart<P: Props>(root: &El, props: &P) -> Chart<P::Shape, P::Text> {
    let mut out = Chart {
        area: sp_pr(root, props),
        text: tx_pr(root, props),
        style: root
            .child(Ns::C, "style")
            .and_then(|s| s.attr_u32("val"))
            .or_else(|| {
                // `c14:style` inside an AlternateContent choice.
                alternate(root.child(Ns::Mc, "AlternateContent")?)
                    .0
                    .and_then(|c| c.children.first())
                    .and_then(|s| s.attr_u32("val"))
                    .map(|v| v.saturating_sub(100))
            }),
        title: None,
        plots: Vec::new(),
        cat_axis: None,
        val_axis: None,
        legend: None,
        plot_area: P::Shape::default(),
        axes: Vec::new(),
        blanks: None,
        view_3d: false,
        chart_ex: false,
    };
    let Some(c) = root.child(Ns::C, "chart") else {
        return out;
    };
    let title_deleted = val_bool(c.child(Ns::C, "autoTitleDeleted"), false);
    out.blanks = val_str(c.child(Ns::C, "dispBlanksAs"));
    out.view_3d = c.child(Ns::C, "view3D").is_some();
    if let Some(t) = c.child(Ns::C, "title") {
        out.title = Some(title(t, props));
    } else if !title_deleted && single_series_auto_title(c) {
        out.title = Some(ChartTitle {
            text: String::new(),
            props: None,
            overlay: false,
        });
    }
    if let Some(pa) = c.child(Ns::C, "plotArea") {
        out.plot_area = sp_pr(pa, props);
        for el in &pa.children {
            if el.ns != Ns::C {
                continue;
            }
            let kind = match el.local.as_str() {
                "barChart" | "bar3DChart" => PlotKind::Bar {
                    horizontal: el.child(Ns::C, "barDir").and_then(|d| d.attr("val"))
                        == Some("bar"),
                    grouping: val_str(el.child(Ns::C, "grouping")).unwrap_or("clustered".into()),
                    gap_width: val_i32(el.child(Ns::C, "gapWidth")).unwrap_or(150),
                    overlap: val_i32(el.child(Ns::C, "overlap")).unwrap_or(0),
                },
                "lineChart" | "line3DChart" => PlotKind::Line {
                    grouping: val_str(el.child(Ns::C, "grouping")).unwrap_or("standard".into()),
                },
                "areaChart" | "area3DChart" => PlotKind::Area {
                    grouping: val_str(el.child(Ns::C, "grouping")).unwrap_or("standard".into()),
                },
                "pieChart" | "pie3DChart" | "doughnutChart" => PlotKind::Pie {
                    first_slice_angle: val_i32(el.child(Ns::C, "firstSliceAng")).unwrap_or(0),
                    hole: (el.local == "doughnutChart")
                        .then(|| val_i32(el.child(Ns::C, "holeSize")).unwrap_or(50)),
                },
                "catAx" | "dateAx" | "valAx" | "serAx" => {
                    if P::AXES_AND_LABELS {
                        let a = axis(el, props);
                        if el.local == "valAx" {
                            if out.val_axis.is_none() {
                                out.val_axis = Some(a.clone());
                            }
                        } else if el.local != "serAx" && out.cat_axis.is_none() {
                            out.cat_axis = Some(a.clone());
                        }
                        out.axes.push(a);
                    }
                    continue;
                }
                local if local.ends_with("Chart") => PlotKind::Other(local.to_string()),
                _ => continue,
            };
            props.plot(el, &kind);
            out.plots.push(Plot {
                kind,
                vary_colors: val_bool(el.child(Ns::C, "varyColors"), false),
                series: el
                    .children_named(Ns::C, "ser")
                    .map(|s| series(s, props))
                    .collect(),
                labels: el
                    .child(Ns::C, "dLbls")
                    .filter(|_| P::AXES_AND_LABELS)
                    .map(|d| labels(d, props)),
                element: el.local.clone(),
                options: plot_options(el),
                axis_ids: el
                    .children_named(Ns::C, "axId")
                    .filter_map(|a| a.attr_u32("val"))
                    .collect(),
            });
        }
    }
    if let Some(l) = c.child(Ns::C, "legend") {
        out.legend = Some(Legend {
            position: val_str(l.child(Ns::C, "legendPos")).unwrap_or("r".into()),
            overlay: val_bool(l.child(Ns::C, "overlay"), false),
            text: tx_pr(l, props),
        });
    }
    out
}

/// PowerPoint titles a chart with one series by that series' name unless
/// the title was deleted.
fn single_series_auto_title(c: &El) -> bool {
    c.child(Ns::C, "plotArea")
        .map(|pa| {
            pa.children
                .iter()
                .flat_map(|p| p.children_named(Ns::C, "ser"))
                .count()
                == 1
        })
        .unwrap_or(false)
}

pub(crate) fn title<P: Props>(t: &El, props: &P) -> ChartTitle<P::Text> {
    let rich = t.path(&[(Ns::C, "tx"), (Ns::C, "rich")]);
    let text = rich
        .map(|r| {
            r.children_named(Ns::A, "p")
                .map(|p| p.deep_text())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .or_else(|| {
            // A title bound to a cell: its cached text.
            t.path(&[(Ns::C, "tx"), (Ns::C, "strRef"), (Ns::C, "strCache")])
                .map(|c| points(c).into_iter().map(|(_, v)| v).collect::<String>())
        })
        .unwrap_or_default();
    // The run properties of a rich title's first run win over its txPr.
    let run = rich.and_then(|r| {
        r.children_named(Ns::A, "p").find_map(|p| {
            p.children_named(Ns::A, "r")
                .find_map(|r| r.child(Ns::A, "rPr"))
                .or_else(|| p.path(&[(Ns::A, "pPr"), (Ns::A, "defRPr")]))
        })
    });
    let props_of = match run {
        Some(rp) => Some(props.text(rp)),
        None => tx_pr(t, props),
    };
    ChartTitle {
        text,
        props: props_of,
        overlay: val_bool(t.child(Ns::C, "overlay"), false),
    }
}

fn series<P: Props>(s: &El, props: &P) -> Series<P::Shape, P::Text> {
    let tx = s.child(Ns::C, "tx");
    let name = tx
        .map(|t| {
            t.path(&[(Ns::C, "strRef"), (Ns::C, "strCache")])
                .map(|c| points(c).into_iter().map(|(_, v)| v).collect::<String>())
                .or_else(|| t.child(Ns::C, "v").map(|v| v.deep_text()))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let (cat, val) = if P::CACHES {
        (
            cache(s.child(Ns::C, "cat").or_else(|| s.child(Ns::C, "xVal"))),
            cache(s.child(Ns::C, "val").or_else(|| s.child(Ns::C, "yVal"))),
        )
    } else {
        (None, None)
    };
    let categories = cat.map(dense_strings).unwrap_or_default();
    let (values, format) = match val {
        Some(v) => {
            let count = v
                .child(Ns::C, "ptCount")
                .and_then(|c| c.attr_u32("val"))
                .unwrap_or(0) as usize;
            let mut vals = vec![None; count];
            for (i, t) in points(v) {
                if i >= vals.len() {
                    vals.resize(i + 1, None);
                }
                vals[i] = t.trim().parse::<f64>().ok();
            }
            (vals, v.child(Ns::C, "formatCode").map(|f| f.deep_text()))
        }
        None => (Vec::new(), None),
    };
    let refs = SeriesRefs {
        name: tx
            .and_then(|t| t.path(&[(Ns::C, "strRef"), (Ns::C, "f")]))
            .map(El::deep_text),
        categories: formula(s.child(Ns::C, "cat")),
        values: formula(s.child(Ns::C, "val")),
        x_values: formula(s.child(Ns::C, "xVal")),
        y_values: formula(s.child(Ns::C, "yVal")),
        bubble_sizes: formula(s.child(Ns::C, "bubbleSize")),
    };
    Series {
        index: val_u32(s.child(Ns::C, "idx")).unwrap_or(0),
        name,
        props: sp_pr(s, props),
        categories,
        values,
        smooth: val_bool(s.child(Ns::C, "smooth"), false),
        marker: s
            .path(&[(Ns::C, "marker"), (Ns::C, "symbol")])
            .and_then(|m| m.attr("val"))
            .map(str::to_string),
        points: s
            .children_named(Ns::C, "dPt")
            .map(|p| (val_u32(p.child(Ns::C, "idx")).unwrap_or(0), sp_pr(p, props)))
            .collect(),
        labels: s
            .child(Ns::C, "dLbls")
            .filter(|_| P::AXES_AND_LABELS)
            .map(|d| labels(d, props)),
        format,
        refs,
        marker_size: s
            .path(&[(Ns::C, "marker"), (Ns::C, "size")])
            .and_then(|m| m.attr_u32("val")),
        marker_props: s
            .path(&[(Ns::C, "marker"), (Ns::C, "spPr")])
            .map(|m| props.shape(m)),
        trendlines: s
            .children_named(Ns::C, "trendline")
            .map(|t| Trendline {
                name: t.child(Ns::C, "name").map(El::deep_text),
                kind: val_str(t.child(Ns::C, "trendlineType")).unwrap_or("linear".into()),
                order: val_u32(t.child(Ns::C, "order")),
                period: val_u32(t.child(Ns::C, "period")),
                forward: val_f64(t.child(Ns::C, "forward")),
                backward: val_f64(t.child(Ns::C, "backward")),
                intercept: val_f64(t.child(Ns::C, "intercept")),
                display_r2: val_bool(t.child(Ns::C, "dispRSqr"), false),
                display_equation: val_bool(t.child(Ns::C, "dispEq"), false),
                props: sp_pr(t, props),
            })
            .collect(),
        error_bars: s
            .children_named(Ns::C, "errBars")
            .map(|e| ErrorBars {
                direction: val_str(e.child(Ns::C, "errDir")),
                bar_type: val_str(e.child(Ns::C, "errBarType")).unwrap_or("both".into()),
                value_type: val_str(e.child(Ns::C, "errValType")).unwrap_or("fixedVal".into()),
                value: val_f64(e.child(Ns::C, "val")),
                no_end_cap: val_bool(e.child(Ns::C, "noEndCap"), false),
                plus: formula(e.child(Ns::C, "plus")),
                minus: formula(e.child(Ns::C, "minus")),
                props: sp_pr(e, props),
            })
            .collect(),
        explosion: val_u32(s.child(Ns::C, "explosion")),
        invert_if_negative: val_bool(s.child(Ns::C, "invertIfNegative"), false),
    }
}

/// The type-specific options of a plot element.
fn plot_options(el: &El) -> PlotOptions {
    PlotOptions {
        scatter_style: val_str(el.child(Ns::C, "scatterStyle")),
        radar_style: val_str(el.child(Ns::C, "radarStyle")),
        bubble_scale: val_u32(el.child(Ns::C, "bubbleScale")),
        show_neg_bubbles: val_bool(el.child(Ns::C, "showNegBubbles"), false),
        size_represents: val_str(el.child(Ns::C, "sizeRepresents")),
        of_pie_type: val_str(el.child(Ns::C, "ofPieType")),
        split_type: val_str(el.child(Ns::C, "splitType")),
        split_pos: val_f64(el.child(Ns::C, "splitPos")),
        cust_split: el
            .child(Ns::C, "custSplit")
            .map(|c| {
                c.children_named(Ns::C, "secondPiePt")
                    .filter_map(|p| p.attr_u32("val"))
                    .collect()
            })
            .unwrap_or_default(),
        second_pie_size: val_u32(el.child(Ns::C, "secondPieSize")),
        hi_low_lines: el.child(Ns::C, "hiLowLines").is_some(),
        up_down_bars: el.child(Ns::C, "upDownBars").is_some(),
        drop_lines: el.child(Ns::C, "dropLines").is_some(),
        marker: el.child(Ns::C, "marker").map(|m| val_bool(Some(m), true)),
        wireframe: val_bool(el.child(Ns::C, "wireframe"), false),
        ex: Default::default(),
    }
}

/// The cached values under a `c:cat` / `c:val` (number, string, literal or
/// the first level of a multi-level string cache).
fn cache(el: Option<&El>) -> Option<&El> {
    let el = el?;
    el.path(&[(Ns::C, "numRef"), (Ns::C, "numCache")])
        .or_else(|| el.path(&[(Ns::C, "strRef"), (Ns::C, "strCache")]))
        .or_else(|| el.child(Ns::C, "numLit"))
        .or_else(|| el.child(Ns::C, "strLit"))
        .or_else(|| {
            el.path(&[(Ns::C, "multiLvlStrRef"), (Ns::C, "multiLvlStrCache")])
                .and_then(|m| m.child(Ns::C, "lvl"))
        })
}

/// The formula a `c:cat` / `c:val` / `c:xVal` / `c:yVal` is bound to.
fn formula(el: Option<&El>) -> Option<String> {
    let el = el?;
    ["numRef", "strRef", "multiLvlStrRef"]
        .iter()
        .find_map(|r| el.path(&[(Ns::C, r), (Ns::C, "f")]))
        .map(El::deep_text)
}

/// `c:pt` children as (idx, text).
fn points(cache: &El) -> Vec<(usize, String)> {
    cache
        .children_named(Ns::C, "pt")
        .map(|p| {
            (
                p.attr_u32("idx").unwrap_or(0) as usize,
                p.child(Ns::C, "v")
                    .map(|v| v.deep_text())
                    .unwrap_or_default(),
            )
        })
        .collect()
}

fn dense_strings(cache: &El) -> Vec<String> {
    let count = cache
        .child(Ns::C, "ptCount")
        .and_then(|c| c.attr_u32("val"))
        .unwrap_or(0) as usize;
    let mut out = vec![String::new(); count];
    for (i, t) in points(cache) {
        if i >= out.len() {
            out.resize(i + 1, String::new());
        }
        out[i] = t;
    }
    out
}

fn labels<P: Props>(d: &El, props: &P) -> DataLabels<P::Text> {
    DataLabels {
        show_value: val_bool(d.child(Ns::C, "showVal"), false),
        show_category: val_bool(d.child(Ns::C, "showCatName"), false),
        show_series: val_bool(d.child(Ns::C, "showSerName"), false),
        show_percent: val_bool(d.child(Ns::C, "showPercent"), false),
        position: val_str(d.child(Ns::C, "dLblPos")),
        text: tx_pr(d, props),
        format: d
            .child(Ns::C, "numFmt")
            .and_then(|f| f.attr("formatCode"))
            .map(str::to_string),
        show_bubble_size: val_bool(d.child(Ns::C, "showBubbleSize"), false),
        separator: d.child(Ns::C, "separator").map(El::deep_text),
    }
}

fn axis<P: Props>(el: &El, props: &P) -> Axis<P::Shape, P::Text> {
    let scaling = el.child(Ns::C, "scaling");
    let num = |name: &str| {
        scaling
            .and_then(|s| s.child(Ns::C, name))
            .and_then(|m| m.attr("val"))
            .and_then(|v| v.parse::<f64>().ok())
    };
    let fmt = el.child(Ns::C, "numFmt");
    Axis {
        id: val_u32(el.child(Ns::C, "axId")).unwrap_or(0),
        cross_ax: val_u32(el.child(Ns::C, "crossAx")).unwrap_or(0),
        element: el.local.clone(),
        title: el.child(Ns::C, "title").map(|t| title(t, props)),
        log_base: num("logBase"),
        minor_unit: val_f64(el.child(Ns::C, "minorUnit")),
        crosses: val_str(el.child(Ns::C, "crosses")),
        crosses_at: val_f64(el.child(Ns::C, "crossesAt")),
        base_time_unit: val_str(el.child(Ns::C, "baseTimeUnit")),
        deleted: val_bool(el.child(Ns::C, "delete"), false),
        position: val_str(el.child(Ns::C, "axPos")).unwrap_or_default(),
        major_gridlines: el.child(Ns::C, "majorGridlines").map(|g| sp_pr(g, props)),
        minor_gridlines: el.child(Ns::C, "minorGridlines").map(|g| sp_pr(g, props)),
        line: sp_pr(el, props),
        text: tx_pr(el, props),
        tick_labels: val_str(el.child(Ns::C, "tickLblPos")).unwrap_or("nextTo".into()),
        min: num("min"),
        max: num("max"),
        reversed: scaling
            .and_then(|s| s.child(Ns::C, "orientation"))
            .and_then(|o| o.attr("val"))
            == Some("maxMin"),
        major_unit: el
            .child(Ns::C, "majorUnit")
            .and_then(|m| m.attr("val"))
            .and_then(|v| v.parse().ok()),
        format: fmt
            .filter(|f| f.attr("sourceLinked") != Some("1"))
            .and_then(|f| f.attr("formatCode"))
            .map(str::to_string),
    }
}

pub(crate) fn sp_pr<P: Props>(el: &El, props: &P) -> P::Shape {
    el.child(Ns::C, "spPr")
        .map(|s| props.shape(s))
        .unwrap_or_default()
}

/// `c:txPr`: the default run properties of its first paragraph.
pub(crate) fn tx_pr<P: Props>(el: &El, props: &P) -> Option<P::Text> {
    el.child(Ns::C, "txPr")?
        .children_named(Ns::A, "p")
        .find_map(|p| p.path(&[(Ns::A, "pPr"), (Ns::A, "defRPr")]))
        .map(|d| props.text(d))
}

fn val_str(el: Option<&El>) -> Option<String> {
    el.and_then(|e| e.attr("val")).map(str::to_string)
}

fn val_i32(el: Option<&El>) -> Option<i32> {
    el.and_then(|e| e.attr_i32("val"))
}

fn val_f64(el: Option<&El>) -> Option<f64> {
    el.and_then(|e| e.attr("val"))
        .and_then(|v| v.trim().parse().ok())
}

fn val_u32(el: Option<&El>) -> Option<u32> {
    el.and_then(|e| e.attr_u32("val"))
}

/// A boolean `val` (an element present without `val` means true).
fn val_bool(el: Option<&El>, default: bool) -> bool {
    match el {
        Some(e) => e
            .attr("val")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(true),
        None => default,
    }
}
