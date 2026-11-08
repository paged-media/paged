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

//! A text frame's warp (engine ADR 1091): WordArt's `a:prstTxWarp`.
//!
//! The frame's text is laid out in its unbent box, then its outlines are
//! mapped onto the preset's shape (`paged_warp::textshape`). The model keeps
//! the preset's name and its adjusts as written, so a reader carries them
//! without knowing a preset's geometry and a writer can set them back.

use serde::{Deserialize, Serialize};

/// A preset text warp.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TextWarp {
    /// The `ST_TextShapeType` name (`textArchUp`, `textWave1`, …).
    pub preset: String,
    /// The adjusts as written (`adj`, `adj1`, …: 1/100000 of the box or
    /// 1/60000 of a degree); the preset's defaults for the rest.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adjusts: Vec<(String, i64)>,
}

impl TextWarp {
    /// The adjust named `name`, as written.
    pub fn adjust(&self, name: &str) -> Option<i64> {
        self.adjusts
            .iter()
            .find(|(n, _)| n == name)
            .map(|&(_, v)| v)
    }

    /// Whether it bends anything: a preset other than the plain box and the
    /// "no shape" one.
    pub fn is_active(&self) -> bool {
        !matches!(self.preset.as_str(), "" | "textNoShape")
    }
}
