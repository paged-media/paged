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

//! ADR 026 — generated pages for growing stories.
//!
//! A story with a [`paged_model::FlowGrowRule`] gets pages appended after
//! the page of its chain's last frame, the way InDesign 2025's Smart Text
//! Reflow adds them (measured with the `reflow` paged-gen fixture and
//! `tools/indesign-export/reflow-probe.sh`):
//!
//! - a generated page copies the size and applied master of that page;
//! - its frame is the page's MARGIN BOX (36 pt all round when the page
//!   declares no margins, InDesign's default), with the margin grid's
//!   columns, threaded onto the chain;
//! - the frame has DEFAULT frame options: no insets, the default first
//!   baseline, no fill or stroke (unless the rule sets
//!   `copy_frame_options`, as a Word section does: then the chain's insets,
//!   first baseline and vertical justification carry over).
//!
//! Generated pages are derived. [`Document::with_generated_pages`] returns a
//! COPY of the document with them materialised; the document itself (what
//! is saved, what undo records) never holds them. Their ids are stable, from
//! the story id and the page's ordinal, so selections and caches survive a
//! regrow, and they are XML names (`u1_grow2_page`), because an IDML export
//! writes them as `Self` attributes and part file names.

use std::collections::HashMap;

use paged_model::{Bounds, MarginPreference, Spread};

use crate::Document;

/// InDesign's margin when a page declares none (measured: the generated
/// frame of a margin-less 372 x 472 pt page came out at 36..336 x 36..436).
pub const DEFAULT_MARGIN_PT: f32 = 36.0;

/// The id of the `k`-th (1-based) generated page of `story`.
pub fn generated_page_id(story: &str, k: u32) -> String {
    format!("{story}_grow{k}_page")
}

/// The id of the `k`-th (1-based) generated text frame of `story`.
pub fn generated_frame_id(story: &str, k: u32) -> String {
    format!("{story}_grow{k}_frame")
}

/// `k` when `frame_id` is [`generated_frame_id`]`(story, k)`.
pub fn generated_frame_ordinal(story: &str, frame_id: &str) -> Option<u32> {
    frame_id
        .strip_prefix(story)?
        .strip_prefix("_grow")?
        .strip_suffix("_frame")?
        .parse()
        .ok()
}

/// The id of the spread holding the `k`-th generated page of `story`.
pub fn generated_spread_id(story: &str, k: u32) -> String {
    format!("{story}_grow{k}_spread")
}

/// The id of the blank page an odd/even section start of `story` put in
/// front of the story's first page (engine ADR 1022).
pub fn generated_blank_page_id(story: &str) -> String {
    format!("{story}_blank_page")
}

/// The id of the spread holding [`generated_blank_page_id`].
pub fn generated_blank_spread_id(story: &str) -> String {
    format!("{story}_blank_spread")
}

impl Document {
    /// Stories whose chain grows (they carry a grow rule and have at least
    /// one frame), in document order.
    pub fn growing_stories(&self) -> Vec<String> {
        self.stories
            .iter()
            .filter(|s| s.story.grow.is_some())
            .map(|s| s.self_id.clone())
            .filter(|id| !self.frame_chain(id).is_empty())
            .collect()
    }

    /// A copy of this document with `counts[story]` generated pages
    /// appended to each growing story's chain. Stories without a grow rule
    /// or without frames are ignored; a count of 0 adds nothing.
    pub fn with_generated_pages(&self, counts: &HashMap<String, u32>) -> Document {
        let mut doc = self.clone();
        let mut stories: Vec<&String> = counts.keys().collect();
        stories.sort();
        for story in stories {
            let n = counts[story];
            if n == 0
                || !self
                    .stories
                    .iter()
                    .any(|s| &s.self_id == story && s.story.grow.is_some())
            {
                continue;
            }
            let rule = self
                .stories
                .iter()
                .find(|s| &s.self_id == story)
                .and_then(|s| s.story.grow.clone())
                .unwrap_or_default();
            doc.append_generated_pages(story, n, &rule);
        }
        // Engine ADR 1022 — Word's section rules: an odd/even start gets a
        // blank page in front, and the chain's pages take the rule's
        // first/odd/even masters.
        doc.apply_section_rules();
        // The stories are untouched, so the clone's story-derived indexes
        // (the heading-anchor table) are already right; each append left
        // the frame indexes current.
        doc
    }

    /// The pages a story's chain stands on, in chain order (each once).
    pub fn chain_page_ids(&self, story: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for frame in self.frame_chain(story) {
            let Some(&(si, _)) = frame
                .self_id
                .as_ref()
                .and_then(|id| self.text_frame_index.get(id))
            else {
                continue;
            };
            let spread = &self.spreads[si].spread;
            let pi =
                crate::page_index_for_bounds(&spread.pages, frame.bounds, frame.item_transform)
                    .unwrap_or(0);
            if let Some(id) = spread.pages.get(pi).and_then(|p| p.self_id.clone()) {
                if !out.contains(&id) {
                    out.push(id);
                }
            }
        }
        out
    }

    /// Every page's number by the section rules (Word decides odd and even
    /// by it), in document order, keyed by the page's `Self`.
    pub fn page_numbers(&self) -> Vec<(String, u32)> {
        let mut walk = paged_model::SectionWalk::new(&self.designmap.sections);
        let mut out = Vec::new();
        for parsed in &self.spreads {
            for page in &parsed.spread.pages {
                walk.derived_label(page.self_id.as_deref());
                if let Some(id) = &page.self_id {
                    out.push((id.clone(), walk.current_number()));
                }
            }
        }
        out
    }

    /// Engine ADR 1022 — apply the section rules of every story whose grow
    /// rule names masters or an odd/even start. Stories go in the order of
    /// their first pages, so a blank page put before one section moves the
    /// numbers of the sections after it before they are read.
    fn apply_section_rules(&mut self) {
        let mut ruled: Vec<(String, paged_model::FlowGrowRule)> = self
            .stories
            .iter()
            .filter_map(|s| s.story.grow.clone().map(|g| (s.self_id.clone(), g)))
            .filter(|(_, g)| g.names_masters() || !g.section_start.is_new_page())
            .collect();
        if ruled.is_empty() {
            return;
        }
        let order: HashMap<String, usize> = self
            .page_numbers()
            .into_iter()
            .enumerate()
            .map(|(i, (id, _))| (id, i))
            .collect();
        ruled.sort_by_key(|(story, _)| {
            self.chain_page_ids(story)
                .first()
                .and_then(|p| order.get(p).copied())
                .unwrap_or(usize::MAX)
        });

        // Blank pages: (the story it stands before, its page id).
        let mut blanks: Vec<(String, String)> = Vec::new();
        for (story, rule) in &ruled {
            if rule.section_start.is_new_page() {
                continue;
            }
            let Some(first) = self.chain_page_ids(story).into_iter().next() else {
                continue;
            };
            let numbers = self.page_numbers();
            let Some(at) = numbers.iter().position(|(id, _)| *id == first) else {
                continue;
            };
            // The document's first page has nothing to stand behind.
            if at == 0 || rule.section_start.accepts(numbers[at].1) {
                continue;
            }
            if let Some(id) = self.insert_blank_page_before(story, &first) {
                blanks.push((story.clone(), id));
            }
        }

        let numbers: HashMap<String, u32> = self.page_numbers().into_iter().collect();
        let mut assign: Vec<(String, String)> = Vec::new();
        let mut owner: HashMap<String, &paged_model::FlowGrowRule> = HashMap::new();
        for (story, rule) in &ruled {
            for (i, page) in self.chain_page_ids(story).into_iter().enumerate() {
                if let Some(m) = rule.master_for(i == 0, numbers.get(&page).copied().unwrap_or(1)) {
                    assign.push((page.clone(), m.to_string()));
                }
                owner.insert(page, rule);
            }
        }
        // A blank page shows the section before it, as the next page of
        // that section would (Word prints its header and footer there).
        let order: Vec<String> = self.page_numbers().into_iter().map(|(id, _)| id).collect();
        for (_, blank) in &blanks {
            let Some(at) = order.iter().position(|id| id == blank) else {
                continue;
            };
            let prev_rule = order[..at].iter().rev().find_map(|id| owner.get(id));
            if let Some(m) = prev_rule
                .and_then(|r| r.master_for(false, numbers.get(blank).copied().unwrap_or(1)))
            {
                assign.push((blank.clone(), m.to_string()));
            }
        }
        for (page_id, master) in assign {
            if let Some(page) = self
                .spreads
                .iter_mut()
                .flat_map(|s| s.spread.pages.iter_mut())
                .find(|p| p.self_id.as_deref() == Some(page_id.as_str()))
            {
                page.applied_master = Some(master);
            }
        }
    }

    /// Insert a blank page (a page of the size, margins and master of the
    /// page before it, with nothing on it) in a spread of its own before the
    /// spread holding `page_id`. Its id is stable: [`generated_blank_page_id`].
    fn insert_blank_page_before(&mut self, story: &str, page_id: &str) -> Option<String> {
        let si = self.spreads.iter().position(|s| {
            s.spread
                .pages
                .iter()
                .any(|p| p.self_id.as_deref() == Some(page_id))
        })?;
        let prev_spread = &self.spreads[si.checked_sub(1)?].spread;
        let template = prev_spread.pages.last()?.clone();
        let margins = template
            .self_id
            .as_ref()
            .and_then(|id| prev_spread.page_margins.get(id))
            .cloned();
        let item_transform = prev_spread.item_transform;
        let id = generated_blank_page_id(story);
        let mut page = template;
        page.self_id = Some(id.clone());
        page.name = None;
        page.override_list = Vec::new();
        let mut page_margins = HashMap::new();
        if let Some(m) = margins {
            page_margins.insert(id.clone(), m);
        }
        let spread = Spread {
            self_id: Some(generated_blank_spread_id(story)),
            item_transform,
            pages: vec![page],
            page_margins,
            ..Default::default()
        };
        self.spreads.insert(
            si,
            crate::ParsedSpread {
                src: format!("Spreads/Spread_{}.xml", generated_blank_spread_id(story)),
                spread,
            },
        );
        self.rebuild_frame_indexes();
        Some(id)
    }

    fn append_generated_pages(&mut self, story: &str, n: u32, rule: &paged_model::FlowGrowRule) {
        let Some(last) = self.frame_chain(story).last().map(|f| (*f).clone()) else {
            return;
        };
        let Some(last_id) = last.self_id.clone() else {
            return;
        };
        let Some(&(spread_idx, _)) = self.text_frame_index.get(&last_id) else {
            return;
        };
        let template_spread = self.spreads[spread_idx].spread.clone();
        let page_idx =
            crate::page_index_for_bounds(&template_spread.pages, last.bounds, last.item_transform)
                .unwrap_or(0);
        let Some(template_page) = template_spread.pages.get(page_idx).cloned() else {
            return;
        };
        let margins = template_page
            .self_id
            .as_ref()
            .and_then(|id| template_spread.page_margins.get(id))
            .cloned()
            .unwrap_or(MarginPreference {
                top: DEFAULT_MARGIN_PT,
                bottom: DEFAULT_MARGIN_PT,
                left: DEFAULT_MARGIN_PT,
                right: DEFAULT_MARGIN_PT,
                column_count: 1,
                column_gutter: 12.0,
            });
        let pb = template_page.bounds;
        let margin_box = Bounds {
            top: pb.top + margins.top,
            left: pb.left + margins.left,
            bottom: pb.bottom - margins.bottom,
            right: pb.right - margins.right,
        };

        // Where the chain's current last frame sits. Spreads are only ever
        // inserted AFTER it, so its position stays valid without
        // re-indexing the whole document per generated page.
        let Some(&first_link) = self.text_frame_index.get(&last_id) else {
            return;
        };
        let mut prev_at = first_link;
        for (insert_at, k) in (spread_idx + 1..).zip(1..=n) {
            let page_id = generated_page_id(story, k);
            let frame_id = generated_frame_id(story, k);

            let mut page = template_page.clone();
            page.self_id = Some(page_id.clone());
            // The renderer numbers an unnamed page by its position.
            page.name = None;
            page.override_list = Vec::new();

            let mut frame = last.clone();
            frame.self_id = Some(frame_id.clone());
            frame.parent_story = Some(story.to_string());
            frame.bounds = margin_box;
            // Frame inner coords = page inner coords.
            frame.item_transform = template_page.item_transform;
            frame.next_text_frame = None;
            // InDesign's new frame takes DEFAULT options, not the chain's.
            frame.anchors = Vec::new();
            frame.subpath_starts = Vec::new();
            frame.subpath_open = Vec::new();
            frame.fill_color = None;
            frame.fill_tint = None;
            frame.stroke_color = None;
            frame.stroke_weight = None;
            frame.stroke_type = None;
            frame.stroke_gap_color = None;
            frame.stroke_gap_tint = None;
            frame.stroke_dash = Vec::new();
            frame.drop_shadow = None;
            frame.stroke_drop_shadow = None;
            if !rule.copy_frame_options {
                frame.vertical_justification = None;
                frame.first_baseline_offset = None;
                frame.minimum_first_baseline_offset = None;
                frame.inset_spacing = None;
            }
            frame.auto_sizing = None;
            frame.auto_sizing_reference_point = None;
            frame.minimum_width_for_auto_sizing = None;
            frame.minimum_height_for_auto_sizing = None;
            frame.use_minimum_height_for_auto_sizing = None;
            frame.column_count = (margins.column_count > 1).then_some(margins.column_count);
            frame.column_gutter = (margins.column_count > 1).then_some(margins.column_gutter);
            frame.column_balance = None;
            frame.applied_object_style = None;
            frame.text_wrap = None;
            frame.is_anchored = false;
            frame.opacity = None;
            frame.blend_mode = None;
            frame.effects = None;
            frame.corner_radius = None;
            frame.corner_option = None;
            frame.corners = Default::default();

            let mut page_margins = HashMap::new();
            page_margins.insert(page_id.clone(), margins.clone());
            let spread = Spread {
                self_id: Some(generated_spread_id(story, k)),
                item_transform: template_spread.item_transform,
                pages: vec![page],
                text_frames: vec![frame],
                page_margins,
                ..Default::default()
            };

            // Thread the previous chain end onto the new frame.
            let (si, fi) = prev_at;
            self.spreads[si].spread.text_frames[fi].next_text_frame = Some(frame_id);
            self.spreads.insert(
                insert_at,
                crate::ParsedSpread {
                    src: format!("Spreads/Spread_{}.xml", generated_spread_id(story, k)),
                    spread,
                },
            );
            prev_at = (insert_at, 0);
        }
        // Once per story, not per page: the next story's chain lookup needs
        // the shifted spread indices.
        self.rebuild_frame_indexes();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_distinct() {
        assert_eq!(generated_page_id("u1", 2), "u1_grow2_page");
        assert_ne!(generated_frame_id("u1", 1), generated_frame_id("u1", 2));
        assert_ne!(generated_spread_id("u1", 1), generated_page_id("u1", 1));
        assert_eq!(
            generated_frame_ordinal("u1", &generated_frame_id("u1", 300)),
            Some(300)
        );
        assert_eq!(generated_frame_ordinal("u1", "u12_grow3_frame"), None);
        assert_eq!(
            generated_frame_ordinal("u1", &generated_page_id("u1", 3)),
            None
        );
    }
}
