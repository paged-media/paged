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

//! Type 1 charstrings (Type 1 Font Format, chapter 6): the glyph program
//! a Type 1 font's CharStrings hold, decrypted with key 4330, run to an
//! outline in character space and the glyph's advance. Hints are read
//! and ignored; flex (othersubrs 0–2) and hint replacement (3) follow
//! the specification's conventions.

#[cfg(test)]
use crate::geom::PathEl;
use crate::geom::{Path, Point};

pub const CHARSTRING_KEY: u16 = 4330;

#[derive(Debug, PartialEq)]
pub enum CsError {
    Stack,
    Subr,
    Depth,
    Op(u8),
}

pub struct Glyph {
    pub path: Path,
    pub width: (f64, f64),
}

struct Run<'a> {
    subrs: &'a [Vec<u8>],
    /// seac: the charstring of a StandardEncoding code.
    lookup: &'a dyn Fn(u8) -> Option<Vec<u8>>,
    stack: Vec<f64>,
    ps: Vec<f64>,
    path: Path,
    cur: Point,
    sb: Point,
    width: (f64, f64),
    flex: Option<Vec<Point>>,
    /// Offset of an accent drawn for `seac`.
    origin: Point,
    done: bool,
}

/// Run `cs` (already decrypted, lenIV bytes dropped).
pub fn run(
    cs: &[u8],
    subrs: &[Vec<u8>],
    lookup: &dyn Fn(u8) -> Option<Vec<u8>>,
) -> Result<Glyph, CsError> {
    let mut r = Run {
        subrs,
        lookup,
        stack: Vec::with_capacity(24),
        ps: Vec::new(),
        path: Path::default(),
        cur: Point::new(0.0, 0.0),
        sb: Point::new(0.0, 0.0),
        width: (0.0, 0.0),
        flex: None,
        origin: Point::new(0.0, 0.0),
        done: false,
    };
    r.exec(cs, 0)?;
    Ok(Glyph {
        path: r.path,
        width: r.width,
    })
}

impl Run<'_> {
    fn pop(&mut self) -> Result<f64, CsError> {
        self.stack.pop().ok_or(CsError::Stack)
    }

    fn args<const N: usize>(&mut self) -> Result<[f64; N], CsError> {
        if self.stack.len() < N {
            return Err(CsError::Stack);
        }
        let start = self.stack.len() - N;
        let mut a = [0.0; N];
        a.copy_from_slice(&self.stack[start..]);
        self.stack.truncate(start);
        Ok(a)
    }

    fn at(&self, p: Point) -> Point {
        Point::new(p.x + self.origin.x, p.y + self.origin.y)
    }

    fn rmove(&mut self, dx: f64, dy: f64) {
        self.cur = Point::new(self.cur.x + dx, self.cur.y + dy);
        if self.flex.is_none() {
            let p = self.at(self.cur);
            self.path.move_to(p);
        }
    }

    fn rline(&mut self, dx: f64, dy: f64) {
        self.cur = Point::new(self.cur.x + dx, self.cur.y + dy);
        let p = self.at(self.cur);
        if self.path.cur.is_none() {
            self.path.move_to(p);
        } else {
            self.path.line_to(p);
        }
    }

    fn rcurve(&mut self, v: [f64; 6]) {
        let a = Point::new(self.cur.x + v[0], self.cur.y + v[1]);
        let b = Point::new(a.x + v[2], a.y + v[3]);
        let c = Point::new(b.x + v[4], b.y + v[5]);
        self.cur = c;
        let (a, b, c) = (self.at(a), self.at(b), self.at(c));
        if self.path.cur.is_none() {
            self.path.move_to(a);
        }
        self.path.curve_to(a, b, c);
    }

    fn exec(&mut self, cs: &[u8], depth: usize) -> Result<(), CsError> {
        if depth > 16 {
            return Err(CsError::Depth);
        }
        let mut k = 0;
        while k < cs.len() && !self.done {
            let v = cs[k];
            k += 1;
            if v >= 32 {
                let n = match v {
                    32..=246 => v as f64 - 139.0,
                    247..=250 => {
                        let w = *cs.get(k).ok_or(CsError::Stack)? as f64;
                        k += 1;
                        (v as f64 - 247.0) * 256.0 + w + 108.0
                    }
                    251..=254 => {
                        let w = *cs.get(k).ok_or(CsError::Stack)? as f64;
                        k += 1;
                        -(v as f64 - 251.0) * 256.0 - w - 108.0
                    }
                    _ => {
                        let b = cs.get(k..k + 4).ok_or(CsError::Stack)?;
                        k += 4;
                        i32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64
                    }
                };
                if self.stack.len() >= 48 {
                    return Err(CsError::Stack);
                }
                self.stack.push(n);
                continue;
            }
            match v {
                1 | 3 => {
                    self.stack.clear();
                }
                4 => {
                    let [dy] = self.args()?;
                    self.rmove(0.0, dy);
                }
                5 => {
                    let [dx, dy] = self.args()?;
                    self.rline(dx, dy);
                }
                6 => {
                    let [dx] = self.args()?;
                    self.rline(dx, 0.0);
                }
                7 => {
                    let [dy] = self.args()?;
                    self.rline(0.0, dy);
                }
                8 => {
                    let a = self.args::<6>()?;
                    self.rcurve(a);
                }
                9 => {
                    self.path.close();
                    self.stack.clear();
                }
                10 => {
                    let n = self.pop()?;
                    let idx = n as usize;
                    let subr = self.subrs.get(idx).ok_or(CsError::Subr)?.clone();
                    self.exec(&subr, depth + 1)?;
                }
                11 => return Ok(()),
                13 => {
                    let [sbx, wx] = self.args()?;
                    self.sb = Point::new(sbx, 0.0);
                    self.cur = self.sb;
                    self.width = (wx, 0.0);
                }
                14 => {
                    self.done = true;
                }
                21 => {
                    let [dx, dy] = self.args()?;
                    self.rmove(dx, dy);
                }
                22 => {
                    let [dx] = self.args()?;
                    self.rmove(dx, 0.0);
                }
                30 => {
                    let [dy1, dx2, dy2, dx3] = self.args()?;
                    self.rcurve([0.0, dy1, dx2, dy2, dx3, 0.0]);
                }
                31 => {
                    let [dx1, dx2, dy2, dy3] = self.args()?;
                    self.rcurve([dx1, 0.0, dx2, dy2, 0.0, dy3]);
                }
                12 => {
                    let e = *cs.get(k).ok_or(CsError::Op(12))?;
                    k += 1;
                    self.escape(e)?;
                }
                // Type 2 / undocumented operators: ignore their operands.
                _ => self.stack.clear(),
            }
        }
        Ok(())
    }

    fn escape(&mut self, e: u8) -> Result<(), CsError> {
        match e {
            0..=2 => self.stack.clear(),
            6 => {
                let [asb, adx, ady, bchar, achar] = self.args()?;
                let base = (self.lookup)(bchar as u8).ok_or(CsError::Subr)?;
                let accent = (self.lookup)(achar as u8).ok_or(CsError::Subr)?;
                let width = self.width;
                let saved_sb = self.sb;
                self.exec(&base, 1)?;
                self.done = false;
                self.origin = Point::new(adx - asb + saved_sb.x, ady);
                self.flex = None;
                self.exec(&accent, 1)?;
                self.origin = Point::new(0.0, 0.0);
                self.width = width;
                self.done = true;
            }
            7 => {
                let [sbx, sby, wx, wy] = self.args()?;
                self.sb = Point::new(sbx, sby);
                self.cur = self.sb;
                self.width = (wx, wy);
            }
            12 => {
                let [a, b] = self.args()?;
                self.stack.push(if b == 0.0 { 0.0 } else { a / b });
            }
            16 => {
                let n_subr = self.pop()? as i32;
                let n = self.pop()? as usize;
                if self.stack.len() < n {
                    return Err(CsError::Stack);
                }
                let args = self.stack.split_off(self.stack.len() - n);
                match n_subr {
                    0 => {
                        // End of flex: seven points (a reference point,
                        // then two curves' worth) → two curves.
                        let pts = self.flex.take().unwrap_or_default();
                        if pts.len() >= 7 {
                            for c in [&pts[1..4], &pts[4..7]] {
                                let (a, b, d) = (self.at(c[0]), self.at(c[1]), self.at(c[2]));
                                if self.path.cur.is_none() {
                                    self.path.move_to(a);
                                }
                                self.path.curve_to(a, b, d);
                            }
                            self.cur = pts[6];
                        }
                        let (x, y) = (
                            args.get(1).copied().unwrap_or(self.cur.x),
                            args.get(2).copied().unwrap_or(self.cur.y),
                        );
                        // `pop pop setcurrentpoint` reads x then y.
                        self.ps.push(y);
                        self.ps.push(x);
                    }
                    1 => self.flex = Some(Vec::new()),
                    2 => {
                        let c = self.cur;
                        if let Some(f) = self.flex.as_mut() {
                            f.push(c);
                        }
                    }
                    _ => {
                        for a in args.into_iter().rev() {
                            self.ps.push(a);
                        }
                    }
                }
            }
            17 => {
                let v = self.ps.pop().unwrap_or(0.0);
                self.stack.push(v);
            }
            33 => {
                let [x, y] = self.args()?;
                self.cur = Point::new(x, y);
            }
            _ => self.stack.clear(),
        }
        Ok(())
    }
}

/// Encode `ops` as a charstring (numbers then operators), for tests
/// that build a font.
pub fn encode(items: &[CsItem]) -> Vec<u8> {
    let mut out = Vec::new();
    for it in items {
        match *it {
            CsItem::N(n) => {
                if (-107..=107).contains(&n) {
                    out.push((n + 139) as u8);
                } else if (108..=1131).contains(&n) {
                    let v = n - 108;
                    out.push((v / 256 + 247) as u8);
                    out.push((v % 256) as u8);
                } else if (-1131..=-108).contains(&n) {
                    let v = -n - 108;
                    out.push((v / 256 + 251) as u8);
                    out.push((v % 256) as u8);
                } else {
                    out.push(255);
                    out.extend_from_slice(&n.to_be_bytes());
                }
            }
            CsItem::Op(o) => out.push(o),
            CsItem::Esc(o) => out.extend_from_slice(&[12, o]),
        }
    }
    out
}

#[derive(Clone, Copy)]
pub enum CsItem {
    N(i32),
    Op(u8),
    Esc(u8),
}

#[cfg(test)]
mod tests {
    use super::CsItem::*;
    use super::*;

    #[test]
    fn a_square_glyph_and_its_width() {
        let cs = encode(&[
            N(50),
            N(600),
            Op(13), // hsbw
            N(0),
            N(0),
            Op(21), // rmoveto
            N(500),
            Op(6), // hlineto
            N(500),
            Op(7), // vlineto
            N(-500),
            Op(6),
            Op(9),
            Op(14),
        ]);
        let g = run(&cs, &[], &|_| None).unwrap();
        assert_eq!(g.width, (600.0, 0.0));
        assert_eq!(
            g.path.bez.elements()[0],
            PathEl::MoveTo(Point::new(50.0, 0.0))
        );
        assert_eq!(
            g.path.bez.elements()[1],
            PathEl::LineTo(Point::new(550.0, 0.0))
        );
        assert_eq!(g.path.bez.elements().last(), Some(&PathEl::ClosePath));
    }

    #[test]
    fn subrs_div_and_big_numbers() {
        let subr = encode(&[N(1000), N(0), Op(5), Op(11)]);
        let cs = encode(&[
            N(0),
            N(2000),
            Op(13),
            N(0),
            N(0),
            Op(21),
            N(0),
            Op(10),
            N(7),
            N(2),
            Esc(12),
            N(0),
            Op(5),
            Op(14),
        ]);
        let g = run(&cs, &[subr], &|_| None).unwrap();
        assert_eq!(g.width.0, 2000.0);
        assert_eq!(
            g.path.bez.elements()[1],
            PathEl::LineTo(Point::new(1000.0, 0.0))
        );
        assert_eq!(
            g.path.bez.elements()[2],
            PathEl::LineTo(Point::new(1003.5, 0.0))
        );
    }

    #[test]
    fn flex_draws_two_curves() {
        // The specification's flex sequence: 1 callothersubr, rmoveto +
        // 2 callothersubr seven times, then 0 callothersubr pop pop
        // setcurrentpoint.
        let mut items = vec![
            N(0),
            N(500),
            Op(13),
            N(0),
            N(0),
            Op(21),
            N(0),
            N(1),
            Esc(16),
        ];
        for (dx, dy) in [
            (10, 0),
            (10, 5),
            (10, 5),
            (10, 0),
            (10, -5),
            (10, -5),
            (10, 0),
        ] {
            items.extend([N(dx), N(dy), Op(21), N(0), N(2), Esc(16)]);
        }
        items.extend([
            N(50),
            N(70),
            N(0),
            N(3),
            N(0),
            Esc(16),
            Esc(17),
            Esc(17),
            Esc(33),
            Op(14),
        ]);
        let g = run(&encode(&items), &[], &|_| None).unwrap();
        let curves = g
            .path
            .bez
            .elements()
            .iter()
            .filter(|s| matches!(s, PathEl::CurveTo(..)))
            .count();
        assert_eq!(curves, 2);
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(run(&[10], &[], &|_| None).is_err());
        assert!(run(&[255, 1], &[], &|_| None).is_err());
        let _ = run(&[12], &[], &|_| None);
    }
}
