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

//! Kernel model (spec §6) — WGSL is the implementation.
//!
//! A kernel is a WGSL compute function plus a typed param block plus
//! metadata. Kernels are engine-agnostic pure functions over tile
//! slices with a frozen ABI (`abi.rs`); Engine A, Engine B, the
//! conformance harness, and the WGSL assembly all consume this ONE
//! definition. The `kernel_family!` macro (`family.rs`) emits both the
//! WGSL body and (behind the `reference` feature, test-only) the
//! scalar Rust twin from a single expression — one source of truth.

pub mod abi;
/// The compose family's scalar twins (in `paged-kernels`): the test-only
/// reference and (feature `cpu`) the layer fold's CPU path (image ADR 480).
#[cfg(any(feature = "reference", feature = "cpu"))]
pub use paged_kernels::compose_twin;
/// The shipped CPU twins of the adjustment chain's kernels (feature
/// `cpu`; ADR 465). The `reference` feature stays test-only.
#[cfg(feature = "cpu")]
pub mod cpu;
pub mod families;
#[cfg(any(feature = "reference", feature = "cpu"))]
pub use paged_kernels::reference_prelude;
pub use paged_kernels::{family, kernel_family};

pub use paged_kernels::def::{
    KernelClass, KernelDef, ParamField, ParamsLayout, ReductionKind, Tolerance, ABI_VERSION,
};

// The dispatch table, GENERATED from registry/kernels.yaml by build.rs
// (spec §12.2.1): a kernel without a registry row is unreachable by
// construction.
include!(concat!(env!("OUT_DIR"), "/registry_gen.rs"));

/// Dispatch lookup over the registry table.
pub fn lookup(id: &str) -> Option<&'static KernelDef> {
    registry().iter().copied().find(|d| d.id == id)
}

/// Every `KernelDef` defined in code, registry-listed or not. The
/// conformance gate asserts set-equality with `registry()` — both
/// directions of the 100% invariant (§12.2).
pub fn all_defined() -> Vec<&'static KernelDef> {
    families::ALL_FAMILIES
        .iter()
        .flat_map(|f| f.iter().copied())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_and_definitions_agree() {
        let mut reg: Vec<&str> = registry().iter().map(|d| d.id).collect();
        let mut def: Vec<&str> = all_defined().iter().map(|d| d.id).collect();
        reg.sort_unstable();
        def.sort_unstable();
        assert_eq!(
            reg, def,
            "registry/kernels.yaml and code-defined kernels must agree \
             (registry-driven dispatch, spec §12.2)"
        );
    }

    #[test]
    fn lookup_finds_linear() {
        let def = lookup("math.linear").expect("math.linear registered");
        assert_eq!(def.inputs, 1);
        assert!(matches!(def.class, KernelClass::Point));
    }
}
