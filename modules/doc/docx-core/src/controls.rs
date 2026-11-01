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

//! Doc ADR 614 (content controls) — an inline content control (`w:sdt`
//! inside a paragraph), read from its `w:sdtPr`. The shape serialises
//! exactly as the engine's `paged_model::ContentControl` (engine ADR 1052),
//! so the lowering hands it to the engine as it stands.

use serde::{Deserialize, Serialize};

/// An inline content control on the runs of its content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentControl {
    /// The engine's id: `w<w:id>`, or `sdt<n>` (document order) when Word
    /// wrote no id.
    pub id: String,
    pub kind: ContentControlKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// `w:lock/@w:val`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<String>,
    /// `w:showingPlcHdr`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub showing_placeholder: bool,
    /// The engine character style the placeholder runs carry (set by the
    /// lowering).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder_style: Option<String>,
}

impl ContentControl {
    /// Word's `w:id`, when the engine id carries it.
    pub fn word_id(&self) -> Option<i32> {
        self.id.strip_prefix('w')?.parse().ok()
    }
}

/// The kind, from the `w:sdtPr` type element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ContentControlKind {
    PlainText {
        #[serde(default)]
        multi_line: bool,
    },
    RichText,
    Checkbox {
        checked: bool,
        checked_glyph: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked_font: Option<String>,
        unchecked_glyph: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unchecked_font: Option<String>,
    },
    DropDown {
        #[serde(default)]
        combo: bool,
        items: Vec<ListItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    Date {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
}

/// A `w:listItem`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    pub display: String,
    pub value: String,
}
