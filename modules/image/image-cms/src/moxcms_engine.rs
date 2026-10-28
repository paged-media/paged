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

//! The moxcms backend — the print lane (D-11 ruling §F.2 in the A-0
//! audit), now the engine's: `paged_color::cms` with
//! [`Backend::Moxcms`] (pure Rust, no C FFI, every target).
//!
//! ## Intents
//!
//! Honoured for real: moxcms selects the per-intent A2B/B2A table
//! (perceptual → A2B0, relative/absolute colorimetric → A2B1, saturation
//! → A2B2). Matrix-shaper profiles carry no per-intent tables, so for
//! them the colorimetric result is intent-independent by construction.
//!
//! ## Black-point compensation
//!
//! Honoured. moxcms 0.8 has no BPC of its own; `paged_color::cms::bpc`
//! implements Adobe's published algorithm (black-point detection from the
//! profiles, then the XYZ scale between the PCS legs), held to lcms2's
//! BPC by the engine's tests and by this crate's `tests/it/print_lane.rs`
//! and `cmyk_lane.rs`. Under the perceptual and saturation intents a v4
//! destination compensates whether or not BPC was asked for (ICC v4's
//! reference medium black; lcms2 does the same).
//!
//! ## Bit depth
//!
//! The shared [`crate::ExactTransform`] contract is 8-bit RGBA (M1). The
//! engine's transform also runs on floats; once the trait grows a float
//! endpoint (a versioned amendment) the print lane can keep it.
//!
//! ## CMYK ingest (spec §5.2)
//!
//! "CMYK sources transform to working space at ingest and back at
//! export." [`Self::compile_cmyk_to_rgba8`] is that ingest path: a CMYK
//! *device* source profile → an RGB destination, packed CMYK8 ink in,
//! straight RGBA8 out (A = 255: CMYK ink carries no alpha).

use paged_color::cms::{Backend, Layout, ProfileRef, Rendering, Space, Transform};

use crate::{
    adapt_err, map_intent, Adapted, CmsEngine, CmsError, CompiledCmykTransform, CompiledTransform,
    Intent, Profile,
};

#[derive(Debug, Default)]
pub struct MoxcmsEngine;

fn transform(
    src: &Profile,
    src_layout: Layout,
    dst: &Profile,
    intent: Intent,
    bpc: bool,
) -> Result<Transform, CmsError> {
    Transform::new(
        Backend::Moxcms,
        ProfileRef::Icc(&src.bytes),
        src_layout,
        ProfileRef::Icc(&dst.bytes),
        Layout::RGBA,
        Rendering::new(map_intent(intent), bpc),
    )
    .map_err(adapt_err)
}

impl CmsEngine for MoxcmsEngine {
    fn compile(
        &self,
        src: &Profile,
        dst: &Profile,
        intent: Intent,
        bpc: bool,
    ) -> Result<CompiledTransform, CmsError> {
        let t = transform(src, Layout::RGBA, dst, intent, bpc)?;
        Ok(CompiledTransform {
            src: src.hash,
            dst: dst.hash,
            intent,
            bpc,
            backend: Box::new(Adapted(t)),
        })
    }

    fn compile_cmyk_to_rgba8(
        &self,
        src: &Profile,
        dst: &Profile,
        intent: Intent,
        bpc: bool,
    ) -> Result<CompiledCmykTransform, CmsError> {
        // Refuse a non-CMYK source up front — the ingest contract is
        // "CMYK device → working space"; an RGB source here is a caller
        // error, and reading RGB as ink would silently mis-colour.
        let space =
            paged_color::cms::profile_space(ProfileRef::Icc(&src.bytes)).map_err(adapt_err)?;
        if space != Space::Cmyk {
            return Err(CmsError::Unsupported(format!(
                "compile_cmyk_to_rgba8 needs a CMYK device source profile, got {space:?}"
            )));
        }
        let t = transform(src, Layout::CMYK, dst, intent, bpc)?;
        Ok(CompiledCmykTransform {
            src: src.hash,
            dst: dst.hash,
            intent,
            bpc,
            backend: Box::new(Adapted(t)),
        })
    }
}
