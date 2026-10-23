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

//! # The per-cell styler — ONE style path for the page and the grid
//!
//! [`CellStyler`] is what both surfaces call for every populated cell they
//! show: the page lowering ([`crate::lower_range_condfmt`] and the styled
//! door) and the live grid scene (`sheet_grid::grid_scene_styled`). It
//! resolves the cell's base visual style through a [`VisualStyleSource`],
//! folds conditional formatting on top (dxf rules, colour scales), interns
//! the effective style into a deduplicated [`LoweredStyle`] table and hands
//! back the cell's `style_key`. It also answers the data-bar geometry
//! question for the same cell, against the same memoized cf domains.
//!
//! Keys are positional: the n-th distinct effective style seen gets key n
//! (key 0 is always the default). Two walks over the same cells in the same
//! order therefore produce the same keys and the same table — which is how
//! the grid's style keys equal the page lowering's for the same window.

use crate::condfmt::{self, CfRange, SheetCondFmt};
use crate::style::{VisualAttrs, VisualStyleSource};
use crate::LoweredStyle;
use sheet_core::{Cell, CellValue, StyleId, Worksheet};
use sheet_format::FormatColor;
use std::collections::HashMap;

/// Resolves cells to `style_key`s over one deduplicated styles table (see the
/// module docs). A cell whose style needs nothing beyond its `StyleId` (no
/// format colour, no conditional formatting) is cached by `StyleId`; every
/// other cell's effective style (base, then the number format's colour, then
/// the winning cf override) is interned by content into the same table.
pub struct CellStyler<'a, S: VisualStyleSource> {
    visual: &'a S,
    cf: &'a SheetCondFmt,
    ws: Option<&'a Worksheet>,
    /// The output table; index == key, entry 0 the default.
    styles: Vec<LoweredStyle>,
    /// Effective style (minus its key) -> key.
    dedup: HashMap<StyleKeyless, u32>,
    /// `StyleId` -> key for cells with no override.
    by_style_id: HashMap<u32, u32>,
    /// cf range -> the numeric `(min, max)` of its cells, memoized.
    domains: HashMap<CfRange, Option<(f64, f64)>>,
}

impl<'a, S: VisualStyleSource> CellStyler<'a, S> {
    /// A styler over `ws` (the sheet the cells come from — needed for cf
    /// domains), resolving base styles through `visual` and folding `cf`.
    pub fn new(visual: &'a S, cf: &'a SheetCondFmt, ws: Option<&'a Worksheet>) -> Self {
        CellStyler {
            visual,
            cf,
            ws,
            styles: vec![LoweredStyle::default_key0()],
            dedup: HashMap::new(),
            by_style_id: HashMap::new(),
            domains: HashMap::new(),
        }
    }

    /// The `style_key` of the cell at sheet `(row, col)`.
    pub fn key_for_cell(&mut self, row: u32, col: u32, cell: &Cell) -> u32 {
        self.key_for_display(row, col, cell, None)
    }

    /// The `style_key` of the cell at sheet `(row, col)` whose number format
    /// asked for `format_color` (a `[Red]` / `[ColorN]` bracket on the section
    /// it rendered with). The format colour replaces the font colour; a
    /// conditional format's font colour wins over it (Excel's order).
    pub fn key_for_display(
        &mut self,
        row: u32,
        col: u32,
        cell: &Cell,
        format_color: Option<FormatColor>,
    ) -> u32 {
        let table = self.table_attrs(row, col);
        if self.cf.is_empty() && format_color.is_none() && table.is_none() {
            return self.key_for_style(cell.style);
        }
        let mut base = self.visual.visual(cell.style).unwrap_or_default();
        if let Some(t) = &table {
            base = crate::table_band::under(t, &base);
        }
        if let Some(c) = format_color {
            base.text_rgb = Some(self.visual.format_color_rgb(c));
        }
        let effective = if self.cf.is_empty() {
            base
        } else {
            let (cf, ws, domains) = (self.cf, self.ws, &mut self.domains);
            match condfmt::override_for(cf, row, col, &cell.value, &mut |rng| {
                domain(ws, rng, domains)
            }) {
                Some(over) => condfmt::fold_override(&base, &over),
                None => base,
            }
        };
        self.intern(effective)
    }

    /// The table style at sheet `(row, col)`, if a table covers it.
    fn table_attrs(&self, row: u32, col: u32) -> Option<VisualAttrs> {
        self.cf.tables.iter().find_map(|b| b.attrs_at(row, col))
    }

    /// The `style_key` of an EMPTY cell at sheet `(row, col)`: the table
    /// style when a table covers it (Excel bands empty table cells too),
    /// else the default key 0.
    pub fn key_for_empty(&mut self, row: u32, col: u32) -> u32 {
        match self.table_attrs(row, col) {
            Some(t) => self.intern(t),
            None => 0,
        }
    }

    /// The key of a bare `StyleId` (no format colour, no cf).
    fn key_for_style(&mut self, id: StyleId) -> u32 {
        if let Some(&k) = self.by_style_id.get(&id.0) {
            return k;
        }
        let attrs = self.visual.visual(id).unwrap_or_default();
        let key = self.intern(attrs);
        self.by_style_id.insert(id.0, key);
        key
    }

    /// The data bar to draw in the cell at sheet `(row, col)`, if any:
    /// `(fill_fraction, rgb)` (see [`condfmt::databar_for`]).
    pub fn databar(&mut self, row: u32, col: u32, cell: &Cell) -> Option<(f64, (u8, u8, u8))> {
        if self.cf.is_empty() {
            return None;
        }
        let (cf, ws, domains) = (self.cf, self.ws, &mut self.domains);
        condfmt::databar_for(cf, row, col, &cell.value, &mut |rng| {
            domain(ws, rng, domains)
        })
    }

    /// The finished styles table (index == key; entry 0 is the default).
    pub fn into_styles(self) -> Vec<LoweredStyle> {
        self.styles
    }

    /// Intern an effective [`VisualAttrs`], deduping by content (a default
    /// style is key 0).
    fn intern(&mut self, attrs: VisualAttrs) -> u32 {
        if attrs.is_default() {
            return 0;
        }
        let lowered = attrs.into_lowered(0);
        let dk = StyleKeyless::of(&lowered);
        if let Some(&existing) = self.dedup.get(&dk) {
            return existing;
        }
        let new_key = self.styles.len() as u32;
        self.styles.push(LoweredStyle {
            key: new_key,
            ..lowered
        });
        self.dedup.insert(dk, new_key);
        new_key
    }
}

/// The numeric `(min, max)` over a cf range's cells, memoized; `None` when the
/// range holds no number. Walks the sparse cell map over the range's row band
/// (O(populated cells in those rows)), never the range's area, so a whole-
/// column rule (`A:A`) costs the cells that exist, not a million lookups.
fn domain(
    ws: Option<&Worksheet>,
    rng: CfRange,
    cache: &mut HashMap<CfRange, Option<(f64, f64)>>,
) -> Option<(f64, f64)> {
    if let Some(&hit) = cache.get(&rng) {
        return hit;
    }
    let (r0, c0, r1, c1) = rng;
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    if let Some(ws) = ws {
        for (&(_, c), cell) in ws.cells.range((r0, c0)..=(r1, c1)) {
            if c < c0 || c > c1 {
                continue;
            }
            if let CellValue::Number(n) = cell.value {
                lo = lo.min(n);
                hi = hi.max(n);
            }
        }
    }
    let out = (lo.is_finite() && hi.is_finite()).then_some((lo, hi));
    cache.insert(rng, out);
    out
}

/// A [`LoweredStyle`] without its positional `key` (the dedup map key).
#[derive(Clone, PartialEq, Eq, Hash)]
struct StyleKeyless {
    bold: bool,
    italic: bool,
    font_size_bits: Option<u64>,
    font_name: Option<String>,
    fill_rgb: Option<String>,
    text_rgb: Option<String>,
    border_top: bool,
    border_right: bool,
    border_bottom: bool,
    border_left: bool,
    /// The Wave 6 facets (underline, vertical alignment, wrap, border
    /// lines), keyed by their debug rendering (f64 weights have no `Hash`).
    extra: String,
}

impl StyleKeyless {
    fn of(s: &LoweredStyle) -> Self {
        StyleKeyless {
            bold: s.bold,
            italic: s.italic,
            font_size_bits: s.font_size_pt.map(f64::to_bits),
            font_name: s.font_name.clone(),
            fill_rgb: s.fill_rgb.clone(),
            text_rgb: s.text_rgb.clone(),
            border_top: s.border_top,
            border_right: s.border_right,
            border_bottom: s.border_bottom,
            border_left: s.border_left,
            extra: format!("{:?}", (s.underline, &s.v_align, s.wrap, &s.border_lines)),
        }
    }
}
