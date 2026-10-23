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

//! Template permissions at the operation level (the editor's
//! `docs/composable-editor.md` §7.7, `apply::permit`): a filler session may
//! do to a template what its policy permits and nothing else, whichever
//! operation asks; a batch is refused whole; undo is exempt; the policy
//! protects itself; an editor or an author is not bound by it.

use std::path::PathBuf;

use paged_mutate::operation::NodeSpec;
use paged_mutate::{apply, apply_checked, NodeId, Operation, OperationError, PropertyPath, Value};
use paged_scene::Document;
use paged_template::{
    DocumentPolicy, FieldDef, ItemPolicy, Override, Permission, Role, SessionPolicy,
    TemplateFieldKind, TEMPLATE_KEY,
};

fn fixture() -> Document {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("corpus")
        .join("generated")
        .join("geometry.idml");
    let bytes = std::fs::read(path).expect("read geometry fixture");
    idml_import::import_idml_doc(&bytes).expect("open")
}

fn add_rect(doc: &mut Document, id: &str, x: f32) -> NodeId {
    let parent = NodeId::Spread(doc.spreads[0].spread.self_id.clone().expect("spread id"));
    let position = doc.spreads[0].spread.rectangles.len();
    apply(
        doc,
        &Operation::InsertNode {
            parent,
            position,
            z_slot: None,
            node: NodeSpec::Rectangle {
                self_id: id.to_string(),
                bounds: [100.0, x, 160.0, x + 40.0],
                fill_color: Some("Color/Black".to_string()),
                stroke_color: None,
                stroke_weight: None,
                item_transform: None,
            },
        },
    )
    .unwrap_or_else(|e| panic!("insert {id}: {e:?}"));
    NodeId::Rectangle(id.to_string())
}

fn label(node: &NodeId, value: String) -> Operation {
    Operation::SetProperty {
        node: node.clone(),
        path: PropertyPath::PluginMetadata,
        value: Value::PluginMetadata {
            key: TEMPLATE_KEY.to_string(),
            value: Some(value),
            caller: None,
            prev: None,
        },
    }
}

fn field(name: &str, kind: TemplateFieldKind) -> FieldDef {
    FieldDef {
        name: name.into(),
        kind,
        label: None,
        help: None,
        group: None,
        required: false,
        constraints: Default::default(),
        module: None,
    }
}

/// A template: `photo` is an image field that may also be cropped, `logo`
/// is scenery, and the document lets a filler do nothing by default.
fn template() -> (Document, NodeId, NodeId) {
    let mut doc = fixture();
    let photo = add_rect(&mut doc, "photo", 50.0);
    let logo = add_rect(&mut doc, "logo", 200.0);
    let photo_policy = ItemPolicy {
        field: Some(field("photo", TemplateFieldKind::Image)),
        allow: vec![Permission::ImageCrop],
        ..Default::default()
    };
    apply(&mut doc, &label(&photo, photo_policy.to_label())).expect("photo policy");
    apply(
        &mut doc,
        &Operation::SetDocumentMetadata {
            key: TEMPLATE_KEY.to_string(),
            value: Some(DocumentPolicy::default().to_label()),
            caller: None,
        },
    )
    .expect("document policy");
    (doc, photo, logo)
}

fn session(role: Role) -> SessionPolicy {
    SessionPolicy {
        role,
        overrides: vec![],
    }
}

fn move_op(node: &NodeId) -> Operation {
    Operation::SetProperty {
        node: node.clone(),
        path: PropertyPath::FrameBounds,
        value: Value::Bounds([110.0, 60.0, 170.0, 100.0]),
    }
}

fn assert_refused(result: Result<impl std::fmt::Debug, OperationError>, permission: &str) {
    match result {
        Err(OperationError::NotPermitted { permission: p, .. }) => assert_eq!(p, permission),
        other => panic!("expected NotPermitted({permission}), got {other:?}"),
    }
}

#[test]
fn a_filler_replaces_and_crops_a_field_and_nothing_else() {
    let (mut doc, photo, logo) = template();
    let filler = session(Role::Filler);
    apply_checked(
        &mut doc,
        &Operation::PlaceImage {
            frame: photo.clone(),
            image_uri: Some("file:///new.png".into()),
            fit: None,
        },
        &filler,
    )
    .expect("the field takes a picture");
    apply_checked(
        &mut doc,
        &Operation::SetProperty {
            node: photo.clone(),
            path: PropertyPath::ImageContentTransform,
            value: Value::Transform(Some([1.0, 0.0, 0.0, 1.0, 5.0, 5.0])),
        },
        &filler,
    )
    .expect("crop was granted on the item");

    assert_refused(
        apply_checked(&mut doc, &move_op(&photo), &filler),
        "item.resize",
    );
    assert_refused(
        apply_checked(
            &mut doc,
            &Operation::RemoveNode { node: logo.clone() },
            &filler,
        ),
        "item.delete",
    );
    assert_refused(
        apply_checked(
            &mut doc,
            &Operation::PlaceImage {
                frame: logo.clone(),
                image_uri: Some("file:///x.png".into()),
                fit: None,
            },
            &filler,
        ),
        "image.replace",
    );
}

#[test]
fn a_batch_is_refused_whole_before_anything_applies() {
    let (mut doc, photo, logo) = template();
    let before = serde_json::to_string(&doc.spreads[0].spread).unwrap();
    let batch = Operation::Batch {
        ops: vec![
            Operation::PlaceImage {
                frame: photo.clone(),
                image_uri: Some("file:///ok.png".into()),
                fit: None,
            },
            Operation::RemoveNode { node: logo },
        ],
    };
    assert_refused(
        apply_checked(&mut doc, &batch, &session(Role::Filler)),
        "item.delete",
    );
    assert_eq!(
        serde_json::to_string(&doc.spreads[0].spread).unwrap(),
        before
    );
}

#[test]
fn the_policy_protects_itself() {
    let (mut doc, photo, logo) = template();
    let open_up = label(
        &logo,
        ItemPolicy {
            allow: vec![Permission::ItemDelete],
            ..Default::default()
        }
        .to_label(),
    );
    assert_refused(
        apply_checked(&mut doc, &open_up, &session(Role::Filler)),
        "template.author",
    );
    assert_refused(
        apply_checked(&mut doc, &open_up, &session(Role::Editor)),
        "template.author",
    );
    apply_checked(&mut doc, &open_up, &session(Role::Author))
        .expect("the author writes the policy");
    let allowed = SessionPolicy {
        role: Role::Editor,
        overrides: vec![(Permission::TemplateAuthor, Override::Allow)],
    };
    let doc_policy = Operation::SetDocumentMetadata {
        key: TEMPLATE_KEY.into(),
        value: Some(DocumentPolicy::default().to_label()),
        caller: None,
    };
    apply_checked(&mut doc, &doc_policy, &allowed).expect("a host may let an editor author");

    // Renaming a field's item renames the field: the author's call.
    let rename = |node: &NodeId| Operation::SetProperty {
        node: node.clone(),
        path: PropertyPath::ItemName,
        value: Value::Text("other".into()),
    };
    assert_refused(
        apply_checked(&mut doc, &rename(&photo), &session(Role::Editor)),
        "template.author",
    );
    apply_checked(&mut doc, &rename(&logo), &session(Role::Editor))
        .expect("an editor renames scenery");
}

#[test]
fn an_editor_and_an_author_are_not_bound_and_a_viewer_changes_nothing() {
    let (mut doc, _photo, logo) = template();
    apply_checked(&mut doc, &move_op(&logo), &session(Role::Editor)).expect("editor moves");
    apply_checked(&mut doc, &move_op(&logo), &session(Role::Author)).expect("author moves");
    assert_refused(
        apply_checked(&mut doc, &move_op(&logo), &session(Role::Viewer)),
        "item.resize",
    );
}

#[test]
fn overrides_open_or_close_one_permission_for_the_session() {
    let (mut doc, photo, logo) = template();
    let host = SessionPolicy {
        role: Role::Filler,
        overrides: vec![
            (Permission::ItemResize, Override::Allow),
            (Permission::ImageReplace, Override::Deny),
        ],
    };
    apply_checked(&mut doc, &move_op(&logo), &host).expect("allowed for the session");
    assert_refused(
        apply_checked(
            &mut doc,
            &Operation::PlaceImage {
                frame: photo,
                image_uri: Some("file:///n.png".into()),
                fit: None,
            },
            &host,
        ),
        "image.replace",
    );
}

#[test]
fn undo_is_exempt_whatever_the_role_is_now() {
    let (mut doc, _photo, logo) = template();
    // The author moves the logo, then previews as a filler and undoes.
    let applied = apply_checked(&mut doc, &move_op(&logo), &session(Role::Author)).expect("move");
    apply(&mut doc, &applied.inverse).expect("the inverse applies without the policy");
}

#[test]
fn parent_pages_are_page_setup() {
    let required = paged_mutate::apply::permit::required(&Operation::OnMaster {
        master_id: "A-Master".into(),
        op: Box::new(Operation::RemoveNode {
            node: NodeId::Rectangle("x".into()),
        }),
    });
    assert_eq!(required.len(), 1);
    assert_eq!(required[0].permission, Permission::DocumentPages);
}

/// A module field opens its own plugin's document-level label to a filler
/// (a sheet's workbook version lives there), and no other plugin's.
#[test]
fn a_module_field_opens_its_own_plugins_document_label() {
    let (mut doc, _photo, _logo) = template();
    let sheet = add_rect(&mut doc, "sheet", 300.0);
    let policy: ItemPolicy = serde_json::from_value(serde_json::json!({
        "field": {
            "name": "price",
            "kind": "module",
            "module": { "kind": "media.paged.sheet.cell", "grants": ["text.edit"], "def": { "ref": "B4" } }
        }
    }))
    .unwrap();
    apply(&mut doc, &label(&sheet, policy.to_label())).expect("sheet policy");
    let filler = session(Role::Filler);
    let doc_label = |key: &str| Operation::SetDocumentMetadata {
        key: key.to_string(),
        value: Some(r#"{"v":1,"data":{}}"#.to_string()),
        caller: None,
    };
    apply_checked(&mut doc, &doc_label("x-paged:media.paged.sheet"), &filler)
        .expect("the sheet's own state");
    assert_refused(
        apply_checked(&mut doc, &doc_label("x-paged:media.paged.web"), &filler),
        "document.metadata",
    );
    assert_refused(
        apply_checked(&mut doc, &doc_label(TEMPLATE_KEY), &filler),
        "template.author",
    );
    // A session override still closes it.
    let closed = SessionPolicy {
        role: Role::Filler,
        overrides: vec![(Permission::DocumentMetadata, Override::Deny)],
    };
    assert_refused(
        apply_checked(&mut doc, &doc_label("x-paged:media.paged.sheet"), &closed),
        "document.metadata",
    );
}
