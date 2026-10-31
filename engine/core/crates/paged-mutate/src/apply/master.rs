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

use super::*;
use paged_scene::Document;

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, NodeId, Operation};

// ---------------------------------------------------------------------------
// W0.5 — master application
// ---------------------------------------------------------------------------

pub(super) fn apply_master_to_page(
    doc: &mut Document,
    page: &str,
    master: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    // Engine ADR 1026 — a master page applies a master too ("Based on
    // Master"): refused when it would make a cycle or stack more than
    // `MAX_MASTER_DEPTH` masters.
    if let (Some(own), Some(parent)) = (master_holding_page(doc, page), master) {
        if !doc.master_basis_allowed(&own, parent) {
            return Err(master_error(
                &own,
                format!(
                    "master {own} cannot be based on {parent}: it would make a cycle, name a \
                     master the document lacks, or stack more than {} masters",
                    paged_scene::MAX_MASTER_DEPTH
                ),
            ));
        }
    }
    let page_ref = find_page_or_master_page_mut(doc, page)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Page(page.to_string())))?;
    let prev = page_ref.applied_master.clone();
    page_ref.applied_master = master.map(str::to_string);
    Ok(AppliedOperation {
        op: Operation::ApplyMasterToPage {
            page: page.to_string(),
            master: master.map(str::to_string),
        },
        inverse: Operation::ApplyMasterToPage {
            page: page.to_string(),
            master: prev,
        },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

/// Operations that address pages or the spread list, which mean nothing
/// inside one master.
fn page_level(op: &Operation) -> bool {
    match op {
        Operation::InsertPage { .. }
        | Operation::RemovePage { .. }
        | Operation::MovePage { .. }
        | Operation::SetSpreadOrder { .. }
        | Operation::DuplicatePage { .. }
        | Operation::ApplyMasterToPage { .. }
        | Operation::InsertSection { .. }
        | Operation::EditSection { .. }
        | Operation::DeleteSection { .. }
        | Operation::OnMaster { .. }
        | Operation::CreateMaster { .. }
        | Operation::DeleteMaster { .. }
        | Operation::RestoreMaster { .. }
        | Operation::RenameMaster { .. }
        | Operation::SetPageOverrides { .. }
        | Operation::OverrideMasterItems { .. } => true,
        Operation::Batch { ops } => ops.iter().any(page_level),
        _ => false,
    }
}

/// v70 — `OnMaster`: run `op` with master `master_id` standing in as the
/// document's only spread, then put both back.
pub(super) fn apply_on_master(
    doc: &mut Document,
    master_id: &str,
    op: &Operation,
) -> Result<AppliedOperation, OperationError> {
    let key = master_id.rsplit_once('/').map_or(master_id, |(_, id)| id);
    if page_level(op) {
        return Err(OperationError::InvalidValue {
            node: NodeId::Page(key.to_string()),
            path: PropertyPath::PageBounds,
            reason: "page and spread operations do not apply inside a master".to_string(),
        });
    }
    let Some(master) = doc.master_spreads.remove(key) else {
        return Err(OperationError::NodeNotFound(NodeId::Page(key.to_string())));
    };
    let paged_scene::ParsedMasterSpread {
        src,
        self_id,
        spread,
        name,
    } = master;
    let pages = std::mem::replace(
        &mut doc.spreads,
        vec![paged_scene::ParsedSpread {
            src: src.clone(),
            spread,
        }],
    );
    let result = super::apply_inner(doc, op);
    let mut swapped = std::mem::replace(&mut doc.spreads, pages);
    let spread = swapped.pop().map(|p| p.spread).unwrap_or_default();
    doc.master_spreads.insert(
        key.to_string(),
        paged_scene::ParsedMasterSpread {
            src,
            self_id,
            spread,
            name,
        },
    );
    let applied = result?;
    Ok(AppliedOperation {
        op: Operation::OnMaster {
            master_id: key.to_string(),
            op: Box::new(applied.op),
        },
        inverse: Operation::OnMaster {
            master_id: key.to_string(),
            op: Box::new(applied.inverse),
        },
        // Every page the master is applied to repaints.
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

fn bare(master_id: &str) -> &str {
    master_id.rsplit_once('/').map_or(master_id, |(_, id)| id)
}

fn master_error(id: &str, reason: String) -> OperationError {
    OperationError::InvalidValue {
        node: NodeId::Page(id.to_string()),
        path: PropertyPath::PageBounds,
        reason,
    }
}

/// v70 — create a master: one page of the given size, or a fresh-id copy
/// of `duplicate_of`.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_create_master(
    doc: &mut Document,
    master_id: &str,
    name: Option<&str>,
    width_pt: f32,
    height_pt: f32,
    duplicate_of: Option<&str>,
    restore_json: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let id = bare(master_id).to_string();
    if doc.master_spreads.contains_key(&id) {
        return Err(OperationError::DuplicateNodeId { id });
    }
    let master = match restore_json {
        Some(json) => serde_json::from_str::<paged_scene::ParsedMasterSpread>(json)
            .map_err(|e| master_error(&id, format!("master restore failed: {e}")))?,
        None => {
            let mut next = crate::ids::highest_u_hex_id(doc) + 1;
            let mut spread = match duplicate_of {
                Some(src) => {
                    let src = bare(src);
                    let Some(m) = doc.master_spreads.get(src) else {
                        return Err(OperationError::NodeNotFound(NodeId::Page(src.to_string())));
                    };
                    let mut copy = m.spread.clone();
                    let _ = super::duplicate_page::fresh_ids(&mut copy, &mut next);
                    copy
                }
                None => {
                    if !(width_pt > 0.0 && height_pt > 0.0) {
                        return Err(master_error(
                            &id,
                            "a master's page needs a positive size".into(),
                        ));
                    }
                    paged_model::Spread {
                        pages: vec![paged_model::Page {
                            self_id: Some(format!("u{next:x}")),
                            bounds: paged_model::Bounds {
                                top: 0.0,
                                left: 0.0,
                                bottom: height_pt,
                                right: width_pt,
                            },
                            applied_master: None,
                            item_transform: None,
                            master_page_transform: None,
                            override_list: Vec::new(),
                            name: None,
                            show_master_items: None,
                            canvas_origin: None,
                        }],
                        ..paged_model::Spread::default()
                    }
                }
            };
            spread.self_id = Some(id.clone());
            paged_scene::ParsedMasterSpread {
                src: format!("MasterSpreads/MasterSpread_{id}.xml"),
                self_id: id.clone(),
                spread,
                name: name.map(str::to_string).or_else(|| {
                    duplicate_of.and_then(|d| doc.master_spreads.get(bare(d))?.name.clone())
                }),
            }
        }
    };
    let json = serde_json::to_string(&master)
        .map_err(|e| master_error(&id, format!("master capture failed: {e}")))?;
    doc.master_spreads.insert(id.clone(), master);
    Ok(AppliedOperation {
        op: Operation::CreateMaster {
            master_id: id.clone(),
            name: name.map(str::to_string),
            width_pt,
            height_pt,
            duplicate_of: duplicate_of.map(str::to_string),
            restore_json: Some(json),
        },
        inverse: Operation::DeleteMaster { master_id: id },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

/// Whether any page (or master page) applies master `id`.
fn master_in_use(doc: &Document, id: &str) -> bool {
    let applies = |p: &paged_model::Page| p.applied_master.as_deref().map(bare) == Some(id);
    doc.spreads
        .iter()
        .any(|s| s.spread.pages.iter().any(applies))
        || doc
            .master_spreads
            .values()
            .any(|m| m.spread.pages.iter().any(applies))
}

/// v70 — remove a master no page applies.
pub(super) fn apply_delete_master(
    doc: &mut Document,
    master_id: &str,
) -> Result<AppliedOperation, OperationError> {
    let id = bare(master_id).to_string();
    if !doc.master_spreads.contains_key(&id) {
        return Err(OperationError::NodeNotFound(NodeId::Page(id)));
    }
    if master_in_use(doc, &id) {
        return Err(master_error(
            &id,
            "the master is applied to a page; apply another first".into(),
        ));
    }
    let master = doc.master_spreads.remove(&id).expect("checked above");
    let json = serde_json::to_string(&master)
        .map_err(|e| master_error(&id, format!("master capture failed: {e}")))?;
    Ok(AppliedOperation {
        op: Operation::DeleteMaster { master_id: id },
        inverse: Operation::RestoreMaster { master_json: json },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

/// v70 — `DeleteMaster`'s inverse.
pub(super) fn apply_restore_master(
    doc: &mut Document,
    master_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let master: paged_scene::ParsedMasterSpread = serde_json::from_str(master_json)
        .map_err(|e| master_error("", format!("master restore failed: {e}")))?;
    let id = master.self_id.clone();
    if doc.master_spreads.contains_key(&id) {
        return Err(OperationError::DuplicateNodeId { id });
    }
    doc.master_spreads.insert(id.clone(), master);
    Ok(AppliedOperation {
        op: Operation::RestoreMaster {
            master_json: master_json.to_string(),
        },
        inverse: Operation::DeleteMaster { master_id: id },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

/// v70 — set or clear a master's name.
pub(super) fn apply_rename_master(
    doc: &mut Document,
    master_id: &str,
    name: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let id = bare(master_id).to_string();
    let Some(master) = doc.master_spreads.get_mut(&id) else {
        return Err(OperationError::NodeNotFound(NodeId::Page(id)));
    };
    let prev = std::mem::replace(&mut master.name, name.map(str::to_string));
    Ok(AppliedOperation {
        op: Operation::RenameMaster {
            master_id: id.clone(),
            name: name.map(str::to_string),
        },
        inverse: Operation::RenameMaster {
            master_id: id,
            name: prev,
        },
        invalidation: InvalidationHint::default(),
    })
}

// ---------------------------------------------------------------------------
// Engine ADR 1026 — masters based on masters, overrides
// ---------------------------------------------------------------------------

/// The `Self` of the master spread that holds page `page`, when it is a
/// master page.
fn master_holding_page(doc: &Document, page: &str) -> Option<String> {
    doc.master_spreads
        .values()
        .find(|m| {
            m.spread
                .pages
                .iter()
                .any(|p| p.self_id.as_deref() == Some(page))
        })
        .map(|m| m.self_id.clone())
}

/// A body page or a master page, by `Self`.
fn find_page_or_master_page_mut<'a>(
    doc: &'a mut Document,
    page: &str,
) -> Option<&'a mut paged_model::Page> {
    if find_page_mut(doc, page).is_some() {
        return find_page_mut(doc, page);
    }
    doc.master_spreads.values_mut().find_map(|m| {
        m.spread
            .pages
            .iter_mut()
            .find(|p| p.self_id.as_deref() == Some(page))
    })
}

/// Engine ADR 1026 — set a page's `OverrideList`.
pub(super) fn apply_set_page_overrides(
    doc: &mut Document,
    page: &str,
    overrides: &[String],
) -> Result<AppliedOperation, OperationError> {
    let page_ref = find_page_or_master_page_mut(doc, page)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Page(page.to_string())))?;
    let mut list: Vec<String> = Vec::new();
    for id in overrides {
        if !list.contains(id) {
            list.push(id.clone());
        }
    }
    let prev = std::mem::replace(&mut page_ref.override_list, list.clone());
    Ok(AppliedOperation {
        op: Operation::SetPageOverrides {
            page: page.to_string(),
            overrides: list,
        },
        inverse: Operation::SetPageOverrides {
            page: page.to_string(),
            overrides: prev,
        },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

/// The page item `id` on `spread` as a node, any of the six kinds.
fn node_by_id(spread: &paged_model::Spread, id: &str) -> Option<NodeId> {
    let has = |mut ids: std::slice::Iter<'_, Option<String>>| ids.any(|s| s.as_deref() == Some(id));
    let tf: Vec<Option<String>> = spread
        .text_frames
        .iter()
        .map(|f| f.self_id.clone())
        .collect();
    let re: Vec<Option<String>> = spread
        .rectangles
        .iter()
        .map(|f| f.self_id.clone())
        .collect();
    let ov: Vec<Option<String>> = spread.ovals.iter().map(|f| f.self_id.clone()).collect();
    let gl: Vec<Option<String>> = spread
        .graphic_lines
        .iter()
        .map(|f| f.self_id.clone())
        .collect();
    let po: Vec<Option<String>> = spread.polygons.iter().map(|f| f.self_id.clone()).collect();
    let gr: Vec<Option<String>> = spread.groups.iter().map(|f| f.self_id.clone()).collect();
    let id = id.to_string();
    if has(tf.iter()) {
        Some(NodeId::TextFrame(id))
    } else if has(re.iter()) {
        Some(NodeId::Rectangle(id))
    } else if has(ov.iter()) {
        Some(NodeId::Oval(id))
    } else if has(gl.iter()) {
        Some(NodeId::GraphicLine(id))
    } else if has(po.iter()) {
        Some(NodeId::Polygon(id))
    } else if has(gr.iter()) {
        Some(NodeId::Group(id))
    } else {
        None
    }
}

/// A page's top-left in its spread's coordinates.
fn page_origin(p: &paged_model::Page) -> (f32, f32) {
    let m = p.item_transform.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let (x, y) = (p.bounds.left, p.bounds.top);
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// Engine ADR 1026 — what overriding master items copies: the snippet of
/// the items as their master holds them, the body page's spread and the
/// offset that puts the copies where the master draws them.
pub struct OverrideCopy {
    pub snippet: super::snippet::ItemSnippet,
    pub spread: String,
    pub dx: f32,
    pub dy: f32,
    /// The page's `OverrideList` before the override.
    pub overrides: Vec<String>,
}

/// Engine ADR 1026 — the copy [`Operation::OverrideMasterItems`] makes of
/// `items` for body page `page`, without writing anything. The items must
/// all be on one master the page shows.
pub fn override_copy(
    doc: &Document,
    page: &str,
    items: &[String],
    empty_text: bool,
) -> Result<OverrideCopy, OperationError> {
    let not_found = || OperationError::NodeNotFound(NodeId::Page(page.to_string()));
    let (spread_idx, body) = doc
        .spreads
        .iter()
        .enumerate()
        .find_map(|(i, s)| {
            s.spread
                .pages
                .iter()
                .find(|p| p.self_id.as_deref() == Some(page))
                .map(|p| (i, p))
        })
        .ok_or_else(not_found)?;
    let Some(first) = items.first() else {
        return Err(master_error(page, "no master item to override".into()));
    };
    // The master of the page's chain that holds the items.
    let master = body
        .applied_master
        .as_deref()
        .map(|m| doc.master_chain(m))
        .unwrap_or_default()
        .into_iter()
        .find(|m| node_by_id(&m.spread, first).is_some())
        .ok_or_else(|| {
            master_error(
                page,
                format!("{first} is not an item of a master this page shows"),
            )
        })?;
    let mut nodes = Vec::new();
    for id in items {
        nodes.push(node_by_id(&master.spread, id).ok_or_else(|| {
            master_error(
                page,
                format!("{id} is not an item of master {}", master.self_id),
            )
        })?);
    }
    let (mx, my) = master
        .spread
        .pages
        .first()
        .map(page_origin)
        .unwrap_or((0.0, 0.0));
    let (bx, by) = page_origin(body);
    // Copy from a view whose only spread is the master (as `OnMaster`
    // edits it).
    let view = Document {
        designmap: doc.designmap.clone(),
        palette: doc.palette.clone(),
        spreads: vec![paged_scene::ParsedSpread {
            src: master.src.clone(),
            spread: master.spread.clone(),
        }],
        stories: doc.stories.clone(),
        styles: doc.styles.clone(),
        ..Document::default()
    };
    let mut snippet = super::snippet::extract_snippet(&view, &nodes)?;
    if empty_text {
        // A new slide's placeholders: the master's prompt goes, its first
        // paragraph and first run stay, empty, so what is typed takes
        // their formatting.
        for parsed in &mut snippet.stories {
            let paras = &mut parsed.story.paragraphs;
            paras.truncate(1);
            if let Some(p) = paras.first_mut() {
                p.runs.truncate(1);
                for r in &mut p.runs {
                    r.text.clear();
                    r.hyperlink_source = None;
                }
            }
        }
        snippet.hyperlinks.clear();
        snippet.text.clear();
    }
    let spread = doc.spreads[spread_idx]
        .spread
        .self_id
        .clone()
        .ok_or_else(not_found)?;
    Ok(OverrideCopy {
        snippet,
        spread,
        dx: bx - mx,
        dy: by - my,
        overrides: body.override_list.clone(),
    })
}

/// Engine ADR 1026 — override master items on a body page: copy them
/// onto the page's spread where the master draws them and hide the
/// master's own on this page (`OverrideList`). The items must all be on
/// one master of the page's chain.
pub(super) fn apply_override_master_items(
    doc: &mut Document,
    page: &str,
    items: &[String],
    ids: &[String],
    story_ids: &[String],
    empty_text: bool,
) -> Result<AppliedOperation, OperationError> {
    let copy = override_copy(doc, page, items, empty_text)?;
    let json = serde_json::to_string(&copy.snippet)
        .map_err(|e| master_error(page, format!("override capture failed: {e}")))?;
    let pasted = super::snippet::apply_insert_snippet(
        doc,
        &json,
        &copy.spread,
        copy.dx,
        copy.dy,
        ids,
        story_ids,
    )?;
    let (new_ids, new_story_ids) = match &pasted.op {
        Operation::InsertSnippet { ids, story_ids, .. } => (ids.clone(), story_ids.clone()),
        _ => (Vec::new(), Vec::new()),
    };
    let prev = copy.overrides;
    let mut list = prev.clone();
    for id in items {
        if !list.contains(id) {
            list.push(id.clone());
        }
    }
    if let Some(p) = find_page_mut(doc, page) {
        p.override_list = list;
    }
    Ok(AppliedOperation {
        op: Operation::OverrideMasterItems {
            page: page.to_string(),
            items: items.to_vec(),
            ids: new_ids,
            story_ids: new_story_ids,
            empty_text,
        },
        inverse: Operation::Batch {
            ops: vec![
                pasted.inverse,
                Operation::SetPageOverrides {
                    page: page.to_string(),
                    overrides: prev,
                },
            ],
        },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}
