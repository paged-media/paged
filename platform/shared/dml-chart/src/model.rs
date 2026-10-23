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

//! The chart model: a `c:chartSpace` part as the file authors it.
//!
//! The cached values (`c:numCache` / `c:strCache`) are what PowerPoint draws
//! from; the formula references (`c:f`) are what Excel binds the series to.
//! Both are kept, so each module lays the chart out from the side it reads.
//! The paints and text properties are the reader's own types: `S` for a
//! `c:spPr`, `T` for an `a:rPr` / `a:defRPr` (see [`crate::Props`]); a
//! module that does not read them uses `()`.

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

/// One `c:chartSpace` part.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Chart<S = (), T = ()> {
    /// `c:title`; `None` when the chart has none (or `autoTitleDeleted`).
    pub title: Option<ChartTitle<T>>,
    /// The chart types drawn in the plot area, in file order.
    pub plots: Vec<Plot<S, T>>,
    /// `c:catAx` (or `c:dateAx`).
    pub cat_axis: Option<Axis<S, T>>,
    /// `c:valAx`.
    pub val_axis: Option<Axis<S, T>>,
    pub legend: Option<Legend<T>>,
    /// `c:chartSpace/c:spPr`: the chart area.
    pub area: S,
    /// `c:plotArea/c:spPr`.
    pub plot_area: S,
    /// `c:chartSpace/c:txPr` default run properties.
    pub text: Option<T>,
    /// `c:style` (Office's chart style number), when given.
    pub style: Option<u32>,
    /// Every axis of the plot area in file order (`cat_axis` / `val_axis`
    /// are the first of each); the plots name theirs by id.
    pub axes: Vec<Axis<S, T>>,
    /// `c:dispBlanksAs` (`gap`, `zero`, `span`).
    pub blanks: Option<String>,
    /// The chart has a `c:view3D` (a 3-D chart).
    pub view_3d: bool,
    /// Read from a chartEx part (`cx:chartSpace`).
    pub chart_ex: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct ChartTitle<T = ()> {
    /// Rich text runs; empty means the automatic title (the single series'
    /// name, or "Chart Title").
    pub text: String,
    pub props: Option<T>,
    pub overlay: bool,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub enum PlotKind {
    /// `c:barChart`: `col` (vertical bars) or `bar` (horizontal).
    Bar {
        horizontal: bool,
        /// `clustered`, `stacked`, `percentStacked`.
        grouping: String,
        /// Gap between clusters, % of a bar's width (default 150).
        gap_width: i32,
        /// Overlap of bars in a cluster, % (−100..100, default 0).
        overlap: i32,
    },
    /// `c:lineChart`: `standard`, `stacked`, `percentStacked`.
    Line { grouping: String },
    /// `c:areaChart`.
    Area { grouping: String },
    /// `c:pieChart` / `c:doughnutChart` (`hole` % of the radius).
    Pie {
        first_slice_angle: i32,
        hole: Option<i32>,
    },
    /// Any other chart type (radar, scatter, surface, …), by element name.
    Other(String),
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Plot<S = (), T = ()> {
    pub kind: PlotKind,
    /// `c:varyColors`: one colour per data point (pie).
    pub vary_colors: bool,
    pub series: Vec<Series<S, T>>,
    /// `c:dLbls` at the chart-type level.
    pub labels: Option<DataLabels<T>>,
    /// The plot's element name as written (`barChart`, `bar3DChart`,
    /// `scatterChart`, …): [`PlotKind`] folds the 3-D variants into the flat
    /// kinds, and a reader may want to tell them apart. A chartEx series
    /// layout is `cx:<layoutId>` (`cx:waterfall`, `cx:treemap`, …).
    pub element: String,
    /// The type-specific options the kind does not carry.
    pub options: PlotOptions,
    /// `c:axId`: the axes this plot is drawn on.
    pub axis_ids: Vec<u32>,
}

/// The options of a chart type beyond its [`PlotKind`].
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct PlotOptions {
    /// `c:scatterStyle` (`lineMarker`, `marker`, `smoothMarker`, …).
    pub scatter_style: Option<String>,
    /// `c:radarStyle` (`standard`, `marker`, `filled`).
    pub radar_style: Option<String>,
    /// `c:bubbleScale` (%).
    pub bubble_scale: Option<u32>,
    pub show_neg_bubbles: bool,
    /// `c:sizeRepresents` (`area`, `w`).
    pub size_represents: Option<String>,
    /// `c:ofPieType` (`pie`, `bar`).
    pub of_pie_type: Option<String>,
    /// `c:splitType` (`auto`, `pos`, `val`, `percent`, `cust`).
    pub split_type: Option<String>,
    pub split_pos: Option<f64>,
    /// `c:custSplit/c:secondPiePt`.
    pub cust_split: Vec<u32>,
    pub second_pie_size: Option<u32>,
    pub hi_low_lines: bool,
    pub up_down_bars: bool,
    pub drop_lines: bool,
    /// `c:lineChart/c:marker`: markers shown (absent = `None`).
    pub marker: Option<bool>,
    /// `c:surfaceChart/c:wireframe`.
    pub wireframe: bool,
    /// chartEx `cx:layoutPr` and the series' owner (a pareto line).
    pub ex: ExLayout,
}

/// A chartEx series' layout properties (`cx:layoutPr`).
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct ExLayout {
    /// Waterfall `cx:subtotals/cx:idx`.
    pub subtotals: Vec<u32>,
    /// Histogram `cx:binning`: `binSize`, `binCount`, `intervalClosed`
    /// (`l`/`r`), `underflow`/`overflow` (`auto` or a number).
    pub bin_size: Option<f64>,
    pub bin_count: Option<u32>,
    pub interval_closed: Option<String>,
    pub underflow: Option<String>,
    pub overflow: Option<String>,
    /// `cx:aggregation`: bins by category.
    pub aggregation: bool,
    /// Box & whisker `cx:statistics quartileMethod`.
    pub quartile_method: Option<String>,
    /// `cx:visibility` of a box & whisker.
    pub mean_line: Option<bool>,
    pub mean_marker: Option<bool>,
    pub nonoutliers: Option<bool>,
    pub outliers: Option<bool>,
    /// Treemap `cx:parentLabelLayout`.
    pub parent_label_layout: Option<String>,
    /// `ownerIdx`: the series this one belongs to (a pareto line).
    pub owner_idx: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Series<S = (), T = ()> {
    /// `c:idx`: picks the automatic colour.
    pub index: u32,
    /// `c:tx` cached name.
    pub name: String,
    pub props: S,
    /// Category labels from `c:cat` (or `c:xVal`).
    pub categories: Vec<String>,
    /// Values from `c:val` (or `c:yVal`); a missing point is `None`.
    pub values: Vec<Option<f64>>,
    /// `c:smooth` (line).
    pub smooth: bool,
    /// `c:marker/c:symbol`, `none` when markers are off.
    pub marker: Option<String>,
    /// Per-point overrides (`c:dPt`): index and its shape properties.
    pub points: Vec<(u32, S)>,
    pub labels: Option<DataLabels<T>>,
    /// Number format of the values (`c:numCache/c:formatCode`).
    pub format: Option<String>,
    /// The formulas the series is bound to (`c:f`), as written.
    pub refs: SeriesRefs,
    /// `c:marker/c:size`.
    pub marker_size: Option<u32>,
    /// `c:marker/c:spPr`.
    pub marker_props: Option<S>,
    pub trendlines: Vec<Trendline<S>>,
    pub error_bars: Vec<ErrorBars<S>>,
    /// `c:explosion` (%).
    pub explosion: Option<u32>,
    pub invert_if_negative: bool,
}

/// `c:trendline`.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Trendline<S = ()> {
    pub name: Option<String>,
    /// `c:trendlineType` (`linear`, `exp`, `log`, `poly`, `power`,
    /// `movingAvg`).
    pub kind: String,
    /// `c:order` (poly) or `c:period` (movingAvg).
    pub order: Option<u32>,
    pub period: Option<u32>,
    pub forward: Option<f64>,
    pub backward: Option<f64>,
    pub intercept: Option<f64>,
    pub display_r2: bool,
    pub display_equation: bool,
    pub props: S,
}

/// `c:errBars`.
#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct ErrorBars<S = ()> {
    /// `c:errDir` (`x`, `y`).
    pub direction: Option<String>,
    /// `c:errBarType` (`both`, `plus`, `minus`).
    pub bar_type: String,
    /// `c:errValType` (`fixedVal`, `percentage`, `stdDev`, `stdErr`, `cust`).
    pub value_type: String,
    pub value: Option<f64>,
    pub no_end_cap: bool,
    /// `c:plus/…/c:f` and `c:minus/…/c:f`.
    pub plus: Option<String>,
    pub minus: Option<String>,
    pub props: S,
}

/// The `c:f` formula text of a series' parts, as written (a sheet-qualified
/// A1 range such as `Sheet1!$B$2:$B$4`). Excel binds the series to these; the
/// cached values are what they last evaluated to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct SeriesRefs {
    /// `c:tx/c:strRef/c:f`: the series name.
    pub name: Option<String>,
    /// `c:cat/…/c:f`.
    pub categories: Option<String>,
    /// `c:val/…/c:f`.
    pub values: Option<String>,
    /// `c:xVal/…/c:f` (scatter).
    pub x_values: Option<String>,
    /// `c:yVal/…/c:f` (scatter).
    pub y_values: Option<String>,
    /// `c:bubbleSize/…/c:f`.
    pub bubble_sizes: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct DataLabels<T = ()> {
    pub show_value: bool,
    pub show_category: bool,
    pub show_series: bool,
    pub show_percent: bool,
    /// `c:dLblPos` (outEnd, inEnd, ctr, t, b, l, r, bestFit).
    pub position: Option<String>,
    pub text: Option<T>,
    pub format: Option<String>,
    pub show_bubble_size: bool,
    /// `c:separator`.
    pub separator: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Axis<S = (), T = ()> {
    /// `c:axId`.
    pub id: u32,
    /// `c:crossAx`.
    pub cross_ax: u32,
    /// The element: `catAx`, `valAx`, `dateAx`, `serAx`.
    pub element: String,
    /// `c:title`.
    pub title: Option<ChartTitle<T>>,
    /// `c:scaling/c:logBase`.
    pub log_base: Option<f64>,
    pub minor_unit: Option<f64>,
    /// `c:crosses` (`autoZero`, `min`, `max`).
    pub crosses: Option<String>,
    pub crosses_at: Option<f64>,
    /// `c:baseTimeUnit` (`days`, `months`, `years`).
    pub base_time_unit: Option<String>,
    /// `c:delete`: the axis (line and labels) is hidden.
    pub deleted: bool,
    /// `c:axPos` (l, r, t, b).
    pub position: String,
    /// `c:majorGridlines` (its line, when drawn).
    pub major_gridlines: Option<S>,
    pub minor_gridlines: Option<S>,
    /// The axis line itself (`c:spPr`).
    pub line: S,
    /// Tick labels' run properties (`c:txPr`).
    pub text: Option<T>,
    /// `c:tickLblPos` (nextTo, low, high, none).
    pub tick_labels: String,
    /// `c:scaling`: explicit bounds and `maxMin` orientation.
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub reversed: bool,
    pub major_unit: Option<f64>,
    /// `c:numFmt formatCode` (value axis), unless linked to the source.
    pub format: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Legend<T = ()> {
    /// `c:legendPos` (r, l, t, b, tr).
    pub position: String,
    pub overlay: bool,
    pub text: Option<T>,
}
