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

//! Engine ADR 1004 — a mutation can join the undo step of the commit
//! before it (`apply_mutation_amending`, the wire's `AmendMutation`): one
//! undo reverts both, one redo replays both. It is refused once that step
//! is no longer the last one, or an undo or a redo ran since, and a refused
//! amend applies nothing.

use std::io::Write;

use paged_canvas::{channel::Mutation, channel::WorkerError, CanvasModel, CanvasOptions, PageId};

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

fn frames(model: &CanvasModel) -> usize {
    model.scene().stories.len()
}

fn refused(r: Result<impl std::fmt::Debug, WorkerError>) -> String {
    match r {
        Err(WorkerError::NotAmendable { reason, .. }) => reason,
        other => panic!("expected NotAmendable, got {other:?}"),
    }
}

#[test]
fn an_amend_joins_the_step_and_one_undo_reverts_both() {
    let mut model = load();
    let h0 = model.current_state_hash();
    let edit = model.apply_mutation(&frame_at(20.0)).expect("edit");
    let steps = model.applied_log_len();
    let rebuild = model
        .apply_mutation_amending(&frame_at(200.0), edit.applied_seq)
        .expect("amend");
    let h_both = model.current_state_hash();
    assert_eq!(frames(&model), 2);
    assert_eq!(model.applied_log_len(), steps, "no new undo step");
    assert!(rebuild.applied_seq > edit.applied_seq);

    model.undo().expect("undo");
    assert_eq!(model.current_state_hash(), h0, "one undo reverts both");
    assert_eq!(frames(&model), 0);

    model.redo().expect("redo");
    assert_eq!(model.current_state_hash(), h_both, "one redo replays both");
    assert_eq!(frames(&model), 2);
}

#[test]
fn the_amended_step_stays_amendable_under_its_new_seq() {
    let mut model = load();
    let h0 = model.current_state_hash();
    let edit = model.apply_mutation(&frame_at(20.0)).expect("edit");
    let first = model
        .apply_mutation_amending(&frame_at(150.0), edit.applied_seq)
        .expect("first amend");
    // The old seq no longer names the step; the reply's does.
    refused(model.apply_mutation_amending(&frame_at(300.0), edit.applied_seq));
    model
        .apply_mutation_amending(
            &Mutation::Batch {
                ops: vec![frame_at(300.0), frame_at(420.0)],
            },
            first.applied_seq,
        )
        .expect("second amend, a batch");
    assert_eq!(frames(&model), 4);
    assert_eq!(model.applied_log_len(), 1);
    model.undo().expect("undo");
    assert_eq!(model.current_state_hash(), h0);
}

#[test]
fn an_amend_is_refused_after_a_newer_step() {
    let mut model = load();
    let edit = model.apply_mutation(&frame_at(20.0)).expect("edit");
    model.apply_mutation(&frame_at(200.0)).expect("newer step");
    let h = model.current_state_hash();
    let why = refused(model.apply_mutation_amending(&frame_at(400.0), edit.applied_seq));
    assert!(why.contains("no longer the last step"), "{why}");
    assert_eq!(
        model.current_state_hash(),
        h,
        "a refused amend applies nothing"
    );
    assert_eq!(model.applied_log_len(), 2);
}

#[test]
fn an_amend_is_refused_after_an_undo() {
    let mut model = load();
    let before = model.apply_mutation(&frame_at(20.0)).expect("before");
    let edit = model.apply_mutation(&frame_at(200.0)).expect("edit");
    model.undo().expect("undo");
    // The undone step is gone, and the step it uncovered is not the one
    // a rebuild of the undone edit would join.
    refused(model.apply_mutation_amending(&frame_at(400.0), edit.applied_seq));
    let why = refused(model.apply_mutation_amending(&frame_at(400.0), before.applied_seq));
    assert!(why.contains("undo or a redo"), "{why}");
    assert_eq!(frames(&model), 1);
    assert_eq!(model.redo_log_len(), 1, "a refused amend keeps the redo");
}

#[test]
fn an_amend_is_refused_after_a_redo() {
    let mut model = load();
    let edit = model.apply_mutation(&frame_at(20.0)).expect("edit");
    model.undo().expect("undo");
    model.redo().expect("redo");
    let why = refused(model.apply_mutation_amending(&frame_at(400.0), edit.applied_seq));
    assert!(why.contains("undo or a redo"), "{why}");
    assert_eq!(frames(&model), 1);
}

#[test]
fn an_amend_on_an_empty_history_is_refused() {
    let mut model = load();
    refused(model.apply_mutation_amending(&frame_at(20.0), 1));
    assert_eq!(frames(&model), 0);
}
