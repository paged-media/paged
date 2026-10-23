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

//! The DrawingML chart WRITER: one module-neutral chart description
//! ([`ChartOut`]) generated as a complete `c:chartSpace` (or `cx:chartSpace`
//! for the Office 2016 kinds), and the SPLICE primitives that patch a part
//! as written — replace one child in schema order, keep every other byte of
//! the tree as it was (paged.sheet ADR 503 amendment: "existing parts are
//! patched; parts Paged creates are generated").
//!
//! Element order follows ECMA-376 Part 1 §21.2 (CT_ChartSpace, CT_PlotArea,
//! the per-type CT_*Chart and CT_*Ser sequences, CT_CatAx / CT_ValAx /
//! CT_DateAx / CT_SerAx). Colours and text are written as the module
//! resolved them: an sRGB value, or a theme slot with its `lumMod`/`lumOff`
//! when the role was theme-sourced.

use std::fmt::Write as _;

use paged_ooxml::tree::{El, Ns};

pub const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
pub const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
pub const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub const NS_CX: &str = "http://schemas.microsoft.com/office/drawing/2014/chartex";

// ── the description ─────────────────────────────────────────────────────────

/// A colour as written.
#[derive(Clone, Debug, PartialEq)]
pub enum ColorOut {
    Srgb(u32),
    /// `a:schemeClr` (`accent1`, `tx1`, …) with optional `lumMod`/`lumOff`
    /// in 1/1000 of a percent (`60000` = 60%).
    Scheme {
        slot: String,
        lum_mod: Option<i64>,
        lum_off: Option<i64>,
    },
}

/// Run properties (`a:defRPr` / `a:rPr`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RunOut {
    pub font: Option<String>,
    /// Points.
    pub size: Option<f64>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub color: Option<ColorOut>,
}

impl RunOut {
    pub fn is_empty(&self) -> bool {
        *self == RunOut::default()
    }
}

/// A line (`a:ln`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LineOut {
    pub color: Option<ColorOut>,
    pub width_pt: Option<f64>,
    pub dash: Option<String>,
    pub none: bool,
}

/// Shape properties (`c:spPr`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ShapeOut {
    pub fill: Option<ColorOut>,
    pub no_fill: bool,
    pub line: Option<LineOut>,
}

impl ShapeOut {
    pub fn is_empty(&self) -> bool {
        self.fill.is_none() && !self.no_fill && self.line.is_none()
    }
}

/// A text with its run properties (titles).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextOut {
    pub text: String,
    /// The cell a title is bound to (`c:tx/c:strRef/c:f`).
    pub formula: Option<String>,
    pub run: RunOut,
    pub overlay: bool,
}

/// A series' data reference: the formula and the cache.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DataOut {
    pub formula: Option<String>,
    /// A numeric cache (`c:numRef`/`c:numLit`).
    pub numbers: Option<Vec<Option<f64>>>,
    /// A string cache (`c:strRef`/`c:strLit`).
    pub strings: Option<Vec<String>>,
    pub format: Option<String>,
}

/// Data labels (`c:dLbls`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LabelsOut {
    pub show_value: bool,
    pub show_category: bool,
    pub show_series: bool,
    pub show_percent: bool,
    pub show_bubble_size: bool,
    pub position: Option<String>,
    pub format: Option<String>,
    pub separator: Option<String>,
    pub run: RunOut,
}

/// A marker (`c:marker`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MarkerOut {
    pub symbol: String,
    pub size: Option<u32>,
    pub shape: ShapeOut,
}

/// A trendline (`c:trendline`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrendOut {
    pub name: Option<String>,
    pub kind: String,
    pub order: Option<u32>,
    pub period: Option<u32>,
    pub forward: Option<f64>,
    pub backward: Option<f64>,
    pub intercept: Option<f64>,
    pub display_r2: bool,
    pub display_equation: bool,
    pub line: Option<LineOut>,
}

/// Error bars (`c:errBars`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ErrOut {
    pub direction: Option<String>,
    pub bar_type: String,
    pub value_type: String,
    pub value: Option<f64>,
    pub no_end_cap: bool,
    pub plus: Option<DataOut>,
    pub minus: Option<DataOut>,
    pub line: Option<LineOut>,
}

/// One series (`c:ser`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeriesOut {
    pub idx: u32,
    pub order: u32,
    /// The name: a literal, or bound to a cell.
    pub name: Option<TextOut>,
    pub shape: ShapeOut,
    pub marker: Option<MarkerOut>,
    pub points: Vec<(u32, ShapeOut)>,
    pub labels: Option<LabelsOut>,
    pub trendlines: Vec<TrendOut>,
    pub error_bars: Vec<ErrOut>,
    /// Categories (`c:cat`) or X values (`c:xVal`) for scatter/bubble.
    pub categories: Option<DataOut>,
    /// Values (`c:val`) or Y values (`c:yVal`).
    pub values: DataOut,
    pub sizes: Option<DataOut>,
    pub smooth: Option<bool>,
    pub explosion: Option<u32>,
    pub invert_if_negative: bool,
}

/// One chart type (`c:barChart`, …) in the plot area.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlotOut {
    /// The element: `barChart`, `lineChart`, `areaChart`, `pieChart`,
    /// `doughnutChart`, `ofPieChart`, `scatterChart`, `bubbleChart`,
    /// `radarChart`, `stockChart`, `surfaceChart`.
    pub element: String,
    pub bar_dir: Option<String>,
    pub grouping: Option<String>,
    pub vary_colors: bool,
    pub series: Vec<SeriesOut>,
    pub labels: Option<LabelsOut>,
    pub gap_width: Option<u32>,
    pub overlap: Option<i32>,
    pub first_slice_angle: Option<u32>,
    pub hole_size: Option<u32>,
    pub scatter_style: Option<String>,
    pub radar_style: Option<String>,
    pub bubble_scale: Option<u32>,
    pub size_represents: Option<String>,
    pub of_pie_type: Option<String>,
    pub split_type: Option<String>,
    pub split_pos: Option<f64>,
    pub cust_split: Vec<u32>,
    pub second_pie_size: Option<u32>,
    pub hi_low_lines: bool,
    pub up_down_bars: bool,
    pub drop_lines: bool,
    pub marker: Option<bool>,
    pub axis_ids: Vec<u32>,
}

/// An axis.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AxisOut {
    /// `catAx`, `valAx`, `dateAx`, `serAx`.
    pub element: String,
    pub id: u32,
    pub cross_ax: u32,
    /// `b`, `l`, `r`, `t`.
    pub position: String,
    pub deleted: bool,
    pub log_base: Option<f64>,
    pub reversed: bool,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub major_unit: Option<f64>,
    pub minor_unit: Option<f64>,
    /// `autoZero`, `min`, `max`; `crosses_at` wins.
    pub crosses: Option<String>,
    pub crosses_at: Option<f64>,
    pub title: Option<TextOut>,
    /// The number format; `None` = linked to the source (`General`).
    pub format: Option<String>,
    pub major_gridlines: Option<LineOut>,
    pub minor_gridlines: Option<LineOut>,
    pub line: Option<LineOut>,
    pub labels: RunOut,
    /// `nextTo`, `low`, `high`, `none`.
    pub tick_labels: Option<String>,
    pub base_time_unit: Option<String>,
    /// `between` / `midCat` (value axes).
    pub cross_between: Option<String>,
}

/// The legend.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LegendOut {
    pub position: String,
    pub overlay: bool,
    pub run: RunOut,
}

/// One recorded document reference (paged.sheet's extension).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RefOut {
    pub role: String,
    pub rgb: Option<u32>,
    pub swatch: Option<String>,
    pub paragraph: Option<String>,
    pub character: Option<String>,
}

/// A whole chart.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChartOut {
    pub title: Option<TextOut>,
    pub plots: Vec<PlotOut>,
    pub axes: Vec<AxisOut>,
    pub legend: Option<LegendOut>,
    /// `gap`, `zero`, `span`.
    pub blanks: Option<String>,
    pub style: Option<u32>,
    pub chart_area: ShapeOut,
    pub plot_area: ShapeOut,
    pub text: RunOut,
    pub date1904: bool,
    /// Draw a surface flat from above (`c:view3D` rotX 90): a contour.
    pub contour: bool,
    /// The paged extension: its uri, namespace, and the references and
    /// chart index it records.
    pub ext: Option<ExtOut>,
}

/// The module's own extension under `c:extLst`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExtOut {
    pub uri: String,
    pub ns: String,
    pub refs: Vec<RefOut>,
    pub index: Option<u32>,
    /// The chart slots a save left empty (deleted charts): recorded so a
    /// reload keeps every index.
    pub removed: Vec<u32>,
}

// ── XML helpers ─────────────────────────────────────────────────────────────

/// Escape text and attribute values.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

fn val(out: &mut String, el: &str, v: impl std::fmt::Display) {
    let _ = write!(out, r#"<c:{el} val="{v}"/>"#);
}

fn color_xml(c: &ColorOut) -> String {
    match c {
        ColorOut::Srgb(v) => format!(r#"<a:srgbClr val="{:06X}"/>"#, v & 0xFF_FFFF),
        ColorOut::Scheme {
            slot,
            lum_mod,
            lum_off,
        } => {
            let mut s = format!(r#"<a:schemeClr val="{}">"#, esc(slot));
            if let Some(m) = lum_mod {
                let _ = write!(s, r#"<a:lumMod val="{m}"/>"#);
            }
            if let Some(o) = lum_off {
                let _ = write!(s, r#"<a:lumOff val="{o}"/>"#);
            }
            s.push_str("</a:schemeClr>");
            s
        }
    }
}

fn line_xml(l: &LineOut) -> String {
    let mut s = String::from("<a:ln");
    if let Some(w) = l.width_pt {
        let _ = write!(s, r#" w="{}""#, (w * 12_700.0).round() as i64);
    }
    s.push('>');
    if l.none {
        s.push_str("<a:noFill/>");
    } else if let Some(c) = &l.color {
        let _ = write!(s, "<a:solidFill>{}</a:solidFill>", color_xml(c));
    }
    if let Some(d) = &l.dash {
        let _ = write!(s, r#"<a:prstDash val="{}"/>"#, esc(d));
    }
    s.push_str("</a:ln>");
    s
}

/// `c:spPr` (empty string when there is nothing to say).
pub fn shape_xml(sp: &ShapeOut) -> String {
    if sp.is_empty() {
        return String::new();
    }
    let mut s = String::from("<c:spPr>");
    if sp.no_fill {
        s.push_str("<a:noFill/>");
    } else if let Some(c) = &sp.fill {
        let _ = write!(s, "<a:solidFill>{}</a:solidFill>", color_xml(c));
    }
    if let Some(l) = &sp.line {
        s.push_str(&line_xml(l));
    }
    s.push_str("</c:spPr>");
    s
}

fn rpr_attrs(r: &RunOut) -> String {
    let mut s = String::new();
    if let Some(sz) = r.size {
        let _ = write!(s, r#" sz="{}""#, (sz * 100.0).round() as i64);
    }
    if let Some(b) = r.bold {
        let _ = write!(s, r#" b="{}""#, u8::from(b));
    }
    if let Some(i) = r.italic {
        let _ = write!(s, r#" i="{}""#, u8::from(i));
    }
    s
}

fn rpr_children(r: &RunOut) -> String {
    let mut s = String::new();
    if let Some(c) = &r.color {
        let _ = write!(s, "<a:solidFill>{}</a:solidFill>", color_xml(c));
    }
    if let Some(f) = &r.font {
        let _ = write!(s, r#"<a:latin typeface="{}"/>"#, esc(f));
    }
    s
}

fn def_rpr(r: &RunOut) -> String {
    let kids = rpr_children(r);
    if kids.is_empty() {
        format!("<a:defRPr{}/>", rpr_attrs(r))
    } else {
        format!("<a:defRPr{}>{kids}</a:defRPr>", rpr_attrs(r))
    }
}

/// `c:txPr` with the run properties (empty when there are none).
pub fn tx_pr_xml(r: &RunOut) -> String {
    if r.is_empty() {
        return String::new();
    }
    format!(
        "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>{}</a:pPr><a:endParaRPr lang=\"en-US\"/></a:p></c:txPr>",
        def_rpr(r)
    )
}

/// `c:title`.
pub fn title_xml(t: &TextOut) -> String {
    let mut s = String::from("<c:title><c:tx>");
    if let Some(f) = &t.formula {
        let _ = write!(
            s,
            "<c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>{}</c:v></c:pt></c:strCache></c:strRef>",
            esc(f),
            esc(&t.text)
        );
    } else {
        s.push_str("<c:rich><a:bodyPr/><a:lstStyle/>");
        for line in t.text.split('\n') {
            let _ = write!(
                s,
                "<a:p><a:pPr>{}</a:pPr><a:r><a:rPr lang=\"en-US\"{}>{}</a:rPr><a:t>{}</a:t></a:r></a:p>",
                def_rpr(&t.run),
                rpr_attrs(&t.run),
                rpr_children(&t.run),
                esc(line)
            );
        }
        s.push_str("</c:rich>");
    }
    s.push_str("</c:tx>");
    let _ = write!(s, r#"<c:overlay val="{}"/>"#, u8::from(t.overlay));
    if t.formula.is_some() {
        s.push_str(&tx_pr_xml(&t.run));
    }
    s.push_str("</c:title>");
    s
}

/// `c:legend`.
pub fn legend_xml(l: &LegendOut) -> String {
    format!(
        r#"<c:legend><c:legendPos val="{}"/><c:overlay val="{}"/>{}</c:legend>"#,
        esc(&l.position),
        u8::from(l.overlay),
        tx_pr_xml(&l.run)
    )
}

/// `c:dLbls`.
pub fn labels_xml(d: &LabelsOut) -> String {
    let mut s = String::from("<c:dLbls>");
    if let Some(f) = &d.format {
        let _ = write!(s, r#"<c:numFmt formatCode="{}" sourceLinked="0"/>"#, esc(f));
    }
    s.push_str(&tx_pr_xml(&d.run));
    if let Some(p) = &d.position {
        val(&mut s, "dLblPos", esc(p));
    }
    val(&mut s, "showLegendKey", 0);
    val(&mut s, "showVal", u8::from(d.show_value));
    val(&mut s, "showCatName", u8::from(d.show_category));
    val(&mut s, "showSerName", u8::from(d.show_series));
    val(&mut s, "showPercent", u8::from(d.show_percent));
    val(&mut s, "showBubbleSize", u8::from(d.show_bubble_size));
    if let Some(sep) = &d.separator {
        let _ = write!(s, "<c:separator>{}</c:separator>", esc(sep));
    }
    s.push_str("</c:dLbls>");
    s
}

/// A data reference as the `inner` element (`c:cat`, `c:val`, …).
pub fn data_xml(tag: &str, d: &DataOut) -> String {
    let mut s = format!("<c:{tag}>");
    let numeric = d.strings.is_none();
    match (&d.formula, numeric) {
        (Some(f), true) => {
            let _ = write!(s, "<c:numRef><c:f>{}</c:f>", esc(f));
            s.push_str(&num_cache("numCache", d));
            s.push_str("</c:numRef>");
        }
        (Some(f), false) => {
            let _ = write!(s, "<c:strRef><c:f>{}</c:f>", esc(f));
            s.push_str(&str_cache("strCache", d));
            s.push_str("</c:strRef>");
        }
        (None, true) => s.push_str(&num_cache("numLit", d)),
        (None, false) => s.push_str(&str_cache("strLit", d)),
    }
    let _ = write!(s, "</c:{tag}>");
    s
}

fn num_cache(tag: &str, d: &DataOut) -> String {
    let vals = d.numbers.clone().unwrap_or_default();
    let mut s = format!("<c:{tag}>");
    let _ = write!(
        s,
        "<c:formatCode>{}</c:formatCode>",
        esc(d.format.as_deref().unwrap_or("General"))
    );
    val(&mut s, "ptCount", vals.len());
    for (i, v) in vals.iter().enumerate() {
        if let Some(v) = v.filter(|v| v.is_finite()) {
            let _ = write!(s, r#"<c:pt idx="{i}"><c:v>{}</c:v></c:pt>"#, num(v));
        }
    }
    let _ = write!(s, "</c:{tag}>");
    s
}

fn str_cache(tag: &str, d: &DataOut) -> String {
    let vals = d.strings.clone().unwrap_or_default();
    let mut s = format!("<c:{tag}>");
    val(&mut s, "ptCount", vals.len());
    for (i, v) in vals.iter().enumerate() {
        let _ = write!(s, r#"<c:pt idx="{i}"><c:v>{}</c:v></c:pt>"#, esc(v));
    }
    let _ = write!(s, "</c:{tag}>");
    s
}

fn tx_xml(t: &TextOut) -> String {
    match &t.formula {
        Some(f) => format!(
            "<c:tx><c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"1\"/><c:pt idx=\"0\"><c:v>{}</c:v></c:pt></c:strCache></c:strRef></c:tx>",
            esc(f),
            esc(&t.text)
        ),
        None => format!("<c:tx><c:v>{}</c:v></c:tx>", esc(&t.text)),
    }
}

fn marker_xml(m: &MarkerOut) -> String {
    let mut s = format!(r#"<c:marker><c:symbol val="{}"/>"#, esc(&m.symbol));
    if let Some(sz) = m.size {
        val(&mut s, "size", sz.clamp(2, 72));
    }
    s.push_str(&shape_xml(&m.shape));
    s.push_str("</c:marker>");
    s
}

fn trend_xml(t: &TrendOut) -> String {
    let mut s = String::from("<c:trendline>");
    if let Some(n) = &t.name {
        let _ = write!(s, "<c:name>{}</c:name>", esc(n));
    }
    if let Some(l) = &t.line {
        s.push_str(&shape_xml(&ShapeOut {
            line: Some(l.clone()),
            ..ShapeOut::default()
        }));
    }
    val(&mut s, "trendlineType", esc(&t.kind));
    if let Some(o) = t.order {
        val(&mut s, "order", o);
    }
    if let Some(p) = t.period {
        val(&mut s, "period", p);
    }
    if let Some(f) = t.forward.filter(|v| *v != 0.0) {
        val(&mut s, "forward", num(f));
    }
    if let Some(b) = t.backward.filter(|v| *v != 0.0) {
        val(&mut s, "backward", num(b));
    }
    if let Some(i) = t.intercept {
        val(&mut s, "intercept", num(i));
    }
    val(&mut s, "dispRSqr", u8::from(t.display_r2));
    val(&mut s, "dispEq", u8::from(t.display_equation));
    s.push_str("</c:trendline>");
    s
}

fn err_xml(e: &ErrOut) -> String {
    let mut s = String::from("<c:errBars>");
    if let Some(d) = &e.direction {
        val(&mut s, "errDir", esc(d));
    }
    val(&mut s, "errBarType", esc(&e.bar_type));
    val(&mut s, "errValType", esc(&e.value_type));
    val(&mut s, "noEndCap", u8::from(e.no_end_cap));
    if let Some(p) = &e.plus {
        s.push_str(&data_xml("plus", p));
    }
    if let Some(m) = &e.minus {
        s.push_str(&data_xml("minus", m));
    }
    if let Some(v) = e.value {
        val(&mut s, "val", num(v));
    }
    if let Some(l) = &e.line {
        s.push_str(&shape_xml(&ShapeOut {
            line: Some(l.clone()),
            ..ShapeOut::default()
        }));
    }
    s.push_str("</c:errBars>");
    s
}

/// One `c:ser` for a plot element, in that type's schema order.
pub fn series_xml(element: &str, s: &SeriesOut) -> String {
    let xy = matches!(element, "scatterChart" | "bubbleChart");
    let has_marker = matches!(
        element,
        "lineChart" | "line3DChart" | "scatterChart" | "radarChart"
    );
    let has_trend = matches!(
        element,
        "barChart" | "lineChart" | "areaChart" | "scatterChart" | "bubbleChart"
    );
    let pie = matches!(
        element,
        "pieChart" | "pie3DChart" | "doughnutChart" | "ofPieChart"
    );
    let mut x = String::from("<c:ser>");
    val(&mut x, "idx", s.idx);
    val(&mut x, "order", s.order);
    if let Some(n) = &s.name {
        x.push_str(&tx_xml(n));
    }
    x.push_str(&shape_xml(&s.shape));
    if matches!(element, "barChart" | "bar3DChart" | "bubbleChart") && s.invert_if_negative {
        val(&mut x, "invertIfNegative", 1);
    }
    if has_marker {
        if let Some(m) = &s.marker {
            x.push_str(&marker_xml(m));
        }
    }
    if pie {
        if let Some(e) = s.explosion.filter(|e| *e > 0) {
            val(&mut x, "explosion", e);
        }
    }
    for (i, sp) in &s.points {
        let _ = write!(x, "<c:dPt>");
        val(&mut x, "idx", i);
        if matches!(element, "barChart" | "bubbleChart") {
            val(&mut x, "invertIfNegative", 0);
        }
        if element == "bubbleChart" {
            val(&mut x, "bubble3D", 0);
        }
        x.push_str(&shape_xml(sp));
        x.push_str("</c:dPt>");
    }
    if let Some(d) = &s.labels {
        x.push_str(&labels_xml(d));
    }
    if has_trend {
        for t in &s.trendlines {
            x.push_str(&trend_xml(t));
        }
        let max_err = if xy { 2 } else { 1 };
        for e in s.error_bars.iter().take(max_err) {
            x.push_str(&err_xml(e));
        }
    }
    if xy {
        if let Some(c) = &s.categories {
            x.push_str(&data_xml("xVal", c));
        }
        x.push_str(&data_xml("yVal", &s.values));
        if element == "bubbleChart" {
            if let Some(z) = &s.sizes {
                x.push_str(&data_xml("bubbleSize", z));
            }
            val(&mut x, "bubble3D", 0);
        }
    } else {
        if let Some(c) = &s.categories {
            x.push_str(&data_xml("cat", c));
        }
        x.push_str(&data_xml("val", &s.values));
    }
    if matches!(element, "lineChart" | "scatterChart") {
        val(&mut x, "smooth", u8::from(s.smooth.unwrap_or(false)));
    }
    x.push_str("</c:ser>");
    x
}

/// One plot element.
pub fn plot_xml(p: &PlotOut) -> String {
    let e = p.element.as_str();
    let mut x = format!("<c:{e}>");
    match e {
        "barChart" | "bar3DChart" => {
            val(&mut x, "barDir", esc(p.bar_dir.as_deref().unwrap_or("col")));
            val(
                &mut x,
                "grouping",
                esc(p.grouping.as_deref().unwrap_or("clustered")),
            );
        }
        "lineChart" | "line3DChart" | "areaChart" | "area3DChart" => {
            val(
                &mut x,
                "grouping",
                esc(p.grouping.as_deref().unwrap_or("standard")),
            );
        }
        "ofPieChart" => val(
            &mut x,
            "ofPieType",
            esc(p.of_pie_type.as_deref().unwrap_or("pie")),
        ),
        "scatterChart" => val(
            &mut x,
            "scatterStyle",
            esc(p.scatter_style.as_deref().unwrap_or("lineMarker")),
        ),
        "radarChart" => val(
            &mut x,
            "radarStyle",
            esc(p.radar_style.as_deref().unwrap_or("marker")),
        ),
        "surfaceChart" | "surface3DChart" => val(&mut x, "wireframe", 0),
        _ => {}
    }
    if !matches!(e, "stockChart" | "surfaceChart" | "surface3DChart") {
        val(&mut x, "varyColors", u8::from(p.vary_colors));
    }
    for s in &p.series {
        x.push_str(&series_xml(e, s));
    }
    if let Some(d) = &p.labels {
        x.push_str(&labels_xml(d));
    }
    match e {
        "barChart" | "bar3DChart" => {
            val(&mut x, "gapWidth", p.gap_width.unwrap_or(150));
            if let Some(o) = p.overlap {
                val(&mut x, "overlap", o);
            } else if matches!(p.grouping.as_deref(), Some("stacked" | "percentStacked")) {
                val(&mut x, "overlap", 100);
            }
        }
        "lineChart" | "line3DChart" | "stockChart" => {
            if p.drop_lines {
                x.push_str("<c:dropLines/>");
            }
            if p.hi_low_lines {
                x.push_str("<c:hiLowLines/>");
            }
            if p.up_down_bars {
                x.push_str(r#"<c:upDownBars><c:gapWidth val="150"/><c:upBars/><c:downBars/></c:upDownBars>"#);
            }
            if e == "lineChart" {
                val(&mut x, "marker", u8::from(p.marker.unwrap_or(true)));
            }
        }
        "areaChart" => {
            if p.drop_lines {
                x.push_str("<c:dropLines/>");
            }
        }
        "pieChart" | "pie3DChart" => val(&mut x, "firstSliceAng", p.first_slice_angle.unwrap_or(0)),
        "doughnutChart" => {
            val(&mut x, "firstSliceAng", p.first_slice_angle.unwrap_or(0));
            val(&mut x, "holeSize", p.hole_size.unwrap_or(50).clamp(10, 90));
        }
        "ofPieChart" => {
            val(&mut x, "gapWidth", p.gap_width.unwrap_or(100));
            if let Some(t) = &p.split_type {
                val(&mut x, "splitType", esc(t));
            }
            if let Some(v) = p.split_pos {
                val(&mut x, "splitPos", num(v));
            }
            if !p.cust_split.is_empty() {
                x.push_str("<c:custSplit>");
                for i in &p.cust_split {
                    val(&mut x, "secondPiePt", i);
                }
                x.push_str("</c:custSplit>");
            }
            val(&mut x, "secondPieSize", p.second_pie_size.unwrap_or(75));
            x.push_str("<c:serLines/>");
        }
        "bubbleChart" => {
            val(&mut x, "bubbleScale", p.bubble_scale.unwrap_or(100));
            val(&mut x, "showNegBubbles", 0);
            if let Some(r) = &p.size_represents {
                val(&mut x, "sizeRepresents", esc(r));
            }
        }
        _ => {}
    }
    for id in &p.axis_ids {
        val(&mut x, "axId", id);
    }
    let _ = write!(x, "</c:{e}>");
    x
}

/// One axis element.
pub fn axis_xml(a: &AxisOut) -> String {
    let e = a.element.as_str();
    let mut x = format!("<c:{e}>");
    val(&mut x, "axId", a.id);
    x.push_str(&scaling_xml(a));
    val(&mut x, "delete", u8::from(a.deleted));
    val(&mut x, "axPos", esc(&a.position));
    if let Some(g) = &a.major_gridlines {
        x.push_str(&gridlines_xml("majorGridlines", g));
    }
    if let Some(g) = &a.minor_gridlines {
        x.push_str(&gridlines_xml("minorGridlines", g));
    }
    if let Some(t) = &a.title {
        x.push_str(&title_xml(t));
    }
    match &a.format {
        Some(f) => {
            let _ = write!(x, r#"<c:numFmt formatCode="{}" sourceLinked="0"/>"#, esc(f));
        }
        None if e == "valAx" || e == "dateAx" => {
            x.push_str(r#"<c:numFmt formatCode="General" sourceLinked="1"/>"#)
        }
        None => {}
    }
    val(
        &mut x,
        "majorTickMark",
        if e == "serAx" { "out" } else { "none" },
    );
    val(&mut x, "minorTickMark", "none");
    val(
        &mut x,
        "tickLblPos",
        esc(a.tick_labels.as_deref().unwrap_or("nextTo")),
    );
    if let Some(l) = &a.line {
        x.push_str(&shape_xml(&ShapeOut {
            line: Some(l.clone()),
            ..ShapeOut::default()
        }));
    }
    x.push_str(&tx_pr_xml(&a.labels));
    val(&mut x, "crossAx", a.cross_ax);
    match (a.crosses_at, &a.crosses) {
        (Some(v), _) => val(&mut x, "crossesAt", num(v)),
        (None, Some(c)) => val(&mut x, "crosses", esc(c)),
        (None, None) => val(&mut x, "crosses", "autoZero"),
    }
    match e {
        "catAx" => {
            val(&mut x, "auto", 1);
            val(&mut x, "lblAlgn", "ctr");
            val(&mut x, "lblOffset", 100);
            val(&mut x, "noMultiLvlLbl", 0);
        }
        "dateAx" => {
            val(&mut x, "auto", 1);
            val(&mut x, "lblOffset", 100);
            if let Some(u) = &a.base_time_unit {
                val(&mut x, "baseTimeUnit", esc(u));
            }
            if let Some(m) = a.major_unit {
                val(&mut x, "majorUnit", num(m));
            }
        }
        "valAx" => {
            val(
                &mut x,
                "crossBetween",
                esc(a.cross_between.as_deref().unwrap_or("between")),
            );
            if let Some(m) = a.major_unit {
                val(&mut x, "majorUnit", num(m));
            }
            if let Some(m) = a.minor_unit {
                val(&mut x, "minorUnit", num(m));
            }
        }
        _ => {}
    }
    let _ = write!(x, "</c:{e}>");
    x
}

/// `c:scaling` of an axis.
pub fn scaling_xml(a: &AxisOut) -> String {
    let mut x = String::from("<c:scaling>");
    if let Some(b) = a.log_base {
        val(&mut x, "logBase", num(b));
    }
    val(
        &mut x,
        "orientation",
        if a.reversed { "maxMin" } else { "minMax" },
    );
    if let Some(m) = a.max {
        val(&mut x, "max", num(m));
    }
    if let Some(m) = a.min {
        val(&mut x, "min", num(m));
    }
    x.push_str("</c:scaling>");
    x
}

/// `c:majorGridlines` / `c:minorGridlines`.
pub fn gridlines_xml(tag: &str, l: &LineOut) -> String {
    if *l == LineOut::default() {
        return format!("<c:{tag}/>");
    }
    format!(
        "<c:{tag}>{}</c:{tag}>",
        shape_xml(&ShapeOut {
            line: Some(l.clone()),
            ..ShapeOut::default()
        })
    )
}

/// The module's extension (`c:extLst/c:ext`), or empty.
pub fn ext_xml(e: &ExtOut) -> String {
    let mut x = format!(
        r#"<c:ext uri="{}" xmlns:pg="{}"><pg:refs"#,
        esc(&e.uri),
        esc(&e.ns)
    );
    if let Some(i) = e.index {
        let _ = write!(x, r#" index="{i}""#);
    }
    if !e.removed.is_empty() {
        let list: Vec<String> = e.removed.iter().map(|r| r.to_string()).collect();
        let _ = write!(x, r#" removed="{}""#, list.join(" "));
    }
    x.push('>');
    for r in &e.refs {
        let _ = write!(x, r#"<pg:ref role="{}""#, esc(&r.role));
        if let Some(v) = r.rgb {
            let _ = write!(x, r#" rgb="{v:06X}""#);
        }
        for (k, v) in [
            ("swatch", &r.swatch),
            ("paragraph", &r.paragraph),
            ("character", &r.character),
        ] {
            if let Some(v) = v {
                let _ = write!(x, r#" {k}="{}""#, esc(v));
            }
        }
        x.push_str("/>");
    }
    x.push_str("</pg:refs></c:ext>");
    x
}

/// A complete `c:chartSpace` part.
pub fn generate(c: &ChartOut) -> String {
    let mut x = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    x.push('\n');
    let _ = write!(
        x,
        r#"<c:chartSpace xmlns:c="{NS_C}" xmlns:a="{NS_A}" xmlns:r="{NS_R}">"#
    );
    val(&mut x, "date1904", u8::from(c.date1904));
    val(&mut x, "roundedCorners", 0);
    if let Some(s) = c.style {
        val(&mut x, "style", s.clamp(1, 48));
    }
    x.push_str("<c:chart>");
    match &c.title {
        Some(t) => {
            x.push_str(&title_xml(t));
            val(&mut x, "autoTitleDeleted", 0);
        }
        None => val(&mut x, "autoTitleDeleted", 1),
    }
    if c.contour {
        x.push_str(r#"<c:view3D><c:rotX val="90"/><c:rotY val="0"/><c:rAngAx val="0"/><c:perspective val="0"/></c:view3D>"#);
    }
    x.push_str("<c:plotArea><c:layout/>");
    for p in &c.plots {
        x.push_str(&plot_xml(p));
    }
    for a in &c.axes {
        x.push_str(&axis_xml(a));
    }
    x.push_str(&shape_xml(&c.plot_area));
    x.push_str("</c:plotArea>");
    if let Some(l) = &c.legend {
        x.push_str(&legend_xml(l));
    }
    val(&mut x, "plotVisOnly", 1);
    val(
        &mut x,
        "dispBlanksAs",
        esc(c.blanks.as_deref().unwrap_or("gap")),
    );
    x.push_str("</c:chart>");
    x.push_str(&shape_xml(&c.chart_area));
    x.push_str(&tx_pr_xml(&c.text));
    if let Some(e) = &c.ext {
        let _ = write!(x, "<c:extLst>{}</c:extLst>", ext_xml(e));
    }
    x.push_str("</c:chartSpace>");
    x
}

// ── chartEx ─────────────────────────────────────────────────────────────────

/// One Office 2016 chart (`cx:chartSpace`): one series of `layout`
/// (`waterfall`, `funnel`, `treemap`, `sunburst`, `clusteredColumn` with
/// binning for a histogram, plus `paretoLine` for a pareto, `boxWhisker`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChartExOut {
    pub title: Option<String>,
    pub layout: String,
    pub categories: Option<DataOut>,
    /// The series (box & whisker takes several; the others one).
    pub series: Vec<ExSeriesOut>,
    /// Waterfall subtotal indexes.
    pub subtotals: Vec<u32>,
    /// Histogram binning: (count, width, closed left, aggregation).
    pub bin_count: Option<u32>,
    pub bin_size: Option<f64>,
    pub closed_left: bool,
    pub aggregation: bool,
    pub pareto: bool,
    pub legend: Option<String>,
    pub show_values: bool,
    pub ext: Option<ExtOut>,
}

/// One chartEx series.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExSeriesOut {
    pub name: Option<TextOut>,
    pub values: DataOut,
    pub fill: Option<ColorOut>,
}

fn cx_dim(kind: &str, tag: &str, d: &DataOut) -> String {
    let mut x = format!(r#"<cx:{tag} type="{kind}">"#);
    if let Some(f) = &d.formula {
        let _ = write!(x, "<cx:f>{}</cx:f>", esc(f));
    }
    match (&d.numbers, &d.strings) {
        (Some(n), _) => {
            let _ = write!(
                x,
                r#"<cx:lvl ptCount="{}" formatCode="{}">"#,
                n.len(),
                esc(d.format.as_deref().unwrap_or("General"))
            );
            for (i, v) in n.iter().enumerate() {
                if let Some(v) = v.filter(|v| v.is_finite()) {
                    let _ = write!(x, r#"<cx:pt idx="{i}">{}</cx:pt>"#, num(v));
                }
            }
            x.push_str("</cx:lvl>");
        }
        (None, Some(s)) => {
            let _ = write!(x, r#"<cx:lvl ptCount="{}">"#, s.len());
            for (i, v) in s.iter().enumerate() {
                let _ = write!(x, r#"<cx:pt idx="{i}">{}</cx:pt>"#, esc(v));
            }
            x.push_str("</cx:lvl>");
        }
        _ => {}
    }
    let _ = write!(x, "</cx:{tag}>");
    x
}

/// A complete `cx:chartSpace` part.
pub fn generate_ex(c: &ChartExOut) -> String {
    let mut x = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    x.push('\n');
    let _ = write!(
        x,
        r#"<cx:chartSpace xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:cx="{NS_CX}">"#
    );
    x.push_str("<cx:chartData>");
    let val_kind = if matches!(c.layout.as_str(), "treemap" | "sunburst") {
        "size"
    } else {
        "val"
    };
    for (i, se) in c.series.iter().enumerate() {
        let _ = write!(x, r#"<cx:data id="{i}">"#);
        if let Some(cat) = &c.categories {
            x.push_str(&cx_dim("cat", "strDim", cat));
        }
        x.push_str(&cx_dim(val_kind, "numDim", &se.values));
        x.push_str("</cx:data>");
    }
    x.push_str("</cx:chartData><cx:chart>");
    if let Some(t) = &c.title {
        let _ = write!(
            x,
            r#"<cx:title pos="t" align="ctr" overlay="0"><cx:tx><cx:txData><cx:v>{}</cx:v></cx:txData></cx:tx></cx:title>"#,
            esc(t)
        );
    }
    x.push_str("<cx:plotArea><cx:plotAreaRegion>");
    let lp = match c.layout.as_str() {
        "waterfall" => {
            let mut s = String::from("<cx:layoutPr><cx:subtotals>");
            for i in &c.subtotals {
                let _ = write!(s, r#"<cx:idx val="{i}"/>"#);
            }
            s.push_str("</cx:subtotals></cx:layoutPr>");
            s
        }
        "clusteredColumn" => {
            let mut s = String::from("<cx:layoutPr>");
            if c.aggregation {
                s.push_str("<cx:aggregation/>");
            } else {
                let _ = write!(
                    s,
                    r#"<cx:binning intervalClosed="{}">"#,
                    if c.closed_left { "l" } else { "r" }
                );
                match (c.bin_size, c.bin_count) {
                    (Some(w), _) => {
                        let _ = write!(s, r#"<cx:binSize val="{}"/>"#, num(w));
                    }
                    (None, Some(n)) => {
                        let _ = write!(s, r#"<cx:binCount val="{n}"/>"#);
                    }
                    _ => {}
                }
                s.push_str("</cx:binning>");
            }
            s.push_str("</cx:layoutPr>");
            s
        }
        "boxWhisker" => r#"<cx:layoutPr><cx:visibility meanLine="0" meanMarker="1" nonoutliers="0" outliers="1"/><cx:statistics quartileMethod="exclusive"/></cx:layoutPr>"#.to_string(),
        "treemap" => r#"<cx:layoutPr><cx:parentLabelLayout val="banner"/></cx:layoutPr>"#.to_string(),
        _ => String::new(),
    };
    for (i, se) in c.series.iter().enumerate() {
        let _ = write!(
            x,
            r#"<cx:series layoutId="{}" uniqueId="{{00000000-{:04X}-0000-0000-000000000000}}">"#,
            esc(&c.layout),
            i + 1
        );
        if let Some(n) = &se.name {
            x.push_str("<cx:tx><cx:txData>");
            if let Some(f) = &n.formula {
                let _ = write!(x, "<cx:f>{}</cx:f>", esc(f));
            }
            let _ = write!(x, "<cx:v>{}</cx:v></cx:txData></cx:tx>", esc(&n.text));
        }
        if let Some(f) = &se.fill {
            let _ = write!(
                x,
                "<cx:spPr><a:solidFill>{}</a:solidFill></cx:spPr>",
                color_xml(f)
            );
        }
        if c.show_values {
            x.push_str(r#"<cx:dataLabels pos="outEnd"><cx:visibility seriesName="0" categoryName="0" value="1"/></cx:dataLabels>"#);
        }
        let _ = write!(x, r#"<cx:dataId val="{i}"/>"#);
        x.push_str(&lp);
        x.push_str("</cx:series>");
    }
    if c.pareto {
        x.push_str(r#"<cx:series layoutId="paretoLine" ownerIdx="0" uniqueId="{00000000-0002-0000-0000-000000000000}"><cx:axisId val="2"/></cx:series>"#);
    }
    x.push_str("</cx:plotAreaRegion>");
    if !matches!(c.layout.as_str(), "treemap" | "sunburst") {
        x.push_str(r#"<cx:axis id="0"><cx:catScaling gapWidth="0.5"/><cx:tickLabels/></cx:axis>"#);
        x.push_str(
            r#"<cx:axis id="1"><cx:valScaling/><cx:majorGridlines/><cx:tickLabels/></cx:axis>"#,
        );
        if c.pareto {
            x.push_str(r#"<cx:axis id="2"><cx:valScaling max="1" min="0"/><cx:units unit="percentage"/><cx:tickLabels/></cx:axis>"#);
        }
    }
    x.push_str("</cx:plotArea>");
    if let Some(pos) = &c.legend {
        let _ = write!(
            x,
            r#"<cx:legend pos="{}" align="ctr" overlay="0"/>"#,
            esc(pos)
        );
    }
    x.push_str("</cx:chart>");
    if let Some(e) = &c.ext {
        let _ = write!(
            x,
            "<cx:extLst>{}</cx:extLst>",
            ext_xml(e)
                .replace("<c:ext ", "<cx:ext ")
                .replace("</c:ext>", "</cx:ext>")
        );
    }
    x.push_str("</cx:chartSpace>");
    x
}

/// The chart style part a chartEx part needs (`cs:chartStyle`; Excel does
/// not open a chartEx part without one): every style entry, referring to the
/// theme.
pub fn chart_style_xml(id: u32) -> String {
    const ENTRIES: [&str; 31] = [
        "axisTitle",
        "categoryAxis",
        "chartArea",
        "dataLabel",
        "dataLabelCallout",
        "dataPoint",
        "dataPoint3D",
        "dataPointLine",
        "dataPointMarker",
        "dataPointMarkerLayout",
        "dataPointWireframe",
        "dataTable",
        "downBar",
        "dropLine",
        "errorBar",
        "floor",
        "gridlineMajor",
        "gridlineMinor",
        "hiLoLine",
        "leaderLine",
        "legend",
        "plotArea",
        "plotArea3D",
        "seriesAxis",
        "seriesLine",
        "title",
        "trendline",
        "trendlineLabel",
        "upBar",
        "valueAxis",
        "wall",
    ];
    let mut x = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cs:chartStyle xmlns:cs="{NS_CS}" xmlns:a="{NS_A}" id="{id}">"#
    );
    for e in ENTRIES {
        if e == "dataPointMarkerLayout" {
            x.push_str(r#"<cs:dataPointMarkerLayout symbol="circle" size="5"/>"#);
            continue;
        }
        let fill = if e == "dataPoint" {
            r#"<cs:fillRef idx="1"><cs:styleClr val="auto"/></cs:fillRef>"#
        } else {
            r#"<cs:fillRef idx="0"/>"#
        };
        let _ = write!(
            x,
            r#"<cs:{e}><cs:lnRef idx="0"/>{fill}<cs:effectRef idx="0"/><cs:fontRef idx="minor"><a:schemeClr val="tx1"/></cs:fontRef></cs:{e}>"#
        );
    }
    x.push_str("</cs:chartStyle>");
    x
}

/// The colour style part beside it (`cs:colorStyle`): the six accents,
/// cycled with Excel's lighter and darker variations.
pub fn chart_colors_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cs:colorStyle xmlns:cs="{NS_CS}" xmlns:a="{NS_A}" meth="cycle" id="10"><a:schemeClr val="accent1"/><a:schemeClr val="accent2"/><a:schemeClr val="accent3"/><a:schemeClr val="accent4"/><a:schemeClr val="accent5"/><a:schemeClr val="accent6"/><cs:variation/><cs:variation><a:lumMod val="60000"/></cs:variation><cs:variation><a:lumMod val="80000"/><a:lumOff val="20000"/></cs:variation><cs:variation><a:lumMod val="80000"/></cs:variation><cs:variation><a:lumMod val="60000"/><a:lumOff val="40000"/></cs:variation><cs:variation><a:lumMod val="50000"/></cs:variation></cs:colorStyle>"#
    )
}

/// The chart-style namespace.
pub const NS_CS: &str = "http://schemas.microsoft.com/office/drawing/2012/chartStyle";
/// Relationship types and content types of the style parts.
pub const RT_CHART_STYLE: &str =
    "http://schemas.microsoft.com/office/2011/relationships/chartStyle";
pub const RT_CHART_COLORS: &str =
    "http://schemas.microsoft.com/office/2011/relationships/chartColorStyle";
pub const CT_CHART_STYLE: &str = "application/vnd.ms-office.chartstyle+xml";
pub const CT_CHART_COLORS: &str = "application/vnd.ms-office.chartcolorstyle+xml";

// ── splicing ────────────────────────────────────────────────────────────────

/// The schema order of `c:chartSpace` children.
pub const ORDER_CHART_SPACE: &[&str] = &[
    "date1904",
    "lang",
    "roundedCorners",
    "AlternateContent",
    "style",
    "clrMapOvr",
    "pivotSource",
    "protection",
    "chart",
    "spPr",
    "txPr",
    "externalData",
    "printSettings",
    "userShapes",
    "extLst",
];
/// The schema order of `c:chart` children.
pub const ORDER_CHART: &[&str] = &[
    "title",
    "autoTitleDeleted",
    "pivotFmts",
    "view3D",
    "floor",
    "sideWall",
    "backWall",
    "plotArea",
    "legend",
    "plotVisOnly",
    "dispBlanksAs",
    "showDLblsOverMax",
    "extLst",
];
/// The order of a series' children (the union of the CT_*Ser sequences;
/// each type uses a subsequence in this order).
pub const ORDER_SER: &[&str] = &[
    "idx",
    "order",
    "tx",
    "spPr",
    "invertIfNegative",
    "pictureOptions",
    "marker",
    "explosion",
    "dPt",
    "dLbls",
    "trendline",
    "errBars",
    "cat",
    "val",
    "xVal",
    "yVal",
    "bubbleSize",
    "smooth",
    "shape",
    "bubble3D",
    "extLst",
];
/// The order of an axis' children (CT_CatAx/ValAx/DateAx/SerAx share the
/// head).
pub const ORDER_AXIS: &[&str] = &[
    "axId",
    "scaling",
    "delete",
    "axPos",
    "majorGridlines",
    "minorGridlines",
    "title",
    "numFmt",
    "majorTickMark",
    "minorTickMark",
    "tickLblPos",
    "spPr",
    "txPr",
    "crossAx",
    "crosses",
    "crossesAt",
    "crossBetween",
    "auto",
    "lblAlgn",
    "lblOffset",
    "baseTimeUnit",
    "majorUnit",
    "majorTimeUnit",
    "minorUnit",
    "minorTimeUnit",
    "tickLblSkip",
    "tickMarkSkip",
    "noMultiLvlLbl",
    "dispUnits",
    "extLst",
];

/// Parse a generated fragment (with `c:`/`a:` prefixes) into an element.
pub fn fragment(xml: &str) -> Result<El, String> {
    let wrapped = format!(
        r#"<w xmlns:c="{NS_C}" xmlns:a="{NS_A}" xmlns:r="{NS_R}" xmlns:cx="{NS_CX}">{xml}</w>"#
    );
    let root = paged_ooxml::tree::parse(wrapped.as_bytes())?;
    root.children
        .into_iter()
        .next()
        .ok_or_else(|| "empty fragment".to_string())
}

/// Put `new` in place of `parent`'s `local` children (in `ns`), or remove
/// them (`None`); a new child goes before the first sibling that comes
/// after it in `order`.
pub fn put_child(parent: &mut El, ns: Ns, local: &str, new: Option<El>, order: &[&str]) {
    let at = parent.children.iter().position(|c| c.is(ns, local));
    parent.children.retain(|c| !c.is(ns, local));
    let Some(new) = new else {
        return;
    };
    let rank = |l: &str| order.iter().position(|o| *o == l);
    let pos = at.unwrap_or_else(|| {
        let mine = rank(local).unwrap_or(usize::MAX);
        parent
            .children
            .iter()
            .position(|c| rank(&c.local).is_some_and(|r| r > mine))
            .unwrap_or(parent.children.len())
    });
    parent.children.insert(pos.min(parent.children.len()), new);
}

/// Make sure the root declares the `c:`, `a:` and `r:` prefixes generated
/// fragments use.
pub fn ensure_prefixes(root: &mut El) {
    for (p, uri) in [("xmlns:c", NS_C), ("xmlns:a", NS_A), ("xmlns:r", NS_R)] {
        if !root.raw_attrs.iter().any(|(k, _)| k == p) {
            root.raw_attrs.push((p.to_string(), uri.to_string()));
        }
    }
}

/// Serialise a spliced part: the original XML declaration, then the tree.
pub fn serialise(original: &[u8], root: &El) -> Vec<u8> {
    let head = original.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(original);
    let decl = if head.starts_with(b"<?xml") {
        head.iter()
            .position(|b| *b == b'>')
            .map(|e| String::from_utf8_lossy(&head[..=e]).into_owned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let mut out = decl;
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&root.to_xml());
    out.into_bytes()
}

/// Replace (or add, or remove) the paged extension under a chart space's
/// `c:extLst`, keeping every other extension.
pub fn put_ext(root: &mut El, ext: Option<&ExtOut>, uri: &str) -> Result<(), String> {
    let ns = if root.ns == Ns::Cx { Ns::Cx } else { Ns::C };
    let mut list = root.children.iter().find(|c| c.is(ns, "extLst")).cloned();
    if let Some(l) = list.as_mut() {
        l.children.retain(|e| e.attr("uri") != Some(uri));
    }
    if let Some(e) = ext {
        let xml = if ns == Ns::Cx {
            ext_xml(e)
                .replace("<c:ext ", "<cx:ext ")
                .replace("</c:ext>", "</cx:ext>")
        } else {
            ext_xml(e)
        };
        let el = fragment(&xml)?;
        match list.as_mut() {
            Some(l) => l.children.push(el),
            None => {
                let mut l = fragment(if ns == Ns::Cx {
                    "<cx:extLst/>"
                } else {
                    "<c:extLst/>"
                })?;
                l.children.push(el);
                list = Some(l);
            }
        }
    }
    let list = list.filter(|l| !l.children.is_empty());
    if ns == Ns::Cx {
        root.children.retain(|c| !c.is(Ns::Cx, "extLst"));
        if let Some(l) = list {
            root.children.push(l);
        }
    } else {
        put_child(root, Ns::C, "extLst", list, ORDER_CHART_SPACE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column() -> ChartOut {
        ChartOut {
            title: Some(TextOut {
                text: "Sales & More".into(),
                ..TextOut::default()
            }),
            plots: vec![PlotOut {
                element: "barChart".into(),
                bar_dir: Some("col".into()),
                grouping: Some("clustered".into()),
                series: vec![SeriesOut {
                    idx: 0,
                    order: 0,
                    name: Some(TextOut {
                        text: "Q1".into(),
                        formula: Some("Sheet1!$B$1".into()),
                        ..TextOut::default()
                    }),
                    shape: ShapeOut {
                        fill: Some(ColorOut::Scheme {
                            slot: "accent2".into(),
                            lum_mod: Some(75000),
                            lum_off: None,
                        }),
                        ..ShapeOut::default()
                    },
                    categories: Some(DataOut {
                        formula: Some("Sheet1!$A$2:$A$3".into()),
                        strings: Some(vec!["a".into(), "b".into()]),
                        ..DataOut::default()
                    }),
                    values: DataOut {
                        formula: Some("Sheet1!$B$2:$B$3".into()),
                        numbers: Some(vec![Some(1.0), None]),
                        ..DataOut::default()
                    },
                    ..SeriesOut::default()
                }],
                axis_ids: vec![1, 2],
                ..PlotOut::default()
            }],
            axes: vec![
                AxisOut {
                    element: "catAx".into(),
                    id: 1,
                    cross_ax: 2,
                    position: "b".into(),
                    ..AxisOut::default()
                },
                AxisOut {
                    element: "valAx".into(),
                    id: 2,
                    cross_ax: 1,
                    position: "l".into(),
                    major_gridlines: Some(LineOut::default()),
                    log_base: Some(10.0),
                    max: Some(1000.0),
                    ..AxisOut::default()
                },
            ],
            legend: Some(LegendOut {
                position: "r".into(),
                ..LegendOut::default()
            }),
            ..ChartOut::default()
        }
    }

    #[test]
    fn a_generated_part_reads_back() {
        let xml = generate(&column());
        let root = paged_ooxml::tree::parse(xml.as_bytes()).unwrap();
        let c = crate::chart(&root, &());
        assert_eq!(c.title.unwrap().text, "Sales & More");
        assert_eq!(c.plots.len(), 1);
        let s = &c.plots[0].series[0];
        assert_eq!(s.name, "Q1");
        assert_eq!(s.refs.values.as_deref(), Some("Sheet1!$B$2:$B$3"));
        assert_eq!(s.values, vec![Some(1.0), None]);
        assert_eq!(s.categories, vec!["a", "b"]);
        let v = c.val_axis.unwrap();
        assert_eq!((v.log_base, v.max), (Some(10.0), Some(1000.0)));
        assert!(v.major_gridlines.is_some());
        assert_eq!(c.legend.unwrap().position, "r");
        // Schema order inside the value axis' scaling: logBase, orientation, max.
        let v = &xml[xml.find("<c:valAx>").unwrap()..];
        let a = v.find("logBase").unwrap();
        let b = v.find("orientation").unwrap();
        let m = v.find("<c:max ").unwrap();
        assert!(a < b && b < m);
    }

    #[test]
    fn put_child_keeps_schema_order() {
        let mut ser = fragment(
            r#"<c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>A</c:f></c:numRef></c:val></c:ser>"#,
        )
        .unwrap();
        put_child(
            &mut ser,
            Ns::C,
            "spPr",
            Some(fragment("<c:spPr><a:noFill/></c:spPr>").unwrap()),
            ORDER_SER,
        );
        put_child(
            &mut ser,
            Ns::C,
            "cat",
            Some(fragment(r#"<c:cat><c:strRef><c:f>B</c:f></c:strRef></c:cat>"#).unwrap()),
            ORDER_SER,
        );
        let names: Vec<&str> = ser.children.iter().map(|c| c.local.as_str()).collect();
        assert_eq!(names, ["idx", "order", "spPr", "cat", "val"]);
        put_child(&mut ser, Ns::C, "spPr", None, ORDER_SER);
        assert_eq!(ser.children.len(), 4);
    }

    #[test]
    fn a_chart_ex_part_reads_back() {
        let x = generate_ex(&ChartExOut {
            title: Some("Bridge".into()),
            layout: "waterfall".into(),
            categories: Some(DataOut {
                formula: Some("Sheet1!$A$2:$A$4".into()),
                strings: Some(vec!["a".into(), "b".into(), "c".into()]),
                ..DataOut::default()
            }),
            series: vec![ExSeriesOut {
                values: DataOut {
                    formula: Some("Sheet1!$B$2:$B$4".into()),
                    numbers: Some(vec![Some(1.0), Some(2.0), Some(3.0)]),
                    ..DataOut::default()
                },
                ..ExSeriesOut::default()
            }],
            subtotals: vec![2],
            ..ChartExOut::default()
        });
        let root = paged_ooxml::tree::parse(x.as_bytes()).unwrap();
        let c = crate::chart_ex(&root, &());
        assert_eq!(c.plots[0].element, "cx:waterfall");
        assert_eq!(c.plots[0].options.ex.subtotals, vec![2]);
        assert_eq!(
            c.plots[0].series[0].refs.values.as_deref(),
            Some("Sheet1!$B$2:$B$4")
        );
    }
}
