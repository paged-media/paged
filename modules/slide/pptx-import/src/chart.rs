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
//! values, the axes, title and legend.

use pptx_core::chart::{Axis, Chart, ChartTitle, DataLabels, Legend, Plot, PlotKind, Series};
use pptx_core::{RunProps, ShapeProps};

use crate::shapes::shape_props;
use crate::text::run_props;
use crate::xml::{El, Ns};
use crate::Ctx;

/// Read a chart part's root element.
pub fn chart(root: &El, ctx: &Ctx) -> Chart {
    let mut out = Chart {
        area: sp_pr(root, ctx),
        text: tx_pr(root, ctx),
        style: root
            .child(Ns::C, "style")
            .and_then(|s| s.attr_u32("val"))
            .or_else(|| {
                // `c14:style` inside an AlternateContent choice.
                crate::xml::alternate(root.child(Ns::Mc, "AlternateContent")?)
                    .0
                    .and_then(|c| c.children.first())
                    .and_then(|s| s.attr_u32("val"))
                    .map(|v| v.saturating_sub(100))
            }),
        ..Default::default()
    };
    let Some(c) = root.child(Ns::C, "chart") else {
        return out;
    };
    let title_deleted = val_bool(c.child(Ns::C, "autoTitleDeleted"), false);
    if let Some(t) = c.child(Ns::C, "title") {
        out.title = Some(title(t, ctx));
    } else if !title_deleted && single_series_auto_title(c) {
        out.title = Some(ChartTitle::default());
    }
    if let Some(pa) = c.child(Ns::C, "plotArea") {
        out.plot_area = sp_pr(pa, ctx);
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
                "catAx" | "dateAx" => {
                    out.cat_axis = Some(axis(el, ctx));
                    continue;
                }
                "valAx" => {
                    out.val_axis = Some(axis(el, ctx));
                    continue;
                }
                local if local.ends_with("Chart") => PlotKind::Other(local.to_string()),
                _ => continue,
            };
            if matches!(kind, PlotKind::Other(_)) || el.local.contains("3D") {
                ctx.note(format!("chart type {} drawn flat or not at all", el.local));
            }
            out.plots.push(Plot {
                kind,
                vary_colors: val_bool(el.child(Ns::C, "varyColors"), false),
                series: el
                    .children_named(Ns::C, "ser")
                    .map(|s| series(s, ctx))
                    .collect(),
                labels: el.child(Ns::C, "dLbls").map(|d| labels(d, ctx)),
            });
        }
    }
    if let Some(l) = c.child(Ns::C, "legend") {
        out.legend = Some(Legend {
            position: val_str(l.child(Ns::C, "legendPos")).unwrap_or("r".into()),
            overlay: val_bool(l.child(Ns::C, "overlay"), false),
            text: tx_pr(l, ctx),
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

fn title(t: &El, ctx: &Ctx) -> ChartTitle {
    let rich = t.path(&[(Ns::C, "tx"), (Ns::C, "rich")]);
    let text = rich
        .map(|r| {
            r.children_named(Ns::A, "p")
                .map(|p| p.deep_text())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    // The run properties of a rich title's first run win over its txPr.
    let props = rich
        .and_then(|r| {
            r.children_named(Ns::A, "p").find_map(|p| {
                p.children_named(Ns::A, "r")
                    .find_map(|r| r.child(Ns::A, "rPr"))
                    .or_else(|| p.path(&[(Ns::A, "pPr"), (Ns::A, "defRPr")]))
            })
        })
        .map(|rp| run_props(rp, ctx))
        .or_else(|| tx_pr(t, ctx));
    ChartTitle {
        text,
        props,
        overlay: val_bool(t.child(Ns::C, "overlay"), false),
    }
}

fn series(s: &El, ctx: &Ctx) -> Series {
    let name = s
        .child(Ns::C, "tx")
        .map(|t| {
            t.path(&[(Ns::C, "strRef"), (Ns::C, "strCache")])
                .map(|c| points(c).into_iter().map(|(_, v)| v).collect::<String>())
                .or_else(|| t.child(Ns::C, "v").map(|v| v.deep_text()))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let cat = cache(s.child(Ns::C, "cat").or_else(|| s.child(Ns::C, "xVal")));
    let val = cache(s.child(Ns::C, "val").or_else(|| s.child(Ns::C, "yVal")));
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
    Series {
        index: val_u32(s.child(Ns::C, "idx")).unwrap_or(0),
        name,
        props: sp_pr(s, ctx),
        categories,
        values,
        smooth: val_bool(s.child(Ns::C, "smooth"), false),
        marker: s
            .path(&[(Ns::C, "marker"), (Ns::C, "symbol")])
            .and_then(|m| m.attr("val"))
            .map(str::to_string),
        points: s
            .children_named(Ns::C, "dPt")
            .map(|p| (val_u32(p.child(Ns::C, "idx")).unwrap_or(0), sp_pr(p, ctx)))
            .collect(),
        labels: s.child(Ns::C, "dLbls").map(|d| labels(d, ctx)),
        format,
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

fn labels(d: &El, ctx: &Ctx) -> DataLabels {
    DataLabels {
        show_value: val_bool(d.child(Ns::C, "showVal"), false),
        show_category: val_bool(d.child(Ns::C, "showCatName"), false),
        show_series: val_bool(d.child(Ns::C, "showSerName"), false),
        show_percent: val_bool(d.child(Ns::C, "showPercent"), false),
        position: val_str(d.child(Ns::C, "dLblPos")),
        text: tx_pr(d, ctx),
        format: d
            .child(Ns::C, "numFmt")
            .and_then(|f| f.attr("formatCode"))
            .map(str::to_string),
    }
}

fn axis(el: &El, ctx: &Ctx) -> Axis {
    let scaling = el.child(Ns::C, "scaling");
    let num = |name: &str| {
        scaling
            .and_then(|s| s.child(Ns::C, name))
            .and_then(|m| m.attr("val"))
            .and_then(|v| v.parse::<f64>().ok())
    };
    let fmt = el.child(Ns::C, "numFmt");
    Axis {
        deleted: val_bool(el.child(Ns::C, "delete"), false),
        position: val_str(el.child(Ns::C, "axPos")).unwrap_or_default(),
        major_gridlines: el.child(Ns::C, "majorGridlines").map(|g| sp_pr(g, ctx)),
        minor_gridlines: el.child(Ns::C, "minorGridlines").map(|g| sp_pr(g, ctx)),
        line: sp_pr(el, ctx),
        text: tx_pr(el, ctx),
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

fn sp_pr(el: &El, ctx: &Ctx) -> ShapeProps {
    el.child(Ns::C, "spPr")
        .map(|s| shape_props(s, ctx))
        .unwrap_or_default()
}

/// `c:txPr`: the default run properties of its first paragraph.
fn tx_pr(el: &El, ctx: &Ctx) -> Option<RunProps> {
    el.child(Ns::C, "txPr")?
        .children_named(Ns::A, "p")
        .find_map(|p| p.path(&[(Ns::A, "pPr"), (Ns::A, "defRPr")]))
        .map(|d| run_props(d, ctx))
}

fn val_str(el: Option<&El>) -> Option<String> {
    el.and_then(|e| e.attr("val")).map(str::to_string)
}

fn val_i32(el: Option<&El>) -> Option<i32> {
    el.and_then(|e| e.attr_i32("val"))
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
