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
    /// kinds, and a reader may want to tell them apart.
    pub element: String,
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
}

#[derive(Debug, Clone, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
pub struct Axis<S = (), T = ()> {
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
