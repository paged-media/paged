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

//! A write's dry run (v82, engine ADR 1310): any mutation — a batch, a
//! Boolean, a region verb, a property, a text edit — applied through the
//! whole write path to a sandbox (a copy of the document in a model of
//! its own, [`CanvasModel::sandbox`]) and answered as the geometry and the
//! outlines it leaves, and the line evidence of a story when asked. The
//! document, its build, its undo history and its revision are untouched:
//! a preview is a read. Applying the write is the ordinary `Mutate`, one
//! undo step, and leaves what the preview showed.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use tsify_next::Tsify;

use crate::channel::{ElementGeometryItem, Mutation, PathAnchorsResult, WorkerError};
use crate::element_selection::ElementId;
use crate::line_evidence::{LineEvidenceQuery, LineEvidenceReport};
use crate::model::CanvasModel;

/// What to preview, and what to answer about.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct PreviewQuery {
    /// The write, as `Mutate` takes it.
    pub mutation: Mutation,
    /// Items to answer the geometry and outline of after the write (the
    /// ones it takes, typically); the items it creates are answered
    /// whatever this lists.
    #[serde(default)]
    pub items: Vec<ElementId>,
    /// A story to answer the line evidence of after the write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    pub story: Option<String>,
}

/// The answer to `RequestPreview`.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi, missing_as_null)]
#[serde(rename_all = "camelCase")]
pub struct PreviewReport {
    /// The write applied to the copy; false when it was refused.
    pub applied: bool,
    /// Why the write was refused (the engine's refusal, in words), or why
    /// no copy could be made.
    pub refused: Option<String>,
    /// The page items the write would create, in document order.
    pub created: Vec<ElementId>,
    /// The asked items the write would remove.
    pub removed: Vec<ElementId>,
    /// The geometry of the created items and of the asked items that
    /// remain, as the write would leave them.
    pub geometry: Vec<ElementGeometryItem>,
    /// Their outlines (anchors in the item's space and its transform onto
    /// the page), for the items drawn from a path or a box.
    pub outlines: Vec<PathAnchorsResult>,
    /// The asked story's line evidence after the write.
    pub lines: Option<LineEvidenceReport>,
    /// The document revision the preview was made from (engine ADR 1301):
    /// it does not move.
    pub revision: u64,
}

/// A refusal in words: the error's own sentence, as a refused write
/// says it.
pub(crate) fn refusal_text(error: &WorkerError) -> String {
    error.to_string()
}

/// Every page item of the document (body spreads), in document order.
fn page_items(doc: &paged_scene::Document) -> Vec<ElementId> {
    let mut out = Vec::new();
    for parsed in &doc.spreads {
        crate::explain::for_each_item_id(&parsed.spread, |id| out.push(id));
    }
    out
}

impl CanvasModel {
    /// The dry run of `query.mutation` (engine ADR 1310). A read.
    pub fn preview(&self, query: &PreviewQuery) -> PreviewReport {
        let revision = self.document_revision();
        let refused = |why: String| PreviewReport {
            applied: false,
            refused: Some(why),
            created: Vec::new(),
            removed: Vec::new(),
            geometry: Vec::new(),
            outlines: Vec::new(),
            lines: None,
            revision,
        };
        let mut copy = match self.sandbox() {
            Ok(copy) => copy,
            Err(e) => return refused(format!("{e:?}")),
        };
        if let Err(e) = copy.apply_mutation(&query.mutation) {
            return refused(refusal_text(&e));
        }
        // Items are matched by their `Self` id: a write may change an
        // item's kind and keep it (a rectangle a Boolean leaves as a path).
        let before: BTreeSet<String> = page_items(&self.scene)
            .iter()
            .map(|id| id.raw_id().to_string())
            .collect();
        let after: BTreeMap<String, ElementId> = page_items(&copy.scene)
            .into_iter()
            .map(|id| (id.raw_id().to_string(), id))
            .collect();
        let created: Vec<ElementId> = page_items(&copy.scene)
            .into_iter()
            .filter(|id| !before.contains(id.raw_id()))
            .collect();
        let mut kept = Vec::new();
        let mut removed = Vec::new();
        for id in &query.items {
            match after.get(id.raw_id()) {
                Some(now) => kept.push(now.clone()),
                None => removed.push(id.clone()),
            }
        }
        let mut answer: Vec<ElementId> = created.clone();
        answer.extend(kept);
        let geometry = copy.element_geometry(&answer);
        let outlines = answer
            .iter()
            .filter_map(|id| copy.path_anchors(id))
            .collect();
        let lines = query.story.as_ref().map(|story| {
            copy.line_evidence(&LineEvidenceQuery {
                story: story.clone(),
                frame: None,
                range: None,
                preview: None,
            })
        });
        PreviewReport {
            applied: true,
            refused: None,
            created,
            removed,
            geometry,
            outlines,
            lines: lines.map(|mut l| {
                l.preview = true;
                l.revision = revision;
                l
            }),
            revision,
        }
    }
}
