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

//! # slide-sheet — a deck's charts as live paged.sheet charts (ADR 715)
//!
//! A PowerPoint chart carries its data twice: as the cached values in the
//! chart part (`c:numCache`, `c:strCache`), which PowerPoint draws from, and
//! as an embedded workbook (`c:externalData`, an `.xlsx` package part),
//! which PowerPoint opens when the user edits the data. [`ChartBook`] is
//! that workbook, read by paged.sheet (`sheet-xlsx`) into its cell model and
//! calculated by its engine (`sheet-calc`). A chart without an embedded
//! workbook gets one made from its cached values, laid out as PowerPoint
//! lays out a new chart's sheet (categories down column A, one series per
//! column from B, names in row 1), and its series are bound to those cells.
//!
//! The chart's series are bound to cells by their `c:f` formulas, read by
//! paged.sheet's chart reader (`sheet_xlsx::parts::chart`). Editing a cell
//! recalculates the workbook; [`ChartBook::series`] then answers the live
//! values. They are drawn two ways:
//!
//! - [`ChartBook::apply`] writes them into the deck's chart model, which
//!   `slide-chart` lays out as PowerPoint draws it (the kinds it draws:
//!   bars, lines, areas, pies, doughnuts);
//! - [`ChartBook::geometry`] is paged.sheet's chart geometry for the same
//!   chart (`sheet_chart::generate`), and [`prims`] turns it into the same
//!   primitives, for every other kind (scatter, bubble, radar, stock,
//!   surface, the Office 2016 kinds).
//!
//! On export, [`ChartBook::chart_part`] is the chart part with its caches
//! rewritten from the cells (and, for a made workbook, bound to it), and
//! [`ChartBook::save_xlsx`] is the workbook, written by `sheet-xlsx`: an
//! edited sheet re-encoded, every other part of the package as it was.

mod synth;

use std::collections::BTreeSet;

use dml_chart::write::{self as dw, DataOut};
use paged_ooxml::tree::{El, Ns};
use pptx_core::{Color, ColorBase, Fill, Line, RunProps};
use serde::{Deserialize, Serialize};
use sheet_calc::{Engine, EngineConfig};
use sheet_chart::{ChartGeometry, ChartModel, PlotData, Primitive, TextAnchor};
use sheet_core::{CellValue, RangeRef, SheetId, SheetModel};
use sheet_format::{FormatCache, FormatCtx};
use sheet_parser::{parse, print, print_ooxml, strip_storage_prefixes, ParseCtx, SheetNames};
use sheet_xlsx::parts::chart::{parse_f_ref, SheetResolver};
use sheet_xlsx::XlsxDocument;
use slide_chart::{Align, Prim};

pub use synth::synthesize_xlsx;

/// The chart part's relationship type of an embedded workbook.
pub const REL_PACKAGE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package";
/// The content type of an `.xlsx` part.
pub const CT_XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// Where a chart's workbook came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// The chart's embedded workbook (`c:externalData`).
    Embedded,
    /// Made from the chart's cached values: the chart had no embedded
    /// workbook, or it could not be read.
    Synthesized,
}

/// One series as the cells say it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SeriesData {
    /// The name cell's text, when the series is bound to one.
    pub name: Option<String>,
    /// The category (or X) labels, when bound.
    pub categories: Option<Vec<String>>,
    /// Whether every category cell holds a number.
    pub numeric_categories: bool,
    /// The values (Y for scatter); a blank or error cell is `None`.
    pub values: Option<Vec<Option<f64>>>,
    /// The number format of the first value cell, when not `General`.
    pub format: Option<String>,
}

/// One cell for the data grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridCell {
    pub row: u32,
    pub col: u32,
    /// As the cell displays (its number format applied).
    pub text: String,
    /// What typing it back would enter (`=…` for a formula).
    pub input: String,
}

/// One worksheet for the data grid: its used range (with the cells the
/// chart is bound to) and its cells.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridSheet {
    pub name: String,
    pub rows: u32,
    pub cols: u32,
    pub cells: Vec<GridCell>,
    /// The ranges the chart reads, zero-based `[row0, col0, row1, col1]`
    /// (series names, categories, values).
    pub bound: Vec<[u32; 4]>,
}

/// A chart's workbook, live: paged.sheet's cell model under its calculation
/// engine, the chart part it feeds and the chart model bound to it.
pub struct ChartBook {
    doc: XlsxDocument,
    engine: Engine,
    edited: BTreeSet<(SheetId, u32, u32)>,
    /// The chart part: as the deck has it, or (a made workbook) with its
    /// series bound to the made cells.
    chart_xml: Vec<u8>,
    /// The chart part as the deck has it.
    original: Vec<u8>,
    chart: ChartModel,
    origin: Origin,
}

/// Sheet names → ids over a model.
struct Names<'a>(&'a SheetModel);

impl SheetResolver for Names<'_> {
    fn resolve(&self, name: &str) -> Option<SheetId> {
        self.0.sheet_id(name)
    }
    fn defined(&self, name: &str) -> Option<String> {
        sheet_xlsx::parts::chart::defined_reference(self.0, name)
    }
}

struct Parse<'a> {
    model: &'a SheetModel,
    current: SheetId,
}

impl ParseCtx for Parse<'_> {
    fn sheet_id(&self, name: &str) -> Option<SheetId> {
        self.model.sheet_id(name)
    }
    fn name_id(&self, name: &str) -> Option<sheet_core::NameId> {
        self.model.names.resolve(name, self.current)
    }
    fn current_sheet(&self) -> SheetId {
        self.current
    }
}

impl SheetNames for Names<'_> {
    fn sheet_name(&self, id: SheetId) -> Option<&str> {
        self.0.sheet(id).map(|ws| ws.name.as_str())
    }
    fn defined_name(&self, id: sheet_core::NameId) -> Option<&str> {
        self.0.names.get(id).map(|d| d.name.as_str())
    }
}

/// The `c:ser` elements of a chart part, in file order (every plot).
fn series_elements(root: &El) -> Vec<&El> {
    let mut out = Vec::new();
    if let Some(area) = root.path(&[(Ns::C, "chart"), (Ns::C, "plotArea")]) {
        for plot in &area.children {
            out.extend(plot.children_named(Ns::C, "ser"));
        }
    }
    out
}

/// The `c:f` of a data element (`c:cat`, `c:val`, `c:tx`, …).
fn formula_of(el: &El) -> Option<String> {
    el.children
        .iter()
        .find_map(|r| r.child(Ns::C, "f"))
        .map(|f| f.deep_text())
        .filter(|f| !f.trim().is_empty())
}

impl ChartBook {
    /// Open a chart's workbook: `xlsx` is its embedded package (or `None`),
    /// `chart_xml` its chart part. A workbook that cannot be read, or none,
    /// is made from the chart's cached values.
    pub fn open(xlsx: Option<&[u8]>, chart_xml: &[u8]) -> Result<ChartBook, String> {
        if let Some(bytes) = xlsx {
            if let Ok(book) = Self::embedded(bytes, chart_xml) {
                return Ok(book);
            }
        }
        Self::synthesized(chart_xml)
    }

    /// The chart's embedded workbook.
    pub fn embedded(xlsx: &[u8], chart_xml: &[u8]) -> Result<ChartBook, String> {
        Self::load(xlsx, chart_xml.to_vec(), chart_xml, Origin::Embedded)
    }

    /// A workbook made from the chart's cached values, the chart part bound
    /// to it.
    pub fn synthesized(chart_xml: &[u8]) -> Result<ChartBook, String> {
        let (xlsx, bound) = synth::synthesize(chart_xml)?;
        Self::load(&xlsx, bound, chart_xml, Origin::Synthesized)
    }

    /// Re-open a workbook this module wrote (the document's copy) for its
    /// chart part: an embedded workbook, or a made one (`origin`).
    pub fn reopen(xlsx: &[u8], chart_xml: &[u8], origin: Origin) -> Result<ChartBook, String> {
        let bound = match origin {
            Origin::Embedded => chart_xml.to_vec(),
            Origin::Synthesized => synth::bind(chart_xml)?,
        };
        Self::load(xlsx, bound, chart_xml, origin)
    }

    fn load(
        xlsx: &[u8],
        chart_xml: Vec<u8>,
        original: &[u8],
        origin: Origin,
    ) -> Result<ChartBook, String> {
        let mut doc = XlsxDocument::open(xlsx).map_err(|e| format!("chart workbook: {e}"))?;
        let mut model = std::mem::take(&mut doc.model);
        if model.sheets.is_empty() {
            return Err("chart workbook has no sheets".into());
        }
        // Formulas, as paged.sheet loads them (sheet-js `load_xlsx`): each
        // `<f>` parsed onto its cell; one it cannot parse keeps its cached
        // value.
        let texts: Vec<_> = doc
            .formula_texts
            .iter()
            .map(|(k, v)| (*k, v.clone()))
            .collect();
        for ((sheet, row, col), text) in texts {
            let parsed = parse(
                &strip_storage_prefixes(&text),
                &Parse {
                    model: &model,
                    current: sheet,
                },
            );
            if let Ok(mut f) = parsed {
                let legacy = model
                    .sheet(sheet)
                    .is_some_and(|ws| !ws.array_formulas.contains_key(&(row, col)));
                if legacy {
                    sheet_calc::legacy::mark_implicit_intersections(&model, &mut f.root);
                }
                let id = model.intern_formula(f);
                if let Some(c) = model
                    .sheet_mut(sheet)
                    .and_then(|ws| ws.cells.get_mut(&(row, col)))
                {
                    c.formula = Some(id);
                }
            }
        }
        let mode = std::mem::take(&mut model.calc.calc_mode);
        let mut engine = Engine::new(model, EngineConfig::default());
        engine.recalc_all();
        engine.set_calc_mode(mode);
        let chart = sheet_xlsx::parts::chart::parse(&chart_xml, 0, &Names(engine.model()))
            .map_err(|e| format!("chart part: {e}"))?
            .model;
        Ok(ChartBook {
            doc,
            engine,
            edited: BTreeSet::new(),
            chart_xml,
            original: original.to_vec(),
            chart,
            origin,
        })
    }

    /// The chart part as the deck has it (before a made workbook bound it).
    pub fn original_xml(&self) -> &[u8] {
        &self.original
    }

    pub fn origin(&self) -> Origin {
        self.origin
    }

    /// Whether a cell was entered since the workbook was opened.
    pub fn is_edited(&self) -> bool {
        !self.edited.is_empty()
    }

    /// The workbook's cell model, calculated.
    pub fn model(&self) -> &SheetModel {
        self.engine.model()
    }

    /// paged.sheet's model of the chart, bound to the workbook.
    pub fn chart_model(&self) -> &ChartModel {
        &self.chart
    }

    /// Enter `input` into a cell, as typed into a sheet: `=…` is a formula,
    /// anything else a literal (a number, a date, `TRUE`, text). The
    /// workbook recalculates.
    pub fn enter(&mut self, sheet: &str, row: u32, col: u32, input: &str) -> Result<(), String> {
        let id = self
            .model()
            .sheet_id(sheet)
            .ok_or_else(|| format!("no sheet {sheet:?} in the chart's workbook"))?;
        self.engine
            .enter(id, row, col, input)
            .map_err(|e| format!("{e:?}"))?;
        self.edited.insert((id, row, col));
        Ok(())
    }

    fn range(&self, f: &str) -> Option<RangeRef> {
        parse_f_ref(f, 0, &Names(self.model())).map(|r| r.normalized())
    }

    fn values(&self, r: &RangeRef) -> Vec<Option<f64>> {
        let ws = self.model().sheet(r.start.sheet);
        let mut out = Vec::new();
        for row in r.start.row..=r.end.row {
            for col in r.start.col..=r.end.col {
                out.push(
                    ws.and_then(|ws| ws.cell(row, col))
                        .and_then(|c| match &c.value {
                            CellValue::Number(n) => Some(*n),
                            CellValue::Bool(b) => Some(f64::from(u8::from(*b))),
                            CellValue::Text(_) => Some(0.0),
                            _ => None,
                        }),
                );
            }
        }
        out
    }

    fn display(&self, sheet: SheetId, row: u32, col: u32, cache: &mut FormatCache) -> String {
        let model = self.model();
        let Some(cell) = model.sheet(sheet).and_then(|ws| ws.cell(row, col)) else {
            return String::new();
        };
        if matches!(cell.value, CellValue::Empty) {
            return String::new();
        }
        let ctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
        match cache.get(model.styles.num_fmt_of(cell.style)) {
            Ok(fmt) => sheet_format::format_value(&cell.value, fmt, &ctx),
            Err(_) => sheet_format::format_general(&cell.value),
        }
    }

    fn texts(&self, r: &RangeRef, cache: &mut FormatCache) -> (Vec<String>, bool) {
        let ws = self.model().sheet(r.start.sheet);
        let mut out = Vec::new();
        let mut numeric = true;
        for row in r.start.row..=r.end.row {
            for col in r.start.col..=r.end.col {
                out.push(self.display(r.start.sheet, row, col, cache));
                numeric &= matches!(
                    ws.and_then(|ws| ws.cell(row, col)).map(|c| &c.value),
                    Some(CellValue::Number(_))
                );
            }
        }
        let numeric = numeric && !out.is_empty();
        (out, numeric)
    }

    /// Every series of the chart, in file order, as its cells say it now.
    pub fn series(&self) -> Vec<SeriesData> {
        let Ok(root) = paged_ooxml::tree::parse(&self.chart_xml) else {
            return Vec::new();
        };
        let mut cache = FormatCache::default();
        series_elements(&root)
            .into_iter()
            .map(|ser| {
                let get = |tag: &str| ser.child(Ns::C, tag).and_then(formula_of);
                let name = get("tx")
                    .and_then(|f| self.range(&f))
                    .map(|r| self.texts(&r, &mut cache).0.join(" "));
                let cats = get("cat").or_else(|| get("xVal"));
                let (categories, numeric_categories) = match cats.and_then(|f| self.range(&f)) {
                    Some(r) => {
                        let (t, n) = self.texts(&r, &mut cache);
                        (Some(t), n)
                    }
                    None => (None, false),
                };
                let vals = get("val")
                    .or_else(|| get("yVal"))
                    .and_then(|f| self.range(&f));
                let format = vals.as_ref().and_then(|r| {
                    let model = self.model();
                    model
                        .sheet(r.start.sheet)
                        .and_then(|ws| ws.cell(r.start.row, r.start.col))
                        .map(|c| model.styles.num_fmt_of(c.style).to_string())
                        .filter(|f| f != "General")
                });
                SeriesData {
                    name,
                    categories,
                    numeric_categories,
                    values: vals.map(|r| self.values(&r)),
                    format,
                }
            })
            .collect()
    }

    /// Write the live values into the deck's chart model (series in file
    /// order): what `slide-chart` lays out.
    pub fn apply(&self, chart: &mut pptx_core::chart::Chart) {
        let data = self.series();
        let mut it = data.into_iter();
        for plot in &mut chart.plots {
            for s in &mut plot.series {
                let Some(d) = it.next() else {
                    return;
                };
                if let Some(n) = d.name {
                    s.name = n;
                }
                if let Some(c) = d.categories {
                    s.categories = c;
                }
                if let Some(v) = d.values {
                    s.values = v;
                }
            }
        }
    }

    /// The data paged.sheet's chart engine draws, from the live cells
    /// (sheet-js `plot_data`, for the chart's own cells).
    pub fn plot_data(&self, theme: Option<[u32; 12]>) -> PlotData {
        let model = self.model();
        let ctx = FormatCtx::new(model.calc.date_system, model.calc.locale);
        let mut cache = FormatCache::default();
        let mut data = PlotData {
            format_ctx: ctx,
            theme: theme.or(self.doc.chart_theme),
            ..PlotData::default()
        };
        let nan = |v: Vec<Option<f64>>| v.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect();
        for s in self.chart.series() {
            data.series.push(nan(self.values(&s.values.normalized())));
            data.x_values.push(
                s.x_values
                    .as_ref()
                    .map(|r| nan(self.values(&r.normalized()))),
            );
            data.sizes
                .push(s.sizes.as_ref().map(|r| nan(self.values(&r.normalized()))));
            data.names.push(s.name_ref.as_ref().map(|r| {
                let n = r.normalized();
                self.display(n.start.sheet, n.start.row, n.start.col, &mut cache)
            }));
            let n = s.values.normalized();
            data.value_formats.push(
                model
                    .sheet(n.start.sheet)
                    .and_then(|ws| ws.cell(n.start.row, n.start.col))
                    .map(|c| model.styles.num_fmt_of(c.style).to_string())
                    .filter(|f| f != "General"),
            );
            data.custom_errors.push(Vec::new());
        }
        if let Some(cat) = self.chart.series().find_map(|s| s.categories.as_ref()) {
            let (labels, numeric) = self.texts(&cat.normalized(), &mut cache);
            if numeric {
                data.category_serials = Some(
                    self.values(&cat.normalized())
                        .into_iter()
                        .map(|v| v.unwrap_or(f64::NAN))
                        .collect(),
                );
            }
            data.categories = labels;
        }
        data
    }

    /// paged.sheet's geometry of the chart in a `w` × `h` pt box, from the
    /// live cells. `theme` is the deck's twelve theme colours (dk1, lt1,
    /// dk2, lt2, accent1–6, hlink, folHlink).
    pub fn geometry(&self, w: f64, h: f64, theme: Option<[u32; 12]>) -> ChartGeometry {
        sheet_chart::generate(&self.chart, &self.plot_data(theme), w, h)
    }

    /// The workbook's sheets for the data grid.
    pub fn grid(&self) -> Vec<GridSheet> {
        let model = self.model();
        let mut cache = FormatCache::default();
        let bound: Vec<RangeRef> = self
            .chart
            .series()
            .flat_map(|s| {
                [
                    s.name_ref.as_ref(),
                    s.categories.as_ref(),
                    Some(&s.values),
                    s.x_values.as_ref(),
                    s.sizes.as_ref(),
                ]
            })
            .flatten()
            .map(|r| r.normalized())
            .collect();
        model
            .sheets
            .iter()
            .enumerate()
            .map(|(i, ws)| {
                let id = i as SheetId;
                let mine: Vec<[u32; 4]> = bound
                    .iter()
                    .filter(|r| r.start.sheet == id)
                    .map(|r| [r.start.row, r.start.col, r.end.row, r.end.col])
                    .collect();
                let (mut rows, mut cols) = ws
                    .used_range()
                    .map(|u| (u.row1 + 1, u.col1 + 1))
                    .unwrap_or((0, 0));
                for b in &mine {
                    rows = rows.max(b[2] + 1);
                    cols = cols.max(b[3] + 1);
                }
                let cells = ws
                    .iter_cells()
                    .filter(|(_, c)| !matches!(c.value, CellValue::Empty) || c.formula.is_some())
                    .map(|(&(row, col), _)| GridCell {
                        row,
                        col,
                        text: self.display(id, row, col, &mut cache),
                        input: self.input(id, row, col),
                    })
                    .collect();
                GridSheet {
                    name: ws.name.to_string(),
                    rows,
                    cols,
                    cells,
                    bound: mine,
                }
            })
            .collect()
    }

    /// A cell's re-enterable text (sheet-js `cell_input_text`).
    fn input(&self, sheet: SheetId, row: u32, col: u32) -> String {
        let model = self.model();
        let Some(cell) = model.sheet(sheet).and_then(|ws| ws.cell(row, col)) else {
            return String::new();
        };
        if let Some(f) = cell.formula.and_then(|id| model.formula(id)) {
            return format!("={}", print(f, sheet, &Names(model)));
        }
        match &cell.value {
            CellValue::Empty => String::new(),
            CellValue::Number(n) => n.to_string(),
            CellValue::Text(t) => {
                let ctx = sheet_format::entry::EntryCtx::new(
                    model.calc.locale,
                    model.calc.date_system,
                    0.0,
                );
                if sheet_format::entry::needs_quote(t, &ctx) {
                    format!("'{t}")
                } else {
                    t.to_string()
                }
            }
            CellValue::Bool(b) => (if *b { "TRUE" } else { "FALSE" }).to_string(),
            CellValue::Error(e) => e.as_str().to_string(),
        }
    }

    /// The workbook as an `.xlsx` (sheet-xlsx's writer: the edited sheets
    /// re-encoded, every other part as it was read).
    pub fn save_xlsx(&mut self) -> Result<Vec<u8>, String> {
        let model = self.engine.model();
        let mut dirty = BTreeSet::new();
        for &(sheet, row, col) in &self.edited {
            let f = model
                .sheet(sheet)
                .and_then(|ws| ws.cell(row, col))
                .and_then(|c| c.formula)
                .and_then(|id| model.formula(id));
            match f {
                Some(f) => {
                    let text = print_ooxml(f, sheet, &Names(model));
                    self.doc.formula_texts.insert((sheet, row, col), text);
                }
                None => {
                    self.doc.formula_texts.remove(&(sheet, row, col));
                }
            }
            dirty.insert(sheet);
        }
        for s in dirty {
            self.doc.mark_sheet_dirty(s);
        }
        self.doc
            .save_model(model)
            .map_err(|e| format!("chart workbook: {e}"))
    }

    /// The chart part with every series' caches written from the cells
    /// (names, categories, values; formulas and number formats kept), and,
    /// with `external`, its `c:externalData` naming that relationship id.
    /// Everything else in the part is kept as it was.
    pub fn chart_part(&self, external: Option<&str>) -> Result<Vec<u8>, String> {
        let mut root = paged_ooxml::tree::parse(&self.chart_xml)?;
        let data = self.series();
        let mut i = 0;
        if let Some(area) = root
            .children
            .iter_mut()
            .find(|c| c.is(Ns::C, "chart"))
            .and_then(|c| c.children.iter_mut().find(|c| c.is(Ns::C, "plotArea")))
        {
            for plot in &mut area.children {
                for ser in plot.children.iter_mut().filter(|c| c.is(Ns::C, "ser")) {
                    let Some(d) = data.get(i) else {
                        break;
                    };
                    i += 1;
                    write_series(ser, d)?;
                }
            }
        }
        if let Some(rid) = external {
            let el = dw::fragment(&format!(
                r#"<c:externalData r:id="{}"><c:autoUpdate val="0"/></c:externalData>"#,
                dw::esc(rid)
            ))?;
            dw::put_child(
                &mut root,
                Ns::C,
                "externalData",
                Some(el),
                dw::ORDER_CHART_SPACE,
            );
        }
        dw::ensure_prefixes(&mut root);
        Ok(dw::serialise(&self.chart_xml, &root))
    }
}

/// Rewrite one `c:ser`'s caches from its cells.
fn write_series(ser: &mut El, d: &SeriesData) -> Result<(), String> {
    if let (Some(name), Some(f)) = (&d.name, ser.child(Ns::C, "tx").and_then(formula_of)) {
        let el = dw::fragment(&format!(
            r#"<c:tx><c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>{}</c:v></c:pt></c:strCache></c:strRef></c:tx>"#,
            dw::esc(&f),
            dw::esc(name)
        ))?;
        dw::put_child(ser, Ns::C, "tx", Some(el), dw::ORDER_SER);
    }
    for tag in ["cat", "xVal"] {
        let Some(old) = ser.child(Ns::C, tag) else {
            continue;
        };
        let (Some(f), Some(cats)) = (formula_of(old), &d.categories) else {
            continue;
        };
        let was_numeric = old.child(Ns::C, "numRef").is_some();
        let numbers = (d.numeric_categories && was_numeric).then(|| {
            cats.iter()
                .map(|c| c.parse::<f64>().ok())
                .collect::<Vec<_>>()
        });
        let format = old
            .path(&[
                (Ns::C, "numRef"),
                (Ns::C, "numCache"),
                (Ns::C, "formatCode"),
            ])
            .map(|e| e.deep_text());
        let out = DataOut {
            formula: Some(f),
            strings: numbers.is_none().then(|| cats.clone()),
            numbers,
            format,
        };
        let el = dw::fragment(&dw::data_xml(tag, &out))?;
        dw::put_child(ser, Ns::C, tag, Some(el), dw::ORDER_SER);
    }
    for tag in ["val", "yVal"] {
        let Some(old) = ser.child(Ns::C, tag) else {
            continue;
        };
        let (Some(f), Some(values)) = (formula_of(old), &d.values) else {
            continue;
        };
        let format = old
            .path(&[
                (Ns::C, "numRef"),
                (Ns::C, "numCache"),
                (Ns::C, "formatCode"),
            ])
            .map(|e| e.deep_text())
            .or_else(|| d.format.clone());
        let out = DataOut {
            formula: Some(f),
            numbers: Some(values.clone()),
            strings: None,
            format,
        };
        let el = dw::fragment(&dw::data_xml(tag, &out))?;
        dw::put_child(ser, Ns::C, tag, Some(el), dw::ORDER_SER);
    }
    Ok(())
}

// ── paged.sheet's geometry as slide-chart primitives ───────────────────────

fn rgb(s: &str) -> Option<u32> {
    let h = s.trim_start_matches('#');
    (h.len() == 6).then(|| u32::from_str_radix(h, 16).ok())?
}

fn solid(c: &Option<String>) -> Option<Fill> {
    let v = rgb(c.as_deref()?)?;
    Some(Fill::Solid(Color {
        base: ColorBase::Srgb(v),
        transforms: Vec::new(),
    }))
}

fn line(c: &Option<String>, w: f64, dash: Option<&str>) -> Option<Line> {
    let v = rgb(c.as_deref()?)?;
    Some(Line {
        width: Some((w.max(0.0) * 12700.0).round() as i64),
        fill: Some(Fill::Solid(Color {
            base: ColorBase::Srgb(v),
            transforms: Vec::new(),
        })),
        dash: dash.map(str::to_string),
        ..Line::default()
    })
}

/// paged.sheet's chart geometry as `slide-chart` primitives, which the
/// slide lowers as it lowers its own chart layout.
pub fn prims(g: &ChartGeometry) -> Vec<Prim> {
    let mut out = Vec::new();
    for p in &g.prims {
        match p {
            Primitive::Rect {
                x,
                y,
                w,
                h,
                fill,
                stroke,
                stroke_w,
                ..
            } => out.push(Prim::Rect {
                x: *x,
                y: *y,
                w: *w,
                h: *h,
                fill: solid(fill),
                line: line(stroke, *stroke_w, None),
            }),
            Primitive::Line {
                pts,
                stroke,
                stroke_w,
                dash,
                ..
            } => out.push(Prim::Path {
                points: pts.clone(),
                smooth: false,
                closed: false,
                fill: None,
                line: line(&Some(stroke.clone()), *stroke_w, dash.as_deref()),
            }),
            Primitive::Polygon {
                pts,
                fill,
                stroke,
                stroke_w,
                ..
            } => out.push(Prim::Path {
                points: pts.clone(),
                smooth: false,
                closed: true,
                fill: solid(fill),
                line: line(stroke, *stroke_w, None),
            }),
            Primitive::Wedge {
                cx,
                cy,
                r,
                start_deg,
                end_deg,
                fill,
                stroke,
                inner_r,
                ..
            } => out.push(Prim::Wedge {
                cx: *cx,
                cy: *cy,
                r: *r,
                hole: inner_r.unwrap_or(0.0),
                start: *start_deg,
                sweep: end_deg - start_deg,
                fill: solid(fill),
                line: line(stroke, 0.75, None),
            }),
            Primitive::Text {
                x,
                y,
                s,
                size_pt,
                anchor,
                color,
                bold,
                italic,
                font,
                ..
            } => {
                let props = RunProps {
                    size: Some((size_pt * 100.0).round() as i32),
                    bold: bold.then_some(true),
                    italic: italic.then_some(true),
                    fill: solid(color),
                    latin: font.clone(),
                    ..RunProps::default()
                };
                // The baseline sits about a third of the size below the
                // centre of the line.
                out.push(Prim::Label {
                    x: *x,
                    cy: y - size_pt * 0.32,
                    align: match anchor {
                        TextAnchor::Start => Align::Left,
                        TextAnchor::Middle => Align::Center,
                        TextAnchor::End => Align::Right,
                    },
                    text: s.clone(),
                    props,
                });
            }
        }
    }
    out
}

/// Whether `slide-chart` lays this chart out as PowerPoint draws it: every
/// plot is a bar, line, area, pie or doughnut (2-D). Other charts are drawn
/// by paged.sheet's chart engine.
pub fn slide_draws(chart: &pptx_core::chart::Chart) -> bool {
    use dml_chart::PlotKind as K;
    !chart.plots.is_empty()
        && chart.plots.iter().all(|p| {
            !p.element.contains("3D")
                && matches!(
                    p.kind,
                    K::Bar { .. } | K::Line { .. } | K::Area { .. } | K::Pie { .. }
                )
        })
}

/// The workbook a deck's chart part embeds (`c:externalData` through the
/// part's relationships), when there is one: its part name and bytes.
pub fn embedded_part(pkg: &paged_ooxml::OpcPackage, chart_part: &str) -> Option<(String, Vec<u8>)> {
    let xml = pkg.part(chart_part)?;
    let root = paged_ooxml::tree::parse(xml).ok()?;
    let rid = root
        .child(Ns::C, "externalData")?
        .attr_ns(Ns::R, "id")
        .or_else(|| root.child(Ns::C, "externalData")?.attr("id"))?
        .to_string();
    let rels =
        paged_ooxml::Relationships::parse(pkg.part(&paged_ooxml::rels_part_name(chart_part))?);
    let rel = rels.by_id(&rid)?;
    if rel.target_mode.as_deref() == Some("External") || !rel.is_type("/package") {
        return None;
    }
    let target = paged_ooxml::resolve_target(paged_ooxml::part_dir(chart_part), &rel.target);
    let bytes = pkg.part(&target)?.to_vec();
    Some((target, bytes))
}

/// Open the workbook of a deck's chart part: its embedded workbook, or one
/// made from its caches.
pub fn open_for(pkg: &paged_ooxml::OpcPackage, chart_part: &str) -> Result<ChartBook, String> {
    let xml = pkg
        .part(chart_part)
        .ok_or_else(|| format!("no chart part {chart_part}"))?;
    let embedded = embedded_part(pkg, chart_part);
    ChartBook::open(embedded.as_ref().map(|(_, b)| b.as_slice()), xml)
}

/// A deck's twelve theme colours (dk1, lt1, dk2, lt2, accent1–6, hlink,
/// folHlink) as paged.sheet's chart engine takes them: the first master's
/// theme, when every slot is a literal colour.
pub fn theme_colors(deck: &pptx_core::Presentation) -> Option<[u32; 12]> {
    let theme = deck
        .masters
        .first()
        .and_then(|m| m.theme_part.as_deref())
        .and_then(|t| deck.theme(t))
        .or(deck.themes.first())?;
    const SLOTS: [&str; 12] = [
        "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5",
        "accent6", "hlink", "folHlink",
    ];
    let mut out = [0u32; 12];
    for (i, slot) in SLOTS.iter().enumerate() {
        let (_, c) = theme.colors.iter().find(|(k, _)| k == slot)?;
        out[i] = match &c.base {
            ColorBase::Srgb(v) => *v,
            ColorBase::System { last: Some(v), .. } => *v,
            _ => return None,
        };
    }
    Some(out)
}

/// The live charts of a deck: each chart part's workbook (embedded or
/// made), and how its frame is drawn.
pub struct DeckCharts {
    pub books: std::collections::BTreeMap<String, ChartBook>,
    /// The parts `slide-chart` lays out (PowerPoint's layout from the
    /// values); the others are drawn by paged.sheet's chart engine.
    pub slide_drawn: BTreeSet<String>,
    pub theme: Option<[u32; 12]>,
}

impl DeckCharts {
    /// Open every chart part of `deck` (read from `pkg`). A chart whose
    /// workbook cannot be opened at all stays a static drawing, and says
    /// why in the diagnostics.
    pub fn open(
        pkg: &paged_ooxml::OpcPackage,
        deck: &pptx_core::Presentation,
    ) -> (DeckCharts, Vec<String>) {
        let mut out = DeckCharts {
            books: Default::default(),
            slide_drawn: BTreeSet::new(),
            theme: theme_colors(deck),
        };
        let mut diagnostics = Vec::new();
        for (part, chart) in &deck.charts {
            if slide_draws(chart) {
                out.slide_drawn.insert(part.clone());
            }
            match open_for(pkg, part) {
                Ok(book) => {
                    out.books.insert(part.clone(), book);
                }
                Err(e) => diagnostics.push(format!("chart {part}: not live ({e})")),
            }
        }
        (out, diagnostics)
    }

    /// The primitives of a chart frame paged.sheet draws (`None`: the
    /// deck's layout draws it, or it is not live).
    pub fn draw(&self, part: &str, w: f64, h: f64) -> Option<Vec<Prim>> {
        if self.slide_drawn.contains(part) {
            return None;
        }
        let book = self.books.get(part)?;
        Some(prims(&book.geometry(w, h, self.theme)))
    }
}
