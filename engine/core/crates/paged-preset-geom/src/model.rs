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
//! Engine ADR 1096 — a preset on a model path item
//! ([`paged_model::live_shape::PresetShape`] on a [`Polygon`]).
//!
//! - [`draw`]: the anchors a preset makes (its part of the program, drawn
//!   for its box, mirrored by its flips, at the box's place).
//! - [`live_preset`]: the preset while the anchors are still what it
//!   draws (ADR 1047's rule; [`live::FIT_TOLERANCE`]).
//! - [`refit`]: after a resize (the anchors scaled, or the item's transform
//!   scaled), the preset drawn again for the box the item covers now, the
//!   scale moved out of the transform into the box.
//! - [`handles`], [`drag_handle`]: the adjust handles in the item's own
//!   coordinates and the adjust values a drag sets.
//! - [`sites`], [`route`]: connection sites in the item's container and a
//!   connector drawn between two of them.

use paged_model::live_shape::{PresetPart, PresetShape};
use paged_model::{Bounds, PathAnchor, Polygon};

use crate::live::{self, apply, mul, Affine, Anchor, Part, IDENTITY};
use crate::{preset_evaluated, preset_geometry, Site, SubPath};

/// A path as the model holds it.
#[derive(Debug, Clone, PartialEq)]
pub struct Drawn {
    pub anchors: Vec<PathAnchor>,
    /// One start per contour (`[0]` for one contour, as the readers write).
    pub starts: Vec<usize>,
    pub open: Vec<bool>,
}

impl Drawn {
    /// The box the anchors span (control points included), as the frame
    /// box of a path follows its points.
    pub fn bounds(&self) -> Option<Bounds> {
        paged_model::live_shape::anchor_box(&self.anchors)
    }
}

fn part(p: PresetPart) -> Part {
    match p {
        PresetPart::All => Part::All,
        PresetPart::Fill => Part::Fill,
        PresetPart::Detail => Part::Detail,
    }
}

fn adjusts(p: &PresetShape) -> &[(String, String)] {
    &p.adjusts
}

/// The subpaths `p` draws in its box's coordinates, `(0, 0)`–`(w, h)`,
/// mirrored by its flips. `None` for a name that is no preset.
pub fn subpaths_in_box(p: &PresetShape) -> Option<Vec<SubPath>> {
    let [_, _, w, h] = p.frame;
    let (w, h) = (f64::from(w), f64::from(h));
    let e = preset_evaluated(&p.name, adjusts(p), w, h)?;
    let mut subs = live::part_of(&e.outline.subpaths, part(p.part));
    if p.flip_h || p.flip_v {
        let f = |q: (f64, f64)| {
            (
                if p.flip_h { w - q.0 } else { q.0 },
                if p.flip_v { h - q.1 } else { q.1 },
            )
        };
        for s in &mut subs {
            for pt in &mut s.points {
                pt.anchor = f(pt.anchor);
                pt.left = f(pt.left);
                pt.right = f(pt.right);
            }
        }
    }
    Some(subs)
}

/// Subpaths in box coordinates as the model's anchors, at the box's
/// place `(x, y)` in the item's own coordinates.
pub fn to_model(subpaths: &[SubPath], x: f64, y: f64) -> Drawn {
    let mut anchors = Vec::new();
    let mut starts = Vec::new();
    let mut open = Vec::new();
    let at = |q: (f64, f64)| ((q.0 + x) as f32, (q.1 + y) as f32);
    for s in subpaths {
        if s.points.is_empty() {
            continue;
        }
        starts.push(anchors.len());
        open.push(!s.closed);
        anchors.extend(s.points.iter().map(|pt| PathAnchor {
            anchor: at(pt.anchor),
            left: at(pt.left),
            right: at(pt.right),
        }));
    }
    Drawn {
        anchors,
        starts,
        open,
    }
}

/// The anchors preset `p` draws. `None` for a name that is no preset.
pub fn draw(p: &PresetShape) -> Option<Drawn> {
    let subs = subpaths_in_box(p)?;
    Some(to_model(
        &subs,
        f64::from(p.frame[0]),
        f64::from(p.frame[1]),
    ))
}

/// A model path's anchors in a preset's box coordinates, as the live
/// arithmetic takes them.
fn in_box(anchors: &[PathAnchor], x: f64, y: f64) -> Vec<Anchor> {
    let b = |q: (f32, f32)| (f64::from(q.0) - x, f64::from(q.1) - y);
    anchors
        .iter()
        .map(|a| [b(a.anchor), b(a.left), b(a.right)])
        .collect()
}

/// `[sx, ox, sy, oy]` mapping the outline `p` draws onto `anchors`
/// (box coordinates), or `None` when they are no scale of it.
fn fit_anchors(p: &PresetShape, anchors: &[PathAnchor], starts: &[usize]) -> Option<[f64; 4]> {
    let expected = subpaths_in_box(p)?;
    if expected.is_empty() {
        return None;
    }
    let local = in_box(anchors, f64::from(p.frame[0]), f64::from(p.frame[1]));
    live::fit(&expected, &local, starts)
}

fn identity_fit(f: &[f64; 4]) -> bool {
    let unit = |v: f64| (v - 1.0).abs() < 1e-4;
    unit(f[0]) && unit(f[2]) && f[1].abs() < 1e-3 && f[3].abs() < 1e-3
}

/// The polygon's preset while its anchors are what the preset draws for
/// its box; `None` otherwise (no preset, or a path edited since).
pub fn live_preset(poly: &Polygon) -> Option<&PresetShape> {
    let p = poly.preset.as_ref()?;
    let f = fit_anchors(p, &poly.anchors, &poly.subpath_starts)?;
    identity_fit(&f).then_some(p)
}

/// Whether `anchors` are what `p` draws (to the live tolerance).
pub fn anchors_are(p: &PresetShape, anchors: &[PathAnchor], starts: &[usize]) -> bool {
    fit_anchors(p, anchors, starts).is_some_and(|f| identity_fit(&f))
}

fn to64(t: Option<[f32; 6]>) -> Affine {
    t.map_or(IDENTITY, |m| m.map(f64::from))
}

fn to32(t: Affine) -> [f32; 6] {
    t.map(|v| v as f32)
}

/// A preset item drawn again for a new box.
#[derive(Debug, Clone, PartialEq)]
pub struct Refitted {
    /// The preset with its new box.
    pub preset: PresetShape,
    pub drawn: Drawn,
    /// The item's new transform (its columns unit length: the scale moved
    /// into the box; rotation and flips stay). `None` when it had none and
    /// needs none.
    pub transform: Option<[f32; 6]>,
    /// Old box coordinates → new box coordinates (`x·sx`, `y·sy`): how a
    /// companion on the old box (the shape's text frame) follows.
    pub scale: (f64, f64),
}

/// What [`refit`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum Refit {
    /// The item still holds the preset for its box: nothing to do.
    Same,
    /// It was resized: here is the preset for the new box.
    Refitted(Box<Refitted>),
    /// Its anchors are no scale of the preset (reshaped by hand), or the
    /// new size changes the preset's contours: it is no longer live.
    Reshaped,
}

/// Where an item with `transform` and preset `p` drawn at the box
/// `(x, y, w, h)` lands when its box → container map is `m`: the new
/// transform, box size and the scale.
fn normalise(
    p: &PresetShape,
    m: Affine,
    had_transform: bool,
) -> (PresetShape, Option<[f32; 6]>, (f64, f64)) {
    let [x, y, w, h] = p.frame.map(f64::from);
    let n1 = m[0].hypot(m[1]);
    let n2 = m[2].hypot(m[3]);
    let col = |a: f64, b: f64, n: f64, fa: f64, fb: f64| {
        if n < 1e-9 {
            let fl = fa.hypot(fb).max(1e-12);
            (fa / fl, fb / fl)
        } else {
            (a / n, b / n)
        }
    };
    let c1 = col(m[0], m[1], n1, 1.0, 0.0);
    let c2 = col(m[2], m[3], n2, 0.0, 1.0);
    let (w2, h2) = (w * n1, h * n2);
    let mut next = p.clone();
    // The item's own coordinates keep the box at (x, y): the new transform
    // maps (x, y) + box' onto the container as `m` maps the old box.
    let linear_identity = (c1.0 - 1.0).abs() < 1e-9
        && c1.1.abs() < 1e-9
        && c2.0.abs() < 1e-9
        && (c2.1 - 1.0).abs() < 1e-9;
    let transform = if !had_transform && linear_identity {
        // No transform before and none needed: the box moves instead.
        next.frame = [m[4] as f32, m[5] as f32, w2 as f32, h2 as f32];
        None
    } else {
        let tx = m[4] - c1.0 * x - c2.0 * y;
        let ty = m[5] - c1.1 * x - c2.1 * y;
        next.frame = [x as f32, y as f32, w2 as f32, h2 as f32];
        Some(to32([c1.0, c1.1, c2.0, c2.1, tx, ty]))
    };
    (next, transform, (n1, n2))
}

/// Fit `poly`'s preset to its current anchors and transform and, when it
/// was resized, draw it again for the box it covers now. `None` when the
/// polygon has no preset (or names no program).
pub fn refit(poly: &Polygon) -> Option<Refit> {
    let p = poly.preset.as_ref()?;
    preset_geometry(&p.name)?;
    let Some(f) = fit_anchors(p, &poly.anchors, &poly.subpath_starts) else {
        return Some(Refit::Reshaped);
    };
    let t = to64(poly.item_transform);
    let [x, y, _, _] = p.frame.map(f64::from);
    // Old box coordinates → the container: the fitted local scale, the
    // box's place, then the transform.
    let m = mul(
        &t,
        &mul(
            &[1.0, 0.0, 0.0, 1.0, x, y],
            &[f[0], 0.0, 0.0, f[2], f[1], f[3]],
        ),
    );
    let unit = |v: f64| (v - 1.0).abs() < 1e-4;
    if identity_fit(&f) && unit(t[0].hypot(t[1])) && unit(t[2].hypot(t[3])) {
        return Some(Refit::Same);
    }
    let (next, transform, scale) = normalise(p, m, poly.item_transform.is_some());
    let old_count = subpaths_in_box(p)?.len();
    let drawn = draw(&next)?;
    if drawn.starts.len() != old_count {
        return Some(Refit::Reshaped);
    }
    Some(Refit::Refitted(Box::new(Refitted {
        preset: next,
        drawn,
        transform,
        scale,
    })))
}

/// A companion of a refitted item (its detail item) drawn for the new box.
pub fn companion(p: &PresetShape, refitted: &PresetShape) -> Option<(PresetShape, Drawn)> {
    let mut next = p.clone();
    next.frame = refitted.frame;
    next.flip_h = refitted.flip_h;
    next.flip_v = refitted.flip_v;
    let drawn = draw(&next)?;
    Some((next, drawn))
}

// ─── adjust handles ─────────────────────────────────────────────────

/// One adjust handle in the item's own coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelHandle {
    pub pos: (f64, f64),
    pub polar: bool,
    /// The adjust values it moves.
    pub refs: Vec<String>,
}

fn box_to_own(p: &PresetShape, q: (f64, f64)) -> (f64, f64) {
    let [x, y, w, h] = p.frame.map(f64::from);
    (
        x + if p.flip_h { w - q.0 } else { q.0 },
        y + if p.flip_v { h - q.1 } else { q.1 },
    )
}

fn own_to_box(p: &PresetShape, q: (f64, f64)) -> (f64, f64) {
    let [x, y, w, h] = p.frame.map(f64::from);
    let (bx, by) = (q.0 - x, q.1 - y);
    (
        if p.flip_h { w - bx } else { bx },
        if p.flip_v { h - by } else { by },
    )
}

/// The adjust handles of `p`, in the item's own coordinates.
pub fn handles(p: &PresetShape) -> Vec<ModelHandle> {
    let [_, _, w, h] = p.frame.map(f64::from);
    live::handles(&p.name, adjusts(p), w, h)
        .unwrap_or_default()
        .into_iter()
        .map(|hd| ModelHandle {
            pos: box_to_own(p, hd.pos),
            polar: hd.polar,
            refs: hd.refs,
        })
        .collect()
}

/// The adjust values that put handle `index` of `p` at `target` (the
/// item's own coordinates): every adjust value of the program as
/// `val N`. `None` for an unknown preset or handle.
pub fn drag_handle(
    p: &PresetShape,
    index: usize,
    target: (f64, f64),
) -> Option<Vec<(String, String)>> {
    let [_, _, w, h] = p.frame.map(f64::from);
    live::drag_handle(&p.name, adjusts(p), w, h, index, own_to_box(p, target))
}

/// Every adjust value of `p`'s program with `p`'s own overriding the
/// defaults, in the program's order (an authored value the program does
/// not name is kept at the end).
pub fn adjusts_resolved(p: &PresetShape) -> Vec<(String, String)> {
    let Some(geom) = preset_geometry(&p.name) else {
        return p.adjusts.clone();
    };
    let mut out: Vec<(String, String)> = geom
        .adjust
        .iter()
        .map(|(n, f)| {
            let own = p.adjusts.iter().find(|(m, _)| m == n).map(|(_, v)| v);
            (n.clone(), own.unwrap_or(f).clone())
        })
        .collect();
    for (n, f) in &p.adjusts {
        if !out.iter().any(|(m, _)| m == n) {
            out.push((n.clone(), f.clone()));
        }
    }
    out
}

// ─── connection sites and connectors ────────────────────────────────

/// The connection sites of `p` in the item's container: the program's
/// sites (a rectangle's for a name that is no preset) through the box's
/// place, its flips and the item's transform.
pub fn sites(p: &PresetShape, transform: Option<[f32; 6]>) -> Vec<Site> {
    let [x, y, w, h] = p.frame.map(f64::from);
    let flip = [
        if p.flip_h { -1.0 } else { 1.0 },
        0.0,
        0.0,
        if p.flip_v { -1.0 } else { 1.0 },
        if p.flip_h { x + w } else { x },
        if p.flip_v { y + h } else { y },
    ];
    let m = mul(&to64(transform), &flip);
    live::sites_on_page(&p.name, adjusts(p), w, h, &m)
}

/// The four side midpoints of a plain box (`Bounds` in the item's own
/// coordinates) in its container, as PowerPoint glues to a shape without
/// sites of its own: right, bottom, left, top.
pub fn box_sites(b: Bounds, transform: Option<[f32; 6]>) -> Vec<Site> {
    let p = PresetShape {
        frame: [b.left, b.top, b.right - b.left, b.bottom - b.top],
        ..PresetShape::new("rect", 0.0, 0.0)
    };
    sites(&p, transform)
}

/// A connector routed between two sites.
#[derive(Debug, Clone, PartialEq)]
pub struct Routed {
    pub preset: PresetShape,
    pub drawn: Drawn,
    pub transform: [f32; 6],
}

/// Connector `p` drawn from `start` to `end` (sites in its container):
/// its box at its own origin, its transform the route's.
pub fn route(p: &PresetShape, start: Site, end: Site) -> Option<Routed> {
    let r = live::route(&p.name, adjusts(p), start, end)?;
    let mut next = p.clone();
    next.frame = [0.0, 0.0, r.w as f32, r.h as f32];
    next.flip_h = false;
    next.flip_v = false;
    let drawn = to_model(&r.subpaths, 0.0, 0.0);
    Some(Routed {
        preset: next,
        drawn,
        transform: to32(r.transform),
    })
}

/// Where a connector's two ends are in its container: its first and
/// last anchor through its transform.
pub fn connector_ends(poly: &Polygon) -> Option<((f64, f64), (f64, f64))> {
    let t = to64(poly.item_transform);
    let first = poly.anchors.first()?;
    let last = poly.anchors.last()?;
    let p = |a: &PathAnchor| apply(&t, (f64::from(a.anchor.0), f64::from(a.anchor.1)));
    Some((p(first), p(last)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn poly_of(p: PresetShape, t: Option<[f32; 6]>) -> Polygon {
        let d = draw(&p).unwrap();
        Polygon {
            anchors: d.anchors,
            subpath_starts: d.starts,
            subpath_open: d.open,
            item_transform: t,
            preset: Some(p),
            ..Polygon::new(
                "p",
                Bounds {
                    top: 0.0,
                    left: 0.0,
                    bottom: 0.0,
                    right: 0.0,
                },
            )
        }
    }

    #[test]
    fn a_drawn_preset_is_live_and_a_moved_point_ends_it() {
        let p = PresetShape {
            frame: [10.0, 20.0, 200.0, 100.0],
            ..PresetShape::new("roundRect", 0.0, 0.0)
        };
        let mut poly = poly_of(p, None);
        assert!(live_preset(&poly).is_some());
        assert_eq!(refit(&poly), Some(Refit::Same));
        poly.anchors[2].anchor.0 += 5.0;
        assert!(live_preset(&poly).is_none());
        assert_eq!(refit(&poly), Some(Refit::Reshaped));
    }

    #[test]
    fn scaled_anchors_refit_and_keep_the_corner_radius() {
        let p = PresetShape {
            frame: [10.0, 20.0, 200.0, 100.0],
            ..PresetShape::new("roundRect", 0.0, 0.0)
        };
        let mut poly = poly_of(p, None);
        // Twice as wide about x = 10.
        for a in &mut poly.anchors {
            for q in [&mut a.anchor, &mut a.left, &mut a.right] {
                q.0 = 10.0 + (q.0 - 10.0) * 2.0;
            }
        }
        let Some(Refit::Refitted(r)) = refit(&poly) else {
            panic!("refit");
        };
        assert_eq!(r.transform, None);
        assert_eq!(r.preset.frame, [10.0, 20.0, 400.0, 100.0]);
        // The radius is a sixth of the short side, as before: 16.67.
        let min_x = r
            .drawn
            .anchors
            .iter()
            .map(|a| a.anchor.0)
            .filter(|&x| x > 10.0)
            .fold(f32::MAX, f32::min);
        assert!((min_x - 26.667).abs() < 0.01, "{min_x}");
        assert!((r.scale.0 - 2.0).abs() < 1e-6 && (r.scale.1 - 1.0).abs() < 1e-6);
    }

    #[test]
    fn a_scaled_transform_moves_into_the_box() {
        let p = PresetShape::new("rightArrow", 100.0, 50.0);
        let poly = poly_of(p, Some([3.0, 0.0, 0.0, 2.0, 7.0, 9.0]));
        let Some(Refit::Refitted(r)) = refit(&poly) else {
            panic!("refit");
        };
        assert_eq!(r.transform, Some([1.0, 0.0, 0.0, 1.0, 7.0, 9.0]));
        assert_eq!(r.preset.frame, [0.0, 0.0, 300.0, 100.0]);
        let refitted = poly_of(r.preset, r.transform);
        assert_eq!(refit(&refitted), Some(Refit::Same));
    }

    #[test]
    fn handles_drag_in_own_coordinates_with_flips() {
        let p = PresetShape {
            frame: [0.0, 0.0, 200.0, 100.0],
            flip_h: true,
            ..PresetShape::new("roundRect", 0.0, 0.0)
        };
        let h = handles(&p);
        assert_eq!(h.len(), 1);
        // The handle sits on the top edge, a radius in from the (mirrored)
        // left: at 200 - 16.67.
        assert!((h[0].pos.0 - (200.0 - 16.667)).abs() < 0.01, "{:?}", h[0]);
        let adj = drag_handle(&p, 0, (200.0 - 10.0, 0.0)).unwrap();
        assert_eq!(adj, vec![("adj".to_string(), "val 10000".to_string())]);
    }

    #[test]
    fn sites_follow_the_box_place_and_transform() {
        let p = PresetShape {
            frame: [10.0, 0.0, 100.0, 50.0],
            ..PresetShape::new("rect", 0.0, 0.0)
        };
        let s = sites(&p, Some([1.0, 0.0, 0.0, 1.0, 5.0, 5.0]));
        // rect's first site is the top centre (cxn order of Annex D).
        assert!(s
            .iter()
            .any(|s| (s.pos.0 - 65.0).abs() < 1e-9 && (s.pos.1 - 5.0).abs() < 1e-9));
        assert!(s
            .iter()
            .any(|s| (s.pos.0 - 115.0).abs() < 1e-9 && (s.pos.1 - 30.0).abs() < 1e-9));
    }

    #[test]
    fn a_connector_routes_between_two_sites() {
        let p = PresetShape::new("bentConnector3", 10.0, 10.0);
        let r = route(
            &p,
            Site {
                pos: (0.0, 0.0),
                angle: 0.0,
            },
            Site {
                pos: (100.0, 40.0),
                angle: 180.0,
            },
        )
        .unwrap();
        assert_eq!(r.preset.frame, [0.0, 0.0, 100.0, 40.0]);
        let t = r.transform.map(f64::from);
        let first = r.drawn.anchors.first().unwrap().anchor;
        let last = r.drawn.anchors.last().unwrap().anchor;
        let at = |q: (f32, f32)| apply(&t, (f64::from(q.0), f64::from(q.1)));
        assert_eq!(at(first), (0.0, 0.0));
        assert_eq!(at(last), (100.0, 40.0));
    }
}
