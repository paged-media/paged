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

//! Smooth shading (PLRM 4.9.3): `shfill` and shading patterns. An axial
//! shading, and a radial one between concentric circles, become a
//! [`Gradient`] (its stops sampled from the function, an unextended end
//! a clip); a function-based shading and a radial one between offset
//! circles are sampled into an image. Types 4–7 (meshes) are reported
//! and skipped.

use std::rc::Rc;

use crate::art::{Color, Element, FillRule, Gradient, GradientKind, Image, Pixels};
use crate::color::{parse_space, to_device, ColorSpace};
use crate::function::{parse, Func};
use crate::geom::{arc_curves, Affine, Path, Point, Ps};
use crate::interp::{err, Interp, OpDef, PsError, R};
use crate::object::{Obj, PsDict};

pub const OPS: &[OpDef] = &[OpDef {
    name: "shfill",
    f: |i| {
        let d = i.pop_dict()?;
        shfill_dict(i, &d)
    },
}];

const STOPS: usize = 33;
const MAX_RASTER: usize = 400;

fn nums(d: &PsDict, k: &str) -> Option<Vec<f64>> {
    let a = d.get_name(k)?;
    a.as_array()?.items().iter().map(Obj::as_num).collect()
}

pub fn shfill_dict(i: &mut Interp<'_>, d: &PsDict) -> R {
    if i.suppress > 0 {
        return Ok(());
    }
    let ty = d
        .get_name("ShadingType")
        .and_then(|o| o.as_int())
        .ok_or(err("rangecheck"))?;
    let cs_obj = d.get_name("ColorSpace").ok_or(err("undefined"))?;
    let cs = Rc::new(parse_space(i, &cs_obj, 0)?);
    if !(1..=3).contains(&ty) {
        i.report.unsupported(&format!("shading type {ty}"));
        return Ok(());
    }
    let fobj = d.get_name("Function").ok_or(err("undefined"))?;
    let func = parse(i, &fobj, cs.ncomp(), 0)?;
    let extend = d
        .get_name("Extend")
        .and_then(|o| o.as_array().cloned())
        .map(|a| {
            (
                a.get(0).and_then(|o| o.as_bool()).unwrap_or(false),
                a.get(1).and_then(|o| o.as_bool()).unwrap_or(false),
            )
        })
        .unwrap_or((false, false));
    i.sync_clips()?;
    let mut pushed = 0;
    if let Some(b) = nums(d, "BBox").filter(|b| b.len() == 4) {
        let m = i.gs.ctm;
        i.emit(Element::PushClip {
            path: crate::graphics::rect(b[0], b[1], b[2] - b[0], b[3] - b[1], &m).bez,
            rule: FillRule::NonZero,
        })?;
        pushed += 1;
    }
    let r = match ty {
        1 => function_based(i, d, &cs, &func),
        2 => axial(i, d, &cs, &func, extend, &mut pushed),
        _ => radial(i, d, &cs, &func, extend, &mut pushed),
    };
    for _ in 0..pushed {
        i.emit(Element::PopClip)?;
    }
    r
}

fn color_at(i: &mut Interp<'_>, cs: &ColorSpace, f: &Func, x: &[f64]) -> Result<Color, PsError> {
    let comps = f.eval(i, x)?;
    Ok(to_device(i, cs, &comps, 0)?.map_or(Color::Gray(1.0), |(c, _)| c))
}

fn stops(
    i: &mut Interp<'_>,
    cs: &ColorSpace,
    f: &Func,
    domain: (f64, f64),
) -> Result<Vec<(f32, Color)>, PsError> {
    let mut out = Vec::with_capacity(STOPS);
    for k in 0..STOPS {
        let s = k as f64 / (STOPS - 1) as f64;
        let t = domain.0 + s * (domain.1 - domain.0);
        out.push((s as f32, color_at(i, cs, f, &[t])?));
    }
    Ok(out)
}

fn domain(d: &PsDict) -> (f64, f64) {
    nums(d, "Domain")
        .filter(|v| v.len() >= 2)
        .map_or((0.0, 1.0), |v| (v[0], v[1]))
}

/// The device area to cover: the clip's box.
fn area(i: &Interp<'_>) -> [f64; 4] {
    i.clip_box()
}

/// Half the diagonal of `area` in shading space (through `inv`), a
/// length that reaches past any point of it.
fn reach(area: &[f64; 4], inv: &Affine) -> f64 {
    let mut p = Path::default();
    for (x, y) in [
        (area[0], area[1]),
        (area[2], area[1]),
        (area[2], area[3]),
        (area[0], area[3]),
    ] {
        p.line_to(inv.apply(x, y));
    }
    let b = p.bbox().unwrap_or([0.0; 4]);
    (b[2] - b[0]).hypot(b[3] - b[1]) + 1.0
}

fn axial(
    i: &mut Interp<'_>,
    d: &PsDict,
    cs: &ColorSpace,
    f: &Func,
    extend: (bool, bool),
    pushed: &mut usize,
) -> R {
    let c = nums(d, "Coords")
        .filter(|c| c.len() == 4)
        .ok_or(err("rangecheck"))?;
    let m = i.gs.ctm;
    let Some(inv) = m.invert() else { return Ok(()) };
    let stops = stops(i, cs, f, domain(d))?;
    let a = area(i);
    let (dx, dy) = (c[2] - c[0], c[3] - c[1]);
    let len = dx.hypot(dy);
    if len == 0.0 {
        return Ok(());
    }
    if !(extend.0 && extend.1) {
        // The band between the end lines, reaching past the area.
        let l = reach(&a, &inv);
        let (ux, uy) = (dx / len, dy / len);
        let (nx, ny) = (-uy, ux);
        let t0 = if extend.0 { -l } else { 0.0 };
        let t1 = if extend.1 { len + l } else { len };
        let at = |t: f64, s: f64| m.apply(c[0] + ux * t + nx * s, c[1] + uy * t + ny * s);
        let mut band = Path::default();
        band.move_to(at(t0, -l));
        band.line_to(at(t1, -l));
        band.line_to(at(t1, l));
        band.line_to(at(t0, l));
        band.close();
        i.emit(Element::PushClip {
            path: band.bez,
            rule: FillRule::NonZero,
        })?;
        *pushed += 1;
    }
    i.emit(Element::Gradient(Gradient {
        kind: GradientKind::Axial {
            x0: c[0],
            y0: c[1],
            x1: c[2],
            y1: c[3],
        },
        stops,
        transform: m,
        area: a,
    }))
}

pub fn circle(cx: f64, cy: f64, r: f64, m: &Affine) -> Path {
    let (s, curves) = arc_curves(cx, cy, r, 0.0, 360.0, true);
    let mut p = Path::default();
    p.move_to(m.apply(s.x, s.y));
    crate::graphics::append_curves(&mut p, &curves, m);
    p.close();
    p
}

fn radial(
    i: &mut Interp<'_>,
    d: &PsDict,
    cs: &ColorSpace,
    f: &Func,
    extend: (bool, bool),
    pushed: &mut usize,
) -> R {
    let c = nums(d, "Coords")
        .filter(|c| c.len() == 6)
        .ok_or(err("rangecheck"))?;
    let (x0, y0, r0, x1, y1, r1) = (c[0], c[1], c[2].max(0.0), c[3], c[4], c[5].max(0.0));
    let m = i.gs.ctm;
    let Some(inv) = m.invert() else { return Ok(()) };
    let dom = domain(d);
    if (x0 - x1).abs() > 1e-9 || (y0 - y1).abs() > 1e-9 {
        return radial_raster(i, &c, cs, f, dom, extend, &inv);
    }
    let a = area(i);
    let big = r0.max(r1);
    if big <= 0.0 {
        return Ok(());
    }
    // Outside the larger circle is the extension of whichever end it
    // belongs to; inside the smaller, of the other.
    let (outer_ext, inner_ext) = if r1 >= r0 {
        (extend.1, extend.0)
    } else {
        (extend.0, extend.1)
    };
    let small = r0.min(r1);
    if !outer_ext || (!inner_ext && small > 0.0) {
        let mut clip = if outer_ext {
            let l = reach(&a, &inv);
            crate::graphics::rect(x0 - l, y0 - l, 2.0 * l, 2.0 * l, &m)
        } else {
            circle(x0, y0, big, &m)
        };
        if !inner_ext && small > 0.0 {
            clip.append(&circle(x0, y0, small, &m).bez);
        }
        i.emit(Element::PushClip {
            path: clip.bez,
            rule: FillRule::EvenOdd,
        })?;
        *pushed += 1;
    }
    let mut st = stops(i, cs, f, dom)?;
    for (t, _) in st.iter_mut() {
        let r = r0 + *t as f64 * (r1 - r0);
        *t = (r / big) as f32;
    }
    if r0 > r1 {
        st.reverse();
    }
    i.emit(Element::Gradient(Gradient {
        kind: GradientKind::Radial {
            cx: x0,
            cy: y0,
            r0: 0.0,
            r1: big,
        },
        stops: st,
        transform: m,
        area: a,
    }))
}

/// The raster grid over the device box `b`: its size, at most
/// [`MAX_RASTER`] on the longer side and one sample per unit below that.
fn grid(b: &[f64; 4]) -> (usize, usize) {
    let (w, h) = ((b[2] - b[0]).max(1.0), (b[3] - b[1]).max(1.0));
    let s = (MAX_RASTER as f64 / w.max(h)).min(1.0);
    (
        ((w * s).ceil() as usize).max(1),
        ((h * s).ceil() as usize).max(1),
    )
}

fn push_raster(
    i: &mut Interp<'_>,
    b: [f64; 4],
    (w, h): (usize, usize),
    mut sample: impl FnMut(&mut Interp<'_>, Point) -> Result<Option<Color>, PsError>,
) -> R {
    let mut rgb = Vec::with_capacity(w * h * 3);
    let mut cmyk: Option<Vec<u8>> = None;
    let mut alpha = Vec::with_capacity(w * h);
    let mut any_hole = false;
    i.alloc(w * h * 8)?;
    for row in 0..h {
        for col in 0..w {
            // Row 0 is the top of the box (the image's first row).
            let p = Point::new(
                b[0] + (col as f64 + 0.5) / w as f64 * (b[2] - b[0]),
                b[3] - (row as f64 + 0.5) / h as f64 * (b[3] - b[1]),
            );
            match sample(i, p)? {
                Some(c) => {
                    if let Color::Cmyk(v) = c {
                        let buf = cmyk.get_or_insert_with(|| Vec::with_capacity(w * h * 4));
                        buf.resize(alpha.len() * 4, 0);
                        buf.extend(v.iter().map(|x| (x * 255.0).round() as u8));
                    }
                    rgb.extend(c.to_srgb().iter().map(|x| (x * 255.0).round() as u8));
                    alpha.push(255);
                }
                None => {
                    rgb.extend([0, 0, 0]);
                    if let Some(buf) = cmyk.as_mut() {
                        buf.extend([0, 0, 0, 0]);
                    }
                    alpha.push(0);
                    any_hole = true;
                }
            }
        }
    }
    let pixels = match cmyk {
        Some(mut c) if c.len() <= w * h * 4 => {
            c.resize(w * h * 4, 0);
            Pixels::Cmyk(c)
        }
        _ => Pixels::Rgb(rgb),
    };
    i.emit(Element::Image(Image {
        width: w as u32,
        height: h as u32,
        pixels,
        alpha: any_hole.then_some(alpha),
        transform: Affine::new([b[2] - b[0], 0.0, 0.0, -(b[3] - b[1]), b[0], b[3]]),
    }))
}

fn function_based(i: &mut Interp<'_>, d: &PsDict, cs: &ColorSpace, f: &Func) -> R {
    let dom = nums(d, "Domain")
        .filter(|v| v.len() == 4)
        .unwrap_or_else(|| vec![0.0, 1.0, 0.0, 1.0]);
    let sm = nums(d, "Matrix")
        .filter(|v| v.len() == 6)
        .map(|v| Affine::new([v[0], v[1], v[2], v[3], v[4], v[5]]))
        .unwrap_or(Affine::IDENTITY);
    let to_dev = sm.then(&i.gs.ctm);
    let Some(inv) = to_dev.invert() else {
        return Ok(());
    };
    let mut corners = Path::default();
    for (x, y) in [
        (dom[0], dom[2]),
        (dom[1], dom[2]),
        (dom[1], dom[3]),
        (dom[0], dom[3]),
    ] {
        corners.line_to(to_dev.apply(x, y));
    }
    let Some(b) = corners.bbox() else {
        return Ok(());
    };
    let c = i.clip_box();
    let b = [
        b[0].max(c[0]),
        b[1].max(c[1]),
        b[2].min(c[2]),
        b[3].min(c[3]),
    ];
    if b[2] <= b[0] || b[3] <= b[1] {
        return Ok(());
    }
    let g = grid(&b);
    push_raster(i, b, g, |i, p| {
        let q = inv.apply(p.x, p.y);
        if q.x < dom[0].min(dom[1])
            || q.x > dom[0].max(dom[1])
            || q.y < dom[2].min(dom[3])
            || q.y > dom[2].max(dom[3])
        {
            return Ok(None);
        }
        color_at(i, cs, f, &[q.x, q.y]).map(Some)
    })
}

/// The parameter s of the largest circle of the two-circle family
/// through `p` (PLRM 4.9.3, type 3), honouring the extends.
pub fn radial_s(c: &[f64], p: Point, extend: (bool, bool)) -> Option<f64> {
    let (x0, y0, r0, x1, y1, r1) = (c[0], c[1], c[2], c[3], c[4], c[5]);
    let (cdx, cdy, dr) = (x1 - x0, y1 - y0, r1 - r0);
    let (pdx, pdy) = (p.x - x0, p.y - y0);
    let a = cdx * cdx + cdy * cdy - dr * dr;
    let b = pdx * cdx + pdy * cdy + r0 * dr;
    let cc = pdx * pdx + pdy * pdy - r0 * r0;
    let mut roots = Vec::with_capacity(2);
    if a.abs() < 1e-12 {
        if b.abs() > 1e-12 {
            roots.push(cc / (2.0 * b));
        }
    } else {
        let disc = b * b - a * cc;
        if disc < 0.0 {
            return None;
        }
        let sq = disc.sqrt();
        roots.push((b + sq) / a);
        roots.push((b - sq) / a);
        roots.sort_by(|x, y| y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal));
    }
    roots.into_iter().find_map(|s| {
        if r0 + s * dr < 0.0 {
            return None;
        }
        if s < 0.0 {
            return extend.0.then_some(0.0);
        }
        if s > 1.0 {
            return extend.1.then_some(1.0);
        }
        Some(s)
    })
}

fn radial_raster(
    i: &mut Interp<'_>,
    c: &[f64],
    cs: &ColorSpace,
    f: &Func,
    dom: (f64, f64),
    extend: (bool, bool),
    inv: &Affine,
) -> R {
    let b = area(i);
    if b[2] <= b[0] || b[3] <= b[1] {
        return Ok(());
    }
    let g = grid(&b);
    // Colours along s, sampled once.
    let mut lut = Vec::with_capacity(256);
    for k in 0..256 {
        let s = k as f64 / 255.0;
        lut.push(color_at(i, cs, f, &[dom.0 + s * (dom.1 - dom.0)])?);
    }
    let inv = *inv;
    let c = c.to_vec();
    push_raster(i, b, g, move |_, p| {
        let q = inv.apply(p.x, p.y);
        Ok(radial_s(&c, q, extend).map(|s| lut[(s * 255.0).round().clamp(0.0, 255.0) as usize]))
    })
}
