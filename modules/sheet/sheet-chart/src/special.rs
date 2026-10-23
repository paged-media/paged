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

//! The Office 2016 chartEx kinds (treemap, funnel, histogram, pareto,
//! box & whisker), the surface chart drawn as a contour, and the honest
//! placeholder of a kind paged.sheet does not draw.
//!
//! HISTOGRAM (Excel's rules): automatic bins follow Scott's normal
//! reference rule (width `3.5·σ / n^⅓`) from the smallest value; bins are
//! closed on the right (`(a, b]`, the first `[a, b]`) unless set otherwise;
//! overflow and underflow bins collect the tails. By category, equal text
//! categories are summed. PARETO sorts the bins descending and adds the
//! cumulative percentage as a line on a secondary 0–100% axis.
//!
//! BOX & WHISKER: quartiles exclusive of the median by default
//! (QUARTILE.EXC's interpolation; inclusive is QUARTILE.INC's), whiskers to
//! the furthest points within 1.5 × IQR, points beyond as outliers, the mean
//! as an ×; one box per series in each distinct category.

use crate::cartesian::series_list;
use crate::colors::Paint;
use crate::frame::{self, Entry, Glyph, Rect};
use crate::geometry::{
    format_number, group_count, series_name, value_at, Pen, PlotData, TextAnchor, TextSpec,
    AXIS_STROKE, AXIS_STROKE_W, GRID_STROKE, LABEL_PT,
};
use crate::model::{
    Axis, ChartKind, ChartModel, Crosses, DataLabels, Grouping, LineStyle, MarkerSymbol, Plot,
    Series,
};
use crate::scale::Scale;

// ── hierarchy (treemap, sunburst) ───────────────────────────────────────────

pub(crate) struct Node {
    pub label: String,
    pub value: f64,
    pub children: Vec<usize>,
}

pub(crate) struct Tree {
    pub nodes: Vec<Node>,
    pub roots: Vec<usize>,
}

impl Tree {
    /// The hierarchy of series `gi`'s points over the category levels; a
    /// blank label repeats the one above it (how a sheet lays a hierarchy
    /// out), and a point whose deeper levels are blank is a leaf above them.
    pub fn build(data: &PlotData, gi: usize) -> Tree {
        let n = group_count(data);
        let levels: Vec<Vec<String>> = if data.category_levels.is_empty() {
            vec![data.categories.clone()]
        } else {
            data.category_levels.clone()
        };
        let mut tree = Tree {
            nodes: Vec::new(),
            roots: Vec::new(),
        };
        let mut last: Vec<String> = vec![String::new(); levels.len()];
        for i in 0..n {
            let v = value_at(data, gi, i);
            let v = if v.is_finite() { v.max(0.0) } else { 0.0 };
            // The path of this point.
            let mut path: Vec<String> = Vec::new();
            let mut fresh = false;
            for (k, lv) in levels.iter().enumerate() {
                let l = lv.get(i).cloned().unwrap_or_default();
                if !l.is_empty() {
                    fresh = true;
                    last[k] = l.clone();
                    for x in last.iter_mut().skip(k + 1) {
                        x.clear();
                    }
                    path.push(l);
                } else if !fresh && !last[k].is_empty() {
                    path.push(last[k].clone());
                } else {
                    break;
                }
            }
            if path.is_empty() {
                path.push((i + 1).to_string());
            }
            // Walk / create.
            let mut parent: Option<usize> = None;
            for label in path {
                let siblings = match parent {
                    Some(p) => tree.nodes[p].children.clone(),
                    None => tree.roots.clone(),
                };
                let found = siblings.into_iter().find(|&s| tree.nodes[s].label == label);
                let id = match found {
                    Some(id) => id,
                    None => {
                        tree.nodes.push(Node {
                            label,
                            value: 0.0,
                            children: Vec::new(),
                        });
                        let id = tree.nodes.len() - 1;
                        match parent {
                            Some(p) => tree.nodes[p].children.push(id),
                            None => tree.roots.push(id),
                        }
                        id
                    }
                };
                tree.nodes[id].value += v;
                parent = Some(id);
            }
        }
        tree
    }

    pub fn depth(&self) -> usize {
        fn d(t: &Tree, n: usize) -> usize {
            1 + t.nodes[n]
                .children
                .iter()
                .map(|&c| d(t, c))
                .max()
                .unwrap_or(0)
        }
        self.roots.iter().map(|&r| d(self, r)).max().unwrap_or(0)
    }
}

/// Squarified treemap layout of `values` (descending) into `r`.
fn squarify(values: &[(usize, f64)], r: Rect) -> Vec<(usize, Rect)> {
    let total: f64 = values.iter().map(|v| v.1).sum();
    if total <= 0.0 || !r.ok() {
        return Vec::new();
    }
    let scale = r.w * r.h / total;
    let mut items: Vec<(usize, f64)> = values.iter().map(|&(i, v)| (i, v * scale)).collect();
    items.retain(|v| v.1 > 0.0);
    let mut out = Vec::new();
    let mut rest = r;
    let mut row: Vec<(usize, f64)> = Vec::new();
    let worst = |row: &[(usize, f64)], side: f64| {
        let s: f64 = row.iter().map(|v| v.1).sum();
        let max = row.iter().map(|v| v.1).fold(0.0, f64::max);
        let min = row.iter().map(|v| v.1).fold(f64::INFINITY, f64::min);
        ((side * side * max) / (s * s)).max((s * s) / (side * side * min))
    };
    let mut i = 0;
    while i < items.len() {
        let side = rest.w.min(rest.h);
        let mut cand = row.clone();
        cand.push(items[i]);
        if row.is_empty() || worst(&cand, side) <= worst(&row, side) {
            row = cand;
            i += 1;
        } else {
            rest = lay_row(&row, rest, &mut out);
            row.clear();
        }
    }
    if !row.is_empty() {
        lay_row(&row, rest, &mut out);
    }
    out
}

fn lay_row(row: &[(usize, f64)], r: Rect, out: &mut Vec<(usize, Rect)>) -> Rect {
    let s: f64 = row.iter().map(|v| v.1).sum();
    if r.w >= r.h {
        let w = s / r.h;
        let mut y = r.y;
        for &(i, a) in row {
            let h = a / w;
            out.push((i, Rect { x: r.x, y, w, h }));
            y += h;
        }
        Rect {
            x: r.x + w,
            y: r.y,
            w: (r.w - w).max(0.0),
            h: r.h,
        }
    } else {
        let h = s / r.w;
        let mut x = r.x;
        for &(i, a) in row {
            let w = a / h;
            out.push((i, Rect { x, y: r.y, w, h }));
            x += w;
        }
        Rect {
            x: r.x,
            y: r.y + h,
            w: r.w,
            h: (r.h - h).max(0.0),
        }
    }
}

pub(crate) fn treemap(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let list = series_list(pen, model);
    let Some(s) = list.first() else {
        frame::frame(pen, model, &[]);
        return;
    };
    let tree = Tree::build(data, s.gi);
    let n_roots = tree.roots.len();
    let ents: Vec<Entry> = tree
        .roots
        .iter()
        .enumerate()
        .map(|(k, &ni)| Entry {
            label: tree.nodes[ni].label.clone(),
            glyph: Glyph::Box(pen.theme.auto_color(k, n_roots, model.style)),
        })
        .collect();
    let area = frame::frame(pen, model, &ents);
    let spec = TextSpec {
        color: Some(Paint::hex("#FFFFFF")),
        ..TextSpec::plain(LABEL_PT, TextAnchor::Start, "dataLabel")
    };
    let banner_spec = TextSpec {
        bold: true,
        ..spec.clone()
    };
    let white = Paint::hex("#FFFFFF");
    let banners = model
        .plots
        .first()
        .and_then(|p| p.ex.parent_labels.as_deref())
        .is_none_or(|l| l == "banner");
    fn node_values(tree: &Tree, ids: &[usize]) -> Vec<(usize, f64)> {
        let mut v: Vec<(usize, f64)> = ids.iter().map(|&i| (i, tree.nodes[i].value)).collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1));
        v
    }
    let mut stack: Vec<(usize, Rect, Paint)> = Vec::new();
    for (k, (ni, r)) in squarify(&node_values(&tree, &tree.roots), area)
        .into_iter()
        .enumerate()
    {
        let order = tree.roots.iter().position(|&x| x == ni).unwrap_or(k);
        stack.push((ni, r, pen.theme.auto_color(order, n_roots, model.style)));
    }
    while let Some((ni, r, color)) = stack.pop() {
        let node = &tree.nodes[ni];
        if node.children.is_empty() {
            pen.rect(r.x, r.y, r.w, r.h, Some(&color), Some(&white), 1.0);
            let inner = r.inset(2.0, 0.0, 2.0, 0.0);
            if inner.w > spec.size && inner.h > spec.size {
                pen.text_in_box(
                    inner.x,
                    inner.y,
                    inner.w,
                    spec.size * 1.6,
                    &node.label,
                    &spec,
                );
            }
            continue;
        }
        let mut body = r;
        if banners && r.h > spec.size * 3.0 {
            let bh = spec.size * 1.5;
            pen.rect(
                r.x,
                r.y,
                r.w,
                bh,
                Some(&color.tinted(-0.2)),
                Some(&white),
                1.0,
            );
            pen.text(r.x + 3.0, r.y + bh - 3.0, &node.label, &banner_spec);
            body = r.inset(0.0, bh, 0.0, 0.0);
        }
        for (ch, cr) in squarify(&node_values(&tree, &node.children), body) {
            stack.push((ch, cr, color.clone()));
        }
    }
}

// ── funnel ──────────────────────────────────────────────────────────────────

pub(crate) fn funnel(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let list = series_list(pen, model);
    let ents: Vec<Entry> = list
        .iter()
        .map(|s| Entry {
            label: series_name(model, data, s.gi),
            glyph: Glyph::Box(s.color.clone()),
        })
        .collect();
    let area = frame::frame(pen, model, &ents);
    let Some(s) = list.first() else { return };
    let n = group_count(data);
    if n == 0 {
        return;
    }
    let tick = TextSpec::plain(LABEL_PT, TextAnchor::End, "tick");
    let label_w = data
        .categories
        .iter()
        .map(|c| tick.width(c))
        .fold(0.0, f64::max)
        .min(area.w * 0.3);
    let plot = area.inset(label_w + 6.0, 0.0, 0.0, 0.0);
    let max = (0..n)
        .map(|i| value_at(data, s.gi, i))
        .filter(|v| v.is_finite())
        .fold(0.0, f64::max);
    if max <= 0.0 || !plot.ok() {
        return;
    }
    let row = plot.h / n as f64;
    let bh = row / (1.0 + s.plot.gap_width.min(500) as f64 / 100.0 * 0.4);
    let spec = TextSpec {
        color: Some(Paint::hex("#FFFFFF")),
        ..TextSpec::plain(LABEL_PT, TextAnchor::Middle, "dataLabel")
    };
    for i in 0..n {
        let v = value_at(data, s.gi, i);
        let cy = plot.y + row * (i as f64 + 0.5);
        if let Some(c) = data.categories.get(i) {
            pen.text(plot.x - 4.0, cy + tick.size * 0.35, c, &tick);
        }
        if !v.is_finite() || v <= 0.0 {
            continue;
        }
        let w = plot.w * v / max;
        let fill = crate::cartesian::point_color(pen, model, s, i, data);
        pen.bar(plot.cx() - w / 2.0, cy - bh / 2.0, w, bh, &fill);
        pen.text(
            plot.cx(),
            cy + spec.size * 0.35,
            &format_number(v, None, data),
            &spec,
        );
    }
}

// ── histogram and pareto ────────────────────────────────────────────────────

/// The bins of a histogram: (label, count/sum).
pub(crate) fn bins(model: &ChartModel, data: &PlotData) -> Vec<(String, f64)> {
    let p = model.plots.first().cloned().unwrap_or_default();
    let b = &p.ex.bins;
    let gi = 0;
    let n = group_count(data);
    let text_cats = !data.categories.is_empty()
        && data
            .categories
            .iter()
            .any(|c| c.parse::<f64>().is_err() && !c.is_empty());
    if b.by_category || (text_cats && b.count.is_none() && b.width.is_none()) {
        let mut out: Vec<(String, f64)> = Vec::new();
        for i in 0..n {
            let label = data.categories.get(i).cloned().unwrap_or_default();
            let v = value_at(data, gi, i);
            let v = if v.is_finite() { v } else { 0.0 };
            match out.iter_mut().find(|(l, _)| *l == label) {
                Some(e) => e.1 += v,
                None => out.push((label, v)),
            }
        }
        return out;
    }
    let vals: Vec<f64> = (0..n)
        .map(|i| value_at(data, gi, i))
        .filter(|v| v.is_finite())
        .collect();
    if vals.is_empty() {
        return Vec::new();
    }
    let lo_all = vals.iter().copied().fold(f64::INFINITY, f64::min);
    let hi_all = vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let lo = b.underflow.unwrap_or(lo_all);
    let hi = b.overflow.unwrap_or(hi_all);
    let count_n = vals.len() as f64;
    let width = match (b.width, b.count) {
        (Some(w), _) if w > 0.0 => w,
        (_, Some(c)) if c > 0 => ((hi - lo) / c as f64).max(f64::MIN_POSITIVE),
        _ => {
            let mean = vals.iter().sum::<f64>() / count_n;
            let sd = (vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>()
                / (count_n - 1.0).max(1.0))
            .sqrt();
            let w = 3.5 * sd / count_n.cbrt();
            if w > 0.0 {
                w
            } else {
                1.0
            }
        }
    };
    let k = (((hi - lo) / width).ceil() as usize).clamp(1, 1000);
    let mut counts = vec![0.0; k];
    let (mut under, mut over) = (0.0, 0.0);
    for &v in &vals {
        if b.underflow.is_some() && (if b.closed_left { v < lo } else { v <= lo }) {
            under += 1.0;
            continue;
        }
        if b.overflow.is_some() && (if b.closed_left { v >= hi } else { v > hi }) {
            over += 1.0;
            continue;
        }
        let pos = (v - lo) / width;
        let idx = if b.closed_left {
            pos.floor()
        } else {
            (pos.ceil() - 1.0).max(0.0)
        };
        counts[(idx as usize).min(k - 1)] += 1.0;
    }
    // Bin edges as Excel shows them: two decimals at most.
    let f = |x: f64| format_number((x * 100.0).round() / 100.0, None, data);
    let mut out = Vec::new();
    if b.underflow.is_some() {
        out.push((format!("≤{}", f(lo)), under));
    }
    for (i, c) in counts.into_iter().enumerate() {
        let a = lo + width * i as f64;
        let z = a + width;
        let label = if b.closed_left {
            if i + 1 == k && b.overflow.is_none() {
                format!("[{}, {}]", f(a), f(z))
            } else {
                format!("[{}, {})", f(a), f(z))
            }
        } else if i == 0 && b.underflow.is_none() {
            format!("[{}, {}]", f(a), f(z))
        } else {
            format!("({}, {}]", f(a), f(z))
        };
        out.push((label, c));
    }
    if b.overflow.is_some() {
        out.push((format!(">{}", f(hi)), over));
    }
    out
}

pub(crate) fn histogram(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let mut bins = bins(model, data);
    let pareto = model.kind() == ChartKind::Pareto;
    if pareto {
        bins.sort_by(|a, b| b.1.total_cmp(&a.1));
    }
    let labels: Vec<String> = bins.iter().map(|b| b.0.clone()).collect();
    let counts: Vec<f64> = bins.iter().map(|b| b.1).collect();
    let base = model.plots.first().cloned().unwrap_or_default();
    let mut bar_series = base.series.first().cloned().unwrap_or_else(|| {
        Series::of(sheet_core::RangeRef {
            start: sheet_core::CellRef {
                sheet: 0,
                row: 0,
                col: 0,
                row_abs: false,
                col_abs: false,
            },
            end: sheet_core::CellRef {
                sheet: 0,
                row: 0,
                col: 0,
                row_abs: false,
                col_abs: false,
            },
        })
    });
    bar_series.trendlines.clear();
    bar_series.error_bars.clear();
    let mut plots = vec![Plot {
        kind: ChartKind::Column,
        grouping: Grouping::Standard,
        series: vec![bar_series.clone()],
        gap_width: if base.gap_width == 150 {
            0
        } else {
            base.gap_width
        },
        labels: base.labels.clone(),
        ..Plot::default()
    }];
    let mut series_data = vec![counts.clone()];
    let mut names = vec![data.names.first().cloned().flatten()];
    if pareto {
        let total: f64 = counts.iter().sum();
        let mut run = 0.0;
        let cum: Vec<f64> = counts
            .iter()
            .map(|c| {
                run += c;
                if total > 0.0 {
                    run / total
                } else {
                    0.0
                }
            })
            .collect();
        let mut line = bar_series.clone();
        line.fill = None;
        line.line = None;
        line.marker = Some(crate::model::Marker {
            symbol: MarkerSymbol::None,
            ..Default::default()
        });
        line.labels = None::<DataLabels>;
        line.index = Some(1);
        plots.push(Plot {
            kind: ChartKind::Line,
            secondary: true,
            series: vec![line],
            ..Plot::default()
        });
        series_data.push(cum);
        names.push(Some("Cumulative %".to_string()));
    }
    let synth = ChartModel {
        plots,
        sec_val_axis: pareto.then(|| Axis {
            min: Some(0.0),
            max: Some(1.0),
            format: Some("0%".into()),
            crosses: Crosses::Max,
            ..Axis::default()
        }),
        val_axis: Axis {
            major_gridlines: model
                .val_axis
                .major_gridlines
                .clone()
                .or(Some(LineStyle::default())),
            ..model.val_axis.clone()
        },
        ..model.clone()
    };
    let synth_data = PlotData {
        series: series_data,
        categories: labels,
        names,
        theme: data.theme,
        format_ctx: data.format_ctx,
        ..PlotData::default()
    };
    crate::cartesian::cartesian(pen, &synth, &synth_data);
}

// ── box and whisker ─────────────────────────────────────────────────────────

/// Quartile `q` (0.25 / 0.5 / 0.75) of sorted `v`, exclusive or inclusive.
fn quartile(v: &[f64], q: f64, inclusive: bool) -> f64 {
    let n = v.len();
    if n == 0 {
        return f64::NAN;
    }
    if n == 1 {
        return v[0];
    }
    let pos = if inclusive {
        q * (n as f64 - 1.0)
    } else {
        (q * (n as f64 + 1.0) - 1.0).clamp(0.0, n as f64 - 1.0)
    };
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    v[lo] + (v[hi] - v[lo]) * (pos - lo as f64)
}

pub(crate) struct BoxStats {
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub lo: f64,
    pub hi: f64,
    pub mean: f64,
    pub outliers: Vec<f64>,
    pub points: Vec<f64>,
}

pub(crate) fn box_stats(vals: &[f64], inclusive: bool) -> Option<BoxStats> {
    let mut v: Vec<f64> = vals.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let q1 = quartile(&v, 0.25, inclusive);
    let median = quartile(&v, 0.5, inclusive);
    let q3 = quartile(&v, 0.75, inclusive);
    let iqr = q3 - q1;
    let (fl, fh) = (q1 - 1.5 * iqr, q3 + 1.5 * iqr);
    let inside: Vec<f64> = v.iter().copied().filter(|x| *x >= fl && *x <= fh).collect();
    Some(BoxStats {
        q1,
        median,
        q3,
        lo: inside.first().copied().unwrap_or(q1),
        hi: inside.last().copied().unwrap_or(q3),
        mean: v.iter().sum::<f64>() / v.len() as f64,
        outliers: v.iter().copied().filter(|x| *x < fl || *x > fh).collect(),
        points: v,
    })
}

pub(crate) fn box_whisker(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let list = series_list(pen, model);
    let ents: Vec<Entry> = list
        .iter()
        .map(|s| Entry {
            label: series_name(model, data, s.gi),
            glyph: Glyph::Box(s.color.clone()),
        })
        .collect();
    let area = frame::frame(pen, model, &ents);
    let n = group_count(data);
    // Groups: distinct category labels in order (one group without labels).
    let mut groups: Vec<String> = Vec::new();
    let group_of: Vec<usize> = (0..n)
        .map(|i| {
            let l = data.categories.get(i).cloned().unwrap_or_default();
            match groups.iter().position(|g| *g == l) {
                Some(k) => k,
                None => {
                    groups.push(l);
                    groups.len() - 1
                }
            }
        })
        .collect();
    if groups.is_empty() {
        return;
    }
    let opts = model
        .plots
        .first()
        .map(|p| p.ex.box_whisker.clone())
        .unwrap_or_default();
    let stats: Vec<Vec<Option<BoxStats>>> = list
        .iter()
        .map(|s| {
            (0..groups.len())
                .map(|g| {
                    let vals: Vec<f64> = (0..n)
                        .filter(|i| group_of[*i] == g)
                        .map(|i| value_at(data, s.gi, i))
                        .collect();
                    box_stats(&vals, opts.inclusive)
                })
                .collect()
        })
        .collect();
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for st in stats.iter().flatten().flatten() {
        lo = lo.min(st.points[0]);
        hi = hi.max(*st.points.last().unwrap());
    }
    let tick = TextSpec::plain(LABEL_PT, TextAnchor::End, "tick");
    let sc = Scale::auto(lo, hi, &model.val_axis, false);
    let lw = sc
        .ticks()
        .iter()
        .map(|t| tick.width(&format_number(*t, model.val_axis.format.as_deref(), data)))
        .fold(0.0, f64::max);
    let plot = area.inset(lw + 6.0, 4.0, 4.0, LABEL_PT * 1.4);
    if !plot.ok() {
        return;
    }
    let sc = sc.on(plot.bottom(), plot.y);
    let grid = Paint::hex(GRID_STROKE);
    for t in sc.ticks() {
        let y = sc.px(t);
        pen.line(
            vec![(plot.x, y), (plot.right(), y)],
            &grid,
            AXIS_STROKE_W,
            None,
        );
        pen.text(
            plot.x - 4.0,
            y + tick.size * 0.35,
            &format_number(t, model.val_axis.format.as_deref(), data),
            &tick,
        );
    }
    pen.line(
        vec![(plot.x, plot.bottom()), (plot.right(), plot.bottom())],
        &Paint::hex(AXIS_STROKE),
        AXIS_STROKE_W,
        None,
    );
    let gw = plot.w / groups.len() as f64;
    let ns = list.len().max(1) as f64;
    let bw = gw / (ns + 1.0);
    let ctick = TextSpec::plain(LABEL_PT, TextAnchor::Middle, "tick");
    let edge = Paint::hex("#404040");
    for (g, label) in groups.iter().enumerate() {
        pen.text(
            plot.x + gw * (g as f64 + 0.5),
            plot.bottom() + ctick.size * 1.2,
            label,
            &ctick,
        );
    }
    for (k, s) in list.iter().enumerate() {
        let mut means: Vec<(f64, f64)> = Vec::new();
        for (g, st) in stats[k].iter().enumerate() {
            let Some(st) = st else { continue };
            let cx = plot.x + gw * g as f64 + bw * (k as f64 + 1.0);
            let (x0, x1) = (cx - bw * 0.4, cx + bw * 0.4);
            pen.line(
                vec![(cx, sc.px(st.hi)), (cx, sc.px(st.q3))],
                &edge,
                0.75,
                None,
            );
            pen.line(
                vec![(cx, sc.px(st.q1)), (cx, sc.px(st.lo))],
                &edge,
                0.75,
                None,
            );
            pen.line(
                vec![
                    (x0 + bw * 0.15, sc.px(st.hi)),
                    (x1 - bw * 0.15, sc.px(st.hi)),
                ],
                &edge,
                0.75,
                None,
            );
            pen.line(
                vec![
                    (x0 + bw * 0.15, sc.px(st.lo)),
                    (x1 - bw * 0.15, sc.px(st.lo)),
                ],
                &edge,
                0.75,
                None,
            );
            pen.rect(
                x0,
                sc.px(st.q3),
                x1 - x0,
                sc.px(st.q1) - sc.px(st.q3),
                Some(&s.color),
                Some(&edge),
                0.75,
            );
            pen.line(
                vec![(x0, sc.px(st.median)), (x1, sc.px(st.median))],
                &edge,
                1.0,
                None,
            );
            if opts.mean_marker {
                crate::extras::marker(pen, cx, sc.px(st.mean), MarkerSymbol::X, 5.0, &edge, None);
            }
            means.push((cx, sc.px(st.mean)));
            if opts.outliers {
                for o in &st.outliers {
                    crate::extras::marker(
                        pen,
                        cx,
                        sc.px(*o),
                        MarkerSymbol::Circle,
                        4.0,
                        &Paint::hex("#FFFFFF"),
                        Some(&s.color),
                    );
                }
            }
            if opts.inner_points {
                for v in st.points.iter().filter(|v| !st.outliers.contains(v)) {
                    crate::extras::marker(
                        pen,
                        cx,
                        sc.px(*v),
                        MarkerSymbol::Circle,
                        3.0,
                        &Paint::hex("#FFFFFF"),
                        Some(&s.color),
                    );
                }
            }
        }
        if opts.mean_line && means.len() >= 2 {
            pen.line(means, &s.color, 1.0, None);
        }
    }
}

// ── surface (as contour) ────────────────────────────────────────────────────

/// Clip a polygon with per-vertex values to `v >= t` (`keep_above`) or
/// `v < t`, interpolating the crossing points.
fn clip(poly: &[(f64, f64, f64)], t: f64, keep_above: bool) -> Vec<(f64, f64, f64)> {
    let inside = |p: &(f64, f64, f64)| if keep_above { p.2 >= t } else { p.2 < t };
    let mut out = Vec::new();
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let (ia, ib) = (inside(&a), inside(&b));
        if ia {
            out.push(a);
        }
        if ia != ib && (b.2 - a.2).abs() > 0.0 {
            let f = (t - a.2) / (b.2 - a.2);
            out.push((a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f, t));
        }
    }
    out
}

pub(crate) fn surface(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let n = group_count(data);
    let m = data.series.len();
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for v in data.series.iter().flatten() {
        if v.is_finite() {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
    }
    let sc = Scale::auto(lo, hi, &model.val_axis, false);
    let ticks = sc.ticks();
    let bands: Vec<(f64, f64)> = ticks.windows(2).map(|w| (w[0], w[1])).collect();
    let nb = bands.len().max(1);
    let colors: Vec<Paint> = (0..nb)
        .map(|i| pen.theme.auto_color(i, nb, model.style))
        .collect();
    let ents: Vec<Entry> = bands
        .iter()
        .enumerate()
        .map(|(i, (a, b))| Entry {
            label: format!(
                "{}-{}",
                format_number(*a, None, data),
                format_number(*b, None, data)
            ),
            glyph: Glyph::Box(colors[i].clone()),
        })
        .collect();
    let area = frame::frame(pen, model, &ents);
    let tick = TextSpec::plain(LABEL_PT, TextAnchor::End, "tick");
    let name_w = (0..m)
        .map(|j| tick.width(&series_name(model, data, j)))
        .fold(0.0, f64::max);
    let plot = area.inset(name_w.min(area.w * 0.3) + 6.0, 4.0, 4.0, LABEL_PT * 1.4);
    if n < 2 || m < 2 || !plot.ok() {
        if n >= 1 && m == 1 {
            // One series is a line of cells: draw it as bands across.
        }
        return;
    }
    let px = |i: f64| plot.x + plot.w * i / (n - 1) as f64;
    let py = |j: f64| plot.bottom() - plot.h * j / (m - 1) as f64;
    let z = |i: usize, j: usize| {
        let v = value_at(data, j, i);
        if v.is_finite() {
            v
        } else {
            sc.min
        }
    };
    for j in 0..m - 1 {
        for i in 0..n - 1 {
            let quad = [
                (px(i as f64), py(j as f64), z(i, j)),
                (px(i as f64 + 1.0), py(j as f64), z(i + 1, j)),
                (px(i as f64 + 1.0), py(j as f64 + 1.0), z(i + 1, j + 1)),
                (px(i as f64), py(j as f64 + 1.0), z(i, j + 1)),
            ];
            for tri in [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]] {
                for (b, (a0, a1)) in bands.iter().enumerate() {
                    let last = b + 1 == nb;
                    let p = clip(&tri, *a0, true);
                    let p = if last { p } else { clip(&p, *a1, false) };
                    if p.len() >= 3 {
                        pen.poly(
                            p.iter().map(|q| (q.0, q.1)).collect(),
                            Some(&colors[b]),
                            None,
                            0.0,
                        );
                    }
                }
            }
        }
    }
    let ctick = TextSpec::plain(LABEL_PT, TextAnchor::Middle, "tick");
    for i in 0..n {
        if let Some(c) = data.categories.get(i) {
            pen.text(px(i as f64), plot.bottom() + ctick.size * 1.2, c, &ctick);
        }
    }
    for j in 0..m {
        pen.text(
            plot.x - 4.0,
            py(j as f64) + tick.size * 0.35,
            &series_name(model, data, j),
            &tick,
        );
    }
}

// ── placeholder ─────────────────────────────────────────────────────────────

/// A kind paged.sheet does not draw: a dashed frame naming it, never a
/// different chart.
pub(crate) fn placeholder(pen: &Pen, model: &ChartModel) {
    let r = Rect {
        x: frame::PAD,
        y: frame::PAD,
        w: pen.w - 2.0 * frame::PAD,
        h: pen.h - 2.0 * frame::PAD,
    };
    if !r.ok() {
        return;
    }
    let grey = Paint::hex("#A6A6A6");
    pen.line(
        vec![
            (r.x, r.y),
            (r.right(), r.y),
            (r.right(), r.bottom()),
            (r.x, r.bottom()),
            (r.x, r.y),
        ],
        &grey,
        0.75,
        Some("dash"),
    );
    let what = model
        .source
        .as_deref()
        .map(|s| s.trim_start_matches("cx:").to_string())
        .unwrap_or_else(|| "chart".into());
    let title = model.title.as_deref().unwrap_or("");
    let spec = TextSpec {
        color: Some(Paint::hex("#595959")),
        ..TextSpec::plain(LABEL_PT + 1.0, TextAnchor::Middle, "note")
    };
    if !title.is_empty() {
        pen.text(
            r.cx(),
            r.cy() - spec.size,
            title,
            &TextSpec {
                bold: true,
                ..spec.clone()
            },
        );
    }
    pen.text(
        r.cx(),
        r.cy() + spec.size * 0.5,
        &format!("A {what} chart: not drawn by Paged"),
        &spec,
    );
}
