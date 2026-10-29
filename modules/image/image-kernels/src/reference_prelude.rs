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

//! The Rust half of the kernel DSL: test-only under `feature =
//! "reference"` (enabled solely by image-conformance), and the pixel
//! type of the shipped CPU twins under `feature = "cpu"` (ADR 465).
//! Every helper here has the
//! exact semantics of its WGSL counterpart — `abi::WGSL_PRELUDE` and
//! the WGSL builtin set — so a `kernel_family!` body means the same
//! thing in both languages. f32, no fast-math, fixed evaluation order:
//! bit-stable across platforms by construction (spec §6.3).

/// The pixel lives in `paged-kernels` (engine ADR 1013's first step).
pub use paged_kernels::Px;

/// WGSL `splat4` (see `abi::WGSL_PRELUDE`).
pub fn splat4(x: f32) -> Px {
    Px([x; 4])
}

/// WGSL `pack4`.
pub fn pack4(x: f32, y: f32, z: f32, w: f32) -> Px {
    Px([x, y, z, w])
}

fn bool4(a: Px, b: Px, f: impl Fn(f32, f32) -> bool) -> Px {
    a.zip(b, |x, y| if f(x, y) { 1.0 } else { 0.0 })
}

/// WGSL `eq4` — exact 0.0/1.0; NaN compares false (IEEE, both lanes).
pub fn eq4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| x == y)
}

/// WGSL `ne4`. NOTE: `!=` with NaN is TRUE on both lanes (IEEE).
pub fn ne4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| x != y)
}

/// WGSL `lt4`.
pub fn lt4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| x < y)
}

/// WGSL `le4`.
pub fn le4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| x <= y)
}

/// WGSL `gt4`.
pub fn gt4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| x > y)
}

/// WGSL `ge4`.
pub fn ge4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| x >= y)
}

fn truthy(x: f32) -> bool {
    x > 0.5
}

/// WGSL `and4` — truthiness is `> 0.5`, NaN deterministically false.
pub fn and4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| truthy(x) && truthy(y))
}

/// WGSL `or4`.
pub fn or4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| truthy(x) || truthy(y))
}

/// WGSL `xor4`.
pub fn xor4(a: Px, b: Px) -> Px {
    bool4(a, b, |x, y| truthy(x) != truthy(y))
}

/// WGSL `not4`.
pub fn not4(a: Px) -> Px {
    a.map(|x| if truthy(x) { 0.0 } else { 1.0 })
}

/// WGSL `sign4` — composed from comparisons so NaN → 0 on both lanes
/// (the builtin `sign` is not NaN-deterministic across drivers).
pub fn sign4(a: Px) -> Px {
    gt4(a, splat4(0.0)) - lt4(a, splat4(0.0))
}

/// WGSL `neg4`.
pub fn neg4(a: Px) -> Px {
    -a
}

/// WGSL `premul4` — rgb · a, alpha through.
pub fn premul4(c: Px) -> Px {
    Px([c.0[0] * c.0[3], c.0[1] * c.0[3], c.0[2] * c.0[3], c.0[3]])
}

/// WGSL `unpremul4` — zero alpha maps to all-zero (no Inf/NaN leak).
pub fn unpremul4(c: Px) -> Px {
    if c.0[3] == 0.0 {
        splat4(0.0)
    } else {
        Px([c.0[0] / c.0[3], c.0[1] / c.0[3], c.0[2] / c.0[3], c.0[3]])
    }
}

/// WGSL builtin `clamp` (componentwise).
pub fn clamp(x: Px, lo: Px, hi: Px) -> Px {
    // WGSL clamp(e, low, high) = min(max(e, low), high).
    min(max(x, lo), hi)
}

/// WGSL builtin `mix` (componentwise linear blend).
pub fn mix(a: Px, b: Px, t: Px) -> Px {
    // WGSL mix(e1, e2, e3) = e1 * (1 - e3) + e2 * e3.
    Px([
        a.0[0] * (1.0 - t.0[0]) + b.0[0] * t.0[0],
        a.0[1] * (1.0 - t.0[1]) + b.0[1] * t.0[1],
        a.0[2] * (1.0 - t.0[2]) + b.0[2] * t.0[2],
        a.0[3] * (1.0 - t.0[3]) + b.0[3] * t.0[3],
    ])
}

/// WGSL builtin `min` (componentwise).
pub fn min(a: Px, b: Px) -> Px {
    a.zip(b, f32::min)
}

/// WGSL builtin `max` (componentwise).
pub fn max(a: Px, b: Px) -> Px {
    a.zip(b, f32::max)
}

/// WGSL builtin `abs` (componentwise).
pub fn abs(x: Px) -> Px {
    x.map(f32::abs)
}

/// WGSL builtin `floor` (componentwise).
pub fn floor(x: Px) -> Px {
    x.map(f32::floor)
}
