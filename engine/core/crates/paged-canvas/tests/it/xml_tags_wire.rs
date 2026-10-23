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

//! Engine ADR 1002 — XML tags carry template fields, over the wire: the
//! fields a tagged document describes, "Open as template" as one undo
//! step (author only), run fields read and set through their placeholder,
//! the XML structure mutations, and the fixed point through IDML.

use paged_canvas::{
    channel::{Mutation, WorkerError},
    template::{FieldValue, TemplateFieldValue},
    CanvasModel, CanvasOptions,
};
use paged_template::{DeriveOptions, Role, SessionPolicy, TemplateFieldKind};

fn model() -> CanvasModel {
    let bytes = paged_gen::fixtures::tagged_template_idml();
    CanvasModel::load("tagged", &bytes, CanvasOptions::default()).expect("load")
}

fn role(m: &mut CanvasModel, role: Role) {
    m.set_session_policy(SessionPolicy {
        role,
        overrides: vec![],
    });
}

fn body(m: &CanvasModel) -> String {
    m.scene()
        .stories
        .iter()
        .find(|s| s.self_id == "sBody")
        .unwrap()
        .story
        .flat_text()
}

fn values(m: &CanvasModel) -> Vec<(String, TemplateFieldKind, Option<String>)> {
    m.template_fields()
        .into_iter()
        .map(|r| {
            let v = match r.value {
                Some(FieldValue::Text { text }) => Some(text),
                Some(FieldValue::Image { uri }) => Some(uri),
                Some(FieldValue::Visible { visible }) => Some(visible.to_string()),
                None => None,
            };
            (r.field.name, r.field.kind, v)
        })
        .collect()
}

fn open_as_template(m: &mut CanvasModel) {
    let batch = m
        .lower_open_as_template(DeriveOptions::default(), None)
        .expect("fields are tagged");
    m.apply_mutation(&batch).expect("applies");
}

#[test]
fn open_as_template_writes_the_fields_in_one_undo_step() {
    let mut m = model();
    role(&mut m, Role::Author);
    let derived = m.derived_template_fields(DeriveOptions::default());
    assert_eq!(derived.fields.len(), 4);
    assert!(m.template_fields().is_empty(), "deriving writes nothing");

    open_as_template(&mut m);
    assert_eq!(
        values(&m),
        vec![
            (
                "Headline".into(),
                TemplateFieldKind::Text,
                Some("Summer Sale".into())
            ),
            ("Photo".into(), TemplateFieldKind::Image, None),
            (
                "Name".into(),
                TemplateFieldKind::TextRun,
                Some("Ada".into())
            ),
            (
                "Price".into(),
                TemplateFieldKind::TextRun,
                Some("9.99".into())
            ),
        ]
    );
    assert_eq!(body(&m), "Dear Ada, your price is 9.99 today.");
    // The ranges are placeholders now, and their elements wrap them.
    let story = &m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == "sBody")
        .unwrap()
        .story;
    let keys: Vec<String> = story
        .paragraphs
        .iter()
        .flat_map(|p| p.runs.iter())
        .filter_map(|r| r.placeholder.as_ref().map(|p| p.key.clone()))
        .collect();
    assert_eq!(keys, ["di2i5i1", "di2i5i2"]);
    let price = story.xml_elements[0]
        .find("di2i5i2")
        .unwrap()
        .range
        .unwrap();
    assert_eq!((price.start, price.end), (24, 28));
    // The headline's frame took its field's name.
    let names = &m.scene().spreads[0].spread.item_names;
    assert_eq!(names.get("tfHead").map(String::as_str), Some("Headline"));

    m.undo().expect("one undo");
    assert!(m.template_fields().is_empty());
    assert_eq!(body(&m), "Dear Ada, your price is 9.99 today.");
    let story = &m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == "sBody")
        .unwrap()
        .story;
    assert!(story
        .paragraphs
        .iter()
        .flat_map(|p| p.runs.iter())
        .all(|r| r.placeholder.is_none()));
}

#[test]
fn only_an_author_opens_a_document_as_a_template() {
    let mut m = model();
    let batch = m
        .lower_open_as_template(DeriveOptions::default(), None)
        .unwrap();
    match m.apply_mutation(&batch) {
        Err(WorkerError::NotPermitted { permission, .. }) => {
            assert_eq!(permission, "template.author")
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(body(&m), "Dear Ada, your price is 9.99 today.");
}

#[test]
fn only_the_fields_named_are_written() {
    let mut m = model();
    role(&mut m, Role::Author);
    let batch = m
        .lower_open_as_template(DeriveOptions::default(), Some(&["Price".to_string()]))
        .unwrap();
    m.apply_mutation(&batch).unwrap();
    let names: Vec<String> = values(&m).into_iter().map(|v| v.0).collect();
    assert_eq!(names, ["Price"]);
    assert!(m
        .lower_open_as_template(DeriveOptions::default(), Some(&["Nope".to_string()]))
        .is_err());
}

#[test]
fn a_filler_sets_run_fields_through_their_placeholders() {
    let mut m = model();
    role(&mut m, Role::Author);
    open_as_template(&mut m);
    role(&mut m, Role::Filler);
    let set = m
        .lower_template_fields(&[
            TemplateFieldValue {
                name: "Price".into(),
                value: FieldValue::Text {
                    text: "129.00".into(),
                },
            },
            TemplateFieldValue {
                name: "Name".into(),
                value: FieldValue::Text {
                    text: "Grace".into(),
                },
            },
        ])
        .expect("values fit");
    m.apply_mutation(&set).expect("a filler fills runs");
    assert_eq!(body(&m), "Dear Grace, your price is 129.00 today.");
    let v = values(&m);
    assert_eq!(v[2].2.as_deref(), Some("Grace"));
    assert_eq!(v[3].2.as_deref(), Some("129.00"));
    // maxLength 8 on Price, from its tag's attribute.
    let too_long = m.lower_template_fields(&[TemplateFieldValue {
        name: "Price".into(),
        value: FieldValue::Text {
            text: "123456789".into(),
        },
    }]);
    assert!(too_long.is_err());
    m.undo().unwrap();
    assert_eq!(body(&m), "Dear Ada, your price is 9.99 today.");
}

#[test]
fn a_reopened_template_reads_and_sets_its_runs_by_their_tags() {
    let mut m = model();
    role(&mut m, Role::Author);
    open_as_template(&mut m);
    let first = m.derived_template_fields(DeriveOptions::default());
    let idml = m.export_idml().expect("export");
    let mut back = CanvasModel::load("back", &idml, CanvasOptions::default()).unwrap();
    // Fixed point: the placeholders went out as tagged text and read back
    // as the same fields.
    assert_eq!(
        back.derived_template_fields(DeriveOptions::default()),
        first
    );
    assert_eq!(values(&back), values(&m));
    role(&mut back, Role::Filler);
    let set = back
        .lower_template_fields(&[TemplateFieldValue {
            name: "Name".into(),
            value: FieldValue::Text {
                text: "Grace".into(),
            },
        }])
        .unwrap();
    back.apply_mutation(&set).unwrap();
    assert_eq!(body(&back), "Dear Grace, your price is 9.99 today.");
    assert_eq!(values(&back)[2].2.as_deref(), Some("Grace"));
}

#[test]
fn the_xml_mutations_mint_ids_and_undo() {
    let mut m = model();
    role(&mut m, Role::Author);
    m.apply_mutation(&Mutation::TagItem {
        item: "rLogo".into(),
        tag: "Logo".into(),
        self_id: None,
    })
    .expect("tag");
    let rows = m.xml_elements();
    let logo = rows.iter().find(|r| r.tag == "Logo").expect("tagged");
    assert!(logo.self_id.starts_with("di"));
    m.apply_mutation(&Mutation::SetXmlAttribute {
        element: logo.self_id.clone(),
        name: "label".into(),
        value: Some("Brand".into()),
    })
    .unwrap();
    m.apply_mutation(&Mutation::TagRange {
        story_id: "sHead".into(),
        start: 0,
        end: 6,
        tag: "Season".into(),
        self_id: None,
    })
    .unwrap();
    let season = m
        .xml_elements()
        .into_iter()
        .find(|r| r.tag == "Season")
        .unwrap();
    assert_eq!(season.range, Some([0, 6]));
    assert_eq!(season.story_id.as_deref(), Some("sHead"));
    // Typing before the range moves it.
    m.apply_mutation(&Mutation::InsertText {
        story_id: "sHead".into(),
        offset: 0,
        text: "Hot ".into(),
        cell: None,
    })
    .unwrap();
    let season = m
        .xml_elements()
        .into_iter()
        .find(|r| r.tag == "Season")
        .unwrap();
    assert_eq!(season.range, Some([4, 10]));
    m.undo().unwrap();
    m.undo().unwrap();
    m.undo().unwrap();
    m.undo().unwrap();
    assert!(m.xml_elements().iter().all(|r| r.tag != "Logo"));
    assert!(!m.scene().designmap.xml_structure_edited);
    // A filler may not tag.
    role(&mut m, Role::Filler);
    assert!(matches!(
        m.apply_mutation(&Mutation::TagItem {
            item: "rLogo".into(),
            tag: "Logo".into(),
            self_id: None,
        }),
        Err(WorkerError::NotPermitted { .. })
    ));
}
