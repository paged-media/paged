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

//! Markers, data-label text, trendlines and error bars — what every series
//! kind can carry.
//!
//! TRENDLINES fit with the function library's own least-squares solver
//! (`sheet_fn::families::stat2::least_squares`, the one behind LINEST), so a
//! chart's trendline equals LINEST / LOGEST on the same data: linear,
//! polynomial (order 2–6), logarithmic (`y = a·ln x + b`), exponential
//! (`ln y` on `x`) and power (`ln y` on `ln x`), the last two with R² of
//! the linearised fit as Excel reports it; a moving average has no equation.
//!
//! ERROR BARS (Excel's rules): fixed and percentage amounts per point;
//! standard deviation bars are centred on the series MEAN (k × the sample
//! standard deviation), standard error bars on each point; custom amounts
//! come from the ranges.

use crate::colors::Paint;
use crate::geometry::{format_number, Pen, PlotData, TextAnchor, TextSpec};
use crate::model::{
    DataLabels, ErrorBarType, ErrorBars, ErrorValue, MarkerSymbol, TrendKind, Trendline,
};

/// Draw a marker centred at `(x, y)`, `size` pt across.
pub(crate) fn marker(
    pen: &Pen,
    x: f64,
    y: f64,
    sym: MarkerSymbol,
    size: f64,
    fill: &Paint,
    stroke: Option<&Paint>,
) {
    let r = size / 2.0;
    let sw = 0.75;
    match sym {
        MarkerSymbol::None | MarkerSymbol::Auto => {}
        MarkerSymbol::Circle => {
            let pts = (0..16)
                .map(|i| {
                    let a = std::f64::consts::TAU * i as f64 / 16.0;
                    (x + r * a.cos(), y + r * a.sin())
                })
                .collect();
            pen.poly(pts, Some(fill), stroke, sw);
        }
        MarkerSymbol::Square => pen.rect(x - r, y - r, size, size, Some(fill), stroke, sw),
        MarkerSymbol::Dot => pen.rect(x - r / 2.0, y - r / 2.0, r, r, Some(fill), stroke, sw),
        MarkerSymbol::Diamond => pen.poly(
            vec![(x, y - r), (x + r, y), (x, y + r), (x - r, y)],
            Some(fill),
            stroke,
            sw,
        ),
        MarkerSymbol::Triangle => pen.poly(
            vec![(x, y - r), (x + r, y + r), (x - r, y + r)],
            Some(fill),
            stroke,
            sw,
        ),
        MarkerSymbol::Dash => pen.rect(x - r, y - 0.75, size, 1.5, Some(fill), None, 0.0),
        MarkerSymbol::X | MarkerSymbol::Plus | MarkerSymbol::Star => {
            let c = stroke.unwrap_or(fill);
            if matches!(sym, MarkerSymbol::X | MarkerSymbol::Star) {
                pen.line(vec![(x - r, y - r), (x + r, y + r)], c, 1.0, None);
                pen.line(vec![(x - r, y + r), (x + r, y - r)], c, 1.0, None);
            }
            if matches!(sym, MarkerSymbol::Plus | MarkerSymbol::Star) {
                pen.line(vec![(x - r, y), (x + r, y)], c, 1.0, None);
                pen.line(vec![(x, y - r), (x, y + r)], c, 1.0, None);
            }
        }
    }
}

/// What a data label says for one point.
pub(crate) struct LabelParts<'a> {
    pub value: f64,
    pub category: &'a str,
    pub series: &'a str,
    pub percent: Option<f64>,
    pub bubble: Option<f64>,
    /// The values' own number format (used unless the labels set one).
    pub format: Option<String>,
}

/// The data-label text: the shown parts in Excel's order (series,
/// category, value, percent, bubble size), joined by the separator.
pub(crate) fn label_text(dl: &DataLabels, p: &LabelParts, data: &PlotData) -> String {
    let sep = dl.separator.as_deref().unwrap_or(", ");
    let mut parts: Vec<String> = Vec::new();
    if dl.show_series {
        parts.push(p.series.to_string());
    }
    if dl.show_category {
        parts.push(p.category.to_string());
    }
    if dl.show_value && p.value.is_finite() {
        parts.push(format_number(
            p.value,
            dl.format.as_deref().or(p.format.as_deref()),
            data,
        ));
    }
    if dl.show_percent {
        if let Some(pc) = p.percent {
            parts.push(format_number(pc, Some("0%"), data));
        }
    }
    if dl.show_bubble_size {
        if let Some(b) = p.bubble {
            parts.push(format_number(b, dl.format.as_deref(), data));
        }
    }
    parts.join(sep)
}

/// A fitted trendline.
pub(crate) struct Fit {
    /// `y(x)`.
    pub eval: Box<dyn Fn(f64) -> f64>,
    pub r2: Option<f64>,
    pub equation: Option<String>,
}

fn coef(v: f64) -> String {
    let r = (v * 1e4).round() / 1e4;
    let s = format!("{r}");
    if s == "-0" {
        "0".into()
    } else {
        s
    }
}

fn r_squared(ys: &[f64], fitted: &[f64]) -> f64 {
    let n = ys.len() as f64;
    let mean = ys.iter().sum::<f64>() / n;
    let ss_tot: f64 = ys.iter().map(|y| (y - mean).powi(2)).sum();
    let ss_res: f64 = ys.iter().zip(fitted).map(|(y, f)| (y - f).powi(2)).sum();
    if ss_tot == 0.0 {
        1.0
    } else {
        1.0 - ss_res / ss_tot
    }
}

/// Fit `t` to the points `(xs[i], ys[i])` (finite only). `None` when the
/// data cannot carry it (too few points, a log of a non-positive value).
pub(crate) fn fit(t: &Trendline, xs: &[f64], ys: &[f64]) -> Option<Fit> {
    use sheet_fn::families::stat2::least_squares;
    let pts: Vec<(f64, f64)> = xs
        .iter()
        .zip(ys)
        .filter(|(x, y)| x.is_finite() && y.is_finite())
        .map(|(x, y)| (*x, *y))
        .collect();
    if pts.len() < 2 {
        return None;
    }
    let px: Vec<f64> = pts.iter().map(|p| p.0).collect();
    let py: Vec<f64> = pts.iter().map(|p| p.1).collect();
    match t.kind {
        TrendKind::Linear | TrendKind::Polynomial(_) => {
            let order = match t.kind {
                TrendKind::Polynomial(k) => k.clamp(2, 6) as usize,
                _ => 1,
            };
            if pts.len() <= order {
                return None;
            }
            let cols: Vec<Vec<f64>> = (1..=order)
                .map(|k| px.iter().map(|x| x.powi(k as i32)).collect())
                .collect();
            let (beta, b) = match t.intercept {
                Some(b0) => {
                    let yb: Vec<f64> = py.iter().map(|y| y - b0).collect();
                    (least_squares(&cols, &yb, false)?.beta, b0)
                }
                None => {
                    let ls = least_squares(&cols, &py, true)?;
                    let b = ls.beta[order];
                    (ls.beta[..order].to_vec(), b)
                }
            };
            let m = beta.clone();
            let eval = move |x: f64| {
                b + m
                    .iter()
                    .enumerate()
                    .map(|(k, c)| c * x.powi(k as i32 + 1))
                    .sum::<f64>()
            };
            let fitted: Vec<f64> = px.iter().map(|x| eval(*x)).collect();
            let mut eq = String::from("y = ");
            for (k, c) in beta.iter().enumerate().rev() {
                let term = match k {
                    0 => format!("{}x", coef(*c)),
                    _ => format!("{}x^{}", coef(*c), k + 1),
                };
                if eq.len() > 4 {
                    if *c < 0.0 {
                        eq.push_str(&format!(" - {}", term.trim_start_matches('-')));
                    } else {
                        eq.push_str(&format!(" + {term}"));
                    }
                } else {
                    eq.push_str(&term);
                }
            }
            if b != 0.0 {
                if b < 0.0 {
                    eq.push_str(&format!(" - {}", coef(-b)));
                } else {
                    eq.push_str(&format!(" + {}", coef(b)));
                }
            }
            Some(Fit {
                r2: Some(r_squared(&py, &fitted)),
                equation: Some(eq),
                eval: Box::new(eval),
            })
        }
        TrendKind::Logarithmic => {
            if px.iter().any(|x| *x <= 0.0) {
                return None;
            }
            let lx: Vec<f64> = px.iter().map(|x| x.ln()).collect();
            let ls = least_squares(std::slice::from_ref(&lx), &py, true)?;
            let (a, b) = (ls.beta[0], ls.beta[1]);
            let fitted: Vec<f64> = lx.iter().map(|l| a * l + b).collect();
            Some(Fit {
                r2: Some(r_squared(&py, &fitted)),
                equation: Some(format!(
                    "y = {}ln(x) {} {}",
                    coef(a),
                    if b < 0.0 { "-" } else { "+" },
                    coef(b.abs())
                )),
                eval: Box::new(move |x| if x > 0.0 { a * x.ln() + b } else { f64::NAN }),
            })
        }
        TrendKind::Exponential | TrendKind::Power => {
            if py.iter().any(|y| *y <= 0.0) {
                return None;
            }
            let power = matches!(t.kind, TrendKind::Power);
            if power && px.iter().any(|x| *x <= 0.0) {
                return None;
            }
            let ly: Vec<f64> = py.iter().map(|y| y.ln()).collect();
            let xr: Vec<f64> = if power {
                px.iter().map(|x| x.ln()).collect()
            } else {
                px.clone()
            };
            let (k, ln_a) = match t.intercept.filter(|b| *b > 0.0 && !power) {
                Some(a0) => {
                    let yb: Vec<f64> = ly.iter().map(|l| l - a0.ln()).collect();
                    (
                        least_squares(std::slice::from_ref(&xr), &yb, false)?.beta[0],
                        a0.ln(),
                    )
                }
                None => {
                    let ls = least_squares(std::slice::from_ref(&xr), &ly, true)?;
                    (ls.beta[0], ls.beta[1])
                }
            };
            let a = ln_a.exp();
            let fitted: Vec<f64> = xr.iter().map(|x| ln_a + k * x).collect();
            let r2 = r_squared(&ly, &fitted);
            let eq = if power {
                format!("y = {}x^{}", coef(a), coef(k))
            } else {
                format!("y = {}e^{}x", coef(a), coef(k))
            };
            Some(Fit {
                r2: Some(r2),
                equation: Some(eq),
                eval: Box::new(move |x| {
                    if power {
                        if x > 0.0 {
                            a * x.powf(k)
                        } else {
                            f64::NAN
                        }
                    } else {
                        a * (k * x).exp()
                    }
                }),
            })
        }
        TrendKind::MovingAverage(_) => None,
    }
}

/// The moving-average points of `(xs, ys)` with period `n` (Excel: the
/// average of the `n` points ending at each point, from the `n`-th on).
pub(crate) fn moving_average(xs: &[f64], ys: &[f64], n: u32) -> Vec<(f64, f64)> {
    let n = n.max(2) as usize;
    let mut out = Vec::new();
    for i in (n - 1)..ys.len() {
        let w = &ys[i + 1 - n..=i];
        if w.iter().all(|v| v.is_finite()) {
            out.push((xs[i], w.iter().sum::<f64>() / n as f64));
        }
    }
    out
}

/// The (low, high) ends of each point's error bar, in value space.
pub(crate) fn error_ends(
    eb: &ErrorBars,
    values: &[f64],
    custom: Option<&crate::geometry::CustomErrors>,
) -> Vec<Option<(f64, f64)>> {
    let finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    let n = finite.len() as f64;
    let mean = if n > 0.0 {
        finite.iter().sum::<f64>() / n
    } else {
        0.0
    };
    let sd = if n > 1.0 {
        (finite.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
    } else {
        0.0
    };
    values
        .iter()
        .enumerate()
        .map(|(i, &v)| {
            if !v.is_finite() {
                return None;
            }
            let (center, plus, minus) = match &eb.value {
                ErrorValue::Fixed(a) => (v, *a, *a),
                ErrorValue::Percentage(p) => (v, v.abs() * p / 100.0, v.abs() * p / 100.0),
                ErrorValue::StdDev(k) => (mean, k * sd, k * sd),
                ErrorValue::StdErr => {
                    let se = if n > 0.0 { sd / n.sqrt() } else { 0.0 };
                    (v, se, se)
                }
                ErrorValue::Custom { .. } => {
                    let get = |o: &Option<Vec<f64>>| {
                        o.as_ref()
                            .and_then(|vs| vs.get(i).copied())
                            .filter(|x| x.is_finite())
                            .unwrap_or(0.0)
                    };
                    let (p, m) = custom.map_or((0.0, 0.0), |(p, m)| (get(p), get(m)));
                    (v, p, m)
                }
            };
            let hi = if eb.bar_type == ErrorBarType::Minus {
                center
            } else {
                center + plus
            };
            let lo = if eb.bar_type == ErrorBarType::Plus {
                center
            } else {
                center - minus
            };
            Some((lo, hi))
        })
        .collect()
}

/// Draw one error bar from `a` to `b` (pt) across at `at`, vertical unless
/// `horizontal`.
pub(crate) fn error_bar(
    pen: &Pen,
    at: f64,
    a: f64,
    b: f64,
    horizontal: bool,
    cap: bool,
    p: &Paint,
) {
    const CAP: f64 = 3.0;
    if horizontal {
        pen.line(vec![(a, at), (b, at)], p, 0.75, None);
        if cap {
            for e in [a, b] {
                pen.line(vec![(e, at - CAP), (e, at + CAP)], p, 0.75, None);
            }
        }
    } else {
        pen.line(vec![(at, a), (at, b)], p, 0.75, None);
        if cap {
            for e in [a, b] {
                pen.line(vec![(at - CAP, e), (at + CAP, e)], p, 0.75, None);
            }
        }
    }
}

/// Draw a trendline's label (equation and/or R²) at its end.
pub(crate) fn trend_label(pen: &Pen, t: &Trendline, f: &Fit, x: f64, y: f64, spec: &TextSpec) {
    let mut lines = Vec::new();
    if t.display_equation {
        if let Some(e) = &f.equation {
            lines.push(e.clone());
        }
    }
    if t.display_r2 {
        if let Some(r2) = f.r2 {
            lines.push(format!("R² = {}", coef(r2)));
        }
    }
    let spec = spec.anchored(TextAnchor::End);
    for (i, l) in lines.iter().enumerate() {
        pen.text(x, y - 4.0 + i as f64 * spec.size * 1.2, l, &spec);
    }
}

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;

    fn tl(kind: TrendKind) -> Trendline {
        Trendline::of(kind)
    }

    #[test]
    fn linear_fit_matches_linest__feat__sheet_chart_series_features() {
        let xs = [1.0, 2.0, 3.0, 4.0];
        let ys = [3.0, 5.0, 7.0, 9.0];
        let f = fit(&tl(TrendKind::Linear), &xs, &ys).unwrap();
        assert!(((f.eval)(5.0) - 11.0).abs() < 1e-9);
        assert_eq!(f.equation.as_deref(), Some("y = 2x + 1"));
        assert!((f.r2.unwrap() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn every_type_fits_its_own_curve__feat__sheet_chart_series_features() {
        let xs: Vec<f64> = (1..=6).map(f64::from).collect();
        let exp: Vec<f64> = xs.iter().map(|x| 2.0 * (0.5 * x).exp()).collect();
        let f = fit(&tl(TrendKind::Exponential), &xs, &exp).unwrap();
        assert!(((f.eval)(3.0) - exp[2]).abs() < 1e-9);
        let pow: Vec<f64> = xs.iter().map(|x| 3.0 * x.powf(1.5)).collect();
        let f = fit(&tl(TrendKind::Power), &xs, &pow).unwrap();
        assert!(((f.eval)(4.0) - pow[3]).abs() < 1e-9);
        let log: Vec<f64> = xs.iter().map(|x| 4.0 * x.ln() + 1.0).collect();
        let f = fit(&tl(TrendKind::Logarithmic), &xs, &log).unwrap();
        assert!(((f.eval)(2.0) - log[1]).abs() < 1e-9);
        let quad: Vec<f64> = xs.iter().map(|x| x * x - 2.0 * x + 3.0).collect();
        let f = fit(&tl(TrendKind::Polynomial(2)), &xs, &quad).unwrap();
        assert!(((f.eval)(5.0) - 18.0).abs() < 1e-6);
        assert_eq!(moving_average(&xs, &quad, 2).len(), 5);
    }

    #[test]
    fn error_ends_by_type__feat__sheet_chart_series_features() {
        let mut eb = ErrorBars {
            along_x: false,
            bar_type: ErrorBarType::Both,
            value: ErrorValue::Fixed(1.0),
            no_end_cap: false,
            line: None,
        };
        let v = [2.0, 4.0];
        assert_eq!(error_ends(&eb, &v, None)[0], Some((1.0, 3.0)));
        eb.value = ErrorValue::Percentage(50.0);
        assert_eq!(error_ends(&eb, &v, None)[1], Some((2.0, 6.0)));
        eb.bar_type = ErrorBarType::Plus;
        assert_eq!(error_ends(&eb, &v, None)[1], Some((4.0, 6.0)));
        eb.bar_type = ErrorBarType::Both;
        eb.value = ErrorValue::StdDev(1.0);
        let e = error_ends(&eb, &v, None);
        let sd = 2f64.sqrt();
        assert!((e[0].unwrap().0 - (3.0 - sd)).abs() < 1e-12);
    }
}
