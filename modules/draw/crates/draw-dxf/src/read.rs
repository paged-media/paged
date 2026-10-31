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

//! DXF → SVG: the drawing's model space as an SVG document the engine's
//! `paged-svg` import lowers to native paths (draw ADR 364).
//!
//! - **Entities.** `LINE`, `LWPOLYLINE` and 2-D `POLYLINE` (bulges as
//!   arcs, constant width as the stroke), `CIRCLE`, `ARC`, `ELLIPSE`
//!   (and its arcs), `SPLINE` (its Bézier pieces; fit points alone: a
//!   curve through them), and `INSERT` (the block's entities under the
//!   insert's placement, rows and columns included, eight levels deep),
//!   and SOLID `HATCH` as a filled path of its boundary loops (`hatch.rs`;
//!   the `dxf` crate does not model it). Every other entity type — and a
//!   pattern hatch — is counted and left out. File order is paint order.
//! - **Layers** become named groups (`<g id="name">`), in the layer
//!   table's order. A layer that is off has its entities left out.
//! - **Colour.** An entity's true colour (group 420), else its index
//!   colour, else (BYLAYER) its layer's, else (BYBLOCK) the inserting
//!   entity's. Index 7 is black.
//! - **Line weight** in hundredths of a millimetre; BYLAYER, BYBLOCK and
//!   the default (0.25 mm, AutoCAD's) resolved likewise.
//! - **Units.** `$INSUNITS` sets the scale; a unitless drawing is read in
//!   millimetres, as Illustrator reads it. The y axis is flipped (DXF's
//!   points up) and the drawing's top-left corner is the SVG's origin.

use std::collections::HashMap;
use std::fmt::Write as _;

use dxf::entities::{Entity, EntityType};
use dxf::enums::Units;
use dxf::Drawing;

use crate::aci;
use crate::curves::{self, Affine, Contour, Pt, Seg, SplineNotes};
use crate::{escape, Report};

/// AutoCAD's default line weight (`$LWDEFAULT`), in 1/100 mm.
const DEFAULT_LINEWEIGHT: i16 = 25;
/// How deep block references are followed.
const MAX_INSERT_DEPTH: usize = 8;
/// The most copies an `INSERT` array makes.
const MAX_ARRAY: usize = 10_000;

/// What [`dxf_to_svg`] answers.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DxfImport {
    /// The SVG document (user units are points).
    pub svg: String,
    pub report: Report,
    /// The layers that drew something.
    pub layers: u32,
    /// Points per drawing unit.
    pub scale: f64,
}

/// One drawn entity: its contours in drawing units, its paint.
struct Shape {
    /// Paint order: the entity's position in the ENTITIES section (an
    /// inserted block's entities share their INSERT's).
    order: usize,
    contours: Vec<Contour>,
    rgb: [u8; 3],
    /// Stroke width in points; `None`: a fill (a HATCH).
    width: Option<f64>,
    /// A fill's rule.
    even_odd: bool,
}

/// What the inserting entity passes down (BYBLOCK).
#[derive(Clone, Copy)]
struct Inherit {
    rgb: [u8; 3],
    lineweight: i16,
}

struct Reader<'a> {
    drawing: &'a Drawing,
    blocks: HashMap<&'a str, &'a dxf::Block>,
    layers: HashMap<&'a str, &'a dxf::tables::Layer>,
    /// Shapes per layer name.
    shapes: HashMap<String, Vec<Shape>>,
    report: Report,
    /// Points per drawing unit.
    k: f64,
    /// The paint order of the top-level entity being read.
    order: usize,
}

/// Read `bytes` (an ASCII or binary DXF) into an SVG document.
pub fn dxf_to_svg(bytes: &[u8]) -> Result<DxfImport, String> {
    let drawing = Drawing::load(&mut std::io::Cursor::new(bytes))
        .map_err(|e| format!("not a readable DXF: {e}"))?;
    let k = points_per_unit(drawing.header.default_drawing_units);
    let mut r = Reader {
        drawing: &drawing,
        blocks: drawing.blocks().map(|b| (b.name.as_str(), b)).collect(),
        layers: drawing.layers().map(|l| (l.name.as_str(), l)).collect(),
        shapes: HashMap::new(),
        report: Report::default(),
        k,
        order: 0,
    };
    let inherit = Inherit {
        rgb: [0, 0, 0],
        lineweight: DEFAULT_LINEWEIGHT,
    };
    // What the file's ENTITIES section lists, against what the reader
    // was handed: a type the `dxf` crate does not model (MLEADER, MESH,
    // …) never reaches it and is counted here.
    let mut seen: HashMap<&str, u32> = HashMap::new();
    for e in drawing.entities() {
        *seen.entry(type_name(&e.specific)).or_default() += 1;
    }
    for (name, n) in crate::scan::entity_counts(bytes) {
        let read = seen.get(name.as_str()).copied().unwrap_or(0);
        // HATCH is read from the group codes (`hatch.rs`), not by the crate.
        if n > read && name != "VERTEX" && name != "SEQEND" && name != "HATCH" {
            r.report.note_n(
                &format!("entity.{name}"),
                crate::Severity::Dropped,
                &unsupported(&name),
                n - read,
            );
        }
    }
    let section = crate::hatch::section(bytes);
    for (i, e) in drawing.entities().enumerate() {
        if e.common.is_in_paper_space {
            r.report.dropped(
                "paperSpace",
                "paper space (layout) entities are left out; model space is imported",
            );
            continue;
        }
        r.order = section
            .order
            .get(&e.common.handle.as_string().to_uppercase())
            .copied()
            .unwrap_or(i);
        r.entity(e, &Affine::IDENTITY, inherit, None, 0);
    }
    for (order, hatch) in section.hatches {
        match hatch {
            Ok(h) => r.hatch(h, order),
            Err(why) => r
                .report
                .dropped("hatch.unreadable", &format!("{why} is left out")),
        }
    }
    Ok(r.finish())
}

/// Points per drawing unit for `$INSUNITS`.
fn points_per_unit(u: Units) -> f64 {
    const MM: f64 = 72.0 / 25.4;
    match u {
        Units::Inches => 72.0,
        Units::Feet => 864.0,
        Units::Yards => 2592.0,
        Units::Miles => 72.0 * 63_360.0,
        Units::Mils => 0.072,
        Units::Microinches => 72e-6,
        Units::Centimeters => 10.0 * MM,
        Units::Decimeters => 100.0 * MM,
        Units::Meters => 1000.0 * MM,
        Units::Kilometers => 1e6 * MM,
        Units::Microns => 1e-3 * MM,
        Units::Nanometers => 1e-6 * MM,
        Units::USSurveyFeet => 1200.0 / 3937.0 * 72.0 / 0.0254,
        Units::USSurveyInch => 72.0,
        // Unitless (and anything astronomical): millimetres.
        _ => MM,
    }
}

impl<'a> Reader<'a> {
    fn layer_visible(&self, name: &str) -> bool {
        self.layers
            .get(name)
            .is_none_or(|l| l.is_layer_on && !l.color.is_turned_off())
    }

    fn color(&self, e: &Entity, layer: &str, inherit: Inherit) -> [u8; 3] {
        let c = &e.common;
        if c.color_24_bit > 0 {
            let v = c.color_24_bit as u32;
            return [(v >> 16) as u8, (v >> 8) as u8, v as u8];
        }
        if let Some(i) = c.color.index() {
            return aci::rgb(i);
        }
        if c.color.is_by_block() {
            return inherit.rgb;
        }
        self.layers
            .get(layer)
            .and_then(|l| l.color.index())
            .map_or([0, 0, 0], aci::rgb)
    }

    /// The entity's line weight in 1/100 mm (AutoCAD: -1 BYLAYER, -2
    /// BYBLOCK, -3 default).
    fn lineweight(&self, e: &Entity, layer: &str, inherit: Inherit) -> i16 {
        // Before AutoCAD 2000 there are no line weights (the reader
        // answers 0 for the absent group 370).
        if self.drawing.header.version < dxf::enums::AcadVersion::R2000 {
            return DEFAULT_LINEWEIGHT;
        }
        match e.common.lineweight_enum_value {
            v if v >= 0 => v,
            -2 => inherit.lineweight,
            -1 => self
                .layers
                .get(layer)
                .map(|l| l.line_weight.raw_value())
                .filter(|v| *v >= 0)
                .unwrap_or(DEFAULT_LINEWEIGHT),
            _ => DEFAULT_LINEWEIGHT,
        }
    }

    /// Draw `e` under `m`. `block_layer`: the layer of the INSERT that
    /// brought it in (entities of layer "0" in a block take it).
    fn entity(
        &mut self,
        e: &'a Entity,
        m: &Affine,
        inherit: Inherit,
        block_layer: Option<&str>,
        depth: usize,
    ) {
        if !e.common.is_visible {
            return;
        }
        let layer = match block_layer {
            Some(outer) if e.common.layer == "0" => outer.to_string(),
            _ => e.common.layer.clone(),
        };
        if !self.layer_visible(&layer) {
            self.report
                .dropped("layer.off", "entities on a layer that is off are left out");
            return;
        }
        let rgb = self.color(e, &layer, inherit);
        let lineweight = self.lineweight(e, &layer, inherit);
        let mut width_units: Option<f64> = None;
        let ocs = |n: &dxf::Vector| -> Option<Affine> {
            if n.z > 0.0 && n.x.abs() < 1e-9 && n.y.abs() < 1e-9 {
                Some(Affine::IDENTITY)
            } else if n.z < 0.0 && n.x.abs() < 1e-9 && n.y.abs() < 1e-9 {
                // The arbitrary-axis rule for (0, 0, -1): the OCS x axis
                // is the world's -x.
                Some(Affine::scale(-1.0, 1.0))
            } else {
                None
            }
        };
        let contours: Vec<Contour> = match &e.specific {
            EntityType::Line(l) => {
                let mut c = Contour::new([l.p1.x, l.p1.y]);
                c.segs.push(Seg::Line([l.p2.x, l.p2.y]));
                vec![c]
            }
            EntityType::Circle(c) => {
                let Some(o) = ocs(&c.normal) else {
                    return self.not_planar();
                };
                let mut segs = Vec::new();
                let r = c.radius;
                let start = curves::ellipse_arc(
                    [c.center.x, c.center.y],
                    [r, 0.0],
                    [0.0, r],
                    0.0,
                    std::f64::consts::TAU,
                    &mut segs,
                );
                let mut out = Contour::new(start);
                out.segs = segs;
                out.closed = true;
                vec![out.mapped(&o)]
            }
            EntityType::Arc(a) => {
                let Some(o) = ocs(&a.normal) else {
                    return self.not_planar();
                };
                let (s, mut end) = (a.start_angle.to_radians(), a.end_angle.to_radians());
                if end <= s {
                    end += std::f64::consts::TAU;
                }
                let mut segs = Vec::new();
                let r = a.radius;
                let start = curves::ellipse_arc(
                    [a.center.x, a.center.y],
                    [r, 0.0],
                    [0.0, r],
                    s,
                    end - s,
                    &mut segs,
                );
                let mut out = Contour::new(start);
                out.segs = segs;
                vec![out.mapped(&o)]
            }
            EntityType::Ellipse(el) => {
                if ocs(&el.normal).is_none() {
                    return self.not_planar();
                }
                // ELLIPSE is in world coordinates; its minor axis is the
                // major turned a quarter about the normal.
                let major = [el.major_axis.x, el.major_axis.y];
                let turn = if el.normal.z < 0.0 { -1.0 } else { 1.0 };
                let minor = [
                    -major[1] * el.minor_axis_ratio * turn,
                    major[0] * el.minor_axis_ratio * turn,
                ];
                let (s, mut end) = (el.start_parameter, el.end_parameter);
                if end <= s {
                    end += std::f64::consts::TAU;
                }
                let full = (end - s - std::f64::consts::TAU).abs() < 1e-9;
                let mut segs = Vec::new();
                let start = curves::ellipse_arc(
                    [el.center.x, el.center.y],
                    major,
                    minor,
                    s,
                    end - s,
                    &mut segs,
                );
                let mut out = Contour::new(start);
                out.segs = segs;
                out.closed = full;
                vec![out]
            }
            EntityType::LwPolyline(p) => {
                let Some(o) = ocs(&p.extrusion_direction) else {
                    return self.not_planar();
                };
                if p.constant_width > 0.0 {
                    width_units = Some(p.constant_width);
                }
                if p.vertices.iter().any(|v| {
                    v.starting_width != v.ending_width
                        || (v.starting_width > 0.0 && v.starting_width != p.constant_width)
                }) {
                    self.report.approximated(
                        "polyline.width",
                        "a polyline whose width varies along it is drawn at one width",
                    );
                }
                let pts: Vec<(Pt, f64)> =
                    p.vertices.iter().map(|v| ([v.x, v.y], v.bulge)).collect();
                polyline(&pts, p.is_closed())
                    .map(|c| c.mapped(&o))
                    .into_iter()
                    .collect()
            }
            EntityType::Polyline(p) => {
                // 8: a 3-D polyline, 16: a polygon mesh, 64: a polyface mesh.
                if p.flags & (16 | 64) != 0 {
                    self.report
                        .dropped("polyline.mesh", "a polygon or polyface mesh is left out");
                    return;
                }
                let Some(o) = ocs(&p.normal) else {
                    return self.not_planar();
                };
                if p.flags & 8 != 0 {
                    self.report.approximated(
                        "polyline.3d",
                        "a 3-D polyline is drawn flat, seen from above",
                    );
                }
                // A spline-fit polyline lists its control frame (vertex
                // flag 16) and its fitted points (8): draw the fitted.
                let pts: Vec<(Pt, f64)> = p
                    .vertices()
                    .filter(|v| v.flags & 16 == 0)
                    .map(|v| ([v.location.x, v.location.y], v.bulge))
                    .collect();
                let o = if p.flags & 8 != 0 {
                    Affine::IDENTITY
                } else {
                    o
                };
                polyline(&pts, p.is_closed())
                    .map(|c| c.mapped(&o))
                    .into_iter()
                    .collect()
            }
            EntityType::Spline(s) => {
                let mut notes = SplineNotes::default();
                let ctrl: Vec<Pt> = s.control_points.iter().map(|p| [p.x, p.y]).collect();
                let curve = if !ctrl.is_empty() {
                    curves::spline(
                        s.degree_of_curve.max(0) as usize,
                        &s.knot_values,
                        &ctrl,
                        &s.weight_values,
                        &mut notes,
                    )
                } else {
                    notes.fit_points = true;
                    let fit: Vec<Pt> = s.fit_points.iter().map(|p| [p.x, p.y]).collect();
                    curves::through(&fit, s.is_closed())
                };
                if notes.approximated {
                    self.report.approximated(
                        "spline.rational",
                        "a rational spline or one above degree 3 is drawn as cubic curves through its points and tangents",
                    );
                }
                if notes.fit_points {
                    self.report.approximated(
                        "spline.fitPoints",
                        "a spline stored by its fit points alone is drawn as a smooth curve through them",
                    );
                }
                match curve {
                    Some(mut c) => {
                        c.closed = s.is_closed() && c.start == c.end();
                        vec![c]
                    }
                    None => {
                        self.report.dropped(
                            "spline.malformed",
                            "a spline with inconsistent knots is left out",
                        );
                        return;
                    }
                }
            }
            EntityType::Insert(ins) => {
                self.insert(ins, m, &layer, rgb, lineweight, depth);
                return;
            }
            other => {
                let name = type_name(other);
                self.report
                    .dropped(&format!("entity.{name}"), &unsupported(name));
                return;
            }
        };
        if contours.is_empty() {
            return;
        }
        let contours: Vec<Contour> = contours.iter().map(|c| c.mapped(m)).collect();
        let mean = m_scale(m);
        let width = match width_units {
            Some(w) => w * mean * self.k,
            None => f64::from(lineweight) / 100.0 * 72.0 / 25.4,
        };
        // A zero weight is AutoCAD's thinnest line, one pixel on screen.
        let width = if width > 0.0 { width } else { 0.25 };
        self.report.items += 1;
        self.shapes.entry(layer).or_default().push(Shape {
            order: self.order,
            contours,
            rgb,
            width: Some(width),
            even_odd: false,
        });
    }

    /// A HATCH: its loops as one filled shape, painted at `order`.
    fn hatch(&mut self, h: crate::hatch::Hatch, order: usize) {
        if h.paper_space {
            self.report.dropped(
                "paperSpace",
                "paper space (layout) entities are left out; model space is imported",
            );
            return;
        }
        if h.invisible {
            return;
        }
        if !self.layer_visible(&h.layer) {
            self.report
                .dropped("layer.off", "entities on a layer that is off are left out");
            return;
        }
        if !h.solid {
            self.report.dropped(
                "hatch.pattern",
                "a pattern hatch (hatching lines) is left out; solid fills are imported",
            );
            return;
        }
        if h.gradient {
            self.report.approximated(
                "hatch.gradient",
                "a gradient hatch is filled with its colour",
            );
        }
        if h.approximated {
            self.report.approximated(
                "spline.rational",
                "a rational spline or one above degree 3 is drawn as cubic curves through its points and tangents",
            );
        }
        if h.loops.is_empty() {
            return;
        }
        let rgb = match (h.true_color, h.index) {
            (Some(v), _) if v > 0 => [(v >> 16) as u8, (v >> 8) as u8, v as u8],
            (_, Some(i)) if (1..=255).contains(&i) => aci::rgb(i as u8),
            _ => self
                .layers
                .get(h.layer.as_str())
                .and_then(|l| l.color.index())
                .map_or([0, 0, 0], aci::rgb),
        };
        self.report.items += 1;
        self.shapes.entry(h.layer).or_default().push(Shape {
            order,
            contours: h.loops,
            rgb,
            width: None,
            even_odd: h.even_odd,
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        &mut self,
        ins: &'a dxf::entities::Insert,
        m: &Affine,
        layer: &str,
        rgb: [u8; 3],
        lineweight: i16,
        depth: usize,
    ) {
        if depth >= MAX_INSERT_DEPTH {
            self.report.dropped(
                "insert.depth",
                "blocks nested more than eight deep are left out",
            );
            return;
        }
        let Some(block) = self.blocks.get(ins.name.as_str()).copied() else {
            self.report.dropped(
                "insert.missing",
                "a reference to a block the file does not define is left out",
            );
            return;
        };
        if ins.extrusion_direction.z < 0.0 {
            self.report.approximated(
                "insert.mirrored",
                "a block inserted upside down (negative extrusion) is drawn as seen from above",
            );
        }
        let cols = usize::try_from(ins.column_count.max(1)).unwrap_or(1);
        let rows = usize::try_from(ins.row_count.max(1)).unwrap_or(1);
        if cols * rows > MAX_ARRAY {
            self.report.dropped(
                "insert.array",
                "a block array of more than 10 000 copies is left out",
            );
            return;
        }
        let inherit = Inherit { rgb, lineweight };
        let rot = ins.rotation.to_radians();
        let base = Affine::translate(-block.base_point.x, -block.base_point.y);
        let sx = if ins.x_scale_factor == 0.0 {
            1.0
        } else {
            ins.x_scale_factor
        };
        let sy = if ins.y_scale_factor == 0.0 {
            1.0
        } else {
            ins.y_scale_factor
        };
        for r in 0..rows {
            for c in 0..cols {
                // The array steps along the insert's own rotated axes.
                let offset = Affine::rotate(rot)
                    .apply([c as f64 * ins.column_spacing, r as f64 * ins.row_spacing]);
                let place =
                    Affine::translate(ins.location.x + offset[0], ins.location.y + offset[1])
                        .then(&Affine::rotate(rot))
                        .then(&Affine::scale(sx, sy))
                        .then(&base);
                let world = m.then(&place);
                for child in &block.entities {
                    self.entity(child, &world, inherit, Some(layer), depth + 1);
                }
            }
        }
    }

    fn not_planar(&mut self) {
        self.report.dropped(
            "entity.notPlanar",
            "an entity drawn in a plane other than the drawing's is left out",
        );
    }

    fn finish(mut self) -> DxfImport {
        // The extent of everything drawn, in drawing units.
        let mut min = [f64::INFINITY; 2];
        let mut max = [f64::NEG_INFINITY; 2];
        for shapes in self.shapes.values() {
            for s in shapes {
                for c in &s.contours {
                    for p in c.points() {
                        if p[0].is_finite() && p[1].is_finite() {
                            min = [min[0].min(p[0]), min[1].min(p[1])];
                            max = [max[0].max(p[0]), max[1].max(p[1])];
                        }
                    }
                }
            }
        }
        let k = self.k;
        let (w, h) = if min[0].is_finite() {
            ((max[0] - min[0]) * k, (max[1] - min[1]) * k)
        } else {
            (0.0, 0.0)
        };
        // Page space: x from the left edge, y down from the top.
        let to_page = Affine([k, 0.0, 0.0, -k, -min[0] * k, max[1] * k]);
        let mut svg = String::new();
        let _ = write!(
            svg,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 {} {}">"#,
            num(w.max(1.0)),
            num(h.max(1.0)),
            num(w.max(1.0)),
            num(h.max(1.0))
        );
        // Layers in the table's order, then any the table does not list.
        let mut order: Vec<String> = self.drawing.layers().map(|l| l.name.clone()).collect();
        let mut extra: Vec<String> = self
            .shapes
            .keys()
            .filter(|k| !order.contains(k))
            .cloned()
            .collect();
        extra.sort();
        order.extend(extra);
        let mut layers = 0;
        for name in order {
            let Some(mut shapes) = self.shapes.remove(&name) else {
                continue;
            };
            // File order is paint order (stable: a block's entities keep
            // theirs under their INSERT's).
            shapes.sort_by_key(|s| s.order);
            layers += 1;
            let _ = write!(svg, r#"<g id="{}">"#, escape(&name));
            for s in shapes {
                let mut d = String::new();
                for c in &s.contours {
                    path_data(&c.mapped(&to_page), &mut d);
                }
                let [r, g, b] = s.rgb;
                let _ = match s.width {
                    Some(w) => write!(
                        svg,
                        r##"<path d="{d}" fill="none" stroke="#{r:02x}{g:02x}{b:02x}" stroke-width="{}"/>"##,
                        num(w)
                    ),
                    None => write!(
                        svg,
                        r##"<path d="{d}" fill="#{r:02x}{g:02x}{b:02x}" fill-rule="{}"/>"##,
                        if s.even_odd { "evenodd" } else { "nonzero" }
                    ),
                };
            }
            svg.push_str("</g>");
        }
        svg.push_str("</svg>");
        DxfImport {
            svg,
            report: self.report,
            layers,
            scale: k,
        }
    }
}

/// The report's sentence for an entity type that is not imported.
fn unsupported(name: &str) -> String {
    format!(
        "{name} entities are left out (lines, polylines, arcs, circles, ellipses, splines, solid hatches and blocks are imported)"
    )
}

/// The mean scale of `m` (for a width under a block's scale).
fn m_scale(m: &Affine) -> f64 {
    let [a, b, c, d, _, _] = m.0;
    ((a * d - b * c).abs()).sqrt()
}

/// A polyline's vertices (with the bulge of the segment that leaves
/// each) as one contour.
fn polyline(pts: &[(Pt, f64)], closed: bool) -> Option<Contour> {
    let (first, _) = *pts.first()?;
    let mut c = Contour::new(first);
    for w in pts.windows(2) {
        curves::bulge_segment(w[0].0, w[1].0, w[0].1, &mut c.segs);
    }
    if closed && pts.len() > 1 {
        let (last, bulge) = pts[pts.len() - 1];
        curves::bulge_segment(last, first, bulge, &mut c.segs);
        c.closed = true;
    }
    (!c.segs.is_empty()).then_some(c)
}

/// A number with at most three decimals, no trailing zeros.
pub(crate) fn num(v: f64) -> String {
    let s = format!("{:.3}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

fn path_data(c: &Contour, d: &mut String) {
    let pt = |p: Pt| format!("{} {}", num(p[0]), num(p[1]));
    if !d.is_empty() {
        d.push(' ');
    }
    let _ = write!(d, "M{}", pt(c.start));
    for s in &c.segs {
        match *s {
            Seg::Line(p) => {
                let _ = write!(d, " L{}", pt(p));
            }
            Seg::Cubic(a, b, p) => {
                let _ = write!(d, " C{} {} {}", pt(a), pt(b), pt(p));
            }
        }
    }
    if c.closed {
        d.push_str(" Z");
    }
}

/// An entity type's DXF name.
pub(crate) fn type_name(t: &EntityType) -> &'static str {
    match t {
        EntityType::Face3D(_) => "3DFACE",
        EntityType::Solid3D(_) => "3DSOLID",
        EntityType::ProxyEntity(_) => "ACAD_PROXY_ENTITY",
        EntityType::Arc(_) => "ARC",
        EntityType::ArcAlignedText(_) => "ARCALIGNEDTEXT",
        EntityType::AttributeDefinition(_) => "ATTDEF",
        EntityType::Attribute(_) => "ATTRIB",
        EntityType::Body(_) => "BODY",
        EntityType::Circle(_) => "CIRCLE",
        EntityType::RotatedDimension(_)
        | EntityType::RadialDimension(_)
        | EntityType::DiameterDimension(_)
        | EntityType::AngularThreePointDimension(_)
        | EntityType::OrdinateDimension(_) => "DIMENSION",
        EntityType::Ellipse(_) => "ELLIPSE",
        EntityType::Helix(_) => "HELIX",
        EntityType::Image(_) => "IMAGE",
        EntityType::Insert(_) => "INSERT",
        EntityType::Leader(_) => "LEADER",
        EntityType::Light(_) => "LIGHT",
        EntityType::Line(_) => "LINE",
        EntityType::LwPolyline(_) => "LWPOLYLINE",
        EntityType::MLine(_) => "MLINE",
        EntityType::MText(_) => "MTEXT",
        EntityType::OleFrame(_) => "OLEFRAME",
        EntityType::Ole2Frame(_) => "OLE2FRAME",
        EntityType::ModelPoint(_) => "POINT",
        EntityType::Polyline(_) => "POLYLINE",
        EntityType::Ray(_) => "RAY",
        EntityType::Region(_) => "REGION",
        EntityType::RText(_) => "RTEXT",
        EntityType::Section(_) => "SECTION",
        EntityType::Seqend(_) => "SEQEND",
        EntityType::Shape(_) => "SHAPE",
        EntityType::Solid(_) => "SOLID",
        EntityType::Spline(_) => "SPLINE",
        EntityType::Text(_) => "TEXT",
        EntityType::Tolerance(_) => "TOLERANCE",
        EntityType::Trace(_) => "TRACE",
        EntityType::DgnUnderlay(_) => "DGNUNDERLAY",
        EntityType::DwfUnderlay(_) => "DWFUNDERLAY",
        EntityType::PdfUnderlay(_) => "PDFUNDERLAY",
        EntityType::Vertex(_) => "VERTEX",
        EntityType::Wipeout(_) => "WIPEOUT",
        EntityType::XLine(_) => "XLINE",
    }
}
