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

//! Engine ADR 1301 — the edit scope of an element: what lies inside the
//! subtree an edit context entered on it (`UXI-CTX-010`, `UXI-CTX-011`).
//!
//! The subtree is the document's own nesting, the one the scene tree shows:
//!
//! - a group's members, nested groups and their members included;
//! - a container's pasted-in children (`nested_children`, engine ADR 1010);
//! - a text frame's story (a story range, a table or a cell in it) and the
//!   objects anchored in that story, an anchored group's children included;
//! - a text-on-path's story, for the item that carries the path.
//!
//! Each of these is walked recursively, so a group holding a text frame
//! holds the frame's anchored objects too. The root itself is in its own
//! scope. A module frame (a sheet, a web or a draw frame) is a page item
//! like any other: its scope is whatever of the above it holds.

use std::collections::BTreeSet;

use paged_model::{AnchoredFrame, AnchoredFrameKind, FrameRef, Paragraph, Spread};

use crate::element_selection::ElementId;
use crate::model::CanvasModel;

/// The subtree of one root (see the module docs).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeSubtree {
    /// Whether the root names an item of the document.
    pub found: bool,
    /// Every page item below the root, in document order, the root left
    /// out.
    pub members: Vec<ElementId>,
    /// The stories whose text is inside the scope: a story range, a table
    /// or a cell of one of them is in scope.
    pub stories: Vec<String>,
}

impl ScopeSubtree {
    /// Whether `id` lies inside the scope of `root`: the root itself, a
    /// member, or an address in one of the scope's stories.
    pub fn contains(&self, root: &ElementId, id: &ElementId) -> bool {
        if !self.found {
            return false;
        }
        if same_item(root, id) {
            return true;
        }
        match id {
            ElementId::StoryRange { story_id, .. }
            | ElementId::Table { story_id, .. }
            | ElementId::TableCell { story_id, .. } => self.stories.iter().any(|s| s == story_id),
            _ => self.members.iter().any(|m| same_item(m, id)),
        }
    }
}

/// Two page-item ids name the same item. A frame's kind is part of its
/// id, but a host that only knows the `Self` (an anchored frame read back
/// as a rectangle) still names it, so the kinds of page items need not
/// agree; a story address never equals a page item.
fn same_item(a: &ElementId, b: &ElementId) -> bool {
    let page_item = |e: &ElementId| {
        !matches!(
            e,
            ElementId::StoryRange { .. } | ElementId::Table { .. } | ElementId::TableCell { .. }
        )
    };
    if page_item(a) && page_item(b) {
        a.raw_id() == b.raw_id()
    } else {
        a == b
    }
}

/// A recursion bound for a malformed document (a cycle of nested children
/// or of anchored stories).
const MAX_DEPTH: usize = 64;

struct Walk<'a> {
    model: &'a CanvasModel,
    members: Vec<ElementId>,
    seen: BTreeSet<String>,
    stories: Vec<String>,
}

impl<'a> Walk<'a> {
    fn push(&mut self, id: ElementId) -> bool {
        if !self.seen.insert(id.raw_id().to_string()) {
            return false;
        }
        self.members.push(id);
        true
    }

    /// Everything below the spread item `r` (not `r` itself).
    fn below_item(&mut self, spread: &Spread, r: FrameRef, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        if let FrameRef::Group(gi) = r {
            if let Some(group) = spread.groups.get(gi) {
                for m in &group.members {
                    if let Some(id) = element_of(spread, *m) {
                        if self.push(id) {
                            self.below_item(spread, *m, depth + 1);
                        }
                    }
                }
            }
        }
        let Some(own) = self_id_of(spread, r) else {
            return;
        };
        if let Some(children) = spread.nested_children.get(own) {
            for c in children {
                if let Some(id) = element_of(spread, *c) {
                    if self.push(id) {
                        self.below_item(spread, *c, depth + 1);
                    }
                }
            }
        }
        for story in stories_of(spread, r) {
            self.story(&story, depth + 1);
        }
    }

    /// A story in scope: its id, and the objects anchored in it.
    fn story(&mut self, story_id: &str, depth: usize) {
        if depth > MAX_DEPTH || self.stories.iter().any(|s| s == story_id) {
            return;
        }
        self.stories.push(story_id.to_string());
        let model = self.model;
        let Some(story) = model.scene.stories.iter().find(|s| s.self_id == story_id) else {
            return;
        };
        let mut anchored: Vec<&AnchoredFrame> = Vec::new();
        collect_anchored(&story.story.paragraphs, &mut anchored);
        for frame in anchored {
            if let Some(id) = anchored_element(frame) {
                if self.push(id) {
                    self.below_anchored(frame, depth + 1);
                }
            }
        }
    }

    /// Everything below an anchored object: an anchored group's children
    /// and an anchored text frame's story.
    fn below_anchored(&mut self, frame: &AnchoredFrame, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        for child in &frame.children {
            if let Some(id) = anchored_element(child) {
                if self.push(id) {
                    self.below_anchored(child, depth + 1);
                }
            }
        }
        if let Some(story) = frame.parent_story.as_deref() {
            self.story(story, depth + 1);
        }
    }
}

/// The anchored objects of `paragraphs` at their top level (an anchored
/// group's children are walked through the group), those in table cells
/// included.
fn collect_anchored<'p>(paragraphs: &'p [Paragraph], out: &mut Vec<&'p AnchoredFrame>) {
    for p in paragraphs {
        out.extend(p.anchored_frames.iter());
        if let Some(table) = &p.table {
            for cell in &table.cells {
                collect_anchored(&cell.paragraphs, out);
            }
        }
    }
}

fn anchored_element(frame: &AnchoredFrame) -> Option<ElementId> {
    let id = frame.self_id.clone()?;
    Some(match frame.frame_kind {
        AnchoredFrameKind::TextFrame => ElementId::TextFrame(id),
        AnchoredFrameKind::Rectangle => ElementId::Rectangle(id),
        AnchoredFrameKind::Group => ElementId::Group(id),
    })
}

/// The id of the spread item `r`, by its kind.
pub(crate) fn element_of(spread: &Spread, r: FrameRef) -> Option<ElementId> {
    let id = self_id_of(spread, r)?.to_string();
    Some(match r {
        FrameRef::TextFrame(_) => ElementId::TextFrame(id),
        FrameRef::Rectangle(_) => ElementId::Rectangle(id),
        FrameRef::Oval(_) => ElementId::Oval(id),
        FrameRef::Polygon(_) => ElementId::Polygon(id),
        FrameRef::GraphicLine(_) => ElementId::GraphicLine(id),
        FrameRef::Group(_) => ElementId::Group(id),
        FrameRef::Instance(_) => ElementId::Instance(id),
    })
}

fn self_id_of(spread: &Spread, r: FrameRef) -> Option<&str> {
    match r {
        FrameRef::TextFrame(i) => spread.text_frames.get(i)?.self_id.as_deref(),
        FrameRef::Rectangle(i) => spread.rectangles.get(i)?.self_id.as_deref(),
        FrameRef::Oval(i) => spread.ovals.get(i)?.self_id.as_deref(),
        FrameRef::Polygon(i) => spread.polygons.get(i)?.self_id.as_deref(),
        FrameRef::GraphicLine(i) => spread.graphic_lines.get(i)?.self_id.as_deref(),
        FrameRef::Group(i) => spread.groups.get(i)?.self_id.as_deref(),
        FrameRef::Instance(i) => spread.instances.get(i)?.self_id.as_deref(),
    }
}

/// The stories a spread item carries: a text frame's, and the stories of
/// the text paths on a rectangle, a polygon or a line.
fn stories_of(spread: &Spread, r: FrameRef) -> Vec<String> {
    let paths = |paths: &[paged_model::TextPath]| -> Vec<String> {
        paths.iter().map(|p| p.parent_story.clone()).collect()
    };
    match r {
        FrameRef::TextFrame(i) => spread
            .text_frames
            .get(i)
            .and_then(|f| f.parent_story.clone())
            .into_iter()
            .collect(),
        FrameRef::Rectangle(i) => spread
            .rectangles
            .get(i)
            .map(|f| paths(&f.text_paths))
            .unwrap_or_default(),
        FrameRef::Polygon(i) => spread
            .polygons
            .get(i)
            .map(|f| paths(&f.text_paths))
            .unwrap_or_default(),
        FrameRef::GraphicLine(i) => spread
            .graphic_lines
            .get(i)
            .map(|f| paths(&f.text_paths))
            .unwrap_or_default(),
        FrameRef::Oval(_) | FrameRef::Group(_) | FrameRef::Instance(_) => Vec::new(),
    }
}

/// The spread item `root` names on `spread`, when it is there.
fn find_on(spread: &Spread, root: &ElementId) -> Option<FrameRef> {
    let id = root.raw_id();
    let is = |s: &Option<String>| s.as_deref() == Some(id);
    let pos = |found: Option<usize>, make: fn(usize) -> FrameRef| found.map(make);
    match root {
        ElementId::Group(_) => pos(
            spread.groups.iter().position(|g| is(&g.self_id)),
            FrameRef::Group,
        ),
        ElementId::StoryRange { .. } | ElementId::Table { .. } | ElementId::TableCell { .. } => {
            None
        }
        // A page item by its `Self`, whichever kind list holds it (a host
        // that read an anchored or a converted frame by another kind
        // still names it).
        _ => pos(
            spread.text_frames.iter().position(|f| is(&f.self_id)),
            FrameRef::TextFrame,
        )
        .or_else(|| {
            pos(
                spread.rectangles.iter().position(|f| is(&f.self_id)),
                FrameRef::Rectangle,
            )
        })
        .or_else(|| {
            pos(
                spread.ovals.iter().position(|f| is(&f.self_id)),
                FrameRef::Oval,
            )
        })
        .or_else(|| {
            pos(
                spread.polygons.iter().position(|f| is(&f.self_id)),
                FrameRef::Polygon,
            )
        })
        .or_else(|| {
            pos(
                spread.graphic_lines.iter().position(|f| is(&f.self_id)),
                FrameRef::GraphicLine,
            )
        })
        .or_else(|| {
            pos(
                spread.instances.iter().position(|f| is(&f.self_id)),
                FrameRef::Instance,
            )
        })
        .or_else(|| {
            pos(
                spread.groups.iter().position(|g| is(&g.self_id)),
                FrameRef::Group,
            )
        }),
    }
}

impl CanvasModel {
    /// Engine ADR 1301 — the scope of `root` (see the module docs): its
    /// members and the stories inside it. A story address as the root
    /// scopes that story. An id that names nothing answers `found: false`
    /// and an empty scope.
    pub fn scope_subtree(&self, root: &ElementId) -> ScopeSubtree {
        let mut walk = Walk {
            model: self,
            members: Vec::new(),
            seen: BTreeSet::new(),
            stories: Vec::new(),
        };
        walk.seen.insert(root.raw_id().to_string());
        let found = match root {
            ElementId::StoryRange { story_id, .. }
            | ElementId::Table { story_id, .. }
            | ElementId::TableCell { story_id, .. } => {
                let exists = self.scene.stories.iter().any(|s| &s.self_id == story_id);
                if exists {
                    walk.story(story_id, 0);
                }
                exists
            }
            _ => self.scope_of_item(&mut walk, root),
        };
        if !found {
            return ScopeSubtree::default();
        }
        ScopeSubtree {
            found,
            members: walk.members,
            stories: walk.stories,
        }
    }

    /// Engine ADR 1301 — for each of `ids`, whether it lies inside the
    /// scope of `root` ([`ScopeSubtree::contains`]).
    pub fn scope_contains(&self, root: &ElementId, ids: &[ElementId]) -> Vec<bool> {
        let scope = self.scope_subtree(root);
        ids.iter().map(|id| scope.contains(root, id)).collect()
    }

    /// The document revision a scope answer holds for: it moves with every
    /// rebuild of the document, so an answer cached under it is current
    /// while it has not moved (a new document starts again and has a new
    /// `docId`).
    pub fn document_revision(&self) -> u64 {
        self.last_rebuild_stats().rebuilds
    }

    fn scope_of_item(&self, walk: &mut Walk<'_>, root: &ElementId) -> bool {
        let spreads = self
            .scene
            .spreads
            .iter()
            .map(|p| &p.spread)
            .chain(self.scene.master_spreads.values().map(|m| &m.spread));
        for spread in spreads {
            if let Some(r) = find_on(spread, root) {
                walk.below_item(spread, r, 0);
                return true;
            }
        }
        // An object anchored in text is no spread item: find it in the
        // stories.
        for story in &self.scene.stories {
            if let Some(frame) =
                paged_model::anchored_frame_in(&story.story.paragraphs, root.raw_id())
            {
                walk.below_anchored(frame, 0);
                return true;
            }
        }
        false
    }
}
