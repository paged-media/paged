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

//! Word's charts (doc ADR 628): a `c:chart r:id` resolved to its chart part
//! and read by the shared DrawingML chart reader (`dml_chart`, as paged.slide
//! and paged.sheet read theirs) into paged.slide's chart model, whose paints
//! are the shared DrawingML paint IR. The cached values are what Word draws
//! from; the embedded workbook is not read.

use paged_ooxml::drawingml;
use paged_ooxml::resolve_target;
use paged_ooxml::tree::{self, El, Ns};
use pptx_core::chart::Chart;
use pptx_core::{RunProps, ShapeProps};

use crate::ImageResolver;

/// A chart's paints and text properties, as authored.
struct ChartProps;

impl dml_chart::Props for ChartProps {
    type Shape = ShapeProps;
    type Text = RunProps;

    fn shape(&self, sp_pr: &El) -> ShapeProps {
        let p = drawingml::shape_properties(sp_pr, &|_: &str| None);
        ShapeProps {
            fill: p.fill,
            line: p.line,
            ..Default::default()
        }
    }

    fn text(&self, r_pr: &El) -> RunProps {
        RunProps {
            size: r_pr.attr_i32("sz"),
            bold: r_pr.attr_bool("b"),
            italic: r_pr.attr_bool("i"),
            fill: drawingml::fill_in(r_pr, &|_: &str| None),
            latin: r_pr
                .child(Ns::A, "latin")
                .and_then(|l| l.attr("typeface"))
                .map(str::to_string),
            ..Default::default()
        }
    }
}

/// The chart part `rid` names among the part's relationships and the chart
/// it holds; `None` for a linked, missing or unreadable part.
pub(crate) fn read(images: &ImageResolver, rid: &str) -> Option<(String, Chart)> {
    let rel = images.rels.by_id(rid)?;
    if rel
        .target_mode
        .as_deref()
        .is_some_and(|m| m.eq_ignore_ascii_case("External"))
    {
        return None;
    }
    let target = resolve_target(&images.base_dir, &rel.target);
    let root = tree::parse(images.package.part(&target)?).ok()?;
    if !root.is(Ns::C, "chartSpace") {
        return None;
    }
    let chart = dml_chart::chart(&root, &ChartProps);
    Some((target, chart))
}
