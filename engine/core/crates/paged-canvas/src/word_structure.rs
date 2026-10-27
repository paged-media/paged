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

//! Engine ADR 1022 — the Word document-structure mutations, lowered over
//! the current layout: Word's F9 (`updateFields`), a field inserted with
//! its result, Insert Cross-reference, Insert Table of Contents (and its
//! update in place), and the offsets of bookmarks and index markers.

use paged_mutate::operation::FieldKind;
use paged_mutate::Operation;
use paged_renderer::pipeline::word_fields::{updated_field_paragraphs, FieldUpdate};
use paged_renderer::{BuiltDocument, Document};
use paged_wire::{CrossReferenceKind, CrossReferenceTarget, TocLevelSpec};

use crate::channel::WorkerError;

fn refuse(what: String) -> WorkerError {
    WorkerError::NotImplemented { what }
}

/// The paragraph holding story char `offset` (the story-range space, no
/// paragraph separators) and the offset within it. An offset on a boundary
/// is the start of the later paragraph; past the end, the end of the last.
pub(crate) fn char_to_paragraph(
    paragraphs: &[paged_model::Paragraph],
    offset: u32,
) -> (usize, u32) {
    let mut start = 0u32;
    for (i, p) in paragraphs.iter().enumerate() {
        let n: u32 = p.runs.iter().map(|r| r.text.chars().count() as u32).sum();
        if offset < start + n || (offset == start + n && i + 1 == paragraphs.len()) {
            return (i, offset - start);
        }
        start += n;
    }
    (paragraphs.len().saturating_sub(1), 0)
}

/// The paragraph and in-paragraph char offset of a CARET offset (UTF-8
/// bytes, one separator per paragraph boundary): unambiguous at a boundary.
pub(crate) fn content_to_paragraph(
    paragraphs: &[paged_model::Paragraph],
    content: u32,
) -> Option<(usize, u32)> {
    let mut consumed = 0u32;
    for (i, p) in paragraphs.iter().enumerate() {
        let text: String = p.runs.iter().map(|r| r.text.as_str()).collect();
        let len = text.len() as u32;
        if content <= consumed + len {
            let local = (content - consumed) as usize;
            if !text.is_char_boundary(local) {
                return None;
            }
            return Some((i, text[..local].chars().count() as u32));
        }
        consumed += len + 1;
    }
    None
}

/// The story char offset of (paragraph, char in it).
fn paragraph_to_char(paragraphs: &[paged_model::Paragraph], paragraph: usize, local: u32) -> u32 {
    paragraphs[..paragraph.min(paragraphs.len())]
        .iter()
        .flat_map(|p| p.runs.iter())
        .map(|r| r.text.chars().count() as u32)
        .sum::<u32>()
        + local
}

/// Destinations after paragraphs `[start, start + removed)` were replaced
/// by `inserted` paragraphs: those after the range move with it, those
/// inside stand at its start.
fn shifted_destinations(
    destinations: &[paged_model::StoryDestination],
    start: usize,
    removed: usize,
    inserted: usize,
) -> Vec<paged_model::StoryDestination> {
    destinations
        .iter()
        .cloned()
        .map(|mut d| {
            let p = d.paragraph as usize;
            if p >= start + removed {
                d.paragraph = (p - removed + inserted) as u32;
            } else if p >= start {
                d.paragraph = start as u32;
                d.offset = 0;
            }
            d
        })
        .collect()
}

/// The page facts an update reads, for a build of a document.
struct PageFacts {
    paragraph_pages: paged_scene::ParagraphPages,
    labels: Vec<String>,
    numbers: Vec<u32>,
    sections: Vec<Option<usize>>,
}

fn page_facts(scene: &Document, built: &BuiltDocument) -> PageFacts {
    let names: std::collections::HashMap<&str, Option<&str>> = scene
        .spreads
        .iter()
        .flat_map(|parsed| parsed.spread.pages.iter())
        .filter_map(|p| Some((p.self_id.as_deref()?, p.name.as_deref())))
        .collect();
    let mut labels = Vec::new();
    let mut numbers = Vec::new();
    let mut sections = Vec::new();
    let mut walk = paged_model::SectionWalk::new(&scene.designmap.sections);
    for p in &built.pages {
        let id = p.id.as_str();
        labels.push(walk.next_label(Some(id), names.get(id).copied().flatten()));
        numbers.push(walk.current_number());
        sections.push(walk.active_section());
    }
    PageFacts {
        paragraph_pages: built.paragraph_pages(),
        labels,
        numbers,
        sections,
    }
}

fn now_of(
    now: Option<&str>,
) -> Result<Option<paged_model::word_field::CivilDateTime>, WorkerError> {
    match now {
        None => Ok(None),
        Some(s) => paged_model::word_field::CivilDateTime::parse(s)
            .map(Some)
            .ok_or_else(|| {
                refuse(format!(
                    "updateFields: {s:?} is not a date (YYYY-MM-DDTHH:MM:SS)"
                ))
            }),
    }
}

fn batch(mut ops: Vec<Operation>) -> Operation {
    if ops.len() == 1 {
        ops.pop().expect("one op")
    } else {
        Operation::Batch { ops }
    }
}

/// The paragraph styles Word gives a table of contents: `TOC 1`… with a
/// right tab and its leader at the measure, each level indented 12 pt
/// further; `TOC Heading` for the title.
fn toc_level_style(
    level: u32,
    tab: f32,
    leader: &str,
    based_on: Option<&str>,
) -> paged_model::ParagraphStyleDef {
    paged_model::ParagraphStyleDef {
        self_id: format!("ParagraphStyle/TOC {level}"),
        name: Some(format!("TOC {level}")),
        based_on: based_on.map(str::to_string),
        left_indent: Some(12.0 * level.saturating_sub(1) as f32),
        space_after: Some(5.0),
        tab_list: vec![paged_model::TabStop {
            position: tab,
            alignment: Some("RightAlign".to_string()),
            alignment_character: None,
            leader: (!leader.is_empty()).then(|| leader.to_string()),
        }],
        ..Default::default()
    }
}

impl super::CanvasModel {
    /// A one-shot build of `scene` (a copy the caller changed), off the
    /// live caches: what a lowering reads when its own edit moves pages.
    fn scratch_build(&self, scene: &Document) -> Result<BuiltDocument, WorkerError> {
        let resolver = super::build_font_resolver(&self.font_registry, self.font_bytes.as_deref());
        let resource_providers = self.resource_tiles.provider_entries();
        let grow_hint = std::cell::RefCell::new(self.grow_hint.borrow().clone());
        let mut options = self.pipeline_options(
            super::PipelinePurpose::Export,
            resolver
                .as_ref()
                .map(|r| r as &dyn paged_renderer::AssetResolver),
            &resource_providers,
        );
        options.grow_hint = Some(&grow_hint);
        paged_renderer::pipeline::build_document(scene, &options)
            .map_err(|e| refuse(format!("the layout did not build ({e})")))
    }

    /// Engine ADR 1022 — `updateFields` (Word's F9): the fields' results
    /// over the current layout, one `ReplaceStoryParagraphs` per story it
    /// changes, in one batch.
    pub(super) fn lower_update_fields(
        &mut self,
        story_id: Option<&str>,
        offset: Option<u32>,
        now: Option<&str>,
    ) -> Result<Operation, WorkerError> {
        self.settle_owed_build("updateFields")?;
        let now = now_of(now)?;
        if let Some(story) = story_id {
            if !self.scene.stories.iter().any(|s| s.self_id == story) {
                return Err(refuse(format!("updateFields: no story {story}")));
            }
        }
        let facts = page_facts(&self.scene, &self.built);
        let upd = FieldUpdate {
            document: &self.scene,
            paragraph_pages: &facts.paragraph_pages,
            page_labels: &facts.labels,
            page_numbers: &facts.numbers,
            page_sections: &facts.sections,
            now,
        };
        let changed =
            updated_field_paragraphs(&upd, story_id, offset.filter(|_| story_id.is_some()));
        if changed.is_empty() {
            return Err(refuse(
                "updateFields: every field already shows its result".to_string(),
            ));
        }
        Ok(batch(
            changed
                .into_iter()
                .map(|(story_id, paragraphs)| Operation::ReplaceStoryParagraphs {
                    story_id,
                    paragraphs_json: serde_json::to_string(&paragraphs)
                        .expect("paragraphs serialize"),
                })
                .collect(),
        ))
    }

    /// The result a Word field inserted at story char `offset` of
    /// `story_id` shows: `pre` and the field's insertion applied to a copy,
    /// then that one field updated over the current layout (inserting a run
    /// moves no paragraph). `None` when the field has no result to compute
    /// (an opaque field, a date without a clock).
    fn computed_field_result(
        &self,
        pre: &[Operation],
        story_id: &str,
        offset: u32,
        code: &str,
        now: Option<paged_model::word_field::CivilDateTime>,
    ) -> Result<Option<String>, WorkerError> {
        let mut scratch = self.scene.clone();
        for op in pre {
            paged_mutate::apply(&mut scratch, op)
                .map_err(|e| refuse(format!("insertField: {e}")))?;
        }
        paged_mutate::apply(
            &mut scratch,
            &Operation::InsertField {
                story_id: story_id.to_string(),
                offset,
                field: FieldKind::Word {
                    code: code.to_string(),
                    result: None,
                },
                content_offset: None,
            },
        )
        .map_err(|e| refuse(format!("insertField: {e}")))?;
        let facts = page_facts(&self.scene, &self.built);
        let upd = FieldUpdate {
            document: &scratch,
            paragraph_pages: &facts.paragraph_pages,
            page_labels: &facts.labels,
            page_numbers: &facts.numbers,
            page_sections: &facts.sections,
            now,
        };
        let changed = updated_field_paragraphs(&upd, Some(story_id), Some(offset));
        let Some((_, paragraphs)) = changed.into_iter().next() else {
            return Ok(None);
        };
        // The run that starts at `offset` and carries the field.
        let mut at = 0u32;
        for p in &paragraphs {
            for r in &p.runs {
                if at == offset && r.field.is_some() {
                    return Ok(Some(r.text.clone()));
                }
                at += r.text.chars().count() as u32;
            }
        }
        Ok(None)
    }

    /// The story char offset an op names: `content_offset` (caret unit)
    /// when given, else `offset`.
    fn story_char_offset(
        &self,
        what: &str,
        story_id: &str,
        offset: u32,
        content_offset: Option<u32>,
    ) -> Result<u32, WorkerError> {
        let parsed = self
            .scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)
            .ok_or_else(|| refuse(format!("{what}: no story {story_id}")))?;
        match content_offset {
            None => Ok(offset),
            Some(c) => paged_model::char_offset_of_content_offset(&parsed.story.paragraphs, c)
                .ok_or_else(|| refuse(format!("{what}: contentOffset {c} is outside the story"))),
        }
    }

    /// Engine ADR 1022 — a Word field inserted without a result gets the
    /// one an update would give it now.
    pub(super) fn lower_insert_word_field(
        &mut self,
        story_id: &str,
        offset: u32,
        content_offset: Option<u32>,
        code: &str,
    ) -> Result<Operation, WorkerError> {
        self.settle_owed_build("insertField")?;
        let offset = self.story_char_offset("insertField", story_id, offset, content_offset)?;
        let result = self.computed_field_result(&[], story_id, offset, code, None)?;
        Ok(Operation::InsertField {
            story_id: story_id.to_string(),
            offset,
            field: FieldKind::Word {
                code: code.to_string(),
                result,
            },
            content_offset: None,
        })
    }

    /// Engine ADR 1022 — Insert Cross-reference: a `REF` / `PAGEREF` field
    /// to a bookmark, or to a paragraph through a hidden `_Ref` bookmark
    /// made for it (reused when the paragraph has one).
    pub(super) fn lower_insert_cross_reference(
        &mut self,
        story_id: &str,
        offset: u32,
        content_offset: Option<u32>,
        target: &CrossReferenceTarget,
        refer_to: CrossReferenceKind,
        hyperlink: bool,
    ) -> Result<Operation, WorkerError> {
        const WHAT: &str = "insertCrossReference";
        self.settle_owed_build(WHAT)?;
        let offset = self.story_char_offset(WHAT, story_id, offset, content_offset)?;
        let mut pre: Vec<Operation> = Vec::new();
        let name = match (&target.bookmark, &target.story_id, target.paragraph) {
            (Some(bookmark), _, _) => {
                let (_, dest) =
                    paged_renderer::pipeline::word_fields::find_bookmark(&self.scene, bookmark)
                        .ok_or_else(|| refuse(format!("{WHAT}: no bookmark {bookmark:?}")))?;
                dest.name.clone().unwrap_or_else(|| dest.self_id.clone())
            }
            (None, Some(target_story), Some(paragraph)) => {
                let parsed = self
                    .scene
                    .stories
                    .iter()
                    .find(|s| &s.self_id == target_story)
                    .ok_or_else(|| refuse(format!("{WHAT}: no story {target_story}")))?;
                if paragraph as usize >= parsed.story.paragraphs.len() {
                    return Err(refuse(format!(
                        "{WHAT}: story {target_story} has no paragraph {paragraph}"
                    )));
                }
                // Word's hidden bookmark at the paragraph, once.
                let existing = parsed.story.destinations.iter().find(|d| {
                    d.paragraph == paragraph
                        && d.offset == 0
                        && d.name.as_deref().is_some_and(|n| n.starts_with("_Ref"))
                });
                match existing {
                    Some(d) => d.name.clone().expect("a named bookmark"),
                    None => {
                        let taken: std::collections::HashSet<&str> = self
                            .scene
                            .stories
                            .iter()
                            .flat_map(|s| s.story.destinations.iter())
                            .filter_map(|d| d.name.as_deref())
                            .collect();
                        let name = (1u32..)
                            .map(|n| format!("_Ref{n}"))
                            .find(|n| !taken.contains(n.as_str()))
                            .expect("an unused name");
                        let base = self.mint_page_item_id_with_offset(&mut 0);
                        pre.push(Operation::InsertTextAnchor {
                            story_id: target_story.clone(),
                            paragraph,
                            offset: 0,
                            self_id: format!("HyperlinkTextDestination/{base}"),
                            name: Some(name.clone()),
                            index: None,
                        });
                        name
                    }
                }
            }
            _ => {
                return Err(refuse(format!(
                    "{WHAT}: the target is a bookmark, or a story and a paragraph"
                )))
            }
        };
        let switches = match refer_to {
            CrossReferenceKind::Text => "REF",
            CrossReferenceKind::PageNumber => "PAGEREF",
            CrossReferenceKind::AboveBelow => "PAGEREF",
        };
        let mut code = format!("{switches} {name}");
        if refer_to == CrossReferenceKind::AboveBelow {
            code.push_str(" \\p");
        }
        if hyperlink {
            code.push_str(" \\h");
        }
        let result = self.computed_field_result(&pre, story_id, offset, &code, None)?;
        pre.push(Operation::InsertField {
            story_id: story_id.to_string(),
            offset,
            field: FieldKind::Word { code, result },
            content_offset: None,
        });
        Ok(batch(pre))
    }

    /// Engine ADR 1022 — Insert Table of Contents: the TOC style and its
    /// entry styles when missing, then the entries in paragraphs of their
    /// own at the caret, with the page numbers the insertion itself makes.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn lower_insert_toc(
        &mut self,
        story_id: &str,
        offset: u32,
        content_offset: Option<u32>,
        levels: &[TocLevelSpec],
        title: Option<&str>,
        toc_style_name: Option<&str>,
        page_numbers: bool,
        leader: Option<&str>,
        tab_position: Option<f32>,
    ) -> Result<Operation, WorkerError> {
        const WHAT: &str = "insertTableOfContents";
        self.settle_owed_build(WHAT)?;
        let parsed = self
            .scene
            .stories
            .iter()
            .find(|s| s.self_id == story_id)
            .ok_or_else(|| refuse(format!("{WHAT}: no story {story_id}")))?;
        let paragraphs = &parsed.story.paragraphs;
        let (para, local) = match content_offset {
            Some(c) => content_to_paragraph(paragraphs, c)
                .ok_or_else(|| refuse(format!("{WHAT}: contentOffset {c} is outside the story")))?,
            None => char_to_paragraph(paragraphs, offset),
        };
        let insert_at = if local == 0 { para } else { para + 1 };
        if levels.is_empty() {
            return Err(refuse(format!("{WHAT}: a table of contents needs a level")));
        }
        let styles = &self.scene.styles;
        for l in levels {
            if !styles.paragraph_styles.contains_key(&l.style) {
                return Err(refuse(format!("{WHAT}: no paragraph style {}", l.style)));
            }
            if !(1..=9).contains(&l.level) {
                return Err(refuse(format!("{WHAT}: level {} is not 1 to 9", l.level)));
            }
        }
        let name = toc_style_name.unwrap_or("Table of Contents");
        let toc_id = format!("TOCStyle/{name}");
        let mut ops: Vec<Operation> = Vec::new();
        let def = match styles.toc_styles.get(&toc_id) {
            Some(def) => def.clone(),
            None => {
                // The measure: the story's frame's width inside its insets.
                let tab = tab_position.unwrap_or_else(|| {
                    self.scene
                        .frame_for_story
                        .get(story_id)
                        .map(|f| {
                            let inset = f.inset_spacing.unwrap_or([0.0; 4]);
                            (f.bounds.right - f.bounds.left - inset[1] - inset[3]).max(1.0)
                        })
                        .unwrap_or(468.0)
                });
                let leader = leader.unwrap_or(".");
                let basic = [
                    "ParagraphStyle/Normal",
                    "ParagraphStyle/$ID/NormalParagraphStyle",
                ]
                .into_iter()
                .find(|s| styles.paragraph_styles.contains_key(*s));
                let mut wanted: Vec<u32> = levels.iter().map(|l| l.level).collect();
                wanted.sort_unstable();
                wanted.dedup();
                for level in wanted {
                    let id = format!("ParagraphStyle/TOC {level}");
                    if styles.paragraph_styles.contains_key(&id) {
                        continue;
                    }
                    let def = toc_level_style(level, tab, leader, basic);
                    ops.push(Operation::CreateParagraphStyle {
                        self_id: None,
                        name: None,
                        based_on: None,
                        restore_json: Some(
                            serde_json::to_string(&def).expect("a style serializes"),
                        ),
                    });
                }
                let title_style = "ParagraphStyle/TOC Heading";
                if title.is_some() && !styles.paragraph_styles.contains_key(title_style) {
                    let def = paged_model::ParagraphStyleDef {
                        self_id: title_style.to_string(),
                        name: Some("TOC Heading".to_string()),
                        based_on: basic.map(str::to_string),
                        point_size: Some(16.0),
                        space_after: Some(12.0),
                        ..Default::default()
                    };
                    ops.push(Operation::CreateParagraphStyle {
                        self_id: None,
                        name: None,
                        based_on: None,
                        restore_json: Some(
                            serde_json::to_string(&def).expect("a style serializes"),
                        ),
                    });
                }
                let def = paged_model::TOCStyleDef {
                    self_id: toc_id.clone(),
                    name: Some(name.to_string()),
                    title: title.map(str::to_string),
                    title_style: title.map(|_| title_style.to_string()),
                    entries: levels
                        .iter()
                        .map(|l| paged_model::TOCStyleEntryDef {
                            name: styles
                                .paragraph_styles
                                .get(&l.style)
                                .and_then(|s| s.name.clone()),
                            include_style: Some(l.style.clone()),
                            format_style: Some(format!("ParagraphStyle/TOC {}", l.level)),
                            level: Some(l.level),
                            separator: Some("^t".to_string()),
                            page_number_position: Some(
                                if page_numbers { "AfterEntry" } else { "None" }.to_string(),
                            ),
                            ..Default::default()
                        })
                        .collect(),
                    ..Default::default()
                };
                ops.push(Operation::SetTocStyle {
                    toc_style_id: toc_id.clone(),
                    def_json: Some(serde_json::to_string(&def).expect("a TOC style serializes")),
                });
                def
            }
        };
        self.toc_in_story(story_id, &def, insert_at, 0, ops)
    }

    /// Engine ADR 1022 — `updateTableOfContents` on a story whose table of
    /// contents stands in its text: the paragraphs naming the TOC style are
    /// rewritten in place.
    pub(super) fn lower_update_toc_in_text(
        &mut self,
        story_id: &str,
    ) -> Result<Option<Operation>, WorkerError> {
        let Some(parsed) = self.scene.stories.iter().find(|s| s.self_id == story_id) else {
            return Ok(None);
        };
        let paragraphs = &parsed.story.paragraphs;
        let Some(start) = paragraphs.iter().position(|p| p.toc.is_some()) else {
            return Ok(None);
        };
        let toc_id = paragraphs[start].toc.clone().expect("a toc paragraph");
        let len = paragraphs[start..]
            .iter()
            .take_while(|p| p.toc.as_deref() == Some(toc_id.as_str()))
            .count();
        let def = self
            .scene
            .styles
            .toc_styles
            .get(&toc_id)
            .cloned()
            .ok_or_else(|| {
                refuse(format!(
                "updateTableOfContents: story {story_id} names {toc_id}, which the document lacks"
            ))
            })?;
        self.toc_in_story(story_id, &def, start, len, Vec::new())
            .map(Some)
    }

    /// The batch that puts a table of contents of `def` at paragraph `start`
    /// of `story_id` in place of `removed` paragraphs, after `pre` (the
    /// styles it creates). Its page numbers are those of the layout the
    /// batch itself makes: the entries are written once over the current
    /// layout, the result built on a copy, and the entries written again
    /// over that build when its pages differ.
    fn toc_in_story(
        &self,
        story_id: &str,
        def: &paged_model::TOCStyleDef,
        start: usize,
        removed: usize,
        pre: Vec<Operation>,
    ) -> Result<Operation, WorkerError> {
        let make = |scene: &Document, built: &BuiltDocument| -> Vec<paged_model::Paragraph> {
            let facts = page_facts(scene, built);
            let entries = scene.resolve_toc_on(def, &facts.paragraph_pages);
            let mut out = paged_renderer::pipeline::toc_paragraphs(def, entries, &facts.labels);
            for p in &mut out {
                p.toc = Some(def.self_id.clone());
            }
            out
        };
        let ops_for = |toc: &[paged_model::Paragraph]| -> Result<Operation, WorkerError> {
            let parsed = self
                .scene
                .stories
                .iter()
                .find(|s| s.self_id == story_id)
                .ok_or_else(|| refuse(format!("no story {story_id}")))?;
            let old = &parsed.story.paragraphs;
            let mut next: Vec<paged_model::Paragraph> = Vec::with_capacity(old.len() + toc.len());
            next.extend_from_slice(&old[..start.min(old.len())]);
            next.extend_from_slice(toc);
            next.extend_from_slice(&old[(start + removed).min(old.len())..]);
            let mut ops = pre.clone();
            ops.push(Operation::ReplaceStoryParagraphs {
                story_id: story_id.to_string(),
                paragraphs_json: serde_json::to_string(&next).expect("paragraphs serialize"),
            });
            if !parsed.story.destinations.is_empty() && removed != toc.len() {
                let dests =
                    shifted_destinations(&parsed.story.destinations, start, removed, toc.len());
                ops.push(Operation::SetStoryDestinations {
                    story_id: story_id.to_string(),
                    destinations_json: serde_json::to_string(&dests)
                        .expect("destinations serialize"),
                });
            }
            Ok(batch(ops))
        };
        let first = make(&self.scene, &self.built);
        let op = ops_for(&first)?;
        let mut scratch = self.scene.clone();
        paged_mutate::apply(&mut scratch, &op)
            .map_err(|e| refuse(format!("tableOfContents: {e}")))?;
        let built = self.scratch_build(&scratch)?;
        let second = make(&scratch, &built);
        let same = serde_json::to_string(&first).ok() == serde_json::to_string(&second).ok();
        if same {
            Ok(op)
        } else {
            ops_for(&second)
        }
    }

    /// Engine ADR 1022 — the paragraph and in-paragraph offset of a
    /// bookmark or index marker an op places.
    pub(super) fn paragraph_at(
        &self,
        story_id: &str,
        offset: u32,
        content_offset: Option<u32>,
    ) -> Option<(u32, u32)> {
        let parsed = self.scene.stories.iter().find(|s| s.self_id == story_id)?;
        let paragraphs = &parsed.story.paragraphs;
        let (p, local) = match content_offset {
            Some(c) => content_to_paragraph(paragraphs, c)?,
            None => char_to_paragraph(paragraphs, offset),
        };
        Some((p as u32, local))
    }
}

/// Engine ADR 1022 — keep a story's text destinations where they stand
/// across a text edit: each is moved through the replacement of `removed`
/// characters at story char `at` by `inserted`, the way a tagged range is,
/// then put back into the paragraph that now holds it. `before` is the
/// story's paragraphs before the edit; a destination at a paragraph's start
/// stays at a paragraph's start.
pub(crate) fn keep_destinations(
    story: &mut paged_model::Story,
    before: &[paged_model::Paragraph],
    at: u32,
    removed: u32,
    inserted: u32,
) {
    if story.destinations.is_empty() {
        return;
    }
    let absolute: Vec<(u32, bool)> = story
        .destinations
        .iter()
        .map(|d| {
            (
                paragraph_to_char(before, d.paragraph as usize, d.offset),
                d.offset == 0,
            )
        })
        .collect();
    // Paragraph starts after the edit.
    let mut starts: Vec<u32> = Vec::with_capacity(story.paragraphs.len());
    let mut acc = 0u32;
    for p in &story.paragraphs {
        starts.push(acc);
        acc += p
            .runs
            .iter()
            .map(|r| r.text.chars().count() as u32)
            .sum::<u32>();
    }
    for (d, (abs, at_start)) in story.destinations.iter_mut().zip(absolute) {
        let moved = if abs < at {
            abs
        } else if abs >= at + removed {
            abs - removed + inserted
        } else {
            at
        };
        let pi = if at_start {
            // The last paragraph starting there (a split keeps the
            // destination on the paragraph it opened).
            starts
                .iter()
                .rposition(|s| *s == moved)
                .or_else(|| starts.iter().rposition(|s| *s <= moved))
        } else {
            starts.iter().rposition(|s| *s < moved).or(Some(0))
        }
        .unwrap_or(0);
        d.paragraph = pi as u32;
        d.offset = moved - starts.get(pi).copied().unwrap_or(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(t: &str) -> paged_model::Paragraph {
        paged_model::Paragraph {
            runs: vec![paged_model::CharacterRun {
                text: t.into(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn offsets_find_their_paragraph() {
        let ps = vec![para("abc"), para("de")];
        assert_eq!(char_to_paragraph(&ps, 0), (0, 0));
        assert_eq!(
            char_to_paragraph(&ps, 3),
            (1, 0),
            "a boundary opens the later"
        );
        assert_eq!(char_to_paragraph(&ps, 5), (1, 2));
        assert_eq!(content_to_paragraph(&ps, 3), Some((0, 3)));
        assert_eq!(content_to_paragraph(&ps, 4), Some((1, 0)));
        assert_eq!(content_to_paragraph(&ps, 7), None);
    }

    #[test]
    fn destinations_follow_text_edits() {
        let before = vec![para("abc"), para("def")];
        let mut story = paged_model::Story {
            paragraphs: vec![para("aXXbc"), para("def")],
            destinations: vec![
                paged_model::StoryDestination {
                    self_id: "d0".into(),
                    paragraph: 1,
                    offset: 0,
                    ..Default::default()
                },
                paged_model::StoryDestination {
                    self_id: "d1".into(),
                    paragraph: 0,
                    offset: 2,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        keep_destinations(&mut story, &before, 1, 0, 2);
        assert_eq!(
            (
                story.destinations[0].paragraph,
                story.destinations[0].offset
            ),
            (1, 0)
        );
        assert_eq!(
            (
                story.destinations[1].paragraph,
                story.destinations[1].offset
            ),
            (0, 4)
        );
        // A paragraph split before a destination's paragraph moves it on.
        let before = story.paragraphs.clone();
        story.paragraphs = vec![para("aX"), para("Xbc"), para("def")];
        keep_destinations(&mut story, &before, 2, 0, 0);
        assert_eq!(story.destinations[0].paragraph, 2);
        assert_eq!(
            (
                story.destinations[1].paragraph,
                story.destinations[1].offset
            ),
            (1, 2)
        );
    }
}
