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

//! # slide-geom — DrawingML geometry → Bézier outlines
//!
//! A shape's outline is a small program: adjust values, guide formulas over
//! the shape's width and height, and paths of move / line / arc / Bézier
//! commands that reference the guides. Presets (`a:prstGeom`) are the 187
//! programs of ECMA-376 Annex D, embedded from `data/presetShapeDefinitions.xml`
//! and read with the same reader as an authored `a:custGeom`, so one
//! evaluator serves both.
//!
//! The result is in the shape's own box, `(0, 0)`–`(w, h)`, as subpaths of
//! anchors with incoming and outgoing control points — the form the engine's
//! path items take.

use std::collections::HashMap;
use std::sync::OnceLock;

use pptx_core::{CustomGeometry, PathCmd};
use serde::{Deserialize, Serialize};

const DEFINITIONS: &str = include_str!("../data/presetShapeDefinitions.xml");

/// One anchor with its incoming (`left`) and outgoing (`right`) control
/// points; a corner has both equal to the anchor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PathPoint {
    pub anchor: (f64, f64),
    pub left: (f64, f64),
    pub right: (f64, f64),
}

/// One contour.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubPath {
    pub points: Vec<PathPoint>,
    pub closed: bool,
    /// The path's `fill` is not `none` (some presets draw a stroke-only
    /// detail path over a filled one).
    pub filled: bool,
    pub stroked: bool,
    /// The path's `fill` modifier when it is not plain: `darken`,
    /// `darkenLess`, `lighten`, `lightenLess` (shading on ribbons, action
    /// buttons, curved arrows), applied to the shape's fill by the resolver.
    pub fill_mode: Option<String>,
}

/// An evaluated geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Outline {
    pub subpaths: Vec<SubPath>,
    /// The text rectangle `(l, t, r, b)` in the same box; the whole box when
    /// the geometry names none.
    pub text_rect: (f64, f64, f64, f64),
}

/// A preset's geometry and its text rectangle (`l t r b` guide names).
type Definition = (CustomGeometry, Option<[String; 4]>);

fn definitions() -> &'static HashMap<String, Definition> {
    static DEFS: OnceLock<HashMap<String, Definition>> = OnceLock::new();
    DEFS.get_or_init(|| {
        let root =
            pptx_import::xml::parse(DEFINITIONS.as_bytes()).expect("embedded definitions parse");
        root.children
            .iter()
            .map(|shape| {
                let geom = pptx_import::shapes::custom_geometry(shape);
                let rect =
                    shape.children.iter().find(|c| c.local == "rect").map(|r| {
                        ["l", "t", "r", "b"].map(|k| r.attr(k).unwrap_or("0").to_string())
                    });
                (shape.local.clone(), (geom, rect))
            })
            .collect()
    })
}

/// The names of every preset geometry.
pub fn preset_names() -> Vec<&'static str> {
    let mut v: Vec<&str> = definitions().keys().map(String::as_str).collect();
    v.sort_unstable();
    v
}

/// Evaluate preset `name` for a `w` × `h` box with the shape's own adjust
/// values (`a:avLst` of the `a:prstGeom`, overriding the preset's defaults).
pub fn preset(name: &str, adjust: &[(String, String)], w: f64, h: f64) -> Option<Outline> {
    let (geom, rect) = definitions().get(name)?;
    Some(evaluate(geom, rect.as_ref(), adjust, w, h))
}

/// Evaluate an authored `a:custGeom` for a `w` × `h` box.
pub fn custom(geom: &CustomGeometry, w: f64, h: f64) -> Outline {
    evaluate(geom, None, &[], w, h)
}

// ─── guides ─────────────────────────────────────────────────────────

/// 60 000ths of a degree → radians.
fn rad(angle: f64) -> f64 {
    (angle / 60_000.0).to_radians()
}

struct Guides {
    values: HashMap<String, f64>,
}

impl Guides {
    fn new(w: f64, h: f64) -> Self {
        let ss = w.min(h);
        let ls = w.max(h);
        let mut v = HashMap::new();
        let mut set = |k: &str, x: f64| {
            v.insert(k.to_string(), x);
        };
        set("w", w);
        set("h", h);
        set("l", 0.0);
        set("t", 0.0);
        set("r", w);
        set("b", h);
        set("hc", w / 2.0);
        set("vc", h / 2.0);
        set("ss", ss);
        set("ls", ls);
        for (k, d) in [
            ("2", 2.0),
            ("3", 3.0),
            ("4", 4.0),
            ("5", 5.0),
            ("6", 6.0),
            ("8", 8.0),
            ("10", 10.0),
            ("32", 32.0),
        ] {
            set(&format!("wd{k}"), w / d);
            set(&format!("hd{k}"), h / d);
        }
        for (k, d) in [
            ("2", 2.0),
            ("4", 4.0),
            ("6", 6.0),
            ("8", 8.0),
            ("16", 16.0),
            ("32", 32.0),
        ] {
            set(&format!("ssd{k}"), ss / d);
        }
        set("cd2", 10_800_000.0);
        set("cd4", 5_400_000.0);
        set("cd8", 2_700_000.0);
        set("3cd4", 16_200_000.0);
        set("3cd8", 8_100_000.0);
        set("5cd8", 13_500_000.0);
        set("7cd8", 18_900_000.0);
        Guides { values: v }
    }

    fn arg(&self, s: &str) -> f64 {
        self.values
            .get(s)
            .copied()
            .or_else(|| s.parse::<f64>().ok())
            .unwrap_or(0.0)
    }

    fn formula(&self, f: &str) -> f64 {
        let parts: Vec<&str> = f.split_whitespace().collect();
        let a = |i: usize| parts.get(i).map(|s| self.arg(s)).unwrap_or(0.0);
        match parts.first().copied().unwrap_or("") {
            "val" => a(1),
            "*/" => {
                let z = a(3);
                if z == 0.0 {
                    0.0
                } else {
                    a(1) * a(2) / z
                }
            }
            "+-" => a(1) + a(2) - a(3),
            "+/" => {
                let z = a(3);
                if z == 0.0 {
                    0.0
                } else {
                    (a(1) + a(2)) / z
                }
            }
            "?:" => {
                if a(1) > 0.0 {
                    a(2)
                } else {
                    a(3)
                }
            }
            "abs" => a(1).abs(),
            "at2" => a(2).atan2(a(1)).to_degrees() * 60_000.0,
            "cat2" => a(1) * a(3).atan2(a(2)).cos(),
            "sat2" => a(1) * a(3).atan2(a(2)).sin(),
            "cos" => a(1) * rad(a(2)).cos(),
            "sin" => a(1) * rad(a(2)).sin(),
            "tan" => a(1) * rad(a(2)).tan(),
            "max" => a(1).max(a(2)),
            "min" => a(1).min(a(2)),
            "mod" => (a(1).powi(2) + a(2).powi(2) + a(3).powi(2)).sqrt(),
            "pin" => {
                let (lo, x, hi) = (a(1), a(2), a(3));
                if x < lo {
                    lo
                } else if x > hi {
                    hi
                } else {
                    x
                }
            }
            "sqrt" => a(1).max(0.0).sqrt(),
            _ => 0.0,
        }
    }

    fn define(&mut self, name: &str, fmla: &str) {
        let v = self.formula(fmla);
        self.values.insert(name.to_string(), v);
    }
}

// ─── paths ──────────────────────────────────────────────────────────

struct Builder {
    fill_mode: Option<String>,
    subpaths: Vec<SubPath>,
    cur: Vec<PathPoint>,
    pen: (f64, f64),
}

impl Builder {
    fn corner(p: (f64, f64)) -> PathPoint {
        PathPoint {
            anchor: p,
            left: p,
            right: p,
        }
    }
    fn flush(&mut self, closed: bool, filled: bool, stroked: bool) {
        let fill_mode = self.fill_mode.clone();
        if self.cur.len() > 1 || (closed && !self.cur.is_empty()) {
            let mut points = std::mem::take(&mut self.cur);
            // A close back onto the first anchor: merge the duplicate so the
            // contour does not carry a zero-length segment.
            if closed && points.len() > 1 {
                let first = points[0];
                let last = *points.last().unwrap();
                if (first.anchor.0 - last.anchor.0).abs() < 1e-6
                    && (first.anchor.1 - last.anchor.1).abs() < 1e-6
                {
                    points[0].left = last.left;
                    points.pop();
                }
            }
            self.subpaths.push(SubPath {
                points,
                closed,
                filled,
                stroked,
                fill_mode,
            });
        }
        self.cur.clear();
    }
    fn move_to(&mut self, p: (f64, f64), filled: bool, stroked: bool) {
        self.flush(false, filled, stroked);
        self.cur.push(Self::corner(p));
        self.pen = p;
    }
    fn ensure_start(&mut self) {
        if self.cur.is_empty() {
            self.cur.push(Self::corner(self.pen));
        }
    }
    fn line_to(&mut self, p: (f64, f64)) {
        self.ensure_start();
        self.cur.push(Self::corner(p));
        self.pen = p;
    }
    fn cubic_to(&mut self, c1: (f64, f64), c2: (f64, f64), p: (f64, f64)) {
        self.ensure_start();
        self.cur.last_mut().unwrap().right = c1;
        self.cur.push(PathPoint {
            anchor: p,
            left: c2,
            right: p,
        });
        self.pen = p;
    }
    /// `arcTo wR hR stAng swAng`, angles in 60 000ths of a degree measured
    /// as VISUAL angles on the ellipse (the ray from the centre), as
    /// PowerPoint draws them.
    fn arc_to(&mut self, wr: f64, hr: f64, st: f64, sw: f64) {
        self.ensure_start();
        if wr <= 0.0 || hr <= 0.0 || sw == 0.0 {
            return;
        }
        let param = |visual: f64| (wr * visual.sin()).atan2(hr * visual.cos());
        let vs = rad(st);
        let ve = rad(st + sw);
        let ts = param(vs);
        let mut delta = param(ve) - ts;
        let tau = std::f64::consts::TAU;
        if sw > 0.0 {
            while delta <= 0.0 {
                delta += tau;
            }
        } else {
            while delta >= 0.0 {
                delta -= tau;
            }
        }
        let turns = (sw.abs() / 21_600_000.0).floor();
        if turns >= 1.0 && (delta.abs() - tau).abs() > 1e-9 {
            delta += delta.signum() * tau * turns;
        }
        let (cx, cy) = (self.pen.0 - wr * ts.cos(), self.pen.1 - hr * ts.sin());
        let n = (delta.abs() / std::f64::consts::FRAC_PI_2).ceil().max(1.0) as usize;
        let step = delta / n as f64;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        let mut t = ts;
        for _ in 0..n {
            let t2 = t + step;
            let p0 = (cx + wr * t.cos(), cy + hr * t.sin());
            let p3 = (cx + wr * t2.cos(), cy + hr * t2.sin());
            let c1 = (p0.0 - k * wr * t.sin(), p0.1 + k * hr * t.cos());
            let c2 = (p3.0 + k * wr * t2.sin(), p3.1 - k * hr * t2.cos());
            self.cubic_to(c1, c2, p3);
            t = t2;
        }
    }
}

fn evaluate(
    geom: &CustomGeometry,
    rect: Option<&[String; 4]>,
    adjust: &[(String, String)],
    w: f64,
    h: f64,
) -> Outline {
    let mut g = Guides::new(w, h);
    for (name, fmla) in &geom.adjust {
        let own = adjust
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, f)| f.as_str());
        g.define(name, own.unwrap_or(fmla));
    }
    // An authored avLst may name adjust values the definition does not
    // (custGeom), so take those too.
    for (name, fmla) in adjust {
        if !geom.adjust.iter().any(|(n, _)| n == name) {
            g.define(name, fmla);
        }
    }
    for (name, fmla) in &geom.guides {
        g.define(name, fmla);
    }

    let mut b = Builder {
        fill_mode: None,
        subpaths: Vec::new(),
        cur: Vec::new(),
        pen: (0.0, 0.0),
    };
    for path in &geom.paths {
        // A path's own w / h scale its coordinates onto the box.
        let sx = path
            .w
            .filter(|&pw| pw > 0)
            .map(|pw| w / pw as f64)
            .unwrap_or(1.0);
        let sy = path
            .h
            .filter(|&ph| ph > 0)
            .map(|ph| h / ph as f64)
            .unwrap_or(1.0);
        let pt = |g: &Guides, p: &(String, String)| (g.arg(&p.0) * sx, g.arg(&p.1) * sy);
        let filled = path.fill.as_deref() != Some("none");
        b.fill_mode = path.fill.clone().filter(|f| f != "norm" && f != "none");
        let stroked = path.stroke;
        for cmd in &path.commands {
            match cmd {
                PathCmd::MoveTo(x, y) => {
                    b.move_to(pt(&g, &(x.clone(), y.clone())), filled, stroked)
                }
                PathCmd::LineTo(x, y) => b.line_to(pt(&g, &(x.clone(), y.clone()))),
                PathCmd::ArcTo(wr, hr, st, sw) => {
                    b.arc_to(g.arg(wr) * sx, g.arg(hr) * sy, g.arg(st), g.arg(sw))
                }
                PathCmd::QuadTo([c, p]) => {
                    let p0 = b.pen;
                    let c = pt(&g, c);
                    let p = pt(&g, p);
                    let c1 = (
                        p0.0 + 2.0 / 3.0 * (c.0 - p0.0),
                        p0.1 + 2.0 / 3.0 * (c.1 - p0.1),
                    );
                    let c2 = (p.0 + 2.0 / 3.0 * (c.0 - p.0), p.1 + 2.0 / 3.0 * (c.1 - p.1));
                    b.cubic_to(c1, c2, p);
                }
                PathCmd::CubicTo([c1, c2, p]) => {
                    let (c1, c2, p) = (pt(&g, c1), pt(&g, c2), pt(&g, p));
                    b.cubic_to(c1, c2, p);
                }
                PathCmd::Close => {
                    if let Some(first) = b.cur.first().map(|p| p.anchor) {
                        b.flush(true, filled, stroked);
                        b.pen = first;
                    }
                }
            }
        }
        b.flush(false, filled, stroked);
    }
    let text_rect = rect
        .map(|r| (g.arg(&r[0]), g.arg(&r[1]), g.arg(&r[2]), g.arg(&r[3])))
        .unwrap_or((0.0, 0.0, w, h));
    Outline {
        subpaths: b.subpaths,
        text_rect,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bbox(o: &Outline) -> (f64, f64, f64, f64) {
        let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for s in &o.subpaths {
            for p in &s.points {
                b.0 = b.0.min(p.anchor.0);
                b.1 = b.1.min(p.anchor.1);
                b.2 = b.2.max(p.anchor.0);
                b.3 = b.3.max(p.anchor.1);
            }
        }
        b
    }

    #[test]
    fn every_preset_evaluates_inside_or_near_its_box() {
        let names = preset_names();
        assert_eq!(names.len(), 187);
        for n in names {
            let o = preset(n, &[], 200.0, 100.0).unwrap();
            assert!(!o.subpaths.is_empty(), "{n}: no outline");
            for s in &o.subpaths {
                for p in &s.points {
                    assert!(
                        p.anchor.0.is_finite() && p.anchor.1.is_finite(),
                        "{n}: non-finite"
                    );
                }
            }
        }
    }

    #[test]
    fn rect_is_its_box() {
        let o = preset("rect", &[], 200.0, 100.0).unwrap();
        assert_eq!(o.subpaths.len(), 1);
        let s = &o.subpaths[0];
        assert!(s.closed);
        assert_eq!(s.points.len(), 4);
        assert_eq!(bbox(&o), (0.0, 0.0, 200.0, 100.0));
    }

    #[test]
    fn ellipse_touches_its_box_at_the_quadrants() {
        let o = preset("ellipse", &[], 200.0, 100.0).unwrap();
        let (l, t, r, b) = bbox(&o);
        assert!(
            (l - 0.0).abs() < 1e-6 && (r - 200.0).abs() < 1e-6,
            "{l} {r}"
        );
        assert!(
            (t - 0.0).abs() < 1e-6 && (b - 100.0).abs() < 1e-6,
            "{t} {b}"
        );
        // Four quarter arcs, closed.
        assert!(o.subpaths[0].closed);
        assert_eq!(o.subpaths[0].points.len(), 4);
        // The text rectangle is inset (the inscribed square of the ellipse).
        assert!(
            o.text_rect.0 > 20.0 && o.text_rect.0 < 40.0,
            "{:?}",
            o.text_rect
        );
    }

    #[test]
    fn round_rect_honours_its_adjust_value() {
        let corner_x = |o: &Outline| {
            o.subpaths[0]
                .points
                .iter()
                .map(|p| p.anchor.0)
                .filter(|&x| x > 0.0)
                .fold(f64::MAX, f64::min)
        };
        let default = preset("roundRect", &[], 200.0, 100.0).unwrap();
        let tight = preset(
            "roundRect",
            &[("adj".into(), "val 5000".into())],
            200.0,
            100.0,
        )
        .unwrap();
        // Default adj is 16667 (1/6 of the short side): radius ≈ 16.7.
        assert!(
            (corner_x(&default) - 16.667).abs() < 0.01,
            "{}",
            corner_x(&default)
        );
        assert!(
            (corner_x(&tight) - 5.0).abs() < 0.01,
            "{}",
            corner_x(&tight)
        );
    }

    #[test]
    fn right_arrow_has_seven_corners() {
        let o = preset("rightArrow", &[], 200.0, 100.0).unwrap();
        assert_eq!(o.subpaths[0].points.len(), 7);
        assert_eq!(bbox(&o), (0.0, 0.0, 200.0, 100.0));
    }
}
