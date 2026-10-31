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

//! Function dictionaries (PLRM 3.10): sampled (type 0), exponential
//! (type 2) and stitching (type 3), parsed once and evaluated per
//! sample; an array of one-output functions, and a PostScript procedure
//! standing in for a function, are accepted too.

use crate::interp::{err, Interp, PsError};
use crate::object::{Obj, PsDict, V};

pub enum Func {
    Sampled {
        domain: Vec<f64>,
        range: Vec<f64>,
        size: Vec<usize>,
        encode: Vec<f64>,
        decode: Vec<f64>,
        /// Samples normalised to 0..=1, outputs interleaved.
        samples: Vec<f64>,
        n_out: usize,
    },
    Exponential {
        domain: Vec<f64>,
        c0: Vec<f64>,
        c1: Vec<f64>,
        n: f64,
    },
    Stitching {
        domain: Vec<f64>,
        funcs: Vec<Func>,
        bounds: Vec<f64>,
        encode: Vec<f64>,
    },
    Array(Vec<Func>),
    Proc(Obj, usize),
}

fn nums(d: &PsDict, k: &str) -> Option<Vec<f64>> {
    let a = d.get_name(k)?;
    let a = a.as_array()?;
    a.items().iter().map(Obj::as_num).collect()
}

pub fn parse(i: &mut Interp<'_>, o: &Obj, n_out: usize, depth: usize) -> Result<Func, PsError> {
    if depth > 8 {
        return Err(err("limitcheck"));
    }
    match &o.v {
        V::Array(a) if !o.exec => {
            let mut v = Vec::new();
            for f in a.items() {
                v.push(parse(i, &f, 1, depth + 1)?);
            }
            Ok(Func::Array(v))
        }
        V::Dict(d) => parse_dict(i, d, depth),
        _ if o.exec => Ok(Func::Proc(o.clone(), n_out)),
        _ => Err(err("typecheck")),
    }
}

fn parse_dict(i: &mut Interp<'_>, d: &PsDict, depth: usize) -> Result<Func, PsError> {
    let ty = d
        .get_name("FunctionType")
        .and_then(|o| o.as_int())
        .ok_or(err("rangecheck"))?;
    let domain = nums(d, "Domain").unwrap_or_else(|| vec![0.0, 1.0]);
    match ty {
        0 => {
            let size: Vec<usize> = nums(d, "Size")
                .ok_or(err("rangecheck"))?
                .iter()
                .map(|v| (*v as usize).max(1))
                .collect();
            let range = nums(d, "Range").ok_or(err("rangecheck"))?;
            let n_out = range.len() / 2;
            let bits = d
                .get_name("BitsPerSample")
                .and_then(|o| o.as_int())
                .unwrap_or(8) as u32;
            if !matches!(bits, 1 | 2 | 4 | 8 | 12 | 16 | 24 | 32) || n_out == 0 {
                return Err(err("rangecheck"));
            }
            let total: usize = size.iter().product::<usize>().saturating_mul(n_out);
            if total > 1 << 22 {
                return Err(err("limitcheck"));
            }
            let src = d.get_name("DataSource").ok_or(err("undefined"))?;
            let need = (total * bits as usize).div_ceil(8);
            let input = crate::ops::read_input(i, &src, need)?;
            let data = input.bytes();
            let mut samples = Vec::with_capacity(total);
            let max = ((1u64 << bits) - 1) as f64;
            let mut bitpos = 0usize;
            for _ in 0..total {
                let mut v: u64 = 0;
                for _ in 0..bits {
                    let byte = data.get(bitpos / 8).copied().unwrap_or(0);
                    v = (v << 1) | ((byte >> (7 - bitpos % 8)) & 1) as u64;
                    bitpos += 1;
                }
                samples.push(v as f64 / max);
            }
            input.consume(need.min(data.len()));
            let encode = nums(d, "Encode")
                .unwrap_or_else(|| size.iter().flat_map(|s| [0.0, (*s - 1) as f64]).collect());
            let decode = nums(d, "Decode").unwrap_or_else(|| range.clone());
            i.alloc(total * 8)?;
            Ok(Func::Sampled {
                domain,
                range,
                size,
                encode,
                decode,
                samples,
                n_out,
            })
        }
        2 => Ok(Func::Exponential {
            domain,
            c0: nums(d, "C0").unwrap_or_else(|| vec![0.0]),
            c1: nums(d, "C1").unwrap_or_else(|| vec![1.0]),
            n: d.get_name("N").and_then(|o| o.as_num()).unwrap_or(1.0),
        }),
        3 => {
            let fa = d.get_name("Functions").ok_or(err("undefined"))?;
            let fa = fa.as_array().ok_or(err("typecheck"))?.clone();
            let mut funcs = Vec::new();
            for f in fa.items() {
                funcs.push(parse(i, &f, 0, depth + 1)?);
            }
            Ok(Func::Stitching {
                domain,
                bounds: nums(d, "Bounds").unwrap_or_default(),
                encode: nums(d, "Encode")
                    .unwrap_or_else(|| (0..funcs.len()).flat_map(|_| [0.0, 1.0]).collect()),
                funcs,
            })
        }
        _ => {
            i.report.unsupported("function type 4");
            Err(err("rangecheck"))
        }
    }
}

fn interp(x: f64, x0: f64, x1: f64, y0: f64, y1: f64) -> f64 {
    if x1 == x0 {
        y0
    } else {
        y0 + (x - x0) * (y1 - y0) / (x1 - x0)
    }
}

impl Func {
    pub fn eval(&self, i: &mut Interp<'_>, x: &[f64]) -> Result<Vec<f64>, PsError> {
        Ok(match self {
            Func::Sampled {
                domain,
                range,
                size,
                encode,
                decode,
                samples,
                n_out,
            } => {
                let m = size.len();
                // Each input to a fractional sample index.
                let mut idx = Vec::with_capacity(m);
                for k in 0..m {
                    let (d0, d1) = (
                        domain.get(2 * k).copied().unwrap_or(0.0),
                        domain.get(2 * k + 1).copied().unwrap_or(1.0),
                    );
                    let xk = x
                        .get(k)
                        .copied()
                        .unwrap_or(0.0)
                        .clamp(d0.min(d1), d0.max(d1));
                    let e = interp(xk, d0, d1, encode[2 * k], encode[2 * k + 1]);
                    idx.push(e.clamp(0.0, (size[k] - 1) as f64));
                }
                let mut out = vec![0.0; *n_out];
                // Multilinear interpolation over the 2^m corners.
                for corner in 0..(1usize << m) {
                    let mut w = 1.0;
                    let mut off = 0usize;
                    let mut stride = 1usize;
                    for k in 0..m {
                        let lo = idx[k].floor();
                        let f = idx[k] - lo;
                        let hi_bit = corner >> k & 1 == 1;
                        let pos = if hi_bit {
                            (lo as usize + 1).min(size[k] - 1)
                        } else {
                            lo as usize
                        };
                        w *= if hi_bit { f } else { 1.0 - f };
                        off += pos * stride;
                        stride *= size[k];
                    }
                    if w == 0.0 {
                        continue;
                    }
                    for (j, o) in out.iter_mut().enumerate() {
                        *o += w * samples.get(off * n_out + j).copied().unwrap_or(0.0);
                    }
                }
                for (j, o) in out.iter_mut().enumerate() {
                    let v = interp(*o, 0.0, 1.0, decode[2 * j], decode[2 * j + 1]);
                    *o = v.clamp(
                        range[2 * j].min(range[2 * j + 1]),
                        range[2 * j].max(range[2 * j + 1]),
                    );
                }
                out
            }
            Func::Exponential { domain, c0, c1, n } => {
                let t = x
                    .first()
                    .copied()
                    .unwrap_or(0.0)
                    .clamp(domain[0], domain[1]);
                let p = t.powf(*n);
                c0.iter()
                    .zip(c1.iter())
                    .map(|(a, b)| a + p * (b - a))
                    .collect()
            }
            Func::Stitching {
                domain,
                funcs,
                bounds,
                encode,
            } => {
                let t = x
                    .first()
                    .copied()
                    .unwrap_or(0.0)
                    .clamp(domain[0], domain[1]);
                let k = bounds
                    .iter()
                    .take_while(|b| t >= **b)
                    .count()
                    .min(funcs.len().saturating_sub(1));
                let lo = if k == 0 { domain[0] } else { bounds[k - 1] };
                let hi = if k < bounds.len() {
                    bounds[k]
                } else {
                    domain[1]
                };
                let e = interp(t, lo, hi, encode[2 * k], encode[2 * k + 1]);
                match funcs.get(k) {
                    Some(f) => f.eval(i, &[e])?,
                    None => vec![0.0],
                }
            }
            Func::Array(fs) => {
                let mut out = Vec::new();
                for f in fs {
                    out.extend(f.eval(i, x)?);
                }
                out
            }
            Func::Proc(p, n) => {
                for v in x {
                    i.push(Obj::real(*v))?;
                }
                i.call(p.clone())?;
                crate::graphics::pop_nums(i, (*n).max(1))?
            }
        })
    }
}
