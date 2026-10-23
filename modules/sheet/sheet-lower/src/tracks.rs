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

//! # Lowering over explicit tracks — the page side of a frame window
//!
//! [`lower_tracks`] lowers the rows and columns a caller names, in the order
//! it names them, into the [`LoweredContent`] IR. The tracks come from
//! `sheet_grid::frame_window` (ADR 510): the frozen tracks first, then the
//! scrolled body, hidden tracks already skipped, gaps allowed. The live grid
//! scene is built on the same window, so the page table and the grid show
//! the same cells with the same sizes and styles:
//!
//! - **Sizes** are the sheet's own: column widths in character units times
//!   [`crate::CHAR_TO_PT`], row heights in pt ([`col_width_pt`] /
//!   [`row_height_pt`], which `sheet-grid` uses too). Nothing is measured.
//! - **Indices** are SHEET indices: `LoweredRow::index`, `LoweredCol::index`,
//!   `LoweredCell::col`, the merges' `row`/`col` and the data bars'
//!   `row`/`col`. A refresh after a scroll aligns tracks by them. The printed
//!   heading row and column carry [`HEADING_INDEX`].
//! - **Styles** go through [`crate::CellStyler`], walking the populated cells
//!   in display order exactly as the grid scene does, so the style keys and
//!   the styles table are the grid's. The printed headings' style is appended
//!   after the walk.
//! - **Merges** intersecting the window become one span per pane (the frozen
//!   band and the body are separate panes, as in the grid). A merge whose
//!   anchor is clipped away is anchored at its first shown cell, and that
//!   cell carries the anchor's text, alignment and style. Cells covered by a
//!   merge (other than its shown corner) lower blank.
//! - **Header rows**: the first `header_rows` tracks of `rows` are the
//!   frozen rows; with printed headings the heading row joins them. The
//!   result's `header_rows` says how many rows repeat on continuation frames.

use crate::condfmt::SheetCondFmt;
use crate::style::{NoStyles, VisualStyleSource};
use crate::{
    databar_rect, lower_cell_display, BorderLines, CellStyler, DataBarRect, LoweredCell,
    LoweredCol, LoweredContent, LoweredRow, LoweredStyle, MergeSpan, Rule, RuleSet, CHAR_TO_PT,
    DEFAULT_COL_CHARS, DEFAULT_ROW_PT,
};
use sheet_core::{Align, SheetId, SheetModel, Worksheet};
use sheet_format::{FormatCache, FormatCtx};
use std::collections::HashMap;

/// The `index` (row or column) of the printed heading track: the heading row
/// above the cells and the heading column left of them. No sheet track has
/// it (the last sheet row is `MAX_ROW`).
pub const HEADING_INDEX: u32 = u32::MAX;

/// Options for [`lower_tracks`].
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub struct TrackOptions {
    /// Add a heading row (A, B, C, …) above the cells and a heading column
    /// (1, 2, 3, …) left of them, as Excel prints them.
    pub print_headings: bool,
    /// Draw gridlines at every track boundary (broken across merges).
    pub print_gridlines: bool,
    /// How many leading entries of `rows` are frozen rows: they become table
    /// header rows and form their own merge pane.
    pub header_rows: u32,
    /// How many leading entries of `cols` are frozen columns (their own
    /// merge pane).
    pub frozen_cols: u32,
}

/// Column width in pt: the sheet's width in character units (or the xlsx
/// default) times [`CHAR_TO_PT`]. The grid scene and the page use this one
/// rule, so a column is equally wide on both surfaces.
pub fn col_width_pt(ws: Option<&Worksheet>, col: u32) -> f64 {
    ws.and_then(|w| w.col_widths.get(&col).copied())
        .unwrap_or(DEFAULT_COL_CHARS)
        * CHAR_TO_PT
}

/// Row height in pt: the sheet's height (already pt) or the default.
pub fn row_height_pt(ws: Option<&Worksheet>, row: u32) -> f64 {
    ws.and_then(|w| w.row_heights.get(&row).copied())
        .unwrap_or(DEFAULT_ROW_PT)
}

/// The width of the printed heading column when the largest row number it
/// shows is `max_row_number` (1-based): room for its digits plus a margin,
/// never narrower than three digits.
pub fn heading_col_width_pt(max_row_number: u32) -> f64 {
    let digits = max_row_number.max(1).to_string().len().max(3);
    6.0 + digits as f64 * CHAR_TO_PT
}

/// The style of the printed heading cells: boxed on every edge, no fill
/// (Excel prints headings as plain boxed labels).
fn heading_style(key: u32) -> LoweredStyle {
    LoweredStyle {
        key,
        border_top: true,
        border_right: true,
        border_bottom: true,
        border_left: true,
        border_lines: BorderLines::default(),
        ..LoweredStyle::default_key0()
    }
}

/// Lower the named tracks without workbook styles (every cell key 0, no
/// conditional formatting). See [`lower_tracks_styled`].
pub fn lower_tracks(
    model: &SheetModel,
    sheet: SheetId,
    rows: &[u32],
    cols: &[u32],
    opts: &TrackOptions,
) -> LoweredContent {
    lower_tracks_styled(
        model,
        sheet,
        rows,
        cols,
        opts,
        &NoStyles,
        &SheetCondFmt::default(),
    )
}

/// One merged area's visible part in one pane, in display indices of the
/// SHEET tracks (`dr0..dr1` × `dc0..dc1`, exclusive ends) — the same
/// fragments `sheet_grid::grid_scene_styled` builds.
#[derive(Clone, Copy)]
struct Fragment {
    merge: usize,
    area: (u32, u32, u32, u32),
    dr0: usize,
    dr1: usize,
    dc0: usize,
    dc1: usize,
}

/// The display indices `lo..hi` (inside the pane `seg`) whose track lies in
/// `[t0, t1]`. The tracks of a pane are increasing.
fn band(tracks: &[u32], seg: (usize, usize), t0: u32, t1: u32) -> (usize, usize) {
    let s = &tracks[seg.0..seg.1];
    let lo = s.partition_point(|&t| t < t0);
    let hi = s.partition_point(|&t| t <= t1);
    (seg.0 + lo, seg.0 + hi.max(lo))
}

fn panes(frozen: usize, total: usize) -> Vec<(usize, usize)> {
    [(0, frozen), (frozen, total)]
        .into_iter()
        .filter(|(a, b)| a < b)
        .collect()
}

/// Lower the tracks `rows` × `cols` of `sheet` (sheet indices, display
/// order) with the workbook's visual styles and conditional formats — the
/// page table of a sheet frame (ADR 510; see the module docs). Within the
/// frozen band and within the body, `rows` and `cols` must be increasing
/// (what `frame_window` returns). Pure; O(tracks shown + merges).
pub fn lower_tracks_styled(
    model: &SheetModel,
    sheet: SheetId,
    rows: &[u32],
    cols: &[u32],
    opts: &TrackOptions,
    visual: &impl VisualStyleSource,
    cf: &SheetCondFmt,
) -> LoweredContent {
    let ws = model.sheet(sheet);
    let n_rows = rows.len();
    let n_cols = cols.len();
    let fr = (opts.header_rows as usize).min(n_rows);
    let fc = (opts.frozen_cols as usize).min(n_cols);
    debug_assert!(rows[..fr].windows(2).all(|w| w[0] < w[1]));
    debug_assert!(rows[fr..].windows(2).all(|w| w[0] < w[1]));
    debug_assert!(cols[..fc].windows(2).all(|w| w[0] < w[1]));
    debug_assert!(cols[fc..].windows(2).all(|w| w[0] < w[1]));

    // The heading track (if printed) leads each axis: display index 0.
    let hd = usize::from(opts.print_headings);
    let heights: Vec<f64> = rows.iter().map(|&r| row_height_pt(ws, r)).collect();
    let widths: Vec<f64> = cols.iter().map(|&c| col_width_pt(ws, c)).collect();
    let heading_w = heading_col_width_pt(rows.iter().map(|r| r + 1).max().unwrap_or(1));
    let heading_h = DEFAULT_ROW_PT;

    // Offsets over the WHOLE table (headings included).
    let mut x_offsets = vec![0.0_f64];
    if hd == 1 {
        x_offsets.push(heading_w);
    }
    for w in &widths {
        x_offsets.push(x_offsets[x_offsets.len() - 1] + w);
    }
    let mut y_offsets = vec![0.0_f64];
    if hd == 1 {
        y_offsets.push(heading_h);
    }
    for h in &heights {
        y_offsets.push(y_offsets[y_offsets.len() - 1] + h);
    }
    let total_width = *x_offsets.last().unwrap_or(&0.0);
    let total_height = *y_offsets.last().unwrap_or(&0.0);

    // ---- Merge fragments, one per pane (as the grid builds them). ----
    let row_panes = panes(fr, n_rows);
    let col_panes = panes(fc, n_cols);
    let mut frags: Vec<Fragment> = Vec::new();
    if let Some(ws) = ws {
        for (mi, m) in ws.merges.iter().enumerate() {
            let n = m.normalized();
            if n.start.sheet != sheet {
                continue;
            }
            let area = (n.start.row, n.start.col, n.end.row, n.end.col);
            for &rp in &row_panes {
                let (dr0, dr1) = band(rows, rp, area.0, area.2);
                if dr0 >= dr1 {
                    continue;
                }
                for &cp in &col_panes {
                    let (dc0, dc1) = band(cols, cp, area.1, area.3);
                    if dc0 >= dc1 {
                        continue;
                    }
                    frags.push(Fragment {
                        merge: mi,
                        area,
                        dr0,
                        dr1,
                        dc0,
                        dc1,
                    });
                }
            }
        }
    }
    // Display cell -> the fragment covering it.
    let mut covered: HashMap<(usize, usize), usize> = HashMap::new();
    for (fi, f) in frags.iter().enumerate() {
        for dr in f.dr0..f.dr1 {
            for dc in f.dc0..f.dc1 {
                covered.insert((dr, dc), fi);
            }
        }
    }

    // ---- Cells, walked in display order (the grid's styler order). ----
    let ctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
    let mut cache = FormatCache::default();
    let mut styler = CellStyler::new(visual, cf, ws);
    let mut databars: Vec<DataBarRect> = Vec::new();
    let mut anchors: HashMap<usize, (String, Align, u32, Option<String>)> = HashMap::new();
    let mut grid: Vec<Vec<LoweredCell>> = Vec::with_capacity(n_rows);
    for (dr, &r) in rows.iter().enumerate() {
        let mut line = Vec::with_capacity(n_cols);
        for (dc, &c) in cols.iter().enumerate() {
            let empty_key = match ws.and_then(|w| w.cell(r, c)) {
                Some(_) => 0,
                None => styler.key_for_empty(r, c),
            };
            let mut out = LoweredCell {
                col: c,
                text: String::new(),
                align: Align::General,
                style_key: empty_key,
                fill: None,
            };
            if let Some(cell) = ws.and_then(|w| w.cell(r, c)) {
                let d = lower_cell_display(model, cell, &mut cache, &ctx);
                let key = styler.key_for_display(r, c, cell, d.color);
                if let Some((frac, rgb)) = styler.databar(r, c, cell) {
                    let (x0, y0) = (x_offsets[dc + hd], y_offsets[dr + hd]);
                    databars.push(databar_rect(
                        r,
                        c,
                        x0,
                        y0,
                        x_offsets[dc + hd + 1] - x0,
                        y_offsets[dr + hd + 1] - y0,
                        frac,
                        rgb,
                    ));
                }
                let fill = d.fill.map(String::from);
                match covered.get(&(dr, dc)).map(|&fi| frags[fi]) {
                    Some(f) => {
                        if (r, c) == (f.area.0, f.area.1) {
                            anchors.insert(f.merge, (d.text, d.align, key, fill));
                        }
                    }
                    None => {
                        out.text = d.text;
                        out.align = d.align;
                        out.style_key = key;
                        out.fill = fill;
                    }
                }
            }
            line.push(out);
        }
        grid.push(line);
    }
    // Anchors outside the window: resolved after the walk (append-only to
    // the styles table), in fragment order — as the grid does.
    if let Some(ws) = ws {
        for f in &frags {
            if anchors.contains_key(&f.merge) {
                continue;
            }
            let entry = match ws.cell(f.area.0, f.area.1) {
                Some(cell) => {
                    let d = lower_cell_display(model, cell, &mut cache, &ctx);
                    let key = styler.key_for_display(f.area.0, f.area.1, cell, d.color);
                    (d.text, d.align, key, d.fill.map(String::from))
                }
                None => (String::new(), Align::General, 0, None),
            };
            anchors.insert(f.merge, entry);
        }
    }
    // Every fragment's shown corner carries its anchor.
    for f in &frags {
        if let Some((text, align, key, fill)) = anchors.get(&f.merge) {
            let cell = &mut grid[f.dr0][f.dc0];
            cell.text = text.clone();
            cell.align = *align;
            cell.style_key = *key;
            cell.fill = fill.clone();
        }
    }
    let mut styles = styler.into_styles();
    let heading_key = styles.len() as u32;
    if hd == 1 {
        styles.push(heading_style(heading_key));
    }
    let heading_cell = |col: u32, text: String| LoweredCell {
        col,
        text,
        align: Align::Center,
        style_key: heading_key,
        fill: None,
    };

    // ---- Assemble rows / cols (headings first). ----
    let mut out_cols = Vec::with_capacity(n_cols + hd);
    if hd == 1 {
        out_cols.push(LoweredCol {
            index: HEADING_INDEX,
            width_pt: heading_w,
        });
    }
    out_cols.extend(cols.iter().zip(&widths).map(|(&c, &w)| LoweredCol {
        index: c,
        width_pt: w,
    }));
    let mut out_rows = Vec::with_capacity(n_rows + hd);
    if hd == 1 {
        let mut cells = vec![heading_cell(HEADING_INDEX, String::new())];
        cells.extend(
            cols.iter()
                .map(|&c| heading_cell(c, sheet_core::col_to_a1(c).to_string())),
        );
        out_rows.push(LoweredRow {
            index: HEADING_INDEX,
            height_pt: heading_h,
            cells,
        });
    }
    for ((&r, &h), line) in rows.iter().zip(&heights).zip(grid) {
        let mut cells = Vec::with_capacity(n_cols + hd);
        if hd == 1 {
            cells.push(heading_cell(HEADING_INDEX, (r + 1).to_string()));
        }
        cells.extend(line);
        out_rows.push(LoweredRow {
            index: r,
            height_pt: h,
            cells,
        });
    }

    // ---- Merges in sheet indices: a span counts the shown tracks between
    // its first and last shown track (what the host table counts). ----
    let merges = frags
        .iter()
        .map(|f| MergeSpan {
            row: rows[f.dr0],
            col: cols[f.dc0],
            row_span: rows[f.dr1 - 1] - rows[f.dr0] + 1,
            col_span: cols[f.dc1 - 1] - cols[f.dc0] + 1,
        })
        .collect();

    // ---- Gridlines over the whole table, broken across merges. ----
    let rules = if opts.print_gridlines {
        let mut h = Vec::with_capacity(y_offsets.len());
        for (i, &at) in y_offsets.iter().enumerate() {
            let gaps = frags
                .iter()
                .filter(|f| f.dr0 + hd < i && i < f.dr1 + hd)
                .map(|f| (x_offsets[f.dc0 + hd], x_offsets[f.dc1 + hd]));
            push_broken_rule(&mut h, at, total_width, gaps);
        }
        let mut v = Vec::with_capacity(x_offsets.len());
        for (i, &at) in x_offsets.iter().enumerate() {
            let gaps = frags
                .iter()
                .filter(|f| f.dc0 + hd < i && i < f.dc1 + hd)
                .map(|f| (y_offsets[f.dr0 + hd], y_offsets[f.dr1 + hd]));
            push_broken_rule(&mut v, at, total_height, gaps);
        }
        RuleSet { h, v }
    } else {
        RuleSet::default()
    };

    LoweredContent {
        cols: out_cols,
        rows: out_rows,
        rules,
        merges,
        styles,
        databars,
        header_rows: fr as u32 + hd as u32,
    }
}

/// Push the rule at `at` running `0..len`, minus the `gaps`, as one [`Rule`]
/// per remaining segment (the grid scene's rule).
fn push_broken_rule(
    out: &mut Vec<Rule>,
    at: f64,
    len: f64,
    gaps: impl Iterator<Item = (f64, f64)>,
) {
    let mut gaps: Vec<(f64, f64)> = gaps.collect();
    gaps.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut from = 0.0_f64;
    for (g0, g1) in gaps {
        if g0 > from {
            out.push(Rule { at, from, to: g0 });
        }
        from = from.max(g1);
    }
    if from < len {
        out.push(Rule { at, from, to: len });
    }
}

#[cfg(test)]
mod tests {
    #![allow(non_snake_case)]
    use super::*;
    use sheet_core::{Cell, CellRef, CellValue, RangeRef};

    fn model() -> SheetModel {
        let mut m = SheetModel::new();
        let s = m.add_sheet("S");
        let ws = m.sheet_mut(s).unwrap();
        for r in 0..30u32 {
            for c in 0..10u32 {
                ws.set_cell(
                    r,
                    c,
                    Cell {
                        value: CellValue::Number(f64::from(r * 100 + c)),
                        ..Default::default()
                    },
                );
            }
        }
        m
    }

    fn at(row: u32, col: u32) -> CellRef {
        CellRef {
            sheet: 0,
            row,
            col,
            row_abs: false,
            col_abs: false,
        }
    }

    fn merge(r0: u32, c0: u32, r1: u32, c1: u32) -> RangeRef {
        RangeRef {
            start: at(r0, c0),
            end: at(r1, c1),
        }
    }

    fn texts(lc: &LoweredContent) -> Vec<Vec<String>> {
        lc.rows
            .iter()
            .map(|r| r.cells.iter().map(|c| c.text.clone()).collect())
            .collect()
    }

    #[test]
    fn non_contiguous_tracks_keep_sheet_indices__feat__sheet_lower_page() {
        let m = model();
        let lc = lower_tracks(&m, 0, &[0, 10, 11], &[0, 5], &TrackOptions::default());
        let idx: Vec<u32> = lc.rows.iter().map(|r| r.index).collect();
        assert_eq!(idx, vec![0, 10, 11]);
        let cidx: Vec<u32> = lc.cols.iter().map(|c| c.index).collect();
        assert_eq!(cidx, vec![0, 5]);
        assert_eq!(lc.rows[1].cells[1].col, 5);
        assert_eq!(texts(&lc)[1], vec!["1000", "1005"]);
        assert!(lc.rules.h.is_empty() && lc.rules.v.is_empty());
        assert_eq!(lc.header_rows, 0);
        // Widths are the sheet's own pt sizes, never measured.
        assert!((lc.cols[0].width_pt - DEFAULT_COL_CHARS * CHAR_TO_PT).abs() < 1e-9);
    }

    #[test]
    fn print_headings_add_a_heading_row_and_column__feat__sheet_lower_page() {
        let m = model();
        let opts = TrackOptions {
            print_headings: true,
            print_gridlines: true,
            header_rows: 1,
            frozen_cols: 0,
        };
        let lc = lower_tracks(&m, 0, &[0, 7, 8], &[1, 27], &opts);
        assert_eq!(lc.header_rows, 2, "frozen row + heading row repeat");
        assert_eq!(lc.rows[0].index, HEADING_INDEX);
        assert_eq!(lc.cols[0].index, HEADING_INDEX);
        let t = texts(&lc);
        assert_eq!(t[0], vec!["", "B", "AB"]);
        assert_eq!(t[2][0], "8");
        let hk = lc.rows[0].cells[1].style_key;
        assert!(lc.styles[hk as usize].border_left);
        assert_eq!(lc.rows[0].cells[1].align, Align::Center);
        // Gridlines at every boundary, headings included.
        assert_eq!(lc.rules.h.len(), 5);
        assert_eq!(lc.rules.v.len(), 4);
    }

    #[test]
    fn clipped_merge_carries_the_anchor_onto_the_shown_corner__feat__sheet_lower_page() {
        let mut m = model();
        let ws = m.sheet_mut(0).unwrap();
        ws.merges.push(merge(2, 1, 6, 3));
        // The window starts inside the merge (rows 4.., cols 2..).
        let lc = lower_tracks(&m, 0, &[4, 5, 6, 7], &[2, 3, 4], &TrackOptions::default());
        assert_eq!(
            lc.merges,
            vec![MergeSpan {
                row: 4,
                col: 2,
                row_span: 3,
                col_span: 2
            }]
        );
        let t = texts(&lc);
        assert_eq!(t[0][0], "201", "the anchor B3's text on the clipped corner");
        assert_eq!(t[0][1], "", "covered cells lower blank");
        assert_eq!(t[3][0], "702");
    }

    #[test]
    fn a_merge_across_the_frozen_split_splits_per_pane__feat__sheet_lower_page() {
        let mut m = model();
        let ws = m.sheet_mut(0).unwrap();
        ws.merges.push(merge(0, 0, 12, 0));
        let opts = TrackOptions {
            header_rows: 1,
            ..Default::default()
        };
        let lc = lower_tracks(&m, 0, &[0, 10, 11, 12, 13], &[0, 1], &opts);
        assert_eq!(lc.merges.len(), 2);
        assert_eq!((lc.merges[0].row, lc.merges[0].row_span), (0, 1));
        assert_eq!((lc.merges[1].row, lc.merges[1].row_span), (10, 3));
        let t = texts(&lc);
        assert_eq!(t[0][0], "0");
        assert_eq!(t[1][0], "0", "the body part shows the anchor too");
        assert_eq!(lc.header_rows, 1);
    }
}
