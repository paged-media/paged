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

//! Removing a threaded text frame closes the thread around it: the frame
//! before it links to the frame after it, no frame is left naming an id
//! the document does not hold, and the undo puts the chain back exactly.

use paged_model::{Bounds, FrameRef, Spread, Story};
use paged_mutate::{apply, NodeId, Operation};
use paged_scene::{Document, ParsedSpread, ParsedStory};

/// Three frames on one story, threaded `a → b → c`.
fn chain() -> Document {
    let mut spread = Spread {
        self_id: Some("s1".into()),
        ..Default::default()
    };
    spread.pages.push(paged_model::Page::new(
        "p1",
        Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 792.0,
            right: 612.0,
        },
    ));
    for (i, (id, next)) in [("a", Some("b")), ("b", Some("c")), ("c", None)]
        .into_iter()
        .enumerate()
    {
        let top = 36.0 + 120.0 * i as f32;
        let mut frame = paged_model::TextFrame::new(
            id,
            Some("Story/u1".into()),
            Bounds {
                top,
                left: 36.0,
                bottom: top + 100.0,
                right: 300.0,
            },
        );
        frame.next_text_frame = next.map(str::to_string);
        spread.text_frames.push(frame);
        spread.frames_in_order.push(FrameRef::TextFrame(i));
    }
    let mut doc = Document {
        spreads: vec![ParsedSpread {
            src: "Spreads/Spread_s1.xml".into(),
            spread,
        }],
        stories: vec![ParsedStory {
            src: "Stories/Story_u1.xml".into(),
            self_id: "Story/u1".into(),
            story: Story::default(),
        }],
        ..Default::default()
    };
    doc.rebuild_indexes();
    doc
}

/// Each frame's id and link, in vec order.
fn links(doc: &Document) -> Vec<(String, Option<String>)> {
    doc.spreads[0]
        .spread
        .text_frames
        .iter()
        .map(|f| {
            (
                f.self_id.clone().unwrap_or_default(),
                f.next_text_frame.clone(),
            )
        })
        .collect()
}

fn assert_no_dangling_link(doc: &Document) {
    let ids: Vec<String> = links(doc).into_iter().map(|(id, _)| id).collect();
    for (id, next) in links(doc) {
        if let Some(next) = next {
            assert!(
                ids.contains(&next),
                "frame {id} links to {next}, which the document does not hold"
            );
        }
    }
}

fn spreads_json(doc: &Document) -> serde_json::Value {
    serde_json::to_value(doc.spreads.iter().map(|p| &p.spread).collect::<Vec<_>>()).expect("json")
}

fn remove(doc: &mut Document, id: &str) -> paged_mutate::AppliedOperation {
    apply(
        doc,
        &Operation::RemoveNode {
            node: NodeId::TextFrame(id.into()),
        },
    )
    .expect("remove")
}

fn owned(pairs: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
    pairs
        .iter()
        .map(|(id, next)| (id.to_string(), next.map(str::to_string)))
        .collect()
}

#[test]
fn removing_a_middle_frame_links_the_one_before_to_the_one_after() {
    let mut doc = chain();
    let before = spreads_json(&doc);
    let applied = remove(&mut doc, "b");
    assert_eq!(links(&doc), owned(&[("a", Some("c")), ("c", None)]));
    assert_no_dangling_link(&doc);
    let after = spreads_json(&doc);

    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(spreads_json(&doc), before, "undo restores the chain");
    assert_eq!(
        links(&doc),
        owned(&[("a", Some("b")), ("b", Some("c")), ("c", None)])
    );

    apply(&mut doc, &applied.op).expect("redo");
    assert_eq!(spreads_json(&doc), after, "redo closes the thread again");
}

#[test]
fn removing_the_last_frame_ends_the_chain_at_the_one_before() {
    let mut doc = chain();
    let before = spreads_json(&doc);
    let applied = remove(&mut doc, "c");
    assert_eq!(links(&doc), owned(&[("a", Some("b")), ("b", None)]));
    assert_no_dangling_link(&doc);
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(spreads_json(&doc), before);
}

#[test]
fn removing_the_first_frame_leaves_the_rest_of_the_chain_alone() {
    let mut doc = chain();
    let before = spreads_json(&doc);
    let applied = remove(&mut doc, "a");
    assert_eq!(links(&doc), owned(&[("b", Some("c")), ("c", None)]));
    assert!(
        matches!(applied.inverse, Operation::InsertNode { .. }),
        "no thread to close: the undo is the plain re-insert"
    );
    apply(&mut doc, &applied.inverse).expect("undo");
    assert_eq!(spreads_json(&doc), before);
}
