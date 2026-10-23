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

//! Engine ADR 1002 — fields derived from the XML tags of a document made
//! the way InDesign tags one (`paged_gen::fixtures::tagged_template_idml`).

use paged_template::{derive_fields, DeriveOptions, DerivedFrom, DerivedTarget, TemplateFieldKind};

fn doc() -> paged_scene::Document {
    idml_import::import_idml_doc(&paged_gen::fixtures::tagged_template_idml()).unwrap()
}

#[test]
fn every_case_of_the_tagged_fixture() {
    let d = derive_fields(&doc(), DeriveOptions::default());
    let names: Vec<(&str, TemplateFieldKind)> = d
        .fields
        .iter()
        .map(|f| (f.field.name.as_str(), f.field.kind))
        .collect();
    assert_eq!(
        names,
        vec![
            ("Headline", TemplateFieldKind::Text),
            ("Photo", TemplateFieldKind::Image),
            ("Name", TemplateFieldKind::TextRun),
            ("Price", TemplateFieldKind::TextRun),
        ]
    );
    // A tagged text frame: its story, through its frame; the story's
    // element carries the metadata.
    let head = &d.fields[0];
    assert_eq!(
        head.target,
        DerivedTarget::Story {
            story_id: "sHead".into(),
            frame_id: "tfHead".into()
        }
    );
    assert_eq!(head.field.label.as_deref(), Some("Headline"));
    assert_eq!(head.field.constraints.max_length, Some(40));
    assert!(head.field.required);
    assert_eq!(head.element_id.as_deref(), Some("di2i3"));
    assert_eq!(head.from, DerivedFrom::Tag);
    // A tagged graphic frame: a picture, its label from the back story.
    let photo = &d.fields[1];
    assert_eq!(
        photo.target,
        DerivedTarget::Item {
            item_id: "rPhoto".into()
        }
    );
    assert_eq!(photo.field.label.as_deref(), Some("Product photo"));
    assert!(!photo.field.required);
    // Tagged ranges: runs, with their text and metadata.
    let DerivedTarget::Range {
        story_id,
        element_id,
        text,
        ..
    } = &d.fields[2].target
    else {
        panic!("a range: {:?}", d.fields[2].target);
    };
    assert_eq!(
        (story_id.as_str(), element_id.as_str(), text.as_str()),
        ("sBody", "di2i5i1", "Ada")
    );
    assert_eq!(d.fields[2].field.label.as_deref(), Some("First name"));
    let DerivedTarget::Range { text, .. } = &d.fields[3].target else {
        panic!();
    };
    assert_eq!(text, "9.99");
    assert_eq!(d.fields[3].field.constraints.max_length, Some(8));
    // The story holding the ranges, and the parent-page tag, are reported.
    let skipped: Vec<(&str, &str)> = d
        .skipped
        .iter()
        .map(|s| (s.tag.as_str(), s.reason.as_str()))
        .collect();
    assert_eq!(
        skipped,
        vec![
            ("Letter", "its tagged ranges are the fields"),
            ("Folio", "it is on a parent page"),
        ]
    );
}

#[test]
fn names_and_placeholders_join_when_asked() {
    let mut doc = doc();
    let none = derive_fields(&doc, DeriveOptions::default());
    assert!(!none.fields.iter().any(|f| f.field.name == "logo"));
    let named = derive_fields(
        &doc,
        DeriveOptions {
            include_names: true,
            include_placeholders: false,
        },
    );
    let logo = named
        .fields
        .iter()
        .find(|f| f.field.name == "logo")
        .unwrap();
    assert_eq!(logo.field.kind, TemplateFieldKind::Image);
    assert_eq!(logo.from, DerivedFrom::Name);
    // A data-merge placeholder in the headline's story.
    let story = doc
        .stories
        .iter_mut()
        .find(|s| s.self_id == "sHead")
        .unwrap();
    story.story.paragraphs[0].runs[0].placeholder = Some(paged_model::PlaceholderField {
        plugin: "media.paged.data".into(),
        key: "season".into(),
        value: None,
    });
    let with = derive_fields(
        &doc,
        DeriveOptions {
            include_names: false,
            include_placeholders: true,
        },
    );
    let season = with
        .fields
        .iter()
        .find(|f| f.field.name == "season")
        .unwrap();
    assert_eq!(season.field.kind, TemplateFieldKind::TextRun);
    assert_eq!(season.from, DerivedFrom::Placeholder);
}

#[test]
fn an_untagged_document_derives_nothing() {
    let mut doc = doc();
    doc.designmap.xml_root = None;
    let d = derive_fields(&doc, DeriveOptions::default());
    assert!(d.fields.is_empty() && d.skipped.is_empty());
}
