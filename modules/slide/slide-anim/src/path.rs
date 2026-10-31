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

//! Motion paths (`p:animMotion path`, ECMA-376 Part 1 §19.5.4): `M`, `L`,
//! `C`, `Z` and `E` (end) in slide fractions, relative to where the shape
//! stands; lower-case commands are relative to the current point. The
//! shape moves along the path at constant speed (by arc length in points),
//! as PowerPoint plays it.

/// A path flattened to a polyline with its cumulative lengths.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MotionPath {
    /// Points in slide fractions.
    pts: Vec<(f64, f64)>,
    /// Cumulative length at each point, in points (aspect-correct).
    len: Vec<f64>,
}

const CURVE_STEPS: usize = 24;

impl MotionPath {
    /// Parse `path` for a slide of `w` × `h` pt (lengths are measured in
    /// points so a diagonal is as fast as a horizontal).
    pub fn parse(path: &str, w: f64, h: f64) -> MotionPath {
        let toks = tokens(path);
        let mut pts: Vec<(f64, f64)> = Vec::new();
        let mut cur = (0.0, 0.0);
        let mut start = (0.0, 0.0);
        let mut i = 0;
        let mut cmd = 'M';
        let num = |i: &mut usize| -> Option<f64> {
            match toks.get(*i) {
                Some(Tok::Num(n)) => {
                    *i += 1;
                    Some(*n)
                }
                _ => None,
            }
        };
        while i < toks.len() {
            if let Tok::Cmd(c) = toks[i] {
                cmd = c;
                i += 1;
            }
            let rel = cmd.is_ascii_lowercase();
            let off = |p: (f64, f64), cur: (f64, f64)| {
                if rel {
                    (p.0 + cur.0, p.1 + cur.1)
                } else {
                    p
                }
            };
            match cmd.to_ascii_uppercase() {
                'M' => {
                    let (Some(x), Some(y)) = (num(&mut i), num(&mut i)) else {
                        break;
                    };
                    cur = off((x, y), cur);
                    start = cur;
                    pts.push(cur);
                    // Further pairs after M are line-tos.
                    cmd = if rel { 'l' } else { 'L' };
                }
                'L' => {
                    let (Some(x), Some(y)) = (num(&mut i), num(&mut i)) else {
                        break;
                    };
                    if pts.is_empty() {
                        pts.push(cur);
                    }
                    cur = off((x, y), cur);
                    pts.push(cur);
                }
                'C' => {
                    let mut c = [0.0f64; 6];
                    for v in c.iter_mut() {
                        match num(&mut i) {
                            Some(n) => *v = n,
                            None => return MotionPath::finish(pts, w, h),
                        }
                    }
                    if pts.is_empty() {
                        pts.push(cur);
                    }
                    let p0 = cur;
                    let p1 = off((c[0], c[1]), cur);
                    let p2 = off((c[2], c[3]), cur);
                    let p3 = off((c[4], c[5]), cur);
                    for k in 1..=CURVE_STEPS {
                        let t = k as f64 / CURVE_STEPS as f64;
                        let u = 1.0 - t;
                        let b = |a: f64, b: f64, c: f64, d: f64| {
                            u * u * u * a
                                + 3.0 * u * u * t * b
                                + 3.0 * u * t * t * c
                                + t * t * t * d
                        };
                        pts.push((b(p0.0, p1.0, p2.0, p3.0), b(p0.1, p1.1, p2.1, p3.1)));
                    }
                    cur = p3;
                }
                'Z' => {
                    cur = start;
                    pts.push(cur);
                }
                'E' => break,
                _ => {
                    // An unknown command: skip its numbers.
                    while num(&mut i).is_some() {}
                    if i < toks.len() && !matches!(toks[i], Tok::Cmd(_)) {
                        i += 1;
                    }
                }
            }
        }
        MotionPath::finish(pts, w, h)
    }

    fn finish(pts: Vec<(f64, f64)>, w: f64, h: f64) -> MotionPath {
        let mut len = Vec::with_capacity(pts.len());
        let mut acc = 0.0;
        for (k, p) in pts.iter().enumerate() {
            if k > 0 {
                let q = pts[k - 1];
                acc += ((p.0 - q.0) * w).hypot((p.1 - q.1) * h);
            }
            len.push(acc);
        }
        MotionPath { pts, len }
    }

    /// The point at `p` (0..1 of the length), in slide fractions; the
    /// origin when the path is empty.
    pub fn at(&self, p: f64) -> (f64, f64) {
        let Some(&last) = self.pts.last() else {
            return (0.0, 0.0);
        };
        let total = *self.len.last().unwrap_or(&0.0);
        if total <= 0.0 {
            return last;
        }
        let d = p.clamp(0.0, 1.0) * total;
        let k = self
            .len
            .partition_point(|&l| l < d)
            .max(1)
            .min(self.pts.len() - 1);
        let (l0, l1) = (self.len[k - 1], self.len[k]);
        let f = if l1 > l0 { (d - l0) / (l1 - l0) } else { 1.0 };
        let (a, b) = (self.pts[k - 1], self.pts[k]);
        (a.0 + (b.0 - a.0) * f, a.1 + (b.1 - a.1) * f)
    }

    /// The path's last point.
    pub fn end(&self) -> (f64, f64) {
        self.pts.last().copied().unwrap_or((0.0, 0.0))
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tok {
    Cmd(char),
    Num(f64),
}

fn tokens(s: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_alphabetic() && !(c == b'e' && i > 0 && b[i - 1].is_ascii_digit()) {
            out.push(Tok::Cmd(c as char));
            i += 1;
        } else if c.is_ascii_digit() || c == b'-' || c == b'+' || c == b'.' {
            let start = i;
            i += 1;
            while i < b.len()
                && (b[i].is_ascii_digit()
                    || b[i] == b'.'
                    || ((b[i] == b'e' || b[i] == b'E') && i + 1 < b.len())
                    || ((b[i] == b'-' || b[i] == b'+') && (b[i - 1] == b'e' || b[i - 1] == b'E')))
            {
                i += 1;
            }
            if let Ok(n) = s[start..i].parse() {
                out.push(Tok::Num(n));
            }
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_at_constant_speed_and_ends_at_the_end() {
        // Right 0.5 of the width, then down 0.5 of the height: on a 100 × 50
        // slide, 50 pt then 25 pt.
        let p = MotionPath::parse("M 0 0 L 0.5 0 L 0.5 0.5 E", 100.0, 50.0);
        assert_eq!(p.at(0.0), (0.0, 0.0));
        assert_eq!(p.end(), (0.5, 0.5));
        let (x, y) = p.at(1.0);
        assert!((x - 0.5).abs() < 1e-12 && (y - 0.5).abs() < 1e-12);
        // Two thirds of 75 pt: at the corner.
        let (x, y) = p.at(2.0 / 3.0);
        assert!((x - 0.5).abs() < 1e-9 && y.abs() < 1e-9);
        let (x, _) = p.at(1.0 / 3.0);
        assert!((x - 0.25).abs() < 1e-9);
    }

    #[test]
    fn reads_curves_closes_and_relative_commands() {
        let c = MotionPath::parse("M 0 0 C 0.1 0 0.2 0.1 0.2 0.2 Z E", 960.0, 540.0);
        assert_eq!(c.end(), (0.0, 0.0));
        let r = MotionPath::parse("m 0 0 l 0.1 0.1 l 0.1 0 E", 1.0, 1.0);
        assert!((r.end().0 - 0.2).abs() < 1e-12 && (r.end().1 - 0.1).abs() < 1e-12);
        assert_eq!(MotionPath::parse("", 1.0, 1.0).at(0.5), (0.0, 0.0));
        let sci = MotionPath::parse("M 0 0 L 1.5e-2 -2E-2 E", 1.0, 1.0);
        assert!((sci.end().0 - 0.015).abs() < 1e-12 && (sci.end().1 + 0.02).abs() < 1e-12);
    }
}
