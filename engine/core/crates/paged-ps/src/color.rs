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

//! Colour spaces (PLRM 4.8): the device spaces, Indexed, Separation and
//! DeviceN (through their tint transforms to the alternate space),
//! ICCBased (through its alternate), the CIE-based spaces (approximated
//! by the device space of their component count) and Pattern.

use std::rc::Rc;

use crate::art::{Color, Paint};
use crate::interp::{err, Interp, OpDef, PsError, R};
use crate::object::{Obj, PsDict, V};

pub enum Lookup {
    Table(Vec<u8>),
    Proc(Obj),
}

pub enum ColorSpace {
    Gray,
    Rgb,
    Cmyk,
    Indexed {
        base: Rc<ColorSpace>,
        hival: usize,
        lookup: Lookup,
    },
    Separation {
        name: String,
        alt: Rc<ColorSpace>,
        tint: Obj,
    },
    DeviceN {
        n: usize,
        alt: Rc<ColorSpace>,
        tint: Obj,
    },
    /// CIEBasedA/ABC/DEF/DEFG, approximated by the device space with the
    /// same number of components.
    Cie(Rc<ColorSpace>),
    Pattern(Option<Rc<ColorSpace>>),
}

impl ColorSpace {
    pub fn ncomp(&self) -> usize {
        match self {
            ColorSpace::Gray => 1,
            ColorSpace::Rgb => 3,
            ColorSpace::Cmyk => 4,
            ColorSpace::Indexed { .. } | ColorSpace::Separation { .. } => 1,
            ColorSpace::DeviceN { n, .. } => *n,
            ColorSpace::Cie(b) => b.ncomp(),
            ColorSpace::Pattern(_) => 1,
        }
    }
    pub fn initial(&self) -> Vec<f64> {
        match self {
            ColorSpace::Cmyk => vec![0.0, 0.0, 0.0, 1.0],
            ColorSpace::Separation { .. } => vec![1.0],
            ColorSpace::DeviceN { n, .. } => vec![1.0; *n],
            ColorSpace::Cie(b) => b.initial(),
            other => vec![0.0; other.ncomp()],
        }
    }
    /// The decode range of component `k` for an image's default
    /// `Decode` (PLRM 4.10.5).
    pub fn decode_max(&self, _k: usize, bits: u32) -> f64 {
        match self {
            ColorSpace::Indexed { .. } => ((1u64 << bits) - 1) as f64,
            _ => 1.0,
        }
    }
}

pub enum PaintKind {
    /// Nothing is painted (the /None separation).
    None,
    Solid(Paint),
    /// A pattern, and for an uncoloured one the colour it is painted in.
    Pattern(PsDict, Option<Paint>),
}

macro_rules! ops {
    ($($name:literal => $f:expr),* $(,)?) => {
        &[$(OpDef { name: $name, f: $f }),*]
    };
}

pub const OPS: &[OpDef] = ops! {
    "setgray" => |i| { let g = i.pop_num()?; set_device(i, ColorSpace::Gray, "DeviceGray", vec![g]) },
    "setrgbcolor" => |i| { let v = crate::graphics::pop_nums(i, 3)?; set_device(i, ColorSpace::Rgb, "DeviceRGB", v) },
    "setcmykcolor" => |i| { let v = crate::graphics::pop_nums(i, 4)?; set_device(i, ColorSpace::Cmyk, "DeviceCMYK", v) },
    "sethsbcolor" => |i| { let v = crate::graphics::pop_nums(i, 3)?; let rgb = paged_color::math::hsb_to_rgb(v[0], v[1], v[2]); set_device(i, ColorSpace::Rgb, "DeviceRGB", rgb.to_vec()) },
    "currentgray" => |i| { let c = current_device(i)?; let [r, g, b] = c.to_srgb(); let gray = match c { Color::Gray(v) => v, _ => 0.3 * r + 0.59 * g + 0.11 * b }; i.push(Obj::real(gray as f64)) },
    "currentrgbcolor" => |i| { let c = current_device(i)?; for v in c.to_srgb() { i.push(Obj::real(v as f64))?; } Ok(()) },
    "currenthsbcolor" => |i| { let c = current_device(i)?; let [r, g, b] = c.to_srgb(); for v in paged_color::math::rgb_to_hsb([r as f64, g as f64, b as f64]) { i.push(Obj::real(v))?; } Ok(()) },
    "currentcmykcolor" => |i| { let c = current_device(i)?; let v = match c { Color::Cmyk(v) => v, Color::Gray(g) => [0.0, 0.0, 0.0, 1.0 - g], Color::Rgb([r, g, b]) => { let (c, m, y) = (1.0 - r, 1.0 - g, 1.0 - b); let k = c.min(m).min(y); [c - k, m - k, y - k, k] } }; for x in v { i.push(Obj::real(x as f64))?; } Ok(()) },
    "setcolorspace" => setcolorspace,
    "currentcolorspace" => |i| { let o = i.gs.cs_obj.clone(); let o = if o.as_name().is_some() { Obj::array(vec![o]) } else { o }; i.push(o) },
    "setcolor" => setcolor,
    "setpattern" => |i| { let top = i.top(0)?.clone(); let uncolored = top.as_dict().and_then(|d| d.get_name("PaintType")).and_then(|o| o.as_int()) == Some(2); if !uncolored { set_space(i, Obj::name("Pattern"))?; } else if !matches!(&*i.gs.cs, ColorSpace::Pattern(Some(_))) { let base = i.gs.cs_obj.clone(); set_space(i, Obj::array(vec![Obj::name("Pattern"), base]))?; } setcolor(i) },
    "currentcolor" => |i| { if let Some(p) = i.gs.pattern.clone() { for v in i.gs.color.clone() { i.push(Obj::real(v))?; } return i.push(Obj::dict(p)); } for v in i.gs.color.clone() { i.push(Obj::real(v))?; } Ok(()) },
};

fn set_device(i: &mut Interp<'_>, cs: ColorSpace, name: &str, v: Vec<f64>) -> R {
    if i.gs.uncolored {
        return Ok(());
    }
    i.gs.cs = Rc::new(cs);
    i.gs.cs_obj = Obj::name(name);
    i.gs.color = v.into_iter().map(|x| x.clamp(0.0, 1.0)).collect();
    i.gs.pattern = None;
    Ok(())
}

/// Paint in `p`'s device colour (an uncoloured pattern's cell).
pub fn set_device_paint(i: &mut Interp<'_>, p: &Paint) {
    let (cs, name, v) = match p.color {
        Color::Gray(g) => (ColorSpace::Gray, "DeviceGray", vec![g as f64]),
        Color::Rgb(c) => (
            ColorSpace::Rgb,
            "DeviceRGB",
            c.iter().map(|x| *x as f64).collect(),
        ),
        Color::Cmyk(c) => (
            ColorSpace::Cmyk,
            "DeviceCMYK",
            c.iter().map(|x| *x as f64).collect(),
        ),
    };
    i.gs.cs = Rc::new(cs);
    i.gs.cs_obj = Obj::name(name);
    i.gs.color = v;
    i.gs.pattern = None;
}

fn setcolorspace(i: &mut Interp<'_>) -> R {
    let o = i.pop()?;
    if i.gs.uncolored {
        return Ok(());
    }
    set_space(i, o)
}

fn set_space(i: &mut Interp<'_>, o: Obj) -> R {
    let cs = parse_space(i, &o, 0)?;
    i.gs.color = cs.initial();
    i.gs.cs = Rc::new(cs);
    i.gs.cs_obj = o;
    i.gs.pattern = None;
    Ok(())
}

fn space_name(o: &Obj) -> Option<String> {
    match &o.v {
        V::Name(n) => Some(n.to_string()),
        V::Array(a) => a.get(0).and_then(|f| f.as_name().map(|n| n.to_string())),
        _ => None,
    }
}

pub fn parse_space(i: &mut Interp<'_>, o: &Obj, depth: usize) -> Result<ColorSpace, PsError> {
    if depth > 8 {
        return Err(err("limitcheck"));
    }
    let name = space_name(o).ok_or(err("typecheck"))?;
    let arg = |k: usize| o.as_array().and_then(|a| a.get(k));
    Ok(match name.as_str() {
        "DeviceGray" | "G" | "CalGray" => ColorSpace::Gray,
        "DeviceRGB" | "RGB" | "CalRGB" => ColorSpace::Rgb,
        "DeviceCMYK" | "CMYK" => ColorSpace::Cmyk,
        "Pattern" => ColorSpace::Pattern(match arg(1) {
            Some(b) => Some(Rc::new(parse_space(i, &b, depth + 1)?)),
            None => None,
        }),
        "Indexed" | "I" => {
            let base = parse_space(i, &arg(1).ok_or(err("rangecheck"))?, depth + 1)?;
            let hival = arg(2).and_then(|h| h.as_int()).ok_or(err("typecheck"))?;
            let hival = usize::try_from(hival)
                .map_err(|_| err("rangecheck"))?
                .min(4095);
            let l = arg(3).ok_or(err("rangecheck"))?;
            let lookup = match &l.v {
                V::Str(s) if !l.exec => Lookup::Table(s.bytes()),
                _ => Lookup::Proc(l),
            };
            ColorSpace::Indexed {
                base: Rc::new(base),
                hival,
                lookup,
            }
        }
        "Separation" => {
            let sep = arg(1)
                .map(|n| String::from_utf8_lossy(&crate::ops::text_of(&n)).into_owned())
                .unwrap_or_default();
            let alt = parse_space(i, &arg(2).ok_or(err("rangecheck"))?, depth + 1)?;
            ColorSpace::Separation {
                name: sep,
                alt: Rc::new(alt),
                tint: arg(3).ok_or(err("rangecheck"))?,
            }
        }
        "DeviceN" => {
            let n = arg(1)
                .and_then(|a| a.as_array().map(|a| a.len))
                .ok_or(err("typecheck"))?;
            let alt = parse_space(i, &arg(2).ok_or(err("rangecheck"))?, depth + 1)?;
            ColorSpace::DeviceN {
                n: n.max(1),
                alt: Rc::new(alt),
                tint: arg(3).ok_or(err("rangecheck"))?,
            }
        }
        "ICCBased" => {
            let d = arg(1).and_then(|d| d.as_dict().cloned());
            if let Some(alt) = d.as_ref().and_then(|d| d.get_name("Alternate")) {
                parse_space(i, &alt, depth + 1)?
            } else {
                match d.and_then(|d| d.get_name("N")).and_then(|n| n.as_int()) {
                    Some(1) => ColorSpace::Gray,
                    Some(4) => ColorSpace::Cmyk,
                    _ => ColorSpace::Rgb,
                }
            }
        }
        "CIEBasedA" => {
            i.report.unsupported("CIE-based colour (approximated)");
            ColorSpace::Cie(Rc::new(ColorSpace::Gray))
        }
        "CIEBasedABC" | "CIEBasedDEF" | "Lab" => {
            i.report.unsupported("CIE-based colour (approximated)");
            ColorSpace::Cie(Rc::new(ColorSpace::Rgb))
        }
        "CIEBasedDEFG" => {
            i.report.unsupported("CIE-based colour (approximated)");
            ColorSpace::Cie(Rc::new(ColorSpace::Cmyk))
        }
        _ => return Err(err("undefined")),
    })
}

fn setcolor(i: &mut Interp<'_>) -> R {
    if i.gs.uncolored {
        // Drop the operands the colour would have taken.
        let n = match i.top(0).map(|o| o.v.clone()) {
            Ok(V::Dict(_)) => 1 + pattern_base_n(&i.gs.cs),
            _ => i.gs.cs.ncomp(),
        };
        for _ in 0..n.min(i.ostack.len()) {
            i.pop()?;
        }
        return Ok(());
    }
    if let ColorSpace::Pattern(base) = &*i.gs.cs {
        let n = base.as_ref().map_or(0, |b| b.ncomp());
        let pat = i.pop_dict()?;
        let v = crate::graphics::pop_nums(i, n)?;
        i.gs.color = v;
        i.gs.pattern = Some(pat);
        return Ok(());
    }
    let n = i.gs.cs.ncomp();
    let v = crate::graphics::pop_nums(i, n)?;
    i.gs.color = v;
    Ok(())
}

fn pattern_base_n(cs: &ColorSpace) -> usize {
    match cs {
        ColorSpace::Pattern(Some(b)) => b.ncomp(),
        _ => 0,
    }
}

/// The device colour of `comps` in `cs`, running tint transforms and
/// lookup procedures; `None` for the /None separation.
pub fn to_device(
    i: &mut Interp<'_>,
    cs: &ColorSpace,
    comps: &[f64],
    depth: usize,
) -> Result<Option<(Color, Option<String>)>, PsError> {
    if depth > 8 {
        return Err(err("limitcheck"));
    }
    let c = |k: usize| comps.get(k).copied().unwrap_or(0.0).clamp(0.0, 1.0) as f32;
    Ok(Some(match cs {
        ColorSpace::Gray => (Color::Gray(c(0)), None),
        ColorSpace::Rgb => (Color::Rgb([c(0), c(1), c(2)]), None),
        ColorSpace::Cmyk => (Color::Cmyk([c(0), c(1), c(2), c(3)]), None),
        ColorSpace::Cie(b) => return to_device(i, b, comps, depth + 1),
        ColorSpace::Indexed {
            base,
            hival,
            lookup,
        } => {
            let idx = comps
                .first()
                .copied()
                .unwrap_or(0.0)
                .round()
                .clamp(0.0, *hival as f64) as usize;
            let n = base.ncomp();
            let vals: Vec<f64> = match lookup {
                Lookup::Table(t) => (0..n)
                    .map(|k| t.get(idx * n + k).copied().unwrap_or(0) as f64 / 255.0)
                    .collect(),
                Lookup::Proc(p) => {
                    i.push(Obj::int(idx as i32))?;
                    i.call(p.clone())?;
                    crate::graphics::pop_nums(i, n)?
                }
            };
            return to_device(i, base, &vals, depth + 1);
        }
        ColorSpace::Separation { name, alt, tint } => {
            if name == "None" {
                return Ok(None);
            }
            i.push(Obj::real(comps.first().copied().unwrap_or(1.0)))?;
            i.call(tint.clone())?;
            let vals = crate::graphics::pop_nums(i, alt.ncomp())?;
            let (col, _) = to_device(i, alt, &vals, depth + 1)?.ok_or(err("rangecheck"))?;
            let sep = (name != "All").then(|| name.clone());
            (col, sep)
        }
        ColorSpace::DeviceN { n, alt, tint } => {
            for k in 0..*n {
                i.push(Obj::real(comps.get(k).copied().unwrap_or(1.0)))?;
            }
            i.call(tint.clone())?;
            let vals = crate::graphics::pop_nums(i, alt.ncomp())?;
            return to_device(i, alt, &vals, depth + 1);
        }
        ColorSpace::Pattern(_) => (Color::Gray(0.5), None),
    }))
}

/// The paint of the current colour.
pub fn current_paint(i: &mut Interp<'_>) -> Result<PaintKind, PsError> {
    let cs = i.gs.cs.clone();
    if let ColorSpace::Pattern(base) = &*cs {
        let Some(p) = i.gs.pattern.clone() else {
            return Ok(PaintKind::None);
        };
        let under = match base {
            Some(b) => {
                let comps = i.gs.color.clone();
                to_device(i, b, &comps, 0)?.map(|(color, separation)| Paint { color, separation })
            }
            None => None,
        };
        return Ok(PaintKind::Pattern(p, under));
    }
    let comps = i.gs.color.clone();
    Ok(match to_device(i, &cs, &comps, 0)? {
        Some((color, separation)) => PaintKind::Solid(Paint { color, separation }),
        None => PaintKind::None,
    })
}

fn current_device(i: &mut Interp<'_>) -> Result<Color, PsError> {
    Ok(match current_paint(i)? {
        PaintKind::Solid(p) => p.color,
        _ => Color::Gray(0.0),
    })
}
