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
//! Hand-written for the presets Word's gallery offers most (the rectangle
//! family, the ellipse, triangles, the diamond, the parallelogram, the
//! trapezoid, the hexagon, the octagon, block arrows, the line), after the
//! guides of ECMA-376 Annex D, and for an authored `a:custGeom` whose points
//! are literal numbers. The 187-preset evaluator of `dml-geom` is not linked:
//! its definitions are half a megabyte of XML, which the doc wasm's size
//! ceiling cannot hold. A preset not listed here is told, never guessed.

use docx_core::{CustomPath, PathCommand, Shape, ShapeGeometry};

/// Anchors of one shape: every contour's anchors in order, where each
/// contour starts and whether it is left open (stroked, not filled).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outline {
    pub anchors: Vec<[f32; 6]>,
    pub starts: Vec<usize>,
    pub open: Vec<bool>,
}

/// The control-point distance of a quarter circle, over its radius.
const KAPPA: f32 = 0.552_284_75;

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

    fn polygon(&mut self, points: &[(f32, f32)]) {
        for (i, (x, y)) in points.iter().enumerate() {
            if i == 0 {
                self.move_to(*x, *y);
            } else {
                self.line_to(*x, *y);
            }
        }
        self.close();
    }

    fn done(mut self) -> Outline {
        self.finish(true);
        self.out
    }
}

/// The guide `name` of a preset, or `default`.
fn adj(shape: &[(String, i64)], name: &str, default: f32) -> f32 {
    shape
        .iter()
        .find(|(n, _)| n == name)
        .map_or(default, |(_, v)| *v as f32)
}

/// A preset's outline in a `w` x `h` pt box, or `None` for a preset this
/// module does not draw.
fn preset(name: &str, g: &[(String, i64)], w: f32, h: f32) -> Option<Outline> {
    let ss = w.min(h);
    let mut pen = Pen::default();
    match name {
        "rect" | "flowChartProcess" | "flowChartPredefinedProcess" | "textBox" => {
            pen.polygon(&[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)])
        }
        "roundRect" | "flowChartAlternateProcess" => {
            let a = if name == "roundRect" {
                adj(g, "adj", 16667.0)
            } else {
                16667.0
            };
            let r = (ss * a.clamp(0.0, 50000.0) / 100_000.0).max(0.0);
            let k = KAPPA * r;
            pen.move_to(r, 0.0);
            pen.line_to(w - r, 0.0);
            pen.cubic_to((w - r + k, 0.0), (w, r - k), (w, r));
            pen.line_to(w, h - r);
            pen.cubic_to((w, h - r + k), (w - r + k, h), (w - r, h));
            pen.line_to(r, h);
            pen.cubic_to((r - k, h), (0.0, h - r + k), (0.0, h - r));
            pen.line_to(0.0, r);
            pen.cubic_to((0.0, r - k), (r - k, 0.0), (r, 0.0));
            pen.close();
        }
        "ellipse" | "flowChartConnector" => {
            let (kx, ky) = (KAPPA * w / 2.0, KAPPA * h / 2.0);
            let (cx, cy) = (w / 2.0, h / 2.0);
            pen.move_to(0.0, cy);
            pen.cubic_to((0.0, cy - ky), (cx - kx, 0.0), (cx, 0.0));
            pen.cubic_to((cx + kx, 0.0), (w, cy - ky), (w, cy));
            pen.cubic_to((w, cy + ky), (cx + kx, h), (cx, h));
            pen.cubic_to((cx - kx, h), (0.0, cy + ky), (0.0, cy));
            pen.close();
        }
        "triangle" => {
            let x = w * adj(g, "adj", 50000.0).clamp(0.0, 100_000.0) / 100_000.0;
            pen.polygon(&[(0.0, h), (x, 0.0), (w, h)]);
        }
        "rtTriangle" => pen.polygon(&[(0.0, h), (0.0, 0.0), (w, h)]),
        "diamond" | "flowChartDecision" => {
            pen.polygon(&[(0.0, h / 2.0), (w / 2.0, 0.0), (w, h / 2.0), (w / 2.0, h)])
        }
        "parallelogram" => {
            let max = 100_000.0 * w / ss.max(1e-3);
            let x2 = ss * adj(g, "adj", 25000.0).clamp(0.0, max) / 100_000.0;
            pen.polygon(&[(0.0, h), (x2, 0.0), (w, 0.0), (w - x2, h)]);
        }
        "trapezoid" => {
            let max = 50_000.0 * w / ss.max(1e-3);
            let x2 = ss * adj(g, "adj", 25000.0).clamp(0.0, max) / 100_000.0;
            pen.polygon(&[(0.0, h), (x2, 0.0), (w - x2, 0.0), (w, h)]);
        }
        "hexagon" => {
            let max = 50_000.0 * w / ss.max(1e-3);
            let x1 = ss * adj(g, "adj", 25000.0).clamp(0.0, max) / 100_000.0;
            pen.polygon(&[
                (0.0, h / 2.0),
                (x1, 0.0),
                (w - x1, 0.0),
                (w, h / 2.0),
                (w - x1, h),
                (x1, h),
            ]);
        }
        "octagon" => {
            let x1 = ss * adj(g, "adj", 29289.0).clamp(0.0, 50000.0) / 100_000.0;
            pen.polygon(&[
                (0.0, x1),
                (x1, 0.0),
                (w - x1, 0.0),
                (w, x1),
                (w, h - x1),
                (w - x1, h),
                (x1, h),
                (0.0, h - x1),
            ]);
        }
        "rightArrow" | "leftArrow" => {
            let a1 = adj(g, "adj1", 50000.0).clamp(0.0, 100_000.0);
            let max2 = 100_000.0 * w / ss.max(1e-3);
            let a2 = adj(g, "adj2", 50000.0).clamp(0.0, max2);
            let head = ss * a2 / 100_000.0;
            let x1 = w - head;
            let half = h * a1 / 200_000.0;
            let (y1, y2) = (h / 2.0 - half, h / 2.0 + half);
            let right = [
                (0.0, y1),
                (x1, y1),
                (x1, 0.0),
                (w, h / 2.0),
                (x1, h),
                (x1, y2),
                (0.0, y2),
            ];
            if name == "rightArrow" {
                pen.polygon(&right);
            } else {
                let left: Vec<_> = right.iter().rev().map(|(x, y)| (w - x, *y)).collect();
                pen.polygon(&left);
            }
        }
        "line" | "straightConnector1" => {
            pen.move_to(0.0, 0.0);
            pen.line_to(w, h);
        }
        _ => return None,
    }
    Some(pen.done())
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
        // adj 50 % of the short side: a stadium; the first anchor is where
        // the top edge begins, `r` in.
        assert!((o.anchors[0][0] - 20.0).abs() < 1e-3 && o.anchors[0][1] == 0.0);
        assert_eq!(o.anchors.len(), 8);
        // The curve leaves the top edge's end toward the right edge.
        let a = o.anchors[1];
        assert!((a[4] - (80.0 + KAPPA * 20.0)).abs() < 1e-3 && a[5] == 0.0);
    }

    #[test]
    fn an_ellipse_is_four_anchors_on_the_box() {
        let o = outline(&shape("ellipse", &[]), 80.0, 40.0).unwrap();
        assert_eq!(
            pos(&o),
            vec![(0.0, 20.0), (40.0, 0.0), (80.0, 20.0), (40.0, 40.0)]
        );
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
    fn a_preset_it_does_not_draw_is_named() {
        let e = outline(&shape("cloudCallout", &[]), 10.0, 10.0).unwrap_err();
        assert!(e.contains("cloudCallout"));
    }

    #[test]
    fn a_custom_path_scales_to_the_box_and_a_no_fill_path_stays_open() {
        let mut s = Shape::default();
        s.geometry = ShapeGeometry::Custom(vec![CustomPath {
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
        }]);
        let o = outline(&s, 200.0, 50.0).unwrap();
        assert_eq!(
            pos(&o),
            vec![(0.0, 0.0), (200.0, 0.0), (200.0, 50.0), (0.0, 0.0)]
        );
        assert_eq!(o.open, vec![true]);
    }
}
