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

//! Table styles on cells (W2.6, sheet ADR 517): a table's style paints its
//! region UNDER the cells' own formatting — Excel's order is conditional
//! formatting, then direct formatting, then the table style. A
//! [`TableBand`] is one table's region with its resolved style; the styler
//! asks [`TableBand::attrs_at`] for the cell and folds the cell's own style
//! over it, so the page and the grid band identically (one styler).
//!
//! Elements compose low to high, as Excel's table-style elements do: the
//! whole table, column stripes, row stripes, the first and last column,
//! the header row, the totals row.

use crate::style::{BorderLine, VisualAttrs};

/// One table-style element (`tableStyleElement`): a fill, a font colour,
/// bold, and lines on the element's edges or between its cells.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TableElementStyle {
    pub fill: Option<String>,
    pub text: Option<String>,
    pub bold: bool,
    /// Lines on the element's outer edges `[top, right, bottom, left]`
    /// (style name, colour).
    pub edges: [Option<(String, Option<String>)>; 4],
    /// Lines between the element's rows / columns.
    pub inner_h: Option<(String, Option<String>)>,
    pub inner_v: Option<(String, Option<String>)>,
}

/// A table style resolved to colours.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TableStyleDef {
    pub whole: Option<TableElementStyle>,
    pub header: Option<TableElementStyle>,
    pub totals: Option<TableElementStyle>,
    pub first_col: Option<TableElementStyle>,
    pub last_col: Option<TableElementStyle>,
    pub row_stripe1: Option<TableElementStyle>,
    pub row_stripe2: Option<TableElementStyle>,
    pub col_stripe1: Option<TableElementStyle>,
    pub col_stripe2: Option<TableElementStyle>,
    /// Rows (columns) per stripe (`size`, 1 by default).
    pub row_stripe_size: u32,
    pub col_stripe_size: u32,
}

/// One table's region and style, with its `tableStyleInfo` switches.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TableBand {
    /// The full extent `(r0, c0, r1, c1)`, header and totals included.
    pub range: (u32, u32, u32, u32),
    pub header_rows: u32,
    pub totals_rows: u32,
    pub style: TableStyleDef,
    pub first_col: bool,
    pub last_col: bool,
    pub row_stripes: bool,
    pub col_stripes: bool,
}

fn line(l: &(String, Option<String>)) -> BorderLine {
    BorderLine {
        weight_pt: BorderLine::weight_of(&l.0),
        style: l.0.clone(),
        rgb: l.1.clone(),
        swatch: None,
    }
}

/// Fold `el` (covering `(er0, ec0)–(er1, ec1)`) onto `acc` at `(r, c)`.
fn fold(acc: &mut VisualAttrs, el: &TableElementStyle, r: u32, c: u32, area: (u32, u32, u32, u32)) {
    let (er0, ec0, er1, ec1) = area;
    if el.fill.is_some() {
        acc.fill_rgb = el.fill.clone();
    }
    if el.text.is_some() {
        acc.text_rgb = el.text.clone();
    }
    acc.bold |= el.bold;
    let mut set = |edge: usize, l: &(String, Option<String>)| {
        let bl = line(l);
        match edge {
            0 => {
                acc.border_top = true;
                acc.border_lines.top = Some(bl);
            }
            1 => {
                acc.border_right = true;
                acc.border_lines.right = Some(bl);
            }
            2 => {
                acc.border_bottom = true;
                acc.border_lines.bottom = Some(bl);
            }
            _ => {
                acc.border_left = true;
                acc.border_lines.left = Some(bl);
            }
        }
    };
    let on = [r == er0, c == ec1, r == er1, c == ec0];
    for (i, e) in el.edges.iter().enumerate() {
        if let (Some(l), true) = (e, on[i]) {
            set(i, l);
        }
    }
    if let Some(l) = &el.inner_h {
        if r > er0 {
            set(0, l);
        }
        if r < er1 {
            set(2, l);
        }
    }
    if let Some(l) = &el.inner_v {
        if c > ec0 {
            set(3, l);
        }
        if c < ec1 {
            set(1, l);
        }
    }
}

impl TableBand {
    /// Whether `(r, c)` is inside the table.
    pub fn covers(&self, r: u32, c: u32) -> bool {
        let (r0, c0, r1, c1) = self.range;
        r0 <= r && r <= r1 && c0 <= c && c <= c1
    }

    /// The table style's attributes at `(r, c)`, `None` outside the table
    /// or where the style paints nothing.
    pub fn attrs_at(&self, r: u32, c: u32) -> Option<VisualAttrs> {
        if !self.covers(r, c) {
            return None;
        }
        let (r0, c0, r1, c1) = self.range;
        let s = &self.style;
        let body0 = r0 + self.header_rows;
        let body1 = r1.saturating_sub(self.totals_rows);
        let in_header = r < body0;
        let in_totals = self.totals_rows > 0 && r > body1;
        let mut acc = VisualAttrs::default();
        if let Some(w) = &s.whole {
            fold(&mut acc, w, r, c, self.range);
        }
        let in_body = !in_header && !in_totals;
        if in_body && self.col_stripes {
            let size = s.col_stripe_size.max(1);
            let k = ((c - c0) / size) % 2;
            let el = if k == 0 {
                &s.col_stripe1
            } else {
                &s.col_stripe2
            };
            if let Some(el) = el {
                let a = c0 + (c - c0) / size * size;
                fold(
                    &mut acc,
                    el,
                    r,
                    c,
                    (body0, a, body1, (a + size - 1).min(c1)),
                );
            }
        }
        if in_body && self.row_stripes {
            let size = s.row_stripe_size.max(1);
            let k = ((r - body0) / size) % 2;
            let el = if k == 0 {
                &s.row_stripe1
            } else {
                &s.row_stripe2
            };
            if let Some(el) = el {
                let a = body0 + (r - body0) / size * size;
                fold(&mut acc, el, r, c, (a, c0, (a + size - 1).min(body1), c1));
            }
        }
        if self.first_col && c == c0 {
            if let Some(el) = &s.first_col {
                fold(&mut acc, el, r, c, (r0, c0, r1, c0));
            }
        }
        if self.last_col && c == c1 {
            if let Some(el) = &s.last_col {
                fold(&mut acc, el, r, c, (r0, c1, r1, c1));
            }
        }
        if in_header {
            if let Some(el) = &s.header {
                fold(&mut acc, el, r, c, (r0, c0, body0 - 1, c1));
            }
        }
        if in_totals {
            if let Some(el) = &s.totals {
                fold(&mut acc, el, r, c, (body1 + 1, c0, r1, c1));
            }
        }
        (!acc.is_default()).then_some(acc)
    }
}

/// The cell's own style folded over the table style: what the cell sets
/// wins, what it leaves default shows the table's.
pub fn under(table: &VisualAttrs, own: &VisualAttrs) -> VisualAttrs {
    let mut out = own.clone();
    if out.fill_rgb.is_none() && out.fill_pattern.is_none() && out.fill_gradient.is_none() {
        out.fill_rgb = table.fill_rgb.clone();
    }
    if out.text_rgb.is_none() {
        out.text_rgb = table.text_rgb.clone();
    }
    out.bold |= table.bold;
    for (mine, theirs, flag_mine, flag_theirs) in [
        (
            &mut out.border_lines.top,
            &table.border_lines.top,
            &mut out.border_top,
            table.border_top,
        ),
        (
            &mut out.border_lines.right,
            &table.border_lines.right,
            &mut out.border_right,
            table.border_right,
        ),
        (
            &mut out.border_lines.bottom,
            &table.border_lines.bottom,
            &mut out.border_bottom,
            table.border_bottom,
        ),
        (
            &mut out.border_lines.left,
            &table.border_lines.left,
            &mut out.border_left,
            table.border_left,
        ),
    ] {
        if !*flag_mine && flag_theirs {
            *flag_mine = true;
            *mine = theirs.clone();
        }
    }
    out
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn el(fill: &str) -> TableElementStyle {
        TableElementStyle {
            fill: Some(fill.into()),
            ..Default::default()
        }
    }

    #[test]
    fn banding_header_totals_and_precedence__feat__sheet_table_styles() {
        let band = TableBand {
            range: (0, 0, 5, 2),
            header_rows: 1,
            totals_rows: 1,
            style: TableStyleDef {
                whole: Some(TableElementStyle {
                    edges: [
                        Some(("thin".into(), Some("#000000".into()))),
                        None,
                        Some(("thin".into(), Some("#000000".into()))),
                        None,
                    ],
                    ..Default::default()
                }),
                header: Some(TableElementStyle {
                    fill: Some("#4472C4".into()),
                    text: Some("#FFFFFF".into()),
                    bold: true,
                    ..Default::default()
                }),
                totals: Some(TableElementStyle {
                    bold: true,
                    ..Default::default()
                }),
                row_stripe1: Some(el("#D9E1F2")),
                ..Default::default()
            },
            row_stripes: true,
            ..Default::default()
        };
        let h = band.attrs_at(0, 1).unwrap();
        assert_eq!(h.fill_rgb.as_deref(), Some("#4472C4"));
        assert!(h.bold && h.border_top);
        assert_eq!(
            band.attrs_at(1, 0).unwrap().fill_rgb.as_deref(),
            Some("#D9E1F2")
        );
        assert!(band.attrs_at(2, 0).is_none());
        assert_eq!(
            band.attrs_at(3, 0).unwrap().fill_rgb.as_deref(),
            Some("#D9E1F2")
        );
        let t = band.attrs_at(5, 2).unwrap();
        assert!(t.bold && t.border_bottom);
        assert!(band.attrs_at(6, 0).is_none());
        // The cell's own fill wins over the stripe.
        let own = VisualAttrs {
            fill_rgb: Some("#FF0000".into()),
            ..Default::default()
        };
        let merged = under(&band.attrs_at(1, 0).unwrap(), &own);
        assert_eq!(merged.fill_rgb.as_deref(), Some("#FF0000"));
    }
}
