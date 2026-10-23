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

//! Value axes: Excel's automatic bounds and major unit, logarithmic and
//! reversed scales, and the value→pt map.
//!
//! AUTOMATIC BOUNDS (Excel's rule, the one paged.slide reads PowerPoint's
//! charts with too): the data extent widened by 5% headroom on the side(s)
//! away from zero, a 1-2-5 major unit for that span, the bounds rounded out
//! to the unit. Zero is included unless every value is on one side of it and
//! the spread is under a sixth of the largest magnitude — then the axis
//! starts near the data, as Excel's does. An explicit min, max or unit wins.

use crate::model::{Axis, Crosses};

/// A value axis mapped onto a pt interval.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scale {
    pub min: f64,
    pub max: f64,
    pub unit: f64,
    pub minor: f64,
    /// Logarithmic base.
    pub log: Option<f64>,
    pub reversed: bool,
    /// The pt position of `min` and `max` (before reversal).
    pub a: f64,
    pub b: f64,
}

impl Scale {
    /// Excel's automatic scale for data in `lo..=hi` under `axis`'s
    /// overrides. `percent` = a percent-stacked axis (0..1 unless set).
    pub fn auto(lo: f64, hi: f64, axis: &Axis, percent: bool) -> Scale {
        let (mut lo, mut hi) = if lo.is_finite() && hi.is_finite() {
            (lo, hi)
        } else {
            (0.0, 1.0)
        };
        if percent {
            lo = lo.min(0.0);
            hi = if hi > 0.0 { 1.0 } else { 0.0 };
            if lo < 0.0 {
                lo = -1.0;
            }
        }
        if let Some(base) = axis.log_base.filter(|b| *b > 1.0) {
            return Scale::log(lo, hi, base, axis);
        }
        let span_data = hi - lo;
        let near_data = lo > 0.0 && span_data < hi / 6.0;
        let near_data_neg = hi < 0.0 && span_data < -lo / 6.0;
        let (mut bottom, mut top) = (lo.min(0.0), hi.max(0.0));
        if near_data {
            bottom = lo;
        }
        if near_data_neg {
            top = hi;
        }
        if top == bottom {
            top = bottom + if bottom == 0.0 { 1.0 } else { bottom.abs() };
        }
        let span = top - bottom;
        let head_top = if top > 0.0 || near_data_neg {
            top + 0.05 * span
        } else {
            0.0
        };
        let head_bottom = if bottom < 0.0 || near_data {
            bottom - 0.05 * span
        } else {
            0.0
        };
        let (head_top, head_bottom) = if percent {
            (top, bottom)
        } else {
            (head_top, head_bottom)
        };
        let unit = axis
            .major_unit
            .filter(|u| *u > 0.0)
            .unwrap_or_else(|| nice_unit(head_top - head_bottom));
        let mut min = axis.min.unwrap_or((head_bottom / unit).floor() * unit);
        let mut max = axis.max.unwrap_or((head_top / unit).ceil() * unit);
        if near_data && axis.min.is_none() && min < 0.0 {
            min = 0.0;
        }
        if max <= min {
            max = min + unit;
        }
        if !min.is_finite() || !max.is_finite() {
            min = 0.0;
            max = 1.0;
        }
        Scale {
            min,
            max,
            unit,
            minor: axis.minor_unit.filter(|u| *u > 0.0).unwrap_or(unit / 5.0),
            log: None,
            reversed: axis.reversed,
            a: 0.0,
            b: 1.0,
        }
    }

    fn log(lo: f64, hi: f64, base: f64, axis: &Axis) -> Scale {
        let lo = if lo > 0.0 { lo } else { 1.0 };
        let hi = if hi > 0.0 { hi.max(lo) } else { lo * base };
        let lmin = axis
            .min
            .filter(|m| *m > 0.0)
            .unwrap_or_else(|| base.powf(lo.log(base).floor()));
        let mut lmax = axis
            .max
            .filter(|m| *m > 0.0)
            .unwrap_or_else(|| base.powf(hi.log(base).ceil()));
        if lmax <= lmin {
            lmax = lmin * base;
        }
        Scale {
            min: lmin,
            max: lmax,
            unit: axis.major_unit.filter(|u| *u > 1.0).unwrap_or(base),
            minor: base,
            log: Some(base),
            reversed: axis.reversed,
            a: 0.0,
            b: 1.0,
        }
    }

    /// The same scale over the pt interval `a..b` (`a` is where `min` sits).
    pub fn on(self, a: f64, b: f64) -> Scale {
        Scale { a, b, ..self }
    }

    /// `v`'s fraction of the axis, 0 at `min`, 1 at `max` (unclamped).
    pub fn frac(&self, v: f64) -> f64 {
        let f = match self.log {
            Some(base) => {
                let v = if v > 0.0 { v } else { self.min };
                (v.log(base) - self.min.log(base)) / (self.max.log(base) - self.min.log(base))
            }
            None => (v - self.min) / (self.max - self.min),
        };
        if self.reversed {
            1.0 - f
        } else {
            f
        }
    }

    /// `v` in pt.
    pub fn px(&self, v: f64) -> f64 {
        self.a + (self.b - self.a) * self.frac(v)
    }

    /// `v` in pt, clamped to the axis.
    pub fn px_clamped(&self, v: f64) -> f64 {
        let f = self.frac(v).clamp(0.0, 1.0);
        self.a + (self.b - self.a) * f
    }

    /// The major tick values, `min` to `max`.
    pub fn ticks(&self) -> Vec<f64> {
        self.steps(self.unit)
    }

    /// The minor tick values (excluding the major ones).
    pub fn minor_ticks(&self) -> Vec<f64> {
        if let Some(base) = self.log {
            let mut out = Vec::new();
            for m in self.ticks() {
                for k in 2..(base as i64).min(10) {
                    let v = m * k as f64;
                    if v < self.max {
                        out.push(v);
                    }
                }
            }
            return out;
        }
        let major = self.ticks();
        self.steps(self.minor)
            .into_iter()
            .filter(|v| !major.iter().any(|m| (m - v).abs() < self.minor * 1e-6))
            .collect()
    }

    fn steps(&self, unit: f64) -> Vec<f64> {
        if let Some(base) = self.log {
            let step = if unit > 1.0 { unit } else { base };
            let mut out = Vec::new();
            let mut v = self.min;
            while v <= self.max * (1.0 + 1e-9) && out.len() < 200 {
                out.push(v);
                v *= step;
            }
            return out;
        }
        if unit <= 0.0 || !unit.is_finite() {
            return vec![self.min, self.max];
        }
        let n = ((self.max - self.min) / unit + 1e-9).floor() as i64;
        if !(0..=500).contains(&n) {
            return vec![self.min, self.max];
        }
        (0..=n)
            .map(|i| {
                let v = self.min + i as f64 * unit;
                // Kill float residue (0.30000000000000004).
                let r = (v / unit).round() * unit;
                if (r - v).abs() < unit * 1e-9 {
                    clean(r)
                } else {
                    clean(v)
                }
            })
            .collect()
    }

    /// The value where the perpendicular axis crosses this one.
    pub fn cross_value(&self, crosses: Crosses) -> f64 {
        match crosses {
            Crosses::Min => self.min,
            Crosses::Max => self.max,
            Crosses::At(v) => v.clamp(self.min, self.max),
            Crosses::AutoZero => {
                if self.log.is_some() {
                    self.min
                } else {
                    0.0f64.clamp(self.min, self.max)
                }
            }
        }
    }
}

/// Round away binary residue to 12 significant digits.
fn clean(v: f64) -> f64 {
    if v == 0.0 {
        return 0.0;
    }
    let mag = 10f64.powi(11 - v.abs().log10().floor() as i32);
    (v * mag).round() / mag
}

/// Excel's major unit for a span: a 1, 2 or 5 step giving about five to ten
/// intervals.
pub fn nice_unit(range: f64) -> f64 {
    if range <= 0.0 || !range.is_finite() {
        return 1.0;
    }
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

#[cfg(test)]
#[allow(non_snake_case)] // `__feat__<id>` test-name links (cockpit rule)
mod tests {
    use super::*;

    #[test]
    fn excel_bounds_with_headroom__feat__sheet_chart_axes() {
        // 10..30: span 30 → 31.5 with headroom → unit 5 → 0..35.
        let s = Scale::auto(10.0, 30.0, &Axis::default(), false);
        assert_eq!((s.min, s.max, s.unit), (0.0, 35.0, 5.0));
        // Negative values reach below zero.
        let s = Scale::auto(-12.0, 20.0, &Axis::default(), false);
        assert!(s.min < -12.0 && s.max > 20.0);
        // A narrow band far from zero starts near the data.
        let s = Scale::auto(100.0, 110.0, &Axis::default(), false);
        assert!(s.min > 0.0 && s.min <= 100.0 && s.max >= 110.0);
        // Percent-stacked runs 0..100%.
        let s = Scale::auto(0.0, 0.8, &Axis::default(), true);
        assert_eq!((s.min, s.max), (0.0, 1.0));
    }

    #[test]
    fn overrides_win__feat__sheet_chart_axes() {
        let axis = Axis {
            min: Some(5.0),
            max: Some(50.0),
            major_unit: Some(15.0),
            ..Axis::default()
        };
        let s = Scale::auto(10.0, 30.0, &axis, false);
        assert_eq!(s.ticks(), vec![5.0, 20.0, 35.0, 50.0]);
    }

    #[test]
    fn log_and_reversed__feat__sheet_chart_axes() {
        let axis = Axis {
            log_base: Some(10.0),
            ..Axis::default()
        };
        let s = Scale::auto(3.0, 4000.0, &axis, false).on(0.0, 300.0);
        assert_eq!(s.ticks(), vec![1.0, 10.0, 100.0, 1000.0, 10000.0]);
        assert!((s.px(100.0) - 150.0).abs() < 1e-9);
        let r = Scale {
            reversed: true,
            ..Scale::auto(0.0, 10.0, &Axis::default(), false)
        }
        .on(0.0, 100.0);
        assert!(r.px(r.min) > r.px(r.max));
    }
}
