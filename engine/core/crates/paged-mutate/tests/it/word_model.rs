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

//! Engine ADR 1018 — Word's character and paragraph additions, list levels
//! and style re-parenting through the operation layer, each undone
//! exactly.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use std::io::Write;

use paged_mutate::{
    apply, NodeId, Operation, ParagraphListState, PropertyPath, StyleCollection, Value,
};
use paged_scene::Document;
use proptest::prelude::*;

fn idml(styles: &str, paras: usize) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let mut put = |name: &str, body: &str| {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    put(
        "designmap.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Styles src="Resources/Styles.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_u10.xml"/>
</Document>"#,
    );
    put(
        "Resources/Styles.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Styles xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">{styles}</idPkg:Styles>"#
        ),
    );
    put(
        "Spreads/Spread_sp1.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Spread Self="sp1"><Page Self="p1" GeometricBounds="0 0 600 612"/><TextFrame Self="f1" ParentStory="u10" GeometricBounds="40 40 560 572"/></Spread></idPkg:Spread>"#,
    );
    let body: String = (0..paras)
        .map(|i| {
            let br = if i + 1 < paras { "<Br/>" } else { "" };
            format!(r#"<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body"><CharacterStyleRange><Content>Para {i}</Content>{br}</CharacterStyleRange></ParagraphStyleRange>"#)
        })
        .collect();
    put(
        "Stories/Story_u10.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u10">{body}</Story></idPkg:Story>"#
        ),
    );
    zip.finish().unwrap().into_inner()
}

const STYLES: &str = r#"<RootCharacterStyleGroup Self="rc"><CharacterStyle Self="CharacterStyle/$ID/[No character style]" Name="$ID/[No character style]"/><CharacterStyle Self="CharacterStyle/Strong" Name="Strong"/><CharacterStyle Self="CharacterStyle/Mark" Name="Mark"/></RootCharacterStyleGroup><RootParagraphStyleGroup Self="rp"><ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]" Name="$ID/[No paragraph style]"/><ParagraphStyle Self="ParagraphStyle/Body" Name="Body"/><ParagraphStyle Self="ParagraphStyle/Heading" Name="Heading"><Properties><BasedOn type="object">ParagraphStyle/Body</BasedOn></Properties></ParagraphStyle><ParagraphStyle Self="ParagraphStyle/Sub" Name="Sub"><Properties><BasedOn type="object">ParagraphStyle/Heading</BasedOn></Properties></ParagraphStyle></RootParagraphStyleGroup>"#;

fn open() -> Document {
    idml_import::import_idml_doc(&idml(STYLES, 4)).expect("fixture")
}

/// Applies `op`, checks its inverse puts the model back exactly (the
/// canonical hash) and the redo lands on the edit again.
fn round_trip(doc: &mut Document, op: &Operation) {
    let before = doc.canonical_hash();
    let applied = apply(doc, op).unwrap_or_else(|e| panic!("{op:?}: {e}"));
    let after = doc.canonical_hash();
    let undone = apply(doc, &applied.inverse).expect("undoes");
    assert_eq!(doc.canonical_hash(), before, "undo restores {op:?}");
    apply(doc, &undone.inverse).expect("redoes");
    assert_eq!(doc.canonical_hash(), after, "redo restores {op:?}");
}

fn range(start: u32, end: u32) -> NodeId {
    NodeId::StoryRange {
        story_id: "u10".into(),
        start,
        end,
    }
}

fn set(node: NodeId, path: PropertyPath, value: Value) -> Operation {
    Operation::SetProperty { node, path, value }
}

fn run(doc: &Document, p: usize) -> &paged_model::CharacterRun {
    &doc.stories[0].story.paragraphs[p].runs[0]
}

#[test]
fn character_additions_set_on_runs_and_undo__feat__doc_word_character_model() {
    let mut doc = open();
    let cases = [
        (
            PropertyPath::CharacterHighlightColor,
            Value::ColorRef(Some("Color/Yellow".into())),
        ),
        (PropertyPath::CharacterHidden, Value::Bool(true)),
        (
            PropertyPath::CharacterUnderlineType,
            Value::Text("double".into()),
        ),
        (
            PropertyPath::CharacterUnderlineColor,
            Value::ColorRef(Some("Color/Red".into())),
        ),
        (
            PropertyPath::CharacterDoubleStrikethrough,
            Value::Bool(true),
        ),
    ];
    for (path, value) in cases.iter().cloned() {
        // The whole first run ("Para 0"): a range inside a run splits it,
        // and an undo leaves the split (as for every character path).
        round_trip(&mut doc, &set(range(0, 6), path, value));
    }
    let r = run(&doc, 0);
    assert_eq!(
        r.decorations.highlight_color.as_deref(),
        Some("Color/Yellow")
    );
    assert_eq!(r.decorations.hidden, Some(true));
    assert_eq!(
        r.decorations.underline_kind,
        Some(paged_model::UnderlineKind::Double)
    );
    assert_eq!(r.underline, Some(true), "a kind turns the underline on");
    assert_eq!(r.decorations.double_strikethrough, Some(true));
    // The next paragraph is untouched.
    assert!(run(&doc, 1).decorations.is_unset());
    // An unknown kind is refused and changes nothing.
    let before = doc.canonical_hash();
    assert!(apply(
        &mut doc,
        &set(
            range(0, 6),
            PropertyPath::CharacterUnderlineType,
            Value::Text("zigzag".into())
        )
    )
    .is_err());
    assert_eq!(doc.canonical_hash(), before);
}

#[test]
fn character_additions_set_on_styles__feat__doc_word_character_model() {
    let mut doc = open();
    for (collection, id) in [
        (StyleCollection::Character, "CharacterStyle/Mark"),
        (StyleCollection::Paragraph, "ParagraphStyle/Body"),
    ] {
        for (path, value) in [
            (
                PropertyPath::CharacterHighlightColor,
                Value::ColorRef(Some("Color/Yellow".into())),
            ),
            (PropertyPath::CharacterHidden, Value::Bool(true)),
            (
                PropertyPath::CharacterUnderlineType,
                Value::Text("wave".into()),
            ),
            (
                PropertyPath::CharacterUnderlineColor,
                Value::ColorRef(Some("Color/Red".into())),
            ),
            (
                PropertyPath::CharacterDoubleStrikethrough,
                Value::Bool(true),
            ),
        ] {
            round_trip(
                &mut doc,
                &Operation::SetStyleProperty {
                    collection,
                    style_id: id.into(),
                    path,
                    value,
                },
            );
        }
    }
    let mark = &doc.styles.character_styles["CharacterStyle/Mark"];
    assert_eq!(
        mark.decorations.underline_kind,
        Some(paged_model::UnderlineKind::Wave)
    );
    // The paragraph style's additions reach a run through the cascade.
    let p = &doc.stories[0].story.paragraphs[0];
    let attrs = doc.resolved_run_attrs(p, &p.runs[0]);
    assert_eq!(attrs.decorations.hidden, Some(true));
    assert_eq!(
        attrs.drawn_underline(),
        Some(paged_model::UnderlineKind::Wave)
    );
}

#[test]
fn paragraph_shading_and_border_set_directly_and_on_styles__feat__doc_word_paragraph_model() {
    let mut doc = open();
    let cases = [
        (PropertyPath::ParagraphShadingOn, Value::Bool(true)),
        (
            PropertyPath::ParagraphShadingColor,
            Value::ColorRef(Some("Color/Yellow".into())),
        ),
        (
            PropertyPath::ParagraphShadingTint,
            Value::Length(Some(40.0)),
        ),
        (PropertyPath::ParagraphBorderOn, Value::Bool(true)),
        (
            PropertyPath::ParagraphBorderColor,
            Value::ColorRef(Some("Color/Red".into())),
        ),
        (
            PropertyPath::ParagraphBorderWeight,
            Value::Length(Some(2.0)),
        ),
    ];
    for (path, value) in cases.iter().cloned() {
        round_trip(&mut doc, &set(range(0, 3), path, value.clone()));
        round_trip(
            &mut doc,
            &Operation::SetStyleProperty {
                collection: StyleCollection::Paragraph,
                style_id: "ParagraphStyle/Heading".into(),
                path,
                value,
            },
        );
    }
    let p = &doc.stories[0].story.paragraphs[0];
    assert_eq!(p.shading.color.as_deref(), Some("Color/Yellow"));
    assert_eq!(p.border.weight, Some(2.0));
    // Direct beats style per field: a style colour under a direct tint.
    let attrs = doc.resolved_paragraph_attrs(p);
    assert_eq!(attrs.shading.tint, Some(40.0));
    assert_eq!(attrs.border.color.as_deref(), Some("Color/Red"));
    assert_eq!(
        doc.styles.paragraph_styles["ParagraphStyle/Heading"]
            .shading
            .on,
        Some(true)
    );
}

#[test]
fn show_hidden_text_is_a_document_flag__feat__doc_word_character_model() {
    let mut doc = open();
    round_trip(
        &mut doc,
        &set(
            NodeId::Document(String::new()),
            PropertyPath::DocumentShowHiddenText,
            Value::Bool(true),
        ),
    );
    assert_eq!(
        doc.designmap.document_preference.show_hidden_text,
        Some(true)
    );
}

#[test]
fn style_based_on_moves_and_refuses_a_cycle__feat__doc_word_styles() {
    let mut doc = open();
    let op = |style: &str, parent: Option<&str>| Operation::SetStyleBasedOn {
        collection: StyleCollection::Paragraph,
        style_id: style.into(),
        based_on: parent.map(str::to_string),
    };
    round_trip(
        &mut doc,
        &op("ParagraphStyle/Sub", Some("ParagraphStyle/Body")),
    );
    assert_eq!(
        doc.styles.paragraph_styles["ParagraphStyle/Sub"]
            .based_on
            .as_deref(),
        Some("ParagraphStyle/Body")
    );
    round_trip(&mut doc, &op("ParagraphStyle/Sub", None));
    let before = doc.canonical_hash();
    for bad in [
        op("ParagraphStyle/Body", Some("ParagraphStyle/Heading")),
        op("ParagraphStyle/Body", Some("ParagraphStyle/Body")),
        op("ParagraphStyle/Body", Some("ParagraphStyle/Missing")),
        op("ParagraphStyle/Missing", None),
    ] {
        assert!(apply(&mut doc, &bad).is_err(), "{bad:?} must be refused");
    }
    assert_eq!(doc.canonical_hash(), before, "a refusal changes nothing");
    round_trip(
        &mut doc,
        &Operation::SetStyleBasedOn {
            collection: StyleCollection::Character,
            style_id: "CharacterStyle/Mark".into(),
            based_on: Some("CharacterStyle/Strong".into()),
        },
    );
}

/// No style's chain loops, however many re-parents were accepted.
fn acyclic(doc: &Document) -> bool {
    let styles = &doc.styles.paragraph_styles;
    styles.keys().all(|start| {
        let mut seen = std::collections::HashSet::new();
        let mut cur = Some(start.clone());
        while let Some(id) = cur {
            if !seen.insert(id.clone()) {
                return false;
            }
            cur = styles.get(&id).and_then(|d| d.based_on.clone());
        }
        true
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    /// Random re-parents over a chain of styles: every accepted one keeps
    /// the graph acyclic, every refused one changes nothing.
    #[test]
    fn based_on_never_makes_a_cycle__feat__doc_word_styles(
        moves in proptest::collection::vec((0usize..6, proptest::option::of(0usize..6)), 1..30)
    ) {
        let styles: String = (0..6)
            .map(|i| format!(r#"<ParagraphStyle Self="ParagraphStyle/S{i}" Name="S{i}"/>"#))
            .collect();
        let mut doc = idml_import::import_idml_doc(&idml(
            &format!(r#"<RootParagraphStyleGroup Self="rp"><ParagraphStyle Self="ParagraphStyle/Body" Name="Body"/>{styles}</RootParagraphStyleGroup>"#),
            1,
        ))
        .unwrap();
        for (s, p) in moves {
            let op = Operation::SetStyleBasedOn {
                collection: StyleCollection::Paragraph,
                style_id: format!("ParagraphStyle/S{s}"),
                based_on: p.map(|p| format!("ParagraphStyle/S{p}")),
            };
            let before = doc.canonical_hash();
            if apply(&mut doc, &op).is_err() {
                prop_assert_eq!(doc.canonical_hash(), before);
            }
            prop_assert!(acyclic(&doc));
        }
    }
}

#[test]
fn list_level_and_restart_numbering_undo_exactly__feat__doc_word_list_levels() {
    let mut doc = open();
    // "Para 0" … "Para 3": 6 chars each; the second paragraph spans 6..12.
    round_trip(
        &mut doc,
        &Operation::SetListLevel {
            story_id: "u10".into(),
            start: 7,
            end: 20,
            level: Some(2),
            delta: None,
        },
    );
    let levels = |d: &Document| -> Vec<Option<u32>> {
        d.stories[0]
            .story
            .paragraphs
            .iter()
            .map(|p| p.list_level.level)
            .collect()
    };
    assert_eq!(levels(&doc), [None, Some(2), Some(2), Some(2)]);
    round_trip(
        &mut doc,
        &Operation::SetListLevel {
            story_id: "u10".into(),
            start: 0,
            end: 8,
            level: None,
            delta: Some(1),
        },
    );
    assert_eq!(levels(&doc), [Some(2), Some(3), Some(2), Some(2)]);
    round_trip(
        &mut doc,
        &Operation::SetListLevel {
            story_id: "u10".into(),
            start: 0,
            end: 0,
            level: None,
            delta: Some(-5),
        },
    );
    assert_eq!(levels(&doc)[0], Some(1), "clamped to level 1");
    for bad in [
        Operation::SetListLevel {
            story_id: "u10".into(),
            start: 0,
            end: 0,
            level: Some(10),
            delta: None,
        },
        Operation::SetListLevel {
            story_id: "u10".into(),
            start: 0,
            end: 0,
            level: Some(2),
            delta: Some(1),
        },
    ] {
        assert!(apply(&mut doc, &bad).is_err());
    }
    round_trip(
        &mut doc,
        &Operation::RestartNumbering {
            story_id: "u10".into(),
            start: 13,
            end: 13,
            start_at: Some(4),
            continue_numbering: false,
        },
    );
    let p2 = &doc.stories[0].story.paragraphs[2];
    assert_eq!(
        (p2.numbering_continue, p2.numbering_start_at),
        (Some(false), Some(4))
    );
    round_trip(
        &mut doc,
        &Operation::SetParagraphListState {
            story_id: "u10".into(),
            entries: vec![ParagraphListState {
                paragraph: 3,
                level: Some(9),
                numbering_continue: Some(true),
                numbering_start_at: None,
            }],
        },
    );
}

#[test]
fn numbering_list_levels_travel_through_the_spec__feat__doc_word_list_levels() {
    let mut doc = open();
    let spec = paged_mutate::NumberingListSpec {
        self_id: Some("NumberingList/w".into()),
        name: Some("Word".into()),
        continue_across_stories: None,
        continue_across_documents: None,
        levels: vec![paged_mutate::NumberingLevelSpec {
            level: 1,
            list_type: Some("NumberedList".into()),
            format: Some("lowerRoman".into()),
            expression: Some("%1)".into()),
            suffix: Some("tab".into()),
            start_at: Some(3),
            bullet_character: Some("•".into()),
            ..Default::default()
        }],
    };
    round_trip(
        &mut doc,
        &Operation::CreateNumberingList { spec: spec.clone() },
    );
    let def = &doc.styles.numbering_lists["NumberingList/w"];
    assert_eq!(def.levels[0].idml_expression().as_deref(), Some("^1)^t"));
    assert_eq!(
        def.levels[0].idml_format().as_deref(),
        Some("i, ii, iii, iv...")
    );
    assert_eq!(def.levels[0].bullet_character, Some('•' as u32));
    assert_eq!(
        paged_mutate::apply::numbering_list_spec_from_def(def),
        spec,
        "spec → def → spec is the identity"
    );
}

// ---- engine ADR 1051 — direction and script slots ----------------------

#[test]
fn direction_and_script_slots_set_and_undo__feat__doc_script_font_slots() {
    let mut doc = open();
    let cases = [
        (PropertyPath::CharacterDirection, Value::Text("rtl".into())),
        (
            PropertyPath::CharacterEastAsianFont,
            Value::Text("MS Mincho".into()),
        ),
        (
            PropertyPath::CharacterComplexFont,
            Value::Text("Arial".into()),
        ),
        (
            PropertyPath::CharacterComplexFontSize,
            Value::Length(Some(14.0)),
        ),
        (PropertyPath::CharacterComplexBold, Value::Bool(true)),
        (PropertyPath::CharacterComplexItalic, Value::Bool(true)),
        (PropertyPath::CharacterComplexScript, Value::Bool(true)),
        (
            PropertyPath::CharacterFontHint,
            Value::Text("eastAsia".into()),
        ),
    ];
    for (path, value) in cases {
        round_trip(&mut doc, &set(range(0, 4), path, value.clone()));
        apply(&mut doc, &set(range(0, 4), path, value)).unwrap();
    }
    let s = &run(&doc, 0).script;
    assert_eq!(
        s.direction,
        Some(paged_model::CharacterDirection::RightToLeft)
    );
    assert_eq!(s.east_asian_font.as_deref(), Some("MS Mincho"));
    assert_eq!(s.complex_point_size, Some(14.0));
    assert_eq!(s.hint, Some(paged_model::FontHint::EastAsia));
    // A bad value is refused before anything changes.
    let before = doc.canonical_hash();
    assert!(apply(
        &mut doc,
        &set(
            range(0, 4),
            PropertyPath::CharacterFontHint,
            Value::Text("x".into())
        )
    )
    .is_err());
    assert_eq!(doc.canonical_hash(), before);
}

#[test]
fn paragraph_direction_sets_and_undoes__feat__doc_bidi_paragraph() {
    let mut doc = open();
    let op = set(
        range(0, 2),
        PropertyPath::ParagraphDirection,
        Value::Text("rtl".into()),
    );
    round_trip(&mut doc, &op);
    apply(&mut doc, &op).unwrap();
    assert_eq!(
        doc.stories[0].story.paragraphs[0].direction,
        Some(paged_model::ParagraphDirection::RightToLeft)
    );
    assert!(apply(
        &mut doc,
        &set(
            range(0, 2),
            PropertyPath::ParagraphDirection,
            Value::Text("up".into())
        )
    )
    .is_err());
    // On a paragraph style too.
    let style = Operation::SetStyleProperty {
        collection: StyleCollection::Paragraph,
        style_id: "ParagraphStyle/Body".into(),
        path: PropertyPath::ParagraphDirection,
        value: Value::Text("auto".into()),
    };
    round_trip(&mut doc, &style);
    let slot = Operation::SetStyleProperty {
        collection: StyleCollection::Character,
        style_id: "CharacterStyle/Strong".into(),
        path: PropertyPath::CharacterComplexFont,
        value: Value::Text("Arial".into()),
    };
    round_trip(&mut doc, &slot);
}
