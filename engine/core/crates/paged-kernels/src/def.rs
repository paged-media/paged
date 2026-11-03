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

//! The kernel model (paged.image spec §6): what a kernel definition says,
//! with no behaviour. Moved from `image-kernels/src/lib.rs` by engine
//! ADR 1013; `image-kernels` re-exports every name at its crate root.

/// Frozen kernel ABI version (spec §9.2). Bumps are orchestrator-level
/// amendments.
pub const ABI_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum KernelClass {
    /// out(x,y) = f(in₀(x,y), …)
    Point,
    /// Needs an expanded input window (ROI inflation in the engines).
    Windowed { radius: (u16, u16) },
    /// Rational scale with kernel support.
    Resample { support: f32 },
    /// min/max/avg/histogram → scalar/table.
    Reduction(ReductionKind),
    /// No inputs (gradients, noise, constants).
    Generator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReductionKind {
    Min,
    Max,
    Avg,
    Histogram,
}

/// Per-kernel GPU-vs-reference tolerance (spec §6.3): GPU output is
/// verified against the scalar-reference golden by tolerance, never
/// byte-golden-tested.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tolerance {
    /// Bit-identical after f16 quantization of the reference.
    Exact,
    /// Max per-channel distance in f16 ULPs.
    ChannelEpsF16(u32),
    /// Mean perceptual ΔE bound (color kernels, T1+).
    PerceptualDeltaE(f32),
}

/// One field of a param block — drives the WGSL `struct Params`
/// emission (1:1 with the `#[repr(C)]` Rust layout).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParamField {
    pub name: &'static str,
    /// `f32` | `u32` | `i32` — the token is valid in both languages.
    pub wgsl_ty: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParamsLayout {
    /// `size_of` the Rust param struct (uniform upload size).
    pub size: usize,
    pub fields: &'static [ParamField],
}

/// The kernel definition (spec §6.1, frozen M0 phase 0).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KernelDef {
    /// Registry id (dispatch key), e.g. `math.linear`, `conv.gaussian`.
    pub id: &'static str,
    pub class: KernelClass,
    /// Input texture arity (group 0): 1 = unary, 2 = binary,
    /// 0 = generator.
    pub inputs: u8,
    pub params: ParamsLayout,
    /// The kernel WGSL — interpreted per `module`: an expression body
    /// in the restricted DSL spliced into the ABI template
    /// (`kernel_family!` output), or a complete handwritten compute
    /// module conforming to the ABI binding interface (T1
    /// windowed/resample kernels, spec §9.2 "handwritten WGSL"). The
    /// WGSL is the production implementation either way.
    pub wgsl: &'static str,
    /// ABI v1.1 amendment (M1): `true` = `wgsl` is a complete module
    /// (see `abi` docs for the module-authoring contract); `false` =
    /// expression body. `kernel_family!` always emits `false`.
    pub module: bool,
    /// Safe to evaluate at mip levels with scaled params? (§8.3)
    pub mip_exact: bool,
    pub gpu_tolerance: Tolerance,
}
