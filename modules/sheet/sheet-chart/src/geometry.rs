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

//! The chart GEOMETRY IR (spec §8.4; ADR 016, W4 ADR 519): the PURE
//! projection of a [`ChartModel`] plus resolved [`PlotData`] into vector
//! [`Primitive`]s in **chart-content pt space** (origin top-left, y DOWN —
//! the frame-content coordinate system, spec §8.5). The page lowering turns
//! them into `paged.draw` paths and text frames; the grid view paints them.
//!
//! [`generate`] is **pure** and deterministic: same inputs, byte-identical
//! IR.
//!
//! ## The IR
//!
//! Five primitives (rect, line, polygon, wedge, text), unchanged in shape
//! since the IR was frozen; W4 added only OPTIONAL fields, each omitted from
//! the JSON when unset, so a consumer that ignores them reads the same chart:
//!
//! - `fillSwatchRef` / `strokeSwatchRef` (and a text's `colorSwatchRef`): the
//!   document swatch a colour role names ([`crate::model::ColorRef::doc`]),
//!   beside the resolved `#RRGGBB`. The page lowering references the swatch
//!   instead of minting one.
//! - a wedge's `innerR`: a ring segment (donut rings, sunburst) instead of a
//!   slice; before W4 a donut was a pie with a page-white disc on top.
//! - a line's `dash` (`a:prstDash`).
//! - a text's `color`, `bold`, `italic`, `font`, `paragraphStyle`,
//!   `characterStyle` and `role` (`title`, `axisTitle`, `tick`, `dataLabel`,
//!   `legend`, `note`): the text role's concrete run properties and document
//!   style references.
//!
//! ## Layout
//!
//! plotters (driven over the custom [`crate::backend::GeomBackend`]) emits
//! every text label, so text keeps one metrics path. Value→pt placement is
//! this crate's own [`crate::scale::Scale`] since W4: it is what expresses a
//! logarithmic, reversed, date or secondary axis, which a plotters `f64`
//! range does not, and it places marks at exact, unrounded positions (ADR 016
//! amendment 2026-10-23). The axis bounds follow Excel's automatic rule
//! (5% headroom, a 1-2-5 major unit).

use std::cell::RefCell;
use std::rc::Rc;

use plotters::prelude::*;
use plotters::style::text_anchor::{HPos, Pos, VPos};

use crate::backend::{GeomBackend, Sink};
use crate::colors::{Paint, Theme};
use crate::model::{ChartKind, ChartModel, TextStyleRef};

/// Text alignment for a [`Primitive::Text`] anchor point.
#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAnchor {
    Start,
    Middle,
    End,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One vector primitive in chart-content pt space (spec §8.4). serde emits
/// `camelCase` field names; the variant tag is the lowercase `kind`. The
/// optional fields are omitted when unset (see the module docs).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Primitive {
    /// An axis-aligned rectangle (bars, plot-area fill, legend swatches).
    #[serde(rename_all = "camelCase")]
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: Option<String>,
        stroke: Option<String>,
        stroke_w: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        fill_swatch_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stroke_swatch_ref: Option<String>,
    },
    /// A polyline (series lines, axis rules, gridlines). At least two points.
    #[serde(rename_all = "camelCase")]
    Line {
        pts: Vec<(f64, f64)>,
        stroke: String,
        stroke_w: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        stroke_swatch_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dash: Option<String>,
    },
    /// A closed polygon (area bands, markers, contour bands).
    #[serde(rename_all = "camelCase")]
    Polygon {
        pts: Vec<(f64, f64)>,
        fill: Option<String>,
        stroke: Option<String>,
        stroke_w: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        fill_swatch_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stroke_swatch_ref: Option<String>,
    },
    /// A pie slice or ring segment: centre `(cx, cy)`, radius `r` (and an
    /// inner radius for a ring segment), angular span in degrees clockwise
    /// from 12 o'clock.
    #[serde(rename_all = "camelCase")]
    Wedge {
        cx: f64,
        cy: f64,
        r: f64,
        start_deg: f64,
        end_deg: f64,
        fill: Option<String>,
        stroke: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inner_r: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fill_swatch_ref: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stroke_swatch_ref: Option<String>,
    },
    /// A text label; `(x, y)` is the baseline anchor point.
    #[serde(rename_all = "camelCase")]
    Text {
        x: f64,
        y: f64,
        s: String,
        size_pt: f64,
        anchor: TextAnchor,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        color_swatch_ref: Option<String>,
        #[serde(skip_serializing_if = "is_false")]
        bold: bool,
        #[serde(skip_serializing_if = "is_false")]
        italic: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        font: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        paragraph_style: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        character_style: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<String>,
    },
}

impl Primitive {
    /// A plain text primitive (no optional fields).
    pub fn text(x: f64, y: f64, s: String, size_pt: f64, anchor: TextAnchor) -> Primitive {
        Primitive::Text {
            x,
            y,
            s,
            size_pt,
            anchor,
            color: None,
            color_swatch_ref: None,
            bold: false,
            italic: false,
            font: None,
            paragraph_style: None,
            character_style: None,
            role: None,
        }
    }
}

/// The generated geometry for one chart: the content-box size plus the
/// ordered primitive list.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartGeometry {
    pub width_pt: f64,
    pub height_pt: f64,
    pub prims: Vec<Primitive>,
    /// The chart was a 3-D kind drawn as its 2-D equivalent.
    #[serde(skip_serializing_if = "is_false")]
    pub flattened_3d: bool,
}

/// Custom error amounts of one error-bar set: (plus, minus) per point.
pub type CustomErrors = (Option<Vec<f64>>, Option<Vec<f64>>);

/// The RESOLVED data the generator consumes. Every per-series vector aligns
/// with [`ChartModel::series`] (all plots, in order). A missing point is
/// `NaN` (a gap).
#[derive(Clone, Debug, Default)]
pub struct PlotData {
    /// Values (Y for scatter/bubble).
    pub series: Vec<Vec<f64>>,
    /// The category labels, shared across series.
    pub categories: Vec<String>,
    /// Hierarchical categories (treemap, sunburst; a multi-level category
    /// range): `category_levels[level][point]`, outermost level first. Empty
    /// = one level, `categories`.
    pub category_levels: Vec<Vec<String>>,
    /// The categories as numbers (a date axis), when every one is.
    pub category_serials: Option<Vec<f64>>,
    /// Scatter/bubble X values per series (`None` = 1, 2, 3…).
    pub x_values: Vec<Option<Vec<f64>>>,
    /// Bubble sizes per series.
    pub sizes: Vec<Option<Vec<f64>>>,
    /// The live series names (bound name cells) — win over the model's.
    pub names: Vec<Option<String>>,
    /// The number format of each series' values (its first cell's).
    pub value_formats: Vec<Option<String>>,
    /// Custom error amounts per series, per error-bar set: (plus, minus).
    pub custom_errors: Vec<Vec<CustomErrors>>,
    /// The workbook theme's twelve colours (`None` = the Office theme).
    pub theme: Option<[u32; 12]>,
    /// Number formatting context (date system, locale).
    pub format_ctx: sheet_format::FormatCtx,
}

impl PlotData {
    /// Values and categories only.
    pub fn of(series: Vec<Vec<f64>>, categories: Vec<String>) -> PlotData {
        PlotData {
            series,
            categories,
            ..PlotData::default()
        }
    }
}

/// Default text sizes (pt): Excel's chart defaults.
pub(crate) const TITLE_PT: f64 = 14.0;
pub(crate) const LABEL_PT: f64 = 9.0;
/// Axis and gridline greys (Excel's default text-1 tints).
pub(crate) const AXIS_STROKE: &str = "#D9D9D9";
pub(crate) const GRID_STROKE: &str = "#D9D9D9";
pub(crate) const TEXT_GREY: &str = "#595959";
pub(crate) const AXIS_STROKE_W: f64 = 0.75;
pub(crate) const SERIES_STROKE_W: f64 = 2.25;
/// The approximate advance of a character, em (the backend's estimate).
pub(crate) const ADVANCE_EM: f64 = 0.55;

/// Project a [`ChartModel`] + resolved [`PlotData`] into a [`ChartGeometry`].
pub fn generate(
    model: &ChartModel,
    data: &PlotData,
    width_pt: f64,
    height_pt: f64,
) -> ChartGeometry {
    let theme = Theme::from_data(data);
    let pen = Pen::new(width_pt, height_pt, theme);
    pen.chart_area(model);
    match model.kind() {
        ChartKind::Pie | ChartKind::Donut | ChartKind::PieOfPie | ChartKind::BarOfPie => {
            crate::radial::pies(&pen, model, data)
        }
        ChartKind::Radar | ChartKind::FilledRadar => crate::radial::radar(&pen, model, data),
        ChartKind::Sunburst => crate::radial::sunburst(&pen, model, data),
        ChartKind::Treemap => crate::special::treemap(&pen, model, data),
        ChartKind::Funnel => crate::special::funnel(&pen, model, data),
        ChartKind::Histogram | ChartKind::Pareto => crate::special::histogram(&pen, model, data),
        ChartKind::BoxWhisker => crate::special::box_whisker(&pen, model, data),
        ChartKind::Surface => crate::special::surface(&pen, model, data),
        ChartKind::Unsupported => crate::special::placeholder(&pen, model),
        _ => crate::cartesian::cartesian(&pen, model, data),
    }
    ChartGeometry {
        width_pt,
        height_pt,
        prims: pen.finish(),
        flattened_3d: model.flattened_3d,
    }
}

// ── the pen: every emission goes through here ───────────────────────────────

/// A text role's rendering spec.
#[derive(Clone, Debug)]
pub(crate) struct TextSpec {
    pub size: f64,
    pub anchor: TextAnchor,
    pub bold: bool,
    pub italic: bool,
    pub font: Option<String>,
    pub color: Option<Paint>,
    pub paragraph: Option<String>,
    pub character: Option<String>,
    pub role: &'static str,
}

impl TextSpec {
    /// A spec from a text role, falling back to `size` and the chart text.
    pub fn of(
        style: &TextStyleRef,
        base: &TextStyleRef,
        size: f64,
        anchor: TextAnchor,
        role: &'static str,
        theme: &Theme,
    ) -> TextSpec {
        let c = &style.font;
        let b = &base.font;
        TextSpec {
            size: c
                .size
                .or(b.size.filter(|_| role != "title"))
                .unwrap_or(size),
            anchor,
            bold: c.bold || b.bold,
            italic: c.italic || b.italic,
            font: c.name.as_ref().or(b.name.as_ref()).cloned(),
            color: c
                .color
                .as_ref()
                .or(b.color.as_ref())
                .map(|r| theme.paint(r, TEXT_GREY)),
            paragraph: style
                .doc_para_style
                .as_ref()
                .or(base.doc_para_style.as_ref())
                .cloned(),
            character: style
                .doc_char_style
                .as_ref()
                .or(base.doc_char_style.as_ref())
                .cloned(),
            role,
        }
    }
    pub fn plain(size: f64, anchor: TextAnchor, role: &'static str) -> TextSpec {
        TextSpec {
            size,
            anchor,
            bold: false,
            italic: false,
            font: None,
            color: None,
            paragraph: None,
            character: None,
            role,
        }
    }
    pub fn anchored(&self, anchor: TextAnchor) -> TextSpec {
        TextSpec {
            anchor,
            ..self.clone()
        }
    }
    /// The approximate advance width of `s` at this size.
    pub fn width(&self, s: &str) -> f64 {
        text_width(s, self.size)
    }
}

/// The approximate advance width of `s` at `size` pt.
pub(crate) fn text_width(s: &str, size: f64) -> f64 {
    s.chars().count() as f64 * ADVANCE_EM * size
}

/// The emitter: a primitive sink plus the plotters drawing area text flows
/// through, and the resolved theme.
pub(crate) struct Pen {
    pub sink: Sink,
    pub root: DrawingArea<GeomBackend, plotters::coord::Shift>,
    pub theme: Theme,
    pub w: f64,
    pub h: f64,
}

impl Pen {
    pub fn new(w: f64, h: f64, theme: Theme) -> Pen {
        let sink: Sink = Rc::new(RefCell::new(Vec::new()));
        let backend = GeomBackend::new(w, h, Rc::clone(&sink));
        Pen {
            sink,
            root: backend.into_drawing_area(),
            theme,
            w,
            h,
        }
    }

    pub fn finish(self) -> Vec<Primitive> {
        let _ = self.root.present();
        let Pen { sink, root, .. } = self;
        drop(root);
        Rc::try_unwrap(sink)
            .map(|c| c.into_inner())
            .unwrap_or_else(|rc| rc.borrow().clone())
    }

    fn push(&self, p: Primitive) {
        self.sink.borrow_mut().push(p);
    }

    /// The chart area's own fill/outline, when the model states one.
    pub fn chart_area(&self, model: &ChartModel) {
        let a = &model.chart_area;
        let fill = a.fill.as_ref().filter(|_| !a.no_fill);
        let line = a.line.as_ref().filter(|l| !l.none && l.color.is_some());
        if fill.is_none() && line.is_none() {
            return;
        }
        let fill = fill.map(|c| self.theme.paint(c, "#FFFFFF"));
        let stroke = line.map(|l| self.theme.paint(l.color.as_ref().unwrap(), AXIS_STROKE));
        self.rect(
            0.0,
            0.0,
            self.w,
            self.h,
            fill.as_ref(),
            stroke.as_ref(),
            line.and_then(|l| l.width_pt).unwrap_or(0.75),
        );
    }

    /// A rectangle (`w`/`h` may be negative: normalised).
    #[allow(clippy::too_many_arguments)]
    pub fn rect(
        &self,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: Option<&Paint>,
        stroke: Option<&Paint>,
        stroke_w: f64,
    ) {
        let (x, w) = if w < 0.0 { (x + w, -w) } else { (x, w) };
        let (y, h) = if h < 0.0 { (y + h, -h) } else { (y, h) };
        self.push(Primitive::Rect {
            x,
            y,
            w,
            h,
            fill: fill.map(|p| p.hex.clone()),
            stroke: stroke.map(|p| p.hex.clone()),
            stroke_w: if stroke.is_some() { stroke_w } else { 0.0 },
            fill_swatch_ref: fill.and_then(|p| p.swatch.clone()),
            stroke_swatch_ref: stroke.and_then(|p| p.swatch.clone()),
        });
    }

    /// A filled rect without outline.
    pub fn bar(&self, x: f64, y: f64, w: f64, h: f64, fill: &Paint) {
        self.rect(x, y, w, h, Some(fill), None, 0.0);
    }

    pub fn line(&self, pts: Vec<(f64, f64)>, stroke: &Paint, w: f64, dash: Option<&str>) {
        if pts.len() < 2 {
            return;
        }
        self.push(Primitive::Line {
            pts,
            stroke: stroke.hex.clone(),
            stroke_w: w,
            stroke_swatch_ref: stroke.swatch.clone(),
            dash: dash.map(str::to_string),
        });
    }

    pub fn poly(
        &self,
        pts: Vec<(f64, f64)>,
        fill: Option<&Paint>,
        stroke: Option<&Paint>,
        stroke_w: f64,
    ) {
        if pts.len() < 3 {
            return;
        }
        self.push(Primitive::Polygon {
            pts,
            fill: fill.map(|p| p.hex.clone()),
            stroke: stroke.map(|p| p.hex.clone()),
            stroke_w: if stroke.is_some() { stroke_w } else { 0.0 },
            fill_swatch_ref: fill.and_then(|p| p.swatch.clone()),
            stroke_swatch_ref: stroke.and_then(|p| p.swatch.clone()),
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub fn wedge(
        &self,
        cx: f64,
        cy: f64,
        r: f64,
        inner: f64,
        start: f64,
        end: f64,
        fill: &Paint,
        stroke: Option<&Paint>,
    ) {
        if r <= 0.0 || end <= start {
            return;
        }
        self.push(Primitive::Wedge {
            cx,
            cy,
            r,
            start_deg: start,
            end_deg: end,
            fill: Some(fill.hex.clone()),
            stroke: stroke.map(|p| p.hex.clone()),
            inner_r: (inner > 0.0).then_some(inner),
            fill_swatch_ref: fill.swatch.clone(),
            stroke_swatch_ref: stroke.and_then(|p| p.swatch.clone()),
        });
    }

    /// A text label through plotters (the one text-metrics path), then
    /// placed exactly and given its role's properties.
    pub fn text(&self, x: f64, y: f64, s: &str, spec: &TextSpec) {
        if s.is_empty() {
            return;
        }
        let h = match spec.anchor {
            TextAnchor::Start => HPos::Left,
            TextAnchor::Middle => HPos::Center,
            TextAnchor::End => HPos::Right,
        };
        let style = ("sans-serif", spec.size)
            .into_text_style(&self.root)
            .pos(Pos::new(h, VPos::Bottom));
        let before = self.sink.borrow().len();
        let _ = self.root.draw(&Text::new(
            s.to_string(),
            (x.round() as i32, y.round() as i32),
            &style,
        ));
        let mut sink = self.sink.borrow_mut();
        if sink.len() == before {
            sink.push(Primitive::text(x, y, s.to_string(), spec.size, spec.anchor));
        }
        if let Some(Primitive::Text {
            x: px,
            y: py,
            color,
            color_swatch_ref,
            bold,
            italic,
            font,
            paragraph_style,
            character_style,
            role,
            ..
        }) = sink.last_mut()
        {
            *px = x;
            *py = y;
            *color = spec.color.as_ref().map(|p| p.hex.clone());
            *color_swatch_ref = spec.color.as_ref().and_then(|p| p.swatch.clone());
            *bold = spec.bold;
            *italic = spec.italic;
            *font = spec.font.clone();
            *paragraph_style = spec.paragraph.clone();
            *character_style = spec.character.clone();
            *role = Some(spec.role.to_string());
        }
    }

    /// A text label centred in a box, ellipsis-free: lines broken on spaces
    /// to fit `w`, at most as many as fit `h`.
    pub fn text_in_box(&self, x: f64, y: f64, w: f64, h: f64, s: &str, spec: &TextSpec) {
        let lines = wrap(s, w, spec.size);
        let lh = spec.size * 1.2;
        let fit = ((h / lh).floor() as usize).max(1).min(lines.len());
        let total = lh * fit as f64;
        let mut by = y + (h - total) / 2.0 + spec.size;
        let cx = match spec.anchor {
            TextAnchor::Start => x + 2.0,
            TextAnchor::Middle => x + w / 2.0,
            TextAnchor::End => x + w - 2.0,
        };
        for l in lines.iter().take(fit) {
            self.text(cx, by, l, spec);
            by += lh;
        }
    }
}

/// Break `s` on spaces into lines no wider than `w` at `size` (a word wider
/// than `w` stands alone).
pub(crate) fn wrap(s: &str, w: f64, size: f64) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for para in s.split('\n') {
        let mut cur = String::new();
        for word in para.split(' ').filter(|w| !w.is_empty()) {
            let cand = if cur.is_empty() {
                word.to_string()
            } else {
                format!("{cur} {word}")
            };
            if text_width(&cand, size) <= w || cur.is_empty() {
                cur = cand;
            } else {
                lines.push(std::mem::take(&mut cur));
                cur = word.to_string();
            }
        }
        lines.push(cur);
    }
    lines
}

/// The series' display name: the live name, the model's, or "Series N".
pub(crate) fn series_name(model: &ChartModel, data: &PlotData, i: usize) -> String {
    data.names
        .get(i)
        .and_then(|n| n.clone())
        .filter(|n| !n.is_empty())
        .or_else(|| {
            model
                .series()
                .nth(i)
                .and_then(|s| s.name.as_ref())
                .map(|n| n.to_string())
        })
        .unwrap_or_else(|| format!("Series{}", i + 1))
}

/// Value of series `si` at point `pi` (NaN when missing).
pub(crate) fn value_at(data: &PlotData, si: usize, pi: usize) -> f64 {
    data.series
        .get(si)
        .and_then(|s| s.get(pi))
        .copied()
        .unwrap_or(f64::NAN)
}

/// The point count of a category chart: the longest series or the label
/// count, whichever is larger.
pub(crate) fn group_count(data: &PlotData) -> usize {
    data.categories
        .len()
        .max(data.series.iter().map(Vec::len).max().unwrap_or(0))
}

/// Format `v` through an Excel number format (`None` = General).
pub(crate) fn format_number(v: f64, format: Option<&str>, data: &PlotData) -> String {
    let code = format.filter(|f| !f.is_empty()).unwrap_or("General");
    let f = sheet_format::compile(code)
        .or_else(|_| sheet_format::compile("General"))
        .ok();
    match f {
        Some(f) => {
            sheet_format::format_value(&sheet_core::CellValue::Number(v), &f, &data.format_ctx)
        }
        None => sheet_format::format_general(&sheet_core::CellValue::Number(v)),
    }
}
