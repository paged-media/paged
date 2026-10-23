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

//! Multi-key sort (W2.7, sheet ADR 517): Excel's Sort dialog. Up to 64
//! levels, each by value (ascending, descending or a custom list), cell
//! colour or font colour (a colour on top or on bottom); case-sensitive or
//! not; top to bottom or left to right. The order is stable: rows equal on
//! every key keep their order. Values order as Excel orders them —
//! numbers, text, logicals, errors, and blanks always last; a custom list
//! puts its items first in list order and the rest after, in value order;
//! case-sensitive text puts lower case before upper case.
//!
//! Rows (columns) move whole with their formats; a formula is re-addressed
//! for its new position (relative references move, `$` ones stay), as the
//! single-key sort always did. The sort is written as `<sortState>` — inside
//! the sheet's `<autoFilter>` when the sorted range lies in it, else as the
//! worksheet's own — so Excel's Sort dialog reopens with the same levels.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use sheet_core::{CellRef, CellValue, StyleId};
use sheet_parser::{parse, print, rewrite_fill};
use sheet_xlsx::xtree::XNode;

use super::{
    a1_of, cell_input_text, ci_text_cmp, typed_value_cmp, CellEdit, ModelParseCtx, ModelSheetNames,
    SessionError, SheetSession, SortResult, StyleSwap, T0_LOWER_CELL_CAP,
};

/// Excel's limit of sort levels.
pub const MAX_SORT_KEYS: usize = 64;

/// One sort level.
#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SortKeyArg {
    /// The key column (row, for a left-to-right sort), 0-based within the
    /// range.
    pub index: u32,
    /// Descending order; for a colour key: the colour goes to the bottom.
    pub descending: bool,
    /// `value` (default), `cellColor`, `fontColor`.
    pub sort_by: Option<String>,
    /// The colour of a colour key (`#RRGGBB`; empty = no fill / automatic).
    pub color: Option<String>,
    /// A custom order (Excel's custom lists: `Jan, Feb, …`).
    pub custom_list: Option<Vec<String>>,
}

/// Excel's Sort dialog.
#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SortSpec {
    pub keys: Vec<SortKeyArg>,
    /// "My data has headers": the first row (column) stays put.
    pub has_header: bool,
    /// Sort left to right (columns by the values of rows).
    pub left_to_right: bool,
    pub case_sensitive: bool,
}

#[derive(Clone)]
enum KeyKind {
    Value(Option<Vec<String>>),
    Color { fill: bool, rgb: Option<String> },
}

fn norm_rgb(s: &str) -> Option<String> {
    let t = s.trim().trim_start_matches('#').to_ascii_uppercase();
    if t.is_empty() {
        return None;
    }
    Some(if t.len() == 8 { t[2..].to_string() } else { t })
}

/// Case-sensitive tie-break: lower case before upper case (Excel).
fn case_cmp(a: &str, b: &str) -> Ordering {
    for (x, y) in a.chars().zip(b.chars()) {
        if x == y {
            continue;
        }
        let (xl, yl) = (x.to_lowercase().next(), y.to_lowercase().next());
        if xl == yl {
            return if x.is_lowercase() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        return Ordering::Equal;
    }
    Ordering::Equal
}

/// The value order of one key (blanks last in both directions).
fn value_cmp(
    a: &CellValue,
    b: &CellValue,
    desc: bool,
    list: Option<&[String]>,
    case: bool,
) -> Ordering {
    let blank = |v: &CellValue| matches!(v, CellValue::Empty);
    match (blank(a), blank(b)) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    let ord = match list {
        Some(list) => {
            let pos = |v: &CellValue| {
                let t = match v {
                    CellValue::Text(t) => t.to_string(),
                    other => sheet_format::format_general(other),
                };
                list.iter().position(|i| i.eq_ignore_ascii_case(t.trim()))
            };
            match (pos(a), pos(b)) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => typed_value_cmp(a, b),
            }
        }
        None => match (a, b) {
            (CellValue::Text(x), CellValue::Text(y)) => {
                let o = ci_text_cmp(x, y);
                if o == Ordering::Equal || x.to_lowercase() == y.to_lowercase() {
                    if case {
                        case_cmp(x, y)
                    } else {
                        Ordering::Equal
                    }
                } else {
                    o
                }
            }
            _ => typed_value_cmp(a, b),
        },
    };
    if desc {
        ord.reverse()
    } else {
        ord
    }
}

impl SheetSession {
    /// Sort `range` by `spec` (see the module docs). Returns the changed
    /// displays, the per-cell input rewrites and the style swap for the
    /// undo journal.
    pub fn sort_range_by(
        &mut self,
        sheet: u16,
        range: &str,
        spec: SortSpec,
    ) -> Result<SortResult, SessionError> {
        let (sheet, cr) = self.resolve_range(sheet, range)?;
        let (top, bottom) = (cr.r0.min(cr.r1), cr.r0.max(cr.r1));
        let (left, right) = (cr.c0.min(cr.c1), cr.c0.max(cr.c1));
        let area = u64::from(right - left + 1) * u64::from(bottom - top + 1);
        if area > T0_LOWER_CELL_CAP {
            return Err(SessionError(format!(
                "range exceeds the sort cap ({T0_LOWER_CELL_CAP} cells)"
            )));
        }
        if spec.keys.is_empty() {
            return Err(SessionError("a sort needs at least one key".into()));
        }
        if spec.keys.len() > MAX_SORT_KEYS {
            return Err(SessionError(format!(
                "a sort takes at most {MAX_SORT_KEYS} levels"
            )));
        }
        let ltr = spec.left_to_right;
        // Along: the lines that move (rows, or columns left to right);
        // across: the key positions within a line.
        let (a0, a1, x0, x1) = if ltr {
            (left, right, top, bottom)
        } else {
            (top, bottom, left, right)
        };
        for k in &spec.keys {
            if k.index > x1 - x0 {
                return Err(SessionError(format!(
                    "sort key {} {} out of range (the range has {} {})",
                    if ltr { "row" } else { "column" },
                    k.index,
                    x1 - x0 + 1,
                    if ltr { "rows" } else { "columns" }
                )));
            }
        }
        let first = if spec.has_header { a0 + 1 } else { a0 };
        if first >= a1 {
            return Ok(SortResult::default());
        }
        self.guard_allow(sheet, super::protect::Allow::Sort)?;
        let cell_at = |line: u32, pos: u32| if ltr { (pos, line) } else { (line, pos) };
        let all_cells: Vec<(u16, u32, u32)> = (first..=a1)
            .flat_map(|l| (x0..=x1).map(move |p| (l, p)))
            .map(|(l, p)| {
                let (r, c) = cell_at(l, p);
                (sheet, r, c)
            })
            .collect();
        self.guard_cells(all_cells.iter().copied())?;
        {
            let spills = self.engine().spills();
            for &(_, r, c) in &all_cells {
                let cref = CellRef {
                    sheet,
                    row: r,
                    col: c,
                    row_abs: false,
                    col_abs: false,
                };
                if spills.owner_of(cref).is_some() {
                    return Err(SessionError(format!(
                        "sort over a spilled region not supported (spilled cell at {} — edit the anchor formula)",
                        a1_of(r, c)
                    )));
                }
            }
        }
        let kinds: Vec<KeyKind> = spec
            .keys
            .iter()
            .map(|k| match k.sort_by.as_deref().unwrap_or("value") {
                "value" => Ok(KeyKind::Value(k.custom_list.clone())),
                "cellColor" => Ok(KeyKind::Color {
                    fill: true,
                    rgb: k.color.as_deref().and_then(norm_rgb),
                }),
                "fontColor" => Ok(KeyKind::Color {
                    fill: false,
                    rgb: k.color.as_deref().and_then(norm_rgb),
                }),
                "icon" => Err(SessionError(
                    "sorting by conditional-format icon is not supported yet".into(),
                )),
                other => Err(SessionError(format!("unknown sort basis {other:?}"))),
            })
            .collect::<Result<_, _>>()?;

        // ── the key values of every line.
        let lines: Vec<u32> = (first..=a1).collect();
        let mut keyvals: Vec<Vec<CellValue>> = vec![Vec::new(); lines.len()];
        let mut keycols: Vec<Vec<Option<String>>> = vec![Vec::new(); lines.len()];
        for (ki, k) in spec.keys.iter().enumerate() {
            let pos = x0 + k.index;
            let colors = match &kinds[ki] {
                KeyKind::Color { fill, .. } => {
                    let shown = if ltr {
                        // A key row: its cells across the moving columns.
                        (first..=a1)
                            .map(|c| {
                                self.shown_colors(sheet, &[pos], c)
                                    .get(&pos)
                                    .cloned()
                                    .unwrap_or((None, None))
                            })
                            .collect::<Vec<_>>()
                    } else {
                        let m = self.shown_colors(sheet, &lines, pos);
                        lines
                            .iter()
                            .map(|r| m.get(r).cloned().unwrap_or((None, None)))
                            .collect()
                    };
                    shown
                        .into_iter()
                        .map(|(f, t)| if *fill { f } else { t })
                        .collect::<Vec<_>>()
                }
                KeyKind::Value(_) => vec![None; lines.len()],
            };
            for (i, &line) in lines.iter().enumerate() {
                let (r, c) = cell_at(line, pos);
                keyvals[i].push(self.cell_value(sheet, r, c));
                keycols[i].push(colors[i].clone());
            }
        }
        let mut order: Vec<usize> = (0..lines.len()).collect();
        order.sort_by(|&a, &b| {
            for (ki, k) in spec.keys.iter().enumerate() {
                let o = match &kinds[ki] {
                    KeyKind::Value(list) => value_cmp(
                        &keyvals[a][ki],
                        &keyvals[b][ki],
                        k.descending,
                        list.as_deref(),
                        spec.case_sensitive,
                    ),
                    KeyKind::Color { rgb, .. } => {
                        let hit = |i: usize| keycols[i][ki] == *rgb;
                        let o = hit(b).cmp(&hit(a)); // matching first
                        if k.descending {
                            o.reverse()
                        } else {
                            o
                        }
                    }
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });

        let result = self.apply_line_order(sheet, ltr, first, x0, x1, &order, range)?;
        self.write_sort_state(sheet, &spec, (top, left, bottom, right))?;
        Ok(result)
    }

    fn cell_value(&self, sheet: u16, row: u32, col: u32) -> CellValue {
        self.engine()
            .model()
            .sheet(sheet)
            .and_then(|w| w.cell(row, col))
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    /// Move line `first + order[i]` to line `first + i` (rows, or columns
    /// when `ltr`), across positions `x0..=x1`: inputs re-addressed, styles
    /// carried, one batch write.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn apply_line_order(
        &mut self,
        sheet: u16,
        ltr: bool,
        first: u32,
        x0: u32,
        x1: u32,
        order: &[usize],
        range: &str,
    ) -> Result<SortResult, SessionError> {
        let cell_at = |line: u32, pos: u32| if ltr { (pos, line) } else { (line, pos) };
        type Snap = (
            Vec<String>,
            Vec<Option<sheet_core::ast::Formula>>,
            Vec<StyleId>,
        );
        let snaps: Vec<Snap> = {
            let model = self.engine().model();
            let ws = model.sheet(sheet);
            (0..order.len() as u32)
                .map(|i| {
                    let line = first + i;
                    let mut inputs = Vec::new();
                    let mut forms = Vec::new();
                    let mut styles = Vec::new();
                    for p in x0..=x1 {
                        let (r, c) = cell_at(line, p);
                        inputs.push(cell_input_text(model, sheet, r, c));
                        let cell = ws.and_then(|w| w.cell(r, c));
                        forms.push(
                            cell.and_then(|c| c.formula)
                                .and_then(|f| model.formula(f))
                                .cloned(),
                        );
                        styles.push(cell.map(|c| c.style).unwrap_or_default());
                    }
                    (inputs, forms, styles)
                })
                .collect()
        };
        let next: Vec<Vec<String>> = {
            let model = self.engine().model();
            let names = ModelSheetNames { model };
            let ctx = ModelParseCtx {
                model,
                current: sheet,
            };
            let mut out = Vec::new();
            for (i, &src) in order.iter().enumerate() {
                let d = i as i64 - src as i64;
                let (dr, dc) = if ltr { (0, d) } else { (d, 0) };
                let mut line = Vec::new();
                for (j, input) in snaps[src].0.iter().enumerate() {
                    match &snaps[src].1[j] {
                        Some(f) if d != 0 => {
                            let text = print(&rewrite_fill(f, dr, dc), sheet, &names);
                            if let Err(e) = parse(&text, &ctx) {
                                let (r, c) = cell_at(first + src as u32, x0 + j as u32);
                                return Err(SessionError(format!(
                                    "sort cannot move the formula at {} ({e})",
                                    a1_of(r, c)
                                )));
                            }
                            line.push(format!("={text}"));
                        }
                        _ => line.push(input.clone()),
                    }
                }
                out.push(line);
            }
            out
        };
        // Styles first (a swap, no recalc).
        let restyle: Vec<(u32, u32, StyleId)> = order
            .iter()
            .enumerate()
            .flat_map(|(i, &src)| {
                let snaps = &snaps;
                (x0..=x1).enumerate().filter_map(move |(j, p)| {
                    let want = snaps[src].2[j];
                    let have = snaps[i].2[j];
                    (want != have).then(|| {
                        let (r, c) = cell_at(first + i as u32, p);
                        (r, c, want)
                    })
                })
            })
            .collect();
        let styles = if restyle.is_empty() {
            None
        } else {
            let before = self.get_style_ids(sheet, range)?;
            for &(r, c, s) in &restyle {
                self.engine_mut().set_cell_style(sheet, r, c, s);
            }
            self.extra_dirty.insert(sheet);
            Some(StyleSwap {
                range: range.to_string(),
                before,
                after: self.get_style_ids(sheet, range)?,
            })
        };
        let mut edits = Vec::new();
        let mut batch = Vec::new();
        let mut changed: BTreeSet<(u16, u32, u32)> = BTreeSet::new();
        let mut circular: BTreeSet<(u16, u32, u32)> = BTreeSet::new();
        for i in 0..order.len() {
            for (j, p) in (x0..=x1).enumerate() {
                let (r, c) = cell_at(first + i as u32, p);
                let n = &next[i][j];
                let prev = &snaps[i].0[j];
                if n == prev {
                    continue;
                }
                let input = self.engine().parse_input(sheet, n).map_err(|e| {
                    SessionError(format!("sort re-entry failed at {}: {e}", a1_of(r, c)))
                })?;
                batch.push((sheet, r, c, input));
                edits.push(CellEdit {
                    sheet,
                    row: r,
                    col: c,
                    prev_input: prev.clone(),
                    next_input: n.clone(),
                });
                changed.insert((sheet, r, c));
            }
        }
        if !batch.is_empty() {
            let res = self.engine_mut().set_cells(batch);
            changed.extend(res.changed.iter().map(|c| (c.sheet, c.row, c.col)));
            circular.extend(res.circular.iter().map(|c| (c.sheet, c.row, c.col)));
            for e in &edits {
                self.edited.insert((e.sheet, e.row, e.col));
            }
        }
        let (changed, circular) = self.collect_changes(&changed, &circular);
        Ok(SortResult {
            changed,
            circular,
            edits,
            styles,
        })
    }

    /// Write the sort as `<sortState>` (inside the sheet's `<autoFilter>`
    /// when the range lies in its range, else the worksheet's own).
    fn write_sort_state(
        &mut self,
        sheet: u16,
        spec: &SortSpec,
        (top, left, bottom, right): (u32, u32, u32, u32),
    ) -> Result<(), SessionError> {
        let (dtop, dleft) = if spec.left_to_right {
            (top, left + u32::from(spec.has_header))
        } else {
            (top + u32::from(spec.has_header), left)
        };
        let a1 =
            |r0: u32, c0: u32, r1: u32, c1: u32| format!("{}:{}", a1_of(r0, c0), a1_of(r1, c1));
        let in_filter = self.sheet_autofilter(sheet).is_some_and(|v| {
            let n = v.range.normalized();
            n.start.row <= top && bottom <= n.end.row && n.start.col <= left && right <= n.end.col
        });
        let prefix = self.doc.ws_prefix(sheet);
        let el = |l: &str| XNode::new(format!("{prefix}{l}"));
        let mut st = el("sortState");
        if spec.left_to_right {
            st.set("columnSort", Some("1".into()));
        }
        if spec.case_sensitive {
            st.set("caseSensitive", Some("1".into()));
        }
        st.set("ref", Some(a1(dtop, dleft, bottom, right)));
        for k in &spec.keys {
            let mut c = el("sortCondition");
            if k.descending {
                c.set("descending", Some("1".into()));
            }
            match k.sort_by.as_deref().unwrap_or("value") {
                "cellColor" | "fontColor" => {
                    let fill = k.sort_by.as_deref() == Some("cellColor");
                    c.set(
                        "sortBy",
                        Some(if fill { "cellColor" } else { "fontColor" }.into()),
                    );
                    if let Some(rgb) = k.color.as_deref().filter(|s| !s.trim().is_empty()) {
                        let dxf = self
                            .doc
                            .color_dxf(rgb, fill)
                            .map_err(|e| SessionError(e.to_string()))?;
                        c.set("dxfId", Some(dxf.to_string()));
                    }
                }
                _ => {}
            }
            let r = if spec.left_to_right {
                let row = top + k.index;
                a1(row, dleft, row, right)
            } else {
                let col = left + k.index;
                a1(dtop, col, bottom, col)
            };
            c.set("ref", Some(r));
            if let Some(list) = &k.custom_list {
                c.set("customList", Some(list.join(",")));
            }
            // CT_SortCondition attribute order: descending, sortBy, ref,
            // customList, dxfId.
            let order = ["descending", "sortBy", "ref", "customList", "dxfId"];
            c.attrs
                .sort_by_key(|(k, _)| order.iter().position(|o| o == k).unwrap_or(9));
            st.children.push(c);
        }
        if in_filter {
            let mut af = XNode::parse(self.doc.ws_child(sheet, "autoFilter").expect("has one"))
                .map_err(|e| SessionError(e.to_string()))?;
            af.remove_children("sortState");
            let p = af.prefix().to_string();
            let mut st = st;
            st.name = format!("{p}sortState");
            for c in &mut st.children {
                c.name = format!("{p}sortCondition");
            }
            let at = af
                .children
                .iter()
                .position(|c| c.local() == "extLst")
                .unwrap_or(af.children.len());
            af.children.insert(at, st);
            self.doc
                .set_ws_child(sheet, "autoFilter", Some(af.to_xml().into_bytes()))
                .map_err(|e| SessionError(e.to_string()))?;
            self.doc
                .set_ws_child(sheet, "sortState", None)
                .map_err(|e| SessionError(e.to_string()))?;
        } else {
            self.doc
                .set_ws_child(sheet, "sortState", Some(st.to_xml().into_bytes()))
                .map_err(|e| SessionError(e.to_string()))?;
        }
        self.extra_dirty.insert(sheet);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_order_matches_excel() {
        let t = |s: &str| CellValue::Text(s.into());
        let n = CellValue::Number;
        let mut v = vec![
            t("b"),
            CellValue::Empty,
            n(2.0),
            CellValue::Bool(true),
            t("A"),
            n(1.0),
        ];
        v.sort_by(|a, b| value_cmp(a, b, false, None, false));
        assert_eq!(
            v,
            vec![
                n(1.0),
                n(2.0),
                t("A"),
                t("b"),
                CellValue::Bool(true),
                CellValue::Empty
            ]
        );
        v.sort_by(|a, b| value_cmp(a, b, true, None, false));
        assert_eq!(v.last(), Some(&CellValue::Empty));
        let mut c = vec![t("B"), t("b"), t("a")];
        c.sort_by(|a, b| value_cmp(a, b, false, None, true));
        assert_eq!(c, vec![t("a"), t("b"), t("B")]);
        let list = vec!["Low".to_string(), "Mid".into(), "High".into()];
        let mut l = vec![t("High"), t("zzz"), t("low"), t("Mid")];
        l.sort_by(|a, b| value_cmp(a, b, false, Some(&list), false));
        assert_eq!(l, vec![t("low"), t("Mid"), t("High"), t("zzz")]);
    }
}
