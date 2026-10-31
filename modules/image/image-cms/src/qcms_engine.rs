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

//! The qcms backend — the display-consistency engine (D-11 ruling §F.1
//! in the A-0 audit): the engine's own qcms build (`paged_color::cms`,
//! [`Backend::Qcms`]), so "the page" and "the image editor" agree by
//! construction. Known limits (audit §A): no BPC, 8-bit endpoints,
//! perceptual/relative-colorimetric-centric intents — the print lane
//! (moxcms) covers what this backend can't.
//!
//! `bpc: true` requests are accepted and recorded on the handle but not
//! honoured: qcms has no black-point compensation and no PCS access to
//! compute one, so the transform is compiled without it (the engine's
//! API would refuse the request; this adapter keeps the documented
//! display-lane behaviour).

use paged_color::cms::{Backend, Layout, ProfileRef, Rendering, Transform};

use crate::{
    adapt_err, map_intent, Adapted, CmsEngine, CmsError, CompiledTransform, Intent, Profile,
};

#[derive(Debug, Default)]
pub struct QcmsEngine;

impl CmsEngine for QcmsEngine {
    fn compile(
        &self,
        src: &Profile,
        dst: &Profile,
        intent: Intent,
        bpc: bool,
    ) -> Result<CompiledTransform, CmsError> {
        let t = Transform::new(
            Backend::Qcms,
            ProfileRef::Icc(&src.bytes),
            Layout::RGBA,
            ProfileRef::Icc(&dst.bytes),
            Layout::RGBA,
            Rendering::new(map_intent(intent), false),
        )
        .map_err(adapt_err)?;
        Ok(CompiledTransform {
            src: src.hash,
            dst: dst.hash,
            intent,
            bpc,
            backend: Box::new(Adapted(t)),
        })
    }
}
