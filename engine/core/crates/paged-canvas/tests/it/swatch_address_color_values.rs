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

//! A colour value written as a swatch ADDRESS (`swatch:Color/Red`, or
//! `swatch:Red` by name) is stored as the swatch's `Self` id. Stored
//! verbatim it named no colour: the renderer painted the object black or
//! not at all while the write reported success — found when a script
//! author (Claude, following the catalog's address grammar) coloured a
//! whole document that way and none of it showed.

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions};
use paged_mutate::{PropertyPath, StyleCollection, Value};
use paged_wire::Address;

fn blank_with_frame() -> (CanvasModel, paged_canvas::element_selection::ElementId) {
    let mut m = CanvasModel::new_blank("swatch-values", 595.0, 842.0, CanvasOptions::default())
        .expect("blank");
    let page = m.page_ids().next().expect("a page").clone();
    let out = m
        .apply_mutation(&Mutation::InsertFrame {
            page_id: page,
            bounds: (50.0, 50.0, 250.0, 250.0),
        })
        .expect("insert");
    (m, out.created_id.expect("a frame"))
}

fn fill(m: &CanvasModel, id: &paged_canvas::element_selection::ElementId) -> Value {
    m.get_property_at(&Address::parse(&id_address(id)).unwrap(), "frameFillColor")
        .expect("read")
}

fn id_address(id: &paged_canvas::element_selection::ElementId) -> String {
    serde_json::to_value(id)
        .ok()
        .and_then(|v| {
            let kind = v.get("kind")?.as_str()?.to_string();
            let raw = v.get("id")?.as_str()?.to_string();
            Some(format!("{kind}:{raw}"))
        })
        .expect("element address")
}

#[test]
fn a_swatch_address_by_id_is_stored_as_the_swatch_id() {
    let (mut m, frame) = blank_with_frame();
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: frame.clone(),
        path: PropertyPath::FrameFillColor,
        value: Value::ColorRef(Some("swatch:Color/Black".into())),
    })
    .expect("set");
    assert_eq!(
        fill(&m, &frame),
        Value::ColorRef(Some("Color/Black".into()))
    );
}

#[test]
fn a_swatch_address_by_name_resolves_too_and_set_by_address_is_covered() {
    let (mut m, frame) = blank_with_frame();
    m.apply_mutation(&Mutation::Set {
        address: Address::parse(&id_address(&frame)).unwrap(),
        path: "frameFillColor".into(),
        value: Value::ColorRef(Some("swatch:Black".into())),
    })
    .expect("set by address");
    assert_eq!(
        fill(&m, &frame),
        Value::ColorRef(Some("Color/Black".into()))
    );
}

#[test]
fn ids_unknown_addresses_and_batches_behave() {
    let (mut m, frame) = blank_with_frame();
    // An id stays an id.
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: frame.clone(),
        path: PropertyPath::FrameFillColor,
        value: Value::ColorRef(Some("Color/Black".into())),
    })
    .expect("set");
    assert_eq!(
        fill(&m, &frame),
        Value::ColorRef(Some("Color/Black".into()))
    );
    // Inside a batch, the child is rewritten as well.
    m.apply_mutation(&Mutation::Batch {
        ops: vec![Mutation::SetElementProperty {
            element_id: frame.clone(),
            path: PropertyPath::FrameStrokeColor,
            value: Value::ColorRef(Some("swatch:Color/Black".into())),
        }],
    })
    .expect("batch");
    assert_eq!(
        m.get_property_at(
            &Address::parse(&id_address(&frame)).unwrap(),
            "frameStrokeColor"
        )
        .unwrap(),
        Value::ColorRef(Some("Color/Black".into()))
    );
}

#[test]
fn a_style_colour_by_address_is_stored_as_the_id() {
    let (mut m, _) = blank_with_frame();
    let style = m
        .paragraph_styles()
        .first()
        .map(|s| s.self_id.clone())
        .expect("a paragraph style");
    m.apply_mutation(&Mutation::SetStyleProperty {
        collection: StyleCollection::Paragraph,
        style_id: style.clone(),
        path: PropertyPath::CharacterFillColor,
        value: Value::ColorRef(Some("swatch:Color/Black".into())),
    })
    .expect("style set");
    let address = Address::parse(&format!(
        "style:paragraph/{}",
        style.trim_start_matches("ParagraphStyle/")
    ))
    .unwrap();
    assert_eq!(
        m.get_property_at(&address, "characterFillColor").unwrap(),
        Value::ColorRef(Some("Color/Black".into()))
    );
}
