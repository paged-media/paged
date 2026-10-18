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

//! The ONE test device every crate's GPU tests share (feature
//! `test-support`, enabled only through dev-dependencies, so it never
//! reaches the shipped wasm).
//!
//! A machine without an adapter SKIPS the device tests, which is right
//! for a laptop without a GPU and wrong for a lane that exists to run
//! them: there, a skip is a pass that proved nothing. The skip goes
//! through `paged-test-resources` (platform/shared/test-resources): it
//! prints `unavailable: GPU adapter: …`, lands in `$PAGED_SKIP_LOG`, and
//! `PAGED_REQUIRE_GPU=1` turns it into a panic, so a lane that sets it
//! cannot go green without executing every GPU test. (`REQUIRE_GPU=1`,
//! the old spelling, is still read, with a deprecation warning.)
//! `PAGED_FORCE_NO_GPU=1` makes a machine with an adapter behave as if
//! it had none, which proves that path locally. There used to be four
//! copies of this helper (conformance, layers, stroke, the ingest
//! tests), each skipping on its own, which is why none of them could be
//! made strict.

use std::sync::OnceLock;

use paged_test_resources::Resource;

use crate::GpuContext;

static DEVICE: OnceLock<Result<GpuContext, String>> = OnceLock::new();

/// True when the environment demands a device (`PAGED_REQUIRE_GPU=1`, or
/// the deprecated `REQUIRE_GPU=1`).
pub fn gpu_required() -> bool {
    paged_test_resources::required(Resource::Gpu)
}

/// The process-wide test device, or `None` when the machine has no
/// usable adapter (or `PAGED_FORCE_NO_GPU=1` says to act as if it had
/// none). `who` names the caller in the `unavailable:` line.
///
/// # Panics
///
/// When no adapter is available and `PAGED_REQUIRE_GPU=1` is set.
#[track_caller]
pub fn device_or_skip(who: &str) -> Option<&'static GpuContext> {
    let ctx = DEVICE.get_or_init(|| {
        if paged_test_resources::gpu_forced_off() {
            return Err(format!(
                "{} is set, so no adapter is requested",
                paged_test_resources::FORCE_NO_GPU
            ));
        }
        match pollster::block_on(GpuContext::new()) {
            Ok(ctx) => {
                eprintln!(
                    "test GPU: {} ({:?})",
                    ctx.adapter_info.name, ctx.adapter_info.backend
                );
                Ok(ctx)
            }
            Err(e) => Err(e.to_string()),
        }
    });
    match ctx {
        Ok(ctx) => Some(ctx),
        Err(why) => {
            paged_test_resources::unavailable(Resource::Gpu, format_args!("{who}: {why}"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The GPU lanes run this with `--nocapture` first, so their log
    /// names the adapter every later device test ran on. (The
    /// `__feat__` suffix is the feature registry's join convention.)
    #[test]
    #[allow(non_snake_case)]
    fn the_test_device_names_its_adapter__feat__image_conformance_harness() {
        if let Some(ctx) = device_or_skip("adapter") {
            let info = &ctx.adapter_info;
            println!(
                "test GPU adapter: {} | backend {:?} | type {:?} | driver {} {}",
                info.name, info.backend, info.device_type, info.driver, info.driver_info
            );
        }
    }
}
