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

//! # dml-chart — one DrawingML chart reader for paged.sheet and paged.slide
//!
//! An Excel workbook and a PowerPoint deck carry the same chart part, a
//! DrawingML `c:chartSpace` (ECMA-376 Part 1 §21.2). This crate reads it once
//! ([`chart`]) into one model ([`Chart`]): the chart types in the plot area,
//! their series with the cached values and the formula references, the
//! axes, the title and the legend. The paints and text properties are the
//! reader's own types (the [`Props`] it passes): paged.slide reads them into
//! its `ShapeProps` / `RunProps`, paged.sheet into `()`.
//!
//! How a chart is laid out is not here. Excel and PowerPoint draw the same
//! chart differently, and each module keeps its own profile: paged.sheet's
//! curated kinds and geometry (`sheet-chart`), bound to the live cells the
//! references name; paged.slide's PowerPoint layout (`slide-chart`), drawn
//! from the cached values.
//!
//! The reader works on `paged_ooxml::tree`'s element tree and is tolerant:
//! an element it does not know is skipped, never an error.

pub mod model;
pub mod read;
pub mod read_ex;
pub mod write;

pub use model::{
    Axis, Chart, ChartTitle, DataLabels, ErrorBars, ExLayout, Legend, Plot, PlotKind, PlotOptions,
    Series, SeriesRefs, Trendline,
};
pub use read::{chart, Props};
pub use read_ex::chart_ex;
