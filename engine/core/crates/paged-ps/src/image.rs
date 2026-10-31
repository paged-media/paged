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

//! Sampled images (PLRM 4.10): `image`, `colorimage` and `imagemask`
//! in their operand and dictionary forms, with data from a string, a
//! file (through any decode filter) or procedures, one source or one per
//! component. Samples are decoded, converted to a device colour space
//! (through lookups and tint transforms) and drawn as 8-bit pixels.

use std::collections::HashMap;
use std::rc::Rc;

use crate::art::{Color, Element, Image, Pixels};
use crate::color::{to_device, ColorSpace};
use crate::geom::{Affine, Ps};
use crate::interp::{err, matrix_of, Interp, OpDef, PsError, R};
use crate::object::{Obj, PsDict, V};

pub const OPS: &[OpDef] = &[
    OpDef {
        name: "image",
        f: image,
    },
    OpDef {
        name: "colorimage",
        f: colorimage,
    },
    OpDef {
        name: "imagemask",
        f: imagemask,
    },
];

const MAX_PIXELS: usize = 1 << 26;

struct Spec {
    w: usize,
    h: usize,
    bpc: u32,
    matrix: Affine,
    sources: Vec<Obj>,
    decode: Vec<f64>,
    mask_color: Option<Vec<f64>>,
}

fn dict_spec(i: &Interp<'_>, d: &PsDict, ncomp: usize, cs: &ColorSpace) -> Result<Spec, PsError> {
    let int = |k: &str| d.get_name(k).and_then(|o| o.as_int());
    let w =
        usize::try_from(int("Width").ok_or(err("undefined"))?).map_err(|_| err("rangecheck"))?;
    let h =
        usize::try_from(int("Height").ok_or(err("undefined"))?).map_err(|_| err("rangecheck"))?;
    let bpc = int("BitsPerComponent").unwrap_or(1) as u32;
    let matrix = matrix_of(
        d.get_name("ImageMatrix")
            .and_then(|o| o.as_array().cloned())
            .as_ref()
            .ok_or(err("undefined"))?,
    )?;
    let src = d.get_name("DataSource").ok_or(err("undefined"))?;
    let multi = d
        .get_name("MultipleDataSources")
        .and_then(|o| o.as_bool())
        .unwrap_or(false);
    let sources = if multi {
        src.as_array().ok_or(err("typecheck"))?.items()
    } else {
        vec![src]
    };
    let decode: Vec<f64> = match d.get_name("Decode").and_then(|o| o.as_array().cloned()) {
        Some(a) => a.items().iter().filter_map(Obj::as_num).collect(),
        None => (0..ncomp)
            .flat_map(|k| [0.0, cs.decode_max(k, bpc)])
            .collect(),
    };
    let mask_color = d
        .get_name("MaskColor")
        .and_then(|o| o.as_array().cloned())
        .map(|a| a.items().iter().filter_map(Obj::as_num).collect());
    let _ = i;
    Ok(Spec {
        w,
        h,
        bpc,
        matrix,
        sources,
        decode,
        mask_color,
    })
}

fn image(i: &mut Interp<'_>) -> R {
    if let V::Dict(_) = i.top(0)?.v {
        let d = i.pop_dict()?;
        let ty = d
            .get_name("ImageType")
            .and_then(|o| o.as_int())
            .unwrap_or(1);
        if ty != 1 && ty != 4 {
            i.report.unsupported(&format!("image type {ty}"));
            return Err(err("rangecheck"));
        }
        let cs = i.gs.cs.clone();
        let spec = dict_spec(i, &d, cs.ncomp(), &cs)?;
        return draw(i, spec, cs);
    }
    let src = i.pop()?;
    let m = i.pop_matrix()?;
    let bpc = i.pop_int()? as u32;
    let h = i.pop_usize()?;
    let w = i.pop_usize()?;
    let spec = Spec {
        w,
        h,
        bpc,
        matrix: m,
        sources: vec![src],
        decode: vec![0.0, 1.0],
        mask_color: None,
    };
    draw(i, spec, Rc::new(ColorSpace::Gray))
}

fn colorimage(i: &mut Interp<'_>) -> R {
    let ncomp = i.pop_usize()?;
    let multi = i.pop_bool()?;
    let cs = match ncomp {
        1 => ColorSpace::Gray,
        3 => ColorSpace::Rgb,
        4 => ColorSpace::Cmyk,
        _ => return Err(err("rangecheck")),
    };
    let mut sources = Vec::new();
    for _ in 0..if multi { ncomp } else { 1 } {
        sources.push(i.pop()?);
    }
    sources.reverse();
    let m = i.pop_matrix()?;
    let bpc = i.pop_int()? as u32;
    let h = i.pop_usize()?;
    let w = i.pop_usize()?;
    let spec = Spec {
        w,
        h,
        bpc,
        matrix: m,
        sources,
        decode: (0..ncomp).flat_map(|_| [0.0, 1.0]).collect(),
        mask_color: None,
    };
    draw(i, spec, Rc::new(cs))
}

fn imagemask(i: &mut Interp<'_>) -> R {
    let (spec, paint_ones) = if let V::Dict(_) = i.top(0)?.v {
        let d = i.pop_dict()?;
        let spec = dict_spec(i, &d, 1, &ColorSpace::Gray)?;
        // Decode [0 1] paints the 0 samples; [1 0] the 1 samples.
        let ones = spec.decode.first().copied().unwrap_or(0.0) > 0.5;
        (spec, ones)
    } else {
        let src = i.pop()?;
        let m = i.pop_matrix()?;
        let polarity = i.pop_bool()?;
        let h = i.pop_usize()?;
        let w = i.pop_usize()?;
        (
            Spec {
                w,
                h,
                bpc: 1,
                matrix: m,
                sources: vec![src],
                decode: vec![0.0, 1.0],
                mask_color: None,
            },
            polarity,
        )
    };
    if spec.w == 0 || spec.h == 0 {
        return Ok(());
    }
    if spec.w.saturating_mul(spec.h) > MAX_PIXELS {
        return Err(err("limitcheck"));
    }
    let row = spec.w.div_ceil(8);
    let data = read_sources(i, &spec.sources, row * spec.h)?;
    let data = &data[0];
    let paint = match crate::color::current_paint(i)? {
        crate::color::PaintKind::Solid(p) => p,
        crate::color::PaintKind::Pattern(_, Some(p)) => p,
        crate::color::PaintKind::Pattern(_, None) => {
            i.report.unsupported("imagemask with a pattern");
            crate::art::Paint {
                color: Color::Gray(0.5),
                separation: None,
            }
        }
        crate::color::PaintKind::None => return Ok(()),
    };
    if i.suppress > 0 {
        return Ok(());
    }
    let n = spec.w * spec.h;
    i.alloc(n * 5)?;
    let mut alpha = Vec::with_capacity(n);
    for y in 0..spec.h {
        for x in 0..spec.w {
            let byte = data.get(y * row + x / 8).copied().unwrap_or(0);
            let bit = (byte >> (7 - x % 8)) & 1 == 1;
            alpha.push(if bit == paint_ones { 255 } else { 0 });
        }
    }
    let pixels = solid_pixels(&paint.color, n);
    let transform = image_transform(i, &spec)?;
    i.sync_clips()?;
    i.emit(Element::Image(Image {
        width: spec.w as u32,
        height: spec.h as u32,
        pixels,
        alpha: Some(alpha),
        transform,
    }))
}

fn solid_pixels(c: &Color, n: usize) -> Pixels {
    let b = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    match *c {
        Color::Gray(g) => Pixels::Gray(vec![b(g); n]),
        Color::Rgb(v) => Pixels::Rgb(v.iter().map(|x| b(*x)).cycle().take(n * 3).collect()),
        Color::Cmyk(v) => Pixels::Cmyk(v.iter().map(|x| b(*x)).cycle().take(n * 4).collect()),
    }
}

fn image_transform(i: &Interp<'_>, spec: &Spec) -> Result<Affine, PsError> {
    let inv = spec.matrix.invert().ok_or(err("undefinedresult"))?;
    Ok(Affine::scale_non_uniform(spec.w as f64, spec.h as f64)
        .then(&inv)
        .then(&i.gs.ctm))
}

/// `need` bytes from each source. Procedures are called in turn, as
/// the image operators call them, so sources reading one file in
/// interleaved rows see their own rows; a string source is used again
/// as often as needed.
fn read_sources(i: &mut Interp<'_>, sources: &[Obj], need: usize) -> Result<Vec<Vec<u8>>, PsError> {
    i.alloc(need * sources.len())?;
    let mut out: Vec<Vec<u8>> = vec![Vec::with_capacity(need); sources.len()];
    let mut done = vec![false; sources.len()];
    loop {
        let mut progress = false;
        for (k, src) in sources.iter().enumerate() {
            if done[k] || out[k].len() >= need {
                done[k] = true;
                continue;
            }
            match &src.v {
                V::File(f) => {
                    let mut f = f.borrow_mut();
                    if let Some(rest) = f.rest() {
                        let take = (need - out[k].len()).min(rest.len());
                        out[k].extend_from_slice(&rest[..take]);
                        f.advance(take);
                    }
                    while out[k].len() < need {
                        match f.read() {
                            Some(b) => out[k].push(b),
                            None => break,
                        }
                    }
                    done[k] = true;
                }
                V::Str(s) if !src.exec => {
                    let b = s.bytes();
                    if b.is_empty() {
                        done[k] = true;
                    } else {
                        while out[k].len() < need {
                            let take = (need - out[k].len()).min(b.len());
                            out[k].extend_from_slice(&b[..take]);
                        }
                    }
                }
                _ if src.exec => {
                    i.call(src.clone())?;
                    let s = i.pop_str()?;
                    if s.len == 0 {
                        done[k] = true;
                    } else {
                        out[k].extend_from_slice(&s.bytes());
                        progress = true;
                    }
                }
                _ => return Err(err("typecheck")),
            }
        }
        if !progress || done.iter().all(|d| *d) {
            break;
        }
    }
    for o in &mut out {
        o.resize(need, 0);
    }
    Ok(out)
}

fn draw(i: &mut Interp<'_>, spec: Spec, cs: Rc<ColorSpace>) -> R {
    let ncomp = cs.ncomp();
    if spec.w == 0 || spec.h == 0 {
        return Ok(());
    }
    if !matches!(spec.bpc, 1 | 2 | 4 | 8 | 12 | 16) {
        return Err(err("rangecheck"));
    }
    if spec.w.saturating_mul(spec.h) > MAX_PIXELS {
        return Err(err("limitcheck"));
    }
    if matches!(&*cs, ColorSpace::Pattern(_)) {
        return Err(err("typecheck"));
    }
    let per_source = if spec.sources.len() > 1 { 1 } else { ncomp };
    let row = (spec.w * per_source * spec.bpc as usize).div_ceil(8);
    let data = read_sources(i, &spec.sources, row * spec.h)?;
    if i.suppress > 0 {
        return Ok(());
    }
    let n = spec.w * spec.h;
    let max = ((1u64 << spec.bpc) - 1) as f64;
    let sample = |src: &[u8], idx: usize| -> u32 {
        let bpc = spec.bpc as usize;
        let bit = idx * bpc;
        match bpc {
            8 => src.get(idx).copied().unwrap_or(0) as u32,
            16 => {
                let b = idx * 2;
                ((src.get(b).copied().unwrap_or(0) as u32) << 8)
                    | src.get(b + 1).copied().unwrap_or(0) as u32
            }
            _ => {
                let mut v = 0u32;
                for k in 0..bpc {
                    let byte = src.get((bit + k) / 8).copied().unwrap_or(0);
                    v = (v << 1) | ((byte >> (7 - (bit + k) % 8)) & 1) as u32;
                }
                v
            }
        }
    };
    let raw = |x: usize, y: usize, c: usize| -> u32 {
        if spec.sources.len() > 1 {
            let src = &data[c.min(data.len() - 1)];
            let rowbytes = &src[(y * row).min(src.len())..((y + 1) * row).min(src.len())];
            sample(rowbytes, x)
        } else {
            let src = &data[0];
            let rowbytes = &src[(y * row).min(src.len())..((y + 1) * row).min(src.len())];
            sample(rowbytes, x * ncomp + c)
        }
    };
    let direct = spec.bpc == 8
        && matches!(&*cs, ColorSpace::Gray | ColorSpace::Rgb | ColorSpace::Cmyk)
        && spec.decode.chunks(2).all(|d| d == [0.0, 1.0])
        && spec.mask_color.is_none();
    i.alloc(n * (ncomp + 1))?;
    let pixels = if direct {
        let mut v = Vec::with_capacity(n * ncomp);
        for y in 0..spec.h {
            for x in 0..spec.w {
                for c in 0..ncomp {
                    v.push(raw(x, y, c) as u8);
                }
            }
        }
        match &*cs {
            ColorSpace::Gray => Pixels::Gray(v),
            ColorSpace::Rgb => Pixels::Rgb(v),
            _ => Pixels::Cmyk(v),
        }
    } else {
        let mut cache: HashMap<u64, Color> = HashMap::new();
        let mut buf: Option<Pixels> = None;
        let b8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        for y in 0..spec.h {
            for x in 0..spec.w {
                let mut key = 0u64;
                let mut comps = Vec::with_capacity(ncomp);
                for c in 0..ncomp {
                    let r = raw(x, y, c);
                    key = key.wrapping_mul(65599).wrapping_add(r as u64 + 1);
                    let (d0, d1) = (
                        spec.decode.get(2 * c).copied().unwrap_or(0.0),
                        spec.decode.get(2 * c + 1).copied().unwrap_or(1.0),
                    );
                    comps.push(d0 + r as f64 * (d1 - d0) / max);
                }
                let color = match cache.get(&key) {
                    Some(c) => *c,
                    None => {
                        let c = to_device(i, &cs, &comps, 0)?.map_or(Color::Gray(1.0), |(c, _)| c);
                        if cache.len() < 1 << 16 {
                            cache.insert(key, c);
                        }
                        c
                    }
                };
                let b = buf.get_or_insert_with(|| match color {
                    Color::Gray(_) => Pixels::Gray(Vec::with_capacity(n)),
                    Color::Rgb(_) => Pixels::Rgb(Vec::with_capacity(n * 3)),
                    Color::Cmyk(_) => Pixels::Cmyk(Vec::with_capacity(n * 4)),
                });
                match (b, color) {
                    (Pixels::Gray(v), Color::Gray(g)) => v.push(b8(g)),
                    (Pixels::Rgb(v), Color::Rgb(c)) => v.extend(c.iter().map(|x| b8(*x))),
                    (Pixels::Cmyk(v), Color::Cmyk(c)) => v.extend(c.iter().map(|x| b8(*x))),
                    (Pixels::Gray(v), c) => v.push(b8(c.to_srgb()[1])),
                    (Pixels::Rgb(v), c) => v.extend(c.to_srgb().iter().map(|x| b8(*x))),
                    (Pixels::Cmyk(v), c) => {
                        let [r, g, bb] = c.to_srgb();
                        let (cc, m, yy) = (1.0 - r, 1.0 - g, 1.0 - bb);
                        let k = cc.min(m).min(yy);
                        v.extend([cc - k, m - k, yy - k, k].iter().map(|x| b8(*x)));
                    }
                }
            }
        }
        buf.unwrap_or(Pixels::Gray(vec![0; n]))
    };
    // ImageType 4: samples whose raw values fall in the MaskColor ranges
    // are not painted.
    let alpha = spec.mask_color.as_ref().map(|mc| {
        let mut a = Vec::with_capacity(n);
        for y in 0..spec.h {
            for x in 0..spec.w {
                let masked = (0..ncomp).all(|c| {
                    let r = raw(x, y, c) as f64;
                    if mc.len() == ncomp {
                        r == mc[c]
                    } else {
                        r >= mc.get(2 * c).copied().unwrap_or(0.0)
                            && r <= mc.get(2 * c + 1).copied().unwrap_or(0.0)
                    }
                });
                a.push(if masked { 0 } else { 255 });
            }
        }
        a
    });
    let transform = image_transform(i, &spec)?;
    i.sync_clips()?;
    i.emit(Element::Image(Image {
        width: spec.w as u32,
        height: spec.h as u32,
        pixels,
        alpha,
        transform,
    }))
}
