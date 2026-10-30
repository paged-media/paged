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

//! Engine ADR 1047 — live shapes: the parameters a polygon, a star and a
//! pie are made from, kept on the item so they stay editable.
//!
//! - A **polygon or star** is a [`Polygon`] whose anchors were made by
//!   [`polygon_anchors`] from a [`PolygonShape`] (side count, star inset).
//!   The anchors stay the geometry every consumer reads; the parameters
//!   ride along in [`Polygon::live_shape`] and are live while the anchors
//!   are still what they make in their own bounding box
//!   ([`live_polygon`]). A point edit, a reversal or anything else that
//!   reshapes the path ends the live shape without a write; a resize
//!   keeps it, because the shape is fitted to its box.
//! - A **pie** is an [`Oval`] with [`Oval::pie`]: the wedge of the
//!   ellipse inscribed in the oval's bounds between two angles. The
//!   bounds stay the whole ellipse; [`pie_anchors`] is the outline, and
//!   [`pie_polygon`] the polygon a renderer draws it as.
//!
//! IDML has neither: InDesign keeps a polygon's sides and inset only as
//! the polygon tool's preference, and an `<Oval>` is whatever its path
//! says. The IDML export writes the outline (a pie oval's path IS its
//! wedge, which InDesign draws) and keeps the parameters in the item's
//! label ([`label`]); the import lifts them back.

use serde::{Deserialize, Serialize};

use crate::{Bounds, Oval, PathAnchor, Polygon};

/// The fewest sides a polygon (points a star) takes.
pub const MIN_SIDES: u32 = 3;
/// The most sides a polygon (points a star) takes — InDesign's limit.
pub const MAX_SIDES: u32 = 100;
/// The deepest star inset, percent. At 100 every inner point would sit
/// on the centre and the star would have no area.
pub const MAX_STAR_INSET: f32 = 99.0;

/// A live polygon's parameters.
///
/// Inset semantics are the polygon tool's (InDesign's Star Inset): the
/// inner points sit at `1 − inset/100` of the outer radius, and an inset
/// of 0 is the plain polygon (no inner points at all).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolygonShape {
    /// Sides of a polygon, points of a star; [`MIN_SIDES`]..=[`MAX_SIDES`].
    pub sides: u32,
    /// Percent, 0..=[`MAX_STAR_INSET`]; 0 is a plain polygon.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub star_inset: f32,
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

impl PolygonShape {
    /// A shape with both parameters clamped into range (a non-finite
    /// inset reads as 0).
    pub fn new(sides: u32, star_inset: f32) -> Self {
        let inset = if star_inset.is_finite() {
            star_inset.clamp(0.0, MAX_STAR_INSET)
        } else {
            0.0
        };
        Self {
            sides: sides.clamp(MIN_SIDES, MAX_SIDES),
            star_inset: inset,
        }
    }

    /// Whether the shape is a star (it has inner points).
    pub fn is_star(&self) -> bool {
        self.star_inset > 0.0
    }

    /// How many anchors the shape has: a point per side, and a star an
    /// inner point between each two.
    pub fn anchor_count(&self) -> usize {
        let n = self.sides.clamp(MIN_SIDES, MAX_SIDES) as usize;
        if self.is_star() {
            2 * n
        } else {
            n
        }
    }
}

/// A live pie: the wedge of an ellipse swept COUNTER-CLOCKWISE on the
/// page from `start` to `end`, both in degrees from three o'clock —
/// Illustrator's Pie Start and Pie End angles. `start` is in `[0, 360)`
/// and `end` in `[0, 360]`. Both angles are kept even when they name the
/// same direction (a zero sweep), which draws the whole ellipse: moving
/// one angle onto the other and on again must not lose the other one.
/// Only the default pair, 0 and 360, is no pie at all
/// ([`PieAngles::new`] answers `None`); [`PieAngles::cuts`] says whether
/// the pie draws a wedge.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PieAngles {
    pub start: f32,
    pub end: f32,
}

impl PieAngles {
    /// The pie between `start` and `end`, normalised, or `None` for the
    /// default pair (0 and 360: the whole ellipse with nothing set) and
    /// for angles that are not finite.
    pub fn new(start: f32, end: f32) -> Option<Self> {
        if !start.is_finite() || !end.is_finite() {
            return None;
        }
        let pie = Self {
            start: normalize_start(start),
            end: normalize_end(end),
        };
        (!(pie.start == 0.0 && pie.end == 360.0)).then_some(pie)
    }

    /// Whether the pie draws a wedge (its sweep is not a whole turn).
    pub fn cuts(&self) -> bool {
        self.sweep() > 0.0
    }

    /// The angle swept from `start` to `end`, degrees, in `[0, 360)`.
    pub fn sweep(&self) -> f32 {
        (self.end - self.start).rem_euclid(360.0) % 360.0
    }
}

/// The start angle as stored: `[0, 360)`.
pub fn normalize_start(deg: f32) -> f32 {
    let r = deg.rem_euclid(360.0);
    if r >= 360.0 {
        0.0
    } else {
        r + 0.0
    }
}

/// The end angle as stored: `(0, 360]`, so a whole turn reads 360 and
/// not 0 (0 itself stays 0).
pub fn normalize_end(deg: f32) -> f32 {
    let r = normalize_start(deg);
    if r == 0.0 && deg != 0.0 {
        360.0
    } else {
        r
    }
}

/// The pie start an oval shows: 0 for the whole ellipse.
pub fn pie_start(oval: &Oval) -> f32 {
    oval.pie.map_or(0.0, |p| p.start)
}

/// The pie end an oval shows: 360 for the whole ellipse.
pub fn pie_end(oval: &Oval) -> f32 {
    oval.pie.map_or(360.0, |p| p.end)
}

/// The oval's pie when it draws a wedge; `None` for the whole ellipse
/// (no angles set, or two angles a whole turn apart).
pub fn cut_pie(oval: &Oval) -> Option<PieAngles> {
    oval.pie.filter(PieAngles::cuts)
}

// ------------------------------------------------------------ polygons

/// The shape's points on the unit circle: the first points straight up
/// (twelve o'clock) and they run clockwise on the page, the polygon
/// tool's order; a star's inner points sit between them.
fn unit_polygon(shape: PolygonShape) -> Vec<(f64, f64)> {
    let count = shape.anchor_count();
    let inner = 1.0 - f64::from(shape.star_inset.clamp(0.0, MAX_STAR_INSET)) / 100.0;
    (0..count)
        .map(|i| {
            let t =
                -std::f64::consts::FRAC_PI_2 + (i as f64) * std::f64::consts::TAU / (count as f64);
            let r = if shape.is_star() && i % 2 == 1 {
                inner
            } else {
                1.0
            };
            (r * t.cos(), r * t.sin())
        })
        .collect()
}

fn corner(x: f32, y: f32) -> PathAnchor {
    PathAnchor {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    }
}

/// The extent of the shape's unit points: `(min_x, max_x, min_y, max_y)`.
fn unit_extent(unit: &[(f64, f64)]) -> (f64, f64, f64, f64) {
    unit.iter().fold(
        (f64::MAX, f64::MIN, f64::MAX, f64::MIN),
        |(a, b, c, d), &(x, y)| (a.min(x), b.max(x), c.min(y), d.max(y)),
    )
}

/// The box of the ellipse a shape fitted to `frame` is inscribed in —
/// its outer points lie on that ellipse. A change of sides or inset keeps
/// it, so the outer radius stays where it was (Illustrator's behaviour),
/// while the points' own box may grow or shrink.
pub fn circle_box(frame: Bounds, shape: PolygonShape) -> Bounds {
    let (min_x, max_x, min_y, max_y) = unit_extent(&unit_polygon(shape));
    let sx = f64::from(frame.width()) / (max_x - min_x);
    let sy = f64::from(frame.height()) / (max_y - min_y);
    let x = |u: f64| (f64::from(frame.left) + (u - min_x) * sx) as f32;
    let y = |u: f64| (f64::from(frame.top) + (u - min_y) * sy) as f32;
    Bounds {
        top: y(-1.0),
        left: x(-1.0),
        bottom: y(1.0),
        right: x(1.0),
    }
}

/// The anchors of `shape` inscribed in the ellipse of `circle` (its outer
/// points on the ellipse), as the polygon tool draws a shape in its drag
/// box. Every anchor is a corner.
pub fn polygon_anchors_in(circle: Bounds, shape: PolygonShape) -> Vec<PathAnchor> {
    let cx = f64::from(circle.left + circle.right) * 0.5;
    let cy = f64::from(circle.top + circle.bottom) * 0.5;
    let rx = f64::from(circle.width()) * 0.5;
    let ry = f64::from(circle.height()) * 0.5;
    unit_polygon(shape)
        .into_iter()
        .map(|(x, y)| corner((cx + x * rx) as f32, (cy + y * ry) as f32))
        .collect()
}

/// The anchors of `shape` fitted to `frame`: its points' bounding box is
/// `frame` exactly. Every anchor is a corner.
pub fn polygon_anchors(frame: Bounds, shape: PolygonShape) -> Vec<PathAnchor> {
    let unit = unit_polygon(shape);
    let (min_x, max_x, min_y, max_y) = unit_extent(&unit);
    let sx = f64::from(frame.width()) / (max_x - min_x);
    let sy = f64::from(frame.height()) / (max_y - min_y);
    unit.into_iter()
        .map(|(x, y)| {
            corner(
                (f64::from(frame.left) + (x - min_x) * sx) as f32,
                (f64::from(frame.top) + (y - min_y) * sy) as f32,
            )
        })
        .collect()
}

/// The bounding box of the anchor POINTS (not their handles) — the box
/// the IDML reader gives an item from its path. `None` for no anchors.
pub fn anchor_box(anchors: &[PathAnchor]) -> Option<Bounds> {
    let first = anchors.first()?;
    let mut b = Bounds {
        top: first.anchor.1,
        left: first.anchor.0,
        bottom: first.anchor.1,
        right: first.anchor.0,
    };
    for a in &anchors[1..] {
        b.left = b.left.min(a.anchor.0);
        b.right = b.right.max(a.anchor.0);
        b.top = b.top.min(a.anchor.1);
        b.bottom = b.bottom.max(a.anchor.1);
    }
    Some(b)
}

/// Whether a path is `shape` fitted to its own box: one closed contour of
/// corner anchors, each where [`polygon_anchors`] puts it (within a
/// thousandth of a point, or a ten-thousandth of the box on a big one).
pub fn matches_polygon(
    anchors: &[PathAnchor],
    subpath_starts: &[usize],
    subpath_open: &[bool],
    shape: PolygonShape,
) -> bool {
    if subpath_starts.len() > 1
        || subpath_starts.first().is_some_and(|s| *s != 0)
        || subpath_open.iter().any(|o| *o)
        || anchors.len() != shape.anchor_count()
    {
        return false;
    }
    let Some(frame) = anchor_box(anchors) else {
        return false;
    };
    let tol = 1e-3_f32.max(1e-4 * frame.width().abs().max(frame.height().abs()));
    let close = |a: (f32, f32), b: (f32, f32)| (a.0 - b.0).abs() <= tol && (a.1 - b.1).abs() <= tol;
    polygon_anchors(frame, shape)
        .iter()
        .zip(anchors)
        .all(|(want, got)| {
            close(got.anchor, want.anchor)
                && close(got.left, want.anchor)
                && close(got.right, want.anchor)
        })
}

/// The polygon's live shape: its parameters while its anchors are still
/// what they make, `None` otherwise (no parameters, or a path edited
/// since).
pub fn live_polygon(poly: &Polygon) -> Option<PolygonShape> {
    let shape = poly.live_shape?;
    matches_polygon(
        &poly.anchors,
        &poly.subpath_starts,
        &poly.subpath_open,
        shape,
    )
    .then_some(shape)
}

// ---------------------------------------------------------------- pies

/// The four-arc constant for a quarter turn generalised: the handle
/// length of a cubic spanning `d` radians of a unit circle.
fn arc_handle(d: f64) -> f64 {
    4.0 / 3.0 * (d / 4.0).tan()
}

/// A pie's outline in the coordinates of `ellipse` (the oval's bounds):
/// the centre, then the arc from `start` counter-clockwise to `end` in
/// cubic segments of at most a quarter turn. One closed contour; the
/// centre and the two arc ends are corners.
pub fn pie_anchors(ellipse: Bounds, pie: PieAngles) -> Vec<PathAnchor> {
    let cx = f64::from(ellipse.left + ellipse.right) * 0.5;
    let cy = f64::from(ellipse.top + ellipse.bottom) * 0.5;
    let rx = f64::from(ellipse.width()) * 0.5;
    let ry = f64::from(ellipse.height()) * 0.5;
    let sweep = f64::from(pie.sweep()).to_radians();
    let start = f64::from(pie.start).to_radians();
    let segments = (sweep / std::f64::consts::FRAC_PI_2 - 1e-9).ceil().max(1.0) as usize;
    let d = sweep / segments as f64;
    let h = arc_handle(d);
    // Counter-clockwise on a y-down page: y falls as the angle grows.
    let point = |t: f64| (cx + rx * t.cos(), cy - ry * t.sin());
    let tangent = |t: f64| (-rx * t.sin(), -ry * t.cos());
    let f = |(x, y): (f64, f64)| (x as f32, y as f32);
    let mut out = Vec::with_capacity(segments + 2);
    out.push(corner(cx as f32, cy as f32));
    for i in 0..=segments {
        let t = start + d * i as f64;
        let p = point(t);
        let (tx, ty) = tangent(t);
        let left = if i == 0 {
            p
        } else {
            (p.0 - h * tx, p.1 - h * ty)
        };
        let right = if i == segments {
            p
        } else {
            (p.0 + h * tx, p.1 + h * ty)
        };
        out.push(PathAnchor {
            anchor: f(p),
            left: f(left),
            right: f(right),
        });
    }
    out
}

/// The polygon a pie oval is drawn as: the oval's paint, stroke, effects
/// and picture on the pie's outline. The bounds stay the ellipse's, so a
/// gradient or a placed picture does not move as the angles change. The
/// oval's corner attributes are left behind (an ellipse draws none, and
/// neither does its pie). `None` for a whole ellipse.
pub fn pie_polygon(oval: &Oval) -> Option<Polygon> {
    let pie = cut_pie(oval)?;
    let o = oval.clone();
    Some(Polygon {
        self_id: o.self_id,
        bounds: o.bounds,
        item_transform: o.item_transform,
        fill_color: o.fill_color,
        fill_tint: o.fill_tint,
        stroke_color: o.stroke_color,
        stroke_weight: o.stroke_weight,
        stroke_type: o.stroke_type,
        stroke_alignment: o.stroke_alignment,
        end_join: None,
        miter_limit: None,
        stroke_gap_color: o.stroke_gap_color,
        stroke_gap_tint: o.stroke_gap_tint,
        stroke_dash: o.stroke_dash,
        applied_object_style: o.applied_object_style,
        anchors: pie_anchors(oval.bounds, pie),
        subpath_starts: Vec::new(),
        subpath_open: Vec::new(),
        fill_rule: o.fill_rule,
        text_wrap: o.text_wrap,
        item_layer: o.item_layer,
        drop_shadow: o.drop_shadow,
        effects: o.effects,
        effect_stack: o.effect_stack,
        fill_transparency: o.fill_transparency,
        stroke_transparency: o.stroke_transparency,
        content_transparency: o.content_transparency,
        fill_drop_shadow: o.fill_drop_shadow,
        content_drop_shadow: o.content_drop_shadow,
        gradient_fill_angle: o.gradient_fill_angle,
        gradient_fill_length: o.gradient_fill_length,
        gradient_fill_start: o.gradient_fill_start,
        gradient_stroke_angle: o.gradient_stroke_angle,
        gradient_stroke_length: o.gradient_stroke_length,
        opacity: o.opacity,
        blend_mode: o.blend_mode,
        text_paths: Vec::new(),
        image_link: o.image_link,
        has_image_element: o.has_image_element,
        has_inline_pdf: o.has_inline_pdf,
        has_inline_eps: o.has_inline_eps,
        placed_pdf: o.placed_pdf,
        image_item_transform: o.image_item_transform,
        image_bytes: o.image_bytes,
        image_clip: o.image_clip,
        image_adjustments: o.image_adjustments,
        overprint_fill: o.overprint_fill,
        overprint_stroke: o.overprint_stroke,
        nonprinting: o.nonprinting,
        visible: o.visible,
        locked: o.locked,
        corner_radius: None,
        corner_option: None,
        corners: Default::default(),
        end_cap: o.end_cap,
        start_arrow: crate::ArrowheadType::None,
        end_arrow: crate::ArrowheadType::None,
        start_arrow_scale: 100.0,
        end_arrow_scale: 100.0,
        live_shape: None,
    })
}

/// The outline an oval draws, in its own coordinates: the pie's when it
/// has one, otherwise `None` (the whole ellipse, drawn from its bounds).
pub fn oval_outline(oval: &Oval) -> Option<Vec<PathAnchor>> {
    cut_pie(oval).map(|pie| pie_anchors(oval.bounds, pie))
}

// --------------------------------------------------------------- label

/// The IDML form of the live shapes: a label on the item (`paged:liveShape`),
/// stamped by the IDML writer and lifted by the reader.
pub mod label {
    use serde::{Deserialize, Serialize};

    use super::{anchor_box, live_polygon, matches_polygon, pie_anchors, PieAngles, PolygonShape};
    use crate::Bounds;

    /// The label key.
    pub const KEY: &str = "paged:liveShape";

    #[derive(Default, Serialize, Deserialize)]
    struct Envelope {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        polygon: Option<PolygonShape>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pie: Option<PieAngles>,
        /// The pie's whole ellipse `[top, left, bottom, right]`: the IDML
        /// path is the wedge, so the box the reader takes from it is the
        /// wedge's, not the ellipse's.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ellipse: Option<[f32; 4]>,
    }

    /// Whether anything on `spread` has a live shape to stamp.
    pub fn any(spread: &crate::Spread) -> bool {
        spread.ovals.iter().any(|o| super::cut_pie(o).is_some())
            || spread.polygons.iter().any(|p| live_polygon(p).is_some())
    }

    /// Put every live shape on `spread` into its item's label, for an
    /// IDML writer. Returns whether anything was added.
    pub fn stamp(spread: &mut crate::Spread) -> bool {
        let mut add: Vec<(String, String)> = Vec::new();
        for o in &spread.ovals {
            if let (Some(id), Some(pie)) = (&o.self_id, super::cut_pie(o)) {
                let b = o.bounds;
                let env = Envelope {
                    pie: Some(pie),
                    ellipse: Some([b.top, b.left, b.bottom, b.right]),
                    ..Default::default()
                };
                if let Ok(v) = serde_json::to_string(&env) {
                    add.push((id.clone(), v));
                }
            }
        }
        for p in &spread.polygons {
            if let (Some(id), Some(shape)) = (&p.self_id, live_polygon(p)) {
                let env = Envelope {
                    polygon: Some(shape),
                    ..Default::default()
                };
                if let Ok(v) = serde_json::to_string(&env) {
                    add.push((id.clone(), v));
                }
            }
        }
        let any = !add.is_empty();
        for (id, v) in add {
            let entries = spread.labels.entry(id).or_default();
            entries.retain(|(k, _)| k != KEY);
            entries.push((KEY.to_string(), v));
        }
        any
    }

    /// Lift every item's label on `spread` into its live shape and drop
    /// the label from the side map, so the model holds the shape once.
    ///
    /// A polygon takes its shape back only while its path is still that
    /// shape (InDesign may have reshaped it); a pie takes its ellipse
    /// back fitted to the wedge's box as the reader found it, so a pie
    /// InDesign moved or scaled keeps its place and its size.
    pub fn lift(spread: &mut crate::Spread) {
        if !spread
            .labels
            .values()
            .any(|v| v.iter().any(|(k, _)| k == KEY))
        {
            return;
        }
        let mut take = |id: &Option<String>| -> Option<Envelope> {
            let entries = spread.labels.get_mut(id.as_deref()?)?;
            let at = entries.iter().position(|(k, _)| k == KEY)?;
            let (_, v) = entries.remove(at);
            serde_json::from_str(&v).ok()
        };
        for o in spread.ovals.iter_mut() {
            let Some(env) = take(&o.self_id) else {
                continue;
            };
            let (Some(pie), Some([t, l, b, r])) = (env.pie, env.ellipse) else {
                continue;
            };
            let Some(pie) = PieAngles::new(pie.start, pie.end).filter(PieAngles::cuts) else {
                continue;
            };
            let ellipse = Bounds {
                top: t,
                left: l,
                bottom: b,
                right: r,
            };
            let Some(wedge) = anchor_box(&pie_anchors(ellipse, pie)) else {
                continue;
            };
            // A source whose oval carries no path (bounds alone) keeps the
            // ellipse's box: the writer had no path to put the wedge in.
            if !same_box(o.bounds, ellipse) {
                o.bounds = refit(ellipse, wedge, o.bounds);
            }
            o.pie = Some(pie);
        }
        for p in spread.polygons.iter_mut() {
            let Some(env) = take(&p.self_id) else {
                continue;
            };
            let Some(shape) = env
                .polygon
                .map(|s| PolygonShape::new(s.sides, s.star_inset))
            else {
                continue;
            };
            if matches_polygon(&p.anchors, &p.subpath_starts, &p.subpath_open, shape) {
                p.live_shape = Some(shape);
            }
        }
        spread.labels.retain(|_, v| !v.is_empty());
    }

    /// Two boxes equal to a thousandth of a point (the precision IDML
    /// spells a coordinate to and back).
    fn same_box(a: Bounds, b: Bounds) -> bool {
        let tol = 1e-3_f32.max(1e-5 * a.width().abs().max(a.height().abs()));
        (a.top - b.top).abs() <= tol
            && (a.left - b.left).abs() <= tol
            && (a.bottom - b.bottom).abs() <= tol
            && (a.right - b.right).abs() <= tol
    }

    /// `ellipse` moved and scaled the way `from` became `to`, each axis on
    /// its own (an axis with no extent only moves).
    fn refit(ellipse: Bounds, from: Bounds, to: Bounds) -> Bounds {
        let axis = |e0: f32, e1: f32, f0: f32, f1: f32, t0: f32, t1: f32| {
            let fw = f1 - f0;
            if fw.abs() > f32::EPSILON {
                let s = (t1 - t0) / fw;
                (t0 + (e0 - f0) * s, t0 + (e1 - f0) * s)
            } else {
                (e0 + (t0 - f0), e1 + (t0 - f0))
            }
        };
        let (left, right) = axis(
            ellipse.left,
            ellipse.right,
            from.left,
            from.right,
            to.left,
            to.right,
        );
        let (top, bottom) = axis(
            ellipse.top,
            ellipse.bottom,
            from.top,
            from.bottom,
            to.top,
            to.bottom,
        );
        Bounds {
            top,
            left,
            bottom,
            right,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(top: f32, left: f32, bottom: f32, right: f32) -> Bounds {
        Bounds {
            top,
            left,
            bottom,
            right,
        }
    }

    #[test]
    fn a_polygon_fills_its_box_and_starts_at_twelve() {
        let a = polygon_anchors(b(0.0, 0.0, 80.0, 100.0), PolygonShape::new(5, 0.0));
        assert_eq!(a.len(), 5);
        let bx = anchor_box(&a).unwrap();
        assert!((bx.left - 0.0).abs() < 1e-4 && (bx.right - 100.0).abs() < 1e-4);
        assert!((bx.top - 0.0).abs() < 1e-4 && (bx.bottom - 80.0).abs() < 1e-4);
        // The first point is the top middle; the next runs clockwise
        // (right and down on the page).
        assert!((a[0].anchor.0 - 50.0).abs() < 1e-4 && a[0].anchor.1.abs() < 1e-4);
        assert!(a[1].anchor.0 > 50.0 && a[1].anchor.1 > 0.0);
    }

    #[test]
    fn a_star_alternates_outer_and_inner_points() {
        let s = PolygonShape::new(5, 50.0);
        let a = polygon_anchors(b(0.0, 0.0, 100.0, 100.0), s);
        assert_eq!(a.len(), 10);
        // Inner points are nearer the unit centre than the outer ones.
        let c = (50.0, 50.0);
        let d = |p: (f32, f32)| ((p.0 - c.0).powi(2) + (p.1 - c.1).powi(2)).sqrt();
        assert!(d(a[1].anchor) < d(a[0].anchor));
    }

    #[test]
    fn a_polygon_is_live_while_its_points_are_its_shape() {
        let shape = PolygonShape::new(6, 0.0);
        let mut p = Polygon::new("p", b(10.0, 10.0, 70.0, 90.0));
        p.anchors = polygon_anchors(b(10.0, 10.0, 70.0, 90.0), shape);
        p.live_shape = Some(shape);
        assert_eq!(live_polygon(&p), Some(shape));
        // A resize (every point scaled about a corner) keeps it.
        for a in &mut p.anchors {
            a.anchor.0 = 10.0 + (a.anchor.0 - 10.0) * 2.0;
            a.left = a.anchor;
            a.right = a.anchor;
        }
        assert_eq!(live_polygon(&p), Some(shape));
        // A moved point ends it.
        p.anchors[2].anchor.1 += 3.0;
        p.anchors[2].left = p.anchors[2].anchor;
        p.anchors[2].right = p.anchors[2].anchor;
        assert_eq!(live_polygon(&p), None);
    }

    #[test]
    fn a_shape_in_its_circle_is_the_shape_fitted_to_its_box() {
        let shape = PolygonShape::new(5, 30.0);
        let fit = b(10.0, 20.0, 90.0, 120.0);
        let circle = circle_box(fit, shape);
        let a = polygon_anchors(fit, shape);
        let c = polygon_anchors_in(circle, shape);
        for (p, q) in a.iter().zip(&c) {
            assert!(
                (p.anchor.0 - q.anchor.0).abs() < 1e-3 && (p.anchor.1 - q.anchor.1).abs() < 1e-3
            );
        }
        // A pentagon's box is shorter than its circle (no point at the
        // bottom); the circle's top is the top point.
        assert!((circle.top - 10.0).abs() < 1e-4 && circle.bottom > 90.0);
    }

    #[test]
    fn pie_angles_normalise_and_a_whole_turn_is_no_pie() {
        assert_eq!(PieAngles::new(0.0, 360.0), None);
        // Two angles in one direction are kept, and draw the ellipse.
        let same = PieAngles::new(90.0, 90.0).unwrap();
        assert!(!same.cuts());
        assert!(PieAngles::new(0.0, 90.0).unwrap().cuts());
        assert_eq!(PieAngles::new(-90.0, 720.0 + 45.0).unwrap().start, 270.0);
        let p = PieAngles::new(0.0, 90.0).unwrap();
        assert_eq!(p.sweep(), 90.0);
        let wrap = PieAngles::new(270.0, 90.0).unwrap();
        assert_eq!(wrap.sweep(), 180.0);
        assert_eq!(PieAngles::new(30.0, 360.0).unwrap().end, 360.0);
    }

    #[test]
    fn a_quarter_pie_is_the_centre_and_a_quarter_arc_up_and_right() {
        // A circle of radius 50 centred at (50, 50); 0°..90° is the
        // upper-right quarter on the page.
        let a = pie_anchors(
            b(0.0, 0.0, 100.0, 100.0),
            PieAngles::new(0.0, 90.0).unwrap(),
        );
        assert_eq!(a.len(), 3);
        assert_eq!(a[0].anchor, (50.0, 50.0));
        assert!((a[1].anchor.0 - 100.0).abs() < 1e-4 && (a[1].anchor.1 - 50.0).abs() < 1e-4);
        assert!((a[2].anchor.0 - 50.0).abs() < 1e-4 && a[2].anchor.1.abs() < 1e-4);
        // The handle is the four-arc constant times the radius, along the
        // tangent (up from three o'clock).
        let k = 50.0 * 0.552_284_8;
        assert!((a[1].right.1 - (50.0 - k)).abs() < 1e-3);
        let box_ = anchor_box(&a).unwrap();
        assert_eq!((box_.left, box_.top), (50.0, 0.0));
    }

    #[test]
    fn a_wide_pie_splits_into_quarter_segments() {
        let a = pie_anchors(
            b(0.0, 0.0, 100.0, 100.0),
            PieAngles::new(45.0, 315.0).unwrap(),
        );
        // 270° → three segments: centre + four arc points.
        assert_eq!(a.len(), 5);
    }

    #[test]
    fn the_label_carries_a_pie_through_its_wedge_box() {
        let mut s = crate::Spread::default();
        let mut o = Oval::new("o", b(0.0, 0.0, 100.0, 200.0));
        o.pie = PieAngles::new(0.0, 90.0);
        s.ovals.push(o);
        let shape = PolygonShape::new(7, 30.0);
        let mut p = Polygon::new("p", b(0.0, 0.0, 50.0, 50.0));
        p.anchors = polygon_anchors(b(0.0, 0.0, 50.0, 50.0), shape);
        p.live_shape = Some(shape);
        s.polygons.push(p);
        assert!(label::any(&s));
        assert!(label::stamp(&mut s));
        // What the IDML reader makes of it: the bounds of the wedge's
        // path, no parameters.
        let wedge = anchor_box(&oval_outline(&s.ovals[0]).unwrap()).unwrap();
        s.ovals[0].bounds = wedge;
        s.ovals[0].pie = None;
        s.polygons[0].live_shape = None;
        label::lift(&mut s);
        assert!(s.labels.is_empty());
        let o = &s.ovals[0];
        assert_eq!(o.pie, PieAngles::new(0.0, 90.0));
        assert!((o.bounds.right - 200.0).abs() < 1e-3 && (o.bounds.bottom - 100.0).abs() < 1e-3);
        assert_eq!(s.polygons[0].live_shape, Some(shape));
    }

    #[test]
    fn a_reshaped_polygon_does_not_take_its_label_back() {
        let mut s = crate::Spread::default();
        let shape = PolygonShape::new(5, 0.0);
        let mut p = Polygon::new("p", b(0.0, 0.0, 50.0, 50.0));
        p.anchors = polygon_anchors(b(0.0, 0.0, 50.0, 50.0), shape);
        p.live_shape = Some(shape);
        s.polygons.push(p);
        label::stamp(&mut s);
        s.polygons[0].live_shape = None;
        s.polygons[0].anchors[0].anchor.0 += 5.0;
        label::lift(&mut s);
        assert_eq!(s.polygons[0].live_shape, None);
        assert!(s.labels.is_empty());
    }

    #[test]
    fn a_pie_polygon_keeps_the_ovals_paint_and_drops_its_corners() {
        let mut o = Oval::new("o", b(0.0, 0.0, 10.0, 10.0));
        o.fill_color = Some("Color/Black".into());
        o.corner_radius = Some(4.0);
        assert!(pie_polygon(&o).is_none());
        o.pie = PieAngles::new(10.0, 200.0);
        let p = pie_polygon(&o).unwrap();
        assert_eq!(p.fill_color.as_deref(), Some("Color/Black"));
        assert_eq!(p.corner_radius, None);
        assert_eq!(p.bounds.right, 10.0);
        assert!(!p.anchors.is_empty());
    }
}
