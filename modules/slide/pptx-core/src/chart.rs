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

//! DrawingML charts (`c:chartSpace`), as the file authors them: the cached
//! values (`c:numCache` / `c:strCache`) PowerPoint draws from, and every
//! paint and text property still unresolved. The embedded workbook is not
//! read; the cache is what PowerPoint itself shows until the data is edited.

use serde::{Deserialize, Serialize};

use crate::{RunProps, ShapeProps};

/// One `c:chartSpace` part.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Chart {
    /// `c:title`; `None` when the chart has none (or `autoTitleDeleted`).
    pub title: Option<ChartTitle>,
    /// The chart types drawn in the plot area, in file order.
    pub plots: Vec<Plot>,
    /// `c:catAx` (or `c:dateAx`).
    pub cat_axis: Option<Axis>,
    /// `c:valAx`.
    pub val_axis: Option<Axis>,
    pub legend: Option<Legend>,
    /// `c:chartSpace/c:spPr`: the chart area.
    pub area: ShapeProps,
    /// `c:plotArea/c:spPr`.
    pub plot_area: ShapeProps,
    /// `c:chartSpace/c:txPr` default run properties.
    pub text: Option<RunProps>,
    /// `c:style` (Office's chart style number), when given.
    pub style: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ChartTitle {
    /// Rich text runs; empty means the automatic title (the single series'
    /// name, or "Chart Title").
    pub text: String,
    pub props: Option<RunProps>,
    pub overlay: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// A type this importer does not draw (radar, scatter, 3-D, …).
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plot {
    pub kind: PlotKind,
    /// `c:varyColors`: one colour per data point (pie).
    pub vary_colors: bool,
    pub series: Vec<Series>,
    /// `c:dLbls` at the chart-type level.
    pub labels: Option<DataLabels>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Series {
    /// `c:idx`: picks the automatic colour.
    pub index: u32,
    /// `c:tx` cached name.
    pub name: String,
    pub props: ShapeProps,
    /// Category labels from `c:cat`.
    pub categories: Vec<String>,
    /// Values from `c:val`; a missing point is `None`.
    pub values: Vec<Option<f64>>,
    /// `c:smooth` (line).
    pub smooth: bool,
    /// `c:marker/c:symbol`, `none` when markers are off.
    pub marker: Option<String>,
    /// Per-point overrides (`c:dPt`): index and its shape properties.
    pub points: Vec<(u32, ShapeProps)>,
    pub labels: Option<DataLabels>,
    /// Number format of the values (`c:numCache/c:formatCode`).
    pub format: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DataLabels {
    pub show_value: bool,
    pub show_category: bool,
    pub show_series: bool,
    pub show_percent: bool,
    /// `c:dLblPos` (outEnd, inEnd, ctr, t, b, l, r, bestFit).
    pub position: Option<String>,
    pub text: Option<RunProps>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Axis {
    /// `c:delete`: the axis (line and labels) is hidden.
    pub deleted: bool,
    /// `c:axPos` (l, r, t, b).
    pub position: String,
    /// `c:majorGridlines` (its line, when drawn).
    pub major_gridlines: Option<ShapeProps>,
    pub minor_gridlines: Option<ShapeProps>,
    /// The axis line itself (`c:spPr`).
    pub line: ShapeProps,
    /// Tick labels' run properties (`c:txPr`).
    pub text: Option<RunProps>,
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

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Legend {
    /// `c:legendPos` (r, l, t, b, tr).
    pub position: String,
    pub overlay: bool,
    pub text: Option<RunProps>,
}
