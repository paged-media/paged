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

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

/// How a construct fared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
#[serde(rename_all = "camelCase")]
pub enum SvgNoteSeverity {
    /// Carried over with a visible difference (a focal point moved to
    /// the centre, a skewed stroke drawn at one width).
    Approximated,
    /// Not carried over at all (a filter, an external image).
    Dropped,
}

/// One kind of loss, with how often it happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SvgNote {
    /// A stable code (`"filter"`, `"gradient.focal"`, `"text.outlined"`,
    /// …) a caller can switch on; the codes are listed in engine ADR 1016.
    pub code: String,
    pub severity: SvgNoteSeverity,
    /// What happened, in a sentence.
    pub message: String,
    /// How many times.
    pub count: u32,
}

/// The report of one import or export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SvgReport {
    /// Import: the page items the plan creates (groups included).
    /// Export: the elements written.
    pub items: u32,
    /// The losses, one row per code, in the order they first happened.
    pub notes: Vec<SvgNote>,
}

impl SvgReport {
    /// Count one occurrence of `code`.
    pub fn note(&mut self, code: &str, severity: SvgNoteSeverity, message: &str) {
        if let Some(n) = self.notes.iter_mut().find(|n| n.code == code) {
            n.count += 1;
            return;
        }
        self.notes.push(SvgNote {
            code: code.to_string(),
            severity,
            message: message.to_string(),
            count: 1,
        });
    }

    pub fn approximated(&mut self, code: &str, message: &str) {
        self.note(code, SvgNoteSeverity::Approximated, message);
    }

    pub fn dropped(&mut self, code: &str, message: &str) {
        self.note(code, SvgNoteSeverity::Dropped, message);
    }

    /// The row of `code`, if it happened.
    pub fn get(&self, code: &str) -> Option<&SvgNote> {
        self.notes.iter().find(|n| n.code == code)
    }

    /// Whether everything was carried over exactly.
    pub fn is_exact(&self) -> bool {
        self.notes.is_empty()
    }
}
