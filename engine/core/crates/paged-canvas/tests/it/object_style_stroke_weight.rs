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

//! Engine ADR 1316 — a frame that applies an object style is stroked at the
//! style's weight. The writes a script makes (`createObjectStyle`,
//! `setStyleProperty('object', …, 'frameStrokeWeight', 3)`, `set(frame,
//! 'appliedObjectStyle', …)`) all landed: the style held 3 pt and the frame
//! named it. The drawing lost it: the frame was stroked at 1 pt.

use paged_canvas::{channel::Mutation, CanvasModel, CanvasOptions, PageId};
use paged_compose::DisplayCommand;
use paged_mutate::{PropertyPath as P, StyleCollection, Value};
use paged_wire::ElementId;

const STYLE: &str = "ObjectStyle/Callout";

fn apply(m: &mut CanvasModel, mutation: Mutation) {
    m.apply_mutation(&mutation)
        .unwrap_or_else(|e| panic!("{}: {e:?}", mutation.discriminant()));
}

/// A blank page holding one text frame, as the scripting lab's seed makes
/// it, with the "Callout" style the lab's theme defines applied to it.
fn styled_frame() -> (CanvasModel, ElementId) {
    let mut m =
        CanvasModel::new_blank("stroke", 612.0, 792.0, CanvasOptions::default()).expect("blank");
    let page = PageId(m.pages()[0].self_id.clone());
    let frame = m
        .apply_mutation(&Mutation::InsertTextFrame {
            page_id: page,
            bounds: (144.0, 72.0, 360.0, 540.0),
        })
        .expect("text frame")
        .created_id
        .expect("its id");
    apply(
        &mut m,
        Mutation::CreateObjectStyle {
            self_id: Some(STYLE.into()),
            name: Some("Callout".into()),
            based_on: None,
        },
    );
    for (path, value) in [
        (P::FrameStrokeWeight, Value::Length(Some(3.0))),
        (
            P::FrameStrokeColor,
            Value::ColorRef(Some("Color/Black".into())),
        ),
        (
            P::FrameFillColor,
            Value::ColorRef(Some("Color/Black".into())),
        ),
        (P::FrameFillTint, Value::Length(Some(10.0))),
    ] {
        apply(
            &mut m,
            Mutation::SetStyleProperty {
                collection: StyleCollection::Object,
                style_id: STYLE.into(),
                path,
                value,
            },
        );
    }
    apply(
        &mut m,
        Mutation::SetElementProperty {
            element_id: frame.clone(),
            path: P::AppliedObjectStyle,
            value: Value::Text(STYLE.into()),
        },
    );
    (m, frame)
}

/// The widths of the strokes the page draws.
fn stroke_widths(m: &CanvasModel) -> Vec<f32> {
    let page = PageId(m.pages()[0].self_id.clone());
    m.display_list_for_page(&page)
        .expect("display list")
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::StrokePath { stroke, .. }
            | DisplayCommand::StrokePathOverprint { stroke, .. } => Some(stroke.width),
            _ => None,
        })
        .collect()
}

#[test]
fn a_frame_is_stroked_at_its_object_styles_weight() {
    let (m, _) = styled_frame();
    assert_eq!(stroke_widths(&m), vec![3.0]);
}

#[test]
fn a_local_weight_overrides_the_style_and_clearing_it_restores_the_style() {
    let (mut m, frame) = styled_frame();
    apply(
        &mut m,
        Mutation::SetElementProperty {
            element_id: frame.clone(),
            path: P::FrameStrokeWeight,
            value: Value::Length(Some(0.5)),
        },
    );
    assert_eq!(stroke_widths(&m), vec![0.5], "the frame's own weight wins");
    m.undo().expect("undo the override");
    assert_eq!(stroke_widths(&m), vec![3.0], "back to the style's weight");
    apply(
        &mut m,
        Mutation::SetElementProperty {
            element_id: frame,
            path: P::AppliedObjectStyle,
            value: Value::Text(String::new()),
        },
    );
    assert!(
        stroke_widths(&m).is_empty(),
        "without the style the text frame has no stroke"
    );
}

#[test]
fn a_change_to_the_styles_weight_reaches_the_frame() {
    let (mut m, _) = styled_frame();
    apply(
        &mut m,
        Mutation::SetStyleProperty {
            collection: StyleCollection::Object,
            style_id: STYLE.into(),
            path: P::FrameStrokeWeight,
            value: Value::Length(Some(6.0)),
        },
    );
    assert_eq!(stroke_widths(&m), vec![6.0]);
}
