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

//! Doc ADR 613 — Word's review markup as the import reads it: tracked
//! changes (`w:ins`, `w:del`, `w:moveTo`, `w:moveFrom`, `w:rPrChange`,
//! `w:pPrChange`, a paragraph mark's `w:ins` / `w:del`) and comment threads
//! (`comments.xml`, `commentsExtended.xml`, `commentsIds.xml`, the
//! `w:commentRangeStart` / `w:commentRangeEnd` ranges).

use serde::{Deserialize, Serialize};

use crate::{ParaProps, RunProps};

/// What a tracked change did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// Text inserted (`w:ins`), or moved here (`w:moveTo`).
    Insert,
    /// Text deleted (`w:del`), or moved away (`w:moveFrom`).
    Delete,
}

/// One tracked change's identity: Word's `w:id`, `w:author`, `w:date`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    /// `@w:id`, as written.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// `@w:date`, as written (`2026-10-01T10:00:00Z`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// The change is a move (`w:moveTo` / `w:moveFrom`), which save-back
    /// does not rewrite.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub moved: bool,
}

/// A run's text insertion or deletion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunChange {
    pub kind: ChangeKind,
    pub revision: Revision,
}

/// A run's tracked formatting change (`w:rPrChange`): its look before.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatChange {
    pub revision: Revision,
    /// `w:rPrChange/w:rPr/w:rStyle`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_style_id: Option<String>,
    /// The rest of `w:rPrChange/w:rPr`.
    #[serde(default)]
    pub old_props: RunProps,
}

/// A paragraph's tracked property change (`w:pPrChange`): its properties
/// before.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParaPropsChange {
    pub revision: Revision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_style_id: Option<String>,
    #[serde(default)]
    pub old_props: ParaProps,
}

/// A paragraph's review state: its mark inserted or deleted, its
/// properties changed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphReview {
    /// `w:pPr/w:rPr/w:ins` or `w:del` (or a move).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<RunChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub props: Option<ParaPropsChange>,
}

impl ParagraphReview {
    pub fn is_empty(&self) -> bool {
        self.mark.is_none() && self.props.is_none()
    }
}

/// One comment of `comments.xml`, with its thread place
/// (`commentsExtended.xml`) and durable id (`commentsIds.xml`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// `w:comment/@w:id`.
    pub id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initials: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// Its paragraphs' text, separated by `\n`.
    pub text: String,
    /// `w14:paraId` of its last paragraph: what `commentsExtended.xml` and
    /// `commentsIds.xml` key it by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub para_id: Option<String>,
    /// The comment this one answers (`w15:paraIdParent`), by `w:id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<i64>,
    /// `w15:done="1"`: the thread is resolved.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
    /// `w16cid:durableId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub durable_id: Option<String>,
}

/// The engine id a Word revision id becomes (`docx-r12`), and back.
pub fn change_token(word_id: &str) -> String {
    format!("docx-r{word_id}")
}

/// The engine id a Word comment id becomes (`docx-c3`).
pub fn comment_token(word_id: i64) -> String {
    format!("docx-c{word_id}")
}

/// The Word comment id an engine comment id names, when it came from Word.
pub fn comment_word_id(token: &str) -> Option<i64> {
    token.strip_prefix("docx-c")?.parse().ok()
}
