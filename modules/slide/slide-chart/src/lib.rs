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

//! # slide-chart — DrawingML charts laid out as PowerPoint draws them
//!
//! [`layout`] turns a [`Chart`] (its cached values, axes, title and legend)
//! into positioned primitives in the chart frame's own points: bars, lines,
//! areas, pie wedges, gridlines and labels. Paints stay unresolved
//! DrawingML fills and lines (theme colours resolve with the rest of the
//! slide); a primitive without its own paint gets the colour Office's
//! default chart style gives it.
//!
//! PowerPoint's automatic layout is not specified. The padding, label bands
//! and axis scaling here are measured from PowerPoint's own PDF export of
//! the corpus charts (ADR 705): plot area inset 6.5 pt left, 11 pt right;
//! category labels start 0.85 × their size below the plot; value labels end
//! 0.93 × their size left of it; the value axis runs from 0 to the first
//! "nice" step (1, 2 or 5 × 10ⁿ) above the largest value plus 5 %.

use pptx_core::chart::{Axis, Chart, DataLabels, PlotKind, Series};
use pptx_core::{Color, ColorBase, Fill, Line, RunProps};
use serde::{Deserialize, Serialize};

/// Text a chart title shows when the file gives none (PowerPoint shows its
/// UI language's word; English here).
pub const AUTO_TITLE: &str = "Chart Title";

/// One positioned piece of a chart, in pt from the frame's top-left.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Prim {
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: Option<Fill>,
        line: Option<Line>,
    },
    /// An open polyline (`smooth`: a Catmull-Rom curve through the points)
    /// or, when `closed`, a filled polygon.
    Path {
        points: Vec<(f64, f64)>,
        smooth: bool,
        closed: bool,
        fill: Option<Fill>,
        line: Option<Line>,
    },
    /// A pie slice: angles in degrees clockwise from 12 o'clock.
    Wedge {
        cx: f64,
        cy: f64,
        r: f64,
        hole: f64,
        start: f64,
        sweep: f64,
        fill: Option<Fill>,
        line: Option<Line>,
    },
    /// One line of text, centred vertically on `cy` and placed by `align`
    /// against `x` (left edge, centre or right edge).
    Label {
        x: f64,
        cy: f64,
        align: Align,
        text: String,
        props: RunProps,
    },
}

/// A fill and a line.
type Paint = (Option<Fill>, Option<Line>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Align {
    Left,
    Center,
    Right,
}

const PAD_LEFT: f64 = 6.5;
const PAD_RIGHT: f64 = 11.0;
const PAD_TOP: f64 = 7.0;
const PAD_BOTTOM: f64 = 6.5;
/// The end value labels overhang the plot by half their size plus this.
const LABEL_OVERHANG: f64 = 1.1;
/// Average advance of a digit, and of a letter, as a share of the size.
const DIGIT_W: f64 = 0.6;
const CHAR_W: f64 = 0.52;

/// Lay `chart` out in a `w` × `h` pt frame.
pub fn layout(chart: &Chart, w: f64, h: f64) -> Vec<Prim> {
    let mut out = Vec::new();
    let base = merged(&default_text(1197), chart.text.as_ref());
    if chart.area.fill.is_some() || chart.area.line.is_some() {
        out.push(Prim::Rect {
            x: 0.0,
            y: 0.0,
            w,
            h,
            fill: chart.area.fill.clone(),
            line: chart.area.line.clone(),
        });
    }

    // Title.
    let mut top = PAD_TOP;
    if let Some(t) = &chart.title {
        let props = merged(
            &merged(&default_text(1862), chart.text.as_ref()),
            t.props.as_ref(),
        );
        let s = size(&props);
        let text = if t.text.is_empty() {
            single_series_name(chart).unwrap_or_else(|| AUTO_TITLE.to_string())
        } else {
            t.text.clone()
        };
        out.push(Prim::Label {
            x: w / 2.0,
            cy: PAD_TOP + 3.7 + s / 2.0,
            align: Align::Center,
            text,
            props,
        });
        if !t.overlay {
            top = PAD_TOP + 3.7 + 2.0 * s;
        }
    }

    // Legend: reserve its band.
    let mut right = w - PAD_RIGHT;
    let mut bottom_limit = h - PAD_BOTTOM;
    let legend = chart.legend.as_ref().map(|l| {
        let props = merged(&base, l.text.as_ref());
        let entries = legend_entries(chart);
        (l, props, entries)
    });
    if let Some((l, props, entries)) = &legend {
        let s = size(props);
        if !l.overlay {
            match l.position.as_str() {
                "b" => bottom_limit -= 1.6 * s,
                "t" => top += 1.6 * s,
                "l" => {}
                _ => {
                    let widest = entries
                        .iter()
                        .map(|(n, _)| text_width(n, s))
                        .fold(0.0, f64::max);
                    right -= widest + 1.4 * s + 6.0;
                }
            }
        }
    }

    let pie = chart
        .plots
        .iter()
        .any(|p| matches!(p.kind, PlotKind::Pie { .. }));
    if pie {
        pie_layout(chart, &mut out, PAD_LEFT, top, right, bottom_limit, &base);
    } else {
        cartesian(chart, &mut out, top, right, bottom_limit, &base);
    }

    if let Some((l, props, entries)) = legend {
        legend_layout(&mut out, l.position.as_str(), &props, &entries, w, h, top);
    }
    out
}

// ─── cartesian charts ──────────────────────────────────────────────────

struct Scale {
    min: f64,
    max: f64,
    unit: f64,
}

fn cartesian(
    chart: &Chart,
    out: &mut Vec<Prim>,
    top: f64,
    right: f64,
    bottom: f64,
    base: &RunProps,
) {
    let horizontal = chart.plots.iter().any(|p| {
        matches!(
            p.kind,
            PlotKind::Bar {
                horizontal: true,
                ..
            }
        )
    });
    let cat_axis = chart.cat_axis.clone().unwrap_or_default();
    let val_axis = chart.val_axis.clone().unwrap_or_default();
    let cat_props = merged(base, cat_axis.text.as_ref());
    let val_props = merged(base, val_axis.text.as_ref());
    let (s_c, s_v) = (size(&cat_props), size(&val_props));
    let categories = categories(chart);
    let n_cat = categories.len().max(1);
    let scale = value_scale(chart, &val_axis);
    let fmt = val_axis
        .format
        .clone()
        .or_else(|| first_series(chart).and_then(|s| s.format.clone()))
        .unwrap_or_else(|| "General".into());
    let ticks: Vec<f64> = (0..)
        .map(|i| scale.min + i as f64 * scale.unit)
        .take_while(|v| *v <= scale.max + scale.unit * 1e-6)
        .collect();
    let tick_text: Vec<String> = ticks.iter().map(|v| format_number(*v, &fmt)).collect();
    let show_val = !val_axis.deleted && val_axis.tick_labels != "none";
    let show_cat = !cat_axis.deleted && cat_axis.tick_labels != "none";

    // The plot rectangle.
    let (left, plot_top, plot_bottom) = if horizontal {
        let widest = categories
            .iter()
            .map(|c| text_width(c, s_c))
            .fold(0.0, f64::max);
        let left = if show_cat {
            PAD_LEFT + widest + 0.93 * s_c
        } else {
            PAD_LEFT + 4.0
        };
        let bottom = if show_val {
            bottom - 1.85 * s_v
        } else {
            bottom - 4.5
        };
        (left, top.max(PAD_TOP + 4.0), bottom)
    } else {
        let widest = tick_text
            .iter()
            .map(|t| text_width(t, s_v))
            .fold(0.0, f64::max);
        let left = if show_val {
            PAD_LEFT + widest + 0.93 * s_v
        } else {
            PAD_LEFT + 4.0
        };
        // Without category labels the bottom value label still needs its
        // half line, as the top one does.
        let bottom = match (show_cat, show_val) {
            (true, _) => bottom - 1.85 * s_c,
            (false, true) => bottom - 0.5 * s_v - LABEL_OVERHANG,
            (false, false) => bottom - 4.5,
        };
        let plot_top = if show_val {
            top.max(PAD_TOP + 0.5 * s_v + LABEL_OVERHANG)
        } else {
            top
        };
        (left, plot_top, bottom)
    };
    let (pw, ph) = ((right - left).max(1.0), (plot_bottom - plot_top).max(1.0));
    if chart.plot_area.fill.is_some() || chart.plot_area.line.is_some() {
        out.push(Prim::Rect {
            x: left,
            y: plot_top,
            w: pw,
            h: ph,
            fill: chart.plot_area.fill.clone(),
            line: chart.plot_area.line.clone(),
        });
    }
    // Value → position along the value axis; category band → its span.
    let val_pos = |v: f64| -> f64 {
        let t = (v - scale.min) / (scale.max - scale.min);
        let t = if val_axis.reversed { 1.0 - t } else { t };
        if horizontal {
            left + t * pw
        } else {
            plot_bottom - t * ph
        }
    };
    let band = |i: usize| -> (f64, f64) {
        let i = if cat_axis.reversed { n_cat - 1 - i } else { i };
        if horizontal {
            // The first category sits at the bottom.
            let bw = ph / n_cat as f64;
            (plot_bottom - (i + 1) as f64 * bw, bw)
        } else {
            let bw = pw / n_cat as f64;
            (left + i as f64 * bw, bw)
        }
    };

    // Gridlines.
    if let Some(g) = &val_axis.major_gridlines {
        let line = g
            .line
            .clone()
            .or_else(|| Some(default_line("tx1", 15_000, 85_000)));
        for v in &ticks {
            let p = val_pos(*v);
            let pts = if horizontal {
                vec![(p, plot_top), (p, plot_bottom)]
            } else {
                vec![(left, p), (right, p)]
            };
            out.push(Prim::Path {
                points: pts,
                smooth: false,
                closed: false,
                fill: None,
                line: line.clone(),
            });
        }
    }

    // Series.
    let zero = val_pos(scale.min.max(0.0).min(scale.max));
    for plot in &chart.plots {
        match &plot.kind {
            PlotKind::Bar {
                grouping,
                gap_width,
                overlap,
                ..
            } => {
                let stacked = grouping != "clustered" && grouping != "standard";
                let percent = grouping == "percentStacked";
                let n = if stacked { 1 } else { plot.series.len().max(1) };
                let g = *gap_width as f64 / 100.0;
                let o = if stacked {
                    1.0
                } else {
                    *overlap as f64 / 100.0
                };
                let mut acc_pos = vec![0.0; n_cat];
                let mut acc_neg = vec![0.0; n_cat];
                let totals: Vec<f64> = (0..n_cat)
                    .map(|c| {
                        plot.series
                            .iter()
                            .map(|s| s.values.get(c).copied().flatten().unwrap_or(0.0).abs())
                            .sum()
                    })
                    .collect();
                for (si, s) in plot.series.iter().enumerate() {
                    let (fill, line) = series_paint(s);
                    for c in 0..n_cat {
                        let Some(mut v) = s.values.get(c).copied().flatten() else {
                            continue;
                        };
                        if percent && totals[c] > 0.0 {
                            v = v / totals[c] * scale.max.max(1.0);
                        }
                        let (b0, bw) = band(c);
                        let bar = bw / (n as f64 - (n as f64 - 1.0) * o + g);
                        let slot = if stacked { 0 } else { si };
                        let a = b0 + bar * g / 2.0 + slot as f64 * bar * (1.0 - o);
                        let (from, to) = if stacked {
                            let acc = if v >= 0.0 { &mut acc_pos } else { &mut acc_neg };
                            let from = acc[c];
                            acc[c] += v;
                            (val_pos(from), val_pos(acc[c]))
                        } else {
                            (zero, val_pos(v))
                        };
                        let (fill, line) =
                            point_paint(s, c, fill.clone(), line.clone(), plot.vary_colors, c);
                        let (x, y, ww, hh) = if horizontal {
                            // Bars grow right; slots run bottom-up.
                            let y = b0 + bw - (a - b0) - bar;
                            (from.min(to), y, (to - from).abs(), bar)
                        } else {
                            (a, from.min(to), bar, (to - from).abs())
                        };
                        out.push(Prim::Rect {
                            x,
                            y,
                            w: ww,
                            h: hh,
                            fill,
                            line,
                        });
                        if let Some(dl) = labels_for(s, plot.labels.as_ref()) {
                            if dl.show_value {
                                let props = merged(base, dl.text.as_ref());
                                let text = format_number(
                                    s.values[c].unwrap_or(0.0),
                                    dl.format
                                        .as_deref()
                                        .or(s.format.as_deref())
                                        .unwrap_or("General"),
                                );
                                let (lx, ly, al) = if horizontal {
                                    (x + ww + 3.0, y + hh / 2.0, Align::Left)
                                } else {
                                    (x + ww / 2.0, y - 0.7 * size(&props), Align::Center)
                                };
                                out.push(Prim::Label {
                                    x: lx,
                                    cy: ly,
                                    align: al,
                                    text,
                                    props,
                                });
                            }
                        }
                    }
                }
            }
            PlotKind::Line { grouping } | PlotKind::Area { grouping } => {
                let area = matches!(plot.kind, PlotKind::Area { .. });
                let stacked = grouping != "standard";
                let mut acc = vec![0.0; n_cat];
                for s in &plot.series {
                    let (fill, line) = series_paint(s);
                    let mut pts = Vec::new();
                    for (c, total) in acc.iter_mut().enumerate() {
                        let Some(v) = s.values.get(c).copied().flatten() else {
                            continue;
                        };
                        let v = if stacked {
                            *total += v;
                            *total
                        } else {
                            v
                        };
                        let (b0, bw) = band(c);
                        let m = b0 + bw / 2.0;
                        pts.push(if horizontal {
                            (val_pos(v), m)
                        } else {
                            (m, val_pos(v))
                        });
                    }
                    if area {
                        let mut poly = pts.clone();
                        if let (Some(first), Some(last)) = (pts.first(), pts.last()) {
                            poly.push((last.0, zero));
                            poly.push((first.0, zero));
                        }
                        out.push(Prim::Path {
                            points: poly,
                            smooth: false,
                            closed: true,
                            fill: fill
                                .or_else(|| s.props.line.as_ref().and_then(|l| l.fill.clone())),
                            line: None,
                        });
                    } else {
                        let line = s
                            .props
                            .line
                            .clone()
                            .map(|mut l| {
                                if l.width.is_none() {
                                    l.width = Some(28_575);
                                }
                                l
                            })
                            .or(line);
                        out.push(Prim::Path {
                            points: pts.clone(),
                            smooth: s.smooth,
                            closed: false,
                            fill: None,
                            line: line.clone(),
                        });
                        if let Some(sym) = s.marker.as_deref().filter(|m| *m != "none") {
                            let mk = line.as_ref().and_then(|l| l.fill.clone());
                            for (x, y) in &pts {
                                let r = 2.5;
                                if sym == "circle" {
                                    out.push(Prim::Wedge {
                                        cx: *x,
                                        cy: *y,
                                        r,
                                        hole: 0.0,
                                        start: 0.0,
                                        sweep: 360.0,
                                        fill: mk.clone(),
                                        line: None,
                                    });
                                } else {
                                    out.push(Prim::Rect {
                                        x: x - r,
                                        y: y - r,
                                        w: 2.0 * r,
                                        h: 2.0 * r,
                                        fill: mk.clone(),
                                        line: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            PlotKind::Pie { .. } | PlotKind::Other(_) => {}
        }
    }

    // Axis lines (the category axis crosses at zero).
    let cat_line = cat_axis
        .line
        .line
        .clone()
        .unwrap_or_else(|| default_line("tx1", 15_000, 85_000));
    if !cat_axis.deleted && !no_line(&cat_line) {
        let pts = if horizontal {
            vec![(zero, plot_top), (zero, plot_bottom)]
        } else {
            vec![(left, zero), (right, zero)]
        };
        out.push(Prim::Path {
            points: pts,
            smooth: false,
            closed: false,
            fill: None,
            line: Some(cat_line),
        });
    }
    if let Some(l) = val_axis.line.line.clone().filter(|l| !no_line(l)) {
        if !val_axis.deleted {
            let pts = if horizontal {
                vec![(left, plot_bottom), (right, plot_bottom)]
            } else {
                vec![(left, plot_top), (left, plot_bottom)]
            };
            out.push(Prim::Path {
                points: pts,
                smooth: false,
                closed: false,
                fill: None,
                line: Some(l),
            });
        }
    }

    // Tick labels.
    if show_val {
        for (v, t) in ticks.iter().zip(&tick_text) {
            let p = val_pos(*v);
            out.push(if horizontal {
                Prim::Label {
                    x: p,
                    cy: plot_bottom + 1.35 * s_v,
                    align: Align::Center,
                    text: t.clone(),
                    props: val_props.clone(),
                }
            } else {
                Prim::Label {
                    x: left - 0.93 * s_v,
                    cy: p + 0.035 * s_v,
                    align: Align::Right,
                    text: t.clone(),
                    props: val_props.clone(),
                }
            });
        }
    }
    if show_cat {
        for (i, c) in categories.iter().enumerate() {
            let (b0, bw) = band(i);
            out.push(if horizontal {
                Prim::Label {
                    x: left - 0.93 * s_c,
                    cy: b0 + bw / 2.0,
                    align: Align::Right,
                    text: c.clone(),
                    props: cat_props.clone(),
                }
            } else {
                Prim::Label {
                    x: b0 + bw / 2.0,
                    cy: plot_bottom + 1.35 * s_c,
                    align: Align::Center,
                    text: c.clone(),
                    props: cat_props.clone(),
                }
            });
        }
    }
}

/// Excel's automatic value scale: zero-based when the data allow, the top
/// raised 5 % past the largest value, then to the next multiple of a 1/2/5
/// unit.
fn value_scale(chart: &Chart, axis: &Axis) -> Scale {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for p in &chart.plots {
        let stacked = match &p.kind {
            PlotKind::Bar { grouping, .. } => grouping != "clustered" && grouping != "standard",
            PlotKind::Line { grouping } | PlotKind::Area { grouping } => grouping != "standard",
            _ => false,
        };
        let percent = matches!(&p.kind, PlotKind::Bar { grouping, .. } | PlotKind::Line { grouping } | PlotKind::Area { grouping } if grouping == "percentStacked");
        if percent {
            lo = lo.min(0.0);
            hi = hi.max(1.0);
            continue;
        }
        if stacked {
            let n = p.series.iter().map(|s| s.values.len()).max().unwrap_or(0);
            for c in 0..n {
                let (mut pos, mut neg) = (0.0, 0.0);
                for s in &p.series {
                    let v = s.values.get(c).copied().flatten().unwrap_or(0.0);
                    if v >= 0.0 {
                        pos += v
                    } else {
                        neg += v
                    }
                }
                hi = hi.max(pos);
                lo = lo.min(neg);
            }
        } else {
            for v in p.series.iter().flat_map(|s| s.values.iter().flatten()) {
                hi = hi.max(*v);
                lo = lo.min(*v);
            }
        }
    }
    if !hi.is_finite() {
        lo = 0.0;
        hi = 1.0;
    }
    let lo0 = lo.min(0.0);
    let hi0 = hi.max(0.0);
    let span = (hi0 - lo0).max(f64::EPSILON);
    let top = if hi0 > 0.0 { hi0 + 0.05 * span } else { 0.0 };
    let bottom = if lo0 < 0.0 { lo0 - 0.05 * span } else { 0.0 };
    let unit = axis.major_unit.unwrap_or_else(|| nice_unit(top - bottom));
    let max = axis.max.unwrap_or((top / unit).ceil() * unit);
    let min = axis.min.unwrap_or((bottom / unit).floor() * unit);
    Scale {
        min,
        max: if max > min { max } else { min + unit },
        unit,
    }
}

fn nice_unit(range: f64) -> f64 {
    let p = 10f64.powf(range.log10().floor());
    let r = range / p;
    if r > 5.0 {
        p
    } else if r > 2.0 {
        p / 2.0
    } else {
        p / 5.0
    }
}

// ─── pie ────────────────────────────────────────────────────────────────

fn pie_layout(
    chart: &Chart,
    out: &mut Vec<Prim>,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    base: &RunProps,
) {
    let Some(plot) = chart
        .plots
        .iter()
        .find(|p| matches!(p.kind, PlotKind::Pie { .. }))
    else {
        return;
    };
    let PlotKind::Pie {
        first_slice_angle,
        hole,
    } = plot.kind
    else {
        return;
    };
    let Some(s) = plot.series.first() else {
        return;
    };
    let (cx, cy) = ((left + right) / 2.0, (top + bottom) / 2.0);
    let r = ((right - left).min(bottom - top) / 2.0 - 4.0).max(1.0);
    let hole = hole.map(|h| r * h as f64 / 100.0).unwrap_or(0.0);
    let total: f64 = s.values.iter().flatten().map(|v| v.abs()).sum();
    if total <= 0.0 {
        return;
    }
    let mut a = first_slice_angle as f64;
    for (i, v) in s.values.iter().enumerate() {
        let Some(v) = v else { continue };
        let sweep = v.abs() / total * 360.0;
        let (fill, line) = point_paint(s, i, None, None, true, i);
        let line = line.or_else(|| Some(default_line("bg1", 100_000, 0)));
        out.push(Prim::Wedge {
            cx,
            cy,
            r,
            hole,
            start: a,
            sweep,
            fill,
            line,
        });
        if let Some(dl) = labels_for(s, plot.labels.as_ref()) {
            if dl.show_value || dl.show_percent || dl.show_category {
                let mid = (a + sweep / 2.0).to_radians();
                let rr = if hole > 0.0 {
                    (r + hole) / 2.0
                } else {
                    r * 0.65
                };
                let mut parts = Vec::new();
                if dl.show_category {
                    parts.push(s.categories.get(i).cloned().unwrap_or_default());
                }
                if dl.show_value {
                    parts.push(format_number(*v, dl.format.as_deref().unwrap_or("General")));
                }
                if dl.show_percent {
                    parts.push(format!("{:.0}%", v.abs() / total * 100.0));
                }
                out.push(Prim::Label {
                    x: cx + rr * mid.sin(),
                    cy: cy - rr * mid.cos(),
                    align: Align::Center,
                    text: parts.join(", "),
                    props: merged(base, dl.text.as_ref()),
                });
            }
        }
        a += sweep;
    }
}

// ─── legend ─────────────────────────────────────────────────────────────

fn legend_entries(chart: &Chart) -> Vec<(String, Paint)> {
    let mut out = Vec::new();
    for p in &chart.plots {
        if matches!(p.kind, PlotKind::Pie { .. }) {
            if let Some(s) = p.series.first() {
                for (i, c) in s.categories.iter().enumerate() {
                    out.push((c.clone(), point_paint(s, i, None, None, true, i)));
                }
            }
            continue;
        }
        for s in &p.series {
            let paint = series_paint(s);
            let paint = if matches!(p.kind, PlotKind::Line { .. }) {
                (
                    s.props
                        .line
                        .as_ref()
                        .and_then(|l| l.fill.clone())
                        .or(paint.0),
                    None,
                )
            } else {
                paint
            };
            out.push((s.name.clone(), paint));
        }
    }
    out
}

fn legend_layout(
    out: &mut Vec<Prim>,
    pos: &str,
    props: &RunProps,
    entries: &[(String, Paint)],
    w: f64,
    h: f64,
    top: f64,
) {
    let s = size(props);
    let mark = 0.6 * s;
    let place =
        |out: &mut Vec<Prim>, x: f64, cy: f64, name: &str, paint: &(Option<Fill>, Option<Line>)| {
            out.push(Prim::Rect {
                x,
                y: cy - mark / 2.0,
                w: mark,
                h: mark,
                fill: paint.0.clone(),
                line: paint.1.clone(),
            });
            out.push(Prim::Label {
                x: x + mark + 0.3 * s,
                cy,
                align: Align::Left,
                text: name.to_string(),
                props: props.clone(),
            });
        };
    match pos {
        "b" | "t" => {
            let widths: Vec<f64> = entries
                .iter()
                .map(|(n, _)| mark + 0.3 * s + text_width(n, s) + s)
                .collect();
            let total: f64 = widths.iter().sum();
            let mut x = (w - total) / 2.0;
            let cy = if pos == "b" {
                h - PAD_BOTTOM - 0.6 * s
            } else {
                top - 0.9 * s
            };
            for ((n, p), wd) in entries.iter().zip(widths) {
                place(out, x, cy, n, p);
                x += wd;
            }
        }
        _ => {
            let widest = entries
                .iter()
                .map(|(n, _)| text_width(n, s))
                .fold(0.0, f64::max);
            let x = if pos == "l" {
                PAD_LEFT
            } else {
                w - PAD_RIGHT - widest - mark - 0.3 * s
            };
            let step = 1.4 * s;
            let mut cy = h / 2.0 - step * (entries.len() as f64 - 1.0) / 2.0;
            for (n, p) in entries {
                place(out, x, cy, n, p);
                cy += step;
            }
        }
    }
}

// ─── paints and text ────────────────────────────────────────────────────

fn scheme(name: &str, lum_mod: i32, lum_off: i32) -> Color {
    let mut transforms = Vec::new();
    if lum_mod != 100_000 {
        transforms.push(("lumMod".to_string(), lum_mod));
    }
    if lum_off != 0 {
        transforms.push(("lumOff".to_string(), lum_off));
    }
    Color {
        base: ColorBase::Scheme(name.into()),
        transforms,
    }
}

fn default_line(name: &str, lum_mod: i32, lum_off: i32) -> Line {
    Line {
        width: Some(9_525),
        fill: Some(Fill::Solid(scheme(name, lum_mod, lum_off))),
        ..Default::default()
    }
}

fn no_line(l: &Line) -> bool {
    matches!(l.fill, Some(Fill::None))
}

/// Office's automatic series colour: accent 1–6, then the same darkened
/// and lightened.
fn auto_color(i: usize) -> Color {
    let accent = format!("accent{}", i % 6 + 1);
    match (i / 6) % 3 {
        0 => scheme(&accent, 100_000, 0),
        1 => scheme(&accent, 60_000, 0),
        _ => scheme(&accent, 80_000, 20_000),
    }
}

/// A series' own paint, else its automatic colour (by `c:idx`).
fn series_paint(s: &Series) -> Paint {
    let fill = s
        .props
        .fill
        .clone()
        .or_else(|| Some(Fill::Solid(auto_color(s.index as usize))));
    (fill, s.props.line.clone())
}

fn point_paint(
    s: &Series,
    point: usize,
    fill: Option<Fill>,
    line: Option<Line>,
    vary: bool,
    vary_index: usize,
) -> Paint {
    if let Some((_, p)) = s.points.iter().find(|(i, _)| *i as usize == point) {
        return (p.fill.clone().or(fill), p.line.clone().or(line));
    }
    if vary {
        return (
            Some(Fill::Solid(auto_color(vary_index))),
            line.or_else(|| s.props.line.clone()),
        );
    }
    (fill, line)
}

fn labels_for<'a>(s: &'a Series, plot: Option<&'a DataLabels>) -> Option<&'a DataLabels> {
    s.labels.as_ref().or(plot)
}

fn default_text(size: i32) -> RunProps {
    RunProps {
        size: Some(size),
        latin: Some("+mn-lt".into()),
        fill: Some(Fill::Solid(scheme("tx1", 65_000, 35_000))),
        ..Default::default()
    }
}

/// `over`'s set fields on top of `base`.
fn merged(base: &RunProps, over: Option<&RunProps>) -> RunProps {
    let Some(o) = over else {
        return base.clone();
    };
    let mut r = base.clone();
    macro_rules! take { ($($f:ident),*) => { $( if o.$f.is_some() { r.$f = o.$f.clone(); } )* }; }
    take!(
        size, bold, italic, underline, strike, caps, spacing, baseline, latin, east_asian, complex,
        fill, lang
    );
    r
}

fn size(p: &RunProps) -> f64 {
    p.size.unwrap_or(1197) as f64 / 100.0
}

fn text_width(t: &str, s: f64) -> f64 {
    t.chars()
        .map(|c| {
            if c.is_ascii_digit() {
                DIGIT_W
            } else if matches!(c, '.' | ',' | ' ' | '-') {
                0.3
            } else {
                CHAR_W
            }
        })
        .sum::<f64>()
        * s
}

fn categories(chart: &Chart) -> Vec<String> {
    let n = chart
        .plots
        .iter()
        .flat_map(|p| p.series.iter())
        .map(|s| s.values.len().max(s.categories.len()))
        .max()
        .unwrap_or(0);
    let named = chart
        .plots
        .iter()
        .flat_map(|p| p.series.iter())
        .find(|s| !s.categories.is_empty())
        .map(|s| s.categories.clone())
        .unwrap_or_default();
    (0..n)
        .map(|i| named.get(i).cloned().unwrap_or_else(|| (i + 1).to_string()))
        .collect()
}

fn first_series(chart: &Chart) -> Option<&Series> {
    chart.plots.iter().flat_map(|p| p.series.iter()).next()
}

fn single_series_name(chart: &Chart) -> Option<String> {
    let all: Vec<&Series> = chart.plots.iter().flat_map(|p| p.series.iter()).collect();
    (all.len() == 1).then(|| all[0].name.clone())
}

/// A number in an Excel format code: `General`, `0`, `0.0…`, `#,##0…`,
/// and a trailing `%`.
pub fn format_number(v: f64, code: &str) -> String {
    let code = code.split(';').next().unwrap_or("General").trim();
    if code.eq_ignore_ascii_case("general") || code.is_empty() {
        if v == v.trunc() && v.abs() < 1e15 {
            return format!("{}", v as i64);
        }
        let s = format!("{:.10}", v);
        return s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    let percent = code.ends_with('%');
    let v = if percent { v * 100.0 } else { v };
    let body = code.trim_end_matches('%');
    let decimals = body
        .split('.')
        .nth(1)
        .map(|d| d.chars().filter(|c| *c == '0' || *c == '#').count())
        .unwrap_or(0);
    let grouped = body.contains(',');
    let mut s = format!("{:.*}", decimals, v);
    if grouped {
        let (int, frac) = match s.find('.') {
            Some(i) => (s[..i].to_string(), s[i..].to_string()),
            None => (s.clone(), String::new()),
        };
        let neg = int.starts_with('-');
        let digits: Vec<char> = int.trim_start_matches('-').chars().collect();
        let mut g = String::new();
        for (i, c) in digits.iter().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                g.push(',');
            }
            g.push(*c);
        }
        s = format!("{}{g}{frac}", if neg { "-" } else { "" });
    }
    if percent {
        s.push('%');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excel_scales_to_the_next_nice_step_past_five_percent_headroom() {
        // PowerPoint's answers on the corpus charts: largest value 5.0 (bars
        // or line) → 5.25 → unit 1 → 0..6.
        {
            let (hi, max, unit) = (5.0, 6.0, 1.0);
            let chart = Chart {
                plots: vec![pptx_core::chart::Plot {
                    kind: PlotKind::Bar {
                        horizontal: false,
                        grouping: "clustered".into(),
                        gap_width: 150,
                        overlap: 0,
                    },
                    vary_colors: false,
                    series: vec![Series {
                        values: vec![Some(1.0), Some(hi)],
                        ..Default::default()
                    }],
                    labels: None,
                }],
                ..Default::default()
            };
            let s = value_scale(&chart, &Axis::default());
            assert_eq!((s.min, s.max, s.unit), (0.0, max, unit), "max value {hi}");
        }
    }

    #[test]
    fn number_formats() {
        assert_eq!(format_number(4.5, "General"), "4.5");
        assert_eq!(format_number(6.0, "General"), "6");
        assert_eq!(format_number(0.25, "0%"), "25%");
        assert_eq!(format_number(1234567.0, "#,##0"), "1,234,567");
        assert_eq!(format_number(1.23456, "0.00"), "1.23");
    }
}
