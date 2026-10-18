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

//! Spike C: WASM size measurement.
//!
//! The lib pulls in the heavy dependencies (`wgpu`, `harfrust`, etc.) so
//! they actually end up in the compiled artefact. `measure.sh` in this
//! directory runs the full build + opt + compress pipeline and prints
//! the resulting size.
//!
//! Pass criterion: compressed artefact ≤ 3.5 MB. Above that, we need a
//! concrete splitting strategy before Phase 0.

// Touch harfrust + ttf-parser so the linker keeps them.
pub fn shaping_stack_linked() -> &'static str {
    // A real symbol from each crate so neither is dead-stripped.
    let _ = harfrust::Tag::new(b"kern");
    let _ = ttf_parser::Tag::from_bytes(b"kern");
    "harfrust + ttf-parser linked"
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn keep_wgpu_linked() -> String {
        // Instantiating a wgpu type ensures the linker keeps its code.
        let _instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        super::shaping_stack_linked().to_string()
    }
}
