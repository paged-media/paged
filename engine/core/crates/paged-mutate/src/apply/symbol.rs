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

//! Engine ADR 1039 — symbols: definitions in the document's store,
//! instances on the spreads.
//!
//! * `CreateSymbol` copies page items whole (the snippet copy, ADR 193)
//!   into a new definition, in definition space: the centre of their union
//!   box is the registration point. With `replace` the items leave the page
//!   and an instance takes their place, drawn exactly where they were.
//! * `RedefineSymbol` swaps a definition's artwork (its revision moves on,
//!   so every instance draws the new artwork), its name or its 9-slice
//!   guides.
//! * `PlaceSymbolInstance` puts an instance on a spread, on top.
//! * `BreakSymbolLink` expands an instance into the definition's artwork as
//!   native items, mapped through the instance's transform, in the
//!   instance's z slot.
//! * `DeleteSymbol` breaks every instance of a definition and removes it.
//!
//! ## Undo
//!
//! Every symbol op touches a few spreads, the symbol store and (for a
//! replace or an expansion) some stories. Its inverse is one
//! `RestoreSymbolState` that puts exactly those back: the touched spreads
//! and the store whole, the stories by id. Applying a state captures the
//! state it replaces, so undo and redo are the same op. A failed op is
//! rolled back from the same capture before it returns its error.

use std::collections::HashSet;

use paged_model::{
    Bounds, FrameRef, Group, GroupTransparency, NineSlice, Spread, SymbolDefinition,
    SymbolInstance, SymbolOverrides, SymbolStory,
};
use paged_scene::{Document, ParsedStory};
use serde::{Deserialize, Serialize};

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, NodeId, Operation};

use super::duplicate_nodes::{ref_self_id, refused, DuplicateDemand};
use super::insert_node::{ensure_frames_in_order, ref_home, unregister_frame_ref, RefHome};
use super::snippet::{count_subtree, extract_snippet, graft_roots, mint, page_item_ids};

type Affine = [f32; 6];

const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `outer ∘ inner` (`inner` applies first).
fn multiply(outer: Affine, inner: Affine) -> Affine {
    let [a, b, c, d, e, f] = outer;
    let [g, h, i, j, k, l] = inner;
    [
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * l + e,
        b * k + d * l + f,
    ]
}

/// The state a symbol op replaces (see the module docs).
#[derive(Debug, Default, Serialize, Deserialize)]
struct SymbolState {
    /// `(spread index, the spread)`, each put back whole.
    spreads: Vec<(usize, Spread)>,
    /// The symbol store, put back whole.
    symbols: Vec<SymbolDefinition>,
    /// Stories to put back, at their index.
    add_stories: Vec<(usize, ParsedStory)>,
    /// Stories to take out, by id.
    drop_stories: Vec<String>,
}

fn structural() -> InvalidationHint {
    InvalidationHint {
        structural: true,
        ..Default::default()
    }
}

/// Run `f` against `doc` with the spreads `touched` (indices), the symbol
/// store and the story list captured; build the inverse from the capture.
/// `f` returns the op as applied (ids resolved, so a redo lands the same).
fn transact(
    doc: &mut Document,
    touched: &[usize],
    f: impl FnOnce(&mut Document, &mut Vec<(usize, ParsedStory)>) -> Result<Operation, OperationError>,
) -> Result<AppliedOperation, OperationError> {
    let mut seen = HashSet::new();
    let spreads: Vec<(usize, Spread)> = touched
        .iter()
        .filter(|i| seen.insert(**i))
        .filter_map(|&i| doc.spreads.get(i).map(|p| (i, p.spread.clone())))
        .collect();
    let symbols = doc.symbols.clone();
    let before_ids: HashSet<String> = doc.stories.iter().map(|s| s.self_id.clone()).collect();
    let mut removed: Vec<(usize, ParsedStory)> = Vec::new();
    match f(doc, &mut removed) {
        Ok(op) => {
            let drop_stories: Vec<String> = doc
                .stories
                .iter()
                .filter(|s| !before_ids.contains(&s.self_id))
                .map(|s| s.self_id.clone())
                .collect();
            let state = SymbolState {
                spreads,
                symbols,
                add_stories: removed,
                drop_stories,
            };
            Ok(AppliedOperation {
                op,
                inverse: Operation::RestoreSymbolState {
                    state: serde_json::to_string(&state).expect("a symbol state serialises"),
                },
                invalidation: structural(),
            })
        }
        Err(e) => {
            // Roll back from the capture: nothing of a refused op stays.
            for (i, spread) in spreads {
                doc.spreads[i].spread = spread;
            }
            doc.symbols = symbols;
            doc.stories.retain(|s| before_ids.contains(&s.self_id));
            removed.sort_by_key(|(i, _)| *i);
            for (i, story) in removed {
                let at = i.min(doc.stories.len());
                doc.stories.insert(at, story);
            }
            Err(e)
        }
    }
}

pub(super) fn apply_restore_symbol_state(
    doc: &mut Document,
    state_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let state: SymbolState = serde_json::from_str(state_json).map_err(|e| {
        refused(
            NodeId::Document(String::new()),
            format!("the symbol state could not be read ({e})"),
        )
    })?;
    if let Some((i, _)) = state.spreads.iter().find(|(i, _)| *i >= doc.spreads.len()) {
        return Err(refused(
            NodeId::Document(String::new()),
            format!("the symbol state names spread {i}, which the document lacks"),
        ));
    }
    let mut inverse = SymbolState::default();
    for (i, spread) in state.spreads {
        let old = std::mem::replace(&mut doc.spreads[i].spread, spread);
        inverse.spreads.push((i, old));
    }
    inverse.symbols = std::mem::replace(&mut doc.symbols, state.symbols);
    for id in &state.drop_stories {
        if let Some(pos) = doc.stories.iter().position(|s| s.self_id == *id) {
            let story = doc.stories.remove(pos);
            inverse.add_stories.push((pos, story));
        }
    }
    // Put back in index order, so each lands where it was.
    inverse.add_stories.reverse();
    let mut add = state.add_stories;
    add.sort_by_key(|(i, _)| *i);
    for (i, story) in add {
        inverse.drop_stories.push(story.self_id.clone());
        let at = i.min(doc.stories.len());
        doc.stories.insert(at, story);
    }
    let inverse_json = serde_json::to_string(&inverse).expect("a symbol state serialises");
    Ok(AppliedOperation {
        op: Operation::RestoreSymbolState {
            state: state_json.to_string(),
        },
        inverse: Operation::RestoreSymbolState {
            state: inverse_json,
        },
        invalidation: structural(),
    })
}

// ------------------------------------------------------------------ helpers

fn spread_of_node(doc: &Document, node: &NodeId) -> Option<usize> {
    let id = node.self_id();
    doc.spreads
        .iter()
        .position(|p| super::duplicate_nodes::ref_in_spread(&p.spread, node).is_some())
        .or_else(|| {
            doc.spreads.iter().position(|p| {
                p.spread
                    .instances
                    .iter()
                    .any(|i| i.self_id.as_deref() == Some(id))
            })
        })
}

/// The spread holding the instance `id`, and its index in `instances`.
pub(crate) fn find_instance(doc: &Document, id: &str) -> Option<(usize, usize)> {
    doc.spreads.iter().enumerate().find_map(|(si, p)| {
        p.spread
            .instances
            .iter()
            .position(|i| i.self_id.as_deref() == Some(id))
            .map(|ii| (si, ii))
    })
}

fn check_nine_slice(def_bounds: Bounds, g: [f32; 4]) -> Result<NineSlice, String> {
    let [left, top, right, bottom] = g;
    if g.iter().any(|v| !v.is_finite() || *v < 0.0) {
        return Err("9-slice guides are insets and must be numbers ≥ 0".into());
    }
    if left + right > def_bounds.width() || top + bottom > def_bounds.height() {
        return Err(
            "9-slice guides overlap: the insets are wider or taller than the symbol".into(),
        );
    }
    Ok(NineSlice {
        left,
        top,
        right,
        bottom,
    })
}

/// Map every item of the subtree at `r` through `m` (in spread space):
/// each leaf's and instance's transform, a ROOT group's own transform (a
/// nested group's is relative to its parent and rides along), pasted-in
/// children and mask items (both stored in spread space).
pub(super) fn premultiply_subtree(spread: &mut Spread, r: FrameRef, m: Affine, root: bool) {
    let pre = |t: &mut Option<[f32; 6]>| *t = Some(multiply(m, t.unwrap_or(IDENTITY)));
    match r {
        FrameRef::TextFrame(i) => pre(&mut spread.text_frames[i].item_transform),
        FrameRef::Rectangle(i) => pre(&mut spread.rectangles[i].item_transform),
        FrameRef::Oval(i) => pre(&mut spread.ovals[i].item_transform),
        FrameRef::GraphicLine(i) => pre(&mut spread.graphic_lines[i].item_transform),
        FrameRef::Polygon(i) => pre(&mut spread.polygons[i].item_transform),
        FrameRef::Instance(i) => {
            let inst = &mut spread.instances[i];
            inst.item_transform = multiply(m, inst.item_transform);
        }
        FrameRef::Group(gi) => {
            if root {
                pre(&mut spread.groups[gi].item_transform);
            }
            for member in spread.groups[gi].members.clone() {
                premultiply_subtree(spread, member, m, false);
            }
        }
    }
    let id = ref_self_id(spread, r).map(str::to_string);
    if let Some(id) = id {
        if let Some(children) = spread.nested_children.get(&id).cloned() {
            for c in children {
                premultiply_subtree(spread, c, m, false);
            }
        }
        if let Some(mask) = spread.opacity_masks.get(&id).cloned() {
            if let Some(mr) = leaf_ref(spread, &mask.mask_item) {
                premultiply_subtree(spread, mr, m, false);
            }
        }
    }
}

fn leaf_ref(spread: &Spread, id: &str) -> Option<FrameRef> {
    let is = |s: &Option<String>| s.as_deref() == Some(id);
    if let Some(i) = spread.rectangles.iter().position(|f| is(&f.self_id)) {
        return Some(FrameRef::Rectangle(i));
    }
    if let Some(i) = spread.polygons.iter().position(|f| is(&f.self_id)) {
        return Some(FrameRef::Polygon(i));
    }
    if let Some(i) = spread.ovals.iter().position(|f| is(&f.self_id)) {
        return Some(FrameRef::Oval(i));
    }
    if let Some(i) = spread.graphic_lines.iter().position(|f| is(&f.self_id)) {
        return Some(FrameRef::GraphicLine(i));
    }
    None
}

/// Set the layer of every leaf of the subtree at `r`.
fn set_subtree_layer(spread: &mut Spread, r: FrameRef, layer: &Option<String>) {
    match r {
        FrameRef::TextFrame(i) => spread.text_frames[i].item_layer = layer.clone(),
        FrameRef::Rectangle(i) => spread.rectangles[i].item_layer = layer.clone(),
        FrameRef::Oval(i) => spread.ovals[i].item_layer = layer.clone(),
        FrameRef::GraphicLine(i) => spread.graphic_lines[i].item_layer = layer.clone(),
        FrameRef::Polygon(i) => spread.polygons[i].item_layer = layer.clone(),
        FrameRef::Instance(i) => spread.instances[i].item_layer = layer.clone(),
        FrameRef::Group(gi) => {
            for member in spread.groups[gi].members.clone() {
                set_subtree_layer(spread, member, layer);
            }
        }
    }
}

fn item_layer_of(spread: &Spread, r: FrameRef) -> Option<String> {
    match r {
        FrameRef::TextFrame(i) => spread.text_frames.get(i)?.item_layer.clone(),
        FrameRef::Rectangle(i) => spread.rectangles.get(i)?.item_layer.clone(),
        FrameRef::Oval(i) => spread.ovals.get(i)?.item_layer.clone(),
        FrameRef::GraphicLine(i) => spread.graphic_lines.get(i)?.item_layer.clone(),
        FrameRef::Polygon(i) => spread.polygons.get(i)?.item_layer.clone(),
        FrameRef::Instance(i) => spread.instances.get(i)?.item_layer.clone(),
        FrameRef::Group(gi) => spread
            .groups
            .get(gi)?
            .members
            .iter()
            .find_map(|m| item_layer_of(spread, *m)),
    }
}

/// The leaves a removal of `r` removes, back to front (a group goes with
/// its last member; a container takes its pasted-in children along).
fn removal_leaves(spread: &Spread, r: FrameRef, out: &mut Vec<NodeId>) {
    if let FrameRef::Group(gi) = r {
        if let Some(g) = spread.groups.get(gi) {
            for m in &g.members {
                removal_leaves(spread, *m, out);
            }
        }
        return;
    }
    out.push(super::duplicate_nodes::node_for(spread, r));
}

/// What a capture of `sources` makes: the definition's items (definition
/// space), its stories, its bounds, and where the registration point sat
/// in spread space.
struct Capture {
    items: Spread,
    stories: Vec<SymbolStory>,
    bounds: Bounds,
    origin: [f32; 2],
    spread: usize,
    /// The ids of the stories the sources own (a replace takes them out).
    story_ids: Vec<String>,
}

fn capture(doc: &Document, sources: &[NodeId]) -> Result<Capture, OperationError> {
    if sources.is_empty() {
        return Err(refused(
            NodeId::Document(String::new()),
            "a symbol needs artwork — select the page items to make it from",
        ));
    }
    for s in sources {
        if matches!(s, NodeId::Instance(_)) {
            return Err(refused(
                s.clone(),
                "a symbol cannot hold an instance of another symbol yet — break the link first",
            ));
        }
    }
    let snippet = extract_snippet(doc, sources)?;
    if !snippet.spread.instances.is_empty() {
        return Err(refused(
            sources[0].clone(),
            "a symbol cannot hold an instance of another symbol yet — break the link first",
        ));
    }
    let si = spread_of_node(doc, &sources[0])
        .ok_or_else(|| OperationError::NodeNotFound(sources[0].clone()))?;
    let [t, l, b, r] = snippet.bounds;
    let (cx, cy) = ((l + r) / 2.0, (t + b) / 2.0);
    let mut items = snippet.spread;
    let to_def = [1.0, 0.0, 0.0, 1.0, -cx, -cy];
    for root in items.frames_in_order.clone() {
        premultiply_subtree(&mut items, root, to_def, true);
    }
    let story_ids = snippet.stories.iter().map(|s| s.self_id.clone()).collect();
    Ok(Capture {
        items,
        stories: snippet
            .stories
            .into_iter()
            .map(|s| SymbolStory {
                self_id: s.self_id,
                story: s.story,
            })
            .collect(),
        bounds: Bounds {
            top: t - cy,
            left: l - cx,
            bottom: b - cy,
            right: r - cx,
        },
        origin: [cx, cy],
        spread: si,
        story_ids,
    })
}

/// Replace the captured sources with an instance `instance_id` of
/// `symbol` drawn where they were, in the top-most source's slot.
fn replace_with_instance(
    doc: &mut Document,
    cap: &Capture,
    sources: &[NodeId],
    symbol: &str,
    instance_id: &str,
    removed_stories: &mut Vec<(usize, ParsedStory)>,
) -> Result<(), OperationError> {
    let si = cap.spread;
    let (home, layer, leaves) = {
        let spread = &mut doc.spreads[si].spread;
        ensure_frames_in_order(spread);
        let refs: Vec<FrameRef> = sources
            .iter()
            .filter_map(|n| super::duplicate_nodes::ref_in_spread(spread, n))
            .collect();
        let order = paint_order_positions(spread);
        let top = refs
            .iter()
            .copied()
            .max_by_key(|r| order.iter().position(|x| x == r).unwrap_or(0))
            .ok_or_else(|| OperationError::NodeNotFound(sources[0].clone()))?;
        let mut leaves = Vec::new();
        let mut sorted = refs.clone();
        sorted.sort_by_key(|r| order.iter().position(|x| x == r).unwrap_or(0));
        for r in sorted {
            removal_leaves(spread, r, &mut leaves);
        }
        (ref_home(spread, top), item_layer_of(spread, top), leaves)
    };
    // Seat the instance just above the top-most source, then remove the
    // sources (their removal never shifts an instance index).
    {
        let spread = &mut doc.spreads[si].spread;
        let idx = spread.instances.len();
        spread.instances.push(SymbolInstance {
            self_id: Some(instance_id.to_string()),
            symbol: symbol.to_string(),
            item_transform: [1.0, 0.0, 0.0, 1.0, cap.origin[0], cap.origin[1]],
            item_layer: layer,
            visible: true,
            locked: false,
            overrides: SymbolOverrides::default(),
            nine_slice: None,
            bounds: cap.bounds,
        });
        let r = FrameRef::Instance(idx);
        match home {
            Some(RefHome::Group(gi, i)) => spread.groups[gi].members.insert(i + 1, r),
            Some(RefHome::Root(i)) => spread.frames_in_order.insert(i + 1, r),
            _ => spread.frames_in_order.push(r),
        }
    }
    for leaf in leaves.into_iter().rev() {
        super::apply_inner(doc, &Operation::RemoveNode { node: leaf })?;
    }
    for id in &cap.story_ids {
        if let Some(pos) = doc.stories.iter().position(|s| s.self_id == *id) {
            let story = doc.stories.remove(pos);
            removed_stories.push((pos, story));
        }
    }
    Ok(())
}

/// Every listed item in paint order (groups expanded in place).
fn paint_order_positions(spread: &Spread) -> Vec<FrameRef> {
    fn walk(spread: &Spread, r: FrameRef, out: &mut Vec<FrameRef>) {
        out.push(r);
        if let FrameRef::Group(gi) = r {
            if let Some(g) = spread.groups.get(gi) {
                for m in &g.members {
                    walk(spread, *m, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    for r in &spread.frames_in_order {
        walk(spread, *r, &mut out);
    }
    out
}

fn mint_instance_id(doc: &Document) -> String {
    format!("u{:x}", crate::ids::highest_u_hex_id(doc) + 1)
}

fn check_fresh_id(doc: &Document, id: &str) -> Result<(), OperationError> {
    let taken = page_item_ids(doc).contains(id)
        || doc.spreads.iter().any(|p| {
            p.spread
                .instances
                .iter()
                .any(|i| i.self_id.as_deref() == Some(id))
        });
    if taken {
        return Err(OperationError::DuplicateNodeId { id: id.to_string() });
    }
    Ok(())
}

// ------------------------------------------------------------------ ops

pub(super) fn apply_create_symbol(
    doc: &mut Document,
    symbol_id: &str,
    name: &str,
    sources: &[NodeId],
    replace: bool,
    instance_id: Option<&str>,
    nine_slice: Option<[f32; 4]>,
) -> Result<AppliedOperation, OperationError> {
    if symbol_id.is_empty() || doc.symbol(symbol_id).is_some() {
        return Err(refused(
            NodeId::Document(String::new()),
            format!("the document already has a symbol \"{symbol_id}\""),
        ));
    }
    let cap = capture(doc, sources)?;
    let nine = match nine_slice {
        Some(g) => Some(
            check_nine_slice(cap.bounds, g)
                .map_err(|e| refused(NodeId::Document(String::new()), e))?,
        ),
        None => None,
    };
    let instance_id = match (replace, instance_id) {
        (false, _) => None,
        (true, Some(id)) => {
            check_fresh_id(doc, id)?;
            Some(id.to_string())
        }
        (true, None) => Some(mint_instance_id(doc)),
    };
    let si = cap.spread;
    let symbol_id = symbol_id.to_string();
    let name = name.to_string();
    let sources = sources.to_vec();
    transact(doc, &[si], move |doc, removed| {
        doc.symbols.push(SymbolDefinition {
            id: symbol_id.clone(),
            name: name.clone(),
            revision: 0,
            items: cap.items.clone(),
            stories: cap.stories.clone(),
            bounds: cap.bounds,
            nine_slice: nine,
        });
        if let Some(iid) = &instance_id {
            replace_with_instance(doc, &cap, &sources, &symbol_id, iid, removed)?;
        }
        Ok(Operation::CreateSymbol {
            symbol_id,
            name,
            sources,
            replace,
            instance_id,
            nine_slice,
        })
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn apply_redefine_symbol(
    doc: &mut Document,
    symbol_id: &str,
    sources: &[NodeId],
    name: Option<&str>,
    nine_slice: Option<&[f32]>,
    replace: bool,
    instance_id: Option<&str>,
) -> Result<AppliedOperation, OperationError> {
    let Some(pos) = doc.symbols.iter().position(|d| d.id == symbol_id) else {
        return Err(refused(
            NodeId::Document(String::new()),
            format!("the document has no symbol \"{symbol_id}\""),
        ));
    };
    let cap = if sources.is_empty() {
        None
    } else {
        Some(capture(doc, sources)?)
    };
    let bounds = cap
        .as_ref()
        .map(|c| c.bounds)
        .unwrap_or(doc.symbols[pos].bounds);
    let nine: Option<Option<NineSlice>> = match nine_slice {
        None => None,
        Some([]) => Some(None),
        Some(&[l, t, r, b]) => Some(Some(
            check_nine_slice(bounds, [l, t, r, b])
                .map_err(|e| refused(NodeId::Document(String::new()), e))?,
        )),
        Some(_) => {
            return Err(refused(
                NodeId::Document(String::new()),
                "9-slice guides are four insets: [left, top, right, bottom]",
            ))
        }
    };
    let instance_id = match (&cap, replace, instance_id) {
        (Some(_), true, Some(id)) => {
            check_fresh_id(doc, id)?;
            Some(id.to_string())
        }
        (Some(_), true, None) => Some(mint_instance_id(doc)),
        _ => None,
    };
    let touched: Vec<usize> = cap.as_ref().map(|c| vec![c.spread]).unwrap_or_default();
    let symbol_id = symbol_id.to_string();
    let name = name.map(str::to_string);
    let nine_arg = nine_slice.map(<[f32]>::to_vec);
    let sources = sources.to_vec();
    transact(doc, &touched, move |doc, removed| {
        {
            let def = &mut doc.symbols[pos];
            if let Some(n) = &name {
                def.name = n.clone();
            }
            if let Some(c) = &cap {
                def.items = c.items.clone();
                def.stories = c.stories.clone();
                def.bounds = c.bounds;
                def.revision += 1;
            }
            if let Some(n) = nine {
                def.nine_slice = n;
            }
        }
        if let (Some(c), Some(iid)) = (&cap, &instance_id) {
            replace_with_instance(doc, c, &sources, &symbol_id, iid, removed)?;
        }
        Ok(Operation::RedefineSymbol {
            symbol_id,
            sources,
            name,
            nine_slice: nine_arg,
            replace,
            instance_id,
        })
    })
}

pub(super) fn apply_place_symbol_instance(
    doc: &mut Document,
    symbol_id: &str,
    spread: &str,
    transform: [f32; 6],
    instance_id: Option<&str>,
    nine_slice: Option<[f32; 4]>,
) -> Result<AppliedOperation, OperationError> {
    let Some(def) = doc.symbol(symbol_id) else {
        return Err(refused(
            NodeId::Document(String::new()),
            format!("the document has no symbol \"{symbol_id}\""),
        ));
    };
    let def_bounds = def.bounds;
    let si = super::snippet::spread_index(doc, spread)
        .ok_or_else(|| OperationError::NodeNotFound(NodeId::Spread(spread.to_string())))?;
    if transform.iter().any(|v| !v.is_finite()) {
        return Err(refused(
            NodeId::Spread(spread.to_string()),
            "the instance transform is not a number",
        ));
    }
    let nine = match nine_slice {
        Some(g) => Some(
            check_nine_slice(def_bounds, g)
                .map_err(|e| refused(NodeId::Spread(spread.into()), e))?,
        ),
        None => None,
    };
    let instance_id = match instance_id {
        Some(id) => {
            check_fresh_id(doc, id)?;
            id.to_string()
        }
        None => mint_instance_id(doc),
    };
    let symbol_id = symbol_id.to_string();
    let spread_id = spread.to_string();
    transact(doc, &[si], move |doc, _| {
        let target = &mut doc.spreads[si].spread;
        ensure_frames_in_order(target);
        let idx = target.instances.len();
        target.instances.push(SymbolInstance {
            self_id: Some(instance_id.clone()),
            symbol: symbol_id.clone(),
            item_transform: transform,
            item_layer: None,
            visible: true,
            locked: false,
            overrides: SymbolOverrides::default(),
            nine_slice: nine,
            bounds: def_bounds,
        });
        target.frames_in_order.push(FrameRef::Instance(idx));
        Ok(Operation::PlaceSymbolInstance {
            symbol_id,
            spread: spread_id,
            transform,
            instance_id: Some(instance_id),
            nine_slice,
        })
    })
}

/// How many ids breaking `inst` mints: the definition's items, plus one
/// for the wrapping group when there is one.
fn break_demand(def: &SymbolDefinition, inst: &SymbolInstance) -> (DuplicateDemand, bool) {
    let mut demand = DuplicateDemand::default();
    let stories: Vec<ParsedStory> = def_parsed_stories(def);
    for r in &def.items.frames_in_order {
        count_subtree(&def.items, &stories, *r, &mut demand);
    }
    let grouped = def.items.frames_in_order.len() > 1
        || inst.overrides.opacity.is_some()
        || inst.overrides.blend_mode.is_some();
    if grouped {
        demand.items += 1;
    }
    (demand, grouped)
}

/// Engine ADR 1039 — how many item and story ids `BreakSymbolLink` on the
/// instance `instance` mints (`None`: no such instance). A caller that
/// mints ahead (the canvas, in a batch) passes them in the op.
pub fn symbol_break_demand(doc: &Document, instance: &str) -> Option<DuplicateDemand> {
    let (si, ii) = find_instance(doc, instance)?;
    let inst = &doc.spreads[si].spread.instances[ii];
    let def = doc.symbol(&inst.symbol)?;
    Some(break_demand(def, inst).0)
}

/// Engine ADR 1039 — the root an applied `BreakSymbolLink` made (its
/// `Self`): the first id, pre-order — the wrapping group when there is one,
/// else the one root.
pub fn symbol_break_root(op: &Operation) -> Option<&str> {
    let Operation::BreakSymbolLink { ids, .. } = op else {
        return None;
    };
    ids.first().map(String::as_str)
}

pub(crate) fn def_parsed_stories(def: &SymbolDefinition) -> Vec<ParsedStory> {
    def.stories
        .iter()
        .map(|s| ParsedStory {
            src: String::new(),
            self_id: s.self_id.clone(),
            story: s.story.clone(),
        })
        .collect()
}

/// Expand the instance at `(si, ii)` in place. `ids` / `story_ids` as
/// `BreakSymbolLink` takes them (complete; validated by the caller).
/// Returns the expansion's root.
fn expand_instance(
    doc: &mut Document,
    si: usize,
    ii: usize,
    ids: &[String],
    story_ids: &[String],
) -> Result<Option<FrameRef>, OperationError> {
    let inst = doc.spreads[si].spread.instances[ii].clone();
    let Some(def) = doc.symbol(&inst.symbol).cloned() else {
        // A dangling instance draws nothing; breaking it leaves nothing.
        let spread = &mut doc.spreads[si].spread;
        spread.instances.remove(ii);
        unregister_frame_ref(spread, FrameRef::Instance(0), ii);
        return Ok(None);
    };
    let (_, grouped) = break_demand(&def, &inst);
    let stories = def_parsed_stories(&def);
    // Pre-order, as a paste takes them: the wrapping group first.
    let item_ids = if grouped { &ids[1..] } else { ids };
    let roots = graft_roots(doc, si, &def.items, &stories, item_ids, story_ids);
    let spread = &mut doc.spreads[si].spread;
    for r in &roots {
        premultiply_subtree(spread, *r, inst.item_transform, true);
        if inst.item_layer.is_some() {
            set_subtree_layer(spread, *r, &inst.item_layer);
        }
    }
    let new_root = if grouped {
        spread.groups.push(Group {
            self_id: ids.first().cloned(),
            members: roots.clone(),
            transparency: GroupTransparency {
                blend_mode: inst.overrides.blend_mode.clone(),
                opacity: inst.overrides.opacity,
                ..Default::default()
            },
            item_transform: None,
            ..Default::default()
        });
        FrameRef::Group(spread.groups.len() - 1)
    } else {
        match roots.first() {
            Some(r) => *r,
            None => {
                spread.instances.remove(ii);
                unregister_frame_ref(spread, FrameRef::Instance(0), ii);
                return Ok(None);
            }
        }
    };
    let home = ref_home(spread, FrameRef::Instance(ii));
    // Swap the instance's ref for the expansion's, then drop the instance.
    match home {
        Some(RefHome::Root(i)) => spread.frames_in_order[i] = new_root,
        Some(RefHome::Group(gi, i)) => spread.groups[gi].members[i] = new_root,
        Some(RefHome::Nested(host, i)) => {
            if let Some(children) = spread.nested_children.get_mut(&host) {
                children[i] = new_root;
            }
        }
        None => spread.frames_in_order.push(new_root),
    }
    spread.instances.remove(ii);
    unregister_frame_ref(spread, FrameRef::Instance(0), ii);
    Ok(Some(new_root))
}

pub(super) fn apply_break_symbol_link(
    doc: &mut Document,
    instance: &str,
    ids: &[String],
    story_ids: &[String],
) -> Result<AppliedOperation, OperationError> {
    let Some((si, ii)) = find_instance(doc, instance) else {
        return Err(OperationError::NodeNotFound(NodeId::Instance(
            instance.into(),
        )));
    };
    let inst = doc.spreads[si].spread.instances[ii].clone();
    let (ids, story_ids) = match doc.symbol(&inst.symbol) {
        Some(def) => {
            let (demand, _) = break_demand(def, &inst);
            let (ids, story_ids) = if ids.is_empty() && story_ids.is_empty() {
                mint(doc, demand)
            } else {
                (ids.to_vec(), story_ids.to_vec())
            };
            if ids.len() != demand.items || story_ids.len() != demand.stories {
                return Err(refused(
                    NodeId::Instance(instance.into()),
                    format!(
                        "breaking the link needs {} item id(s) and {} story id(s); {} and {} were supplied",
                        demand.items,
                        demand.stories,
                        ids.len(),
                        story_ids.len()
                    ),
                ));
            }
            let taken = page_item_ids(doc);
            let mut seen = HashSet::new();
            for id in &ids {
                if !seen.insert(id.as_str()) || taken.contains(id.as_str()) {
                    return Err(OperationError::DuplicateNodeId { id: id.clone() });
                }
            }
            for id in &story_ids {
                if doc.stories.iter().any(|s| s.self_id == *id) {
                    return Err(OperationError::DuplicateNodeId { id: id.clone() });
                }
            }
            (ids, story_ids)
        }
        None => (Vec::new(), Vec::new()),
    };
    let instance = instance.to_string();
    transact(doc, &[si], move |doc, _| {
        expand_instance(doc, si, ii, &ids, &story_ids)?;
        Ok(Operation::BreakSymbolLink {
            instance,
            ids,
            story_ids,
        })
    })
}

pub(super) fn apply_delete_symbol(
    doc: &mut Document,
    symbol_id: &str,
) -> Result<AppliedOperation, OperationError> {
    if doc.symbol(symbol_id).is_none() {
        return Err(refused(
            NodeId::Document(String::new()),
            format!("the document has no symbol \"{symbol_id}\""),
        ));
    }
    let touched: Vec<usize> = doc
        .spreads
        .iter()
        .enumerate()
        .filter(|(_, p)| p.spread.instances.iter().any(|i| i.symbol == symbol_id))
        .map(|(si, _)| si)
        .collect();
    let symbol_id = symbol_id.to_string();
    transact(doc, &touched, move |doc, _| {
        while let Some((si, ii)) = doc.spreads.iter().enumerate().find_map(|(si, p)| {
            p.spread
                .instances
                .iter()
                .position(|i| i.symbol == symbol_id)
                .map(|ii| (si, ii))
        }) {
            let inst = doc.spreads[si].spread.instances[ii].clone();
            let def = doc.symbol(&symbol_id).expect("checked above");
            let (demand, _) = break_demand(def, &inst);
            let (ids, story_ids) = mint(doc, demand);
            expand_instance(doc, si, ii, &ids, &story_ids)?;
        }
        doc.symbols.retain(|d| d.id != symbol_id);
        Ok(Operation::DeleteSymbol { symbol_id })
    })
}

// ------------------------------------------------------------------ interchange

/// Engine ADR 1039 — the document label holding the symbol store when the
/// document travels as IDML (which has no symbols).
pub const SYMBOLS_LABEL: &str = "paged:symbols";
/// Engine ADR 1039 — the label each leaf of an expanded instance carries:
/// the instance it was, so a reopen in paged restores it.
pub const SYMBOL_INSTANCE_LABEL: &str = "paged:symbolInstance";

/// The leaves of the subtree at `r` (groups expanded, pasted-in children
/// included), by `Self`.
fn subtree_leaf_ids(spread: &Spread, r: FrameRef, out: &mut Vec<String>) {
    match r {
        FrameRef::Group(gi) => {
            if let Some(g) = spread.groups.get(gi) {
                for m in &g.members {
                    subtree_leaf_ids(spread, *m, out);
                }
            }
        }
        leaf => {
            if let Some(id) = ref_self_id(spread, leaf) {
                out.push(id.to_string());
                if let Some(children) = spread.nested_children.get(id) {
                    for c in children.clone() {
                        subtree_leaf_ids(spread, c, out);
                    }
                }
            }
        }
    }
}

/// Engine ADR 1039 — make `doc` IDML-shaped: every instance is broken into
/// its artwork (each leaf labelled with the instance it was) and the
/// symbol store rides the document label [`SYMBOLS_LABEL`]. Returns one
/// line per instance, for the export's loss report. The IDML export runs
/// this on its copy of the document; [`restore_symbols_from_labels`]
/// undoes it on reopen.
pub fn expand_symbols_for_interchange(doc: &mut Document) -> Vec<String> {
    let mut lines = Vec::new();
    let has_instances = doc.spreads.iter().any(|p| !p.spread.instances.is_empty());
    if doc.symbols.is_empty() && !has_instances {
        return lines;
    }
    doc.designmap.labels.retain(|(k, _)| k != SYMBOLS_LABEL);
    if !doc.symbols.is_empty() {
        doc.designmap.labels.push((
            SYMBOLS_LABEL.to_string(),
            serde_json::to_string(&doc.symbols).unwrap_or_default(),
        ));
    }
    for si in 0..doc.spreads.len() {
        while let Some(inst) = doc.spreads[si].spread.instances.first().cloned() {
            let id = inst.self_id.clone().unwrap_or_default();
            let Some(def) = doc.symbol(&inst.symbol).cloned() else {
                let spread = &mut doc.spreads[si].spread;
                spread.instances.remove(0);
                unregister_frame_ref(spread, FrameRef::Instance(0), 0);
                lines.push(format!(
                    "symbol instance `{id}` names a symbol the document lacks (`{}`) — it draws \
                     nothing and is not written",
                    inst.symbol
                ));
                continue;
            };
            let (demand, _) = break_demand(&def, &inst);
            let (ids, story_ids) = mint(doc, demand);
            let root = match expand_instance(doc, si, 0, &ids, &story_ids) {
                Ok(Some(r)) => r,
                _ => {
                    lines.push(format!(
                        "symbol instance `{id}` of \"{}\" has no artwork to write",
                        def.name
                    ));
                    continue;
                }
            };
            let record = serde_json::to_string(&inst).unwrap_or_default();
            let spread = &mut doc.spreads[si].spread;
            let mut leaves = Vec::new();
            subtree_leaf_ids(spread, root, &mut leaves);
            for leaf in leaves {
                let entries = spread.labels.entry(leaf).or_default();
                entries.retain(|(k, _)| k != SYMBOL_INSTANCE_LABEL);
                entries.push((SYMBOL_INSTANCE_LABEL.to_string(), record.clone()));
            }
            let mut extra = String::new();
            if inst.overrides.tint.is_some() {
                extra.push_str("; its tint is not drawn");
            }
            if inst.nine_slice.or(def.nine_slice).is_some() {
                extra.push_str("; its 9-slice scaling is drawn as a plain scale");
            }
            lines.push(format!(
                "symbol instance `{id}` of \"{}\" is written as its artwork — IDML has no \
                 symbols; the link is kept in a label and comes back when paged reopens the \
                 file{extra}",
                def.name
            ));
        }
    }
    lines.sort();
    lines
}

/// Engine ADR 1039 — the inverse of [`expand_symbols_for_interchange`] on
/// an opened IDML: the symbol store comes back from [`SYMBOLS_LABEL`], and
/// every group of leaves labelled with one instance is replaced by that
/// instance, in the z slot its artwork held. Leaves whose symbol is gone
/// stay ordinary items (their label is dropped). Returns how many
/// instances it restored.
pub fn restore_symbols_from_labels(doc: &mut Document) -> usize {
    if let Some(pos) = doc
        .designmap
        .labels
        .iter()
        .position(|(k, _)| k == SYMBOLS_LABEL)
    {
        let (_, json) = doc.designmap.labels.remove(pos);
        if doc.symbols.is_empty() {
            if let Ok(defs) = serde_json::from_str::<Vec<SymbolDefinition>>(&json) {
                doc.symbols = defs;
            }
        }
    }
    let mut restored = 0;
    for si in 0..doc.spreads.len() {
        loop {
            // The next instance this spread still carries as artwork.
            let next = {
                let spread = &doc.spreads[si].spread;
                let mut found: Option<(SymbolInstance, Vec<String>)> = None;
                let mut ids: Vec<&String> = spread.labels.keys().collect();
                ids.sort();
                for id in ids {
                    let Some((_, v)) = spread.labels[id]
                        .iter()
                        .find(|(k, _)| k == SYMBOL_INSTANCE_LABEL)
                    else {
                        continue;
                    };
                    let Ok(inst) = serde_json::from_str::<SymbolInstance>(v) else {
                        continue;
                    };
                    match &mut found {
                        None => found = Some((inst, vec![id.clone()])),
                        Some((f, leaves)) if f.self_id == inst.self_id => leaves.push(id.clone()),
                        Some(_) => {}
                    }
                }
                found
            };
            let Some((mut inst, leaves)) = next else {
                break;
            };
            let spread = &mut doc.spreads[si].spread;
            for leaf in &leaves {
                if let Some(entries) = spread.labels.get_mut(leaf) {
                    entries.retain(|(k, _)| k != SYMBOL_INSTANCE_LABEL);
                    if entries.is_empty() {
                        spread.labels.remove(leaf);
                    }
                }
            }
            if doc.symbol(&inst.symbol).is_none() {
                continue;
            }
            if restore_one(doc, si, &mut inst, &leaves) {
                restored += 1;
            }
        }
    }
    doc.rebuild_indexes();
    restored
}

/// Replace the leaves `leaves` (one expanded instance) by `inst`.
fn restore_one(
    doc: &mut Document,
    si: usize,
    inst: &mut SymbolInstance,
    leaves: &[String],
) -> bool {
    let (home, nodes, stories) = {
        let spread = &mut doc.spreads[si].spread;
        ensure_frames_in_order(spread);
        let refs: Vec<FrameRef> = leaves
            .iter()
            .filter_map(|id| leaf_or_text(spread, id))
            .collect();
        let Some(first) = refs.first().copied() else {
            return false;
        };
        // The expansion's root: climb from the first leaf while the group
        // above holds only this instance's leaves.
        let leaf_set: HashSet<&str> = leaves.iter().map(String::as_str).collect();
        let mut root = first;
        while let Some(RefHome::Group(gi, _)) = ref_home(spread, root) {
            let mut inner = Vec::new();
            subtree_leaf_ids(spread, FrameRef::Group(gi), &mut inner);
            if inner.iter().all(|l| leaf_set.contains(l.as_str())) {
                root = FrameRef::Group(gi);
            } else {
                break;
            }
        }
        let home = ref_home(spread, root);
        let stories: Vec<String> = refs
            .iter()
            .filter_map(|r| match r {
                FrameRef::TextFrame(i) => spread.text_frames[*i].parent_story.clone(),
                _ => None,
            })
            .collect();
        let mut nodes = Vec::new();
        removal_leaves(spread, root, &mut nodes);
        // Every labelled leaf goes, whether or not the root held it.
        for r in &refs {
            let n = super::duplicate_nodes::node_for(spread, *r);
            if !nodes.contains(&n) {
                nodes.push(n);
            }
        }
        // Seat the instance in the root's slot.
        let idx = spread.instances.len();
        inst.bounds = Bounds::ZERO;
        spread.instances.push(inst.clone());
        let r = FrameRef::Instance(idx);
        match &home {
            Some(RefHome::Group(gi, i)) => spread.groups[*gi].members.insert(*i, r),
            Some(RefHome::Root(i)) => spread.frames_in_order.insert(*i, r),
            _ => spread.frames_in_order.push(r),
        }
        (home, nodes, stories)
    };
    let _ = home;
    for node in nodes.into_iter().rev() {
        let _ = super::apply_inner(doc, &Operation::RemoveNode { node });
    }
    doc.stories.retain(|s| !stories.contains(&s.self_id));
    true
}

fn leaf_or_text(spread: &Spread, id: &str) -> Option<FrameRef> {
    spread
        .text_frames
        .iter()
        .position(|f| f.self_id.as_deref() == Some(id))
        .map(FrameRef::TextFrame)
        .or_else(|| leaf_ref(spread, id))
}
