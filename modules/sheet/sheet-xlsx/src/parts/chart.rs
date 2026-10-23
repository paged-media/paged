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

//! `xl/charts/chartN.xml` and `xl/charts/chartExN.xml` — DrawingML charts
//! (ECMA-376 §21.2) and Office 2016 chartEx parts, read by the shared reader
//! (`dml_chart`, which paged.slide reads its charts with too) and folded
//! into the [`sheet_chart::ChartModel`] (W4, ADR 519).
//!
//! ## What we read
//!
//! - Every plot of the plot area, each as its own [`Plot`] (a combo chart
//!   keeps its column plot and its line plot), with its kind, grouping
//!   (clustered / stacked / percent-stacked, for bars, lines and areas),
//!   axis group (a plot whose value axis is not the first one is on the
//!   secondary axis) and type options (gap, overlap, hole, first slice,
//!   bubble scale, pie-of-pie split, high-low lines, up/down bars).
//! - KIND RULING (`sheet.chart.kinds`, replacing the silent column): every
//!   element maps to its own kind; a 3-D element maps to its 2-D kind with
//!   [`ChartModel::flattened_3d`] set; an element or chartEx layout with no
//!   drawing (a region map, an unknown future type) is
//!   [`ChartKind::Unsupported`] and names its source. Nothing is ever drawn
//!   as a column because it was not understood.
//! - Each series: its cached name and name cell, categories, values, X
//!   values, bubble sizes (all bound to the cells their `c:f` names), fill,
//!   line, marker, per-point fills, data labels, trendlines, error bars,
//!   smoothing, explosion, invert-if-negative.
//! - The axes (primary and secondary): title, bounds, units, log base,
//!   orientation, crossing, date base unit, number format, gridlines, line,
//!   tick-label text and position, deletion. The title, legend, chart and
//!   plot area paints, default text and `c:style`.
//! - Colours as [`ColorRef`]s: `a:srgbClr`, `a:schemeClr` (a theme slot with
//!   its `lumMod`/`lumOff`/`tint`/`shade` as an Excel tint), `a:sysClr`,
//!   `a:prstClr`; `a:noFill` lines are `none`.
//! - DOCUMENT REFERENCES: Paged writes the document swatch / style a role
//!   was bound to into a paged `c:extLst` extension beside the concrete
//!   value it wrote ([`PAGED_EXT_URI`]); on re-import a reference is restored
//!   only when the role's concrete value is still the one recorded — a
//!   colour changed in Excel wins over the stale reference.
//!
//! ## Round-trip
//!
//! Parsing is read-only; the part stays an opaque OPC part. An unedited
//! chart re-emits byte-identical. An edited one is spliced by the writer
//! (`dml_chart::write`, ADR 503 amendment): only what changed is replaced.

use std::collections::HashMap;

use crate::error::XlsxError;
use compact_str::CompactString;
use dml_chart::{PlotKind, Series as DmlSeries};
use paged_ooxml::tree::{El, Ns};
use sheet_chart::model::*;
use sheet_core::{parse_a1, CellRef, RangeRef, SheetId};

/// The `c:ext` uri of Paged's document-reference extension.
pub const PAGED_EXT_URI: &str = "{6B3D2E6A-8C1F-4F5B-9A47-2C0D51E8B7A3}";
/// Its element namespace.
pub const PAGED_EXT_NS: &str = "http://paged.media/2026/chart-refs";

/// Resolves an XLSX sheet NAME to its model [`SheetId`].
pub trait SheetResolver {
    fn resolve(&self, name: &str) -> Option<SheetId>;
    /// The reference a workbook defined name stands for (`Sheet1!$A$1:$A$4`):
    /// Excel writes a chartEx part's data as hidden `_xlchart.v1.N` names.
    fn defined(&self, _name: &str) -> Option<String> {
        None
    }
}

/// The text a defined name of `model` refers to, when it is a reference.
pub fn defined_reference(model: &sheet_core::SheetModel, name: &str) -> Option<String> {
    use sheet_core::names::NameTarget;
    let (_, def) = model
        .names
        .iter()
        .find(|(_, d)| d.name.eq_ignore_ascii_case(name))?;
    match &def.target {
        NameTarget::Formula(t) => Some(t.trim_start_matches('=').to_string()),
        NameTarget::Range(r) => {
            let n = r.normalized();
            let sheet = model.sheet(n.start.sheet)?;
            Some(format!(
                "{}!${}${}:${}${}",
                crate::structure::quote_sheet(&sheet.name),
                sheet_core::col_to_a1(n.start.col),
                n.start.row + 1,
                sheet_core::col_to_a1(n.end.col),
                n.end.row + 1
            ))
        }
    }
}

/// A parsed chart plus where it lives.
#[derive(Clone, Debug)]
pub struct ParsedChart {
    /// The worksheet (or chartsheet) that hosts the chart.
    pub host_sheet: SheetId,
    /// The chart model.
    pub model: ChartModel,
    /// The chart part (`xl/charts/chart1.xml`); `None` for a chart authored
    /// in Paged and not yet saved.
    pub part: Option<String>,
    /// The drawing part that anchors it, and the anchor's relationship id.
    pub drawing: Option<String>,
    /// Read from a chartEx part.
    pub chart_ex: bool,
    /// The host is a chartsheet (the chart IS the tab).
    pub chartsheet: bool,
    /// The model changed since the part was read (the writer splices it).
    pub dirty: bool,
    /// Where an authored chart is anchored: (from col, from row, to col,
    /// to row), zero-based cells.
    pub anchor: Option<(u32, u32, u32, u32)>,
    /// A deleted chart's slot (its part is gone; the index stays taken).
    pub removed: bool,
}

impl ParsedChart {
    /// A chart authored in Paged (no part yet).
    pub fn authored(host_sheet: SheetId, model: ChartModel) -> ParsedChart {
        ParsedChart {
            host_sheet,
            model,
            part: None,
            drawing: None,
            chart_ex: false,
            chartsheet: false,
            dirty: true,
            anchor: None,
            removed: false,
        }
    }
}

// ── the Excel profile: paints and text into the chart model's roles ──────────

/// A `c:spPr` as the chart roles need it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShapeProps {
    pub fill: Option<ColorRef>,
    pub no_fill: bool,
    pub line: Option<LineStyle>,
}

/// What the Excel profile reads of a chart.
struct ExcelProfile;

/// A DrawingML colour choice element → a [`ColorRef`].
pub fn color_of(el: &El) -> Option<ColorRef> {
    let mods = |el: &El| {
        let pct = |name: &str| {
            el.child(Ns::A, name)
                .and_then(|m| m.attr("val"))
                .and_then(|v| v.trim().parse::<f64>().ok())
                .map(|v| v / 100_000.0)
        };
        let tint = sheet_chart::colors::tint_of(pct("lumMod"), pct("lumOff"));
        if tint != 0.0 {
            tint
        } else if let Some(t) = pct("tint") {
            1.0 - t
        } else if let Some(s) = pct("shade") {
            s - 1.0
        } else {
            0.0
        }
    };
    let concrete = match el.local.as_str() {
        "srgbClr" => {
            let v = u32::from_str_radix(el.attr("val")?.trim(), 16).ok()?;
            color_rgb(sheet_chart::colors::apply_tint(v, mods(el)))
        }
        "sysClr" => {
            let v = el
                .attr("lastClr")
                .and_then(|v| u32::from_str_radix(v.trim(), 16).ok())
                .unwrap_or(if el.attr("val") == Some("window") {
                    0xFFFFFF
                } else {
                    0
                });
            color_rgb(sheet_chart::colors::apply_tint(v, mods(el)))
        }
        "schemeClr" => {
            let idx = match el.attr("val")? {
                "dk1" | "tx1" => 0,
                "lt1" | "bg1" => 1,
                "dk2" | "tx2" => 2,
                "lt2" | "bg2" => 3,
                "accent1" => 4,
                "accent2" => 5,
                "accent3" => 6,
                "accent4" => 7,
                "accent5" => 8,
                "accent6" => 9,
                "hlink" => 10,
                "folHlink" => 11,
                _ => return Some(ColorRef::auto()),
            };
            color_scheme(idx, mods(el))
        }
        "prstClr" => color_rgb(match el.attr("val")? {
            "black" => 0x000000,
            "white" => 0xFFFFFF,
            "red" => 0xFF0000,
            "green" => 0x008000,
            "blue" => 0x0000FF,
            "yellow" => 0xFFFF00,
            "gray" | "grey" => 0x808080,
            _ => return None,
        }),
        "scrgbClr" => {
            let c = |n: &str| {
                el.attr(n)
                    .and_then(|v| v.parse::<f64>().ok())
                    .map_or(0, |v| {
                        ((v / 100_000.0).clamp(0.0, 1.0) * 255.0).round() as u32
                    })
            };
            color_rgb((c("r") << 16) | (c("g") << 8) | c("b"))
        }
        _ => return None,
    };
    Some(concrete)
}

/// The colour of a `a:solidFill` (or the first colour child of `el`).
fn solid(el: &El) -> Option<ColorRef> {
    el.child(Ns::A, "solidFill")
        .and_then(|f| f.children.iter().find_map(color_of))
}

/// The first colour of a gradient fill (Excel draws a gradient; the chart
/// paints its first stop).
fn grad_first(el: &El) -> Option<ColorRef> {
    el.path(&[(Ns::A, "gradFill"), (Ns::A, "gsLst")])
        .and_then(|g| g.children.first())
        .and_then(|gs| gs.children.iter().find_map(color_of))
}

impl dml_chart::Props for ExcelProfile {
    type Shape = ShapeProps;
    type Text = FontSpec;
    fn shape(&self, sp: &El) -> ShapeProps {
        let line = sp.child(Ns::A, "ln").map(|ln| LineStyle {
            color: solid(ln),
            width_pt: ln
                .attr("w")
                .and_then(|w| w.parse::<f64>().ok())
                .map(|emu| emu / 12_700.0),
            dash: ln
                .child(Ns::A, "prstDash")
                .and_then(|d| d.attr("val"))
                .filter(|d| *d != "solid")
                .map(CompactString::new),
            none: ln.child(Ns::A, "noFill").is_some(),
        });
        ShapeProps {
            fill: solid(sp).or_else(|| grad_first(sp)),
            no_fill: sp.child(Ns::A, "noFill").is_some(),
            line,
        }
    }
    fn text(&self, rp: &El) -> FontSpec {
        FontSpec {
            name: rp
                .child(Ns::A, "latin")
                .and_then(|l| l.attr("typeface"))
                .filter(|t| !t.starts_with('+'))
                .map(str::to_string),
            size: rp
                .attr("sz")
                .and_then(|s| s.parse::<f64>().ok())
                .map(|s| s / 100.0),
            bold: rp.attr_bool("b").unwrap_or(false),
            italic: rp.attr_bool("i").unwrap_or(false),
            color: solid(rp),
            ..FontSpec::default()
        }
    }
    const CACHES: bool = false;
    const AXES_AND_LABELS: bool = true;
}

fn text_ref(t: Option<&FontSpec>) -> TextStyleRef {
    TextStyleRef {
        font: t.cloned().unwrap_or_default(),
        ..TextStyleRef::default()
    }
}

fn area_of(sp: &ShapeProps) -> AreaStyle {
    AreaStyle {
        fill: sp.fill.clone(),
        no_fill: sp.no_fill,
        line: sp.line.clone(),
    }
}

// ── parse ────────────────────────────────────────────────────────────────────

/// Parse a `chartN.xml` part. `host_sheet` is the sheet the chart is
/// anchored to; `resolver` maps `c:f` sheet names to model ids. `Err` only
/// on malformed XML.
pub fn parse(
    xml: &[u8],
    host_sheet: SheetId,
    resolver: &impl SheetResolver,
) -> Result<ParsedChart, XlsxError> {
    let root = paged_ooxml::tree::parse(xml).map_err(XlsxError::Structure)?;
    let ex = root.is(Ns::Cx, "chartSpace");
    let chart = if ex {
        dml_chart::chart_ex(&root, &ExcelProfile)
    } else {
        dml_chart::chart(&root, &ExcelProfile)
    };
    let mut model = fold(&chart, host_sheet, resolver);
    apply_paged_refs(&root, &mut model);
    Ok(ParsedChart {
        host_sheet,
        model,
        part: None,
        drawing: None,
        chart_ex: ex,
        chartsheet: false,
        dirty: false,
        anchor: None,
        removed: false,
    })
}

type DChart = dml_chart::Chart<ShapeProps, FontSpec>;
type DPlot = dml_chart::Plot<ShapeProps, FontSpec>;
type DAxis = dml_chart::Axis<ShapeProps, FontSpec>;

/// The kind a plot element is drawn as, and whether it was flattened.
pub fn kind_of(plot: &DPlot) -> (ChartKind, Grouping, bool) {
    let grouping = |g: &str| match g {
        "stacked" => Grouping::Stacked,
        "percentStacked" => Grouping::PercentStacked,
        _ => Grouping::Standard,
    };
    let el = plot.element.as_str();
    let flat = el.contains("3D");
    let o = &plot.options;
    match (&plot.kind, el) {
        (
            PlotKind::Bar {
                horizontal,
                grouping: g,
                ..
            },
            _,
        ) => (
            if *horizontal {
                ChartKind::Bar
            } else {
                ChartKind::Column
            },
            grouping(g),
            flat,
        ),
        (PlotKind::Line { grouping: g }, _) => (ChartKind::Line, grouping(g), flat),
        (PlotKind::Area { grouping: g }, _) => (ChartKind::Area, grouping(g), flat),
        (PlotKind::Pie { hole: Some(_), .. }, _) => (ChartKind::Donut, Grouping::Standard, flat),
        (PlotKind::Pie { .. }, _) => (ChartKind::Pie, Grouping::Standard, flat),
        (_, "ofPieChart") => (
            if o.of_pie_type.as_deref() == Some("bar") {
                ChartKind::BarOfPie
            } else {
                ChartKind::PieOfPie
            },
            Grouping::Standard,
            false,
        ),
        (_, "scatterChart") => (ChartKind::Scatter, Grouping::Standard, false),
        (_, "bubbleChart") => (ChartKind::Bubble, Grouping::Standard, false),
        (_, "radarChart") => (
            if o.radar_style.as_deref() == Some("filled") {
                ChartKind::FilledRadar
            } else {
                ChartKind::Radar
            },
            Grouping::Standard,
            false,
        ),
        (_, "stockChart") => (ChartKind::Stock, Grouping::Standard, false),
        (_, "surfaceChart") | (_, "surface3DChart") => (
            ChartKind::Surface,
            Grouping::Standard,
            el == "surface3DChart",
        ),
        (_, "cx:waterfall") => (ChartKind::Waterfall, Grouping::Standard, false),
        (_, "cx:funnel") => (ChartKind::Funnel, Grouping::Standard, false),
        (_, "cx:treemap") => (ChartKind::Treemap, Grouping::Standard, false),
        (_, "cx:sunburst") => (ChartKind::Sunburst, Grouping::Standard, false),
        (_, "cx:boxWhisker") => (ChartKind::BoxWhisker, Grouping::Standard, false),
        (_, "cx:paretoLine") => (ChartKind::Pareto, Grouping::Standard, false),
        (_, "cx:clusteredColumn") => (ChartKind::Histogram, Grouping::Standard, false),
        _ => (ChartKind::Unsupported, Grouping::Standard, false),
    }
}

fn shape_fill(sp: &ShapeProps) -> Option<ColorRef> {
    if sp.no_fill {
        None
    } else {
        sp.fill.clone()
    }
}

fn fold(chart: &DChart, host: SheetId, resolver: &impl SheetResolver) -> ChartModel {
    let mut model = ChartModel::default();
    let range = |f: &Option<String>| {
        f.as_deref()
            .and_then(|f| parse_f_ref(f.trim(), host, resolver))
    };
    // The axis groups: the first plot's axes are primary.
    let primary_ids: Vec<u32> = chart
        .plots
        .first()
        .map(|p| p.axis_ids.clone())
        .unwrap_or_default();
    let axis_by_id = |id: u32| chart.axes.iter().find(|a| a.id == id);
    let mut flattened = false;
    let mut sources: Vec<String> = Vec::new();
    let pareto = chart.plots.iter().any(|p| p.element == "cx:paretoLine");
    for p in &chart.plots {
        let (mut kind, grouping, flat) = kind_of(p);
        flattened |= flat || (chart.view_3d && p.element.contains("3D"));
        if p.element == "cx:paretoLine" {
            continue; // drawn by the pareto layout of its owner
        }
        if pareto && kind == ChartKind::Histogram {
            kind = ChartKind::Pareto;
        }
        if kind == ChartKind::Unsupported || flat {
            sources.push(p.element.clone());
        }
        let secondary = !p.axis_ids.is_empty()
            && !primary_ids.is_empty()
            && p.axis_ids != primary_ids
            && p.axis_ids.iter().any(|id| !primary_ids.contains(id));
        let o = &p.options;
        let mut plot = Plot {
            kind,
            grouping,
            secondary,
            series: Vec::new(),
            vary_colors: p.vary_colors,
            labels: p.labels.as_ref().map(labels_of),
            hi_low_lines: o.hi_low_lines,
            up_down_bars: o.up_down_bars,
            drop_lines: o.drop_lines,
            bubble_scale: o.bubble_scale.unwrap_or(100),
            bubble_size_is_width: o.size_represents.as_deref() == Some("w"),
            ..Plot::default()
        };
        match &p.kind {
            PlotKind::Bar {
                gap_width, overlap, ..
            } => {
                plot.gap_width = (*gap_width).max(0) as u32;
                plot.overlap = *overlap;
            }
            PlotKind::Pie {
                first_slice_angle,
                hole,
            } => {
                plot.first_slice_angle = (*first_slice_angle).max(0) as u32;
                plot.hole_size = hole.unwrap_or(50).max(0) as u32;
            }
            _ => {}
        }
        if matches!(kind, ChartKind::PieOfPie | ChartKind::BarOfPie) {
            plot.of_pie = OfPie {
                split: match o.split_type.as_deref() {
                    Some("val") => SplitType::Value,
                    Some("percent") => SplitType::Percent,
                    Some("cust") => SplitType::Custom,
                    _ => SplitType::Position,
                },
                split_pos: o.split_pos,
                custom: o.cust_split.clone(),
                second_size: o.second_pie_size.unwrap_or(75),
            };
        }
        let ex = &o.ex;
        plot.ex = ExOptions {
            subtotals: ex.subtotals.clone(),
            bins: Binning {
                by_category: ex.aggregation,
                count: ex.bin_count,
                width: ex.bin_size,
                overflow: ex.overflow.as_deref().and_then(|v| v.parse().ok()),
                underflow: ex.underflow.as_deref().and_then(|v| v.parse().ok()),
                closed_left: ex.interval_closed.as_deref() == Some("l"),
            },
            box_whisker: BoxOptions {
                inclusive: ex.quartile_method.as_deref() == Some("inclusive"),
                mean_line: ex.mean_line.unwrap_or(false),
                mean_marker: ex.mean_marker.unwrap_or(true),
                inner_points: ex.nonoutliers.unwrap_or(false),
                outliers: ex.outliers.unwrap_or(true),
            },
            parent_labels: ex.parent_label_layout.as_deref().map(CompactString::new),
        };
        if kind.is_chart_ex() {
            plot.gap_width = if matches!(kind, ChartKind::Histogram | ChartKind::Pareto) {
                0
            } else {
                150
            };
        }
        let markers_off = o.marker == Some(false);
        for s in &p.series {
            plot.series.push(series_of(s, kind, markers_off, &range));
        }
        model.plots.push(plot);
    }
    // A chartEx part writes one series element per series: consecutive
    // series of one layout are one plot.
    if chart.chart_ex {
        let mut merged: Vec<Plot> = Vec::new();
        for p in std::mem::take(&mut model.plots) {
            match merged.last_mut() {
                Some(last) if last.kind == p.kind => last.series.extend(p.series),
                _ => merged.push(p),
            }
        }
        model.plots = merged;
    }
    if model.plots.is_empty() {
        // An empty or unreadable plot area: a placeholder, never a column.
        model.plots.push(Plot {
            kind: if chart.plots.is_empty() {
                ChartKind::Column
            } else {
                ChartKind::Unsupported
            },
            ..Plot::default()
        });
    }
    model.flattened_3d = flattened;
    model.source = sources.first().map(|s| CompactString::new(s));
    // Axes.
    let prim_cat = primary_ids
        .first()
        .and_then(|id| axis_by_id(*id))
        .or(chart.cat_axis.as_ref());
    let prim_val = primary_ids
        .get(1)
        .and_then(|id| axis_by_id(*id))
        .or(chart.val_axis.as_ref());
    if let Some(a) = prim_cat {
        model.cat_axis = axis_of(a);
    }
    if let Some(a) = prim_val {
        model.val_axis = axis_of(a);
    }
    if let Some(sp) = chart
        .plots
        .iter()
        .find(|p| !p.axis_ids.is_empty() && !primary_ids.is_empty() && p.axis_ids != primary_ids)
    {
        model.sec_cat_axis = sp
            .axis_ids
            .first()
            .and_then(|id| axis_by_id(*id))
            .map(axis_of);
        model.sec_val_axis = sp
            .axis_ids
            .get(1)
            .and_then(|id| axis_by_id(*id))
            .map(axis_of);
    }
    if model.kind().is_xy() {
        model.cat_axis.kind = AxisKind::Value;
    }
    // Title (an automatic title is the single series' name).
    if let Some(t) = &chart.title {
        let text = if t.text.trim().is_empty() {
            if model.series_count() == 1 {
                model
                    .series()
                    .next()
                    .and_then(|s| s.name.clone())
                    .unwrap_or_else(|| "Chart Title".into())
            } else {
                "Chart Title".into()
            }
        } else {
            CompactString::new(t.text.trim())
        };
        model.title = Some(text);
        model.title_style = text_ref(t.props.as_ref());
        model.title_overlay = t.overlay;
    }
    model.legend = chart.legend.as_ref().map(|l| Legend {
        position: LegendPosition::from_tag(&l.position),
        overlay: l.overlay,
        style: text_ref(l.text.as_ref()),
    });
    model.chart_area = area_of(&chart.area);
    model.plot_area = area_of(&chart.plot_area);
    model.text = text_ref(chart.text.as_ref());
    model.style = chart.style;
    model.blanks = match chart.blanks.as_deref() {
        Some("zero") => Blanks::Zero,
        Some("span") => Blanks::Span,
        _ => Blanks::Gap,
    };
    model
}

fn labels_of(d: &dml_chart::DataLabels<FontSpec>) -> DataLabels {
    DataLabels {
        show_value: d.show_value,
        show_category: d.show_category,
        show_series: d.show_series,
        show_percent: d.show_percent,
        show_bubble_size: d.show_bubble_size,
        position: d.position.as_deref().and_then(LabelPosition::from_tag),
        format: d.format.as_deref().map(CompactString::new),
        separator: d.separator.as_deref().map(CompactString::new),
        style: text_ref(d.text.as_ref()),
    }
}

fn series_of(
    s: &DmlSeries<ShapeProps, FontSpec>,
    kind: ChartKind,
    markers_off: bool,
    range: &impl Fn(&Option<String>) -> Option<RangeRef>,
) -> Series {
    let xy = kind.is_xy();
    let values = range(&s.refs.values)
        .or_else(|| range(&s.refs.y_values))
        .unwrap_or_else(|| empty_range(0));
    let mut out = Series::of(values);
    let name = s.name.trim();
    out.name = (!name.is_empty()).then(|| CompactString::new(name));
    out.name_ref = range(&s.refs.name);
    if xy {
        out.x_values = range(&s.refs.x_values).or_else(|| range(&s.refs.categories));
    } else {
        out.categories = range(&s.refs.categories).or_else(|| range(&s.refs.x_values));
    }
    out.sizes = range(&s.refs.bubble_sizes);
    out.fill = shape_fill(&s.props);
    out.line = s.props.line.clone();
    let mut marker = s.marker.as_deref().map(|sym| Marker {
        symbol: MarkerSymbol::from_tag(sym),
        ..Marker::default()
    });
    if marker.is_none() && markers_off {
        marker = Some(Marker {
            symbol: MarkerSymbol::None,
            ..Marker::default()
        });
    }
    if let Some(m) = marker.as_mut() {
        if let Some(sz) = s.marker_size {
            m.size = sz as f64;
        }
        if let Some(mp) = &s.marker_props {
            m.fill = shape_fill(mp);
            m.line = mp.line.as_ref().and_then(|l| l.color.clone());
        }
    } else if let Some(mp) = &s.marker_props {
        marker = Some(Marker {
            fill: shape_fill(mp),
            line: mp.line.as_ref().and_then(|l| l.color.clone()),
            ..Marker::default()
        });
    }
    out.marker = marker;
    out.points = s
        .points
        .iter()
        .filter_map(|(i, sp)| shape_fill(sp).map(|c| (*i, c)))
        .collect();
    out.labels = s.labels.as_ref().map(labels_of);
    out.trendlines = s
        .trendlines
        .iter()
        .map(|t| Trendline {
            kind: match t.kind.as_str() {
                "exp" => TrendKind::Exponential,
                "log" => TrendKind::Logarithmic,
                "poly" => TrendKind::Polynomial(t.order.unwrap_or(2).clamp(2, 6) as u8),
                "power" => TrendKind::Power,
                "movingAvg" => TrendKind::MovingAverage(t.period.unwrap_or(2).max(2)),
                _ => TrendKind::Linear,
            },
            name: t.name.as_deref().map(CompactString::new),
            forward: t.forward.unwrap_or(0.0),
            backward: t.backward.unwrap_or(0.0),
            intercept: t.intercept,
            display_r2: t.display_r2,
            display_equation: t.display_equation,
            line: t.props.line.clone(),
        })
        .collect();
    out.error_bars = s
        .error_bars
        .iter()
        .map(|e| ErrorBars {
            along_x: e.direction.as_deref() == Some("x"),
            bar_type: match e.bar_type.as_str() {
                "plus" => ErrorBarType::Plus,
                "minus" => ErrorBarType::Minus,
                _ => ErrorBarType::Both,
            },
            value: match e.value_type.as_str() {
                "percentage" => ErrorValue::Percentage(e.value.unwrap_or(5.0)),
                "stdDev" => ErrorValue::StdDev(e.value.unwrap_or(1.0)),
                "stdErr" => ErrorValue::StdErr,
                "cust" => ErrorValue::Custom {
                    plus: range(&e.plus),
                    minus: range(&e.minus),
                },
                _ => ErrorValue::Fixed(e.value.unwrap_or(1.0)),
            },
            no_end_cap: e.no_end_cap,
            line: e.props.line.clone(),
        })
        .collect();
    out.smooth = s.smooth;
    out.explosion = s.explosion.unwrap_or(0);
    out.invert_if_negative = s.invert_if_negative;
    out.index = Some(s.index);
    out
}

fn axis_of(a: &DAxis) -> Axis {
    let grid = |g: &Option<ShapeProps>| {
        g.as_ref().map(|sp| match &sp.line {
            Some(l) => l.clone(),
            None => LineStyle::default(),
        })
    };
    Axis {
        title: a
            .title
            .as_ref()
            .map(|t| CompactString::new(t.text.trim()))
            .filter(|t| !t.is_empty()),
        title_style: text_ref(a.title.as_ref().and_then(|t| t.props.as_ref())),
        kind: match a.element.as_str() {
            "dateAx" => AxisKind::Date,
            "valAx" => AxisKind::Value,
            _ => AxisKind::Category,
        },
        min: a.min,
        max: a.max,
        major_unit: a.major_unit,
        minor_unit: a.minor_unit,
        log_base: a.log_base,
        reversed: a.reversed,
        crosses: match (a.crosses.as_deref(), a.crosses_at) {
            (_, Some(v)) => Crosses::At(v),
            (Some("min"), _) => Crosses::Min,
            (Some("max"), _) => Crosses::Max,
            _ => Crosses::AutoZero,
        },
        base_unit: match a.base_time_unit.as_deref() {
            Some("days") => Some(TimeUnit::Days),
            Some("months") => Some(TimeUnit::Months),
            Some("years") => Some(TimeUnit::Years),
            _ => None,
        },
        format: a.format.as_deref().map(CompactString::new),
        deleted: a.deleted,
        major_gridlines: grid(&a.major_gridlines),
        minor_gridlines: grid(&a.minor_gridlines),
        line: a.line.line.clone(),
        labels: text_ref(a.text.as_ref()),
        tick_labels: match a.tick_labels.as_str() {
            "low" => TickLabels::Low,
            "high" => TickLabels::High,
            "none" => TickLabels::None,
            _ => TickLabels::NextTo,
        },
    }
}

// ── document references (the paged extension) ───────────────────────────────

/// One recorded reference: the role, the concrete value written, the
/// document ids.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoleRef {
    pub role: String,
    pub rgb: Option<u32>,
    pub swatch: Option<String>,
    pub paragraph: Option<String>,
    pub character: Option<String>,
}

/// The references recorded in a part's paged extension.
pub fn read_paged_refs(root: &El) -> Vec<RoleRef> {
    let Some(ext) = root
        .child(Ns::C, "extLst")
        .or_else(|| root.child(Ns::Cx, "extLst"))
        .and_then(|l| {
            l.children
                .iter()
                .find(|e| e.local == "ext" && e.attr("uri") == Some(PAGED_EXT_URI))
        })
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    fn walk(el: &El, out: &mut Vec<RoleRef>) {
        if el.local == "ref" {
            out.push(RoleRef {
                role: el.attr("role").unwrap_or("").to_string(),
                rgb: el.attr("rgb").and_then(|v| u32::from_str_radix(v, 16).ok()),
                swatch: el.attr("swatch").map(str::to_string),
                paragraph: el.attr("paragraph").map(str::to_string),
                character: el.attr("character").map(str::to_string),
            });
        }
        for c in &el.children {
            walk(c, out);
        }
    }
    walk(ext, &mut out);
    out
}

/// Every colour and text role of a model, by its role path, for recording
/// and restoring references.
pub fn color_roles(model: &mut ChartModel) -> Vec<(String, &mut Option<ColorRef>)> {
    let mut out: Vec<(String, &mut Option<ColorRef>)> = Vec::new();
    out.push(("chartArea".into(), &mut model.chart_area.fill));
    out.push(("plotArea".into(), &mut model.plot_area.fill));
    let mut i = 0;
    for p in model.plots.iter_mut() {
        for s in p.series.iter_mut() {
            out.push((format!("series/{i}/fill"), &mut s.fill));
            if let Some(l) = s.line.as_mut() {
                out.push((format!("series/{i}/line"), &mut l.color));
            }
            i += 1;
        }
    }
    for (name, a) in [
        ("catAx", &mut model.cat_axis),
        ("valAx", &mut model.val_axis),
    ] {
        if let Some(l) = a.line.as_mut() {
            out.push((format!("{name}/line"), &mut l.color));
        }
        if let Some(g) = a.major_gridlines.as_mut() {
            out.push((format!("{name}/gridlines"), &mut g.color));
        }
    }
    out
}

/// Every text role of a model, by its role path.
pub fn text_roles(model: &mut ChartModel) -> Vec<(String, &mut TextStyleRef)> {
    let mut out: Vec<(String, &mut TextStyleRef)> = vec![
        ("text".into(), &mut model.text),
        ("title".into(), &mut model.title_style),
        ("catAx/title".into(), &mut model.cat_axis.title_style),
        ("valAx/title".into(), &mut model.val_axis.title_style),
        ("catAx/labels".into(), &mut model.cat_axis.labels),
        ("valAx/labels".into(), &mut model.val_axis.labels),
    ];
    if let Some(l) = model.legend.as_mut() {
        out.push(("legend".into(), &mut l.style));
    }
    let mut i = 0;
    for p in model.plots.iter_mut() {
        for s in p.series.iter_mut() {
            if let Some(d) = s.labels.as_mut() {
                out.push((format!("series/{i}/labels"), &mut d.style));
            }
            i += 1;
        }
    }
    out
}

/// The concrete sRGB of a colour as written (theme colours are written as
/// themselves, so they compare by their value against the default theme —
/// a reference on a theme colour is kept while the slot and tint match).
pub fn concrete_rgb(c: &ColorRef) -> Option<u32> {
    match c.concrete {
        ConcreteColor::Rgb { .. } => rgb_of(c),
        ConcreteColor::Theme { index, tint } => Some(sheet_chart::colors::apply_tint(
            sheet_chart::colors::OFFICE_THEME
                [usize::from(dml_to_sheet_index(index.min(11) as u8)) % 12],
            tint,
        )),
        _ => None,
    }
}

/// Restore the recorded references whose concrete value is unchanged.
fn apply_paged_refs(root: &El, model: &mut ChartModel) {
    let refs = read_paged_refs(root);
    if refs.is_empty() {
        return;
    }
    let by_role: HashMap<&str, &RoleRef> = refs.iter().map(|r| (r.role.as_str(), r)).collect();
    for (role, slot) in color_roles(model) {
        let Some(r) = by_role.get(role.as_str()) else {
            continue;
        };
        let Some(sw) = &r.swatch else { continue };
        if let Some(c) = slot.as_mut() {
            if let Some(rgb) = concrete_rgb(c).filter(|v| Some(*v) == r.rgb) {
                c.doc = Some(doc_swatch(sw, rgb));
            }
        }
    }
    for (role, t) in text_roles(model) {
        let Some(r) = by_role.get(role.as_str()) else {
            continue;
        };
        // A text reference holds while the run colour written is unchanged
        // (or none was recorded).
        let now = t.font.color.as_ref().and_then(concrete_rgb);
        if r.rgb.is_none() || r.rgb == now {
            t.doc_para_style = r.paragraph.clone();
            t.doc_char_style = r.character.clone();
        }
    }
}

// ── references ───────────────────────────────────────────────────────────────

fn empty_range(sheet: SheetId) -> RangeRef {
    let c = CellRef {
        sheet,
        row: 0,
        col: 0,
        row_abs: false,
        col_abs: false,
    };
    RangeRef { start: c, end: c }
}

/// Parse a `c:f` range-ref body (`Sheet1!$B$1:$B$3`, `'My Sheet'!$A$1`, or a
/// bare `$B$1:$B$3`). A parenthesised union takes its first area.
pub fn parse_f_ref(
    s: &str,
    host_sheet: SheetId,
    resolver: &impl SheetResolver,
) -> Option<RangeRef> {
    let s = s.trim().trim_start_matches('(').trim_end_matches(')');
    let s = s.split(',').next()?.trim();
    if s.is_empty() {
        return None;
    }
    // A defined name (no sheet, no cell address): what it refers to.
    if !s.contains('!') && !s.contains('$') && parse_a1(s).is_none() {
        let target = resolver.defined(s)?;
        if target == s {
            return None;
        }
        return parse_f_ref(&target, host_sheet, resolver);
    }
    let (sheet_part, range_part) = split_sheet_ref(s);
    let sheet = sheet_part
        .and_then(|name| resolver.resolve(&name))
        .unwrap_or(host_sheet);
    let mk = |row, col| CellRef {
        sheet,
        row,
        col,
        row_abs: false,
        col_abs: false,
    };
    match range_part.split_once(':') {
        Some((a, b)) => {
            let (r0, c0, _, _) = parse_a1(strip_dollars(a).as_str())?;
            let (r1, c1, _, _) = parse_a1(strip_dollars(b).as_str())?;
            Some(RangeRef {
                start: mk(r0, c0),
                end: mk(r1, c1),
            })
        }
        None => {
            let (r, c, _, _) = parse_a1(strip_dollars(range_part).as_str())?;
            Some(RangeRef {
                start: mk(r, c),
                end: mk(r, c),
            })
        }
    }
}

fn split_sheet_ref(s: &str) -> (Option<String>, &str) {
    if let Some(rest) = s.strip_prefix('\'') {
        if let Some(close) = find_closing_quote(rest) {
            let name = rest[..close].replace("''", "'");
            let after = &rest[close + 1..];
            if let Some(range) = after.strip_prefix('!') {
                return (Some(name), range);
            }
        }
        return (None, s);
    }
    match s.rsplit_once('!') {
        Some((name, range)) => (Some(name.to_string()), range),
        None => (None, s),
    }
}

fn find_closing_quote(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if bytes.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

fn strip_dollars(s: &str) -> String {
    s.replace('$', "")
}

#[cfg(test)]
#[path = "chart_tests.rs"]
mod tests;
