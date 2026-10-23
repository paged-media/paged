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

//! `FORECAST.ETS` and its companions: additive-error, additive-trend,
//! additive-seasonality exponential smoothing (the "AAA" model Microsoft's
//! documentation names), built from the published method (Hyndman et al.,
//! *Forecasting with Exponential Smoothing*, 2008).
//!
//! - **Timeline.** Values are sorted by the timeline; the step is the
//!   smallest positive difference and every difference must be a multiple
//!   of it (else `#NUM!`). Duplicate points are aggregated (`aggregation`
//!   1–7: AVERAGE, COUNT, COUNTA, MAX, MEDIAN, MIN, SUM); a missing point is
//!   the mean of its neighbours (`data_completion` 1) or 0 (`0`).
//! - **Seasonality.** Detected as the strongest autocorrelation peak of the
//!   linearly detrended series between lag 2 and `(n−1)/2`; none → no
//!   seasonal component. An explicit length up to 8760 is taken as given.
//! - **Fit.** Initial states by classical decomposition (a centred moving
//!   average for the seasonal indices, a regression of the first ten
//!   seasonally adjusted points for level and trend); α, β, γ minimise the
//!   one-step squared error over `[0.001, 0.999]` (a coarse grid refined by
//!   coordinate search).
//! - **Divergence.** Excel's optimiser and initial states are not published;
//!   forecasts agree with Excel where the model fits the series exactly and
//!   differ in the later digits elsewhere (listed rows in
//!   `oracle/excel/divergences.tsv`). Seasonality detection, the argument
//!   checks and the statistics on exact fits agree.

use sheet_core::{CellError, CellValue};

use super::stat2::std_norm_inv;
use super::util::{finite, flat, num};
use crate::arg::Arg;
use crate::ctx::EvalCtx;

type R<T> = Result<T, CellError>;

/// The regular series prepared from `(values, timeline)`.
struct Series {
    y: Vec<f64>,
    t0: f64,
    step: f64,
}

fn opt_int(args: &[Arg], i: usize, default: f64) -> R<f64> {
    match args.get(i) {
        None | Some(Arg::Scalar(CellValue::Empty)) => Ok(default),
        Some(a) => Ok(num(Some(a))?.trunc()),
    }
}

fn aggregate(v: &mut [f64], how: f64) -> f64 {
    let n = v.len() as f64;
    match how as i32 {
        2 | 3 => n,
        4 => v.iter().copied().fold(f64::MIN, f64::max),
        5 => {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let k = v.len();
            if k % 2 == 1 {
                v[k / 2]
            } else {
                (v[k / 2 - 1] + v[k / 2]) / 2.0
            }
        }
        6 => v.iter().copied().fold(f64::MAX, f64::min),
        7 => v.iter().sum(),
        _ => v.iter().sum::<f64>() / n,
    }
}

fn series(values: &Arg, timeline: &Arg, completion: f64, agg: f64) -> R<Series> {
    let vs = flat(values);
    let ts = flat(timeline);
    if vs.len() != ts.len() {
        return Err(CellError::Na);
    }
    let mut pts = Vec::new();
    for (v, t) in vs.iter().zip(&ts) {
        let t = match t {
            CellValue::Number(t) => *t,
            CellValue::Error(e) => return Err(*e),
            _ => return Err(CellError::Value),
        };
        match v {
            CellValue::Number(v) => pts.push((t, *v)),
            CellValue::Error(e) => return Err(*e),
            _ => {}
        }
    }
    if pts.len() < 3 {
        return Err(CellError::Num);
    }
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    // Aggregate duplicates.
    let mut grouped: Vec<(f64, Vec<f64>)> = Vec::new();
    for (t, v) in pts {
        match grouped.last_mut() {
            Some(g) if g.0 == t => g.1.push(v),
            _ => grouped.push((t, vec![v])),
        }
    }
    let pts: Vec<(f64, f64)> = grouped
        .into_iter()
        .map(|(t, mut v)| (t, aggregate(&mut v, agg)))
        .collect();
    if pts.len() < 3 {
        return Err(CellError::Num);
    }
    let step = pts
        .windows(2)
        .map(|w| w[1].0 - w[0].0)
        .fold(f64::MAX, f64::min);
    if step <= 0.0 {
        return Err(CellError::Num);
    }
    let t0 = pts[0].0;
    let mut y: Vec<Option<f64>> = Vec::new();
    for (t, v) in &pts {
        let k = (t - t0) / step;
        if (k - k.round()).abs() > 1e-9 {
            return Err(CellError::Num);
        }
        let k = k.round() as usize;
        if k > 100_000 {
            return Err(CellError::Num);
        }
        y.resize(k + 1, None);
        y[k] = Some(*v);
    }
    let n = y.len();
    let mut out = vec![0.0; n];
    for i in 0..n {
        out[i] = match y[i] {
            Some(v) => v,
            None if completion == 0.0 => 0.0,
            None => {
                let prev = (0..i).rev().find_map(|j| y[j]).unwrap_or(0.0);
                let next = (i + 1..n).find_map(|j| y[j]).unwrap_or(prev);
                (prev + next) / 2.0
            }
        };
    }
    Ok(Series { y: out, t0, step })
}

/// The detected season length (0: none).
fn detect_season(y: &[f64]) -> usize {
    let n = y.len();
    if n < 5 {
        return 0;
    }
    let nf = n as f64;
    let mx = (nf - 1.0) / 2.0;
    let my = y.iter().sum::<f64>() / nf;
    let sxx: f64 = (0..n).map(|i| (i as f64 - mx).powi(2)).sum();
    let b = (0..n).map(|i| (i as f64 - mx) * (y[i] - my)).sum::<f64>() / sxx;
    let r: Vec<f64> = (0..n).map(|i| y[i] - (my + b * (i as f64 - mx))).collect();
    let c0: f64 = r.iter().map(|v| v * v).sum();
    if c0 <= 1e-12 * y.iter().map(|v| v * v).sum::<f64>().max(1e-300) {
        return 0;
    }
    let acf = |k: usize| (0..n - k).map(|i| r[i] * r[i + k]).sum::<f64>() / c0;
    let max_lag = (n - 1) / 2;
    let mut best = (0, f64::MIN);
    for k in 2..=max_lag {
        let a = acf(k);
        if a > acf(k - 1) && a >= acf(k + 1) && a > best.1 {
            best = (k, a);
        }
    }
    if best.1 > 0.0 {
        best.0
    } else {
        0
    }
}

/// Initial `(level, trend, seasonal indices)`.
fn init_states(y: &[f64], m: usize) -> (f64, f64, Vec<f64>) {
    let n = y.len();
    let mut s = vec![0.0; m];
    if m >= 2 {
        let h = m / 2;
        let mut sums = vec![0.0; m];
        let mut counts = vec![0usize; m];
        for i in h..n.saturating_sub(h) {
            let ma = if m.is_multiple_of(2) {
                (0.5 * y[i - h] + y[i + 1 - h..i + h].iter().sum::<f64>() + 0.5 * y[i + h])
                    / m as f64
            } else {
                y[i - h..=i + h].iter().sum::<f64>() / m as f64
            };
            sums[i % m] += y[i] - ma;
            counts[i % m] += 1;
        }
        for j in 0..m {
            s[j] = if counts[j] > 0 {
                sums[j] / counts[j] as f64
            } else {
                0.0
            };
        }
        let mu = s.iter().sum::<f64>() / m as f64;
        for v in &mut s {
            *v -= mu;
        }
    }
    let k = n.min(10);
    let adj: Vec<f64> = (0..k)
        .map(|i| y[i] - if m >= 2 { s[i % m] } else { 0.0 })
        .collect();
    let mx = (k as f64 + 1.0) / 2.0;
    let my = adj.iter().sum::<f64>() / k as f64;
    let sxx: f64 = (1..=k).map(|x| (x as f64 - mx).powi(2)).sum();
    let b = (1..=k)
        .map(|x| (x as f64 - mx) * (adj[x - 1] - my))
        .sum::<f64>()
        / sxx;
    (my - b * mx, b, s)
}

/// A fitted model.
struct Fit {
    alpha: f64,
    beta: f64,
    gamma: f64,
    m: usize,
    level: f64,
    trend: f64,
    season: Vec<f64>,
    errors: Vec<f64>,
}

fn run(y: &[f64], m: usize, p: (f64, f64, f64), init: &(f64, f64, Vec<f64>)) -> Fit {
    let (a, b, g) = p;
    let (mut l, mut t) = (init.0, init.1);
    let mut s = init.2.clone();
    let mut errors = Vec::with_capacity(y.len());
    for (i, &yi) in y.iter().enumerate() {
        let si = if m >= 2 { s[i % m] } else { 0.0 };
        let e = yi - (l + t + si);
        errors.push(e);
        let ln = l + t + a * e;
        t += a * b * e;
        if m >= 2 {
            s[i % m] = si + g * e;
        }
        l = ln;
    }
    Fit {
        alpha: a,
        beta: b,
        gamma: g,
        m,
        level: l,
        trend: t,
        season: s,
        errors,
    }
}

fn sse(f: &Fit) -> f64 {
    f.errors.iter().map(|e| e * e).sum()
}

fn fit(y: &[f64], m: usize) -> Fit {
    let init = init_states(y, m);
    let lo = 0.001;
    let hi = 0.999;
    let grid = [0.001, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999];
    let mut best = (f64::MAX, (0.5, 0.5, 0.5));
    for &a in &grid {
        for &b in &grid {
            for &g in if m >= 2 { &grid[..] } else { &grid[..1] } {
                let v = sse(&run(y, m, (a, b, g), &init));
                if v < best.0 {
                    best = (v, (a, b, g));
                }
            }
        }
    }
    // Coordinate search with a shrinking step.
    let mut step = 0.1;
    let mut p = best.1;
    let mut cur = best.0;
    while step >= 1e-4 {
        let mut improved = false;
        for k in 0..3 {
            if k == 2 && m < 2 {
                continue;
            }
            for dir in [-1.0, 1.0] {
                let mut q = p;
                let v = match k {
                    0 => &mut q.0,
                    1 => &mut q.1,
                    _ => &mut q.2,
                };
                *v = (*v + dir * step).clamp(lo, hi);
                let e = sse(&run(y, m, q, &init));
                if e < cur {
                    cur = e;
                    p = q;
                    improved = true;
                }
            }
        }
        if !improved {
            step /= 2.0;
        }
    }
    if m < 2 {
        p.2 = 0.0;
    }
    run(y, m, p, &init)
}

/// The common arguments: `(series, fit, horizon)` for a target date.
fn prepare(args: &[Arg], values_at: usize, season_at: usize) -> R<(Series, Fit)> {
    let season = opt_int(args, season_at, 1.0)?;
    let completion = opt_int(args, season_at + 1, 1.0)?;
    let agg = opt_int(args, season_at + 2, 1.0)?;
    if !(0.0..=8760.0).contains(&season)
        || !(0.0..=1.0).contains(&completion)
        || !(1.0..=7.0).contains(&agg)
    {
        return Err(CellError::Num);
    }
    let s = series(&args[values_at], &args[values_at + 1], completion, agg)?;
    let m = if season == 1.0 {
        detect_season(&s.y)
    } else {
        season as usize
    };
    if m >= 2 && m > s.y.len() / 2 {
        return Err(CellError::Num);
    }
    let f = fit(&s.y, m);
    Ok((s, f))
}

fn forecast_at(s: &Series, f: &Fit, target: f64) -> R<f64> {
    if target < s.t0 {
        return Err(CellError::Num);
    }
    let n = s.y.len();
    let h = (target - (s.t0 + (n as f64 - 1.0) * s.step)) / s.step;
    let mut v = f.level + h * f.trend;
    if f.m >= 2 {
        let k = (n as f64 - 1.0 + h.ceil()).max(0.0) as usize;
        v += f.season[k % f.m];
    }
    Ok(v)
}

/// `FORECAST.ETS(target_date, values, timeline, [seasonality],
/// [data_completion], [aggregation])`.
pub fn forecast_ets(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let r = (|| {
        let target = num(args.first())?;
        let (s, f) = prepare(args, 1, 3)?;
        forecast_at(&s, &f, target)
    })();
    match r {
        Ok(v) => finite(v),
        Err(e) => CellValue::Error(e),
    }
}

/// `FORECAST.ETS.CONFINT(target_date, values, timeline, [confidence_level],
/// [seasonality], [data_completion], [aggregation])`: the half-width of the
/// prediction interval, `z · √(MSE · (1 + Σ cⱼ²))`.
pub fn forecast_ets_confint(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let r = (|| {
        let target = num(args.first())?;
        let level = match args.get(3) {
            None | Some(Arg::Scalar(CellValue::Empty)) => 0.95,
            Some(a) => num(Some(a))?,
        };
        if !(0.0..1.0).contains(&level) {
            return Err(CellError::Num);
        }
        let (s, f) = prepare(args, 1, 4)?;
        forecast_at(&s, &f, target)?;
        let n = s.y.len();
        let h = ((target - (s.t0 + (n as f64 - 1.0) * s.step)) / s.step)
            .ceil()
            .max(1.0) as usize;
        let mse = f.errors.iter().map(|e| e * e).sum::<f64>() / n as f64;
        let mut var = 1.0;
        for j in 1..h {
            let seasonal = if f.m >= 2 && j % f.m == 0 {
                f.gamma
            } else {
                0.0
            };
            let c = f.alpha * (1.0 + j as f64 * f.beta) + seasonal;
            var += c * c;
        }
        if level == 0.0 {
            return Ok(0.0);
        }
        let z = -std_norm_inv((1.0 - level) / 2.0);
        Ok(z * (mse * var).sqrt())
    })();
    match r {
        Ok(v) => finite(v),
        Err(e) => CellValue::Error(e),
    }
}

/// `FORECAST.ETS.SEASONALITY(values, timeline, [data_completion],
/// [aggregation])`.
pub fn forecast_ets_seasonality(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let r = (|| {
        let completion = opt_int(args, 2, 1.0)?;
        let agg = opt_int(args, 3, 1.0)?;
        if !(0.0..=1.0).contains(&completion) || !(1.0..=7.0).contains(&agg) {
            return Err(CellError::Num);
        }
        let s = series(&args[0], &args[1], completion, agg)?;
        Ok(detect_season(&s.y) as f64)
    })();
    match r {
        Ok(v) => finite(v),
        Err(e) => CellValue::Error(e),
    }
}

/// `FORECAST.ETS.STAT(values, timeline, statistic_type, [seasonality],
/// [data_completion], [aggregation])`: 1 α, 2 β, 3 γ, 4 MASE, 5 SMAPE,
/// 6 MAE, 7 RMSE, 8 the step.
pub fn forecast_ets_stat(args: &[Arg], _ctx: &EvalCtx) -> CellValue {
    let r = (|| {
        let kind = num(args.get(2))?.trunc();
        if !(1.0..=8.0).contains(&kind) {
            return Err(CellError::Num);
        }
        let (s, f) = prepare(args, 0, 3)?;
        let n = s.y.len() as f64;
        let mae = f.errors.iter().map(|e| e.abs()).sum::<f64>() / n;
        Ok(match kind as i32 {
            1 => f.alpha,
            2 => f.beta,
            3 => f.gamma,
            4 => {
                let lag = if f.m >= 2 { f.m } else { 1 };
                let d: Vec<f64> =
                    s.y.windows(lag + 1)
                        .map(|w| (w[lag] - w[0]).abs())
                        .collect();
                let scale = d.iter().sum::<f64>() / d.len().max(1) as f64;
                if scale == 0.0 {
                    0.0
                } else {
                    mae / scale
                }
            }
            5 => {
                f.errors
                    .iter()
                    .zip(&s.y)
                    .map(|(e, y)| {
                        let fc = y - e;
                        let d = y.abs() + fc.abs();
                        if d == 0.0 {
                            0.0
                        } else {
                            2.0 * e.abs() / d
                        }
                    })
                    .sum::<f64>()
                    / n
            }
            6 => mae,
            7 => (f.errors.iter().map(|e| e * e).sum::<f64>() / n).sqrt(),
            _ => s.step,
        })
    })();
    match r {
        Ok(v) => finite(v),
        Err(e) => CellValue::Error(e),
    }
}
