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

//! `FrameBounds` on `Oval` — the arm every sibling property already had.
//!
//! Ovals carried FillColor/StrokeColor/StrokeWeight/Opacity/Transform
//! arms but not FrameBounds, so the unrotated translate GESTURE (whose
//! canonical commit op is `SetProperty { FrameBounds }`) failed on any
//! oval with "property FrameBounds is not supported on Oval". Found by
//! the 2026-08-17 corpus sweep (cultured-business-newsletter) once the
//! editor surfaced the `GestureFailure::Other` message. This pins the
//! arm: forward moves the bounds, inverse restores bytewise.

use paged_mutate::{apply, NodeId, Operation, PropertyPath, Value};
use paged_scene::Document;

fn fixture_bytes() -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("corpus")
        .join("generated")
        .join("strokes-fills.idml");
    std::fs::read(path).expect("read strokes-fills fixture")
}

fn first_oval(doc: &Document) -> String {
    doc.spreads
        .iter()
        .flat_map(|s| s.spread.ovals.iter())
        .filter_map(|o| o.self_id.clone())
        .next()
        .expect("fixture has an oval with a self id")
}

fn bounds_of(doc: &Document, id: &str) -> [f32; 4] {
    let b = doc
        .spreads
        .iter()
        .flat_map(|s| s.spread.ovals.iter())
        .find(|o| o.self_id.as_deref() == Some(id))
        .expect("oval present")
        .bounds;
    [b.top, b.left, b.bottom, b.right]
}

#[test]
fn frame_bounds_on_oval_round_trips() {
    let mut doc = idml_import::import_idml_doc(&fixture_bytes()).expect("open");
    let id = first_oval(&doc);
    let before = bounds_of(&doc, &id);
    let target = [
        before[0] + 10.0,
        before[1] + 10.0,
        before[2] + 10.0,
        before[3] + 10.0,
    ];
    let applied = apply(
        &mut doc,
        &Operation::SetProperty {
            node: NodeId::Oval(id.clone()),
            path: PropertyPath::FrameBounds,
            value: Value::Bounds(target),
        },
    )
    .expect("FrameBounds applies to an oval — the translate-gesture commit op");
    assert_eq!(bounds_of(&doc, &id), target, "forward moves the oval");
    apply(&mut doc, &applied.inverse).expect("inverse apply");
    assert_eq!(bounds_of(&doc, &id), before, "inverse restores bytewise");
}
