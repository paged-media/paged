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

//! SVG → DXF: what the engine's SVG export says a page or a selection
//! draws, as DXF entities (draw ADR 364).
//!
//! The SVG is read with usvg and walked with `paged-svg`'s one walker
//! (engine ADR 1031, plan item C9), every transform applied. Each
//! contour becomes one entity in millimetres (`$INSUNITS` 4), the y axis
//! flipped to point up:
//!
//! - straight contours an `LWPOLYLINE` (closed when the path closes);
//! - curved contours a cubic `SPLINE` whose control points are the
//!   Bézier pieces' (each inner knot three times): the same curve,
//!   exactly; a straight piece inside it is a cubic on its line.
//!
//! Its colour is the stroke's (else the fill's) as a true colour (group
//! 420) with the nearest index colour beside it for older readers; its
//! line weight the stroke width, snapped to DXF's 24 weights. A top-level
//! named group is a layer; everything else is on layer `0`.
//!
//! Reported: fills (DXF lines carry none: a filled shape is its outline),
//! gradients and patterns (their first colour), dashes, opacity, blend
//! modes, clips (the content is written whole), masks, filters and
//! images.

use dxf::entities::{Entity, EntityType, LwPolyline, Spline};
use dxf::enums::{AcadVersion, Units};
use dxf::tables::Layer;
use dxf::{Color, Drawing, LwPolylineVertex, Point};

use paged_svg::usvg;
use paged_svg::walk::{self, Enter, Visitor};

use crate::aci;
use crate::Report;

/// Millimetres per point.
const MM: f64 = 25.4 / 72.0;
/// DXF's line weights, in 1/100 mm.
const WEIGHTS: [i16; 24] = [
    0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200,
    211,
];

/// What [`svg_to_dxf`] answers.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DxfExport {
    /// The ASCII DXF (AutoCAD 2010).
    pub dxf: String,
    pub report: Report,
}

/// One contour, in points, y down.
#[derive(Debug, Clone)]
enum Piece {
    Line([f64; 2]),
    Cubic([f64; 2], [f64; 2], [f64; 2]),
}

struct Writer {
    drawing: Drawing,
    report: Report,
    /// The document's height in points (y is flipped about it).
    height: f64,
    /// The layer of the top-level group being walked.
    layer: Option<String>,
    depth: usize,
    layers: Vec<String>,
}

/// Write `svg` (an SVG document) as a DXF drawing.
pub fn svg_to_dxf(svg: &str) -> Result<DxfExport, String> {
    let opt = usvg::Options {
        resources_dir: None,
        // A user unit is a point, as the engine's export writes it.
        dpi: 72.0,
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_str(svg, &opt).map_err(|e| format!("not a readable SVG: {e}"))?;
    let mut drawing = Drawing::new();
    drawing.header.version = AcadVersion::R2010;
    drawing.header.default_drawing_units = Units::Millimeters;
    let mut w = Writer {
        drawing,
        report: Report::default(),
        height: f64::from(tree.size().height()),
        layer: None,
        depth: 0,
        layers: Vec::new(),
    };
    walk::walk_tree(&tree, usvg::Transform::default(), &mut w);
    if w.report.items == 0 {
        return Err("the SVG draws no path to write".into());
    }
    for name in std::mem::take(&mut w.layers) {
        if name == "0" {
            continue;
        }
        w.drawing.add_layer(Layer {
            name,
            color: Color::from_index(7),
            ..Default::default()
        });
    }
    let mut out = Vec::new();
    w.drawing
        .save(&mut out)
        .map_err(|e| format!("the DXF could not be written: {e}"))?;
    Ok(DxfExport {
        dxf: String::from_utf8_lossy(&out).into_owned(),
        report: w.report,
    })
}

impl Writer {
    fn map(&self, ts: &usvg::Transform, p: usvg::tiny_skia_path::Point) -> [f64; 2] {
        let (x, y) = (f64::from(p.x), f64::from(p.y));
        let px = f64::from(ts.sx) * x + f64::from(ts.kx) * y + f64::from(ts.tx);
        let py = f64::from(ts.ky) * x + f64::from(ts.sy) * y + f64::from(ts.ty);
        [px, py]
    }

    /// Page points (y down) → DXF millimetres (y up).
    fn dxf_point(&self, p: [f64; 2]) -> Point {
        Point::new(p[0] * MM, (self.height - p[1]) * MM, 0.0)
    }

    fn colour(&mut self, paint: &usvg::Paint) -> [u8; 3] {
        let c = match paint {
            usvg::Paint::Color(c) => *c,
            usvg::Paint::LinearGradient(g) => {
                self.gradient();
                g.stops()
                    .first()
                    .map_or(usvg::Color::black(), |s| s.color())
            }
            usvg::Paint::RadialGradient(g) => {
                self.gradient();
                g.stops()
                    .first()
                    .map_or(usvg::Color::black(), |s| s.color())
            }
            usvg::Paint::Pattern(_) => {
                self.report.approximated(
                    "paint.pattern",
                    "a pattern paint is written as black: DXF entities have one colour",
                );
                usvg::Color::black()
            }
        };
        [c.red, c.green, c.blue]
    }

    fn gradient(&mut self) {
        self.report.approximated(
            "paint.gradient",
            "a gradient is written as its first colour: DXF entities have one colour",
        );
    }

    fn contours(
        &self,
        path: &usvg::Path,
        ts: &usvg::Transform,
    ) -> Vec<(Vec<Piece>, [f64; 2], bool)> {
        use usvg::tiny_skia_path::PathSegment as S;
        let mut out: Vec<(Vec<Piece>, [f64; 2], bool)> = Vec::new();
        let mut cur: Option<(Vec<Piece>, [f64; 2], bool)> = None;
        let mut last = [0.0, 0.0];
        for seg in path.data().segments() {
            match seg {
                S::MoveTo(p) => {
                    if let Some(c) = cur.take() {
                        out.push(c);
                    }
                    last = self.map(ts, p);
                    cur = Some((Vec::new(), last, false));
                }
                S::LineTo(p) => {
                    let p = self.map(ts, p);
                    if let Some(c) = cur.as_mut() {
                        c.0.push(Piece::Line(p));
                    }
                    last = p;
                }
                S::QuadTo(q, p) => {
                    let (q, p) = (self.map(ts, q), self.map(ts, p));
                    let c1 = [
                        last[0] + (q[0] - last[0]) * 2.0 / 3.0,
                        last[1] + (q[1] - last[1]) * 2.0 / 3.0,
                    ];
                    let c2 = [
                        p[0] + (q[0] - p[0]) * 2.0 / 3.0,
                        p[1] + (q[1] - p[1]) * 2.0 / 3.0,
                    ];
                    if let Some(c) = cur.as_mut() {
                        c.0.push(Piece::Cubic(c1, c2, p));
                    }
                    last = p;
                }
                S::CubicTo(a, b, p) => {
                    let (a, b, p) = (self.map(ts, a), self.map(ts, b), self.map(ts, p));
                    if let Some(c) = cur.as_mut() {
                        c.0.push(Piece::Cubic(a, b, p));
                    }
                    last = p;
                }
                S::Close => {
                    if let Some(mut c) = cur.take() {
                        c.2 = true;
                        last = c.1;
                        out.push(c);
                    }
                }
            }
        }
        if let Some(c) = cur.take() {
            out.push(c);
        }
        out.retain(|(pieces, _, _)| !pieces.is_empty());
        out
    }

    fn entity(&mut self, specific: EntityType, rgb: [u8; 3], weight: i16) {
        let mut e = Entity::new(specific);
        e.common.layer = self.layer.clone().unwrap_or_else(|| "0".into());
        e.common.color = Color::from_index(aci::nearest(rgb));
        e.common.color_24_bit =
            (i32::from(rgb[0]) << 16) | (i32::from(rgb[1]) << 8) | i32::from(rgb[2]);
        e.common.lineweight_enum_value = weight;
        self.drawing.add_entity(e);
        self.report.items += 1;
    }
}

/// The DXF weight nearest `mm100` (hundredths of a millimetre).
fn snap_weight(mm100: f64) -> i16 {
    *WEIGHTS
        .iter()
        .min_by(|a, b| {
            (f64::from(**a) - mm100)
                .abs()
                .total_cmp(&(f64::from(**b) - mm100).abs())
        })
        .unwrap_or(&25)
}

impl Visitor for Writer {
    type Ts = usvg::Transform;

    fn compose(&self, parent: usvg::Transform, local: usvg::Transform) -> usvg::Transform {
        parent.pre_concat(local)
    }

    fn enter_group(&mut self, g: &usvg::Group, _: usvg::Transform) -> Enter {
        if self.depth == 0 && !g.id().is_empty() {
            self.layer = Some(g.id().to_string());
            if !self.layers.iter().any(|l| l == g.id()) {
                self.layers.push(g.id().to_string());
            }
        }
        if g.clip_path().is_some() {
            self.report.approximated(
                "clip",
                "clipped content is written whole: DXF has no clipping",
            );
        }
        if g.mask().is_some() {
            self.report.dropped("mask", "an opacity mask is left out");
        }
        if !g.filters().is_empty() {
            self.report.dropped("filter", "a filter effect is left out");
        }
        if g.opacity().get() < 1.0 {
            self.report
                .dropped("opacity", "opacity is left out: DXF entities are opaque");
        }
        if g.blend_mode() != usvg::BlendMode::Normal {
            self.report.dropped("blend", "a blend mode is left out");
        }
        self.depth += 1;
        Enter::Children
    }

    fn leave_group(&mut self, _: &usvg::Group, _: usvg::Transform) {
        self.depth -= 1;
        if self.depth == 0 {
            self.layer = None;
        }
    }

    fn path(&mut self, path: &usvg::Path, ts: usvg::Transform) {
        if !path.is_visible() {
            return;
        }
        let (rgb, weight) = match (path.stroke(), path.fill()) {
            (Some(s), fill) => {
                if fill.is_some() {
                    self.report.approximated(
                        "fill.outline",
                        "a fill is written as its outline: DXF lines carry no fill",
                    );
                }
                if s.dasharray().is_some() {
                    self.report.dropped(
                        "stroke.dash",
                        "a dash pattern is left out: the line is solid",
                    );
                }
                if s.opacity().get() < 1.0 {
                    self.report
                        .dropped("opacity", "opacity is left out: DXF entities are opaque");
                }
                let rgb = self.colour(s.paint());
                // Under the walk's transform the width scales by its mean.
                let k = f64::from((ts.sx * ts.sy - ts.kx * ts.ky).abs()).sqrt();
                let mm100 = f64::from(s.width().get()) * k * MM * 100.0;
                let weight = snap_weight(mm100);
                if (f64::from(weight) - mm100).abs() > 0.5 {
                    self.report.approximated(
                        "stroke.weight",
                        "a stroke width is snapped to the nearest DXF line weight",
                    );
                }
                (rgb, weight)
            }
            (None, Some(f)) => {
                self.report.approximated(
                    "fill.outline",
                    "a fill is written as its outline: DXF lines carry no fill",
                );
                if f.opacity().get() < 1.0 {
                    self.report
                        .dropped("opacity", "opacity is left out: DXF entities are opaque");
                }
                (self.colour(f.paint()), 0)
            }
            (None, None) => return,
        };
        for (pieces, start, closed) in self.contours(path, &ts) {
            let curved = pieces.iter().any(|p| matches!(p, Piece::Cubic(..)));
            if !curved {
                let mut poly = LwPolyline::default();
                poly.vertices.push(vertex(self.dxf_point(start)));
                let n = pieces.len();
                for (i, p) in pieces.iter().enumerate() {
                    let Piece::Line(p) = p else { continue };
                    // A closed polyline's last vertex is not its first again.
                    if closed && i + 1 == n && *p == start {
                        continue;
                    }
                    poly.vertices.push(vertex(self.dxf_point(*p)));
                }
                poly.set_is_closed(closed);
                self.entity(EntityType::LwPolyline(poly), rgb, weight);
                continue;
            }
            let mut ctrl = vec![self.dxf_point(start)];
            let mut last = start;
            for p in &pieces {
                match *p {
                    Piece::Line(q) => {
                        let a = [
                            last[0] + (q[0] - last[0]) / 3.0,
                            last[1] + (q[1] - last[1]) / 3.0,
                        ];
                        let b = [
                            last[0] + (q[0] - last[0]) * 2.0 / 3.0,
                            last[1] + (q[1] - last[1]) * 2.0 / 3.0,
                        ];
                        ctrl.extend([self.dxf_point(a), self.dxf_point(b), self.dxf_point(q)]);
                        last = q;
                    }
                    Piece::Cubic(a, b, q) => {
                        ctrl.extend([self.dxf_point(a), self.dxf_point(b), self.dxf_point(q)]);
                        last = q;
                    }
                }
            }
            if closed && last != start {
                let (a, b) = (
                    [
                        last[0] + (start[0] - last[0]) / 3.0,
                        last[1] + (start[1] - last[1]) / 3.0,
                    ],
                    [
                        last[0] + (start[0] - last[0]) * 2.0 / 3.0,
                        last[1] + (start[1] - last[1]) * 2.0 / 3.0,
                    ],
                );
                ctrl.extend([self.dxf_point(a), self.dxf_point(b), self.dxf_point(start)]);
            }
            let pieces_n = (ctrl.len() - 1) / 3;
            let mut knots = vec![0.0; 4];
            for i in 1..pieces_n {
                knots.extend([i as f64; 3]);
            }
            knots.extend([pieces_n as f64; 4]);
            let mut spline = Spline {
                degree_of_curve: 3,
                knot_values: knots,
                control_points: ctrl,
                ..Default::default()
            };
            spline.set_is_planar(true);
            self.entity(EntityType::Spline(spline), rgb, weight);
        }
    }

    fn image(&mut self, _: &usvg::Image, _: usvg::Transform) {
        self.report
            .dropped("image", "an image is left out: DXF images link to files");
    }
}

fn vertex(p: Point) -> LwPolylineVertex {
    LwPolylineVertex {
        x: p.x,
        y: p.y,
        ..Default::default()
    }
}
