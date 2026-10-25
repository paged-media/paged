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

//! Live presets: a preset shape that stays a preset while it is edited.
//!
//! - **Refit.** A host resizes a path by scaling its anchors (or its
//!   transform). [`refit_preset`] recovers that scale by fitting the outline
//!   the preset drew for its last box onto the anchors the item holds now,
//!   and draws the preset again for the new box, so a rounded rectangle
//!   keeps its corner radius and an arrow its head. Anchors that no longer
//!   fit any scale of the old outline were reshaped by hand: the shape is no
//!   longer that preset.
//! - **Adjust handles.** [`drag_handle`] finds the adjust values that put a
//!   handle (`a:ahXY` / `a:ahPolar`) where the pointer is, within the
//!   handle's range, numerically (the guide formulas are not inverted).
//! - **Connection sites and connectors.** [`sites_on_page`] places a shape's
//!   sites on the page; [`route`] draws a connector preset
//!   (`straightConnector1`, `bentConnectorN`, `curvedConnectorN`) from one
//!   site to another as PowerPoint does: a box from the start to the end,
//!   flipped (and turned a quarter for a site that faces up or down).
//!
//! Transforms are `[a, b, c, d, tx, ty]`, mapping `(x, y)` to
//! `(a x + c y + tx, b x + d y + ty)`.

use crate::{guides_of, preset_evaluated, preset_geometry, AdjustHandle, Site, SubPath};

/// `[a, b, c, d, tx, ty]`.
pub type Affine = [f64; 6];

pub const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `m ∘ n`: `n` first, then `m`.
pub fn mul(m: &Affine, n: &Affine) -> Affine {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

pub fn apply(m: &Affine, p: (f64, f64)) -> (f64, f64) {
    (
        m[0] * p.0 + m[2] * p.1 + m[4],
        m[1] * p.0 + m[3] * p.1 + m[5],
    )
}

pub fn invert(m: &Affine) -> Option<Affine> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-12 {
        return None;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
}

/// One anchor as hosts hold it: the anchor, its incoming and outgoing
/// control points.
pub type Anchor = [(f64, f64); 3];

/// Which of a preset's subpaths one page element draws. A filled shape is
/// written as its filled subpaths, and its stroke-only detail paths (a
/// callout's leader, a cube's edges) as a second element above it; an
/// unfilled one as all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    /// The filled subpaths.
    Fill,
    /// Every subpath.
    All,
    /// The stroke-only subpaths over a filled shape.
    Detail,
}

/// The subpaths of `outline` that `part` draws.
pub fn part_of(subpaths: &[SubPath], part: Part) -> Vec<SubPath> {
    subpaths
        .iter()
        .filter(|s| match part {
            Part::Fill => s.filled,
            Part::All => true,
            Part::Detail => !s.filled && s.stroked,
        })
        .cloned()
        .collect()
}

/// Subpaths as a host's flat anchor list and its contour starts (the
/// first contour's `0` left out when there is only one, as hosts keep it).
pub fn flatten(subpaths: &[SubPath]) -> (Vec<Anchor>, Vec<usize>, Vec<bool>) {
    let mut anchors = Vec::new();
    let mut starts = Vec::new();
    let mut open = Vec::new();
    for s in subpaths {
        if s.points.is_empty() {
            continue;
        }
        starts.push(anchors.len());
        open.push(!s.closed);
        anchors.extend(s.points.iter().map(|p| [p.anchor, p.left, p.right]));
    }
    if starts.len() <= 1 {
        starts.clear();
    }
    (anchors, starts, open)
}

/// The contour sizes of a flat anchor list.
fn contour_sizes(n: usize, starts: &[usize]) -> Vec<usize> {
    if starts.len() <= 1 {
        return if n == 0 { Vec::new() } else { vec![n] };
    }
    let mut out = Vec::with_capacity(starts.len());
    for (i, &s) in starts.iter().enumerate() {
        let e = starts.get(i + 1).copied().unwrap_or(n);
        out.push(e.saturating_sub(s));
    }
    out
}

/// How far a point may sit from the fitted outline and still be the same
/// shape (pt). Hosts keep anchors to 1/1000 pt in single precision.
pub const FIT_TOLERANCE: f64 = 0.05;

/// The per-axis scale and offset `(sx, ox, sy, oy)` that maps `expected`
/// onto `anchors` (`x' = sx·x + ox`, `y' = sy·y + oy`), by least squares
/// over every anchor and control point; `None` when the contours differ or
/// some point sits further than [`FIT_TOLERANCE`] from the fit.
pub fn fit(expected: &[SubPath], anchors: &[Anchor], starts: &[usize]) -> Option<[f64; 4]> {
    let (exp, exp_starts, _) = flatten(expected);
    if exp.len() != anchors.len()
        || contour_sizes(exp.len(), &exp_starts) != contour_sizes(anchors.len(), starts)
    {
        return None;
    }
    let pairs: Vec<((f64, f64), (f64, f64))> = exp
        .iter()
        .zip(anchors)
        .flat_map(|(e, c)| (0..3).map(move |k| (e[k], c[k])))
        .collect();
    let axis = |get: &dyn Fn((f64, f64)) -> f64| -> (f64, f64) {
        let n = pairs.len() as f64;
        let mx = pairs.iter().map(|(e, _)| get(*e)).sum::<f64>() / n;
        let my = pairs.iter().map(|(_, c)| get(*c)).sum::<f64>() / n;
        let sxx: f64 = pairs.iter().map(|(e, _)| (get(*e) - mx).powi(2)).sum();
        let sxy: f64 = pairs
            .iter()
            .map(|(e, c)| (get(*e) - mx) * (get(*c) - my))
            .sum();
        if sxx < 1e-9 {
            // No extent along this axis (a horizontal line): nothing to
            // scale, only to shift.
            (1.0, my - mx)
        } else {
            let s = sxy / sxx;
            (s, my - s * mx)
        }
    };
    let (sx, ox) = axis(&|p| p.0);
    let (sy, oy) = axis(&|p| p.1);
    let tol = FIT_TOLERANCE * sx.abs().max(sy.abs()).max(1.0);
    let off = pairs
        .iter()
        .any(|(e, c)| (sx * e.0 + ox - c.0).abs() > tol || (sy * e.1 + oy - c.1).abs() > tol);
    if off {
        None
    } else {
        Some([sx, ox, sy, oy])
    }
}

/// A preset drawn again for its new box.
#[derive(Debug, Clone, PartialEq)]
pub struct Regenerated {
    /// Which subpaths the element draws.
    pub part: Part,
    /// The element's new transform: the old one with the scale moved into
    /// the box (its columns are unit length; rotation and flips stay).
    pub transform: Affine,
    pub w: f64,
    pub h: f64,
    pub subpaths: Vec<SubPath>,
    /// Old box coordinates → new box coordinates (`x·sx`, `y·sy`): how a
    /// companion element in the old box (the shape's text frame) follows.
    pub scale: (f64, f64),
}

/// What [`refit_preset`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum Refit {
    /// The element still holds the preset for its box: nothing to do.
    Same,
    /// It was resized: here is the preset for the new box.
    Regenerated(Regenerated),
    /// Its anchors are no scale of the preset: it was reshaped by hand.
    Reshaped,
}

/// Fit preset `name` (with `adjust`, last drawn for a `w` × `h` box) to an
/// element's current `anchors` and `transform`, and draw it again for the
/// box the element now covers. `None` for an unknown preset.
pub fn refit_preset(
    name: &str,
    adjust: &[(String, String)],
    w: f64,
    h: f64,
    anchors: &[Anchor],
    starts: &[usize],
    transform: &Affine,
) -> Option<Refit> {
    let old = preset_evaluated(name, adjust, w, h)?.outline.subpaths;
    let found = [Part::Fill, Part::All, Part::Detail]
        .into_iter()
        .find_map(|part| {
            let exp = part_of(&old, part);
            (!exp.is_empty())
                .then(|| fit(&exp, anchors, starts).map(|f| (part, f)))
                .flatten()
        });
    let Some((part, [sx, ox, sy, oy])) = found else {
        return Some(Refit::Reshaped);
    };
    // Box → page now: the transform after the fitted local scale.
    let m = mul(transform, &[sx, 0.0, 0.0, sy, ox, oy]);
    let n1 = (m[0] * m[0] + m[1] * m[1]).sqrt();
    let n2 = (m[2] * m[2] + m[3] * m[3]).sqrt();
    let (w2, h2) = (w * n1, h * n2);
    let unit = |v: f64| (v - 1.0).abs() < 1e-4;
    let local_identity = unit(sx) && unit(sy) && ox.abs() < 1e-3 && oy.abs() < 1e-3;
    if local_identity && unit(n1) && unit(n2) {
        return Some(Refit::Same);
    }
    // A column with no length (a box with no extent) keeps the old
    // direction.
    let col = |a: f64, b: f64, n: f64, fa: f64, fb: f64| {
        if n < 1e-9 {
            let fl = (fa * fa + fb * fb).sqrt().max(1e-12);
            (fa / fl, fb / fl)
        } else {
            (a / n, b / n)
        }
    };
    let c1 = col(m[0], m[1], n1, transform[0], transform[1]);
    let c2 = col(m[2], m[3], n2, transform[2], transform[3]);
    let new_t = [c1.0, c1.1, c2.0, c2.1, m[4], m[5]];
    let subpaths = part_of(
        &preset_evaluated(name, adjust, w2, h2)?.outline.subpaths,
        part,
    );
    if subpaths.len() != part_of(&old, part).len() {
        // A contour came or went with the new size: the element's open
        // flags no longer line up with its contours.
        return Some(Refit::Reshaped);
    }
    Some(Refit::Regenerated(Regenerated {
        part,
        transform: new_t,
        w: w2,
        h: h2,
        subpaths,
        scale: (n1, n2),
    }))
}

// ─── adjust handles ─────────────────────────────────────────────────

/// Golden-section search for the minimum of `f` on `[lo, hi]`.
fn golden(f: &dyn Fn(f64) -> f64, mut lo: f64, mut hi: f64, iters: usize) -> f64 {
    let r = (5f64.sqrt() - 1.0) / 2.0;
    let mut c = hi - r * (hi - lo);
    let mut d = lo + r * (hi - lo);
    let (mut fc, mut fd) = (f(c), f(d));
    for _ in 0..iters {
        if fc < fd {
            hi = d;
            d = c;
            fd = fc;
            c = hi - r * (hi - lo);
            fc = f(c);
        } else {
            lo = c;
            c = d;
            fc = fd;
            d = lo + r * (hi - lo);
            fd = f(d);
        }
    }
    (lo + hi) / 2.0
}

/// EMU per point.
const EMU: f64 = 12_700.0;

/// The widest range searched by sampling; a handle with a wider one
/// (PowerPoint's ±2³¹ for a callout's leader) is solved by Newton steps.
const SAMPLED_RANGE: f64 = 4_000_000.0;

/// The adjust values that put handle `index` of preset `name` (drawn for
/// a `w` × `h` box with `adjust`) at `target` (box coordinates), each kept
/// in the handle's range: every adjust value of the preset as `val N`
/// (integers, as `a:avLst` holds them). `None` for an unknown preset or
/// handle.
pub fn drag_handle(
    name: &str,
    adjust: &[(String, String)],
    w: f64,
    h: f64,
    index: usize,
    target: (f64, f64),
) -> Option<Vec<(String, String)>> {
    let geom = preset_geometry(name)?;
    let handle = geom.handles.get(index)?;
    // Current values of every adjust value.
    let g0 = guides_of(geom, adjust, w, h);
    let mut values: Vec<(String, f64)> = geom
        .adjust
        .iter()
        .map(|(n, _)| (n.clone(), g0.arg(n)))
        .collect();
    let as_adjust = |vals: &[(String, f64)]| -> Vec<(String, String)> {
        vals.iter()
            .map(|(n, v)| (n.clone(), format!("val {}", v.round() as i64)))
            .collect()
    };
    let pos_of = |vals: &[(String, f64)]| -> (f64, f64) {
        let g = guides_of(geom, &as_adjust_exact(vals), w, h);
        let (x, y) = handle.pos();
        (g.arg(x), g.arg(y))
    };
    let dist = |vals: &[(String, f64)]| -> f64 {
        let p = pos_of(vals);
        (p.0 - target.0).powi(2) + (p.1 - target.1).powi(2)
    };
    let refs: Vec<_> = handle.refs().into_iter().cloned().collect();
    // One pass settles a handle that moves one value; two values that
    // depend on each other settle in a few.
    let rounds = if refs.len() > 1 { 4 } else { 1 };
    for _round in 0..rounds {
        for r in &refs {
            let Some(slot) = values.iter().position(|(n, _)| *n == r.guide) else {
                continue;
            };
            // Ranges as PowerPoint reads them: with the box in EMU, so a
            // range given as a length (`ssd2`) is that many EMU, while one
            // given in adjust units (`maxAdj`) is the same at any scale.
            let g = guides_of(geom, &as_adjust_exact(&values), w * EMU, h * EMU);
            let (a, b) = (g.arg(&r.min), g.arg(&r.max));
            let (lo, hi) = (a.min(b), a.max(b));
            let with = |v: f64| {
                let mut vals = values.clone();
                vals[slot].1 = v;
                dist(&vals)
            };
            let best = if hi - lo <= SAMPLED_RANGE {
                // Sample, then refine around the best sample.
                let n = 200;
                let step = (hi - lo) / n as f64;
                let (mut bi, mut bv) = (0, f64::MAX);
                for i in 0..=n {
                    let d = with(lo + step * i as f64);
                    if d < bv {
                        bv = d;
                        bi = i;
                    }
                }
                let c = lo + step * bi as f64;
                golden(&with, (c - step).max(lo), (c + step).min(hi), 48)
            } else {
                // Newton steps on the squared distance (the handle is
                // linear in the value on such ranges).
                let mut v = values[slot].1.clamp(lo, hi);
                for _ in 0..8 {
                    let d = 1000.0;
                    let (f0, fp, fm) = (with(v), with(v + d), with(v - d));
                    let curv = (fp - 2.0 * f0 + fm) / (d * d);
                    if curv <= 1e-18 {
                        break;
                    }
                    let next = (v - (fp - fm) / (2.0 * d) / curv).clamp(lo, hi);
                    if (next - v).abs() < 0.5 {
                        v = next;
                        break;
                    }
                    v = next;
                }
                v
            };
            values[slot].1 = best.clamp(lo, hi);
        }
    }
    Some(as_adjust(&values))
}

/// Adjust values as formulas without rounding (the search works on reals;
/// only its answer is rounded).
fn as_adjust_exact(vals: &[(String, f64)]) -> Vec<(String, String)> {
    vals.iter()
        .map(|(n, v)| (n.clone(), format!("val {v}")))
        .collect()
}

/// The handles of preset `name` for a `w` × `h` box with `adjust`.
pub fn handles(
    name: &str,
    adjust: &[(String, String)],
    w: f64,
    h: f64,
) -> Option<Vec<crate::Handle>> {
    Some(preset_evaluated(name, adjust, w, h)?.handles)
}

/// The adjust handles a preset declares (whether it has any).
pub fn handle_count(name: &str) -> usize {
    preset_geometry(name).map_or(0, |g| g.handles.len())
}

/// Whether handle `index` of `name` is polar.
pub fn handle_is_polar(name: &str, index: usize) -> bool {
    preset_geometry(name)
        .and_then(|g| g.handles.get(index))
        .is_some_and(|h| matches!(h, AdjustHandle::Polar { .. }))
}

// ─── connection sites and connectors ────────────────────────────────

/// The connection sites of preset `name` (or a rectangle's, for a name
/// that is no preset) on a `w` × `h` box placed by `transform`: page
/// positions and the page direction each leaves in.
pub fn sites_on_page(
    name: &str,
    adjust: &[(String, String)],
    w: f64,
    h: f64,
    transform: &Affine,
) -> Vec<Site> {
    let local = preset_evaluated(name, adjust, w, h)
        .or_else(|| preset_evaluated("rect", &[], w, h))
        .map(|e| e.sites)
        .unwrap_or_default();
    local
        .into_iter()
        .map(|s| {
            let (dx, dy) = (s.angle.to_radians().cos(), s.angle.to_radians().sin());
            let v = (
                transform[0] * dx + transform[2] * dy,
                transform[1] * dx + transform[3] * dy,
            );
            let angle = v.1.atan2(v.0).to_degrees().rem_euclid(360.0);
            Site {
                pos: apply(transform, s.pos),
                angle,
            }
        })
        .collect()
}

/// A connector drawn between two sites.
#[derive(Debug, Clone, PartialEq)]
pub struct Routed {
    /// Box → page: the start site at the box's origin, the end at its far
    /// corner.
    pub transform: Affine,
    pub w: f64,
    pub h: f64,
    pub subpaths: Vec<SubPath>,
}

/// Whether a site faces up or down.
fn vertical(angle: f64) -> bool {
    let a = angle.rem_euclid(180.0);
    (a - 90.0).abs() < 45.0
}

/// Draw connector preset `name` (with `adjust`) from `start` to `end`. A
/// straight connector is the box's diagonal. An elbow or curved one leaves
/// its start along the box's first side: horizontally, or, from a site
/// that faces up or down, vertically (the box turned a quarter, as
/// PowerPoint turns it). `None` for an unknown preset.
pub fn route(name: &str, adjust: &[(String, String)], start: Site, end: Site) -> Option<Routed> {
    let (p1, p2) = (start.pos, end.pos);
    let (dx, dy) = (p2.0 - p1.0, p2.1 - p1.1);
    let sgn = |v: f64| if v < 0.0 { -1.0 } else { 1.0 };
    let turned = (name.starts_with("bentConnector") || name.starts_with("curvedConnector"))
        && vertical(start.angle);
    let (transform, w, h) = if turned {
        // Local x runs along page y, local y along page x.
        ([0.0, sgn(dy), sgn(dx), 0.0, p1.0, p1.1], dy.abs(), dx.abs())
    } else {
        ([sgn(dx), 0.0, 0.0, sgn(dy), p1.0, p1.1], dx.abs(), dy.abs())
    };
    let subpaths = preset_evaluated(name, adjust, w, h)?.outline.subpaths;
    Some(Routed {
        transform,
        w,
        h,
        subpaths,
    })
}
