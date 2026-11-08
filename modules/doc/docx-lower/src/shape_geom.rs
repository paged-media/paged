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

//! Doc ADR 627 — a DrawingML shape's outline in the shape's own box, as the
//! path anchors the engine draws (`[x, y, left x, left y, right x, right y]`
//! in points, `(0, 0)` at the box's top left).
//!
//! A preset is evaluated by `dml-geom` from ECMA-376 Annex D's definitions
//! (all 187, with their `a:avLst` guides; doc ADR 629, which replaced the
//! hand port of fourteen that ADR 627 made while the definitions did not fit
//! the doc wasm). An authored `a:custGeom` whose points are literal numbers
//! is scaled from each path's own space. A name that is not a preset is
//! told, never guessed.

use docx_core::{CustomPath, PathCommand, Shape, ShapeGeometry};

/// Anchors of one shape: every contour's anchors in order, where each
/// contour starts and whether it is left open (stroked, not filled).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outline {
    pub anchors: Vec<[f32; 6]>,
    pub starts: Vec<usize>,
    pub open: Vec<bool>,
}

/// A pen that draws contours as anchors with handles.
#[derive(Default)]
struct Pen {
    out: Outline,
    /// The current contour began at `start` (an index into `anchors`).
    start: Option<usize>,
}

impl Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.finish(true);
        self.start = Some(self.out.anchors.len());
        self.out.starts.push(self.out.anchors.len());
        self.out.open.push(true);
        self.out.anchors.push([x, y, x, y, x, y]);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.out.anchors.push([x, y, x, y, x, y]);
    }

    fn cubic_to(&mut self, c1: (f32, f32), c2: (f32, f32), p: (f32, f32)) {
        if let Some(last) = self.out.anchors.last_mut() {
            last[4] = c1.0;
            last[5] = c1.1;
        }
        self.out.anchors.push([p.0, p.1, c2.0, c2.1, p.0, p.1]);
    }

    fn quad_to(&mut self, c: (f32, f32), p: (f32, f32)) {
        let Some(from) = self.out.anchors.last() else {
            return;
        };
        let (x0, y0) = (from[0], from[1]);
        // The quadratic as the cubic with the same curve.
        let c1 = (x0 + 2.0 / 3.0 * (c.0 - x0), y0 + 2.0 / 3.0 * (c.1 - y0));
        let c2 = (p.0 + 2.0 / 3.0 * (c.0 - p.0), p.1 + 2.0 / 3.0 * (c.1 - p.1));
        self.cubic_to(c1, c2, p);
    }

    /// Close the contour: a last anchor on the first one is that anchor (its
    /// incoming handle becomes the first's), then the contour is closed.
    fn close(&mut self) {
        self.finish(false);
    }

    fn finish(&mut self, open: bool) {
        let Some(start) = self.start.take() else {
            return;
        };
        if !open {
            let n = self.out.anchors.len();
            if n > start + 1 {
                let (first, last) = (self.out.anchors[start], self.out.anchors[n - 1]);
                if (first[0] - last[0]).abs() < 1e-3 && (first[1] - last[1]).abs() < 1e-3 {
                    self.out.anchors[start][2] = last[2];
                    self.out.anchors[start][3] = last[3];
                    self.out.anchors.pop();
                }
            }
            if let Some(o) = self.out.open.last_mut() {
                *o = false;
            }
        }
    }

    fn done(mut self) -> Outline {
        self.finish(true);
        self.out
    }
}

/// An authored geometry's outline: each path's points scaled from its own
/// space to the box; a path that is `fill="none"` is left open.
fn custom(paths: &[CustomPath], shape: &Shape, w: f32, h: f32) -> Outline {
    let mut pen = Pen::default();
    for path in paths {
        let pw = if path.w > 0 { path.w } else { shape.width_emu }.max(1) as f32;
        let ph = if path.h > 0 { path.h } else { shape.height_emu }.max(1) as f32;
        let p = |x: i64, y: i64| (x as f32 * w / pw, y as f32 * h / ph);
        let mut first: Option<(f32, f32)> = None;
        for cmd in &path.commands {
            match *cmd {
                PathCommand::Move(x, y) => {
                    let (x, y) = p(x, y);
                    first = Some((x, y));
                    pen.move_to(x, y);
                }
                PathCommand::Line(x, y) => {
                    let (x, y) = p(x, y);
                    pen.line_to(x, y);
                }
                PathCommand::Quad([cx, cy, x, y]) => pen.quad_to(p(cx, cy), p(x, y)),
                PathCommand::Cubic([ax, ay, bx, by, x, y]) => {
                    pen.cubic_to(p(ax, ay), p(bx, by), p(x, y))
                }
                PathCommand::Close => {
                    if path.no_fill {
                        // Stroked only: the closing segment is drawn.
                        if let Some((x, y)) = first {
                            pen.line_to(x, y);
                        }
                        pen.finish(true);
                    } else {
                        pen.close();
                    }
                }
            }
        }
    }
    pen.done()
}

/// Turn the outline by `shape`'s flips and rotation, about the box's centre.
fn transform(out: &mut Outline, shape: &Shape, w: f32, h: f32) {
    let angle = (shape.rotation as f32 / 60_000.0).to_radians();
    let (sin, cos) = angle.sin_cos();
    let (cx, cy) = (w / 2.0, h / 2.0);
    let map = |x: f32, y: f32| {
        let x = if shape.flip_h { w - x } else { x };
        let y = if shape.flip_v { h - y } else { y };
        if shape.rotation == 0 {
            return (x, y);
        }
        let (dx, dy) = (x - cx, y - cy);
        (cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
    };
    for a in &mut out.anchors {
        for i in 0..3 {
            let (x, y) = map(a[i * 2], a[i * 2 + 1]);
            a[i * 2] = x;
            a[i * 2 + 1] = y;
        }
    }
}

/// A preset's outline in a `w` x `h` pt box through `dml-geom`'s evaluator
/// of Annex D's definitions; a contour that is not filled (a detail line) is
/// left open. `None` for a name that is not a preset.
fn preset(name: &str, adjust: &[(String, i64)], w: f32, h: f32) -> Option<Outline> {
    let adjust: Vec<(String, String)> = adjust
        .iter()
        .map(|(n, v)| (n.clone(), format!("val {v}")))
        .collect();
    let o = dml_geom::preset(name, &adjust, w as f64, h as f64)?;
    let mut out = Outline::default();
    for sp in &o.subpaths {
        if sp.points.is_empty() {
            continue;
        }
        out.starts.push(out.anchors.len());
        out.open.push(!(sp.closed && sp.filled));
        for p in &sp.points {
            out.anchors.push([
                p.anchor.0 as f32,
                p.anchor.1 as f32,
                p.left.0 as f32,
                p.left.1 as f32,
                p.right.0 as f32,
                p.right.1 as f32,
            ]);
        }
    }
    Some(out)
}

/// One line end (arrow head) of a shape's open outline, in the shape's box:
/// filled in the line's colour, or stroked with the line (`open`, Office's
/// `arrow`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Head {
    pub anchors: Vec<[f32; 6]>,
    pub open: bool,
}

/// The control-point distance of a quarter ellipse, over its radius.
const KAPPA: f32 = 0.552_284_8;

/// Office's arrow head sizes (`sm`, `med`, `lg`) as multiples of the line
/// width.
fn factor(size: Option<&str>) -> f32 {
    match size {
        Some("sm") => 2.0,
        Some("lg") => 5.0,
        _ => 3.0,
    }
}

/// The line ends of the first open contour of `o` (a line, a connector, an
/// arc): `a:headEnd` at its start, `a:tailEnd` at its end, sized by the
/// line's width `width_pt`, each pointing along the line. Closed outlines
/// take none, as in Office. The kinds it does not draw are returned by name.
pub fn heads(
    o: &Outline,
    head: Option<&paged_ooxml::drawingml::LineEnd>,
    tail: Option<&paged_ooxml::drawingml::LineEnd>,
    width_pt: f32,
) -> (Vec<Head>, Vec<String>) {
    let (mut out, mut undrawn) = (Vec::new(), Vec::new());
    let Some(c) = o.open.iter().position(|open| *open) else {
        return (out, undrawn);
    };
    let start = o.starts[c];
    let end = o.starts.get(c + 1).copied().unwrap_or(o.anchors.len());
    if end < start + 2 {
        return (out, undrawn);
    }
    let pt = |a: &[f32; 6]| (a[0], a[1]);
    let first = &o.anchors[start];
    let last = &o.anchors[end - 1];
    // The direction the line arrives in at each end: from the handle when
    // the end is curved, else from the neighbouring anchor.
    let from = |tip: (f32, f32), handle: (f32, f32), next: (f32, f32)| {
        let toward = if (handle.0 - tip.0).hypot(handle.1 - tip.1) > 1e-3 {
            handle
        } else {
            next
        };
        let (dx, dy) = (tip.0 - toward.0, tip.1 - toward.1);
        let n = dx.hypot(dy).max(1e-6);
        (dx / n, dy / n)
    };
    let ends = [
        (
            head,
            pt(first),
            from(pt(first), (first[4], first[5]), pt(&o.anchors[start + 1])),
        ),
        (
            tail,
            pt(last),
            from(pt(last), (last[2], last[3]), pt(&o.anchors[end - 2])),
        ),
    ];
    let lw = width_pt.max(0.75);
    for (end, tip, (dx, dy)) in ends {
        let Some(e) = end else { continue };
        let (len, wid) = (lw * factor(e.len.as_deref()), lw * factor(e.w.as_deref()));
        // Along the line (back from the tip) and across it.
        let at =
            |back: f32, side: f32| (tip.0 - dx * back - dy * side, tip.1 - dy * back + dx * side);
        let corner = |p: (f32, f32)| [p.0, p.1, p.0, p.1, p.0, p.1];
        let (anchors, open): (Vec<[f32; 6]>, bool) = match e.kind.as_str() {
            "none" | "" => continue,
            "triangle" => (
                [at(0.0, 0.0), at(len, wid / 2.0), at(len, -wid / 2.0)]
                    .map(corner)
                    .to_vec(),
                false,
            ),
            "stealth" => (
                [
                    at(0.0, 0.0),
                    at(len, wid / 2.0),
                    at(len * 0.6, 0.0),
                    at(len, -wid / 2.0),
                ]
                .map(corner)
                .to_vec(),
                false,
            ),
            "arrow" => (
                [at(len, wid / 2.0), at(0.0, 0.0), at(len, -wid / 2.0)]
                    .map(corner)
                    .to_vec(),
                true,
            ),
            "diamond" => (
                [
                    at(-len / 2.0, 0.0),
                    at(0.0, wid / 2.0),
                    at(len / 2.0, 0.0),
                    at(0.0, -wid / 2.0),
                ]
                .map(corner)
                .to_vec(),
                false,
            ),
            "oval" => {
                // An ellipse about the end point, its axes along and across
                // the line.
                let (a, b) = (len / 2.0, wid / 2.0);
                let pts = [(-a, 0.0), (0.0, b), (a, 0.0), (0.0, -b)];
                let tangents = [(0.0, b), (a, 0.0), (0.0, -b), (-a, 0.0)];
                let anchors = pts
                    .iter()
                    .zip(tangents)
                    .map(|(&(u, v), (tu, tv))| {
                        let p = at(u, v);
                        let l = at(u - KAPPA * tu, v - KAPPA * tv);
                        let r = at(u + KAPPA * tu, v + KAPPA * tv);
                        [p.0, p.1, l.0, l.1, r.0, r.1]
                    })
                    .collect();
                (anchors, false)
            }
            other => {
                if !undrawn.iter().any(|u| u == other) {
                    undrawn.push(other.to_string());
                }
                continue;
            }
        };
        out.push(Head { anchors, open });
    }
    (out, undrawn)
}

/// The outline of `shape` in a `w` x `h` pt box, or why it is not drawn.
pub fn outline(shape: &Shape, w: f32, h: f32) -> Result<Outline, String> {
    let mut out = match &shape.geometry {
        ShapeGeometry::Preset { name, adjust } => {
            preset(name, adjust, w, h).ok_or_else(|| format!("preset \u{201c}{name}\u{201d}"))?
        }
        ShapeGeometry::Custom(paths) => custom(paths, shape, w, h),
        ShapeGeometry::Unsupported => return Err("a custom geometry with guides or arcs".into()),
    };
    if out.anchors.is_empty() {
        return Err("an empty geometry".into());
    }
    transform(&mut out, shape, w, h);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(name: &str, adjust: &[(&str, i64)]) -> Shape {
        Shape {
            geometry: ShapeGeometry::Preset {
                name: name.into(),
                adjust: adjust.iter().map(|(n, v)| (n.to_string(), *v)).collect(),
            },
            ..Shape::default()
        }
    }

    fn pos(o: &Outline) -> Vec<(f32, f32)> {
        o.anchors.iter().map(|a| (a[0], a[1])).collect()
    }

    #[test]
    fn a_triangle_puts_its_apex_by_adj() {
        let o = outline(&shape("triangle", &[("adj", 25000)]), 100.0, 60.0).unwrap();
        assert_eq!(pos(&o), vec![(0.0, 60.0), (25.0, 0.0), (100.0, 60.0)]);
        assert_eq!((o.starts.clone(), o.open.clone()), (vec![0], vec![false]));
    }

    #[test]
    fn a_rounded_rectangle_rounds_by_the_short_side() {
        let o = outline(&shape("roundRect", &[("adj", 50000)]), 100.0, 40.0).unwrap();
        // adj 50 % of the short side: a stadium; the top edge runs from
        // `r` in to `r` from the right.
        let top: Vec<f32> = pos(&o)
            .iter()
            .filter(|(_, y)| y.abs() < 1e-3)
            .map(|(x, _)| *x)
            .collect();
        assert!(top.iter().any(|x| (x - 20.0).abs() < 1e-3), "{top:?}");
        assert!(top.iter().any(|x| (x - 80.0).abs() < 1e-3), "{top:?}");
        assert_eq!(o.open, vec![false]);
    }

    #[test]
    fn an_ellipse_passes_through_the_box_s_edge_midpoints() {
        let o = outline(&shape("ellipse", &[]), 80.0, 40.0).unwrap();
        let p = pos(&o);
        for want in [(0.0, 20.0), (40.0, 0.0), (80.0, 20.0), (40.0, 40.0)] {
            assert!(
                p.iter()
                    .any(|q| (q.0 - want.0).abs() < 1e-3 && (q.1 - want.1).abs() < 1e-3),
                "{want:?} in {p:?}"
            );
        }
    }

    #[test]
    fn every_annex_d_preset_is_drawn() {
        let o = outline(&shape("cloudCallout", &[]), 100.0, 60.0).unwrap();
        assert!(o.anchors.len() > 10);
        let o = outline(&shape("chevron", &[]), 100.0, 60.0).unwrap();
        assert_eq!(o.anchors.len(), 6);
    }

    #[test]
    fn a_line_is_open_and_flips() {
        let mut s = shape("line", &[]);
        s.flip_v = true;
        let o = outline(&s, 50.0, 30.0).unwrap();
        assert_eq!(pos(&o), vec![(0.0, 30.0), (50.0, 0.0)]);
        assert_eq!(o.open, vec![true]);
    }

    #[test]
    fn a_quarter_turn_swaps_the_axes_about_the_centre() {
        let mut s = shape("line", &[]);
        s.rotation = 90 * 60_000;
        let o = outline(&s, 40.0, 40.0).unwrap();
        let (x0, y0) = (o.anchors[0][0], o.anchors[0][1]);
        assert!((x0 - 40.0).abs() < 1e-3 && y0.abs() < 1e-3, "{x0} {y0}");
    }

    #[test]
    fn a_line_takes_a_triangle_at_its_end_and_an_open_arrow_at_its_start() {
        let o = outline(&shape("line", &[]), 100.0, 0.0).unwrap();
        let end = |kind: &str| paged_ooxml::drawingml::LineEnd {
            kind: kind.into(),
            w: None,
            len: None,
        };
        let (h, undrawn) = heads(&o, Some(&end("arrow")), Some(&end("triangle")), 2.0);
        assert!(undrawn.is_empty());
        assert_eq!(h.len(), 2);
        // The open arrow at (0, 0) points left: its wings 6 pt to the right.
        assert!(h[0].open);
        assert_eq!(
            pos(&Outline {
                anchors: h[0].anchors.clone(),
                ..Default::default()
            }),
            vec![(6.0, -3.0), (0.0, 0.0), (6.0, 3.0)]
        );
        // The triangle's tip is the line's end, its base 6 pt back.
        assert!(!h[1].open);
        assert_eq!(h[1].anchors[0][0], 100.0);
        assert!((h[1].anchors[1][0] - 94.0).abs() < 1e-4);
        // A closed outline takes none.
        let rect = outline(&shape("rect", &[]), 10.0, 10.0).unwrap();
        assert!(heads(&rect, Some(&end("triangle")), None, 1.0).0.is_empty());
    }

    #[test]
    fn a_name_that_is_not_a_preset_is_told() {
        let e = outline(&shape("notAPreset", &[]), 10.0, 10.0).unwrap_err();
        assert!(e.contains("notAPreset"));
    }

    #[test]
    fn a_custom_path_scales_to_the_box_and_a_no_fill_path_stays_open() {
        let s = Shape {
            geometry: ShapeGeometry::Custom(vec![CustomPath {
                w: 100,
                h: 100,
                no_fill: true,
                no_stroke: false,
                commands: vec![
                    PathCommand::Move(0, 0),
                    PathCommand::Line(100, 0),
                    PathCommand::Line(100, 100),
                    PathCommand::Close,
                ],
            }]),
            ..Shape::default()
        };
        let o = outline(&s, 200.0, 50.0).unwrap();
        assert_eq!(
            pos(&o),
            vec![(0.0, 0.0), (200.0, 0.0), (200.0, 50.0), (0.0, 0.0)]
        );
        assert_eq!(o.open, vec![true]);
    }
}
