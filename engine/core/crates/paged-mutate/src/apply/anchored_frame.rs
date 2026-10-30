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

//! v52 — the anchored-frame CREATE/REMOVE door.
//!
//! The anchored-object model (`paged_model::AnchoredFrame` on
//! `Paragraph::anchored_frames`), its inline render path
//! (`paged-renderer` `anchored.rs`), and its property edits
//! (`AnchoredPosition` / `AnchoredXOffset` / …) all predate this. What was
//! missing was a way to *create* an anchored frame with a mutation — the door
//! a content plugin (paged.doc) needs to place an inline image in the text
//! flow. `InsertAnchoredFrame` pushes an image-bearing anchored Rectangle onto
//! the paragraph containing a story character offset; leaving `setting = None`
//! makes the renderer default `anchored_position` to `"InlinePosition"`, so the
//! frame is drawn inline at the paragraph origin (its `image_link` painted via
//! the existing deferred-image path).

use crate::error::OperationError;
use crate::operation::{
    AnchoredFrameInsertKind, AnchoredLayoutSpec, AppliedOperation, CellAddr, NodeId, Operation,
};
use paged_scene::Document;

use super::path_topology::reflow_hint_for_story;

/// The paragraph index in `paragraphs` whose `[start, end)` char range
/// contains character `offset`; clamps to the last paragraph when `offset` is
/// at or past the end. CONTIGUOUS char offsets — the same address space as
/// `paged_mutate::apply::character` / `apply::paragraph` (no synthetic break
/// character between paragraphs), so the frame anchors at the offset a
/// contiguous char pour computes. NOTE: this is deliberately NOT the
/// `mutate::locate` / `InsertText` byte+`\n` address space — the range-styling
/// apply ops this door sits beside walk char-contiguous, so it matches them.
fn paragraph_for_offset(
    paragraphs: &[paged_model::Paragraph],
    offset: u32,
) -> Option<(usize, u32)> {
    if paragraphs.is_empty() {
        return None;
    }
    let mut char_offset: u32 = 0;
    for (i, para) in paragraphs.iter().enumerate() {
        let chars: u32 = para
            .runs
            .iter()
            .map(|r| r.text.chars().count() as u32)
            .sum();
        let para_end = char_offset + chars;
        if offset < para_end {
            return Some((i, offset - char_offset));
        }
        if i + 1 == paragraphs.len() {
            return Some((i, chars));
        }
        char_offset = para_end; // contiguous — no inter-paragraph break char
    }
    None
}

/// The character offset of paragraph `para_idx`'s start in its stream.
fn paragraph_start(paragraphs: &[paged_model::Paragraph], para_idx: usize) -> u32 {
    paragraphs[..para_idx]
        .iter()
        .flat_map(|p| &p.runs)
        .map(|r| r.text.chars().count() as u32)
        .sum()
}

/// Where the anchored frame `self_id` stands: its story's index, the cell
/// holding its paragraph (engine ADR 1050: a picture in a table cell, at any
/// nesting) or `None` for the story's body, and the paragraph's index there.
fn locate_anchored_frame(
    doc: &Document,
    self_id: &str,
) -> Option<(usize, Option<CellAddr>, usize)> {
    fn holds(p: &paged_model::Paragraph, self_id: &str) -> bool {
        p.anchored_frames
            .iter()
            .any(|af| af.self_id.as_deref() == Some(self_id))
    }
    fn in_stream(
        paragraphs: &[paged_model::Paragraph],
        cell: Option<CellAddr>,
        self_id: &str,
    ) -> Option<(Option<CellAddr>, usize)> {
        if let Some(pi) = paragraphs.iter().position(|p| holds(p, self_id)) {
            return Some((cell, pi));
        }
        for p in paragraphs {
            let Some(table) = &p.table else {
                continue;
            };
            let Some(table_id) = table.self_id.as_deref() else {
                continue;
            };
            for c in &table.cells {
                let Some((col, row)) = c.coords() else {
                    continue;
                };
                let addr = CellAddr {
                    table_id: table_id.to_string(),
                    row,
                    col,
                };
                if let Some(found) = in_stream(&c.paragraphs, Some(addr), self_id) {
                    return Some(found);
                }
            }
        }
        None
    }
    doc.stories.iter().enumerate().find_map(|(si, ps)| {
        in_stream(&ps.story.paragraphs, None, self_id).map(|(cell, pi)| (si, cell, pi))
    })
}

/// The paragraphs of a story's body, or of the cell `cell` names.
fn stream_mut<'a>(
    story: &'a mut paged_model::Story,
    cell: Option<&CellAddr>,
) -> Option<&'a mut Vec<paged_model::Paragraph>> {
    match cell {
        None => Some(&mut story.paragraphs),
        Some(a) => {
            paged_model::cell_paragraphs_in_mut(&mut story.paragraphs, &a.table_id, a.col, a.row)
        }
    }
}

/// v52 — insert an image-bearing anchored Rectangle at the paragraph holding
/// `offset` in `story_id`. v65: `paragraph` names the paragraph outright
/// (an empty paragraph has no offset of its own in the contiguous space);
/// `offset` is still the story offset, clamped into that paragraph.
///
/// Engine ADR 1050: `kind` [`AnchoredFrameInsertKind::Text`] makes a text
/// frame holding `frame_story` (created empty when it does not exist; the
/// inverse removes a story it created), `layout` sets its wrap, z-order,
/// overlap and insets, and `restore` (an inverse's) puts a removed frame
/// back whole.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_insert_anchored_frame(
    doc: &mut Document,
    story_id: &str,
    paragraph: Option<u32>,
    offset: u32,
    width: f32,
    height: f32,
    image_uri: Option<&str>,
    self_id: &str,
    kind: AnchoredFrameInsertKind,
    frame_story: Option<&str>,
    layout: Option<&AnchoredLayoutSpec>,
    restore: Option<&str>,
    cell: Option<&CellAddr>,
) -> Result<AppliedOperation, OperationError> {
    if locate_anchored_frame(doc, self_id).is_some() {
        return Err(OperationError::DuplicateNodeId {
            id: self_id.to_string(),
        });
    }
    let story_idx = doc
        .stories
        .iter()
        .position(|s| s.self_id == story_id)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Story(story_id.to_string())))?;

    let invalid = |reason: String| OperationError::InvalidValue {
        node: NodeId::Story(story_id.to_string()),
        path: crate::PropertyPath::AnchoredPosition,
        reason,
    };
    let not_found = || OperationError::NodeNotFound(NodeId::Story(story_id.to_string()));
    // A fresh cell holds no paragraph (`insertTable` mints none): the frame
    // gets one, and the inverse puts the story back as it was.
    let before = {
        let paragraphs =
            stream_mut(&mut doc.stories[story_idx].story, cell).ok_or_else(not_found)?;
        paragraphs.is_empty().then_some(())
    }
    .map(|()| serde_json::to_string(&doc.stories[story_idx]).expect("a parsed story serializes"));
    if before.is_some() {
        let paragraphs =
            stream_mut(&mut doc.stories[story_idx].story, cell).ok_or_else(not_found)?;
        paragraphs.push(paged_model::Paragraph {
            runs: vec![paged_model::CharacterRun::default()],
            ..Default::default()
        });
    }
    let (para_idx, local) = {
        let paragraphs =
            stream_mut(&mut doc.stories[story_idx].story, cell).ok_or_else(not_found)?;
        match paragraph {
            Some(index) => {
                let para = paragraphs.get(index as usize).ok_or_else(|| {
                    invalid(format!(
                        "paragraph {index} is past the {} paragraphs there",
                        paragraphs.len()
                    ))
                })?;
                let chars: u32 = para
                    .runs
                    .iter()
                    .map(|r| r.text.chars().count() as u32)
                    .sum();
                // `offset` stays a STORY (or cell) offset (what an engine
                // without the address reads); the address only says which
                // paragraph.
                let start = paragraph_start(paragraphs, index as usize);
                (index as usize, offset.saturating_sub(start).min(chars))
            }
            None => paragraph_for_offset(paragraphs, offset).ok_or_else(not_found)?,
        }
    };

    let frame = match restore {
        Some(json) => {
            let mut frame: paged_model::AnchoredFrame = serde_json::from_str(json)
                .map_err(|e| invalid(format!("the frame to restore does not decode: {e}")))?;
            frame.self_id = Some(self_id.to_string());
            frame
        }
        None => {
            let text = kind == AnchoredFrameInsertKind::Text;
            if text && frame_story.is_none() {
                return Err(invalid("a text frame names no story".to_string()));
            }
            paged_model::AnchoredFrame {
                frame_kind: if text {
                    paged_model::AnchoredFrameKind::TextFrame
                } else {
                    paged_model::AnchoredFrameKind::Rectangle
                },
                self_id: Some(self_id.to_string()),
                bounds: Some(paged_model::Bounds {
                    top: 0.0,
                    left: 0.0,
                    bottom: height,
                    right: width,
                }),
                item_transform: None,
                parent_story: frame_story.filter(|_| text).map(str::to_string),
                // `setting: None` ⇒ the renderer defaults `anchored_position` to
                // "InlinePosition": the frame is a character of its line at `offset`.
                setting: None,
                fill_color: None,
                stroke_color: None,
                stroke_weight: None,
                fill_tint: None,
                gradient_fill_angle: None,
                applied_object_style: None,
                image_link: image_uri.filter(|_| !text).map(str::to_string),
                image_item_transform: None,
                children: Vec::new(),
                layout: layout.map(AnchoredLayoutSpec::to_model).unwrap_or_default(),
            }
        }
    };
    if let Some(own) = frame.parent_story.as_deref() {
        if own == story_id {
            return Err(invalid(
                "a text frame cannot hold its own anchor story".to_string(),
            ));
        }
    }
    // A text frame's story: created empty when absent (a fresh insert, the
    // redo of an undone one); an existing one is attached as it is.
    let minted = match frame.parent_story.as_deref() {
        Some(id) if !doc.stories.iter().any(|s| s.self_id == id) => {
            let mut story = paged_model::Story::default();
            story.paragraphs.push(paged_model::Paragraph {
                runs: vec![paged_model::CharacterRun::default()],
                ..Default::default()
            });
            doc.stories.push(paged_scene::ParsedStory {
                // Minted post-parse: the writer emits a fresh part for it.
                src: String::new(),
                self_id: id.to_string(),
                story,
            });
            Some(id.to_string())
        }
        _ => None,
    };

    let para =
        &mut stream_mut(&mut doc.stories[story_idx].story, cell).ok_or_else(not_found)?[para_idx];
    // The frame stands in its line at `offset` (an inline object is a
    // character of its line). Frames without a recorded anchor anchor
    // at the paragraph's start; give them that explicitly so this one's
    // offset lines up with its index.
    let recorded = para.anchored_frames.len();
    para.anchored_frame_offsets.resize(recorded, 0);
    para.anchored_frame_offsets.push(local);
    para.anchored_frames.push(frame);

    let invalidation = reflow_hint_for_story(doc, story_id);
    let remove = Operation::RemoveAnchoredFrame {
        story_id: story_id.to_string(),
        self_id: self_id.to_string(),
    };
    let inverse = match (before, minted) {
        (Some(story_json), minted) => Operation::Batch {
            ops: minted
                .map(|story| Operation::RemoveStory { story_id: story })
                .into_iter()
                .chain([
                    Operation::RemoveStory {
                        story_id: story_id.to_string(),
                    },
                    Operation::RestoreStory {
                        position: story_idx,
                        story_json,
                    },
                ])
                .collect(),
        },
        (None, Some(story)) => Operation::Batch {
            ops: vec![remove, Operation::RemoveStory { story_id: story }],
        },
        (None, None) => remove,
    };
    Ok(AppliedOperation {
        op: Operation::InsertAnchoredFrame {
            paragraph,
            story_id: story_id.to_string(),
            offset,
            width,
            height,
            image_uri: image_uri.map(str::to_string),
            self_id: self_id.to_string(),
            frame_kind: kind,
            frame_story: frame_story.map(str::to_string),
            layout: layout.cloned(),
            restore: restore.map(str::to_string),
            cell: cell.cloned(),
        },
        inverse,
        invalidation,
    })
}

/// v52 — remove the anchored frame `self_id` (the `InsertAnchoredFrame` inverse).
pub(super) fn apply_remove_anchored_frame(
    doc: &mut Document,
    story_id: &str,
    self_id: &str,
) -> Result<AppliedOperation, OperationError> {
    let (story_idx, cell, para_idx) = locate_anchored_frame(doc, self_id)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Story(story_id.to_string())))?;

    let paragraphs = stream_mut(&mut doc.stories[story_idx].story, cell.as_ref())
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Story(story_id.to_string())))?;
    let para_start = paragraph_start(paragraphs, para_idx);
    let para = &mut paragraphs[para_idx];
    let pos = para
        .anchored_frames
        .iter()
        .position(|af| af.self_id.as_deref() == Some(self_id))
        .expect("locate_anchored_frame just found it");
    let removed = para.anchored_frames.remove(pos);
    let local = if pos < para.anchored_frame_offsets.len() {
        para.anchored_frame_offsets.remove(pos)
    } else {
        0
    };

    let width = removed.bounds.map(|b| b.right - b.left).unwrap_or(0.0);
    let height = removed.bounds.map(|b| b.bottom - b.top).unwrap_or(0.0);
    let invalidation = reflow_hint_for_story(doc, story_id);
    Ok(AppliedOperation {
        op: Operation::RemoveAnchoredFrame {
            story_id: story_id.to_string(),
            self_id: self_id.to_string(),
        },
        inverse: Operation::InsertAnchoredFrame {
            // By paragraph: the contiguous offset cannot name an empty one.
            paragraph: Some(para_idx as u32),
            story_id: story_id.to_string(),
            offset: para_start + local,
            width,
            height,
            image_uri: removed.image_link.clone(),
            self_id: self_id.to_string(),
            frame_kind: if removed.frame_kind == paged_model::AnchoredFrameKind::TextFrame {
                AnchoredFrameInsertKind::Text
            } else {
                AnchoredFrameInsertKind::Graphic
            },
            frame_story: removed.parent_story.clone(),
            layout: (!removed.layout.is_unset())
                .then(|| AnchoredLayoutSpec::from_model(&removed.layout)),
            // The whole frame, so undo puts back its anchoring and look too.
            restore: serde_json::to_string(&removed).ok(),
            cell,
        },
        invalidation,
    })
}
