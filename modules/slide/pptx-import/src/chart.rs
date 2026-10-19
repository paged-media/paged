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
//! values, the axes, title and legend, read by the shared DrawingML chart
//! reader (`dml_chart`, with paged.sheet) with this crate's shape and run
//! properties.

use dml_chart::{PlotKind, Props};
use pptx_core::chart::Chart;
use pptx_core::{RunProps, ShapeProps};

use crate::shapes::shape_props;
use crate::text::run_props;
use crate::xml::El;
use crate::Ctx;

/// A chart's paints and text, read as a slide's are.
struct ChartProps<'c, 'a>(&'c Ctx<'a>);

impl Props for ChartProps<'_, '_> {
    type Shape = ShapeProps;
    type Text = RunProps;

    fn shape(&self, sp_pr: &El) -> ShapeProps {
        shape_props(sp_pr, self.0)
    }

    fn text(&self, r_pr: &El) -> RunProps {
        run_props(r_pr, self.0)
    }

    fn plot(&self, el: &El, kind: &PlotKind) {
        if matches!(kind, PlotKind::Other(_)) || el.local.contains("3D") {
            self.0
                .note(format!("chart type {} drawn flat or not at all", el.local));
        }
    }
}

/// Read a chart part's root element.
pub fn chart(root: &El, ctx: &Ctx) -> Chart {
    dml_chart::chart(root, &ChartProps(ctx))
}
