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

//! The radial kinds: pie, doughnut (one ring per series), pie-of-pie and
//! bar-of-pie, radar (outlined, with markers, or filled) and sunburst.
//! Angles run clockwise from 12 o'clock (the [`crate::Primitive::Wedge`]
//! convention), starting at the plot's first-slice angle.
//!
//! RULING (`sheet.chart.kinds.pie-series`): a PIE draws its first series
//! only, as Excel does; the other series stay in the model (and in the file)
//! and draw when the chart becomes a doughnut, where each series is a ring.

use crate::cartesian::{marker_of, point_color, series_list, S};
use crate::colors::Paint;
use crate::extras::{self, LabelParts};
use crate::frame::{self, Entry, Glyph, Rect};
use crate::geometry::{
    format_number, group_count, series_name, value_at, Pen, PlotData, TextAnchor, TextSpec,
    AXIS_STROKE, AXIS_STROKE_W, LABEL_PT, SERIES_STROKE_W,
};
use crate::model::{ChartKind, ChartModel, LabelPosition, SplitType};
use crate::scale::Scale;

fn slice_entries(pen: &Pen, model: &ChartModel, data: &PlotData, s: &S) -> Vec<Entry> {
    let n = group_count(data);
    (0..n)
        .map(|i| Entry {
            label: data
                .categories
                .get(i)
                .cloned()
                .unwrap_or_else(|| (i + 1).to_string()),
            glyph: Glyph::Box(slice_color(pen, model, s, i, n)),
        })
        .collect()
}

/// A slice's colour: its `c:dPt`, else the varied automatic colour (pies
/// vary by point unless `varyColors` is off).
fn slice_color(pen: &Pen, model: &ChartModel, s: &S, i: usize, n: usize) -> Paint {
    if let Some((_, c)) = s.series.points.iter().find(|(p, _)| *p as usize == i) {
        return pen.theme.paint(c, &s.color.hex);
    }
    if s.plot.vary_colors || model.series_count() == 1 {
        pen.theme.auto_color(i, n.max(1), model.style)
    } else {
        s.color.clone()
    }
}

fn plot_is_pie(s: &S) -> bool {
    s.plot.kind != ChartKind::Donut
}

pub(crate) fn pies(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let list = series_list(pen, model);
    let Some(first) = list.first() else {
        frame::frame(pen, model, &[]);
        return;
    };
    // Slices vary by point: the legend names the categories; rings in
    // one colour each name the series.
    let ents = if first.plot.vary_colors || list.len() == 1 || plot_is_pie(first) {
        slice_entries(pen, model, data, first)
    } else {
        list.iter()
            .map(|s| Entry {
                label: series_name(model, data, s.gi),
                glyph: Glyph::Box(s.color.clone()),
            })
            .collect()
    };
    let area = frame::frame(pen, model, &ents);
    if !area.ok() {
        return;
    }
    let plot = first.plot;
    let edge = Paint::hex("#FFFFFF");
    match plot.kind {
        ChartKind::PieOfPie | ChartKind::BarOfPie => of_pie(pen, model, data, first, area),
        ChartKind::Donut => {
            let r = area.w.min(area.h) / 2.0 * 0.92;
            let hole = r * plot.hole_size.clamp(10, 90) as f64 / 100.0;
            let rings = list.len().max(1);
            let ring_w = (r - hole) / rings as f64;
            for (k, s) in list.iter().enumerate() {
                let inner = hole + ring_w * k as f64;
                ring(
                    pen,
                    model,
                    data,
                    s,
                    area.cx(),
                    area.cy(),
                    inner + ring_w,
                    inner,
                    plot.first_slice_angle as f64,
                    &edge,
                );
            }
        }
        _ => {
            let r = area.w.min(area.h) / 2.0 * 0.9;
            ring(
                pen,
                model,
                data,
                first,
                area.cx(),
                area.cy(),
                r,
                0.0,
                plot.first_slice_angle as f64,
                &edge,
            );
        }
    }
}

/// One series as slices (inner 0) or a ring.
#[allow(clippy::too_many_arguments)]
fn ring(
    pen: &Pen,
    model: &ChartModel,
    data: &PlotData,
    s: &S,
    cx: f64,
    cy: f64,
    r: f64,
    inner: f64,
    start: f64,
    edge: &Paint,
) {
    let n = group_count(data);
    let vals: Vec<f64> = (0..n).map(|i| value_at(data, s.gi, i)).collect();
    let total: f64 = vals.iter().filter(|v| v.is_finite()).map(|v| v.abs()).sum();
    if total <= 0.0 {
        return;
    }
    let explode = s.series.explosion as f64 / 100.0 * r;
    let mut acc = start;
    let dl = s
        .series
        .labels
        .as_ref()
        .or(s.plot.labels.as_ref())
        .filter(|d| d.any());
    for (i, v) in vals.iter().enumerate() {
        if !v.is_finite() || *v == 0.0 {
            continue;
        }
        let sweep = v.abs() / total * 360.0;
        let (a0, a1) = (acc, acc + sweep);
        acc = a1;
        let mid = ((a0 + a1) / 2.0).to_radians();
        let (ox, oy) = (explode * mid.sin(), -explode * mid.cos());
        let fill = slice_color(pen, model, s, i, n);
        pen.wedge(cx + ox, cy + oy, r, inner, a0, a1, &fill, Some(edge));
        if let Some(dl) = dl {
            let spec = TextSpec::of(
                &dl.style,
                &model.text,
                LABEL_PT,
                TextAnchor::Middle,
                "dataLabel",
                &pen.theme,
            );
            let text = extras::label_text(
                dl,
                &LabelParts {
                    value: *v,
                    category: data.categories.get(i).map_or("", String::as_str),
                    series: &series_name(model, data, s.gi),
                    percent: Some(v.abs() / total),
                    bubble: None,
                    format: crate::cartesian::data_format(data, s.gi),
                },
                data,
            );
            let outside = matches!(dl.position, Some(LabelPosition::OutsideEnd));
            let rr = if outside {
                r + spec.size
            } else if matches!(dl.position, Some(LabelPosition::InsideBase)) && inner > 0.0 {
                inner + spec.size
            } else if inner > 0.0 {
                (r + inner) / 2.0
            } else {
                r * 0.65
            };
            let (lx, ly) = (cx + ox + rr * mid.sin(), cy + oy - rr * mid.cos());
            let anchor = if outside {
                if mid.sin() > 0.1 {
                    TextAnchor::Start
                } else if mid.sin() < -0.1 {
                    TextAnchor::End
                } else {
                    TextAnchor::Middle
                }
            } else {
                TextAnchor::Middle
            };
            pen.text(lx, ly + spec.size * 0.35, &text, &spec.anchored(anchor));
        }
    }
}

/// Pie-of-pie / bar-of-pie: the split points leave the main pie as one
/// "Other" slice and are drawn again in a second pie or a stacked bar,
/// joined to it by series lines.
fn of_pie(pen: &Pen, model: &ChartModel, data: &PlotData, s: &S, area: Rect) {
    let n = group_count(data);
    let vals: Vec<f64> = (0..n)
        .map(|i| value_at(data, s.gi, i))
        .map(|v| if v.is_finite() { v.abs() } else { 0.0 })
        .collect();
    let total: f64 = vals.iter().sum();
    if total <= 0.0 || n == 0 {
        return;
    }
    let op = &s.plot.of_pie;
    let in_second: Vec<bool> = (0..n)
        .map(|i| match op.split {
            SplitType::Position => {
                let k = op
                    .split_pos
                    .map_or(((n as f64) / 3.0).round().max(1.0), |p| p.max(0.0))
                    as usize;
                i + k >= n
            }
            SplitType::Value => vals[i] < op.split_pos.unwrap_or(0.0),
            SplitType::Percent => vals[i] / total * 100.0 < op.split_pos.unwrap_or(10.0),
            SplitType::Custom => op.custom.contains(&(i as u32)),
        })
        .collect();
    let other: f64 = (0..n).filter(|i| in_second[*i]).map(|i| vals[i]).sum();
    let size = op.second_size.clamp(5, 200) as f64 / 100.0;
    // Both plots side by side with a gap between them.
    let r1 = (area.w * 0.8 / (2.0 + 2.0 * size + 0.6)).min(area.h / 2.0 * 0.9);
    let (cx1, cy) = (area.x + area.w * 0.1 + r1, area.cy());
    let edge = Paint::hex("#FFFFFF");
    // The main pie: kept slices, then "Other" centred on the right (3 o'clock).
    let other_sweep = other / total * 360.0;
    let mut acc = 90.0 + other_sweep / 2.0;
    for i in 0..n {
        if in_second[i] || vals[i] == 0.0 {
            continue;
        }
        let sweep = vals[i] / total * 360.0;
        let fill = slice_color(pen, model, s, i, n);
        pen.wedge(cx1, cy, r1, 0.0, acc, acc + sweep, &fill, Some(&edge));
        acc += sweep;
    }
    let other_fill = pen.theme.auto_color(n, n + 1, model.style);
    if other > 0.0 {
        pen.wedge(
            cx1,
            cy,
            r1,
            0.0,
            90.0 - other_sweep / 2.0,
            90.0 + other_sweep / 2.0,
            &other_fill,
            Some(&edge),
        );
    }
    let line = Paint::hex("#808080");
    let a = (90.0 - other_sweep / 2.0).to_radians();
    let b = (90.0 + other_sweep / 2.0).to_radians();
    let top1 = (cx1 + r1 * a.sin(), cy - r1 * a.cos());
    let bot1 = (cx1 + r1 * b.sin(), cy - r1 * b.cos());
    let cx2 = cx1 + r1 * (1.6 + size);
    if s.plot.kind == ChartKind::PieOfPie {
        let r2 = r1 * size;
        // The second pie starts at 12 o'clock.
        let mut acc = 0.0;
        let others: Vec<usize> = (0..n).filter(|i| in_second[*i]).collect();
        let sub_total = other.max(f64::MIN_POSITIVE);
        for &i in &others {
            let sweep = vals[i] / sub_total * 360.0;
            let fill = slice_color(pen, model, s, i, n);
            pen.wedge(cx2, cy, r2, 0.0, acc, acc + sweep, &fill, Some(&edge));
            acc += sweep;
        }
        pen.line(vec![top1, (cx2, cy - r2)], &line, 0.75, None);
        pen.line(vec![bot1, (cx2, cy + r2)], &line, 0.75, None);
    } else {
        let bh = r1 * 2.0 * size;
        let bw = bh * 0.25;
        let bx = cx2 - bw / 2.0;
        let mut y = cy - bh / 2.0;
        for i in (0..n).filter(|i| in_second[*i]) {
            let h = vals[i] / other.max(f64::MIN_POSITIVE) * bh;
            let fill = slice_color(pen, model, s, i, n);
            pen.rect(bx, y, bw, h, Some(&fill), Some(&edge), 0.75);
            y += h;
        }
        pen.line(vec![top1, (bx, cy - bh / 2.0)], &line, 0.75, None);
        pen.line(vec![bot1, (bx, cy + bh / 2.0)], &line, 0.75, None);
    }
    let _ = format_number;
}

/// Radar: a polar grid, one spoke per category, an outline (or filled
/// polygon) per series, markers for a marker radar.
pub(crate) fn radar(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let list = series_list(pen, model);
    let ents: Vec<Entry> = list
        .iter()
        .map(|s| Entry {
            label: series_name(model, data, s.gi),
            glyph: if s.plot.kind == ChartKind::FilledRadar {
                Glyph::Box(s.color.clone())
            } else {
                Glyph::Line(
                    s.color.clone(),
                    marker_of(s).map(|(m, _)| (m, s.color.clone())),
                )
            },
        })
        .collect();
    let area = frame::frame(pen, model, &ents);
    let n = group_count(data);
    let label_gap = LABEL_PT * 1.2;
    let r = (area.w.min(area.h) / 2.0 - label_gap - 4.0).max(0.0);
    if n < 3 || r <= 0.0 {
        return;
    }
    let (cx, cy) = (area.cx(), area.cy());
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for v in data.series.iter().flatten() {
        if v.is_finite() {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
    }
    let scale = Scale::auto(lo, hi, &model.val_axis, false).on(0.0, r);
    let at = |i: usize, rad: f64| {
        let a = (i as f64 * 360.0 / n as f64).to_radians();
        (cx + rad * a.sin(), cy - rad * a.cos())
    };
    let grid = Paint::hex(AXIS_STROKE);
    for t in scale.ticks().into_iter().skip(1) {
        let rad = scale.px(t);
        let mut pts: Vec<(f64, f64)> = (0..n).map(|i| at(i, rad)).collect();
        pts.push(pts[0]);
        pen.line(pts, &grid, AXIS_STROKE_W, None);
    }
    for i in 0..n {
        pen.line(vec![(cx, cy), at(i, r)], &grid, AXIS_STROKE_W, None);
    }
    let tick = TextSpec::of(
        &model.val_axis.labels,
        &model.text,
        LABEL_PT,
        TextAnchor::End,
        "tick",
        &pen.theme,
    );
    if !model.val_axis.deleted {
        for t in scale.ticks() {
            pen.text(
                cx - 3.0,
                cy - scale.px(t) + tick.size * 0.35,
                &format_number(t, model.val_axis.format.as_deref(), data),
                &tick,
            );
        }
    }
    let ctick = TextSpec::of(
        &model.cat_axis.labels,
        &model.text,
        LABEL_PT,
        TextAnchor::Middle,
        "tick",
        &pen.theme,
    );
    for i in 0..n {
        let label = data
            .categories
            .get(i)
            .cloned()
            .unwrap_or_else(|| (i + 1).to_string());
        let (lx, ly) = at(i, r + label_gap * 0.8);
        pen.text(lx, ly + ctick.size * 0.35, &label, &ctick);
    }
    for s in &list {
        let mut pts: Vec<(f64, f64)> = (0..n)
            .map(|i| {
                let v = value_at(data, s.gi, i);
                at(
                    i,
                    scale.px_clamped(if v.is_finite() { v } else { scale.min }),
                )
            })
            .collect();
        if s.plot.kind == ChartKind::FilledRadar {
            pen.poly(pts.clone(), Some(&s.color), None, 0.0);
            continue;
        }
        pts.push(pts[0]);
        pen.line(pts.clone(), &s.color, SERIES_STROKE_W, None);
        if let Some((sym, size)) = marker_of(s) {
            for p in pts.iter().take(n) {
                extras::marker(pen, p.0, p.1, sym, size, &s.color, None);
            }
        }
    }
    let _ = point_color;
}

/// Sunburst: rings by hierarchy level (the outermost category level at the
/// centre), each node's angle its share of the values beneath it, every
/// branch in its top-level node's colour, lighter going out.
pub(crate) fn sunburst(pen: &Pen, model: &ChartModel, data: &PlotData) {
    let list = series_list(pen, model);
    let Some(s) = list.first() else {
        frame::frame(pen, model, &[]);
        return;
    };
    let tree = crate::special::Tree::build(data, s.gi);
    let ents: Vec<Entry> = tree
        .roots
        .iter()
        .enumerate()
        .map(|(k, &ni)| Entry {
            label: tree.nodes[ni].label.clone(),
            glyph: Glyph::Box(pen.theme.auto_color(k, tree.roots.len(), model.style)),
        })
        .collect();
    let area = frame::frame(pen, model, &ents);
    let depth = tree.depth().max(1);
    let r = area.w.min(area.h) / 2.0 * 0.95;
    let hole = r * 0.15;
    let ring_w = (r - hole) / depth as f64;
    let total: f64 = tree.roots.iter().map(|&n| tree.nodes[n].value).sum();
    if total <= 0.0 {
        return;
    }
    let edge = Paint::hex("#FFFFFF");
    let spec = TextSpec::plain(LABEL_PT * 0.9, TextAnchor::Middle, "dataLabel");
    let mut stack: Vec<(usize, f64, f64, usize, Paint)> = Vec::new();
    let mut acc = 0.0;
    for (k, &ni) in tree.roots.iter().enumerate() {
        let sweep = tree.nodes[ni].value / total * 360.0;
        stack.push((
            ni,
            acc,
            acc + sweep,
            0,
            pen.theme.auto_color(k, tree.roots.len(), model.style),
        ));
        acc += sweep;
    }
    while let Some((ni, a0, a1, level, color)) = stack.pop() {
        let inner = hole + ring_w * level as f64;
        let fill = if level == 0 {
            color.clone()
        } else {
            color.tinted(0.15 * level as f64)
        };
        pen.wedge(
            area.cx(),
            area.cy(),
            inner + ring_w,
            inner,
            a0,
            a1,
            &fill,
            Some(&edge),
        );
        let mid = ((a0 + a1) / 2.0).to_radians();
        let rr = inner + ring_w / 2.0;
        let arc = (a1 - a0).to_radians() * rr;
        let label = &tree.nodes[ni].label;
        if arc > spec.width(label).min(ring_w) {
            pen.text(
                area.cx() + rr * mid.sin(),
                area.cy() - rr * mid.cos() + spec.size * 0.35,
                label,
                &spec,
            );
        }
        let node = &tree.nodes[ni];
        if node.value > 0.0 {
            let mut c = a0;
            for &ch in &node.children {
                let sweep = tree.nodes[ch].value / node.value * (a1 - a0);
                stack.push((ch, c, c + sweep, level + 1, color.clone()));
                c += sweep;
            }
        }
    }
}
