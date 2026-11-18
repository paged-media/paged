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

//! Engine ADR 200, amended 2026-11-18 — `deleteFrame { withStory: true }`
//! takes the story the frame alone held.
//!
//! A plain delete keeps a deleted text frame's story: held by no frame, it
//! is free to be put on a path, and the IDML export leaves it out with a
//! loss line. A caller that owns what it deletes (paged.data clearing a
//! consumed Data Merge template, or the frames of an earlier merge) asks
//! for the story to go with the frame. [`drop_unheld`] removes each such
//! story the operation left unplaced, with the stories anchored in it and
//! the hyperlinks whose source text they hold, and folds the removal into
//! the operation's own undo step.
//!
//! "Unplaced" is the export's own test ([`idml_export::placed_story_ids`]):
//! a story placed before the operation and not after it. One still
//! threaded on to a frame that stays is kept, and so is one nothing placed
//! before (an import can carry one).

use std::collections::HashSet;

use paged_model::Paragraph;
use paged_mutate::{AppliedOperation, Operation};
use paged_scene::Document;

use crate::channel::Mutation;

/// The stories of `doc` something places: what [`drop_unheld`] compares.
pub(crate) fn placed(doc: &Document) -> HashSet<String> {
    idml_export::placed_story_ids(doc)
}

/// The stories a frame holds: a text frame's own, and every text path's on
/// a frame, shape or line with that id, on a spread or a master.
pub(crate) fn stories_of_item(doc: &Document, id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let spreads = doc
        .spreads
        .iter()
        .map(|s| &s.spread)
        .chain(doc.master_spreads.values().map(|m| &m.spread));
    for spread in spreads {
        let is = |own: &Option<String>| own.as_deref() == Some(id);
        for f in spread.text_frames.iter().filter(|f| is(&f.self_id)) {
            out.extend(f.parent_story.clone());
        }
        for r in spread.rectangles.iter().filter(|r| is(&r.self_id)) {
            out.extend(r.text_paths.iter().map(|t| t.parent_story.clone()));
        }
        for p in spread.polygons.iter().filter(|p| is(&p.self_id)) {
            out.extend(p.text_paths.iter().map(|t| t.parent_story.clone()));
        }
        for l in spread.graphic_lines.iter().filter(|l| is(&l.self_id)) {
            out.extend(l.text_paths.iter().map(|t| t.parent_story.clone()));
        }
    }
    out
}

/// Remove each of `candidates` (and each story anchored in one) that
/// `before` placed and nothing places now, with the hyperlinks whose source
/// text they hold, and fold that into `applied`: the forward op becomes
/// `[applied, removal]` and the inverse `[restore, applied's inverse]`, so
/// undo puts the stories back before the frames return to them and redo
/// removes them again. `applied` comes back as it was when nothing is to
/// go, or (defensively) when the removal does not apply: the batch rolls
/// itself back and the stories stay, as a plain delete leaves them.
pub(crate) fn drop_unheld(
    doc: &mut Document,
    before: &HashSet<String>,
    candidates: &[String],
    applied: AppliedOperation,
) -> AppliedOperation {
    let after = placed(doc);
    let unplaced = |id: &str| {
        idml_export::story_is_placed(before, id) && !idml_export::story_is_placed(&after, id)
    };
    // The candidates, then what is anchored in them, to a fixpoint.
    let mut wanted: Vec<String> = Vec::new();
    let mut queue: Vec<String> = candidates.to_vec();
    while let Some(id) = queue.pop() {
        if wanted.contains(&id) {
            continue;
        }
        let Some(story) = doc.stories.iter().find(|s| s.self_id == id) else {
            continue;
        };
        if !unplaced(&id) {
            continue;
        }
        anchored_stories(&story.story.paragraphs, &mut queue);
        wanted.push(id);
    }
    if wanted.is_empty() {
        return applied;
    }
    let mut sources = HashSet::new();
    for s in doc.stories.iter().filter(|s| wanted.contains(&s.self_id)) {
        hyperlink_sources(&s.story.paragraphs, &mut sources);
    }
    let mut ops: Vec<Operation> = doc
        .designmap
        .hyperlinks
        .iter()
        .filter(|h| {
            h.source
                .as_deref()
                .is_some_and(|s| sources.contains(tail(s)))
        })
        .map(|h| Operation::DeleteHyperlink {
            hyperlink_id: h.self_id.clone(),
        })
        .collect();
    // In document order, so the restore puts each back where it was.
    ops.extend(
        doc.stories
            .iter()
            .filter(|s| wanted.contains(&s.self_id))
            .map(|s| Operation::RemoveStory {
                story_id: s.self_id.clone(),
            }),
    );
    let Ok(removal) = paged_mutate::apply(doc, &Operation::Batch { ops }) else {
        return applied;
    };
    let mut invalidation = applied.invalidation;
    invalidation.merge(removal.invalidation);
    invalidation.structural = true;
    AppliedOperation {
        op: Operation::Batch {
            ops: vec![applied.op, removal.op],
        },
        inverse: Operation::Batch {
            ops: vec![removal.inverse, applied.inverse],
        },
        invalidation,
    }
}

/// A source id without its kind prefix (`HyperlinkTextSource/u12` → `u12`):
/// a hyperlink and the run it starts from may spell it either way.
fn tail(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}

/// Every hyperlink source tagged on a run of `paras`, table cells and
/// footnotes included, by [`tail`].
fn hyperlink_sources(paras: &[Paragraph], out: &mut HashSet<String>) {
    for p in paras {
        for r in &p.runs {
            if let Some(s) = &r.hyperlink_source {
                out.insert(tail(s).to_string());
            }
        }
        if let Some(t) = &p.table {
            for c in &t.cells {
                hyperlink_sources(&c.paragraphs, out);
            }
        }
        for f in &p.footnotes {
            hyperlink_sources(&f.paragraphs, out);
        }
    }
}

/// The stories the anchored frames in `paras` hold (nested ones too).
fn anchored_stories(paras: &[Paragraph], out: &mut Vec<String>) {
    fn frames(list: &[paged_model::AnchoredFrame], out: &mut Vec<String>) {
        for f in list {
            out.extend(f.parent_story.clone());
            frames(&f.children, out);
        }
    }
    for p in paras {
        frames(&p.anchored_frames, out);
        if let Some(t) = &p.table {
            for c in &t.cells {
                anchored_stories(&c.paragraphs, out);
            }
        }
        for f in &p.footnotes {
            anchored_stories(&f.paragraphs, out);
        }
    }
}

/// The stories `mutation`'s `deleteFrame { withStory: true }` ops name, as
/// `doc` holds them before it applies. A frame minted earlier in the same
/// batch (named by a handle) has none to name yet.
pub(crate) fn stories_deleted_with(doc: &Document, mutation: &Mutation) -> Vec<String> {
    match mutation {
        Mutation::DeleteFrame {
            frame_id,
            with_story: true,
        } => stories_of_item(doc, frame_id),
        Mutation::OnMaster { mutation, .. } => stories_deleted_with(doc, mutation),
        Mutation::Batch { ops } => ops
            .iter()
            .flat_map(|m| stories_deleted_with(doc, m))
            .collect(),
        _ => Vec::new(),
    }
}
