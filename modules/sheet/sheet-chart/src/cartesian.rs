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

//! The cartesian kinds: column, bar, line, area, stock and waterfall on a
//! category axis; scatter and bubble on two value axes — alone or combined
//! (a combo chart), on a primary and an optional secondary value axis.
//!
//! STACKING (Excel's rule, which replaces the old floor-clamp ruling of
//! `sheet.chart.geometry.stacked`): positive values stack upward from the
//! axis and negative values downward, each on its own running total;
//! percent-stacked divides every category by the sum of its magnitudes, on
//! a 0–100% axis. Stacked lines and areas accumulate in series order.
//!
//! BARS: within a category slot a clustered plot of `n` series is
//! `n − (n−1)·overlap + gap` bar widths wide (Excel's `gapWidth` and
//! `overlap`); bars grow from where the category axis crosses the value
//! axis (`crosses`), so an axis crossing at 10 draws bars from 10.

use crate::colors::Paint;
use crate::extras::{self, LabelParts};
use crate::frame::{self, Entry, Glyph, Rect};
use crate::geometry::{
    group_count, series_name, text_width, value_at, Pen, PlotData, TextAnchor, TextSpec,
    AXIS_STROKE, AXIS_STROKE_W, GRID_STROKE, LABEL_PT, SERIES_STROKE_W,
};
use crate::model::{
    Axis, AxisKind, Blanks, ChartKind, ChartModel, DmlFx, Grouping, LabelPosition, MarkerSymbol,
    Plot, Series, TickLabels, TimeUnit, TrendKind,
};
use crate::scale::Scale;

/// A series with everything the drawing needs.
pub(crate) struct S<'a> {
    pub plot: &'a Plot,
    pub series: &'a Series,
    /// Index across the chart (into `PlotData`).
    pub gi: usize,
    pub color: Paint,
}

/// Resolve each series' paint: its fill/line, else the automatic colour.
pub(crate) fn series_list<'a>(pen: &Pen, model: &'a ChartModel) -> Vec<S<'a>> {
    let n = model.series_count();
    let mut out = Vec::new();
    let mut gi = 0;
    for plot in &model.plots {
        for s in &plot.series {
            let auto_idx = s.index.map_or(gi, |i| i as usize);
            let lineish = matches!(
                plot.kind,
                ChartKind::Line | ChartKind::Scatter | ChartKind::Radar | ChartKind::Stock
            );
            let explicit = if lineish {
                s.line
                    .as_ref()
                    .and_then(|l| l.color.as_ref())
                    .or(s.fill.as_ref())
            } else {
                s.fill
                    .as_ref()
                    .or(s.line.as_ref().and_then(|l| l.color.as_ref()))
            };
            let color = pen
                .theme
                .paint_or(explicit, || pen.theme.auto_color(auto_idx, n, model.style));
            out.push(S {
                plot,
                series: s,
                gi,
                color,
            });
            gi += 1;
        }
    }
    out
}

/// The marker a series draws (`None` = no marker).
pub(crate) fn marker_of(s: &S) -> Option<(MarkerSymbol, f64)> {
    let lineish = matches!(
        s.plot.kind,
        ChartKind::Line | ChartKind::Scatter | ChartKind::Radar
    );
    match &s.series.marker {
        Some(m) => match m.symbol {
            MarkerSymbol::None => None,
            MarkerSymbol::Auto => Some((MarkerSymbol::auto_for(s.gi), m.size)),
            sym => Some((sym, m.size)),
        },
        None if lineish => Some((MarkerSymbol::auto_for(s.gi), 5.0)),
        None => None,
    }
}

/// The legend entries of a cartesian chart.
fn entries(pen: &Pen, model: &ChartModel, data: &PlotData, list: &[S]) -> Vec<Entry> {
    let mut out = Vec::new();
    if model.kind() == ChartKind::Waterfall {
        for (i, label) in ["Increase", "Decrease", "Total"].iter().enumerate() {
            out.push(Entry {
                label: (*label).to_string(),
                glyph: Glyph::Box(pen.theme.auto_color(i, 3, model.style)),
            });
        }
        return out;
    }
    // One single-series plot with one colour per point: the categories.
    if list.len() == 1 && list[0].plot.vary_colors && list[0].plot.kind.is_category() {
        for (i, c) in data.categories.iter().enumerate() {
            out.push(Entry {
                label: c.clone(),
                glyph: Glyph::Box(point_color(pen, model, &list[0], i, data)),
            });
        }
        return out;
    }
    for s in list {
        let label = series_name(model, data, s.gi);
        let glyph = match s.plot.kind {
            ChartKind::Line | ChartKind::Scatter | ChartKind::Stock => {
                let m = marker_of(s).map(|(sym, _)| (sym, s.color.clone()));
                if line_visible(s) {
                    Glyph::Line(s.color.clone(), m)
                } else {
                    match m {
                        Some((sym, p)) => Glyph::Marker(sym, p),
                        None => Glyph::Line(s.color.clone(), None),
                    }
                }
            }
            _ => Glyph::Box(s.color.clone()),
        };
        out.push(Entry { label, glyph });
        for t in &s.series.trendlines {
            let tname = t.name.as_ref().map(|n| n.to_string()).unwrap_or_else(|| {
                let k = match t.kind {
                    TrendKind::Linear => "Linear".to_string(),
                    TrendKind::Exponential => "Expon.".to_string(),
                    TrendKind::Logarithmic => "Log.".to_string(),
                    TrendKind::Polynomial(_) => "Poly.".to_string(),
                    TrendKind::Power => "Power".to_string(),
                    TrendKind::MovingAverage(n) => format!("{n} per. Mov. Avg."),
                };
                format!("{k} ({})", series_name(model, data, s.gi))
            });
            out.push(Entry {
                label: tname,
                glyph: Glyph::Line(trend_paint(pen, s, t), None),
            });
        }
    }
    out
}

fn trend_paint(pen: &Pen, s: &S, t: &crate::model::Trendline) -> Paint {
    pen.theme
        .paint_or(t.line.as_ref().and_then(|l| l.color.as_ref()), || {
            s.color.clone()
        })
}

/// A point's fill: its `c:dPt` override, the varied colour, or the series'.
pub(crate) fn point_color(
    pen: &Pen,
    model: &ChartModel,
    s: &S,
    i: usize,
    data: &PlotData,
) -> Paint {
    if let Some((_, c)) = s.series.points.iter().find(|(p, _)| *p as usize == i) {
        return pen.theme.paint(c, &s.color.hex);
    }
    if s.plot.vary_colors && model.series_count() == 1 {
        let n = group_count(data).max(1);
        return pen.theme.auto_color(i, n, model.style);
    }
    s.color.clone()
}

/// A point's gradient and effects: its `c:dPt` override, else the series'
/// (sheet ADR 527).
pub(crate) fn point_fx<'a>(s: &S<'a>, i: usize) -> Option<&'a DmlFx> {
    s.series
        .point_fx
        .iter()
        .find(|(p, _)| *p as usize == i)
        .map(|(_, fx)| fx)
        .or(s.series.fx.as_deref())
}

/// Whether a line-ish series draws its line.
pub(crate) fn line_visible(s: &S) -> bool {
    match &s.series.line {
        Some(l) => !l.none,
        None => !matches!(s.plot.kind, ChartKind::Stock),
    }
}

fn line_width(s: &S) -> f64 {
    s.series
        .line
        .as_ref()
        .and_then(|l| l.width_pt)
        .unwrap_or(SERIES_STROKE_W)
}

/// What a value axis measures across the plots on it.
fn extent(plots: &[&S], data: &PlotData, n: usize) -> (f64, f64, bool) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    let mut percent = false;
    let mut seen: Vec<*const Plot> = Vec::new();
    for s in plots {
        let p = s.plot;
        let key = p as *const Plot;
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let members: Vec<&&S> = plots.iter().filter(|t| std::ptr::eq(t.plot, p)).collect();
        let stackable = matches!(
            p.kind,
            ChartKind::Column | ChartKind::Bar | ChartKind::Line | ChartKind::Area
        );
        if p.kind == ChartKind::Waterfall {
            let mut run = 0.0;
            lo = lo.min(0.0);
            hi = hi.max(0.0);
            for i in 0..n {
                let v = value_at(data, members[0].gi, i);
                if !v.is_finite() {
                    continue;
                }
                if p.ex.subtotals.contains(&(i as u32)) {
                    run = v;
                } else {
                    let start = run;
                    run += v;
                    lo = lo.min(start);
                    hi = hi.max(start);
                }
                lo = lo.min(run);
                hi = hi.max(run);
            }
            continue;
        }
        if stackable && p.grouping.is_stacked() {
            if p.grouping == Grouping::PercentStacked {
                percent = true;
            }
            for i in 0..n {
                let (pos, neg, mag) = members.iter().fold((0.0, 0.0, 0.0), |(p_, n_, m), t| {
                    let v = value_at(data, t.gi, i);
                    if !v.is_finite() {
                        (p_, n_, m)
                    } else if v >= 0.0 {
                        (p_ + v, n_, m + v)
                    } else {
                        (p_, n_ + v, m - v)
                    }
                });
                let (pos, neg) = if p.grouping == Grouping::PercentStacked {
                    if mag > 0.0 {
                        (pos / mag, neg / mag)
                    } else {
                        (0.0, 0.0)
                    }
                } else {
                    (pos, neg)
                };
                if matches!(p.kind, ChartKind::Line | ChartKind::Area) {
                    // Lines/areas accumulate signed values in order.
                    let mut run = 0.0;
                    for t in &members {
                        let v = value_at(data, t.gi, i);
                        if v.is_finite() {
                            run += if p.grouping == Grouping::PercentStacked && mag > 0.0 {
                                v / mag
                            } else {
                                v
                            };
                            lo = lo.min(run);
                            hi = hi.max(run);
                        }
                    }
                } else {
                    lo = lo.min(neg);
                    hi = hi.max(pos);
                }
            }
            continue;
        }
        for t in &members {
            for v in data.series.get(t.gi).into_iter().flatten() {
                if v.is_finite() {
                    lo = lo.min(*v);
                    hi = hi.max(*v);
                }
            }
            // Error bars widen the extent.
            for (k, eb) in t.series.error_bars.iter().enumerate() {
                if eb.along_x {
                    continue;
                }
                let vals = data.series.get(t.gi).cloned().unwrap_or_default();
                let custom = data.custom_errors.get(t.gi).and_then(|c| c.get(k));
                for (a, b) in extras::error_ends(eb, &vals, custom).into_iter().flatten() {
                    lo = lo.min(a);
                    hi = hi.max(b);
                }
            }
        }
    }
    (lo, hi, percent)
}

/// The category positions: slot count and the unit index of each point.
struct Cats {
    slots: usize,
    /// Slot of each point.
    at: Vec<f64>,
    /// Label per slot (empty = none).
    labels: Vec<String>,
    /// Points sit on slot edges (area alone) rather than centres.
    on_edges: bool,
}

fn date_unit(serial: f64, unit: TimeUnit, data: &PlotData) -> f64 {
    let sys = data.format_ctx.date_system;
    match unit {
        TimeUnit::Days => serial.floor(),
        TimeUnit::Months => sheet_format::serial::serial_to_ymd(serial, sys)
            .map_or(serial / 30.4375, |(y, m, _)| {
                (y as f64) * 12.0 + m as f64 - 1.0
            }),
        TimeUnit::Years => sheet_format::serial::serial_to_ymd(serial, sys)
            .map_or(serial / 365.25, |(y, _, _)| y as f64),
    }
}

fn categories(model: &ChartModel, data: &PlotData, n: usize) -> Cats {
    let on_edges = model.plots.iter().all(|p| p.kind == ChartKind::Area);
    if model.cat_axis.kind == AxisKind::Date {
        if let Some(serials) = data.category_serials.as_ref().filter(|s| !s.is_empty()) {
            let unit = model.cat_axis.base_unit.unwrap_or_else(|| {
                // Excel picks the unit from the smallest gap between dates.
                let mut sorted: Vec<f64> = serials.clone();
                sorted.sort_by(|a, b| a.total_cmp(b));
                let gap = sorted
                    .windows(2)
                    .map(|w| w[1] - w[0])
                    .filter(|g| *g > 0.0)
                    .fold(f64::INFINITY, f64::min);
                if gap >= 365.0 {
                    TimeUnit::Years
                } else if gap >= 28.0 {
                    TimeUnit::Months
                } else {
                    TimeUnit::Days
                }
            });
            let us: Vec<f64> = serials.iter().map(|s| date_unit(*s, unit, data)).collect();
            let umin = us.iter().copied().fold(f64::INFINITY, f64::min);
            let umax = us.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let slots = ((umax - umin) as usize + 1).min(5000);
            let fmt = model.cat_axis.format.as_deref().unwrap_or(match unit {
                TimeUnit::Days => "d-mmm",
                TimeUnit::Months => "mmm-yy",
                TimeUnit::Years => "yyyy",
            });
            let mut labels = vec![String::new(); slots];
            for (k, s) in serials.iter().enumerate() {
                let slot = (us[k] - umin) as usize;
                if slot < slots && labels[slot].is_empty() {
                    labels[slot] = crate::geometry::format_number(*s, Some(fmt), data);
                }
            }
            return Cats {
                slots,
                at: us.iter().map(|u| u - umin).collect(),
                labels,
                on_edges,
            };
        }
    }
    let mut labels = data.categories.clone();
    labels.resize(n, String::new());
    if data.categories.is_empty() {
        labels = (1..=n).map(|i| i.to_string()).collect();
    }
    Cats {
        slots: n,
        at: (0..n).map(|i| i as f64).collect(),
        labels,
        on_edges,
    }
}

/// The category axis mapped onto pt: slot `i`'s centre and the slot width.
#[derive(Clone, Copy)]
struct CatMap {
    a: f64,
    b: f64,
    slots: usize,
    on_edges: bool,
    reversed: bool,
}

impl CatMap {
    fn width(&self) -> f64 {
        let n = if self.on_edges {
            (self.slots.max(2) - 1) as f64
        } else {
            self.slots.max(1) as f64
        };
        (self.b - self.a).abs() / n
    }
    fn center(&self, slot: f64) -> f64 {
        let f = if self.on_edges {
            slot / (self.slots.max(2) - 1) as f64
        } else {
            (slot + 0.5) / self.slots.max(1) as f64
        };
        let f = if self.reversed { 1.0 - f } else { f };
        self.a + (self.b - self.a) * f
    }
}

/// The plot geometry shared by every series of a cartesian chart.
struct Geo {
    horizontal: bool,
    plot: Rect,
    cat: CatMap,
    /// Scatter/bubble X.
    x: Option<Scale>,
    val: Scale,
    val2: Option<Scale>,
    cats: Cats,
}

impl Geo {
    fn scale(&self, secondary: bool) -> &Scale {
        if secondary {
            self.val2.as_ref().unwrap_or(&self.val)
        } else {
            &self.val
        }
    }
    /// A (category position, value position) pair to (x, y).
    fn xy(&self, c: f64, v: f64) -> (f64, f64) {
        if self.horizontal {
            (v, c)
        } else {
            (c, v)
        }
    }
}

pub(crate) fn cartesian(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let list = series_list(pen, model);
    let ents = entries(pen, model, data, &list);
    let area = frame::frame(pen, model, &ents);
    if !area.ok() {
        return;
    }
    let xy_chart = model.plots.iter().any(|p| p.kind.is_xy());
    let horizontal = !xy_chart
        && model
            .plots
            .first()
            .is_some_and(|p| p.kind == ChartKind::Bar);
    let n = group_count(data);

    // Value extents per axis group, then the scales.
    let prim: Vec<&S> = list.iter().filter(|s| !s.plot.secondary).collect();
    let sec: Vec<&S> = list.iter().filter(|s| s.plot.secondary).collect();
    let (lo, hi, pct) = if prim.is_empty() {
        extent(&sec, data, n)
    } else {
        extent(&prim, data, n)
    };
    let val = Scale::auto(lo, hi, &model.val_axis, pct);
    let val2 = (!sec.is_empty() && !prim.is_empty()).then(|| {
        let (lo, hi, pct) = extent(&sec, data, n);
        Scale::auto(
            lo,
            hi,
            model.sec_val_axis.as_ref().unwrap_or(&model.val_axis),
            pct,
        )
    });
    let x = xy_chart.then(|| {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for s in &list {
            for v in xs_of(data, s.gi) {
                if v.is_finite() {
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
            }
        }
        Scale::auto(lo, hi, &model.cat_axis, false)
    });
    let cats = categories(model, data, n);
    let val_fmt = |s: &Scale, axis: &Axis| -> Box<dyn Fn(f64) -> String> {
        let fmt = axis
            .format
            .clone()
            .map(|f| f.to_string())
            .or_else(|| pct.then(|| "0%".to_string()))
            .or_else(|| list.first().and_then(|s| data_format(data, s.gi)));
        let _ = s;
        Box::new(move |v| crate::geometry::format_number(v, fmt.as_deref(), data))
    };
    let vfmt = val_fmt(&val, &model.val_axis);
    let v2fmt = val2
        .as_ref()
        .map(|s| val_fmt(s, model.sec_val_axis.as_ref().unwrap_or(&model.val_axis)));
    let xfmt = x.as_ref().map(|s| val_fmt(s, &model.cat_axis));

    // Gutters: the value labels' width, the category labels' height.
    let tick = TextSpec::of(
        &model.val_axis.labels,
        &model.text,
        LABEL_PT,
        TextAnchor::End,
        "tick",
        &pen.theme,
    );
    let ctick = TextSpec::of(
        &model.cat_axis.labels,
        &model.text,
        LABEL_PT,
        TextAnchor::Middle,
        "tick",
        &pen.theme,
    );
    let show_val = !model.val_axis.deleted && model.val_axis.tick_labels != TickLabels::None;
    let show_cat = !model.cat_axis.deleted && model.cat_axis.tick_labels != TickLabels::None;
    let val_label_w = |s: &Scale, f: &dyn Fn(f64) -> String| {
        s.ticks()
            .iter()
            .map(|v| tick.width(&f(*v)))
            .fold(0.0, f64::max)
    };
    let cat_label_w = if let Some(xs) = &x {
        let f = xfmt.as_ref().unwrap();
        xs.ticks()
            .iter()
            .map(|v| ctick.width(&f(*v)))
            .fold(0.0, f64::max)
    } else {
        cats.labels
            .iter()
            .map(|l| ctick.width(l))
            .fold(0.0, f64::max)
    };
    let title_h = |a: &Axis| {
        a.title
            .as_ref()
            .filter(|t| !t.is_empty())
            .map_or(0.0, |_| LABEL_PT * 1.4)
    };
    let (mut left, mut right, mut top, mut bottom) = (0.0, 0.0, 0.0, 0.0);
    let primary_axis_right = model.val_axis.crosses == crate::model::Crosses::Max;
    if horizontal {
        // Value axis along the bottom, categories down the left.
        if show_val {
            bottom += tick.size * 1.4;
        }
        if show_cat {
            left += cat_label_w.min(area.w * 0.35) + 6.0;
        }
        bottom += title_h(&model.val_axis);
        top += title_h(&model.cat_axis);
        if let (Some(s2), Some(_)) = (&val2, &v2fmt) {
            let _ = s2;
            top += tick.size * 1.4;
        }
    } else {
        if show_val {
            let w = val_label_w(&val, &*vfmt) + 6.0;
            if primary_axis_right {
                right += w;
            } else {
                left += w;
            }
        }
        if let (Some(s2), Some(f2)) = (&val2, &v2fmt) {
            right += val_label_w(s2, &**f2) + 6.0;
        }
        if show_cat {
            bottom += ctick.size * 1.4;
        }
        bottom += title_h(&model.cat_axis);
        top += title_h(&model.val_axis);
        if val2.is_some() {
            if let Some(a2) = &model.sec_val_axis {
                top = top.max(title_h(a2));
            }
        }
    }
    let plot = area.inset(left, top.max(4.0), right.max(4.0), bottom);
    if !plot.ok() {
        return;
    }
    let (va, vb) = if horizontal {
        (plot.x, plot.right())
    } else {
        (plot.bottom(), plot.y)
    };
    let val = val.on(va, vb);
    let val2 = val2.map(|s| s.on(va, vb));
    let x = x.map(|s| s.on(plot.x, plot.right()));
    let cat = if horizontal {
        // Excel draws the first category at the bottom of a bar chart.
        CatMap {
            a: plot.bottom(),
            b: plot.y,
            slots: cats.slots,
            on_edges: false,
            reversed: model.cat_axis.reversed,
        }
    } else {
        CatMap {
            a: plot.x,
            b: plot.right(),
            slots: cats.slots,
            on_edges: cats.on_edges,
            reversed: model.cat_axis.reversed,
        }
    };
    let geo = Geo {
        horizontal,
        plot,
        cat,
        x,
        val,
        val2,
        cats,
    };

    // Plot area, gridlines, axes.
    let pa = &model.plot_area;
    if let Some(f) = pa.fill.as_ref().filter(|_| !pa.no_fill) {
        let fill = pen.theme.paint(f, "#FFFFFF");
        pen.with_fx(pa.fx.as_deref(), || {
            pen.bar(plot.x, plot.y, plot.w, plot.h, &fill)
        });
    }
    gridlines(pen, model, &geo);
    axes(
        pen,
        model,
        &geo,
        &tick,
        &ctick,
        &*vfmt,
        v2fmt.as_deref(),
        xfmt.as_deref(),
        show_val,
        show_cat,
    );

    // The series, plot by plot in drawing order: areas and bars first
    // (behind), then lines and markers (Excel's z-order).
    let rank = |k: ChartKind| match k {
        ChartKind::Area => 0,
        ChartKind::Column | ChartKind::Bar | ChartKind::Waterfall => 1,
        ChartKind::Stock => 2,
        ChartKind::Bubble => 3,
        _ => 4,
    };
    let mut order: Vec<&Plot> = model.plots.iter().collect();
    order.sort_by_key(|p| rank(p.kind));
    for p in order {
        let members: Vec<&S> = list.iter().filter(|s| std::ptr::eq(s.plot, p)).collect();
        if members.is_empty() {
            continue;
        }
        match p.kind {
            ChartKind::Column | ChartKind::Bar => bars(pen, model, data, &geo, p, &members),
            ChartKind::Line | ChartKind::Area => lines(pen, model, data, &geo, p, &members),
            ChartKind::Stock => stock(pen, data, &geo, p, &members),
            ChartKind::Waterfall => waterfall(pen, model, data, &geo, p, &members),
            ChartKind::Scatter | ChartKind::Bubble => scatter(pen, model, data, &geo, p, &members),
            _ => {}
        }
    }
}

/// The number format of series `gi`'s values (its first cell's), which a
/// value axis and data labels show unless they state their own.
pub(crate) fn data_format(data: &PlotData, gi: usize) -> Option<String> {
    data.value_formats.get(gi).cloned().flatten()
}

/// Scatter/bubble X values (1, 2, 3… when the series has none).
pub(crate) fn xs_of(data: &PlotData, gi: usize) -> Vec<f64> {
    let n = data.series.get(gi).map_or(0, Vec::len);
    match data.x_values.get(gi).and_then(|x| x.as_ref()) {
        Some(x) if !x.is_empty() => x.clone(),
        _ => (1..=n).map(|i| i as f64).collect(),
    }
}

fn grid_paint(pen: &Pen, l: &crate::model::LineStyle) -> Option<(Paint, f64, Option<String>)> {
    if l.none {
        return None;
    }
    Some((
        pen.theme
            .paint_or(l.color.as_ref(), || Paint::hex(GRID_STROKE)),
        l.width_pt.unwrap_or(AXIS_STROKE_W),
        l.dash.as_ref().map(|d| d.to_string()),
    ))
}

fn gridlines(pen: &Pen, model: &ChartModel, g: &Geo) {
    let p = g.plot;
    let along = |pos: f64, paint: &(Paint, f64, Option<String>), value_axis: bool| {
        // Value gridlines run across the categories and vice versa.
        let horizontal_line = value_axis != g.horizontal;
        let pts = if horizontal_line {
            vec![(p.x, pos), (p.right(), pos)]
        } else {
            vec![(pos, p.y), (pos, p.bottom())]
        };
        pen.line(pts, &paint.0, paint.1, paint.2.as_deref());
    };
    if let Some(gl) = model
        .val_axis
        .minor_gridlines
        .as_ref()
        .and_then(|l| grid_paint(pen, l))
    {
        for v in g.val.minor_ticks() {
            along(g.val.px(v), &gl, true);
        }
    }
    if let Some(gl) = model
        .val_axis
        .major_gridlines
        .as_ref()
        .and_then(|l| grid_paint(pen, l))
    {
        for v in g.val.ticks() {
            along(g.val.px(v), &gl, true);
        }
    }
    if let Some(gl) = model
        .cat_axis
        .major_gridlines
        .as_ref()
        .and_then(|l| grid_paint(pen, l))
    {
        if let Some(x) = &g.x {
            for v in x.ticks() {
                along(x.px(v), &gl, false);
            }
        } else {
            let w = g.cat.width();
            for i in 0..=g.cats.slots {
                let c = g.cat.center(i as f64) - w / 2.0 * (g.cat.b - g.cat.a).signum();
                along(c, &gl, false);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn axes(
    pen: &Pen,
    model: &ChartModel,
    g: &Geo,
    tick: &TextSpec,
    ctick: &TextSpec,
    vfmt: &dyn Fn(f64) -> String,
    v2fmt: Option<&dyn Fn(f64) -> String>,
    xfmt: Option<&dyn Fn(f64) -> String>,
    show_val: bool,
    show_cat: bool,
) {
    let p = g.plot;
    let axis_paint = |a: &Axis| -> Option<(Paint, f64)> {
        match &a.line {
            Some(l) if l.none => None,
            Some(l) => Some((
                pen.theme
                    .paint_or(l.color.as_ref(), || Paint::hex(AXIS_STROKE)),
                l.width_pt.unwrap_or(AXIS_STROKE_W),
            )),
            None => Some((Paint::hex(AXIS_STROKE), AXIS_STROKE_W)),
        }
    };
    // Where the category axis crosses the value axis, and vice versa.
    let cross_v = g.val.px_clamped(g.val.cross_value(model.cat_axis.crosses));
    let val_at_max = model.val_axis.crosses == crate::model::Crosses::Max;
    let cross_c = if g.horizontal {
        if val_at_max {
            p.y
        } else {
            p.bottom()
        }
    } else if val_at_max {
        p.right()
    } else if let Some(x) = &g.x {
        x.px_clamped(x.cross_value(model.val_axis.crosses))
    } else {
        p.x
    };
    // Category (or X) axis line.
    if !model.cat_axis.deleted {
        if let Some((paint, w)) = axis_paint(&model.cat_axis) {
            let pts = if g.horizontal {
                vec![(cross_v, p.y), (cross_v, p.bottom())]
            } else {
                vec![(p.x, cross_v), (p.right(), cross_v)]
            };
            pen.line(pts, &paint, w, None);
        }
    }
    // Value axis line (Excel leaves it off by default; drawn when stated).
    if !model.val_axis.deleted {
        if let Some(l) = model
            .val_axis
            .line
            .as_ref()
            .filter(|l| !l.none && l.color.is_some())
        {
            let paint = pen
                .theme
                .paint_or(l.color.as_ref(), || Paint::hex(AXIS_STROKE));
            let pts = if g.horizontal {
                vec![(p.x, cross_c), (p.right(), cross_c)]
            } else {
                vec![(cross_c, p.y), (cross_c, p.bottom())]
            };
            pen.line(pts, &paint, l.width_pt.unwrap_or(AXIS_STROKE_W), None);
        }
    }
    // Value tick labels.
    let label_side = |a: &Axis, low: f64, high: f64, next: f64| match a.tick_labels {
        TickLabels::Low => low,
        TickLabels::High => high,
        _ => next,
    };
    if show_val {
        if g.horizontal {
            let y = label_side(&model.val_axis, p.bottom(), p.y, p.bottom()) + tick.size * 1.1;
            for v in g.val.ticks() {
                pen.text(g.val.px(v), y, &vfmt(v), &tick.anchored(TextAnchor::Middle));
            }
        } else {
            let at_right = val_at_max;
            let x = if at_right { p.right() + 4.0 } else { p.x - 4.0 };
            let x = label_side(&model.val_axis, p.x - 4.0, p.right() + 4.0, x);
            let anchor = if x > p.cx() {
                TextAnchor::Start
            } else {
                TextAnchor::End
            };
            for v in g.val.ticks() {
                pen.text(
                    x,
                    g.val.px(v) + tick.size * 0.35,
                    &vfmt(v),
                    &tick.anchored(anchor),
                );
            }
        }
    }
    if let (Some(s2), Some(f2)) = (&g.val2, v2fmt) {
        let a2 = model.sec_val_axis.as_ref();
        if !a2.is_some_and(|a| a.deleted) {
            for v in s2.ticks() {
                if g.horizontal {
                    pen.text(
                        s2.px(v),
                        p.y - 4.0,
                        &f2(v),
                        &tick.anchored(TextAnchor::Middle),
                    );
                } else {
                    pen.text(
                        p.right() + 4.0,
                        s2.px(v) + tick.size * 0.35,
                        &f2(v),
                        &tick.anchored(TextAnchor::Start),
                    );
                }
            }
        }
    }
    // Category (or X) labels; every k-th when they would collide.
    if show_cat {
        if let (Some(x), Some(f)) = (&g.x, xfmt) {
            let y = p.bottom() + ctick.size * 1.2;
            for v in x.ticks() {
                pen.text(x.px(v), y, &f(v), &ctick.anchored(TextAnchor::Middle));
            }
        } else {
            let w = g.cat.width();
            let widest = g
                .cats
                .labels
                .iter()
                .map(|l| ctick.width(l))
                .fold(0.0, f64::max);
            let step = if g.horizontal {
                ((ctick.size * 1.2) / w).ceil().max(1.0) as usize
            } else {
                ((widest + 4.0) / w).ceil().max(1.0) as usize
            };
            for (i, l) in g.cats.labels.iter().enumerate() {
                if l.is_empty() || i % step != 0 {
                    continue;
                }
                let c = g.cat.center(i as f64);
                if g.horizontal {
                    let x = label_side(&model.cat_axis, p.x - 4.0, p.right() + 4.0, p.x - 4.0);
                    pen.text(
                        x,
                        c + ctick.size * 0.35,
                        l,
                        &ctick.anchored(TextAnchor::End),
                    );
                } else {
                    let y = label_side(&model.cat_axis, p.bottom(), p.y, p.bottom());
                    pen.text(
                        c,
                        y + ctick.size * 1.2,
                        l,
                        &ctick.anchored(TextAnchor::Middle),
                    );
                }
            }
        }
    }
    // Axis titles (RULING `sheet.chart.axis-titles`: the IR has no rotation,
    // so the value-axis title sits horizontally above its axis and the
    // category-axis title is centred under the labels).
    let (bottom_axis, top_axis) = if g.horizontal {
        (&model.val_axis, &model.cat_axis)
    } else {
        (&model.cat_axis, &model.val_axis)
    };
    if let Some(t) = top_axis.title.as_deref().filter(|t| !t.is_empty()) {
        let spec = TextSpec::of(
            &top_axis.title_style,
            &model.text,
            LABEL_PT,
            TextAnchor::Start,
            "axisTitle",
            &pen.theme,
        );
        pen.text(frame::PAD, p.y - 4.0, t, &spec);
    }
    if let Some(a2) = model.sec_val_axis.as_ref().filter(|_| g.val2.is_some()) {
        if let Some(t) = a2.title.as_deref().filter(|t| !t.is_empty()) {
            let spec = TextSpec::of(
                &a2.title_style,
                &model.text,
                LABEL_PT,
                TextAnchor::End,
                "axisTitle",
                &pen.theme,
            );
            pen.text(pen.w - frame::PAD, p.y - 4.0, t, &spec);
        }
    }
    if let Some(t) = bottom_axis.title.as_deref().filter(|t| !t.is_empty()) {
        let spec = TextSpec::of(
            &bottom_axis.title_style,
            &model.text,
            LABEL_PT,
            TextAnchor::Middle,
            "axisTitle",
            &pen.theme,
        );
        pen.text(p.cx(), pen.h - frame::PAD - 2.0, t, &spec);
    }
}

// ── bars ────────────────────────────────────────────────────────────────────

fn bars(pen: &Pen, model: &ChartModel, data: &PlotData, g: &Geo, p: &Plot, ms: &[&S]) {
    let scale = g.scale(p.secondary);
    let w = g.cat.width();
    let n = ms.len() as f64;
    let gap = p.gap_width as f64 / 100.0;
    let stacked = p.grouping.is_stacked();
    let ov = if stacked {
        1.0
    } else {
        (p.overlap as f64 / 100.0).clamp(-1.0, 1.0)
    };
    let bw = if stacked {
        w / (1.0 + gap)
    } else {
        w / (n - (n - 1.0) * ov + gap)
    };
    let step = bw * (1.0 - ov);
    let cluster = bw + step * (n - 1.0);
    let base = scale.px_clamped(scale.cross_value(model.cat_axis.crosses));
    let dir = (g.cat.b - g.cat.a).signum();
    let count = group_count(data);
    let mut pos_run = vec![0.0; count];
    let mut neg_run = vec![0.0; count];
    let mags: Vec<f64> = (0..count)
        .map(|i| {
            ms.iter()
                .map(|s| value_at(data, s.gi, i))
                .filter(|v| v.is_finite())
                .map(f64::abs)
                .sum()
        })
        .collect();
    for (k, s) in ms.iter().enumerate() {
        for i in 0..count {
            let raw = value_at(data, s.gi, i);
            let v = match (raw.is_finite(), model.blanks) {
                (true, _) => raw,
                (false, Blanks::Zero) => 0.0,
                _ => continue,
            };
            let slot = g.cats.at.get(i).copied().unwrap_or(i as f64);
            let c = g.cat.center(slot);
            let lo_c = c - dir * cluster / 2.0 + dir * k as f64 * step;
            let lo_c = if stacked { c - dir * bw / 2.0 } else { lo_c };
            let (from, to) = if stacked {
                let v = if p.grouping == Grouping::PercentStacked {
                    if mags[i] > 0.0 {
                        v / mags[i]
                    } else {
                        0.0
                    }
                } else {
                    v
                };
                let run = if v >= 0.0 {
                    &mut pos_run[i]
                } else {
                    &mut neg_run[i]
                };
                let from = *run;
                *run += v;
                (scale.px_clamped(from), scale.px_clamped(*run))
            } else {
                (base, scale.px_clamped(v))
            };
            let fill = point_color(pen, model, s, i, data);
            let (fill, stroke) = if s.series.invert_if_negative && v < 0.0 {
                (Paint::hex("#FFFFFF"), Some(fill))
            } else {
                (fill, None)
            };
            let (x0, y0) = g.xy(lo_c, from);
            let (x1, y1) = g.xy(lo_c + dir * bw, to);
            pen.with_fx(point_fx(s, i), || {
                pen.rect(x0, y0, x1 - x0, y1 - y0, Some(&fill), stroke.as_ref(), 0.75)
            });
            // Data label.
            if let Some(dl) = s
                .series
                .labels
                .as_ref()
                .or(p.labels.as_ref())
                .filter(|d| d.any())
            {
                let pos = dl.position.unwrap_or(if stacked {
                    LabelPosition::Center
                } else {
                    LabelPosition::OutsideEnd
                });
                let text = extras::label_text(
                    dl,
                    &LabelParts {
                        value: raw,
                        category: g.cats.labels.get(i).map_or("", String::as_str),
                        series: &series_name(model, data, s.gi),
                        percent: (mags[i] > 0.0).then(|| raw.abs() / mags[i]),
                        bubble: None,
                        format: crate::cartesian::data_format(data, s.gi),
                    },
                    data,
                );
                let spec = TextSpec::of(
                    &dl.style,
                    &model.text,
                    LABEL_PT,
                    TextAnchor::Middle,
                    "dataLabel",
                    &pen.theme,
                );
                let sgn = (to - from).signum();
                let vpos = match pos {
                    LabelPosition::Center => (from + to) / 2.0,
                    LabelPosition::InsideBase => from + sgn * spec.size,
                    LabelPosition::InsideEnd => to - sgn * spec.size,
                    _ => to + sgn * (spec.size * 0.8),
                };
                let cpos = lo_c + dir * bw / 2.0;
                let (lx, ly) = g.xy(cpos, vpos);
                if g.horizontal {
                    let anchor =
                        if matches!(pos, LabelPosition::OutsideEnd | LabelPosition::InsideBase)
                            == (sgn > 0.0)
                        {
                            TextAnchor::Start
                        } else {
                            TextAnchor::End
                        };
                    let anchor = if pos == LabelPosition::Center {
                        TextAnchor::Middle
                    } else {
                        anchor
                    };
                    pen.text(lx, ly + spec.size * 0.35, &text, &spec.anchored(anchor));
                } else {
                    pen.text(lx, ly + spec.size * 0.35, &text, &spec);
                }
            }
        }
        series_extras(pen, model, data, g, p, s, scale, |i| {
            let slot = g.cats.at.get(i).copied().unwrap_or(i as f64);
            let c = g.cat.center(slot);
            if stacked {
                c
            } else {
                c - dir * cluster / 2.0 + dir * (k as f64 * step + bw / 2.0)
            }
        });
    }
}

// ── lines and areas ─────────────────────────────────────────────────────────

/// Catmull-Rom smoothing of a polyline (Excel's smoothed line).
fn smooth(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let mut out = Vec::with_capacity(pts.len() * 8);
    for i in 0..pts.len() - 1 {
        let p0 = pts[i.saturating_sub(1)];
        let p1 = pts[i];
        let p2 = pts[i + 1];
        let p3 = pts[(i + 2).min(pts.len() - 1)];
        for k in 0..8 {
            let t = k as f64 / 8.0;
            let (t2, t3) = (t * t, t * t * t);
            let f = |a: f64, b: f64, c: f64, d: f64| {
                0.5 * (2.0 * b
                    + (-a + c) * t
                    + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2
                    + (-a + 3.0 * b - 3.0 * c + d) * t3)
            };
            out.push((f(p0.0, p1.0, p2.0, p3.0), f(p0.1, p1.1, p2.1, p3.1)));
        }
    }
    out.push(*pts.last().unwrap());
    out
}

fn lines(pen: &Pen, model: &ChartModel, data: &PlotData, g: &Geo, p: &Plot, ms: &[&S]) {
    let scale = g.scale(p.secondary);
    let count = group_count(data);
    let area = p.kind == ChartKind::Area;
    let pct = p.grouping == Grouping::PercentStacked;
    let mags: Vec<f64> = (0..count)
        .map(|i| {
            ms.iter()
                .map(|s| value_at(data, s.gi, i))
                .filter(|v| v.is_finite())
                .map(f64::abs)
                .sum()
        })
        .collect();
    let mut prev_top: Vec<f64> = vec![0.0; count];
    let base_v = scale.cross_value(model.cat_axis.crosses);
    let cpos = |i: usize| g.cat.center(g.cats.at.get(i).copied().unwrap_or(i as f64));
    // Stacked values per series.
    let mut tops: Vec<Vec<f64>> = Vec::new();
    for s in ms {
        let mut row = Vec::with_capacity(count);
        for i in 0..count {
            let raw = value_at(data, s.gi, i);
            let v = if raw.is_finite() {
                raw
            } else if model.blanks == Blanks::Zero || p.grouping.is_stacked() || area {
                0.0
            } else {
                f64::NAN
            };
            let v = if pct && mags[i] > 0.0 { v / mags[i] } else { v };
            if p.grouping.is_stacked() {
                prev_top[i] += v;
                row.push(prev_top[i]);
            } else {
                row.push(v);
            }
        }
        tops.push(row);
    }
    // Areas first (back to front in series order), then lines.
    if area {
        for (k, s) in ms.iter().enumerate() {
            let top = &tops[k];
            let bottom: Vec<f64> = if p.grouping.is_stacked() && k > 0 {
                tops[k - 1].clone()
            } else {
                vec![base_v; count]
            };
            let mut poly: Vec<(f64, f64)> = (0..count)
                .map(|i| g.xy(cpos(i), scale.px_clamped(top[i])))
                .collect();
            poly.extend(
                (0..count)
                    .rev()
                    .map(|i| g.xy(cpos(i), scale.px_clamped(bottom[i]))),
            );
            pen.with_fx(s.series.fx.as_deref(), || {
                pen.poly(poly, Some(&s.color), None, 0.0)
            });
            labels_along(pen, model, data, g, p, s, scale, &tops[k], cpos);
            series_extras(pen, model, data, g, p, s, scale, cpos);
        }
        return;
    }
    for (k, s) in ms.iter().enumerate() {
        let vals = &tops[k];
        if line_visible(s) {
            let dash = s.series.line.as_ref().and_then(|l| l.dash.as_deref());
            let mut run: Vec<(f64, f64)> = Vec::new();
            let flush = |run: &mut Vec<(f64, f64)>| {
                if run.len() >= 2 {
                    let pts = if s.series.smooth {
                        smooth(run)
                    } else {
                        run.clone()
                    };
                    pen.with_fx(s.series.fx.as_deref(), || {
                        pen.line(pts, &s.color, line_width(s), dash)
                    });
                }
                run.clear();
            };
            for (i, &v) in vals.iter().enumerate().take(count) {
                if v.is_finite() {
                    run.push(g.xy(cpos(i), scale.px_clamped(v)));
                } else if model.blanks != Blanks::Span {
                    flush(&mut run);
                }
            }
            flush(&mut run);
        }
        if let Some((sym, size)) = marker_of(s) {
            let mfill = s
                .series
                .marker
                .as_ref()
                .and_then(|m| m.fill.as_ref())
                .map_or(s.color.clone(), |c| pen.theme.paint(c, &s.color.hex));
            let mline = s
                .series
                .marker
                .as_ref()
                .and_then(|m| m.line.as_ref())
                .map(|c| pen.theme.paint(c, &s.color.hex));
            for (i, v) in vals.iter().enumerate() {
                if v.is_finite() {
                    let (x, y) = g.xy(cpos(i), scale.px_clamped(*v));
                    extras::marker(pen, x, y, sym, size, &mfill, mline.as_ref());
                }
            }
        }
        labels_along(pen, model, data, g, p, s, scale, vals, cpos);
        series_extras(pen, model, data, g, p, s, scale, cpos);
    }
    // Drop lines, high-low lines, up/down bars.
    let grey = Paint::hex("#000000");
    if p.drop_lines {
        for s in ms.iter().take(1) {
            let _ = s;
            for i in 0..count {
                let hi = tops
                    .iter()
                    .map(|r| r[i])
                    .filter(|v| v.is_finite())
                    .fold(f64::NEG_INFINITY, f64::max);
                if hi.is_finite() {
                    let (x0, y0) = g.xy(cpos(i), scale.px_clamped(hi));
                    let (x1, y1) = g.xy(cpos(i), scale.px_clamped(base_v));
                    pen.line(vec![(x0, y0), (x1, y1)], &grey, 0.75, None);
                }
            }
        }
    }
    if p.hi_low_lines {
        hi_low(pen, g, scale, &tops, count, cpos);
    }
    if p.up_down_bars && tops.len() >= 2 {
        up_down(pen, g, scale, &tops[0], &tops[tops.len() - 1], p, cpos);
    }
}

fn hi_low(
    pen: &Pen,
    g: &Geo,
    scale: &Scale,
    rows: &[Vec<f64>],
    count: usize,
    cpos: impl Fn(usize) -> f64,
) {
    let black = Paint::hex("#000000");
    for i in 0..count {
        let vs: Vec<f64> = rows
            .iter()
            .filter_map(|r| r.get(i))
            .copied()
            .filter(|v| v.is_finite())
            .collect();
        if vs.len() < 2 {
            continue;
        }
        let lo = vs.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = vs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let (x0, y0) = g.xy(cpos(i), scale.px_clamped(lo));
        let (x1, y1) = g.xy(cpos(i), scale.px_clamped(hi));
        pen.line(vec![(x0, y0), (x1, y1)], &black, 0.75, None);
    }
}

fn up_down(
    pen: &Pen,
    g: &Geo,
    scale: &Scale,
    open: &[f64],
    close: &[f64],
    p: &Plot,
    cpos: impl Fn(usize) -> f64,
) {
    let w = g.cat.width() / (1.0 + p.gap_width as f64 / 100.0);
    let up = Paint::hex("#FFFFFF");
    let down = Paint::hex("#000000");
    let edge = Paint::hex("#000000");
    for i in 0..open.len().min(close.len()) {
        let (o, c) = (open[i], close[i]);
        if !(o.is_finite() && c.is_finite()) {
            continue;
        }
        let ctr = cpos(i);
        let (x0, y0) = g.xy(ctr - w / 2.0, scale.px_clamped(o));
        let (x1, y1) = g.xy(ctr + w / 2.0, scale.px_clamped(c));
        let fill = if c >= o { &up } else { &down };
        pen.rect(x0, y0, x1 - x0, y1 - y0, Some(fill), Some(&edge), 0.75);
    }
}

/// Data labels along a line/area series.
#[allow(clippy::too_many_arguments)]
fn labels_along(
    pen: &Pen,
    model: &ChartModel,
    data: &PlotData,
    g: &Geo,
    p: &Plot,
    s: &S,
    scale: &Scale,
    vals: &[f64],
    cpos: impl Fn(usize) -> f64,
) {
    let Some(dl) = s
        .series
        .labels
        .as_ref()
        .or(p.labels.as_ref())
        .filter(|d| d.any())
    else {
        return;
    };
    let spec = TextSpec::of(
        &dl.style,
        &model.text,
        LABEL_PT,
        TextAnchor::Start,
        "dataLabel",
        &pen.theme,
    );
    for (i, v) in vals.iter().enumerate() {
        let raw = value_at(data, s.gi, i);
        if !v.is_finite() || !raw.is_finite() {
            continue;
        }
        let text = extras::label_text(
            dl,
            &LabelParts {
                value: raw,
                category: g.cats.labels.get(i).map_or("", String::as_str),
                series: &series_name(model, data, s.gi),
                percent: None,
                bubble: None,
                format: crate::cartesian::data_format(data, s.gi),
            },
            data,
        );
        let (x, y) = g.xy(cpos(i), scale.px_clamped(*v));
        let (dx, dy, anchor) = match dl.position.unwrap_or(LabelPosition::Right) {
            LabelPosition::Left => (-5.0, spec.size * 0.35, TextAnchor::End),
            LabelPosition::Top | LabelPosition::OutsideEnd => (0.0, -5.0, TextAnchor::Middle),
            LabelPosition::Bottom => (0.0, spec.size + 4.0, TextAnchor::Middle),
            LabelPosition::Center | LabelPosition::InsideEnd | LabelPosition::InsideBase => {
                (0.0, spec.size * 0.35, TextAnchor::Middle)
            }
            _ => (5.0, spec.size * 0.35, TextAnchor::Start),
        };
        pen.text(x + dx, y + dy, &text, &spec.anchored(anchor));
    }
}

/// Trendlines and error bars of a category series; `cpos(i)` is the pt
/// position of point `i` along the category axis.
#[allow(clippy::too_many_arguments)]
fn series_extras(
    pen: &Pen,
    model: &ChartModel,
    data: &PlotData,
    g: &Geo,
    _p: &Plot,
    s: &S,
    scale: &Scale,
    cpos: impl Fn(usize) -> f64,
) {
    let vals = data.series.get(s.gi).cloned().unwrap_or_default();
    let n = vals.len();
    for (k, eb) in s.series.error_bars.iter().enumerate() {
        if eb.along_x {
            continue;
        }
        let paint = pen
            .theme
            .paint_or(eb.line.as_ref().and_then(|l| l.color.as_ref()), || {
                Paint::hex("#000000")
            });
        let custom = data.custom_errors.get(s.gi).and_then(|c| c.get(k));
        for (i, e) in extras::error_ends(eb, &vals, custom)
            .into_iter()
            .enumerate()
        {
            if let Some((lo, hi)) = e {
                error_line(
                    pen,
                    g,
                    cpos(i),
                    scale.px_clamped(lo),
                    scale.px_clamped(hi),
                    !eb.no_end_cap,
                    &paint,
                );
            }
        }
    }
    if s.series.trendlines.is_empty() || n < 2 {
        return;
    }
    let xs: Vec<f64> = (1..=n).map(|i| i as f64).collect();
    let spec = TextSpec::plain(LABEL_PT, TextAnchor::End, "dataLabel");
    // pt along the category axis for a fractional X (1-based).
    let c_of = |x: f64| {
        let i0 = cpos(0);
        let i1 = if n > 1 { cpos(1) } else { i0 + 1.0 };
        i0 + (x - 1.0) * (i1 - i0)
    };
    for t in &s.series.trendlines {
        let paint = trend_paint(pen, s, t);
        let dash = t
            .line
            .as_ref()
            .and_then(|l| l.dash.as_deref())
            .unwrap_or("sysDot");
        let width = t.line.as_ref().and_then(|l| l.width_pt).unwrap_or(1.5);
        if let TrendKind::MovingAverage(per) = t.kind {
            let pts: Vec<(f64, f64)> = extras::moving_average(&xs, &vals, per)
                .into_iter()
                .map(|(x, y)| g.xy(c_of(x), scale.px_clamped(y)))
                .collect();
            pen.line(pts, &paint, width, Some(dash));
            continue;
        }
        let Some(f) = extras::fit(t, &xs, &vals) else {
            continue;
        };
        let (x0, x1) = (1.0 - t.backward, n as f64 + t.forward);
        let pts: Vec<(f64, f64)> = (0..=40)
            .map(|k| x0 + (x1 - x0) * k as f64 / 40.0)
            .map(|x| (x, (f.eval)(x)))
            .filter(|(_, y)| y.is_finite())
            .map(|(x, y)| g.xy(c_of(x), scale.px_clamped(y)))
            .filter(|(x, y)| {
                // A forecast past the last category stops at the plot edge.
                *x >= g.plot.x - 0.01
                    && *x <= g.plot.right() + 0.01
                    && *y >= g.plot.y - 0.01
                    && *y <= g.plot.bottom() + 0.01
            })
            .collect();
        if let Some(&(ex, ey)) = pts.last() {
            extras::trend_label(pen, t, &f, ex.min(g.plot.right()), ey, &spec);
        }
        pen.line(pts, &paint, width, Some(dash));
    }
    let _ = model;
}

fn error_line(pen: &Pen, g: &Geo, c: f64, a: f64, b: f64, cap: bool, paint: &Paint) {
    // Bars run along the value axis: vertical in a column chart.
    extras::error_bar(pen, c, a, b, g.horizontal, cap, paint);
}

// ── stock ───────────────────────────────────────────────────────────────────

fn stock(pen: &Pen, data: &PlotData, g: &Geo, p: &Plot, ms: &[&S]) {
    let scale = g.scale(p.secondary);
    let count = group_count(data);
    let rows: Vec<Vec<f64>> = ms
        .iter()
        .map(|s| (0..count).map(|i| value_at(data, s.gi, i)).collect())
        .collect();
    let cpos = |i: usize| g.cat.center(g.cats.at.get(i).copied().unwrap_or(i as f64));
    // Hi-low lines are what a stock chart is; Excel writes them, and draws
    // them for a parsed chart that omits the element too.
    hi_low(pen, g, scale, &rows, count, cpos);
    let black = Paint::hex("#000000");
    if rows.len() >= 4 {
        // Open-high-low-close: up/down bars between open and close.
        up_down(pen, g, scale, &rows[0], &rows[3], p, cpos);
    } else if rows.len() == 3 {
        // High-low-close: the close as a tick to the right.
        let w = g.cat.width() * 0.2;
        for (i, &c) in rows[2].iter().enumerate() {
            if c.is_finite() {
                let (x0, y0) = g.xy(cpos(i), scale.px_clamped(c));
                let (x1, y1) = g.xy(cpos(i) + w, scale.px_clamped(c));
                pen.line(vec![(x0, y0), (x1, y1)], &black, 1.5, None);
            }
        }
    }
    // Series with visible lines or markers (rare in a stock chart).
    for (k, s) in ms.iter().enumerate() {
        if s.series.line.as_ref().is_some_and(|l| !l.none) {
            let pts: Vec<(f64, f64)> = rows[k]
                .iter()
                .enumerate()
                .filter(|(_, v)| v.is_finite())
                .map(|(i, v)| g.xy(cpos(i), scale.px_clamped(*v)))
                .collect();
            pen.line(pts, &s.color, line_width(s), None);
        }
        if let Some(m) = s
            .series
            .marker
            .as_ref()
            .filter(|m| !matches!(m.symbol, MarkerSymbol::None | MarkerSymbol::Auto))
        {
            for (i, v) in rows[k].iter().enumerate() {
                if v.is_finite() {
                    let (x, y) = g.xy(cpos(i), scale.px_clamped(*v));
                    extras::marker(pen, x, y, m.symbol, m.size, &s.color, None);
                }
            }
        }
    }
}

// ── waterfall ───────────────────────────────────────────────────────────────

fn waterfall(pen: &Pen, model: &ChartModel, data: &PlotData, g: &Geo, p: &Plot, ms: &[&S]) {
    let s = ms[0];
    let scale = g.scale(p.secondary);
    let count = group_count(data);
    let w = g.cat.width() / (1.0 + p.gap_width as f64 / 100.0);
    let colors: Vec<Paint> = (0..3)
        .map(|i| pen.theme.auto_color(i, 3, model.style))
        .collect();
    let grey = Paint::hex("#A6A6A6");
    let mut run = 0.0;
    let mut prev_end: Option<(f64, f64)> = None;
    let spec = TextSpec::plain(LABEL_PT, TextAnchor::Middle, "dataLabel");
    let show_labels = s
        .series
        .labels
        .as_ref()
        .or(p.labels.as_ref())
        .is_some_and(|d| d.any());
    for i in 0..count {
        let v = value_at(data, s.gi, i);
        if !v.is_finite() {
            continue;
        }
        let total = p.ex.subtotals.contains(&(i as u32));
        let (from, to, color) = if total {
            run = v;
            (0.0, v, &colors[2])
        } else {
            let from = run;
            run += v;
            (from, run, if v >= 0.0 { &colors[0] } else { &colors[1] })
        };
        let c = g.cat.center(i as f64);
        let fill = s
            .series
            .points
            .iter()
            .find(|(pi, _)| *pi as usize == i)
            .map_or(color.clone(), |(_, c)| pen.theme.paint(c, &color.hex));
        let (x0, y0) = g.xy(c - w / 2.0, scale.px_clamped(from));
        let (x1, y1) = g.xy(c + w / 2.0, scale.px_clamped(to));
        pen.bar(x0, y0, x1 - x0, y1 - y0, &fill);
        if let Some((pc, pv)) = prev_end {
            let (a, b) = (
                g.xy(pc, scale.px_clamped(pv)),
                g.xy(c - w / 2.0, scale.px_clamped(pv)),
            );
            pen.line(vec![a, b], &grey, 0.75, Some("dash"));
        }
        prev_end = Some((c + w / 2.0, run));
        if show_labels {
            let (lx, ly) = g.xy(c, scale.px_clamped(to.max(from)) - 3.0);
            pen.text(
                lx,
                ly,
                &crate::geometry::format_number(v, None, data),
                &spec,
            );
        }
    }
}

// ── scatter and bubble ──────────────────────────────────────────────────────

fn scatter(pen: &Pen, model: &ChartModel, data: &PlotData, g: &Geo, p: &Plot, ms: &[&S]) {
    let Some(xs_scale) = g.x.as_ref() else {
        return;
    };
    let ys_scale = g.scale(p.secondary);
    let bubble = p.kind == ChartKind::Bubble;
    let max_size = ms
        .iter()
        .flat_map(|s| {
            data.sizes
                .get(s.gi)
                .and_then(|v| v.clone())
                .unwrap_or_default()
        })
        .filter(|v| v.is_finite())
        .map(f64::abs)
        .fold(0.0, f64::max);
    let max_r = g.plot.w.min(g.plot.h) * 0.125 * p.bubble_scale as f64 / 100.0;
    for s in ms {
        let xs = xs_of(data, s.gi);
        let ys = data.series.get(s.gi).cloned().unwrap_or_default();
        let pts: Vec<(f64, f64, usize)> = xs
            .iter()
            .zip(&ys)
            .enumerate()
            .filter(|(_, (x, y))| x.is_finite() && y.is_finite())
            .map(|(i, (x, y))| (xs_scale.px_clamped(*x), ys_scale.px_clamped(*y), i))
            .collect();
        if bubble {
            let sizes = data
                .sizes
                .get(s.gi)
                .and_then(|v| v.clone())
                .unwrap_or_default();
            for &(x, y, i) in &pts {
                let sz = sizes.get(i).copied().unwrap_or(f64::NAN);
                if !sz.is_finite() || sz <= 0.0 || max_size <= 0.0 {
                    continue;
                }
                let r = if p.bubble_size_is_width {
                    max_r * sz / max_size
                } else {
                    max_r * (sz / max_size).sqrt()
                };
                let fill = point_color(pen, model, s, i, data);
                pen.with_fx(point_fx(s, i), || {
                    pen.wedge(x, y, r, 0.0, 0.0, 360.0, &fill, None)
                });
            }
        } else {
            if line_visible(s) && pts.len() >= 2 {
                let line: Vec<(f64, f64)> = pts.iter().map(|p| (p.0, p.1)).collect();
                let line = if s.series.smooth { smooth(&line) } else { line };
                pen.with_fx(s.series.fx.as_deref(), || {
                    pen.line(
                        line,
                        &s.color,
                        line_width(s),
                        s.series.line.as_ref().and_then(|l| l.dash.as_deref()),
                    )
                });
            }
            if let Some((sym, size)) = marker_of(s) {
                let fill = s
                    .series
                    .marker
                    .as_ref()
                    .and_then(|m| m.fill.as_ref())
                    .map_or(s.color.clone(), |c| pen.theme.paint(c, &s.color.hex));
                for &(x, y, i) in &pts {
                    let f = if s.series.points.iter().any(|(pi, _)| *pi as usize == i) {
                        point_color(pen, model, s, i, data)
                    } else {
                        fill.clone()
                    };
                    extras::marker(pen, x, y, sym, size, &f, None);
                }
            }
        }
        // Data labels.
        if let Some(dl) = s
            .series
            .labels
            .as_ref()
            .or(p.labels.as_ref())
            .filter(|d| d.any())
        {
            let spec = TextSpec::of(
                &dl.style,
                &model.text,
                LABEL_PT,
                TextAnchor::Start,
                "dataLabel",
                &pen.theme,
            );
            let sizes = data
                .sizes
                .get(s.gi)
                .and_then(|v| v.clone())
                .unwrap_or_default();
            for &(x, y, i) in &pts {
                let text = extras::label_text(
                    dl,
                    &LabelParts {
                        value: ys[i],
                        category: "",
                        series: &series_name(model, data, s.gi),
                        percent: None,
                        bubble: sizes.get(i).copied(),
                        format: crate::cartesian::data_format(data, s.gi),
                    },
                    data,
                );
                let (dx, anchor) = if bubble {
                    (0.0, TextAnchor::Middle)
                } else {
                    (5.0, TextAnchor::Start)
                };
                pen.text(x + dx, y + spec.size * 0.35, &text, &spec.anchored(anchor));
            }
        }
        // Error bars (X and Y).
        for (k, eb) in s.series.error_bars.iter().enumerate() {
            let paint = pen
                .theme
                .paint_or(eb.line.as_ref().and_then(|l| l.color.as_ref()), || {
                    Paint::hex("#000000")
                });
            let custom = data.custom_errors.get(s.gi).and_then(|c| c.get(k));
            let base = if eb.along_x { &xs } else { &ys };
            for (i, e) in extras::error_ends(eb, base, custom).into_iter().enumerate() {
                let (Some((lo, hi)), Some(x), Some(y)) = (e, xs.get(i), ys.get(i)) else {
                    continue;
                };
                if !(x.is_finite() && y.is_finite()) {
                    continue;
                }
                if eb.along_x {
                    extras::error_bar(
                        pen,
                        ys_scale.px_clamped(*y),
                        xs_scale.px_clamped(lo),
                        xs_scale.px_clamped(hi),
                        true,
                        !eb.no_end_cap,
                        &paint,
                    );
                } else {
                    extras::error_bar(
                        pen,
                        xs_scale.px_clamped(*x),
                        ys_scale.px_clamped(lo),
                        ys_scale.px_clamped(hi),
                        false,
                        !eb.no_end_cap,
                        &paint,
                    );
                }
            }
        }
        // Trendlines in X value space.
        for t in &s.series.trendlines {
            let paint = trend_paint(pen, s, t);
            let dash = t
                .line
                .as_ref()
                .and_then(|l| l.dash.as_deref())
                .unwrap_or("sysDot");
            let width = t.line.as_ref().and_then(|l| l.width_pt).unwrap_or(1.5);
            if let TrendKind::MovingAverage(per) = t.kind {
                let mut pairs: Vec<(f64, f64)> =
                    xs.iter().copied().zip(ys.iter().copied()).collect();
                pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
                let (sx, sy): (Vec<f64>, Vec<f64>) = pairs.into_iter().unzip();
                let pts: Vec<(f64, f64)> = extras::moving_average(&sx, &sy, per)
                    .into_iter()
                    .map(|(x, y)| (xs_scale.px_clamped(x), ys_scale.px_clamped(y)))
                    .collect();
                pen.line(pts, &paint, width, Some(dash));
                continue;
            }
            let Some(f) = extras::fit(t, &xs, &ys) else {
                continue;
            };
            let finite: Vec<f64> = xs.iter().copied().filter(|x| x.is_finite()).collect();
            let lo = finite.iter().copied().fold(f64::INFINITY, f64::min) - t.backward;
            let hi = finite.iter().copied().fold(f64::NEG_INFINITY, f64::max) + t.forward;
            let line: Vec<(f64, f64)> = (0..=40)
                .map(|k| lo + (hi - lo) * k as f64 / 40.0)
                .map(|x| (x, (f.eval)(x)))
                .filter(|(_, y)| y.is_finite())
                .map(|(x, y)| (xs_scale.px_clamped(x), ys_scale.px_clamped(y)))
                .collect();
            if let Some(&(ex, ey)) = line.last() {
                extras::trend_label(
                    pen,
                    t,
                    &f,
                    ex,
                    ey,
                    &TextSpec::plain(LABEL_PT, TextAnchor::End, "dataLabel"),
                );
            }
            pen.line(line, &paint, width, Some(dash));
        }
    }
    let _ = text_width;
}
