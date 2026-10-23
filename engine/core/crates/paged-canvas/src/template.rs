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

//! Template fields as a read and write surface (engine ADR 1001; the
//! editor's `docs/composable-editor.md` §7.3, task C8).
//!
//! [`CanvasModel::template_fields`] lists the document's fields with their
//! definitions and current values: the `templateFields` collection a form,
//! a host or the CLI reads. [`CanvasModel::lower_template_fields`] checks a
//! set of values against the fields' constraints and lowers them to ONE
//! batch of ordinary mutations, so filling a form is one undo step, and
//! every write meets the session's policy at the usual doors.
//!
//! A field swaps content, not design: a text field's new text is inserted
//! before the old and the old deleted, so it takes the first run's
//! character and paragraph style; a picture takes the field's fit.

use paged_template::{FieldDef, PolicyIndex, TemplateFieldKind};
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::channel::Mutation;
use crate::element_selection::ElementId;
use crate::model::CanvasModel;

/// A value for one field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FieldValue {
    /// A `text` or `variable` field's text.
    Text { text: String },
    /// An `image` field's picture, by URI (the host resolved it).
    Image { uri: String },
    /// A `visibility` field.
    Visible { visible: bool },
}

/// One field and the value to give it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFieldValue {
    pub name: String,
    pub value: FieldValue,
}

/// Why a value was not taken.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFieldProblem {
    pub name: String,
    pub problem: String,
}

/// A row of the `templateFields` collection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFieldSummary {
    /// The field's definition, from its policy.
    pub field: FieldDef,
    /// The page item it is (`Self` id), or the text variable.
    pub target_id: String,
    /// The page item, when the field is one.
    pub element_id: Option<ElementId>,
    /// The story a text field edits.
    pub story_id: Option<String>,
    /// The current value, where one can be read.
    pub value: Option<FieldValue>,
    /// The story overflows its frames.
    pub overset: bool,
}

fn element_of(node: &paged_mutate::NodeId) -> Option<ElementId> {
    use paged_mutate::NodeId as N;
    Some(match node {
        N::TextFrame(s) => ElementId::TextFrame(s.clone()),
        N::Rectangle(s) => ElementId::Rectangle(s.clone()),
        N::Oval(s) => ElementId::Oval(s.clone()),
        N::Polygon(s) => ElementId::Polygon(s.clone()),
        N::GraphicLine(s) => ElementId::GraphicLine(s.clone()),
        N::Group(s) => ElementId::Group(s.clone()),
        _ => return None,
    })
}

impl CanvasModel {
    fn story_text(&self, story_id: &str) -> Option<String> {
        let story = self.scene.stories.iter().find(|s| s.self_id == story_id)?;
        let mut text = String::new();
        for para in &story.story.paragraphs {
            for run in &para.runs {
                text.push_str(&run.text);
            }
        }
        Some(text)
    }

    /// A run field's story, and its placeholder run (offset and display
    /// text) when the field is one, else its tagged range's text.
    fn run_field(&self, key: &str) -> Option<(String, Option<u32>, String)> {
        let story_id = paged_template::story_of_run(&self.scene, key)?;
        let story = &self
            .scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)?
            .story;
        let mut at = 0u32;
        let mut found: Option<(u32, String, bool)> = None;
        for run in story.paragraphs.iter().flat_map(|p| p.runs.iter()) {
            if let Some(p) = run.placeholder.as_ref().filter(|p| p.key == key) {
                let ours = p.plugin == paged_model::TEMPLATE_PLACEHOLDER_PLUGIN;
                if found
                    .as_ref()
                    .is_none_or(|(_, _, was_ours)| ours && !was_ours)
                {
                    found = Some((at, run.text.clone(), ours));
                }
            }
            at += run.text.chars().count() as u32;
        }
        if let Some((offset, text, _)) = found {
            return Some((story_id.to_string(), Some(offset), text));
        }
        let range = story
            .xml_elements
            .iter()
            .find_map(|e| e.find(key))
            .and_then(|e| e.range)?;
        let text: String = story
            .flat_text()
            .chars()
            .skip(range.start as usize)
            .take((range.end - range.start) as usize)
            .collect();
        Some((story_id.to_string(), None, text))
    }

    fn story_paragraphs(&self, story_id: &str) -> &[paged_model::Paragraph] {
        self.scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)
            .map_or(&[], |s| s.story.paragraphs.as_slice())
    }

    /// The tagged range of the element `element` in `story_id`.
    fn range_of(&self, story_id: &str, element: &str) -> Option<(u32, u32)> {
        self.scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)?
            .story
            .xml_elements
            .iter()
            .find_map(|e| e.find(element))
            .and_then(|e| e.range)
            .map(|r| (r.start, r.end))
    }

    fn story_of_frame(&self, frame_id: &str) -> Option<String> {
        self.scene
            .text_frame(frame_id)
            .and_then(|f| f.parent_story.clone())
    }

    fn image_link_of(&self, self_id: &str) -> Option<String> {
        let id = Some(self_id);
        self.scene.spreads.iter().find_map(|parsed| {
            let s = &parsed.spread;
            s.rectangles
                .iter()
                .find(|f| f.self_id.as_deref() == id)
                .map(|f| f.image_link.clone())
                .or_else(|| {
                    s.ovals
                        .iter()
                        .find(|f| f.self_id.as_deref() == id)
                        .map(|f| f.image_link.clone())
                })
                .or_else(|| {
                    s.polygons
                        .iter()
                        .find(|f| f.self_id.as_deref() == id)
                        .map(|f| f.image_link.clone())
                })
                .flatten()
        })
    }

    fn visible_of(&self, element: &ElementId) -> Option<bool> {
        self.element_properties(element)?
            .entries
            .into_iter()
            .find(|e| e.path == paged_mutate::PropertyPath::ElementVisible)
            .and_then(|e| match e.value {
                Some(paged_mutate::Value::Bool(b)) => Some(b),
                _ => None,
            })
    }

    /// The document's template fields, in the policy's form order (fields
    /// it does not order follow, by name).
    pub fn template_fields(&self) -> Vec<TemplateFieldSummary> {
        let (index, _) = PolicyIndex::build(&self.scene);
        let overset = self.built.diagnostics.overset_story_ids();
        let mut rows: Vec<TemplateFieldSummary> = index
            .fields()
            .map(|(target_id, field)| {
                let node = self.resolve_frame_node_id(target_id);
                let element_id = node.as_ref().and_then(element_of);
                let run = (field.kind == TemplateFieldKind::TextRun)
                    .then(|| self.run_field(target_id))
                    .flatten();
                let story_id = match field.kind {
                    TemplateFieldKind::Text => self.story_of_frame(target_id),
                    TemplateFieldKind::TextRun => run.as_ref().map(|(s, _, _)| s.clone()),
                    _ => None,
                };
                let value = match field.kind {
                    TemplateFieldKind::Text => story_id
                        .as_deref()
                        .and_then(|s| self.story_text(s))
                        .map(|text| FieldValue::Text { text }),
                    TemplateFieldKind::Variable => self
                        .scene
                        .designmap
                        .text_variables
                        .iter()
                        .find(|v| v.self_id == target_id)
                        .map(|v| FieldValue::Text {
                            text: v.contents.clone().unwrap_or_default(),
                        }),
                    TemplateFieldKind::Image => self
                        .image_link_of(target_id)
                        .map(|uri| FieldValue::Image { uri }),
                    TemplateFieldKind::Visibility => element_id
                        .as_ref()
                        .and_then(|e| self.visible_of(e))
                        .map(|visible| FieldValue::Visible { visible }),
                    // A run's value is its placeholder's text, or the text
                    // of the range its element tags (engine ADR 1002).
                    TemplateFieldKind::TextRun => run.map(|(_, _, text)| FieldValue::Text { text }),
                    // A module field's value is its module's to read.
                    TemplateFieldKind::Choice
                    | TemplateFieldKind::Data
                    | TemplateFieldKind::Module => None,
                };
                TemplateFieldSummary {
                    overset: story_id.as_ref().is_some_and(|s| overset.contains(s)),
                    field: field.clone(),
                    target_id: target_id.to_string(),
                    element_id,
                    story_id,
                    value,
                }
            })
            .collect();
        let order: Vec<String> = index
            .document()
            .map(|d| d.order.clone())
            .unwrap_or_default();
        let rank = |name: &str| order.iter().position(|n| n == name).unwrap_or(usize::MAX);
        rows.sort_by(|a, b| {
            rank(&a.field.name)
                .cmp(&rank(&b.field.name))
                .then_with(|| a.field.name.cmp(&b.field.name))
        });
        rows
    }

    /// Checks `values` against the fields' constraints and lowers them to
    /// one batch mutation. Nothing is applied here; a problem with any
    /// value refuses them all.
    pub fn lower_template_fields(
        &self,
        values: &[TemplateFieldValue],
    ) -> Result<Mutation, Vec<TemplateFieldProblem>> {
        let fields = self.template_fields();
        let mut problems = Vec::new();
        let mut ops = Vec::new();
        for TemplateFieldValue { name, value } in values {
            let mut problem = |p: &str| {
                problems.push(TemplateFieldProblem {
                    name: name.clone(),
                    problem: p.to_string(),
                })
            };
            let Some(row) = fields.iter().find(|r| &r.field.name == name) else {
                problem("no field has this name");
                continue;
            };
            let c = &row.field.constraints;
            match (row.field.kind, value) {
                (
                    TemplateFieldKind::Text | TemplateFieldKind::Variable,
                    FieldValue::Text { text },
                ) => {
                    let len = text.chars().count() as u32;
                    if row.field.required && text.trim().is_empty() {
                        problem("required");
                        continue;
                    }
                    if c.max_length.is_some_and(|max| len > max) {
                        problem("longer than the field allows");
                        continue;
                    }
                    if row.field.kind == TemplateFieldKind::Variable {
                        let Ok(address) =
                            paged_wire::Address::parse(&format!("textVariable:{}", row.target_id))
                        else {
                            problem("the field's variable cannot be addressed");
                            continue;
                        };
                        ops.push(Mutation::Set {
                            address,
                            path: "textVariable.contents".into(),
                            value: paged_mutate::Value::Text(text.clone()),
                        });
                        continue;
                    }
                    let Some(story) = row.story_id.clone() else {
                        problem("the field's frame holds no story");
                        continue;
                    };
                    let old = self
                        .story_text(&story)
                        .map_or(0, |t| t.chars().count() as u32);
                    // Insert first, then delete the old text after it: the
                    // new text takes the style of the text it replaces.
                    if len > 0 {
                        ops.push(Mutation::InsertText {
                            story_id: story.clone(),
                            offset: 0,
                            text: text.clone(),
                            cell: None,
                        });
                    }
                    if old > 0 {
                        ops.push(Mutation::DeleteRange {
                            story_id: story,
                            start: len,
                            end: len + old,
                            cell: None,
                        });
                    }
                }
                (TemplateFieldKind::Image, FieldValue::Image { uri }) => {
                    if row.field.required && uri.is_empty() {
                        problem("required");
                        continue;
                    }
                    ops.push(Mutation::PlaceImage {
                        element_id: row.target_id.clone(),
                        uri: uri.clone(),
                        fit: c.fit.clone(),
                    });
                }
                (TemplateFieldKind::Visibility, FieldValue::Visible { visible }) => {
                    let Some(element_id) = row.element_id.clone() else {
                        problem("the field's item is not in the document");
                        continue;
                    };
                    ops.push(Mutation::SetElementProperty {
                        element_id,
                        path: paged_mutate::PropertyPath::ElementVisible,
                        value: paged_mutate::Value::Bool(*visible),
                    });
                }
                (TemplateFieldKind::TextRun, FieldValue::Text { text }) => {
                    if row.field.required && text.trim().is_empty() {
                        problem("required");
                        continue;
                    }
                    if c.max_length
                        .is_some_and(|max| text.chars().count() as u32 > max)
                    {
                        problem("longer than the field allows");
                        continue;
                    }
                    let Some((story_id, placeholder, old)) = self.run_field(&row.target_id) else {
                        problem("the field's run is not in the document");
                        continue;
                    };
                    match placeholder {
                        // The placeholder is the field: its value is set.
                        Some(offset) => ops.push(Mutation::SetFieldValue {
                            story_id,
                            offset,
                            value: Some(text.clone()),
                        }),
                        // A tagged range not yet a placeholder (an IDML
                        // reopened): its text is replaced, deleted first so
                        // the emptied range takes the new text.
                        None => {
                            let Some((start, _)) = self.range_of(&story_id, &row.target_id) else {
                                problem("the field's run is not in the document");
                                continue;
                            };
                            let old_len = old.chars().count() as u32;
                            let paragraphs = self.story_paragraphs(&story_id);
                            let cs = crate::mutate::char_to_content_offset(paragraphs, start);
                            let ce =
                                crate::mutate::char_to_content_offset(paragraphs, start + old_len);
                            if ce > cs {
                                ops.push(Mutation::DeleteRange {
                                    story_id: story_id.clone(),
                                    start: cs,
                                    end: ce,
                                    cell: None,
                                });
                            }
                            if !text.is_empty() {
                                ops.push(Mutation::InsertText {
                                    story_id,
                                    offset: cs,
                                    text: text.clone(),
                                    cell: None,
                                });
                            }
                        }
                    }
                }
                (TemplateFieldKind::Choice | TemplateFieldKind::Data, _) => {
                    problem("this kind of field cannot be set yet");
                }
                (TemplateFieldKind::Module, _) => {
                    problem("a module field is set through its module");
                }
                _ => problem("the value does not fit the field's kind"),
            }
        }
        if problems.is_empty() {
            Ok(Mutation::Batch { ops })
        } else {
            Err(problems)
        }
    }
}

impl CanvasModel {
    /// The fields the document's XML tags describe (engine ADR 1002, task
    /// C9). Reads only.
    pub fn derived_template_fields(
        &self,
        opts: paged_template::DeriveOptions,
    ) -> paged_template::Derivation {
        paged_template::derive_fields(&self.scene, opts)
    }

    /// "Open as template" (task F5): the derived fields, those named in
    /// `only` when it is given, written as the template's policy, and each
    /// tagged range made a placeholder run of the template's plugin keyed
    /// by its element (the element stays and wraps it). ONE batch, so one
    /// undo step; it writes the template's labels, which only an author's
    /// session may. Nothing is applied here.
    pub fn lower_open_as_template(
        &self,
        opts: paged_template::DeriveOptions,
        only: Option<&[String]>,
    ) -> Result<Mutation, Vec<TemplateFieldProblem>> {
        use paged_template::{DerivedTarget, ItemPolicy, TEMPLATE_KEY};
        let derived: Vec<paged_template::DerivedField> = self
            .derived_template_fields(opts)
            .fields
            .into_iter()
            .filter(|f| only.is_none_or(|names| names.contains(&f.field.name)))
            .collect();
        if derived.is_empty() {
            return Err(vec![TemplateFieldProblem {
                name: String::new(),
                problem: "nothing in the document is tagged as a field".into(),
            }]);
        }
        let (index, _) = PolicyIndex::build(&self.scene);
        let mut document = index.document().cloned().unwrap_or_default();
        let mut ops = Vec::new();

        // The ranges become placeholders, last first in each story, so the
        // offsets of the ones before stay true within the batch.
        let mut ranges: Vec<(&str, &str, u32, u32, &str)> = derived
            .iter()
            .filter_map(|f| match &f.target {
                DerivedTarget::Range {
                    story_id,
                    element_id,
                    start,
                    end,
                    text,
                } if end > start => Some((
                    story_id.as_str(),
                    element_id.as_str(),
                    *start,
                    *end,
                    text.as_str(),
                )),
                _ => None,
            })
            .collect();
        ranges.sort_by(|a, b| a.0.cmp(b.0).then(b.2.cmp(&a.2)));
        for (story_id, element_id, start, end, text) in ranges {
            let paragraphs = self.story_paragraphs(story_id);
            let cs = crate::mutate::char_to_content_offset(paragraphs, start);
            let ce = crate::mutate::char_to_content_offset(paragraphs, end);
            let inserted = text.len() as u32;
            ops.push(Mutation::InsertField {
                story_id: story_id.to_string(),
                offset: start,
                field: paged_mutate::FieldKind::Placeholder {
                    plugin: paged_model::TEMPLATE_PLACEHOLDER_PLUGIN.to_string(),
                    key: element_id.to_string(),
                    value: Some(text.to_string()),
                },
                content_offset: None,
            });
            ops.push(Mutation::DeleteRange {
                story_id: story_id.to_string(),
                start: cs + inserted,
                end: ce + inserted,
                cell: None,
            });
        }

        for f in &derived {
            let item = match &f.target {
                DerivedTarget::Item { item_id } => item_id,
                DerivedTarget::Story { frame_id, .. } => frame_id,
                DerivedTarget::Range { element_id, .. } => {
                    document.runs.insert(element_id.clone(), f.field.clone());
                    continue;
                }
                DerivedTarget::Placeholder { key, .. } => {
                    document.runs.insert(key.clone(), f.field.clone());
                    continue;
                }
            };
            let Some(element_id) = self
                .resolve_frame_node_id(item)
                .as_ref()
                .and_then(element_of)
            else {
                continue;
            };
            let mut policy: ItemPolicy = index.item(item).cloned().unwrap_or_default();
            policy.field = Some(f.field.clone());
            ops.push(Mutation::SetPluginMetadata {
                element_id: element_id.clone(),
                key: TEMPLATE_KEY.to_string(),
                value: Some(policy.to_label()),
                caller: None,
            });
            // The item carries its field's name, as the Template panel's
            // Make field does, when it has none.
            let named = self
                .scene
                .spreads
                .iter()
                .any(|p| p.spread.item_names.contains_key(item.as_str()));
            if !named {
                ops.push(Mutation::SetElementProperty {
                    element_id,
                    path: paged_mutate::PropertyPath::ItemName,
                    value: paged_mutate::Value::Text(f.field.name.clone()),
                });
            }
        }
        for f in &derived {
            if !document.order.contains(&f.field.name) {
                document.order.push(f.field.name.clone());
            }
        }
        ops.push(Mutation::SetDocumentMetadata {
            key: TEMPLATE_KEY.to_string(),
            value: Some(document.to_label()),
            caller: None,
        });
        Ok(Mutation::Batch { ops })
    }
}
