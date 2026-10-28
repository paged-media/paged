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

//! `HATCH` — the one way a DXF fills an area, and the way Illustrator
//! writes every fill (measured: its DXF export of a filled triangle is an
//! outline `LWPOLYLINE` plus a `SOLID` hatch over three line edges). The
//! `dxf` crate does not model it, so it is read here from the file's group
//! codes, in the order the format lays them out.
//!
//! A SOLID hatch becomes a filled path of its boundary loops — polyline
//! loops (bulges as arcs) and edge loops of lines, circular and elliptic
//! arcs and splines — filled even-odd for the "normal" island style. A
//! gradient hatch is filled with its colour (approximated); a PATTERN
//! hatch (hatching lines) is left out, reported. A hatch that cannot be
//! read to its end is left out, reported.

use crate::curves::{self, Contour, Pt, Seg, SplineNotes};

/// One `HATCH` of the ENTITIES section.
#[derive(Debug, Clone)]
pub struct Hatch {
    /// Its handle (group 5), uppercase hex; empty when it has none.
    pub handle: String,
    pub layer: String,
    /// Index colour (62), when given.
    pub index: Option<i16>,
    /// True colour (420), when given.
    pub true_color: Option<u32>,
    pub paper_space: bool,
    pub invisible: bool,
    pub solid: bool,
    pub gradient: bool,
    /// Island style 0 ("normal": alternate loops are holes).
    pub even_odd: bool,
    pub loops: Vec<Contour>,
    /// A loop had a spline edge that needed approximating.
    pub approximated: bool,
}

/// A cursor over one entity's group codes.
struct Codes<'a> {
    pairs: &'a [(i32, &'a str)],
    at: usize,
}

impl<'a> Codes<'a> {
    fn peek(&self) -> Option<i32> {
        self.pairs.get(self.at).map(|p| p.0)
    }
    /// The next pair, which must carry `code`.
    fn take(&mut self, code: i32) -> Option<&'a str> {
        let (c, v) = *self.pairs.get(self.at)?;
        (c == code).then(|| {
            self.at += 1;
            v
        })
    }
    fn f(&mut self, code: i32) -> Option<f64> {
        self.take(code)?.trim().parse().ok()
    }
    fn i(&mut self, code: i32) -> Option<i64> {
        self.take(code)?.trim().parse().ok()
    }
    fn pt(&mut self, x: i32, y: i32) -> Option<Pt> {
        Some([self.f(x)?, self.f(y)?])
    }
    /// Skip to the next pair carrying `code`.
    fn seek(&mut self, code: i32) -> bool {
        while let Some(c) = self.peek() {
            if c == code {
                return true;
            }
            self.at += 1;
        }
        false
    }
}

/// What the ENTITIES section says beyond what the `dxf` crate reads.
#[derive(Debug, Default)]
pub struct Section {
    /// Every `HATCH`, in file order, with its position among the
    /// section's entities. `Err` names a hatch that could not be read.
    pub hatches: Vec<(usize, Result<Hatch, String>)>,
    /// Each entity's position by its handle (uppercase hex): paint order,
    /// for the crate's entities to be merged with the hatches.
    pub order: std::collections::HashMap<String, usize>,
}

/// Read an ASCII DXF's ENTITIES section for its hatches and its order.
/// (A binary DXF answers nothing.)
pub fn section(bytes: &[u8]) -> Section {
    let mut out = Section::default();
    if bytes.starts_with(b"AutoCAD Binary DXF") {
        return out;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut lines = text.lines();
    let mut pairs: Vec<(i32, &str)> = Vec::new();
    while let (Some(c), Some(v)) = (lines.next(), lines.next()) {
        match c.trim().parse() {
            Ok(code) => pairs.push((code, v.trim_end())),
            Err(_) => return out,
        }
    }
    // The ENTITIES section's entities, as runs of pairs.
    let mut i = 0;
    let mut in_entities = false;
    let mut index = 0;
    while i < pairs.len() {
        let (c, v) = pairs[i];
        if c == 0 && v.trim() == "SECTION" {
            in_entities = pairs.get(i + 1).is_some_and(|p| p.1.trim() == "ENTITIES");
            i += 1;
            continue;
        }
        if c == 0 && v.trim() == "ENDSEC" {
            in_entities = false;
        }
        if in_entities && c == 0 && v.trim() != "ENDSEC" {
            let end = pairs[i + 1..]
                .iter()
                .position(|p| p.0 == 0)
                .map_or(pairs.len(), |n| i + 1 + n);
            let name = v.trim();
            if name == "HATCH" {
                out.hatches.push((index, read(&pairs[i + 1..end])));
            }
            if name != "VERTEX" && name != "SEQEND" && name != "ATTRIB" {
                if let Some((_, handle)) = pairs[i + 1..end].iter().find(|p| p.0 == 5) {
                    out.order.insert(handle.trim().to_uppercase(), index);
                }
                index += 1;
            }
            i = end;
            continue;
        }
        i += 1;
    }
    out
}

fn read(pairs: &[(i32, &str)]) -> Result<Hatch, String> {
    let mut h = Hatch {
        handle: String::new(),
        layer: "0".into(),
        index: None,
        true_color: None,
        paper_space: false,
        invisible: false,
        solid: false,
        gradient: false,
        even_odd: true,
        loops: Vec::new(),
        approximated: false,
    };
    // The common part, up to the hatch's own subclass.
    let mut at = 0;
    while at < pairs.len() {
        let (c, v) = pairs[at];
        let v = v.trim();
        match c {
            5 => h.handle = v.to_uppercase(),
            8 => h.layer = v.to_string(),
            62 => h.index = v.parse().ok(),
            420 => h.true_color = v.parse::<i64>().ok().map(|n| n as u32),
            67 => h.paper_space = v == "1",
            60 => h.invisible = v == "1",
            100 if v == "AcDbHatch" => {
                at += 1;
                break;
            }
            _ => {}
        }
        at += 1;
    }
    let mut c = Codes { pairs, at };
    let bad = |what: &str| format!("a HATCH whose {what} could not be read");
    // Elevation, extrusion, pattern name, solid flag, associativity.
    if !c.seek(70) {
        return Err(bad("fill flag"));
    }
    h.solid = c.i(70) == Some(1);
    c.i(71);
    let n = c.i(91).ok_or_else(|| bad("loop count"))?;
    for _ in 0..n {
        let flags = c.i(92).ok_or_else(|| bad("loop"))?;
        let contour = if flags & 2 != 0 {
            polyline_loop(&mut c)
        } else {
            edge_loop(&mut c, &mut h.approximated)
        }
        .ok_or_else(|| bad("boundary"))?;
        // The loop's source objects (associativity).
        if let Some(k) = c.i(97) {
            for _ in 0..k {
                c.take(330);
            }
        }
        h.loops.push(contour);
    }
    if let Some(style) = c.i(75) {
        h.even_odd = style == 0;
    }
    // A gradient hatch says so with 450 = 1, after the pattern data.
    if c.seek(450) {
        h.gradient = c.i(450) == Some(1);
    }
    Ok(h)
}

fn polyline_loop(c: &mut Codes) -> Option<Contour> {
    let has_bulge = c.i(72)? != 0;
    c.i(73);
    let n = c.i(93)?;
    let mut pts: Vec<(Pt, f64)> = Vec::new();
    for _ in 0..n {
        let p = c.pt(10, 20)?;
        let bulge = if has_bulge {
            c.f(42).unwrap_or(0.0)
        } else {
            0.0
        };
        pts.push((p, bulge));
    }
    let (first, _) = *pts.first()?;
    let mut out = Contour::new(first);
    for w in pts.windows(2) {
        curves::bulge_segment(w[0].0, w[1].0, w[0].1, &mut out.segs);
    }
    let (last, bulge) = pts[pts.len() - 1];
    if last != first {
        curves::bulge_segment(last, first, bulge, &mut out.segs);
    }
    out.closed = true;
    Some(out)
}

fn edge_loop(c: &mut Codes, approximated: &mut bool) -> Option<Contour> {
    let n = c.i(93)?;
    let mut out: Option<Contour> = None;
    let join = |out: &mut Option<Contour>, start: Pt, segs: Vec<Seg>| {
        let contour = out.get_or_insert_with(|| Contour::new(start));
        let end = contour.end();
        if (end[0] - start[0]).abs() > 1e-9 || (end[1] - start[1]).abs() > 1e-9 {
            if !contour.segs.is_empty() || contour.start != start {
                contour.segs.push(Seg::Line(start));
            }
        }
        contour.segs.extend(segs);
    };
    for _ in 0..n {
        match c.i(72)? {
            1 => {
                let a = c.pt(10, 20)?;
                let b = c.pt(11, 21)?;
                join(&mut out, a, vec![Seg::Line(b)]);
            }
            2 => {
                let centre = c.pt(10, 20)?;
                let r = c.f(40)?;
                let (s, e) = (c.f(50)?.to_radians(), c.f(51)?.to_radians());
                let ccw = c.i(73).unwrap_or(1) != 0;
                let (t0, sweep) = arc_sweep(s, e, ccw);
                let mut segs = Vec::new();
                let start = curves::ellipse_arc(centre, [r, 0.0], [0.0, r], t0, sweep, &mut segs);
                join(&mut out, start, segs);
            }
            3 => {
                let centre = c.pt(10, 20)?;
                let major = c.pt(11, 21)?;
                let ratio = c.f(40)?;
                let (s, e) = (c.f(50)?.to_radians(), c.f(51)?.to_radians());
                let ccw = c.i(73).unwrap_or(1) != 0;
                let minor = [-major[1] * ratio, major[0] * ratio];
                let (t0, sweep) = arc_sweep(s, e, ccw);
                let mut segs = Vec::new();
                let start = curves::ellipse_arc(centre, major, minor, t0, sweep, &mut segs);
                join(&mut out, start, segs);
            }
            4 => {
                let degree = c.i(94)? as usize;
                let rational = c.i(73)? != 0;
                c.i(74);
                let nk = c.i(95)? as usize;
                let nc = c.i(96)? as usize;
                let mut knots = Vec::with_capacity(nk);
                for _ in 0..nk {
                    knots.push(c.f(40)?);
                }
                let mut ctrl = Vec::with_capacity(nc);
                let mut weights = Vec::new();
                for _ in 0..nc {
                    ctrl.push(c.pt(10, 20)?);
                    if rational {
                        weights.push(c.f(42).unwrap_or(1.0));
                    }
                }
                if let Some(nf) = c.i(97) {
                    for _ in 0..nf {
                        c.pt(11, 21)?;
                    }
                    if nf > 0 {
                        c.pt(12, 22);
                        c.pt(13, 23);
                    }
                }
                let mut notes = SplineNotes::default();
                let s = curves::spline(degree, &knots, &ctrl, &weights, &mut notes)?;
                *approximated |= notes.approximated;
                join(&mut out, s.start, s.segs);
            }
            _ => return None,
        }
    }
    let mut out = out?;
    out.closed = true;
    Some(out)
}

/// An arc edge's start and signed sweep. A clockwise edge stores its
/// angles mirrored: it runs from -start to -end, clockwise.
fn arc_sweep(s: f64, e: f64, ccw: bool) -> (f64, f64) {
    let tau = std::f64::consts::TAU;
    if ccw {
        let mut sweep = e - s;
        if sweep <= 0.0 {
            sweep += tau;
        }
        (s, sweep)
    } else {
        let mut sweep = e - s;
        if sweep <= 0.0 {
            sweep += tau;
        }
        (-s, -sweep)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dxf(entities: &str) -> String {
        format!("0\nSECTION\n2\nENTITIES\n{entities}0\nENDSEC\n0\nEOF\n")
    }

    #[test]
    fn a_solid_hatch_of_line_edges_is_one_closed_loop() {
        let text = dxf(
            "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n\
             0\nHATCH\n5\n7D\n8\nWalls\n62\n1\n100\nAcDbEntity\n100\nAcDbHatch\n10\n0\n20\n0\n30\n0\n210\n0\n220\n0\n230\n1\n2\nSOLID\n70\n1\n71\n0\n91\n1\n92\n1\n93\n3\n\
             72\n1\n10\n0\n20\n0\n11\n10\n21\n0\n\
             72\n1\n10\n10\n20\n0\n11\n5\n21\n8\n\
             72\n1\n10\n5\n20\n8\n11\n0\n21\n0\n\
             97\n0\n75\n0\n76\n1\n98\n0\n",
        );
        let sec = section(text.as_bytes());
        let hs = &sec.hatches;
        assert_eq!(hs.len(), 1);
        assert_eq!(sec.order.get("7D"), Some(&1));
        let (index, h) = &hs[0];
        assert_eq!(*index, 1, "after the LINE");
        let h = h.as_ref().unwrap();
        assert!(h.solid && h.even_odd && !h.gradient);
        assert_eq!(
            (h.handle.as_str(), h.layer.as_str(), h.index),
            ("7D", "Walls", Some(1))
        );
        assert_eq!(h.loops.len(), 1);
        assert_eq!(h.loops[0].segs.len(), 3);
        assert!(h.loops[0].closed);
    }

    #[test]
    fn a_polyline_loop_keeps_its_bulges() {
        let text = dxf(
            "0\nHATCH\n8\n0\n100\nAcDbHatch\n2\nSOLID\n70\n1\n71\n0\n91\n1\n92\n2\n72\n1\n73\n1\n93\n2\n\
             10\n0\n20\n0\n42\n1\n10\n10\n20\n0\n42\n1\n97\n0\n75\n1\n76\n1\n98\n0\n",
        );
        let sec = section(text.as_bytes());
        let h = sec.hatches[0].1.as_ref().unwrap();
        // Two half circles: a full circle of four quarter cubics.
        assert_eq!(h.loops[0].segs.len(), 4);
        assert!(!h.even_odd, "style 1 is not the normal (alternating) style");
    }

    #[test]
    fn a_truncated_hatch_is_an_error() {
        let text = dxf(
            "0\nHATCH\n8\n0\n100\nAcDbHatch\n70\n1\n71\n0\n91\n2\n92\n1\n93\n1\n72\n1\n10\n0\n",
        );
        assert!(section(text.as_bytes()).hatches[0].1.is_err());
    }
}
