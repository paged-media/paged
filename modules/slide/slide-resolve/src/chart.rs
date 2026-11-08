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

//! Charts: a chart's primitives ([`slide_chart::layout`]'s, or paged.sheet's
//! geometry for a live chart, ADR 715) as native items, grouped under the
//! chart's frame. Every child shares the frame's transform and draws in the
//! frame's own points.

use pptx_core::{Paragraph, ParagraphProps, Run, RunKind, ShapeProps};
use slide_chart::{Align, Prim};
use slide_geom::{PathPoint, SubPath};

use super::{shape_fill, shape_stroke, text, Affine, Ctx, EMPTY_FONTS};
use crate::model::*;

pub(super) fn items(prims: Vec<Prim>, t: Affine, w: f64, h: f64, ctx: &Ctx) -> Vec<Item> {
    let colors = ctx.colors(None);
    let (major, minor) = match ctx.theme {
        Some(th) => (&th.major_font, &th.minor_font),
        None => (&EMPTY_FONTS, &EMPTY_FONTS),
    };
    let tctx = text::TextCtx {
        lists: Vec::new(),
        inherited: 0,
        colors: &colors,
        major,
        minor,
        font_ref: None,
        style_prefix: None,
        shrink: None,
    };
    let mut out = Vec::new();
    for prim in prims {
        let item = |outline: Vec<SubPath>, fill, line, text| {
            let props = ShapeProps {
                fill,
                line,
                ..Default::default()
            };
            let fill = shape_fill(&props, None, ctx);
            let stroke = shape_stroke(&props, None, ctx);
            let opacity = if matches!(fill, Paint::None) {
                stroke
                    .as_ref()
                    .and_then(|s| s.paint.uniform_alpha())
                    .unwrap_or(1.0)
            } else {
                fill.uniform_alpha().unwrap_or(1.0)
            };
            Item {
                id: ctx.id(),
                name: String::new(),
                transform: t,
                w,
                h,
                kind: ItemKind::Shape {
                    outline,
                    fill,
                    stroke,
                    text,
                },
                opacity,
                effects: Effects::default(),
                meta: ItemMeta::default(),
            }
        };
        let contour = slide_chart::outline::contour(&prim);
        match prim {
            Prim::Rect { fill, line, .. }
            | Prim::Path { fill, line, .. }
            | Prim::Wedge { fill, line, .. } => {
                if let Some(c) = contour {
                    out.push(item(vec![sub_path(c)], fill, line, None));
                }
            }
            Prim::Label {
                x,
                cy,
                align,
                text: s,
                props,
            } => {
                let size = props.size.unwrap_or(1197) as f64 / 100.0;
                let (l, r, algn) = match align {
                    Align::Left => (x, x + 1.0, "l"),
                    Align::Center => (x - 0.5, x + 0.5, "ctr"),
                    Align::Right => (x - 1.0, x, "r"),
                };
                let p = Paragraph {
                    props: ParagraphProps {
                        align: Some(algn.into()),
                        ..Default::default()
                    },
                    runs: vec![Run {
                        kind: RunKind::Text(s),
                        props,
                    }],
                    end_props: None,
                };
                let half = 0.6 * size;
                let tf = TextFrame {
                    inset: (0.0, 0.0, 0.0, 0.0),
                    rect: (l, cy - half, r, cy + half),
                    anchor: "middle".into(),
                    wrap: false,
                    columns: 1,
                    column_gap: 0.0,
                    grow: false,
                    shrink: None,
                    rotation: 0.0,
                    paragraphs: vec![text::paragraph(&p, &tctx)],
                };
                out.push(item(Vec::new(), None, None, Some(tf)));
            }
        }
    }
    out
}

/// A contour of [`slide_chart::outline`] as the deck model's sub-path.
fn sub_path(c: slide_chart::outline::Contour) -> SubPath {
    SubPath {
        points: c
            .points
            .into_iter()
            .map(|p| PathPoint {
                anchor: p.anchor,
                left: p.left,
                right: p.right,
            })
            .collect(),
        closed: c.closed,
        filled: c.closed,
        stroked: true,
        fill_mode: None,
        path: 0,
    }
}
