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

//! Progressive composition (engine ADR 1314): the pages a reader sees
//! first are composed first, the whole document after.
//!
//! A provisional build lays out a *reduced* document: the spreads it
//! composes as they are, every other spread cut down to its pages (no
//! items, no master), and no story growing. Its pages are the document's
//! own, so the page list, every page's size, place and label are the
//! whole document's; the pages of the spreads it left out are empty and
//! marked not composed. The spreads composed are a closure: a spread that
//! holds an earlier frame of a story reaching them is laid out too, so a
//! threaded story arrives on the page with the text the frames before it
//! left over.
//!
//! What a provisional page cannot know (another story's count of a
//! continued list, a running header, a cross-reference's page, the pages a
//! growing story adds) it shows as the reduced document has it. That is
//! why it is provisional: the whole document's build replaces every page,
//! and the model is final only then ([`crate::CanvasModel::compose_next`]).

use std::collections::BTreeSet;

use paged_scene::{Document, ParsedSpread};

/// The spread of each page of `scene`'s own (authored) pages, in order.
pub(crate) fn page_spreads(scene: &Document) -> Vec<usize> {
    scene
        .spreads
        .iter()
        .enumerate()
        .flat_map(|(i, s)| std::iter::repeat_n(i, s.spread.pages.len()))
        .collect()
}

/// The spreads a provisional build lays out to compose `seed` as the whole
/// document's build does: `seed`, and every spread holding an earlier frame
/// of a story with a frame on one of them, repeated until nothing is added.
pub(crate) fn closure(scene: &Document, seed: BTreeSet<usize>) -> BTreeSet<usize> {
    let mut set = seed;
    loop {
        let mut grew = false;
        let current: Vec<usize> = set.iter().copied().collect();
        for s in current {
            let Some(parsed) = scene.spreads.get(s) else {
                continue;
            };
            for frame in &parsed.spread.text_frames {
                let Some(story) = frame.parent_story.as_deref() else {
                    continue;
                };
                for earlier in scene.frame_chain(story) {
                    if earlier.self_id.is_some() && earlier.self_id == frame.self_id {
                        break;
                    }
                    let at = earlier
                        .self_id
                        .as_deref()
                        .and_then(|id| scene.text_frame_index.get(id));
                    if let Some(&(spread, _)) = at {
                        grew |= set.insert(spread);
                    }
                }
            }
        }
        if !grew {
            return set;
        }
    }
}

/// `scene` with every spread outside `keep` cut down to its pages (no
/// items, no master page) and no story growing: the document a
/// provisional build lays out.
pub(crate) fn reduced_scene(scene: &Document, keep: &BTreeSet<usize>) -> Document {
    let spreads = scene
        .spreads
        .iter()
        .enumerate()
        .map(|(i, parsed)| {
            if keep.contains(&i) {
                parsed.clone()
            } else {
                ParsedSpread {
                    src: parsed.src.clone(),
                    spread: skeleton(&parsed.spread),
                }
            }
        })
        .collect();
    let stories = scene
        .stories
        .iter()
        .map(|s| {
            let mut s = s.clone();
            s.story.grow = None;
            s
        })
        .collect();
    let mut doc = Document {
        designmap: scene.designmap.clone(),
        palette: scene.palette.clone(),
        spreads,
        stories,
        master_spreads: scene.master_spreads.clone(),
        frame_for_story: Default::default(),
        text_frame_index: Default::default(),
        styles: scene.styles.clone(),
        anchors: Vec::new(),
        symbols: scene.symbols.clone(),
        comment_threads: scene.comment_threads.clone(),
        people: scene.people.clone(),
        theme: scene.theme.clone(),
    };
    doc.rebuild_indexes();
    doc
}

/// A spread's pages alone: their bounds, places and names, nothing on
/// them and no master behind them.
fn skeleton(spread: &paged_model::Spread) -> paged_model::Spread {
    paged_model::Spread {
        self_id: spread.self_id.clone(),
        item_transform: spread.item_transform,
        pages: spread
            .pages
            .iter()
            .map(|p| paged_model::Page {
                applied_master: None,
                override_list: Vec::new(),
                ..p.clone()
            })
            .collect(),
        page_margins: spread.page_margins.clone(),
        ..Default::default()
    }
}
