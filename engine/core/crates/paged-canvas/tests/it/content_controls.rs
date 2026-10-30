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

//! Engine ADR 1052 — content controls through the wire: a checkbox
//! toggles its glyph, a drop-down takes one of its items, a date its
//! formatted value, a plain text control any text; each one undo step,
//! and the story read reports the control.
#![allow(non_snake_case)]

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_model::{ContentControl, ContentControlKind, ListItem};

fn control(id: &str, kind: ContentControlKind) -> ContentControl {
    ContentControl {
        id: id.into(),
        kind,
        tag: Some(format!("tag-{id}")),
        alias: None,
        lock: None,
        showing_placeholder: false,
        placeholder_style: None,
    }
}

/// One paragraph: "Agree " [checkbox ☐] " colour " [drop-down "Red"]
/// " on " [date "1/2/2026"] " by " [plain text "Name", placeholder].
fn model() -> (CanvasModel, String) {
    let idml = paged_gen::write_idml(&paged_gen::samples::notes::build()).expect("idml");
    let mut m = CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load");
    let story = m.scene().stories[0].self_id.clone();
    let s = &mut m.scene_mut().stories[0].story;
    let template = s.paragraphs[0].runs[0].clone();
    let run = |text: &str, c: Option<ContentControl>| {
        let mut r = template.clone();
        r.text = text.into();
        r.control = c;
        r
    };
    let mut placeholder = control("4", ContentControlKind::PlainText { multi_line: false });
    placeholder.showing_placeholder = true;
    placeholder.placeholder_style = Some("CharacterStyle/Placeholder".into());
    let mut name = run("Name", Some(placeholder));
    name.character_style = Some("CharacterStyle/Placeholder".into());
    let mut p = s.paragraphs[0].clone();
    p.runs = vec![
        run("Agree ", None),
        run(
            "\u{2610}",
            Some(control(
                "1",
                ContentControlKind::Checkbox {
                    checked: false,
                    checked_glyph: "\u{2612}".into(),
                    checked_font: Some("MS Gothic".into()),
                    unchecked_glyph: "\u{2610}".into(),
                    unchecked_font: Some("MS Gothic".into()),
                },
            )),
        ),
        run(" colour ", None),
        run(
            "Red",
            Some(control(
                "2",
                ContentControlKind::DropDown {
                    combo: false,
                    items: vec![
                        ListItem {
                            display: "Red".into(),
                            value: "r".into(),
                        },
                        ListItem {
                            display: "Blue".into(),
                            value: "b".into(),
                        },
                    ],
                    value: Some("r".into()),
                },
            )),
        ),
        run(" on ", None),
        run(
            "1/2/2026",
            Some(control(
                "3",
                ContentControlKind::Date {
                    format: Some("d MMMM yyyy".into()),
                    value: Some("2026-01-02".into()),
                },
            )),
        ),
        run(" by ", None),
        name,
    ];
    s.paragraphs = vec![p];
    (m, story)
}

fn text(m: &CanvasModel) -> String {
    m.scene().stories[0].story.paragraphs[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect()
}

#[test]
fn each_control_kind_takes_its_value_in_one_undo_step__feat__doc_content_controls() {
    let (mut m, story) = model();
    let start = m.scene().canonical_hash();
    let steps = [
        Mutation::ToggleContentControl {
            story_id: story.clone(),
            control_id: "1".into(),
        },
        Mutation::ChooseContentControlItem {
            story_id: story.clone(),
            control_id: "2".into(),
            index: 1,
        },
        Mutation::SetContentControlValue {
            story_id: story.clone(),
            control_id: "3".into(),
            value: "2026-10-30".into(),
        },
        Mutation::SetContentControlValue {
            story_id: story.clone(),
            control_id: "4".into(),
            value: "Ada".into(),
        },
    ];
    for step in &steps {
        let before = m.scene().canonical_hash();
        m.apply_mutation(step).expect("applies");
        m.undo().expect("undo");
        assert_eq!(
            m.scene().canonical_hash(),
            before,
            "one undo step: {step:?}"
        );
        m.apply_mutation(step).expect("applies again");
    }
    assert_eq!(
        text(&m),
        "Agree \u{2612} colour Blue on 30 October 2026 by Ada"
    );
    let runs = &m.scene().stories[0].story.paragraphs[0].runs;
    let name = runs.iter().find(|r| r.text == "Ada").unwrap();
    assert_eq!(
        name.character_style, None,
        "the placeholder style goes with the placeholder"
    );
    assert!(!name.control.as_ref().unwrap().showing_placeholder);
    let cb = runs.iter().find(|r| r.text == "\u{2612}").unwrap();
    assert_eq!(cb.font.as_deref(), Some("MS Gothic"));
    // The story read reports each control with its state.
    let content = m.story_content(&story).expect("story");
    let controls: Vec<_> = content.paragraphs[0]
        .runs
        .iter()
        .filter_map(|r| r.control.as_ref())
        .collect();
    assert_eq!(controls.len(), 4);
    assert_eq!(controls[0].kind, "checkbox");
    assert_eq!(controls[0].checked, Some(true));
    assert_eq!(controls[1].value.as_deref(), Some("b"));
    assert_eq!(controls[1].items.len(), 2);
    assert_eq!(controls[2].value.as_deref(), Some("2026-10-30"));
    assert_eq!(controls[0].tag.as_deref(), Some("tag-1"));
    for _ in &steps {
        m.undo().expect("undo");
    }
    assert_eq!(m.scene().canonical_hash(), start);
}

#[test]
fn a_control_refuses_what_its_kind_does_not_take__feat__doc_content_controls() {
    let (mut m, story) = model();
    let before = m.scene().canonical_hash();
    for bad in [
        Mutation::SetContentControlValue {
            story_id: story.clone(),
            control_id: "2".into(),
            value: "Green".into(),
        },
        Mutation::SetContentControlValue {
            story_id: story.clone(),
            control_id: "3".into(),
            value: "soon".into(),
        },
        Mutation::SetContentControlValue {
            story_id: story.clone(),
            control_id: "9".into(),
            value: "x".into(),
        },
        Mutation::ToggleContentControl {
            story_id: story.clone(),
            control_id: "2".into(),
        },
    ] {
        assert!(m.apply_mutation(&bad).is_err(), "{bad:?}");
    }
    m.scene_mut().stories[0].story.paragraphs[0].runs[1]
        .control
        .as_mut()
        .unwrap()
        .lock = Some("contentLocked".into());
    let locked = m.scene().canonical_hash();
    assert!(m
        .apply_mutation(&Mutation::ToggleContentControl {
            story_id: story.clone(),
            control_id: "1".into()
        })
        .is_err());
    assert_eq!(m.scene().canonical_hash(), locked);
    assert_ne!(before, locked);
}
