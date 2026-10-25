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

//! Fields from XML tags (engine ADR 1002; the editor's
//! `docs/composable-editor.md` §7.4, task C9).
//!
//! A document tagged for XML already says which of its parts are open: a
//! tagged story is a text, a tagged graphic frame a picture, a tagged range
//! of text a run inside a story. [`derive_fields`] reads them as field
//! definitions, with the element's attributes `label`, `maxLength` and
//! `required` as the field's metadata. It writes nothing: "Open as
//! template" and `paged template ingest` turn the result into policy labels.
//!
//! A tag the engine cannot make a field of is reported, not dropped: one on
//! a parent page (its items are scenery on every page), one that tags
//! nothing, one on an item that is no kind of field, and a tagged story
//! whose tagged ranges are its fields.

use paged_model::{XmlElement, TEMPLATE_PLACEHOLDER_PLUGIN};
use paged_scene::Document;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::policy::{Constraints, FieldDef, TemplateFieldKind};

/// The XML attributes that carry field metadata; the writer mirrors them,
/// so derive → write → derive is a fixed point.
pub const LABEL_ATTRIBUTE: &str = "label";
pub const MAX_LENGTH_ATTRIBUTE: &str = "maxLength";
pub const REQUIRED_ATTRIBUTE: &str = "required";
/// A text field's allowed character styles, comma-separated (engine ADR 1017).
pub const ALLOWED_STYLES_ATTRIBUTE: &str = "allowedStyles";
/// A text field's breaks: `none`, `line` or `paragraph` (engine ADR 1017).
pub const BREAKS_ATTRIBUTE: &str = "breaks";

/// What else besides XML tags becomes a field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase", default)]
pub struct DeriveOptions {
    /// An untagged page item with an IDML `Name` becomes a field of its
    /// name: a text frame's story a text, a graphic frame a picture.
    pub include_names: bool,
    /// A placeholder run of a plugin (a data-merge field) becomes a
    /// `text-run` field of its key.
    pub include_placeholders: bool,
}

/// Where a derived field's value lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DerivedTarget {
    /// A page item: a graphic frame's picture.
    Item { item_id: String },
    /// A story, through the first frame of its chain (the item its policy
    /// is written on).
    Story { story_id: String, frame_id: String },
    /// A tagged range of a story's characters (`[start, end)`, the
    /// `StoryRange` count), with its text. Opened as a template it becomes
    /// a placeholder run keyed by `element_id`.
    Range {
        story_id: String,
        element_id: String,
        start: u32,
        end: u32,
        text: String,
    },
    /// A plugin's placeholder run.
    Placeholder {
        story_id: String,
        plugin: String,
        key: String,
    },
}

/// Why a field was derived.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub enum DerivedFrom {
    /// An XML tag.
    Tag,
    /// The item's IDML `Name` (`include_names`).
    Name,
    /// A plugin placeholder (`include_placeholders`).
    Placeholder,
}

/// One field derived from the document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct DerivedField {
    pub field: FieldDef,
    pub target: DerivedTarget,
    pub from: DerivedFrom,
    /// The XML element it was derived from.
    pub element_id: Option<String>,
}

/// A tag that did not become a field, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct SkippedTag {
    pub element_id: String,
    /// The tag's name.
    pub tag: String,
    pub reason: String,
}

/// What [`derive_fields`] found.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Tsify)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct Derivation {
    pub fields: Vec<DerivedField>,
    pub skipped: Vec<SkippedTag>,
}

/// The kind of page item an id names, and whether it is on a parent page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemKind {
    TextFrame,
    Graphic,
    Other,
}

fn find_item(doc: &Document, id: &str) -> Option<(ItemKind, bool)> {
    let some = Some(id);
    let kind_in = |s: &paged_model::Spread| {
        if s.text_frames.iter().any(|f| f.self_id.as_deref() == some) {
            Some(ItemKind::TextFrame)
        } else if s.rectangles.iter().any(|f| f.self_id.as_deref() == some)
            || s.ovals.iter().any(|f| f.self_id.as_deref() == some)
            || s.polygons.iter().any(|f| f.self_id.as_deref() == some)
        {
            Some(ItemKind::Graphic)
        } else if s.graphic_lines.iter().any(|f| f.self_id.as_deref() == some)
            || s.groups.iter().any(|f| f.self_id.as_deref() == some)
        {
            Some(ItemKind::Other)
        } else {
            None
        }
    };
    doc.spreads
        .iter()
        .find_map(|p| kind_in(&p.spread))
        .map(|k| (k, false))
        .or_else(|| {
            doc.master_spreads
                .values()
                .find_map(|m| kind_in(&m.spread))
                .map(|k| (k, true))
        })
}

/// Where a story stands: its first frame on a document page, or whether
/// a parent page holds it.
enum StoryPlace {
    Page(String),
    Parent,
    Nowhere,
}

fn story_place(doc: &Document, story_id: &str) -> StoryPlace {
    if let Some(id) = doc
        .frame_chain(story_id)
        .first()
        .and_then(|f| f.self_id.clone())
    {
        return StoryPlace::Page(id);
    }
    let on_parent = doc.master_spreads.values().any(|m| {
        m.spread
            .text_frames
            .iter()
            .any(|f| f.parent_story.as_deref() == Some(story_id))
    });
    if on_parent {
        StoryPlace::Parent
    } else {
        StoryPlace::Nowhere
    }
}

fn story_of_frame(doc: &Document, frame_id: &str) -> Option<String> {
    doc.text_frame(frame_id)
        .and_then(|f| f.parent_story.clone())
        .or_else(|| {
            doc.master_spreads
                .values()
                .flat_map(|m| m.spread.text_frames.iter())
                .find(|f| f.self_id.as_deref() == Some(frame_id))
                .and_then(|f| f.parent_story.clone())
        })
}

/// A field definition from an element: named after its tag, with the
/// metadata its attributes carry.
fn field_of(name: String, kind: TemplateFieldKind, attributes: &[(String, String)]) -> FieldDef {
    let attr = |n: &str| {
        attributes
            .iter()
            .find(|(k, _)| k == n)
            .map(|(_, v)| v.trim())
    };
    FieldDef {
        name,
        kind,
        label: attr(LABEL_ATTRIBUTE)
            .filter(|v| !v.is_empty())
            .map(str::to_string),
        help: None,
        group: None,
        required: attr(REQUIRED_ATTRIBUTE)
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "true" | "1" | "yes")),
        constraints: Constraints {
            max_length: attr(MAX_LENGTH_ATTRIBUTE).and_then(|v| v.parse().ok()),
            allowed_styles: attr(ALLOWED_STYLES_ATTRIBUTE)
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            breaks: attr(BREAKS_ATTRIBUTE).and_then(|v| {
                serde_json::from_value(serde_json::Value::String(v.to_ascii_lowercase())).ok()
            }),
            ..Default::default()
        },
        module: None,
        members: vec![],
    }
}

/// The attributes of an element tagging a story: the story's copy and the
/// back story's, the story's first.
fn story_element_attributes(
    doc: &Document,
    el: &XmlElement,
    story_id: &str,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = doc
        .stories
        .iter()
        .find(|s| s.self_id == story_id)
        .and_then(|s| {
            s.story
                .xml_elements
                .iter()
                .find(|e| e.self_id == el.self_id)
        })
        .map(|e| e.attributes.clone())
        .unwrap_or_default();
    for (k, v) in &el.attributes {
        if !out.iter().any(|(ok, _)| ok == k) {
            out.push((k.clone(), v.clone()));
        }
    }
    out
}

struct Deriver<'a> {
    doc: &'a Document,
    out: Derivation,
}

impl Deriver<'_> {
    fn unique(&self, base: &str) -> String {
        let taken = |n: &str| self.out.fields.iter().any(|f| f.field.name == n);
        if !taken(base) {
            return base.to_string();
        }
        (2..)
            .map(|i| format!("{base}-{i}"))
            .find(|n| !taken(n))
            .expect("an unused name")
    }

    fn skip(&mut self, el: &XmlElement, reason: &str) {
        self.out.skipped.push(SkippedTag {
            element_id: el.self_id.clone(),
            tag: el.tag_name().to_string(),
            reason: reason.to_string(),
        });
    }

    fn push(
        &mut self,
        name: &str,
        kind: TemplateFieldKind,
        attributes: &[(String, String)],
        target: DerivedTarget,
        from: DerivedFrom,
        element_id: Option<String>,
    ) {
        let name = self.unique(name);
        self.out.fields.push(DerivedField {
            field: field_of(name, kind, attributes),
            target,
            from,
            element_id,
        });
    }

    fn story_element(&mut self, el: &XmlElement, story_id: &str) {
        let story = self.doc.stories.iter().find(|s| s.self_id == story_id);
        let Some(story) = story else {
            self.skip(el, "it tags a story the document does not have");
            return;
        };
        match story_place(self.doc, story_id) {
            StoryPlace::Parent => self.skip(el, "it is on a parent page"),
            StoryPlace::Nowhere => self.skip(el, "no frame on a page holds its story"),
            StoryPlace::Page(frame_id) => {
                let ranges: Vec<&XmlElement> = story
                    .story
                    .xml_elements
                    .iter()
                    .filter(|e| e.self_id == el.self_id)
                    .flat_map(|e| e.walk().into_iter().skip(1))
                    .filter(|e| e.range.is_some())
                    .collect();
                if !ranges.is_empty() {
                    self.skip(el, "its tagged ranges are the fields");
                    let text: Vec<char> = story.story.flat_text().chars().collect();
                    for range_el in ranges {
                        if range_el.children.iter().any(|c| c.range.is_some()) {
                            self.skip(range_el, "the tagged ranges inside it are the fields");
                            continue;
                        }
                        let r = range_el.range.expect("filtered above");
                        let (s, e) = (r.start as usize, (r.end as usize).min(text.len()));
                        self.push(
                            range_el.tag_name(),
                            TemplateFieldKind::TextRun,
                            &range_el.attributes,
                            DerivedTarget::Range {
                                story_id: story_id.to_string(),
                                element_id: range_el.self_id.clone(),
                                start: r.start,
                                end: r.end,
                                text: text[s.min(e)..e].iter().collect(),
                            },
                            DerivedFrom::Tag,
                            Some(range_el.self_id.clone()),
                        );
                    }
                    return;
                }
                let attributes = story_element_attributes(self.doc, el, story_id);
                self.push(
                    el.tag_name(),
                    TemplateFieldKind::Text,
                    &attributes,
                    DerivedTarget::Story {
                        story_id: story_id.to_string(),
                        frame_id,
                    },
                    DerivedFrom::Tag,
                    Some(el.self_id.clone()),
                );
            }
        }
    }

    fn element(&mut self, el: &XmlElement) {
        if let Some(content) = el.content.as_deref() {
            if self.doc.stories.iter().any(|s| s.self_id == content) {
                self.story_element(el, content);
            } else {
                match find_item(self.doc, content) {
                    None => self.skip(el, "it tags nothing in the document"),
                    Some((_, true)) => self.skip(el, "it is on a parent page"),
                    Some((ItemKind::Graphic, false)) => self.push(
                        el.tag_name(),
                        TemplateFieldKind::Image,
                        &el.attributes,
                        DerivedTarget::Item {
                            item_id: content.to_string(),
                        },
                        DerivedFrom::Tag,
                        Some(el.self_id.clone()),
                    ),
                    Some((ItemKind::TextFrame, false)) => match story_of_frame(self.doc, content) {
                        Some(story) => self.story_element(el, &story),
                        None => self.skip(el, "its frame holds no story"),
                    },
                    Some((ItemKind::Other, false)) => {
                        self.skip(el, "a line or a group is no kind of field")
                    }
                }
            }
        }
        for child in &el.children {
            self.element(child);
        }
    }
}

/// The fields a document's XML tags (and, as `opts` asks, its item names
/// and plugin placeholders) describe, in document order.
pub fn derive_fields(doc: &Document, opts: DeriveOptions) -> Derivation {
    let mut d = Deriver {
        doc,
        out: Derivation::default(),
    };
    if let Some(root) = &doc.designmap.xml_root {
        for child in &root.children {
            d.element(child);
        }
    }
    if opts.include_names {
        let taken = |d: &Deriver, id: &str| {
            d.out.fields.iter().any(|f| match &f.target {
                DerivedTarget::Item { item_id } => item_id == id,
                DerivedTarget::Story { frame_id, .. } => frame_id == id,
                _ => false,
            })
        };
        for parsed in &doc.spreads {
            let mut names: Vec<(&String, &String)> = parsed.spread.item_names.iter().collect();
            names.sort();
            for (id, name) in names {
                if taken(&d, id) {
                    continue;
                }
                match find_item(doc, id) {
                    Some((ItemKind::Graphic, false)) => d.push(
                        name,
                        TemplateFieldKind::Image,
                        &[],
                        DerivedTarget::Item {
                            item_id: id.clone(),
                        },
                        DerivedFrom::Name,
                        None,
                    ),
                    Some((ItemKind::TextFrame, false)) => {
                        if let Some(story_id) = story_of_frame(doc, id) {
                            d.push(
                                name,
                                TemplateFieldKind::Text,
                                &[],
                                DerivedTarget::Story {
                                    story_id,
                                    frame_id: id.clone(),
                                },
                                DerivedFrom::Name,
                                None,
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    if opts.include_placeholders {
        for s in &doc.stories {
            for run in s.story.paragraphs.iter().flat_map(|p| p.runs.iter()) {
                let Some(p) = &run.placeholder else { continue };
                if p.plugin == TEMPLATE_PLACEHOLDER_PLUGIN {
                    continue;
                }
                d.push(
                    &p.key,
                    TemplateFieldKind::TextRun,
                    &[],
                    DerivedTarget::Placeholder {
                        story_id: s.self_id.clone(),
                        plugin: p.plugin.clone(),
                        key: p.key.clone(),
                    },
                    DerivedFrom::Placeholder,
                    None,
                );
            }
        }
    }
    d.out
}

/// The XML attributes that state a field's metadata (`label`, `maxLength`,
/// `required`, `allowedStyles`, `breaks`), as the writer puts them on the field's element; absent
/// metadata has no attribute.
pub fn field_attributes(field: &FieldDef) -> Vec<(String, Option<String>)> {
    vec![
        (LABEL_ATTRIBUTE.to_string(), field.label.clone()),
        (
            MAX_LENGTH_ATTRIBUTE.to_string(),
            field.constraints.max_length.map(|n| n.to_string()),
        ),
        (
            REQUIRED_ATTRIBUTE.to_string(),
            field.required.then(|| "true".to_string()),
        ),
        (
            ALLOWED_STYLES_ATTRIBUTE.to_string(),
            (!field.constraints.allowed_styles.is_empty())
                .then(|| field.constraints.allowed_styles.join(",")),
        ),
        (
            BREAKS_ATTRIBUTE.to_string(),
            field.constraints.breaks.and_then(|b| {
                serde_json::to_value(b)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
            }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes_become_metadata() {
        let f = field_of(
            "Headline".into(),
            TemplateFieldKind::Text,
            &[
                ("label".into(), "Your headline".into()),
                ("maxLength".into(), "40".into()),
                ("required".into(), "TRUE".into()),
                ("allowedStyles".into(), "Bold, Italic".into()),
                ("breaks".into(), "Line".into()),
                ("other".into(), "x".into()),
            ],
        );
        assert_eq!(f.constraints.allowed_styles, ["Bold", "Italic"]);
        assert_eq!(f.constraints.breaks, Some(crate::policy::TextBreaks::Line));
        assert_eq!(f.label.as_deref(), Some("Your headline"));
        assert_eq!(f.constraints.max_length, Some(40));
        assert!(f.required);
        let back: Vec<(String, String)> = field_attributes(&f)
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k, v)))
            .collect();
        assert_eq!(
            field_of("Headline".into(), TemplateFieldKind::Text, &back),
            f
        );
        let bare = field_of(
            "x".into(),
            TemplateFieldKind::Image,
            &[("maxLength".into(), "many".into())],
        );
        assert_eq!(bare.constraints.max_length, None);
        assert!(!bare.required);
    }
}
