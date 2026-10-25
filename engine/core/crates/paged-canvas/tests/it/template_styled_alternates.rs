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

//! Engine ADR 1017: a text field's value in the character styles and with
//! the breaks its author allows, and nothing else; an alternates field whose
//! filler shows one member and hides the rest, in one undo step, granted
//! nothing but that; both through IDML export and import.

use paged_canvas::{
    channel::Mutation,
    element_selection::ElementId,
    template::{FieldValue, RunBreak, StyledRun, TemplateFieldValue},
    CanvasModel, CanvasOptions, PageId,
};
use paged_template::{
    Constraints, DocumentPolicy, FieldDef, ItemPolicy, Role, SessionPolicy, TemplateFieldKind,
    TextBreaks, TEMPLATE_KEY,
};

fn model() -> CanvasModel {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let bytes = paged_gen::write_idml(&sample).expect("write idml");
    CanvasModel::load("styled", &bytes, CanvasOptions::default()).expect("load")
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

fn field(name: &str, kind: TemplateFieldKind) -> FieldDef {
    FieldDef {
        name: name.into(),
        kind,
        label: None,
        help: None,
        group: None,
        required: false,
        constraints: Constraints::default(),
        module: None,
        members: vec![],
    }
}

fn apply(m: &mut CanvasModel, op: Mutation) -> Option<ElementId> {
    m.apply_mutation(&op).expect("applies").created_id
}

fn style(m: &mut CanvasModel, name: &str) {
    apply(
        m,
        Mutation::CreateCharacterStyle {
            self_id: Some(format!("CharacterStyle/{name}")),
            name: Some(name.into()),
            based_on: None,
        },
    );
}

fn story_of(m: &CanvasModel, frame: &ElementId) -> String {
    m.scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.text_frames.iter())
        .find(|f| f.self_id.as_deref() == Some(frame.raw_id()))
        .and_then(|f| f.parent_story.clone())
        .expect("story")
}

/// A headline text field allowing Bold and Italic and line breaks; the
/// document defines Bold, Italic and Caps. Returns the model, the frame
/// and its story.
fn headline() -> (CanvasModel, ElementId, String) {
    let mut m = model();
    role(&mut m, Role::Author);
    for s in ["Bold", "Italic", "Caps"] {
        style(&mut m, s);
    }
    let page_id = page(&m);
    let tf = apply(
        &mut m,
        Mutation::InsertTextFrame {
            page_id,
            bounds: (100.0, 40.0, 200.0, 400.0),
        },
    )
    .expect("frame");
    let story = story_of(&m, &tf);
    apply(
        &mut m,
        Mutation::InsertText {
            story_id: story.clone(),
            offset: 0,
            text: "Old".into(),
            cell: None,
        },
    );
    let mut def = field("headline", TemplateFieldKind::Text);
    def.constraints.allowed_styles = vec!["Bold".into(), "CharacterStyle/Italic".into()];
    def.constraints.breaks = Some(TextBreaks::Line);
    apply(
        &mut m,
        Mutation::SetPluginMetadata {
            element_id: tf.clone(),
            key: TEMPLATE_KEY.into(),
            value: Some(
                ItemPolicy {
                    field: Some(def),
                    ..Default::default()
                }
                .to_label(),
            ),
            caller: None,
        },
    );
    (m, tf, story)
}

fn text(t: &str, style: Option<&str>) -> StyledRun {
    StyledRun::Text {
        text: t.into(),
        style: style.map(str::to_string),
    }
}

fn runs(name: &str, runs: Vec<StyledRun>) -> TemplateFieldValue {
    TemplateFieldValue {
        name: name.into(),
        value: FieldValue::Runs { runs },
    }
}

fn story_runs(m: &CanvasModel, story: &str) -> Vec<(String, Option<String>)> {
    m.scene()
        .stories
        .iter()
        .find(|s| s.self_id == story)
        .expect("story")
        .story
        .paragraphs
        .iter()
        .flat_map(|p| p.runs.iter())
        .filter(|r| !r.text.is_empty())
        .map(|r| (r.text.clone(), r.character_style.clone()))
        .collect()
}

fn value_of(m: &CanvasModel, name: &str) -> Option<FieldValue> {
    m.template_fields()
        .into_iter()
        .find(|r| r.field.name == name)
        .and_then(|r| r.value)
}

#[test]
fn a_styled_value_is_written_in_the_allowed_styles_in_one_step() {
    let (mut m, _, story) = headline();
    role(&mut m, Role::Filler);
    let depth = m.applied_log_len();
    let value = vec![
        text("Ada ", None),
        text("Lovelace", Some("Bold")),
        StyledRun::Break {
            kind: RunBreak::Line,
        },
        text("Analyst", Some("Italic")),
    ];
    let batch = m
        .lower_template_fields(&[runs("headline", value.clone())])
        .expect("the value fits");
    m.apply_mutation(&batch)
        .expect("a filler writes the allowed styles");
    assert_eq!(m.applied_log_len(), depth + 1, "one undo step");
    let got = story_runs(&m, &story);
    let styled: Vec<_> = got
        .iter()
        .filter_map(|(t, s)| s.as_deref().map(|s| (t.as_str(), s)))
        .filter(|(_, s)| s.starts_with("CharacterStyle/") && !s.contains('['))
        .collect();
    assert_eq!(
        styled,
        [
            ("Lovelace", "CharacterStyle/Bold"),
            ("Analyst", "CharacterStyle/Italic")
        ],
        "{got:?}"
    );
    // Read back in the field's own spelling of the styles, so a value read
    // from a filled document fills the template the same way.
    let Some(FieldValue::Runs { runs: back }) = value_of(&m, "headline") else {
        panic!("a styled field reads as runs");
    };
    assert_eq!(
        back,
        vec![
            text("Ada ", None),
            text("Lovelace", Some("Bold")),
            StyledRun::Break {
                kind: RunBreak::Line
            },
            text("Analyst", Some("CharacterStyle/Italic")),
        ]
    );
    m.undo().expect("undo");
    assert_eq!(
        value_of(&m, "headline"),
        Some(FieldValue::Runs {
            runs: vec![text("Old", None)]
        })
    );
}

#[test]
fn styles_and_breaks_the_author_did_not_allow_are_refused() {
    let (m, _, _) = headline();
    let problem = |v: TemplateFieldValue| {
        m.lower_template_fields(&[v])
            .expect_err("refused")
            .into_iter()
            .map(|p| p.problem)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        problem(runs("headline", vec![text("Shout", Some("Caps"))])),
        ["the field does not allow this character style"]
    );
    assert_eq!(
        problem(runs("headline", vec![text("Nope", Some("Undefined"))])),
        ["the field does not allow this character style"]
    );
    assert_eq!(
        problem(runs(
            "headline",
            vec![
                text("One", None),
                StyledRun::Break {
                    kind: RunBreak::Paragraph
                },
                text("Two", None),
            ]
        )),
        ["the field takes no paragraph breaks"]
    );
    assert_eq!(
        problem(TemplateFieldValue {
            name: "headline".into(),
            value: FieldValue::Text {
                text: "One\nTwo".into()
            },
        }),
        ["the field takes no paragraph breaks"]
    );
}

#[test]
fn a_filler_types_and_styles_only_within_the_field() {
    let (mut m, _, story) = headline();
    role(&mut m, Role::Filler);
    let typed = |m: &mut CanvasModel, t: &str| {
        m.apply_mutation(&Mutation::InsertText {
            story_id: story.clone(),
            offset: 0,
            text: t.into(),
            cell: None,
        })
    };
    assert!(
        typed(&mut m, "line\u{2028}").is_ok(),
        "a line break is allowed"
    );
    let err = typed(&mut m, "para\n").expect_err("a paragraph break is not");
    assert!(format!("{err:?}").contains("paragraph"), "{err:?}");
    let style = |m: &mut CanvasModel, s: &str| {
        m.apply_mutation(&Mutation::ApplyStyle {
            story_id: story.clone(),
            start: 0,
            end: 2,
            style: s.into(),
            scope: paged_mutate::operation::StyleScope::Character,
            cell: None,
            paragraph: None,
        })
    };
    assert!(style(&mut m, "CharacterStyle/Bold").is_ok());
    let err = style(&mut m, "CharacterStyle/Caps").expect_err("Caps is not allowed");
    assert!(format!("{err:?}").contains("text.style"), "{err:?}");
}

/// Three frames named `left`, `centre`, `right` under the alternates field
/// `layout`, `left` shown.
fn alternates() -> (CanvasModel, Vec<ElementId>) {
    let mut m = model();
    role(&mut m, Role::Author);
    let mut ids = Vec::new();
    for (i, name) in ["left", "centre", "right"].iter().enumerate() {
        let x = 40.0 + 100.0 * i as f32;
        let page_id = page(&m);
        let id = apply(
            &mut m,
            Mutation::InsertFrame {
                page_id,
                bounds: (100.0, x, 180.0, x + 80.0),
            },
        )
        .expect("frame");
        apply(
            &mut m,
            Mutation::SetElementProperty {
                element_id: id.clone(),
                path: paged_mutate::PropertyPath::ItemName,
                value: paged_mutate::Value::Text((*name).into()),
            },
        );
        if i > 0 {
            apply(
                &mut m,
                Mutation::SetElementProperty {
                    element_id: id.clone(),
                    path: paged_mutate::PropertyPath::ElementVisible,
                    value: paged_mutate::Value::Bool(false),
                },
            );
        }
        ids.push(id);
    }
    let mut def = field("layout", TemplateFieldKind::Alternates);
    def.members = vec!["left".into(), "centre".into(), "right".into()];
    let mut policy = DocumentPolicy::default();
    policy.alternates.insert("layout".into(), def);
    apply(
        &mut m,
        Mutation::SetDocumentMetadata {
            key: TEMPLATE_KEY.into(),
            value: Some(policy.to_label()),
            caller: None,
        },
    );
    (m, ids)
}

fn pick(member: &str) -> TemplateFieldValue {
    TemplateFieldValue {
        name: "layout".into(),
        value: FieldValue::Alternate {
            member: member.into(),
        },
    }
}

fn shown(m: &CanvasModel) -> Vec<(String, bool)> {
    let row = m
        .template_fields()
        .into_iter()
        .find(|r| r.field.name == "layout")
        .expect("layout");
    row.members
        .into_iter()
        .map(|m| (m.name, m.visible))
        .collect()
}

#[test]
fn a_filler_picks_an_alternate_in_one_undo_step() {
    let (mut m, ids) = alternates();
    role(&mut m, Role::Filler);
    let row = m
        .template_fields()
        .into_iter()
        .find(|r| r.field.name == "layout")
        .expect("layout");
    assert_eq!(
        row.value,
        Some(FieldValue::Alternate {
            member: "left".into()
        })
    );
    assert_eq!(
        row.element_id.as_ref(),
        Some(&ids[0]),
        "drawn on the shown member"
    );
    let depth = m.applied_log_len();
    let batch = m.lower_template_fields(&[pick("right")]).expect("fits");
    m.apply_mutation(&batch).expect("the filler may pick");
    assert_eq!(m.applied_log_len(), depth + 1, "one undo step");
    assert_eq!(
        shown(&m),
        [
            ("left".into(), false),
            ("centre".into(), false),
            ("right".into(), true)
        ]
    );
    m.undo().expect("undo");
    assert_eq!(shown(&m)[0], ("left".into(), true));
    let problems = m
        .lower_template_fields(&[pick("nowhere")])
        .expect_err("no such member");
    assert_eq!(problems[0].problem, "no alternate has this name");
}

#[test]
fn a_member_is_granted_its_visibility_and_nothing_else() {
    let (mut m, ids) = alternates();
    role(&mut m, Role::Filler);
    let moved = m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ids[1].clone(),
        path: paged_mutate::PropertyPath::FrameTransform,
        value: paged_mutate::Value::Transform(Some([1.0, 0.0, 0.0, 1.0, 10.0, 10.0])),
    });
    assert!(moved.is_err(), "a member does not move");
    let renamed = m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ids[1].clone(),
        path: paged_mutate::PropertyPath::ItemName,
        value: paged_mutate::Value::Text("other".into()),
    });
    let err = format!(
        "{:?}",
        renamed.expect_err("renaming a member is the author's")
    );
    assert!(
        err.contains("template.author")
            || err.contains("notPermitted")
            || err.contains("NotPermitted"),
        "{err}"
    );
    assert!(m
        .apply_mutation(&Mutation::SetElementProperty {
            element_id: ids[1].clone(),
            path: paged_mutate::PropertyPath::ElementVisible,
            value: paged_mutate::Value::Bool(true),
        })
        .is_ok());
}

#[test]
fn alternates_and_styled_values_survive_idml_export_and_import() {
    let (mut m, _) = alternates();
    let batch = m.lower_template_fields(&[pick("centre")]).expect("fits");
    m.apply_mutation(&batch).expect("applies");
    let idml = m.export_idml().expect("export");
    let back = CanvasModel::load("alternates", &idml, CanvasOptions::default()).expect("reload");
    assert_eq!(
        shown(&back),
        [
            ("left".into(), false),
            ("centre".into(), true),
            ("right".into(), false)
        ],
        "the members are hidden items in IDML"
    );
    let row = back
        .template_fields()
        .into_iter()
        .find(|r| r.field.name == "layout")
        .expect("layout");
    assert_eq!(row.field.members, ["left", "centre", "right"]);
    assert_eq!(
        row.value,
        Some(FieldValue::Alternate {
            member: "centre".into()
        })
    );

    let (mut m, _, _) = headline();
    let value = vec![text("Ada ", None), text("Lovelace", Some("Bold"))];
    let batch = m
        .lower_template_fields(&[runs("headline", value.clone())])
        .expect("fits");
    m.apply_mutation(&batch).expect("applies");
    let idml = m.export_idml().expect("export");
    let back = CanvasModel::load("styled", &idml, CanvasOptions::default()).expect("reload");
    let row = back
        .template_fields()
        .into_iter()
        .find(|r| r.field.name == "headline")
        .expect("headline");
    assert_eq!(row.field.constraints.breaks, Some(TextBreaks::Line));
    assert_eq!(row.value, Some(FieldValue::Runs { runs: value }));
}

#[test]
fn preflight_names_bad_alternates_and_unknown_styles() {
    let (mut m, _) = alternates();
    let mut def = field("layout", TemplateFieldKind::Alternates);
    def.members = vec!["left".into(), "ghost".into()];
    let mut lonely = field("lonely", TemplateFieldKind::Alternates);
    lonely.members = vec!["right".into()];
    let mut policy = DocumentPolicy::default();
    policy.alternates.insert("layout".into(), def);
    policy.alternates.insert("lonely".into(), lonely);
    apply(
        &mut m,
        Mutation::SetDocumentMetadata {
            key: TEMPLATE_KEY.into(),
            value: Some(policy.to_label()),
            caller: None,
        },
    );
    let (mut h, tf, _) = headline();
    let mut bad = field("headline", TemplateFieldKind::Text);
    bad.constraints.allowed_styles = vec!["Nowhere".into()];
    apply(
        &mut h,
        Mutation::SetPluginMetadata {
            element_id: tf,
            key: TEMPLATE_KEY.into(),
            value: Some(
                ItemPolicy {
                    field: Some(bad),
                    ..Default::default()
                }
                .to_label(),
            ),
            caller: None,
        },
    );
    let codes = |m: &CanvasModel| {
        paged_template::preflight(m.scene())
            .into_iter()
            .map(|f| (f.code, f.field.unwrap_or_default()))
            .collect::<Vec<_>>()
    };
    let a = codes(&m);
    assert!(
        a.contains(&("alternateMissing".into(), "layout".into())),
        "{a:?}"
    );
    assert!(
        a.contains(&("alternatesTooFew".into(), "lonely".into())),
        "{a:?}"
    );
    let b = codes(&h);
    assert!(
        b.contains(&("styleUnknown".into(), "headline".into())),
        "{b:?}"
    );
}
