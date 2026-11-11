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

//! What an import or an export could not carry over exactly.
//!
//! Every construct that is approximated or left out is NAMED, never
//! silently dropped: the report is part of the answer, and the editor
//! shows it.

use paged_loss::LossLog;
pub use paged_loss::{LossEntry, LossSeverity};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

/// How a construct fared: the shared [`LossSeverity`].
pub type SvgNoteSeverity = LossSeverity;

/// One kind of loss, with how often it happened: the shared [`LossEntry`]
/// (capability register C18). The codes are listed in engine ADR 1031.
pub type SvgNote = LossEntry;

/// The report of one import or export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SvgReport {
    /// Import: the page items the plan creates (groups included).
    /// Export: the elements written.
    pub items: u32,
    /// The losses, one row per code, in the order they first happened
    /// (a `LossReport`'s `losses`).
    pub losses: Vec<LossEntry>,
}

impl SvgReport {
    /// Count one occurrence of `code`.
    pub fn note(&mut self, code: &str, severity: LossSeverity, message: &str) {
        self.losses.note(code, severity, message);
    }

    pub fn approximated(&mut self, code: &str, message: &str) {
        self.losses.approximated(code, message);
    }

    pub fn dropped(&mut self, code: &str, message: &str) {
        self.losses.dropped(code, message);
    }

    /// The row of `code`, if it happened.
    pub fn get(&self, code: &str) -> Option<&LossEntry> {
        self.losses.loss(code)
    }

    /// Whether everything was carried over exactly.
    pub fn is_exact(&self) -> bool {
        self.losses.is_empty()
    }
}
