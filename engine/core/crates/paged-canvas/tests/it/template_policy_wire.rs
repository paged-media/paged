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

//! Template permissions on the WIRE (engine ADR 1000): a filler session
//! types into a text field and not into scenery, cannot drag a field, has
//! its click pass through scenery to the field beneath, and cannot change
//! document settings; the refusals are typed. The operation-level half is
//! `paged-mutate/tests/it/template_policy.rs`.

use paged_canvas::{
    channel::{Mutation, WorkerError},
    element_selection::ElementId,
    CanvasModel, CanvasOptions, GestureError, GestureType, PageId,
};
use paged_mutate::{PropertyPath, Value};
use paged_template::{FieldDef, FieldKind, ItemPolicy, Role, SessionPolicy, TEMPLATE_KEY};

fn model() -> CanvasModel {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let bytes = paged_gen::write_idml(&sample).expect("write idml");
    CanvasModel::load("template", &bytes, CanvasOptions::default()).expect("load")
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

fn text_frame(m: &mut CanvasModel, top: f32) -> (ElementId, String) {
    let id = m
        .apply_mutation(&Mutation::InsertTextFrame {
            page_id: page(m),
            bounds: (top, 40.0, top + 60.0, 300.0),
        })
        .expect("text frame")
        .created_id
        .expect("created id");
    let story = m.scene().spreads[0]
        .spread
        .text_frames
        .iter()
        .find(|f| f.self_id.as_deref() == Some(id.raw_id()))
        .and_then(|f| f.parent_story.clone())
        .expect("minted story");
    (id, story)
}

fn rect(m: &mut CanvasModel, bounds: (f32, f32, f32, f32)) -> ElementId {
    m.apply_mutation(&Mutation::InsertFrame {
        page_id: page(m),
        bounds,
    })
    .expect("frame")
    .created_id
    .expect("created id")
}

fn make_field(m: &mut CanvasModel, id: &ElementId, name: &str, kind: FieldKind) {
    let policy = ItemPolicy {
        field: Some(FieldDef {
            name: name.into(),
            kind,
            label: None,
            help: None,
            group: None,
            required: false,
            constraints: Default::default(),
        }),
        ..Default::default()
    };
    m.apply_mutation(&Mutation::SetPluginMetadata {
        element_id: id.clone(),
        key: TEMPLATE_KEY.into(),
        value: Some(policy.to_label()),
        caller: None,
    })
    .unwrap_or_else(|e| panic!("field {name}: {e:?}"));
}

fn type_into(m: &mut CanvasModel, story: &str) -> Result<(), WorkerError> {
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.to_string(),
        offset: 0,
        text: "Ada".into(),
        cell: None,
    })
    .map(|_| ())
}

fn assert_not_permitted(result: Result<(), WorkerError>, permission: &str) {
    match result {
        Err(WorkerError::NotPermitted { permission: p, .. }) => assert_eq!(p, permission),
        other => panic!("expected NotPermitted({permission}), got {other:?}"),
    }
}

#[test]
fn only_the_author_writes_the_policy() {
    let mut m = model();
    let (headline, _) = text_frame(&mut m, 100.0);
    // The default session is an editor: it edits, but not the template.
    let write = Mutation::SetPluginMetadata {
        element_id: headline.clone(),
        key: TEMPLATE_KEY.into(),
        value: Some(ItemPolicy::default().to_label()),
        caller: None,
    };
    assert_not_permitted(m.apply_mutation(&write).map(|_| ()), "template.author");
    role(&mut m, Role::Author);
    m.apply_mutation(&write).expect("the author writes it");
}

#[test]
fn a_filler_types_into_a_field_and_not_into_scenery() {
    let mut m = model();
    role(&mut m, Role::Author);
    let (headline, headline_story) = text_frame(&mut m, 100.0);
    let (_body, body_story) = text_frame(&mut m, 200.0);
    make_field(&mut m, &headline, "headline", FieldKind::Text);
    role(&mut m, Role::Filler);
    type_into(&mut m, &headline_story).expect("the field takes text");
    assert_not_permitted(type_into(&mut m, &body_story), "text.edit");
    assert_not_permitted(
        m.apply_mutation(&Mutation::SetDocumentDefaults {
            fill_color: None,
            stroke_color: None,
            stroke_weight: None,
        })
        .map(|_| ()),
        "document.styles",
    );
}

#[test]
fn a_drag_the_filler_may_not_commit_is_refused_at_begin() {
    let mut m = model();
    role(&mut m, Role::Author);
    let photo = rect(&mut m, (100.0, 100.0, 160.0, 140.0));
    make_field(&mut m, &photo, "photo", FieldKind::Image);
    role(&mut m, Role::Filler);
    match m.begin_gesture(vec![photo.clone()], GestureType::Translate, None) {
        Err(GestureError::NotPermitted(id, permission)) => {
            assert_eq!(id, photo);
            assert_eq!(permission, "item.move");
        }
        other => panic!("expected NotPermitted, got {other:?}"),
    }
}

#[test]
fn a_filler_clicks_through_scenery_to_the_field_beneath() {
    let mut m = model();
    role(&mut m, Role::Author);
    let photo = rect(&mut m, (100.0, 100.0, 160.0, 140.0));
    let overlay = rect(&mut m, (100.0, 100.0, 160.0, 140.0));
    make_field(&mut m, &photo, "photo", FieldKind::Image);
    let p = page(&m);
    let point = (120.0, 130.0);
    assert_eq!(
        m.hit_test(&p, point).element,
        Some(overlay),
        "the top item, for an author"
    );
    role(&mut m, Role::Filler);
    assert_eq!(
        m.hit_test(&p, point).element,
        Some(photo),
        "the field, for a filler"
    );
    role(&mut m, Role::Viewer);
    assert_eq!(m.hit_test(&p, point).element, None, "nothing, for a viewer");
}

#[test]
fn a_locked_items_refusal_is_typed() {
    let mut m = model();
    let f = rect(&mut m, (100.0, 100.0, 160.0, 140.0));
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: f.clone(),
        path: PropertyPath::ElementLocked,
        value: Value::Bool(true),
    })
    .expect("lock");
    match m.apply_mutation(&Mutation::DeleteFrame {
        frame_id: f.raw_id().to_string(),
    }) {
        Err(WorkerError::Locked { action, .. }) => assert_eq!(action, "delete it"),
        other => panic!("expected Locked, got {other:?}"),
    }
}
