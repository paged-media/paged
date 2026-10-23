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

//! Engine ADR 1002 — the operations on the XML structure, each undone by
//! its inverse, and the tagged ranges kept true through field edits.

use paged_mutate::{apply, FieldKind, Operation, OperationError};
use paged_scene::Document;

fn open() -> Document {
    idml_import::import_idml_doc(&paged_gen::fixtures::tagged_template_idml()).expect("fixture")
}

fn snapshot(doc: &Document) -> String {
    serde_json::to_string(&(
        &doc.designmap.xml_tags,
        &doc.designmap.xml_root,
        doc.designmap.xml_structure_edited,
        doc.stories
            .iter()
            .map(|s| (&s.self_id, &s.story.xml_elements))
            .collect::<Vec<_>>(),
    ))
    .unwrap()
}

/// Applies `op`, then its inverse, and checks the structure is back.
fn round_trip(doc: &mut Document, op: Operation) -> String {
    let before = snapshot(doc);
    let applied = apply(doc, &op).expect("applies");
    assert!(doc.designmap.xml_structure_edited);
    let after = snapshot(doc);
    let undone = apply(doc, &applied.inverse).expect("undoes");
    assert_eq!(snapshot(doc), before, "undo restores the structure");
    apply(doc, &undone.inverse).expect("redoes");
    assert_eq!(snapshot(doc), after, "redo restores the edit");
    after
}

fn story<'a>(doc: &'a Document, id: &str) -> &'a paged_model::Story {
    &doc.stories.iter().find(|s| s.self_id == id).unwrap().story
}

fn range_text(doc: &Document, story_id: &str, element: &str) -> String {
    let s = story(doc, story_id);
    let el = s
        .xml_elements
        .iter()
        .find_map(|e| e.find(element))
        .expect("element");
    let r = el.range.expect("a range");
    s.flat_text()
        .chars()
        .skip(r.start as usize)
        .take((r.end - r.start) as usize)
        .collect()
}

#[test]
fn the_fixture_reads_as_tagged() {
    let doc = open();
    assert_eq!(doc.designmap.xml_tags.len(), 7);
    let root = doc.designmap.xml_root.as_ref().unwrap();
    assert_eq!(root.children.len(), 4);
    assert_eq!(range_text(&doc, "sBody", "di2i5i1"), "Ada");
    assert_eq!(range_text(&doc, "sBody", "di2i5i2"), "9.99");
    assert!(!doc.designmap.xml_structure_edited);
}

#[test]
fn a_tag_is_created_and_deleted() {
    let mut doc = open();
    round_trip(
        &mut doc,
        Operation::CreateXmlTag {
            name: "Caption".into(),
            color: Some("Red".into()),
        },
    );
    // The round trip leaves it made; a second definition is refused.
    assert!(matches!(
        apply(
            &mut doc,
            &Operation::CreateXmlTag {
                name: "Caption".into(),
                color: None
            }
        ),
        Err(OperationError::InvalidXmlStructure { .. })
    ));
    assert!(apply(
        &mut doc,
        &Operation::CreateXmlTag {
            name: "two words".into(),
            color: None
        }
    )
    .is_err());
    round_trip(
        &mut doc,
        Operation::DeleteXmlTag {
            name: "Caption".into(),
        },
    );
    assert!(
        apply(
            &mut doc,
            &Operation::DeleteXmlTag {
                name: "Headline".into()
            }
        )
        .is_err(),
        "a tag in use stays"
    );
}

#[test]
fn an_item_and_a_text_frames_story_are_tagged_and_untagged() {
    let mut doc = open();
    round_trip(
        &mut doc,
        Operation::TagItem {
            item: "rLogo".into(),
            tag: "Logo".into(),
            self_id: "x1".into(),
        },
    );
    let root = doc.designmap.xml_root.as_ref().unwrap();
    assert_eq!(root.find("x1").unwrap().content.as_deref(), Some("rLogo"));
    assert!(doc.designmap.xml_tags.iter().any(|t| t.name == "Logo"));
    // Tagged again: retagged, the element keeps its id.
    round_trip(
        &mut doc,
        Operation::TagItem {
            item: "rLogo".into(),
            tag: "Brand".into(),
            self_id: "x2".into(),
        },
    );
    let root = doc.designmap.xml_root.as_ref().unwrap();
    assert_eq!(root.find("x1").unwrap().tag, "XMLTag/Brand");
    assert!(root.find("x2").is_none());
    // An attribute addressed by the item the element tags.
    round_trip(
        &mut doc,
        Operation::SetXmlAttribute {
            element: "tfHead".into(),
            name: "label".into(),
            value: Some("Title".into()),
        },
    );
    let head = &story(&doc, "sHead").xml_elements[0];
    assert_eq!(head.attribute("label"), Some("Title"));
    round_trip(
        &mut doc,
        Operation::UntagItem {
            item: "tfHead".into(),
        },
    );
    assert!(story(&doc, "sHead").xml_elements.is_empty());
    assert!(doc
        .designmap
        .xml_root
        .as_ref()
        .unwrap()
        .find("di2i3")
        .is_none());
}

#[test]
fn tagging_an_untagged_document_makes_its_root() {
    let mut doc = open();
    doc.designmap.xml_root = None;
    doc.designmap.xml_tags.clear();
    for s in &mut doc.stories {
        s.story.xml_elements.clear();
    }
    round_trip(
        &mut doc,
        Operation::TagItem {
            item: "tfBody".into(),
            tag: "Body".into(),
            self_id: "b1".into(),
        },
    );
    let root = doc.designmap.xml_root.as_ref().unwrap();
    assert_eq!(root.tag, "XMLTag/Root");
    assert_eq!(root.children[0].content.as_deref(), Some("sBody"));
    assert_eq!(story(&doc, "sBody").xml_elements[0].self_id, "b1");
    let names: Vec<&str> = doc
        .designmap
        .xml_tags
        .iter()
        .map(|t| t.name.as_str())
        .collect();
    assert_eq!(names, ["Body", "Root"]);
}

#[test]
fn ranges_are_tagged_nested_and_untagged() {
    let mut doc = open();
    // "Dear Ada, your price is 9.99 today." — tag "Dear Ada" around Name.
    round_trip(
        &mut doc,
        Operation::TagRange {
            story_id: "sBody".into(),
            start: 0,
            end: 8,
            tag: "Greeting".into(),
            self_id: "g1".into(),
        },
    );
    let top = &story(&doc, "sBody").xml_elements[0];
    let greeting = top.find("g1").unwrap();
    assert_eq!(greeting.children[0].self_id, "di2i5i1", "it took Name in");
    assert_eq!(range_text(&doc, "sBody", "g1"), "Dear Ada");
    // A range cutting across Name is refused, and nothing changes.
    let before = snapshot(&doc);
    assert!(apply(
        &mut doc,
        &Operation::TagRange {
            story_id: "sBody".into(),
            start: 6,
            end: 12,
            tag: "Bad".into(),
            self_id: "b1".into(),
        }
    )
    .is_err());
    assert_eq!(snapshot(&doc), before);
    round_trip(
        &mut doc,
        Operation::UntagRange {
            element: "g1".into(),
        },
    );
    let top = &story(&doc, "sBody").xml_elements[0];
    assert!(top.find("g1").is_none());
    assert_eq!(
        top.children[0].self_id, "di2i5i1",
        "its children stay tagged"
    );
}

#[test]
fn a_range_in_an_untagged_story_tags_the_story() {
    let mut doc = open();
    apply(
        &mut doc,
        &Operation::UntagItem {
            item: "sHead".into(),
        },
    )
    .unwrap();
    round_trip(
        &mut doc,
        Operation::TagRange {
            story_id: "sHead".into(),
            start: 7,
            end: 11,
            tag: "Season".into(),
            self_id: "r1".into(),
        },
    );
    let s = story(&doc, "sHead");
    assert_eq!(s.xml_elements[0].tag, "XMLTag/Story");
    assert_eq!(range_text(&doc, "sHead", "r1"), "Sale");
    assert!(apply(
        &mut doc,
        &Operation::TagRange {
            story_id: "sHead".into(),
            start: 7,
            end: 99,
            tag: "Season".into(),
            self_id: "r2".into(),
        }
    )
    .is_err());
}

#[test]
fn attributes_are_set_and_removed() {
    let mut doc = open();
    round_trip(
        &mut doc,
        Operation::SetXmlAttribute {
            element: "di2i3".into(),
            name: "maxLength".into(),
            value: Some("20".into()),
        },
    );
    let head = &story(&doc, "sHead").xml_elements[0];
    assert_eq!(head.attribute("maxLength"), Some("20"));
    round_trip(
        &mut doc,
        Operation::SetXmlAttribute {
            element: "di2i4".into(),
            name: "label".into(),
            value: None,
        },
    );
    let photo = doc
        .designmap
        .xml_root
        .as_ref()
        .unwrap()
        .find("di2i4")
        .unwrap();
    assert!(photo.attributes.is_empty());
    assert!(apply(
        &mut doc,
        &Operation::SetXmlAttribute {
            element: "nope".into(),
            name: "label".into(),
            value: Some("x".into()),
        }
    )
    .is_err());
}

#[test]
fn a_placeholder_standing_for_a_range_defines_it() {
    let mut doc = open();
    // Open-as-template's conversion: the placeholder first, then the text.
    apply(
        &mut doc,
        &Operation::InsertField {
            story_id: "sBody".into(),
            offset: 24,
            field: FieldKind::Placeholder {
                plugin: paged_model::TEMPLATE_PLACEHOLDER_PLUGIN.into(),
                key: "di2i5i2".into(),
                value: Some("9.99".into()),
            },
            content_offset: None,
        },
    )
    .unwrap();
    assert_eq!(range_text(&doc, "sBody", "di2i5i2"), "9.99");
    assert_eq!(
        range_text(&doc, "sBody", "di2i5i1"),
        "Ada",
        "before it, unmoved"
    );
    let set = apply(
        &mut doc,
        &Operation::SetFieldValue {
            story_id: "sBody".into(),
            offset: 25,
            value: Some("129.00".into()),
        },
    )
    .unwrap();
    assert_eq!(range_text(&doc, "sBody", "di2i5i2"), "129.00");
    apply(&mut doc, &set.inverse).unwrap();
    assert_eq!(range_text(&doc, "sBody", "di2i5i2"), "9.99");
}
