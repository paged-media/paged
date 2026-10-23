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

//! Outline (group / ungroup, collapse / expand, show level n), hiding rows,
//! columns and sheets (W2.8, sheet ADR 517). The model holds it all already
//! (`RowMeta`, `ColMeta`, `hidden_rows`, `SheetState`, the W1.4 amendment);
//! the save writes it row by row and column by column (ADR 503 amendment),
//! and `<sheetFormatPr outlineLevelRow/Col>` follows the deepest level.
//!
//! Excel's outline rules: a group is a maximal run of rows (columns) whose
//! outline level is at least the group's level; its summary row is the row
//! below the run (`summaryBelow`, the default) or above it, and carries the
//! `collapsed` flag while the group is collapsed. Collapsing hides the run;
//! expanding shows it again except the nested groups that are themselves
//! collapsed.

use std::collections::BTreeSet;

use sheet_core::{ColMeta, SheetState, MAX_COL, MAX_ROW};

use super::{SessionError, SetCellResult, SheetSession};

/// Rows or columns.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
    Rows,
    Cols,
}

impl Axis {
    pub fn parse(s: &str) -> Result<Axis, SessionError> {
        match s {
            "rows" | "row" => Ok(Axis::Rows),
            "cols" | "col" | "columns" => Ok(Axis::Cols),
            other => Err(SessionError(format!("unknown axis {other:?} (rows, cols)"))),
        }
    }

    fn max(self) -> u32 {
        match self {
            Axis::Rows => MAX_ROW,
            Axis::Cols => MAX_COL,
        }
    }
}

/// One outline group, for the grid's outline bar.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutlineGroup {
    /// First and last row (column) of the detail, 0-based inclusive.
    pub first: u32,
    pub last: u32,
    /// 1-based outline level.
    pub level: u8,
    /// Whether the group is collapsed (its summary row carries the flag).
    pub collapsed: bool,
    /// The summary row (column), when it is inside the sheet.
    pub summary: Option<u32>,
}

/// A sheet's outline on both axes.
#[derive(serde::Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutlineInfo {
    pub rows: Vec<OutlineGroup>,
    pub cols: Vec<OutlineGroup>,
    pub max_row_level: u8,
    pub max_col_level: u8,
    pub summary_below: bool,
    pub summary_right: bool,
    /// Hidden rows and columns (by hand, by an outline or saved hidden).
    pub hidden_rows: Vec<u32>,
    pub hidden_cols: Vec<u32>,
}

/// The per-index outline state the operations work on.
#[derive(Clone, Debug, Default, PartialEq)]
struct Track {
    level: u8,
    hidden: bool,
    collapsed: bool,
}

impl SheetSession {
    fn summary_below_right(&self, sheet: u16) -> (bool, bool) {
        let Some(b) = self.doc.ws_child(sheet, "sheetPr") else {
            return (true, true);
        };
        let Ok(n) = sheet_xlsx::xtree::XNode::parse(b) else {
            return (true, true);
        };
        match n.child("outlinePr") {
            Some(o) => (o.flag("summaryBelow", true), o.flag("summaryRight", true)),
            None => (true, true),
        }
    }

    fn track(&self, sheet: u16, axis: Axis, i: u32) -> Track {
        let Some(ws) = self.engine().model().sheet(sheet) else {
            return Track::default();
        };
        match axis {
            Axis::Rows => {
                let m = ws.row_meta.get(&i);
                Track {
                    level: m.map_or(0, |m| m.outline_level),
                    hidden: ws.hidden_rows.contains(&i),
                    collapsed: m.is_some_and(|m| m.collapsed),
                }
            }
            Axis::Cols => {
                let m = ws.col_meta.iter().find(|m| m.min <= i && i <= m.max);
                Track {
                    level: m.map_or(0, |m| m.outline_level),
                    hidden: m.is_some_and(|m| m.hidden),
                    collapsed: m.is_some_and(|m| m.collapsed),
                }
            }
        }
    }

    /// Apply `f` to the track of every index in `first..=last`.
    fn edit_tracks(
        &mut self,
        sheet: u16,
        axis: Axis,
        first: u32,
        last: u32,
        mut f: impl FnMut(u32, &mut Track),
    ) {
        let view = self.engine_mut().sheet_view_mut(sheet).expect("validated");
        match axis {
            Axis::Rows => {
                for r in first..=last {
                    let m = view.row_meta.entry(r).or_default();
                    let mut t = Track {
                        level: m.outline_level,
                        hidden: view.hidden_rows.contains(&r),
                        collapsed: m.collapsed,
                    };
                    f(r, &mut t);
                    m.outline_level = t.level;
                    m.collapsed = t.collapsed;
                    if *m == sheet_core::RowMeta::default() {
                        view.row_meta.remove(&r);
                    }
                    if t.hidden {
                        view.hidden_rows.insert(r);
                    } else {
                        view.hidden_rows.remove(&r);
                    }
                }
            }
            Axis::Cols => {
                let mut per: Vec<ColMeta> = Vec::new();
                for c in first..=last {
                    let mut m = view
                        .col_meta
                        .iter()
                        .find(|m| m.min <= c && c <= m.max)
                        .cloned()
                        .unwrap_or_default();
                    m.min = c;
                    m.max = c;
                    let mut t = Track {
                        level: m.outline_level,
                        hidden: m.hidden,
                        collapsed: m.collapsed,
                    };
                    f(c, &mut t);
                    m.outline_level = t.level;
                    m.hidden = t.hidden;
                    m.collapsed = t.collapsed;
                    per.push(m);
                }
                set_col_metas(view.col_meta, first, last, per);
            }
        }
    }

    /// The maximal run around `at` whose level is at least `level`.
    fn run_around(&self, sheet: u16, axis: Axis, at: u32, level: u8) -> (u32, u32) {
        let (mut a, mut b) = (at, at);
        while a > 0 && self.track(sheet, axis, a - 1).level >= level {
            a -= 1;
        }
        while b < axis.max() && self.track(sheet, axis, b + 1).level >= level {
            b += 1;
        }
        (a, b)
    }

    fn summary_of(&self, sheet: u16, axis: Axis, run: (u32, u32)) -> Option<u32> {
        let (below, right) = self.summary_below_right(sheet);
        let after = match axis {
            Axis::Rows => below,
            Axis::Cols => right,
        };
        if after {
            (run.1 < axis.max()).then_some(run.1 + 1)
        } else {
            run.0.checked_sub(1)
        }
    }

    /// Every group on one axis, outermost first within a position.
    fn groups(&self, sheet: u16, axis: Axis) -> Vec<OutlineGroup> {
        let Some(ws) = self.engine().model().sheet(sheet) else {
            return Vec::new();
        };
        let leveled: Vec<(u32, u8)> = match axis {
            Axis::Rows => ws
                .row_meta
                .iter()
                .filter(|(_, m)| m.outline_level > 0)
                .map(|(&r, m)| (r, m.outline_level))
                .collect(),
            Axis::Cols => {
                let mut v: Vec<(u32, u8)> = ws
                    .col_meta
                    .iter()
                    .filter(|m| m.outline_level > 0)
                    .flat_map(|m| (m.min..=m.max).map(move |c| (c, m.outline_level)))
                    .collect();
                v.sort();
                v
            }
        };
        let mut out = Vec::new();
        for level in 1..=7u8 {
            let mut run: Option<(u32, u32)> = None;
            let flush = |run: Option<(u32, u32)>, out: &mut Vec<OutlineGroup>| {
                if let Some(r) = run {
                    let summary = self.summary_of(sheet, axis, r);
                    let collapsed = summary.is_some_and(|s| self.track(sheet, axis, s).collapsed);
                    out.push(OutlineGroup {
                        first: r.0,
                        last: r.1,
                        level,
                        collapsed,
                        summary,
                    });
                }
            };
            for &(i, l) in &leveled {
                if l < level {
                    continue;
                }
                run = match run {
                    Some((a, b)) if b + 1 == i => Some((a, i)),
                    other => {
                        flush(other, &mut out);
                        Some((i, i))
                    }
                };
            }
            flush(run, &mut out);
        }
        out.sort_by_key(|g| (g.first, g.level));
        out
    }

    /// The sheet's outline and hidden rows and columns.
    pub fn outline(&self, sheet: u16) -> Result<OutlineInfo, SessionError> {
        self.validate_sheet(sheet)?;
        let rows = self.groups(sheet, Axis::Rows);
        let cols = self.groups(sheet, Axis::Cols);
        let (summary_below, summary_right) = self.summary_below_right(sheet);
        let ws = self.engine().model().sheet(sheet).expect("validated");
        Ok(OutlineInfo {
            max_row_level: rows.iter().map(|g| g.level).max().unwrap_or(0),
            max_col_level: cols.iter().map(|g| g.level).max().unwrap_or(0),
            rows,
            cols,
            summary_below,
            summary_right,
            hidden_rows: ws.hidden_rows.iter().copied().collect(),
            hidden_cols: ws
                .col_meta
                .iter()
                .filter(|m| m.hidden)
                .flat_map(|m| m.min..=m.max)
                .collect(),
        })
    }

    /// After an outline or visibility change: the sheet saves again, the
    /// outline levels are written, and SUBTOTAL/AGGREGATE over hidden rows
    /// recalculate.
    fn after_view_change(&mut self, sheet: u16) -> Result<SetCellResult, SessionError> {
        self.extra_dirty.insert(sheet);
        let (r, c) = {
            let ws = self.engine().model().sheet(sheet).expect("validated");
            (
                ws.row_meta
                    .values()
                    .map(|m| m.outline_level)
                    .max()
                    .unwrap_or(0),
                ws.col_meta
                    .iter()
                    .map(|m| m.outline_level)
                    .max()
                    .unwrap_or(0),
            )
        };
        self.doc
            .set_outline_levels(sheet, r, c)
            .map_err(|e| SessionError(e.to_string()))?;
        let res = self.engine_mut().recalc_visibility();
        Ok(self.changes_of(&res))
    }

    fn span(axis: Axis, first: u32, last: u32) -> Result<(u32, u32), SessionError> {
        let (a, b) = (first.min(last), first.max(last));
        if b > axis.max() {
            return Err(SessionError("outside the sheet".into()));
        }
        Ok((a, b))
    }

    /// Group rows or columns `first..=last` one level deeper (Data ▸ Group;
    /// at most 8 levels, Excel's limit of 7 outline levels).
    pub fn group(
        &mut self,
        sheet: u16,
        axis: Axis,
        first: u32,
        last: u32,
    ) -> Result<SetCellResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_format_axis(sheet, axis)?;
        let (a, b) = Self::span(axis, first, last)?;
        if (a..=b).any(|i| self.track(sheet, axis, i).level >= 7) {
            return Err(SessionError(
                "the outline is already 7 levels deep there".into(),
            ));
        }
        self.edit_tracks(sheet, axis, a, b, |_, t| t.level += 1);
        self.after_view_change(sheet)
    }

    /// Take rows or columns `first..=last` one level out (Data ▸ Ungroup).
    pub fn ungroup(
        &mut self,
        sheet: u16,
        axis: Axis,
        first: u32,
        last: u32,
    ) -> Result<SetCellResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_format_axis(sheet, axis)?;
        let (a, b) = Self::span(axis, first, last)?;
        if (a..=b).all(|i| self.track(sheet, axis, i).level == 0) {
            return Err(SessionError("nothing there is grouped".into()));
        }
        self.edit_tracks(sheet, axis, a, b, |_, t| {
            t.level = t.level.saturating_sub(1)
        });
        self.after_view_change(sheet)
    }

    /// Collapse (`true`) or expand the innermost group holding row (column)
    /// `at`, or whose summary row it is.
    pub fn set_group_collapsed(
        &mut self,
        sheet: u16,
        axis: Axis,
        at: u32,
        collapsed: bool,
    ) -> Result<SetCellResult, SessionError> {
        self.validate_sheet(sheet)?;
        let mut level = self.track(sheet, axis, at).level;
        let mut probe = at;
        if level == 0 {
            // The summary row of a group: the detail is beside it.
            let (below, right) = self.summary_below_right(sheet);
            let after = match axis {
                Axis::Rows => below,
                Axis::Cols => right,
            };
            let detail = if after {
                at.checked_sub(1)
            } else {
                (at < axis.max()).then_some(at + 1)
            };
            match detail {
                Some(d) if self.track(sheet, axis, d).level > 0 => {
                    probe = d;
                    level = self.track(sheet, axis, d).level;
                }
                _ => return Err(SessionError("no group there".into())),
            }
        }
        let run = self.run_around(sheet, axis, probe, level);
        let summary = self.summary_of(sheet, axis, run);
        if collapsed {
            self.edit_tracks(sheet, axis, run.0, run.1, |_, t| t.hidden = true);
        } else {
            let keep_hidden = self.nested_collapsed(sheet, axis, run, level + 1);
            self.edit_tracks(sheet, axis, run.0, run.1, |i, t| {
                t.hidden = keep_hidden.contains(&i);
            });
        }
        if let Some(s) = summary {
            self.edit_tracks(sheet, axis, s, s, |_, t| t.collapsed = collapsed);
        }
        self.after_view_change(sheet)
    }

    /// The indexes inside `run` that stay hidden when it expands: the
    /// detail of nested groups (level `level` and deeper) that are collapsed.
    fn nested_collapsed(
        &self,
        sheet: u16,
        axis: Axis,
        run: (u32, u32),
        level: u8,
    ) -> BTreeSet<u32> {
        let mut out = BTreeSet::new();
        if level > 7 {
            return out;
        }
        let mut i = run.0;
        while i <= run.1 {
            if self.track(sheet, axis, i).level >= level {
                let sub = self.run_around(sheet, axis, i, level);
                let sub = (sub.0.max(run.0), sub.1.min(run.1));
                let collapsed = self
                    .summary_of(sheet, axis, sub)
                    .is_some_and(|s| self.track(sheet, axis, s).collapsed);
                if collapsed {
                    out.extend(sub.0..=sub.1);
                } else {
                    out.extend(self.nested_collapsed(sheet, axis, sub, level + 1));
                }
                i = sub.1 + 1;
            } else {
                i += 1;
            }
        }
        out
    }

    /// Excel's outline-level buttons: show rows (columns) of level below
    /// `level`, hide the deeper ones, and mark the groups at `level` and
    /// deeper collapsed. `level` 8 (or more) expands everything.
    pub fn show_outline_level(
        &mut self,
        sheet: u16,
        axis: Axis,
        level: u8,
    ) -> Result<SetCellResult, SessionError> {
        self.validate_sheet(sheet)?;
        let groups = self.groups(sheet, axis);
        if groups.is_empty() {
            return Ok(SetCellResult::default());
        }
        let first = groups.iter().map(|g| g.first).min().unwrap_or(0);
        let last = groups.iter().map(|g| g.last).max().unwrap_or(0);
        self.edit_tracks(sheet, axis, first, last, |_, t| {
            if t.level > 0 {
                t.hidden = t.level >= level;
            }
        });
        for g in &groups {
            if let Some(s) = g.summary {
                let c = g.level >= level;
                self.edit_tracks(sheet, axis, s, s, |_, t| t.collapsed = c);
            }
        }
        self.after_view_change(sheet)
    }

    /// Hide (`true`) or unhide rows or columns `first..=last`.
    pub fn set_hidden(
        &mut self,
        sheet: u16,
        axis: Axis,
        first: u32,
        last: u32,
        hidden: bool,
    ) -> Result<SetCellResult, SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_format_axis(sheet, axis)?;
        let (a, b) = Self::span(axis, first, last)?;
        self.edit_tracks(sheet, axis, a, b, |_, t| t.hidden = hidden);
        self.after_view_change(sheet)
    }

    /// Show, hide or very-hide a sheet tab. The last visible sheet cannot
    /// be hidden; a protected workbook structure refuses.
    pub fn set_sheet_state(&mut self, sheet: u16, state: &str) -> Result<(), SessionError> {
        self.validate_sheet(sheet)?;
        self.guard_structure()?;
        let state = match state {
            "visible" => SheetState::Visible,
            "hidden" => SheetState::Hidden,
            "veryHidden" => SheetState::VeryHidden,
            other => {
                return Err(SessionError(format!(
                    "unknown sheet state {other:?} (visible, hidden, veryHidden)"
                )))
            }
        };
        let sheets = &self.engine().model().sheets;
        let others_visible = sheets
            .iter()
            .enumerate()
            .find(|(i, s)| *i != sheet as usize && s.state == SheetState::Visible)
            .map(|(i, _)| i as u32);
        if state != SheetState::Visible && others_visible.is_none() {
            return Err(SessionError(
                "a workbook must keep at least one visible sheet".into(),
            ));
        }
        self.doc
            .set_sheet_state(sheet, state, others_visible)
            .map_err(|e| SessionError(e.to_string()))?;
        let view = self.engine_mut().sheet_view_mut(sheet).expect("validated");
        *view.state = state;
        self.structure_changed = true;
        Ok(())
    }
}

/// Replace columns `first..=last` of `metas` with the per-column records
/// `per`, splitting the ranges that straddle the span and merging equal
/// neighbours again; plain records (nothing beyond their range) are dropped.
fn set_col_metas(metas: &mut Vec<ColMeta>, first: u32, last: u32, per: Vec<ColMeta>) {
    let mut out: Vec<ColMeta> = Vec::new();
    for m in metas.drain(..) {
        if m.max < first || m.min > last {
            out.push(m);
            continue;
        }
        if m.min < first {
            out.push(ColMeta {
                max: first - 1,
                ..m.clone()
            });
        }
        if m.max > last {
            out.push(ColMeta {
                min: last + 1,
                ..m.clone()
            });
        }
    }
    out.extend(per.into_iter().filter(|m| !m.is_plain()));
    out.sort_by_key(|m| m.min);
    let mut merged: Vec<ColMeta> = Vec::new();
    for m in out {
        if let Some(prev) = merged.last_mut() {
            let same = ColMeta {
                min: m.min,
                max: m.max,
                ..prev.clone()
            } == m;
            if same && prev.max + 1 == m.min {
                prev.max = m.max;
                continue;
            }
        }
        merged.push(m);
    }
    *metas = merged;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn col_meta_split_and_merge() {
        let mut v = vec![ColMeta {
            min: 0,
            max: 9,
            style: 3,
            ..Default::default()
        }];
        let per = (3..=4)
            .map(|c| ColMeta {
                min: c,
                max: c,
                style: 3,
                hidden: true,
                ..Default::default()
            })
            .collect();
        set_col_metas(&mut v, 3, 4, per);
        assert_eq!(v.len(), 3);
        assert_eq!((v[1].min, v[1].max, v[1].hidden), (3, 4, true));
        let per = (3..=4)
            .map(|c| ColMeta {
                min: c,
                max: c,
                style: 3,
                ..Default::default()
            })
            .collect();
        set_col_metas(&mut v, 3, 4, per);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].min, v[0].max), (0, 9));
    }
}
