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

//! A structural-integrity check over a scene [`Document`]: every id names
//! one thing, and every reference names something the document holds.
//!
//! It is a helper, shared by the sweeps that replay the whole mutation
//! vocabulary (`render_effect_sweep`): an operation, its undo and its redo
//! must each leave the document as sound as they found it. The result is
//! a SET of findings rather than an assertion, so a caller compares the
//! state after an edit with the state before it and reports what the edit
//! broke, not what the fixture already carried.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use paged_model::{FrameRef, Spread};
use paged_scene::Document;

/// Whether a `NextTextFrame`-style value names a frame (`n` and the empty
/// string are IDML's "none").
fn names_a_frame(link: &str) -> bool {
    !link.is_empty() && link != "n"
}

/// The ids of a spread's pages and page items, with what each one is.
fn spread_ids<'a>(spread: &'a Spread) -> Vec<(&'static str, &'a str)> {
    let mut out: Vec<(&'static str, &'a str)> = Vec::new();
    let mut push = |kind: &'static str, id: Option<&'a str>| {
        if let Some(id) = id {
            out.push((kind, id));
        }
    };
    push("spread", spread.self_id.as_deref());
    for p in &spread.pages {
        push("page", p.self_id.as_deref());
    }
    for f in &spread.text_frames {
        push("text frame", f.self_id.as_deref());
    }
    for f in &spread.rectangles {
        push("rectangle", f.self_id.as_deref());
    }
    for f in &spread.ovals {
        push("oval", f.self_id.as_deref());
    }
    for f in &spread.graphic_lines {
        push("line", f.self_id.as_deref());
    }
    for f in &spread.polygons {
        push("polygon", f.self_id.as_deref());
    }
    for f in &spread.groups {
        push("group", f.self_id.as_deref());
    }
    for f in &spread.instances {
        push("instance", f.self_id.as_deref());
    }
    out
}

fn in_range(spread: &Spread, r: FrameRef) -> bool {
    match r {
        FrameRef::TextFrame(i) => i < spread.text_frames.len(),
        FrameRef::Rectangle(i) => i < spread.rectangles.len(),
        FrameRef::Oval(i) => i < spread.ovals.len(),
        FrameRef::GraphicLine(i) => i < spread.graphic_lines.len(),
        FrameRef::Polygon(i) => i < spread.polygons.len(),
        FrameRef::Group(i) => i < spread.groups.len(),
        FrameRef::Instance(i) => i < spread.instances.len(),
    }
}

/// The references inside one spread: its z-order and group members index
/// items that exist, each at most once; its id-keyed side maps name items
/// of the spread; its items name layers, stories, symbols and thread
/// targets the document holds.
fn check_spread(
    doc: &Document,
    whose: &str,
    spread: &Spread,
    frames: &HashSet<&str>,
    out: &mut BTreeSet<String>,
) {
    let own: HashSet<&str> = spread_ids(spread).into_iter().map(|(_, id)| id).collect();
    let stories: HashSet<&str> = doc.stories.iter().map(|s| s.self_id.as_str()).collect();
    let layers: HashSet<&str> = doc
        .designmap
        .layers
        .iter()
        .map(|l| l.self_id.as_str())
        .collect();

    // The z-order and the groups: indices in range, no item listed twice.
    let mut listed: BTreeMap<String, usize> = BTreeMap::new();
    let lists = std::iter::once(("the z-order".to_string(), &spread.frames_in_order)).chain(
        spread.groups.iter().enumerate().map(|(i, g)| {
            (
                format!(
                    "group {}",
                    g.self_id.clone().unwrap_or_else(|| format!("#{i}"))
                ),
                &g.members,
            )
        }),
    );
    for (list, refs) in lists {
        for r in refs {
            if !in_range(spread, *r) {
                out.insert(format!(
                    "{whose}: {list} lists {r:?}, which is out of range"
                ));
            }
            *listed.entry(format!("{r:?}")).or_default() += 1;
        }
    }
    for (r, n) in listed {
        if n > 1 {
            out.insert(format!(
                "{whose}: {r} is listed {n} times in the z-order and groups"
            ));
        }
    }
    for (host, children) in &spread.nested_children {
        if !own.contains(host.as_str()) {
            out.insert(format!(
                "{whose}: pasted-in content hangs on {host}, which is not an item of the spread"
            ));
        }
        for r in children {
            if !in_range(spread, *r) {
                out.insert(format!(
                    "{whose}: {host} holds pasted-in {r:?}, which is out of range"
                ));
            }
        }
    }
    for (target, mask) in &spread.opacity_masks {
        if !own.contains(target.as_str()) {
            out.insert(format!(
                "{whose}: an opacity mask hangs on {target}, which is not an item of the spread"
            ));
        }
        if !own.contains(mask.mask_item.as_str()) {
            out.insert(format!(
                "{whose}: {target}'s opacity mask is {}, which is not an item of the spread",
                mask.mask_item
            ));
        }
    }

    let mut layer = |id: Option<&str>, layer: Option<&str>| {
        if let Some(layer) = layer {
            if !layers.contains(layer) {
                out.insert(format!(
                    "{whose}: {} is on layer {layer}, which the document does not hold",
                    id.unwrap_or("an item")
                ));
            }
        }
    };
    for f in &spread.text_frames {
        layer(f.self_id.as_deref(), f.item_layer.as_deref());
    }
    for f in &spread.rectangles {
        layer(f.self_id.as_deref(), f.item_layer.as_deref());
    }
    for f in &spread.ovals {
        layer(f.self_id.as_deref(), f.item_layer.as_deref());
    }
    for f in &spread.graphic_lines {
        layer(f.self_id.as_deref(), f.item_layer.as_deref());
    }
    for f in &spread.polygons {
        layer(f.self_id.as_deref(), f.item_layer.as_deref());
    }
    for f in &spread.instances {
        layer(f.self_id.as_deref(), f.item_layer.as_deref());
    }

    for f in &spread.text_frames {
        let id = f.self_id.as_deref().unwrap_or("a text frame");
        if let Some(story) = f.parent_story.as_deref() {
            if !stories.contains(story) {
                out.insert(format!(
                    "{whose}: text frame {id} is on story {story}, which the document does not hold"
                ));
            }
        }
        if let Some(next) = f.next_text_frame.as_deref().filter(|n| names_a_frame(n)) {
            if !frames.contains(next) {
                out.insert(format!(
                    "{whose}: text frame {id} threads to {next}, which is not a text frame"
                ));
            }
        }
    }
    for i in &spread.instances {
        if doc.symbol(&i.symbol).is_none() {
            out.insert(format!(
                "{whose}: instance {} draws symbol {}, which the document does not hold",
                i.self_id.as_deref().unwrap_or("?"),
                i.symbol
            ));
        }
    }
    for p in &spread.pages {
        if let Some(master) = p.applied_master.as_deref().filter(|m| names_a_frame(m)) {
            if doc.master_spread(master).is_none() {
                out.insert(format!(
                    "{whose}: page {} applies master {master}, which the document does not hold",
                    p.self_id.as_deref().unwrap_or("?")
                ));
            }
        }
    }
}

/// Everything unsound about `doc`, one line each; empty for a sound
/// document. Unique ids across the spreads and masters (one number line,
/// `paged_mutate::ids`), the stories, the layers and the symbols; no
/// reference to something the document does not hold.
pub fn issues(doc: &Document) -> BTreeSet<String> {
    let mut out = BTreeSet::new();

    // Masters in a fixed order, so the findings read the same every run.
    let mut masters: Vec<_> = doc.master_spreads.iter().collect();
    masters.sort_by(|a, b| a.0.cmp(b.0));
    let spreads: Vec<(String, &Spread)> = doc
        .spreads
        .iter()
        .enumerate()
        .map(|(i, s)| {
            (
                format!(
                    "spread {}",
                    s.spread.self_id.clone().unwrap_or_else(|| format!("#{i}"))
                ),
                &s.spread,
            )
        })
        .chain(
            masters
                .iter()
                .map(|(id, m)| (format!("master {id}"), &m.spread)),
        )
        .collect();

    let mut holders: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for (whose, spread) in &spreads {
        for (kind, id) in spread_ids(spread) {
            holders
                .entry(id)
                .or_default()
                .push(format!("{kind} on {whose}"));
        }
    }
    for (id, held) in &holders {
        if held.len() > 1 {
            out.insert(format!("id {id} names {}", held.join(" and ")));
        }
    }
    let mut once = |what: &str, ids: Vec<&str>| {
        let mut seen = HashSet::new();
        for id in ids {
            if !seen.insert(id) {
                out.insert(format!("{what} id {id} is in the document more than once"));
            }
        }
    };
    once(
        "story",
        doc.stories.iter().map(|s| s.self_id.as_str()).collect(),
    );
    once(
        "layer",
        doc.designmap
            .layers
            .iter()
            .map(|l| l.self_id.as_str())
            .collect(),
    );
    once(
        "symbol",
        doc.symbols.iter().map(|s| s.id.as_str()).collect(),
    );

    let frames: HashSet<&str> = spreads
        .iter()
        .flat_map(|(_, s)| s.text_frames.iter())
        .filter_map(|f| f.self_id.as_deref())
        .collect();
    for (whose, spread) in &spreads {
        check_spread(doc, whose, spread, &frames, &mut out);
    }
    out
}
