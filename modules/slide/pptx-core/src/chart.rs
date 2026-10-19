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
//!
//! The model is the shared DrawingML chart model (`dml_chart`,
//! `platform/shared/dml-chart`, which paged.sheet reads its charts into too),
//! with this crate's paints ([`ShapeProps`]) and text properties
//! ([`RunProps`]).

use crate::{RunProps, ShapeProps};

pub use dml_chart::{PlotKind, SeriesRefs};

/// One `c:chartSpace` part.
pub type Chart = dml_chart::Chart<ShapeProps, RunProps>;
pub type ChartTitle = dml_chart::ChartTitle<RunProps>;
pub type Plot = dml_chart::Plot<ShapeProps, RunProps>;
pub type Series = dml_chart::Series<ShapeProps, RunProps>;
pub type DataLabels = dml_chart::DataLabels<RunProps>;
pub type Axis = dml_chart::Axis<ShapeProps, RunProps>;
pub type Legend = dml_chart::Legend<RunProps>;
