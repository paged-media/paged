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

//! Glyphs → lines → blocks → paragraphs: the page's text as frames of
//! paragraphs, read from where the PDF sets each glyph.
//!
//! The reader leans on how a layout program writes a page: each text
//! frame's lines are painted together, top to bottom, so paint order
//! separates frames that geometry alone would merge (two columns at one
//! baseline) and joins what geometry alone would split (a heading and its
//! body). Everything is in spread points, y down.

use super::Glyph;

/// One line as the page sets it.
#[derive(Debug, Clone)]
pub struct Line {
    pub glyphs: Vec<Glyph>,
    pub baseline: f32,
    pub x0: f32,
    pub x1: f32,
    /// The largest em size on the line.
    pub size: f32,
}

impl Line {
    fn new(g: Glyph) -> Line {
        // A space has no ink: a line's extent is its ink's, so a trailing
        // space does not move a centred line's centre.
        let blank = g.text.trim().is_empty();
        Line {
            baseline: g.y,
            x0: if blank { f32::MAX } else { g.x },
            x1: if blank { f32::MIN } else { g.x + g.adv },
            size: g.size,
            glyphs: vec![g],
        }
    }
    fn push(&mut self, g: Glyph) {
        if !g.text.trim().is_empty() {
            self.x0 = self.x0.min(g.x);
            self.x1 = self.x1.max(g.x + g.adv);
        }
        if g.size > self.size {
            self.size = g.size;
        }
        // The line's baseline is its largest glyph's: a superscript's
        // raised baseline does not move the line.
        if g.size >= self.size && (g.y - self.baseline).abs() < 0.05 * g.size {
            self.baseline = g.y;
        }
        self.glyphs.push(g);
    }
    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }
    pub fn center(&self) -> f32 {
        0.5 * (self.x0 + self.x1)
    }
    /// The dominant (font, size, colour) by glyph count.
    pub fn dominant(&self) -> (u32, f32, [u8; 3]) {
        let mut best: Tally = Vec::new();
        for g in &self.glyphs {
            if g.text.trim().is_empty() {
                continue;
            }
            let k = (g.font, (g.size * 10.0).round() as i32, g.color);
            match best.iter_mut().find(|(kk, _)| *kk == k) {
                Some((_, n)) => *n += 1,
                None => best.push((k, 1)),
            }
        }
        best.sort_by_key(|b| std::cmp::Reverse(b.1));
        best.first()
            .map(|((f, s, c), _)| (*f, *s as f32 / 10.0, *c))
            .unwrap_or((
                self.glyphs[0].font,
                self.glyphs[0].size,
                self.glyphs[0].color,
            ))
    }
    /// The (font, size, colour) most of the line's first or last few
    /// letters are set in: where the line takes its paragraph over from the
    /// line above, or hands it on (a run-in head starts a line whose end is
    /// the body's; a superscript at the end is outvoted).
    fn edge_style(&self, last: bool) -> (u32, f32, [u8; 3]) {
        let ink: Vec<&Glyph> = self
            .glyphs
            .iter()
            .filter(|g| !g.text.trim().is_empty())
            .collect();
        let take = 6.min(ink.len());
        let part: Vec<&Glyph> = if last {
            ink[ink.len() - take..].to_vec()
        } else {
            ink[..take].to_vec()
        };
        let mut best: Tally = Vec::new();
        for g in part {
            let k = (g.font, (g.size * 10.0).round() as i32, g.color);
            match best.iter_mut().find(|(kk, _)| *kk == k) {
                Some((_, n)) => *n += 1,
                None => best.push((k, 1)),
            }
        }
        best.sort_by_key(|b| std::cmp::Reverse(b.1));
        best.first()
            .map(|((f, s, c), _)| (*f, *s as f32 / 10.0, *c))
            .unwrap_or_else(|| self.dominant())
    }
    /// The visible text of the line, spaces recovered from gaps, tabs from
    /// wide gaps.
    pub fn text(&self) -> String {
        let mut s = String::new();
        for t in line_tokens(self) {
            s.push_str(&t.text);
        }
        s
    }
    fn last_char(&self) -> Option<char> {
        self.glyphs
            .iter()
            .rev()
            .find_map(|g| g.text.trim_end().chars().last())
    }
    fn first_char(&self) -> Option<char> {
        self.glyphs
            .iter()
            .find_map(|g| g.text.trim_start().chars().next())
    }
    /// The width of the line's first word (to its first space).
    fn first_word_width(&self) -> f32 {
        let mut end = self.x0;
        let mut prev_end = None::<f32>;
        for g in &self.glyphs {
            if g.text.trim().is_empty() {
                break;
            }
            // Chinese and Japanese break between any two characters: the
            // first "word" of such a line is its first character.
            if prev_end.is_some() && g.text.chars().next().is_some_and(is_cjk) {
                break;
            }
            if let Some(pe) = prev_end {
                if g.x - pe > 0.2 * g.size {
                    break;
                }
            }
            end = g.x + g.adv;
            prev_end = Some(end);
        }
        end - self.x0
    }
}

/// A character of a script that breaks lines between characters (Han,
/// kana, the full-width forms and CJK punctuation).
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

impl Line {
    /// How wide its word spaces are set against the font's own space: about
    /// 1 for ragged text, stretched or squeezed for justified lines. `None`
    /// when the line draws no space glyph between words.
    pub fn space_ratio(&self) -> Option<f32> {
        // Tracking widens a space as it widens a letter: take the line's
        // letter spacing off before comparing.
        let mut extras: Vec<f32> = self
            .glyphs
            .windows(2)
            .filter(|w| {
                !w[0].text.trim().is_empty() && !w[1].text.trim().is_empty() && w[0].has_adv
            })
            .map(|w| w[1].x - (w[0].x + w[0].adv))
            .filter(|e| e.abs() < 0.3 * self.size)
            .collect();
        extras.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let track = extras.get(extras.len() / 2).copied().unwrap_or(0.0);
        let mut sum = 0.0;
        let mut n = 0;
        for w in self.glyphs.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if a.text == " " && a.has_adv && a.adv > 0.0 && !b.text.trim().is_empty() {
                sum += (b.x - a.x - track) / a.adv;
                n += 1;
            }
        }
        (n > 0).then(|| sum / n as f32)
    }
}

/// Glyph counts per (font, size in tenths, colour).
type Tally = Vec<((u32, i32, [u8; 3]), usize)>;

/// A piece of a line's text with its glyph style.
#[derive(Debug, Clone)]
pub struct Token {
    pub text: String,
    /// The glyph the token's style comes from.
    pub glyph: usize,
}

/// A tab column of a block: the x its cells start at (left), end at
/// (right, figures), or have their decimal point at (decimal: figures
/// whose negatives in parentheses run past the positives' last digit).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TabCol {
    pub x: f32,
    pub right: bool,
    pub decimal: bool,
}

/// Where a cell's decimal point is: a full stop between digits, in the
/// glyphs from `from` up to (not including) `to`.
fn cell_decimal(line: &Line, from: usize, to: usize) -> Option<f32> {
    let g = &line.glyphs;
    let digit = |i: usize| {
        g.get(i)
            .and_then(|x| x.text.chars().next())
            .is_some_and(|c| c.is_ascii_digit())
    };
    (from + 1..to.min(g.len()).saturating_sub(1))
        .find(|&i| g[i].text == "." && digit(i - 1) && digit(i + 1))
        .map(|i| g[i].x)
}

/// The cells of a line with their decimal points: (first glyph, start,
/// end, decimal).
fn cells_dec(line: &Line) -> Vec<(usize, f32, f32, Option<f32>)> {
    let c = cells(line);
    (0..c.len())
        .map(|k| {
            let to = c.get(k + 1).map_or(line.glyphs.len(), |n| n.0);
            (c[k].0, c[k].1, c[k].2, cell_decimal(line, c[k].0, to))
        })
        .collect()
}

/// The cells of a line: runs of ink set apart by more than a tab's gap
/// (one and a half ems), each as its first glyph's index, start and end.
pub fn cells(line: &Line) -> Vec<(usize, f32, f32)> {
    let mut out: Vec<(usize, f32, f32)> = Vec::new();
    let mut prev_end: Option<f32> = None;
    for (i, g) in line.glyphs.iter().enumerate() {
        if g.text.trim().is_empty() {
            continue;
        }
        let starts = prev_end.is_none_or(|pe| g.x - pe > 1.5 * g.size);
        if starts {
            out.push((i, g.x, g.x + g.adv));
        } else if let Some(c) = out.last_mut() {
            c.2 = g.x + g.adv;
        }
        prev_end = Some(g.x + g.adv);
    }
    out
}

/// A block's tab columns, from where its cells line up: ends that agree
/// across rows are right-aligned columns (figures), starts that agree are
/// left-aligned ones. A cell that lines up with nothing makes its own
/// left column.
pub fn tab_columns(lines: &[Line]) -> Vec<TabCol> {
    // A table has rows: one line with a gap (a caption and its mark) is
    // not one, and its gap is a space.
    if lines.iter().filter(|l| cells(l).len() >= 2).count() < 2 {
        return Vec::new();
    }
    let mut starts: Vec<f32> = Vec::new();
    let mut ends: Vec<f32> = Vec::new();
    let mut points: Vec<f32> = Vec::new();
    for l in lines {
        for (_, a, b, d) in cells_dec(l).into_iter().skip(1) {
            starts.push(a);
            ends.push(b);
            points.extend(d);
        }
    }
    if starts.is_empty() {
        return Vec::new();
    }
    let clusters = |v: &mut Vec<f32>| -> Vec<(f32, usize)> {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut out: Vec<(f32, usize, f32)> = Vec::new();
        for x in v.iter() {
            match out.last_mut() {
                Some((_, n, last)) if (x - *last).abs() <= 1.5 => {
                    *n += 1;
                    *last = *x;
                }
                _ => out.push((*x, 1, *x)),
            }
        }
        out.into_iter()
            .map(|(first, n, last)| (0.5 * (first + last), n))
            .collect()
    };
    let right: Vec<(f32, usize)> = clusters(&mut ends.clone())
        .into_iter()
        .filter(|c| c.1 >= 2)
        .collect();
    let left: Vec<(f32, usize)> = clusters(&mut starts.clone())
        .into_iter()
        .filter(|c| c.1 >= 2)
        .collect();
    let decimals: Vec<(f32, usize)> = clusters(&mut points.clone())
        .into_iter()
        .filter(|c| c.1 >= 2)
        .collect();
    let near = |v: &[(f32, usize)], x: f32| -> Option<(f32, usize)> {
        v.iter()
            .filter(|c| (c.0 - x).abs() <= 1.5)
            .max_by_key(|c| c.1)
            .copied()
    };
    // A decimal column where the points line its figures up better than
    // their ends do (a negative's closing parenthesis runs past).
    let decimal_for = |b: f32, d: Option<f32>| -> Option<f32> {
        let (x, n) = near(&decimals, d?)?;
        (n > near(&right, b).map_or(0, |r| r.1)).then_some(x)
    };
    let used: Vec<f32> = lines
        .iter()
        .flat_map(|l| cells_dec(l).into_iter().skip(1))
        .filter_map(|(_, _, b, d)| decimal_for(b, d))
        .collect();
    let mut cols: Vec<TabCol> = Vec::new();
    let mut add = |col: TabCol| {
        if !cols
            .iter()
            .any(|c| c.right == col.right && c.decimal == col.decimal && (c.x - col.x).abs() <= 1.5)
        {
            cols.push(col);
        }
    };
    for l in lines {
        for (_, a, b, d) in cells_dec(l).into_iter().skip(1) {
            if let Some(x) = decimal_for(b, d) {
                add(TabCol {
                    x,
                    right: false,
                    decimal: true,
                });
                continue;
            }
            // A dash or a figure without a point beside a decimal column
            // is that column's.
            if let Some(&x) = used
                .iter()
                .find(|&&x| x > a - 0.6 * l.size && x < b + 0.6 * l.size)
            {
                add(TabCol {
                    x,
                    right: false,
                    decimal: true,
                });
                continue;
            }
            let r = right
                .iter()
                .filter(|c| (c.0 - b).abs() <= 1.5)
                .max_by_key(|c| c.1);
            let lf = left
                .iter()
                .filter(|c| (c.0 - a).abs() <= 1.5)
                .max_by_key(|c| c.1);
            let col = match (r, lf) {
                (Some(r), Some(lf)) if r.1 > lf.1 => TabCol {
                    x: r.0,
                    right: true,
                    decimal: false,
                },
                (_, Some(lf)) => TabCol {
                    x: lf.0,
                    right: false,
                    decimal: false,
                },
                (Some(r), None) => TabCol {
                    x: r.0,
                    right: true,
                    decimal: false,
                },
                (None, None) => TabCol {
                    x: a,
                    right: false,
                    decimal: false,
                },
            };
            add(col);
        }
    }
    // In order along the line: a right column by where its cells start.
    cols.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    cols
}

/// Whether `line` is a row whose first cell is empty: two cells or more,
/// the first set in from the frame's left (a total under its column).
fn leads_with_tab(line: &Line, left: f32) -> bool {
    let all = cells(line);
    all.len() >= 2 && all[0].1 > left + line.size
}

/// Which column each cell of `line` sits in: every cell after the first,
/// and the first too in a row whose label cell is empty. A lone line set
/// in from the left (an entry's second line beside a column of numbers)
/// is indented, not tabbed.
fn cell_columns(line: &Line, cols: &[TabCol], left: f32) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let all = cells_dec(line);
    let skip = usize::from(!leads_with_tab(line, left));
    for (gi, a, b, d) in all.into_iter().skip(skip) {
        // How far a column is from where the cell meets it: its point,
        // its end or its start; a cell without a point meets a decimal
        // column anywhere across it.
        let off = |c: &TabCol| -> f32 {
            if c.decimal {
                match d {
                    Some(d) => (c.x - d).abs(),
                    None if c.x >= a && c.x <= b => 0.0,
                    None => (c.x - a).abs().min((c.x - b).abs()),
                }
            } else if c.right {
                (c.x - b).abs()
            } else {
                (c.x - a).abs()
            }
        };
        let best = cols
            .iter()
            .enumerate()
            .min_by(|(_, x), (_, y)| off(x).partial_cmp(&off(y)).unwrap())
            .map(|(i, _)| i);
        if let Some(i) = best {
            out.push((gi, i));
        }
    }
    out
}

/// [`line_tokens`] with a block's tab columns: a cell is reached by as
/// many tabs as columns it skips (an empty cell is a tab of its own).
pub fn line_tokens_cols(line: &Line, cols: &[TabCol], left: f32) -> Vec<Token> {
    let mut tokens = line_tokens(line);
    if cols.is_empty() {
        // No columns to tab to: a gap is a space.
        for t in tokens.iter_mut() {
            if t.text == "\t" {
                t.text = " ".into();
            }
        }
        return tokens;
    }
    let mapping = cell_columns(line, cols, left);
    let mut prev: isize = -1;
    for (gi, col) in mapping {
        let want = (col as isize - prev).max(1) as usize;
        prev = col as isize;
        // A first cell set in from the left is reached by its tabs too.
        if gi == tokens.first().map_or(usize::MAX, |t| t.glyph) {
            for _ in 0..want {
                tokens.insert(
                    0,
                    Token {
                        text: "\t".into(),
                        glyph: gi,
                    },
                );
            }
            continue;
        }
        if let Some(pos) = tokens.iter().position(|t| t.glyph == gi && t.text == "\t") {
            for _ in 1..want {
                tokens.insert(
                    pos,
                    Token {
                        text: "\t".into(),
                        glyph: gi,
                    },
                );
            }
        }
    }
    tokens
}

/// The line's glyphs as text tokens, inserting a space where a gap is
/// wider than a word space's share of the em and the page drew no space
/// glyph, and a tab where a gap is wider than one and a half ems.
pub fn line_tokens(line: &Line) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    // A word space is a gap well past the line's own letter spacing: text
    // set tight (word spaces of a sixth of an em) or tracked open alike.
    // The letter spacing is the median gap between neighbouring letters;
    // estimated advances (a font without widths) keep the fixed share.
    let letter_gap = {
        let ink: Vec<&Glyph> = line
            .glyphs
            .iter()
            .filter(|g| !g.text.trim().is_empty())
            .collect();
        let mut gaps: Vec<f32> = ink
            .windows(2)
            .filter(|w| w[0].has_adv && w[1].has_adv)
            .map(|w| (w[1].x - (w[0].x + w[0].adv)) / w[1].size.max(0.1))
            .filter(|g| g.abs() < 0.5)
            .collect();
        gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
        (gaps.len() >= 6).then(|| gaps[gaps.len() / 2])
    };
    // Gaps are measured from the last inked glyph: a layout program sets
    // a tab as a space glyph and then a jump, and the jump is the tab.
    let mut last_ink_end: Option<f32> = None;
    let mut spaces: Vec<usize> = Vec::new();
    for (i, g) in line.glyphs.iter().enumerate() {
        let is_space = !g.text.is_empty() && g.text.trim().is_empty();
        if is_space {
            // A "space" the next glyph starts on top of advances nothing:
            // an invisible discretionary hyphen InDesign maps to a space.
            if let Some(n) = line.glyphs.get(i + 1) {
                if n.x - g.x < 0.3 * g.adv.max(0.1 * g.size) && !n.text.trim().is_empty() {
                    continue;
                }
            }
            spaces.push(i);
            continue;
        }
        if g.text.is_empty() {
            continue;
        }
        if let Some(end) = last_ink_end {
            let gap = g.x - end;
            if gap > 1.5 * g.size {
                out.push(Token {
                    text: "\t".into(),
                    glyph: i,
                });
            } else if !spaces.is_empty() {
                // Every space the page sets is a space of the text.
                for &si in &spaces {
                    out.push(Token {
                        text: " ".into(),
                        glyph: si,
                    });
                }
            } else if gap
                > match letter_gap {
                    Some(m) => (m + 0.1).max(0.1) * g.size,
                    None => 0.18 * g.size,
                }
            {
                out.push(Token {
                    text: " ".into(),
                    glyph: i,
                });
            }
        }
        spaces.clear();
        out.push(Token {
            text: g.text.clone(),
            glyph: i,
        });
        last_ink_end = Some(g.x + g.adv);
    }
    out
}

/// A line with a gap that no line near it repeats is not a row of a
/// table: its cells are separate items on one baseline (a label and the
/// next label, a caption and its mark), each set where the page sets it.
/// A row has a neighbour a few lines away whose cells line up with its
/// own: by their left edges, right edges or centres.
fn split_lone_rows(lines: Vec<Line>) -> Vec<Line> {
    let rows: Vec<Vec<(usize, f32, f32)>> = lines.iter().map(cells).collect();
    let is_row = |i: usize| -> bool {
        let li = &lines[i];
        (0..lines.len()).any(|j| {
            let dy = (lines[j].baseline - li.baseline).abs();
            j != i
                && rows[j].len() >= 2
                && dy > 0.5
                && dy < 4.0 * li.size.max(lines[j].size)
                && rows[j].iter().skip(1).any(|c| {
                    rows[i].iter().skip(1).any(|d| {
                        // Left-set text, right-set figures, centred heads.
                        (c.1 - d.1).abs() < 1.5
                            || (c.2 - d.2).abs() < 1.5
                            || ((c.1 + c.2) - (d.1 + d.2)).abs() < 3.0
                    })
                })
        })
    };
    let lone: Vec<bool> = (0..lines.len())
        .map(|i| rows[i].len() >= 2 && !is_row(i))
        .collect();
    let mut out = Vec::with_capacity(lines.len());
    for (i, l) in lines.into_iter().enumerate() {
        if !lone[i] {
            out.push(l);
            continue;
        }
        let starts: Vec<usize> = rows[i].iter().map(|c| c.0).collect();
        let mut part: Option<Line> = None;
        for (gi, g) in l.glyphs.into_iter().enumerate() {
            if starts.contains(&gi) && gi != starts[0] {
                if let Some(p) = part.take() {
                    out.push(p);
                }
            }
            match part.as_mut() {
                Some(p) => p.push(g),
                None => part = Some(Line::new(g)),
            }
        }
        if let Some(p) = part {
            out.push(p);
        }
    }
    // A part that is only the spaces before a cell is no line.
    out.retain(|l| l.glyphs.iter().any(|g| !g.text.trim().is_empty()));
    out
}

/// The page's glyphs (paint order) as lines.
pub fn lines(glyphs: Vec<Glyph>, cuts: &[f32]) -> Vec<Line> {
    let mut out: Vec<Line> = Vec::new();
    for g in glyphs {
        if g.text.is_empty() && g.adv <= 0.0 {
            continue;
        }
        let joins = out.last().is_some_and(|l| {
            let tol = 0.25 * l.size.max(g.size);
            let same_baseline = (g.y - l.baseline).abs() <= tol.max(0.3 * g.size)
                // A raised or lowered small glyph (a superscript) stays on
                // its line.
                || (g.size < 0.8 * l.size && (g.y - l.baseline).abs() <= 0.5 * l.size);
            let end = l.glyphs.last().map_or(l.x1, |p| p.x + p.adv);
            let gap = g.x - end;
            // The cells of a table row, painted one after another on one
            // baseline, are one line however far apart (tabbed text); a
            // page edge between them is not.
            let across_page = cuts.iter().any(|c| *c > end + 0.5 && *c < g.x - 0.5);
            same_baseline && gap > -0.6 * g.size && gap < 30.0 * l.size.max(g.size) && !across_page
        });
        if joins {
            out.last_mut().unwrap().push(g);
        } else {
            out.push(Line::new(g));
        }
    }
    // A line whose glyphs are all spaces is no line.
    out.retain(|l| l.glyphs.iter().any(|g| !g.text.trim().is_empty()));
    // A table's cells painted in passes (a shaded or bold column after the
    // rest) are still its row: a short or numeric line on another line's
    // baseline, beside it, joins it. Body text in columns shares baselines
    // too, but its lines are long words, not figures.
    let cellish = |l: &Line| {
        let t = l.text();
        let t = t.trim();
        t.chars().count() <= 6
            || t.chars()
                .all(|c| c.is_ascii_digit() || " .,()%–-—£$€*\t".contains(c))
    };
    let mut merged: Vec<Line> = Vec::new();
    'next: for l in out {
        if cellish(&l) {
            for m in merged.iter_mut().rev().take(40) {
                let same = (m.baseline - l.baseline).abs() < 0.5 && (m.size - l.size).abs() < 0.6;
                let apart = l.x0 > m.x1 + 0.5 || l.x1 < m.x0 - 0.5;
                let (a, b) = if l.x0 > m.x1 {
                    (m.x1, l.x0)
                } else {
                    (l.x1, m.x0)
                };
                let across = cuts.iter().any(|c| *c > a + 0.5 && *c < b - 0.5);
                if same && apart && !across && b - a < 30.0 * l.size && cellish(m) {
                    for g in l.glyphs {
                        m.push(g);
                    }
                    m.glyphs.sort_by(|p, q| p.x.partial_cmp(&q.x).unwrap());
                    continue 'next;
                }
            }
        }
        merged.push(l);
    }
    let mut out = split_lone_rows(merged);
    if let Some(pat) = std::env::var_os("PAGED_PDF_DEBUG_GLYPHS") {
        let pat = pat.to_string_lossy().to_string();
        for l in &out {
            if l.text().contains(&pat) {
                for g in &l.glyphs {
                    eprintln!(
                        "  {:?} x {:.2} adv {:.2} has {}",
                        g.text, g.x, g.adv, g.has_adv
                    );
                }
            }
        }
    }
    // A discretionary hyphen inside a line marks where the word may break;
    // it is not drawn there. Only the one that ends a line is a hyphen.
    for l in out.iter_mut() {
        let last_ink = l.glyphs.iter().rposition(|g| !g.text.trim().is_empty());
        let mut k = 0;
        l.glyphs.retain(|g| {
            let keep = g.text != "\u{00AD}" || Some(k) == last_ink;
            k += 1;
            keep
        });
    }
    out
}

/// How a paragraph's lines sit in its frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Align {
    Left,
    Center,
    Right,
    Justify,
}

/// A run of text with one character style.
#[derive(Debug, Clone)]
pub struct Run {
    pub text: String,
    pub font: u32,
    pub size: f32,
    pub color: [u8; 3],
    pub hscale: f32,
    /// Raised (positive) above the line's baseline, points.
    pub shift: f32,
    /// Set in All Caps (`None` until a glyph says).
    pub caps: Option<bool>,
}

/// A paragraph as recovered.
#[derive(Debug, Clone)]
pub struct Para {
    pub runs: Vec<Run>,
    pub align: Align,
    /// Baseline to baseline, points; `None` for one line (taken from the
    /// style).
    pub leading: Option<f32>,
    /// Extra space above the paragraph's first baseline beyond the
    /// leading, points.
    pub space_before: f32,
    /// Baseline distance from the previous paragraph's last line (none for
    /// a frame's first paragraph).
    pub from_prev: Option<f32>,
    pub first_indent: f32,
    pub left_indent: f32,
    /// Mean letter spacing of its glyphs over their advances, per mille
    /// of the em (InDesign's tracking unit).
    pub tracking: f32,
    /// The original advance sum of its non-space glyphs per em, and how
    /// many: what the metric fit matches.
    pub adv_em: f32,
    pub adv_n: usize,
    /// Its text per character, for the metric fit.
    pub chars: String,
    /// The paragraph's dominant (font, size, colour).
    pub dominant: (u32, f32, [u8; 3]),
    /// Its last line ends where the frame does and without closing
    /// punctuation: it may go on in another frame.
    pub open_end: bool,
    /// Its first line looks like a continuation (no indent where the
    /// style indents, a lowercase start).
    pub open_start: bool,
    /// The first paragraph of its frame.
    pub first_in_frame: bool,
    /// A line of it ends in a hyphen that splits a word.
    pub hyphenated: bool,
    /// Its lines as the metric fit needs them.
    pub fit_lines: Vec<FitLine>,
    /// How many lines the page sets it in.
    pub n_lines: usize,
}

/// One line of a paragraph for the metric fit: its text, where it starts
/// and ends, its em size, and — when it ends in a soft break — the next
/// line's first word (which must not fit on it).
#[derive(Debug, Clone)]
pub struct FitLine {
    pub text: String,
    /// The line's text by font: `(text, font)` in order (a heading set in
    /// two weights measures each in its own).
    pub segments: Vec<(String, u32)>,
    pub x0: f32,
    pub x1: f32,
    pub size: f32,
    pub next_word: Option<String>,
}

/// A frame of text.
#[derive(Debug, Clone)]
pub struct Block {
    pub lines: Vec<Line>,
    pub paras: Vec<Para>,
    /// Frame box: left, top, right, bottom.
    pub frame: [f32; 4],
    /// First baseline below the frame's top.
    pub first_baseline: f32,
    /// Its lines hang punctuation into the margin (optical margin alignment).
    pub optical: bool,
    /// The reading direction it is turned to, radians (0 upright); its
    /// geometry is in its own axes.
    pub turn: f32,
    /// Its tab columns (tabbed rows: a table set with tabs).
    pub tabs: Vec<TabCol>,
}

/// Group the page's lines into blocks (frames), in paint order.
pub fn blocks(lines: Vec<Line>) -> Vec<Vec<Line>> {
    let mut out: Vec<Vec<Line>> = Vec::new();
    for line in lines {
        let joins = out.last().is_some_and(|b| {
            let last = b.last().unwrap();
            let dy = line.baseline - last.baseline;
            let x0 = b.iter().map(|l| l.x0).fold(f32::MAX, f32::min);
            let x1 = b.iter().map(|l| l.x1).fold(f32::MIN, f32::max);
            let overlap = line.x1.min(x1) - line.x0.max(x0);
            let size = line.size.max(last.size);
            // Down the page, within a few lines, sharing the column.
            // The block's own leading, but never more than a generous
            // leading for its type: labels set far apart do not make a
            // leading that pulls the next far line in too.
            let lead = typical_lead(b)
                .unwrap_or(1.25 * size)
                .min(1.6 * size.max(last.size));
            dy > 0.4 * size
                && dy < (3.2 * lead).max(4.5 * size.min(last.size))
                && overlap > 0.25 * line.width().min(x1 - x0)
        });
        if joins {
            out.last_mut().unwrap().push(line);
        } else {
            out.push(vec![line]);
        }
    }
    out
}

/// Split a block where display type (a heading, 14 pt and up) meets body
/// text: each gets a frame of its own measure — a heading needs room for a
/// face a little wider than the original, the body the original's exact
/// measure, and one frame cannot give both.
pub fn split_display(lines: Vec<Line>) -> Vec<Vec<Line>> {
    let display = |l: &Line| l.size >= 14.0;
    let mut out: Vec<Vec<Line>> = Vec::new();
    for l in lines {
        let starts = out
            .last()
            .and_then(|b| b.last())
            .is_none_or(|p| display(p) != display(&l));
        if starts {
            out.push(vec![l]);
        } else {
            out.last_mut().unwrap().push(l);
        }
    }
    out
}

/// Split a block where its lines change measure: frames threaded one
/// under the other in a column read as one run of lines, but each frame
/// sets its lines to its own width. Two steady lines either side of a jump
/// in where lines end (or start) is a frame edge, not a ragged margin.
pub fn split_measures(lines: Vec<Line>) -> Vec<Vec<Line>> {
    if lines.len() < 4 {
        return vec![lines];
    }
    let width = lines.iter().map(|l| l.x1).fold(f32::MIN, f32::max)
        - lines.iter().map(|l| l.x0).fold(f32::MAX, f32::min);
    let steady = |a: f32, b: f32| (a - b).abs() < 0.06 * width;
    let mut cuts: Vec<usize> = Vec::new();
    for i in 1..lines.len().saturating_sub(2) {
        // Lines since the last frame edge found.
        let since = cuts.last().copied().unwrap_or(0);
        let (a, b, c, d) = (&lines[i - 1], &lines[i], &lines[i + 1], &lines[i + 2]);
        let right_jump = steady(a.x1, b.x1)
            && steady(c.x1, d.x1)
            && (0.5 * (a.x1 + b.x1) - 0.5 * (c.x1 + d.x1)).abs() > 0.15 * width
            // Lines that run well past every line before them are set in a
            // wider frame (the one before may end on a paragraph's short
            // last line).
            || i >= since + 2
                && steady(c.x1, d.x1)
                && c.x1.min(d.x1)
                    > lines[since..=i].iter().map(|l| l.x1).fold(f32::MIN, f32::max)
                        + 0.15 * width;
        let left_jump = steady(a.x0, b.x0)
            && steady(c.x0, d.x0)
            && (0.5 * (a.x0 + b.x0) - 0.5 * (c.x0 + d.x0)).abs() > 0.15 * width;
        if right_jump || left_jump {
            // The frame edge is where the lines also jump down, when they
            // do just before: a frame's first line may be a short one.
            let lead = typical_lead(&lines[since..=i + 1]).unwrap_or(1.2 * b.size);
            let at = (since.max(i.saturating_sub(1))..=i + 1)
                .rev()
                .find(|&j| j > since && lines[j].baseline - lines[j - 1].baseline > 1.5 * lead)
                .unwrap_or(i + 1);
            if cuts.last() != Some(&at) && at > since {
                cuts.push(at);
            }
        }
    }
    if cuts.is_empty() {
        return vec![lines];
    }
    let mut out = Vec::new();
    let mut rest = lines;
    for c in cuts.into_iter().rev() {
        let tail = rest.split_off(c);
        out.push(tail);
    }
    out.push(rest);
    out.reverse();
    out
}

fn typical_lead(lines: &[Line]) -> Option<f32> {
    let mut d: Vec<f32> = lines
        .windows(2)
        .map(|w| w[1].baseline - w[0].baseline)
        .filter(|d| *d > 0.0)
        .collect();
    if d.is_empty() {
        return None;
    }
    d.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(d[d.len() / 2])
}

/// A hyphen as a layout program draws one at a line's end: the ASCII
/// hyphen-minus, the soft hyphen, or Unicode's hyphen (InDesign maps its
/// discretionary hyphen to U+2010).
fn is_hyphen(t: &str) -> bool {
    matches!(t, "-" | "\u{00AD}" | "\u{2010}" | "\u{2011}")
}

/// Where a line ended in a hyphen inside a word: the hyphen of
/// hyphenation (gone when the text reflows) or a hard hyphen ("two-way").
/// The story builder resolves it against the words the document hyphenates
/// mid-line.
pub const HYPHEN_JOIN: char = '\u{001F}';

/// What ends a paragraph's last line for good: sentence punctuation, and
/// the end marks magazines set after an article's last word.
const CLOSERS: &[char] = &[
    '.', '!', '?', ':', '”', '"', '’', ')', '…', '»', '«', ';', '■', '□', '▪', '◼', '◾', '◆', '♦',
    '●', '·', '•', '★', '✦', '◊',
];

/// Build a block's paragraphs and its frame from its lines.
/// Punctuation a layout program hangs into the margin (optical margin
/// alignment): a line that starts with one starts left of its column.
const HANGERS: &[char] = &['“', '"', '‘', '\'', '„', '«', '»', '-', '–', '—', '(', '['];

pub fn build_block(mut lines: Vec<Line>) -> Block {
    // Hanging punctuation: a line opening with a quote mark sits left of
    // the column by about the mark's width. Its column edge is where its
    // first letter would sit without the hang: the block's common left.
    let mut optical = false;
    if lines.len() >= 2 {
        let mut xs: Vec<f32> = lines.iter().map(|l| (l.x0 * 2.0).round() / 2.0).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut best = (xs[0], 0usize);
        let mut i = 0;
        while i < xs.len() {
            let j = xs[i..]
                .iter()
                .take_while(|v| (**v - xs[i]).abs() < 0.6)
                .count();
            if j > best.1 {
                best = (xs[i], j);
            }
            i += j.max(1);
        }
        let common = best.0;
        for l in lines.iter_mut() {
            let hang = common - l.x0;
            // Quote marks hang by most of their width; letters by a sliver
            // of the em (InDesign's optical margin moves display type too).
            let hanger = l.first_char().is_some_and(|c| HANGERS.contains(&c));
            if hang > 0.3 && (hanger && hang < 0.8 * l.size || hang < 0.1 * l.size) {
                l.x0 = common;
                optical = true;
            }
        }
    }
    let left = lines.iter().map(|l| l.x0).fold(f32::MAX, f32::min);
    let right = lines.iter().map(|l| l.x1).fold(f32::MIN, f32::max);
    // Tabbed rows (a table set with tabs): the block's columns.
    let tabs = tab_columns(&lines);
    let tabbed = |l: &Line| !tabs.is_empty() && cells(l).len() > 1;

    // Justified: most lines run to the right edge (a ragged column's
    // longest lines meet it only by chance).
    let body_lines: Vec<&Line> = if lines.iter().any(|l| l.size < 14.0) {
        lines.iter().filter(|l| l.size < 14.0).collect()
    } else {
        lines.iter().collect()
    };
    let body_right = body_lines.iter().map(|l| l.x1).fold(f32::MIN, f32::max);
    let justified_block = body_lines.len() >= 3
        && body_lines
            .iter()
            .filter(|q| (q.x1 - body_right).abs() < 0.6)
            .count()
            * 3
            >= body_lines.len() * 2;

    // Split into paragraphs.
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let lead_all = typical_lead(&lines);
    // A block whose paragraphs are set apart by space says where its
    // paragraphs end: a change of face with no space is inside one.
    let spaced = lines.windows(2).any(|w| {
        let lead = lead_all
            .unwrap_or(1.2 * w[1].size)
            .max(0.95 * w[1].size.min(w[0].size));
        w[1].baseline - w[0].baseline > lead * 1.18 + 0.5
    });
    for i in 0..lines.len() {
        let new_para = if i == 0 {
            true
        } else {
            let (p, l) = (&lines[i - 1], &lines[i]);
            let dy = l.baseline - p.baseline;
            // The block's leading is its body's; a display line is measured
            // against its own size.
            let lead = lead_all
                .unwrap_or(1.2 * l.size)
                .max(0.95 * l.size.min(p.size));
            // Face from the whole line; size and colour where the lines
            // meet (a run-in head in a smaller face starts a line whose
            // end is the body's).
            let (pf, _, _) = p.dominant();
            let (lf, _, _) = l.dominant();
            let (_, ps, pc) = p.edge_style(true);
            let (_, ls, lc) = l.edge_style(false);
            // A change of size or colour is a new paragraph. A change of
            // face alone (a bold lead-in, a quote set bold inside its
            // paragraph) is one only where the earlier line ends one: it
            // closes a sentence or stops short, and the next does not go
            // on in lowercase.
            let face_only = pf != lf && (ps - ls).abs() <= 0.15 && pc == lc;
            let ends =
                p.last_char().is_some_and(|c| CLOSERS.contains(&c)) || p.x1 < right - 2.0 * p.size;
            let goes_on = l.first_char().is_some_and(|c| c.is_lowercase());
            let style_change =
                (ps - ls).abs() > 0.15 || pc != lc || (face_only && ends && !goes_on && !spaced);
            let gap = dy > lead * 1.18 + 0.5;
            // A line indented under one at the frame's edge starts a new
            // paragraph (a first-line indent) — unless it continues a hung
            // one: the line above is its item's first, opening with a
            // bullet or a list number ("1.", "2)"), or the line below keeps
            // the indent.
            let marker = |t: &str| {
                let t = t.trim_start();
                let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
                t.starts_with(|c: char| "•·–—-▪■●◦".contains(c))
                    || ((1..=2).contains(&digits) && t[digits..].starts_with(['.', ')']))
            };
            let item_start = groups.last().is_some_and(|g| g[0] == i - 1);
            let hung = item_start
                && (marker(&p.text())
                    || lines
                        .get(i + 1)
                        .is_some_and(|n2| (n2.x0 - l.x0).abs() < 0.6));
            let indent = l.x0 > left + 0.6 * l.size
                && (p.x0 - left).abs() < 0.3 * p.size
                && !hung
                // A centred or right-set block moves every line.
                && lines.iter().filter(|q| (q.x0 - left).abs() < 0.3 * q.size).count() * 2
                    > lines.len();
            // In a justified block a short line ends its paragraph.
            let short = justified_block && p.x1 < right - 1.0 * p.size;
            if std::env::var_os("PAGED_PDF_DEBUG_LINES").is_some() {
                eprintln!(
                    "  line {i} x0 {:.1} x1 {:.1} base {:.1} size {:.1} font {} | style {style_change} gap {gap} (dy {dy:.2} lead {lead:.2}) indent {indent} short {short} :: {}",
                    l.x0, l.x1, l.baseline, l.size, lf,
                    l.text().chars().take(40).collect::<String>()
                );
            }
            // A tabbed row is a paragraph of its own (a row of a table).
            let row = tabbed(p) || tabbed(l);
            // A list item starts with its bullet, or back out at the edge a
            // hung paragraph's lines were indented from: the paragraph's
            // first line sits left of its others, and this line is back at
            // the first line's edge. (A first-line indent steps left on
            // the paragraph's second line; that is the same paragraph.)
            let first = groups.last().map_or(i - 1, |g| g[0]);
            let hung_back = first < i - 1
                && lines[first].x0 < p.x0 - 0.6 * l.size
                && (l.x0 - lines[first].x0).abs() < 0.3 * l.size;
            let item = l.first_char().is_some_and(|c| "•·▪■●◦".contains(c)) || hung_back;
            style_change || gap || indent || short || row || item
        };
        if new_para {
            groups.push(vec![i]);
        } else {
            groups.last_mut().unwrap().push(i);
        }
    }

    // The frame's width. A line breaks because its next word would not
    // fit, so every soft break bounds the width from above (the line, a
    // space, the next line's first word); the widest line bounds it from
    // below. A break whose next word would have fit on the widest line was
    // forced and bounds nothing. Between the bounds, the middle: a face a
    // little wider or narrower than the original still breaks where the
    // page breaks.
    // A frame that sets a heading over its body text takes its measure
    // from the body: the heading's breaks are kept as breaks (display
    // type), and only the body's soft breaks say how wide the frame is.
    let body = |l: &Line| l.size < 14.0;
    let has_body = lines.iter().any(body);
    let measured = |l: &Line| !has_body || body(l);
    let widest_display = lines.iter().map(|l| l.x1).fold(f32::MIN, f32::max) - left;
    let lefts_aligned =
        lines.iter().filter(|l| (l.x0 - left).abs() < 0.6).count() * 2 > lines.len();
    let widest = lines
        .iter()
        .filter(|l| measured(l))
        .map(|l| l.x1)
        .fold(f32::MIN, f32::max)
        - left;
    let mut upper = f32::MAX;
    for g in &groups {
        for w in g.windows(2) {
            let (p, l) = (&lines[w[0]], &lines[w[1]]);
            if !measured(p) {
                continue;
            }
            if p.last_char().is_some_and(|c| is_hyphen(&c.to_string())) {
                continue;
            }
            let space = 0.25 * p.size;
            // A line set from the left fills from the frame's edge; a
            // centred or right-set one only its own width.
            let filled = if lefts_aligned {
                p.x1 - left
            } else {
                p.width()
            };
            let need = filled + space + l.first_word_width();
            if need > widest + 0.25 {
                upper = upper.min(need);
            }
        }
    }
    // Justified lines run to the frame's edge: its width is theirs.
    let width = if justified_block {
        widest
    } else if upper < f32::MAX {
        widest + 0.5 * (upper - widest)
    } else {
        // No soft break: room for a slightly wider face.
        widest + (0.04 * widest).max(1.0 * lines[0].size)
    };
    // The heading fitted its frame in the original: the frame is at least
    // as wide as it.
    let width = width.max(widest_display + 0.5);

    let mut paras = Vec::new();
    for (gi, g) in groups.iter().enumerate() {
        let ls: Vec<&Line> = g.iter().map(|&i| &lines[i]).collect();
        paras.push(build_para(
            &ls, left, right, width, gi, &groups, &lines, &tabs,
        ));
    }
    // One-line paragraphs say nothing of their alignment, but a block of
    // them does: lines that share a right edge and not a left one are set
    // right, lines that share only a centre are centred.
    if lines.len() >= 2 && tabs.is_empty() && groups.iter().all(|g| g.len() == 1) {
        let same = |f: &dyn Fn(&Line) -> f32| {
            let v0 = f(&lines[0]);
            lines.iter().all(|l| (f(l) - v0).abs() < 0.6)
        };
        let (l_eq, r_eq, c_eq) = (same(&|l| l.x0), same(&|l| l.x1), same(&|l| l.center()));
        let set = if r_eq && !l_eq {
            Some(Align::Right)
        } else if c_eq && !l_eq {
            Some(Align::Center)
        } else {
            None
        };
        if let Some(a) = set {
            for p in paras.iter_mut() {
                p.align = a;
                p.first_indent = 0.0;
                p.left_indent = 0.0;
            }
        }
    }
    // A one-line paragraph on the axis of the block's centred paragraphs
    // is centred too (one line says nothing of its alignment).
    let axis: Vec<f32> = groups
        .iter()
        .zip(&paras)
        .filter(|(_, p)| p.align == Align::Center)
        .flat_map(|(g, _)| g.iter().map(|&i| lines[i].center()))
        .collect();
    if let Some(&c) = axis.first() {
        for (g, p) in groups.iter().zip(paras.iter_mut()) {
            if g.len() == 1 && p.align == Align::Left && (lines[g[0]].center() - c).abs() < 1.5 {
                p.align = Align::Center;
                p.first_indent = 0.0;
                p.left_indent = 0.0;
            }
        }
    }
    let first = &lines[0];
    let first_baseline = 0.8 * first.size;
    let last = lines.last().unwrap();
    let frame = [
        frame_left(&paras, left, right, width),
        first.baseline - first_baseline,
        frame_left(&paras, left, right, width) + width.max(1.0),
        last.baseline + 0.32 * last.size,
    ];
    Block {
        lines,
        paras,
        frame,
        first_baseline,
        optical,
        turn: 0.0,
        tabs,
    }
}

/// Where the frame starts: at the block's left, or around its centre (or
/// against its right) when every paragraph is set that way.
fn frame_left(paras: &[Para], left: f32, right: f32, width: f32) -> f32 {
    if paras.iter().all(|p| p.align == Align::Center) {
        0.5 * (left + right) - 0.5 * width
    } else if paras.iter().all(|p| p.align == Align::Right) {
        right - width
    } else {
        left
    }
}

#[allow(clippy::too_many_arguments)]
fn build_para(
    ls: &[&Line],
    left: f32,
    right: f32,
    width: f32,
    gi: usize,
    groups: &[Vec<usize>],
    all: &[Line],
    tabs: &[TabCol],
) -> Para {
    // Alignment.
    let n = ls.len();
    let tol = 0.6f32;
    let lefts_eq = ls.iter().all(|l| (l.x0 - left).abs() < tol);
    // The lines after the first share a left edge (the paragraph's own,
    // which a hanging indent moves in from the frame's).
    let rest_left = if n >= 2 { ls[1].x0 } else { left };
    let rest_lefts_eq = ls.iter().skip(1).all(|l| (l.x0 - rest_left).abs() < tol);
    let rights_eq_but_last = n >= 2 && ls[..n - 1].iter().all(|l| (l.x1 - right).abs() < tol);
    let centers: Vec<f32> = ls.iter().map(|l| l.center()).collect();
    let mid = 0.5 * (left + right);
    let centered = n >= 1
        && centers.iter().all(|c| (c - centers[0]).abs() < 1.0)
        && !(lefts_eq && n >= 2)
        && ls
            .iter()
            .any(|l| (l.x0 - left).abs() > 1.0 || (l.x1 - right).abs() > 1.0)
        && (centers[0] - mid).abs() < 1.5;
    // Lines after an indented first one starting at the frame's edge are
    // body text with a first-line indent, never right-set.
    let indented_body =
        n >= 2 && rest_lefts_eq && (rest_left - left).abs() < tol && ls[0].x0 > rest_left + tol;
    let righted =
        n >= 2 && ls.iter().all(|l| (l.x1 - right).abs() < tol) && !lefts_eq && !indented_body;
    // Two lines ending together could be a ragged paragraph whose first
    // line is the block's widest: justified lines stretch their spaces.
    let stretched = ls[..n.saturating_sub(1)]
        .iter()
        .filter_map(|l| l.space_ratio())
        .any(|r| (r - 1.0).abs() > 0.06);
    let align = if rights_eq_but_last && rest_lefts_eq && (n >= 3 || stretched || indented_body) {
        Align::Justify
    } else if centered && n >= 2 {
        Align::Center
    } else if righted {
        Align::Right
    } else {
        Align::Left
    };

    // Indents.
    // A first line left of the rest is a hanging indent (a bullet or a
    // number hung in the margin): negative.
    let first_indent = if n >= 2 { ls[0].x0 - ls[1].x0 } else { 0.0 };
    let base_left = if n >= 2 { ls[1].x0 } else { ls[0].x0 };
    // A one-line paragraph's offset from the frame's edge is its first
    // line's indent (below), counted once; a row reached by tabs has none.
    let left_indent = if (align == Align::Left || align == Align::Justify) && n >= 2 {
        (base_left - left).max(0.0)
    } else {
        0.0
    };
    let first_indent = if align == Align::Left || align == Align::Justify {
        if n >= 2 {
            first_indent
        } else if !tabs.is_empty() && leads_with_tab(ls[0], left) {
            // A row reached by tabs is not indented.
            0.0
        } else {
            (ls[0].x0 - left).max(0.0)
        }
    } else {
        0.0
    };

    // Leading and space before.
    let leading = if n >= 2 {
        let mut d: Vec<f32> = ls
            .windows(2)
            .map(|w| w[1].baseline - w[0].baseline)
            .collect();
        d.sort_by(|a, b| a.partial_cmp(b).unwrap());
        Some(d[d.len() / 2])
    } else {
        None
    };
    let from_prev = (gi > 0).then(|| {
        let prev_last = &all[*groups[gi - 1].last().unwrap()];
        ls[0].baseline - prev_last.baseline
    });
    let space_before = from_prev.map_or(0.0, |dy| {
        let lead = leading.unwrap_or(1.2 * ls[0].size);
        (dy - lead).max(0.0)
    });

    // Runs, with spaces between lines and hyphens at line ends resolved.
    let mut runs: Vec<Run> = Vec::new();
    let mut tracking_sum = 0.0f32;
    let mut tracking_n = 0usize;
    let mut adv_em = 0.0f32;
    let mut adv_n = 0usize;
    let mut chars = String::new();
    let mut hyphenated = false;
    let mut fit_lines: Vec<FitLine> = Vec::new();
    // A list set as one paragraph (names, one to a line): every line opens
    // with a capital and the lines fall well short of the measure. Its
    // breaks are the list's, not the measure's.
    let list_like = align == Align::Left
        && n >= 4
        && ls
            .iter()
            .all(|l| l.first_char().is_some_and(char::is_uppercase))
        && ls[..n - 1]
            .iter()
            .map(|l| (l.x1 - left) / width.max(1.0))
            .sum::<f32>()
            / ((n - 1) as f32)
            < 0.8;
    for (li, l) in ls.iter().enumerate() {
        let tokens = line_tokens_cols(l, tabs, left);
        let last_line = li + 1 == n;
        let line_text: String = tokens.iter().map(|t| t.text.as_str()).collect();
        let mut tokens = tokens;
        let mut soft_next: Option<String> = None;
        // Join with the next line.
        if !last_line {
            let next_first = ls[li + 1].first_char();
            let ends_hyphen = tokens.last().is_some_and(|t| is_hyphen(&t.text))
                && tokens.len() >= 2
                && tokens[tokens.len() - 2]
                    .text
                    .chars()
                    .last()
                    .is_some_and(|c| c.is_alphabetic() && c.is_lowercase())
                && next_first.is_some_and(|c| c.is_alphabetic() && c.is_lowercase());
            if ends_hyphen {
                // Hyphenation or a hard hyphen at the line's end: the
                // document's own spelling of the word decides later
                // ([`HYPHEN_JOIN`]).
                if let Some(last) = tokens.last_mut() {
                    last.text = HYPHEN_JOIN.to_string();
                }
                hyphenated = true;
            } else {
                // A break the frame's width does not explain is a forced
                // line break.
                let space = 0.25 * l.size;
                let filled = match align {
                    Align::Left | Align::Justify => l.x1 - left,
                    _ => l.width(),
                };
                let fits = filled + space + ls[li + 1].first_word_width() < width - 0.25;
                // Display type (a heading of a few lines) breaks where its
                // designer broke it: those breaks are kept as breaks, so a
                // face of other widths cannot move them.
                let display = n <= 4 && l.size >= 14.0;
                let fits = fits || display || list_like;
                let gl = tokens.last().map_or(0, |t| t.glyph);
                let text = if fits && align != Align::Justify {
                    "\u{2028}"
                } else {
                    " "
                };
                if text == " " && align != Align::Justify {
                    let next = ls[li + 1].text();
                    soft_next = next.split(' ').next().map(str::to_string);
                }
                tokens.push(Token {
                    text: text.into(),
                    glyph: gl,
                });
            }
        }
        if !line_text.contains('\t') {
            let mut segments: Vec<(String, u32)> = Vec::new();
            for t in line_tokens(l) {
                let f = l.glyphs[t.glyph].font;
                match segments.last_mut() {
                    Some((s, lf)) if *lf == f || t.text == " " => s.push_str(&t.text),
                    _ => segments.push((t.text.clone(), f)),
                }
            }
            fit_lines.push(FitLine {
                segments,
                text: line_text,
                x0: l.x0,
                x1: l.x1,
                size: l.size,
                next_word: soft_next,
            });
        }
        for t in tokens {
            let g = &l.glyphs[t.glyph];
            let shift = l.baseline - g.y;
            let shift = if shift.abs() < 0.08 * g.size {
                0.0
            } else {
                shift
            };
            let same = runs.last().is_some_and(|r| {
                r.font == g.font
                    && (r.size - g.size).abs() < 0.05
                    && r.color == g.color
                    && (r.hscale - g.hscale).abs() < 0.01
                    && (r.shift - shift).abs() < 0.05
                    && (g.caps.is_none() || r.caps.is_none() || g.caps == r.caps)
            });
            if same || (t.text == " " && !runs.is_empty()) {
                let r = runs.last_mut().unwrap();
                r.text.push_str(&t.text);
                if r.caps.is_none() {
                    r.caps = g.caps;
                }
            } else {
                runs.push(Run {
                    text: t.text.clone(),
                    font: g.font,
                    size: g.size,
                    color: g.color,
                    hscale: g.hscale,
                    shift,
                    caps: g.caps,
                });
            }
        }
        // Letter spacing: within a word, the step between glyph origins
        // past the glyph's own advance.
        for w in l.glyphs.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            if a.text.trim().is_empty() || b.text.trim().is_empty() || !a.has_adv {
                continue;
            }
            let extra = b.x - (a.x + a.adv);
            if extra.abs() < 0.15 * a.size {
                tracking_sum += extra / a.size * 1000.0;
                tracking_n += 1;
            }
        }
        for g in &l.glyphs {
            if !g.text.trim().is_empty() && g.has_adv {
                adv_em += g.adv / g.size;
                adv_n += 1;
                chars.push_str(&g.text);
            }
        }
    }
    let last = ls[n - 1];
    let ends_punct = last.last_char().is_some_and(|c| CLOSERS.contains(&c));
    let full_last = last.x1 > right - 1.0 * last.size;
    let open_end = !ends_punct && (full_last || align == Align::Justify && full_last);
    let first_c = ls[0].first_char();
    let open_start = first_c.is_some_and(|c| c.is_lowercase());
    let dominant = {
        let mut best: Tally = Vec::new();
        for l in ls {
            for g in &l.glyphs {
                if g.text.trim().is_empty() {
                    continue;
                }
                let k = (g.font, (g.size * 10.0).round() as i32, g.color);
                match best.iter_mut().find(|(kk, _)| *kk == k) {
                    Some((_, c)) => *c += 1,
                    None => best.push((k, 1)),
                }
            }
        }
        best.sort_by_key(|b| std::cmp::Reverse(b.1));
        let ((f, s, c), _) = best[0];
        (f, s as f32 / 10.0, c)
    };
    Para {
        runs,
        align,
        leading,
        space_before,
        from_prev,
        first_indent,
        left_indent,
        tracking: if tracking_n > 0 {
            tracking_sum / tracking_n as f32
        } else {
            0.0
        },
        adv_em,
        adv_n,
        chars,
        dominant,
        open_end,
        open_start,
        first_in_frame: gi == 0,
        hyphenated,
        fit_lines,
        n_lines: n,
    }
}

/// A frame of one line has no soft break to fix its width, and its one
/// line no alignment of its own: the page says. A line against the page's
/// outer edge (or the spine) is set from that edge, a line on the page's
/// centre is centred, and the frame gets room on its open side so a face a
/// little wider than the original does not wrap it.
pub fn place_single_line(b: &mut Block, page_x: f32, page_w: f32, left_side: bool) {
    if b.lines.len() != 1 || b.paras.len() != 1 {
        // Several lines: room only where no break bounds the width.
        return;
    }
    let l = &b.lines[0];
    let w = l.width();
    let slack = (0.25 * w).max(2.0 * l.size);
    let mid = page_x + 0.5 * page_w;
    let right_edge_dist = page_x + page_w - l.x1;
    let left_edge_dist = l.x0 - page_x;
    let p = &mut b.paras[0];
    if (l.center() - mid).abs() < 1.0 {
        p.align = Align::Center;
        b.frame[0] = l.x0 - 0.5 * slack;
        b.frame[2] = l.x1 + 0.5 * slack;
    } else if !left_side && right_edge_dist < left_edge_dist && l.x0 > mid {
        p.align = Align::Right;
        b.frame[0] = l.x0 - slack;
        b.frame[2] = l.x1;
    } else {
        b.frame[0] = l.x0;
        b.frame[2] = l.x1 + slack;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EM: f32 = 10.0;

    /// `s` set from `x` on baseline `y`, half an em per character.
    fn set(s: &str, x: f32, y: f32, order: u32) -> Vec<Glyph> {
        s.chars()
            .enumerate()
            .map(|(i, c)| Glyph {
                text: c.to_string(),
                x: x + i as f32 * 0.5 * EM,
                y,
                adv: 0.5 * EM,
                has_adv: true,
                size: EM,
                hscale: 1.0,
                font: 0,
                color: [0, 0, 0],
                order,
                caps: None,
            })
            .collect()
    }

    /// `s` set to end at `right`.
    fn set_right(s: &str, right: f32, y: f32, order: u32) -> Vec<Glyph> {
        set(s, right - s.chars().count() as f32 * 0.5 * EM, y, order)
    }

    fn texts(block: &Block) -> Vec<String> {
        block
            .paras
            .iter()
            .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
            .collect()
    }

    #[test]
    fn a_table_reads_as_tabbed_rows() {
        let mut g = Vec::new();
        g.extend(set("United Kingdom", 0.0, 100.0, 0));
        g.extend(set_right("61.1", 150.0, 100.0, 0));
        g.extend(set_right("1,559.4", 250.0, 100.0, 0));
        g.extend(set("The Americas", 0.0, 112.0, 0));
        g.extend(set_right("7.4", 150.0, 112.0, 0));
        g.extend(set_right("8.1", 250.0, 112.0, 0));
        // The total row has no label, and its second figure is painted in
        // a later pass (a bold column).
        g.extend(set_right("76.0", 150.0, 124.0, 1));
        g.extend(set_right("1,817.7", 250.0, 124.0, 2));
        let ls = lines(g, &[]);
        assert_eq!(ls.len(), 3, "one line per row");
        let block = build_block(ls);
        let cols: Vec<(f32, bool)> = block.tabs.iter().map(|t| (t.x, t.right)).collect();
        assert_eq!(cols.len(), 2, "two figure columns: {cols:?}");
        assert!(cols.iter().all(|c| c.1), "figures align right: {cols:?}");
        assert!((cols[0].0 - 150.0).abs() < 1.0 && (cols[1].0 - 250.0).abs() < 1.0);
        assert_eq!(
            texts(&block),
            [
                "United Kingdom\t61.1\t1,559.4",
                "The Americas\t7.4\t8.1",
                "\t76.0\t1,817.7"
            ]
        );
        assert!(block.paras.iter().all(|p| p.first_indent == 0.0));
    }

    #[test]
    fn a_run_in_head_stays_in_its_paragraph() {
        // A small bold head, then the body, which runs on to the next line.
        // The head has more letters than the body on its line.
        let mut g: Vec<Glyph> = set("THIS LEAVES US WITH A DILEMMA.", 0.0, 100.0, 0)
            .into_iter()
            .map(|mut g| {
                g.font = 1;
                g.size = 7.0;
                g
            })
            .collect();
        g.extend(set(" Conservation is", 151.0, 100.0, 0));
        g.extend(set(
            "underfunded—the U.S. Fish and Wildlife Service and others.",
            0.0,
            112.0,
            0,
        ));
        let block = build_block(lines(g, &[]));
        assert_eq!(block.paras.len(), 1, "{:?}", texts(&block));
    }

    #[test]
    fn two_labels_on_one_baseline_are_two_items() {
        let mut g = Vec::new();
        g.extend(set("UNIT", 20.0, 100.0, 0));
        g.extend(set("Subunits", 120.0, 100.0, 0));
        g.extend(set("Vertical position denotes pitch", 0.0, 140.0, 1));
        let ls = lines(g, &[]);
        let texts: Vec<String> = ls.iter().map(Line::text).collect();
        assert_eq!(
            texts,
            ["UNIT", "Subunits", "Vertical position denotes pitch"]
        );
    }

    #[test]
    fn figures_aligned_on_their_points_are_a_decimal_column() {
        // Negatives in parentheses: their point lines up with the
        // positives', their closing parenthesis runs past.
        let mut g = Vec::new();
        g.extend(set("Revenue", 0.0, 100.0, 0));
        g.extend(set("1,095.3", 120.0, 100.0, 0)); // point at 145
        g.extend(set("Cost of sales", 0.0, 112.0, 0));
        g.extend(set("(751.6)", 125.0, 112.0, 0)); // point at 145
        g.extend(set("Gross profit", 0.0, 124.0, 0));
        g.extend(set("343.7", 130.0, 124.0, 0)); // point at 145
        let block = build_block(lines(g, &[]));
        assert_eq!(block.tabs.len(), 1, "{:?}", block.tabs);
        assert!(block.tabs[0].decimal && (block.tabs[0].x - 145.0).abs() < 1.0);
        assert_eq!(
            texts(&block),
            [
                "Revenue\t1,095.3",
                "Cost of sales\t(751.6)",
                "Gross profit\t343.7"
            ]
        );
    }

    #[test]
    fn hung_bullets_are_list_items() {
        let mut g = Vec::new();
        g.extend(set("• annual review of the", 0.0, 100.0, 0));
        g.extend(set("policy;", 10.0, 112.0, 0));
        g.extend(set("• twice yearly review", 0.0, 124.0, 0));
        g.extend(set("of every risk.", 10.0, 136.0, 0));
        let block = build_block(lines(g, &[]));
        assert_eq!(block.paras.len(), 2, "{:?}", texts(&block));
        for p in &block.paras {
            assert!(
                (p.first_indent + 10.0).abs() < 0.5 && (p.left_indent - 10.0).abs() < 0.5,
                "a hanging indent: first {} left {}",
                p.first_indent,
                p.left_indent
            );
        }
    }
}
