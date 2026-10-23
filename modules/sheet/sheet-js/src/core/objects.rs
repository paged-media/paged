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

//! The object-model doors (ADR 323): the reads the bundle's `table` and
//! `chart` kinds need, and the one chart write.
//!
//! - [`SheetSession::list_tables`] — every structured table, as the model
//!   holds it (name, sheet, full extent, column labels, header/totals flags,
//!   style). READ-ONLY: the xlsx `table` parts re-emit verbatim (spec §10.2),
//!   so a table write would be lost on save; the bundle refuses it.
//! - [`SheetSession::chart_specs`] — every chart with its series ranges and
//!   options (what `list_charts` summarises).
//! - [`SheetSession::update_chart`] — patch one chart's kind, title, legend,
//!   axes, data labels, style references, or replace its series (each with
//!   its own kind and axis group: a combo). The change is written into the
//!   xlsx on save (the chart part is spliced, ADR 503 amendment).

use serde::{Deserialize, Deserializer};
use sheet_core::{CellRef, RangeRef, SheetId, SheetModel};

use super::chart_style::{
    palette, palette_out, role_out, role_style, PaletteIn, PaletteOut, RoleIn, RoleOut, SwatchIn,
};
use super::charts::{chart_kind_from_tag, chart_kind_tag, CHART_KIND_TAGS};
use super::{SessionError, SheetSession};
use sheet_chart::model::{ColorRef, ConcreteColor, DataLabels, Legend, LegendPosition, Series};
use std::collections::BTreeMap;

/// One structured table (ListObject).
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub sheet: u16,
    /// The full extent (header + body + totals), plain A1 without the sheet.
    pub range: String,
    pub columns: Vec<String>,
    pub header_row: bool,
    pub totals_row: bool,
    pub style_name: Option<String>,
}

/// One chart series: ranges as `Sheet!A1:B2` (no `$`).
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSpec {
    pub name: Option<String>,
    pub values: String,
    pub categories: Option<String>,
    /// The fill as `#RRGGBB` (an RGB or resolved theme colour).
    pub color: Option<String>,
    /// The document swatch the fill names.
    pub color_swatch: Option<String>,
    /// The series' plot kind tag (differs from the chart's in a combo).
    pub kind: &'static str,
    pub secondary: bool,
    pub x_values: Option<String>,
    pub sizes: Option<String>,
}

/// One chart with everything the object model reads.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    pub index: u32,
    pub host_sheet: u16,
    pub kind: &'static str,
    pub title: Option<String>,
    pub legend: bool,
    pub series: Vec<SeriesSpec>,
    pub category_axis_title: Option<String>,
    pub value_axis_title: Option<String>,
    pub value_axis_min: Option<f64>,
    pub value_axis_max: Option<f64>,
    pub value_axis_log_base: Option<f64>,
    pub value_axis_format: Option<String>,
    /// `r`, `l`, `t`, `b`, `tr`, or none.
    pub legend_position: Option<&'static str>,
    pub data_labels: bool,
    pub style: Option<u32>,
    pub flattened3d: bool,
    pub title_paragraph_style: Option<String>,
    /// The chart's own document-style overrides by role (sheet ADR 524);
    /// a role absent here follows the workbook default.
    pub roles: BTreeMap<String, RoleOut>,
    /// The chart's own series palette (a document colour group).
    pub series_palette: Option<PaletteOut>,
}

/// A series argument of [`ChartPatch::series`]; empty strings mean none.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SeriesArg {
    pub values: String,
    pub categories: String,
    pub name: String,
    /// `#RRGGBB`; empty = automatic.
    pub color: String,
    /// The document swatch the fill names: `{id, model, fallbackRgb}` or a
    /// bare id (`Color/…`).
    pub color_swatch: Option<SwatchIn>,
    /// This series' kind tag in a combo (empty = the chart's kind).
    pub kind: String,
    pub secondary: bool,
    pub x_values: String,
    pub sizes: String,
}

/// A partial chart update: absent = unchanged; `null` (for the nullable
/// fields) = cleared.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChartPatch {
    pub kind: Option<String>,
    #[serde(deserialize_with = "present")]
    pub title: Option<Option<String>>,
    pub legend: Option<bool>,
    pub series: Option<Vec<SeriesArg>>,
    #[serde(deserialize_with = "present")]
    pub category_axis_title: Option<Option<String>>,
    #[serde(deserialize_with = "present")]
    pub value_axis_title: Option<Option<String>>,
    #[serde(deserialize_with = "present")]
    pub value_axis_min: Option<Option<f64>>,
    #[serde(deserialize_with = "present")]
    pub value_axis_max: Option<Option<f64>>,
    #[serde(deserialize_with = "present")]
    pub value_axis_log_base: Option<Option<f64>>,
    #[serde(deserialize_with = "present")]
    pub value_axis_format: Option<Option<String>>,
    /// `r`, `l`, `t`, `b` or `tr` (and shown).
    pub legend_position: Option<String>,
    /// Show values as data labels on every series.
    pub data_labels: Option<bool>,
    #[serde(deserialize_with = "present")]
    pub style: Option<Option<u32>>,
    /// A document paragraph style for the title (`ParagraphStyle/…`).
    #[serde(deserialize_with = "present")]
    pub title_paragraph_style: Option<Option<String>>,
    /// Sheet ADR 524 — per-role document-style overrides, merged: a role
    /// given `null` gives its override up (the workbook default applies).
    pub roles: Option<BTreeMap<String, Option<RoleIn>>>,
    /// Give every override up first (roles, series swatches, palette).
    pub reset_roles: Option<bool>,
    /// The chart's own series palette; `null` = the workbook default's.
    #[serde(deserialize_with = "present")]
    pub series_palette: Option<Option<PaletteIn>>,
}

/// A field that is present (even as `null`) is `Some(..)`; `default` makes
/// an absent one `None`.
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// `Sheet!A1:B2` (or `Sheet!A1` for one cell), no `$`, the sheet quoted
/// when it must be.
fn plain_range(model: &SheetModel, r: &RangeRef) -> String {
    let n = r.normalized();
    let sheet = model
        .sheet(n.start.sheet)
        .map(|w| sheet_xlsx::structure::quote_sheet(&w.name))
        .unwrap_or_else(|| "#REF".into());
    let at = |row: u32, col: u32| format!("{}{}", sheet_core::col_to_a1(col), row + 1);
    if n.start.row == n.end.row && n.start.col == n.end.col {
        format!("{sheet}!{}", at(n.start.row, n.start.col))
    } else {
        format!(
            "{sheet}!{}:{}",
            at(n.start.row, n.start.col),
            at(n.end.row, n.end.col)
        )
    }
}

/// One cell's computed value, typed (no number format applied): a number,
/// a string, a boolean, `null` for empty, or an error as `{ "error":
/// "#DIV/0!" }`.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(untagged)]
pub enum RawValue {
    Number(f64),
    Text(String),
    Bool(bool),
    Empty(()),
    Error { error: String },
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

impl SheetSession {
    /// The computed VALUES of `range` as seen from `sheet`, typed and
    /// unformatted, row-major. Bounded by the same cell cap as the display
    /// read.
    pub fn get_range_raw(
        &self,
        sheet: u16,
        range: &str,
    ) -> Result<Vec<Vec<RawValue>>, SessionError> {
        let (sheet, cr) = self.resolve_range(sheet, range)?;
        let (top, left, bottom, right) = (
            cr.r0.min(cr.r1),
            cr.c0.min(cr.c1),
            cr.r0.max(cr.r1),
            cr.c0.max(cr.c1),
        );
        let area = (bottom as u64 - top as u64 + 1) * (right as u64 - left as u64 + 1);
        if area > super::T0_LOWER_CELL_CAP {
            return Err(SessionError(format!(
                "range exceeds the T0 lowering cap ({} cells)",
                super::T0_LOWER_CELL_CAP
            )));
        }
        let model = self.engine().model();
        let ws = model.sheet(sheet as SheetId);
        let mut rows = Vec::with_capacity((bottom - top + 1) as usize);
        for r in top..=bottom {
            let mut row = Vec::with_capacity((right - left + 1) as usize);
            for c in left..=right {
                let v = ws.and_then(|w| w.cell(r, c)).map(|cell| &cell.value);
                row.push(match v {
                    None | Some(sheet_core::CellValue::Empty) => RawValue::Empty(()),
                    Some(sheet_core::CellValue::Number(n)) => RawValue::Number(*n),
                    Some(sheet_core::CellValue::Text(t)) => RawValue::Text(t.to_string()),
                    Some(sheet_core::CellValue::Bool(b)) => RawValue::Bool(*b),
                    Some(sheet_core::CellValue::Error(e)) => RawValue::Error {
                        error: e.as_str().to_string(),
                    },
                });
            }
            rows.push(row);
        }
        Ok(rows)
    }

    /// Every structured table, in sheet then definition order.
    pub fn list_tables(&self) -> Vec<TableInfo> {
        let model = self.engine().model();
        let mut out = Vec::new();
        for (i, ws) in model.sheets.iter().enumerate() {
            for t in &ws.tables {
                let n = t.range.normalized();
                out.push(TableInfo {
                    name: t.name.to_string(),
                    sheet: i as u16,
                    range: format!(
                        "{}{}:{}{}",
                        sheet_core::col_to_a1(n.start.col),
                        n.start.row + 1,
                        sheet_core::col_to_a1(n.end.col),
                        n.end.row + 1
                    ),
                    columns: t.columns.iter().map(|c| c.to_string()).collect(),
                    header_row: t.header_row,
                    totals_row: t.totals_row,
                    style_name: t.style_name.as_ref().map(|s| s.to_string()),
                });
            }
        }
        out
    }

    /// Every chart with its series ranges and options.
    pub fn chart_specs(&self) -> Vec<ChartSpec> {
        let model = self.engine().model();
        let theme = self.doc.chart_theme;
        let hex = |c: &ColorRef| -> Option<String> {
            let th = sheet_chart::colors::Theme {
                colors: theme.unwrap_or(sheet_chart::colors::OFFICE_THEME),
            };
            (!matches!(c.concrete, ConcreteColor::Auto)).then(|| th.paint(c, "#808080").hex)
        };
        self.doc
            .charts
            .iter()
            .enumerate()
            .filter(|(i, _)| !self.removed_charts.contains(&(*i as u32)))
            .map(|(i, c)| {
                let m = &c.model;
                ChartSpec {
                    index: i as u32,
                    host_sheet: c.host_sheet,
                    kind: chart_kind_tag(m.kind(), m.grouping()),
                    title: m.title.as_ref().map(|t| t.to_string()),
                    legend: m.legend.is_some(),
                    series: m
                        .plots
                        .iter()
                        .flat_map(|p| p.series.iter().map(move |s| (p, s)))
                        .map(|(p, s)| SeriesSpec {
                            name: s.name.as_ref().map(|t| t.to_string()),
                            values: plain_range(model, &s.values),
                            categories: s.categories.as_ref().map(|r| plain_range(model, r)),
                            color: s.fill.as_ref().and_then(hex),
                            color_swatch: s
                                .fill
                                .as_ref()
                                .and_then(|f| f.doc.as_ref())
                                .map(|d| d.id.clone()),
                            kind: chart_kind_tag(p.kind, p.grouping),
                            secondary: p.secondary,
                            x_values: s.x_values.as_ref().map(|r| plain_range(model, r)),
                            sizes: s.sizes.as_ref().map(|r| plain_range(model, r)),
                        })
                        .collect(),
                    category_axis_title: m.cat_axis.title.as_ref().map(|t| t.to_string()),
                    value_axis_title: m.val_axis.title.as_ref().map(|t| t.to_string()),
                    value_axis_min: m.val_axis.min,
                    value_axis_max: m.val_axis.max,
                    value_axis_log_base: m.val_axis.log_base,
                    value_axis_format: m.val_axis.format.as_ref().map(|t| t.to_string()),
                    legend_position: m.legend.as_ref().map(|l| l.position.tag()),
                    data_labels: m
                        .series()
                        .any(|s| s.labels.as_ref().is_some_and(DataLabels::any))
                        || m.plots
                            .iter()
                            .any(|p| p.labels.as_ref().is_some_and(DataLabels::any)),
                    style: m.style,
                    flattened3d: m.flattened_3d,
                    title_paragraph_style: m
                        .title_style
                        .doc_para_style
                        .as_ref()
                        .map(|t| t.to_string()),
                    roles: sheet_chart::style::overrides(m)
                        .roles
                        .iter()
                        .map(|(k, r)| (k.clone(), role_out(r)))
                        .collect(),
                    series_palette: m.palette.as_ref().map(palette_out),
                }
            })
            .collect()
    }

    /// A range argument (`B2:B5`, `Sheet2!B2:B5`, a name or table) as a
    /// model range, resolved from `sheet`.
    fn range_ref(&self, sheet: u16, text: &str) -> Result<RangeRef, SessionError> {
        let (s, cr) = self.resolve_range(sheet, text)?;
        let cell = |row: u32, col: u32| CellRef {
            sheet: s as SheetId,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        Ok(RangeRef {
            start: cell(cr.r0.min(cr.r1), cr.c0.min(cr.c1)),
            end: cell(cr.r0.max(cr.r1), cr.c0.max(cr.c1)),
        })
    }

    /// Patch chart `index`. Validated whole before anything changes: a bad
    /// kind, an unresolvable range or an empty series list leaves the chart
    /// as it was. A patched chart is spliced into its part on save.
    pub fn update_chart(&mut self, index: u32, patch: ChartPatch) -> Result<(), SessionError> {
        let count = self.doc.charts.len();
        let host_sheet = self
            .doc
            .charts
            .get(index as usize)
            .map(|c| c.host_sheet)
            .ok_or_else(|| {
                SessionError(format!("chart index {index} out of range ({count} charts)"))
            })?;
        self.live_chart(index)?;
        let tag = |t: &str| {
            chart_kind_from_tag(t).ok_or_else(|| {
                SessionError(format!(
                    "unknown chart kind {t:?} ({})",
                    CHART_KIND_TAGS.join("|")
                ))
            })
        };
        let kind = match &patch.kind {
            None => None,
            Some(t) => Some(tag(t)?),
        };
        let series = match &patch.series {
            None => None,
            Some(list) => {
                if list.is_empty() {
                    return Err(SessionError("a chart needs at least one series".into()));
                }
                let mut out = Vec::with_capacity(list.len());
                for a in list {
                    let mut s = Series::of(self.range_ref(host_sheet, &a.values)?);
                    s.categories = match non_empty(&a.categories) {
                        None => None,
                        Some(c) => Some(self.range_ref(host_sheet, &c)?),
                    };
                    s.x_values = match non_empty(&a.x_values) {
                        None => None,
                        Some(c) => Some(self.range_ref(host_sheet, &c)?),
                    };
                    s.sizes = match non_empty(&a.sizes) {
                        None => None,
                        Some(c) => Some(self.range_ref(host_sheet, &c)?),
                    };
                    s.name = non_empty(&a.name).map(Into::into);
                    let mut fill = non_empty(&a.color).and_then(|c| ColorRef::from_hex(&c));
                    match &a.color_swatch {
                        Some(SwatchIn::Id(sw)) if !sw.trim().is_empty() => {
                            // A swatch named without a colour paints automatic
                            // until the document resolves it.
                            let base = fill.unwrap_or_else(ColorRef::auto);
                            let fallback = sheet_chart::model::rgb_of(&base).unwrap_or(0x808080);
                            fill = Some(
                                base.with_doc(sheet_chart::model::doc_swatch(sw.trim(), fallback)),
                            );
                        }
                        Some(r @ SwatchIn::Ref(_)) => {
                            if let Some(d) = r.to_ref()? {
                                fill = Some(sheet_chart::style::swatch_color(&d));
                            }
                        }
                        _ => {}
                    }
                    s.fill = fill;
                    if let Some(k) = non_empty(&a.kind) {
                        let (k, g) = tag(&k)?;
                        s.kind = Some(k);
                        s.grouping = Some(g);
                    }
                    s.secondary = a.secondary;
                    out.push(s);
                }
                Some(out)
            }
        };
        let legend_pos = match patch.legend_position.as_deref() {
            None => None,
            Some(p @ ("r" | "l" | "t" | "b" | "tr")) => Some(LegendPosition::from_tag(p)),
            Some(other) => {
                return Err(SessionError(format!(
                    "unknown legend position {other:?} (r|l|t|b|tr)"
                )))
            }
        };
        let mut roles = Vec::new();
        for (role, r) in patch.roles.iter().flatten() {
            let style = match r {
                None => {
                    role_style(role, &RoleIn::default())?;
                    None
                }
                Some(r) => Some(role_style(role, r)?).filter(|x| !x.is_empty()),
            };
            roles.push((role.clone(), style));
        }
        let new_palette = match &patch.series_palette {
            None => None,
            Some(None) => Some(None),
            Some(Some(p)) => Some(palette(p)?),
        };
        let chart = &mut self.doc.charts[index as usize];
        chart.dirty = true;
        if patch.reset_roles == Some(true) {
            sheet_chart::style::clear_overrides(&mut chart.model);
        }
        for (role, style) in &roles {
            sheet_chart::style::set_role(&mut chart.model, role, style.as_ref());
        }
        if let Some(p) = new_palette {
            chart.model.palette = p;
        }
        let m = &mut chart.model;
        if let Some(s) = series {
            let (k, g) = kind.unwrap_or((m.kind(), m.grouping()));
            m.set_series(s, k, g);
        } else if let Some((k, g)) = kind {
            // A kind change re-types every plot of a one-kind chart; a combo
            // keeps its other plots and changes the first.
            if m.plots.len() == 1 {
                m.plots[0].kind = k;
                m.plots[0].grouping = g;
            } else if let Some(p) = m.plots.first_mut() {
                p.kind = k;
                p.grouping = g;
            }
            if k.is_xy() {
                m.cat_axis.kind = sheet_chart::model::AxisKind::Value;
            } else if m.cat_axis.kind == sheet_chart::model::AxisKind::Value {
                m.cat_axis.kind = sheet_chart::model::AxisKind::Category;
            }
            if matches!(
                k,
                sheet_chart::ChartKind::Pie | sheet_chart::ChartKind::Donut
            ) {
                m.plots[0].vary_colors = true;
            }
        }
        if let Some(t) = patch.title {
            m.title = t.and_then(|t| non_empty(&t)).map(Into::into);
        }
        if let Some(l) = patch.legend {
            m.legend = if l {
                Some(m.legend.clone().unwrap_or_default())
            } else {
                None
            };
        }
        if let Some(p) = legend_pos {
            m.legend.get_or_insert_with(Legend::default).position = p;
        }
        if let Some(t) = patch.category_axis_title {
            m.cat_axis.title = t.and_then(|t| non_empty(&t)).map(Into::into);
        }
        if let Some(t) = patch.value_axis_title {
            m.val_axis.title = t.and_then(|t| non_empty(&t)).map(Into::into);
        }
        if let Some(v) = patch.value_axis_min {
            m.val_axis.min = v;
        }
        if let Some(v) = patch.value_axis_max {
            m.val_axis.max = v;
        }
        if let Some(v) = patch.value_axis_log_base {
            m.val_axis.log_base = v.filter(|b| *b >= 2.0);
        }
        if let Some(v) = patch.value_axis_format {
            m.val_axis.format = v.and_then(|t| non_empty(&t)).map(Into::into);
        }
        if let Some(on) = patch.data_labels {
            for p in &mut m.plots {
                p.labels = None;
                for s in &mut p.series {
                    s.labels = on.then(|| DataLabels {
                        show_value: true,
                        ..DataLabels::default()
                    });
                }
            }
        }
        if let Some(v) = patch.style {
            m.style = v.filter(|s| (1..=48).contains(s));
        }
        if let Some(v) = patch.title_paragraph_style {
            m.title_style.doc_para_style = v.and_then(|t| non_empty(&t));
        }
        Ok(())
    }

    /// Refuse a chart index that names a deleted chart.
    pub(crate) fn live_chart(&self, index: u32) -> Result<(), SessionError> {
        if self.removed_charts.contains(&index) {
            return Err(SessionError(format!("chart {index} was deleted")));
        }
        Ok(())
    }

    /// Delete chart `index`. Its slot stays, so every other chart keeps its
    /// index; it is no longer listed (`list_charts`, `chart_specs`), drawn or
    /// patched. A chart read from the workbook leaves the package on the
    /// next save (`save_xlsx` removes its anchor, relationship and parts);
    /// its slot is then a tombstone ([`chart_tombstones`](Self::chart_tombstones))
    /// that a caller reloading those bytes restores
    /// ([`restore_chart_slots`](Self::restore_chart_slots)), so the indices
    /// placements and journals name stay valid.
    pub fn delete_chart(&mut self, index: u32) -> Result<(), SessionError> {
        let count = self.doc.charts.len();
        if index as usize >= count {
            return Err(SessionError(format!(
                "chart index {index} out of range ({count} charts)"
            )));
        }
        self.live_chart(index)?;
        self.removed_charts.insert(index);
        Ok(())
    }

    /// The deleted slots of charts read from the file (in index order): the
    /// saved bytes no longer carry them, so a reload must re-open them for
    /// the later charts to keep their indices. A chartsheet's chart is never
    /// one: the tab is the chart, so its parts stay and the delete replays.
    pub fn chart_tombstones(&self) -> Vec<u32> {
        self.removed_charts
            .iter()
            .copied()
            .filter(|&i| {
                self.doc
                    .charts
                    .get(i as usize)
                    .is_some_and(|c| c.from_file && !c.chartsheet)
            })
            .collect()
    }

    /// Re-open deleted chart slots after a load: each slot (ascending) is
    /// inserted at its index as a deleted chart read from the file, so the
    /// charts the bytes still carry move back to the indices they had when
    /// the bytes were saved. Called before any chart is added; a slot past
    /// the end (more than one beyond the charts already there) is refused.
    pub fn restore_chart_slots(&mut self, slots: &[u32]) -> Result<(), SessionError> {
        let mut sorted = slots.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        for slot in sorted {
            let at = slot as usize;
            if at > self.doc.charts.len() {
                return Err(SessionError(format!(
                    "chart slot {slot} is past the end ({} charts)",
                    self.doc.charts.len()
                )));
            }
            // Later deletes move up with their charts.
            self.removed_charts = self
                .removed_charts
                .iter()
                .map(|&i| if i >= slot { i + 1 } else { i })
                .collect();
            self.doc.charts.insert(at, tombstone_chart());
            self.removed_charts.insert(slot);
        }
        Ok(())
    }

    /// How many charts are not deleted.
    pub(crate) fn live_chart_count(&self) -> usize {
        self.doc.charts.len() - self.removed_charts.len()
    }
}

/// The stand-in for a chart a save dropped from the file: an empty chart on
/// the first sheet, never listed or drawn (its slot is deleted).
fn tombstone_chart() -> sheet_xlsx::XlsxChart {
    let mut c = sheet_xlsx::XlsxChart::authored(0, sheet_chart::ChartModel::default());
    c.dirty = false;
    c.from_file = true;
    c
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;

    fn session() -> SheetSession {
        let mut s = SheetSession::new();
        for (r, row) in [
            ["", "Q1", "Q2"],
            ["North", "10", "20"],
            ["South", "30", "40"],
        ]
        .iter()
        .enumerate()
        {
            for (c, v) in row.iter().enumerate() {
                if !v.is_empty() {
                    s.set_cell(0, r as u32, c as u32, v).unwrap();
                }
            }
        }
        s
    }

    #[test]
    fn delete_chart_keeps_the_other_indices__feat__sheet_objects() {
        let mut s = session();
        let a = s
            .add_chart(0, "B2:B3", "A2:A3", "column", "A", "columns")
            .unwrap();
        let b = s
            .add_chart(0, "C2:C3", "A2:A3", "line", "B", "columns")
            .unwrap();
        s.delete_chart(a).unwrap();
        let specs = s.chart_specs();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].index, b);
        assert_eq!(s.list_charts().len(), 1);
        assert_eq!(s.list_charts()[0].index, b);
        assert!(s.get_chart_geometry(a, 200.0, 100.0).is_err());
        assert!(s.get_chart_geometry(b, 200.0, 100.0).is_ok());
        assert!(s
            .update_chart(a, ChartPatch::default())
            .unwrap_err()
            .0
            .contains("deleted"));
        // Twice, or out of range, is refused.
        assert!(s.delete_chart(a).is_err());
        assert!(s.delete_chart(9).is_err());
        // A chart added later takes the next slot, never the deleted one.
        let c = s.add_chart(0, "B2:C3", "", "bar", "", "columns").unwrap();
        assert_eq!(c, b + 1);
    }

    #[test]
    fn chart_specs_carry_series_ranges__feat__sheet_objects() {
        let mut s = session();
        let i = s
            .add_chart(0, "B2:C3", "A2:A3", "column", "Sales", "columns")
            .unwrap();
        let spec = &s.chart_specs()[i as usize];
        assert_eq!(spec.kind, "column");
        assert_eq!(spec.title.as_deref(), Some("Sales"));
        assert_eq!(spec.series.len(), 2);
        assert_eq!(spec.series[0].values, "Sheet1!B2:B3");
        assert_eq!(spec.series[0].categories.as_deref(), Some("Sheet1!A2:A3"));
        assert!(spec.legend);
    }

    #[test]
    fn update_chart_patches_and_validates_whole__feat__sheet_objects() {
        let mut s = session();
        let i = s
            .add_chart(0, "B2:C3", "", "column", "", "columns")
            .unwrap();
        let patch = ChartPatch {
            kind: Some("line".into()),
            title: Some(Some("Trend".into())),
            legend: Some(false),
            series: Some(vec![SeriesArg {
                values: "C2:C3".into(),
                categories: "A2:A3".into(),
                name: "Q2".into(),
                ..Default::default()
            }]),
            value_axis_min: Some(Some(0.0)),
            ..Default::default()
        };
        s.update_chart(i, patch).unwrap();
        let spec = &s.chart_specs()[i as usize];
        assert_eq!(spec.kind, "line");
        assert_eq!(spec.title.as_deref(), Some("Trend"));
        assert!(!spec.legend);
        assert_eq!(spec.series.len(), 1);
        assert_eq!(spec.series[0].name.as_deref(), Some("Q2"));
        assert_eq!(spec.value_axis_min, Some(0.0));

        // A bad kind changes nothing.
        let bad = ChartPatch {
            kind: Some("sparkle".into()),
            title: Some(None),
            ..Default::default()
        };
        assert!(s.update_chart(i, bad).is_err());
        assert_eq!(s.chart_specs()[i as usize].title.as_deref(), Some("Trend"));
        // Clearing with null.
        s.update_chart(
            i,
            ChartPatch {
                title: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.chart_specs()[i as usize].title, None);
        assert!(s.update_chart(9, ChartPatch::default()).is_err());
    }

    #[test]
    fn get_range_raw_is_typed_and_unformatted__feat__sheet_objects() {
        let mut s = session();
        s.set_cell(0, 3, 1, "=B2+B3").unwrap();
        s.set_cell(0, 3, 2, "TRUE").unwrap();
        let raw = s.get_range_raw(0, "A2:C4").unwrap();
        assert_eq!(raw[0][0], RawValue::Text("North".into()));
        assert_eq!(raw[0][1], RawValue::Number(10.0));
        assert_eq!(raw[2][0], RawValue::Empty(()));
        assert_eq!(raw[2][1], RawValue::Number(40.0));
        assert_eq!(raw[2][2], RawValue::Bool(true));
        assert!(s.get_range_raw(0, "nope").is_err());
    }

    #[test]
    fn list_tables_is_empty_without_tables__feat__sheet_objects() {
        assert!(session().list_tables().is_empty());
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod corpus_tests {
    use super::*;

    fn load(name: &str) -> SheetSession {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../corpus/xlsx-corpus/");
        let bytes = std::fs::read(format!("{path}{name}")).expect("corpus file");
        SheetSession::load_xlsx(&bytes).expect("loads")
    }

    #[test]
    fn list_tables_reads_the_corpus_table__feat__sheet_objects() {
        let tables = load("07-tables.xlsx").list_tables();
        assert!(!tables.is_empty(), "07-tables.xlsx carries a table");
        let t = &tables[0];
        assert!(!t.name.is_empty());
        assert!(!t.columns.is_empty());
        assert!(t.range.contains(':'));
    }

    #[test]
    fn chart_specs_read_a_parsed_chart__feat__sheet_objects() {
        let specs = load("09-chart.xlsx").chart_specs();
        assert!(!specs.is_empty());
        assert!(!specs[0].series.is_empty());
        assert!(specs[0].series[0].values.contains('!'));
    }
}
