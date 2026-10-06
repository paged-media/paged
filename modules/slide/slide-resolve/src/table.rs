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

//! Tables: a `a:tbl` with its table style resolved cell by cell, as
//! PowerPoint draws it, plus the native table style the engine keeps for
//! editing.
//!
//! PowerPoint layers a style's parts in a fixed order, each overriding what
//! is below: the whole table, banded columns, banded rows, the first and
//! last column, the first and last row, then the corner cells; the cell's
//! own properties come last. A line between two cells belongs to whichever
//! of their parts ranks highest. Bands skip the header and total rows and
//! the first and last column.

use pptx_core::{
    Fill, Line, ListStyle, ParagraphProps, RunProps, ShapeProps, TableStyle, TableStylePart,
};

use super::{paint, shape_stroke, text, Ctx, EMPTY_FONTS, EMU_PER_PT};
use crate::color::Rgba;
use crate::model::*;
use crate::table_styles;

/// Where a part applies: its region of the table.
#[derive(Clone, Copy)]
enum Region {
    Table,
    Row,
    Column,
    Cell,
}

struct Layer<'a> {
    rank: u8,
    part: &'a TableStylePart,
    region: Region,
}

#[derive(Clone, Copy, PartialEq)]
enum Side {
    Left,
    Right,
    Top,
    Bottom,
}

struct Grid {
    rows: usize,
    cols: usize,
}

fn layers<'a>(
    style: &'a TableStyle,
    t: &pptx_core::Table,
    g: &Grid,
    r: usize,
    c: usize,
) -> Vec<Layer<'a>> {
    let part = |name: &str| style.parts.get(name);
    let mut out = Vec::new();
    let mut push = |rank, name: &str, region| {
        if let Some(p) = part(name) {
            out.push(Layer {
                rank,
                part: p,
                region,
            });
        }
    };
    push(0, "wholeTbl", Region::Table);
    let first_col = t.first_col && c == 0;
    let last_col = t.last_col && c + 1 == g.cols;
    let first_row = t.first_row && r == 0;
    let last_row = t.last_row && r + 1 == g.rows;
    if t.band_col && !first_col && !last_col {
        let k = c - usize::from(t.first_col);
        push(
            1,
            if k.is_multiple_of(2) {
                "band1V"
            } else {
                "band2V"
            },
            Region::Column,
        );
    }
    if t.band_row && !first_row && !last_row {
        let k = r - usize::from(t.first_row);
        push(
            2,
            if k.is_multiple_of(2) {
                "band1H"
            } else {
                "band2H"
            },
            Region::Row,
        );
    }
    if first_col {
        push(3, "firstCol", Region::Column);
    }
    if last_col {
        push(3, "lastCol", Region::Column);
    }
    if last_row {
        push(4, "lastRow", Region::Row);
    }
    if first_row {
        push(5, "firstRow", Region::Row);
    }
    let corner = match (first_row, last_row, first_col, last_col) {
        (true, _, true, _) => Some("nwCell"),
        (true, _, _, true) => Some("neCell"),
        (_, true, true, _) => Some("swCell"),
        (_, true, _, true) => Some("seCell"),
        _ => None,
    };
    if let Some(name) = corner {
        push(6, name, Region::Cell);
    }
    out
}

/// The line a layer draws on one side of cell (r, c): the part's outer
/// edge where the side lies on its region's boundary, else its inside line.
fn layer_edge<'a>(l: &Layer<'a>, g: &Grid, r: usize, c: usize, side: Side) -> Option<&'a Line> {
    let b = &l.part.borders;
    let on_boundary = match (l.region, side) {
        (Region::Cell, _) => true,
        (Region::Row, Side::Top | Side::Bottom) => true,
        (Region::Column, Side::Left | Side::Right) => true,
        (Region::Table | Region::Row, Side::Left) => c == 0,
        (Region::Table | Region::Row, Side::Right) => c + 1 == g.cols,
        (Region::Table | Region::Column, Side::Top) => r == 0,
        (Region::Table | Region::Column, Side::Bottom) => r + 1 == g.rows,
    };
    match (side, on_boundary) {
        (Side::Left, true) => b.left.as_ref(),
        (Side::Right, true) => b.right.as_ref(),
        (Side::Top, true) => b.top.as_ref(),
        (Side::Bottom, true) => b.bottom.as_ref(),
        (Side::Left | Side::Right, false) => b.inside_v.as_ref(),
        (Side::Top | Side::Bottom, false) => b.inside_h.as_ref(),
    }
}

/// The highest-ranked style line on one side of (r, c), looking at both
/// cells that share the edge.
fn style_edge<'a>(
    style: &'a TableStyle,
    t: &pptx_core::Table,
    g: &Grid,
    r: usize,
    c: usize,
    side: Side,
) -> Option<&'a Line> {
    let mut best: Option<(u8, &Line)> = None;
    let mut consider = |rr: usize, cc: usize, s: Side| {
        for l in layers(style, t, g, rr, cc) {
            if let Some(line) = layer_edge(&l, g, rr, cc, s) {
                if best.is_none_or(|(rank, _)| l.rank >= rank) {
                    best = Some((l.rank, line));
                }
            }
        }
    };
    consider(r, c, side);
    match side {
        Side::Left if c > 0 => consider(r, c - 1, Side::Right),
        Side::Right if c + 1 < g.cols => consider(r, c + 1, Side::Left),
        Side::Top if r > 0 => consider(r - 1, c, Side::Bottom),
        Side::Bottom if r + 1 < g.rows => consider(r + 1, c, Side::Top),
        _ => {}
    }
    best.map(|(_, l)| l)
}

/// The style a table uses: one the deck defines, else a built-in.
/// A table without a style id, or with one PowerPoint does not know, is
/// drawn as "No Style, Table Grid" (measured: fixture tables, where
/// PowerPoint dropped an unknown id on save and drew the grid).
fn style_of(t: &pptx_core::Table, ctx: &Ctx) -> Option<TableStyle> {
    let Some(id) = t.style_id.as_deref() else {
        return table_styles::builtin(table_styles::TABLE_GRID);
    };
    ctx.deck
        .table_styles
        .iter()
        .find(|s| s.id.eq_ignore_ascii_case(id))
        .cloned()
        .or_else(|| table_styles::builtin(id))
        .or_else(|| {
            ctx.note(format!(
                "table style {id} is unknown; drawn as No Style, Table Grid"
            ));
            table_styles::builtin(table_styles::TABLE_GRID)
        })
}

/// A fill flattened onto the backdrop: the engine's cells have no alpha.
fn opaque(p: Paint, under: Rgba) -> Paint {
    match p {
        Paint::Solid { rgb, alpha, theme } if alpha < 0.999 => {
            let mix = |a: u8, b: f64| (a as f64 * alpha + b * 255.0 * (1.0 - alpha)).round() as u8;
            Paint::Solid {
                rgb: [
                    mix(rgb[0], under.r),
                    mix(rgb[1], under.g),
                    mix(rgb[2], under.b),
                ],
                alpha: 1.0,
                theme: if alpha <= 0.001 { None } else { theme },
            }
        }
        p => p,
    }
}

fn part_fill(p: &TableStylePart, ctx: &Ctx) -> Option<Paint> {
    if let Some(f) = &p.fill {
        return Some(paint(f, ctx, None));
    }
    let r = p.fill_ref.as_ref()?;
    let ph = r
        .color
        .as_ref()
        .map(|c| super::resolve_color(c, &ctx.colors(None)));
    let f = ctx
        .theme?
        .fill_styles
        .get((r.idx as usize).checked_sub(1)?)?;
    Some(paint(f, ctx, ph))
}

fn stroke(l: &Line, ctx: &Ctx) -> Option<Stroke> {
    let props = ShapeProps {
        line: Some(l.clone()),
        ..Default::default()
    };
    shape_stroke(&props, None, ctx)
}

pub(super) fn table(t: &pptx_core::Table, ctx: &Ctx) -> Table {
    let style = style_of(t, ctx);
    let g = Grid {
        rows: t.rows.len(),
        cols: t.columns.len(),
    };
    // Without a table background, translucent fills sit on the slide,
    // taken as white.
    let under = Rgba {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
    };
    let colors = ctx.colors(None);
    let (major, minor) = match ctx.theme {
        Some(t) => (&t.major_font, &t.minor_font),
        None => (&EMPTY_FONTS, &EMPTY_FONTS),
    };
    let background = style
        .as_ref()
        .and_then(|s| {
            s.background
                .as_ref()
                .map(|f| paint(f, ctx, None))
                .or_else(|| {
                    let r = s.background_ref.as_ref()?;
                    let ph = r.color.as_ref().map(|c| super::resolve_color(c, &colors));
                    let f = ctx
                        .theme?
                        .fill_styles
                        .get((r.idx as usize).checked_sub(1)?)?;
                    Some(paint(f, ctx, ph))
                })
        })
        .unwrap_or(Paint::None);

    // The table's box, to read its background at a cell.
    let probe = Table {
        columns: t.columns.iter().map(|w| *w as f64 / EMU_PER_PT).collect(),
        rows: t
            .rows
            .iter()
            .map(|x| (x.height as f64 / EMU_PER_PT, Vec::new()))
            .collect(),
        background: background.clone(),
        look: None,
    };
    let mut rows = Vec::with_capacity(g.rows);
    for (r, row) in t.rows.iter().enumerate() {
        let mut cells = Vec::with_capacity(row.cells.len());
        for (c, cell) in row.cells.iter().enumerate() {
            let stack = style
                .as_ref()
                .map(|s| layers(s, t, &g, r, c))
                .unwrap_or_default();
            // Fill: the cell's own, else the highest part that sets one.
            let fill = match &cell.fill {
                Some(f) => paint(f, ctx, None),
                None => stack
                    .iter()
                    .rev()
                    .find_map(|l| part_fill(l.part, ctx))
                    .unwrap_or(Paint::None),
            };
            // The engine's cells have no alpha: a translucent fill is
            // composited over what shows beneath it, the table's background
            // at the cell's centre or the white slide.
            let cx: f64 = t.columns[..c].iter().sum::<i64>() as f64 / EMU_PER_PT
                + t.columns.get(c).copied().unwrap_or(0) as f64 / EMU_PER_PT / 2.0;
            let cy: f64 = t.rows[..r].iter().map(|x| x.height).sum::<i64>() as f64 / EMU_PER_PT
                + row.height as f64 / EMU_PER_PT / 2.0;
            let under = probe
                .backdrop_at(cx, cy)
                .map(|c| Rgba {
                    r: c[0] as f64 / 255.0,
                    g: c[1] as f64 / 255.0,
                    b: c[2] as f64 / 255.0,
                    a: 1.0,
                })
                .unwrap_or(under);
            let fill = opaque(fill, under);
            // Edges: the cell's own (or its neighbour's on the shared
            // edge), else the style's.
            let sides = [Side::Left, Side::Right, Side::Top, Side::Bottom];
            let neighbour = |side: Side| -> Option<&Line> {
                let (rr, cc, k) = match side {
                    Side::Left if c > 0 => (r, c - 1, 1),
                    Side::Right if c + 1 < g.cols => (r, c + 1, 0),
                    Side::Top if r > 0 => (r - 1, c, 3),
                    Side::Bottom if r + 1 < g.rows => (r + 1, c, 2),
                    _ => return None,
                };
                t.rows.get(rr)?.cells.get(cc)?.borders[k].as_ref()
            };
            let borders = [0, 1, 2, 3].map(|k| {
                let line = cell.borders[k]
                    .as_ref()
                    .or_else(|| neighbour(sides[k]))
                    .or_else(|| {
                        style
                            .as_ref()
                            .and_then(|s| style_edge(s, t, &g, r, c, sides[k]))
                    })?;
                stroke(line, ctx)
            });
            // Text: the style's text properties under the runs' own.
            let mut run = RunProps::default();
            for l in &stack {
                let p = l.part;
                if p.bold.is_some() {
                    run.bold = p.bold;
                }
                if p.italic.is_some() {
                    run.italic = p.italic;
                }
                if let Some(col) = &p.color {
                    run.fill = Some(Fill::Solid(col.clone()));
                }
                if let Some(f) = &p.font {
                    run.latin = Some(f.clone());
                } else if let Some(slot) = &p.font_ref {
                    run.latin = Some(if slot == "major" { "+mj-lt" } else { "+mn-lt" }.into());
                }
            }
            let style_list = ListStyle {
                default: Some(ParagraphProps {
                    default_run: Some(run),
                    ..Default::default()
                }),
                levels: Default::default(),
            };
            let mut lists: Vec<&ListStyle> = ctx.deck.default_text_style.iter().collect();
            lists.push(&style_list);
            let tctx = text::TextCtx {
                lists,
                colors: &colors,
                major,
                minor,
                font_ref: None,
                style_prefix: None,
                shrink: None,
            };
            cells.push(Cell {
                span: (cell.row_span.max(1), cell.grid_span.max(1)),
                merged: cell.h_merge || cell.v_merge,
                fill,
                fill_from_style: false,
                borders,
                text: cell.text.as_ref().map(|tb| TextFrame {
                    inset: (
                        cell.margins.0.unwrap_or(91_440) as f64 / EMU_PER_PT,
                        cell.margins.2.unwrap_or(45_720) as f64 / EMU_PER_PT,
                        cell.margins.1.unwrap_or(91_440) as f64 / EMU_PER_PT,
                        cell.margins.3.unwrap_or(45_720) as f64 / EMU_PER_PT,
                    ),
                    rect: (0.0, 0.0, 0.0, 0.0),
                    anchor: match cell.anchor.as_deref() {
                        Some("ctr") => "middle",
                        Some("b") => "bottom",
                        _ => "top",
                    }
                    .to_string(),
                    wrap: true,
                    columns: 1,
                    column_gap: 0.0,
                    grow: false,
                    shrink: None,
                    rotation: 0.0,
                    paragraphs: text::body(tb, &tctx),
                }),
            });
        }
        rows.push((row.height as f64 / EMU_PER_PT, cells));
    }

    let mut out = Table {
        columns: t.columns.iter().map(|w| *w as f64 / EMU_PER_PT).collect(),
        rows,
        background,
        look: None,
    };
    if let Some(s) = &style {
        let look = look(s, t, &g, &out);
        for (r, (_, cells)) in out.rows.iter_mut().enumerate() {
            for (c, cell) in cells.iter_mut().enumerate() {
                cell.fill_from_style = predict(&look, &g, r, c) == cell.fill;
            }
        }
        out.look = Some(look);
    }
    out
}

/// The native table style for a table: its regions' fills read from the
/// resolved cells (header and total rows, first and last column when the
/// style fills them) and its banding as alternating fills.
fn look(style: &TableStyle, t: &pptx_core::Table, g: &Grid, tb: &Table) -> TableLook {
    let fill_at = |r: usize, c: usize| -> Paint {
        tb.rows
            .get(r)
            .and_then(|(_, cells)| cells.get(c))
            .map(|cell| cell.fill.clone())
            .unwrap_or(Paint::None)
    };
    let part_has_fill = |name: &str| {
        style
            .parts
            .get(name)
            .is_some_and(|p| p.fill.is_some() || p.fill_ref.is_some())
    };
    let header_rows = u32::from(t.first_row && g.rows > 0);
    let footer_rows = u32::from(t.last_row && g.rows > 1);
    let body0 = header_rows as usize;
    let body_last = g.rows.saturating_sub(1 + footer_rows as usize);
    let mid = if g.cols > 2 { 1 } else { 0 };
    let mut look = TableLook {
        name: style.name.clone(),
        header_rows,
        footer_rows,
        header: if header_rows > 0 {
            fill_at(0, mid)
        } else {
            Paint::None
        },
        footer: if footer_rows > 0 {
            fill_at(g.rows - 1, mid)
        } else {
            Paint::None
        },
        left: if t.first_col && part_has_fill("firstCol") {
            fill_at(body0, 0)
        } else {
            Paint::None
        },
        right: if t.last_col && part_has_fill("lastCol") {
            fill_at(body0, g.cols.saturating_sub(1))
        } else {
            Paint::None
        },
        body: Paint::None,
        alternate: None,
    };
    if t.band_row && body_last >= body0 {
        look.alternate = Some(Alternate {
            rows: true,
            start: fill_at(body0, mid),
            end: if body_last > body0 {
                fill_at(body0 + 1, mid)
            } else {
                fill_at(body0, mid)
            },
            skip_first: 0,
            skip_last: 0,
        });
    } else if t.band_col && g.cols > 1 {
        let c0 = usize::from(t.first_col);
        look.alternate = Some(Alternate {
            rows: false,
            start: fill_at(body0, c0),
            end: fill_at(body0, (c0 + 1).min(g.cols - 1)),
            skip_first: u32::from(t.first_col),
            skip_last: u32::from(t.last_col),
        });
    } else {
        look.body = fill_at(body0.min(g.rows.saturating_sub(1)), mid);
    }
    look
}

/// The fill the engine paints at (r, c) from `look` alone: a region's own
/// fill over the alternating fill (header and footer rows take no row
/// alternation).
fn predict(look: &TableLook, g: &Grid, r: usize, c: usize) -> Paint {
    let header = (r as u32) < look.header_rows;
    let footer = look.footer_rows > 0 && r + look.footer_rows as usize >= g.rows;
    let region = if header {
        &look.header
    } else if footer {
        &look.footer
    } else if c == 0 && !matches!(look.left, Paint::None) {
        &look.left
    } else if c + 1 == g.cols && !matches!(look.right, Paint::None) {
        &look.right
    } else {
        &look.body
    };
    if !matches!(region, Paint::None) {
        return region.clone();
    }
    match &look.alternate {
        Some(a) if a.rows && !header && !footer => {
            let k = r - look.header_rows as usize;
            if k.is_multiple_of(2) {
                a.start.clone()
            } else {
                a.end.clone()
            }
        }
        Some(a) if !a.rows => {
            let skip_last = a.skip_last as usize;
            if c < a.skip_first as usize || c + skip_last >= g.cols {
                return Paint::None;
            }
            let k = c - a.skip_first as usize;
            if k.is_multiple_of(2) {
                a.start.clone()
            } else {
                a.end.clone()
            }
        }
        _ => Paint::None,
    }
}
