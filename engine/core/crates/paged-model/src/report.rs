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

//! The loss report every importer and exporter answers with (capability
//! register C18): what a source carried that the target could not keep, one
//! entry per kind, counted. One shape in Rust and one in the extension
//! contract (`LossReport` / `LossEntry` in `@paged-media/plugin-api`), so a
//! consumer reads any producer's report with the same code.
//!
//! An entry is a stable `code` (what kind of thing), how often (`count`),
//! optionally the 0-based `pages` it stood on, and a worded `message`. A
//! producer that leaves the wording to its host (the PDF place-as-vectors
//! mapper words its codes in the bundle) leaves `message` empty, and the
//! empty `message` and `pages` stay off the wire.

use std::fmt;

use serde::{Deserialize, Serialize};

/// One kind of loss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossEntry {
    /// Stable code: an annotation type (`Link`, `Stamp`, `state:Marked`), a
    /// mapper code (`shading.sampled`).
    pub code: String,
    /// How many times it happened.
    pub count: usize,
    /// The 0-based pages it stood on, when the source has pages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<usize>,
    /// Why or what, worded; empty when the consumer words the code.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
}

impl fmt::Display for LossEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} x {}", self.count, self.code)?;
        if !self.pages.is_empty() {
            let pages: Vec<String> = self.pages.iter().map(|p| (p + 1).to_string()).collect();
            write!(f, " (page {})", pages.join(", "))?;
        }
        if !self.message.is_empty() {
            write!(f, ": {}", self.message)?;
        }
        Ok(())
    }
}

/// What a conversion left behind.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LossReport {
    pub losses: Vec<LossEntry>,
}

impl LossReport {
    /// Whether nothing was lost.
    pub fn is_empty(&self) -> bool {
        self.losses.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_prints_and_serialises_without_its_empty_parts() {
        let full = LossEntry {
            code: "Link".into(),
            count: 2,
            pages: vec![0, 2],
            message: "a hyperlink".into(),
        };
        assert_eq!(full.to_string(), "2 x Link (page 1, 3): a hyperlink");
        assert_eq!(
            serde_json::to_string(&full).unwrap(),
            r#"{"code":"Link","count":2,"pages":[0,2],"message":"a hyperlink"}"#
        );
        let bare = LossEntry {
            code: "shading.sampled".into(),
            count: 1,
            pages: vec![],
            message: String::new(),
        };
        assert_eq!(bare.to_string(), "1 x shading.sampled");
        assert_eq!(
            serde_json::to_string(&bare).unwrap(),
            r#"{"code":"shading.sampled","count":1}"#
        );
        let back: LossEntry = serde_json::from_str(r#"{"code":"x","count":3}"#).unwrap();
        assert_eq!(
            (back.count, back.pages.len(), back.message.len()),
            (3, 0, 0)
        );
    }
}
