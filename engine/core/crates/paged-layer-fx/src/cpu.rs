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

//! The CPU device: every kernel the evaluator dispatches, run by its
//! shipped scalar twin, each output stored as the rgba16float texel the
//! GPU stores (so the CPU agrees with the GPU within the kernels'
//! declared tolerances).

use std::sync::Arc;

use half::f16;
use paged_kernels::compose_twin::{composite, from_kernel_id};
use paged_kernels::def::KernelDef;
use paged_kernels::families::compose::ComposeParams;
use paged_kernels::families::{arithmetic, band, gen, minmax, style};
use paged_kernels::Px;

use crate::draw::{Frame, FxDevice, FxError, Tex, Textures};

/// A texture: `w × h` premultiplied RGBA, row-major, every value one an
/// rgba16float texel holds.
#[derive(Debug, Clone, PartialEq)]
pub struct CpuTex {
    pub w: u32,
    pub h: u32,
    pub px: Arc<Vec<[f32; 4]>>,
}

impl CpuTex {
    /// A texture of these texels, stored as f16.
    pub fn new(w: u32, h: u32, px: Vec<[f32; 4]>) -> CpuTex {
        CpuTex {
            w,
            h,
            px: Arc::new(px.into_iter().map(q4).collect()),
        }
    }
}

/// The CPU device over one frame.
pub struct CpuDevice {
    frame: Frame,
    slab: Vec<CpuTex>,
}

impl CpuDevice {
    pub fn new(frame: Frame) -> CpuDevice {
        CpuDevice {
            frame,
            slab: Vec::new(),
        }
    }
}

impl Textures for CpuDevice {
    type Native = CpuTex;
    fn put(&mut self, t: CpuTex) -> Tex {
        self.slab.push(t);
        Tex(self.slab.len() as u32 - 1)
    }
    fn get(&self, t: Tex) -> &CpuTex {
        &self.slab[t.0 as usize]
    }
}

fn unsupported(id: &str) -> FxError {
    FxError(format!("the kernel `{id}` has no CPU twin"))
}

fn q(v: f32) -> f32 {
    f16::from_f32(v).to_f32()
}

fn q4(p: [f32; 4]) -> [f32; 4] {
    p.map(q)
}

fn pod<T: bytemuck::Pod>(params: &[u8]) -> T {
    bytemuck::pod_read_unaligned(&params[..std::mem::size_of::<T>()])
}

fn per_texel(a: &[[f32; 4]], b: Option<&[[f32; 4]]>, f: impl Fn(Px, Px) -> Px) -> Vec<[f32; 4]> {
    a.iter()
        .enumerate()
        .map(|(i, &x)| f(Px(x), Px(b.map_or([0.0; 4], |b| b[i]))).0)
        .collect()
}

fn coords(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 4]) -> Vec<[f32; 4]> {
    (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| f(x, y))
        .collect()
}

impl FxDevice for CpuDevice {
    fn frame(&self) -> Frame {
        self.frame
    }

    fn run(
        &mut self,
        def: &'static KernelDef,
        inputs: &[&Tex],
        params: &[u8],
        mask: Option<&Tex>,
    ) -> Result<Tex, FxError> {
        use style::reference as s;
        let (w, h) = (self.frame.w, self.frame.h);
        let input = |i: usize| inputs.get(i).map(|t| self.get(**t).clone());
        let first = input(0).ok_or_else(|| unsupported(def.id))?;
        let second = input(1);
        let mask = mask.map(|m| self.get(*m).clone());
        let a: &[[f32; 4]] = &first.px;
        let b: Option<&[[f32; 4]]> = second.as_ref().map(|t| t.px.as_slice());
        let out: Vec<[f32; 4]> = match def.id {
            "style.shift" => s::shift(a, w, h, &pod(params)),
            "style.blur_h" => s::blur(a, w, h, &pod(params), false),
            "style.blur_v" => s::blur(a, w, h, &pod(params), true),
            "style.jfa_seed" => s::jfa_seed(a, &pod(params)),
            "style.jfa_step" => s::jfa_step(a, w, h, &pod(params)),
            "style.distance" => s::distance(a, b.unwrap_or(a), w, h),
            "style.ramp" => s::ramp(a, &pod(params)),
            "style.contour" => s::contour(a, &pod(params)),
            "style.colorize" => s::colorize(a, w, &pod(params)),
            "style.bevel" => s::bevel(a, w, h, &pod(params)),
            "style.split" => s::split(a, &pod(params)),
            "style.absdiff" => s::absdiff(a, b.unwrap_or(a)),
            "math.max" => {
                let p: minmax::MathMaxParams = pod(params);
                per_texel(a, b, |x, y| minmax::math_max(x, y, &p))
            }
            "math.max_const" => {
                let p: minmax::MathMaxConstParams = pod(params);
                per_texel(a, None, |x, y| minmax::math_max_const(x, y, &p))
            }
            "math.clamp" => {
                let p: minmax::MathClampParams = pod(params);
                per_texel(a, None, |x, y| minmax::math_clamp(x, y, &p))
            }
            "math.mul" => {
                let p: arithmetic::MathMulParams = pod(params);
                per_texel(a, b, |x, y| arithmetic::math_mul(x, y, &p))
            }
            "math.div" => {
                let p: arithmetic::MathDivParams = pod(params);
                per_texel(a, b, |x, y| arithmetic::math_div(x, y, &p))
            }
            "band.take" => {
                let p: band::BandTakeParams = pod(params);
                per_texel(a, b, |x, y| band::band_take(x, y, &p))
            }
            "band.broadcast_alpha" => {
                let p: band::BandBroadcastAlphaParams = pod(params);
                per_texel(a, None, |x, y| band::band_broadcast_alpha(x, y, &p))
            }
            "gen.solid" => {
                let p: gen::GenSolidParams = pod(params);
                vec![gen::reference::solid(&p); a.len()]
            }
            "gen.linear_gradient" => {
                let p = pod(params);
                coords(w, h, |x, y| gen::reference::linear(x, y, &p))
            }
            "gen.radial_gradient" => {
                let p = pod(params);
                coords(w, h, |x, y| gen::reference::radial(x, y, &p))
            }
            "gen.angular_gradient" => {
                let p = pod(params);
                coords(w, h, |x, y| gen::reference::angular(x, y, &p))
            }
            "gen.reflected_gradient" => {
                let p = pod(params);
                coords(w, h, |x, y| gen::reference::reflected(x, y, &p))
            }
            "gen.diamond_gradient" => {
                let p = pod(params);
                coords(w, h, |x, y| gen::reference::diamond(x, y, &p))
            }
            "gen.pattern" => {
                let p = pod(params);
                let tile = second.as_ref().ok_or_else(|| unsupported("gen.pattern"))?;
                coords(w, h, |x, y| {
                    gen::reference::pattern(
                        x,
                        y,
                        a[(y * w + x) as usize],
                        &tile.px,
                        tile.w,
                        tile.h,
                        &p,
                    )
                })
            }
            id => {
                let blend = from_kernel_id(id).ok_or_else(|| unsupported(def.id))?;
                let p: ComposeParams = pod(params);
                let b = b.ok_or_else(|| unsupported(def.id))?;
                a.iter()
                    .zip(b)
                    .map(|(&x, &y)| composite(Px(x), Px(y), p.opacity, blend).0)
                    .collect()
            }
        };
        // The ABI's mask epilogue: `mix(in0, result, m)`.
        let out = match mask {
            None => out,
            Some(m) => out
                .into_iter()
                .zip(a)
                .zip(m.px.iter())
                .map(|((r, &x), m)| std::array::from_fn(|c| x[c] * (1.0 - m[0]) + r[c] * m[0]))
                .collect(),
        };
        Ok(self.put(CpuTex::new(w, h, out)))
    }

    fn zeros(&mut self) -> Tex {
        let (w, h) = (self.frame.w, self.frame.h);
        self.put(CpuTex {
            w,
            h,
            px: Arc::new(vec![[0.0; 4]; w as usize * h as usize]),
        })
    }

    fn upload(&mut self, w: u32, h: u32, f16_rgba: &[u8]) -> Tex {
        let px = f16_rgba
            .as_chunks::<8>()
            .0
            .iter()
            .map(|t| std::array::from_fn(|c| f16::from_le_bytes([t[c * 2], t[c * 2 + 1]]).to_f32()))
            .collect();
        self.put(CpuTex {
            w,
            h,
            px: Arc::new(px),
        })
    }
}
