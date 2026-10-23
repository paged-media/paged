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

use crate::cfdraw::{BarDraw, CellCf, CellCfSource, IconDraw, VisualDelta};
use crate::condfmt::{self, CfRange, SheetCondFmt};
use crate::style::{StyleKeyless, VisualAttrs, VisualStyleSource};
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
    /// The evaluated conditional formatting (W2.4, `sheet_calc::cf`); when
    /// set it replaces the static rules of `cf.blocks` (tables stay).
    src: Option<&'a dyn CellCfSource>,
    /// The last cell's outcome (key, bar, icon and text ask for the same).
    last: Option<((u32, u32), Option<CellCf>)>,
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
            src: None,
            last: None,
        }
    }

    /// Evaluate conditional formatting through `src` (the session's
    /// evaluator) instead of the static rules.
    pub fn with_cf_source(mut self, src: Option<&'a dyn CellCfSource>) -> Self {
        self.src = src;
        self
    }

    /// Whether any conditional format is on the sheet.
    fn has_cf(&self) -> bool {
        match self.src {
            Some(s) => !s.is_empty(),
            None => !self.cf.is_empty(),
        }
    }

    /// The cell's conditional formatting (memoized for the last cell).
    pub fn cf_outcome(&mut self, row: u32, col: u32, cell: &Cell) -> Option<CellCf> {
        if !self.has_cf() {
            return None;
        }
        if let Some((at, out)) = &self.last {
            if *at == (row, col) {
                return out.clone();
            }
        }
        let out = match self.src {
            Some(s) => s.cell_cf(row, col, &cell.value),
            None => self.static_cf(row, col, &cell.value),
        };
        self.last = Some(((row, col), out.clone()));
        out
    }

    /// The static rules' outcome (the 2006 subset `condfmt` evaluates).
    fn static_cf(&mut self, row: u32, col: u32, value: &CellValue) -> Option<CellCf> {
        let (cf, ws, domains) = (self.cf, self.ws, &mut self.domains);
        let over = condfmt::override_for(cf, row, col, value, &mut |rng| domain(ws, rng, domains));
        let bar = condfmt::databar_for(cf, row, col, value, &mut |rng| domain(ws, rng, domains));
        if over.is_none() && bar.is_none() {
            return None;
        }
        let delta = over.map(|o| VisualDelta {
            bold: o.bold.then_some(true),
            italic: o.italic.then_some(true),
            underline: o.underline.then_some(true),
            strike: o.strike.then_some(true),
            font_size_pt: o.font_size_pt,
            font_name: o.font_name.clone(),
            text: o.text_rgb.clone().map(|t| (t, o.text_swatch.clone())),
            fill: o.fill_rgb.is_some().then(|| Box::new(o.clone())),
            border: None,
        });
        Some(CellCf {
            delta,
            bar: bar.map(|(frac, rgb)| BarDraw {
                start: 0.0,
                end: frac,
                negative: false,
                color: rgb,
                color_swatch: None,
                border: None,
                gradient: false,
                axis: None,
                axis_color: (0, 0, 0),
                show_value: true,
            }),
            ..CellCf::default()
        })
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
        if !self.has_cf() && format_color.is_none() && table.is_none() {
            return self.key_for_style(cell.style);
        }
        let mut base = self.visual.visual(cell.style).unwrap_or_default();
        if let Some(t) = &table {
            base = crate::table_band::under(t, &base);
        }
        if let Some(c) = format_color {
            base.text_rgb = Some(self.visual.format_color_rgb(c));
        }
        let effective = match self.cf_outcome(row, col, cell) {
            Some(o) => o.apply(&base),
            None => base,
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
        let table = self.table_attrs(row, col);
        // A conditional format paints empty cells too (blanks, `= 0`).
        let cf = if self.has_cf() {
            match self.src {
                Some(src) => src.cell_cf(row, col, &CellValue::Empty),
                None => self.static_cf(row, col, &CellValue::Empty),
            }
        } else {
            None
        };
        let base = table.unwrap_or_default();
        match cf {
            Some(o) => self.intern(o.apply(&base)),
            None if base.is_default() => 0,
            None => self.intern(base),
        }
    }

    /// Whether empty cells can carry a style (a table or a conditional
    /// format on the sheet): a surface that skips empty cells asks first.
    pub fn styles_empty_cells(&self) -> bool {
        !self.cf.tables.is_empty() || self.has_cf()
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

    /// The formatted runs of a rich-text cell (W2.2): `(text, style_key)`
    /// per run, keys in the same table, or `None` for plain text. A cell a
    /// conditional format paints shows plain text in the painted style.
    pub fn runs(
        &mut self,
        sheet: sheet_core::SheetId,
        row: u32,
        col: u32,
        cell: &Cell,
        text: &str,
    ) -> Option<Vec<(String, u32)>> {
        if !matches!(cell.value, CellValue::Text(_)) {
            return None;
        }
        let base = self.visual.visual(cell.style).unwrap_or_default();
        let runs = self.visual.rich_runs(sheet, row, col, text, &base)?;
        if self
            .cf_outcome(row, col, cell)
            .is_some_and(|o| o.delta.is_some() || o.scale.is_some())
        {
            return None;
        }
        Some(
            runs.into_iter()
                .map(|(t, a)| {
                    let k = self.intern(a);
                    (t, k)
                })
                .collect(),
        )
    }

    /// The data bar to draw in the cell at sheet `(row, col)`, if any.
    pub fn databar(&mut self, row: u32, col: u32, cell: &Cell) -> Option<BarDraw> {
        self.cf_outcome(row, col, cell).and_then(|o| o.bar)
    }

    /// The icon to draw in the cell at sheet `(row, col)`, if any.
    pub fn icon(&mut self, row: u32, col: u32, cell: &Cell) -> Option<IconDraw> {
        self.cf_outcome(row, col, cell).and_then(|o| o.icon)
    }

    /// A differential number format the cell's text renders through.
    pub fn cf_num_fmt(&mut self, row: u32, col: u32, cell: &Cell) -> Option<String> {
        self.cf_outcome(row, col, cell).and_then(|o| o.num_fmt)
    }

    /// The cell's value is hidden ("show bar / icon only").
    pub fn hides_value(&mut self, row: u32, col: u32, cell: &Cell) -> bool {
        self.cf_outcome(row, col, cell)
            .is_some_and(|o| o.hides_value())
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
