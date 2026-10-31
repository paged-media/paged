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

//! Engine ADR 1030 — every undo step has a name. A wire mutation, a
//! gesture and a text edit name their step by default; a caller's label
//! wins; an amend keeps the step's name; the log reads oldest first; and
//! `undo_to` / `redo_to` move several steps in one call.
//!
//! The `__feat__` suffix links each test to its cockpit feature.
#![allow(non_snake_case)]

use std::io::Write;

use paged_canvas::{
    channel::Mutation,
    gesture::{GestureModifiers, GestureType},
    undo_label::{self, UndoLabel},
    CanvasModel, CanvasOptions, ElementId, PageId,
};
use paged_mutate::{PropertyPath, Value};

fn idml() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/vnd.adobe.indesign-idml-package")
            .unwrap();
        zip.start_file("designmap.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="13.1" Self="d1">
<idPkg:Spread src="Spreads/Spread_s1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
</Document>"#,
        )
        .unwrap();
        zip.start_file("Spreads/Spread_s1.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="1">
<Page Self="p1" Name="1" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
</Spread></idPkg:Spread>"#,
        )
        .unwrap();
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    CanvasModel::load("doc", &idml(), CanvasOptions::default()).expect("load")
}

fn frame_at(x: f32) -> Mutation {
    Mutation::InsertTextFrame {
        page_id: PageId("p1".into()),
        bounds: (x, 20.0, x + 100.0, 120.0),
    }
}

/// The labels of the undo log, oldest first.
fn undo_labels(model: &CanvasModel) -> Vec<String> {
    model
        .undo_log(usize::MAX)
        .undo
        .into_iter()
        .map(|e| e.label.text)
        .collect()
}

fn redo_labels(model: &CanvasModel) -> Vec<String> {
    model
        .undo_log(usize::MAX)
        .redo
        .into_iter()
        .map(|e| e.label.text)
        .collect()
}

fn frame_id(model: &mut CanvasModel) -> (String, ElementId) {
    let out = model.apply_mutation(&frame_at(20.0)).expect("insert");
    let id = out.created_id.expect("a frame was created");
    (id.raw_id().to_string(), id)
}

#[test]
fn each_op_kind_names_its_step__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    let (raw, _) = frame_id(&mut model);
    model
        .apply_mutation(&Mutation::MoveFrame {
            frame_id: raw.clone(),
            transform: [1.0, 0.0, 0.0, 1.0, 30.0, 0.0],
        })
        .expect("move");
    model
        .apply_mutation(&Mutation::ResizeFrame {
            frame_id: raw.clone(),
            bounds: (20.0, 20.0, 220.0, 220.0),
        })
        .expect("resize");
    model
        .apply_mutation(&Mutation::Batch {
            ops: vec![frame_at(300.0), frame_at(420.0)],
        })
        .expect("batch of one kind");
    model
        .apply_mutation(&Mutation::Batch {
            ops: vec![
                frame_at(10.0),
                Mutation::MoveFrame {
                    frame_id: raw,
                    transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                },
            ],
        })
        .expect("mixed batch");
    assert_eq!(
        undo_labels(&model),
        [
            "Insert text frame",
            "Move",
            "Resize",
            "Insert text frame",
            "Multiple changes"
        ]
    );
    let keys: Vec<Option<String>> = model
        .undo_log(2)
        .undo
        .into_iter()
        .map(|e| e.label.key)
        .collect();
    assert_eq!(
        keys,
        [Some("insertTextFrame".into()), Some("batch".into())],
        "the limit keeps the newest steps, oldest first"
    );
}

#[test]
fn property_writes_read_as_the_property__feat__plugin_platform_undo_log_labels() {
    let fill = Mutation::SetElementProperty {
        element_id: ElementId::Rectangle("r1".into()),
        path: PropertyPath::FrameFillColor,
        value: Value::ColorRef(Some("Color/Red".into())),
    };
    assert_eq!(undo_label::for_mutation(&fill).text, "Change fill");
    assert_eq!(
        undo_label::for_mutation(&fill).key.as_deref(),
        Some("set:frame.fillColor")
    );
    let weight = Mutation::SetElementProperty {
        element_id: ElementId::Rectangle("r1".into()),
        path: PropertyPath::FrameStrokeWeight,
        value: Value::Length(Some(2.0)),
    };
    assert_eq!(
        undo_label::for_mutation(&weight).text,
        "Change stroke weight"
    );
    assert_eq!(undo_label::humanize("InsertTextFrame"), "Insert text frame");
    // Every wire op has a non-empty default.
    for name in paged_wire::MUTATION_NAMES {
        assert!(!undo_label::humanize(name).is_empty(), "{name}");
    }
}

#[test]
fn a_gesture_names_its_step__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    let (_, id) = frame_id(&mut model);
    let handle = model
        .begin_gesture(vec![id.clone()], GestureType::Translate, None)
        .expect("begin");
    model
        .update_gesture(
            handle,
            (10.0, 20.0),
            GestureModifiers {
                shift: false,
                alt: false,
                disable_snap: false,
            },
        )
        .expect("update");
    model.commit_gesture(handle).expect("commit");
    assert_eq!(undo_labels(&model), ["Insert text frame", "Move"]);
    assert_eq!(
        undo_label::for_gesture(&GestureType::Rotate, false).text,
        "Rotate"
    );
    assert_eq!(
        undo_label::for_gesture(&GestureType::Translate, true).text,
        "Duplicate"
    );
}

#[test]
fn an_explicit_label_wins__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    model
        .apply_mutation_labeled(&frame_at(20.0), Some("Add caption"))
        .expect("labeled");
    model
        .apply_mutation_labeled(&frame_at(200.0), Some("   "))
        .expect("blank label keeps the default");
    assert_eq!(undo_labels(&model), ["Add caption", "Insert text frame"]);
    let log = model.undo_log(usize::MAX);
    assert_eq!(log.undo[0].label.key, None, "a caller's label has no key");
    assert_eq!(UndoLabel::explicit(""), None);
    // The name survives undo and redo.
    model.undo().expect("undo");
    model.undo().expect("undo");
    assert_eq!(redo_labels(&model), ["Add caption", "Insert text frame"]);
    model.redo().expect("redo");
    assert_eq!(undo_labels(&model), ["Add caption"]);
}

#[test]
fn an_amend_keeps_the_steps_name__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    let edit = model
        .apply_mutation_labeled(&frame_at(20.0), Some("Add caption"))
        .expect("edit");
    model
        .apply_mutation_amending(
            &Mutation::Batch {
                ops: vec![frame_at(300.0), frame_at(420.0)],
            },
            edit.applied_seq,
        )
        .expect("amend");
    assert_eq!(undo_labels(&model), ["Add caption"]);
}

#[test]
fn undo_to_and_redo_to_move_several_steps__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    let h0 = model.current_state_hash();
    let s1 = model
        .apply_mutation(&frame_at(20.0))
        .expect("1")
        .applied_seq;
    let h1 = model.current_state_hash();
    let s2 = model
        .apply_mutation(&frame_at(150.0))
        .expect("2")
        .applied_seq;
    let s3 = model
        .apply_mutation(&frame_at(300.0))
        .expect("3")
        .applied_seq;
    let h3 = model.current_state_hash();

    // The state after step 1: undo down to (and including) step 2.
    let undone = model.undo_to(s2).expect("undo to 2");
    assert_eq!(undone.len(), 2);
    assert_eq!(model.current_state_hash(), h1);
    let log = model.undo_log(usize::MAX);
    assert_eq!(
        log.undo.iter().map(|e| e.applied_seq).collect::<Vec<_>>(),
        [s1]
    );
    assert_eq!(
        log.redo.iter().map(|e| e.applied_seq).collect::<Vec<_>>(),
        [s2, s3],
        "next redo first"
    );

    // A step that is not on the undo log is refused, and nothing moves.
    assert!(model.undo_to(s3).is_err());
    assert_eq!(model.current_state_hash(), h1);

    // Redo to the last step in one call.
    let redone = model.redo_to(s3).expect("redo to 3");
    assert_eq!(redone.len(), 2);
    assert_eq!(model.current_state_hash(), h3);
    assert!(model.redo_to(s3).is_err(), "redo log is empty now");

    // Undo everything, back to the opened document.
    model.undo_to(s1).expect("undo to 1");
    assert_eq!(model.current_state_hash(), h0);
}

#[test]
fn the_history_depth_evicts_the_oldest__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    for i in 0..5 {
        model
            .apply_mutation(&frame_at(10.0 + i as f32 * 50.0))
            .expect("insert");
    }
    assert_eq!(model.set_history_depth(3), 3);
    assert_eq!(model.applied_log_len(), 3);
    model.apply_mutation(&frame_at(400.0)).expect("insert");
    assert_eq!(model.applied_log_len(), 3);
    assert_eq!(model.undo_log(usize::MAX).depth, 3);
    assert_eq!(model.undo_log(usize::MAX).evicted, 3, "two, then one");
    assert_eq!(model.set_history_depth(0), 1, "clamped to at least one");
    assert_eq!(
        model.set_history_depth(usize::MAX),
        paged_canvas::MAX_APPLIED_LOG
    );
}

#[test]
fn a_restore_is_one_undoable_step__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    let h0 = model.current_state_hash();
    let s1 = model
        .apply_mutation(&frame_at(20.0))
        .expect("1")
        .applied_seq;
    let h1 = model.current_state_hash();
    model.apply_mutation(&frame_at(150.0)).expect("2");
    model.apply_mutation(&frame_at(300.0)).expect("3");
    let h3 = model.current_state_hash();

    // Back to the state after step 1, as ONE new step.
    model
        .restore_to(s1, Some("Restore “Draft”"))
        .expect("restore");
    assert_eq!(model.current_state_hash(), h1);
    assert_eq!(
        undo_labels(&model),
        [
            "Insert text frame",
            "Insert text frame",
            "Insert text frame",
            "Restore “Draft”"
        ],
        "the walked-over steps stay; the restore is one step on top"
    );
    assert_eq!(model.redo_log_len(), 0);

    // One undo brings steps 2 and 3 back; one redo restores again.
    model.undo().expect("undo the restore");
    assert_eq!(model.current_state_hash(), h3);
    model.redo().expect("redo the restore");
    assert_eq!(model.current_state_hash(), h1);

    // The opened document (seq 0), and a refusal for the current step.
    model
        .restore_to(0, None)
        .expect("restore to the opened document");
    assert_eq!(model.current_state_hash(), h0);
    assert_eq!(undo_labels(&model).last().unwrap(), "Restore");
    let top = model.undo_log(1).undo[0].applied_seq;
    assert!(model.restore_to(top, None).is_err());
    model.undo().expect("undo");
    assert_eq!(model.current_state_hash(), h1);
}

#[test]
fn a_restore_forward_replays_as_one_step__feat__plugin_platform_undo_log_labels() {
    let mut model = load();
    let h0 = model.current_state_hash();
    model.apply_mutation(&frame_at(20.0)).expect("1");
    let s2 = model
        .apply_mutation(&frame_at(150.0))
        .expect("2")
        .applied_seq;
    let h2 = model.current_state_hash();
    model.undo().expect("undo");
    model.undo().expect("undo");
    assert_eq!(model.current_state_hash(), h0);
    model.restore_to(s2, None).expect("restore forward");
    assert_eq!(model.current_state_hash(), h2);
    assert_eq!(
        model.applied_log_len(),
        1,
        "the replayed steps are one step"
    );
    model.undo().expect("undo");
    assert_eq!(model.current_state_hash(), h0);
}
