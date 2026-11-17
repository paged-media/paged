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

//! The recipe: what the structure reader is told about one document that it
//! cannot see on the page — the fonts to set it in, the names of its styles,
//! how its pages pair into spreads, and fixes where its guesses are wrong.
//! Every field is optional; an empty recipe reads the PDF on its own.

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Recipe {
    /// The document's name (its designmap name).
    pub name: Option<String>,
    /// The PDF the recipe is for, as the person keeping it names it (not
    /// read by the reader).
    pub source: Option<String>,
    /// Notes for the person keeping the recipe (not read).
    pub notes: Option<serde_json::Value>,
    /// How PDF pages become document pages.
    pub layout: Layout,
    /// Only these PDF pages (1-based, inclusive), e.g. `[1, 12]`.
    pub pages: Option<[usize; 2]>,
    /// PostScript name (without subset prefix) → the face to set it in.
    pub fonts: BTreeMap<String, FontChoice>,
    /// Fonts whose text is drawn as outlines, not set as text (symbol
    /// fonts: pictograms), by PostScript name.
    pub outline_fonts: Vec<String>,
    /// Inferred style name → the name to give it.
    pub style_names: BTreeMap<String, String>,
    /// Inferred swatch name → the name to give it.
    pub swatch_names: BTreeMap<String, String>,
    /// Match the substitute fonts' widths to the PDF's (tracking per style).
    pub metric_fit: Option<bool>,
    /// Find master items (folios, running heads, rules).
    pub masters: Option<bool>,
    /// Link frames into threads.
    pub threads: Option<bool>,
    /// Threads to force: `[[page, frame], [page, frame]]` pairs of frame
    /// ordinals (1-based page, 0-based frame in reading order) to link.
    pub links: Vec<[[usize; 2]; 2]>,
    /// Threads to cut, in the same form.
    pub unlinks: Vec<[[usize; 2]; 2]>,
    /// Section starts: 1-based document page → first page number.
    pub sections: BTreeMap<usize, i32>,
}

impl Recipe {
    pub fn metric_fit(&self) -> bool {
        self.metric_fit.unwrap_or(true)
    }
    pub fn masters(&self) -> bool {
        self.masters.unwrap_or(true)
    }
    pub fn threads(&self) -> bool {
        self.threads.unwrap_or(true)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Layout {
    /// Spreads when the PDF holds spreads (pages twice as wide as the
    /// first), facing pages when told, single pages otherwise.
    #[default]
    Auto,
    /// Every PDF page is one page; no spreads.
    Single,
    /// Single PDF pages paired into facing spreads (page 1 on the right).
    Facing,
    /// The PDF was exported as spreads: a page twice as wide as the
    /// document's page is a left and a right page.
    Spreads,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FontChoice {
    pub family: String,
    #[serde(default = "regular")]
    pub style: String,
}

fn regular() -> String {
    "Regular".to_string()
}
