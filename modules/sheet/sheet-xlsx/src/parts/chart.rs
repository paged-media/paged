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

//! `xl/charts/chartN.xml` — a DrawingML chart (ECMA-376 §21.2; the M2 charts
//! track, spec §8.4), read by the shared DrawingML chart reader
//! (`dml_chart`, `platform/shared/dml-chart`, which paged.slide reads its
//! charts with too) and folded into the FROZEN [`sheet_chart::ChartModel`] so
//! the engine (`sheet-js`) can list + render them on both surfaces (one
//! geometry generator, two projections). The Excel layout profile —
//! `sheet_chart`'s curated kinds and geometry — stays this module's.
//!
//! ## What we read (the T2 honest subset)
//!
//! - The chart KIND from the plot-area child element (`c:barChart` with
//!   `c:barDir val="bar"|"col"` and `c:grouping val="stacked"|"percentStacked"`;
//!   `c:areaChart`; `c:lineChart`; `c:pieChart` / `c:doughnutChart`;
//!   `c:scatterChart`; `c:radarChart`). The last of these in the plot area
//!   decides; a 3-D variant does not.
//!   RULING (`sheet.chart.xlsx.grouping`): a bar/column chart's `c:grouping`
//!   selects the STACKED kind — before this it was ignored, so an Excel
//!   stacked chart imported as a GROUPED one and rendered wrong without
//!   saying so. `percentStacked` reads as `stacked` (the segment proportions
//!   are right; the axis is not normalised to 100% — an honest, labelled
//!   approximation, not a claim). `c:grouping` on a LINE or AREA chart is
//!   still ignored: those kinds have no stacked variant in the curated set,
//!   so they render unstacked — labelled here, never silently.
//! - Each `c:ser` series of every plot, in file order: its title `c:tx` (the
//!   cached string), the category labels `c:cat` (a `c:f` range ref), the
//!   values `c:val` (a `c:f` range ref), and its fixed colour: the first
//!   `<a:srgbClr val="RRGGBB"/>` in the series. A `c:scatterChart` series
//!   pairs `c:xVal` (→ first series) + `c:yVal`.
//! - The chart title: the first non-empty text run (`a:t`, or a cached
//!   `c:v`) of the first `c:title` that has one.
//! - Whether a `c:legend` is present.
//!
//! ## Range refs
//!
//! A `c:f` body is a sheet-qualified A1 range like `Sheet1!$B$1:$B$3` (or
//! quoted `'My Sheet'!$A$1:$A$5`). We resolve the sheet name through the
//! caller-supplied [`SheetResolver`] (the workbook's name→id map); an unknown
//! sheet defaults to the chart's host sheet so the binding still resolves. A
//! single-cell ref (`Sheet1!$B$1`) becomes a 1×1 range.
//!
//! ## Round-trip (preservation invariant, spec §10.2)
//!
//! Parsing here is ADDITIVE and READ-ONLY: the chart part stays an OPAQUE OPC
//! part (never promoted to `Modeled`), so it re-emits BYTE-IDENTICAL on
//! round-trip whether or not this model is built. We understand the chart for
//! rendering; we do not rewrite it. The worksheet's `<drawing>` element (which
//! anchors the chart) is likewise an unknown `<worksheet>` child captured
//! verbatim. Re-emitting a fully edited chart part is a later tier; T2's
//! contract is parse-for-render + preserve-on-save.

use crate::error::XlsxError;
use compact_str::CompactString;
use dml_chart::{PlotKind, Series as DmlSeries};
use paged_ooxml::tree::{El, Ns};
use sheet_chart::model::{Axis, ChartKind, ChartModel, Series};
use sheet_core::{parse_a1, CellRef, RangeRef, SheetId};

/// Resolves an XLSX sheet NAME to its model [`SheetId`]. The caller supplies
/// the workbook's name→id map (the chart parser depends only on `sheet-core`
/// types, never the live model).
pub trait SheetResolver {
    /// The model sheet id for `name`, or `None` if the workbook has no such
    /// sheet (a dangling chart reference — the parser falls back to the host).
    fn resolve(&self, name: &str) -> Option<SheetId>;
}

/// A parsed chart plus the host sheet it is anchored to (resolved from the
/// drawing anchor by the caller). The [`ChartModel`] is the frozen IR the
/// geometry generator projects.
#[derive(Clone, Debug)]
pub struct ParsedChart {
    /// The worksheet that hosts the chart (from the drawing anchor).
    pub host_sheet: SheetId,
    /// The frozen chart model (kind, series, axes, legend).
    pub model: ChartModel,
}

/// One series, read for the Excel profile.
struct SeriesAccum {
    name: Option<CompactString>,
    categories: Option<RangeRef>,
    values: Option<RangeRef>,
    x_values: Option<RangeRef>,
    color: Option<CompactString>,
}

/// Parse a `chartN.xml` part into a [`ParsedChart`]. `host_sheet` is the
/// worksheet the chart's drawing is anchored to; `resolver` maps `c:f` sheet
/// names to model ids. Returns `Err` only on malformed XML — an unrecognized /
/// empty chart yields a model with a defaulted kind and no series (still
/// round-trips, since the part stays opaque).
pub fn parse(
    xml: &[u8],
    host_sheet: SheetId,
    resolver: &impl SheetResolver,
) -> Result<ParsedChart, XlsxError> {
    let root = paged_ooxml::tree::parse(xml).map_err(XlsxError::Structure)?;
    let chart = dml_chart::chart(&root, &ExcelProfile);

    // The kind: the last plot of a curated type (3-D variants are not);
    // a bar plot's own direction and grouping pick its variant.
    let mut kind: Option<ChartKind> = None;
    for plot in &chart.plots {
        kind = match (plot.element.as_str(), &plot.kind) {
            (
                "barChart",
                PlotKind::Bar {
                    horizontal,
                    grouping,
                    ..
                },
            ) => {
                let stacked = matches!(grouping.as_str(), "stacked" | "percentStacked");
                Some(match (*horizontal, stacked) {
                    (false, false) => ChartKind::Column,
                    (false, true) => ChartKind::StackedColumn,
                    (true, false) => ChartKind::Bar,
                    (true, true) => ChartKind::StackedBar,
                })
            }
            ("lineChart", _) => Some(ChartKind::Line),
            ("areaChart", _) => Some(ChartKind::Area),
            ("pieChart", _) => Some(ChartKind::Pie),
            ("doughnutChart", _) => Some(ChartKind::Donut),
            ("scatterChart", _) => Some(ChartKind::Scatter),
            ("radarChart", _) => Some(ChartKind::Radar),
            _ => kind,
        };
    }
    let kind = kind.unwrap_or(ChartKind::Column);

    // The series of every plot, in file order, beside their elements (the
    // colour is the first sRGB colour anywhere in the series).
    let series_els = series_elements(&root);
    let mut series = Vec::new();
    for (i, s) in chart.plots.iter().flat_map(|p| &p.series).enumerate() {
        series.push(accum(s, series_els.get(i).copied(), host_sheet, resolver));
    }

    let title = title_text(&root).map(CompactString::new);
    let model = build_model(kind, series, title, chart.legend.is_some(), host_sheet);
    Ok(ParsedChart { host_sheet, model })
}

/// What the Excel profile reads of a chart: no paints, no cached values (a
/// series binds to the cells its formulas name), no axes or data labels (the
/// curated layout draws its own).
struct ExcelProfile;

impl dml_chart::Props for ExcelProfile {
    type Shape = ();
    type Text = ();
    fn shape(&self, _: &El) {}
    fn text(&self, _: &El) {}
    const CACHES: bool = false;
    const AXES_AND_LABELS: bool = false;
}

/// The `c:ser` elements of every plot, in the order the reader reads them.
fn series_elements(root: &El) -> Vec<&El> {
    let Some(pa) = root.path(&[(Ns::C, "chart"), (Ns::C, "plotArea")]) else {
        return Vec::new();
    };
    pa.children
        .iter()
        .filter(|p| p.ns == Ns::C && p.local.ends_with("Chart"))
        .flat_map(|p| p.children_named(Ns::C, "ser"))
        .collect()
}

fn accum(
    s: &DmlSeries,
    el: Option<&El>,
    host_sheet: SheetId,
    resolver: &impl SheetResolver,
) -> SeriesAccum {
    let range = |f: &Option<String>| {
        f.as_deref()
            .and_then(|f| parse_f_ref(f.trim(), host_sheet, resolver))
    };
    let name = s.name.trim();
    SeriesAccum {
        name: (!name.is_empty()).then(|| CompactString::new(name)),
        categories: range(&s.refs.categories),
        values: range(&s.refs.values).or_else(|| range(&s.refs.y_values)),
        x_values: range(&s.refs.x_values),
        color: el.and_then(first_srgb).map(|v| rgb_to_hex(&v)),
    }
}

/// The first `a:srgbClr` value in `el`, in document order.
fn first_srgb(el: &El) -> Option<String> {
    if el.local == "srgbClr" {
        if let Some(v) = el.attr("val") {
            return Some(v.to_string());
        }
    }
    el.children.iter().find_map(first_srgb)
}

/// The chart's title text: the first non-empty `a:t` run or cached `c:v`
/// (trimmed) inside a `c:title`, in document order.
fn title_text(el: &El) -> Option<String> {
    if el.local == "title" {
        if let Some(t) = first_text(el) {
            return Some(t);
        }
    }
    el.children.iter().find_map(title_text)
}

fn first_text(el: &El) -> Option<String> {
    if el.local == "t" || el.local == "v" {
        let t = el.text.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    el.children.iter().find_map(first_text)
}

/// Fold the parsed series accumulators into the frozen [`ChartModel`]. Scatter
/// folds `x_values`/`values` into the model's `series[0]`=X, `series[1]`=Y
/// ordering the geometry generator expects (the xVal/yVal pairing).
fn build_model(
    kind: ChartKind,
    accums: Vec<SeriesAccum>,
    title: Option<CompactString>,
    legend: bool,
    host_sheet: SheetId,
) -> ChartModel {
    let empty = || RangeRef {
        start: CellRef {
            sheet: host_sheet,
            row: 0,
            col: 0,
            row_abs: false,
            col_abs: false,
        },
        end: CellRef {
            sheet: host_sheet,
            row: 0,
            col: 0,
            row_abs: false,
            col_abs: false,
        },
    };

    let mut series: Vec<Series> = Vec::new();
    if kind == ChartKind::Scatter {
        // Scatter: emit X (from xVal) as series 0 and Y (from val) as series 1,
        // matching the geometry generator's (series[0]=X, series[1]=Y) reading.
        if let Some(first) = accums.into_iter().next() {
            if let Some(xr) = first.x_values {
                series.push(Series {
                    name: first.name.clone(),
                    categories: first.categories,
                    values: xr,
                    color: first.color.clone(),
                });
            }
            series.push(Series {
                name: first.name,
                categories: first.categories,
                values: first.values.unwrap_or_else(empty),
                color: first.color,
            });
        }
    } else {
        for a in accums {
            series.push(Series {
                name: a.name,
                categories: a.categories,
                values: a.values.unwrap_or_else(empty),
                color: a.color,
            });
        }
    }

    ChartModel {
        kind,
        title,
        series,
        cat_axis: Axis::default(),
        val_axis: Axis::default(),
        legend,
    }
}

/// Parse a `c:f` range-ref body (`Sheet1!$B$1:$B$3`, `'My Sheet'!$A$1`, or a
/// bare `$B$1:$B$3`) into a [`RangeRef`]. The sheet name resolves through
/// `resolver`; an unqualified or unknown ref anchors to `host_sheet`.
fn parse_f_ref(s: &str, host_sheet: SheetId, resolver: &impl SheetResolver) -> Option<RangeRef> {
    if s.is_empty() {
        return None;
    }
    let (sheet_part, range_part) = split_sheet_ref(s);
    let sheet = sheet_part
        .and_then(|name| resolver.resolve(&name))
        .unwrap_or(host_sheet);

    let mk = |row, col| CellRef {
        sheet,
        row,
        col,
        row_abs: false,
        col_abs: false,
    };
    match range_part.split_once(':') {
        Some((a, b)) => {
            let (r0, c0, _, _) = parse_a1(strip_dollars(a).as_str())?;
            let (r1, c1, _, _) = parse_a1(strip_dollars(b).as_str())?;
            Some(RangeRef {
                start: mk(r0, c0),
                end: mk(r1, c1),
            })
        }
        None => {
            let (r, c, _, _) = parse_a1(strip_dollars(range_part).as_str())?;
            Some(RangeRef {
                start: mk(r, c),
                end: mk(r, c),
            })
        }
    }
}

/// Split a possibly sheet-qualified ref into `(Some(sheet_name), range)` or
/// `(None, range)`. Handles quoted sheet names (`'My Sheet'!A1`) — the `'!'`
/// separator is the LAST `!` outside quotes; T2 takes the first `!` after an
/// optional balanced single-quoted name (the common XLSX writer form).
fn split_sheet_ref(s: &str) -> (Option<String>, &str) {
    if let Some(rest) = s.strip_prefix('\'') {
        // Quoted sheet name: read up to the closing quote (doubled '' = literal).
        if let Some(close) = find_closing_quote(rest) {
            let name = rest[..close].replace("''", "'");
            let after = &rest[close + 1..];
            if let Some(range) = after.strip_prefix('!') {
                return (Some(name), range);
            }
        }
        return (None, s);
    }
    match s.split_once('!') {
        Some((name, range)) => (Some(name.to_string()), range),
        None => (None, s),
    }
}

/// Index of the closing `'` of a single-quoted sheet name in `s` (a doubled
/// `''` is an escaped quote, not the close). `None` if unterminated.
fn find_closing_quote(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if bytes.get(i + 1) == Some(&b'\'') {
                i += 2; // escaped quote
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Drop `$` absolute markers from an A1 cell token (the chart `c:f` body always
/// writes absolute refs; `parse_a1` handles `$` itself, but a leading `$` on a
/// quoted-stripped token is normalized here for the `:`-split halves).
fn strip_dollars(s: &str) -> String {
    s.replace('$', "")
}

/// `RRGGBB` (DrawingML, no alpha) → `#RRGGBB` (the chart-model swatch form).
fn rgb_to_hex(rgb: &str) -> CompactString {
    let hex = rgb.trim().trim_start_matches('#');
    let mut out = String::with_capacity(7);
    out.push('#');
    out.push_str(&hex.to_ascii_uppercase());
    CompactString::new(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Names(HashMap<String, SheetId>);
    impl SheetResolver for Names {
        fn resolve(&self, name: &str) -> Option<SheetId> {
            self.0.get(name).copied()
        }
    }
    fn names() -> Names {
        let mut m = HashMap::new();
        m.insert("Sheet1".to_string(), 0u16);
        m.insert("Data".to_string(), 1u16);
        Names(m)
    }

    fn bar_chart_xml(bar_dir: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Q1 Revenue</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea>
      <c:barChart>
        <c:barDir val="{bar_dir}"/>
        <c:ser>
          <c:idx val="0"/>
          <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:spPr><a:solidFill><a:srgbClr val="3366CC"/></a:solidFill></c:spPr>
          <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f></c:numRef></c:val>
        </c:ser>
      </c:barChart>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/></c:legend>
  </c:chart>
</c:chartSpace>"#
        )
        .into_bytes()
    }

    #[test]
    fn parses_column_chart_series_title_legend_color() {
        let chart = parse(&bar_chart_xml("col"), 0, &names()).unwrap();
        assert_eq!(chart.host_sheet, 0);
        assert_eq!(chart.model.kind, ChartKind::Column);
        assert_eq!(chart.model.title.as_deref(), Some("Q1 Revenue"));
        assert!(chart.model.legend);
        assert_eq!(chart.model.series.len(), 1);
        let s = &chart.model.series[0];
        assert_eq!(s.name.as_deref(), Some("Revenue"));
        assert_eq!(s.color.as_deref(), Some("#3366CC"));
        // values = Sheet1!$B$2:$B$4 → rows 1..3, col 1, sheet 0.
        assert_eq!(s.values.start.sheet, 0);
        assert_eq!(s.values.start.row, 1);
        assert_eq!(s.values.start.col, 1);
        assert_eq!(s.values.end.row, 3);
        // categories = $A$2:$A$4.
        let cats = s.categories.unwrap();
        assert_eq!(cats.start.col, 0);
        assert_eq!(cats.end.row, 3);
    }

    #[test]
    fn bar_dir_bar_selects_horizontal_kind() {
        let chart = parse(&bar_chart_xml("bar"), 0, &names()).unwrap();
        assert_eq!(chart.model.kind, ChartKind::Bar);
    }

    /// `<c:barChart>` with an explicit `barDir` + `grouping` (the ECMA child
    /// order), one series — the stacked-import fixture.
    fn grouped_bar_xml(bar_dir: &str, grouping: &str) -> Vec<u8> {
        format!(
            r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart><c:plotArea><c:barChart>
  <c:barDir val="{bar_dir}"/>
  <c:grouping val="{grouping}"/>
  <c:ser><c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser>
</c:barChart></c:plotArea></c:chart></c:chartSpace>"#
        )
        .into_bytes()
    }

    #[test]
    fn bar_grouping_selects_the_stacked_kind() {
        // Before `c:grouping` was read, an Excel STACKED chart imported as a
        // grouped one and rendered wrong without saying so.
        let kind = |dir, grp| {
            parse(&grouped_bar_xml(dir, grp), 0, &names())
                .unwrap()
                .model
                .kind
        };
        assert_eq!(kind("col", "clustered"), ChartKind::Column);
        assert_eq!(kind("col", "stacked"), ChartKind::StackedColumn);
        assert_eq!(kind("col", "percentStacked"), ChartKind::StackedColumn);
        assert_eq!(kind("bar", "clustered"), ChartKind::Bar);
        assert_eq!(kind("bar", "stacked"), ChartKind::StackedBar);
        assert_eq!(kind("bar", "percentStacked"), ChartKind::StackedBar);
        // An absent grouping keeps the unstacked default.
        assert_eq!(
            parse(&bar_chart_xml("col"), 0, &names())
                .unwrap()
                .model
                .kind,
            ChartKind::Column
        );
    }

    #[test]
    fn line_and_area_grouping_is_ignored_not_misread() {
        // `c:grouping` is shared by bar/line/area. The curated set has no
        // stacked line/area, so a stacked line chart must stay a LINE — never
        // leak the bar family's stacked kind (the labelled ruling).
        let mk = |body: &str| -> Vec<u8> {
            format!(
                r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart><c:plotArea>{body}</c:plotArea></c:chart></c:chartSpace>"#
            )
            .into_bytes()
        };
        let ser = r#"<c:grouping val="stacked"/><c:ser><c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser>"#;
        assert_eq!(
            parse(
                &mk(&format!("<c:lineChart>{ser}</c:lineChart>")),
                0,
                &names()
            )
            .unwrap()
            .model
            .kind,
            ChartKind::Line
        );
        assert_eq!(
            parse(
                &mk(&format!("<c:areaChart>{ser}</c:areaChart>")),
                0,
                &names()
            )
            .unwrap()
            .model
            .kind,
            ChartKind::Area
        );
    }

    #[test]
    fn radar_chart_kind() {
        let xml =
            br#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart><c:plotArea><c:radarChart>
  <c:radarStyle val="marker"/>
  <c:ser>
    <c:cat><c:strRef><c:f>Sheet1!$A$1:$A$5</c:f></c:strRef></c:cat>
    <c:val><c:numRef><c:f>Sheet1!$B$1:$B$5</c:f></c:numRef></c:val>
  </c:ser>
</c:radarChart></c:plotArea></c:chart></c:chartSpace>"#;
        let chart = parse(xml, 0, &names()).unwrap();
        assert_eq!(chart.model.kind, ChartKind::Radar);
        assert_eq!(chart.model.series.len(), 1);
        assert_eq!(chart.model.series[0].values.rows(), 5);
    }

    #[test]
    fn pie_and_doughnut_and_line_kinds() {
        let mk = |body: &str| -> Vec<u8> {
            format!(
                r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart><c:plotArea>{body}</c:plotArea></c:chart></c:chartSpace>"#
            )
            .into_bytes()
        };
        let ser =
            r#"<c:ser><c:val><c:numRef><c:f>Sheet1!$B$1:$B$3</c:f></c:numRef></c:val></c:ser>"#;
        assert_eq!(
            parse(&mk(&format!("<c:pieChart>{ser}</c:pieChart>")), 0, &names())
                .unwrap()
                .model
                .kind,
            ChartKind::Pie
        );
        assert_eq!(
            parse(
                &mk(&format!("<c:doughnutChart>{ser}</c:doughnutChart>")),
                0,
                &names()
            )
            .unwrap()
            .model
            .kind,
            ChartKind::Donut
        );
        assert_eq!(
            parse(
                &mk(&format!("<c:lineChart>{ser}</c:lineChart>")),
                0,
                &names()
            )
            .unwrap()
            .model
            .kind,
            ChartKind::Line
        );
        assert_eq!(
            parse(
                &mk(&format!("<c:areaChart>{ser}</c:areaChart>")),
                0,
                &names()
            )
            .unwrap()
            .model
            .kind,
            ChartKind::Area
        );
    }

    #[test]
    fn scatter_pairs_xval_yval() {
        let xml =
            br#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart><c:plotArea><c:scatterChart>
  <c:ser>
    <c:xVal><c:numRef><c:f>Data!$A$1:$A$3</c:f></c:numRef></c:xVal>
    <c:yVal><c:numRef><c:f>Data!$B$1:$B$3</c:f></c:numRef></c:yVal>
  </c:ser>
</c:scatterChart></c:plotArea></c:chart></c:chartSpace>"#;
        let chart = parse(xml, 0, &names()).unwrap();
        assert_eq!(chart.model.kind, ChartKind::Scatter);
        // Two model series: [0] = X (Data col A), [1] = Y (Data col B); sheet 1.
        assert_eq!(chart.model.series.len(), 2);
        assert_eq!(chart.model.series[0].values.start.sheet, 1);
        assert_eq!(chart.model.series[0].values.start.col, 0);
        assert_eq!(chart.model.series[1].values.start.col, 1);
    }

    #[test]
    fn unknown_sheet_falls_back_to_host() {
        // A ref to a sheet the workbook doesn't have anchors to the host sheet.
        let xml =
            br#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<c:chart><c:plotArea><c:barChart><c:barDir val="col"/>
  <c:ser><c:val><c:numRef><c:f>Ghost!$B$2:$B$4</c:f></c:numRef></c:val></c:ser>
</c:barChart></c:plotArea></c:chart></c:chartSpace>"#;
        let chart = parse(xml, 3, &names()).unwrap();
        assert_eq!(chart.model.series[0].values.start.sheet, 3);
    }

    #[test]
    fn malformed_is_error_not_panic() {
        let chart = parse(b"<c:chartSpace><c:chart>", 0, &names());
        // Truncated XML may parse (lenient quick-xml) or error; either way it
        // never panics and yields a defaulted-kind model when it parses.
        if let Ok(c) = chart {
            assert_eq!(c.model.kind, ChartKind::Column);
            assert!(c.model.series.is_empty());
        }
    }

    /// The Excel-profile rules this reader kept from its streaming
    /// predecessor, on the shapes the corpus has (multi-run titles, a title
    /// only on an axis, a line series coloured by its outline).
    #[test]
    fn excel_profile_title_and_colour_rules() {
        let xml = br#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<c:chart>
  <c:title><c:tx><c:rich><a:p><a:r><a:t> </a:t></a:r><a:r><a:t>North </a:t></a:r><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title>
  <c:plotArea>
    <c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/>
      <c:ser><c:tx><c:v> Plan </c:v></c:tx><c:val><c:numRef><c:f>Sheet1!$B$1:$B$2</c:f></c:numRef></c:val></c:ser>
    </c:barChart>
    <c:lineChart>
      <c:ser><c:spPr><a:ln><a:solidFill><a:srgbClr val="aa0000"/></a:solidFill></a:ln></c:spPr><c:marker><c:spPr><a:solidFill><a:srgbClr val="00AA00"/></a:solidFill></c:spPr></c:marker><c:val><c:numRef><c:f>Sheet1!$C$1:$C$2</c:f></c:numRef></c:val></c:ser>
    </c:lineChart>
    <c:catAx><c:title><c:tx><c:rich><a:p><a:r><a:t>Month</a:t></a:r></a:p></c:rich></c:tx></c:title></c:catAx>
  </c:plotArea>
</c:chart></c:chartSpace>"#;
        let m = parse(xml, 0, &names()).unwrap().model;
        // The last curated plot (the line) decides the kind.
        assert_eq!(m.kind, ChartKind::Line);
        // The first non-empty run, trimmed: not the whole title.
        assert_eq!(m.title.as_deref(), Some("North"));
        assert!(!m.legend);
        assert_eq!(m.series.len(), 2);
        assert_eq!(m.series[0].name.as_deref(), Some("Plan"));
        assert_eq!(m.series[0].color, None);
        // The first sRGB colour in the series: the outline's, upper-cased.
        assert_eq!(m.series[1].color.as_deref(), Some("#AA0000"));
        assert_eq!(m.series[1].values.start.col, 2);

        // No chart title: the first titled axis names the chart.
        let axis_only = br#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<c:chart><c:plotArea><c:pieChart><c:ser><c:val><c:numRef><c:f>$A$1:$A$3</c:f></c:numRef></c:val></c:ser></c:pieChart>
<c:valAx><c:title><c:tx><c:strRef><c:f>Sheet1!$D$1</c:f><c:strCache><c:pt idx="0"><c:v>Units</c:v></c:pt></c:strCache></c:strRef></c:tx></c:title></c:valAx>
</c:plotArea></c:chart></c:chartSpace>"#;
        let m = parse(axis_only, 0, &names()).unwrap().model;
        assert_eq!(m.kind, ChartKind::Pie);
        assert_eq!(m.title.as_deref(), Some("Units"));
    }

    #[test]
    fn quoted_sheet_name_resolves() {
        assert_eq!(
            split_sheet_ref("'My Sheet'!$A$1:$A$3"),
            (Some("My Sheet".to_string()), "$A$1:$A$3")
        );
        assert_eq!(
            split_sheet_ref("Sheet1!$B$2"),
            (Some("Sheet1".to_string()), "$B$2")
        );
        assert_eq!(split_sheet_ref("$B$2"), (None, "$B$2"));
    }
}
