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

//! Conditional-format evaluation (W2.4, sheet ADR 523). Every rule kind of
//! [`sheet_core::condfmt`] evaluates here, because a rule may need the
//! formula evaluator (`cellIs` operands, `expression`, threshold formulas):
//! `cellIs`, `expression`, top/bottom N and N %, above/below the average
//! (with standard deviations), duplicate/unique, text, time periods
//! (volatile: today is the engine's clock), blanks and errors, colour
//! scales (every threshold kind), data bars (negative bars, axis, direction,
//! lengths) and icon sets (custom icons included).
//!
//! ## Stacking
//!
//! The rules covering a cell are taken in priority order (lowest first,
//! document order on ties). A matching rule's differential format merges
//! under what earlier rules set (an earlier rule's facet wins); the first
//! matching colour scale, data bar and icon set are taken; a matching rule
//! with `stopIfTrue` ends the walk — as Excel stacks them.
//!
//! ## Cost
//!
//! Whole-range statistics (sorted values, mean and deviation, value counts,
//! thresholds) are computed once per rule and kept in a [`CfCache`] the
//! caller holds for as long as the values do not change (the session keeps
//! one per recalc); a cell then costs its rules' tests. A surface asks only
//! for the cells it shows.

use std::collections::HashMap;

use sheet_core::condfmt::{
    AxisPosition, BarDirection, CfBlock, CfKind, CfOp, CfTextOp, CfTimePeriod, Cfvo, CfvoKind,
    DataBarRule, IconSetRule, SheetCf,
};
use sheet_core::visual::{CellFill, ColorRef, DifferentialFormat, FontDelta};
use sheet_core::{CellValue, Formula, SheetId, SheetModel};
use sheet_format::resolve::{resolve, ColorPalette};

use crate::Engine;

/// A data bar to draw in a cell: its extent across the cell width (0..1,
/// `start <= end`), whether it is a negative bar, its colours and the axis.
#[derive(Clone, Debug, PartialEq)]
pub struct BarOutcome {
    pub start: f64,
    pub end: f64,
    pub negative: bool,
    pub color: (u8, u8, u8),
    pub color_swatch: Option<String>,
    pub border: Option<(u8, u8, u8)>,
    pub gradient: bool,
    /// The axis position across the cell (0..1), when drawn.
    pub axis: Option<f64>,
    pub axis_color: (u8, u8, u8),
    pub show_value: bool,
}

/// An icon to draw in a cell: its set and position in the set.
#[derive(Clone, Debug, PartialEq)]
pub struct IconOutcome {
    pub set: String,
    pub index: u32,
    pub show_value: bool,
}

/// What conditional formatting does to one cell.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CfOutcome {
    /// The merged differential format of the matching dxf rules.
    pub dxf: Option<DifferentialFormat>,
    /// A colour scale's fill (resolved RGB).
    pub scale: Option<(u8, u8, u8)>,
    pub bar: Option<BarOutcome>,
    pub icon: Option<IconOutcome>,
}

impl CfOutcome {
    pub fn is_empty(&self) -> bool {
        self.dxf.is_none() && self.scale.is_none() && self.bar.is_none() && self.icon.is_none()
    }

    /// The value text is hidden (a bar or icon with `showValue="0"`).
    pub fn hides_value(&self) -> bool {
        self.bar.as_ref().is_some_and(|b| !b.show_value)
            || self.icon.as_ref().is_some_and(|i| !i.show_value)
    }
}

/// Per-rule statistics over the rule's ranges.
#[derive(Clone, Debug, Default)]
struct Stats {
    /// The numbers, ascending (shared by the rules over the same ranges).
    sorted: std::rc::Rc<Vec<f64>>,
    mean: f64,
    /// Sample standard deviation (Excel's `STDEV`).
    std_dev: f64,
    /// Value counts (duplicate / unique), keyed case-insensitively.
    counts: HashMap<DupKey, u32>,
    /// The resolved thresholds of a scale / bar / icon set.
    thresholds: Vec<Option<f64>>,
}

/// The parsed formulas of one rule (at the block anchor).
#[derive(Clone, Debug, Default)]
struct Compiled {
    formulas: Vec<Option<Formula>>,
}

/// What evaluation keeps between cells (and between surfaces, for as long
/// as the values stand): parsed formulas and whole-range statistics, keyed
/// `(block, rule)`.
#[derive(Debug, Default)]
pub struct CfCache {
    compiled: HashMap<(usize, usize), Compiled>,
    stats: HashMap<(usize, usize), Stats>,
    /// The sorted numbers of a range set, shared between its rules.
    numbers: HashMap<Vec<sheet_core::condfmt::CfRange>, std::rc::Rc<Vec<f64>>>,
}

impl CfCache {
    pub fn new() -> CfCache {
        CfCache::default()
    }
}

/// The context one evaluation runs in.
pub struct CfContext<'a> {
    pub engine: &'a Engine,
    pub sheet: SheetId,
    pub cf: &'a SheetCf,
    pub palette: &'a ColorPalette,
}

/// A formula parse context over the model (sheet and name resolution).
struct ParseCtx<'a> {
    model: &'a SheetModel,
    current: SheetId,
}

impl sheet_parser::ParseCtx for ParseCtx<'_> {
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

/// Parse a rule's formula text (a leading `=` tolerated).
fn parse_formula(model: &SheetModel, sheet: SheetId, text: &str) -> Option<Formula> {
    let text = text.trim();
    let text = text.strip_prefix('=').unwrap_or(text);
    let ctx = ParseCtx {
        model,
        current: sheet,
    };
    sheet_parser::parse(&sheet_parser::strip_storage_prefixes(text), &ctx).ok()
}

impl CfContext<'_> {
    fn model(&self) -> &SheetModel {
        self.engine.model()
    }

    fn value(&self, row: u32, col: u32) -> CellValue {
        self.model()
            .sheet(self.sheet)
            .and_then(|ws| ws.cell(row, col))
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    /// Visit every populated value in a block's ranges (each cell once;
    /// overlapping ranges are rare, so the seen-set is kept only for them).
    fn visit_block(&self, block: &CfBlock, mut f: impl FnMut(&CellValue)) {
        let Some(ws) = self.model().sheet(self.sheet) else {
            return;
        };
        let overlap = block.ranges.len() > 1;
        let mut seen = std::collections::HashSet::new();
        for &(r0, c0, r1, c1) in &block.ranges {
            for (&(r, c), cell) in ws.cells.range((r0, c0)..=(r1, c1)) {
                if c < c0 || c > c1 || (overlap && !seen.insert((r, c))) {
                    continue;
                }
                f(&cell.value);
            }
        }
    }

    /// Evaluate formula `i` of rule `(b, r)` at a cell (`None`: no formula).
    fn eval(
        &self,
        cache: &mut CfCache,
        b: usize,
        r: usize,
        i: usize,
        row: u32,
        col: u32,
    ) -> Option<CellValue> {
        let block = &self.cf.blocks[b];
        let compiled = cache.compiled.entry((b, r)).or_insert_with(|| {
            let texts: Vec<&str> = match &block.rules[r].kind {
                CfKind::CellIs { formulas, .. } => formulas.iter().map(String::as_str).collect(),
                CfKind::Expression { formula } => vec![formula.as_str()],
                _ => Vec::new(),
            };
            Compiled {
                formulas: texts
                    .into_iter()
                    .map(|t| parse_formula(self.model(), self.sheet, t))
                    .collect(),
            }
        });
        let f = compiled.formulas.get(i)?.as_ref()?;
        let (ar, ac) = block.anchor();
        let (dr, dc) = (
            i64::from(row) - i64::from(ar),
            i64::from(col) - i64::from(ac),
        );
        let moved;
        let f = if dr == 0 && dc == 0 {
            f
        } else {
            moved = sheet_parser::rewrite_fill(f, dr, dc);
            &moved
        };
        Some(self.engine.eval_formula_at(self.sheet, row, col, f))
    }

    /// A threshold formula's value (evaluated at the block anchor).
    fn eval_text(&self, block: &CfBlock, text: &str) -> Option<f64> {
        if let Ok(n) = text.trim().parse::<f64>() {
            return Some(n);
        }
        let f = parse_formula(self.model(), self.sheet, text)?;
        let (r, c) = block.anchor();
        match self.engine.eval_formula_at(self.sheet, r, c, &f) {
            CellValue::Number(n) => Some(n),
            CellValue::Bool(b) => Some(f64::from(u8::from(b))),
            _ => None,
        }
    }

    fn stats<'c>(&self, cache: &'c mut CfCache, b: usize, r: usize) -> &'c Stats {
        if !cache.stats.contains_key(&(b, r)) {
            let s = self.compute_stats(cache, b, r);
            cache.stats.insert((b, r), s);
        }
        &cache.stats[&(b, r)]
    }

    fn compute_stats(&self, cache: &mut CfCache, b: usize, r: usize) -> Stats {
        let block = &self.cf.blocks[b];
        let rule = &block.rules[r];
        let mut s = Stats::default();
        let needs_numbers = matches!(
            rule.kind,
            CfKind::Top10 { .. }
                | CfKind::AboveAverage { .. }
                | CfKind::ColorScale { .. }
                | CfKind::DataBar(_)
                | CfKind::IconSet(_)
        );
        if needs_numbers {
            let sorted = match cache.numbers.get(&block.ranges) {
                Some(n) => n.clone(),
                None => {
                    let mut v = Vec::new();
                    self.visit_block(block, |x| {
                        if let CellValue::Number(n) = x {
                            if n.is_finite() {
                                v.push(*n);
                            }
                        }
                    });
                    v.sort_unstable_by(|a, b| a.total_cmp(b));
                    let rc = std::rc::Rc::new(v);
                    cache.numbers.insert(block.ranges.clone(), rc.clone());
                    rc
                }
            };
            let n = sorted.len() as f64;
            if n > 0.0 {
                s.mean = sorted.iter().sum::<f64>() / n;
            }
            if n > 1.0 {
                let ss: f64 = sorted.iter().map(|x| (x - s.mean).powi(2)).sum();
                s.std_dev = (ss / (n - 1.0)).sqrt();
            }
            s.sorted = sorted;
        }
        if let CfKind::Duplicates { .. } = rule.kind {
            let mut counts = HashMap::new();
            self.visit_block(block, |v| {
                if let Some(k) = dup_key(v) {
                    *counts.entry(k).or_insert(0) += 1;
                }
            });
            s.counts = counts;
        }
        let cfvos: &[Cfvo] = match &rule.kind {
            CfKind::ColorScale { cfvos, .. } => cfvos,
            CfKind::IconSet(is) => &is.cfvos,
            _ => &[],
        };
        s.thresholds = cfvos
            .iter()
            .map(|c| threshold(c, &s.sorted, |t| self.eval_text(block, t)))
            .collect();
        if let CfKind::DataBar(bar) = &rule.kind {
            s.thresholds = vec![
                bar_end(&bar.min, &s.sorted, true, |t| self.eval_text(block, t)),
                bar_end(&bar.max, &s.sorted, false, |t| self.eval_text(block, t)),
            ];
        }
        s
    }
}

/// What duplicate / unique rules count by: a number by its bits, text
/// lower-cased, booleans and errors by themselves.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum DupKey {
    Number(u64),
    Text(String),
    Bool(bool),
    Error(&'static str),
}

/// The key duplicate / unique rules count by (blanks are not counted).
fn dup_key(v: &CellValue) -> Option<DupKey> {
    match v {
        CellValue::Empty => None,
        CellValue::Text(t) if t.is_empty() => None,
        CellValue::Number(n) => Some(DupKey::Number((n + 0.0).to_bits())),
        CellValue::Text(t) => Some(DupKey::Text(t.to_lowercase().to_string())),
        CellValue::Bool(b) => Some(DupKey::Bool(*b)),
        CellValue::Error(e) => Some(DupKey::Error(e.as_str())),
    }
}

/// `PERCENTILE.INC` over sorted values.
fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let p = p.clamp(0.0, 1.0);
    let h = (sorted.len() - 1) as f64 * p;
    let lo = h.floor() as usize;
    let hi = h.ceil() as usize;
    Some(sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo as f64))
}

/// A threshold's value over the range's numbers.
fn threshold(c: &Cfvo, sorted: &[f64], eval: impl Fn(&str) -> Option<f64>) -> Option<f64> {
    let (min, max) = (sorted.first().copied(), sorted.last().copied());
    let val = || c.val.as_deref().and_then(&eval);
    match c.kind {
        CfvoKind::Min | CfvoKind::AutoMin => min,
        CfvoKind::Max | CfvoKind::AutoMax => max,
        CfvoKind::Num | CfvoKind::Formula => val(),
        CfvoKind::Percent => {
            let p = val()?;
            Some(min? + (max? - min?) * p / 100.0)
        }
        CfvoKind::Percentile => percentile(sorted, val()? / 100.0),
    }
}

/// A data bar end: `autoMin`/`autoMax` (and the 2006 min/max) take zero in
/// when the data stays on one side of it.
fn bar_end(c: &Cfvo, sorted: &[f64], low: bool, eval: impl Fn(&str) -> Option<f64>) -> Option<f64> {
    let v = threshold(c, sorted, eval)?;
    Some(match c.kind {
        CfvoKind::AutoMin => v.min(0.0),
        CfvoKind::AutoMax => v.max(0.0),
        _ if low && c.kind == CfvoKind::Min => v,
        _ => v,
    })
}

/// Excel's value comparison for `cellIs` (a blank is 0 against a number).
fn compare(a: &CellValue, b: &CellValue) -> std::cmp::Ordering {
    sheet_fn::coerce::compare(a, b)
}

fn truthy(v: &CellValue) -> bool {
    match v {
        CellValue::Number(n) => *n != 0.0,
        CellValue::Bool(b) => *b,
        _ => false,
    }
}

/// The cell's value as the text rules read it.
fn as_text(v: &CellValue) -> String {
    match v {
        CellValue::Text(t) => t.to_string(),
        CellValue::Empty => String::new(),
        other => sheet_format::format_general(other),
    }
}

/// Merge `later` under `earlier`: an earlier rule's facet wins.
fn merge_dxf(earlier: &mut DifferentialFormat, later: &DifferentialFormat) {
    match (&mut earlier.font, &later.font) {
        (Some(a), Some(b)) => {
            let f: &mut FontDelta = a;
            f.name = f.name.take().or_else(|| b.name.clone());
            f.size = f.size.or(b.size);
            f.bold = f.bold.or(b.bold);
            f.italic = f.italic.or(b.italic);
            f.underline = f.underline.or(b.underline);
            f.strike = f.strike.or(b.strike);
            f.vert_align = f.vert_align.or(b.vert_align);
            f.color = f.color.take().or_else(|| b.color.clone());
        }
        (None, Some(b)) => earlier.font = Some(b.clone()),
        _ => {}
    }
    if earlier.fill.as_ref().is_none_or(|f| *f == CellFill::None) {
        if let Some(f) = &later.fill {
            earlier.fill = Some(f.clone());
        }
    }
    match (&mut earlier.border, &later.border) {
        (Some(a), Some(b)) => {
            for (x, y) in [
                (&mut a.left, &b.left),
                (&mut a.right, &b.right),
                (&mut a.top, &b.top),
                (&mut a.bottom, &b.bottom),
            ] {
                if x.is_none() {
                    *x = y.clone();
                }
            }
        }
        (None, Some(b)) => earlier.border = Some(b.clone()),
        _ => {}
    }
    if earlier.num_fmt.is_none() {
        earlier.num_fmt = later.num_fmt.clone();
    }
}

/// The serial of today (whole day) from the engine's clock.
fn today(ctx: &CfContext<'_>) -> f64 {
    ctx.engine.now_serial().floor()
}

/// Weekday of a serial, 0 = Sunday (1900 system: serial 1 is a Sunday).
fn weekday(serial: f64) -> i64 {
    ((serial.floor() as i64 - 1) % 7 + 7) % 7
}

fn time_period_matches(ctx: &CfContext<'_>, period: CfTimePeriod, v: f64) -> bool {
    let t = today(ctx);
    let d = v.floor();
    let sys = ctx.model().calc.date_system;
    let ym =
        |s: f64| sheet_format::serial::serial_to_ymd(s, sys).map(|(y, m, _)| y * 12 + m as i32);
    let week_start = t - weekday(t) as f64;
    match period {
        CfTimePeriod::Today => d == t,
        CfTimePeriod::Yesterday => d == t - 1.0,
        CfTimePeriod::Tomorrow => d == t + 1.0,
        CfTimePeriod::Last7Days => d <= t && d > t - 7.0,
        CfTimePeriod::ThisWeek => d >= week_start && d < week_start + 7.0,
        CfTimePeriod::LastWeek => d >= week_start - 7.0 && d < week_start,
        CfTimePeriod::NextWeek => d >= week_start + 7.0 && d < week_start + 14.0,
        CfTimePeriod::ThisMonth => ym(d).is_some() && ym(d) == ym(t),
        CfTimePeriod::LastMonth => match (ym(d), ym(t)) {
            (Some(a), Some(b)) => a == b - 1,
            _ => false,
        },
        CfTimePeriod::NextMonth => match (ym(d), ym(t)) {
            (Some(a), Some(b)) => a == b + 1,
            _ => false,
        },
    }
}

/// Does dxf rule `(b, r)` match the cell?
fn dxf_matches(
    ctx: &CfContext<'_>,
    cache: &mut CfCache,
    b: usize,
    r: usize,
    row: u32,
    col: u32,
    v: &CellValue,
) -> bool {
    let rule = &ctx.cf.blocks[b].rules[r];
    match &rule.kind {
        CfKind::CellIs { op, .. } => {
            if matches!(v, CellValue::Error(_)) {
                return false;
            }
            let a = match ctx.eval(cache, b, r, 0, row, col) {
                Some(CellValue::Error(_)) | None => return false,
                Some(x) => x,
            };
            // A text cell is compared only with text, a number with numbers.
            let v = match v {
                CellValue::Empty if matches!(a, CellValue::Text(_)) => CellValue::from(""),
                CellValue::Empty => CellValue::Number(0.0),
                other => other.clone(),
            };
            use std::cmp::Ordering::*;
            let c = compare(&v, &a);
            match op {
                CfOp::Equal => c == Equal,
                CfOp::NotEqual => c != Equal,
                CfOp::GreaterThan => c == Greater,
                CfOp::GreaterThanOrEqual => c != Less,
                CfOp::LessThan => c == Less,
                CfOp::LessThanOrEqual => c != Greater,
                CfOp::Between | CfOp::NotBetween => {
                    let bb = match ctx.eval(cache, b, r, 1, row, col) {
                        Some(CellValue::Error(_)) | None => return false,
                        Some(x) => x,
                    };
                    let (lo, hi) = if compare(&a, &bb) == Greater {
                        (bb, a)
                    } else {
                        (a, bb)
                    };
                    let inside = compare(&v, &lo) != Less && compare(&v, &hi) != Greater;
                    if *op == CfOp::Between {
                        inside
                    } else {
                        !inside
                    }
                }
            }
        }
        CfKind::Expression { .. } => ctx
            .eval(cache, b, r, 0, row, col)
            .is_some_and(|x| truthy(&x)),
        CfKind::Top10 {
            rank,
            percent,
            bottom,
        } => {
            let CellValue::Number(n) = v else {
                return false;
            };
            let s = ctx.stats(cache, b, r);
            let len = s.sorted.len();
            if len == 0 {
                return false;
            }
            let k = if *percent {
                ((len as f64 * f64::from(*rank) / 100.0).floor() as usize).max(1)
            } else {
                *rank as usize
            }
            .clamp(1, len);
            if *bottom {
                *n <= s.sorted[k - 1]
            } else {
                *n >= s.sorted[len - k]
            }
        }
        CfKind::AboveAverage {
            above,
            equal,
            std_dev,
        } => {
            let CellValue::Number(n) = v else {
                return false;
            };
            let s = ctx.stats(cache, b, r);
            if s.sorted.is_empty() {
                return false;
            }
            let k = f64::from(*std_dev);
            let line = if *above {
                s.mean + k * s.std_dev
            } else {
                s.mean - k * s.std_dev
            };
            match (*above, *equal) {
                (true, false) => *n > line,
                (true, true) => *n >= line,
                (false, false) => *n < line,
                (false, true) => *n <= line,
            }
        }
        CfKind::Duplicates { unique } => {
            let Some(key) = dup_key(v) else {
                return false;
            };
            let count = ctx
                .stats(cache, b, r)
                .counts
                .get(&key)
                .copied()
                .unwrap_or(0);
            if *unique {
                count == 1
            } else {
                count > 1
            }
        }
        CfKind::Text { op, text } => {
            if matches!(v, CellValue::Error(_)) {
                return false;
            }
            let hay = as_text(v).to_lowercase();
            let needle = text.to_lowercase();
            match op {
                CfTextOp::Contains => hay.contains(&needle),
                CfTextOp::NotContains => !hay.contains(&needle),
                CfTextOp::BeginsWith => hay.starts_with(&needle),
                CfTextOp::EndsWith => hay.ends_with(&needle),
            }
        }
        CfKind::TimePeriod { period } => match v {
            CellValue::Number(n) => time_period_matches(ctx, *period, *n),
            _ => false,
        },
        CfKind::Blanks { blank } => {
            let is_blank = match v {
                CellValue::Empty => true,
                CellValue::Text(t) => t.trim().is_empty(),
                _ => false,
            };
            is_blank == *blank
        }
        CfKind::Errors { error } => matches!(v, CellValue::Error(_)) == *error,
        _ => false,
    }
}

/// Interpolate a colour scale at `n`.
fn scale_color(
    ctx: &CfContext<'_>,
    thresholds: &[Option<f64>],
    colors: &[ColorRef],
    n: f64,
) -> Option<(u8, u8, u8)> {
    let stops: Vec<(f64, (u8, u8, u8))> = thresholds
        .iter()
        .zip(colors)
        .filter_map(|(t, c)| Some(((*t)?, resolve(c, ctx.palette)?.rgb)))
        .collect();
    if stops.len() < 2 {
        return None;
    }
    if n <= stops[0].0 {
        return Some(stops[0].1);
    }
    let last = stops[stops.len() - 1];
    if n >= last.0 {
        return Some(last.1);
    }
    for w in stops.windows(2) {
        let ((p0, c0), (p1, c1)) = (w[0], w[1]);
        if n >= p0 && n <= p1 {
            let t = if p1 > p0 { (n - p0) / (p1 - p0) } else { 0.0 };
            if t >= 1.0 {
                return Some(c1);
            }
            // Excel moves each channel from the lower stop by the share of
            // the difference TRUNCATED toward that stop (recorded, the cf
            // display lane: 192 of 194 cells; the two others are a recorded
            // divergence).
            let mix =
                |a: u8, b: u8| (f64::from(a) + ((f64::from(b) - f64::from(a)) * t).trunc()) as u8;
            return Some((mix(c0.0, c1.0), mix(c0.1, c1.1), mix(c0.2, c1.2)));
        }
    }
    Some(last.1)
}

/// A data bar's extent for `n`.
fn bar_outcome(
    ctx: &CfContext<'_>,
    bar: &DataBarRule,
    thresholds: &[Option<f64>],
    n: f64,
) -> Option<BarOutcome> {
    let lo = thresholds.first().copied().flatten()?;
    let hi = thresholds.get(1).copied().flatten()?;
    let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
    let minl = f64::from(bar.min_length.min(100)) / 100.0;
    let maxl = f64::from(bar.max_length.min(100)) / 100.0;
    let rgb = |c: &ColorRef| resolve(c, ctx.palette).map(|r| r.rgb);
    let pos_color = resolve(&bar.color, ctx.palette);
    let (color, swatch) = match &pos_color {
        Some(r) => (r.rgb, r.swatch.clone()),
        None => ((0x63, 0x8E, 0xC6), None),
    };
    let axis_color = bar.axis_color.as_ref().and_then(rgb).unwrap_or((0, 0, 0));
    let negative_data = lo < 0.0 && bar.axis_position != AxisPosition::None;
    let rtl = bar.direction == BarDirection::RightToLeft;
    let flip = |(s, e): (f64, f64)| if rtl { (1.0 - e, 1.0 - s) } else { (s, e) };
    if !negative_data {
        let span = hi - lo;
        let frac = if span > 0.0 {
            ((n - lo) / span).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let len = minl + (maxl - minl) * frac;
        let (start, end) = flip((0.0, len));
        return Some(BarOutcome {
            start,
            end,
            negative: false,
            color,
            color_swatch: swatch,
            border: if bar.border {
                bar.border_color.as_ref().and_then(rgb).or(Some(color))
            } else {
                None
            },
            gradient: bar.gradient,
            axis: None,
            axis_color,
            show_value: bar.show_value,
        });
    }
    // Negative values: the axis splits the cell (in the middle, or at the
    // zero point of the domain) and bars grow away from it.
    let hi = hi.max(0.0);
    let axis = match bar.axis_position {
        AxisPosition::Middle => 0.5,
        _ => {
            if hi - lo > 0.0 {
                -lo / (hi - lo)
            } else {
                0.5
            }
        }
    };
    let negative = n < 0.0;
    let (start, end) = if negative {
        let share = if lo < 0.0 {
            (n / lo).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (axis - axis * share, axis)
    } else {
        let share = if hi > 0.0 {
            (n / hi).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (axis, axis + (1.0 - axis) * share)
    };
    let (start, end) = flip((start, end));
    let neg_color = if negative && !bar.negative_same_as_positive {
        bar.negative_color
            .as_ref()
            .and_then(rgb)
            .unwrap_or((0xFF, 0x00, 0x00))
    } else {
        color
    };
    let border = if bar.border {
        let c = if negative && !bar.negative_same_as_positive {
            bar.negative_border_color.as_ref().and_then(rgb)
        } else {
            bar.border_color.as_ref().and_then(rgb)
        };
        c.or(Some(neg_color))
    } else {
        None
    };
    Some(BarOutcome {
        start,
        end,
        negative,
        color: neg_color,
        color_swatch: if negative { None } else { swatch },
        border,
        gradient: bar.gradient,
        axis: Some(if rtl { 1.0 - axis } else { axis }),
        axis_color,
        show_value: bar.show_value,
    })
}

/// The number of icons of a set.
pub fn icon_count(set: &str) -> u32 {
    set.chars().next().and_then(|c| c.to_digit(10)).unwrap_or(3)
}

/// An icon set's icon for `n`.
fn icon_outcome(is: &IconSetRule, thresholds: &[Option<f64>], n: f64) -> Option<IconOutcome> {
    let count = thresholds.len();
    if count == 0 {
        return None;
    }
    // The highest threshold the value reaches (index 0 is the floor).
    let mut pos = 0usize;
    for (i, t) in thresholds.iter().enumerate().skip(1) {
        let Some(t) = t else { continue };
        let reached = if is.cfvos.get(i).is_none_or(|c| c.gte) {
            n >= *t
        } else {
            n > *t
        };
        if reached {
            pos = i;
        }
    }
    let idx = if is.reverse { count - 1 - pos } else { pos };
    let (set, index) = match is.custom.get(pos).cloned().flatten() {
        Some((set, id)) => (set, id),
        None => (is.set.clone(), idx as u32),
    };
    if set == "NoIcons" {
        return None;
    }
    Some(IconOutcome {
        set,
        index,
        show_value: is.show_value,
    })
}

/// The conditional formatting of the cell at `(row, col)`, or `None` when
/// no rule covers it or none matches.
pub fn cell_outcome(
    ctx: &CfContext<'_>,
    cache: &mut CfCache,
    row: u32,
    col: u32,
) -> Option<CfOutcome> {
    // The rules covering the cell, by priority (document order on ties).
    let mut rules: Vec<(i64, usize, usize)> = Vec::new();
    for (b, block) in ctx.cf.blocks.iter().enumerate() {
        if !block.contains(row, col) {
            continue;
        }
        for (r, rule) in block.rules.iter().enumerate() {
            rules.push((rule.priority, b, r));
        }
    }
    if rules.is_empty() {
        return None;
    }
    rules.sort();
    let v = ctx.value(row, col);
    let mut out = CfOutcome::default();
    for (_, b, r) in rules {
        let rule = &ctx.cf.blocks[b].rules[r];
        let matched = match &rule.kind {
            CfKind::ColorScale { colors, .. } => match v {
                CellValue::Number(n) => {
                    let t = ctx.stats(cache, b, r).thresholds.clone();
                    match scale_color(ctx, &t, colors, n) {
                        Some(c) => {
                            if out.scale.is_none() {
                                out.scale = Some(c);
                            }
                            true
                        }
                        None => false,
                    }
                }
                _ => false,
            },
            CfKind::DataBar(bar) => match v {
                CellValue::Number(n) => {
                    let t = ctx.stats(cache, b, r).thresholds.clone();
                    match bar_outcome(ctx, bar, &t, n) {
                        Some(o) => {
                            if out.bar.is_none() {
                                out.bar = Some(o);
                            }
                            true
                        }
                        None => false,
                    }
                }
                _ => false,
            },
            CfKind::IconSet(is) => match v {
                CellValue::Number(n) => {
                    let t = ctx.stats(cache, b, r).thresholds.clone();
                    match icon_outcome(is, &t, n) {
                        Some(o) => {
                            if out.icon.is_none() {
                                out.icon = Some(o);
                            }
                            true
                        }
                        None => false,
                    }
                }
                _ => false,
            },
            CfKind::Unknown { .. } => false,
            _ => {
                let m = dxf_matches(ctx, cache, b, r, row, col, &v);
                if m {
                    if let Some(d) = &rule.dxf {
                        match &mut out.dxf {
                            Some(acc) => merge_dxf(acc, d),
                            None => out.dxf = Some(d.clone()),
                        }
                    }
                }
                m
            }
        };
        if matched && rule.stop_if_true {
            break;
        }
    }
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;
    use crate::EngineConfig;
    use sheet_core::condfmt::{CfRule, Cfvo};
    use sheet_core::visual::{CellFill, PatternKind};
    use sheet_core::Cell;

    fn engine(values: &[(u32, u32, CellValue)]) -> Engine {
        let mut m = SheetModel::new();
        let s = m.add_sheet("S");
        let ws = m.sheet_mut(s).unwrap();
        for (r, c, v) in values {
            ws.set_cell(
                *r,
                *c,
                Cell {
                    value: v.clone(),
                    ..Default::default()
                },
            );
        }
        Engine::new(
            m,
            EngineConfig {
                now_serial: 45000.5, // 2023-03-15, a Wednesday
                ..EngineConfig::default()
            },
        )
    }

    fn fill(rgb: (u8, u8, u8)) -> DifferentialFormat {
        DifferentialFormat {
            fill: Some(CellFill::Pattern {
                pattern: PatternKind::Solid,
                fg: Some(ColorRef::rgb(rgb.0, rgb.1, rgb.2)),
                bg: None,
            }),
            ..Default::default()
        }
    }

    fn rule(kind: CfKind, priority: i64) -> CfRule {
        CfRule {
            dxf: Some(fill((1, 2, 3))),
            ..CfRule::new(kind, priority)
        }
    }

    fn painted(e: &Engine, cf: &SheetCf, row: u32, col: u32) -> bool {
        let pal = ColorPalette::default();
        let ctx = CfContext {
            engine: e,
            sheet: 0,
            cf,
            palette: &pal,
        };
        cell_outcome(&ctx, &mut CfCache::new(), row, col).is_some_and(|o| o.dxf.is_some())
    }

    fn col_a(n: u32) -> Vec<(u32, u32, CellValue)> {
        (0..n)
            .map(|r| (r, 0, CellValue::Number(f64::from(r + 1))))
            .collect()
    }

    fn sheet(kind: CfKind, rows: u32) -> SheetCf {
        SheetCf {
            blocks: vec![CfBlock {
                ranges: vec![(0, 0, rows - 1, 0)],
                rules: vec![rule(kind, 1)],
                x14_only: false,
            }],
        }
    }

    #[test]
    fn dxf_rule_kinds__feat__sheet_lower_condfmt() {
        let e = engine(&col_a(10));
        // cellIs with a formula operand (relative to the anchor).
        let cf = sheet(
            CfKind::CellIs {
                op: CfOp::GreaterThan,
                formulas: vec!["$A$5+ROW()-ROW()".into()],
            },
            10,
        );
        assert!(!painted(&e, &cf, 4, 0) && painted(&e, &cf, 5, 0));
        // expression, relative reference moved per cell.
        let cf = sheet(
            CfKind::Expression {
                formula: "ISEVEN(A1)".into(),
            },
            10,
        );
        assert!(painted(&e, &cf, 1, 0) && !painted(&e, &cf, 2, 0));
        // top 3, bottom 20 %.
        let cf = sheet(
            CfKind::Top10 {
                rank: 3,
                percent: false,
                bottom: false,
            },
            10,
        );
        assert!(painted(&e, &cf, 7, 0) && !painted(&e, &cf, 6, 0));
        let cf = sheet(
            CfKind::Top10 {
                rank: 20,
                percent: true,
                bottom: true,
            },
            10,
        );
        assert!(painted(&e, &cf, 1, 0) && !painted(&e, &cf, 2, 0));
        // above average; one standard deviation below.
        let cf = sheet(
            CfKind::AboveAverage {
                above: true,
                equal: false,
                std_dev: 0,
            },
            10,
        );
        assert!(painted(&e, &cf, 5, 0) && !painted(&e, &cf, 4, 0));
        let cf = sheet(
            CfKind::AboveAverage {
                above: false,
                equal: false,
                std_dev: 1,
            },
            10,
        );
        // mean 5.5, sample sd 3.03: below 2.47.
        assert!(painted(&e, &cf, 1, 0) && !painted(&e, &cf, 2, 0));
    }

    #[test]
    fn value_kinds__feat__sheet_lower_condfmt() {
        let e = engine(&[
            (0, 0, CellValue::from("Apple")),
            (1, 0, CellValue::from("apple")),
            (2, 0, CellValue::from("Pear")),
            (3, 0, CellValue::Error(sheet_core::CellError::Div0)),
            (4, 0, CellValue::from("  ")),
            (6, 0, CellValue::Number(45000.0)),
            (7, 0, CellValue::Number(44996.0)),
            (8, 0, CellValue::Number(44990.0)),
        ]);
        let dup = sheet(CfKind::Duplicates { unique: false }, 9);
        assert!(painted(&e, &dup, 0, 0) && painted(&e, &dup, 1, 0) && !painted(&e, &dup, 2, 0));
        let uniq = sheet(CfKind::Duplicates { unique: true }, 9);
        assert!(painted(&e, &uniq, 2, 0) && !painted(&e, &uniq, 5, 0));
        let txt = sheet(
            CfKind::Text {
                op: CfTextOp::BeginsWith,
                text: "AP".into(),
            },
            9,
        );
        assert!(painted(&e, &txt, 1, 0) && !painted(&e, &txt, 2, 0) && !painted(&e, &txt, 3, 0));
        let blanks = sheet(CfKind::Blanks { blank: true }, 9);
        assert!(
            painted(&e, &blanks, 4, 0) && painted(&e, &blanks, 5, 0) && !painted(&e, &blanks, 0, 0)
        );
        let errors = sheet(CfKind::Errors { error: true }, 9);
        assert!(painted(&e, &errors, 3, 0) && !painted(&e, &errors, 2, 0));
        // Today is 45000 (a Wednesday); this week runs Sun 44998 .. Sat 45004.
        let today = sheet(
            CfKind::TimePeriod {
                period: CfTimePeriod::Today,
            },
            9,
        );
        assert!(painted(&e, &today, 6, 0) && !painted(&e, &today, 7, 0));
        let last_week = sheet(
            CfKind::TimePeriod {
                period: CfTimePeriod::LastWeek,
            },
            9,
        );
        assert!(painted(&e, &last_week, 7, 0) && !painted(&e, &last_week, 6, 0));
        let last7 = sheet(
            CfKind::TimePeriod {
                period: CfTimePeriod::Last7Days,
            },
            9,
        );
        assert!(painted(&e, &last7, 7, 0) && !painted(&e, &last7, 8, 0));
    }

    #[test]
    fn stacking_merges_and_stops__feat__sheet_lower_condfmt() {
        let e = engine(&col_a(4));
        let bold = DifferentialFormat {
            font: Some(FontDelta {
                bold: Some(true),
                ..Default::default()
            }),
            fill: Some(CellFill::Pattern {
                pattern: PatternKind::Solid,
                fg: Some(ColorRef::rgb(255, 0, 0)),
                bg: None,
            }),
            ..Default::default()
        };
        let mut first = CfRule::new(
            CfKind::CellIs {
                op: CfOp::GreaterThan,
                formulas: vec!["1".into()],
            },
            1,
        );
        first.dxf = Some(bold);
        let second = rule(
            CfKind::CellIs {
                op: CfOp::GreaterThan,
                formulas: vec!["2".into()],
            },
            2,
        );
        let mut cf = SheetCf {
            blocks: vec![CfBlock {
                ranges: vec![(0, 0, 3, 0)],
                rules: vec![second.clone(), first.clone()],
                x14_only: false,
            }],
        };
        let pal = ColorPalette::default();
        let out = |cf: &SheetCf, row: u32| {
            let ctx = CfContext {
                engine: &e,
                sheet: 0,
                cf,
                palette: &pal,
            };
            cell_outcome(&ctx, &mut CfCache::new(), row, 0)
        };
        // Row 3 (value 4) matches both: the priority-1 fill wins, its bold
        // stays, nothing of the later rule overrides it.
        let d = out(&cf, 3).unwrap().dxf.unwrap();
        assert_eq!(d.font.unwrap().bold, Some(true));
        assert_eq!(
            d.fill,
            Some(CellFill::Pattern {
                pattern: PatternKind::Solid,
                fg: Some(ColorRef::rgb(255, 0, 0)),
                bg: None
            })
        );
        // stopIfTrue on the first: a scale under it is not applied.
        cf.blocks[0].rules[1].stop_if_true = true;
        cf.blocks[0].rules.push(CfRule::new(
            CfKind::ColorScale {
                cfvos: vec![
                    Cfvo::new(CfvoKind::Min, None),
                    Cfvo::new(CfvoKind::Max, None),
                ],
                colors: vec![ColorRef::rgb(255, 255, 255), ColorRef::rgb(0, 0, 255)],
            },
            3,
        ));
        assert!(out(&cf, 3).unwrap().scale.is_none());
        assert_eq!(out(&cf, 0).unwrap().scale, Some((255, 255, 255)));
    }

    #[test]
    fn scales_bars_and_icons__feat__sheet_lower_condfmt() {
        let mut vals = col_a(10);
        vals.push((10, 0, CellValue::Number(-5.0)));
        let e = engine(&vals);
        let pal = ColorPalette::default();
        let run = |kind: CfKind, row: u32| {
            let cf = SheetCf {
                blocks: vec![CfBlock {
                    ranges: vec![(0, 0, 10, 0)],
                    rules: vec![CfRule::new(kind, 1)],
                    x14_only: false,
                }],
            };
            let ctx = CfContext {
                engine: &e,
                sheet: 0,
                cf: &cf,
                palette: &pal,
            };
            cell_outcome(&ctx, &mut CfCache::new(), row, 0)
        };
        // A 3-stop scale with a percentile midpoint.
        let scale = CfKind::ColorScale {
            cfvos: vec![
                Cfvo::new(CfvoKind::Num, Some("0")),
                Cfvo::new(CfvoKind::Percentile, Some("50")),
                Cfvo::new(CfvoKind::Formula, Some("$A$10")),
            ],
            colors: vec![
                ColorRef::rgb(255, 0, 0),
                ColorRef::rgb(255, 255, 0),
                ColorRef::rgb(0, 255, 0),
            ],
        };
        // median of -5,1..10 = 5; 10 at the top.
        assert_eq!(run(scale.clone(), 4).unwrap().scale, Some((255, 255, 0)));
        assert_eq!(run(scale, 9).unwrap().scale, Some((0, 255, 0)));
        // A data bar over -5..10 with the automatic axis.
        let mut bar = DataBarRule::new(
            Cfvo::new(CfvoKind::AutoMin, None),
            Cfvo::new(CfvoKind::AutoMax, None),
            ColorRef::rgb(0x63, 0x8E, 0xC6),
        );
        bar.min_length = 0;
        bar.max_length = 100;
        let pos = run(CfKind::DataBar(bar.clone()), 9).unwrap().bar.unwrap();
        let axis = 5.0 / 15.0;
        assert!((pos.axis.unwrap() - axis).abs() < 1e-12);
        assert!((pos.start - axis).abs() < 1e-12 && (pos.end - 1.0).abs() < 1e-12);
        let neg = run(CfKind::DataBar(bar.clone()), 10).unwrap().bar.unwrap();
        assert!(neg.negative && neg.start.abs() < 1e-12 && (neg.end - axis).abs() < 1e-12);
        assert_eq!(neg.color, (0xFF, 0x00, 0x00));
        // Right-to-left mirrors the bar.
        bar.direction = BarDirection::RightToLeft;
        let rtl = run(CfKind::DataBar(bar), 9).unwrap().bar.unwrap();
        assert!(rtl.start.abs() < 1e-12);
        // An icon set: 3 arrows at 0/33/67 percent, reversed, a custom icon.
        let icons = IconSetRule {
            set: "3Arrows".into(),
            cfvos: vec![
                Cfvo::new(CfvoKind::Percent, Some("0")),
                Cfvo::new(CfvoKind::Percent, Some("33")),
                Cfvo::new(CfvoKind::Percent, Some("67")),
            ],
            reverse: false,
            show_value: true,
            custom: vec![],
        };
        assert_eq!(
            run(CfKind::IconSet(icons.clone()), 9)
                .unwrap()
                .icon
                .unwrap()
                .index,
            2
        );
        assert_eq!(
            run(CfKind::IconSet(icons.clone()), 10)
                .unwrap()
                .icon
                .unwrap()
                .index,
            0
        );
        let rev = IconSetRule {
            reverse: true,
            custom: vec![None, None, Some(("3Flags".into(), 1))],
            ..icons
        };
        let top = run(CfKind::IconSet(rev.clone()), 9).unwrap().icon.unwrap();
        assert_eq!((top.set.as_str(), top.index), ("3Flags", 1));
        assert_eq!(
            run(CfKind::IconSet(rev), 10).unwrap().icon.unwrap().index,
            2
        );
    }
}
