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

//! Wave W4b (doc ADRs 614, 620) on its conformance documents: right-to-left
//! paragraphs and runs, East Asian and complex-script fonts lowered to the
//! engine's direction and script slots (engine ADR 1051), and every kind of
//! inline content control lowered to the engine's control (engine ADR
//! 1052) and saved back into its `w:sdt`.

#![allow(non_snake_case)]

use docx_conformance::{w4b_controls_docx, w4b_scripts_docx};
use docx_core::ContentControlKind;
use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn};
use docx_import::import_docx;
use docx_js::DocSession;
use docx_lower::ir::{LoweredDoc, LoweredStyle, PropValue};
use paged_ooxml::OpcPackage;

fn lowered(bytes: &[u8]) -> LoweredDoc {
    docx_lower::lower(&import_docx(bytes).unwrap())
}

fn part(bytes: &[u8], name: &str) -> String {
    String::from_utf8_lossy(OpcPackage::read(bytes).unwrap().part(name).unwrap()).into_owned()
}

/// With `W4B_DUMP` set, the saved file lands there (the Word probe opens
/// it: `scripts/word-pagination-probe.sh`).
fn dump(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("W4B_DUMP") {
        std::fs::write(format!("{dir}/{name}.docx"), bytes).unwrap();
    }
}

fn style<'a>(ir: &'a LoweredDoc, id: &str) -> &'a LoweredStyle {
    ir.styles.iter().find(|s| s.id == id).unwrap()
}

fn prop<'a>(s: &'a LoweredStyle, path: &str) -> Option<&'a PropValue> {
    s.props.iter().find(|p| p.path == path).map(|p| &p.value)
}

/// The read-back of an unedited pour: each run as the baseline lowered it.
fn identity(ir: &LoweredDoc) -> StoryContentIn {
    StoryContentIn {
        comments: Vec::new(),
        self_id: "Story/doc".into(),
        paragraphs: ir
            .story
            .paragraphs()
            .into_iter()
            .map(|p| ParagraphContentIn {
                mark_change: None,
                props_change: None,
                paragraph_style: p.para_style_id.clone(),
                runs: p
                    .runs
                    .iter()
                    .map(|r| RunContentIn {
                        text: r.text.clone(),
                        character_style: r.char_style_id.clone(),
                        control: r.control.as_ref().map(control_in),
                        ..Default::default()
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn control_in(c: &docx_core::ContentControl) -> docx_export::overlay::ControlIn {
    let (kind, checked, value) = match &c.kind {
        ContentControlKind::PlainText { .. } => ("plainText", None, None),
        ContentControlKind::RichText => ("richText", None, None),
        ContentControlKind::Checkbox { checked, .. } => ("checkbox", Some(*checked), None),
        ContentControlKind::DropDown { combo, value, .. } => (
            if *combo { "comboBox" } else { "dropDown" },
            None,
            value.clone(),
        ),
        ContentControlKind::Date { value, .. } => ("date", None, value.clone()),
    };
    docx_export::overlay::ControlIn {
        id: c.id.clone(),
        kind: kind.into(),
        showing_placeholder: c.showing_placeholder,
        checked,
        value,
    }
}

#[test]
fn right_to_left_and_script_fonts_lower_to_the_engines_slots__feat__doc_bidi_paragraph() {
    let ir = lowered(&w4b_scripts_docx());
    let paras = ir.story.paragraphs();
    let p0 = style(&ir, paras[0].para_style_id.as_deref().unwrap());
    assert_eq!(
        prop(p0, "paragraphDirection"),
        Some(&PropValue::Text("rtl".into()))
    );
    let r0 = style(&ir, paras[0].runs[0].char_style_id.as_deref().unwrap());
    assert_eq!(
        prop(r0, "characterDirection"),
        Some(&PropValue::Text("rtl".into()))
    );
    assert_eq!(
        prop(r0, "characterComplexFont"),
        Some(&PropValue::Text("Arial".into()))
    );
    assert_eq!(
        prop(r0, "characterComplexFontSize"),
        Some(&PropValue::Length(14.0))
    );
    assert_eq!(
        prop(r0, "characterComplexBold"),
        Some(&PropValue::Bool(true))
    );
    // The Hebrew paragraph's Latin word keeps no direction of its own.
    assert_eq!(paras[1].runs.len(), 3);
    // The Japanese run's East Asian face and hint.
    let ja = style(&ir, paras[2].runs[1].char_style_id.as_deref().unwrap());
    assert_eq!(
        prop(ja, "characterEastAsianFont"),
        Some(&PropValue::Text("MS Mincho".into()))
    );
    assert_eq!(
        prop(ja, "characterFontHint"),
        Some(&PropValue::Text("eastAsia".into()))
    );
}

#[test]
fn zero_edit_save_of_scripts_and_controls_is_byte_identical__feat__doc_script_font_slots() {
    for bytes in [w4b_scripts_docx(), w4b_controls_docx()] {
        let session = DocSession::load(&bytes).unwrap();
        let ir = lowered(&bytes);
        let (saved, skips) = session.save_edited_from_content(&identity(&ir)).unwrap();
        assert!(skips.is_empty(), "{skips:?}");
        assert_eq!(
            part(&saved, "word/document.xml"),
            part(&bytes, "word/document.xml")
        );
    }
}

#[test]
fn a_script_edit_is_written_back_as_words_run_properties__feat__doc_script_font_slots() {
    let bytes = w4b_scripts_docx();
    let session = DocSession::load(&bytes).unwrap();
    let ir = lowered(&bytes);
    let mut content = identity(&ir);
    // The canvas makes "world." right to left with a complex-script face.
    content.paragraphs[2].runs[2].script = Some(docx_export::overlay::RunScriptIn {
        direction: Some("rtl".into()),
        complex_font: Some("Tahoma".into()),
        ..Default::default()
    });
    let (saved, _) = session.save_edited_from_content(&content).unwrap();
    dump("w4b-scripts-saved", &saved);
    let re = import_docx(&saved).unwrap();
    let docx_core::Block::Paragraph(p) = &re.body[2] else {
        panic!("a paragraph")
    };
    assert_eq!(p.runs[2].props.rtl, Some(true));
    assert_eq!(p.runs[2].props.font_cs.as_deref(), Some("Tahoma"));
    // The other paragraphs keep their bytes.
    let xml = part(&saved, "word/document.xml");
    assert!(xml.contains("<w:rFonts w:cs=\"Arial\"/><w:bCs/><w:rtl/><w:szCs w:val=\"28\"/>"));
}

#[test]
fn every_control_kind_lowers_to_the_engines_control__feat__doc_content_controls() {
    let ir = lowered(&w4b_controls_docx());
    let runs = &ir.story.paragraphs()[0].runs;
    let controls: Vec<&docx_core::ContentControl> =
        runs.iter().filter_map(|r| r.control.as_ref()).collect();
    assert_eq!(controls.len(), 6, "{controls:#?}");
    assert!(
        matches!(&controls[0].kind, ContentControlKind::Checkbox { checked: false, checked_glyph, checked_font: Some(f), .. } if checked_glyph == "☒" && f == "MS Gothic")
    );
    assert_eq!(controls[0].id, "w11");
    assert_eq!(controls[0].tag.as_deref(), Some("agree"));
    assert!(
        matches!(&controls[1].kind, ContentControlKind::DropDown { combo: false, items, value: Some(v) } if items.len() == 2 && v == "r")
    );
    assert!(
        matches!(&controls[2].kind, ContentControlKind::Date { format: Some(f), value: Some(v) } if f == "d MMMM yyyy" && v == "2026-01-02")
    );
    assert!(matches!(
        controls[3].kind,
        ContentControlKind::PlainText { multi_line: false }
    ));
    assert!(controls[3].showing_placeholder);
    assert!(controls[3].placeholder_style.is_some());
    assert_eq!(controls[4].kind, ContentControlKind::RichText);
    assert!(matches!(
        &controls[5].kind,
        ContentControlKind::DropDown { combo: true, .. }
    ));
    // The JSON is the engine's (engine ADR 1052).
    let json = serde_json::to_value(controls[2]).unwrap();
    assert_eq!(json["kind"]["type"], "date");
    assert_eq!(json["kind"]["format"], "d MMMM yyyy");
}

#[test]
fn control_values_are_saved_into_their_sdt__feat__doc_content_controls() {
    let bytes = w4b_controls_docx();
    let session = DocSession::load(&bytes).unwrap();
    let ir = lowered(&bytes);
    let mut content = identity(&ir);
    let runs = &mut content.paragraphs[0].runs;
    let mut set = |id: &str, text: &str, f: &dyn Fn(&mut docx_export::overlay::ControlIn)| {
        let at = runs
            .iter()
            .position(|r| r.control.as_ref().is_some_and(|c| c.id == id))
            .unwrap();
        runs[at].text = text.into();
        let c = runs[at].control.as_mut().unwrap();
        f(c);
    };
    set("w11", "☒", &|c| c.checked = Some(true));
    set("w12", "Blue", &|c| c.value = Some("b".into()));
    set("w13", "30 October 2026", &|c| {
        c.value = Some("2026-10-30".into())
    });
    set("w14", "Ada", &|c| c.showing_placeholder = false);
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    dump("w4b-controls-saved", &saved);
    let xml = part(&saved, "word/document.xml");
    assert!(xml.contains(r#"<w14:checked w14:val="1"/>"#), "{xml}");
    assert!(xml.contains(r#"<w:dropDownList w:lastValue="b">"#), "{xml}");
    assert!(
        xml.contains(r#"w:fullDate="2026-10-30T00:00:00Z""#),
        "{xml}"
    );
    assert!(!xml.contains("showingPlcHdr"));
    // What did not change keeps its bytes: the rich text and the combo.
    assert!(xml.contains(r#"<w:sdt><w:sdtPr><w:id w:val="15"/><w:richText/></w:sdtPr><w:sdtContent><w:r><w:t>rich</w:t></w:r></w:sdtContent></w:sdt>"#));
    // Read back, every value is the canvas's.
    let re = lowered(&saved);
    let text: String = re.story.paragraphs()[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(
        text,
        "Agree ☒ colour Blue on 30 October 2026 by Ada note rich size Medium"
    );
    let controls: Vec<&docx_core::ContentControl> = re.story.paragraphs()[0]
        .runs
        .iter()
        .filter_map(|r| r.control.as_ref())
        .collect();
    assert!(matches!(
        controls[0].kind,
        ContentControlKind::Checkbox { checked: true, .. }
    ));
    assert!(!controls[3].showing_placeholder);
}

/// Word's answer for the W4b documents (`fixtures/w4b-*.word.json`,
/// `scripts/word-objects-probe.sh <out> w4b-scripts w4b-controls`), or
/// `None` where the recording is absent.
fn word(name: &str) -> Option<serde_json::Value> {
    let path = format!("{}/fixtures/{name}.word.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path)
        .ok()
        .map(|s| serde_json::from_str(&s).unwrap())
}

/// The text boxes Word draws on the first page, as (left, right, text).
fn word_lines(answer: &serde_json::Value) -> Vec<(f64, f64, String)> {
    answer["pages"][0]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            let left = l["left"].as_f64().unwrap();
            let width = l["width"].as_f64().unwrap();
            (left, left + width, l["text"].as_str().unwrap().to_string())
        })
        .collect()
}

/// Word reads `w:jc` and `w:ind` in a `w:bidi` paragraph logically, from
/// the paragraph's start edge (the right): `left` sets the line against
/// the right margin (540 pt on a 612 pt page with 72 pt margins), a left
/// indent of 1 in holds it 72 pt off that margin, and `right` sets it
/// against the left margin. The lowering keeps `jc` and `ind` as Word
/// wrote them beside the paragraph's direction, which the engine reads
/// the same way (engine ADR 1051).
#[test]
fn right_to_left_alignment_and_indents_are_logical_as_in_word__feat__doc_bidi_paragraph() {
    let Some(answer) = word("w4b-scripts") else {
        return;
    };
    let lines = word_lines(&answer);
    let find = |needle: &str| {
        lines
            .iter()
            .find(|(_, _, t)| t.contains(needle))
            .unwrap_or_else(|| panic!("Word drew no line with {needle:?}"))
            .clone()
    };
    // p0, Arabic, `jc="left"`: against the right margin.
    let arabic = lines
        .iter()
        .find(|(_, _, t)| t.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c)))
        .expect("the Arabic line");
    assert!((arabic.1 - 540.0).abs() <= 2.0, "{arabic:?}");
    // p1, Hebrew with a Latin word: the base direction orders the runs
    // right to left, so the digits stand leftmost and the Hebrew rightmost.
    let (digits, word_run) = (find("2026"), find("Word"));
    assert!(digits.0 < word_run.0, "{digits:?} {word_run:?}");
    // p3, `jc="left"` and `ind w:left="1440"`: 72 pt off the right margin.
    let indented = find("Bidi left indented");
    assert!((indented.1 - 468.0).abs() <= 2.0, "{indented:?}");
    // p4, `jc="right"`: against the left margin.
    let right = find("Bidi right");
    assert!((right.0 - 72.0).abs() <= 2.0, "{right:?}");

    let ir = lowered(&w4b_scripts_docx());
    let paras = ir.story.paragraphs();
    let p3 = style(&ir, paras[3].para_style_id.as_deref().unwrap());
    assert_eq!(
        prop(p3, "paragraphDirection"),
        Some(&PropValue::Text("rtl".into()))
    );
    assert_eq!(
        prop(p3, "paragraphJustification"),
        Some(&PropValue::Text("LeftAlign".into()))
    );
    assert_eq!(
        prop(p3, "paragraphLeftIndent"),
        Some(&PropValue::Length(72.0))
    );
    let p4 = style(&ir, paras[4].para_style_id.as_deref().unwrap());
    assert_eq!(
        prop(p4, "paragraphJustification"),
        Some(&PropValue::Text("RightAlign".into()))
    );
}

/// Word draws every inline control as text of its line: the checkbox's
/// unchecked glyph between "Agree " and " colour", the drop-down's and the
/// date's shown values, the placeholder text, all on one line.
#[test]
fn controls_draw_as_text_of_their_line_as_in_word__feat__doc_content_controls() {
    let Some(answer) = word("w4b-controls") else {
        return;
    };
    let tops: Vec<f64> = answer["pages"][0]["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["top"].as_f64().unwrap())
        .collect();
    assert!(
        tops.iter().all(|t| (t - tops[0]).abs() <= 2.0),
        "one line: {tops:?}"
    );
    let lines = word_lines(&answer);
    let at = |needle: &str| {
        lines
            .iter()
            .find(|(_, _, t)| t.contains(needle))
            .unwrap_or_else(|| panic!("Word drew no {needle:?}"))
            .0
    };
    assert!(at("Agree") < at("\u{2610}") && at("\u{2610}") < at("colour"));
    let text: String = {
        let mut l = lines.clone();
        l.sort_by(|a, b| a.0.total_cmp(&b.0));
        l.into_iter().map(|(_, _, t)| t).collect()
    };
    for shown in ["Red", "2 January 2026", "Click here", "rich", "Medium"] {
        assert!(text.contains(shown), "{shown:?} in {text:?}");
    }
}
