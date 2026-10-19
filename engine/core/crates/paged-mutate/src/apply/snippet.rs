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

//! ADR 190 — page-item snippets: what Copy takes out of a document and
//! Paste puts into one (this one or another).
//!
//! A snippet is the copied items WHOLE, as `DuplicateNodes` clones them
//! (`duplicate_nodes.rs`): every item's struct verbatim, its label and
//! image-metadata rows, a container's pasted-in children, a group's members
//! (nested groups too), a text frame's story, the hyperlinks its story's
//! sources own, and a text-on-path's story. Unlike a duplicate it does not
//! need the source to be there when it is pasted: Cut deletes the source,
//! and the document may have been replaced since. So it carries what the
//! items NAME as well — the swatches, colours, gradients, styles and
//! conditions they reference, found by their ids — and a paste adds the
//! ones the target document lacks (InDesign keeps the target's definition
//! when both have one).
//!
//! The same refusals as a duplicate apply at Copy, by name: a threaded
//! frame, a story holding a table, an anchored object or a footnote, an
//! opacity mask, an object anchored in text. Items on different spreads
//! are refused too: a spread is one coordinate space, and a copy from two
//! would land as one arbitrary mix.
//!
//! ## Paste
//!
//! [`Operation::InsertSnippet`] grafts the snippet onto one spread, on top
//! of its z-order (InDesign pastes in front), translated by `(dx, dy)` in
//! spread space through each clone's `ItemTransform`, under fresh ids
//! (`ids` / `story_ids`, minted ahead by the canvas or here). An item whose
//! layer the target lacks goes to the default layer, as a new frame does.
//! Its inverse, [`Operation::RemoveSnippet`], removes exactly what it added
//! (items, stories, hyperlinks, resources).

use std::collections::{BTreeMap, BTreeSet, HashSet};

use paged_model::{FrameRef, Spread};
use paged_scene::{Document, ParsedStory};
use serde::{Deserialize, Serialize};

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, NodeId, Operation};

use super::duplicate_nodes::{
    names_source, next_story_number, ref_self_id, refused, relink_copied_story, remove_minted,
    translated, validate, DuplicateDemand,
};
use super::insert_node::ensure_frames_in_order;

/// The `format` every snippet this engine writes carries.
pub const SNIPPET_FORMAT: &str = "paged.snippet/1";

/// Copied page items and what they name (see the module docs). Plain
/// serde: the clipboard holds its JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemSnippet {
    /// [`SNIPPET_FORMAT`].
    pub format: String,
    /// The copied items, ids as in the source document. The roots are
    /// `spread.frames_in_order` (back to front); members, pasted-in
    /// children and nested groups sit in the kind vecs beside them. A root
    /// group's transform is in spread space. No pages.
    pub spread: Spread,
    /// The text frames' and text paths' stories, ids as in the source.
    pub stories: Vec<ParsedStory>,
    /// The `<Hyperlink>`s the copied stories' sources own.
    #[serde(default)]
    pub hyperlinks: Vec<paged_model::Hyperlink>,
    /// The roots' union box, spread space: `[top, left, bottom, right]`.
    pub bounds: [f32; 4],
    /// The top-left of the page the items were copied from, in its spread:
    /// Paste in Place keeps the items' position relative to the page.
    #[serde(default)]
    pub page_origin: Option<[f32; 2]>,
    /// The source page's `Self` id.
    #[serde(default)]
    pub page_id: Option<String>,
    /// What the items reference, by id.
    #[serde(default)]
    pub resources: SnippetResources,
    /// The copied stories' text, frames back to front, one blank line
    /// between frames: the plain-text form of the copy.
    #[serde(default)]
    pub text: String,
}

/// The document resources a snippet's items reference, by `Self` id.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SnippetResources {
    #[serde(default)]
    pub colors: BTreeMap<String, paged_model::ColorEntry>,
    #[serde(default)]
    pub swatches: BTreeMap<String, paged_model::SwatchEntry>,
    #[serde(default)]
    pub gradients: BTreeMap<String, paged_model::GradientEntry>,
    #[serde(default)]
    pub paragraph_styles: BTreeMap<String, paged_model::ParagraphStyleDef>,
    #[serde(default)]
    pub character_styles: BTreeMap<String, paged_model::CharacterStyleDef>,
    #[serde(default)]
    pub object_styles: BTreeMap<String, paged_model::ObjectStyleDef>,
    #[serde(default)]
    pub stroke_styles: BTreeMap<String, paged_model::StrokeStyleDef>,
    #[serde(default)]
    pub conditions: BTreeMap<String, paged_model::ConditionDef>,
}

// ------------------------------------------------------------------ copy

/// Take a snippet of `sources` out of `doc` (Copy, Cut). Writes nothing.
/// Refuses what a duplicate refuses, and items on different spreads.
pub fn extract_snippet(doc: &Document, sources: &[NodeId]) -> Result<ItemSnippet, OperationError> {
    let (located, _) = validate(doc, sources)?;
    let si = located[0].0;
    if let Some(pos) = located.iter().position(|(s, _)| *s != si) {
        return Err(refused(
            sources[pos].clone(),
            "the elements are on different spreads — copy the items of one spread at a time",
        ));
    }
    let src = &doc.spreads[si].spread;
    // Back to front, as the source paints them, whatever order the
    // selection named them in.
    let order = paint_order(src);
    let mut roots: Vec<FrameRef> = located.iter().map(|(_, r)| *r).collect();
    roots.sort_by_key(|r| order.iter().position(|x| x == r).unwrap_or(usize::MAX));
    for r in &roots {
        if let Some(id) = ref_self_id(src, *r) {
            if src.endnote_frames.iter().any(|e| e == id) {
                return Err(refused(
                    super::duplicate_nodes::node_for(src, *r),
                    "the frame holds the document's endnotes — it cannot be copied",
                ));
            }
        }
    }

    let mut mini = Spread::default();
    let mut stories: Vec<ParsedStory> = Vec::new();
    let mut graft = Graft::identity();
    for r in &roots {
        let root = graft.graft(src, &mut mini, &doc.stories, &mut stories, *r, true);
        mini.frames_in_order.push(root);
    }

    let mut hyperlinks: Vec<paged_model::Hyperlink> = Vec::new();
    for parsed in &stories {
        for source in story_sources(&parsed.story) {
            for h in &doc.designmap.hyperlinks {
                let owns = h
                    .source
                    .as_deref()
                    .is_some_and(|s| names_source(s, &source));
                if owns && !hyperlinks.iter().any(|x| x.self_id == h.self_id) {
                    hyperlinks.push(h.clone());
                }
            }
        }
    }

    let bounds = union_box(&mini, &mini.frames_in_order.clone()).unwrap_or([0.0; 4]);
    let (page_id, page_origin) = page_under(src, bounds);
    let resources = collect_resources(doc, &mini, &stories);
    let text = mini
        .frames_in_order
        .iter()
        .flat_map(|r| frame_stories(&mini, *r))
        .filter_map(|sid| stories.iter().find(|s| s.self_id == sid))
        .map(|s| story_plain_text(&s.story))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    Ok(ItemSnippet {
        format: SNIPPET_FORMAT.to_string(),
        spread: mini,
        stories,
        hyperlinks,
        bounds,
        page_origin,
        page_id,
        resources,
        text,
    })
}

/// Parse a snippet's JSON, refusing what this engine did not write.
pub fn parse_snippet(json: &str) -> Result<ItemSnippet, OperationError> {
    let snippet: ItemSnippet = serde_json::from_str(json).map_err(|e| {
        refused(
            NodeId::Spread(String::new()),
            format!("the clipboard holds no page items this editor can read ({e})"),
        )
    })?;
    if snippet.format != SNIPPET_FORMAT {
        return Err(refused(
            NodeId::Spread(String::new()),
            format!(
                "the clipboard holds page items in the format \"{}\"; this editor reads \"{SNIPPET_FORMAT}\"",
                snippet.format
            ),
        ));
    }
    if snippet.spread.frames_in_order.is_empty() {
        return Err(refused(
            NodeId::Spread(String::new()),
            "the clipboard holds no page items",
        ));
    }
    Ok(snippet)
}

/// How many ids a paste of `snippet` mints: one per item (groups
/// included), one per story copied.
pub fn snippet_demand(snippet: &ItemSnippet) -> DuplicateDemand {
    let mut demand = DuplicateDemand::default();
    for r in &snippet.spread.frames_in_order {
        count_subtree(&snippet.spread, &snippet.stories, *r, &mut demand);
    }
    demand
}

/// The root clone of each pasted root, in z order: what the wire reports
/// as minted. Empty when the op carries no resolved ids.
pub fn snippet_roots(op: &Operation) -> Vec<NodeId> {
    let Operation::InsertSnippet { snippet, ids, .. } = op else {
        return Vec::new();
    };
    let Ok(snippet) = parse_snippet(snippet) else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    let mut next = 0usize;
    for r in &snippet.spread.frames_in_order {
        let Some(id) = ids.get(next) else {
            return Vec::new();
        };
        roots.push(match r {
            FrameRef::TextFrame(_) => NodeId::TextFrame(id.clone()),
            FrameRef::Rectangle(_) => NodeId::Rectangle(id.clone()),
            FrameRef::Oval(_) => NodeId::Oval(id.clone()),
            FrameRef::GraphicLine(_) => NodeId::GraphicLine(id.clone()),
            FrameRef::Polygon(_) => NodeId::Polygon(id.clone()),
            FrameRef::Group(_) => NodeId::Group(id.clone()),
        });
        let mut d = DuplicateDemand::default();
        count_subtree(&snippet.spread, &snippet.stories, *r, &mut d);
        next += d.items;
    }
    roots
}

fn count_subtree(spread: &Spread, stories: &[ParsedStory], r: FrameRef, d: &mut DuplicateDemand) {
    d.items += 1;
    for sid in own_stories(spread, r) {
        if stories.iter().any(|s| s.self_id == sid) {
            d.stories += 1;
        }
    }
    if let FrameRef::Group(gi) = r {
        if let Some(g) = spread.groups.get(gi) {
            for m in &g.members {
                count_subtree(spread, stories, *m, d);
            }
        }
    }
    if let Some(children) = ref_self_id(spread, r).and_then(|id| spread.nested_children.get(id)) {
        for c in children {
            count_subtree(spread, stories, *c, d);
        }
    }
}

// ------------------------------------------------------------------ graft

/// One copy pass from a source spread into a destination spread: the
/// offset, the ids handed out (`None` keeps the source's — Copy), the
/// stories copied so far, and the layers an item may keep.
struct Graft<'a> {
    dx: f32,
    dy: f32,
    ids: Option<std::slice::Iter<'a, String>>,
    story_ids: Option<std::slice::Iter<'a, String>>,
    /// Paste only: the target's layer ids; an item on another layer goes
    /// to the default layer.
    layers: Option<HashSet<String>>,
    /// `(source story id, copy's story id)` for every story copied.
    copied: Vec<(String, String)>,
}

impl<'a> Graft<'a> {
    fn identity() -> Self {
        Graft {
            dx: 0.0,
            dy: 0.0,
            ids: None,
            story_ids: None,
            layers: None,
            copied: Vec::new(),
        }
    }

    fn id_for(&mut self, source: Option<&str>) -> Option<String> {
        match self.ids.as_mut() {
            Some(it) => Some(it.next().cloned().expect("validated: one id per item")),
            None => source.map(str::to_string),
        }
    }

    fn story_for(
        &mut self,
        src_stories: &[ParsedStory],
        dst_stories: &mut Vec<ParsedStory>,
        sid: &str,
    ) -> Option<String> {
        let story = src_stories.iter().find(|s| s.self_id == sid)?.story.clone();
        let new_id = match self.story_ids.as_mut() {
            Some(it) => it.next().cloned().expect("validated: one id per story"),
            None => sid.to_string(),
        };
        dst_stories.push(ParsedStory {
            // No source part — minted post-parse, the writer's signal to
            // emit a full story.
            src: String::new(),
            self_id: new_id.clone(),
            story,
        });
        self.copied.push((sid.to_string(), new_id.clone()));
        Some(new_id)
    }

    fn layer(&self, layer: Option<String>) -> Option<String> {
        match (&self.layers, layer) {
            (Some(known), Some(l)) if !known.contains(&l) => None,
            (_, l) => l,
        }
    }

    /// Copy the subtree at `r` of `src` into `dst` (every item pushed onto
    /// its kind vec) and return the copy's root ref, listed nowhere yet.
    /// `root`: the copy becomes top-level, so a group's transform is
    /// composed into spread space (a group nested in the source is stored
    /// relative to its parent).
    fn graft(
        &mut self,
        src: &Spread,
        dst: &mut Spread,
        src_stories: &[ParsedStory],
        dst_stories: &mut Vec<ParsedStory>,
        r: FrameRef,
        root: bool,
    ) -> FrameRef {
        let source_id = ref_self_id(src, r).map(str::to_string);
        // Pre-order: a group before its members, so a root's id is the
        // first its subtree consumes.
        let new_id = self.id_for(source_id.as_deref());
        let (dx, dy) = (self.dx, self.dy);
        let new_ref = match r {
            FrameRef::Group(gi) => {
                let source = src.groups[gi].clone();
                let item_transform = if root {
                    let composed = crate::group_frame::composed_transform(src, gi);
                    translated(composed, dx, dy)
                } else {
                    // Rides its parent group's frame.
                    source.item_transform
                };
                // Members first: the clone pass keeps a nested group
                // BEFORE its outer in the vec, as `DuplicateNodes` does.
                let members: Vec<FrameRef> = source
                    .members
                    .iter()
                    .map(|m| self.graft(src, dst, src_stories, dst_stories, *m, false))
                    .collect();
                dst.groups.push(paged_model::Group {
                    self_id: new_id.clone(),
                    members,
                    item_transform,
                    ..source
                });
                FrameRef::Group(dst.groups.len() - 1)
            }
            FrameRef::TextFrame(i) => {
                let mut clone = src.text_frames[i].clone();
                clone.self_id = new_id.clone();
                clone.item_transform = translated(clone.item_transform, dx, dy);
                clone.item_layer = self.layer(clone.item_layer.take());
                clone.parent_story = clone
                    .parent_story
                    .as_deref()
                    .and_then(|sid| self.story_for(src_stories, dst_stories, sid));
                dst.text_frames.push(clone);
                FrameRef::TextFrame(dst.text_frames.len() - 1)
            }
            FrameRef::Rectangle(i) => {
                let mut clone = src.rectangles[i].clone();
                clone.self_id = new_id.clone();
                clone.item_transform = translated(clone.item_transform, dx, dy);
                clone.item_layer = self.layer(clone.item_layer.take());
                self.text_paths(
                    &mut clone.text_paths,
                    new_id.as_deref(),
                    src_stories,
                    dst_stories,
                );
                dst.rectangles.push(clone);
                FrameRef::Rectangle(dst.rectangles.len() - 1)
            }
            FrameRef::Oval(i) => {
                let mut clone = src.ovals[i].clone();
                clone.self_id = new_id.clone();
                clone.item_transform = translated(clone.item_transform, dx, dy);
                clone.item_layer = self.layer(clone.item_layer.take());
                dst.ovals.push(clone);
                FrameRef::Oval(dst.ovals.len() - 1)
            }
            FrameRef::GraphicLine(i) => {
                let mut clone = src.graphic_lines[i].clone();
                clone.self_id = new_id.clone();
                clone.item_transform = translated(clone.item_transform, dx, dy);
                clone.item_layer = self.layer(clone.item_layer.take());
                self.text_paths(
                    &mut clone.text_paths,
                    new_id.as_deref(),
                    src_stories,
                    dst_stories,
                );
                dst.graphic_lines.push(clone);
                FrameRef::GraphicLine(dst.graphic_lines.len() - 1)
            }
            FrameRef::Polygon(i) => {
                let mut clone = src.polygons[i].clone();
                clone.self_id = new_id.clone();
                clone.item_transform = translated(clone.item_transform, dx, dy);
                clone.item_layer = self.layer(clone.item_layer.take());
                self.text_paths(
                    &mut clone.text_paths,
                    new_id.as_deref(),
                    src_stories,
                    dst_stories,
                );
                dst.polygons.push(clone);
                FrameRef::Polygon(dst.polygons.len() - 1)
            }
        };
        // The side maps keyed by `Self`.
        if let (Some(source_id), Some(new_id)) = (source_id, new_id) {
            if let Some(labels) = src.labels.get(&source_id).cloned() {
                dst.labels.insert(new_id.clone(), labels);
            }
            if let Some(meta) = src.image_metadata.get(&source_id).cloned() {
                dst.image_metadata.insert(new_id.clone(), meta);
            }
            if let Some(children) = src.nested_children.get(&source_id).cloned() {
                let cloned: Vec<FrameRef> = children
                    .iter()
                    .map(|c| self.graft(src, dst, src_stories, dst_stories, *c, false))
                    .collect();
                dst.nested_children.insert(new_id, cloned);
            }
        }
        new_ref
    }

    /// A text-on-path's story is copied with its host; the path entry
    /// takes an id derived from the host's (unique) new id.
    fn text_paths(
        &mut self,
        paths: &mut [paged_model::TextPath],
        host_id: Option<&str>,
        src_stories: &[ParsedStory],
        dst_stories: &mut Vec<ParsedStory>,
    ) {
        let renaming = self.ids.is_some();
        for (k, tp) in paths.iter_mut().enumerate() {
            if let Some(new_sid) = self.story_for(src_stories, dst_stories, &tp.parent_story) {
                tp.parent_story = new_sid;
            }
            if renaming {
                tp.self_id = host_id.map(|h| format!("{h}_tp{k}"));
            }
        }
    }
}

// ------------------------------------------------------------------ paste

/// The resources a paste added, as `<kind>:<id>` (for its undo).
fn add_resources(doc: &mut Document, res: &SnippetResources) -> Vec<String> {
    let mut added = Vec::new();
    macro_rules! merge {
        ($src:expr, $dst:expr, $kind:literal) => {
            for (k, v) in &$src {
                if !$dst.contains_key(k) {
                    $dst.insert(k.clone(), v.clone());
                    added.push(format!("{}:{}", $kind, k));
                }
            }
        };
    }
    merge!(res.colors, doc.palette.colors, "color");
    merge!(res.swatches, doc.palette.swatches, "swatch");
    merge!(res.gradients, doc.palette.gradients, "gradient");
    merge!(
        res.paragraph_styles,
        doc.styles.paragraph_styles,
        "paragraphStyle"
    );
    merge!(
        res.character_styles,
        doc.styles.character_styles,
        "characterStyle"
    );
    merge!(res.object_styles, doc.styles.object_styles, "objectStyle");
    merge!(res.stroke_styles, doc.styles.stroke_styles, "strokeStyle");
    merge!(res.conditions, doc.styles.conditions, "condition");
    added
}

fn remove_resources(doc: &mut Document, added: &[String]) {
    for entry in added {
        let Some((kind, id)) = entry.split_once(':') else {
            continue;
        };
        match kind {
            "color" => {
                doc.palette.colors.remove(id);
            }
            "swatch" => {
                doc.palette.swatches.remove(id);
            }
            "gradient" => {
                doc.palette.gradients.remove(id);
            }
            "paragraphStyle" => {
                doc.styles.paragraph_styles.remove(id);
            }
            "characterStyle" => {
                doc.styles.character_styles.remove(id);
            }
            "objectStyle" => {
                doc.styles.object_styles.remove(id);
            }
            "strokeStyle" => {
                doc.styles.stroke_styles.remove(id);
            }
            "condition" => {
                doc.styles.conditions.remove(id);
            }
            _ => {}
        }
    }
}

fn spread_index(doc: &Document, spread: &str) -> Option<usize> {
    doc.spreads
        .iter()
        .position(|p| p.spread.self_id.as_deref() == Some(spread))
        .or_else(|| doc.spreads.iter().position(|p| p.src == spread))
}

/// The page-item and story ids a direct kernel caller did not supply,
/// on the canvas minter's two number lines.
fn mint(doc: &Document, demand: DuplicateDemand) -> (Vec<String>, Vec<String>) {
    let base = crate::ids::highest_u_hex_id(doc) + 1;
    let ids = (0..demand.items as u64)
        .map(|k| format!("u{:x}", base + k))
        .collect();
    let n = next_story_number(doc);
    let story_ids = (0..demand.stories)
        .map(|k| format!("Story/u{}", n + k))
        .collect();
    (ids, story_ids)
}

fn page_item_ids(doc: &Document) -> HashSet<&str> {
    let mut out = HashSet::new();
    for p in &doc.spreads {
        let s = &p.spread;
        for id in s
            .text_frames
            .iter()
            .map(|f| f.self_id.as_deref())
            .chain(s.rectangles.iter().map(|f| f.self_id.as_deref()))
            .chain(s.ovals.iter().map(|f| f.self_id.as_deref()))
            .chain(s.graphic_lines.iter().map(|f| f.self_id.as_deref()))
            .chain(s.polygons.iter().map(|f| f.self_id.as_deref()))
            .chain(s.groups.iter().map(|f| f.self_id.as_deref()))
            .flatten()
        {
            out.insert(id);
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_insert_snippet(
    doc: &mut Document,
    snippet_json: &str,
    spread: &str,
    dx: f32,
    dy: f32,
    ids: &[String],
    story_ids: &[String],
) -> Result<AppliedOperation, OperationError> {
    // ---- validation: nothing is written before this block ends ----
    let snippet = parse_snippet(snippet_json)?;
    let si = spread_index(doc, spread)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Spread(spread.to_string())))?;
    if !dx.is_finite() || !dy.is_finite() {
        return Err(refused(
            NodeId::Spread(spread.to_string()),
            "the paste offset is not a number",
        ));
    }
    let demand = snippet_demand(&snippet);
    let (ids, story_ids): (Vec<String>, Vec<String>) = if ids.is_empty() && story_ids.is_empty() {
        mint(doc, demand)
    } else {
        (ids.to_vec(), story_ids.to_vec())
    };
    if ids.len() != demand.items || story_ids.len() != demand.stories {
        return Err(refused(
            NodeId::Spread(spread.to_string()),
            format!(
                "the paste needs {} item id(s) and {} story id(s); {} and {} were supplied",
                demand.items,
                demand.stories,
                ids.len(),
                story_ids.len()
            ),
        ));
    }
    {
        let taken = page_item_ids(doc);
        let mut seen: HashSet<&str> = HashSet::new();
        for id in &ids {
            if !seen.insert(id.as_str()) || taken.contains(id.as_str()) {
                return Err(OperationError::DuplicateNodeId { id: id.clone() });
            }
        }
        let mut seen_stories: HashSet<&str> = HashSet::new();
        for id in &story_ids {
            if !seen_stories.insert(id.as_str()) || doc.stories.iter().any(|s| s.self_id == *id) {
                return Err(OperationError::DuplicateNodeId { id: id.clone() });
            }
        }
    }

    // ---- mutation (validated; cannot fail past this point) ----
    let layers: HashSet<String> = doc
        .designmap
        .layers
        .iter()
        .map(|l| l.self_id.clone())
        .collect();
    let mut graft = Graft {
        dx,
        dy,
        ids: Some(ids.iter()),
        story_ids: Some(story_ids.iter()),
        layers: Some(layers),
        copied: Vec::new(),
    };
    {
        let (spreads, stories) = (&mut doc.spreads, &mut doc.stories);
        let target = &mut spreads[si].spread;
        ensure_frames_in_order(target);
        for r in &snippet.spread.frames_in_order {
            let root = graft.graft(&snippet.spread, target, &snippet.stories, stories, *r, true);
            // On top: InDesign pastes in front of everything on the spread.
            target.frames_in_order.push(root);
        }
    }
    let added = add_resources(doc, &snippet.resources);
    // Hyperlinks: a copied story's sources get fresh ids and the links that
    // owned them are copied onto the new ones (the snippet's links, which
    // are the document's own when the copy came from it). A source whose
    // link points at a destination this document lacks loses the link,
    // not the text.
    let known_destinations: BTreeSet<String> = doc
        .designmap
        .hyperlinks
        .iter()
        .filter_map(|h| h.destination.clone())
        .collect();
    for (_, new_sid) in &graft.copied {
        let Some(pos) = doc.stories.iter().position(|s| s.self_id == *new_sid) else {
            continue;
        };
        let mut links = paged_model::DesignMap {
            hyperlinks: snippet
                .hyperlinks
                .iter()
                .filter(|h| {
                    h.destination
                        .as_ref()
                        .is_none_or(|d| known_destinations.contains(d))
                })
                .cloned()
                .collect(),
            ..Default::default()
        };
        let before = links.hyperlinks.len();
        let story = &mut doc.stories[pos].story;
        relink_copied_story(&mut links, story, new_sid);
        let owned: Vec<paged_model::Hyperlink> = links.hyperlinks.split_off(before);
        for p in &mut story.paragraphs {
            for run in &mut p.runs {
                let keep = run.hyperlink_source.as_deref().is_some_and(|src| {
                    owned
                        .iter()
                        .any(|h| h.source.as_deref().is_some_and(|s| names_source(s, src)))
                });
                if !keep {
                    run.hyperlink_source = None;
                }
            }
        }
        doc.designmap.hyperlinks.extend(owned);
    }

    Ok(AppliedOperation {
        op: Operation::InsertSnippet {
            snippet: snippet_json.to_string(),
            spread: spread.to_string(),
            dx,
            dy,
            ids: ids.clone(),
            story_ids: story_ids.clone(),
            added: added.clone(),
        },
        inverse: Operation::RemoveSnippet {
            snippet: snippet_json.to_string(),
            spread: spread.to_string(),
            dx,
            dy,
            ids,
            story_ids,
            added,
        },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_remove_snippet(
    doc: &mut Document,
    snippet_json: &str,
    spread: &str,
    dx: f32,
    dy: f32,
    ids: &[String],
    story_ids: &[String],
    added: &[String],
) -> Result<AppliedOperation, OperationError> {
    remove_minted(doc, ids, story_ids)?;
    remove_resources(doc, added);
    Ok(AppliedOperation {
        op: Operation::RemoveSnippet {
            snippet: snippet_json.to_string(),
            spread: spread.to_string(),
            dx,
            dy,
            ids: ids.to_vec(),
            story_ids: story_ids.to_vec(),
            added: added.to_vec(),
        },
        inverse: Operation::InsertSnippet {
            snippet: snippet_json.to_string(),
            spread: spread.to_string(),
            dx,
            dy,
            ids: ids.to_vec(),
            story_ids: story_ids.to_vec(),
            added: added.to_vec(),
        },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

// ------------------------------------------------------------------ helpers

/// Every listed item in paint order: the z-table with each group's members
/// and each container's pasted-in children expanded in place.
fn paint_order(spread: &Spread) -> Vec<FrameRef> {
    fn walk(spread: &Spread, r: FrameRef, out: &mut Vec<FrameRef>) {
        out.push(r);
        if let FrameRef::Group(gi) = r {
            if let Some(g) = spread.groups.get(gi) {
                for m in &g.members {
                    walk(spread, *m, out);
                }
            }
        }
        if let Some(children) = ref_self_id(spread, r).and_then(|id| spread.nested_children.get(id))
        {
            for c in children {
                walk(spread, *c, out);
            }
        }
    }
    let mut table = spread.frames_in_order.clone();
    if table.is_empty() {
        let mut s = spread.clone();
        ensure_frames_in_order(&mut s);
        table = s.frames_in_order;
    }
    let mut out = Vec::new();
    for r in table {
        walk(spread, r, &mut out);
    }
    out
}

/// The story ids an item itself names (a text frame's, its text paths').
fn own_stories(spread: &Spread, r: FrameRef) -> Vec<String> {
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
            .map(|f| {
                f.text_paths
                    .iter()
                    .map(|t| t.parent_story.clone())
                    .collect()
            })
            .unwrap_or_default(),
        FrameRef::GraphicLine(i) => spread
            .graphic_lines
            .get(i)
            .map(|f| {
                f.text_paths
                    .iter()
                    .map(|t| t.parent_story.clone())
                    .collect()
            })
            .unwrap_or_default(),
        FrameRef::Polygon(i) => spread
            .polygons
            .get(i)
            .map(|f| {
                f.text_paths
                    .iter()
                    .map(|t| t.parent_story.clone())
                    .collect()
            })
            .unwrap_or_default(),
        FrameRef::Oval(_) | FrameRef::Group(_) => Vec::new(),
    }
}

/// Every story an item's subtree names, in paint order.
fn frame_stories(spread: &Spread, r: FrameRef) -> Vec<String> {
    let mut out = own_stories(spread, r);
    if let FrameRef::Group(gi) = r {
        if let Some(g) = spread.groups.get(gi) {
            for m in &g.members {
                out.extend(frame_stories(spread, *m));
            }
        }
    }
    if let Some(children) = ref_self_id(spread, r).and_then(|id| spread.nested_children.get(id)) {
        for c in children {
            out.extend(frame_stories(spread, *c));
        }
    }
    out
}

fn story_sources(story: &paged_model::Story) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in &story.paragraphs {
        for r in &p.runs {
            if let Some(s) = &r.hyperlink_source {
                if !out.contains(s) {
                    out.push(s.clone());
                }
            }
        }
    }
    out
}

/// A story's text: each paragraph's runs, paragraphs joined by `\n`.
fn story_plain_text(story: &paged_model::Story) -> String {
    story
        .paragraphs
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `b` mapped through `m`, as an axis-aligned `[top, left, bottom, right]`.
fn mapped_box(b: paged_model::Bounds, m: Option<[f32; 6]>) -> [f32; 4] {
    let m = m.unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let (mut t, mut l, mut bo, mut r) = (
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    );
    for (x, y) in [
        (b.left, b.top),
        (b.right, b.top),
        (b.left, b.bottom),
        (b.right, b.bottom),
    ] {
        let px = m[0] * x + m[2] * y + m[4];
        let py = m[1] * x + m[3] * y + m[5];
        l = l.min(px);
        r = r.max(px);
        t = t.min(py);
        bo = bo.max(py);
    }
    [t, l, bo, r]
}

fn item_box(spread: &Spread, r: FrameRef) -> Option<[f32; 4]> {
    match r {
        FrameRef::TextFrame(i) => spread
            .text_frames
            .get(i)
            .map(|f| mapped_box(f.bounds, f.item_transform)),
        FrameRef::Rectangle(i) => spread
            .rectangles
            .get(i)
            .map(|f| mapped_box(f.bounds, f.item_transform)),
        FrameRef::Oval(i) => spread
            .ovals
            .get(i)
            .map(|f| mapped_box(f.bounds, f.item_transform)),
        FrameRef::GraphicLine(i) => spread
            .graphic_lines
            .get(i)
            .map(|f| mapped_box(f.bounds, f.item_transform)),
        FrameRef::Polygon(i) => spread
            .polygons
            .get(i)
            .map(|f| mapped_box(f.bounds, f.item_transform)),
        FrameRef::Group(gi) => {
            let g = spread.groups.get(gi)?;
            union_box(spread, &g.members)
        }
    }
}

fn union_box(spread: &Spread, refs: &[FrameRef]) -> Option<[f32; 4]> {
    let mut acc: Option<[f32; 4]> = None;
    for r in refs {
        if let Some(b) = item_box(spread, *r) {
            acc = Some(match acc {
                None => b,
                Some(a) => [
                    a[0].min(b[0]),
                    a[1].min(b[1]),
                    a[2].max(b[2]),
                    a[3].max(b[3]),
                ],
            });
        }
    }
    acc
}

/// The page whose box holds the centre of `b` (else the nearest one), and
/// its top-left in the spread.
fn page_under(spread: &Spread, b: [f32; 4]) -> (Option<String>, Option<[f32; 2]>) {
    let (cx, cy) = ((b[1] + b[3]) / 2.0, (b[0] + b[2]) / 2.0);
    let mut best: Option<(f32, &paged_model::Page, [f32; 4])> = None;
    for p in &spread.pages {
        let pb = mapped_box(p.bounds, p.item_transform);
        let dx = (pb[1] - cx).max(cx - pb[3]).max(0.0);
        let dy = (pb[0] - cy).max(cy - pb[2]).max(0.0);
        let d = dx * dx + dy * dy;
        if best.as_ref().is_none_or(|(bd, _, _)| d < *bd) {
            best = Some((d, p, pb));
        }
    }
    match best {
        Some((_, p, pb)) => (p.self_id.clone(), Some([pb[1], pb[0]])),
        None => (None, None),
    }
}

/// Every string in `value`, recursively (short ones: an id is short, and
/// an image's base64 is not).
fn strings_in(value: &serde_json::Value, out: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(s) if s.len() <= 512 => {
            out.insert(s.clone());
        }
        serde_json::Value::Array(a) => a.iter().for_each(|v| strings_in(v, out)),
        serde_json::Value::Object(o) => o.values().for_each(|v| strings_in(v, out)),
        _ => {}
    }
}

/// The resources `mini` and `stories` name, closed over what those
/// resources name in turn (a style's `BasedOn`, a tint's base colour, a
/// gradient's stops).
fn collect_resources(doc: &Document, mini: &Spread, stories: &[ParsedStory]) -> SnippetResources {
    let mut names: HashSet<String> = HashSet::new();
    if let Ok(v) = serde_json::to_value(mini) {
        strings_in(&v, &mut names);
    }
    if let Ok(v) = serde_json::to_value(stories) {
        strings_in(&v, &mut names);
    }
    let mut res = SnippetResources::default();
    loop {
        let mut grew = false;
        macro_rules! take {
            ($src:expr, $dst:expr) => {
                for (k, v) in &$src {
                    if names.contains(k) && !$dst.contains_key(k) {
                        $dst.insert(k.clone(), v.clone());
                        if let Ok(j) = serde_json::to_value(v) {
                            strings_in(&j, &mut names);
                        }
                        grew = true;
                    }
                }
            };
        }
        take!(doc.palette.colors, res.colors);
        take!(doc.palette.swatches, res.swatches);
        take!(doc.palette.gradients, res.gradients);
        take!(doc.styles.paragraph_styles, res.paragraph_styles);
        take!(doc.styles.character_styles, res.character_styles);
        take!(doc.styles.object_styles, res.object_styles);
        take!(doc.styles.stroke_styles, res.stroke_styles);
        take!(doc.styles.conditions, res.conditions);
        if !grew {
            break;
        }
    }
    res
}
