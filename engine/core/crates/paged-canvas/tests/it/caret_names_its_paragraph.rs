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
//! Engine ADR 1098, amendment — direct formatting where a range cannot
//! reach. Consecutive blank lines share one contiguous offset, so a caret
//! `storyRange` that names its paragraph writes exactly that one (as
//! `applyStyle`'s `paragraph` does), reads it, and undoes exactly; and a
//! tracked change records the look before it as a style and its direct
//! properties, not as a style the importer had to mint.

use paged_canvas::{CanvasModel, CanvasOptions, ElementId, Mutation, PageId};
use paged_mutate::{ChangeSpec, ChangeSpecKind, LookProperty, PropertyPath as P, Value as V};

fn model(text: &str) -> (CanvasModel, String) {
    let idml = paged_canvas::blank::blank_idml(612.0, 792.0);
    let mut m = CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load");
    let page = m.scene().spreads[0].spread.pages[0]
        .self_id
        .clone()
        .expect("page id");
    let out = m
        .apply_mutation(&Mutation::InsertTextFrame {
            page_id: PageId(page),
            bounds: (36.0, 36.0, 576.0, 756.0),
        })
        .expect("frame");
    let Some(ElementId::TextFrame(frame)) = out.created_id else {
        panic!("expected a text frame, got {:?}", out.created_id);
    };
    let story = m.scene().spreads[0]
        .spread
        .text_frames
        .iter()
        .find(|f| f.self_id.as_deref() == Some(frame.as_str()))
        .and_then(|f| f.parent_story.clone())
        .expect("minted story");
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 0,
        text: text.into(),
        cell: None,
    })
    .expect("text");
    (m, story)
}

fn paragraphs(m: &CanvasModel, story: &str) -> Vec<paged_model::Paragraph> {
    m.scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("story")
        .story
        .paragraphs
        .clone()
}

fn caret(story: &str, at: u32, paragraph: u32) -> ElementId {
    ElementId::StoryRange {
        story_id: story.into(),
        start: at,
        end: at,
        cell: None,
        paragraph: Some(paragraph),
    }
}

#[test]
fn a_caret_that_names_its_paragraph_writes_one_blank_line() {
    // "One", two blank lines, "Two": the blank lines both sit at offset 3.
    let (mut m, story) = model("One\n\n\nTwo");
    let before = m.scene().canonical_hash();
    for (p, pt) in [(1, 6.0), (2, 18.0)] {
        m.apply_mutation(&Mutation::SetElementProperty {
            element_id: caret(&story, 3, p),
            path: P::ParagraphSpaceAfter,
            value: V::Length(Some(pt)),
        })
        .expect("a blank line's own spacing");
    }
    let after: Vec<Option<f32>> = paragraphs(&m, &story)
        .iter()
        .map(|p| p.space_after)
        .collect();
    assert_eq!(after, vec![None, Some(6.0), Some(18.0), None]);

    // The same address reads that paragraph.
    let props = m.element_properties(&caret(&story, 3, 2)).expect("a read");
    let value = props
        .entries
        .iter()
        .find(|e| e.path == P::ParagraphSpaceAfter)
        .and_then(|e| e.value.clone());
    assert_eq!(value, Some(V::Length(Some(18.0))));

    // Undo puts each back exactly; redo again.
    m.undo().expect("undo");
    m.undo().expect("undo");
    assert_eq!(m.scene().canonical_hash(), before);
    m.redo().expect("redo");
    m.redo().expect("redo");
    let again: Vec<Option<f32>> = paragraphs(&m, &story)
        .iter()
        .map(|p| p.space_after)
        .collect();
    assert_eq!(again, after);

    // A paragraph index past the story is refused.
    assert!(m
        .apply_mutation(&Mutation::SetElementProperty {
            element_id: caret(&story, 3, 9),
            path: P::ParagraphSpaceAfter,
            value: V::Length(Some(1.0)),
        })
        .is_err());
}

#[test]
fn the_address_grammar_names_a_carets_paragraph() {
    let id = caret("Story/u1", 4, 2);
    let address = id.to_address().expect("addressable");
    assert_eq!(address, "storyRange:Story/u1@4..4#2");
    assert_eq!(ElementId::parse(&address), Some(id));
}

#[test]
fn a_tracked_change_records_its_look_before_as_a_style_and_properties() {
    let (mut m, story) = model("Bold text");
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ElementId::StoryRange {
            story_id: story.clone(),
            start: 0,
            end: 4,
            cell: None,
            paragraph: None,
        },
        path: P::CharacterFontStyle,
        value: V::Text("Bold".into()),
    })
    .expect("bold now");
    let spec = |kind| ChangeSpec {
        kind,
        id: Some("docx-r1".into()),
        author: Some("Author".into()),
        date: None,
        before_character_style: Some("CharacterStyle/$ID/[No character style]".into()),
        before_paragraph_style: None,
        before_character_properties: Some(vec![LookProperty {
            path: P::CharacterFontSize,
            value: V::Length(Some(9.0)),
        }]),
        before_paragraph_properties: None,
    };
    m.apply_mutation(&Mutation::RecordChange {
        story_id: story.clone(),
        start: 0,
        end: 4,
        cell: None,
        paragraph: None,
        change: spec(ChangeSpecKind::Format),
    })
    .expect("format change");
    let ps = paragraphs(&m, &story);
    let run = ps[0]
        .runs
        .iter()
        .find(|r| r.text == "Bold")
        .expect("the changed run");
    let before = &run.format_change.as_ref().expect("a format change").before;
    // The look before is the style and those properties alone, not the
    // run's bold now.
    assert_eq!(before.point_size, Some(9.0));
    assert_eq!(before.font_style, None);
    assert_eq!(
        before.character_style.as_deref(),
        Some("CharacterStyle/$ID/[No character style]")
    );

    // A paragraph's property change, the same way.
    m.apply_mutation(&Mutation::RecordChange {
        story_id: story.clone(),
        start: 0,
        end: 0,
        cell: None,
        paragraph: Some(0),
        change: ChangeSpec {
            kind: ChangeSpecKind::ParaProps,
            before_character_properties: None,
            before_paragraph_style: Some("ParagraphStyle/$ID/NormalParagraphStyle".into()),
            before_paragraph_properties: Some(vec![LookProperty {
                path: P::ParagraphJustification,
                value: V::Text("CenterAlign".into()),
            }]),
            ..spec(ChangeSpecKind::ParaProps)
        },
    })
    .expect("a paragraph change");
    let pc = paragraphs(&m, &story)[0]
        .props_change
        .clone()
        .expect("a property change");
    assert_eq!(
        pc.before.justification.map(|j| j.as_idml().to_string()),
        Some("CenterAlign".into())
    );
}
