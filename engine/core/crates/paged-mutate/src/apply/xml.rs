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

//! Engine ADR 1002 — operations on the document's XML structure: tag
//! definitions, elements tagging page items, stories and text ranges, and
//! their attributes. Every one marks the structure edited, so the exporter
//! writes it from the model; every one but `CreateXmlTag` is undone by
//! putting the structure back as it was captured before it applied.

use paged_model::{XmlElement, XmlRange, XmlTag};
use paged_scene::Document;
use serde::{Deserialize, Serialize};

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, Operation};

/// The tag InDesign roots every structure in.
const ROOT_TAG: &str = "Root";
/// The tag InDesign gives a story it tags on its own (a range tagged in an
/// untagged story).
const STORY_TAG: &str = "Story";

fn refuse(reason: impl Into<String>) -> OperationError {
    OperationError::InvalidXmlStructure {
        reason: reason.into(),
    }
}

fn tag_ref(name: &str) -> String {
    format!("XMLTag/{name}")
}

/// Whether `name` is an XML name InDesign takes for a tag: a letter or `_`
/// first, then letters, digits, `_`, `-` and `.`.
pub fn is_tag_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_alphabetic() || first == '_')
        && chars.all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
        && !name.to_ascii_lowercase().starts_with("xml")
}

/// The XML structure as captured for a `RestoreXmlStructure`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct XmlState {
    tags: Vec<XmlTag>,
    root: Option<XmlElement>,
    /// The elements of each story named, by story `Self`.
    stories: Vec<(String, Vec<XmlElement>)>,
    edited: bool,
}

fn capture(doc: &Document, stories: &[&str]) -> String {
    let state = XmlState {
        tags: doc.designmap.xml_tags.clone(),
        root: doc.designmap.xml_root.clone(),
        stories: stories
            .iter()
            .filter_map(|id| {
                doc.stories
                    .iter()
                    .find(|s| s.self_id == *id)
                    .map(|s| (s.self_id.clone(), s.story.xml_elements.clone()))
            })
            .collect(),
        edited: doc.designmap.xml_structure_edited,
    };
    serde_json::to_string(&state).expect("the XML structure serialises")
}

fn applied(op: Operation, before: String) -> AppliedOperation {
    AppliedOperation {
        op,
        inverse: Operation::RestoreXmlStructure { state: before },
        // The structure draws nothing.
        invalidation: InvalidationHint::default(),
    }
}

fn ensure_tag(doc: &mut Document, name: &str) -> Result<(), OperationError> {
    if !is_tag_name(name) {
        return Err(refuse(format!("{name:?} is not a tag name")));
    }
    let self_id = tag_ref(name);
    if !doc.designmap.xml_tags.iter().any(|t| t.self_id == self_id) {
        doc.designmap.xml_tags.push(XmlTag {
            self_id,
            name: name.to_string(),
            color: None,
        });
    }
    Ok(())
}

fn ensure_root(doc: &mut Document, minted: &str) -> Result<(), OperationError> {
    if doc.designmap.xml_root.is_none() {
        ensure_tag(doc, ROOT_TAG)?;
        doc.designmap.xml_root = Some(XmlElement {
            self_id: format!("{minted}r"),
            tag: tag_ref(ROOT_TAG),
            ..Default::default()
        });
    }
    Ok(())
}

/// Every element `Self` in the document.
fn element_ids(doc: &Document) -> Vec<&str> {
    let mut ids: Vec<&str> = doc
        .designmap
        .xml_root
        .iter()
        .flat_map(|r| r.walk())
        .map(|e| e.self_id.as_str())
        .collect();
    for s in &doc.stories {
        for top in &s.story.xml_elements {
            ids.extend(top.walk().into_iter().map(|e| e.self_id.as_str()));
        }
    }
    ids
}

fn refuse_taken_id(doc: &Document, self_id: &str) -> Result<(), OperationError> {
    if self_id.is_empty() {
        return Err(refuse("an element needs a Self id"));
    }
    if element_ids(doc).contains(&self_id) {
        return Err(OperationError::DuplicateNodeId {
            id: self_id.to_string(),
        });
    }
    Ok(())
}

/// What a `TagItem` / `UntagItem` names: a story (a text frame names its
/// story) or another page item.
enum Tagged {
    Story(String),
    Item(String),
}

fn item_exists(doc: &Document, id: &str) -> bool {
    let has = |s: &paged_model::Spread| {
        let some = Some(id);
        s.text_frames.iter().any(|f| f.self_id.as_deref() == some)
            || s.rectangles.iter().any(|f| f.self_id.as_deref() == some)
            || s.ovals.iter().any(|f| f.self_id.as_deref() == some)
            || s.polygons.iter().any(|f| f.self_id.as_deref() == some)
            || s.graphic_lines.iter().any(|f| f.self_id.as_deref() == some)
            || s.groups.iter().any(|g| g.self_id.as_deref() == some)
    };
    doc.spreads.iter().any(|p| has(&p.spread))
        || doc.master_spreads.values().any(|m| has(&m.spread))
}

fn text_frame_story(doc: &Document, id: &str) -> Option<String> {
    let some = Some(id);
    doc.spreads
        .iter()
        .map(|p| &p.spread)
        .chain(doc.master_spreads.values().map(|m| &m.spread))
        .flat_map(|s| s.text_frames.iter())
        .find(|f| f.self_id.as_deref() == some)
        .and_then(|f| f.parent_story.clone())
}

fn resolve_item(doc: &Document, item: &str) -> Result<Tagged, OperationError> {
    if doc.stories.iter().any(|s| s.self_id == item) {
        return Ok(Tagged::Story(item.to_string()));
    }
    if let Some(story) = text_frame_story(doc, item) {
        return Ok(Tagged::Story(story));
    }
    if item_exists(doc, item) {
        return Ok(Tagged::Item(item.to_string()));
    }
    Err(refuse(format!("no page item or story {item:?}")))
}

/// The element of the structure that tags `content`, depth first.
fn tagging(root: &XmlElement, content: &str) -> Option<String> {
    root.walk()
        .into_iter()
        .find(|e| e.content.as_deref() == Some(content))
        .map(|e| e.self_id.clone())
}

fn remove_from(el: &mut XmlElement, self_id: &str) -> Option<XmlElement> {
    if let Some(i) = el.children.iter().position(|c| c.self_id == self_id) {
        return Some(el.children.remove(i));
    }
    el.children.iter_mut().find_map(|c| remove_from(c, self_id))
}

fn story_mut<'a>(
    doc: &'a mut Document,
    story_id: &str,
) -> Result<&'a mut paged_model::Story, OperationError> {
    doc.stories
        .iter_mut()
        .find(|s| s.self_id == story_id)
        .map(|s| &mut s.story)
        .ok_or_else(|| refuse(format!("no story {story_id:?}")))
}

/// Adds the element `self_id` tagging `target` under the root.
fn tag_target(
    doc: &mut Document,
    target: &Tagged,
    tag: &str,
    self_id: &str,
) -> Result<(), OperationError> {
    let content = match target {
        Tagged::Story(s) | Tagged::Item(s) => s.clone(),
    };
    ensure_tag(doc, tag)?;
    // Tagged already: the element takes the new tag and keeps its id, its
    // attributes and the ranges it holds (InDesign's retag).
    if let Some(existing) = doc
        .designmap
        .xml_root
        .as_ref()
        .and_then(|r| tagging(r, &content))
    {
        let markup = tag_ref(tag);
        if let Some(el) = doc
            .designmap
            .xml_root
            .as_mut()
            .and_then(|r| r.find_mut(&existing))
        {
            el.tag = markup.clone();
        }
        if let Tagged::Story(story_id) = target {
            for top in &mut story_mut(doc, story_id)?.xml_elements {
                if top.self_id == existing {
                    top.tag = markup.clone();
                }
            }
        }
        return Ok(());
    }
    ensure_root(doc, self_id)?;
    let element = XmlElement {
        self_id: self_id.to_string(),
        tag: tag_ref(tag),
        content: Some(content),
        ..Default::default()
    };
    if let Tagged::Story(story_id) = target {
        let story = story_mut(doc, story_id)?;
        story.xml_elements.retain(|e| e.content.is_none());
        story.xml_elements.insert(0, element.clone());
    }
    doc.designmap
        .xml_root
        .as_mut()
        .expect("the root was made above")
        .children
        .push(element);
    Ok(())
}

pub(super) fn apply_create_xml_tag(
    doc: &mut Document,
    name: &str,
    color: &Option<String>,
) -> Result<AppliedOperation, OperationError> {
    if !is_tag_name(name) {
        return Err(refuse(format!("{name:?} is not a tag name")));
    }
    let self_id = tag_ref(name);
    if doc.designmap.xml_tags.iter().any(|t| t.self_id == self_id) {
        return Err(refuse(format!("the tag {name:?} exists")));
    }
    let before = capture(doc, &[]);
    doc.designmap.xml_tags.push(XmlTag {
        self_id,
        name: name.to_string(),
        color: color.clone(),
    });
    doc.designmap.xml_structure_edited = true;
    Ok(AppliedOperation {
        op: Operation::CreateXmlTag {
            name: name.to_string(),
            color: color.clone(),
        },
        // Put back as it was, the edited flag with it.
        inverse: Operation::RestoreXmlStructure { state: before },
        invalidation: InvalidationHint::default(),
    })
}

pub(super) fn apply_delete_xml_tag(
    doc: &mut Document,
    name: &str,
) -> Result<AppliedOperation, OperationError> {
    let self_id = tag_ref(name);
    if !doc.designmap.xml_tags.iter().any(|t| t.self_id == self_id) {
        return Err(OperationError::CollectionEntryNotFound {
            collection: "xmlTag".into(),
            id: name.to_string(),
        });
    }
    let in_use = doc
        .designmap
        .xml_root
        .iter()
        .flat_map(|r| r.walk())
        .chain(
            doc.stories
                .iter()
                .flat_map(|s| s.story.xml_elements.iter())
                .flat_map(|e| e.walk()),
        )
        .filter(|e| e.tag == self_id)
        .count();
    if in_use > 0 {
        return Err(refuse(format!(
            "the tag {name:?} is applied to {in_use} element(s); untag them first"
        )));
    }
    let before = capture(doc, &[]);
    doc.designmap.xml_tags.retain(|t| t.self_id != self_id);
    doc.designmap.xml_structure_edited = true;
    Ok(applied(
        Operation::DeleteXmlTag {
            name: name.to_string(),
        },
        before,
    ))
}

pub(super) fn apply_tag_item(
    doc: &mut Document,
    item: &str,
    tag: &str,
    self_id: &str,
) -> Result<AppliedOperation, OperationError> {
    let target = resolve_item(doc, item)?;
    refuse_taken_id(doc, self_id)?;
    let stories: Vec<String> = match &target {
        Tagged::Story(s) => vec![s.clone()],
        Tagged::Item(_) => vec![],
    };
    let before = capture(doc, &stories.iter().map(String::as_str).collect::<Vec<_>>());
    tag_target(doc, &target, tag, self_id)?;
    doc.designmap.xml_structure_edited = true;
    Ok(applied(
        Operation::TagItem {
            item: item.to_string(),
            tag: tag.to_string(),
            self_id: self_id.to_string(),
        },
        before,
    ))
}

pub(super) fn apply_untag_item(
    doc: &mut Document,
    item: &str,
) -> Result<AppliedOperation, OperationError> {
    let target = resolve_item(doc, item)?;
    let content = match &target {
        Tagged::Story(s) | Tagged::Item(s) => s.clone(),
    };
    let Some(element) = doc
        .designmap
        .xml_root
        .as_ref()
        .and_then(|r| tagging(r, &content))
    else {
        return Err(refuse(format!("{item:?} is not tagged")));
    };
    let stories: Vec<String> = match &target {
        Tagged::Story(s) => vec![s.clone()],
        Tagged::Item(_) => vec![],
    };
    let before = capture(doc, &stories.iter().map(String::as_str).collect::<Vec<_>>());
    if let Some(root) = doc.designmap.xml_root.as_mut() {
        remove_from(root, &element);
    }
    if let Tagged::Story(story_id) = &target {
        story_mut(doc, story_id)?
            .xml_elements
            .retain(|e| e.self_id != element);
    }
    doc.designmap.xml_structure_edited = true;
    Ok(applied(
        Operation::UntagItem {
            item: item.to_string(),
        },
        before,
    ))
}

/// Places `new` (a range element) in `parent`'s children: inside the child
/// that holds it, else beside them, taking in the children it holds.
fn place_range(parent: &mut XmlElement, mut new: XmlElement) -> Result<(), OperationError> {
    let r = new.range.expect("a range element");
    let holds =
        |outer: XmlRange, inner: XmlRange| outer.start <= inner.start && inner.end <= outer.end;
    let cuts = |a: XmlRange, b: XmlRange| a.start < b.end && b.start < a.end;
    if let Some(i) = parent
        .children
        .iter()
        .position(|c| c.range.is_some_and(|cr| holds(cr, r) && cr != r))
    {
        return place_range(&mut parent.children[i], new);
    }
    // A refusal leaves `parent` part-moved; the caller puts the captured
    // structure back.
    let mut kept = Vec::new();
    for child in std::mem::take(&mut parent.children) {
        match child.range {
            Some(cr) if holds(r, cr) => new.children.push(child),
            Some(cr) if cuts(r, cr) => {
                return Err(refuse(format!(
                    "the range cuts across the tagged range {:?}",
                    child.self_id
                )));
            }
            _ => kept.push(child),
        }
    }
    let at = kept
        .iter()
        .position(|c| c.range.is_some_and(|cr| cr.start >= r.end))
        .unwrap_or(kept.len());
    kept.insert(at, new);
    parent.children = kept;
    Ok(())
}

pub(super) fn apply_tag_range(
    doc: &mut Document,
    story_id: &str,
    start: u32,
    end: u32,
    tag: &str,
    self_id: &str,
) -> Result<AppliedOperation, OperationError> {
    let len = story_mut(doc, story_id)?.flat_text().chars().count() as u32;
    if start > end || end > len {
        return Err(refuse(format!(
            "[{start}, {end}) is not a range of the story's {len} characters"
        )));
    }
    refuse_taken_id(doc, self_id)?;
    let before = capture(doc, &[story_id]);
    ensure_tag(doc, tag)?;
    if !story_mut(doc, story_id)?
        .xml_elements
        .iter()
        .any(|e| e.content.is_some())
    {
        let story_element = format!("{self_id}s");
        refuse_taken_id(doc, &story_element)?;
        tag_target(
            doc,
            &Tagged::Story(story_id.to_string()),
            STORY_TAG,
            &story_element,
        )?;
    }
    let new = XmlElement {
        self_id: self_id.to_string(),
        tag: tag_ref(tag),
        range: Some(XmlRange { start, end }),
        ..Default::default()
    };
    let story = story_mut(doc, story_id)?;
    let top = story
        .xml_elements
        .iter_mut()
        .find(|e| e.content.is_some())
        .expect("the story is tagged above");
    if let Err(e) = place_range(top, new) {
        restore(doc, &before)?;
        return Err(e);
    }
    doc.designmap.xml_structure_edited = true;
    Ok(applied(
        Operation::TagRange {
            story_id: story_id.to_string(),
            start,
            end,
            tag: tag.to_string(),
            self_id: self_id.to_string(),
        },
        before,
    ))
}

/// The story whose elements hold `element`.
fn story_holding(doc: &Document, element: &str) -> Option<String> {
    doc.stories
        .iter()
        .find(|s| {
            s.story
                .xml_elements
                .iter()
                .any(|e| e.find(element).is_some())
        })
        .map(|s| s.self_id.clone())
}

pub(super) fn apply_untag_range(
    doc: &mut Document,
    element: &str,
) -> Result<AppliedOperation, OperationError> {
    let Some(story_id) = story_holding(doc, element) else {
        return Err(refuse(format!("no tagged range {element:?}")));
    };
    let before = capture(doc, &[&story_id]);
    let story = story_mut(doc, &story_id)?;
    fn lift(parent: &mut XmlElement, id: &str) -> bool {
        if let Some(i) = parent
            .children
            .iter()
            .position(|c| c.self_id == id && c.range.is_some())
        {
            let removed = parent.children.remove(i);
            for (k, child) in removed.children.into_iter().enumerate() {
                parent.children.insert(i + k, child);
            }
            return true;
        }
        parent.children.iter_mut().any(|c| lift(c, id))
    }
    if !story.xml_elements.iter_mut().any(|top| lift(top, element)) {
        return Err(refuse(format!("{element:?} does not tag a text range")));
    }
    doc.designmap.xml_structure_edited = true;
    Ok(applied(
        Operation::UntagRange {
            element: element.to_string(),
        },
        before,
    ))
}

pub(super) fn apply_set_xml_attribute(
    doc: &mut Document,
    element: &str,
    name: &str,
    value: &Option<String>,
) -> Result<AppliedOperation, OperationError> {
    if !is_tag_name(name) {
        return Err(refuse(format!("{name:?} is not an attribute name")));
    }
    // An element by its id, or by the page item or story it tags.
    let element = if element_ids(doc).contains(&element) {
        element.to_string()
    } else {
        let content = match resolve_item(doc, element)? {
            Tagged::Story(s) | Tagged::Item(s) => s,
        };
        doc.designmap
            .xml_root
            .as_ref()
            .and_then(|r| tagging(r, &content))
            .ok_or_else(|| refuse(format!("{element:?} is not tagged")))?
    };
    let element = element.as_str();
    let story = story_holding(doc, element);
    let before = capture(doc, &story.iter().map(String::as_str).collect::<Vec<_>>());
    // An element tagging a story keeps its attributes with the story's copy.
    let el = match &story {
        Some(s) => story_mut(doc, s)?
            .xml_elements
            .iter_mut()
            .find_map(|e| e.find_mut(element)),
        None => doc
            .designmap
            .xml_root
            .as_mut()
            .and_then(|r| r.find_mut(element)),
    }
    .ok_or_else(|| refuse(format!("no element {element:?}")))?;
    let at = el.attributes.iter().position(|(k, _)| k == name);
    match (at, value) {
        (Some(i), Some(v)) => el.attributes[i].1 = v.clone(),
        (None, Some(v)) => el.attributes.push((name.to_string(), v.clone())),
        (Some(i), None) => {
            el.attributes.remove(i);
        }
        (None, None) => {}
    }
    doc.designmap.xml_structure_edited = true;
    Ok(applied(
        Operation::SetXmlAttribute {
            element: element.to_string(),
            name: name.to_string(),
            value: value.clone(),
        },
        before,
    ))
}

fn restore(doc: &mut Document, state: &str) -> Result<(), OperationError> {
    let state: XmlState =
        serde_json::from_str(state).map_err(|e| refuse(format!("bad captured state: {e}")))?;
    doc.designmap.xml_tags = state.tags;
    doc.designmap.xml_root = state.root;
    doc.designmap.xml_structure_edited = state.edited;
    for (id, elements) in state.stories {
        if let Some(s) = doc.stories.iter_mut().find(|s| s.self_id == id) {
            s.story.xml_elements = elements;
        }
    }
    Ok(())
}

pub(super) fn apply_restore_xml_structure(
    doc: &mut Document,
    state: &str,
) -> Result<AppliedOperation, OperationError> {
    let parsed: XmlState =
        serde_json::from_str(state).map_err(|e| refuse(format!("bad captured state: {e}")))?;
    let stories: Vec<&str> = parsed.stories.iter().map(|(id, _)| id.as_str()).collect();
    let before = capture(doc, &stories);
    restore(doc, state)?;
    Ok(applied(
        Operation::RestoreXmlStructure {
            state: state.to_string(),
        },
        before,
    ))
}

/// The run of `story` holding character `offset`: its start and length.
fn run_at(story: &paged_model::Story, offset: u32) -> Option<(u32, u32)> {
    let mut at = 0u32;
    for run in story.paragraphs.iter().flat_map(|p| p.runs.iter()) {
        let n = run.text.chars().count() as u32;
        if offset < at + n {
            return Some((at, n));
        }
        at += n;
    }
    None
}

/// How a field operation changes its story's text.
pub(super) enum TextChange {
    /// Characters inserted at the offset the operation echoes.
    Insert,
    /// Characters deleted at the offset the operation echoes.
    Delete,
    /// The run holding this offset replaced (a placeholder's new value).
    ReplaceRun(u32),
}

/// Applies a field operation on `story_id` and moves the story's tagged
/// ranges through the text it changed (engine ADR 1002).
pub(super) fn keeping_ranges(
    doc: &mut Document,
    story_id: &str,
    change: TextChange,
    apply: impl FnOnce(&mut Document) -> Result<AppliedOperation, OperationError>,
) -> Result<AppliedOperation, OperationError> {
    let story = |doc: &Document| {
        doc.stories
            .iter()
            .find(|s| s.self_id == story_id)
            .map(|s| s.story.flat_text().chars().count() as u32)
    };
    let tagged = doc
        .stories
        .iter()
        .find(|s| s.self_id == story_id)
        .is_some_and(|s| !s.story.xml_elements.is_empty());
    if !tagged {
        return apply(doc);
    }
    let len_before = story(doc).unwrap_or(0);
    let old_run = match change {
        TextChange::ReplaceRun(o) => doc
            .stories
            .iter()
            .find(|s| s.self_id == story_id)
            .and_then(|s| run_at(&s.story, o)),
        _ => None,
    };
    let out = apply(doc)?;
    let len_after = story(doc).unwrap_or(0);
    let echoed = match &out.op {
        Operation::InsertField { offset, .. }
        | Operation::DeleteField { offset, .. }
        | Operation::SetFieldValue { offset, .. } => *offset,
        _ => 0,
    };
    let (at, removed, inserted) = match (change, old_run) {
        (TextChange::ReplaceRun(_), Some((start, n))) => {
            (start, n, (len_after + n).saturating_sub(len_before))
        }
        (TextChange::Delete, _) => (echoed, len_before.saturating_sub(len_after), 0),
        _ => (echoed, 0, len_after.saturating_sub(len_before)),
    };
    if let Some(s) = doc.stories.iter_mut().find(|s| s.self_id == story_id) {
        s.story.shift_xml_ranges(at, removed, inserted);
    }
    Ok(out)
}
