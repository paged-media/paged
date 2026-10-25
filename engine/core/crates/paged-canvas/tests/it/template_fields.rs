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

//! Template fields as a read and write surface (engine ADR 1001, task C8):
//! the field list with current values, in form order; values checked
//! against constraints; one batch, one undo step; a filler fills a form
//! the policy permits; text keeps its style.

use paged_canvas::{
    channel::Mutation,
    element_selection::ElementId,
    template::{FieldValue, TemplateFieldValue},
    CanvasModel, CanvasOptions, PageId,
};
use paged_template::{
    Constraints, DocumentPolicy, FieldDef, ItemPolicy, Role, SessionPolicy, TemplateFieldKind,
    TEMPLATE_KEY,
};

fn model() -> CanvasModel {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let bytes = paged_gen::write_idml(&sample).expect("write idml");
    CanvasModel::load("fields", &bytes, CanvasOptions::default()).expect("load")
}

fn page(m: &CanvasModel) -> PageId {
    PageId(m.pages()[0].self_id.clone())
}

fn role(m: &mut CanvasModel, role: Role) {
    m.set_session_policy(SessionPolicy {
        role,
        overrides: vec![],
    });
}

fn field(name: &str, kind: TemplateFieldKind, constraints: Constraints) -> FieldDef {
    FieldDef {
        name: name.into(),
        kind,
        label: Some(name.to_uppercase()),
        help: None,
        group: None,
        required: false,
        constraints,
        module: None,
        members: vec![],
    }
}

fn policy(m: &mut CanvasModel, id: &ElementId, def: FieldDef) {
    m.apply_mutation(&Mutation::SetPluginMetadata {
        element_id: id.clone(),
        key: TEMPLATE_KEY.into(),
        value: Some(
            ItemPolicy {
                field: Some(def),
                ..Default::default()
            }
            .to_label(),
        ),
        caller: None,
    })
    .expect("field policy");
}

/// A card: a `headline` text field holding "Old title", a `photo` image
/// field and a `badge` visibility field, ordered badge, headline, photo.
fn card() -> (CanvasModel, String) {
    let mut m = model();
    role(&mut m, Role::Author);
    let tf = m
        .apply_mutation(&Mutation::InsertTextFrame {
            page_id: page(&m),
            bounds: (100.0, 40.0, 160.0, 300.0),
        })
        .expect("text frame")
        .created_id
        .expect("id");
    let story = m.scene().spreads[0]
        .spread
        .text_frames
        .iter()
        .find(|f| f.self_id.as_deref() == Some(tf.raw_id()))
        .and_then(|f| f.parent_story.clone())
        .expect("story");
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 0,
        text: "Old title".into(),
        cell: None,
    })
    .expect("seed text");
    let photo = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id: page(&m),
            bounds: (200.0, 40.0, 260.0, 120.0),
        })
        .expect("frame")
        .created_id
        .expect("id");
    let badge = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id: page(&m),
            bounds: (200.0, 200.0, 220.0, 220.0),
        })
        .expect("frame")
        .created_id
        .expect("id");
    policy(
        &mut m,
        &tf,
        field(
            "headline",
            TemplateFieldKind::Text,
            Constraints {
                max_length: Some(20),
                ..Default::default()
            },
        ),
    );
    policy(
        &mut m,
        &photo,
        field("photo", TemplateFieldKind::Image, Constraints::default()),
    );
    policy(
        &mut m,
        &badge,
        field(
            "badge",
            TemplateFieldKind::Visibility,
            Constraints::default(),
        ),
    );
    m.apply_mutation(&Mutation::SetDocumentMetadata {
        key: TEMPLATE_KEY.into(),
        value: Some(
            DocumentPolicy {
                order: vec!["badge".into(), "headline".into(), "photo".into()],
                ..Default::default()
            }
            .to_label(),
        ),
        caller: None,
    })
    .expect("document policy");
    (m, story)
}

fn text(name: &str, t: &str) -> TemplateFieldValue {
    TemplateFieldValue {
        name: name.into(),
        value: FieldValue::Text { text: t.into() },
    }
}

#[test]
fn the_field_list_is_in_form_order_with_current_values() {
    let (m, story) = card();
    let rows = m.template_fields();
    let names: Vec<_> = rows.iter().map(|r| r.field.name.as_str()).collect();
    assert_eq!(names, ["badge", "headline", "photo"]);
    let headline = &rows[1];
    assert_eq!(headline.story_id.as_deref(), Some(story.as_str()));
    assert_eq!(
        headline.value,
        Some(FieldValue::Text {
            text: "Old title".into()
        })
    );
    assert_eq!(headline.field.label.as_deref(), Some("HEADLINE"));
    assert_eq!(rows[0].value, Some(FieldValue::Visible { visible: true }));
    // The collection carries the same rows.
    let collection = m.collection(paged_canvas::channel::CollectionName::TemplateFields);
    assert_eq!(collection.as_array().map(Vec::len), Some(3));
}

#[test]
fn a_filler_fills_the_form_in_one_undo_step() {
    let (mut m, _) = card();
    role(&mut m, Role::Filler);
    let depth = m.applied_log_len();
    let batch = m
        .lower_template_fields(&[
            text("headline", "Ada Example"),
            TemplateFieldValue {
                name: "badge".into(),
                value: FieldValue::Visible { visible: false },
            },
        ])
        .expect("values fit their fields");
    m.apply_mutation(&batch)
        .expect("the filler may fill these fields");
    let rows = m.template_fields();
    assert_eq!(
        rows[1].value,
        Some(FieldValue::Text {
            text: "Ada Example".into()
        })
    );
    assert_eq!(rows[0].value, Some(FieldValue::Visible { visible: false }));
    assert_eq!(m.applied_log_len(), depth + 1, "one undo step");
    m.undo().expect("undo");
    let rows = m.template_fields();
    assert_eq!(
        rows[1].value,
        Some(FieldValue::Text {
            text: "Old title".into()
        })
    );
    assert_eq!(rows[0].value, Some(FieldValue::Visible { visible: true }));
}

#[test]
fn values_that_do_not_fit_are_refused_and_nothing_applies() {
    let (m, _) = card();
    let problems = m
        .lower_template_fields(&[
            text("headline", "A title far longer than twenty characters"),
            text("nobody", "x"),
            TemplateFieldValue {
                name: "photo".into(),
                value: FieldValue::Visible { visible: true },
            },
        ])
        .expect_err("three problems");
    let mut found: Vec<_> = problems
        .iter()
        .map(|p| (p.name.as_str(), p.problem.as_str()))
        .collect();
    found.sort();
    assert_eq!(
        found,
        [
            ("headline", "longer than the field allows"),
            ("nobody", "no field has this name"),
            ("photo", "the value does not fit the field's kind"),
        ]
    );
}

#[test]
fn a_replaced_text_keeps_its_style() {
    let (mut m, story) = card();
    // Bold the seed text, then replace it as a filler.
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ElementId::StoryRange {
            story_id: story.clone(),
            start: 0,
            end: 9,
        },
        path: paged_mutate::PropertyPath::CharacterFontStyle,
        value: paged_mutate::Value::Text("Bold".into()),
    })
    .expect("bold");
    role(&mut m, Role::Filler);
    let batch = m
        .lower_template_fields(&[text("headline", "New")])
        .expect("fits");
    m.apply_mutation(&batch).expect("applies");
    let s = m
        .scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("story");
    let runs: Vec<_> = s
        .story
        .paragraphs
        .iter()
        .flat_map(|p| p.runs.iter())
        .collect();
    assert_eq!(
        runs.iter().map(|r| r.text.as_str()).collect::<String>(),
        "New"
    );
    assert!(
        runs.iter().all(|r| r.font_style.as_deref() == Some("Bold")),
        "the new text took the replaced text's style: {:?}",
        runs.iter().map(|r| &r.font_style).collect::<Vec<_>>()
    );
}

/// C11 — a template survives its trips: IDML export and import, and the
/// `.paged` save and load (a `.paged` file is an IDML package, core ADR
/// 118). The policy rides in labels, so the fields, their definitions,
/// their order and their values come back as they went.
#[test]
fn a_template_survives_idml_and_paged_round_trips() {
    let (m, _) = card();
    let before = m.template_fields();
    let strip = |rows: Vec<paged_canvas::template::TemplateFieldSummary>| {
        rows.into_iter()
            .map(|r| (r.field, r.value))
            .collect::<Vec<_>>()
    };
    let idml = m.export_idml().expect("export idml");
    let reloaded = CanvasModel::load("idml", &idml, CanvasOptions::default()).expect("reload idml");
    assert_eq!(strip(reloaded.template_fields()), strip(before.clone()));
    let paged = m
        .export_paged(paged_canvas::channel::PROTOCOL_VERSION.0)
        .expect("export paged");
    let reloaded =
        CanvasModel::load("paged", &paged, CanvasOptions::default()).expect("reload paged");
    assert_eq!(strip(reloaded.template_fields()), strip(before));
}

/// Editor plan F3: the template's preflight names what is wrong with its
/// policy — a picture field on a text frame, two fields of one name, a
/// required field on a hidden item — errors first, in the
/// `templateFindings` collection.
#[test]
fn preflight_names_what_is_wrong_with_a_template() {
    let mut m = model();
    role(&mut m, Role::Author);
    let insert = |m: &mut CanvasModel, text: bool, y: f32| {
        let op = if text {
            Mutation::InsertTextFrame {
                page_id: page(m),
                bounds: (y, 40.0, y + 40.0, 300.0),
            }
        } else {
            Mutation::InsertFrame {
                page_id: page(m),
                bounds: (y, 40.0, y + 40.0, 120.0),
            }
        };
        m.apply_mutation(&op)
            .expect("insert")
            .created_id
            .expect("id")
    };
    let headline = insert(&mut m, true, 100.0);
    let photo_on_text = insert(&mut m, true, 160.0);
    let badge = insert(&mut m, false, 220.0);
    let twin = insert(&mut m, false, 280.0);
    policy(
        &mut m,
        &headline,
        field("title", TemplateFieldKind::Text, Constraints::default()),
    );
    policy(
        &mut m,
        &photo_on_text,
        field("photo", TemplateFieldKind::Image, Constraints::default()),
    );
    let mut required = field(
        "badge",
        TemplateFieldKind::Visibility,
        Constraints::default(),
    );
    required.required = true;
    policy(&mut m, &badge, required);
    policy(
        &mut m,
        &twin,
        field(
            "title",
            TemplateFieldKind::Visibility,
            Constraints::default(),
        ),
    );
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: badge.clone(),
        path: paged_mutate::PropertyPath::ElementVisible,
        value: paged_mutate::Value::Bool(false),
    })
    .expect("hide the badge");

    let findings = paged_template::preflight(m.scene());
    let codes: Vec<(&str, Option<&str>)> = findings
        .iter()
        .map(|f| (f.code.as_str(), f.field.as_deref()))
        .collect();
    assert!(
        codes.contains(&("imageNotReplaceable", Some("photo"))),
        "{codes:?}"
    );
    assert!(
        codes.contains(&("fieldDuplicate", Some("title"))),
        "{codes:?}"
    );
    assert!(
        codes.contains(&("requiredHidden", Some("badge"))),
        "{codes:?}"
    );
    // Errors come first.
    let first_warning = findings
        .iter()
        .position(|f| f.severity == paged_template::FindingSeverity::Warning)
        .unwrap();
    assert!(findings[..first_warning]
        .iter()
        .all(|f| f.severity == paged_template::FindingSeverity::Error));
    // The same through the collection the editor reads.
    let collection = m.collection(paged_canvas::channel::CollectionName::TemplateFindings);
    assert_eq!(collection.as_array().map(Vec::len), Some(findings.len()));
}
