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

//! Setting a math tree (engine ADR 1090).
//!
//! The rules are TeX's (Knuth, Appendix G) in the simplified form the OpenType
//! MATH table also states: a style that shrinks scripts and fraction parts, an
//! axis the fraction bar and operators centre on, shifts that keep a minimum
//! clearance, and the inter-atom spacing of ordinary, binary, relation and
//! punctuation atoms. Everything is measured in em of the equation's size, so
//! the output scales with it.
//!
//! The engine text stack stays the only place glyph widths come from: the
//! caller passes a [`MathMetrics`], and the result is positioned glyph runs,
//! rules and strokes. Coordinates are y-down from the origin of the equation:
//! `x` from its left edge, `y` from the baseline (negative above it).

use crate::model::{FracKind, Limits, Math, Node, Row, Run, Variant};

/// Where the width and height of text come from.
pub trait MathMetrics {
    /// The advance of `text` set at `size`.
    fn advance(&self, text: &str, size: f32, variant: Variant) -> f32;

    /// Ascent above and descent below the baseline of `text` at `size`, both
    /// non-negative. The default is a Latin estimate; a font-backed
    /// implementation returns the glyph bounds.
    fn extent(&self, text: &str, size: f32, _variant: Variant) -> (f32, f32) {
        let (mut a, mut d) = (0.0f32, 0.0f32);
        for c in text.chars() {
            let (ca, cd) = match c {
                'g' | 'j' | 'p' | 'q' | 'y' | 'ç' => (0.43, 0.22),
                'a' | 'c' | 'e' | 'm' | 'n' | 'o' | 'r' | 's' | 'u' | 'v' | 'w' | 'x' | 'z' => {
                    (0.43, 0.0)
                }
                ',' | ';' => (0.1, 0.15),
                '.' => (0.1, 0.0),
                '+' | '=' | '<' | '>' | '-' | '\u{2212}' | '\u{00d7}' | '\u{00b7}' => (0.55, 0.05),
                _ => (0.70, 0.0),
            };
            a = a.max(ca);
            d = d.max(cd);
        }
        (a * size, d * size)
    }
}

/// The em fractions the rules use (the OpenType MATH constants' counterparts).
#[derive(Debug, Clone, Copy)]
pub struct Constants {
    /// Height of the math axis above the baseline.
    pub axis: f32,
    /// Fraction bar, radical bar and over/under-line thickness.
    pub rule: f32,
    pub x_height: f32,
    pub num_display: f32,
    pub num_text: f32,
    pub den_display: f32,
    pub den_text: f32,
    pub sup_display: f32,
    pub sup_text: f32,
    pub sub_alone: f32,
    pub sub_with_sup: f32,
    pub sup_drop: f32,
    pub sub_drop: f32,
    pub script_space: f32,
    pub thin: f32,
    pub medium: f32,
    pub thick: f32,
    pub limit_gap: f32,
    pub column_gap: f32,
    pub baseline_skip: f32,
    pub display_operator_scale: f32,
}

impl Default for Constants {
    fn default() -> Self {
        Constants {
            axis: 0.25,
            rule: 0.05,
            x_height: 0.43,
            num_display: 0.677,
            num_text: 0.394,
            den_display: 0.686,
            den_text: 0.345,
            sup_display: 0.413,
            sup_text: 0.363,
            sub_alone: 0.15,
            sub_with_sup: 0.247,
            sup_drop: 0.386,
            sub_drop: 0.05,
            script_space: 0.05,
            thin: 3.0 / 18.0,
            medium: 4.0 / 18.0,
            thick: 5.0 / 18.0,
            limit_gap: 0.15,
            column_gap: 1.0,
            baseline_skip: 1.2,
            display_operator_scale: 1.4,
        }
    }
}

/// One thing to paint.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    /// Text at a baseline origin. `scale_y` stretches a delimiter or operator
    /// vertically (1.0 for everything else).
    Glyphs {
        text: String,
        x: f32,
        y: f32,
        size: f32,
        variant: Variant,
        scale_y: f32,
    },
    /// A filled rectangle (fraction bar, radical bar, over/under-line);
    /// `y` is its top edge.
    Rule { x: f32, y: f32, w: f32, h: f32 },
    /// A stroked polyline (the radical sign).
    Stroke { points: Vec<(f32, f32)>, width: f32 },
}

/// A set equation.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Layout {
    pub width: f32,
    /// Above the baseline, non-negative.
    pub ascent: f32,
    /// Below the baseline, non-negative.
    pub descent: f32,
    pub items: Vec<Item>,
}

/// Set `math` at `size` (the em of the equation, in points).
pub fn layout(math: &Math, metrics: &dyn MathMetrics, size: f32) -> Layout {
    layout_with(math, metrics, size, &Constants::default())
}

/// [`layout`] with explicit constants.
pub fn layout_with(math: &Math, metrics: &dyn MathMetrics, size: f32, k: &Constants) -> Layout {
    let cx = Cx { m: metrics, k };
    let style = if math.display {
        Style::Display
    } else {
        Style::Text
    };
    let b = cx.row(&math.body, style, size);
    Layout {
        width: b.w,
        ascent: b.a,
        descent: b.d,
        items: b.items,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
    Display,
    Text,
    Script,
    ScriptScript,
}

impl Style {
    fn scale(self) -> f32 {
        match self {
            Style::Display | Style::Text => 1.0,
            Style::Script => 0.7,
            Style::ScriptScript => 0.5,
        }
    }
    fn script(self) -> Style {
        match self {
            Style::Display | Style::Text => Style::Script,
            _ => Style::ScriptScript,
        }
    }
    /// Numerator and denominator.
    fn part(self) -> Style {
        match self {
            Style::Display => Style::Text,
            Style::Text => Style::Script,
            _ => Style::ScriptScript,
        }
    }
    fn is_script(self) -> bool {
        matches!(self, Style::Script | Style::ScriptScript)
    }
}

/// A set box: width, ascent, descent, and items relative to its origin.
#[derive(Debug, Clone, Default)]
struct B {
    w: f32,
    a: f32,
    d: f32,
    items: Vec<Item>,
}

impl B {
    fn put(&mut self, other: B, dx: f32, dy: f32) {
        for mut it in other.items {
            match &mut it {
                Item::Glyphs { x, y, .. } => {
                    *x += dx;
                    *y += dy;
                }
                Item::Rule { x, y, .. } => {
                    *x += dx;
                    *y += dy;
                }
                Item::Stroke { points, .. } => {
                    for p in points {
                        p.0 += dx;
                        p.1 += dy;
                    }
                }
            }
            self.items.push(it);
        }
        self.w = self.w.max(dx + other.w);
        self.a = self.a.max(other.a - dy);
        self.d = self.d.max(other.d + dy);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Ord,
    Bin,
    Rel,
    Open,
    Close,
    Punct,
    Op,
}

fn class_of(c: char) -> Class {
    match c {
        '+' | '\u{2212}' | '-' | '\u{00d7}' | '\u{00f7}' | '\u{00b7}' | '\u{00b1}' | '\u{2213}'
        | '\u{2217}' | '\u{2218}' | '\u{2295}' | '\u{2297}' | '\u{222a}' | '\u{2229}'
        | '\u{2227}' | '\u{2228}' => Class::Bin,
        '=' | '<' | '>' | '\u{2264}' | '\u{2265}' | '\u{2260}' | '\u{2248}' | '\u{2261}'
        | '\u{223c}' | '\u{2243}' | '\u{2245}' | '\u{221d}' | '\u{2208}' | '\u{2209}'
        | '\u{2282}' | '\u{2283}' | '\u{2286}' | '\u{2287}' | '\u{2192}' | '\u{2190}'
        | '\u{2194}' | '\u{21d2}' | '\u{21d0}' | '\u{21d4}' | '\u{21a6}' | '\u{2225}'
        | '\u{22a5}' | '\u{226a}' | '\u{226b}' => Class::Rel,
        '(' | '[' | '{' | '\u{27e8}' | '\u{230a}' | '\u{2308}' => Class::Open,
        ')' | ']' | '}' | '\u{27e9}' | '\u{230b}' | '\u{2309}' => Class::Close,
        ',' | ';' => Class::Punct,
        _ => Class::Ord,
    }
}

struct Cx<'a> {
    m: &'a dyn MathMetrics,
    k: &'a Constants,
}

struct Atom {
    class: Class,
    b: B,
}

impl Cx<'_> {
    fn text(&self, text: &str, size: f32, variant: Variant) -> B {
        let (a, d) = self.m.extent(text, size, variant);
        B {
            w: self.m.advance(text, size, variant),
            a,
            d,
            items: vec![Item::Glyphs {
                text: text.to_string(),
                x: 0.0,
                y: 0.0,
                size,
                variant,
                scale_y: 1.0,
            }],
        }
    }

    fn row(&self, row: &Row, style: Style, base: f32) -> B {
        let s = base * style.scale();
        let mut atoms: Vec<Atom> = Vec::new();
        for n in row {
            match n {
                Node::Run(Run { text, variant }) => {
                    let mut pending = String::new();
                    for c in text.chars() {
                        let class = class_of(c);
                        if class == Class::Ord {
                            pending.push(c);
                            continue;
                        }
                        if !pending.is_empty() {
                            atoms.push(Atom {
                                class: Class::Ord,
                                b: self.text(&pending, s, *variant),
                            });
                            pending.clear();
                        }
                        // Operators and relations are upright whatever the run.
                        let v = if matches!(class, Class::Ord) {
                            *variant
                        } else {
                            Variant::Plain
                        };
                        atoms.push(Atom {
                            class,
                            b: self.text(&c.to_string(), s, v),
                        });
                    }
                    if !pending.is_empty() {
                        atoms.push(Atom {
                            class: Class::Ord,
                            b: self.text(&pending, s, *variant),
                        });
                    }
                }
                other => {
                    let class = match other {
                        Node::Nary { .. } | Node::Func { .. } => Class::Op,
                        _ => Class::Ord,
                    };
                    atoms.push(Atom {
                        class,
                        b: self.node(other, style, base),
                    });
                }
            }
        }
        // A binary operator with nothing to bind on its left, or after another
        // operator, an opening delimiter or punctuation, is an ordinary atom;
        // so is one at the end.
        for i in 0..atoms.len() {
            if atoms[i].class != Class::Bin {
                continue;
            }
            let lonely_left = i == 0
                || matches!(
                    atoms[i - 1].class,
                    Class::Bin | Class::Rel | Class::Open | Class::Punct | Class::Op
                );
            if lonely_left || i + 1 == atoms.len() {
                atoms[i].class = Class::Ord;
            }
        }
        let mut out = B::default();
        let mut x = 0.0;
        let mut prev: Option<Class> = None;
        for atom in atoms {
            if let Some(p) = prev {
                x += self.space(p, atom.class, style) * s;
            }
            prev = Some(atom.class);
            let w = atom.b.w;
            out.put(atom.b, x, 0.0);
            x += w;
        }
        out.w = x;
        out
    }

    fn space(&self, l: Class, r: Class, style: Style) -> f32 {
        use Class::*;
        let k = self.k;
        let script = style.is_script();
        match (l, r) {
            (Rel, Rel) => 0.0,
            (Rel, _) | (_, Rel) if !script => k.thick,
            (Bin, _) | (_, Bin) if !script => k.medium,
            (Punct, _) if !script => k.thin,
            (Op, Ord) | (Ord, Op) | (Op, Op) | (Op, Open) | (Close, Op) => k.thin,
            _ => 0.0,
        }
    }

    fn node(&self, n: &Node, style: Style, base: f32) -> B {
        let s = base * style.scale();
        let k = self.k;
        match n {
            Node::Run(_) => self.row(&vec![n.clone()], style, base),
            Node::Group { body } => self.row(body, style, base),
            Node::Frac { num, den, kind } => self.frac(num, den, *kind, style, base),
            Node::Script {
                base: b,
                sub,
                sup,
                pre,
            } => {
                let bb = self.row(b, style, base);
                let single = b.len() == 1 && matches!(b[0], Node::Run(_));
                let sb = sub.as_ref().map(|r| self.row(r, style.script(), base));
                let sp = sup.as_ref().map(|r| self.row(r, style.script(), base));
                self.scripts(bb, single, sb, sp, *pre, style, base)
            }
            Node::Rad { degree, body } => self.rad(degree.as_ref(), body, style, base),
            Node::Nary {
                op,
                sub,
                sup,
                limits,
                body,
            } => self.nary(*op, sub.as_ref(), sup.as_ref(), *limits, body, style, base),
            Node::Delim {
                open,
                close,
                sep,
                items,
            } => self.delim(*open, *close, *sep, items, style, base),
            Node::Matrix { rows } => {
                let cs = if style == Style::Display {
                    Style::Text
                } else {
                    style
                };
                let cells: Vec<Vec<B>> = rows
                    .iter()
                    .map(|r| r.iter().map(|c| self.row(c, cs, base)).collect())
                    .collect();
                self.grid(cells, true, s)
            }
            Node::EqArr { rows } => {
                let cells: Vec<Vec<B>> = rows
                    .iter()
                    .map(|r| vec![self.row(r, style, base)])
                    .collect();
                self.grid(cells, false, s)
            }
            Node::Func { name, body } => {
                let nb = self.row(name, style, base);
                let bb = self.row(body, style, base);
                let mut out = B::default();
                let w = nb.w;
                out.put(nb, 0.0, 0.0);
                out.put(bb, w + k.thin * s, 0.0);
                out
            }
            Node::Accent { chr, base: b } => {
                let bb = self.row(b, style, base);
                let acc = self.text(&chr.to_string(), s, Variant::Plain);
                let lift = (bb.a - k.x_height * s).max(0.0);
                let w = bb.w;
                let aw = acc.w;
                let mut out = B::default();
                out.put(bb, 0.0, 0.0);
                out.put(acc, ((w - aw) / 2.0).max(0.0), -lift);
                out.w = out.w.max(w);
                out
            }
            Node::Bar { top, base: b } => {
                let bb = self.row(b, style, base);
                let t = k.rule * s;
                let (w, a, d) = (bb.w, bb.a, bb.d);
                let mut out = B::default();
                out.put(bb, 0.0, 0.0);
                let y = if *top { -(a + 3.0 * t) } else { d + 2.0 * t };
                out.items.push(Item::Rule { x: 0.0, y, w, h: t });
                if *top {
                    out.a = a + 4.0 * t;
                } else {
                    out.d = d + 3.0 * t;
                }
                out
            }
            Node::Limit {
                base: b,
                lim,
                upper,
            } => {
                let bb = self.row(b, style, base);
                let lb = self.row(lim, style.script(), base);
                let w = bb.w.max(lb.w);
                let gap = k.limit_gap * s;
                let (bw, lw) = (bb.w, lb.w);
                let ly = if *upper {
                    -(bb.a + gap + lb.d)
                } else {
                    bb.d + gap + lb.a
                };
                let mut out = B::default();
                out.put(bb, (w - bw) / 2.0, 0.0);
                out.put(lb, (w - lw) / 2.0, ly);
                out
            }
        }
    }

    fn frac(&self, num: &Row, den: &Row, kind: FracKind, style: Style, base: f32) -> B {
        let s = base * style.scale();
        let k = self.k;
        match kind {
            FracKind::Linear => {
                let mut row = num.clone();
                row.push(Node::run("/"));
                row.extend(den.iter().cloned());
                return self.row(&row, style, base);
            }
            FracKind::Skewed => {
                let n = self.row(num, style.script(), base);
                let d = self.row(den, style.script(), base);
                let slash = self.text("/", s, Variant::Plain);
                let mut out = B::default();
                let (nw, sw) = (n.w, slash.w);
                out.put(n, 0.0, -0.3 * s);
                out.put(slash, nw, 0.0);
                out.put(d, nw + sw, 0.1 * s);
                return out;
            }
            _ => {}
        }
        let nb = self.row(num, style.part(), base);
        let db = self.row(den, style.part(), base);
        let display = style == Style::Display;
        let bar = kind == FracKind::Bar;
        let theta = k.rule * s;
        let (mut u, mut v) = if display {
            (k.num_display * s, k.den_display * s)
        } else {
            (k.num_text * s, k.den_text * s)
        };
        let axis = k.axis * s;
        if bar {
            let phi = if display { 3.0 * theta } else { theta };
            let gap_n = (u - nb.d) - (axis + theta / 2.0);
            if gap_n < phi {
                u += phi - gap_n;
            }
            let gap_d = (axis - theta / 2.0) - (db.a - v);
            if gap_d < phi {
                v += phi - gap_d;
            }
        } else {
            let phi = if display { 7.0 * theta } else { 3.0 * theta };
            let gap = (u - nb.d) - (db.a - v);
            if gap < phi {
                let half = (phi - gap) / 2.0;
                u += half;
                v += half;
            }
        }
        let pad = if bar { 0.05 * s } else { 0.0 };
        let w = nb.w.max(db.w) + 2.0 * pad;
        let (nw, dw) = (nb.w, db.w);
        let mut out = B { w, ..B::default() };
        out.put(nb, (w - nw) / 2.0, -u);
        out.put(db, (w - dw) / 2.0, v);
        if bar {
            out.items.push(Item::Rule {
                x: 0.0,
                y: -axis - theta / 2.0,
                w,
                h: theta,
            });
        }
        out.w = w;
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn scripts(
        &self,
        base: B,
        single: bool,
        sub: Option<B>,
        sup: Option<B>,
        pre: bool,
        style: Style,
        base_size: f32,
    ) -> B {
        let k = self.k;
        let s = base_size * style.scale();
        let ss = base_size * style.script().scale();
        let xh = k.x_height * s;
        let theta = k.rule * s;
        let (mut u, mut v) = if single {
            (0.0, 0.0)
        } else {
            (base.a - k.sup_drop * ss, base.d + k.sub_drop * ss)
        };
        let sup_min = if style == Style::Display {
            k.sup_display
        } else {
            k.sup_text
        } * s;
        match (&sub, &sup) {
            (None, Some(p)) => {
                u = u.max(sup_min).max(p.d + xh / 4.0);
            }
            (Some(b), None) => {
                v = v.max(k.sub_alone * s).max(b.a - 0.8 * xh);
            }
            (Some(b), Some(p)) => {
                u = u.max(sup_min).max(p.d + xh / 4.0);
                v = v.max(k.sub_with_sup * s);
                let gap = (u - p.d) - (b.a - v);
                if gap < 4.0 * theta {
                    v += 4.0 * theta - gap;
                    let psi = 0.8 * xh - (u - p.d);
                    if psi > 0.0 {
                        u += psi;
                        v -= psi;
                    }
                }
            }
            (None, None) => {}
        }
        let sw = sub.as_ref().map_or(0.0, |b| b.w);
        let pw = sup.as_ref().map_or(0.0, |b| b.w);
        let script_w = sw.max(pw) + k.script_space * s;
        let mut out = B::default();
        let bw = base.w;
        let bx = if pre { script_w } else { 0.0 };
        let sx = if pre { 0.0 } else { bw };
        out.put(base, bx, 0.0);
        if let Some(b) = sub {
            out.put(b, sx, v);
        }
        if let Some(p) = sup {
            out.put(p, sx, -u);
        }
        out.w = bw + script_w;
        out
    }

    fn rad(&self, degree: Option<&Row>, body: &Row, style: Style, base: f32) -> B {
        let k = self.k;
        let s = base * style.scale();
        let bb = self.row(body, style, base);
        let theta = k.rule * s;
        let phi = if style == Style::Display {
            k.x_height * s
        } else {
            theta
        };
        let gap = theta + phi / 4.0;
        let total = bb.a + bb.d + gap + theta;
        let sign_w = 0.55 * s;
        let top = -(bb.a + gap + theta / 2.0);
        let bot = bb.d + theta / 2.0;
        let mid = (top + bot) / 2.0;
        let deg = degree.map(|r| self.row(r, Style::ScriptScript, base));
        let left = deg.as_ref().map_or(0.0, |d| (d.w - 0.4 * sign_w).max(0.0));
        let mut out = B::default();
        let body_w = bb.w;
        out.put(bb, left + sign_w, 0.0);
        out.items.push(Item::Stroke {
            points: vec![
                (left, mid + 0.12 * total),
                (left + 0.18 * sign_w, mid + 0.06 * total),
                (left + 0.5 * sign_w, bot),
                (left + sign_w, top),
            ],
            width: theta,
        });
        out.items.push(Item::Rule {
            x: left + sign_w,
            y: top - theta / 2.0,
            w: body_w,
            h: theta,
        });
        out.a = out.a.max(-top + theta / 2.0);
        if let Some(d) = deg {
            out.put(d, 0.0, out.d - 0.6 * total);
        }
        out.w = left + sign_w + body_w;
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn nary(
        &self,
        op: char,
        sub: Option<&Row>,
        sup: Option<&Row>,
        limits: Option<Limits>,
        body: &Row,
        style: Style,
        base: f32,
    ) -> B {
        let k = self.k;
        let s = base * style.scale();
        let display = style == Style::Display;
        let limits = limits.unwrap_or(
            if display
                && matches!(
                    op,
                    '\u{2211}'
                        | '\u{220f}'
                        | '\u{2210}'
                        | '\u{22c3}'
                        | '\u{22c2}'
                        | '\u{2a01}'
                        | '\u{2a02}'
                        | '\u{22c0}'
                        | '\u{22c1}'
                )
            {
                Limits::UnderOver
            } else {
                Limits::SideScripts
            },
        );
        let op_size = if display {
            s * k.display_operator_scale
        } else {
            s
        };
        let glyph = self.text(&op.to_string(), op_size, Variant::Plain);
        // Centre the glyph on the axis.
        let y_op = -k.axis * s + (glyph.a - glyph.d) / 2.0;
        let opw = glyph.w;
        let (ga, gd) = (glyph.a, glyph.d);
        let mut opbox = B::default();
        opbox.put(glyph, 0.0, y_op);
        opbox.w = opw;
        opbox.a = ga - y_op;
        opbox.d = gd + y_op;
        let sb = sub.map(|r| self.row(r, style.script(), base));
        let sp = sup.map(|r| self.row(r, style.script(), base));
        let head = match limits {
            Limits::SideScripts => self.scripts(opbox, false, sb, sp, false, style, base),
            Limits::UnderOver => {
                let gap = k.limit_gap * s;
                let w = opbox
                    .w
                    .max(sb.as_ref().map_or(0.0, |b| b.w))
                    .max(sp.as_ref().map_or(0.0, |b| b.w));
                let (oa, od, ow) = (opbox.a, opbox.d, opbox.w);
                let mut out = B::default();
                out.put(opbox, (w - ow) / 2.0, 0.0);
                if let Some(p) = sp {
                    let pw = p.w;
                    let y = -(oa + gap + p.d);
                    out.put(p, (w - pw) / 2.0, y);
                }
                if let Some(b) = sb {
                    let bw = b.w;
                    let y = od + gap + b.a;
                    out.put(b, (w - bw) / 2.0, y);
                }
                out.w = w;
                out
            }
        };
        let bb = self.row(body, style, base);
        let mut out = B::default();
        let hw = head.w;
        out.put(head, 0.0, 0.0);
        out.put(bb, hw + k.thin * s, 0.0);
        out
    }

    fn delim(
        &self,
        open: Option<char>,
        close: Option<char>,
        sep: char,
        items: &[Row],
        style: Style,
        base: f32,
    ) -> B {
        let k = self.k;
        let s = base * style.scale();
        let mut inner = B::default();
        let mut x = 0.0;
        for (i, it) in items.iter().enumerate() {
            if i > 0 {
                let sb = self.text(&sep.to_string(), s, Variant::Plain);
                let w = sb.w;
                inner.put(sb, x, 0.0);
                x += w + k.thin * s;
            }
            let b = self.row(it, style, base);
            let w = b.w;
            inner.put(b, x, 0.0);
            x += w;
        }
        inner.w = x;
        let axis = k.axis * s;
        let h = (inner.a - axis).max(inner.d + axis);
        let target = (2.0 * h * 0.901).max(2.0 * h - 0.4 * s);
        let scale_y = (target / s).max(1.0);
        let mk = |c: char| -> B {
            let w = self.m.advance(&c.to_string(), s, Variant::Plain);
            let (ga, gd) = (0.75 * s * scale_y, 0.25 * s * scale_y);
            let y = -axis + (ga - gd) / 2.0;
            B {
                w,
                a: ga - y,
                d: gd + y,
                items: vec![Item::Glyphs {
                    text: c.to_string(),
                    x: 0.0,
                    y,
                    size: s,
                    variant: Variant::Plain,
                    scale_y,
                }],
            }
        };
        let mut out = B::default();
        let mut x = 0.0;
        if let Some(c) = open {
            let b = mk(c);
            let w = b.w;
            out.put(b, 0.0, 0.0);
            x += w;
        }
        let iw = inner.w;
        out.put(inner, x, 0.0);
        x += iw;
        if let Some(c) = close {
            let b = mk(c);
            let w = b.w;
            out.put(b, x, 0.0);
            x += w;
        }
        out.w = x;
        out
    }

    /// Rows of cells on a common baseline grid, centred on the axis.
    fn grid(&self, cells: Vec<Vec<B>>, centred: bool, s: f32) -> B {
        let k = self.k;
        let ncols = cells.iter().map(Vec::len).max().unwrap_or(0);
        let mut widths = vec![0.0f32; ncols];
        for r in &cells {
            for (c, b) in r.iter().enumerate() {
                widths[c] = widths[c].max(b.w);
            }
        }
        let gap = if centred { k.column_gap * s } else { 0.0 };
        let mut xs = Vec::with_capacity(ncols);
        let mut x = 0.0;
        for w in &widths {
            xs.push(x);
            x += w + gap;
        }
        let total_w = if ncols == 0 { 0.0 } else { x - gap };
        let mut out = B::default();
        let mut baseline = 0.0f32;
        let mut prev_d = 0.0f32;
        let mut placed: Vec<(f32, Vec<B>)> = Vec::new();
        for (i, r) in cells.into_iter().enumerate() {
            let a = r.iter().map(|b| b.a).fold(0.0, f32::max);
            let d = r.iter().map(|b| b.d).fold(0.0, f32::max);
            if i > 0 {
                baseline += (k.baseline_skip * s).max(prev_d + a + 0.2 * s);
            }
            prev_d = d;
            placed.push((baseline, r));
        }
        let top = placed
            .first()
            .map_or(0.0, |(y, r)| y - r.iter().map(|b| b.a).fold(0.0, f32::max));
        let bottom = placed
            .last()
            .map_or(0.0, |(y, r)| y + r.iter().map(|b| b.d).fold(0.0, f32::max));
        let shift = -k.axis * s - (top + bottom) / 2.0;
        for (y, r) in placed {
            for (c, b) in r.into_iter().enumerate() {
                let dx = if centred {
                    (widths[c] - b.w) / 2.0
                } else {
                    0.0
                };
                out.put(b, xs[c] + dx, y + shift);
            }
        }
        out.w = total_w;
        out
    }
}
