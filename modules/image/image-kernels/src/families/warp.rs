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

//! WARP family (WP5.10): the ENVELOPE warp — a raster bent through a
//! bicubic Bézier patch, the backward sampler of Photoshop-style Warp
//! Text on a type layer (and of any 4×4 mesh warp later).
//!
//! The mesh maths is one definition for every consumer: `paged-warp`'s
//! `envelope` module builds the sixteen control points from a warp style
//! and maps points forward; this kernel inverts the same patch per texel.
//!
//! # Backward sampling of a patch
//!
//! The forward map `P(u, v) = Σ B_r(v) B_c(u) C[r][c]` (cubic Bernstein
//! basis, `C` row-major in the params, OUTPUT pixel coordinates) sends the
//! unit square onto the warped shape. For each output texel centre `p`
//! the kernel solves `P(u, v) = p`:
//!
//! 1. SEED: the nearest of the 9 × 9 grid nodes `(k/8, i/8)`;
//! 2. NEWTON: ten steps on the 2×2 Jacobian, `(u, v)` kept within
//!    `[−0.25, 1.25]` (a point just past an edge still converges, so the
//!    edge is antialiased against the transparent outside of the source
//!    instead of being cut hard);
//! 3. a texel whose solve does not land within half a pixel of `p` maps
//!    to no point of the patch and is TRANSPARENT.
//!
//! The source point is `(u · src_w, v · src_h)` in `in0`'s pixels,
//! sampled bilinearly with transparent taps outside the image. The caller
//! hands ASSOCIATED alpha, so interpolating against transparent black is
//! exact (Heckbert, "Fundamentals of Texture Mapping and Image Warping",
//! 1989, §2: inverse mapping; Newton inversion of a parametric patch is
//! standard numerical analysis). `in0` is the source window at its own
//! size; the output is the warped extent — `image_gpu`'s windowed lane.
//! The mask is unused (a warp of a whole layer).

use crate::{KernelClass, KernelDef, ParamField, ParamsLayout, Tolerance};

/// Envelope-warp params: the sixteen control points `[x0, y0, x1, y1, …]`
/// (row-major, row = v), in OUTPUT pixel coordinates, and the source
/// window's size.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, ::bytemuck::Pod, ::bytemuck::Zeroable)]
pub struct WarpMeshParams {
    pub c: [f32; 32],
    pub src_w: f32,
    pub src_h: f32,
    pub _pad0: u32,
    pub _abi_pad: u32,
}

impl WarpMeshParams {
    /// From a `paged-warp` mesh already in output pixel coordinates.
    pub fn new(mesh: &[[f64; 2]; 16], src_w: u32, src_h: u32) -> Self {
        let mut c = [0.0f32; 32];
        for (i, p) in mesh.iter().enumerate() {
            c[2 * i] = p[0] as f32;
            c[2 * i + 1] = p[1] as f32;
        }
        Self {
            c,
            src_w: src_w as f32,
            src_h: src_h as f32,
            _pad0: 0,
            _abi_pad: 0,
        }
    }

    /// The identity: the patch is the source rectangle itself, so every
    /// texel reads its own centre.
    pub fn identity(w: u32, h: u32) -> Self {
        let mut mesh = [[0.0f64; 2]; 16];
        for r in 0..4 {
            for c in 0..4 {
                mesh[r * 4 + c] = [f64::from(w) * c as f64 / 3.0, f64::from(h) * r as f64 / 3.0];
            }
        }
        Self::new(&mesh, w, h)
    }

    pub fn as_bytes(&self) -> &[u8] {
        ::bytemuck::bytes_of(self)
    }
}

const WARP_MESH_FIELDS: &[ParamField] = &[
    ParamField {
        name: "c0x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c0y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c1x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c1y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c2x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c2y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c3x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c3y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c4x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c4y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c5x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c5y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c6x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c6y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c7x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c7y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c8x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c8y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c9x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c9y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c10x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c10y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c11x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c11y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c12x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c12y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c13x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c13y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c14x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c14y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c15x",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "c15y",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "src_w",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "src_h",
        wgsl_ty: "f32",
    },
    ParamField {
        name: "_pad0",
        wgsl_ty: "u32",
    },
];

/// Backward-mapped envelope (bicubic Bézier patch) warp, bilinear,
/// transparent outside the source. The Newton solve runs in f32 on both
/// lanes and the GPU may contract it into FMAs, which moves the solved
/// point by a few thousandths of a pixel — absorbed by the f16 output at
/// the rotation's `ChannelEpsF16(4)`.
pub static GEOM_WARP_MESH: KernelDef = KernelDef {
    id: "geom.warp_mesh",
    class: KernelClass::Resample { support: 1.0 },
    inputs: 1,
    params: ParamsLayout {
        size: ::core::mem::size_of::<WarpMeshParams>(),
        fields: WARP_MESH_FIELDS,
    },
    wgsl: GEOM_WARP_MESH_WGSL,
    module: true,
    mip_exact: false,
    gpu_tolerance: Tolerance::ChannelEpsF16(4),
};

const GEOM_WARP_MESH_WGSL: &str = "\
// paged.image kernel `geom.warp_mesh` — handwritten under ABI v1.1.
// AGPL-3.0-only OR LicenseRef-PMEL; (c) And The Next GmbH.

struct Params {
    c0x: f32,
    c0y: f32,
    c1x: f32,
    c1y: f32,
    c2x: f32,
    c2y: f32,
    c3x: f32,
    c3y: f32,
    c4x: f32,
    c4y: f32,
    c5x: f32,
    c5y: f32,
    c6x: f32,
    c6y: f32,
    c7x: f32,
    c7y: f32,
    c8x: f32,
    c8y: f32,
    c9x: f32,
    c9y: f32,
    c10x: f32,
    c10y: f32,
    c11x: f32,
    c11y: f32,
    c12x: f32,
    c12y: f32,
    c13x: f32,
    c13y: f32,
    c14x: f32,
    c14y: f32,
    c15x: f32,
    c15y: f32,
    src_w: f32,
    src_h: f32,
    _pad0: u32,
    _abi_pad: u32,
}

@group(0) @binding(0) var in0 : texture_2d<f32>;
@group(1) @binding(0) var<uniform> params : Params;
@group(2) @binding(0) var mask : texture_2d<f32>;
@group(3) @binding(0) var outp : texture_storage_2d<rgba16float, write>;

fn bern(t: f32) -> vec4<f32> {
    let s = 1.0 - t;
    return vec4<f32>(s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t);
}

fn bern_d(t: f32) -> vec4<f32> {
    let s = 1.0 - t;
    return vec4<f32>(
        -3.0 * s * s,
        3.0 * s * s - 6.0 * s * t,
        6.0 * s * t - 3.0 * t * t,
        3.0 * t * t,
    );
}

fn tap(p: vec2<i32>, dims: vec2<i32>) -> vec4<f32> {
    if (p.x < 0 || p.y < 0 || p.x >= dims.x || p.y >= dims.y) {
        return vec4<f32>(0.0);
    }
    return textureLoad(in0, p, 0);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
    let dims = textureDimensions(outp);
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let xy = vec2<i32>(i32(gid.x), i32(gid.y));
    let wdims = vec2<i32>(textureDimensions(in0));
    var c = array<vec2<f32>, 16>(
        vec2<f32>(params.c0x, params.c0y),
        vec2<f32>(params.c1x, params.c1y),
        vec2<f32>(params.c2x, params.c2y),
        vec2<f32>(params.c3x, params.c3y),
        vec2<f32>(params.c4x, params.c4y),
        vec2<f32>(params.c5x, params.c5y),
        vec2<f32>(params.c6x, params.c6y),
        vec2<f32>(params.c7x, params.c7y),
        vec2<f32>(params.c8x, params.c8y),
        vec2<f32>(params.c9x, params.c9y),
        vec2<f32>(params.c10x, params.c10y),
        vec2<f32>(params.c11x, params.c11y),
        vec2<f32>(params.c12x, params.c12y),
        vec2<f32>(params.c13x, params.c13y),
        vec2<f32>(params.c14x, params.c14y),
        vec2<f32>(params.c15x, params.c15y)
    );
    let p = vec2<f32>(f32(xy.x) + 0.5, f32(xy.y) + 0.5);

    // 1. Seed: the nearest node of a 9 x 9 grid.
    var best = vec2<f32>(0.5, 0.5);
    var best_d = 3.0e38;
    for (var i = 0; i <= 8; i = i + 1) {
        let bv = bern(f32(i) / 8.0);
        for (var k = 0; k <= 8; k = k + 1) {
            let bu = bern(f32(k) / 8.0);
            var q = vec2<f32>(0.0, 0.0);
            for (var r = 0; r < 4; r = r + 1) {
                for (var s = 0; s < 4; s = s + 1) {
                    q = q + c[r * 4 + s] * (bv[r] * bu[s]);
                }
            }
            let e = q - p;
            let d = e.x * e.x + e.y * e.y;
            if (d < best_d) {
                best_d = d;
                best = vec2<f32>(f32(k) / 8.0, f32(i) / 8.0);
            }
        }
    }

    // 2. Newton on the 2x2 Jacobian.
    var uv = best;
    var err = vec2<f32>(0.0, 0.0);
    for (var it = 0; it < 10; it = it + 1) {
        let bu = bern(uv.x);
        let bv = bern(uv.y);
        let du = bern_d(uv.x);
        let dv = bern_d(uv.y);
        var q = vec2<f32>(0.0, 0.0);
        var ju = vec2<f32>(0.0, 0.0);
        var jv = vec2<f32>(0.0, 0.0);
        for (var r = 0; r < 4; r = r + 1) {
            for (var s = 0; s < 4; s = s + 1) {
                let cp = c[r * 4 + s];
                q = q + cp * (bv[r] * bu[s]);
                ju = ju + cp * (bv[r] * du[s]);
                jv = jv + cp * (dv[r] * bu[s]);
            }
        }
        err = q - p;
        let det = ju.x * jv.y - jv.x * ju.y;
        if (abs(det) < 1.0e-12) { break; }
        let step_u = (jv.y * err.x - jv.x * err.y) / det;
        let step_v = (-ju.y * err.x + ju.x * err.y) / det;
        uv = clamp(uv - vec2<f32>(step_u, step_v), vec2<f32>(-0.25), vec2<f32>(1.25));
    }

    // 3. The final residual decides whether the texel is on the patch.
    let bu = bern(uv.x);
    let bv = bern(uv.y);
    var q = vec2<f32>(0.0, 0.0);
    for (var r = 0; r < 4; r = r + 1) {
        for (var s = 0; s < 4; s = s + 1) {
            q = q + c[r * 4 + s] * (bv[r] * bu[s]);
        }
    }
    let e = q - p;
    if (e.x * e.x + e.y * e.y > 0.25) {
        textureStore(outp, xy, vec4<f32>(0.0));
        return;
    }
    let sx = uv.x * params.src_w - 0.5;
    let sy = uv.y * params.src_h - 0.5;
    let x0 = floor(sx);
    let y0 = floor(sy);
    let fx = sx - x0;
    let fy = sy - y0;
    let i0 = vec2<i32>(i32(x0), i32(y0));
    let p00 = tap(i0, wdims);
    let p10 = tap(i0 + vec2<i32>(1, 0), wdims);
    let p01 = tap(i0 + vec2<i32>(0, 1), wdims);
    let p11 = tap(i0 + vec2<i32>(1, 1), wdims);
    let top = mix(p00, p10, fx);
    let bot = mix(p01, p11, fx);
    textureStore(outp, xy, mix(top, bot, fy));
}
";

pub static FAMILY: &[&KernelDef] = &[&GEOM_WARP_MESH];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warp_modules_naga_validate() {
        for def in FAMILY {
            let src = crate::abi::assemble(def);
            let module = naga::front::wgsl::parse_str(&src)
                .unwrap_or_else(|e| panic!("{}: WGSL parse failed: {e}\n{src}", def.id));
            let mut validator = naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::default(),
            );
            validator
                .validate(&module)
                .unwrap_or_else(|e| panic!("{}: WGSL validation failed: {e:?}\n{src}", def.id));
        }
    }

    #[test]
    fn the_param_block_matches_the_declared_fields() {
        // 36 four-byte slots: 32 control-point coordinates, the source
        // size, a pad and the ABI pad.
        assert_eq!(::core::mem::size_of::<WarpMeshParams>(), 36 * 4);
        assert_eq!(WARP_MESH_FIELDS.len(), 35);
    }
}
