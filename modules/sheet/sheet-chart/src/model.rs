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

//! The chart MODEL (spec §8.4; W4.1, ADR 519). What a chart IS, bound to the
//! workbook: one or more [`Plot`]s (a combo chart is several, each with its
//! own kind, grouping and axis group), their [`Series`] bound to live ranges,
//! the axes, the legend, the title and the chart's style. The geometry
//! generator ([`crate::geometry`]) projects it; the xlsx reader fills it from
//! `chartN.xml` / `chartExN.xml` parts; the xlsx writer splices or generates
//! a part from it.
//!
//! STYLE ROLES. Every colour a chart paints (series fill and line, markers,
//! axes, gridlines, plot area, chart area, label text) is a [`ColorRef`]: the
//! concrete value (sRGB, a theme slot with a tint, a legacy index, or
//! automatic) BESIDE an optional document swatch id. Every text role (title,
//! axis title, tick labels, data labels, legend) is a [`TextStyleRef`]: the
//! concrete run properties beside optional document paragraph and character
//! style ids. The geometry carries the swatch id next to the resolved colour,
//! so the page lowering references the document's swatch (edit the swatch,
//! the chart recolours) and the xlsx writer writes the concrete value. They
//! are the cell visual model's own types (sheet-core `visual`, ADR 518).
//!
//! These types hold [`RangeRef`] series bindings (resolved against the
//! workbook on every geometry call), so they deliberately do NOT derive
//! `serde` — the shape that crosses the wire is the geometry IR.

use compact_str::CompactString;
use sheet_core::RangeRef;

// ── kinds ───────────────────────────────────────────────────────────────────

/// The chart kinds paged.sheet draws. Each is drawn as itself; a 3-D chart is
/// drawn as its 2-D kind with [`ChartModel::flattened_3d`] set (never silently
/// as something else), and a kind with no drawing (a region map) is
/// [`ChartKind::Unsupported`], drawn as a labelled placeholder.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub enum ChartKind {
    /// Horizontal bars (`c:barChart barDir="bar"`).
    Bar,
    /// Vertical bars (`c:barChart barDir="col"`).
    #[default]
    Column,
    Line,
    Area,
    Pie,
    /// A pie with a centre hole; several series are concentric rings.
    Donut,
    /// Markers (and optional lines) in (x, y) value space; several series.
    Scatter,
    /// A scatter whose points are discs sized by a third value.
    Bubble,
    /// A radial-axis chart: one spoke per category, one outline per series.
    Radar,
    /// A radar whose series are filled polygons.
    FilledRadar,
    /// High-low-close or open-high-low-close: hi-low lines, close ticks and
    /// up/down bars over a category axis.
    Stock,
    /// A pie whose last points are split into a second pie.
    PieOfPie,
    /// A pie whose last points are split into a stacked bar.
    BarOfPie,
    /// A 3-D surface, drawn as a contour (value bands over the
    /// category × series grid).
    Surface,
    // chartEx (`cx:` parts, Office 2016)
    Waterfall,
    Funnel,
    Treemap,
    Sunburst,
    Histogram,
    /// A histogram sorted descending with its cumulative-percent line.
    Pareto,
    BoxWhisker,
    /// A kind paged.sheet does not draw (a region map, an unknown chartEx
    /// layout): a labelled placeholder, never another kind.
    Unsupported,
}

impl ChartKind {
    /// A kind laid out on a category axis × value axis.
    pub fn is_category(self) -> bool {
        matches!(
            self,
            ChartKind::Bar
                | ChartKind::Column
                | ChartKind::Line
                | ChartKind::Area
                | ChartKind::Stock
                | ChartKind::Waterfall
        )
    }
    /// A kind laid out on two value axes.
    pub fn is_xy(self) -> bool {
        matches!(self, ChartKind::Scatter | ChartKind::Bubble)
    }
    /// A kind drawn without cartesian axes.
    pub fn is_radial(self) -> bool {
        matches!(
            self,
            ChartKind::Pie
                | ChartKind::Donut
                | ChartKind::PieOfPie
                | ChartKind::BarOfPie
                | ChartKind::Sunburst
        )
    }
    /// One of the Office 2016 chartEx kinds.
    pub fn is_chart_ex(self) -> bool {
        matches!(
            self,
            ChartKind::Waterfall
                | ChartKind::Funnel
                | ChartKind::Treemap
                | ChartKind::Sunburst
                | ChartKind::Histogram
                | ChartKind::Pareto
                | ChartKind::BoxWhisker
        )
    }
}

/// How the series of a bar, line or area plot combine (`c:grouping`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub enum Grouping {
    /// Side by side (bar: `clustered`; line/area: `standard`).
    #[default]
    Standard,
    /// Each series on the running total of the ones before it.
    Stacked,
    /// Stacked, every category normalised to 100%.
    PercentStacked,
}

impl Grouping {
    pub fn is_stacked(self) -> bool {
        !matches!(self, Grouping::Standard)
    }
}

// ── style roles ─────────────────────────────────────────────────────────────

// The colour and text roles are the document-styles program's own types
// (sheet-core `visual`, sheet ADR 518): a chart role and a cell role are
// the same kind of reference.
pub use sheet_core::visual::{
    ColorRef, ConcreteColor, DocColorModel, DocSwatchRef, FontSpec, TextStyleRef,
};

/// An sRGB colour role from `0xRRGGBB`.
pub fn color_rgb(v: u32) -> ColorRef {
    ColorRef::rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

/// A theme colour role from a DrawingML scheme slot (0 dk1, 1 lt1, 2 dk2,
/// 3 lt2, 4–9 accent1–6, 10 hlink, 11 folHlink) with an Excel tint. The
/// shared type counts the spreadsheet way (lt1, dk1, lt2, dk2 first), so the
/// first four slots swap in pairs.
pub fn color_scheme(slot: u8, tint: f64) -> ColorRef {
    ColorRef::theme(u32::from(dml_to_sheet_index(slot)), tint)
}

/// DrawingML scheme slot → SpreadsheetML theme index (and back: the map is
/// its own inverse).
pub fn dml_to_sheet_index(slot: u8) -> u8 {
    match slot {
        0 => 1,
        1 => 0,
        2 => 3,
        3 => 2,
        s => s,
    }
}

/// The `0xRRGGBB` of a concrete RGB colour.
pub fn rgb_of(c: &ColorRef) -> Option<u32> {
    match c.concrete {
        ConcreteColor::Rgb { r, g, b } => {
            Some((u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b))
        }
        _ => None,
    }
}

/// A document swatch reference with the sRGB a reader without the document
/// shows.
pub fn doc_swatch(id: &str, fallback: u32) -> DocSwatchRef {
    DocSwatchRef {
        id: id.to_string(),
        model: DocColorModel::Rgb,
        fallback_rgb: (
            (fallback >> 16) as u8,
            (fallback >> 8) as u8,
            fallback as u8,
        ),
    }
}

/// A line role (series line, axis line, gridline, outline).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct LineStyle {
    pub color: Option<ColorRef>,
    pub width_pt: Option<f64>,
    /// `a:prstDash` (`dash`, `sysDot`, …); `None` solid.
    pub dash: Option<CompactString>,
    /// `a:noFill`: no line at all.
    pub none: bool,
}

/// A filled area role (chart area, plot area).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct AreaStyle {
    /// `None` = the default (white chart area, no plot-area fill); a
    /// `Some(None)`-like "no fill" is `no_fill`.
    pub fill: Option<ColorRef>,
    pub no_fill: bool,
    pub line: Option<LineStyle>,
}

// ── the chart ───────────────────────────────────────────────────────────────

/// One chart.
#[derive(Clone, Debug, Default)]
pub struct ChartModel {
    /// The plots, in drawing order; never empty for a drawable chart. A
    /// combo chart has several (e.g. a column plot and a line plot on the
    /// secondary axis).
    pub plots: Vec<Plot>,
    pub title: Option<CompactString>,
    pub title_style: TextStyleRef,
    pub title_overlay: bool,
    /// The primary category axis (for scatter/bubble: the X value axis).
    pub cat_axis: Axis,
    /// The primary value axis.
    pub val_axis: Axis,
    /// The secondary axes, when a plot is on the secondary group.
    pub sec_cat_axis: Option<Axis>,
    pub sec_val_axis: Option<Axis>,
    /// `None` = no legend.
    pub legend: Option<Legend>,
    pub chart_area: AreaStyle,
    pub plot_area: AreaStyle,
    /// The chart's default text.
    pub text: TextStyleRef,
    /// Office chart style number (`c:style`, 1–48): its colour column picks
    /// the series colour scheme (2 = colourful accents, 1 = greys,
    /// 3–8 = shades of one accent).
    pub style: Option<u32>,
    /// The chart was a 3-D kind, drawn as its 2-D equivalent.
    pub flattened_3d: bool,
    /// The element the kind was read from (`bar3DChart`, `cx:regionMap`, …)
    /// when it is not the kind's own; a placeholder names it.
    pub source: Option<CompactString>,
    /// Empty cells: `gap` (default), `zero` or `span` (`c:dispBlanksAs`).
    pub blanks: Blanks,
}

/// `c:dispBlanksAs`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum Blanks {
    #[default]
    Gap,
    Zero,
    Span,
}

impl ChartModel {
    /// A one-plot chart.
    pub fn single(kind: ChartKind, grouping: Grouping, series: Vec<Series>) -> ChartModel {
        ChartModel {
            plots: vec![Plot {
                kind,
                grouping,
                series,
                ..Plot::default()
            }],
            ..ChartModel::default()
        }
    }
    /// The chart's kind: its first plot's (`Column` for an empty chart).
    pub fn kind(&self) -> ChartKind {
        self.plots.first().map_or(ChartKind::Column, |p| p.kind)
    }
    /// The first plot's grouping.
    pub fn grouping(&self) -> Grouping {
        self.plots
            .first()
            .map_or(Grouping::Standard, |p| p.grouping)
    }
    /// Every series of every plot, in drawing order (the order
    /// [`crate::PlotData`]'s vectors follow).
    pub fn series(&self) -> impl Iterator<Item = &Series> {
        self.plots.iter().flat_map(|p| p.series.iter())
    }
    pub fn series_count(&self) -> usize {
        self.plots.iter().map(|p| p.series.len()).sum()
    }
    /// More than one plot (a combo chart).
    pub fn is_combo(&self) -> bool {
        self.plots.len() > 1
    }
    /// Whether any plot uses the secondary axis group.
    pub fn has_secondary(&self) -> bool {
        self.plots.iter().any(|p| p.secondary)
    }
    /// Re-group a flat series list into plots: consecutive series with the
    /// same (kind, grouping, axis group) share a plot. Each series' own
    /// [`Series::kind`] / [`Series::secondary`] override the defaults given.
    pub fn set_series(
        &mut self,
        series: Vec<Series>,
        default_kind: ChartKind,
        default_grouping: Grouping,
    ) {
        let template = self.plots.first().cloned().unwrap_or_default();
        let mut plots: Vec<Plot> = Vec::new();
        for s in series {
            let kind = s.kind.unwrap_or(default_kind);
            let grouping = s.grouping.unwrap_or(default_grouping);
            let secondary = s.secondary;
            match plots.last_mut() {
                Some(p) if p.kind == kind && p.grouping == grouping && p.secondary == secondary => {
                    p.series.push(s)
                }
                _ => plots.push(Plot {
                    kind,
                    grouping,
                    secondary,
                    series: vec![s],
                    ..Plot {
                        series: Vec::new(),
                        ..template.clone()
                    }
                }),
            }
        }
        if plots.is_empty() {
            plots.push(Plot {
                kind: default_kind,
                grouping: default_grouping,
                ..template
            });
        }
        self.plots = plots;
    }
}

/// One chart type in the plot area (`c:barChart`, `c:lineChart`, …).
#[derive(Clone, Debug, PartialEq)]
pub struct Plot {
    pub kind: ChartKind,
    pub grouping: Grouping,
    /// On the secondary axis group.
    pub secondary: bool,
    pub series: Vec<Series>,
    /// One colour per point (`c:varyColors`; pies by default).
    pub vary_colors: bool,
    /// Bars: the gap between categories, % of a bar (default 150).
    pub gap_width: u32,
    /// Bars: overlap within a category, % (−100..100).
    pub overlap: i32,
    /// Donut hole, % of the radius (default 50).
    pub hole_size: u32,
    /// Pie: the first slice's angle, degrees clockwise from 12 o'clock.
    pub first_slice_angle: u32,
    /// Bubble: the size scale, % (default 100).
    pub bubble_scale: u32,
    /// Bubble: sizes are areas (`area`, default) or widths (`w`).
    pub bubble_size_is_width: bool,
    /// Pie-of-pie / bar-of-pie.
    pub of_pie: OfPie,
    /// Line/stock: high-low lines.
    pub hi_low_lines: bool,
    /// Line/stock: up/down bars between the first and last series.
    pub up_down_bars: bool,
    /// Line: drop lines.
    pub drop_lines: bool,
    /// Plot-level data labels (a series' own win).
    pub labels: Option<DataLabels>,
    /// chartEx options.
    pub ex: ExOptions,
}

impl Default for Plot {
    fn default() -> Plot {
        Plot {
            kind: ChartKind::Column,
            grouping: Grouping::Standard,
            secondary: false,
            series: Vec::new(),
            vary_colors: false,
            gap_width: 150,
            overlap: 0,
            hole_size: 50,
            first_slice_angle: 0,
            bubble_scale: 100,
            bubble_size_is_width: false,
            of_pie: OfPie::default(),
            hi_low_lines: false,
            up_down_bars: false,
            drop_lines: false,
            labels: None,
            ex: ExOptions::default(),
        }
    }
}

/// How a pie-of-pie / bar-of-pie splits its points (`c:splitType`).
#[derive(Clone, Debug, PartialEq)]
pub struct OfPie {
    pub split: SplitType,
    /// `c:splitPos`: a point count (position), a value or a percent.
    pub split_pos: Option<f64>,
    /// `c:custSplit`: the point indexes in the second plot.
    pub custom: Vec<u32>,
    /// The second plot's size, % of the first (default 75).
    pub second_size: u32,
}

impl Default for OfPie {
    fn default() -> OfPie {
        OfPie {
            split: SplitType::Position,
            split_pos: None,
            custom: Vec::new(),
            second_size: 75,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum SplitType {
    /// The last N points (Excel's automatic choice too).
    #[default]
    Position,
    /// Points below a value.
    Value,
    /// Points below a percent of the total.
    Percent,
    /// The points listed.
    Custom,
}

/// chartEx layout options (`cx:layoutPr`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ExOptions {
    /// Waterfall: the point indexes that are subtotals (drawn from zero).
    pub subtotals: Vec<u32>,
    /// Histogram / pareto binning.
    pub bins: Binning,
    /// Box & whisker.
    pub box_whisker: BoxOptions,
    /// Treemap: parent labels as banners (default) or overlapping or none.
    pub parent_labels: Option<CompactString>,
}

/// Histogram binning (`cx:binning`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Binning {
    /// Bins by category (text categories are counted per distinct value).
    pub by_category: bool,
    pub count: Option<u32>,
    pub width: Option<f64>,
    pub overflow: Option<f64>,
    pub underflow: Option<f64>,
    /// Intervals closed on the left (`[a, b)`); Excel's default is right.
    pub closed_left: bool,
}

/// Box & whisker options (`cx:statistics`, `cx:visibility`).
#[derive(Clone, Debug, PartialEq)]
pub struct BoxOptions {
    /// Quartiles exclusive of the median (default) or inclusive.
    pub inclusive: bool,
    pub mean_line: bool,
    pub mean_marker: bool,
    pub inner_points: bool,
    pub outliers: bool,
}

impl Default for BoxOptions {
    fn default() -> BoxOptions {
        BoxOptions {
            inclusive: false,
            mean_line: false,
            mean_marker: true,
            inner_points: false,
            outliers: true,
        }
    }
}

// ── series ──────────────────────────────────────────────────────────────────

/// One data series, bound to ranges of the workbook.
#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    /// The cached or authored name.
    pub name: Option<CompactString>,
    /// The cell the name is bound to (`c:tx/c:strRef`), live.
    pub name_ref: Option<RangeRef>,
    /// Category labels (bar/line/area/pie/radar/stock) — for scatter and
    /// bubble the X values are [`Series::x_values`].
    pub categories: Option<RangeRef>,
    /// The values (Y for scatter/bubble).
    pub values: RangeRef,
    /// Scatter/bubble X values.
    pub x_values: Option<RangeRef>,
    /// Bubble sizes.
    pub sizes: Option<RangeRef>,
    /// The series fill (bars, areas, slices, bubbles, markers by default).
    pub fill: Option<ColorRef>,
    /// The series line (lines, scatter lines, outlines).
    pub line: Option<LineStyle>,
    pub marker: Option<Marker>,
    /// Per-point fills (`c:dPt`), by point index.
    pub points: Vec<(u32, ColorRef)>,
    pub labels: Option<DataLabels>,
    pub trendlines: Vec<Trendline>,
    pub error_bars: Vec<ErrorBars>,
    /// A smoothed line.
    pub smooth: bool,
    /// Pie: how far the slices are pulled out, % of the radius.
    pub explosion: u32,
    /// Bars: negative values in a contrasting fill (`c:invertIfNegative`).
    pub invert_if_negative: bool,
    /// Combo authoring: this series' kind when it differs from the plot's
    /// (read by [`ChartModel::set_series`]; `None` in a parsed model).
    pub kind: Option<ChartKind>,
    pub grouping: Option<Grouping>,
    /// On the secondary axis group (authoring; parsed series sit in a plot
    /// that says so).
    pub secondary: bool,
    /// The series' index in its part (`c:idx`): picks the automatic colour
    /// and maps the series back to its XML for a splice.
    pub index: Option<u32>,
}

impl Series {
    /// A series over `values` with nothing else set.
    pub fn of(values: RangeRef) -> Series {
        Series {
            name: None,
            name_ref: None,
            categories: None,
            values,
            x_values: None,
            sizes: None,
            fill: None,
            line: None,
            marker: None,
            points: Vec::new(),
            labels: None,
            trendlines: Vec::new(),
            error_bars: Vec::new(),
            smooth: false,
            explosion: 0,
            invert_if_negative: false,
            kind: None,
            grouping: None,
            secondary: false,
            index: None,
        }
    }
}

impl Series {
    /// Apply `f` to every range the series is bound to; `f` returns the new
    /// range, or `None` when the range is gone (an optional binding is then
    /// dropped; the values keep their old range).
    pub fn map_ranges(&mut self, mut f: impl FnMut(RangeRef) -> Option<RangeRef>) {
        if let Some(v) = f(self.values) {
            self.values = v;
        }
        for r in [
            &mut self.name_ref,
            &mut self.categories,
            &mut self.x_values,
            &mut self.sizes,
        ] {
            *r = r.and_then(&mut f);
        }
        for e in &mut self.error_bars {
            if let ErrorValue::Custom { plus, minus } = &mut e.value {
                *plus = plus.and_then(&mut f);
                *minus = minus.and_then(&mut f);
            }
        }
    }
}

/// A marker (`c:marker`).
#[derive(Clone, Debug, PartialEq)]
pub struct Marker {
    pub symbol: MarkerSymbol,
    /// 2–72 pt (Excel's default is 5).
    pub size: f64,
    pub fill: Option<ColorRef>,
    pub line: Option<ColorRef>,
}

impl Default for Marker {
    fn default() -> Marker {
        Marker {
            symbol: MarkerSymbol::Auto,
            size: 5.0,
            fill: None,
            line: None,
        }
    }
}

/// `c:symbol`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum MarkerSymbol {
    None,
    /// The automatic symbol for the series index.
    #[default]
    Auto,
    Circle,
    Square,
    Diamond,
    Triangle,
    X,
    Star,
    Dash,
    Dot,
    Plus,
}

impl MarkerSymbol {
    pub fn from_tag(tag: &str) -> MarkerSymbol {
        match tag {
            "none" => MarkerSymbol::None,
            "circle" => MarkerSymbol::Circle,
            "square" => MarkerSymbol::Square,
            "diamond" => MarkerSymbol::Diamond,
            "triangle" => MarkerSymbol::Triangle,
            "x" => MarkerSymbol::X,
            "star" => MarkerSymbol::Star,
            "dash" => MarkerSymbol::Dash,
            "dot" => MarkerSymbol::Dot,
            "plus" => MarkerSymbol::Plus,
            _ => MarkerSymbol::Auto,
        }
    }
    pub fn tag(self) -> &'static str {
        match self {
            MarkerSymbol::None => "none",
            MarkerSymbol::Auto => "auto",
            MarkerSymbol::Circle => "circle",
            MarkerSymbol::Square => "square",
            MarkerSymbol::Diamond => "diamond",
            MarkerSymbol::Triangle => "triangle",
            MarkerSymbol::X => "x",
            MarkerSymbol::Star => "star",
            MarkerSymbol::Dash => "dash",
            MarkerSymbol::Dot => "dot",
            MarkerSymbol::Plus => "plus",
        }
    }
    /// Excel's automatic symbol sequence by series index.
    pub fn auto_for(index: usize) -> MarkerSymbol {
        const SEQ: [MarkerSymbol; 9] = [
            MarkerSymbol::Diamond,
            MarkerSymbol::Square,
            MarkerSymbol::Triangle,
            MarkerSymbol::X,
            MarkerSymbol::Star,
            MarkerSymbol::Circle,
            MarkerSymbol::Plus,
            MarkerSymbol::Dash,
            MarkerSymbol::Dot,
        ];
        SEQ[index % SEQ.len()]
    }
}

/// Data labels (`c:dLbls`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct DataLabels {
    pub show_value: bool,
    pub show_category: bool,
    pub show_series: bool,
    pub show_percent: bool,
    pub show_bubble_size: bool,
    pub position: Option<LabelPosition>,
    /// The number format of the label values (`c:numFmt`).
    pub format: Option<CompactString>,
    /// Between the label parts (default `", "`; Excel writes `"\n"` too).
    pub separator: Option<CompactString>,
    pub style: TextStyleRef,
}

impl DataLabels {
    pub fn any(&self) -> bool {
        self.show_value
            || self.show_category
            || self.show_series
            || self.show_percent
            || self.show_bubble_size
    }
}

/// `c:dLblPos`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum LabelPosition {
    BestFit,
    Bottom,
    Center,
    InsideBase,
    InsideEnd,
    Left,
    OutsideEnd,
    Right,
    Top,
}

impl LabelPosition {
    pub fn from_tag(tag: &str) -> Option<LabelPosition> {
        Some(match tag {
            "bestFit" => LabelPosition::BestFit,
            "b" => LabelPosition::Bottom,
            "ctr" => LabelPosition::Center,
            "inBase" => LabelPosition::InsideBase,
            "inEnd" => LabelPosition::InsideEnd,
            "l" => LabelPosition::Left,
            "outEnd" => LabelPosition::OutsideEnd,
            "r" => LabelPosition::Right,
            "t" => LabelPosition::Top,
            _ => return None,
        })
    }
    pub fn tag(self) -> &'static str {
        match self {
            LabelPosition::BestFit => "bestFit",
            LabelPosition::Bottom => "b",
            LabelPosition::Center => "ctr",
            LabelPosition::InsideBase => "inBase",
            LabelPosition::InsideEnd => "inEnd",
            LabelPosition::Left => "l",
            LabelPosition::OutsideEnd => "outEnd",
            LabelPosition::Right => "r",
            LabelPosition::Top => "t",
        }
    }
}

/// A trendline (`c:trendline`).
#[derive(Clone, Debug, PartialEq)]
pub struct Trendline {
    pub kind: TrendKind,
    pub name: Option<CompactString>,
    /// Periods to extend forward / backward (in X units).
    pub forward: f64,
    pub backward: f64,
    /// A fixed intercept (`c:intercept`; linear, exponential, polynomial).
    pub intercept: Option<f64>,
    pub display_r2: bool,
    pub display_equation: bool,
    pub line: Option<LineStyle>,
}

impl Trendline {
    pub fn of(kind: TrendKind) -> Trendline {
        Trendline {
            kind,
            name: None,
            forward: 0.0,
            backward: 0.0,
            intercept: None,
            display_r2: false,
            display_equation: false,
            line: None,
        }
    }
}

/// `c:trendlineType`.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum TrendKind {
    Linear,
    Exponential,
    Logarithmic,
    /// Order 2–6.
    Polynomial(u8),
    Power,
    /// Period ≥ 2.
    MovingAverage(u32),
}

/// Error bars (`c:errBars`).
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorBars {
    /// Along Y (default) or X (scatter/bubble).
    pub along_x: bool,
    pub bar_type: ErrorBarType,
    pub value: ErrorValue,
    pub no_end_cap: bool,
    pub line: Option<LineStyle>,
}

/// `c:errBarType`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum ErrorBarType {
    #[default]
    Both,
    Plus,
    Minus,
}

/// `c:errValType` with its amount.
#[derive(Clone, Debug, PartialEq)]
pub enum ErrorValue {
    Fixed(f64),
    Percentage(f64),
    StdDev(f64),
    StdErr,
    Custom {
        plus: Option<RangeRef>,
        minus: Option<RangeRef>,
    },
}

// ── axes, legend ────────────────────────────────────────────────────────────

/// What an axis measures.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum AxisKind {
    #[default]
    Category,
    /// A category axis over date serials (`c:dateAx`).
    Date,
    /// A value axis (scatter/bubble X).
    Value,
}

/// Where the perpendicular axis crosses this one (`c:crosses` /
/// `c:crossesAt`).
#[derive(Copy, Clone, Debug, PartialEq, Default)]
pub enum Crosses {
    #[default]
    AutoZero,
    Min,
    Max,
    At(f64),
}

/// `c:tickLblPos`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum TickLabels {
    #[default]
    NextTo,
    Low,
    High,
    None,
}

/// Date-axis base unit (`c:baseTimeUnit`).
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum TimeUnit {
    #[default]
    Days,
    Months,
    Years,
}

/// An axis.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Axis {
    pub title: Option<CompactString>,
    pub title_style: TextStyleRef,
    pub kind: AxisKind,
    /// Explicit bounds (`None` = automatic).
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub major_unit: Option<f64>,
    pub minor_unit: Option<f64>,
    /// Logarithmic scale base (`c:logBase`, 2–1000).
    pub log_base: Option<f64>,
    /// Values in reverse order (`orientation maxMin`).
    pub reversed: bool,
    pub crosses: Crosses,
    pub base_unit: Option<TimeUnit>,
    /// Tick-label number format (`None` = General / the source's).
    pub format: Option<CompactString>,
    /// The axis is hidden (`c:delete`).
    pub deleted: bool,
    pub major_gridlines: Option<LineStyle>,
    pub minor_gridlines: Option<LineStyle>,
    /// The axis line (`None` = the default grey).
    pub line: Option<LineStyle>,
    pub labels: TextStyleRef,
    pub tick_labels: TickLabels,
}

/// `c:legendPos`.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum LegendPosition {
    #[default]
    Right,
    Left,
    Top,
    Bottom,
    TopRight,
}

impl LegendPosition {
    pub fn from_tag(tag: &str) -> LegendPosition {
        match tag {
            "l" => LegendPosition::Left,
            "t" => LegendPosition::Top,
            "b" => LegendPosition::Bottom,
            "tr" => LegendPosition::TopRight,
            _ => LegendPosition::Right,
        }
    }
    pub fn tag(self) -> &'static str {
        match self {
            LegendPosition::Right => "r",
            LegendPosition::Left => "l",
            LegendPosition::Top => "t",
            LegendPosition::Bottom => "b",
            LegendPosition::TopRight => "tr",
        }
    }
}

/// The legend (`c:legend`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Legend {
    pub position: LegendPosition,
    pub overlay: bool,
    pub style: TextStyleRef,
}

// ── sparklines ──────────────────────────────────────────────────────────────

/// A sparkline group (`x14:sparklineGroup`): one setting, many cells.
#[derive(Clone, Debug, PartialEq)]
pub struct SparklineGroup {
    pub kind: SparklineKind,
    /// Each sparkline: the data range and the cell it is drawn in.
    pub sparklines: Vec<(RangeRef, sheet_core::CellRef)>,
    pub series: ColorRef,
    pub negative: Option<ColorRef>,
    pub axis: Option<ColorRef>,
    pub markers: Option<ColorRef>,
    pub first: Option<ColorRef>,
    pub last: Option<ColorRef>,
    pub high: Option<ColorRef>,
    pub low: Option<ColorRef>,
    pub show_markers: bool,
    pub show_first: bool,
    pub show_last: bool,
    pub show_high: bool,
    pub show_low: bool,
    pub show_negative: bool,
    pub show_axis: bool,
    /// Line weight, pt (default 0.75).
    pub line_weight: f64,
    pub blanks: Blanks,
    /// Fixed axis bounds (`manualMin` / `manualMax` with `custom` type).
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub right_to_left: bool,
}

impl Default for SparklineGroup {
    fn default() -> SparklineGroup {
        SparklineGroup {
            kind: SparklineKind::Line,
            sparklines: Vec::new(),
            series: color_rgb(0x37_6092),
            negative: None,
            axis: None,
            markers: None,
            first: None,
            last: None,
            high: None,
            low: None,
            show_markers: false,
            show_first: false,
            show_last: false,
            show_high: false,
            show_low: false,
            show_negative: false,
            show_axis: false,
            line_weight: 0.75,
            blanks: Blanks::Gap,
            min: None,
            max: None,
            right_to_left: false,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub enum SparklineKind {
    #[default]
    Line,
    Column,
    /// `stacked` in the file: up and down bars of equal height.
    WinLoss,
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;
    use sheet_core::CellRef;

    fn rr(r0: u32, c0: u32, r1: u32, c1: u32) -> RangeRef {
        let cr = |row, col| CellRef {
            sheet: 0,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        RangeRef {
            start: cr(r0, c0),
            end: cr(r1, c1),
        }
    }

    #[test]
    fn model_constructs__feat__sheet_chart_kinds() {
        let mut s = Series::of(rr(0, 1, 2, 1));
        s.name = Some("Revenue".into());
        s.categories = Some(rr(0, 0, 2, 0));
        s.fill = ColorRef::from_hex("#3366CC");
        let mut m = ChartModel::single(ChartKind::Column, Grouping::Standard, vec![s]);
        m.title = Some("Q1".into());
        m.val_axis.title = Some("EUR".into());
        m.val_axis.min = Some(0.0);
        m.legend = Some(Legend::default());
        assert_eq!(m.kind(), ChartKind::Column);
        assert_eq!(m.series_count(), 1);
        assert_eq!(m.series().next().unwrap().values.rows(), 3);
        assert_eq!(m.series().next().unwrap().fill, Some(color_rgb(0x3366CC)));
    }

    #[test]
    fn set_series_groups_a_combo_into_plots__feat__sheet_chart_combo() {
        let mut m = ChartModel::single(ChartKind::Column, Grouping::Standard, Vec::new());
        let a = Series::of(rr(0, 1, 2, 1));
        let b = Series::of(rr(0, 2, 2, 2));
        let mut c = Series::of(rr(0, 3, 2, 3));
        c.kind = Some(ChartKind::Line);
        c.secondary = true;
        m.set_series(vec![a, b, c], ChartKind::Column, Grouping::Stacked);
        assert_eq!(m.plots.len(), 2);
        assert_eq!(m.plots[0].kind, ChartKind::Column);
        assert_eq!(m.plots[0].grouping, Grouping::Stacked);
        assert_eq!(m.plots[0].series.len(), 2);
        assert_eq!(m.plots[1].kind, ChartKind::Line);
        assert!(m.plots[1].secondary);
        assert!(m.is_combo() && m.has_secondary());
    }
}
