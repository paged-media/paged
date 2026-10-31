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

//! Engine ADRs 1018 and 1021 over the wire: Enter applies the Next Style,
//! Find returns hits, Find & Replace is one undo step, and the list and
//! style mutations reach the model.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use paged_canvas::{CanvasModel, CanvasOptions, Mutation};
use paged_wire::{FindMode, FindSpec};
use proptest::prelude::*;

/// One story: "The cat sat." / "A cat, a Cat." / "Dogs." in style Heading
/// (next style Body) / Body / Body.
fn model() -> (CanvasModel, String) {
    let idml = paged_gen::write_idml(&paged_gen::samples::notes::build()).expect("idml");
    let mut m = CanvasModel::load("doc", &idml, CanvasOptions::default()).expect("load");
    let story = m.scene().stories[0].self_id.clone();
    let scene = m.scene_mut();
    for (id, next) in [
        ("ParagraphStyle/Heading", Some("ParagraphStyle/Body")),
        ("ParagraphStyle/Body", None),
    ] {
        scene.styles.paragraph_styles.insert(
            id.into(),
            paged_model::ParagraphStyleDef {
                self_id: id.into(),
                name: Some(id.trim_start_matches("ParagraphStyle/").into()),
                next_style: next.map(str::to_string),
                ..Default::default()
            },
        );
    }
    scene.styles.character_styles.insert(
        "CharacterStyle/Strong".into(),
        paged_model::CharacterStyleDef {
            self_id: "CharacterStyle/Strong".into(),
            ..Default::default()
        },
    );
    let s = &mut scene.stories[0].story;
    let template = s.paragraphs[0].clone();
    s.paragraphs = ["The cat sat.", "A cat, a Cat.", "Dogs."]
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mut p = paged_model::Paragraph {
                paragraph_style: Some(
                    if i == 0 {
                        "ParagraphStyle/Heading"
                    } else {
                        "ParagraphStyle/Body"
                    }
                    .into(),
                ),
                ..Default::default()
            };
            let mut r = template.runs[0].clone();
            r.text = t.to_string();
            r.character_style = None;
            p.runs = vec![r];
            p
        })
        .collect();
    (m, story)
}

fn texts(m: &CanvasModel) -> Vec<String> {
    m.scene().stories[0]
        .story
        .paragraphs
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}

fn styles(m: &CanvasModel) -> Vec<Option<String>> {
    m.scene().stories[0]
        .story
        .paragraphs
        .iter()
        .map(|p| p.paragraph_style.clone())
        .collect()
}

fn spec(find: &str) -> FindSpec {
    FindSpec {
        find: find.into(),
        ..Default::default()
    }
}

#[test]
fn enter_at_the_end_applies_the_next_style__feat__doc_word_styles() {
    let (mut m, story) = model();
    let before = m.scene().canonical_hash();
    // "The cat sat." is 12 bytes: the caret at its end.
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 12,
        text: "\n".into(),
        cell: None,
    })
    .expect("enter");
    assert_eq!(
        styles(&m)[..2],
        [
            Some("ParagraphStyle/Heading".into()),
            Some("ParagraphStyle/Body".into())
        ]
    );
    m.undo().expect("undo");
    assert_eq!(
        m.scene().canonical_hash(),
        before,
        "undo restores the model"
    );
    // In the middle the new paragraph keeps the style.
    m.apply_mutation(&Mutation::InsertText {
        story_id: story.clone(),
        offset: 4,
        text: "\n".into(),
        cell: None,
    })
    .expect("split");
    assert_eq!(
        styles(&m)[..2],
        [
            Some("ParagraphStyle/Heading".into()),
            Some("ParagraphStyle/Heading".into())
        ]
    );
}

#[test]
fn find_reports_hits_in_caret_and_character_offsets__feat__doc_word_find_replace() {
    let (m, story) = model();
    let hits = m.find_text(&spec("cat")).unwrap();
    assert_eq!(hits.len(), 3, "case-insensitive by default");
    assert_eq!((hits[0].start, hits[0].end), (4, 7));
    // Second paragraph starts after 12 bytes and one break.
    assert_eq!(
        (hits[1].start, hits[1].char_start, hits[1].paragraph),
        (15, 14, 1)
    );
    assert_eq!(hits[1].context, "A cat, a Cat.");
    assert_eq!(hits[1].story_id, story);
    let cased = m
        .find_text(&FindSpec {
            match_case: true,
            ..spec("Cat")
        })
        .unwrap();
    assert_eq!(cased.len(), 1);
    let across = m.find_text(&spec("sat.^pA")).unwrap();
    assert_eq!(across.len(), 1, "^p matches the paragraph break");
    let regex = m
        .find_text(&FindSpec {
            mode: FindMode::Regex,
            ..spec("c(a)t")
        })
        .unwrap();
    assert_eq!(regex[0].groups, vec![Some("a".to_string())]);
    let words = m
        .find_text(&FindSpec {
            whole_word: true,
            ..spec("Dog")
        })
        .unwrap();
    assert!(words.is_empty(), "whole word: Dogs is not Dog");
    let wild = m
        .find_text(&FindSpec {
            mode: FindMode::Wildcards,
            ..spec("<?at>")
        })
        .unwrap();
    assert_eq!(
        wild.len(),
        4,
        "cat, sat, cat, Cat: whole three-letter words"
    );
    let styled = m
        .find_text(&FindSpec {
            paragraph_style: Some("ParagraphStyle/Heading".into()),
            ..spec("cat")
        })
        .unwrap();
    assert_eq!(styled.len(), 1);
    assert!(m
        .find_text(&FindSpec {
            mode: FindMode::Regex,
            ..spec("(")
        })
        .is_err());
}

#[test]
fn replace_all_is_one_undo_step__feat__doc_word_find_replace() {
    let (mut m, _) = model();
    let before = m.scene().canonical_hash();
    m.apply_mutation(&Mutation::FindReplace {
        spec: spec("cat"),
        replace: "lion^&".into(),
        replace_all: true,
        paragraph_style: None,
        character_style: Some("CharacterStyle/Strong".into()),
    })
    .expect("replace all");
    assert_eq!(
        texts(&m),
        ["The lioncat sat.", "A lioncat, a lionCat.", "Dogs."]
    );
    let strong = m.scene().stories[0].story.paragraphs[1]
        .runs
        .iter()
        .filter(|r| r.character_style.as_deref() == Some("CharacterStyle/Strong"))
        .count();
    assert_eq!(strong, 2, "each replacement styled");
    m.undo().expect("undo");
    assert_eq!(m.scene().canonical_hash(), before, "one undo restores all");

    // Replace (one): the first hit only; a paragraph break in the text.
    m.apply_mutation(&Mutation::FindReplace {
        spec: spec("sat."),
        replace: "sat^pdown.".into(),
        replace_all: false,
        paragraph_style: None,
        character_style: None,
    })
    .expect("replace one");
    assert_eq!(texts(&m)[..2], ["The cat sat", "down."]);
    assert!(m
        .apply_mutation(&Mutation::FindReplace {
            spec: spec("zebra"),
            replace: String::new(),
            replace_all: true,
            paragraph_style: None,
            character_style: None,
        })
        .is_err());
}

#[test]
fn list_and_style_mutations_reach_the_model__feat__doc_word_list_levels() {
    let (mut m, story) = model();
    m.apply_mutation(&Mutation::SetListLevel {
        story_id: story.clone(),
        start: 0,
        end: 0,
        level: Some(3),
        delta: None,
    })
    .expect("level");
    assert_eq!(
        m.scene().stories[0].story.paragraphs[0].list_level.level,
        Some(3)
    );
    m.apply_mutation(&Mutation::RestartNumbering {
        story_id: story.clone(),
        start: 0,
        end: 0,
        start_at: Some(7),
        continue_numbering: false,
    })
    .expect("restart");
    assert_eq!(
        m.scene().stories[0].story.paragraphs[0].numbering_start_at,
        Some(7)
    );
    m.apply_mutation(&Mutation::SetStyleBasedOn {
        collection: paged_mutate::StyleCollection::Paragraph,
        style_id: "ParagraphStyle/Body".into(),
        based_on: Some("ParagraphStyle/Heading".into()),
    })
    .expect("based on");
    assert!(m
        .apply_mutation(&Mutation::SetStyleBasedOn {
            collection: paged_mutate::StyleCollection::Paragraph,
            style_id: "ParagraphStyle/Heading".into(),
            based_on: Some("ParagraphStyle/Body".into()),
        })
        .is_err());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]
    /// Find & Replace over any literal and replacement: undo restores the
    /// model exactly (ADR 197).
    #[test]
    fn find_replace_undo_restores_exactly__feat__doc_word_find_replace(
        find in "[a-zA-Z. ]{1,3}",
        replace in "[a-z^pt&]{0,5}",
        all in any::<bool>(),
    ) {
        let (mut m, _) = model();
        let before = m.scene().canonical_hash();
        let applied = m.apply_mutation(&Mutation::FindReplace {
            spec: spec(&find),
            replace,
            replace_all: all,
            paragraph_style: None,
            character_style: None,
        });
        if applied.is_ok() {
            m.undo().expect("undo");
        }
        prop_assert_eq!(m.scene().canonical_hash(), before);
    }
}
