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

//! Charts: [`slide_chart::layout`]'s primitives as native items, grouped
//! under the chart's frame. Every child shares the frame's transform and
//! draws in the frame's own points.

use pptx_core::chart::Chart;
use pptx_core::{Paragraph, ParagraphProps, Run, RunKind, ShapeProps};
use slide_chart::{Align, Prim};
use slide_geom::{PathPoint, SubPath};

use super::{shape_fill, shape_stroke, text, Affine, Ctx, EMPTY_FONTS};
use crate::model::*;

pub(super) fn items(chart: &Chart, t: Affine, w: f64, h: f64, ctx: &Ctx) -> Vec<Item> {
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
    for prim in slide_chart::layout(chart, w, h) {
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
                shadow: None,
                meta: ItemMeta::default(),
            }
        };
        match prim {
            Prim::Rect {
                x,
                y,
                w: rw,
                h: rh,
                fill,
                line,
            } => {
                if rw <= 0.0 || rh <= 0.0 {
                    continue;
                }
                let pts = [(x, y), (x + rw, y), (x + rw, y + rh), (x, y + rh)];
                out.push(item(vec![polygon(&pts, true)], fill, line, None));
            }
            Prim::Path {
                points,
                smooth,
                closed,
                fill,
                line,
            } => {
                if points.len() < 2 {
                    continue;
                }
                let sp = if smooth {
                    catmull_rom(&points)
                } else {
                    polygon(&points, closed)
                };
                out.push(item(vec![sp], fill, line, None));
            }
            Prim::Wedge {
                cx,
                cy,
                r,
                hole,
                start,
                sweep,
                fill,
                line,
            } => out.push(item(
                vec![wedge(cx, cy, r, hole, start, sweep)],
                fill,
                line,
                None,
            )),
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

fn corner(p: (f64, f64)) -> PathPoint {
    PathPoint {
        anchor: p,
        left: p,
        right: p,
    }
}

fn polygon(points: &[(f64, f64)], closed: bool) -> SubPath {
    SubPath {
        points: points.iter().copied().map(corner).collect(),
        closed,
        filled: closed,
        stroked: true,
        fill_mode: None,
    }
}

/// A Catmull-Rom curve through `points`, as cubic Béziers.
fn catmull_rom(points: &[(f64, f64)]) -> SubPath {
    let n = points.len();
    let at = |i: isize| points[i.clamp(0, n as isize - 1) as usize];
    let pts = (0..n as isize)
        .map(|i| {
            let (p, prev, next) = (at(i), at(i - 1), at(i + 1));
            let d = ((next.0 - prev.0) / 6.0, (next.1 - prev.1) / 6.0);
            PathPoint {
                anchor: p,
                left: (p.0 - d.0, p.1 - d.1),
                right: (p.0 + d.0, p.1 + d.1),
            }
        })
        .collect();
    SubPath {
        points: pts,
        closed: false,
        filled: false,
        stroked: true,
        fill_mode: None,
    }
}

/// A pie slice (or ring segment when `hole` > 0): degrees clockwise from
/// 12 o'clock, arcs as cubic segments of at most 90°.
fn wedge(cx: f64, cy: f64, r: f64, hole: f64, start: f64, sweep: f64) -> SubPath {
    let arc = |radius: f64, a0: f64, a1: f64| -> Vec<PathPoint> {
        let segs = ((a1 - a0).abs() / 90.0).ceil().max(1.0) as usize;
        let step = (a1 - a0) / segs as f64;
        let pt = |a: f64| {
            let a = a.to_radians();
            (cx + radius * a.sin(), cy - radius * a.cos())
        };
        let tan = |a: f64| {
            let a = a.to_radians();
            (a.cos(), a.sin())
        };
        let k = 4.0 / 3.0 * (step.to_radians() / 4.0).tan() * radius;
        let mut out: Vec<PathPoint> = Vec::new();
        for s in 0..=segs {
            let a = a0 + step * s as f64;
            let p = pt(a);
            let d = tan(a);
            out.push(PathPoint {
                anchor: p,
                left: (p.0 - k * d.0, p.1 - k * d.1),
                right: (p.0 + k * d.0, p.1 + k * d.1),
            });
        }
        out
    };
    let full = sweep >= 359.999;
    let mut points = arc(r, start, start + sweep);
    if full && hole <= 0.0 {
        points.pop();
    } else if hole > 0.0 {
        let mut inner = arc(hole, start, start + sweep);
        inner.reverse();
        for p in &mut inner {
            std::mem::swap(&mut p.left, &mut p.right);
        }
        // The straight edges between the arcs keep corner handles.
        if let Some(last) = points.last_mut() {
            last.right = last.anchor;
        }
        if let Some(first) = inner.first_mut() {
            first.left = first.anchor;
        }
        points.extend(inner);
    } else {
        if let Some(last) = points.last_mut() {
            last.right = last.anchor;
        }
        if let Some(first) = points.first_mut() {
            first.left = first.anchor;
        }
        points.push(corner((cx, cy)));
    }
    SubPath {
        points,
        closed: true,
        filled: true,
        stroked: true,
        fill_mode: None,
    }
}
