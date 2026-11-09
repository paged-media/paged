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

//! Engine ADR 1050, amendment 2026-11-09 — an anchored text frame whose
//! `item_transform` turns it (a Word text box or a SmartArt shape's text,
//! turned) is placed as its unturned box and turned about that box's centre,
//! its text and its fill with it. Set on the `blank-paragraphs` fixture: an
//! inline anchored text frame holding a copy of the first story.

use paged_compose::DisplayCommand;
use paged_gen::samples::blank_paragraphs::story_id;
use paged_model::{AnchoredFrame, AnchoredFrameKind, Bounds};
use paged_renderer::{pipeline, PipelineOptions};

fn inter_font() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).unwrap_or_else(|e| panic!("read Inter.ttf: {e}"))
}

/// The fixture with a 120 x 40 pt anchored text frame at the start of the
/// first story, turned by `turn` (its `item_transform`).
fn document(turn: Option<[f32; 6]>) -> paged_scene::Document {
    let bytes =
        paged_gen::write_idml(&paged_gen::samples::blank_paragraphs::build()).expect("idml");
    let mut doc = idml_import::import_idml_doc(&bytes).expect("import");
    let story = story_id(0);
    let mut inner = doc
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("story 0")
        .clone();
    inner.self_id = "turned_box_story".into();
    inner.src = "Stories/Story_turned_box_story.xml".into();
    doc.stories.push(inner);
    let host = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == story)
        .expect("story 0");
    let p = &mut host.story.paragraphs[0];
    p.anchored_frames.push(AnchoredFrame {
        frame_kind: AnchoredFrameKind::TextFrame,
        self_id: Some("turned_box".into()),
        bounds: Some(Bounds {
            top: 0.0,
            left: 0.0,
            bottom: 40.0,
            right: 120.0,
        }),
        item_transform: turn,
        parent_story: Some("turned_box_story".into()),
        ..AnchoredFrame::default()
    });
    p.anchored_frame_offsets.resize(p.anchored_frames.len(), 0);
    doc
}

fn build(doc: &paged_scene::Document) -> pipeline::BuiltDocument {
    let font = inter_font();
    let opts = PipelineOptions {
        font: Some(&font),
        ..PipelineOptions::default()
    };
    pipeline::build_document(doc, &opts).expect("build")
}

/// The page's filled paths turned a quarter clockwise (their `x` runs down
/// the page): the turned glyphs.
fn quarter_turned(built: &pipeline::BuiltDocument) -> usize {
    built.pages[0]
        .list
        .commands
        .iter()
        .filter(|c| match c {
            DisplayCommand::FillPath { transform, .. } => {
                let [a, b, c, d, _, _] = transform.0;
                a.abs() < 1e-4 && d.abs() < 1e-4 && b > 1e-3 && c.abs() > 1e-3
            }
            _ => false,
        })
        .count()
}

#[test]
fn a_turned_anchored_text_frame_turns_its_text() {
    let upright = build(&document(None));
    assert_eq!(quarter_turned(&upright), 0, "upright: no turned glyph");
    let turned = build(&document(Some([0.0, 1.0, -1.0, 0.0, 0.0, 0.0])));
    assert!(
        quarter_turned(&turned) > 0,
        "the anchored frame's glyphs turn a quarter with it"
    );
}
