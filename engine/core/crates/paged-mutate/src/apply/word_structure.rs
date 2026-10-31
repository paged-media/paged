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

//! Engine ADR 1022 — the document-structure operations a Word document
//! needs: bookmarks as text destinations, index markers, and TOC styles.

use paged_scene::Document;

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, NodeId, Operation};

fn story_not_found(story_id: &str) -> OperationError {
    OperationError::NodeNotFound(NodeId::Story(story_id.to_string()))
}

fn invalid(story_id: &str, reason: String) -> OperationError {
    OperationError::InvalidParent {
        parent: NodeId::Story(story_id.to_string()),
        child_kind: reason,
    }
}

/// Paint-free: a destination, a marker or a TOC style changes no layout
/// by itself (what reads them is rebuilt by the op that rewrites text).
fn inert() -> InvalidationHint {
    InvalidationHint::default()
}

pub(super) fn apply_insert_text_anchor(
    doc: &mut Document,
    story_id: &str,
    paragraph: u32,
    offset: u32,
    self_id: &str,
    name: Option<&str>,
    index: Option<u32>,
) -> Result<AppliedOperation, OperationError> {
    if doc
        .stories
        .iter()
        .any(|s| s.story.destinations.iter().any(|d| d.self_id == self_id))
    {
        return Err(invalid(
            story_id,
            format!("a destination {self_id:?} already exists"),
        ));
    }
    if let Some(name) = name {
        if doc.stories.iter().any(|s| {
            s.story
                .destinations
                .iter()
                .any(|d| d.name.as_deref() == Some(name))
        }) {
            return Err(invalid(
                story_id,
                format!("a bookmark named {name:?} already exists"),
            ));
        }
    }
    let parsed = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story_id)
        .ok_or_else(|| story_not_found(story_id))?;
    let Some(para) = parsed.story.paragraphs.get(paragraph as usize) else {
        return Err(invalid(
            story_id,
            format!("no paragraph {paragraph} for a bookmark"),
        ));
    };
    let chars: u32 = para
        .runs
        .iter()
        .map(|r| r.text.chars().count() as u32)
        .sum();
    let dest = paged_model::StoryDestination {
        self_id: self_id.to_string(),
        name: name.map(str::to_string),
        paragraph,
        offset: offset.min(chars),
        paragraph_destination: false,
    };
    let list = &mut parsed.story.destinations;
    let at = index.map_or(list.len(), |i| (i as usize).min(list.len()));
    list.insert(at, dest);
    Ok(AppliedOperation {
        op: Operation::InsertTextAnchor {
            story_id: story_id.to_string(),
            paragraph,
            offset: offset.min(chars),
            self_id: self_id.to_string(),
            name: name.map(str::to_string),
            index: Some(at as u32),
        },
        inverse: Operation::DeleteTextAnchor {
            anchor_id: self_id.to_string(),
        },
        invalidation: inert(),
    })
}

pub(super) fn apply_delete_text_anchor(
    doc: &mut Document,
    anchor_id: &str,
) -> Result<AppliedOperation, OperationError> {
    let Some((si, di)) = doc.stories.iter().enumerate().find_map(|(si, s)| {
        s.story
            .destinations
            .iter()
            .position(|d| d.self_id == anchor_id)
            .map(|di| (si, di))
    }) else {
        return Err(OperationError::CollectionEntryNotFound {
            collection: "textAnchors".to_string(),
            id: anchor_id.to_string(),
        });
    };
    let story_id = doc.stories[si].self_id.clone();
    let dest = doc.stories[si].story.destinations.remove(di);
    Ok(AppliedOperation {
        op: Operation::DeleteTextAnchor {
            anchor_id: anchor_id.to_string(),
        },
        inverse: Operation::InsertTextAnchor {
            story_id,
            paragraph: dest.paragraph,
            offset: dest.offset,
            self_id: dest.self_id,
            name: dest.name,
            index: Some(di as u32),
        },
        invalidation: inert(),
    })
}

pub(super) fn apply_set_story_destinations(
    doc: &mut Document,
    story_id: &str,
    destinations_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let next: Vec<paged_model::StoryDestination> = serde_json::from_str(destinations_json)
        .map_err(|e| invalid(story_id, format!("destinations that do not read ({e})")))?;
    let parsed = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story_id)
        .ok_or_else(|| story_not_found(story_id))?;
    let prev = std::mem::replace(&mut parsed.story.destinations, next);
    Ok(AppliedOperation {
        op: Operation::SetStoryDestinations {
            story_id: story_id.to_string(),
            destinations_json: destinations_json.to_string(),
        },
        inverse: Operation::SetStoryDestinations {
            story_id: story_id.to_string(),
            destinations_json: serde_json::to_string(&prev).expect("destinations serialize"),
        },
        invalidation: inert(),
    })
}

/// The `Self` the engine gives the topic at `path` (level 1 first).
pub fn index_topic_id(path: &[String]) -> String {
    format!("Topic/{}", path.join("/"))
}

pub(super) fn apply_insert_index_marker(
    doc: &mut Document,
    story_id: &str,
    paragraph: u32,
    topic: &[String],
    sort_order: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let topic: Vec<String> = topic
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if topic.is_empty() || topic.len() > 4 {
        return Err(invalid(
            story_id,
            format!("an index topic has one to four levels, not {}", topic.len()),
        ));
    }
    let si = doc
        .stories
        .iter()
        .position(|s| s.self_id == story_id)
        .ok_or_else(|| story_not_found(story_id))?;
    let Some(para) = doc.stories[si].story.paragraphs.get(paragraph as usize) else {
        return Err(invalid(
            story_id,
            format!("no paragraph {paragraph} for an index marker"),
        ));
    };
    let markers_json = serde_json::to_string(&para.index_markers).expect("markers serialize");
    let dm = &doc.designmap;
    let topics_json = serde_json::to_string(&dm.index_topics).expect("topics serialize");
    let parents_json = serde_json::to_string(&dm.index_topic_parents).expect("parents serialize");

    // Find or make each level's topic, nested under the one before: a
    // level matches an existing topic of that name (case-insensitive)
    // under the same parent.
    let mut parent: Option<String> = None;
    let mut id = String::new();
    for (level, name) in topic.iter().enumerate() {
        let dm = &doc.designmap;
        let found = dm.index_topics.iter().find(|t| {
            t.name
                .as_deref()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
                && dm.index_topic_parents.get(&t.self_id) == parent.as_ref()
        });
        id = match found {
            Some(t) => t.self_id.clone(),
            None => {
                let new_id = index_topic_id(&topic[..=level]);
                let dm = &mut doc.designmap;
                dm.index_topics.push(paged_model::IndexTopic {
                    self_id: new_id.clone(),
                    name: Some(name.clone()),
                    sort_order: (level + 1 == topic.len())
                        .then(|| sort_order.map(str::to_string))
                        .flatten(),
                });
                if let Some(p) = &parent {
                    dm.index_topic_parents.insert(new_id.clone(), p.clone());
                }
                new_id
            }
        };
        parent = Some(id.clone());
    }
    doc.stories[si].story.paragraphs[paragraph as usize]
        .index_markers
        .push(paged_model::IndexMarker {
            topic_name: topic.last().cloned().unwrap_or_default(),
            applied_topic: Some(id),
            sort_order: sort_order.map(str::to_string),
        });
    Ok(AppliedOperation {
        op: Operation::InsertIndexMarker {
            story_id: story_id.to_string(),
            paragraph,
            topic,
            sort_order: sort_order.map(str::to_string),
        },
        inverse: Operation::RestoreIndexMarkers {
            story_id: story_id.to_string(),
            paragraph,
            markers_json,
            topics_json,
            parents_json,
        },
        invalidation: inert(),
    })
}

pub(super) fn apply_restore_index_markers(
    doc: &mut Document,
    story_id: &str,
    paragraph: u32,
    markers_json: &str,
    topics_json: &str,
    parents_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let read =
        |e: serde_json::Error| invalid(story_id, format!("index state that does not read ({e})"));
    let markers: Vec<paged_model::IndexMarker> =
        serde_json::from_str(markers_json).map_err(read)?;
    let topics: Vec<paged_model::IndexTopic> = serde_json::from_str(topics_json).map_err(read)?;
    let parents: std::collections::BTreeMap<String, String> =
        serde_json::from_str(parents_json).map_err(read)?;
    let si = doc
        .stories
        .iter()
        .position(|s| s.self_id == story_id)
        .ok_or_else(|| story_not_found(story_id))?;
    let Some(para) = doc.stories[si].story.paragraphs.get_mut(paragraph as usize) else {
        return Err(invalid(story_id, format!("no paragraph {paragraph}")));
    };
    let prev_markers = std::mem::replace(&mut para.index_markers, markers);
    let dm = &mut doc.designmap;
    let prev_topics = std::mem::replace(&mut dm.index_topics, topics);
    let prev_parents = std::mem::replace(&mut dm.index_topic_parents, parents);
    Ok(AppliedOperation {
        op: Operation::RestoreIndexMarkers {
            story_id: story_id.to_string(),
            paragraph,
            markers_json: markers_json.to_string(),
            topics_json: topics_json.to_string(),
            parents_json: parents_json.to_string(),
        },
        inverse: Operation::RestoreIndexMarkers {
            story_id: story_id.to_string(),
            paragraph,
            markers_json: serde_json::to_string(&prev_markers).expect("markers serialize"),
            topics_json: serde_json::to_string(&prev_topics).expect("topics serialize"),
            parents_json: serde_json::to_string(&prev_parents).expect("parents serialize"),
        },
        invalidation: inert(),
    })
}

pub(super) fn apply_set_toc_style(
    doc: &mut Document,
    toc_style_id: &str,
    def_json: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let next: Option<paged_model::TOCStyleDef> = match def_json {
        Some(json) => {
            let mut def: paged_model::TOCStyleDef =
                serde_json::from_str(json).map_err(|e| OperationError::InvalidValue {
                    node: NodeId::Document(String::new()),
                    path: crate::operation::PropertyPath::AppliedParagraphStyle,
                    reason: format!("a TOC style that does not read ({e})"),
                })?;
            def.self_id = toc_style_id.to_string();
            Some(def)
        }
        None => None,
    };
    let prev = match next {
        Some(def) => doc.styles.toc_styles.insert(toc_style_id.to_string(), def),
        None => doc.styles.toc_styles.remove(toc_style_id),
    };
    if def_json.is_none() && prev.is_none() {
        return Err(OperationError::CollectionEntryNotFound {
            collection: "tocStyles".to_string(),
            id: toc_style_id.to_string(),
        });
    }
    Ok(AppliedOperation {
        op: Operation::SetTocStyle {
            toc_style_id: toc_style_id.to_string(),
            def_json: def_json.map(str::to_string),
        },
        inverse: Operation::SetTocStyle {
            toc_style_id: toc_style_id.to_string(),
            def_json: prev.map(|d| serde_json::to_string(&d).expect("a TOC style serializes")),
        },
        invalidation: inert(),
    })
}
