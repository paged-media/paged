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

//! The AutoFilter criteria engine (W2.7, sheet ADR 517). A sheet has one
//! active filter — its `<autoFilter>` — and the rows it hides are hidden in
//! the file, as Excel stores them; clearing it shows exactly those rows
//! again. Every criterion Excel's dropdown writes is evaluated:
//!
//! - value lists against the cell's SHOWN text (case-insensitive), with date
//!   groups (year, month, day, hour, minute, second) and blanks;
//! - custom conditions: numbers compare as numbers when the operand is a
//!   number, text compares case-insensitively, `equal`/`notEqual` take the
//!   wildcards `*`, `?` and `~`; two conditions join with AND or OR;
//! - top / bottom n items or n percent of the column's numbers (ties kept);
//! - dynamic filters: above / below average, today, yesterday, tomorrow,
//!   this / last / next week, month, quarter, year, year to date, a quarter
//!   (`Q1`–`Q4`) or month (`M1`–`M12`) of any year;
//! - colour filters against the cell's fill or font colour as shown (the
//!   conditional formatting included), named by a differential format;
//! - icon filters read the conditional-format icon, which the styler does
//!   not compute yet: an icon criterion keeps every row (`Unsupported`-like),
//!   and says so in [`ColumnState::applied`].
//!
//! A filter applies when it is set, like Excel: an edit afterwards does not
//! re-filter until `reapply_filter`. Named filter VIEWS are criteria saved
//! beside the workbook (the `.paged` part, through `filter_views_json`), and
//! applying one makes it the active `<autoFilter>`.

use std::collections::{BTreeMap, BTreeSet};

use sheet_core::{
    CellRef, CellValue, ColumnFilter, CustomCondition, DateGroup, FilterCriterion, FilterOp,
    FilterView, RangeRef,
};
use sheet_format::{FormatCache, FormatCtx};
use sheet_xlsx::xtree::XNode;

use super::{cell_display, parse_range, FilterResult, SessionError, SheetSession};

/// A criterion across the wasm door.
#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CriterionArg {
    /// Keep rows showing one of `values` (or a date in `dates`, or blank).
    Values {
        #[serde(default)]
        values: Vec<String>,
        #[serde(default)]
        blanks: bool,
        #[serde(default)]
        dates: Vec<DateGroupArg>,
    },
    /// One or two conditions.
    Custom {
        #[serde(default)]
        and: bool,
        conditions: Vec<ConditionArg>,
    },
    /// Text containing `text` (a custom `equal *text*`).
    Contains { text: String },
    /// The `n` largest (`top`) or smallest, or that percent of them.
    Top {
        n: f64,
        #[serde(default)]
        percent: bool,
        #[serde(default = "yes")]
        top: bool,
    },
    /// `aboveAverage`, `belowAverage`, `today`, `yesterday`, `tomorrow`,
    /// `thisWeek`, `lastWeek`, `nextWeek`, `thisMonth`, `lastMonth`,
    /// `nextMonth`, `thisQuarter`, `lastQuarter`, `nextQuarter`, `thisYear`,
    /// `lastYear`, `nextYear`, `yearToDate`, `Q1`–`Q4`, `M1`–`M12`.
    Dynamic {
        #[serde(rename = "type")]
        dynamic: String,
    },
    /// The cell (`cellColor`) or font colour `#RRGGBB`.
    Color {
        color: String,
        #[serde(default = "yes")]
        cell_color: bool,
    },
    /// Icon `id` of icon set `set` (no `id`: cells without an icon).
    Icon { set: String, id: Option<u32> },
}

fn yes() -> bool {
    true
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConditionArg {
    /// `equal`, `notEqual`, `lessThan`, `lessThanOrEqual`, `greaterThan`,
    /// `greaterThanOrEqual`.
    pub op: String,
    pub val: String,
}

#[derive(serde::Deserialize, serde::Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DateGroupArg {
    pub year: u32,
    pub month: Option<u32>,
    pub day: Option<u32>,
    pub hour: Option<u32>,
    pub minute: Option<u32>,
    pub second: Option<u32>,
}

/// One filtered column as the engine reports it.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnState {
    /// 0-based column offset within the filter range.
    pub col: u32,
    pub criterion: Option<CriterionArg>,
    /// False for a criterion the engine keeps but cannot evaluate.
    pub applied: bool,
}

/// The sheet's active filter.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterState {
    /// The filter range (header row first), A1.
    pub range: String,
    pub columns: Vec<ColumnState>,
    pub hidden_rows: Vec<u32>,
}

/// One entry of the filter dropdown's value list.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterItem {
    pub text: String,
    pub count: u32,
    /// Ticked under the current criterion.
    pub selected: bool,
}

/// The dropdown's date tree: a year, month or day with its count.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DateItem {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub count: u32,
}

/// What the grid's filter dropdown shows for one column: the distinct
/// values of the rows the OTHER columns' criteria keep (sorted as an
/// ascending sort would), the dates among them, blanks, the colours present
/// (for Filter by Color) and the current criterion.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterColumnValues {
    /// `text`, `number` or `date`: what most of the column holds (the
    /// dropdown offers Text, Number or Date Filters by it).
    pub kind: &'static str,
    pub items: Vec<FilterItem>,
    pub dates: Vec<DateItem>,
    pub blanks: u32,
    pub blanks_selected: bool,
    pub fill_colors: Vec<String>,
    pub font_colors: Vec<String>,
    pub criterion: Option<CriterionArg>,
}

/// A named filter view (criteria saved beside the workbook).
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterViewInfo {
    pub sheet: u16,
    pub name: String,
    pub range: String,
    pub columns: Vec<SavedColumn>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedColumn {
    pub col: u32,
    pub criterion: CriterionArg,
}

fn norm_rgb(s: &str) -> String {
    let t = s.trim().trim_start_matches('#').to_ascii_uppercase();
    if t.len() == 8 {
        t[2..].to_string()
    } else {
        t
    }
}

/// Excel's wildcard match (`*`, `?`, `~` escapes), case-insensitive.
pub fn wild_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    fn go(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => (0..=t.len()).any(|i| go(&p[1..], &t[i..])),
            Some('?') => !t.is_empty() && go(&p[1..], &t[1..]),
            Some('~') if p.len() > 1 => t.first() == Some(&p[1]) && go(&p[2..], &t[1..]),
            Some(c) => t.first() == Some(c) && go(&p[1..], &t[1..]),
        }
    }
    go(&p, &t)
}

fn has_wildcard(s: &str) -> bool {
    s.contains(['*', '?'])
}

/// One column's precomputed facts for the criteria (cutoffs, averages,
/// dates, shown colours).
struct ColumnFacts {
    top_cut: Option<f64>,
    average: Option<f64>,
}

impl SheetSession {
    pub(crate) fn filter_ctx(&self) -> (FormatCache, FormatCtx) {
        let m = self.engine().model();
        (
            FormatCache::default(),
            FormatCtx::new(m.calc.date_system, m.calc.locale),
        )
    }

    /// The shown fill and font colours of `rows` in `col` (`RRGGBB`, upper
    /// case), conditional formatting included — the styler the page uses.
    pub(crate) fn shown_colors(
        &self,
        sheet: u16,
        rows: &[u32],
        col: u32,
    ) -> BTreeMap<u32, (Option<String>, Option<String>)> {
        let model = self.engine().model();
        let ws = model.sheet(sheet);
        let cf = self.doc.lowered_conditional_formats(sheet);
        let eval = self.eval_cf(sheet);
        let mut styler = sheet_lower::CellStyler::new(&self.doc.visual_styles, &cf, ws)
            .with_cf_source(eval.as_ref().map(|e| e as &dyn sheet_lower::CellCfSource));
        let (mut cache, ctx) = self.filter_ctx();
        let mut keys = Vec::new();
        for &r in rows {
            if let Some(cell) = ws.and_then(|w| w.cell(r, col)) {
                let d = sheet_lower::lower_cell_display(model, cell, &mut cache, &ctx);
                keys.push((r, styler.key_for_display(r, col, cell, d.color)));
            }
        }
        let styles = styler.into_styles();
        keys.into_iter()
            .map(|(r, k)| {
                let s = styles.get(k as usize);
                (
                    r,
                    (
                        s.and_then(|s| s.fill_rgb.as_deref()).map(norm_rgb),
                        s.and_then(|s| s.text_rgb.as_deref()).map(norm_rgb),
                    ),
                )
            })
            .collect()
    }

    fn value_at(&self, sheet: u16, row: u32, col: u32) -> CellValue {
        self.engine()
            .model()
            .sheet(sheet)
            .and_then(|w| w.cell(row, col))
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    fn facts(&self, sheet: u16, rows: &[u32], col: u32, c: &FilterCriterion) -> ColumnFacts {
        let nums: Vec<f64> = rows
            .iter()
            .filter_map(|&r| match self.value_at(sheet, r, col) {
                CellValue::Number(x) => Some(x),
                _ => None,
            })
            .collect();
        let top_cut = match c {
            FilterCriterion::Top { n, percent, top } if !nums.is_empty() => {
                let mut sorted = nums.clone();
                sorted.sort_by(|a, b| a.total_cmp(b));
                if *top {
                    sorted.reverse();
                }
                let count = if *percent {
                    ((sorted.len() as f64) * n / 100.0).floor().max(1.0) as usize
                } else {
                    *n as usize
                };
                Some(sorted[count.clamp(1, sorted.len()) - 1])
            }
            _ => None,
        };
        let average = (!nums.is_empty()).then(|| nums.iter().sum::<f64>() / nums.len() as f64);
        ColumnFacts { top_cut, average }
    }

    /// The `[lo, hi)` serial span of a dynamic date filter, today being
    /// `today` (a whole serial).
    fn dynamic_span(&self, kind: &str, today: f64) -> Option<(f64, f64)> {
        let sys = self.engine().model().calc.date_system;
        let (y, m, _) = sheet_format::serial::serial_to_ymd(today, sys)?;
        let ymd = |y: i32, m: i32, d: u32| -> Option<f64> {
            let (yy, mm) = (y + (m - 1).div_euclid(12), (m - 1).rem_euclid(12) + 1);
            sheet_format::serial::ymd_to_serial(yy, mm as u32, d, sys)
        };
        let m = m as i32;
        // Weeks start on Sunday (Excel's filter weeks). Serial 1 = Sunday
        // 1900-01-01 in Excel's calendar; 7 divides serial distance.
        let dow = (today as i64 - 1).rem_euclid(7) as f64;
        let week0 = today - dow;
        let q0 = (m - 1) / 3 * 3 + 1;
        Some(match kind {
            "today" => (today, today + 1.0),
            "yesterday" => (today - 1.0, today),
            "tomorrow" => (today + 1.0, today + 2.0),
            "thisWeek" => (week0, week0 + 7.0),
            "lastWeek" => (week0 - 7.0, week0),
            "nextWeek" => (week0 + 7.0, week0 + 14.0),
            "thisMonth" => (ymd(y, m, 1)?, ymd(y, m + 1, 1)?),
            "lastMonth" => (ymd(y, m - 1, 1)?, ymd(y, m, 1)?),
            "nextMonth" => (ymd(y, m + 1, 1)?, ymd(y, m + 2, 1)?),
            "thisQuarter" => (ymd(y, q0, 1)?, ymd(y, q0 + 3, 1)?),
            "lastQuarter" => (ymd(y, q0 - 3, 1)?, ymd(y, q0, 1)?),
            "nextQuarter" => (ymd(y, q0 + 3, 1)?, ymd(y, q0 + 6, 1)?),
            "thisYear" => (ymd(y, 1, 1)?, ymd(y + 1, 1, 1)?),
            "lastYear" => (ymd(y - 1, 1, 1)?, ymd(y, 1, 1)?),
            "nextYear" => (ymd(y + 1, 1, 1)?, ymd(y + 2, 1, 1)?),
            "yearToDate" => (ymd(y, 1, 1)?, today + 1.0),
            _ => return None,
        })
    }

    /// Whether one cell passes `c`.
    #[allow(clippy::too_many_arguments)]
    fn cell_passes(
        &self,
        sheet: u16,
        row: u32,
        col: u32,
        c: &FilterCriterion,
        facts: &ColumnFacts,
        colors: &BTreeMap<u32, (Option<String>, Option<String>)>,
        fmt: &mut (FormatCache, FormatCtx),
    ) -> bool {
        let model = self.engine().model();
        let value = self.value_at(sheet, row, col);
        let shown_text = {
            let (cache, ctx) = fmt;
            cell_display(model, sheet, row, col, cache, ctx)
        };
        let shown = || shown_text.clone();
        let blank = matches!(value, CellValue::Empty)
            || matches!(&value, CellValue::Text(t) if t.is_empty());
        let sys = model.calc.date_system;
        match c {
            FilterCriterion::Values { values, blanks } => {
                if blank {
                    return *blanks;
                }
                let t = shown();
                values
                    .iter()
                    .any(|v| v.trim().eq_ignore_ascii_case(t.trim()))
                    || values.iter().any(|v| v.to_lowercase() == t.to_lowercase())
            }
            FilterCriterion::DateGroups {
                values,
                blanks,
                dates,
            } => {
                if blank {
                    return *blanks;
                }
                if let CellValue::Number(x) = value {
                    if let Some((y, m, d)) = sheet_format::serial::serial_to_ymd(x.floor(), sys) {
                        let (h, mi, s) = sheet_format::serial::serial_to_hms(x);
                        let hit = dates.iter().any(|g| {
                            g.year as i32 == y
                                && g.month.is_none_or(|v| v == m)
                                && g.day.is_none_or(|v| v == d)
                                && g.hour.is_none_or(|v| v == h)
                                && g.minute.is_none_or(|v| v == mi)
                                && g.second.is_none_or(|v| v == s)
                        });
                        if hit {
                            return true;
                        }
                    }
                }
                let t = shown().to_lowercase();
                values.iter().any(|v| v.to_lowercase() == t)
            }
            FilterCriterion::Contains(needle) => shown()
                .to_lowercase()
                .contains(needle.to_lowercase().as_str()),
            FilterCriterion::Custom { and, conditions } => {
                let mut results = conditions.iter().map(|k| {
                    let operand_num = k.val.trim().parse::<f64>().ok();
                    let text = shown();
                    match k.op {
                        FilterOp::Equal | FilterOp::NotEqual => {
                            let eq = if k.val.is_empty() {
                                blank
                            } else if has_wildcard(&k.val) || k.val.contains('~') {
                                wild_match(&k.val, &text)
                            } else if let (Some(n), CellValue::Number(x)) = (operand_num, &value) {
                                *x == n
                            } else {
                                text.eq_ignore_ascii_case(&k.val)
                                    || text.to_lowercase() == k.val.to_lowercase()
                            };
                            (k.op == FilterOp::Equal) == eq
                        }
                        op => {
                            let ord = match (operand_num, &value) {
                                (Some(n), CellValue::Number(x)) => x.partial_cmp(&n),
                                (Some(_), _) => None,
                                (None, CellValue::Number(_)) | (None, CellValue::Empty) => None,
                                (None, _) => {
                                    Some(text.to_lowercase().cmp(&k.val.to_lowercase().to_string()))
                                }
                            };
                            let Some(ord) = ord else {
                                return false;
                            };
                            use std::cmp::Ordering::*;
                            match op {
                                FilterOp::LessThan => ord == Less,
                                FilterOp::LessThanOrEqual => ord != Greater,
                                FilterOp::GreaterThan => ord == Greater,
                                FilterOp::GreaterThanOrEqual => ord != Less,
                                _ => unreachable!(),
                            }
                        }
                    }
                });
                if *and {
                    results.all(|b| b)
                } else {
                    results.any(|b| b)
                }
            }
            FilterCriterion::Top { top, .. } => match (value, facts.top_cut) {
                (CellValue::Number(x), Some(cut)) => {
                    if *top {
                        x >= cut
                    } else {
                        x <= cut
                    }
                }
                _ => false,
            },
            FilterCriterion::Dynamic { kind, .. } => {
                let k = kind.as_str();
                match k {
                    "aboveAverage" | "belowAverage" => match (value, facts.average) {
                        (CellValue::Number(x), Some(a)) => {
                            if k == "aboveAverage" {
                                x > a
                            } else {
                                x < a
                            }
                        }
                        _ => false,
                    },
                    "null" => true,
                    _ => {
                        let CellValue::Number(x) = value else {
                            return false;
                        };
                        if let Some(q) = k.strip_prefix('Q').and_then(|d| d.parse::<u32>().ok()) {
                            return sheet_format::serial::serial_to_ymd(x.floor(), sys)
                                .is_some_and(|(_, m, _)| (m - 1) / 3 + 1 == q);
                        }
                        if let Some(mm) = k.strip_prefix('M').and_then(|d| d.parse::<u32>().ok()) {
                            return sheet_format::serial::serial_to_ymd(x.floor(), sys)
                                .is_some_and(|(_, m, _)| m == mm);
                        }
                        let today = self.now_serial().floor();
                        match self.dynamic_span(k, today) {
                            Some((lo, hi)) => lo <= x && x < hi,
                            None => true,
                        }
                    }
                }
            }
            FilterCriterion::Color { cell_color, dxf_id } => {
                let want = dxf_id
                    .and_then(|i| self.doc.dxfs.get(i as usize))
                    .and_then(|d| {
                        if *cell_color {
                            d.fill_rgb.as_deref()
                        } else {
                            d.text_rgb.as_deref()
                        }
                    });
                let have =
                    colors.get(&row).and_then(
                        |(f, t)| {
                            if *cell_color {
                                f.clone()
                            } else {
                                t.clone()
                            }
                        },
                    );
                match want {
                    Some(w) => have.as_deref() == Some(norm_rgb(w).as_str()),
                    // No colour named: the cells with no fill / automatic font.
                    None => have.is_none(),
                }
            }
            FilterCriterion::Icon { .. } | FilterCriterion::Unsupported => true,
        }
    }

    /// The rows `view` hides (data rows: the range minus its header row).
    pub(crate) fn rows_hidden_by(&self, sheet: u16, view: &FilterView) -> BTreeSet<u32> {
        let r = view.range.normalized();
        let rows: Vec<u32> = (r.start.row + 1..=r.end.row).collect();
        let mut hidden = BTreeSet::new();
        let mut fmt = self.filter_ctx();
        for c in &view.columns {
            let col = r.start.col + c.col;
            let facts = self.facts(sheet, &rows, col, &c.criterion);
            let colors = if matches!(c.criterion, FilterCriterion::Color { .. }) {
                self.shown_colors(sheet, &rows, col)
            } else {
                BTreeMap::new()
            };
            for &row in &rows {
                if !self.cell_passes(sheet, row, col, &c.criterion, &facts, &colors, &mut fmt) {
                    hidden.insert(row);
                }
            }
        }
        hidden
    }

    /// The sheet-level `<autoFilter>` as a view, when the sheet has one.
    pub(crate) fn sheet_autofilter(&self, sheet: u16) -> Option<FilterView> {
        self.doc
            .ws_child(sheet, "autoFilter")
            .and_then(|b| sheet_xlsx::parts::autofilter::parse(b, sheet))
    }

    /// Make `view` the sheet's active filter (`None` removes it): the rows
    /// the old filter hid are shown, the new filter's rows hidden, the
    /// `<autoFilter>` written, SUBTOTAL/AGGREGATE recalculated.
    pub(crate) fn apply_autofilter(
        &mut self,
        sheet: u16,
        view: Option<FilterView>,
    ) -> Result<FilterResult, SessionError> {
        let new_hidden = view
            .as_ref()
            .map(|v| self.rows_hidden_by(sheet, v))
            .unwrap_or_default();
        let base = self
            .doc
            .ws_child(sheet, "autoFilter")
            .and_then(|b| XNode::parse(b).ok());
        let prefix = self.doc.ws_prefix(sheet);
        let bytes = view.as_ref().map(|v| {
            sheet_xlsx::parts::autofilter::autofilter_node(v, base.as_ref(), &prefix)
                .to_xml()
                .into_bytes()
        });
        self.doc
            .set_ws_child(sheet, "autoFilter", bytes)
            .map_err(|e| SessionError(e.to_string()))?;
        let (old_filtered, mut filters) = {
            let ws = self.engine().model().sheet(sheet).expect("validated");
            (ws.filtered_rows.clone(), ws.filters.clone())
        };
        // The sheet view replaces the old sheet view; table views stay.
        let old_sheet_range = base
            .as_ref()
            .and_then(|b| b.attr("ref"))
            .and_then(|r| parse_range(&r).ok());
        if let Some(old) = old_sheet_range {
            filters.retain(|f| {
                let n = f.range.normalized();
                !(n.start.row == old.r0.min(old.r1)
                    && n.start.col == old.c0.min(old.c1)
                    && n.end.row == old.r0.max(old.r1)
                    && n.end.col == old.c0.max(old.c1))
            });
        }
        if let Some(v) = &view {
            filters.insert(0, v.clone());
        }
        {
            let vm = self.engine_mut().sheet_view_mut(sheet).expect("validated");
            for r in &old_filtered {
                vm.hidden_rows.remove(r);
            }
            vm.hidden_rows.extend(new_hidden.iter().copied());
        }
        self.engine_mut()
            .set_filter_view(sheet, filters, new_hidden.clone());
        self.extra_dirty.insert(sheet);
        let res = self.engine_mut().recalc_visibility();
        Ok(FilterResult {
            hidden_rows: new_hidden.into_iter().collect(),
            changed: self.changes_of(&res).changed,
        })
    }

    /// On load: which hidden rows the file's autoFilters hid (so clearing a
    /// filter shows exactly those again).
    pub(crate) fn init_file_filters(&mut self) {
        let n = self.engine().model().sheets.len() as u16;
        for sheet in 0..n {
            let (views, hidden) = {
                let ws = self.engine().model().sheet(sheet).expect("in range");
                (ws.filters.clone(), ws.hidden_rows.clone())
            };
            if views.is_empty() {
                continue;
            }
            let mut filtered = BTreeSet::new();
            for v in &views {
                filtered.extend(
                    self.rows_hidden_by(sheet, v)
                        .into_iter()
                        .filter(|r| hidden.contains(r)),
                );
            }
            self.engine_mut().set_filter_view(sheet, views, filtered);
        }
    }

    fn criterion_from_arg(&mut self, a: &CriterionArg) -> Result<FilterCriterion, SessionError> {
        Ok(match a {
            CriterionArg::Values {
                values,
                blanks,
                dates,
            } => {
                let values = values.iter().map(|v| v.as_str().into()).collect();
                if dates.is_empty() {
                    FilterCriterion::Values {
                        values,
                        blanks: *blanks,
                    }
                } else {
                    FilterCriterion::DateGroups {
                        values,
                        blanks: *blanks,
                        dates: dates
                            .iter()
                            .map(|d| DateGroup {
                                year: d.year,
                                month: d.month,
                                day: d.month.and(d.day),
                                hour: d.month.and(d.day).and(d.hour),
                                minute: d.month.and(d.day).and(d.hour).and(d.minute),
                                second: d.month.and(d.day).and(d.hour).and(d.minute).and(d.second),
                            })
                            .collect(),
                    }
                }
            }
            CriterionArg::Custom { and, conditions } => {
                if conditions.is_empty() || conditions.len() > 2 {
                    return Err(SessionError(
                        "a custom filter takes one or two conditions".into(),
                    ));
                }
                FilterCriterion::Custom {
                    and: *and,
                    conditions: conditions
                        .iter()
                        .map(|k| {
                            Ok(CustomCondition {
                                op: FilterOp::parse(&k.op).ok_or_else(|| {
                                    SessionError(format!("unknown filter operator {:?}", k.op))
                                })?,
                                val: k.val.as_str().into(),
                            })
                        })
                        .collect::<Result<_, SessionError>>()?,
                }
            }
            CriterionArg::Contains { text } => FilterCriterion::Contains(text.into()),
            CriterionArg::Top { n, percent, top } => {
                let max = if *percent { 100.0 } else { 500.0 };
                if !(1.0..=max).contains(n) {
                    return Err(SessionError(format!(
                        "top/bottom takes 1 to {max} {}",
                        if *percent { "percent" } else { "items" }
                    )));
                }
                FilterCriterion::Top {
                    n: n.trunc(),
                    percent: *percent,
                    top: *top,
                }
            }
            CriterionArg::Dynamic { dynamic } => {
                let known = [
                    "aboveAverage",
                    "belowAverage",
                    "today",
                    "yesterday",
                    "tomorrow",
                    "thisWeek",
                    "lastWeek",
                    "nextWeek",
                    "thisMonth",
                    "lastMonth",
                    "nextMonth",
                    "thisQuarter",
                    "lastQuarter",
                    "nextQuarter",
                    "thisYear",
                    "lastYear",
                    "nextYear",
                    "yearToDate",
                ];
                let qm = |p: char, max: u32| {
                    dynamic
                        .strip_prefix(p)
                        .and_then(|d| d.parse::<u32>().ok())
                        .is_some_and(|d| (1..=max).contains(&d))
                };
                if !known.contains(&dynamic.as_str()) && !qm('Q', 4) && !qm('M', 12) {
                    return Err(SessionError(format!("unknown dynamic filter {dynamic:?}")));
                }
                FilterCriterion::Dynamic {
                    kind: dynamic.into(),
                    val: None,
                    max_val: None,
                }
            }
            CriterionArg::Color { color, cell_color } => {
                let dxf = self
                    .doc
                    .color_dxf(color, *cell_color)
                    .map_err(|e| SessionError(e.to_string()))?;
                FilterCriterion::Color {
                    cell_color: *cell_color,
                    dxf_id: Some(dxf),
                }
            }
            CriterionArg::Icon { set, id } => FilterCriterion::Icon {
                set: set.into(),
                id: *id,
            },
        })
    }

    fn criterion_to_arg(&self, c: &FilterCriterion) -> Option<CriterionArg> {
        Some(match c {
            FilterCriterion::Values { values, blanks } => CriterionArg::Values {
                values: values.iter().map(|v| v.to_string()).collect(),
                blanks: *blanks,
                dates: Vec::new(),
            },
            FilterCriterion::DateGroups {
                values,
                blanks,
                dates,
            } => CriterionArg::Values {
                values: values.iter().map(|v| v.to_string()).collect(),
                blanks: *blanks,
                dates: dates
                    .iter()
                    .map(|d| DateGroupArg {
                        year: d.year,
                        month: d.month,
                        day: d.day,
                        hour: d.hour,
                        minute: d.minute,
                        second: d.second,
                    })
                    .collect(),
            },
            FilterCriterion::Contains(t) => CriterionArg::Contains {
                text: t.to_string(),
            },
            FilterCriterion::Custom { and, conditions } => CriterionArg::Custom {
                and: *and,
                conditions: conditions
                    .iter()
                    .map(|k| ConditionArg {
                        op: k.op.as_str().into(),
                        val: k.val.to_string(),
                    })
                    .collect(),
            },
            FilterCriterion::Top { n, percent, top } => CriterionArg::Top {
                n: *n,
                percent: *percent,
                top: *top,
            },
            FilterCriterion::Dynamic { kind, .. } => CriterionArg::Dynamic {
                dynamic: kind.to_string(),
            },
            FilterCriterion::Color { cell_color, dxf_id } => CriterionArg::Color {
                color: dxf_id
                    .and_then(|i| self.doc.dxfs.get(i as usize))
                    .and_then(|d| {
                        if *cell_color {
                            d.fill_rgb.clone()
                        } else {
                            d.text_rgb.clone()
                        }
                    })
                    .map(|c| format!("#{}", norm_rgb(&c)))
                    .unwrap_or_default(),
                cell_color: *cell_color,
            },
            FilterCriterion::Icon { set, id } => CriterionArg::Icon {
                set: set.to_string(),
                id: *id,
            },
            FilterCriterion::Unsupported => return None,
        })
    }

    /// Store the bounds Excel writes with a top10 / dynamic criterion
    /// (`filterVal`, `val`, `maxVal`) — computed at apply time.
    fn with_bounds(&self, sheet: u16, view: &mut FilterView) {
        let r = view.range.normalized();
        let rows: Vec<u32> = (r.start.row + 1..=r.end.row).collect();
        let today = self.now_serial().floor();
        for c in &mut view.columns {
            let col = r.start.col + c.col;
            if let FilterCriterion::Dynamic { kind, val, max_val } = &mut c.criterion {
                if kind == "aboveAverage" || kind == "belowAverage" {
                    *val = self
                        .facts(sheet, &rows, col, &FilterCriterion::Unsupported)
                        .average;
                } else if let Some((lo, hi)) = self.dynamic_span(kind, today) {
                    *val = Some(lo);
                    *max_val = Some(hi);
                }
            }
        }
    }

    fn filter_range_of(&self, sheet: u16, range: &str) -> Result<RangeRef, SessionError> {
        let cr = parse_range(range)?;
        let (top, bottom) = (cr.r0.min(cr.r1), cr.r0.max(cr.r1));
        let (left, right) = (cr.c0.min(cr.c1), cr.c0.max(cr.c1));
        let mk = |row, col| CellRef {
            sheet,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        Ok(RangeRef {
            start: mk(top, left),
            end: mk(bottom, right),
        })
    }

    /// Turn on AutoFilter over `range` (header row first) with no criteria,
    /// or move it there (Data ▸ Filter).
    pub fn set_autofilter(
        &mut self,
        sheet: u16,
        range: &str,
    ) -> Result<FilterResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_allow(sheet, super::protect::Allow::AutoFilter)?;
        let r = self.filter_range_of(sheet, range)?;
        self.apply_autofilter(
            sheet,
            Some(FilterView {
                range: r,
                columns: Vec::new(),
                from_file: false,
            }),
        )
    }

    /// Turn AutoFilter off: every row it hid shows, the element goes.
    pub fn remove_autofilter(&mut self, sheet: u16) -> Result<FilterResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_allow(sheet, super::protect::Allow::AutoFilter)?;
        self.apply_autofilter(sheet, None)
    }

    /// Set (or, with `None`, clear) one column's criterion of the sheet's
    /// AutoFilter over `range`. A filter over another range is replaced, as
    /// a sheet holds one AutoFilter.
    pub fn set_filter_column(
        &mut self,
        sheet: u16,
        range: &str,
        col: u32,
        criterion: Option<CriterionArg>,
    ) -> Result<FilterResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_allow(sheet, super::protect::Allow::AutoFilter)?;
        let r = self.filter_range_of(sheet, range)?;
        if col > r.end.col - r.start.col {
            return Err(SessionError(format!(
                "filter column {col} out of range (the range has {} columns)",
                r.end.col - r.start.col + 1
            )));
        }
        if let Some(def) = self.table_covering(sheet, &r) {
            // A table's own AutoFilter (its part), columns counted from the
            // table's first column.
            let mut view = self.table_view(sheet, &def)?;
            let tcol = r.start.col + col - view.range.normalized().start.col;
            view.columns.retain(|c| c.col != tcol);
            if let Some(a) = criterion {
                let criterion = self.criterion_from_arg(&a)?;
                view.columns.push(ColumnFilter {
                    col: tcol,
                    criterion,
                });
            }
            self.with_bounds(sheet, &mut view);
            return self.apply_table_filter(sheet, def, view);
        }
        let mut view = match self.sheet_autofilter(sheet) {
            Some(v) if v.range.normalized() == r => v,
            _ => FilterView {
                range: r,
                columns: Vec::new(),
                from_file: false,
            },
        };
        view.columns.retain(|c| c.col != col);
        if let Some(a) = criterion {
            let criterion = self.criterion_from_arg(&a)?;
            view.columns.push(ColumnFilter { col, criterion });
        }
        self.with_bounds(sheet, &mut view);
        self.apply_autofilter(sheet, Some(view))
    }

    /// Clear every criterion, keep the AutoFilter (Data ▸ Clear).
    pub fn clear_filter_criteria(&mut self, sheet: u16) -> Result<FilterResult, SessionError> {
        self.validate_sheet(sheet)?;
        let Some(mut v) = self.sheet_autofilter(sheet) else {
            return Ok(FilterResult::default());
        };
        v.columns
            .retain(|c| matches!(c.criterion, FilterCriterion::Unsupported));
        self.apply_autofilter(sheet, Some(v))
    }

    /// Apply the current criteria again (Data ▸ Reapply).
    pub fn reapply_filter(&mut self, sheet: u16) -> Result<FilterResult, SessionError> {
        self.validate_sheet(sheet)?;
        let Some(mut v) = self.sheet_autofilter(sheet) else {
            return Ok(FilterResult::default());
        };
        self.with_bounds(sheet, &mut v);
        self.apply_autofilter(sheet, Some(v))
    }

    /// The sheet's active filter.
    pub fn filter_state(&self, sheet: u16) -> Result<Option<FilterState>, SessionError> {
        self.validate_sheet(sheet)?;
        let Some(v) = self.sheet_autofilter(sheet) else {
            return Ok(None);
        };
        let n = v.range.normalized();
        let ws = self.engine().model().sheet(sheet).expect("validated");
        Ok(Some(FilterState {
            range: format!(
                "{}{}:{}{}",
                sheet_core::col_to_a1(n.start.col),
                n.start.row + 1,
                sheet_core::col_to_a1(n.end.col),
                n.end.row + 1
            ),
            columns: v
                .columns
                .iter()
                .map(|c| ColumnState {
                    col: c.col,
                    criterion: self.criterion_to_arg(&c.criterion),
                    applied: !matches!(
                        c.criterion,
                        FilterCriterion::Icon { .. } | FilterCriterion::Unsupported
                    ),
                })
                .collect(),
            hidden_rows: ws.filtered_rows.iter().copied().collect(),
        }))
    }

    /// The filter dropdown of column `col` (0-based in the AutoFilter range).
    pub fn filter_column_values(
        &self,
        sheet: u16,
        col: u32,
    ) -> Result<FilterColumnValues, SessionError> {
        self.validate_sheet(sheet)?;
        let v = self
            .sheet_autofilter(sheet)
            .ok_or_else(|| SessionError("the sheet has no AutoFilter".into()))?;
        self.column_values_of(sheet, &v, col)
    }

    /// The filter dropdown of column `col` of table `name`'s AutoFilter.
    pub fn table_filter_column_values(
        &self,
        name: &str,
        col: u32,
    ) -> Result<FilterColumnValues, SessionError> {
        let (sheet, def) = self.table_def_pub(name)?;
        let v = self.table_view(sheet, &def)?;
        self.column_values_of(sheet, &v, col)
    }

    fn column_values_of(
        &self,
        sheet: u16,
        v: &FilterView,
        col: u32,
    ) -> Result<FilterColumnValues, SessionError> {
        let n = v.range.normalized();
        if col > n.end.col - n.start.col {
            return Err(SessionError(format!("filter column {col} out of range")));
        }
        let abs = n.start.col + col;
        // Rows the OTHER columns keep.
        let others = FilterView {
            range: v.range,
            columns: v.columns.iter().filter(|c| c.col != col).cloned().collect(),
            from_file: true,
        };
        let hidden = self.rows_hidden_by(sheet, &others);
        let rows: Vec<u32> = (n.start.row + 1..=n.end.row)
            .filter(|r| !hidden.contains(r))
            .collect();
        let current = v.columns.iter().find(|c| c.col == col);
        let model = self.engine().model();
        let sys = model.calc.date_system;
        let (mut cache, ctx) = self.filter_ctx();
        let mut counts: BTreeMap<String, (CellValue, u32)> = BTreeMap::new();
        let mut dates: BTreeMap<(i32, u32, u32), u32> = BTreeMap::new();
        let (mut blanks, mut nums, mut texts, mut date_cells) = (0u32, 0u32, 0u32, 0u32);
        for &r in &rows {
            let value = self.value_at(sheet, r, abs);
            if matches!(value, CellValue::Empty) {
                blanks += 1;
                continue;
            }
            let shown = cell_display(model, sheet, r, abs, &mut cache, &ctx);
            let is_date = match (&value, model.sheet(sheet).and_then(|w| w.cell(r, abs))) {
                (CellValue::Number(x), Some(c)) => {
                    super::fill::is_date_format(&mut cache, model.styles.num_fmt_of(c.style), *x)
                }
                _ => false,
            };
            match (&value, is_date) {
                (CellValue::Number(x), true) => {
                    date_cells += 1;
                    if let Some(ymd) = sheet_format::serial::serial_to_ymd(x.floor(), sys) {
                        *dates.entry(ymd).or_default() += 1;
                    }
                }
                (CellValue::Number(_), false) => nums += 1,
                _ => texts += 1,
            }
            let e = counts.entry(shown).or_insert((value.clone(), 0));
            e.1 += 1;
        }
        let mut items: Vec<(String, CellValue, u32)> =
            counts.into_iter().map(|(t, (v, n))| (t, v, n)).collect();
        items.sort_by(|a, b| super::sort_key_cmp(&a.1, &b.1, true).then(a.0.cmp(&b.0)));
        let mut fmt = self.filter_ctx();
        let facts = current.map(|c| self.facts(sheet, &rows, abs, &c.criterion));
        let colors = self.shown_colors(sheet, &rows, abs);
        let selected =
            |text: &str, row_hint: Option<u32>, fmt: &mut (FormatCache, FormatCtx)| -> bool {
                match (current, row_hint, &facts) {
                    (None, _, _) => true,
                    (Some(c), Some(r), Some(f)) => {
                        self.cell_passes(sheet, r, abs, &c.criterion, f, &colors, fmt)
                    }
                    (Some(c), None, _) => match &c.criterion {
                        FilterCriterion::Values { values, .. } => {
                            values.iter().any(|v| v.eq_ignore_ascii_case(text))
                        }
                        _ => true,
                    },
                    _ => true,
                }
            };
        // A representative row per shown text, to ask the criterion.
        let mut rep: BTreeMap<String, u32> = BTreeMap::new();
        for &r in &rows {
            let t = cell_display(model, sheet, r, abs, &mut cache, &ctx);
            rep.entry(t).or_insert(r);
        }
        let items = items
            .into_iter()
            .map(|(text, _, count)| {
                let sel = selected(&text, rep.get(&text).copied(), &mut fmt);
                FilterItem {
                    text,
                    count,
                    selected: sel,
                }
            })
            .collect();
        let blanks_selected = match current.map(|c| &c.criterion) {
            None => true,
            Some(FilterCriterion::Values { blanks, .. })
            | Some(FilterCriterion::DateGroups { blanks, .. }) => *blanks,
            Some(_) => false,
        };
        let mut fill: BTreeSet<String> = BTreeSet::new();
        let mut font: BTreeSet<String> = BTreeSet::new();
        for (f, t) in colors.values() {
            if let Some(f) = f {
                fill.insert(format!("#{f}"));
            }
            if let Some(t) = t {
                font.insert(format!("#{t}"));
            }
        }
        let kind = if date_cells >= nums && date_cells >= texts && date_cells > 0 {
            "date"
        } else if nums >= texts && nums > 0 {
            "number"
        } else {
            "text"
        };
        Ok(FilterColumnValues {
            kind,
            items,
            dates: dates
                .into_iter()
                .map(|((year, month, day), count)| DateItem {
                    year,
                    month,
                    day,
                    count,
                })
                .collect(),
            blanks,
            blanks_selected,
            fill_colors: fill.into_iter().collect(),
            font_colors: font.into_iter().collect(),
            criterion: current.and_then(|c| self.criterion_to_arg(&c.criterion)),
        })
    }

    // ── tables' own AutoFilters ─────────────────────────────────────────

    fn table_def_pub(
        &self,
        name: &str,
    ) -> Result<(u16, sheet_xlsx::table_doc::TableDef), SessionError> {
        let n = self.engine().model().sheets.len() as u16;
        for s in 0..n {
            for t in self.doc.table_defs(s) {
                if t.name().eq_ignore_ascii_case(name) {
                    return Ok((s, t));
                }
            }
        }
        Err(SessionError(format!("no table named {name:?}")))
    }

    /// The table whose header-and-data rows hold `r`.
    fn table_covering(&self, sheet: u16, r: &RangeRef) -> Option<sheet_xlsx::table_doc::TableDef> {
        let n = r.normalized();
        self.doc.table_defs(sheet).into_iter().find(|t| {
            t.header_rows() > 0
                && t.range().is_some_and(|(r0, c0, r1, c1)| {
                    let d1 = r1 - t.totals_rows();
                    r0 <= n.start.row && n.end.row <= d1 && c0 <= n.start.col && n.end.col <= c1
                })
        })
    }

    /// A table's AutoFilter as a view over its header and data rows.
    fn table_view(
        &self,
        sheet: u16,
        def: &sheet_xlsx::table_doc::TableDef,
    ) -> Result<FilterView, SessionError> {
        let (r0, c0, r1, c1) = def
            .range()
            .ok_or_else(|| SessionError("table without a range".into()))?;
        let d1 = r1 - def.totals_rows();
        let mk = |row, col| CellRef {
            sheet,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        let range = RangeRef {
            start: mk(r0, c0),
            end: mk(d1, c1),
        };
        let columns = sheet_xlsx::parts::autofilter::parse(&def.to_bytes(), sheet)
            .map(|v| v.columns)
            .unwrap_or_default();
        Ok(FilterView {
            range,
            columns,
            from_file: true,
        })
    }

    /// Apply `view` as table `def`'s AutoFilter: the rows its old criteria
    /// hid show, the new ones hide, the part is written.
    fn apply_table_filter(
        &mut self,
        sheet: u16,
        mut def: sheet_xlsx::table_doc::TableDef,
        view: FilterView,
    ) -> Result<FilterResult, SessionError> {
        let old = self.table_view(sheet, &def)?;
        let filtered = self
            .engine()
            .model()
            .sheet(sheet)
            .expect("validated")
            .filtered_rows
            .clone();
        let old_hidden: BTreeSet<u32> = self
            .rows_hidden_by(sheet, &old)
            .into_iter()
            .filter(|r| filtered.contains(r))
            .collect();
        let new_hidden = self.rows_hidden_by(sheet, &view);
        let base = def.node.child("autoFilter").cloned();
        let p = def.node.prefix().to_string();
        let af = sheet_xlsx::parts::autofilter::autofilter_node(&view, base.as_ref(), &p);
        match def
            .node
            .children
            .iter()
            .position(|c| c.local() == "autoFilter")
        {
            Some(i) => def.node.children[i] = af,
            None => def.node.children.insert(0, af),
        }
        self.doc.store_table(&def);
        let mut filters = self
            .engine()
            .model()
            .sheet(sheet)
            .expect("validated")
            .filters
            .clone();
        filters.retain(|f| f.range.normalized() != old.range.normalized());
        filters.push(view);
        let mut now_filtered = filtered;
        for r in &old_hidden {
            now_filtered.remove(r);
        }
        now_filtered.extend(new_hidden.iter().copied());
        {
            let vm = self.engine_mut().sheet_view_mut(sheet).expect("validated");
            for r in &old_hidden {
                vm.hidden_rows.remove(r);
            }
            vm.hidden_rows.extend(new_hidden.iter().copied());
        }
        self.engine_mut()
            .set_filter_view(sheet, filters, now_filtered);
        self.extra_dirty.insert(sheet);
        let res = self.engine_mut().recalc_visibility();
        Ok(FilterResult {
            hidden_rows: new_hidden.into_iter().collect(),
            changed: self.changes_of(&res).changed,
        })
    }

    /// Clear every criterion of table `name`'s AutoFilter.
    pub fn clear_table_filter(&mut self, name: &str) -> Result<FilterResult, SessionError> {
        let (sheet, def) = self.table_def_pub(name)?;
        self.guard_allow(sheet, super::protect::Allow::AutoFilter)?;
        let mut v = self.table_view(sheet, &def)?;
        v.columns.clear();
        self.apply_table_filter(sheet, def, v)
    }

    // ── named filter views ──────────────────────────────────────────────

    /// Save the sheet's active filter as view `name` (replacing one of the
    /// same name).
    pub fn save_filter_view(&mut self, sheet: u16, name: &str) -> Result<(), SessionError> {
        self.validate_sheet(sheet)?;
        if name.trim().is_empty() {
            return Err(SessionError("a filter view needs a name".into()));
        }
        let v = self
            .sheet_autofilter(sheet)
            .ok_or_else(|| SessionError("the sheet has no AutoFilter to save".into()))?;
        let st = self.filter_state(sheet)?.expect("has a filter");
        let info = FilterViewInfo {
            sheet,
            name: name.to_string(),
            range: st.range,
            columns: v
                .columns
                .iter()
                .filter_map(|c| {
                    Some(SavedColumn {
                        col: c.col,
                        criterion: self.criterion_to_arg(&c.criterion)?,
                    })
                })
                .collect(),
        };
        self.filter_views
            .retain(|f| !(f.sheet == sheet && f.name == name));
        self.filter_views.push(info);
        Ok(())
    }

    /// Make view `name` the sheet's active AutoFilter.
    pub fn apply_filter_view(
        &mut self,
        sheet: u16,
        name: &str,
    ) -> Result<FilterResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_allow(sheet, super::protect::Allow::AutoFilter)?;
        let info = self
            .filter_views
            .iter()
            .find(|f| f.sheet == sheet && f.name == name)
            .cloned()
            .ok_or_else(|| SessionError(format!("no filter view {name:?}")))?;
        let range = self.filter_range_of(sheet, &info.range)?;
        let mut view = FilterView {
            range,
            columns: Vec::new(),
            from_file: false,
        };
        for c in &info.columns {
            let criterion = self.criterion_from_arg(&c.criterion)?;
            view.columns.push(ColumnFilter {
                col: c.col,
                criterion,
            });
        }
        self.with_bounds(sheet, &mut view);
        self.apply_autofilter(sheet, Some(view))
    }

    pub fn delete_filter_view(&mut self, sheet: u16, name: &str) {
        self.filter_views
            .retain(|f| !(f.sheet == sheet && f.name == name));
    }

    pub fn list_filter_views(&self) -> Vec<FilterViewInfo> {
        self.filter_views.clone()
    }

    /// Replace the named views (restored from the `.paged` part, where the
    /// bundle keeps what `list_filter_views` gave it).
    pub fn set_filter_views(&mut self, views: Vec<FilterViewInfo>) {
        self.filter_views = views;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcards() {
        assert!(wild_match("a*c", "ABBC"));
        assert!(wild_match("a?c", "abc"));
        assert!(!wild_match("a?c", "abbc"));
        assert!(wild_match("~*x", "*x"));
        assert!(!wild_match("~*x", "ax"));
        assert!(wild_match("*", ""));
    }
}
