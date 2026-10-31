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

//! Fonts and text (PLRM 5): the font dictionary operators and the show
//! family. A Type 1 font's glyphs come from its charstrings, a Type 42
//! font's from its sfnts, a Type 3 font's from its BuildGlyph or
//! BuildChar procedure. A font the program names but does not define is
//! a substitute: a face from the host's [`FontProvider`], looked up by
//! the font's name, recorded in the report. Glyphs are drawn as filled
//! outlines.

use std::collections::HashMap;
use std::rc::Rc;

use crate::art::FillRule;
use crate::encoding::{unicode, STANDARD};
use crate::geom::{Affine, Path, Point, Ps};
use crate::interp::{err, matrix_obj, Interp, OpDef, PsError, R};
use crate::object::{Obj, PsDict, V};
use crate::{Face, FontProvider};

/// The key a substitute font carries its requested name under; it
/// survives the copy-and-redefine a reencoding does.
const SUBSTITUTE: &str = ".PagedSubstitute";

/// A glyph's outline (glyph space) and advance.
type Outline = (Path, (f64, f64));
type GlyphOutline = Option<Rc<Outline>>;

#[derive(Default)]
pub struct FontCache {
    glyphs: HashMap<(u32, Vec<u8>), GlyphOutline>,
    faces: HashMap<String, Option<Face>>,
    subrs: HashMap<u32, Rc<Vec<Vec<u8>>>>,
    sfnts: HashMap<u32, Option<Rc<[u8]>>>,
}

macro_rules! ops {
    ($($name:literal => $f:expr),* $(,)?) => {
        &[$(OpDef { name: $name, f: $f }),*]
    };
}

pub const OPS: &[OpDef] = ops! {
    "definefont" => |i| { let font = i.pop()?; let key = i.pop()?; define_font(i, key, font) },
    "undefinefont" => |i| { let k = i.pop()?; if let Some(k) = k.key() { i.font_directory.remove(&k); } Ok(()) },
    "findfont" => findfont,
    "scalefont" => |i| { let s = i.pop_num()?; let f = i.pop_dict()?; let r = transform_font(i, &f, &Affine::scale_non_uniform(s, s))?; i.push(Obj::dict(r)) },
    "makefont" => |i| { let m = i.pop_matrix()?; let f = i.pop_dict()?; let r = transform_font(i, &f, &m)?; i.push(Obj::dict(r)) },
    "setfont" => |i| { let f = i.pop_dict()?; i.gs.font = Some(f); Ok(()) },
    "currentfont" => |i| { let f = current_font(i); i.push(Obj::dict(f)) },
    "rootfont" => |i| { let f = current_font(i); i.push(Obj::dict(f)) },
    "selectfont" => |i| { let arg = i.pop()?; let key = i.pop()?; i.push(key)?; findfont(i)?; let f = i.pop_dict()?; let m = match &arg.v { V::Array(a) => crate::interp::matrix_of(a)?, _ => { let s = arg.as_num().ok_or(err("typecheck"))?; Affine::scale_non_uniform(s, s) } }; let r = transform_font(i, &f, &m)?; i.gs.font = Some(r); Ok(()) },
    "setcachedevice" => |i| { let v = crate::graphics::pop_nums(i, 6)?; i.glyph_width = Some((v[0], v[1])); i.gs.uncolored = true; Ok(()) },
    "setcharwidth" => |i| { let v = crate::graphics::pop_nums(i, 2)?; i.glyph_width = Some((v[0], v[1])); Ok(()) },
    "show" => |i| { let s = i.pop_str()?.bytes(); show(i, &s, Mode::Draw, &mut |_, _| (0.0, 0.0), None) },
    "ashow" => |i| { let s = i.pop_str()?.bytes(); let ay = i.pop_num()?; let ax = i.pop_num()?; show(i, &s, Mode::Draw, &mut |_, _| (ax, ay), None) },
    "widthshow" => |i| { let s = i.pop_str()?.bytes(); let ch = i.pop_int()?; let cy = i.pop_num()?; let cx = i.pop_num()?; show(i, &s, Mode::Draw, &mut |c, _| if c as i32 == ch { (cx, cy) } else { (0.0, 0.0) }, None) },
    "awidthshow" => |i| { let s = i.pop_str()?.bytes(); let ay = i.pop_num()?; let ax = i.pop_num()?; let ch = i.pop_int()?; let cy = i.pop_num()?; let cx = i.pop_num()?; show(i, &s, Mode::Draw, &mut |c, _| if c as i32 == ch { (cx + ax, cy + ay) } else { (ax, ay) }, None) },
    "xshow" => |i| positioned_show(i, 1),
    "yshow" => |i| positioned_show(i, 2),
    "xyshow" => |i| positioned_show(i, 3),
    "kshow" => |i| { let s = i.pop_str()?.bytes(); let p = i.pop_proc()?; show(i, &s, Mode::Draw, &mut |_, _| (0.0, 0.0), Some(p)) },
    "cshow" => cshow,
    "glyphshow" => glyphshow,
    "stringwidth" => |i| { let s = i.pop_str()?.bytes(); let (dx, dy) = string_width(i, &s)?; i.push(Obj::real(dx))?; i.push(Obj::real(dy)) },
    "charpath" => |i| { let _ = i.pop_bool()?; let s = i.pop_str()?.bytes(); show(i, &s, Mode::Charpath, &mut |_, _| (0.0, 0.0), None) },
};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Draw,
    Charpath,
    Width,
}

fn current_font(i: &mut Interp<'_>) -> PsDict {
    if let Some(f) = &i.gs.font {
        return f.clone();
    }
    // No font set: the default font, as `currentfont` reports one.
    let d = substitute(i, "Courier");
    i.gs.font = Some(d.clone());
    d
}

fn fid(i: &mut Interp<'_>, font: &PsDict) -> u32 {
    if let Some(Obj {
        v: V::FontId(f), ..
    }) = font.get_name("FID")
    {
        return f;
    }
    let f = i.next_fid;
    i.next_fid += 1;
    font.put_name("FID", Obj::lit(V::FontId(f)));
    f
}

pub fn define_font(i: &mut Interp<'_>, key: Obj, font: Obj) -> R {
    let d = font.as_dict().ok_or(err("typecheck"))?.clone();
    if d.get_name("FontMatrix").is_none() {
        d.put_name(
            "FontMatrix",
            matrix_obj(&Affine::scale_non_uniform(0.001, 0.001)),
        );
    }
    if d.get_name("FID").is_none() {
        fid(i, &d);
    }
    i.font_directory.put(key, font.clone());
    i.push(font)
}

pub fn findfont(i: &mut Interp<'_>) -> R {
    let key = i.pop()?;
    let name = String::from_utf8_lossy(&crate::ops::text_of(&key)).into_owned();
    if let Some(f) = key.key().and_then(|k| i.font_directory.get(&k)) {
        return i.push(f);
    }
    let d = substitute(i, &name);
    i.push(Obj::dict(d))
}

/// A font standing in for `name`: the host's face for it, if any.
fn substitute(i: &mut Interp<'_>, name: &str) -> PsDict {
    let face = i.fonts.and_then(|p: &dyn FontProvider| p.face(name));
    i.report
        .substituted_fonts
        .push((name.to_string(), face.as_ref().map(|f| f.name.clone())));
    i.font_cache.faces.insert(name.to_string(), face);
    let d = PsDict::new(12);
    d.put_name("FontName", Obj::name(name));
    d.put_name("FontType", Obj::int(1));
    d.put_name("PaintType", Obj::int(0));
    d.put_name(
        "FontMatrix",
        matrix_obj(&Affine::scale_non_uniform(0.001, 0.001)),
    );
    d.put_name(
        "FontBBox",
        Obj::array(vec![
            Obj::int(0),
            Obj::int(-250),
            Obj::int(1000),
            Obj::int(900),
        ]),
    );
    let enc = i
        .systemdict
        .get_name("StandardEncoding")
        .unwrap_or(Obj::NULL);
    d.put_name("Encoding", enc);
    d.put_name(SUBSTITUTE, Obj::string(name.as_bytes().to_vec()));
    d.put_name("CharStrings", Obj::dict(PsDict::new(1)));
    fid(i, &d);
    i.font_directory.put_name(name, Obj::dict(d.clone()));
    d
}

fn font_matrix(f: &PsDict) -> Affine {
    f.get_name("FontMatrix")
        .and_then(|o| o.as_array().cloned())
        .and_then(|a| crate::interp::matrix_of(&a).ok())
        .unwrap_or(Affine::scale_non_uniform(0.001, 0.001))
}

fn transform_font(i: &mut Interp<'_>, f: &PsDict, m: &Affine) -> Result<PsDict, PsError> {
    let copy = PsDict::new(f.len() + 1);
    for (k, v) in f.entries() {
        copy.put(k, v);
    }
    copy.put_name("FontMatrix", matrix_obj(&font_matrix(f).then(m)));
    i.alloc(f.len() * 48)?;
    Ok(copy)
}

fn glyph_name(font: &PsDict, code: u8) -> Vec<u8> {
    let named = font
        .get_name("Encoding")
        .and_then(|e| e.as_array().and_then(|a| a.get(code as usize)))
        .and_then(|n| n.as_name().map(|n| n.as_bytes().to_vec()));
    named.unwrap_or_else(|| STANDARD[code as usize].as_bytes().to_vec())
}

/// The glyph space → device transform of a glyph at the current point.
fn glyph_matrix(i: &Interp<'_>, font: &PsDict) -> Result<Affine, PsError> {
    let cp = i.gs.path.cur.ok_or(err("nocurrentpoint"))?;
    let c = i.gs.ctm.as_coeffs();
    let lin = Affine::new([c[0], c[1], c[2], c[3], 0.0, 0.0]);
    let m = font_matrix(font).then(&lin);
    Ok(m.then(&Affine::translate((cp.x, cp.y))))
}

fn font_type(font: &PsDict) -> i32 {
    font.get_name("FontType")
        .and_then(|o| o.as_int())
        .unwrap_or(1)
}

/// Draw (or append, or only measure) one glyph at the current point and
/// return its advance in user space.
fn show_glyph(
    i: &mut Interp<'_>,
    font: &PsDict,
    code: u8,
    name: Option<Vec<u8>>,
    mode: Mode,
) -> Result<(f64, f64), PsError> {
    let name = name.unwrap_or_else(|| glyph_name(font, code));
    let fm = font_matrix(font);
    let m = glyph_matrix(i, font)?;
    match font_type(font) {
        3 => {
            let saved = (i.gs.clone(), i.gstack.len(), i.glyph_width.take());
            i.gstack.push((i.gs.clone(), None));
            i.gs.ctm = m;
            i.gs.path = Path::default();
            if mode != Mode::Draw {
                i.suppress += 1;
                if mode == Mode::Charpath {
                    i.report.unsupported("charpath of a Type 3 font");
                }
            }
            i.push(Obj::dict(font.clone()))?;
            let r = if let Some(bg) = font.get_name("BuildGlyph") {
                i.push(Obj::name(&String::from_utf8_lossy(&name)))?;
                i.call(bg)
            } else if let Some(bc) = font.get_name("BuildChar") {
                i.push(Obj::int(code as i32))?;
                i.call(bc)
            } else {
                Err(err("invalidfont"))
            };
            if mode != Mode::Draw {
                i.suppress -= 1;
            }
            let w = i.glyph_width.take().unwrap_or((0.0, 0.0));
            i.gstack.truncate(saved.1);
            i.gs = saved.0;
            i.glyph_width = saved.2;
            r?;
            let d = fm.apply_delta(w.0, w.1);
            Ok((d.x, d.y))
        }
        0 => {
            i.report.unsupported("composite (Type 0) font");
            Ok((0.0, 0.0))
        }
        _ => {
            let outline = outline(i, font, &name)?;
            let Some(g) = outline else {
                // No outline: advance half an em, draw nothing.
                let d = fm.apply_delta(500.0, 0.0);
                return Ok((d.x, d.y));
            };
            let (path, w) = (&g.0, g.1);
            match mode {
                Mode::Draw => {
                    let p = path.transformed(&m);
                    if !p.is_empty() {
                        crate::graphics::fill_path(i, p, FillRule::NonZero)?;
                    }
                }
                Mode::Charpath => {
                    let p = path.transformed(&m);
                    i.gs.path.append(&p.bez);
                }
                Mode::Width => {}
            }
            let d = fm.apply_delta(w.0, w.1);
            Ok((d.x, d.y))
        }
    }
}

/// The outline (glyph space) and width of `name` in an outline font.
fn outline(i: &mut Interp<'_>, font: &PsDict, name: &[u8]) -> Result<GlyphOutline, PsError> {
    let id = fid(i, font);
    let key = (id, name.to_vec());
    if let Some(g) = i.font_cache.glyphs.get(&key) {
        return Ok(g.clone());
    }
    let g = if let Some(req) = font
        .get_name(SUBSTITUTE)
        .and_then(|o| o.as_str().map(|s| s.text()))
    {
        substitute_outline(i, &req, name)
    } else if font_type(font) == 42 {
        type42_outline(i, font, id, name)
    } else {
        type1_outline(i, font, id, name)?
    };
    let g = g.map(Rc::new);
    i.alloc(g.as_ref().map_or(16, |g| g.0.len() * 56 + 64))?;
    i.font_cache.glyphs.insert(key, g.clone());
    Ok(g)
}

fn decrypt_cs(bytes: Vec<u8>, len_iv: i32) -> Vec<u8> {
    if len_iv < 0 {
        bytes
    } else {
        crate::file::decrypt(&bytes, crate::type1::CHARSTRING_KEY, len_iv as usize)
    }
}

fn type1_outline(
    i: &mut Interp<'_>,
    font: &PsDict,
    id: u32,
    name: &[u8],
) -> Result<Option<Outline>, PsError> {
    let Some(cs) = font
        .get_name("CharStrings")
        .and_then(|o| o.as_dict().cloned())
    else {
        return Ok(None);
    };
    let private = font.get_name("Private").and_then(|o| o.as_dict().cloned());
    let len_iv = private
        .as_ref()
        .and_then(|p| p.get_name("lenIV"))
        .and_then(|o| o.as_int())
        .unwrap_or(4);
    let subrs = match i.font_cache.subrs.get(&id) {
        Some(s) => s.clone(),
        None => {
            let list: Vec<Vec<u8>> = private
                .as_ref()
                .and_then(|p| p.get_name("Subrs"))
                .and_then(|o| o.as_array().cloned())
                .map(|a| {
                    a.items()
                        .iter()
                        .map(|s| {
                            s.as_str()
                                .map(|s| decrypt_cs(s.bytes(), len_iv))
                                .unwrap_or_default()
                        })
                        .collect()
                })
                .unwrap_or_default();
            let s = Rc::new(list);
            i.font_cache.subrs.insert(id, s.clone());
            s
        }
    };
    let get = |n: &[u8]| -> Option<Vec<u8>> {
        let o = cs.get_name(&String::from_utf8_lossy(n))?;
        o.as_str().map(|s| decrypt_cs(s.bytes(), len_iv))
    };
    let Some(prog) = get(name).or_else(|| get(b".notdef")) else {
        return Ok(None);
    };
    let lookup = |code: u8| get(STANDARD[code as usize].as_bytes());
    match crate::type1::run(&prog, &subrs, &lookup) {
        Ok(g) => Ok(Some((g.path, g.width))),
        Err(_) => {
            i.report.unsupported("malformed Type 1 charstring");
            Ok(None)
        }
    }
}

struct Builder {
    path: Path,
    scale: f64,
}

impl ttf_parser::OutlineBuilder for Builder {
    fn move_to(&mut self, x: f32, y: f32) {
        let s = self.scale;
        self.path.move_to(Point::new(x as f64 * s, y as f64 * s));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let s = self.scale;
        self.path.line_to(Point::new(x as f64 * s, y as f64 * s));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let s = self.scale;
        let p0 = self.path.cur.unwrap_or(Point::new(0.0, 0.0));
        let q = Point::new(x1 as f64 * s, y1 as f64 * s);
        let p = Point::new(x as f64 * s, y as f64 * s);
        let c1 = Point::new(
            p0.x + 2.0 / 3.0 * (q.x - p0.x),
            p0.y + 2.0 / 3.0 * (q.y - p0.y),
        );
        let c2 = Point::new(p.x + 2.0 / 3.0 * (q.x - p.x), p.y + 2.0 / 3.0 * (q.y - p.y));
        self.path.curve_to(c1, c2, p);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let s = self.scale;
        self.path.curve_to(
            Point::new(x1 as f64 * s, y1 as f64 * s),
            Point::new(x2 as f64 * s, y2 as f64 * s),
            Point::new(x as f64 * s, y as f64 * s),
        );
    }
    fn close(&mut self) {
        self.path.close();
    }
}

/// A glyph of an sfnt, scaled so the em is `em` glyph-space units.
fn sfnt_glyph(
    data: &[u8],
    index: u32,
    gid: Option<ttf_parser::GlyphId>,
    ch: Option<char>,
    em: f64,
) -> Option<Outline> {
    let face = ttf_parser::Face::parse(data, index).ok()?;
    let gid = gid.or_else(|| ch.and_then(|c| face.glyph_index(c)))?;
    let upm = face.units_per_em() as f64;
    let mut b = Builder {
        path: Path::default(),
        scale: em / upm,
    };
    let _ = face.outline_glyph(gid, &mut b);
    let adv = face.glyph_hor_advance(gid).unwrap_or(0) as f64 * em / upm;
    Some((b.path, (adv, 0.0)))
}

fn substitute_outline(i: &mut Interp<'_>, req: &str, name: &[u8]) -> Option<Outline> {
    let face = i.font_cache.faces.get(req).cloned().flatten()?;
    let ch = unicode(&String::from_utf8_lossy(name));
    if name == b".notdef" {
        return None;
    }
    sfnt_glyph(&face.data, face.index, None, ch, 1000.0)
}

fn type42_outline(i: &mut Interp<'_>, font: &PsDict, id: u32, name: &[u8]) -> Option<Outline> {
    let data = match i.font_cache.sfnts.get(&id) {
        Some(d) => d.clone(),
        None => {
            let mut v = Vec::new();
            if let Some(a) = font.get_name("sfnts").and_then(|o| o.as_array().cloned()) {
                for s in a.items() {
                    if let Some(s) = s.as_str() {
                        let mut b = s.bytes();
                        // An odd-length string ends in a padding byte.
                        if b.len() % 2 == 1 {
                            b.pop();
                        }
                        v.extend_from_slice(&b);
                    }
                }
            }
            let d = (!v.is_empty()).then(|| Rc::<[u8]>::from(v));
            i.font_cache.sfnts.insert(id, d.clone());
            d
        }
    }?;
    let gid = font
        .get_name("CharStrings")
        .and_then(|o| o.as_dict().cloned())
        .and_then(|cs| cs.get_name(&String::from_utf8_lossy(name)))
        .and_then(|o| o.as_int())
        .and_then(|g| u16::try_from(g).ok())
        .map(ttf_parser::GlyphId);
    let ch = unicode(&String::from_utf8_lossy(name));
    sfnt_glyph(&data, 0, gid, ch, 1.0)
}

/// The show family's loop: each byte of `s` drawn, the current point
/// advanced by the glyph's width plus `extra(code, k)` (user space).
/// With `between`, that procedure runs between each pair of glyphs
/// (`kshow`), the two codes on the stack.
fn show(
    i: &mut Interp<'_>,
    s: &[u8],
    mode: Mode,
    extra: &mut dyn FnMut(u8, usize) -> (f64, f64),
    between: Option<Obj>,
) -> R {
    let font = current_font(i);
    for (k, &code) in s.iter().enumerate() {
        if k > 0 {
            if let Some(p) = &between {
                i.push(Obj::int(s[k - 1] as i32))?;
                i.push(Obj::int(code as i32))?;
                i.call(p.clone())?;
            }
        }
        let font = if between.is_some() {
            current_font(i)
        } else {
            font.clone()
        };
        let (dx, dy) = show_glyph(i, &font, code, None, mode)?;
        let (ex, ey) = extra(code, k);
        advance(i, dx + ex, dy + ey)?;
    }
    Ok(())
}

fn advance(i: &mut Interp<'_>, dx: f64, dy: f64) -> R {
    let cp = i.gs.path.cur.ok_or(err("nocurrentpoint"))?;
    let d = i.gs.ctm.apply_delta(dx, dy);
    i.gs.path.move_to(Point::new(cp.x + d.x, cp.y + d.y));
    Ok(())
}

fn string_width(i: &mut Interp<'_>, s: &[u8]) -> Result<(f64, f64), PsError> {
    let font = current_font(i);
    let saved = i.gs.path.clone();
    i.gs.path = Path::default();
    i.gs.path.move_to(Point::new(0.0, 0.0));
    let mut total = (0.0, 0.0);
    let mut r = Ok(());
    for &code in s {
        match show_glyph(i, &font, code, None, Mode::Width) {
            Ok((dx, dy)) => {
                total.0 += dx;
                total.1 += dy;
            }
            Err(e) => {
                r = Err(e);
                break;
            }
        }
    }
    i.gs.path = saved;
    r.map(|_| total)
}

fn positioned_show(i: &mut Interp<'_>, kind: u8) -> R {
    let nums = i.pop()?;
    let s = i.pop_str()?.bytes();
    let v: Vec<f64> = match &nums.v {
        V::Array(a) => a.items().iter().filter_map(Obj::as_num).collect(),
        _ => {
            i.report.unsupported("encoded number string positions");
            return show(i, &s, Mode::Draw, &mut |_, _| (0.0, 0.0), None);
        }
    };
    let font = current_font(i);
    for (k, &code) in s.iter().enumerate() {
        show_glyph(i, &font, code, None, Mode::Draw)?;
        let (dx, dy) = match kind {
            1 => (v.get(k).copied().unwrap_or(0.0), 0.0),
            2 => (0.0, v.get(k).copied().unwrap_or(0.0)),
            _ => (
                v.get(2 * k).copied().unwrap_or(0.0),
                v.get(2 * k + 1).copied().unwrap_or(0.0),
            ),
        };
        advance(i, dx, dy)?;
    }
    Ok(())
}

fn cshow(i: &mut Interp<'_>) -> R {
    let s = i.pop_str()?.bytes();
    let p = i.pop_proc()?;
    let font = current_font(i);
    for &code in &s {
        let (wx, wy) = {
            let saved = i.gs.path.clone();
            if i.gs.path.cur.is_none() {
                i.gs.path.move_to(Point::new(0.0, 0.0));
            }
            let w = show_glyph(i, &font, code, None, Mode::Width);
            i.gs.path = saved;
            w?
        };
        i.push(Obj::int(code as i32))?;
        i.push(Obj::real(wx))?;
        i.push(Obj::real(wy))?;
        i.call(p.clone())?;
        i.gs.font = Some(font.clone());
    }
    Ok(())
}

fn glyphshow(i: &mut Interp<'_>) -> R {
    let n = i.pop_name_text()?;
    let font = current_font(i);
    let (dx, dy) = show_glyph(i, &font, 0, Some(n.into_bytes()), Mode::Draw)?;
    advance(i, dx, dy)
}
