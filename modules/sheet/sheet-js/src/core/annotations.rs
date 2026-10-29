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

//! Hyperlinks, notes and pictures through the session (W2.3, sheet ADR 526).
//!
//! - Hyperlinks: listed, set and removed per range; the write rewrites the
//!   worksheet's `<hyperlinks>` and its external relationships
//!   (`sheet_xlsx::links`). A new link gives its cells Excel's `Hyperlink`
//!   cell style, as Excel's Insert Link does. The grid gets one clickable
//!   rect per visible linked cell.
//! - Notes: set (add or replace) and delete, written into the comments part
//!   and the VML drawing together (`sheet_xlsx::comment_edit`); the note of
//!   a cell with a threaded comment is refused.
//! - Pictures: drawing pictures and images in cells, read on demand
//!   (`sheet_xlsx::parts::pictures`), placed in sheet points; the bytes come
//!   by media part name. The grid gets the pictures that show in the
//!   viewport.

use sheet_core::condfmt::CfRange;
use sheet_core::Worksheet;
use sheet_xlsx::links::HyperlinkSpec;
use sheet_xlsx::parts::pictures::{PictureAnchor, EMU_PER_PT};

use super::protect::Allow;
use super::{SessionError, SheetSession};

/// One hyperlink of a sheet.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HyperlinkInfo {
    pub sheet: u16,
    /// The cells it covers, A1 (`B2` or `B2:C4`).
    pub range: String,
    pub url: Option<String>,
    pub location: Option<String>,
    pub display: Option<String>,
    pub tooltip: Option<String>,
}

/// What a hyperlink points to (`set_hyperlink`).
#[derive(serde::Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HyperlinkArg {
    pub url: Option<String>,
    pub location: Option<String>,
    pub display: Option<String>,
    pub tooltip: Option<String>,
}

/// One picture of a sheet, placed in sheet points (the top-left of A1 is
/// the origin).
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PictureInfo {
    pub id: String,
    pub sheet: u16,
    pub name: String,
    pub descr: Option<String>,
    /// The media part (`picture_bytes` takes it).
    pub media: String,
    pub content_type: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// An image placed in a cell (fitted into the cell's box).
    pub in_cell: bool,
    /// The cell an image in a cell sits in, or a drawing picture's top-left
    /// cell.
    pub row: u32,
    pub col: u32,
    /// The picture's top-left inside that cell (pt).
    pub dx: f64,
    pub dy: f64,
    /// A drawing picture's opacity and effects as the shared DrawingML
    /// mapper lowers them (sheet ADR 527).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fx: Option<sheet_chart::native::NativeFx>,
    /// What the page cannot hold of its look, one line per kind.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub losses: Vec<String>,
}

/// The sheet x of a column's left edge (hidden columns take no room).
pub(crate) fn sheet_x(ws: Option<&Worksheet>, col: u32) -> f64 {
    (0..col)
        .filter(|&c| !ws.is_some_and(|w| w.col_hidden(c)))
        .map(|c| sheet_lower::tracks::col_width_pt(ws, c))
        .sum()
}

/// The sheet y of a row's top edge (hidden rows take no room).
pub(crate) fn sheet_y(ws: Option<&Worksheet>, row: u32) -> f64 {
    let d = sheet_lower::DEFAULT_ROW_PT;
    let Some(w) = ws else {
        return f64::from(row) * d;
    };
    let mut y = f64::from(row) * d;
    for &h in w.row_heights.range(..row).map(|(_, h)| h) {
        y += h - d;
    }
    let hidden: std::collections::BTreeSet<u32> = w
        .hidden_rows
        .range(..row)
        .chain(w.filtered_rows.range(..row))
        .copied()
        .collect();
    for r in hidden {
        y -= sheet_lower::tracks::row_height_pt(Some(w), r);
    }
    y
}

/// One picture placed over a page table (`LoweredContent.pictures` on the
/// wire): its anchor cell (sheet indices), the offset in it, its size and
/// the image as a `data:` URI.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PagePicture {
    pub id: String,
    pub row: u32,
    pub col: u32,
    pub dx: f64,
    pub dy: f64,
    pub w_pt: f64,
    pub h_pt: f64,
    pub in_cell: bool,
    pub uri: String,
    /// Opacity and effects (sheet ADR 527).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fx: Option<sheet_chart::native::NativeFx>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub losses: Vec<String>,
}

/// Lowered page content with the pictures anchored in its cells.
#[derive(serde::Serialize, Debug)]
pub struct PageContent<'a> {
    #[serde(flatten)]
    pub content: &'a sheet_lower::LoweredContent,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pictures: Vec<PagePicture>,
}

/// Standard base64 (RFC 4648, padded).
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn range_a1(r: &CfRange) -> String {
    sheet_xlsx::cf_edit::range_a1(r)
}

impl SheetSession {
    fn resolve_cf_range(&self, sheet: u16, range: &str) -> Result<(u16, CfRange), SessionError> {
        let (sheet, cr) = self.resolve_range(sheet, range)?;
        Ok((sheet, super::format::bounds(&cr)))
    }

    /// The hyperlinks of a sheet, in file order.
    pub fn list_hyperlinks(&self, sheet: u16) -> Result<Vec<HyperlinkInfo>, SessionError> {
        self.validate_sheet(sheet)?;
        Ok(self
            .doc
            .hyperlinks_of(sheet)
            .into_iter()
            .map(|h| HyperlinkInfo {
                sheet,
                range: range_a1(&h.range),
                url: h.url,
                location: h.location,
                display: h.display,
                tooltip: h.tooltip,
            })
            .collect())
    }

    /// Link a range: replaces any link over its first cell. The cells take
    /// Excel's `Hyperlink` cell style.
    pub fn set_hyperlink(
        &mut self,
        sheet: u16,
        range: &str,
        link: HyperlinkArg,
    ) -> Result<(), SessionError> {
        let (sheet, r) = self.resolve_cf_range(sheet, range)?;
        self.guard_allow(sheet, Allow::InsertHyperlinks)?;
        self.write_hyperlink(sheet, r, &link)?;
        self.set_style(
            sheet,
            &range_a1(&r),
            super::format::StylePatchArg {
                named_style: Some("Hyperlink".into()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    fn write_hyperlink(
        &mut self,
        sheet: u16,
        r: CfRange,
        link: &HyperlinkArg,
    ) -> Result<(), SessionError> {
        self.doc
            .set_hyperlink(
                sheet,
                r,
                &HyperlinkSpec {
                    url: link.url.clone(),
                    location: link.location.clone(),
                    display: link.display.clone(),
                    tooltip: link.tooltip.clone(),
                },
            )
            .map_err(|e| SessionError(e.to_string()))?;
        self.extra_dirty.insert(sheet);
        Ok(())
    }

    /// Remove every link touching a range; returns how many.
    pub fn remove_hyperlinks(&mut self, sheet: u16, range: &str) -> Result<u32, SessionError> {
        let (sheet, r) = self.resolve_cf_range(sheet, range)?;
        self.guard_allow(sheet, Allow::InsertHyperlinks)?;
        let n = self
            .doc
            .remove_hyperlinks(sheet, r)
            .map_err(|e| SessionError(e.to_string()))?;
        if n > 0 {
            self.extra_dirty.insert(sheet);
        }
        Ok(n as u32)
    }

    /// Put back a `list_hyperlinks` result (undo): the sheet's links become
    /// exactly these.
    pub fn restore_hyperlinks(
        &mut self,
        sheet: u16,
        links: Vec<HyperlinkInfo>,
    ) -> Result<(), SessionError> {
        self.validate_sheet(sheet)?;
        self.doc
            .remove_hyperlinks(sheet, (0, 0, sheet_core::MAX_ROW, sheet_core::MAX_COL))
            .map_err(|e| SessionError(e.to_string()))?;
        for l in links {
            let (_, r) = self.resolve_cf_range(sheet, &l.range)?;
            self.write_hyperlink(
                sheet,
                r,
                &HyperlinkArg {
                    url: l.url,
                    location: l.location,
                    display: l.display,
                    tooltip: l.tooltip,
                },
            )?;
        }
        self.extra_dirty.insert(sheet);
        Ok(())
    }

    /// Set the note of a cell (adds it, or replaces its text and author).
    pub fn set_note(
        &mut self,
        sheet: u16,
        row: u32,
        col: u32,
        author: &str,
        text: &str,
    ) -> Result<(), SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_allow(sheet, Allow::EditObjects)?;
        self.doc
            .set_note(sheet, row, col, author, text)
            .map_err(|e| SessionError(e.to_string()))?;
        self.extra_dirty.insert(sheet);
        Ok(())
    }

    /// Delete the note of a cell; `false` when it has none.
    pub fn delete_note(&mut self, sheet: u16, row: u32, col: u32) -> Result<bool, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_allow(sheet, Allow::EditObjects)?;
        let gone = self
            .doc
            .delete_note(sheet, row, col)
            .map_err(|e| SessionError(e.to_string()))?;
        if gone {
            self.extra_dirty.insert(sheet);
        }
        Ok(gone)
    }

    /// The pictures of a sheet, placed in sheet points.
    pub fn list_pictures(&self, sheet: u16) -> Result<Vec<PictureInfo>, SessionError> {
        self.validate_sheet(sheet)?;
        let ws = self.engine().model().sheets.get(sheet as usize);
        let at = |o: &sheet_xlsx::parts::pictures::CellOffset| {
            (
                sheet_x(ws, o.col) + o.col_off as f64 / EMU_PER_PT,
                sheet_y(ws, o.row) + o.row_off as f64 / EMU_PER_PT,
            )
        };
        Ok(self
            .doc
            .pictures_of(sheet)
            .into_iter()
            .map(|p| {
                let (dx, dy) = match p.anchor {
                    PictureAnchor::TwoCell { from, .. } | PictureAnchor::OneCell { from, .. } => (
                        from.col_off as f64 / EMU_PER_PT,
                        from.row_off as f64 / EMU_PER_PT,
                    ),
                    PictureAnchor::Absolute { x, y, .. } => {
                        (x as f64 / EMU_PER_PT, y as f64 / EMU_PER_PT)
                    }
                    PictureAnchor::InCell { .. } => (0.0, 0.0),
                };
                let (x, y, w, h, row, col, in_cell) = match p.anchor {
                    PictureAnchor::TwoCell { from, to } => {
                        let (x0, y0) = at(&from);
                        let (x1, y1) = at(&to);
                        (
                            x0,
                            y0,
                            (x1 - x0).max(0.0),
                            (y1 - y0).max(0.0),
                            from.row,
                            from.col,
                            false,
                        )
                    }
                    PictureAnchor::OneCell { from, cx, cy } => {
                        let (x0, y0) = at(&from);
                        let (w, h) = (cx as f64 / EMU_PER_PT, cy as f64 / EMU_PER_PT);
                        (x0, y0, w, h, from.row, from.col, false)
                    }
                    PictureAnchor::Absolute { x, y, cx, cy } => (
                        x as f64 / EMU_PER_PT,
                        y as f64 / EMU_PER_PT,
                        cx as f64 / EMU_PER_PT,
                        cy as f64 / EMU_PER_PT,
                        0,
                        0,
                        false,
                    ),
                    PictureAnchor::InCell { row, col } => {
                        let x0 = sheet_x(ws, col);
                        let y0 = sheet_y(ws, row);
                        let w = sheet_lower::tracks::col_width_pt(ws, col);
                        let h = sheet_lower::tracks::row_height_pt(ws, row);
                        (x0, y0, w, h, row, col, true)
                    }
                };
                let (fx, losses) = match p.dml.as_deref() {
                    Some(d) => sheet_chart::native::picture_fx(
                        &self
                            .doc
                            .chart_theme
                            .unwrap_or(sheet_chart::colors::OFFICE_THEME),
                        &d.blip,
                        &d.effects,
                    ),
                    None => (None, Vec::new()),
                };
                PictureInfo {
                    fx,
                    losses,
                    id: p.id,
                    sheet,
                    name: p.name,
                    descr: p.descr,
                    media: p.media,
                    content_type: p.content_type,
                    x,
                    y,
                    w,
                    h,
                    in_cell,
                    row,
                    col,
                    dx,
                    dy,
                }
            })
            .collect())
    }

    /// The bytes of a picture's media part.
    pub fn picture_bytes(&self, media: &str) -> Result<Vec<u8>, SessionError> {
        self.doc
            .media_bytes(media)
            .ok_or_else(|| SessionError(format!("no picture {media:?}")))
    }

    /// The pictures anchored in a page lowering's cells (tracks and frame
    /// pages: sheet indices), with their images as `data:` URIs.
    pub fn page_pictures(
        &self,
        sheet: u16,
        content: &sheet_lower::LoweredContent,
    ) -> Vec<PagePicture> {
        let Ok(list) = self.list_pictures(sheet) else {
            return Vec::new();
        };
        let rows: std::collections::BTreeSet<u32> = content.rows.iter().map(|r| r.index).collect();
        let cols: std::collections::BTreeSet<u32> = content.cols.iter().map(|c| c.index).collect();
        list.into_iter()
            .filter(|p| rows.contains(&p.row) && cols.contains(&p.col))
            .filter_map(|p| {
                let bytes = self.doc.media_bytes(&p.media)?;
                Some(PagePicture {
                    uri: format!("data:{};base64,{}", p.content_type, base64(&bytes)),
                    id: p.id,
                    row: p.row,
                    col: p.col,
                    dx: p.dx,
                    dy: p.dy,
                    w_pt: p.w,
                    h_pt: p.h,
                    in_cell: p.in_cell,
                    fx: p.fx,
                    losses: p.losses,
                })
            })
            .collect()
    }

    /// Fold the sheet's links and pictures into a grid scene.
    pub(crate) fn add_grid_annotations(&self, sheet: u16, scene: &mut sheet_grid::GridScene) {
        let vp = &scene.viewport;
        for h in self.doc.hyperlinks_of(sheet) {
            for &row in &vp.row_indices {
                if row < h.range.0 || row > h.range.2 {
                    continue;
                }
                for &col in &vp.col_indices {
                    if col < h.range.1 || col > h.range.3 {
                        continue;
                    }
                    if let Some((x, y, w, hh)) = vp.cell_box(row, col) {
                        scene.links.push(sheet_grid::GridLink {
                            row,
                            col,
                            x,
                            y,
                            w,
                            h: hh,
                            url: h.url.clone(),
                            location: h.location.clone(),
                            tooltip: h.tooltip.clone(),
                        });
                    }
                }
            }
        }
        let Ok(pictures) = self.list_pictures(sheet) else {
            return;
        };
        if pictures.is_empty() || vp.col_indices.is_empty() || vp.row_indices.is_empty() {
            return;
        }
        let ws = self.engine().model().sheets.get(sheet as usize);
        // The scrolled pane starts at its first shown track; the frozen one
        // at the sheet's origin.
        let fc = vp.frozen_cols as usize;
        let fr = vp.frozen_rows as usize;
        let scroll_x0 = vp
            .col_indices
            .get(fc)
            .map(|&c| (vp.x_offsets[fc], sheet_x(ws, c)));
        let scroll_y0 = vp
            .row_indices
            .get(fr)
            .map(|&r| (vp.y_offsets[fr], sheet_y(ws, r)));
        let (vw, vh) = (
            *vp.x_offsets.last().unwrap_or(&0.0),
            *vp.y_offsets.last().unwrap_or(&0.0),
        );
        for p in pictures {
            let x = match scroll_x0 {
                Some((local, abs)) if p.col >= vp.frozen_cols => local + p.x - abs,
                _ => p.x,
            };
            let y = match scroll_y0 {
                Some((local, abs)) if p.row >= vp.frozen_rows => local + p.y - abs,
                _ => p.y,
            };
            if x + p.w <= 0.0 || y + p.h <= 0.0 || x >= vw || y >= vh {
                continue;
            }
            scene.pictures.push(sheet_grid::GridPicture {
                id: p.id,
                media: p.media,
                content_type: p.content_type,
                x,
                y,
                w: p.w,
                h: p.h,
                in_cell: p.in_cell,
            });
        }
    }
}
