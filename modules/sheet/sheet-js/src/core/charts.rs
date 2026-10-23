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

//! The chart doors (spec §8.4; W4, ADR 518): authoring a chart over live
//! data, the chart list, the geometry of a chart resolved against the live
//! workbook, the chartsheets, and the sparklines.
//!
//! KIND TAGS. One tag per (kind, grouping) pair: `column`,
//! `stackedColumn`, `percentStackedColumn`, the same for `bar`, `line` and
//! `area`, then `scatter`, `bubble`, `pie`, `donut`, `pieOfPie`,
//! `barOfPie`, `radar`, `filledRadar`, `stock`, `surface`, `waterfall`,
//! `funnel`, `treemap`, `sunburst`, `histogram`, `pareto`, `boxWhisker`.
//! A chart Paged does not draw reports `unsupported` (never authorable).
//!
//! LIVE DATA. A value cell gives its number (a boolean 1/0, text 0); an
//! empty or error cell is a gap (Excel draws `#N/A` and blanks as gaps).
//! Categories are the cells' display text; a category range several
//! columns wide (or rows tall, for a row-wise series) is a hierarchy, its
//! first column the outermost level (treemap, sunburst).

use sheet_chart::model::{
    ChartKind, ChartModel, ErrorValue, Grouping, Legend, LineStyle, Marker, MarkerSymbol, Series,
};
use sheet_chart::{generate as generate_chart, ChartGeometry, PlotData, Primitive};
use sheet_core::{CellRef, CellValue, RangeRef, SheetId, SheetModel};
use sheet_format::{FormatCache, FormatCtx};
use sheet_xlsx::XlsxChart;

use super::{cell_display, parse_range, SessionError, SheetSession};

/// One chart in the workbook, for the panel's list.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChartInfo {
    pub index: u32,
    pub host_sheet: u16,
    /// The kind tag (see the module docs).
    pub kind: &'static str,
    pub title: Option<String>,
    pub series_count: u32,
    /// A 3-D chart drawn as its 2-D kind.
    pub flattened3d: bool,
    /// The element the kind came from when it is not the kind's own (a 3-D
    /// element, an unsupported type).
    pub source: Option<String>,
    /// The chart is a chartsheet (its own tab).
    pub chartsheet: bool,
    /// More than one plot (a combo chart).
    pub combo: bool,
}

/// A chartsheet: a sheet tab that is one chart.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChartsheetInfo {
    pub sheet: u16,
    pub name: String,
    /// The chart it shows (an index into the chart list).
    pub chart: Option<u32>,
}

/// One sparkline: the cell it is drawn in and its group's kind.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SparklineInfo {
    pub sheet: u16,
    pub row: u32,
    pub col: u32,
    /// `line`, `column` or `winLoss`.
    pub kind: &'static str,
    /// The data range, `A1:E1` on its sheet.
    pub data: String,
}

/// The kind tags `add_chart` accepts, in panel order.
pub const CHART_KIND_TAGS: &[&str] = &[
    "column",
    "stackedColumn",
    "percentStackedColumn",
    "bar",
    "stackedBar",
    "percentStackedBar",
    "line",
    "stackedLine",
    "percentStackedLine",
    "area",
    "stackedArea",
    "percentStackedArea",
    "scatter",
    "bubble",
    "pie",
    "donut",
    "pieOfPie",
    "barOfPie",
    "radar",
    "filledRadar",
    "stock",
    "surface",
    "waterfall",
    "funnel",
    "treemap",
    "sunburst",
    "histogram",
    "pareto",
    "boxWhisker",
];

/// The tag of a (kind, grouping) pair.
pub(crate) fn chart_kind_tag(kind: ChartKind, grouping: Grouping) -> &'static str {
    use ChartKind as K;
    use Grouping as G;
    match (kind, grouping) {
        (K::Column, G::Standard) => "column",
        (K::Column, G::Stacked) => "stackedColumn",
        (K::Column, G::PercentStacked) => "percentStackedColumn",
        (K::Bar, G::Standard) => "bar",
        (K::Bar, G::Stacked) => "stackedBar",
        (K::Bar, G::PercentStacked) => "percentStackedBar",
        (K::Line, G::Standard) => "line",
        (K::Line, G::Stacked) => "stackedLine",
        (K::Line, G::PercentStacked) => "percentStackedLine",
        (K::Area, G::Standard) => "area",
        (K::Area, G::Stacked) => "stackedArea",
        (K::Area, G::PercentStacked) => "percentStackedArea",
        (K::Scatter, _) => "scatter",
        (K::Bubble, _) => "bubble",
        (K::Pie, _) => "pie",
        (K::Donut, _) => "donut",
        (K::PieOfPie, _) => "pieOfPie",
        (K::BarOfPie, _) => "barOfPie",
        (K::Radar, _) => "radar",
        (K::FilledRadar, _) => "filledRadar",
        (K::Stock, _) => "stock",
        (K::Surface, _) => "surface",
        (K::Waterfall, _) => "waterfall",
        (K::Funnel, _) => "funnel",
        (K::Treemap, _) => "treemap",
        (K::Sunburst, _) => "sunburst",
        (K::Histogram, _) => "histogram",
        (K::Pareto, _) => "pareto",
        (K::BoxWhisker, _) => "boxWhisker",
        (K::Unsupported, _) => "unsupported",
    }
}

/// A tag → its (kind, grouping); the exact inverse of [`chart_kind_tag`]
/// over [`CHART_KIND_TAGS`].
pub(crate) fn chart_kind_from_tag(tag: &str) -> Option<(ChartKind, Grouping)> {
    use ChartKind as K;
    use Grouping as G;
    for k in [
        K::Column,
        K::Bar,
        K::Line,
        K::Area,
        K::Scatter,
        K::Bubble,
        K::Pie,
        K::Donut,
        K::PieOfPie,
        K::BarOfPie,
        K::Radar,
        K::FilledRadar,
        K::Stock,
        K::Surface,
        K::Waterfall,
        K::Funnel,
        K::Treemap,
        K::Sunburst,
        K::Histogram,
        K::Pareto,
        K::BoxWhisker,
    ] {
        for g in [G::Standard, G::Stacked, G::PercentStacked] {
            if chart_kind_tag(k, g) == tag && (g == G::Standard || k.is_category()) {
                return Some((k, g));
            }
        }
    }
    None
}

impl SheetSession {
    /// AUTHOR a chart over live data. `values` is the data block,
    /// `categories` (may be empty) the label range, `kind` a
    /// [`CHART_KIND_TAGS`] tag, empty `title` = none. `series_in` reads one
    /// series per column (`"columns"`, the default) or per row (`"rows"`)
    /// — the same cells read the other way round, never rewritten.
    ///
    /// Scatter takes its first column (row) as X and each other as a
    /// series; bubble takes X, then (Y, size) pairs; stock takes its
    /// columns as high-low-close or open-high-low-close. The chart is
    /// written into the xlsx on save (a generated chart part, ADR 503
    /// amendment), so it survives a round-trip through Excel.
    pub fn add_chart(
        &mut self,
        sheet: u16,
        values: &str,
        categories: &str,
        kind: &str,
        title: &str,
        series_in: &str,
    ) -> Result<u32, SessionError> {
        self.validate_sheet(sheet)?;
        let (kind, grouping) = chart_kind_from_tag(kind).ok_or_else(|| {
            SessionError(format!(
                "unknown chart kind {kind:?} ({})",
                CHART_KIND_TAGS.join("|")
            ))
        })?;
        let by_row = match series_in {
            "" | "columns" => false,
            "rows" => true,
            other => {
                return Err(SessionError(format!(
                    "unknown series orientation {other:?} (columns|rows)"
                )))
            }
        };
        let vr = parse_range(values)?;
        let (top, bottom) = (vr.r0.min(vr.r1), vr.r0.max(vr.r1));
        let (left, right) = (vr.c0.min(vr.c1), vr.c0.max(vr.c1));
        let cell = |row: u32, col: u32| CellRef {
            sheet: sheet as SheetId,
            row,
            col,
            row_abs: false,
            col_abs: false,
        };
        let cat_ref = if categories.is_empty() {
            None
        } else {
            let cr = parse_range(categories)?;
            Some(RangeRef {
                start: cell(cr.r0.min(cr.r1), cr.c0.min(cr.c1)),
                end: cell(cr.r0.max(cr.r1), cr.c0.max(cr.c1)),
            })
        };
        let lanes: Vec<RangeRef> = if by_row {
            (top..=bottom)
                .map(|row| RangeRef {
                    start: cell(row, left),
                    end: cell(row, right),
                })
                .collect()
        } else {
            (left..=right)
                .map(|col| RangeRef {
                    start: cell(top, col),
                    end: cell(bottom, col),
                })
                .collect()
        };
        let mut series: Vec<Series> = Vec::new();
        match kind {
            ChartKind::Scatter | ChartKind::Bubble if lanes.len() >= 2 => {
                let x = lanes[0];
                let step = if kind == ChartKind::Bubble { 2 } else { 1 };
                let mut i = 1;
                while i < lanes.len() {
                    let mut s = Series::of(lanes[i]);
                    s.x_values = Some(x);
                    if kind == ChartKind::Bubble {
                        s.sizes = lanes.get(i + 1).copied();
                    } else {
                        // Excel's default scatter: markers, no lines.
                        s.line = Some(LineStyle {
                            none: true,
                            ..LineStyle::default()
                        });
                    }
                    series.push(s);
                    i += step;
                }
            }
            _ => {
                for l in lanes {
                    let mut s = Series::of(l);
                    s.categories = cat_ref;
                    if kind == ChartKind::Line {
                        s.marker = Some(Marker {
                            symbol: MarkerSymbol::None,
                            ..Marker::default()
                        });
                    }
                    series.push(s);
                }
            }
        }
        if series.is_empty() {
            return Err(SessionError("a chart needs at least one series".into()));
        }
        let mut model = ChartModel::single(kind, grouping, series);
        let first = model.plots.first_mut().expect("one plot");
        if matches!(
            kind,
            ChartKind::Pie | ChartKind::Donut | ChartKind::PieOfPie | ChartKind::BarOfPie
        ) {
            first.vary_colors = true;
        }
        if kind == ChartKind::Stock {
            first.hi_low_lines = true;
            first.up_down_bars = first.series.len() >= 4;
        }
        model.title = (!title.is_empty()).then(|| title.into());
        let n = model.series_count();
        model.legend = (n > 1 || model.kind().is_radial()).then(Legend::default);
        if !model.kind().is_radial() {
            // Excel's default: horizontal major gridlines.
            model.val_axis.major_gridlines = Some(LineStyle::default());
        }
        if model.kind().is_xy() {
            model.cat_axis.kind = sheet_chart::model::AxisKind::Value;
        }
        self.doc
            .charts
            .push(XlsxChart::authored(sheet as SheetId, model));
        Ok((self.doc.charts.len() - 1) as u32)
    }

    /// Every chart: index (the geometry handle), host sheet, kind, title,
    /// series count, and the 3-D, source, chartsheet and combo flags.
    pub fn list_charts(&self) -> Vec<ChartInfo> {
        self.doc
            .charts
            .iter()
            .enumerate()
            .filter(|(i, _)| !self.removed_charts.contains(&(*i as u32)))
            .map(|(i, c)| ChartInfo {
                index: i as u32,
                host_sheet: c.host_sheet,
                kind: chart_kind_tag(c.model.kind(), c.model.grouping()),
                title: c.model.title.as_ref().map(|t| t.to_string()),
                series_count: c.model.series_count() as u32,
                flattened3d: c.model.flattened_3d,
                source: c.model.source.as_ref().map(|t| t.to_string()),
                chartsheet: c.chartsheet,
                combo: c.model.is_combo(),
            })
            .collect()
    }

    /// The chartsheets, in tab order, with the chart each shows.
    pub fn list_chartsheets(&self) -> Vec<ChartsheetInfo> {
        let model = self.engine().model();
        self.doc
            .chartsheets
            .iter()
            .map(|&sid| ChartsheetInfo {
                sheet: sid,
                name: model
                    .sheet(sid)
                    .map(|w| w.name.to_string())
                    .unwrap_or_default(),
                chart: self
                    .doc
                    .charts
                    .iter()
                    .position(|c| c.host_sheet == sid && c.chartsheet)
                    .map(|i| i as u32),
            })
            .collect()
    }

    /// The sparklines of `sheet`.
    pub fn list_sparklines(&self, sheet: u16) -> Vec<SparklineInfo> {
        let mut out = Vec::new();
        for g in self
            .doc
            .sparklines
            .get(&(sheet as SheetId))
            .into_iter()
            .flatten()
        {
            for (data, at) in &g.sparklines {
                let n = data.normalized();
                out.push(SparklineInfo {
                    sheet,
                    row: at.row,
                    col: at.col,
                    kind: match g.kind {
                        sheet_chart::SparklineKind::Line => "line",
                        sheet_chart::SparklineKind::Column => "column",
                        sheet_chart::SparklineKind::WinLoss => "winLoss",
                    },
                    data: format!(
                        "{}{}:{}{}",
                        sheet_core::col_to_a1(n.start.col),
                        n.start.row + 1,
                        sheet_core::col_to_a1(n.end.col),
                        n.end.row + 1
                    ),
                });
            }
        }
        out
    }

    /// The primitives of the sparkline in cell (`row`, `col`) of `sheet`, in
    /// a `w_pt × h_pt` box; `None` when the cell has none.
    pub fn sparkline_geometry(
        &self,
        sheet: u16,
        row: u32,
        col: u32,
        w_pt: f64,
        h_pt: f64,
    ) -> Option<Vec<Primitive>> {
        let model = self.engine().model();
        for g in self
            .doc
            .sparklines
            .get(&(sheet as SheetId))
            .into_iter()
            .flatten()
        {
            for (data, at) in &g.sparklines {
                if at.row == row && at.col == col {
                    let vals = resolve_values(model, data);
                    return Some(sheet_chart::sparkline(
                        g,
                        &vals,
                        w_pt,
                        h_pt,
                        self.doc.chart_theme,
                    ));
                }
            }
        }
        None
    }

    /// Resolve chart `chart_index` against the live model and generate its
    /// geometry for a `w_pt × h_pt` content box — the IR the page lowering
    /// and the grid view both draw.
    pub fn get_chart_geometry(
        &self,
        chart_index: u32,
        w_pt: f64,
        h_pt: f64,
    ) -> Result<ChartGeometry, SessionError> {
        let chart: &XlsxChart = self.doc.charts.get(chart_index as usize).ok_or_else(|| {
            SessionError(format!(
                "chart index {chart_index} out of range ({} charts)",
                self.doc.charts.len()
            ))
        })?;
        self.live_chart(chart_index)?;
        let data = self.plot_data(&chart.model);
        Ok(generate_chart(&chart.model, &data, w_pt, h_pt))
    }

    /// The live data of a chart model.
    pub(crate) fn plot_data(&self, chart: &ChartModel) -> PlotData {
        let model = self.engine().model();
        let ctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
        let mut cache = FormatCache::default();
        let mut data = PlotData {
            format_ctx: ctx,
            theme: self.doc.chart_theme,
            ..PlotData::default()
        };
        for s in chart.series() {
            data.series.push(resolve_values(model, &s.values));
            data.x_values
                .push(s.x_values.as_ref().map(|r| resolve_values(model, r)));
            data.sizes
                .push(s.sizes.as_ref().map(|r| resolve_values(model, r)));
            data.names.push(s.name_ref.as_ref().map(|r| {
                let n = r.normalized();
                cell_display(
                    model,
                    n.start.sheet,
                    n.start.row,
                    n.start.col,
                    &mut cache,
                    &ctx,
                )
            }));
            let n = s.values.normalized();
            data.value_formats.push(
                model
                    .sheet(n.start.sheet)
                    .and_then(|ws| ws.cell(n.start.row, n.start.col))
                    .map(|c| model.styles.num_fmt_of(c.style).to_string())
                    .filter(|f| f != "General"),
            );
            data.custom_errors.push(
                s.error_bars
                    .iter()
                    .map(|e| match &e.value {
                        ErrorValue::Custom { plus, minus } => (
                            plus.as_ref().map(|r| resolve_values(model, r)),
                            minus.as_ref().map(|r| resolve_values(model, r)),
                        ),
                        _ => (None, None),
                    })
                    .collect(),
            );
        }
        if let Some(cat) = chart.series().find_map(|s| s.categories.as_ref()) {
            let (levels, serials) = resolve_levels(model, cat, &mut cache, &ctx);
            data.categories = levels.last().cloned().unwrap_or_default();
            if levels.len() > 1 {
                data.category_levels = levels;
            }
            data.category_serials = serials;
        }
        data
    }
}

/// A values range as numbers, row-major: a number its value, a boolean
/// 1/0, text 0, an empty or error cell a gap (NaN).
pub(crate) fn resolve_values(model: &SheetModel, range: &RangeRef) -> Vec<f64> {
    let r = range.normalized();
    let ws = model.sheet(r.start.sheet);
    let mut out = Vec::new();
    for row in r.start.row..=r.end.row {
        for col in r.start.col..=r.end.col {
            let v = ws
                .and_then(|ws| ws.cell(row, col))
                .map_or(f64::NAN, |c| match &c.value {
                    CellValue::Number(n) => *n,
                    CellValue::Bool(b) => f64::from(u8::from(*b)),
                    CellValue::Text(_) => 0.0,
                    _ => f64::NAN,
                });
            out.push(v);
        }
    }
    out
}

/// A category range as display labels: one level per column of a tall
/// range (or per row of a wide one), outermost first; plus the serial
/// numbers when every label cell is a number (a date axis).
fn resolve_levels(
    model: &SheetModel,
    range: &RangeRef,
    cache: &mut FormatCache,
    ctx: &FormatCtx,
) -> (Vec<Vec<String>>, Option<Vec<f64>>) {
    let r = range.normalized();
    let sheet = r.start.sheet;
    let rows = r.end.row - r.start.row + 1;
    let cols = r.end.col - r.start.col + 1;
    let tall = rows >= cols;
    let mut levels: Vec<Vec<String>> = Vec::new();
    if tall {
        for col in r.start.col..=r.end.col {
            levels.push(
                (r.start.row..=r.end.row)
                    .map(|row| cell_display(model, sheet, row, col, cache, ctx))
                    .collect(),
            );
        }
    } else {
        for row in r.start.row..=r.end.row {
            levels.push(
                (r.start.col..=r.end.col)
                    .map(|col| cell_display(model, sheet, row, col, cache, ctx))
                    .collect(),
            );
        }
    }
    let inner = if tall {
        RangeRef {
            start: CellRef {
                col: r.end.col,
                ..r.start
            },
            end: r.end,
        }
    } else {
        RangeRef {
            start: CellRef {
                row: r.end.row,
                ..r.start
            },
            end: r.end,
        }
    };
    let ws = model.sheet(sheet);
    let n = inner.normalized();
    let mut serials = Vec::new();
    let mut all_numbers = true;
    for row in n.start.row..=n.end.row {
        for col in n.start.col..=n.end.col {
            match ws.and_then(|w| w.cell(row, col)).map(|c| &c.value) {
                Some(CellValue::Number(v)) => serials.push(*v),
                _ => all_numbers = false,
            }
        }
    }
    (
        levels,
        (all_numbers && !serials.is_empty()).then_some(serials),
    )
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn tags_round_trip__feat__sheet_chart_kinds() {
        for tag in CHART_KIND_TAGS {
            let (k, g) = chart_kind_from_tag(tag).unwrap_or_else(|| panic!("{tag}"));
            assert_eq!(chart_kind_tag(k, g), *tag);
        }
        assert!(chart_kind_from_tag("unsupported").is_none());
        assert!(chart_kind_from_tag("stackedPie").is_none());
    }

    fn session() -> SheetSession {
        let mut s = SheetSession::new();
        let rows = [
            ["", "X", "Y", "Z"],
            ["a", "1", "10", "3"],
            ["b", "2", "20", "4"],
            ["c", "3", "15", "5"],
        ];
        for (r, row) in rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                if !v.is_empty() {
                    s.set_cell(0, r as u32, c as u32, v).unwrap();
                }
            }
        }
        s
    }

    #[test]
    fn every_kind_is_authorable_and_draws__feat__sheet_chart_kinds() {
        let mut s = session();
        for tag in CHART_KIND_TAGS {
            let i = s.add_chart(0, "B2:D4", "A2:A4", tag, "T", "").unwrap();
            let info = &s.list_charts()[i as usize];
            assert_eq!(info.kind, *tag);
            let g = s.get_chart_geometry(i, 300.0, 200.0).unwrap();
            assert!(g.prims.len() > 2, "{tag} draws");
        }
    }

    #[test]
    fn scatter_and_bubble_take_x_first__feat__sheet_chart_kinds() {
        let mut s = session();
        let i = s.add_chart(0, "B2:D4", "", "scatter", "", "").unwrap();
        let m = &s.doc.charts[i as usize].model;
        assert_eq!(m.series_count(), 2);
        assert_eq!(m.series().next().unwrap().x_values.unwrap().start.col, 1);
        let i = s.add_chart(0, "B2:D4", "", "bubble", "", "").unwrap();
        let m = &s.doc.charts[i as usize].model;
        assert_eq!(m.series_count(), 1);
        assert_eq!(m.series().next().unwrap().sizes.unwrap().start.col, 3);
    }

    #[test]
    fn blanks_are_gaps_and_names_are_live__feat__sheet_chart_kinds() {
        let mut s = session();
        s.set_cell(0, 2, 2, "").unwrap();
        let i = s.add_chart(0, "C2:C4", "A2:A4", "line", "", "").unwrap();
        let mut m = s.doc.charts[i as usize].model.clone();
        m.plots[0].series[0].name_ref = Some(RangeRef {
            start: CellRef {
                sheet: 0,
                row: 0,
                col: 2,
                row_abs: false,
                col_abs: false,
            },
            end: CellRef {
                sheet: 0,
                row: 0,
                col: 2,
                row_abs: false,
                col_abs: false,
            },
        });
        let d = s.plot_data(&m);
        assert!(d.series[0][1].is_nan());
        assert_eq!(d.names[0].as_deref(), Some("Y"));
        assert_eq!(d.categories, vec!["a", "b", "c"]);
    }
}
