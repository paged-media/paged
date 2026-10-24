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
//! worksheet for the live grid a sheet frame shows while it is entered
//! (ADR 510). Where `sheet-lower` compiles a FIXED range into page content,
//! `sheet-grid` produces the view from a top-left cell bounded by a box —
//! only the cells visible in that window are materialized, so a 1M-row
//! sheet costs O(visible cells), never O(sheet).
//!
//! ## One window, one style path
//!
//! - **Which tracks** — [`frame_window`] is the single answer: the frozen
//!   tracks first, then the scrolled body from the top-left cell, hidden and
//!   filtered rows skipped, whole tracks only. The scene's viewport lists
//!   those tracks (`row_indices` / `col_indices`) with their cumulative
//!   offsets; `first_row` / `first_col` name the first BODY track.
//! - **How a cell looks** — every populated cell goes through
//!   [`sheet_lower::CellStyler`], the same per-cell resolver the page
//!   lowering uses (base visual style + conditional formatting folded on
//!   top), and its text through [`sheet_lower::lower_cell_display`]. A cell's
//!   `style_key` and style equal what the page lowering gives the same cell
//!   when it lowers the same window.
//! - **Merges** — merged areas intersecting the window become
//!   [`GridMerge`] rectangles (split at the frozen band), carrying the
//!   anchor cell's text and style; gridlines inside a merge are omitted and
//!   the covered cells are not emitted as cells.
//! - **Text overflow** — a left- or right-aligned text cell that does not
//!   wrap names how far it may spill into empty neighbours
//!   ([`GridCell::overflow_to`]), as Excel draws it.
//!
//! ## IR reuse (documented spec §4 deviation)
//!
//! The scene's `styles`/`gridlines` reuse `sheet_lower::LoweredStyle` and
//! `sheet_lower::RuleSet` so the grid and the page lowering share ONE
//! style/rule wire shape (see the crate's Cargo.toml note). `sheet-lower`
//! is pure IR, so this does not cross the §4 SDK-isolation rule.

use sheet_core::{Align, CellValue, SheetId, SheetModel};
use sheet_format::{FormatCache, FormatCtx};
use sheet_lower::condfmt::SheetCondFmt;
use sheet_lower::{CellStyler, LoweredStyle, NoStyles, Rule, RuleSet, VisualStyleSource};

// Re-use the page-lowering geometry rulings so a column is the same width on
// both surfaces (spec §8.2 — character-unit columns, point rows).
use sheet_lower::{DATABAR_INSET_PT, DEFAULT_ROW_PT};

// ---- The grid scene IR (wire shape; serde camelCase). ----

/// The complete vector scene for one grid viewport (spec §8.1). Pure data
/// the grid surface draws: the windowed viewport geometry, the visible
/// populated cells, the style table, the gridlines, the merged areas, and
/// the (optional) selection rectangle.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GridScene {
    pub viewport: GridViewport,
    /// The visible populated cells, in display order (row-major). A cell
    /// inside a merged area is not listed; the [`GridMerge`] carries it.
    pub cells: Vec<GridCell>,
    /// The style table `GridCell::style_key` indexes (key 0 = default).
    pub styles: Vec<LoweredStyle>,
    /// Gridlines at the visible track boundaries, broken where a merged area
    /// spans the boundary.
    pub gridlines: RuleSet,
    pub selection: Option<GridSelection>,
    /// The frozen row/column split rendered in this viewport (spec §8.1).
    /// The frozen tracks are pinned at the top/left of the viewport (they
    /// lead `row_indices` / `col_indices`); this names the requested split
    /// and the split-line offsets. `None` when no pane is frozen.
    pub freeze: Option<GridFreeze>,
    /// Cell-comment indicators for the VISIBLE cells that carry a comment
    /// (preserve-first; spec §10.2). The renderer draws a small corner marker
    /// (the classic Excel comment triangle); the comment text rides in the
    /// panel / hover, not the scene. Empty unless the caller supplies the
    /// sheet's commented cells.
    pub comments: Vec<GridCommentMarker>,
    /// Conditional-formatting DATA BARS for the VISIBLE numeric cells covered by
    /// a `dataBar` cf rule (spec §8.2/§10.4 — the same drawn-rect geometry the
    /// page lowering emits). Each is one proportional rect in viewport-local
    /// pt. Empty unless the caller supplies the sheet's conditional formats.
    pub databars: Vec<GridDataBar>,
    /// The merged areas intersecting the window, one rect per pane they
    /// show in (a merge crossing the frozen split yields one per side).
    pub merges: Vec<GridMerge>,
    /// Conditional-format icons of the visible cells (W2.4), as the page
    /// lowering places them (viewport-local pt). Omitted when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub icons: Vec<sheet_lower::IconRect>,
    /// The sparklines of the VISIBLE cells (`x14:sparklineGroups`, sheet
    /// ADR 519): each cell's viewport-local box and the sparkline's
    /// primitives in that box's own pt space. Empty unless the caller
    /// supplies them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sparklines: Vec<GridSparkline>,
    /// The hyperlinks over visible cells (W2.3): one clickable rect per
    /// visible cell box of a linked range (viewport-local pt). Empty unless
    /// the caller supplies them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<GridLink>,
    /// The pictures that show in the viewport (W2.3): drawing pictures at
    /// their anchor, images in cells fitted into the cell. Empty unless the
    /// caller supplies them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pictures: Vec<GridPicture>,
}

/// One clickable hyperlink rect in a grid viewport (viewport-local pt).
#[derive(serde::Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GridLink {
    pub row: u32,
    pub col: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// The external target, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The place in the workbook, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

/// One picture drawn in a grid viewport: its media part (the bytes come
/// from the session by that name) and its box (viewport-local pt). An image
/// in a cell is fitted into the box keeping its aspect ratio.
#[derive(serde::Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GridPicture {
    pub id: String,
    pub media: String,
    pub content_type: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub in_cell: bool,
}

/// One sparkline drawn in a grid viewport: its cell, the cell's box in
/// viewport-local pt, and the chart primitives (sheet-chart's IR) placed in
/// the box (origin its top-left).
#[derive(serde::Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GridSparkline {
    pub row: u32,
    pub col: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub prims: Vec<sheet_chart::Primitive>,
}

impl GridViewport {
    /// The viewport-local box `(x, y, w, h)` of a displayed cell.
    pub fn cell_box(&self, row: u32, col: u32) -> Option<(f64, f64, f64, f64)> {
        let ri = self.row_indices.iter().position(|r| *r == row)?;
        let ci = self.col_indices.iter().position(|c| *c == col)?;
        let (x0, x1) = (*self.x_offsets.get(ci)?, *self.x_offsets.get(ci + 1)?);
        let (y0, y1) = (*self.y_offsets.get(ri)?, *self.y_offsets.get(ri + 1)?);
        Some((x0, y0, x1 - x0, y1 - y0))
    }
}

/// One conditional-formatting DATA BAR drawn in a grid viewport: the page
/// lowering's own [`sheet_lower::DataBarRect`] (built by the same
/// `bar_rect`), with the absolute `(row, col)` and a viewport-local rect.
pub type GridDataBar = sheet_lower::DataBarRect;

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
/// are the number of leading SHEET rows/columns held fixed (as requested);
/// `frozen_width_pt` / `frozen_height_pt` are the split-line offsets — the pt
/// extent of the frozen tracks actually shown (hidden frozen rows take no
/// room), equal to `x_offsets[frozen_cols]` / `y_offsets[frozen_rows]`.
#[derive(serde::Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct GridFreeze {
    /// Leading sheet rows held fixed at the top.
    pub rows: u32,
    /// Leading sheet columns held fixed at the left.
    pub cols: u32,
    /// pt offset of the vertical split line (the frozen column band's width).
    pub frozen_width_pt: f64,
    /// pt offset of the horizontal split line (the frozen row band's height).
    pub frozen_height_pt: f64,
}

/// The windowed viewport: the displayed tracks and their cumulative pt
/// offsets. `row_indices` / `col_indices` are the SHEET indices shown, in
/// display order — the frozen tracks first (`frozen_rows` / `frozen_cols` of
/// them), then the scrolled body; hidden rows are skipped. `rows` / `cols`
/// are their counts. `x_offsets` / `y_offsets` carry `cols + 1` / `rows + 1`
/// entries — the leading edge of every displayed track PLUS a trailing edge;
/// offsets are viewport-local (the first displayed track starts at 0).
/// `first_row` / `first_col` are the first BODY track (the first entry after
/// the frozen band); without a frozen band and hidden rows the tracks are
/// `first_row..first_row + rows`, as before the index arrays existed.
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
    /// Sheet row of each displayed row track (len == `rows`), increasing.
    pub row_indices: Vec<u32>,
    /// Sheet column of each displayed column track (len == `cols`), increasing.
    pub col_indices: Vec<u32>,
    /// How many leading entries of `row_indices` / `col_indices` are frozen.
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    /// The next track past the last whole one, when part of it is inside the
    /// box (the live grid may draw it greyed past the print edge). Not part
    /// of `row_indices` / `col_indices`; no cells are materialized for it.
    pub partial_row: Option<u32>,
    pub partial_col: Option<u32>,
}

/// One materialized visible cell: its absolute `(row, col)`, the FORMATTED
/// text (the number-format render IS the text, spec §8.3), the resolved
/// alignment, and its style key. Only POPULATED cells inside the viewport
/// are emitted — a cell with text or with a non-default style (a styled
/// empty cell still paints its fill and borders); blanks are drawn from the
/// viewport geometry.
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
    /// The text wraps inside the cell (from the style; omitted when false).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub wrap: bool,
    /// Vertical alignment (`"top"` / `"center"` / `"bottom"`, from the
    /// style); omitted for the default (bottom).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v_align: Option<String>,
    /// For a left- or right-aligned, non-wrapping TEXT cell: the farthest
    /// sheet column its text may spill into — the run of empty neighbours to
    /// the right (left-aligned) or left (right-aligned), stopped by the next
    /// cell with text, a merged area, the frozen split or the window edge.
    /// The painter clips the text there (it measures; the engine does not).
    /// Omitted when the immediate neighbour is occupied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overflow_to: Option<u32>,
    /// The number format's repeat-fill character; `text` then holds a TAB
    /// where it stands (see `sheet_lower::LoweredCell::fill`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// A rich-text cell's runs (see `sheet_lower::LoweredCell::runs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<Vec<sheet_lower::LoweredRun>>,
}

/// One merged area as shown in a viewport pane. `row` / `col` /
/// `row_span` / `col_span` are the whole merged area in sheet coordinates
/// (its anchor is the top-left cell); `x` / `y` / `w` / `h` are the visible
/// part in this pane (viewport-local pt). The anchor cell's formatted text,
/// alignment and style ride on every rect of the merge, so the painter
/// draws the text inside the visible part.
#[derive(serde::Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GridMerge {
    pub row: u32,
    pub col: u32,
    pub row_span: u32,
    pub col_span: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub text: String,
    #[serde(serialize_with = "serialize_align")]
    pub align: Align,
    pub style_key: u32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub wrap: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v_align: Option<String>,
    /// The anchor's repeat-fill character (see [`GridCell::fill`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
}

/// A selection rectangle, anchored at `(anchor_row, anchor_col)` and
/// spanning `rows`×`cols` SHEET tracks. The session folds it in.
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
/// of leading SHEET rows/columns held fixed (0 = none).
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
/// frame never renders empty. The listed rows and columns are strictly
/// increasing (the body starts after the frozen band). Hidden columns are
/// skipped like hidden rows.
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

/// Generate the [`GridScene`] for a worksheet viewport (spec §8.1), unstyled
/// (every cell resolves to the default style).
///
/// The window is [`frame_window`] for the scroll origin `(first_row,
/// first_col)`, the box `(max_width_pt, max_height_pt)` and the frozen split
/// in `opts`. Only POPULATED cells inside the window are materialized — so
/// the scene cost is O(visible cells), not O(sheet). An unknown `sheet`
/// yields an empty-but-shaped scene (geometry from the defaults, no cells).
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
/// commented cell visible in the window (preserve-first display; spec
/// §10.2). An empty `comment_cells` reproduces [`grid_scene`] exactly.
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
/// (`cf`): cf dxf rules and colour scales fold into the cell styles and data
/// bars become [`GridDataBar`] rects — the same per-cell path the page
/// lowering takes. Base styles stay default (no visual-style source); the
/// session calls [`grid_scene_styled`] with the workbook's styles.
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
    let spec = FrameWindowSpec {
        top_row: first_row,
        left_col: first_col,
        width_pt: max_width_pt,
        height_pt: max_height_pt,
        freeze_rows: opts.freeze_rows,
        freeze_cols: opts.freeze_cols,
    };
    grid_scene_styled(
        model,
        sheet,
        &spec,
        opts.include_gridlines,
        comment_cells,
        cf,
        &NoStyles,
    )
}

/// A merged area's visible part in one pane, in display-track indices
/// (`dr0..dr1` × `dc0..dc1`, exclusive ends) — the working form of a
/// [`GridMerge`].
#[derive(Clone, Copy, Debug)]
struct Fragment {
    /// Index into the worksheet's `merges`.
    merge: usize,
    /// The merged area in sheet coordinates.
    area: (u32, u32, u32, u32),
    dr0: usize,
    dr1: usize,
    dc0: usize,
    dc1: usize,
}

/// The display indices `lo..hi` (inside the pane `seg`) whose sheet track
/// lies in `[t0, t1]`. `tracks` is strictly increasing.
fn band(tracks: &[u32], seg: (usize, usize), t0: u32, t1: u32) -> (usize, usize) {
    let s = &tracks[seg.0..seg.1];
    let lo = s.partition_point(|&t| t < t0);
    let hi = s.partition_point(|&t| t <= t1);
    (seg.0 + lo, seg.0 + hi.max(lo))
}

/// The panes of one axis: the frozen tracks and the body (empty ones dropped).
fn panes(frozen: usize, total: usize) -> Vec<(usize, usize)> {
    [(0, frozen), (frozen, total)]
        .into_iter()
        .filter(|(a, b)| a < b)
        .collect()
}

/// Generate the [`GridScene`] for the window `spec` asks for (ADR 510), with
/// the workbook's visual styles (`visual`) and conditional formats (`cf`)
/// resolved through the page lowering's own per-cell path
/// ([`sheet_lower::CellStyler`]).
///
/// Cells are walked in display order (frozen rows first, then the body;
/// within a row, frozen columns first), so for a window with no frozen band
/// a cell's `style_key` and the styles table equal the page lowering's for
/// the range the window covers. Styles of merge anchors outside the window
/// are resolved after the walk, so they only ever append to the table.
///
/// Work is O(displayed rows · log n + visible populated cells + merges).
pub fn grid_scene_styled(
    model: &SheetModel,
    sheet: SheetId,
    spec: &FrameWindowSpec,
    include_gridlines: bool,
    comment_cells: &[(u32, u32)],
    cf: &SheetCondFmt,
    visual: &impl VisualStyleSource,
) -> GridScene {
    grid_scene_cf(
        model,
        sheet,
        spec,
        include_gridlines,
        comment_cells,
        cf,
        visual,
        None,
    )
}

/// [`grid_scene_styled`] with conditional formatting evaluated through `src` (W2.4,
/// the session's `sheet_calc::cf` evaluator) instead of the static rules.
pub fn grid_scene_cf(
    model: &SheetModel,
    sheet: SheetId,
    spec: &FrameWindowSpec,
    include_gridlines: bool,
    comment_cells: &[(u32, u32)],
    cf: &SheetCondFmt,
    visual: &impl VisualStyleSource,
    src: Option<&dyn sheet_lower::cfdraw::CellCfSource>,
) -> GridScene {
    let ws = model.sheet(sheet);
    let win = frame_window(model, sheet, spec);
    let n_rows = win.rows.len();
    let n_cols = win.cols.len();
    let fr = win.frozen_rows as usize;
    let fc = win.frozen_cols as usize;

    let mut x_offsets = Vec::with_capacity(n_cols + 1);
    x_offsets.push(0.0);
    let mut x = 0.0_f64;
    for w in &win.col_widths_pt {
        x += w;
        x_offsets.push(x);
    }
    let mut y_offsets = Vec::with_capacity(n_rows + 1);
    y_offsets.push(0.0);
    let mut y = 0.0_f64;
    for h in &win.row_heights_pt {
        y += h;
        y_offsets.push(y);
    }
    let total_width = x;
    let total_height = y;
    let row_panes = panes(fr, n_rows);
    let col_panes = panes(fc, n_cols);
    let row_pos = |r: u32| win.rows.binary_search(&r).ok();
    let col_pos = |c: u32| win.cols.binary_search(&c).ok();

    // ---- Merged areas intersecting the window, one fragment per pane. ----
    let mut frags: Vec<Fragment> = Vec::new();
    if let (Some(ws), Some(&row_lo), Some(&row_hi), Some(&col_lo), Some(&col_hi)) = (
        ws,
        win.rows.first(),
        win.rows.last(),
        win.cols.first(),
        win.cols.last(),
    ) {
        for (mi, m) in ws.merges.iter().enumerate() {
            let n = m.normalized();
            if n.start.sheet != sheet {
                continue;
            }
            let area = (n.start.row, n.start.col, n.end.row, n.end.col);
            if area.2 < row_lo || area.0 > row_hi || area.3 < col_lo || area.1 > col_hi {
                continue;
            }
            for &rp in &row_panes {
                let (dr0, dr1) = band(&win.rows, rp, area.0, area.2);
                if dr0 >= dr1 {
                    continue;
                }
                for &cp in &col_panes {
                    let (dc0, dc1) = band(&win.cols, cp, area.1, area.3);
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
    // Per display row, the fragments covering it (cells under a merge are
    // carried by the merge, not emitted as cells).
    let mut frags_by_row: Vec<Vec<usize>> = vec![Vec::new(); n_rows];
    for (fi, f) in frags.iter().enumerate() {
        for row in &mut frags_by_row[f.dr0..f.dr1] {
            row.push(fi);
        }
    }

    // ---- Materialize ONLY visible populated cells (virtualization). ----
    let ctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
    let mut cache = FormatCache::default();
    let mut styler = CellStyler::new(visual, cf, ws).with_cf_source(src);
    let mut cells: Vec<GridCell> = Vec::new();
    // Per emitted cell: (display row, display col, holds a text value).
    let mut meta: Vec<(usize, usize, bool)> = Vec::new();
    let mut databars: Vec<GridDataBar> = Vec::new();
    let mut icons: Vec<sheet_lower::IconRect> = Vec::new();
    // merge index -> (text, align, style key) of its anchor, once seen.
    #[allow(clippy::type_complexity)]
    let mut anchors: std::collections::HashMap<usize, (String, Align, u32, Option<String>)> =
        std::collections::HashMap::new();
    let empties = styler.styles_empty_cells();
    if let Some(ws) = ws {
        for (dr, &r) in win.rows.iter().enumerate() {
            for &(a, b) in &col_panes {
                let (lo, hi) = (win.cols[a], win.cols[b - 1]);
                // The cells to visit in display order: every shown column when
                // empty cells can be styled (a table, a conditional format —
                // walked inline so style keys come in the page's order), else
                // only the populated ones.
                let items: Vec<(usize, u32, Option<&sheet_core::Cell>)> = if empties {
                    (a..b)
                        .map(|dc| (dc, win.cols[dc], ws.cell(r, win.cols[dc])))
                        .collect()
                } else {
                    ws.cells
                        .range((r, lo)..=(r, hi))
                        .filter_map(|(&(_, c), cell)| col_pos(c).map(|dc| (dc, c, Some(cell))))
                        .collect()
                };
                for (dc, c, cell) in items {
                    let Some(cell) = cell else {
                        if frags_by_row[dr]
                            .iter()
                            .any(|&fi| dc >= frags[fi].dc0 && dc < frags[fi].dc1)
                        {
                            continue;
                        }
                        let key = styler.key_for_empty(r, c);
                        if key == 0 {
                            continue;
                        }
                        meta.push((dr, dc, false));
                        cells.push(GridCell {
                            row: r,
                            col: c,
                            text: String::new(),
                            align: Align::General,
                            style_key: key,
                            wrap: false,
                            v_align: None,
                            overflow_to: None,
                            fill: None,
                            runs: None,
                        });
                        continue;
                    };
                    let d = sheet_lower::lower_cell_cf(
                        &mut styler,
                        model,
                        r,
                        c,
                        cell,
                        &mut cache,
                        &ctx,
                    );
                    let key = styler.key_for_display(r, c, cell, d.color);
                    let cell_x = x_offsets[dc];
                    let cell_w = x_offsets[dc + 1] - cell_x;
                    let cell_y = y_offsets[dr];
                    let cell_h = y_offsets[dr + 1] - cell_y;
                    // The SAME geometry as the page lowering (`bar_rect`,
                    // `place_icon`).
                    if let Some(bar) = styler.databar(r, c, cell) {
                        databars.push(sheet_lower::bar_rect(
                            r,
                            c,
                            (cell_x, cell_y, cell_w, cell_h),
                            &bar,
                        ));
                    }
                    if let Some(icon) = styler.icon(r, c, cell) {
                        icons.push(sheet_lower::place_icon(
                            r,
                            c,
                            &icon,
                            cell_x,
                            cell_y,
                            cell_h,
                            DATABAR_INSET_PT,
                        ));
                    }
                    let (text, align, fill) = (d.text, d.align, d.fill.map(String::from));
                    let covering = frags_by_row[dr]
                        .iter()
                        .map(|&fi| frags[fi])
                        .find(|f| dc >= f.dc0 && dc < f.dc1);
                    if let Some(f) = covering {
                        if (r, c) == (f.area.0, f.area.1) {
                            anchors.insert(f.merge, (text, align, key, fill));
                        }
                        continue;
                    }
                    if text.is_empty() && key == 0 {
                        continue; // nothing to draw beyond the blank grid
                    }
                    // Rich-text runs (a merged area shows its anchor plain).
                    let runs = styler.runs(sheet, r, c, cell, &text).map(|rs| {
                        rs.into_iter()
                            .map(|(text, style_key)| sheet_lower::LoweredRun { text, style_key })
                            .collect::<Vec<_>>()
                    });
                    meta.push((dr, dc, matches!(cell.value, CellValue::Text(_))));
                    cells.push(GridCell {
                        row: r,
                        col: c,
                        text,
                        align,
                        style_key: key,
                        wrap: false,
                        v_align: None,
                        overflow_to: None,
                        fill,
                        runs,
                    });
                }
            }
        }
        // Anchors outside the window (scrolled away, or hidden): resolved
        // after the walk so they only append to the styles table.
        for f in &frags {
            if anchors.contains_key(&f.merge) {
                continue;
            }
            let entry = match ws.cell(f.area.0, f.area.1) {
                Some(cell) => {
                    let d = sheet_lower::lower_cell_display(model, cell, &mut cache, &ctx);
                    let key = styler.key_for_display(f.area.0, f.area.1, cell, d.color);
                    (d.text, d.align, key, d.fill.map(String::from))
                }
                None => (String::new(), Align::General, 0, None),
            };
            anchors.insert(f.merge, entry);
        }
    }
    let styles = styler.into_styles();
    let style_of = |key: u32| styles.get(key as usize).unwrap_or(&styles[0]);

    // ---- Wrap / vertical alignment from the style; overflow hints. ----
    for cell in &mut cells {
        let s = style_of(cell.style_key);
        cell.wrap = s.wrap;
        cell.v_align = s.v_align.clone();
        // Stacked text: one character per line, as the page lowers it.
        if s.rotation == Some(sheet_core::visual::ROTATION_STACKED) {
            cell.text = sheet_lower::stack_text(&cell.text);
            cell.runs = None;
            cell.fill = None;
        }
    }
    let mut start = 0;
    while start < cells.len() {
        let dr = meta[start].0;
        let mut end = start;
        while end < cells.len() && meta[end].0 == dr {
            end += 1;
        }
        // Occupied display columns in this row: cells with text + merges.
        let mut occupied: Vec<usize> = (start..end)
            .filter(|&i| !cells[i].text.is_empty())
            .map(|i| meta[i].1)
            .collect();
        for &fi in &frags_by_row[dr] {
            occupied.extend(frags[fi].dc0..frags[fi].dc1);
        }
        occupied.sort_unstable();
        for i in start..end {
            let (_, dc, is_text) = meta[i];
            let cell = &cells[i];
            if !is_text || cell.wrap || cell.text.is_empty() || cell.fill.is_some() {
                continue;
            }
            let (seg_lo, seg_hi) = if dc < fc { (0, fc) } else { (fc, n_cols) };
            let to = match cell.align {
                Align::Left | Align::General => {
                    let next = occupied[occupied.partition_point(|&o| o <= dc)..]
                        .first()
                        .copied()
                        .unwrap_or(seg_hi)
                        .min(seg_hi);
                    (next > dc + 1).then(|| win.cols[next - 1])
                }
                Align::Right => {
                    let p = occupied.partition_point(|&o| o < dc);
                    let prev = if p == 0 { None } else { Some(occupied[p - 1]) };
                    let first = prev.map_or(seg_lo, |o| o + 1).max(seg_lo);
                    (first < dc).then(|| win.cols[first])
                }
                Align::Center => None,
            };
            cells[i].overflow_to = to;
        }
        start = end;
    }

    // ---- Merge rectangles. ----
    let merges: Vec<GridMerge> = frags
        .iter()
        .map(|f| {
            let (text, align, key, fill) =
                anchors
                    .get(&f.merge)
                    .cloned()
                    .unwrap_or((String::new(), Align::General, 0, None));
            let s = style_of(key);
            let stacked = s.rotation == Some(sheet_core::visual::ROTATION_STACKED);
            let (text, fill) = if stacked {
                (sheet_lower::stack_text(&text), None)
            } else {
                (text, fill)
            };
            GridMerge {
                row: f.area.0,
                col: f.area.1,
                row_span: f.area.2 - f.area.0 + 1,
                col_span: f.area.3 - f.area.1 + 1,
                x: x_offsets[f.dc0],
                y: y_offsets[f.dr0],
                w: x_offsets[f.dc1] - x_offsets[f.dc0],
                h: y_offsets[f.dr1] - y_offsets[f.dr0],
                text,
                align,
                style_key: key,
                wrap: s.wrap,
                v_align: s.v_align.clone(),
                fill,
            }
        })
        .collect();

    // ---- Gridlines at every visible track boundary, broken by merges. ----
    let gridlines = if include_gridlines {
        let mut h = Vec::with_capacity(n_rows + 1);
        for (i, &at) in y_offsets.iter().enumerate() {
            let gaps = frags
                .iter()
                .filter(|f| f.dr0 < i && i < f.dr1)
                .map(|f| (x_offsets[f.dc0], x_offsets[f.dc1]));
            push_broken_rule(&mut h, at, total_width, gaps);
        }
        let mut v = Vec::with_capacity(n_cols + 1);
        for (i, &at) in x_offsets.iter().enumerate() {
            let gaps = frags
                .iter()
                .filter(|f| f.dc0 < i && i < f.dc1)
                .map(|f| (y_offsets[f.dr0], y_offsets[f.dr1]));
            push_broken_rule(&mut v, at, total_height, gaps);
        }
        RuleSet { h, v }
    } else {
        RuleSet::default()
    };

    // ---- Cell-comment indicators (preserve-first; spec §10.2), at each
    // visible commented cell's top-right corner (viewport-local pt). ----
    let comments: Vec<GridCommentMarker> = comment_cells
        .iter()
        .filter_map(|&(r, c)| {
            let (dr, dc) = (row_pos(r)?, col_pos(c)?);
            Some(GridCommentMarker {
                row: r,
                col: c,
                x: x_offsets[dc + 1],
                y: y_offsets[dr],
            })
        })
        .collect();

    // ---- Frozen-pane split (spec §8.1): the requested split and the
    // offsets of the split lines after the shown frozen tracks. ----
    let freeze = (spec.freeze_rows > 0 || spec.freeze_cols > 0).then(|| GridFreeze {
        rows: spec.freeze_rows,
        cols: spec.freeze_cols,
        frozen_width_pt: x_offsets[fc],
        frozen_height_pt: y_offsets[fr],
    });

    GridScene {
        viewport: GridViewport {
            first_row: win
                .rows
                .get(fr)
                .copied()
                .unwrap_or(spec.top_row.max(spec.freeze_rows)),
            first_col: win
                .cols
                .get(fc)
                .copied()
                .unwrap_or(spec.left_col.max(spec.freeze_cols)),
            rows: n_rows as u32,
            cols: n_cols as u32,
            x_offsets,
            y_offsets,
            row_indices: win.rows,
            col_indices: win.cols,
            frozen_rows: win.frozen_rows,
            frozen_cols: win.frozen_cols,
            partial_row: win.partial_row,
            partial_col: win.partial_col,
        },
        cells,
        styles,
        gridlines,
        // The session folds in the stored selection.
        selection: None,
        freeze,
        comments,
        databars,
        sparklines: Vec::new(),
        links: Vec::new(),
        pictures: Vec::new(),
        icons,
        merges,
    }
}

/// Push the rule at `at` running `0..len`, minus the `gaps` (merged areas it
/// would cross), as one [`Rule`] per remaining segment.
fn push_broken_rule(
    out: &mut Vec<Rule>,
    at: f64,
    len: f64,
    gaps: impl Iterator<Item = (f64, f64)>,
) {
    let mut gaps: Vec<(f64, f64)> = gaps.collect();
    if gaps.is_empty() {
        out.push(Rule {
            at,
            from: 0.0,
            to: len,
        });
        return;
    }
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

/// Column width in pt — the page lowering's own rule
/// ([`sheet_lower::col_width_pt`]), so a column matches on both surfaces.
fn col_width_pt(ws: Option<&sheet_core::Worksheet>, col: u32) -> f64 {
    sheet_lower::col_width_pt(ws, col)
}

/// Row height in pt — the page lowering's own rule.
fn row_height_pt(ws: Option<&sheet_core::Worksheet>, row: u32) -> f64 {
    sheet_lower::row_height_pt(ws, row)
}

// ---- The page side of the window (ADR 510, render on leave). ----

/// What the page table of a frame prints besides the cells.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub struct PagePrint {
    /// The heading row (A, B, C, …) and heading column (1, 2, 3, …).
    pub headings: bool,
    /// Gridlines at every track boundary.
    pub gridlines: bool,
}

/// The page table of a sheet frame: [`frame_window`] for `spec`, lowered by
/// [`sheet_lower::lower_tracks_styled`] with the workbook's styles and
/// conditional formats. Without printed headings the window is the one the
/// live grid shows for the same `spec` (the grid takes its heading strips
/// off the box before asking); with them, the heading row and column are
/// taken off `spec`'s box first, so the printed table still fits the frame.
/// The frozen rows become the table's header rows.
pub fn frame_page(
    model: &SheetModel,
    sheet: SheetId,
    spec: &FrameWindowSpec,
    print: PagePrint,
    cf: &SheetCondFmt,
    visual: &impl VisualStyleSource,
) -> sheet_lower::LoweredContent {
    frame_page_cf(model, sheet, spec, print, cf, visual, None)
}

/// [`frame_page`] with conditional formatting evaluated through `src` (W2.4,
/// the session's `sheet_calc::cf` evaluator) instead of the static rules.
pub fn frame_page_cf(
    model: &SheetModel,
    sheet: SheetId,
    spec: &FrameWindowSpec,
    print: PagePrint,
    cf: &SheetCondFmt,
    visual: &impl VisualStyleSource,
    src: Option<&dyn sheet_lower::cfdraw::CellCfSource>,
) -> sheet_lower::LoweredContent {
    let win = frame_page_window(model, sheet, spec, print.headings);
    let opts = sheet_lower::TrackOptions {
        print_headings: print.headings,
        print_gridlines: print.gridlines,
        header_rows: win.frozen_rows,
        frozen_cols: win.frozen_cols,
    };
    sheet_lower::lower_tracks_cf(model, sheet, &win.rows, &win.cols, &opts, visual, cf, src)
}

/// The window a frame's page table shows: `spec`'s box, less the printed
/// heading row and column when `headings` is set. The heading column's
/// width depends on the largest row number shown, so the window is asked
/// again (at most twice more) until that width is stable.
pub fn frame_page_window(
    model: &SheetModel,
    sheet: SheetId,
    spec: &FrameWindowSpec,
    headings: bool,
) -> FrameWindow {
    if !headings {
        return frame_window(model, sheet, spec);
    }
    let mut heading_w = sheet_lower::heading_col_width_pt(spec.top_row + 1);
    let mut win = FrameWindow {
        rows: Vec::new(),
        cols: Vec::new(),
        row_heights_pt: Vec::new(),
        col_widths_pt: Vec::new(),
        frozen_rows: 0,
        frozen_cols: 0,
        width_pt: 0.0,
        height_pt: 0.0,
        partial_row: None,
        partial_col: None,
    };
    for _ in 0..3 {
        let inner = FrameWindowSpec {
            width_pt: (spec.width_pt - heading_w).max(0.0),
            height_pt: (spec.height_pt - DEFAULT_ROW_PT).max(0.0),
            ..*spec
        };
        win = frame_window(model, sheet, &inner);
        let need =
            sheet_lower::heading_col_width_pt(win.rows.iter().map(|r| r + 1).max().unwrap_or(1));
        if need <= heading_w {
            break;
        }
        heading_w = need;
    }
    win
}

#[cfg(test)]
#[allow(non_snake_case)] // test names end in `__feat__<cockpit id>`
mod tests {
    use super::*;
    use sheet_core::{Cell, CellStyle};
    use sheet_lower::condfmt;
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
            tables: Vec::new(),
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

    // ---- the scene on the frame window (ADR 510, P2) ----

    use sheet_core::{CellRef, RangeRef, StyleId};
    use sheet_lower::VisualAttrs;

    fn merge(ws: &mut sheet_core::Worksheet, r0: u32, c0: u32, r1: u32, c1: u32) {
        let at = |row, col| CellRef {
            sheet: 0,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        ws.merges.push(RangeRef {
            start: at(r0, c0),
            end: at(r1, c1),
        });
    }

    fn styled(n: f64, style: u32) -> Cell {
        Cell {
            value: CellValue::Number(n),
            style: StyleId(style),
            ..Default::default()
        }
    }

    /// A visual source keyed by `StyleId`: 1 = bold red fill, 2 = italic
    /// wrap top, 3 = a bottom border, 4 = the same look as 1 (dedups).
    fn visual(id: StyleId) -> Option<VisualAttrs> {
        match id.0 {
            1 | 4 => Some(VisualAttrs {
                bold: true,
                fill_rgb: Some("#FF0000".into()),
                ..Default::default()
            }),
            2 => Some(VisualAttrs {
                italic: true,
                wrap: true,
                v_align: Some("top".into()),
                font_name: Some("Georgia".into()),
                font_size_pt: Some(14.0),
                ..Default::default()
            }),
            3 => Some(VisualAttrs {
                border_bottom: true,
                border_lines: sheet_lower::BorderLines {
                    bottom: Some(sheet_lower::BorderLine {
                        style: "thin".into(),
                        weight_pt: 0.75,
                        rgb: Some("#000000".into()),
                        swatch: None,
                    }),
                    ..Default::default()
                },
                ..Default::default()
            }),
            _ => None,
        }
    }

    fn wspec(top_row: u32, left_col: u32, w: f64, h: f64, fr: u32, fc: u32) -> FrameWindowSpec {
        FrameWindowSpec {
            top_row,
            left_col,
            width_pt: w,
            height_pt: h,
            freeze_rows: fr,
            freeze_cols: fc,
        }
    }

    fn styled_scene(m: &SheetModel, s: SheetId, sp: &FrameWindowSpec) -> GridScene {
        grid_scene_styled(m, s, sp, true, &[], &SheetCondFmt::default(), &visual)
    }

    #[test]
    fn sheet_grid_scene_pins_the_frozen_band_while_the_body_scrolls__feat__sheet_grid_freeze_render(
    ) {
        let (m, s) = model_with(&[
            (0, 0, text("corner")),
            (1, 3, num(1.0)),
            (40, 0, text("frozen col")),
            (40, 7, num(7.0)),
            (5, 7, num(5.0)), // scrolled away above the body
        ]);
        let scene = styled_scene(&m, s, &wspec(40, 7, 200.0, 75.0, 2, 1));
        let vp = &scene.viewport;
        assert_eq!(vp.row_indices, vec![0, 1, 40, 41, 42]);
        assert_eq!(vp.col_indices, vec![0, 7, 8, 9]);
        assert_eq!((vp.frozen_rows, vp.frozen_cols), (2, 1));
        assert_eq!((vp.first_row, vp.first_col), (40, 7));
        assert_eq!((vp.rows, vp.cols), (5, 4));
        let at: Vec<(u32, u32)> = scene.cells.iter().map(|c| (c.row, c.col)).collect();
        assert_eq!(at, vec![(0, 0), (40, 0), (40, 7)]);
        let fz = scene.freeze.unwrap();
        assert_eq!((fz.rows, fz.cols), (2, 1));
        assert_eq!(fz.frozen_height_pt, vp.y_offsets[2]);
        assert_eq!(fz.frozen_width_pt, vp.x_offsets[1]);
        assert!((fz.frozen_height_pt - 30.0).abs() < 1e-9);
        // The partial track past the print edge is named, not listed.
        assert_eq!(vp.partial_col, Some(10));
        // Comment markers find their display position through the index arrays.
        let sc = grid_scene_styled(
            &m,
            s,
            &wspec(40, 7, 200.0, 75.0, 2, 1),
            true,
            &[(40, 7), (5, 7)],
            &SheetCondFmt::default(),
            &visual,
        );
        assert_eq!(sc.comments.len(), 1);
        assert_eq!(sc.comments[0].x, vp.x_offsets[2]);
        assert_eq!(sc.comments[0].y, vp.y_offsets[2]);
    }

    #[test]
    fn sheet_grid_scene_skips_hidden_and_filtered_rows__feat__sheet_grid_inframe() {
        let (mut m, s) = model_with(&[
            (0, 0, num(0.0)),
            (1, 0, num(1.0)),
            (2, 0, num(2.0)),
            (3, 0, num(3.0)),
        ]);
        {
            let ws = m.sheet_mut(s).unwrap();
            ws.hidden_rows.insert(1);
            ws.filtered_rows.insert(2);
        }
        let scene = grid_scene(&m, s, 0, 0, 100.0, 45.0, &GridOptions::default());
        assert_eq!(scene.viewport.row_indices, vec![0, 3, 4]);
        let rows: Vec<u32> = scene.cells.iter().map(|c| c.row).collect();
        assert_eq!(rows, vec![0, 3]);
        assert_eq!(scene.gridlines.h.len(), 4);
    }

    #[test]
    fn sheet_grid_scene_skips_hidden_columns__feat__sheet_grid_inframe() {
        let (mut m, s) =
            model_with(&[(0, 0, text("a")), (0, 1, text("hidden")), (0, 2, text("c"))]);
        m.sheet_mut(s).unwrap().col_meta.push(sheet_core::ColMeta {
            min: 1,
            max: 1,
            hidden: true,
            ..Default::default()
        });
        let scene = grid_scene(&m, s, 0, 0, 100.0, 15.0, &GridOptions::default());
        assert_eq!(scene.viewport.col_indices, vec![0, 2]);
        let cols: Vec<u32> = scene.cells.iter().map(|c| c.col).collect();
        assert_eq!(cols, vec![0, 2]);
        // "a" may overflow over nothing: its neighbour (C) is occupied.
        assert_eq!(scene.cells[0].overflow_to, None);
    }

    #[test]
    fn sheet_grid_scene_resolves_real_styles_and_text_facets__feat__sheet_style_mapping() {
        let (mut m, s) = model_with(&[
            (0, 0, styled(1.0, 1)),
            (0, 1, styled(2.0, 4)),
            (
                1,
                0,
                Cell {
                    value: CellValue::from("wrapped"),
                    style: StyleId(2),
                    ..Default::default()
                },
            ),
            (1, 1, styled(3.0, 0)),
        ]);
        // A styled EMPTY cell still paints (its border).
        m.sheet_mut(s).unwrap().set_cell(
            2,
            0,
            Cell {
                style: StyleId(3),
                ..Default::default()
            },
        );
        let scene = styled_scene(&m, s, &wspec(0, 0, 300.0, 100.0, 0, 0));
        let cell = |r: u32, c: u32| {
            scene
                .cells
                .iter()
                .find(|x| x.row == r && x.col == c)
                .unwrap()
        };
        assert_eq!(cell(0, 0).style_key, 1);
        assert_eq!(cell(0, 1).style_key, 1, "same look → same key");
        assert_eq!(cell(1, 0).style_key, 2);
        assert!(cell(1, 0).wrap);
        assert_eq!(cell(1, 0).v_align.as_deref(), Some("top"));
        assert_eq!(cell(1, 1).style_key, 0);
        assert_eq!(cell(2, 0).style_key, 3);
        assert_eq!(cell(2, 0).text, "");
        let st = &scene.styles;
        assert_eq!(st.len(), 4);
        assert!(st[1].bold && st[1].fill_rgb.as_deref() == Some("#FF0000"));
        assert_eq!(st[2].font_name.as_deref(), Some("Georgia"));
        assert!(st[3].border_lines.bottom.is_some());
    }

    #[test]
    fn sheet_grid_scene_styles_equal_the_page_lowering__feat__sheet_style_mapping() {
        let (mut m, s) = model_with(&[]);
        {
            let ws = m.sheet_mut(s).unwrap();
            for r in 0..12 {
                for c in 0..6 {
                    if (r * 7 + c * 3) % 5 != 0 {
                        ws.set_cell(r, c, styled((r * 10 + c) as f64, (r + c) % 5));
                    }
                }
            }
            ws.hidden_rows.insert(4);
        }
        let cf = SheetCondFmt {
            tables: Vec::new(),
            blocks: vec![condfmt::CfBlock {
                ranges: vec![(0, 2, 11, 2)],
                rules: vec![condfmt::CfRule {
                    kind: condfmt::CfRuleKind::ColorScale(condfmt::ColorScale {
                        stops: vec![
                            condfmt::ScaleStop {
                                value: None,
                                rgb: (255, 255, 255),
                            },
                            condfmt::ScaleStop {
                                value: None,
                                rgb: (0, 128, 0),
                            },
                        ],
                    }),
                    priority: 1,
                    dxf: VisualAttrs::default(),
                }],
            }],
        };
        let sp = wspec(1, 1, 200.0, 120.0, 0, 0);
        let scene = grid_scene_styled(&m, s, &sp, true, &[], &cf, &visual);
        let vp = &scene.viewport;
        let range = sheet_lower::CellRange {
            r0: vp.row_indices[0],
            c0: vp.col_indices[0],
            r1: *vp.row_indices.last().unwrap(),
            c1: *vp.col_indices.last().unwrap(),
        };
        let page = sheet_lower::lower_range_condfmt(
            &m,
            s,
            range,
            &sheet_lower::ViewOptions::default(),
            &visual,
            &cf,
        );
        assert_eq!(scene.styles, page.styles);
        assert_page_parity(&scene, &page);
    }

    /// Every grid cell has the page cell's text, alignment and style key at
    /// the same sheet position (`page` lowers the window's bounding range).
    fn assert_page_parity(scene: &GridScene, page: &sheet_lower::LoweredContent) {
        let vp = &scene.viewport;
        let (r0, c0) = (vp.row_indices[0], vp.col_indices[0]);
        for cell in &scene.cells {
            let row = page
                .rows
                .iter()
                .find(|row| row.index == cell.row - r0)
                .expect("row lowered");
            let pc = row
                .cells
                .iter()
                .find(|pc| pc.col == cell.col - c0)
                .expect("column lowered");
            assert_eq!(cell.text, pc.text, "text at {:?}", (cell.row, cell.col));
            assert_eq!(cell.align, pc.align);
            assert_eq!(cell.style_key, pc.style_key);
            assert_eq!(
                scene.styles[cell.style_key as usize],
                page.styles[pc.style_key as usize]
            );
        }
        // And no styled page cell is missing from the grid.
        for row in &page.rows {
            for pc in &row.cells {
                if pc.style_key != 0 || !pc.text.is_empty() {
                    let (r, c) = (row.index + r0, pc.col + c0);
                    assert!(
                        scene.cells.iter().any(|g| g.row == r && g.col == c),
                        "page cell {r},{c} missing from the grid"
                    );
                }
            }
        }
    }

    #[test]
    fn sheet_grid_scene_merges_carry_the_anchor_and_break_gridlines__feat__sheet_grid_inframe() {
        let (mut m, s) = model_with(&[(
            1,
            1,
            Cell {
                value: CellValue::from("Merged"),
                style: StyleId(1),
                ..Default::default()
            },
        )]);
        merge(m.sheet_mut(s).unwrap(), 1, 1, 2, 2);
        let scene = styled_scene(&m, s, &wspec(0, 0, 200.0, 60.0, 0, 0));
        assert!(scene.cells.is_empty(), "the anchor rides on the merge");
        assert_eq!(scene.merges.len(), 1);
        let mg = &scene.merges[0];
        let vp = &scene.viewport;
        assert_eq!((mg.row, mg.col, mg.row_span, mg.col_span), (1, 1, 2, 2));
        assert_eq!((mg.x, mg.y), (vp.x_offsets[1], vp.y_offsets[1]));
        assert_eq!(mg.w, vp.x_offsets[3] - vp.x_offsets[1]);
        assert_eq!(mg.h, 30.0);
        assert_eq!(mg.text, "Merged");
        assert_eq!(mg.style_key, 1);
        // The h rule between rows 1 and 2 (y = 30) is broken around the merge.
        let mid: Vec<&Rule> = scene.gridlines.h.iter().filter(|r| r.at == 30.0).collect();
        assert_eq!(mid.len(), 2);
        assert_eq!(mid[0].to, vp.x_offsets[1]);
        assert_eq!(mid[1].from, vp.x_offsets[3]);
        let vmid: Vec<&Rule> = scene
            .gridlines
            .v
            .iter()
            .filter(|r| r.at == vp.x_offsets[2])
            .collect();
        assert_eq!(vmid.len(), 2);
        // Outer edges stay whole.
        assert_eq!(scene.gridlines.h.iter().filter(|r| r.at == 15.0).count(), 1);
    }

    #[test]
    fn sheet_grid_scene_merge_split_by_the_frozen_band_and_scrolled_anchor__feat__sheet_grid_inframe(
    ) {
        let (mut m, s) = model_with(&[(0, 0, text("Title"))]);
        {
            let ws = m.sheet_mut(s).unwrap();
            merge(ws, 0, 0, 0, 5); // across the frozen column split
            merge(ws, 10, 3, 30, 3); // anchor scrolled above the body
            ws.set_cell(10, 3, styled(9.0, 2));
        }
        let scene = styled_scene(&m, s, &wspec(20, 3, 300.0, 120.0, 1, 1));
        let title: Vec<&GridMerge> = scene.merges.iter().filter(|g| g.row == 0).collect();
        assert_eq!(title.len(), 2, "one rect per side of the split");
        assert!(title.iter().all(|g| g.text == "Title"));
        assert_eq!(title[0].x, 0.0);
        assert_eq!(title[1].x, scene.viewport.x_offsets[1]);
        let tall = scene.merges.iter().find(|g| g.row == 10).unwrap();
        assert_eq!(tall.text, "9");
        assert!(scene.styles[tall.style_key as usize].italic);
        assert!(tall.wrap);
        // Its visible part starts at the first body row (row 20).
        assert_eq!(tall.y, scene.viewport.y_offsets[1]);
    }

    #[test]
    fn sheet_grid_scene_text_overflow_hints__feat__sheet_grid_inframe() {
        let right = |s: &str| {
            let mut m = SheetModel::new();
            let style = m.styles.intern_style(CellStyle {
                align: Align::Right,
                ..Default::default()
            });
            (
                Cell {
                    value: CellValue::from(s),
                    style,
                    ..Default::default()
                },
                m,
            )
        };
        let (mut m, s) = model_with(&[
            (0, 0, text("a long label")),
            (0, 3, text("stop")),
            (1, 0, num(123456789.0)), // numbers never overflow
            (2, 0, text("x")),
            (2, 1, text("neighbour")),
            (3, 4, text("last col")),
        ]);
        let (rc, rm) = right("right side");
        m.styles = rm.styles;
        m.sheet_mut(s).unwrap().set_cell(4, 3, rc);
        let scene = grid_scene(&m, s, 0, 0, 230.0, 90.0, &GridOptions::default());
        let ov = |r: u32, c: u32| {
            scene
                .cells
                .iter()
                .find(|x| x.row == r && x.col == c)
                .unwrap()
                .overflow_to
        };
        assert_eq!(scene.viewport.cols, 5);
        assert_eq!(ov(0, 0), Some(2), "spills into B and C, stops before D");
        assert_eq!(ov(0, 3), Some(4), "to the window edge");
        assert_eq!(ov(1, 0), None);
        assert_eq!(ov(2, 0), None, "occupied neighbour");
        assert_eq!(ov(3, 4), None, "already at the edge");
        assert_eq!(ov(4, 3), Some(0), "right-aligned spills left");
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"overflowTo\":2"));
        assert!(json.contains("\"rowIndices\"") && json.contains("\"frozenRows\":0"));
    }

    /// Work stays O(visible cells): the per-cell styler is asked exactly once
    /// per visible populated cell of a 50-column × 200-row window over a
    /// large sheet, wherever the window sits.
    #[test]
    fn sheet_grid_scene_work_is_visible_cells_only__feat__sheet_grid_inframe() {
        use std::cell::Cell as Counter;
        let (mut m, s) = model_with(&[]);
        {
            let ws = m.sheet_mut(s).unwrap();
            for r in 0..3000 {
                for c in 0..80 {
                    ws.set_cell(r, c, styled(1.0, 1 + (r + c) % 3));
                }
            }
        }
        // A cf block far away forces the per-cell (uncached) style path.
        let cf = SheetCondFmt {
            tables: Vec::new(),
            blocks: vec![condfmt::CfBlock {
                ranges: vec![(900_000, 0, 900_000, 0)],
                rules: vec![],
            }],
        };
        let calls = Counter::new(0u32);
        let counting = |id: StyleId| {
            calls.set(calls.get() + 1);
            visual(id)
        };
        // 50 default columns × 200 default rows, plus a frozen band.
        let (w, h) = (50.0 * 44.2575 + 1.0, 200.0 * 15.0 + 1.0);
        for (top, left) in [(0, 0), (1400, 20), (2790, 30)] {
            calls.set(0);
            let scene = grid_scene_styled(
                &m,
                s,
                &wspec(top, left, w, h, 2, 1),
                true,
                &[],
                &cf,
                &counting,
            );
            let visible = scene.viewport.rows * scene.viewport.cols;
            assert_eq!(
                scene.cells.len() as u32,
                visible.min(scene.cells.len() as u32)
            );
            assert_eq!(
                calls.get(),
                scene.cells.len() as u32,
                "one style lookup per visible cell"
            );
            assert!(scene.cells.len() <= 200 * 50);
        }
    }
}
