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

//! Sparklines (`x14:sparklineGroup`): a line, column or win/loss chart in
//! one cell, as the same primitives a chart is drawn with, in the cell's
//! own pt box (origin its top-left). Excel's rules: a 1 pt inset; the
//! vertical extent is the sparkline's own data (or the group's fixed
//! bounds); columns grow from zero when zero is in range, else from the
//! bottom; win/loss draws every positive value up and every negative down
//! at the same height; the markers mark points (all, first, last, high,
//! low, negative) in their own colours.

use crate::colors::{Paint, Theme, OFFICE_THEME};
use crate::geometry::Primitive;
use crate::model::{Blanks, SparklineGroup, SparklineKind};

const INSET: f64 = 1.5;

/// The primitives of one sparkline over `values` in a `w × h` box.
pub fn sparkline(
    g: &SparklineGroup,
    values: &[f64],
    w: f64,
    h: f64,
    theme: Option<[u32; 12]>,
) -> Vec<Primitive> {
    let theme = Theme {
        colors: theme.unwrap_or(OFFICE_THEME),
    };
    let mut out = Vec::new();
    let n = values.len();
    if n == 0 || w <= 2.0 * INSET || h <= 2.0 * INSET {
        return out;
    }
    let vals: Vec<f64> = values
        .iter()
        .map(|v| match (v.is_finite(), g.blanks) {
            (true, _) => *v,
            (false, Blanks::Zero) => 0.0,
            _ => f64::NAN,
        })
        .collect();
    let finite: Vec<f64> = vals.iter().copied().filter(|v| v.is_finite()).collect();
    if finite.is_empty() {
        return out;
    }
    let lo = g
        .min
        .unwrap_or_else(|| finite.iter().copied().fold(f64::INFINITY, f64::min));
    let hi = g
        .max
        .unwrap_or_else(|| finite.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    let series = theme.paint(&g.series, "#376092");
    let neg = g.negative.as_ref().map(|c| theme.paint(c, "#D00000"));
    let x_of = |i: usize| {
        let i = if g.right_to_left { n - 1 - i } else { i };
        match g.kind {
            SparklineKind::Line => {
                if n == 1 {
                    w / 2.0
                } else {
                    INSET + (w - 2.0 * INSET) * i as f64 / (n - 1) as f64
                }
            }
            _ => INSET + (w - 2.0 * INSET) * (i as f64 + 0.5) / n as f64,
        }
    };
    let (top, bottom) = (INSET, h - INSET);
    let y_of = |v: f64| {
        if hi == lo {
            (top + bottom) / 2.0
        } else {
            bottom - (bottom - top) * (v - lo) / (hi - lo)
        }
    };
    let rect = |out: &mut Vec<Primitive>, x: f64, y0: f64, y1: f64, bw: f64, p: &Paint| {
        out.push(Primitive::Rect {
            x: x - bw / 2.0,
            y: y0.min(y1),
            w: bw,
            h: (y1 - y0).abs().max(0.5),
            fill: Some(p.hex.clone()),
            stroke: None,
            stroke_w: 0.0,
            fill_swatch_ref: p.swatch.clone(),
            stroke_swatch_ref: None,
            fx: None,
        });
    };
    let bw = (w - 2.0 * INSET) / n as f64 * 0.8;
    match g.kind {
        SparklineKind::Line => {
            let mut run: Vec<(f64, f64)> = Vec::new();
            let flush = |run: &mut Vec<(f64, f64)>, out: &mut Vec<Primitive>| {
                if run.len() >= 2 {
                    out.push(Primitive::Line {
                        pts: std::mem::take(run),
                        stroke: series.hex.clone(),
                        stroke_w: g.line_weight,
                        stroke_swatch_ref: series.swatch.clone(),
                        dash: None,
                        fx: None,
                    });
                }
                run.clear();
            };
            for (i, v) in vals.iter().enumerate() {
                if v.is_finite() {
                    run.push((x_of(i), y_of(*v)));
                } else if g.blanks != Blanks::Span {
                    flush(&mut run, &mut out);
                }
            }
            flush(&mut run, &mut out);
        }
        SparklineKind::Column => {
            let base = if lo <= 0.0 && hi >= 0.0 {
                y_of(0.0)
            } else if hi < 0.0 {
                top
            } else {
                bottom
            };
            for (i, v) in vals.iter().enumerate() {
                if v.is_finite() {
                    let p = if *v < 0.0 && g.show_negative {
                        neg.as_ref().unwrap_or(&series)
                    } else {
                        &series
                    };
                    rect(&mut out, x_of(i), base, y_of(*v), bw, p);
                }
            }
        }
        SparklineKind::WinLoss => {
            let mid = (top + bottom) / 2.0;
            for (i, v) in vals.iter().enumerate() {
                if !v.is_finite() || *v == 0.0 {
                    continue;
                }
                let p = if *v < 0.0 {
                    neg.as_ref().unwrap_or(&series)
                } else {
                    &series
                };
                let end = if *v > 0.0 { top } else { bottom };
                rect(&mut out, x_of(i), mid, end, bw, p);
            }
        }
    }
    if g.show_axis && lo < 0.0 && hi > 0.0 && g.kind != SparklineKind::WinLoss {
        let ax = g
            .axis
            .as_ref()
            .map_or(Paint::hex("#000000"), |c| theme.paint(c, "#000000"));
        out.push(Primitive::Line {
            pts: vec![(INSET, y_of(0.0)), (w - INSET, y_of(0.0))],
            stroke: ax.hex,
            stroke_w: 0.5,
            stroke_swatch_ref: ax.swatch,
            dash: None,
            fx: None,
        });
    }
    // Point highlights: the markers of a line, the coloured bars of a column.
    let idx_hi = (0..n)
        .filter(|i| vals[*i].is_finite())
        .max_by(|a, b| vals[*a].total_cmp(&vals[*b]));
    let idx_lo = (0..n)
        .filter(|i| vals[*i].is_finite())
        .min_by(|a, b| vals[*a].total_cmp(&vals[*b]));
    let first = (0..n).find(|i| vals[*i].is_finite());
    let last = (0..n).rev().find(|i| vals[*i].is_finite());
    let mut marks: Vec<(usize, Paint)> = Vec::new();
    let pick = |c: &Option<crate::model::ColorRef>, d: &str| {
        c.as_ref().map_or(Paint::hex(d), |c| theme.paint(c, d))
    };
    if g.kind == SparklineKind::Line && g.show_markers {
        let p = pick(&g.markers, &series.hex);
        for (i, v) in vals.iter().enumerate() {
            if v.is_finite() {
                marks.push((i, p.clone()));
            }
        }
    }
    if g.show_negative && g.kind == SparklineKind::Line {
        let p = pick(&g.negative, "#D00000");
        for (i, v) in vals.iter().enumerate() {
            if *v < 0.0 {
                marks.push((i, p.clone()));
            }
        }
    }
    for (show, idx, c, d) in [
        (g.show_high, idx_hi, &g.high, "#D00000"),
        (g.show_low, idx_lo, &g.low, "#D00000"),
        (g.show_first, first, &g.first, "#D00000"),
        (g.show_last, last, &g.last, "#D00000"),
    ] {
        if let (true, Some(i)) = (show, idx) {
            marks.push((i, pick(c, d)));
        }
    }
    for (i, p) in marks {
        let v = vals[i];
        match g.kind {
            SparklineKind::Line => {
                let (x, y) = (x_of(i), y_of(v));
                let r = (g.line_weight * 1.5).max(1.25);
                out.push(Primitive::Rect {
                    x: x - r,
                    y: y - r,
                    w: 2.0 * r,
                    h: 2.0 * r,
                    fill: Some(p.hex.clone()),
                    stroke: None,
                    stroke_w: 0.0,
                    fill_swatch_ref: p.swatch.clone(),
                    stroke_swatch_ref: None,
                    fx: None,
                });
            }
            SparklineKind::Column => {
                let base = if lo <= 0.0 && hi >= 0.0 {
                    y_of(0.0)
                } else {
                    bottom
                };
                rect(&mut out, x_of(i), base, y_of(v), bw, &p);
            }
            SparklineKind::WinLoss => {
                let mid = (top + bottom) / 2.0;
                if v != 0.0 {
                    rect(
                        &mut out,
                        x_of(i),
                        mid,
                        if v > 0.0 { top } else { bottom },
                        bw,
                        &p,
                    );
                }
            }
        }
    }
    out
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;

    #[test]
    fn three_kinds_draw_in_the_cell__feat__sheet_chart_sparklines() {
        let mut g = SparklineGroup::default();
        let v = [1.0, -2.0, 3.0, f64::NAN, 2.0];
        let line = sparkline(&g, &v, 60.0, 15.0, None);
        // A gap ends the line; the lone point after it draws no segment.
        assert_eq!(
            line.iter()
                .filter(|p| matches!(p, Primitive::Line { .. }))
                .count(),
            1
        );
        g.kind = SparklineKind::Column;
        let col = sparkline(&g, &v, 60.0, 15.0, None);
        assert_eq!(col.len(), 4);
        g.kind = SparklineKind::WinLoss;
        let wl = sparkline(&g, &v, 60.0, 15.0, None);
        assert_eq!(wl.len(), 4);
        for p in col.iter().chain(&wl) {
            if let Primitive::Rect { x, y, w, h, .. } = p {
                assert!(*x >= 0.0 && *y >= 0.0 && x + w <= 60.0 && y + h <= 15.0 + 1e-9);
            }
        }
        g.kind = SparklineKind::Line;
        g.show_high = true;
        g.show_low = true;
        let marked = sparkline(&g, &v, 60.0, 15.0, None);
        assert_eq!(
            marked
                .iter()
                .filter(|p| matches!(p, Primitive::Rect { .. }))
                .count(),
            2
        );
    }
}
