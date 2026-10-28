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

//! The graphics state and its operators (PLRM 4.2–4.5, 8.1): CTM,
//! line parameters, path construction, painting, clipping, forms and
//! tiling patterns, plus the device operators an EPS may call.
//!
//! Clipping is lazy: the state carries its clip as a chain of paths, and
//! the clips in the output are brought in line with it only when
//! something is painted, so a `gsave … clip … grestore` that draws
//! nothing writes nothing.

use std::rc::Rc;

use crate::art::{Element, FillRule, LineCap, LineJoin, Paint, StrokeStyle};
use crate::color::{ColorSpace, PaintKind};
use crate::geom::{arc_curves, Affine, Path, PathEl, Point, Ps};
use crate::interp::{err, matrix_obj, Interp, Loop, OpDef, PsError, R};
use crate::object::{Obj, PsDict, V};

pub struct ClipEntry {
    pub id: u64,
    pub path: Path,
    pub rule: FillRule,
}

#[derive(Clone)]
pub struct GState {
    pub ctm: Affine,
    pub path: Path,
    pub clip: Vec<Rc<ClipEntry>>,
    pub cs: Rc<ColorSpace>,
    pub cs_obj: Obj,
    pub color: Vec<f64>,
    pub pattern: Option<PsDict>,
    pub line_width: f64,
    pub cap: LineCap,
    pub join: LineJoin,
    pub miter: f64,
    pub dash: Vec<f64>,
    pub dash_offset: f64,
    pub flat: f64,
    pub font: Option<PsDict>,
    pub stroke_adjust: bool,
    pub overprint: bool,
    pub smoothness: f64,
    /// Colour operators are ignored: inside an uncoloured pattern's
    /// PaintProc, or a Type 3 glyph that called `setcachedevice`.
    pub uncolored: bool,
}

impl Default for GState {
    fn default() -> Self {
        GState {
            ctm: Affine::IDENTITY,
            path: Path::default(),
            clip: Vec::new(),
            cs: Rc::new(ColorSpace::Gray),
            cs_obj: Obj::name("DeviceGray"),
            color: vec![0.0],
            pattern: None,
            line_width: 1.0,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
            miter: 10.0,
            dash: Vec::new(),
            dash_offset: 0.0,
            flat: 1.0,
            font: None,
            stroke_adjust: false,
            overprint: false,
            smoothness: 0.02,
            uncolored: false,
        }
    }
}

macro_rules! ops {
    ($($name:literal => $f:expr),* $(,)?) => {
        &[$(OpDef { name: $name, f: $f }),*]
    };
}

pub const OPS: &[OpDef] = ops! {
    "gsave" => |i| { let g = i.gs.clone(); i.gstack.push((g, None)); Ok(()) },
    "grestore" => |i| { if let Some((g, mark)) = i.gstack.last() { let g = g.clone(); if mark.is_none() { i.gstack.pop(); } i.gs = g; } Ok(()) },
    "grestoreall" => |i| { while let Some((g, mark)) = i.gstack.last() { let g = g.clone(); i.gs = g; if mark.is_some() { break; } i.gstack.pop(); } Ok(()) },
    "initgraphics" => |i| { let font = i.gs.font.clone(); i.gs = GState { font, ..GState::default() }; Ok(()) },
    "gstate" => |i| { let g = i.gs.clone(); i.alloc(256)?; i.push(Obj::lit(V::GState(Rc::new(std::cell::RefCell::new(g))))) },
    "currentgstate" => |i| { let o = i.pop()?; let V::GState(g) = &o.v else { return Err(err("typecheck")) }; *g.borrow_mut() = i.gs.clone(); i.push(o) },
    "setgstate" => |i| { let o = i.pop()?; let V::GState(g) = &o.v else { return Err(err("typecheck")) }; i.gs = g.borrow().clone(); Ok(()) },
    // line parameters
    "setlinewidth" => |i| { i.gs.line_width = i.pop_num()?.abs(); Ok(()) },
    "currentlinewidth" => |i| { let w = i.gs.line_width; i.push(Obj::real(w)) },
    "setlinecap" => |i| { i.gs.cap = match i.pop_int()? { 0 => LineCap::Butt, 1 => LineCap::Round, 2 => LineCap::Square, _ => return Err(err("rangecheck")) }; Ok(()) },
    "currentlinecap" => |i| { let c = i.gs.cap as i32; i.push(Obj::int(c)) },
    "setlinejoin" => |i| { i.gs.join = match i.pop_int()? { 0 => LineJoin::Miter, 1 => LineJoin::Round, 2 => LineJoin::Bevel, _ => return Err(err("rangecheck")) }; Ok(()) },
    "currentlinejoin" => |i| { let j = i.gs.join as i32; i.push(Obj::int(j)) },
    "setmiterlimit" => |i| { let m = i.pop_num()?; if m < 1.0 { return Err(err("rangecheck")); } i.gs.miter = m; Ok(()) },
    "currentmiterlimit" => |i| { let m = i.gs.miter; i.push(Obj::real(m)) },
    "setdash" => setdash,
    "currentdash" => |i| { let d = Obj::array(i.gs.dash.iter().map(|v| Obj::real(*v)).collect()); let o = i.gs.dash_offset; i.push(d)?; i.push(Obj::real(o)) },
    "setflat" => |i| { i.gs.flat = i.pop_num()?.clamp(0.2, 100.0); Ok(()) },
    "currentflat" => |i| { let f = i.gs.flat; i.push(Obj::real(f)) },
    "setstrokeadjust" => |i| { i.gs.stroke_adjust = i.pop_bool()?; Ok(()) },
    "currentstrokeadjust" => |i| { let s = i.gs.stroke_adjust; i.push(Obj::bool(s)) },
    "setoverprint" => |i| { i.gs.overprint = i.pop_bool()?; Ok(()) },
    "currentoverprint" => |i| { let o = i.gs.overprint; i.push(Obj::bool(o)) },
    "setsmoothness" => |i| { i.gs.smoothness = i.pop_num()?; Ok(()) },
    "currentsmoothness" => |i| { let s = i.gs.smoothness; i.push(Obj::real(s)) },
    // matrices
    "matrix" => |i| i.push(matrix_obj(&Affine::IDENTITY)),
    "initmatrix" => |i| { i.gs.ctm = Affine::IDENTITY; Ok(()) },
    "identmatrix" => |i| { let a = i.pop_array()?; store_matrix(&a, &Affine::IDENTITY)?; i.push(Obj::lit(V::Array(a))) },
    "defaultmatrix" => |i| { let a = i.pop_array()?; store_matrix(&a, &Affine::IDENTITY)?; i.push(Obj::lit(V::Array(a))) },
    "currentmatrix" => |i| { let a = i.pop_array()?; let m = i.gs.ctm; store_matrix(&a, &m)?; i.push(Obj::lit(V::Array(a))) },
    "setmatrix" => |i| { let m = i.pop_matrix()?; i.gs.ctm = m; Ok(()) },
    "translate" => |i| transform_op(i, 2, |v| Affine::translate((v[0], v[1]))),
    "scale" => |i| transform_op(i, 2, |v| Affine::scale_non_uniform(v[0], v[1])),
    "rotate" => |i| transform_op(i, 1, |v| crate::geom::rotate_deg(v[0])),
    "concat" => |i| { let m = i.pop_matrix()?; i.gs.ctm = m.then(&i.gs.ctm); Ok(()) },
    "concatmatrix" => |i| { let a = i.pop_array()?; let m2 = i.pop_matrix()?; let m1 = i.pop_matrix()?; store_matrix(&a, &m1.then(&m2))?; i.push(Obj::lit(V::Array(a))) },
    "invertmatrix" => |i| { let a = i.pop_array()?; let m = i.pop_matrix()?; let inv = m.invert().ok_or(err("undefinedresult"))?; store_matrix(&a, &inv)?; i.push(Obj::lit(V::Array(a))) },
    "transform" => |i| point_op(i, |m, x, y| Some(m.apply(x, y))),
    "itransform" => |i| point_op(i, |m, x, y| m.invert().map(|n| n.apply(x, y))),
    "dtransform" => |i| point_op(i, |m, x, y| Some(m.apply_delta(x, y))),
    "idtransform" => |i| point_op(i, |m, x, y| m.invert().map(|n| n.apply_delta(x, y))),
    // paths
    "newpath" => |i| { i.gs.path = Path::default(); Ok(()) },
    "currentpoint" => |i| { let p = i.gs.path.cur.ok_or(err("nocurrentpoint"))?; let inv = i.gs.ctm.invert().ok_or(err("undefinedresult"))?; let u = inv.apply(p.x, p.y); i.push(Obj::real(u.x))?; i.push(Obj::real(u.y)) },
    "moveto" => |i| { let y = i.pop_num()?; let x = i.pop_num()?; let p = i.gs.ctm.apply(x, y); i.gs.path.move_to(p); path_budget(i) },
    "rmoveto" => |i| { let dy = i.pop_num()?; let dx = i.pop_num()?; let c = i.gs.path.cur.ok_or(err("nocurrentpoint"))?; let d = i.gs.ctm.apply_delta(dx, dy); i.gs.path.move_to(Point::new(c.x + d.x, c.y + d.y)); Ok(()) },
    "lineto" => |i| { let y = i.pop_num()?; let x = i.pop_num()?; if i.gs.path.cur.is_none() { return Err(err("nocurrentpoint")); } let p = i.gs.ctm.apply(x, y); i.gs.path.line_to(p); path_budget(i) },
    "rlineto" => |i| { let dy = i.pop_num()?; let dx = i.pop_num()?; let c = i.gs.path.cur.ok_or(err("nocurrentpoint"))?; let d = i.gs.ctm.apply_delta(dx, dy); i.gs.path.line_to(Point::new(c.x + d.x, c.y + d.y)); path_budget(i) },
    "curveto" => |i| { let v = pop_nums(i, 6)?; if i.gs.path.cur.is_none() { return Err(err("nocurrentpoint")); } let m = i.gs.ctm; i.gs.path.curve_to(m.apply(v[0], v[1]), m.apply(v[2], v[3]), m.apply(v[4], v[5])); path_budget(i) },
    "rcurveto" => |i| { let v = pop_nums(i, 6)?; let c = i.gs.path.cur.ok_or(err("nocurrentpoint"))?; let m = i.gs.ctm; let d = |x: f64, y: f64| { let p = m.apply_delta(x, y); Point::new(c.x + p.x, c.y + p.y) }; i.gs.path.curve_to(d(v[0], v[1]), d(v[2], v[3]), d(v[4], v[5])); path_budget(i) },
    "arc" => |i| arc(i, true),
    "arcn" => |i| arc(i, false),
    "arct" => |i| arct(i, false),
    "arcto" => |i| arct(i, true),
    "closepath" => |i| { i.gs.path.close(); Ok(()) },
    "flattenpath" => |i| { let f = i.gs.flat; i.gs.path = i.gs.path.flattened(f); Ok(()) },
    "reversepath" => |i| { i.gs.path = i.gs.path.reversed(); Ok(()) },
    "strokepath" => strokepath,
    "pathbbox" => pathbbox,
    "pathforall" => pathforall,
    "clippath" => |i| { i.gs.path = match i.gs.clip.last() { Some(c) => c.path.clone(), None => page_path(i) }; Ok(()) },
    "initclip" => |i| { i.gs.clip.clear(); Ok(()) },
    "clip" => |i| clip(i, FillRule::NonZero),
    "eoclip" => |i| clip(i, FillRule::EvenOdd),
    "rectclip" => |i| { let p = rect_path(i)?; i.gs.path = p; clip(i, FillRule::NonZero)?; i.gs.path = Path::default(); Ok(()) },
    "fill" => |i| { let p = std::mem::take(&mut i.gs.path); fill_path(i, p, FillRule::NonZero) },
    "eofill" => |i| { let p = std::mem::take(&mut i.gs.path); fill_path(i, p, FillRule::EvenOdd) },
    "stroke" => |i| { let p = std::mem::take(&mut i.gs.path); stroke_path(i, p) },
    "rectfill" => |i| { let p = rect_path(i)?; fill_path(i, p, FillRule::NonZero) },
    "rectstroke" => rectstroke,
    "ucache" => |_| Ok(()),
    "execform" => execform,
    "makepattern" => makepattern,
};

pub const DEVICE_OPS: &[OpDef] = ops! {
    "showpage" => |_| Ok(()),
    "copypage" => |_| Ok(()),
    "erasepage" => |_| Ok(()),
    "nulldevice" => |_| Ok(()),
    "setpagedevice" => |i| i.pop().map(drop),
    "currentpagedevice" => |i| { let d = PsDict::new(8); let p = i.page; d.put_name("PageSize", Obj::array(vec![Obj::real(p[2] - p[0]), Obj::real(p[3] - p[1])])); d.put_name("HWResolution", Obj::array(vec![Obj::int(72), Obj::int(72)])); i.push(Obj::dict(d)) },
    "setscreen" => |i| { for _ in 0..3 { i.pop()?; } Ok(()) },
    "currentscreen" => |i| { i.push(Obj::real(60.0))?; i.push(Obj::real(45.0))?; i.push(Obj::proc(vec![Obj::xname("pop"), Obj::xname("pop"), Obj::int(0)])) },
    "setcolorscreen" => |i| { for _ in 0..12 { i.pop()?; } Ok(()) },
    "currentcolorscreen" => |i| { for _ in 0..4 { i.push(Obj::real(60.0))?; i.push(Obj::real(45.0))?; i.push(Obj::proc(vec![Obj::xname("pop"), Obj::xname("pop"), Obj::int(0)]))?; } Ok(()) },
    "settransfer" => |i| i.pop().map(drop),
    "currenttransfer" => |i| i.push(Obj::proc(vec![])),
    "setcolortransfer" => |i| { for _ in 0..4 { i.pop()?; } Ok(()) },
    "currentcolortransfer" => |i| { for _ in 0..4 { i.push(Obj::proc(vec![]))?; } Ok(()) },
    "setblackgeneration" => |i| i.pop().map(drop),
    "currentblackgeneration" => |i| i.push(Obj::proc(vec![])),
    "setundercolorremoval" => |i| i.pop().map(drop),
    "currentundercolorremoval" => |i| i.push(Obj::proc(vec![Obj::xname("pop"), Obj::int(0)])),
    "sethalftone" => |i| i.pop().map(drop),
    "currenthalftone" => |i| { let d = PsDict::new(4); d.put_name("HalftoneType", Obj::int(1)); i.push(Obj::dict(d)) },
    "setcolorrendering" => |i| i.pop().map(drop),
    "currentcolorrendering" => |i| i.push(Obj::dict(PsDict::new(1))),
    "findcolorrendering" => |i| { i.pop()?; i.push(Obj::name("DefaultColorRendering"))?; i.push(Obj::bool(false)) },
    "setbbox" => |i| { for _ in 0..4 { i.pop()?; } Ok(()) },
    "setcachedevice2" => |i| { let v = pop_nums(i, 10)?; i.glyph_width = Some((v[0], v[1])); i.gs.uncolored = true; Ok(()) },
};

/// Append an arc's cubic pieces (user space) through `m`.
pub fn append_curves(path: &mut Path, curves: &[PathEl], m: &Affine) {
    for el in curves {
        if let PathEl::CurveTo(a, b, c) = *el {
            path.curve_to(*m * a, *m * b, *m * c);
        }
    }
}

/// `strokepath`: the path replaced by the outline its stroke would
/// paint (kurbo's stroker, in user space, as the pen is).
fn strokepath(i: &mut Interp<'_>) -> R {
    let ctm = i.gs.ctm;
    let Some(inv) = ctm.invert() else {
        return Ok(());
    };
    let user = inv * i.gs.path.bez.clone();
    let style = stroke_style(i);
    let outline = kurbo::stroke(
        user,
        &kurbo_stroke(&style),
        &kurbo::StrokeOpts::default(),
        0.01,
    );
    let mut p = Path::default();
    p.append(&(ctm * outline));
    p.cur = i.gs.path.cur;
    i.gs.path = p;
    path_budget(i)
}

/// A stroke style as kurbo's.
pub fn kurbo_stroke(s: &StrokeStyle) -> kurbo::Stroke {
    let st = kurbo::Stroke::new(s.width.max(1e-6))
        .with_caps(match s.cap {
            LineCap::Butt => kurbo::Cap::Butt,
            LineCap::Round => kurbo::Cap::Round,
            LineCap::Square => kurbo::Cap::Square,
        })
        .with_join(match s.join {
            LineJoin::Miter => kurbo::Join::Miter,
            LineJoin::Round => kurbo::Join::Round,
            LineJoin::Bevel => kurbo::Join::Bevel,
        })
        .with_miter_limit(s.miter_limit);
    if s.dash.is_empty() {
        st
    } else {
        st.with_dashes(s.dash_offset, s.dash.iter().copied())
    }
}

fn path_budget(i: &mut Interp<'_>) -> R {
    if i.gs.path.len().is_multiple_of(1024) {
        i.alloc(1024 * 56)?;
    }
    Ok(())
}

pub fn pop_nums(i: &mut Interp<'_>, n: usize) -> Result<Vec<f64>, PsError> {
    i.need(n)?;
    let mut v = vec![0.0; n];
    for k in (0..n).rev() {
        v[k] = i.pop_num()?;
    }
    Ok(v)
}

fn store_matrix(a: &crate::object::PsArray, m: &Affine) -> R {
    if a.len != 6 {
        return Err(err("rangecheck"));
    }
    for (k, v) in m.as_coeffs().iter().enumerate() {
        a.set(k, Obj::real(*v));
    }
    Ok(())
}

/// `translate`, `scale`, `rotate`: on the CTM, or, given a matrix
/// operand, into it.
fn transform_op(i: &mut Interp<'_>, n: usize, make: fn(&[f64]) -> Affine) -> R {
    if let Ok(V::Array(_)) = i.top(0).map(|o| o.v.clone()) {
        let a = i.pop_array()?;
        let v = pop_nums(i, n)?;
        store_matrix(&a, &make(&v))?;
        return i.push(Obj::lit(V::Array(a)));
    }
    let v = pop_nums(i, n)?;
    i.gs.ctm = make(&v).then(&i.gs.ctm);
    Ok(())
}

fn point_op(i: &mut Interp<'_>, f: fn(&Affine, f64, f64) -> Option<Point>) -> R {
    let m = if let Ok(V::Array(_)) = i.top(0).map(|o| o.v.clone()) {
        i.pop_matrix()?
    } else {
        i.gs.ctm
    };
    let y = i.pop_num()?;
    let x = i.pop_num()?;
    let p = f(&m, x, y).ok_or(err("undefinedresult"))?;
    i.push(Obj::real(p.x))?;
    i.push(Obj::real(p.y))
}

fn setdash(i: &mut Interp<'_>) -> R {
    let off = i.pop_num()?;
    let a = i.pop_array()?;
    let mut dash = Vec::with_capacity(a.len);
    for o in a.items() {
        let v = o.as_num().ok_or(err("typecheck"))?;
        if v < 0.0 {
            return Err(err("rangecheck"));
        }
        dash.push(v);
    }
    // All zeros is a solid line here (some interpreters refuse it).
    if dash.iter().all(|v| *v == 0.0) {
        dash.clear();
    }
    i.gs.dash = dash;
    i.gs.dash_offset = off;
    Ok(())
}

fn arc(i: &mut Interp<'_>, ccw: bool) -> R {
    let v = pop_nums(i, 5)?;
    let (start, curves) = arc_curves(v[0], v[1], v[2], v[3], v[4], ccw);
    let m = i.gs.ctm;
    let s = m.apply(start.x, start.y);
    if i.gs.path.cur.is_some() {
        i.gs.path.line_to(s);
    } else {
        i.gs.path.move_to(s);
    }
    append_curves(&mut i.gs.path, &curves, &m);
    path_budget(i)
}

/// `arct` / `arcto` (PLRM 8.2): a line from the current point toward
/// (x1, y1), turning into an arc of radius r tangent to both that line
/// and the line from (x1, y1) to (x2, y2).
fn arct(i: &mut Interp<'_>, push: bool) -> R {
    let v = pop_nums(i, 5)?;
    let (x1, y1, x2, y2, r) = (v[0], v[1], v[2], v[3], v[4]);
    let cur = i.gs.path.cur.ok_or(err("nocurrentpoint"))?;
    let inv = i.gs.ctm.invert().ok_or(err("undefinedresult"))?;
    let p0 = inv.apply(cur.x, cur.y);
    let (ax, ay) = (p0.x - x1, p0.y - y1);
    let (bx, by) = (x2 - x1, y2 - y1);
    let (la, lb) = (ax.hypot(ay), bx.hypot(by));
    let m = i.gs.ctm;
    if la == 0.0 || lb == 0.0 || r == 0.0 {
        i.gs.path.line_to(m.apply(x1, y1));
        if push {
            for p in [x1, y1, x1, y1] {
                i.push(Obj::real(p))?;
            }
        }
        return Ok(());
    }
    let (ux, uy, wx, wy) = (ax / la, ay / la, bx / lb, by / lb);
    let cos = (ux * wx + uy * wy).clamp(-1.0, 1.0);
    let theta = cos.acos();
    if theta.abs() < 1e-9 || (std::f64::consts::PI - theta).abs() < 1e-9 {
        i.gs.path.line_to(m.apply(x1, y1));
        if push {
            for p in [x1, y1, x1, y1] {
                i.push(Obj::real(p))?;
            }
        }
        return Ok(());
    }
    let d = r / (theta / 2.0).tan();
    let t1 = Point::new(x1 + ux * d, y1 + uy * d);
    let t2 = Point::new(x1 + wx * d, y1 + wy * d);
    let (bisx, bisy) = (ux + wx, uy + wy);
    let bl = bisx.hypot(bisy);
    let h = r / (theta / 2.0).sin();
    let c = Point::new(x1 + bisx / bl * h, y1 + bisy / bl * h);
    let a1 = (t1.y - c.y).atan2(t1.x - c.x).to_degrees();
    let a2 = (t2.y - c.y).atan2(t2.x - c.x).to_degrees();
    // The turn from the first line into the second decides the arc's
    // direction: a left turn is counter-clockwise.
    let cross = (-ux) * wy - (-uy) * wx;
    let (_, curves) = arc_curves(c.x, c.y, r, a1, a2, cross > 0.0);
    i.gs.path.line_to(m.apply(t1.x, t1.y));
    append_curves(&mut i.gs.path, &curves, &m);
    if push {
        for p in [t1.x, t1.y, t2.x, t2.y] {
            i.push(Obj::real(p))?;
        }
    }
    path_budget(i)
}

fn pathbbox(i: &mut Interp<'_>) -> R {
    let b = i.gs.path.bbox().ok_or(err("nocurrentpoint"))?;
    let inv = i.gs.ctm.invert().ok_or(err("undefinedresult"))?;
    let mut p = Path::default();
    for (x, y) in [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])] {
        p.line_to(inv.apply(x, y));
    }
    let u = p.bbox().unwrap_or(b);
    for v in u {
        i.push(Obj::real(v))?;
    }
    Ok(())
}

fn pathforall(i: &mut Interp<'_>) -> R {
    let close = i.pop()?;
    let curve = i.pop()?;
    let line = i.pop()?;
    let mv = i.pop()?;
    let inv = i.gs.ctm.invert().ok_or(err("undefinedresult"))?;
    let u = |p: &Point| {
        let q = inv.apply(p.x, p.y);
        [q.x, q.y]
    };
    let mut items = Vec::new();
    let mut last = Point::ZERO;
    for s in i.gs.path.bez.elements() {
        items.push(match *s {
            PathEl::MoveTo(p) => (u(&p).to_vec(), 0),
            PathEl::LineTo(p) => (u(&p).to_vec(), 1),
            PathEl::QuadTo(q, p) => {
                // A quadratic (none are built here) as its cubic.
                let c = kurbo::QuadBez::new(last, q, p).raise();
                ([u(&c.p1), u(&c.p2), u(&c.p3)].concat(), 2)
            }
            PathEl::CurveTo(a, b, c) => ([u(&a), u(&b), u(&c)].concat(), 2),
            PathEl::ClosePath => (vec![], 3),
        });
        if let PathEl::MoveTo(p)
        | PathEl::LineTo(p)
        | PathEl::QuadTo(_, p)
        | PathEl::CurveTo(_, _, p) = *s
        {
            last = p;
        }
    }
    i.push_frame(crate::interp::Frame::Loop(Box::new(Loop::Path {
        items,
        i: 0,
        procs: [mv, line, curve, close],
    })))
}

/// The page (the EPS bounding box) as a device-space rectangle.
pub fn page_path(i: &Interp<'_>) -> Path {
    let [x0, y0, x1, y1] = i.page;
    rect(x0, y0, x1 - x0, y1 - y0, &Affine::IDENTITY)
}

pub fn rect(x: f64, y: f64, w: f64, h: f64, m: &Affine) -> Path {
    let mut p = Path::default();
    p.move_to(m.apply(x, y));
    p.line_to(m.apply(x + w, y));
    p.line_to(m.apply(x + w, y + h));
    p.line_to(m.apply(x, y + h));
    p.close();
    p
}

/// The rectangles of `rectfill`, `rectclip`, `rectstroke`: four numbers,
/// or an array (or encoded number string) of fours.
fn rect_path(i: &mut Interp<'_>) -> Result<Path, PsError> {
    let nums: Vec<f64> = match i.top(0)?.v.clone() {
        V::Array(a) => {
            i.pop()?;
            a.items().iter().filter_map(Obj::as_num).collect()
        }
        V::Str(_) => {
            i.pop()?;
            i.report.unsupported("encoded number string rectangles");
            Vec::new()
        }
        _ => pop_nums(i, 4)?,
    };
    let m = i.gs.ctm;
    let mut p = Path::default();
    for r in nums.as_chunks::<4>().0 {
        let q = rect(r[0], r[1], r[2], r[3], &m);
        p.append(&q.bez);
        p.cur = q.cur;
        p.start = q.start;
    }
    Ok(p)
}

fn rectstroke(i: &mut Interp<'_>) -> R {
    // `x y w h [matrix]` or `numarray [matrix]`.
    let top_is_matrix = matches!(i.top(0).map(|o| &o.v), Ok(V::Array(a)) if a.len == 6);
    let below_is_rect = matches!(i.top(1).map(|o| &o.v), Ok(V::Array(_) | V::Str(_)))
        || (1..5).all(|k| i.top(k).is_ok_and(|o| o.as_num().is_some()));
    let extra = if top_is_matrix && below_is_rect {
        Some(i.pop_matrix()?)
    } else {
        None
    };
    let p = rect_path(i)?;
    match extra {
        Some(m) => {
            let saved = i.gs.ctm;
            i.gs.ctm = m.then(&saved);
            let r = stroke_path(i, p);
            i.gs.ctm = saved;
            r
        }
        None => stroke_path(i, p),
    }
}

fn clip(i: &mut Interp<'_>, rule: FillRule) -> R {
    if i.gs.path.is_empty() {
        // Clipping to nothing hides everything that follows.
        let mut p = Path::default();
        p.move_to(Point::new(0.0, 0.0));
        p.close();
        let id = i.id();
        i.gs.clip.push(Rc::new(ClipEntry { id, path: p, rule }));
        return Ok(());
    }
    let id = i.id();
    let path = i.gs.path.clone();
    i.gs.clip.push(Rc::new(ClipEntry { id, path, rule }));
    Ok(())
}

impl Interp<'_> {
    /// Bring the output's clips in line with the state's.
    pub fn sync_clips(&mut self) -> R {
        let want: Vec<Rc<ClipEntry>> = self.gs.clip.clone();
        let mut common = 0;
        while common < want.len()
            && common < self.emitted_clips.len()
            && want[common].id == self.emitted_clips[common]
        {
            common += 1;
        }
        while self.emitted_clips.len() > common {
            self.emitted_clips.pop();
            self.emit(Element::PopClip)?;
        }
        for c in &want[common..] {
            self.emit(Element::PushClip {
                path: c.path.bez.clone(),
                rule: c.rule,
            })?;
            self.emitted_clips.push(c.id);
        }
        Ok(())
    }

    pub fn close_clips(&mut self) {
        while self.emitted_clips.pop().is_some() {
            self.out.push(Element::PopClip);
        }
    }

    /// The device box the current clip allows (the page when there is
    /// no clip).
    pub fn clip_box(&self) -> [f64; 4] {
        let mut b = self.page;
        for c in &self.gs.clip {
            if let Some(cb) = c.path.bbox() {
                b = [
                    b[0].max(cb[0]),
                    b[1].max(cb[1]),
                    b[2].min(cb[2]),
                    b[3].min(cb[3]),
                ];
            }
        }
        if b[2] < b[0] || b[3] < b[1] {
            return [b[0], b[1], b[0], b[1]];
        }
        b
    }
}

/// Fill `path` (device space) with the current paint.
pub fn fill_path(i: &mut Interp<'_>, path: Path, rule: FillRule) -> R {
    if i.suppress > 0 || path.is_empty() {
        return Ok(());
    }
    match crate::color::current_paint(i)? {
        PaintKind::None => Ok(()),
        PaintKind::Solid(paint) => {
            i.sync_clips()?;
            i.emit(Element::Fill {
                path: path.bez,
                rule,
                paint,
            })
        }
        PaintKind::Pattern(pat, under) => pattern_fill(i, &pat, under, path, rule),
    }
}

pub fn stroke_style(i: &Interp<'_>) -> StrokeStyle {
    StrokeStyle {
        width: i.gs.line_width,
        cap: i.gs.cap,
        join: i.gs.join,
        miter_limit: i.gs.miter,
        dash: i.gs.dash.clone(),
        dash_offset: i.gs.dash_offset,
    }
}

fn stroke_path(i: &mut Interp<'_>, path: Path) -> R {
    if i.suppress > 0 || path.is_empty() {
        return Ok(());
    }
    let ctm = i.gs.ctm;
    let Some(inv) = ctm.invert() else {
        return Ok(());
    };
    let paint = match crate::color::current_paint(i)? {
        PaintKind::None => return Ok(()),
        PaintKind::Solid(p) => p,
        PaintKind::Pattern(_, under) => {
            i.report.unsupported("stroke with a pattern");
            under.unwrap_or(Paint {
                color: crate::art::Color::Gray(0.5),
                separation: None,
            })
        }
    };
    i.sync_clips()?;
    let style = stroke_style(i);
    i.emit(Element::Stroke {
        path: path.transformed(&inv).bez,
        transform: ctm,
        style,
        paint,
    })
}

fn execform(i: &mut Interp<'_>) -> R {
    let form = i.pop_dict()?;
    let proc = form.get_name("PaintProc").ok_or(err("undefined"))?;
    let saved = (i.gs.clone(), i.gstack.len());
    i.gstack.push((i.gs.clone(), None));
    if let Some(m) = form.get_name("Matrix").and_then(|o| o.as_array().cloned()) {
        let m = crate::interp::matrix_of(&m)?;
        i.gs.ctm = m.then(&i.gs.ctm);
    }
    if let Some(b) = form.get_name("BBox").and_then(|o| o.as_array().cloned()) {
        let v: Vec<f64> = b.items().iter().filter_map(Obj::as_num).collect();
        if v.len() == 4 {
            let m = i.gs.ctm;
            i.gs.path = rect(v[0], v[1], v[2] - v[0], v[3] - v[1], &m);
            clip(i, FillRule::NonZero)?;
            i.gs.path = Path::default();
        }
    }
    i.push(Obj::dict(form))?;
    let r = i.call(proc);
    i.gstack.truncate(saved.1);
    i.gs = saved.0;
    r
}

fn makepattern(i: &mut Interp<'_>) -> R {
    let m = i.pop_matrix()?;
    let d = i.pop_dict()?;
    let copy = PsDict::new(d.len() + 2);
    for (k, v) in d.entries() {
        copy.put(k, v);
    }
    let pm = m.then(&i.gs.ctm);
    copy.put_name("Implementation", matrix_obj(&pm));
    i.push(Obj::dict(copy))
}

/// Fill with a pattern: a shading pattern shades the area; a tiling
/// pattern runs its PaintProc once per cell over the area, under a clip
/// to it.
fn pattern_fill(
    i: &mut Interp<'_>,
    pat: &PsDict,
    under: Option<Paint>,
    path: Path,
    rule: FillRule,
) -> R {
    let pm = pat
        .get_name("Implementation")
        .and_then(|o| o.as_array().cloned())
        .map(|a| crate::interp::matrix_of(&a))
        .transpose()?
        .unwrap_or(Affine::IDENTITY);
    let kind = pat
        .get_name("PatternType")
        .and_then(|o| o.as_int())
        .unwrap_or(1);
    let saved = (i.gs.clone(), i.gstack.len());
    let id = i.id();
    i.gs.clip.push(Rc::new(ClipEntry {
        id,
        path: path.clone(),
        rule,
    }));
    i.gs.path = Path::default();
    let r = if kind == 2 {
        match pat.get_name("Shading").and_then(|o| o.as_dict().cloned()) {
            Some(sh) => {
                i.gs.ctm = pm;
                crate::shading::shfill_dict(i, &sh)
            }
            None => Err(err("typecheck")),
        }
    } else {
        tiles(i, pat, &pm, under, &path)
    };
    i.gstack.truncate(saved.1);
    i.gs = saved.0;
    r
}

const MAX_TILES: usize = 4096;

fn tiles(i: &mut Interp<'_>, pat: &PsDict, pm: &Affine, under: Option<Paint>, path: &Path) -> R {
    let num = |k: &str| pat.get_name(k).and_then(|o| o.as_num());
    let (Some(xs), Some(ys)) = (num("XStep"), num("YStep")) else {
        return Err(err("rangecheck"));
    };
    let bbox: Vec<f64> = pat
        .get_name("BBox")
        .and_then(|o| o.as_array().cloned())
        .map(|a| a.items().iter().filter_map(Obj::as_num).collect())
        .unwrap_or_default();
    let proc = pat.get_name("PaintProc").ok_or(err("undefined"))?;
    if bbox.len() != 4 || xs == 0.0 || ys == 0.0 {
        return Err(err("rangecheck"));
    }
    let Some(inv) = pm.invert() else {
        return Ok(());
    };
    let Some(b) = path.bbox() else {
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
    let mut corners = Path::default();
    for (x, y) in [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])] {
        corners.line_to(inv.apply(x, y));
    }
    let pb = corners.bbox().unwrap_or([0.0; 4]);
    let (xs, ys) = (xs.abs(), ys.abs());
    let i0 = ((pb[0] - bbox[2]) / xs).floor() as i64;
    let i1 = ((pb[2] - bbox[0]) / xs).ceil() as i64;
    let j0 = ((pb[1] - bbox[3]) / ys).floor() as i64;
    let j1 = ((pb[3] - bbox[1]) / ys).ceil() as i64;
    let count = (i1 - i0 + 1).max(0) as u128 * (j1 - j0 + 1).max(0) as u128;
    let paint_type = pat
        .get_name("PaintType")
        .and_then(|o| o.as_int())
        .unwrap_or(1);
    if count as usize > MAX_TILES || count > MAX_TILES as u128 {
        // Too fine to draw cell by cell: an even grey stands in, reported.
        i.report.unsupported("tiling pattern with too many cells");
        let paint = under.unwrap_or(Paint {
            color: crate::art::Color::Gray(0.5),
            separation: None,
        });
        i.sync_clips()?;
        return i.emit(Element::Fill {
            path: page_path(i).bez,
            rule: FillRule::NonZero,
            paint,
        });
    }
    if paint_type == 2 {
        if let Some(p) = &under {
            crate::color::set_device_paint(i, p);
        }
        i.gs.uncolored = true;
    } else {
        // A coloured cell paints in its own colours, from black.
        crate::color::set_device_paint(
            i,
            &Paint {
                color: crate::art::Color::Gray(0.0),
                separation: None,
            },
        );
    }
    let base = i.gs.clone();
    for jj in j0..=j1 {
        for ii in i0..=i1 {
            i.gs = base.clone();
            i.gs.ctm = Affine::translate((ii as f64 * xs, jj as f64 * ys)).then(pm);
            i.push(Obj::dict(pat.clone()))?;
            i.call(proc.clone())?;
        }
    }
    Ok(())
}
