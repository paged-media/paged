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

//! The portable snippet: page items of one spread with their stories and the
//! resources they name, as Copy writes it and Paste reads it
//! (`paged_mutate::apply::snippet` does both). The types are here, beside
//! the model they carry, so a crate that only produces or reads snippets
//! (the PDF importer) does not link the mutation engine.

use std::collections::BTreeMap;

use paged_model::Spread;
use serde::{Deserialize, Serialize};

use crate::ParsedStory;

/// The `format` every snippet this engine writes carries.
pub const SNIPPET_FORMAT: &str = "paged.snippet/1";

/// Copied page items and what they name (see the module docs). Plain
/// serde: the clipboard holds its JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemSnippet {
    /// [`SNIPPET_FORMAT`].
    pub format: String,
    /// The copied items, ids as in the source document. The roots are
    /// `spread.frames_in_order` (back to front); members, pasted-in
    /// children and nested groups sit in the kind vecs beside them. A root
    /// group's transform is in spread space. No pages.
    pub spread: Spread,
    /// The text frames' and text paths' stories, ids as in the source.
    pub stories: Vec<ParsedStory>,
    /// The `<Hyperlink>`s the copied stories' sources own.
    #[serde(default)]
    pub hyperlinks: Vec<paged_model::Hyperlink>,
    /// The roots' union box, spread space: `[top, left, bottom, right]`.
    pub bounds: [f32; 4],
    /// The top-left of the page the items were copied from, in its spread:
    /// Paste in Place keeps the items' position relative to the page.
    #[serde(default)]
    pub page_origin: Option<[f32; 2]>,
    /// The source page's `Self` id.
    #[serde(default)]
    pub page_id: Option<String>,
    /// What the items reference, by id.
    #[serde(default)]
    pub resources: SnippetResources,
    /// The copied stories' text, frames back to front, one blank line
    /// between frames: the plain-text form of the copy.
    #[serde(default)]
    pub text: String,
}

/// The document resources a snippet's items reference, by `Self` id.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SnippetResources {
    #[serde(default)]
    pub colors: BTreeMap<String, paged_model::ColorEntry>,
    #[serde(default)]
    pub swatches: BTreeMap<String, paged_model::SwatchEntry>,
    #[serde(default)]
    pub gradients: BTreeMap<String, paged_model::GradientEntry>,
    #[serde(default)]
    pub paragraph_styles: BTreeMap<String, paged_model::ParagraphStyleDef>,
    #[serde(default)]
    pub character_styles: BTreeMap<String, paged_model::CharacterStyleDef>,
    #[serde(default)]
    pub object_styles: BTreeMap<String, paged_model::ObjectStyleDef>,
    #[serde(default)]
    pub stroke_styles: BTreeMap<String, paged_model::StrokeStyleDef>,
    #[serde(default)]
    pub conditions: BTreeMap<String, paged_model::ConditionDef>,
}
