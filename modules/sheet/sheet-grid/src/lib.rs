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

//! # sheet-grid — the sheets-mode vector grid scene (spec §8.1, T1)
//!
//! Pure `&SheetModel -> GridScene`: a windowed, virtualized view of one
//! worksheet for the SDK rendering surface (S-02). Where `sheet-lower`
//! compiles a FIXED range into page content, `sheet-grid` produces a
//! SCROLLABLE viewport — only the cells visible from a `(first_row,
//! first_col)` scroll origin, bounded by `(max_width_pt, max_height_pt)`,
//! are materialized. This is what makes a 1M-row sheet cheap: windowing
//! touches O(visible cells), never O(sheet).
//!
//! ## What Phase A lands (this file)
//!
//! - the FROZEN [`GridScene`] / [`GridViewport`] / [`GridCell`] /
//!   [`GridSelection`] / [`GridOptions`] IR (serde camelCase);
//! - [`grid_scene`] — the **viewport windowing**: cumulative pt offsets from
//!   `col_widths`/`row_heights`, cell materialization ONLY for visible
//!   populated cells, formatted text via `sheet-format` (the same number-
//!   format render the page lowering uses, so a cell reads identically on
//!   both surfaces).
//!
//! Selection is always `None` in Phase A — the grid panel supplies it
//! later (the editing/selection contract is a later track).
//!
//! ## IR reuse (documented spec §4 deviation)
//!
//! The scene's `styles`/`gridlines` reuse `sheet_lower::LoweredStyle` and
//! `sheet_lower::RuleSet` so the grid and the page lowering share ONE
//! style/rule wire shape (see the crate's Cargo.toml note). `sheet-lower`
//! is pure IR, so this does not cross the §4 SDK-isolation rule.

use sheet_core::{Align, Cell, CellValue, SheetId, SheetModel};
use sheet_format::{FormatCache, FormatCtx};
use sheet_lower::condfmt::{self, SheetCondFmt};
use sheet_lower::{LoweredStyle, RuleSet};

// Re-use the page-lowering geometry rulings so a column is the same width on
// both surfaces (spec §8.2 — character-unit columns, point rows).
use sheet_lower::{CHAR_TO_PT, DATABAR_INSET_PT, DEFAULT_COL_CHARS, DEFAULT_ROW_PT};

// ---- The grid scene IR (FROZEN wire shape; serde camelCase). ----

/// The complete vector scene for one grid viewport (spec §8.1). Pure data
/// the SDK rendering surface draws: the windowed viewport geometry, the
/// visible populated cells, the style table, the gridlines, and the
/// (optional) selection rectangle.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridScene {
    pub viewport: GridViewport,
    pub cells: Vec<GridCell>,
    pub styles: Vec<LoweredStyle>,
    pub gridlines: RuleSet,
    pub selection: Option<GridSelection>,
    /// The frozen row/column split rendered in this viewport (spec §8.1). The
    /// renderer holds the first `rows`/`cols` of the sheet fixed while the rest
    /// scrolls under them — the classic frozen-header view. `None` (the common
    /// case) when no pane is frozen. When the scroll origin is past the frozen
    /// band, the split still names how many leading sheet rows/cols are pinned
    /// (the renderer composites the frozen band over the scrolled body). */
    pub freeze: Option<GridFreeze>,
    /// Cell-comment indicators for the VISIBLE cells that carry a comment
    /// (preserve-first; spec §10.2). The renderer draws a small corner marker
    /// (the classic Excel comment triangle); the comment text rides in the
    /// panel / hover, not the scene. Empty unless the caller supplies the
    /// sheet's commented cells. Read-only display affordance — comments are
    /// never enforced, only shown.
    pub comments: Vec<GridCommentMarker>,
    /// Conditional-formatting DATA BARS for the VISIBLE numeric cells covered by
    /// a `dataBar` cf rule (spec §8.2/§10.4 — the same drawn-rect geometry the
    /// page lowering emits, so a data bar reads identically on both surfaces).
    /// Each is one proportional rect in viewport-local pt, sized to the cell's
    /// value over the bar's domain. Empty unless the caller supplies the sheet's
    /// conditional-format model (`grid_scene_with_cf`); a non-numeric cell, an
    /// uncovered cell, or a degenerate domain yields no bar.
    pub databars: Vec<GridDataBar>,
}

/// One conditional-formatting DATA BAR drawn in a grid viewport (spec §8.2 — the
/// vector page-draw lane, mirrored on the grid surface). Its absolute
/// `(row, col)` plus the viewport-local rect (`x`, `y`, `w`, `h`, pt): the bar
/// fills `fill_fraction ∈ [0, 1]` of the cell width, inset from the cell edges by
/// [`sheet_lower::DATABAR_INSET_PT`] (the same inset the page lowering uses), so
/// the bar reads inside the cell without touching the gridlines. `fill` is the
/// bar colour as `#RRGGBB`. The renderer draws a filled rect; a data bar is
/// GEOMETRY, never a cell style fill, so a cell can show both its style and a bar.
#[derive(serde::Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GridDataBar {
    pub row: u32,
    pub col: u32,
    /// The rect's viewport-local top-left + size (pt).
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// The bar's value share of the cell width, `[0, 1]` (`w` already encodes it;
    /// carried so a renderer can label/animate the bar).
    pub fill_fraction: f64,
    /// The bar fill colour, `#RRGGBB`.
    pub fill: String,
}

/// One cell-comment indicator on a grid cell (preserve-first display). Its
/// absolute `(row, col)` plus the viewport-local content-space top-right corner
/// of the cell (`x`, `y`) where the renderer draws the marker triangle.
#[derive(serde::Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct GridCommentMarker {
    pub row: u32,
    pub col: u32,
    /// The cell's top-right corner, viewport-local pt (the marker anchor).
    pub x: f64,
    pub y: f64,
}

/// The frozen-pane split shown in a grid viewport (spec §8.1). `rows`/`cols`
/// are the number of leading SHEET rows/columns held fixed; `frozen_width_pt`
/// / `frozen_height_pt` are the pt extents of those frozen bands (the split
/// line sits there), so a renderer can draw the pinned band + the split rule
/// without re-summing widths. The mirror of `sheet_xlsx::FreezePanes` enriched
/// with the band geometry the grid already computed.
#[derive(serde::Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct GridFreeze {
    /// Leading sheet rows held fixed at the top.
    pub rows: u32,
    /// Leading sheet columns held fixed at the left.
    pub cols: u32,
    /// pt width of the frozen column band (sum of the frozen columns' widths).
    pub frozen_width_pt: f64,
    /// pt height of the frozen row band (sum of the frozen rows' heights).
    pub frozen_height_pt: f64,
}

/// The windowed viewport: the first visible `(row, col)`, how many of each
/// fit, and the cumulative pt offsets along each axis. `x_offsets` /
/// `y_offsets` carry `cols + 1` / `rows + 1` entries — the leading edge of
/// every visible track PLUS a trailing edge (so a renderer has every
/// boundary). Offsets are viewport-local (the first visible track starts at
/// 0).
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridViewport {
    pub first_row: u32,
    pub first_col: u32,
    pub rows: u32,
    pub cols: u32,
    /// Cumulative pt boundaries along x (len == `cols + 1`, incl. trailing).
    pub x_offsets: Vec<f64>,
    /// Cumulative pt boundaries along y (len == `rows + 1`, incl. trailing).
    pub y_offsets: Vec<f64>,
}

/// One materialized visible cell: its absolute `(row, col)`, the FORMATTED
/// text (the number-format render IS the text, spec §8.3), the resolved
/// alignment, and its style key. Only POPULATED cells inside the viewport
/// are emitted (empty cells are absent — the renderer draws blanks from the
/// viewport geometry).
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridCell {
    pub row: u32,
    pub col: u32,
    pub text: String,
    /// Lowercase serde like the page lowering (`"general"`/`"left"`/… ).
    #[serde(serialize_with = "serialize_align")]
    pub align: Align,
    pub style_key: u32,
}

/// A selection rectangle, anchored at `(anchor_row, anchor_col)` and
/// spanning `rows`×`cols`. `None` on the scene in Phase A (the panel
/// supplies selection later).
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridSelection {
    pub anchor_row: u32,
    pub anchor_col: u32,
    pub rows: u32,
    pub cols: u32,
}

/// Per-scene options. `include_gridlines` toggles the [`RuleSet`] at every
/// visible track boundary (like the page lowering's grid rules); `freeze_rows`
/// / `freeze_cols` are the frozen-pane split (spec §8.1) to render — the number
/// of leading SHEET rows/columns held fixed (0 = none). The grid resolves these
/// to the [`GridFreeze`] band geometry on the scene.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct GridOptions {
    pub include_gridlines: bool,
    /// Leading frozen rows (spec §8.1); 0 = no frozen row band.
    pub freeze_rows: u32,
    /// Leading frozen columns (spec §8.1); 0 = no frozen column band.
    pub freeze_cols: u32,
}

impl Default for GridOptions {
    fn default() -> Self {
        GridOptions {
            include_gridlines: true,
            freeze_rows: 0,
            freeze_cols: 0,
        }
    }
}

// ---- The frame window: which tracks a sheet frame shows (ADR 510). ----

/// What a sheet frame asks for: the top-left cell it was left at, the box
/// the cells must fit (pt), and the frozen split. The SAME spec is asked by
/// the live grid (with the heading strips taken off the box) and by the page
/// lowering (the whole content box), so the two surfaces can never disagree
/// about which rows and columns are shown or how wide they are.
#[derive(serde::Deserialize, Copy, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameWindowSpec {
    /// The first scrolled (non-frozen) row and column shown.
    pub top_row: u32,
    pub left_col: u32,
    /// The box the cells must fit, pt.
    pub width_pt: f64,
    pub height_pt: f64,
    /// Leading sheet rows / columns held fixed above / left of the body.
    #[serde(default)]
    pub freeze_rows: u32,
    #[serde(default)]
    pub freeze_cols: u32,
}

/// The tracks a frame shows, in display order: the frozen tracks first, then
/// the scrolled body from the top-left cell. Hidden and filtered rows are
/// skipped. Only WHOLE tracks are listed (a native page table cannot clip a
/// column); the first track that does not fit whole is reported separately
/// as `partial_*`, so the live grid can draw it greyed past the print edge.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrameWindow {
    /// Sheet row indices shown, top to bottom (frozen rows first).
    pub rows: Vec<u32>,
    /// Sheet column indices shown, left to right (frozen columns first).
    pub cols: Vec<u32>,
    /// pt height of each entry in `rows`.
    pub row_heights_pt: Vec<f64>,
    /// pt width of each entry in `cols`.
    pub col_widths_pt: Vec<f64>,
    /// How many leading entries of `rows` / `cols` are frozen tracks.
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    /// Sum of `col_widths_pt` / `row_heights_pt`: the area the whole tracks
    /// cover (the print edge).
    pub width_pt: f64,
    pub height_pt: f64,
    /// The next track after the last whole one, if any of it is visible.
    pub partial_row: Option<u32>,
    pub partial_col: Option<u32>,
}

/// Compute the tracks a frame shows for `spec` (ADR 510). Pure and O(visible
/// tracks + skipped hidden rows). At least one body row and column are always
/// shown, even when the first one is wider or taller than the box, so a
/// frame never renders empty.
pub fn frame_window(model: &SheetModel, sheet: SheetId, spec: &FrameWindowSpec) -> FrameWindow {
    let ws = model.sheet(sheet);
    let hidden = |r: u32| ws.is_some_and(|w| w.row_hidden(r));

    // Rows: the frozen band (visible ones only), then the body from top_row.
    let mut rows = Vec::new();
    let mut row_heights_pt = Vec::new();
    let mut y = 0.0_f64;
    let freeze_rows = spec.freeze_rows.min(sheet_core::MAX_ROW + 1);
    for r in 0..freeze_rows {
        if hidden(r) {
            continue;
        }
        let h = row_height_pt(ws, r);
        rows.push(r);
        row_heights_pt.push(h);
        y += h;
    }
    let frozen_rows = rows.len() as u32;
    let mut partial_row = None;
    let mut body_rows = 0u32;
    let mut r = spec.top_row.max(freeze_rows);
    while r <= sheet_core::MAX_ROW {
        if !hidden(r) {
            let h = row_height_pt(ws, r);
            if body_rows > 0 && y + h > spec.height_pt {
                if y < spec.height_pt {
                    partial_row = Some(r);
                }
                break;
            }
            rows.push(r);
            row_heights_pt.push(h);
            y += h;
            body_rows += 1;
        }
        if r == sheet_core::MAX_ROW {
            break;
        }
        r += 1;
    }

    // Columns: the frozen band, then the body from left_col.
    let mut cols = Vec::new();
    let mut col_widths_pt = Vec::new();
    let mut x = 0.0_f64;
    let freeze_cols = spec.freeze_cols.min(sheet_core::MAX_COL + 1);
    let col_hidden = |c: u32| ws.is_some_and(|w| w.col_hidden(c));
    for c in 0..freeze_cols {
        if col_hidden(c) {
            continue;
        }
        let w = col_width_pt(ws, c);
        cols.push(c);
        col_widths_pt.push(w);
        x += w;
    }
    let frozen_cols = cols.len() as u32;
    let mut partial_col = None;
    let mut body_cols = 0u32;
    let mut c = spec.left_col.max(freeze_cols);
    while c <= sheet_core::MAX_COL {
        if !col_hidden(c) {
            let w = col_width_pt(ws, c);
            if body_cols > 0 && x + w > spec.width_pt {
                if x < spec.width_pt {
                    partial_col = Some(c);
                }
                break;
            }
            cols.push(c);
            col_widths_pt.push(w);
            x += w;
            body_cols += 1;
        }
        if c == sheet_core::MAX_COL {
            break;
        }
        c += 1;
    }

    FrameWindow {
        rows,
        cols,
        row_heights_pt,
        col_widths_pt,
        frozen_rows,
        frozen_cols,
        width_pt: x,
        height_pt: y,
        partial_row,
        partial_col,
    }
}

/// serde hook: render `Align` as the agreed lowercase variant name (the
/// same wire token the page lowering uses).
fn serialize_align<S>(align: &Align, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    s.serialize_str(align_str(*align))
}

fn align_str(align: Align) -> &'static str {
    match align {
        Align::General => "general",
        Align::Left => "left",
        Align::Center => "center",
        Align::Right => "right",
    }
}

/// Generate the [`GridScene`] for a worksheet viewport (spec §8.1).
///
/// Windowing: starting from the `(first_row, first_col)` scroll origin,
/// columns are accumulated (their pt widths from `col_widths`, the xlsx
/// default otherwise) until the next column would exceed `max_width_pt`;
/// rows likewise against `max_height_pt`. At least one row/col is always
/// included so the viewport is never degenerate. Only POPULATED cells
/// inside the resulting window are materialized — so the scene cost is
/// O(visible populated cells), not O(sheet). An unknown `sheet` yields an
/// empty-but-shaped scene (geometry from the bounds, no cells).
pub fn grid_scene(
    model: &SheetModel,
    sheet: SheetId,
    first_row: u32,
    first_col: u32,
    max_width_pt: f64,
    max_height_pt: f64,
    opts: &GridOptions,
) -> GridScene {
    grid_scene_with_comments(
        model,
        sheet,
        first_row,
        first_col,
        max_width_pt,
        max_height_pt,
        opts,
        &[],
    )
}

/// As [`grid_scene`], plus the sheet's commented cells (`comment_cells`,
/// absolute `(row, col)`): the scene emits a [`GridCommentMarker`] for each
/// commented cell visible in the windowed viewport (preserve-first display;
/// spec §10.2). The comment TEXT lives in the panel/hover, not the scene — this
/// is only the indicator geometry. An empty `comment_cells` reproduces
/// [`grid_scene`] exactly.
#[allow(clippy::too_many_arguments)]
pub fn grid_scene_with_comments(
    model: &SheetModel,
    sheet: SheetId,
    first_row: u32,
    first_col: u32,
    max_width_pt: f64,
    max_height_pt: f64,
    opts: &GridOptions,
    comment_cells: &[(u32, u32)],
) -> GridScene {
    grid_scene_with_cf(
        model,
        sheet,
        first_row,
        first_col,
        max_width_pt,
        max_height_pt,
        opts,
        comment_cells,
        &SheetCondFmt::default(),
    )
}

/// As [`grid_scene_with_comments`], plus the sheet's conditional-format model
/// (`cf`): every numeric cell visible in the window that a `dataBar` cf rule
/// covers yields a [`GridDataBar`] — a proportional drawn rect in viewport-local
/// pt, sized by the SAME `(value - lo) / (hi - lo)` clamp and inset geometry the
/// page lowering uses ([`sheet_lower::lower_range_condfmt`]), so a data bar reads
/// identically on the grid and the page (spec §8.2/§10.4 cross-surface parity).
/// An empty `cf` reproduces [`grid_scene_with_comments`] exactly (no data bars).
///
/// Data bars are GEOMETRY, not a style fill, so this never touches the cell
/// styles table — a cell can show its style AND a bar (Excel layers them). Only
/// the data-bar facet of cf is rendered in-grid in this track; cellIs / colour-
/// scale style overrides remain a page-lowering lane (the grid keeps key-0 styles
/// in Phase A, matching how it does not yet render cf style overrides).
#[allow(clippy::too_many_arguments)]
pub fn grid_scene_with_cf(
    model: &SheetModel,
    sheet: SheetId,
    first_row: u32,
    first_col: u32,
    max_width_pt: f64,
    max_height_pt: f64,
    opts: &GridOptions,
    comment_cells: &[(u32, u32)],
    cf: &SheetCondFmt,
) -> GridScene {
    let ws = model.sheet(sheet);

    // ---- Window the columns: accumulate widths until max_width_pt. ----
    let mut x_offsets: Vec<f64> = vec![0.0];
    let mut last_col = first_col;
    let mut cols = 0u32;
    let mut x = 0.0_f64;
    loop {
        let width = col_width_pt(ws, last_col);
        // Always include the first column; otherwise stop before overflow.
        if cols > 0 && x + width > max_width_pt {
            break;
        }
        x += width;
        x_offsets.push(x);
        cols += 1;
        // Guard the grid's right edge (XFD) so we never run past the model.
        if last_col == sheet_core::MAX_COL {
            break;
        }
        last_col += 1;
    }

    // ---- Window the rows: accumulate heights until max_height_pt. ----
    let mut y_offsets: Vec<f64> = vec![0.0];
    let mut last_row = first_row;
    let mut rows = 0u32;
    let mut y = 0.0_f64;
    loop {
        let height = row_height_pt(ws, last_row);
        if rows > 0 && y + height > max_height_pt {
            break;
        }
        y += height;
        y_offsets.push(y);
        rows += 1;
        if last_row == sheet_core::MAX_ROW {
            break;
        }
        last_row += 1;
    }

    let total_width = x;
    let total_height = y;
    // The last absolute row/col that is IN the window (inclusive).
    let row_end = first_row + rows - 1;
    let col_end = first_col + cols - 1;

    // ---- Materialize ONLY visible populated cells (virtualization). ----
    let ctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
    let mut cache = FormatCache::default();
    let mut cells: Vec<GridCell> = Vec::new();
    if let Some(ws) = ws {
        // Iterate the sparse cell map's window via a range query so we touch
        // O(populated cells in window), never the full row span. The map is
        // keyed (row, col) row-major, so a range over the row band yields
        // the window's rows in order; we filter columns per row.
        for (&(r, c), cell) in ws.cells.range((first_row, first_col)..=(row_end, col_end)) {
            if c < first_col || c > col_end {
                continue; // outside the column band for this row
            }
            let (text, align) = lower_cell_text(model, cell, &mut cache, &ctx);
            // An empty/blank cell carries no text — skip it (the renderer
            // draws the blank from the viewport geometry).
            if text.is_empty() && matches!(cell.value, CellValue::Empty) {
                continue;
            }
            cells.push(GridCell {
                row: r,
                col: c,
                text,
                align,
                // T0/Phase A: default style key (the style-map track wires
                // real keys later, like the page lowering).
                style_key: 0,
            });
        }
    }

    // ---- Gridlines at every visible track boundary (viewport-local). ----
    let gridlines = if opts.include_gridlines {
        let h = y_offsets
            .iter()
            .map(|&at| sheet_lower::Rule {
                at,
                from: 0.0,
                to: total_width,
            })
            .collect();
        let v = x_offsets
            .iter()
            .map(|&at| sheet_lower::Rule {
                at,
                from: 0.0,
                to: total_height,
            })
            .collect();
        RuleSet { h, v }
    } else {
        RuleSet::default()
    };

    // ---- Cell-comment indicators (preserve-first; spec §10.2). For each
    // commented cell VISIBLE in the window, emit a marker at the cell's top-
    // right corner (viewport-local pt). The comment text rides in the panel. ----
    let mut comment_markers: Vec<GridCommentMarker> = Vec::new();
    if !comment_cells.is_empty() {
        for &(r, c) in comment_cells {
            if r < first_row || r > row_end || c < first_col || c > col_end {
                continue; // outside the window
            }
            let ci = (c - first_col) as usize;
            let ri = (r - first_row) as usize;
            // The cell's top-right corner: x = right edge of the column band,
            // y = top edge of the row band.
            comment_markers.push(GridCommentMarker {
                row: r,
                col: c,
                x: x_offsets[ci + 1],
                y: y_offsets[ri],
            });
        }
    }

    // ---- Conditional-formatting DATA BARS (spec §8.2/§10.4 — the drawn-rect
    // geometry lane, mirrored from the page lowering). For each VISIBLE numeric
    // cell a `dataBar` rule covers, emit one proportional rect in viewport-local
    // pt. The proportion + inset math is `sheet_lower::condfmt::databar_for` +
    // the page lowering's inset rule, so a bar is identical on both surfaces.
    // cf ranges + the value domain are in MODEL (absolute) coordinates. ----
    let mut databars: Vec<GridDataBar> = Vec::new();
    if !cf.is_empty() {
        if let Some(ws) = ws {
            // The covering range's numeric (min, max), memoized — the same lazy
            // domain `lower_range_condfmt` uses (`cf_domain`), so the derived
            // endpoints match the page surface exactly.
            let mut domain_cache: std::collections::HashMap<condfmt::CfRange, Option<(f64, f64)>> =
                std::collections::HashMap::new();
            for (&(r, c), cell) in ws.cells.range((first_row, first_col)..=(row_end, col_end)) {
                if c < first_col || c > col_end {
                    continue; // outside the column band for this row
                }
                if let Some((frac, rgb)) = condfmt::databar_for(cf, r, c, &cell.value, &mut |rng| {
                    grid_cf_domain(Some(ws), rng, &mut domain_cache)
                }) {
                    let ci = (c - first_col) as usize;
                    let ri = (r - first_row) as usize;
                    let cell_x = x_offsets[ci];
                    let cell_w = x_offsets[ci + 1] - cell_x;
                    let cell_y = y_offsets[ri];
                    let cell_h = y_offsets[ri + 1] - cell_y;
                    // The SAME inset rule as the page lowering's `databar_rect`.
                    let inset = DATABAR_INSET_PT.min(cell_w / 4.0).min(cell_h / 4.0);
                    let avail_w = (cell_w - 2.0 * inset).max(0.0);
                    databars.push(GridDataBar {
                        row: r,
                        col: c,
                        x: cell_x + inset,
                        y: cell_y + inset,
                        w: avail_w * frac.clamp(0.0, 1.0),
                        h: (cell_h - 2.0 * inset).max(0.0),
                        fill_fraction: frac,
                        fill: format!("#{:02X}{:02X}{:02X}", rgb.0, rgb.1, rgb.2),
                    });
                }
            }
        }
    }

    // ---- Frozen-pane split (spec §8.1). Sum the frozen leading rows'/cols'
    // pt extents from the sheet origin (independent of the scroll origin — the
    // band is always the FIRST `freeze_rows`/`freeze_cols` of the sheet). ----
    let freeze = if opts.freeze_rows == 0 && opts.freeze_cols == 0 {
        None
    } else {
        let frozen_width_pt = (0..opts.freeze_cols).map(|c| col_width_pt(ws, c)).sum();
        let frozen_height_pt = (0..opts.freeze_rows).map(|r| row_height_pt(ws, r)).sum();
        Some(GridFreeze {
            rows: opts.freeze_rows,
            cols: opts.freeze_cols,
            frozen_width_pt,
            frozen_height_pt,
        })
    };

    GridScene {
        viewport: GridViewport {
            first_row,
            first_col,
            rows,
            cols,
            x_offsets,
            y_offsets,
        },
        cells,
        // Phase A: a single default style entry (key 0), mirroring the page
        // lowering's IR-v2 default style.
        styles: vec![LoweredStyle::default_key0()],
        gridlines,
        // The panel supplies selection later (spec §8.1).
        selection: None,
        freeze,
        comments: comment_markers,
        databars,
    }
}

/// The cf data-bar / colour-scale domain `(min, max)` of a covering range: the
/// min/max of the NUMERIC cell values in that range (model coordinates),
/// memoized. `None` when the range holds no numeric cells (a degenerate bar
/// paints nothing). The grid analogue of the page lowering's `cf_domain`, so a
/// derived (min/max) data-bar endpoint matches on both surfaces.
fn grid_cf_domain(
    ws: Option<&sheet_core::Worksheet>,
    rng: condfmt::CfRange,
    cache: &mut std::collections::HashMap<condfmt::CfRange, Option<(f64, f64)>>,
) -> Option<(f64, f64)> {
    if let Some(&hit) = cache.get(&rng) {
        return hit;
    }
    let (r0, c0, r1, c1) = rng;
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    if let Some(ws) = ws {
        for r in r0..=r1 {
            for c in c0..=c1 {
                if let Some(&CellValue::Number(n)) = ws.cell(r, c).map(|cell| &cell.value) {
                    lo = lo.min(n);
                    hi = hi.max(n);
                }
            }
        }
    }
    let out = if lo.is_finite() && hi.is_finite() {
        Some((lo, hi))
    } else {
        None
    };
    cache.insert(rng, out);
    out
}

/// Column width in pt: explicit `col_widths` (xlsx chars × `CHAR_TO_PT`) or
/// the xlsx default. Mirrors the page lowering so a column matches on both
/// surfaces.
fn col_width_pt(ws: Option<&sheet_core::Worksheet>, col: u32) -> f64 {
    let chars = ws
        .and_then(|w| w.col_widths.get(&col).copied())
        .unwrap_or(DEFAULT_COL_CHARS);
    chars * CHAR_TO_PT
}

/// Row height in pt: explicit `row_heights` (already pt) or the default.
fn row_height_pt(ws: Option<&sheet_core::Worksheet>, row: u32) -> f64 {
    ws.and_then(|w| w.row_heights.get(&row).copied())
        .unwrap_or(DEFAULT_ROW_PT)
}

/// Format one cell to `(text, align)` — the SAME number-format render +
/// Excel-default alignment as the page lowering, so a value reads
/// identically on the grid and the page (spec §8.3).
fn lower_cell_text(
    model: &SheetModel,
    cell: &Cell,
    cache: &mut FormatCache,
    ctx: &FormatCtx,
) -> (String, Align) {
    let code = model.styles.num_fmt_of(cell.style);
    let text = match cache.get(code) {
        Ok(fmt) => sheet_format::format_value(&cell.value, fmt, ctx),
        Err(_) => sheet_format::format_general(&cell.value),
    };
    let style_align = model.styles.style(cell.style).align;
    let align = resolve_align(style_align, &cell.value);
    (text, align)
}

/// Excel-default alignment (matches the page lowering's ruling): explicit
/// non-`General` style alignment wins; otherwise numbers right, text left,
/// bool/error centered, blank stays `General`.
fn resolve_align(style_align: Align, value: &CellValue) -> Align {
    if style_align != Align::General {
        return style_align;
    }
    match value {
        CellValue::Number(_) => Align::Right,
        CellValue::Text(_) => Align::Left,
        CellValue::Bool(_) | CellValue::Error(_) => Align::Center,
        CellValue::Empty => Align::General,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sheet_core::CellStyle;
    use std::time::Instant;

    fn num(n: f64) -> Cell {
        Cell {
            value: CellValue::Number(n),
            ..Default::default()
        }
    }

    fn text(s: &str) -> Cell {
        Cell {
            value: CellValue::from(s),
            ..Default::default()
        }
    }

    /// A one-sheet model with the given `(row, col, cell)` seeds.
    fn model_with(cells: &[(u32, u32, Cell)]) -> (SheetModel, SheetId) {
        let mut m = SheetModel::new();
        let s = m.add_sheet("Sheet1");
        let ws = m.sheet_mut(s).unwrap();
        for (r, c, cell) in cells {
            ws.set_cell(*r, *c, cell.clone());
        }
        (m, s)
    }

    #[test]
    fn sheet_grid_scene_windowing_touches_only_viewport_on_sparse_million_rows() {
        // A sparse 1M-row sheet: one cell in the viewport, a handful FAR
        // outside it. Windowing must materialize only the in-viewport cell,
        // and do so fast (no O(sheet) scan).
        let mut m = SheetModel::new();
        let s = m.add_sheet("Big");
        {
            let ws = m.sheet_mut(s).unwrap();
            ws.set_cell(0, 0, num(1.0)); // in viewport
            ws.set_cell(5, 1, num(2.0)); // in viewport (small window below)
                                         // Far away — must NOT be materialized.
            ws.set_cell(500_000, 0, num(9.0));
            ws.set_cell(1_000_000, 50, text("far"));
            ws.set_cell(900_000, 5, num(7.0));
        }

        let start = Instant::now();
        // A small viewport: ~3 default cols wide, ~6 default rows tall.
        let scene = grid_scene(&m, s, 0, 0, 140.0, 95.0, &GridOptions::default());
        let elapsed = start.elapsed();

        // Only the two in-window populated cells are materialized.
        assert_eq!(scene.cells.len(), 2, "windowing must skip far-away cells");
        let coords: Vec<(u32, u32)> = scene.cells.iter().map(|c| (c.row, c.col)).collect();
        assert!(coords.contains(&(0, 0)));
        assert!(coords.contains(&(5, 1)));
        // Timing sanity: a windowed query over a 5-cell sparse map is
        // sub-millisecond; generously bound it so CI noise never flakes.
        assert!(
            elapsed.as_millis() < 50,
            "windowing should be fast, took {elapsed:?}"
        );
    }

    #[test]
    fn sheet_grid_scene_offsets_are_cumulative_with_trailing_edge() {
        let (m, s) = model_with(&[]);
        // Default cols (44.2575 pt) and rows (15 pt).
        let scene = grid_scene(&m, s, 0, 0, 100.0, 35.0, &GridOptions::default());
        let vp = &scene.viewport;
        // x_offsets carries cols+1 entries, cumulative from 0.
        assert_eq!(vp.x_offsets.len() as u32, vp.cols + 1);
        assert_eq!(vp.y_offsets.len() as u32, vp.rows + 1);
        assert_eq!(vp.x_offsets[0], 0.0);
        assert_eq!(vp.y_offsets[0], 0.0);
        for w in vp.x_offsets.windows(2) {
            assert!(w[1] > w[0], "x offsets strictly increasing");
        }
        // 100pt / 44.2575 ≈ 2 cols fit (the 3rd would overflow).
        assert_eq!(vp.cols, 2);
        // 35pt / 15 ≈ 2 rows fit.
        assert_eq!(vp.rows, 2);
        // Trailing x edge equals the summed widths.
        let last = *vp.x_offsets.last().unwrap();
        assert!((last - 2.0 * 44.2575).abs() < 1e-9);
    }

    #[test]
    fn sheet_grid_scene_formatted_text_matches_lower() {
        // The grid cell text must equal what sheet-format/the page lowering
        // produces for the same value+format (spec §8.3 parity).
        let mut m = SheetModel::new();
        let s = m.add_sheet("Sheet1");
        let fmt = m.styles.intern_num_fmt("0.00");
        let style = m.styles.intern_style(CellStyle {
            num_fmt: fmt,
            ..Default::default()
        });
        m.sheet_mut(s).unwrap().set_cell(
            0,
            0,
            Cell {
                value: CellValue::Number(3.5),
                style,
                ..Default::default()
            },
        );
        let scene = grid_scene(&m, s, 0, 0, 200.0, 60.0, &GridOptions::default());
        let cell = scene
            .cells
            .iter()
            .find(|c| c.row == 0 && c.col == 0)
            .unwrap();
        assert_eq!(cell.text, "3.50");
        assert_eq!(cell.align, Align::Right);

        // Cross-check against the page lowering for the identical model/cell.
        let lc = sheet_lower::lower_range(
            &m,
            s,
            sheet_lower::CellRange {
                r0: 0,
                c0: 0,
                r1: 0,
                c1: 0,
            },
            &sheet_lower::ViewOptions::default(),
        );
        assert_eq!(cell.text, lc.rows[0].cells[0].text);
        assert_eq!(cell.align, lc.rows[0].cells[0].align);
    }

    #[test]
    fn sheet_grid_scene_offsets_first_col_scroll_origin() {
        // Scrolling right: the viewport starts at first_col, offsets local.
        let (m, s) = model_with(&[(0, 5, num(5.0))]);
        let scene = grid_scene(&m, s, 0, 5, 200.0, 30.0, &GridOptions::default());
        assert_eq!(scene.viewport.first_col, 5);
        assert_eq!(scene.viewport.x_offsets[0], 0.0); // viewport-local
                                                      // The seeded cell at (0,5) is visible.
        assert!(scene.cells.iter().any(|c| c.row == 0 && c.col == 5));
    }

    #[test]
    fn sheet_grid_scene_selection_is_none_in_phase_a() {
        let (m, s) = model_with(&[]);
        let scene = grid_scene(&m, s, 0, 0, 100.0, 30.0, &GridOptions::default());
        assert!(scene.selection.is_none());
        assert_eq!(scene.styles, vec![LoweredStyle::default_key0()]);
    }

    #[test]
    fn sheet_grid_scene_gridlines_toggle() {
        let (m, s) = model_with(&[]);
        let on = grid_scene(&m, s, 0, 0, 100.0, 35.0, &GridOptions::default());
        assert!(!on.gridlines.h.is_empty());
        assert!(!on.gridlines.v.is_empty());
        let off = grid_scene(
            &m,
            s,
            0,
            0,
            100.0,
            35.0,
            &GridOptions {
                include_gridlines: false,
                ..GridOptions::default()
            },
        );
        assert!(off.gridlines.h.is_empty());
        assert!(off.gridlines.v.is_empty());
    }

    #[test]
    fn sheet_grid_scene_unknown_sheet_is_shaped_empty() {
        let (m, _s) = model_with(&[]);
        let scene = grid_scene(&m, 99, 0, 0, 100.0, 35.0, &GridOptions::default());
        // Geometry still derives from the bounds; no cells crash.
        assert!(scene.cells.is_empty());
        assert!(scene.viewport.cols >= 1);
        assert!(scene.viewport.rows >= 1);
    }

    #[test]
    fn sheet_grid_scene_freeze_panes_band_geometry() {
        // Frozen 1 col + 2 rows: the scene carries the split + the band pt
        // extents (summed from the sheet origin, independent of scroll).
        let (m, s) = model_with(&[]);
        let scene = grid_scene(
            &m,
            s,
            0,
            0,
            200.0,
            90.0,
            &GridOptions {
                include_gridlines: true,
                freeze_rows: 2,
                freeze_cols: 1,
            },
        );
        let fz = scene.freeze.expect("freeze present");
        assert_eq!(fz.rows, 2);
        assert_eq!(fz.cols, 1);
        // 1 default col = 44.2575 pt; 2 default rows = 30 pt.
        assert!((fz.frozen_width_pt - 44.2575).abs() < 1e-9);
        assert!((fz.frozen_height_pt - 30.0).abs() < 1e-9);
    }

    #[test]
    fn sheet_grid_scene_freeze_none_when_no_split() {
        let (m, s) = model_with(&[]);
        let scene = grid_scene(&m, s, 0, 0, 200.0, 90.0, &GridOptions::default());
        assert!(scene.freeze.is_none());
        // The wire omits `freeze` only as null (the field is always present).
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"freeze\":null"));
    }

    #[test]
    fn sheet_grid_scene_freeze_band_uses_explicit_widths() {
        // Explicit col width / row height feed the frozen band extents.
        let mut m = SheetModel::new();
        let s = m.add_sheet("Sheet1");
        {
            let ws = m.sheet_mut(s).unwrap();
            ws.col_widths.insert(0, 10.0); // 10 ch → 52.5 pt
            ws.row_heights.insert(0, 30.0); // pt
        }
        let scene = grid_scene(
            &m,
            s,
            0,
            0,
            300.0,
            120.0,
            &GridOptions {
                include_gridlines: true,
                freeze_rows: 1,
                freeze_cols: 1,
            },
        );
        let fz = scene.freeze.unwrap();
        assert!((fz.frozen_width_pt - 52.5).abs() < 1e-9);
        assert!((fz.frozen_height_pt - 30.0).abs() < 1e-9);
    }

    #[test]
    fn sheet_grid_scene_comment_markers_visible_only() {
        // Two commented cells: one in the window, one far below. Only the
        // in-window one yields a marker, anchored at the cell's top-right corner.
        let (m, s) = model_with(&[(0, 0, num(1.0))]);
        let scene = grid_scene_with_comments(
            &m,
            s,
            0,
            0,
            200.0,
            90.0,
            &GridOptions::default(),
            &[(0, 0), (500_000, 3)],
        );
        assert_eq!(scene.comments.len(), 1, "only the visible comment marks");
        let mk = &scene.comments[0];
        assert_eq!((mk.row, mk.col), (0, 0));
        // Top-right corner of A1: x = col 0 right edge (44.2575), y = row 0 top (0).
        assert!((mk.x - 44.2575).abs() < 1e-9);
        assert!((mk.y - 0.0).abs() < 1e-9);
    }

    #[test]
    fn sheet_grid_scene_no_comments_when_none_supplied() {
        let (m, s) = model_with(&[]);
        let scene = grid_scene(&m, s, 0, 0, 200.0, 90.0, &GridOptions::default());
        assert!(scene.comments.is_empty());
        // The wire shape carries the (empty) comments array.
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"comments\":[]"));
    }

    #[test]
    fn sheet_grid_scene_camelcase_wire_shape() {
        let (m, s) = model_with(&[(0, 0, num(1.0))]);
        let scene = grid_scene(&m, s, 0, 0, 100.0, 30.0, &GridOptions::default());
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"firstRow\""));
        assert!(json.contains("\"xOffsets\""));
        assert!(json.contains("\"styleKey\""));
        assert!(!json.contains("first_row"));
        assert!(!json.contains("x_offsets"));
    }

    /// A data-bar cf model over A1:A5 (derived [10,90] domain) yields one
    /// `GridDataBar` per visible numeric cell, with `(value-lo)/(hi-lo)` clamped
    /// fractions and the rule colour — the same proportion math the page lowering
    /// uses. Geometry is viewport-local + inside the cell box.
    fn databar_cf(range: (u32, u32, u32, u32), rgb: (u8, u8, u8)) -> SheetCondFmt {
        SheetCondFmt {
            blocks: vec![condfmt::CfBlock {
                ranges: vec![range],
                rules: vec![condfmt::CfRule {
                    kind: condfmt::CfRuleKind::DataBar(condfmt::DataBar {
                        min: None,
                        max: None,
                        rgb,
                    }),
                    priority: 1,
                    dxf: sheet_lower::VisualAttrs::default(),
                }],
            }],
        }
    }

    #[test]
    fn sheet_grid_scene_databars_proportional_per_visible_cell() {
        // A1:A5 = 10,40,70,20,90 → domain [10,90]. Fractions: 0, 0.375, 0.75,
        // 0.125, 1.0.
        let (m, s) = model_with(&[
            (0, 0, num(10.0)),
            (1, 0, num(40.0)),
            (2, 0, num(70.0)),
            (3, 0, num(20.0)),
            (4, 0, num(90.0)),
        ]);
        let cf = databar_cf((0, 0, 4, 0), (0x63, 0x8E, 0xC6));
        let scene =
            grid_scene_with_cf(&m, s, 0, 0, 300.0, 200.0, &GridOptions::default(), &[], &cf);
        assert_eq!(scene.databars.len(), 5, "one bar per A-column numeric cell");
        let frac = |row: u32| {
            scene
                .databars
                .iter()
                .find(|b| b.row == row && b.col == 0)
                .unwrap()
                .fill_fraction
        };
        assert!((frac(0) - 0.0).abs() < 1e-9);
        assert!((frac(1) - 0.375).abs() < 1e-9);
        assert!((frac(2) - 0.75).abs() < 1e-9);
        assert!((frac(4) - 1.0).abs() < 1e-9);
        // Geometry: inset, positive height, width never exceeds the cell, and the
        // colour is the rule colour. Cell A3's bar starts at its row's top edge.
        let cell_w = 44.2575_f64; // one default column
        for b in &scene.databars {
            assert_eq!(b.fill, "#638EC6");
            assert!(b.h > 0.0);
            assert!(b.w <= cell_w);
            assert!(b.x >= 0.0 && b.y >= 0.0);
        }
        let b2 = scene.databars.iter().find(|b| b.row == 2).unwrap();
        // A3 top edge = 2 default rows down = 30 pt; the bar is inset 1.5 pt.
        assert!((b2.y - (30.0 + 1.5)).abs() < 1e-9);
        // The bar width = 0.75 of the inset-available width (cell_w - 2*1.5).
        assert!((b2.w - 0.75 * (cell_w - 3.0)).abs() < 1e-9);
    }

    #[test]
    fn sheet_grid_scene_databars_windowed_and_numeric_only() {
        // A far-below numeric cell (still in the cf range) must NOT bar — only
        // visible cells materialize. A text cell never bars.
        let (m, s) = model_with(&[
            (0, 0, num(10.0)),
            (1, 0, text("hi")),      // non-numeric → no bar
            (900_000, 0, num(90.0)), // far below the window → not visible
        ]);
        let cf = databar_cf((0, 0, 900_000, 0), (1, 2, 3));
        let scene = grid_scene_with_cf(&m, s, 0, 0, 120.0, 45.0, &GridOptions::default(), &[], &cf);
        // Only the visible numeric A1 bars.
        assert_eq!(scene.databars.len(), 1);
        assert_eq!((scene.databars[0].row, scene.databars[0].col), (0, 0));
    }

    #[test]
    fn sheet_grid_scene_no_databars_when_cf_empty() {
        let (m, s) = model_with(&[(0, 0, num(5.0))]);
        let scene = grid_scene(&m, s, 0, 0, 200.0, 90.0, &GridOptions::default());
        assert!(scene.databars.is_empty());
        // The wire shape always carries the (empty) databars array.
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"databars\":[]"));
    }

    #[test]
    fn sheet_grid_scene_databar_camelcase_wire_shape() {
        let (m, s) = model_with(&[(0, 0, num(50.0)), (1, 0, num(100.0))]);
        let cf = databar_cf((0, 0, 1, 0), (0x12, 0x34, 0x56));
        let scene = grid_scene_with_cf(&m, s, 0, 0, 200.0, 90.0, &GridOptions::default(), &[], &cf);
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"databars\""));
        assert!(json.contains("\"fillFraction\""));
        assert!(json.contains("\"fill\":\"#123456\""));
        assert!(!json.contains("fill_fraction"));
    }

    // ---- frame_window (ADR 510) ----

    fn spec(top_row: u32, left_col: u32, w: f64, h: f64) -> FrameWindowSpec {
        FrameWindowSpec {
            top_row,
            left_col,
            width_pt: w,
            height_pt: h,
            freeze_rows: 0,
            freeze_cols: 0,
        }
    }

    #[test]
    fn sheet_frame_window_lists_whole_tracks_and_names_the_partial_one() {
        let (m, s) = model_with(&[]);
        let w = frame_window(&m, s, &spec(0, 0, 200.0, 60.0));
        // Default column 8.43 chars x 5.25 pt = 44.2575 pt: four fit in 200.
        assert_eq!(w.cols, vec![0, 1, 2, 3]);
        assert_eq!(w.partial_col, Some(4));
        // Default row 15 pt: exactly four fit in 60, nothing partial.
        assert_eq!(w.rows, vec![0, 1, 2, 3]);
        assert_eq!(w.partial_row, None);
        assert!((w.width_pt - 4.0 * 44.2575).abs() < 1e-9);
        assert_eq!(w.height_pt, 60.0);
        assert_eq!((w.frozen_rows, w.frozen_cols), (0, 0));
    }

    #[test]
    #[allow(non_snake_case)]
    fn sheet_frame_window_skips_hidden_columns__feat__sheet_grid_inframe() {
        let mut m = SheetModel::new();
        let s = m.add_sheet("S");
        m.sheet_mut(s).unwrap().col_meta.push(sheet_core::ColMeta {
            min: 1,
            max: 2,
            hidden: true,
            ..Default::default()
        });
        let w = frame_window(
            &m,
            s,
            &FrameWindowSpec {
                top_row: 0,
                left_col: 0,
                width_pt: 200.0,
                height_pt: 30.0,
                freeze_rows: 0,
                freeze_cols: 0,
            },
        );
        assert_eq!(&w.cols[..3], &[0, 3, 4]);
    }

    #[test]
    fn sheet_frame_window_starts_at_the_top_left_cell_and_skips_hidden_rows() {
        let (mut m, s) = model_with(&[]);
        {
            let ws = m.sheet_mut(s).unwrap();
            ws.hidden_rows.insert(11);
            ws.filtered_rows.insert(12);
            ws.row_heights.insert(13, 30.0);
        }
        let w = frame_window(&m, s, &spec(10, 2, 100.0, 61.0));
        assert_eq!(w.rows, vec![10, 13, 14]);
        assert_eq!(w.row_heights_pt, vec![15.0, 30.0, 15.0]);
        assert_eq!(w.partial_row, Some(15));
        assert_eq!(w.cols, vec![2, 3]);
    }

    #[test]
    fn sheet_frame_window_pins_the_frozen_band_above_the_scrolled_body() {
        let (m, s) = model_with(&[]);
        let mut sp = spec(40, 7, 200.0, 75.0);
        sp.freeze_rows = 2;
        sp.freeze_cols = 1;
        let w = frame_window(&m, s, &sp);
        assert_eq!(w.rows, vec![0, 1, 40, 41, 42]);
        assert_eq!(w.frozen_rows, 2);
        assert_eq!(w.cols, vec![0, 7, 8, 9]);
        assert_eq!(w.frozen_cols, 1);
        // A top-left inside the frozen band starts the body right after it.
        let w = frame_window(
            &m,
            s,
            &FrameWindowSpec {
                top_row: 0,
                left_col: 0,
                ..sp
            },
        );
        assert_eq!(w.rows, vec![0, 1, 2, 3, 4]);
        assert_eq!(w.cols, vec![0, 1, 2, 3]);
    }

    #[test]
    fn sheet_frame_window_always_shows_one_body_track() {
        let (mut m, s) = model_with(&[]);
        m.sheet_mut(s).unwrap().col_widths.insert(0, 100.0);
        let w = frame_window(&m, s, &spec(0, 0, 50.0, 5.0));
        assert_eq!(w.cols, vec![0]);
        assert_eq!(w.rows, vec![0]);
        assert_eq!(w.partial_col, None);
    }

    #[test]
    fn sheet_frame_window_agrees_with_the_grid_viewport() {
        let (mut m, s) = model_with(&[]);
        {
            let ws = m.sheet_mut(s).unwrap();
            ws.col_widths.insert(3, 20.0);
            ws.col_widths.insert(5, 4.0);
            ws.row_heights.insert(2, 40.0);
        }
        for (r0, c0, w, h) in [
            (0, 0, 300.0, 200.0),
            (1, 2, 123.4, 99.9),
            (5, 4, 1000.0, 20.0),
        ] {
            let fw = frame_window(&m, s, &spec(r0, c0, w, h));
            let scene = grid_scene(&m, s, r0, c0, w, h, &GridOptions::default());
            let vp = &scene.viewport;
            assert_eq!(
                fw.rows,
                (vp.first_row..vp.first_row + vp.rows).collect::<Vec<_>>()
            );
            assert_eq!(
                fw.cols,
                (vp.first_col..vp.first_col + vp.cols).collect::<Vec<_>>()
            );
            assert!((fw.width_pt - vp.x_offsets[vp.cols as usize]).abs() < 1e-9);
            assert!((fw.height_pt - vp.y_offsets[vp.rows as usize]).abs() < 1e-9);
        }
    }

    #[test]
    fn sheet_frame_window_serializes_camel_case() {
        let (m, s) = model_with(&[]);
        let json = serde_json::to_string(&frame_window(&m, s, &spec(0, 0, 50.0, 20.0))).unwrap();
        assert!(json.contains("\"colWidthsPt\"") && json.contains("\"partialRow\""));
        let back: FrameWindowSpec =
            serde_json::from_str(r#"{"topRow":3,"leftCol":1,"widthPt":10,"heightPt":20}"#).unwrap();
        assert_eq!(
            back,
            FrameWindowSpec {
                top_row: 3,
                left_col: 1,
                width_pt: 10.0,
                height_pt: 20.0,
                freeze_rows: 0,
                freeze_cols: 0
            }
        );
    }
}
