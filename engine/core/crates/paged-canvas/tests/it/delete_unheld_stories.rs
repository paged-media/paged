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
//! A plain `deleteFrame` keeps a deleted text frame's story: the story is
//! then held by no frame, free to be put on a path (draw's Type on a Path
//! flows such a story), and the IDML export leaves it out with a loss
//! line. A caller that owns what it deletes asks for the story to go too:
//! paged.data, when a Data Merge consumes its template or a re-merge
//! clears the frames of the run before, which left the template's stories
//! (and one per cleared frame) in the merged document. The story goes in
//! the same undo step, with the hyperlinks whose source text it holds;
//! one still threaded on to a frame that stays is kept.

use std::io::Write;

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, ElementId, PageId};
use serde_json::json;

/// Two single-page spreads, no frames, and one story that no frame places
/// (as an import can leave one).
fn idml() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/vnd.adobe.indesign-idml-package")
            .unwrap();
        let parts: [(&str, &str); 4] = [
            (
                "designmap.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="20.0" Self="d1" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
<idPkg:Spread src="Spreads/Spread_s1.xml"/>
<idPkg:Spread src="Spreads/Spread_s2.xml"/>
<idPkg:Story src="Stories/Story_loose.xml"/>
</Document>"#,
            ),
            (
                "Spreads/Spread_s1.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
            ),
            (
                "Spreads/Spread_s2.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Spread Self="s2" PageCount="1" ItemTransform="1 0 0 1 0 816">
<Page Self="p2" Name="2" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
            ),
            (
                "Stories/Story_loose.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<Story Self="loose">
<ParagraphStyleRange>
<CharacterStyleRange><Content>Kept aside</Content></CharacterStyleRange>
</ParagraphStyleRange>
</Story></idPkg:Story>"#,
            ),
        ];
        for (name, body) in parts {
            zip.start_file(name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    CanvasModel::load("doc", &idml(), CanvasOptions::default()).expect("load")
}

fn story_ids(m: &CanvasModel) -> Vec<String> {
    m.scene()
        .stories
        .iter()
        .map(|s| s.self_id.clone())
        .collect()
}

fn story_text(m: &CanvasModel, id: &str) -> String {
    m.scene()
        .stories
        .iter()
        .find(|s| s.self_id == id)
        .map(|s| {
            s.story
                .paragraphs
                .iter()
                .flat_map(|p| p.runs.iter())
                .map(|r| r.text.as_str())
                .collect()
        })
        .unwrap_or_default()
}

/// A text frame on `page` holding `text`: `(frame id, story id)`.
fn frame_with(m: &mut CanvasModel, page: &str, text: &str) -> (String, String) {
    let out = m
        .apply_mutation(&Mutation::InsertTextFrame {
            page_id: PageId(page.into()),
            bounds: (72.0, 72.0, 300.0, 400.0),
        })
        .expect("frame");
    let Some(ElementId::TextFrame(frame)) = out.created_id else {
        panic!("a text frame id");
    };
    let story = m
        .scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.text_frames.iter())
        .find(|f| f.self_id.as_deref() == Some(frame.as_str()))
        .and_then(|f| f.parent_story.clone())
        .expect("the minted story");
    if !text.is_empty() {
        m.apply_mutation(&Mutation::InsertText {
            story_id: story.clone(),
            offset: 0,
            text: text.into(),
            cell: None,
        })
        .expect("type");
    }
    (frame, story)
}

/// `deleteFrame { withStory: true }`, as a plugin spells it.
fn delete(frame: &str) -> Mutation {
    serde_json::from_value(json!({
        "op": "deleteFrame",
        "args": { "frameId": frame, "withStory": true },
    }))
    .expect("wire spelling")
}

/// A plain `deleteFrame`: the editor's Delete.
fn delete_frame_only(frame: &str) -> Mutation {
    serde_json::from_value(json!({ "op": "deleteFrame", "args": { "frameId": frame } }))
        .expect("wire spelling")
}

/// The export's loss lines about story `id`: an `idml.story.unplaced` line
/// is a story the document kept with no frame to place it. (The fixture's
/// loose story has one of its own.)
fn story_losses(m: &CanvasModel, id: &str) -> Vec<String> {
    m.idml_export_losses()
        .into_iter()
        .filter(|l| l.code.starts_with("idml.story.") && l.message.contains(&format!("`{id}`")))
        .map(|l| l.message)
        .collect()
}

#[test]
fn deleting_a_frame_with_its_story_takes_the_story_and_undo_brings_both_back() {
    let mut m = load();
    let (frame, story) = frame_with(&mut m, "p1", "Merged once");
    let typed = m.current_state_hash();

    m.apply_mutation(&delete(&frame)).expect("delete");
    assert!(
        !story_ids(&m).contains(&story),
        "the story went with its frame"
    );
    assert_eq!(story_losses(&m, &story), Vec::<String>::new());

    m.undo().expect("undo the delete");
    assert_eq!(m.current_state_hash(), typed, "frame, story and text back");
    assert_eq!(story_text(&m, &story), "Merged once");

    m.redo().expect("redo the delete");
    assert!(!story_ids(&m).contains(&story));
}

#[test]
fn a_threaded_story_stays_until_its_last_frame_goes() {
    let mut m = load();
    let (a, story) = frame_with(&mut m, "p1", "Runs on");
    let (b, own) = frame_with(&mut m, "p2", "");
    m.apply_mutation(&Mutation::LinkFrames {
        from: a.clone(),
        to: b.clone(),
    })
    .expect("thread");
    assert!(
        !story_ids(&m).contains(&own),
        "ADR 200: the link took b's own"
    );
    let threaded = m.current_state_hash();

    m.apply_mutation(&delete(&a))
        .expect("delete the first frame");
    assert!(story_ids(&m).contains(&story), "b still holds the story");
    m.apply_mutation(&delete(&b))
        .expect("delete the last frame");
    assert!(!story_ids(&m).contains(&story), "the last frame took it");
    m.undo().expect("undo");
    m.undo().expect("undo");
    assert_eq!(m.current_state_hash(), threaded);

    // Both frames in one batch: one step, the story goes once.
    m.apply_mutation(&Mutation::Batch {
        ops: vec![delete(&a), delete(&b)],
    })
    .expect("delete both");
    assert!(!story_ids(&m).contains(&story));
    m.undo().expect("undo the batch");
    assert_eq!(m.current_state_hash(), threaded);
}

#[test]
fn a_plain_delete_keeps_the_story_free_for_a_path() {
    let mut m = load();
    let (frame, story) = frame_with(&mut m, "p1", "On a path next");
    m.apply_mutation(&delete_frame_only(&frame))
        .expect("delete the frame only");
    assert!(
        story_ids(&m).contains(&story),
        "the story is free, not gone"
    );
    assert_eq!(story_text(&m, &story), "On a path next");
    assert_eq!(story_losses(&m, &story).len(), 1, "and the export says so");
}

#[test]
fn a_story_no_frame_placed_before_the_delete_is_left_alone() {
    let mut m = load();
    assert!(story_ids(&m).contains(&"loose".to_string()), "imported");
    let (frame, _) = frame_with(&mut m, "p1", "Placed");
    m.apply_mutation(&delete(&frame)).expect("delete");
    assert!(
        story_ids(&m).contains(&"loose".to_string()),
        "a delete removes only what it unplaced"
    );
    assert_eq!(story_text(&m, "loose"), "Kept aside");
}

#[test]
fn the_hyperlinks_of_a_story_go_with_it() {
    let mut m = load();
    let (frame, story) = frame_with(&mut m, "p1", "paged.media");
    m.apply_mutation(&Mutation::InsertHyperlink {
        story_id: story.clone(),
        start: 0,
        end: 11,
        url: "https://paged.media".into(),
        page: None,
    })
    .expect("hyperlink");
    assert_eq!(m.scene().designmap.hyperlinks.len(), 1);
    let linked = m.current_state_hash();

    m.apply_mutation(&delete(&frame)).expect("delete");
    assert!(!story_ids(&m).contains(&story));
    assert!(
        m.scene().designmap.hyperlinks.is_empty(),
        "no hyperlink left naming a source that is gone"
    );
    let hyperlinks: Vec<String> = m
        .idml_export_losses()
        .into_iter()
        .filter(|l| l.code.starts_with("idml.hyperlink."))
        .map(|l| l.message)
        .collect();
    assert_eq!(hyperlinks, Vec::<String>::new());
    assert_eq!(story_losses(&m, &story), Vec::<String>::new());

    m.undo().expect("undo");
    assert_eq!(
        m.current_state_hash(),
        linked,
        "the link and its source back"
    );
}
