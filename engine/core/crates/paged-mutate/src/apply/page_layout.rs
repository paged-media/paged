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

//! Engine ADR 1312 — the document's pages laid out again as facing spreads
//! or single pages: Document Setup's Facing Pages on an existing document,
//! and the pairs a page inserted into or removed from a facing document
//! keeps.
//!
//! A spread is cut into one unit per page (the page, every page item that
//! sits on it, with its group members, pasted-in children and mask items,
//! and every side map entry keyed by those ids or the page's); the units
//! are joined again in page order into InDesign's spreads — page 1 alone on
//! the right of the spine, then left/right pairs (mirrored for a
//! right-to-left binding) — or one page per spread; each page moves to its
//! side of the spine and its items move with it by the same offset, so
//! nothing changes on the page. The spreads stack down the pasteboard.
//!
//! The undo of every such change is [`apply_restore_spreads`]: the spreads
//! from the first one touched, captured whole, put back verbatim, so undo
//! and redo are exact.

use std::collections::{HashMap, HashSet};

use paged_model::{Bounds, FrameRef, Spread};
use paged_scene::{Document, ParsedSpread};

use crate::error::OperationError;
use crate::operation::{AppliedOperation, InvalidationHint, NodeId, Operation, PropertyPath};

use super::batch_page::{spread_extent, SPREAD_STACK_GAP_PT};
use super::duplicate_nodes::{ref_self_id, translated};
use super::insert_node::ensure_frames_in_order;

/// The spreads from `first` on, captured for [`Operation::RestoreSpreads`],
/// and the document's facing flag when the change set it.
#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct SpreadsCapture {
    pub(super) spreads: Vec<ParsedSpread>,
    /// Whether the capture puts the facing flag back.
    #[serde(default)]
    pub(super) restore_facing: bool,
    #[serde(default)]
    pub(super) facing_pages: Option<bool>,
}

fn invalid(reason: impl Into<String>) -> OperationError {
    OperationError::InvalidValue {
        node: NodeId::Page(String::new()),
        path: PropertyPath::PageBounds,
        reason: reason.into(),
    }
}

/// Capture `doc.spreads[first..]` (and the facing flag when asked) as the
/// JSON a [`Operation::RestoreSpreads`] carries.
pub(super) fn capture(
    doc: &Document,
    first: usize,
    restore_facing: bool,
) -> Result<String, OperationError> {
    let capture = SpreadsCapture {
        spreads: doc.spreads[first.min(doc.spreads.len())..].to_vec(),
        restore_facing,
        facing_pages: doc.designmap.document_preference.facing_pages,
    };
    serde_json::to_string(&capture).map_err(|e| invalid(format!("spread capture failed: {e}")))
}

/// `RestoreSpreads` — replace the spreads from `first` on with the captured
/// ones (and the facing flag when the capture carries it). Its inverse is
/// itself, carrying what it replaced.
pub(super) fn apply_restore_spreads(
    doc: &mut Document,
    first: usize,
    capture_json: &str,
) -> Result<AppliedOperation, OperationError> {
    let restore: SpreadsCapture = serde_json::from_str(capture_json)
        .map_err(|e| invalid(format!("malformed spread capture: {e}")))?;
    if first > doc.spreads.len() {
        return Err(invalid("RestoreSpreads starts past the last spread"));
    }
    let current = capture(doc, first, restore.restore_facing)?;
    doc.spreads.truncate(first);
    doc.spreads.extend(restore.spreads);
    if restore.restore_facing {
        doc.designmap.document_preference.facing_pages = restore.facing_pages;
    }
    Ok(AppliedOperation {
        op: Operation::RestoreSpreads {
            first,
            capture_json: capture_json.to_string(),
        },
        inverse: Operation::RestoreSpreads {
            first,
            capture_json: current,
        },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

/// `SetFacingPages` — lay every page out as facing spreads or single pages
/// and record the choice in the document's preferences. One undo step.
pub(super) fn apply_set_facing_pages(
    doc: &mut Document,
    facing: bool,
) -> Result<AppliedOperation, OperationError> {
    if doc.spreads.is_empty() {
        return Err(invalid("the document has no pages to lay out"));
    }
    let prior = capture(doc, 0, true)?;
    relayout(doc, 0, facing, |_| true, None);
    doc.designmap.document_preference.facing_pages = Some(facing);
    Ok(AppliedOperation {
        op: Operation::SetFacingPages { facing },
        inverse: Operation::RestoreSpreads {
            first: 0,
            capture_json: prior,
        },
        invalidation: InvalidationHint {
            structural: true,
            ..Default::default()
        },
    })
}

/// Whether the document lays its pages out in facing spreads, as its
/// preferences say. Only an explicit `FacingPages="true"` counts here, so a
/// document that never said keeps one spread per inserted page.
pub(super) fn is_facing(doc: &Document) -> bool {
    doc.designmap.document_preference.facing_pages == Some(true)
}

/// The spread a re-pairing starts at so that the pages before it keep
/// theirs: the spread of `page_index`'s page (or the last one), stepped
/// back while the pages before it end on a right-hand page of an open pair
/// (an even count above zero).
pub(super) fn repair_start(doc: &Document, spread_index: usize) -> usize {
    let mut first = spread_index.min(doc.spreads.len().saturating_sub(1));
    loop {
        let before: usize = doc.spreads[..first]
            .iter()
            .map(|p| p.spread.pages.len())
            .sum();
        if first == 0 || !before.is_multiple_of(2) {
            return first;
        }
        first -= 1;
    }
}

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

/// One page out of its spread: a spread holding that page alone, and
/// whether the page was alone in its spread before.
struct Unit {
    spread: Spread,
    alone: bool,
}

/// Lay out the pages of `doc.spreads[first..]` again — facing or single —
/// keeping the units `keep` accepts (a page `RemovePage` drops is refused
/// by it). The spreads keep their ids in order; a spread more than before
/// takes a fresh id. The spreads from `first` on stack down the pasteboard
/// below the one before.
pub(super) fn relayout(
    doc: &mut Document,
    first: usize,
    facing: bool,
    mut keep: impl FnMut(&str) -> bool,
    place_after: Option<(&str, &str)>,
) {
    let rtl = doc.designmap.document_preference.page_binding.as_deref() == Some("RightToLeft");
    let pages_before: usize = doc.spreads[..first]
        .iter()
        .map(|p| p.spread.pages.len())
        .sum();
    let stack_top = if first > 0 {
        let (top, height) = spread_extent(&doc.spreads[first - 1].spread);
        Some(top + height + SPREAD_STACK_GAP_PT)
    } else {
        None
    };
    let mut next_id = id_floor(doc);
    let old: Vec<ParsedSpread> = doc.spreads.drain(first..).collect();
    let first_top = old.first().map(|p| spread_extent(&p.spread).0);
    let pool: Vec<(Option<String>, String)> = old
        .iter()
        .map(|p| (p.spread.self_id.clone(), p.src.clone()))
        .collect();

    let mut units: Vec<Unit> = Vec::new();
    for parsed in old {
        let alone = parsed.spread.pages.len() == 1;
        for spread in split(parsed.spread) {
            let page_id = spread
                .pages
                .first()
                .and_then(|p| p.self_id.clone())
                .unwrap_or_default();
            if keep(&page_id) {
                units.push(Unit { spread, alone });
            }
        }
    }

    // A page inserted after a page goes right after it, inside its spread
    // if need be (InsertPage put it after the whole spread).
    if let Some((page, after)) = place_after {
        let unit_page = |u: &Unit| u.spread.pages.first().and_then(|p| p.self_id.clone());
        if let Some(from) = units
            .iter()
            .position(|u| unit_page(u).as_deref() == Some(page))
        {
            let unit = units.remove(from);
            let to = units
                .iter()
                .position(|u| unit_page(u).as_deref() == Some(after))
                .map_or(units.len(), |i| i + 1);
            units.insert(to, unit);
        }
    }

    // Group the units into spreads by their page's index in the document.
    let mut groups: Vec<Vec<Unit>> = Vec::new();
    for (k, unit) in units.into_iter().enumerate() {
        let index = pages_before + k;
        let opens = !facing || index == 0 || !index.is_multiple_of(2);
        if opens || groups.is_empty() {
            groups.push(vec![unit]);
        } else {
            groups.last_mut().expect("pushed above").push(unit);
        }
    }

    let mut cursor = stack_top.or(first_top).unwrap_or(0.0);
    for (j, group) in groups.into_iter().enumerate() {
        let index_of_first = pages_before
            + doc.spreads[first..]
                .iter()
                .map(|p| p.spread.pages.len())
                .sum::<usize>();
        let group_top = group
            .first()
            .and_then(|u| u.spread.pages.first())
            .map(|p| page_rect(p).top)
            .unwrap_or(0.0);
        let mut merged: Option<Spread> = None;
        let joined = group.len() > 1;
        for (slot, mut unit) in group.into_iter().enumerate() {
            let index = index_of_first + slot;
            let Some(page) = unit.spread.pages.first() else {
                continue;
            };
            let rect = page_rect(page);
            let width = rect.right - rect.left;
            let left = if facing {
                // A right-hand page (recto) starts at the spine; a
                // left-hand page ends at it. Page 1 is a recto, then each
                // spread a verso and a recto; a right-to-left binding
                // mirrors both.
                let recto = index.is_multiple_of(2);
                if recto != rtl {
                    0.0
                } else {
                    -width
                }
            } else if unit.alone && rect.left + width / 2.0 >= -0.5 {
                // A single page that already binds on its left stays.
                rect.left
            } else {
                0.0
            };
            let (dx, dy) = (left - rect.left, group_top - rect.top);
            move_unit(&mut unit.spread, dx, dy);
            if joined {
                ensure_frames_in_order(&mut unit.spread);
            }
            match merged.as_mut() {
                None => merged = Some(unit.spread),
                Some(dst) => append(dst, unit.spread),
            }
        }
        let Some(mut spread) = merged else { continue };
        let (self_id, src) = match pool.get(j) {
            Some((Some(id), src)) => (id.clone(), src.clone()),
            _ => {
                next_id += 1;
                let id = format!("u{next_id:x}");
                let src = format!("Spreads/Spread_{id}.xml");
                (id, src)
            }
        };
        spread.self_id = Some(self_id);
        // Down the pasteboard: this spread's top where the last one ended.
        let mut m = spread
            .item_transform
            .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        let (top, height) = spread_extent(&spread);
        m[5] += cursor - top;
        spread.item_transform = Some(m);
        cursor += height + SPREAD_STACK_GAP_PT;
        doc.spreads.push(ParsedSpread { src, spread });
    }
}

/// The largest `u<hex>` id among the spreads and their pages and items, so
/// a spread the layout adds takes an id nothing holds.
fn id_floor(doc: &Document) -> u64 {
    let mut max: u64 = 0;
    let mut scan = |id: Option<&str>| {
        let Some(hex) = id.and_then(|id| id.strip_prefix('u')) else {
            return;
        };
        if hex.is_empty() || hex.len() > 12 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return;
        }
        if let Ok(v) = u64::from_str_radix(hex, 16) {
            max = max.max(v);
        }
    };
    for parsed in &doc.spreads {
        let s = &parsed.spread;
        scan(s.self_id.as_deref());
        for p in &s.pages {
            scan(p.self_id.as_deref());
        }
        for r in all_refs(s) {
            scan(ref_self_id(s, r));
        }
    }
    max
}

/// A page's box on its spread.
fn page_rect(p: &paged_model::Page) -> Bounds {
    transform_box(p.bounds, p.item_transform)
}

/// The axis-aligned box of `b` through `m`.
fn transform_box(b: Bounds, m: Option<[f32; 6]>) -> Bounds {
    let Some([a, bb, c, d, e, f]) = m else {
        return b;
    };
    let corners = [
        (b.left, b.top),
        (b.right, b.top),
        (b.left, b.bottom),
        (b.right, b.bottom),
    ];
    let mut out = Bounds {
        top: f32::MAX,
        left: f32::MAX,
        bottom: f32::MIN,
        right: f32::MIN,
    };
    for (x, y) in corners {
        let (px, py) = (a * x + c * y + e, bb * x + d * y + f);
        out.left = out.left.min(px);
        out.right = out.right.max(px);
        out.top = out.top.min(py);
        out.bottom = out.bottom.max(py);
    }
    out
}

/// Every page item of a spread, kind by kind.
fn all_refs(s: &Spread) -> Vec<FrameRef> {
    let mut v = Vec::new();
    v.extend((0..s.text_frames.len()).map(FrameRef::TextFrame));
    v.extend((0..s.rectangles.len()).map(FrameRef::Rectangle));
    v.extend((0..s.ovals.len()).map(FrameRef::Oval));
    v.extend((0..s.graphic_lines.len()).map(FrameRef::GraphicLine));
    v.extend((0..s.polygons.len()).map(FrameRef::Polygon));
    v.extend((0..s.groups.len()).map(FrameRef::Group));
    v.extend((0..s.instances.len()).map(FrameRef::Instance));
    v
}

/// The ref of the item with `Self` id `id`.
fn ref_by_id(s: &Spread, id: &str) -> Option<FrameRef> {
    all_refs(s)
        .into_iter()
        .find(|r| ref_self_id(s, *r) == Some(id))
}

/// The refs a ref brings with it: its group's members, its pasted-in
/// children and its mask item, recursively.
fn inner_refs(s: &Spread, r: FrameRef, out: &mut Vec<FrameRef>, depth: usize) {
    if depth > 64 {
        return;
    }
    let push = |c: FrameRef, out: &mut Vec<FrameRef>| {
        if !out.contains(&c) {
            out.push(c);
            inner_refs(s, c, out, depth + 1);
        }
    };
    if let FrameRef::Group(g) = r {
        if let Some(group) = s.groups.get(g) {
            for m in &group.members {
                push(*m, out);
            }
        }
    }
    if let Some(id) = ref_self_id(s, r) {
        if let Some(children) = s.nested_children.get(id) {
            for c in children {
                push(*c, out);
            }
        }
        if let Some(mask) = s.opacity_masks.get(id) {
            if let Some(m) = ref_by_id(s, &mask.mask_item) {
                push(m, out);
            }
        }
    }
}

/// The box of a page item on its spread (a group's: its members').
fn ref_box(s: &Spread, r: FrameRef, depth: usize) -> Option<Bounds> {
    let leaf = |b: Bounds, m: Option<[f32; 6]>| Some(transform_box(b, m));
    match r {
        FrameRef::TextFrame(i) => s
            .text_frames
            .get(i)
            .and_then(|f| leaf(f.bounds, f.item_transform)),
        FrameRef::Rectangle(i) => s
            .rectangles
            .get(i)
            .and_then(|f| leaf(f.bounds, f.item_transform)),
        FrameRef::Oval(i) => s
            .ovals
            .get(i)
            .and_then(|f| leaf(f.bounds, f.item_transform)),
        FrameRef::GraphicLine(i) => s
            .graphic_lines
            .get(i)
            .and_then(|f| leaf(f.bounds, f.item_transform)),
        FrameRef::Polygon(i) => s
            .polygons
            .get(i)
            .and_then(|f| leaf(f.bounds, f.item_transform)),
        FrameRef::Instance(i) => s
            .instances
            .get(i)
            .and_then(|f| leaf(f.bounds, Some(f.item_transform))),
        FrameRef::Group(g) => {
            if depth > 64 {
                return None;
            }
            let group = s.groups.get(g)?;
            group
                .members
                .iter()
                .filter_map(|m| ref_box(s, *m, depth + 1))
                .reduce(|a, b| Bounds {
                    top: a.top.min(b.top),
                    left: a.left.min(b.left),
                    bottom: a.bottom.max(b.bottom),
                    right: a.right.max(b.right),
                })
        }
    }
}

/// The page of a spread a point belongs to: the one holding it, else the
/// nearest (an item on the pasteboard goes with the page beside it).
fn page_at(pages: &[Bounds], x: f32, y: f32) -> usize {
    let distance = |b: &Bounds| {
        let dx = (b.left - x).max(0.0).max(x - b.right);
        let dy = (b.top - y).max(0.0).max(y - b.bottom);
        dx * dx + dy * dy
    };
    pages
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| distance(a).total_cmp(&distance(b)))
        .map_or(0, |(i, _)| i)
}

/// Cut a spread into one spread per page. A spread of one page is its own
/// unit, untouched.
fn split(mut s: Spread) -> Vec<Spread> {
    let n = s.pages.len();
    if n <= 1 {
        return vec![s];
    }
    ensure_frames_in_order(&mut s);
    let pages: Vec<Bounds> = s.pages.iter().map(page_rect).collect();

    // Which page owns each item: an item no other item brings with it (a
    // root) goes to the page under its centre, and brings its inner items.
    let refs = all_refs(&s);
    let mut inner: HashSet<FrameRef> = HashSet::new();
    for r in &refs {
        let mut v = Vec::new();
        inner_refs(&s, *r, &mut v, 0);
        inner.extend(v);
    }
    let mut owner: HashMap<FrameRef, usize> = HashMap::new();
    for r in refs.iter().filter(|r| !inner.contains(r)) {
        let p = ref_box(&s, *r, 0).map_or(0, |b| {
            page_at(&pages, (b.left + b.right) * 0.5, (b.top + b.bottom) * 0.5)
        });
        owner.insert(*r, p);
        let mut v = Vec::new();
        inner_refs(&s, *r, &mut v, 0);
        for c in v {
            owner.entry(c).or_insert(p);
        }
    }
    // An item only a cycle reaches (malformed input) stays on the first page.
    for r in &refs {
        owner.entry(*r).or_insert(0);
    }

    // The ids each page takes: its own and its items'.
    let mut id_page: HashMap<String, usize> = HashMap::new();
    for (i, p) in s.pages.iter().enumerate() {
        if let Some(id) = &p.self_id {
            id_page.insert(id.clone(), i);
        }
    }
    for r in &refs {
        if let Some(id) = ref_self_id(&s, *r) {
            id_page.insert(id.to_string(), owner[r]);
        }
    }
    let page_of_id = |id: &str| id_page.get(id).copied().unwrap_or(0);

    let mut out: Vec<Spread> = (0..n)
        .map(|i| Spread {
            self_id: s.self_id.clone(),
            item_transform: s.item_transform,
            pages: vec![s.pages[i].clone()],
            skipped_nested_frames: if i == 0 { s.skipped_nested_frames } else { 0 },
            ..Spread::default()
        })
        .collect();

    // The items, kind by kind in their order, and the map of old refs to
    // new ones.
    let mut remap: HashMap<FrameRef, FrameRef> = HashMap::new();
    macro_rules! move_kind {
        ($field:ident, $variant:ident) => {
            for (i, item) in std::mem::take(&mut s.$field).into_iter().enumerate() {
                let old = FrameRef::$variant(i);
                let p = owner.get(&old).copied().unwrap_or(0);
                let dst = &mut out[p];
                remap.insert(old, FrameRef::$variant(dst.$field.len()));
                dst.$field.push(item);
            }
        };
    }
    move_kind!(text_frames, TextFrame);
    move_kind!(rectangles, Rectangle);
    move_kind!(ovals, Oval);
    move_kind!(graphic_lines, GraphicLine);
    move_kind!(polygons, Polygon);
    move_kind!(instances, Instance);
    for (i, mut group) in std::mem::take(&mut s.groups).into_iter().enumerate() {
        let old = FrameRef::Group(i);
        let p = owner.get(&old).copied().unwrap_or(0);
        remap.insert(old, FrameRef::Group(out[p].groups.len()));
        // Members are remapped once every group has its new index.
        group
            .members
            .retain(|m| owner.get(m).copied().unwrap_or(0) == p);
        out[p].groups.push(group);
    }
    let map = |r: &FrameRef| remap.get(r).copied();
    for unit in out.iter_mut() {
        for group in unit.groups.iter_mut() {
            group.members = group.members.iter().filter_map(map).collect();
        }
    }
    for r in &s.frames_in_order {
        let p = owner.get(r).copied().unwrap_or(0);
        if let Some(new) = map(r) {
            out[p].frames_in_order.push(new);
        }
    }
    for (host, children) in std::mem::take(&mut s.nested_children) {
        let p = page_of_id(&host);
        let kept: Vec<FrameRef> = children
            .iter()
            .filter(|c| owner.get(c).copied().unwrap_or(0) == p)
            .filter_map(map)
            .collect();
        out[p].nested_children.insert(host, kept);
    }
    for (id, mask) in std::mem::take(&mut s.opacity_masks) {
        out[page_of_id(&id)].opacity_masks.insert(id, mask);
    }
    for (id, meta) in std::mem::take(&mut s.image_metadata) {
        out[page_of_id(&id)].image_metadata.insert(id, meta);
    }
    for (id, labels) in std::mem::take(&mut s.labels) {
        out[page_of_id(&id)].labels.insert(id, labels);
    }
    for (id, name) in std::mem::take(&mut s.item_names) {
        out[page_of_id(&id)].item_names.insert(id, name);
    }
    for (id, margins) in std::mem::take(&mut s.page_margins) {
        out[page_of_id(&id)].page_margins.insert(id, margins);
    }
    for id in std::mem::take(&mut s.endnote_frames) {
        out[page_of_id(&id)].endnote_frames.push(id);
    }
    for mut guide in std::mem::take(&mut s.guides) {
        let p = (guide.page_index as usize).min(n - 1);
        guide.page_index = 0;
        out[p].guides.push(guide);
    }
    out
}

/// Append `src`'s pages and items to `dst`, every index shifted past what
/// `dst` holds.
fn append(dst: &mut Spread, mut src: Spread) {
    let base = (
        dst.text_frames.len(),
        dst.rectangles.len(),
        dst.ovals.len(),
        dst.graphic_lines.len(),
        dst.polygons.len(),
        dst.groups.len(),
        dst.instances.len(),
    );
    let shift = |r: FrameRef| match r {
        FrameRef::TextFrame(i) => FrameRef::TextFrame(i + base.0),
        FrameRef::Rectangle(i) => FrameRef::Rectangle(i + base.1),
        FrameRef::Oval(i) => FrameRef::Oval(i + base.2),
        FrameRef::GraphicLine(i) => FrameRef::GraphicLine(i + base.3),
        FrameRef::Polygon(i) => FrameRef::Polygon(i + base.4),
        FrameRef::Group(i) => FrameRef::Group(i + base.5),
        FrameRef::Instance(i) => FrameRef::Instance(i + base.6),
    };
    let page_base = dst.pages.len() as u32;
    dst.pages.append(&mut src.pages);
    dst.text_frames.append(&mut src.text_frames);
    dst.rectangles.append(&mut src.rectangles);
    dst.ovals.append(&mut src.ovals);
    dst.graphic_lines.append(&mut src.graphic_lines);
    dst.polygons.append(&mut src.polygons);
    dst.instances.append(&mut src.instances);
    for mut group in src.groups {
        group.members = group.members.into_iter().map(shift).collect();
        dst.groups.push(group);
    }
    dst.frames_in_order
        .extend(src.frames_in_order.into_iter().map(shift));
    for (host, children) in src.nested_children {
        dst.nested_children
            .insert(host, children.into_iter().map(shift).collect());
    }
    dst.opacity_masks.extend(src.opacity_masks);
    dst.image_metadata.extend(src.image_metadata);
    dst.labels.extend(src.labels);
    dst.item_names.extend(src.item_names);
    dst.page_margins.extend(src.page_margins);
    dst.endnote_frames.append(&mut src.endnote_frames);
    for mut guide in src.guides {
        guide.page_index += page_base;
        dst.guides.push(guide);
    }
    dst.skipped_nested_frames += src.skipped_nested_frames;
}

/// Move a one-page unit by `(dx, dy)` on its spread: the page and every
/// item on it. Items keep their place on the page.
fn move_unit(s: &mut Spread, dx: f32, dy: f32) {
    if dx == 0.0 && dy == 0.0 {
        return;
    }
    for p in &mut s.pages {
        p.item_transform = translated(p.item_transform, dx, dy);
    }
    for f in &mut s.text_frames {
        f.item_transform = translated(f.item_transform, dx, dy);
    }
    for f in &mut s.rectangles {
        f.item_transform = translated(f.item_transform, dx, dy);
    }
    for f in &mut s.ovals {
        f.item_transform = translated(f.item_transform, dx, dy);
    }
    for f in &mut s.graphic_lines {
        f.item_transform = translated(f.item_transform, dx, dy);
    }
    for f in &mut s.polygons {
        f.item_transform = translated(f.item_transform, dx, dy);
    }
    for g in &mut s.groups {
        g.item_transform = translated(g.item_transform, dx, dy);
    }
    for i in &mut s.instances {
        i.item_transform[4] += dx;
        i.item_transform[5] += dy;
    }
}
