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

//! Word-parity wave W1, plugin side: theme colours and fonts (doc ADR 609)
//! and save-back completeness (doc ADR 610) — the paragraph style applied on
//! the canvas, a new cell paragraph's own style, and `styles.xml` written
//! when a Word style is modified or a style is made in paged. A zero-edit
//! save stays byte-identical part for part.

// Test names end in their cockpit feature (`__feat__<id>`).
#![allow(non_snake_case)]

use std::collections::BTreeMap;

use docx_conformance::{completeness_docx, theme_docx};
use docx_core::{Block, ThemeColorRef};
use docx_export::{
    CellContentIn, ParagraphContentIn, RunContentIn, StoryContentIn, StyleEntryIn, StyleIn,
};
use docx_import::import_docx;
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredDoc, PropValue};
use docx_lower::{char_style_token, para_style_token};
use paged_ooxml::OpcPackage;

fn part(bytes: &[u8], name: &str) -> String {
    let pkg = OpcPackage::read(bytes).unwrap();
    String::from_utf8(pkg.part(name).unwrap().to_vec()).unwrap()
}

fn assert_parts_identical(original: &[u8], saved: &[u8], except: &[&str]) {
    let a = OpcPackage::read(original).unwrap();
    let b = OpcPackage::read(saved).unwrap();
    for name in a.file_names() {
        if except.contains(&name) {
            continue;
        }
        assert_eq!(a.part(name), b.part(name), "part {name} byte-identical");
    }
}

/// The host's read-back of an unedited document.
fn identity(base: &LoweredDoc) -> StoryContentIn {
    StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: p
                        .runs
                        .iter()
                        .map(|r| RunContentIn {
                            text: r.text.clone(),
                            character_style: r.char_style_id.clone(),
                            ..Default::default()
                        })
                        .collect(),
                }),
                _ => None,
            })
            .collect(),
    }
}

/// The host's style read of every Word style, unedited: each style's own
/// properties as the lowering made them (`""` / `null` for the rest).
fn styles_read(session: &DocSession, base: &LoweredDoc) -> Vec<StyleIn> {
    session
        .style_tokens()
        .into_iter()
        .map(|token| {
            let own = base
                .styles
                .iter()
                .find(|s| s.id == token)
                .map(|s| s.props.clone())
                .unwrap_or_default();
            let entries = own
                .iter()
                .map(|p| StyleEntryIn {
                    path: p.path.clone(),
                    value: wire(&p.value),
                })
                .collect();
            StyleIn {
                collection: if token.starts_with("CharacterStyle/") {
                    "character".into()
                } else {
                    "paragraph".into()
                },
                style_id: token,
                entries,
                ..Default::default()
            }
        })
        .collect()
}

/// A lowering value as the wire `Value` JSON the host sends.
fn wire(v: &PropValue) -> Option<docx_export::WireValue> {
    let json = match v {
        PropValue::Text(s) => format!(r#"{{"type":"text","value":{s:?}}}"#),
        PropValue::Length(n) => format!(r#"{{"type":"length","value":{n}}}"#),
        PropValue::Bool(b) => format!(r#"{{"type":"bool","value":{b}}}"#),
        PropValue::ColorRef(c) => format!(r#"{{"type":"colorRef","value":{c:?}}}"#),
        PropValue::TabStops(_) => return None,
    };
    serde_json::from_str(&json).ok()
}

fn entry(path: &str, json: &str) -> StyleEntryIn {
    StyleEntryIn {
        path: path.into(),
        value: serde_json::from_str(json).ok(),
    }
}

fn set_entry(style: &mut StyleIn, path: &str, json: &str) {
    style.entries.retain(|e| e.path != path);
    style.entries.push(entry(path, json));
}

fn tref(slot: &str, tint: Option<u8>, shade: Option<u8>) -> ThemeColorRef {
    ThemeColorRef {
        slot: slot.into(),
        tint,
        shade,
    }
}

// ---------------------------------------------------------------------------
// Theme colours and fonts (doc ADR 609)

#[test]
fn theme_colours_and_fonts_resolve_and_keep_their_reference__feat__plugin_doc_read_path() {
    let doc = import_docx(&theme_docx()).unwrap();
    let theme = doc.theme.as_ref().expect("the theme part is read");
    assert_eq!(theme.base_color("accent1"), Some("4472C4"));
    assert_eq!(theme.base_color("text1"), Some("000000"), "sysClr lastClr");
    assert_eq!(theme.minor.latin.as_deref(), Some("Calibri"));
    assert_eq!(theme.major.latin.as_deref(), Some("Calibri Light"));

    // The defaults' theme font resolves to the theme's body face.
    let defaults = &doc.styles.doc_defaults.run;
    assert_eq!(defaults.font.as_deref(), Some("Calibri"));
    assert_eq!(defaults.font_theme.as_deref(), Some("minorHAnsi"));
    assert_eq!(defaults.font_east_asia.as_deref(), Some("MS Mincho"));
    assert_eq!(defaults.font_cs, None, "an empty theme face is no face");

    // Heading 1: the heading face, Accent 1 darker 25 %.
    let h1 = doc
        .styles
        .styles
        .iter()
        .find(|s| s.style_id == "Heading1")
        .unwrap();
    assert_eq!(h1.run.font.as_deref(), Some("Calibri Light"));
    assert_eq!(h1.run.font_theme.as_deref(), Some("majorHAnsi"));
    assert_eq!(h1.run.theme_color, Some(tref("accent1", None, Some(0xBF))));
    let shade = docx_core::theme::tinted("4472C4", None, Some(0xBF)).unwrap();
    assert_eq!(h1.run.color.as_deref(), Some(shade.as_str()));

    let Block::Paragraph(p1) = &doc.body[1] else {
        panic!()
    };
    let looks: Vec<_> = p1
        .runs
        .iter()
        .map(|r| (r.props.color.clone(), r.props.theme_color.clone()))
        .collect();
    let tint = docx_core::theme::tinted("4472C4", Some(0x99), None).unwrap();
    assert_eq!(
        looks,
        [
            (Some("ED7D31".into()), Some(tref("accent2", None, None))),
            (Some(tint), Some(tref("accent1", Some(0x99), None))),
            (Some("000000".into()), Some(tref("text1", None, None))),
            (Some("FF0000".into()), None),
        ]
    );
    let Block::Paragraph(p2) = &doc.body[2] else {
        panic!()
    };
    let shading = p2.runs[0].props.shading.clone().unwrap();
    assert_eq!(shading.fill.as_deref(), Some("70AD47"));
    assert_eq!(shading.theme_fill, Some(tref("accent6", None, None)));
    assert_eq!(
        p2.runs[0].props.font_east_asia.as_deref(),
        Some("MS Mincho")
    );
}

#[test]
fn theme_colours_lower_to_the_word_theme_swatch_group__feat__plugin_doc_read_path() {
    let ir = docx_lower::lower(&import_docx(&theme_docx()).unwrap());
    let names: Vec<(&str, &str)> = ir
        .swatches
        .iter()
        .filter(|s| s.theme.is_some())
        .map(|s| (s.id.as_str(), s.name.as_str()))
        .collect();
    for (id, name) in [
        ("Color/docx-theme-dark1", "Dark 1"),
        ("Color/docx-theme-light2", "Light 2"),
        ("Color/docx-theme-accent6", "Accent 6"),
        ("Color/docx-theme-hyperlink", "Hyperlink"),
        ("Color/docx-theme-followedHyperlink", "Followed Hyperlink"),
        ("Color/docx-theme-accent1-tint-99", "Accent 1, Lighter 40%"),
        ("Color/docx-theme-accent1-shade-BF", "Accent 1, Darker 25%"),
        ("Color/docx-theme-text1", "Text 1"),
    ] {
        assert!(names.contains(&(id, name)), "{id} {name}: {names:?}");
    }
    let group = &ir.color_groups[0];
    assert_eq!(group.name, "Word theme");
    assert_eq!(group.members.len(), names.len());
    assert_eq!(&group.members[..12], {
        let first: Vec<String> = docx_core::theme::SCHEME_SLOTS
            .iter()
            .map(|(w, _)| format!("Color/docx-theme-{w}"))
            .collect();
        first
    });
    // A run in Accent 2 references the theme swatch, not a hex one.
    let LoweredBlock::Paragraph(p1) = &ir.story.blocks[1] else {
        panic!()
    };
    let token = p1.runs[0].char_style_id.clone().unwrap();
    let style = ir.styles.iter().find(|s| s.id == token).unwrap();
    assert!(style.props.iter().any(|p| p.path == "characterFillColor"
        && p.value == PropValue::ColorRef("Color/docx-theme-accent2".into())));
    // The theme fonts resolve to concrete families.
    assert!(ir.styles.iter().any(|s| s
        .props
        .iter()
        .any(|p| p.value == PropValue::Text("Calibri Light".into()))));
    assert_eq!(
        ir.theme_fonts.as_ref().and_then(|f| f.minor.as_deref()),
        Some("Calibri")
    );
}

#[test]
fn a_zero_edit_save_of_a_themed_document_is_byte_identical__feat__plugin_doc_save_back() {
    let original = theme_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let colors: BTreeMap<String, String> = base
        .swatches
        .iter()
        .filter(|s| s.theme.is_some())
        .map(|s| (s.id.clone(), s.theme.as_ref().unwrap().rgb.clone()))
        .collect();
    let styles = styles_read(&session, &base);
    let (saved, skips) = session
        .save_edited_full(
            &identity(&base),
            &[],
            &[],
            &colors,
            &styles,
            docx_export::TableParagraphs::Joined,
        )
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    assert_parts_identical(&original, &saved, &[]);
}

#[test]
fn an_unchanged_theme_colour_keeps_its_reference_and_a_changed_one_writes_hex__feat__plugin_doc_save_back(
) {
    let original = theme_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = identity(&base);
    // "Accent " typed into (its colour unchanged); "light " recoloured
    // red; "plain" recoloured to Accent 1 lighter 40 %.
    {
        let runs = &mut content.paragraphs[1].runs;
        runs[0].text = "Accents ".into();
        runs[1].fill_color = Some("Color/docx-FF0000".into());
        runs[3].fill_color = Some("Color/docx-theme-accent1-tint-99".into());
    }
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/document.xml");
    assert!(
        xml.contains(r#"<w:color w:val="ED7D31" w:themeColor="accent2"/></w:rPr><w:t xml:space="preserve">Accents </w:t>"#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">light </w:t>"#),
        "{xml}"
    );
    let tint = docx_core::theme::tinted("4472C4", Some(0x99), None).unwrap();
    assert!(
        xml.contains(&format!(
            r#"<w:color w:val="{tint}" w:themeColor="accent1" w:themeTint="99"/></w:rPr><w:t>plain</w:t>"#
        )),
        "{xml}"
    );
    assert_parts_identical(&original, &saved, &["word/document.xml"]);
}

#[test]
fn an_edited_theme_swatch_writes_its_runs_as_hex__feat__plugin_doc_save_back() {
    let original = theme_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let colors = BTreeMap::from([("Color/docx-theme-accent2".to_string(), "00FF00".to_string())]);
    let (saved, _) = session
        .save_edited_full(
            &identity(&base),
            &[],
            &[],
            &colors,
            &[],
            docx_export::TableParagraphs::Joined,
        )
        .unwrap();
    let xml = part(&saved, "word/document.xml");
    assert!(
        xml.contains(r#"<w:color w:val="00FF00"/></w:rPr><w:t xml:space="preserve">Accent </w:t>"#),
        "{xml}"
    );
    // The other theme colours keep their references.
    assert!(xml.contains(r#"w:themeColor="accent1" w:themeTint="99""#));
}

// ---------------------------------------------------------------------------
// Save-back completeness (doc ADR 610)

#[test]
fn the_paragraph_style_applied_on_the_canvas_is_saved__feat__plugin_doc_save_back() {
    let original = completeness_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = identity(&base);
    content.paragraphs[1].paragraph_style = Some(para_style_token("Quote"));
    // A style the lowering does not know (the engine's own) changes nothing.
    content.paragraphs[0].paragraph_style = Some("ParagraphStyle/$ID/[No paragraph style]".into());
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/document.xml");
    assert!(
        xml.contains(
            r#"<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Second paragraph.</w:t>"#
        ),
        "{xml}"
    );
    assert!(xml.contains(r#"<w:p><w:r><w:t>First paragraph.</w:t>"#));
    assert_parts_identical(&original, &saved, &["word/document.xml"]);
}

#[test]
fn a_paragraph_added_in_a_cell_takes_its_own_paragraph_style__feat__plugin_doc_save_back() {
    let original = completeness_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let normal = para_style_token("Normal");
    let heading = base
        .story
        .blocks
        .iter()
        .find_map(|b| match b {
            LoweredBlock::Table(t) => t.cells[0].paragraphs[0].para_style_id.clone(),
            _ => None,
        })
        .unwrap();
    let cells = [CellContentIn {
        block: 3,
        cell: 0,
        text: "Cell heading\nNew line".into(),
        paragraphs: Some(vec![
            ParagraphContentIn {
                paragraph_style: Some(heading),
                runs: vec![RunContentIn {
                    text: "Cell heading".into(),
                    ..Default::default()
                }],
            },
            ParagraphContentIn {
                paragraph_style: Some(normal),
                runs: vec![RunContentIn {
                    text: "New line".into(),
                    ..Default::default()
                }],
            },
        ]),
    }];
    let (saved, skips) = session
        .save_edited_from_content_and_cells(&identity(&base), &cells)
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/document.xml");
    assert!(
        xml.contains(r#"<w:t>Cell heading</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">New line</w:t></w:r></w:p>"#),
        "{xml}"
    );
}

#[test]
fn a_word_style_modified_in_paged_is_spliced_into_styles_xml__feat__plugin_doc_save_back() {
    let original = theme_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut styles = styles_read(&session, &base);
    let h1 = para_style_token("Heading1");
    let heading = styles.iter_mut().find(|s| s.style_id == h1).unwrap();
    set_entry(
        heading,
        "characterFontSize",
        r#"{"type":"length","value":20}"#,
    );
    set_entry(
        heading,
        "paragraphJustification",
        r#"{"type":"text","value":"CenterAlign"}"#,
    );
    set_entry(
        heading,
        "characterFillColor",
        r#"{"type":"colorRef","value":"Color/docx-theme-accent6"}"#,
    );
    let (saved, skips) = session
        .save_edited_full(
            &identity(&base),
            &[],
            &[],
            &BTreeMap::new(),
            &styles,
            docx_export::TableParagraphs::Joined,
        )
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/styles.xml");
    assert!(
        xml.contains(r#"<w:pPr><w:keepNext/><w:spacing w:before="240"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr>"#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="70AD47" w:themeColor="accent6"/><w:sz w:val="40"/></w:rPr>"#),
        "{xml}"
    );
    // Every other style, and every other part, as it was.
    let quote = r#"<w:style w:type="paragraph" w:styleId="Quote">"#;
    let before = part(&original, "word/styles.xml");
    let tail = |s: &str| s[s.find(quote).unwrap()..].to_string();
    assert_eq!(tail(&xml), tail(&before));
    assert_parts_identical(&original, &saved, &["word/styles.xml"]);
}

#[test]
fn a_style_made_in_paged_is_appended_to_styles_xml__feat__plugin_doc_save_back() {
    let original = theme_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut styles = styles_read(&session, &base);
    let callout = "ParagraphStyle/u42".to_string();
    styles.push(StyleIn {
        collection: "paragraph".into(),
        style_id: callout.clone(),
        name: Some("My Callout".into()),
        based_on: Some(para_style_token("Quote")),
        entries: vec![
            entry("characterFontStyle", r#"{"type":"text","value":"Bold"}"#),
            entry("characterFontFamily", r#"{"type":"text","value":""}"#),
            entry("paragraphSpaceAfter", r#"{"type":"length","value":12}"#),
            entry("characterUnderline", r#"{"type":"bool","value":false}"#),
        ],
    });
    let emph = "CharacterStyle/u43".to_string();
    styles.push(StyleIn {
        collection: "character".into(),
        style_id: emph.clone(),
        name: Some("Strong Red".into()),
        based_on: Some(char_style_token("Emph")),
        entries: vec![entry(
            "characterFillColor",
            r#"{"type":"colorRef","value":"Color/docx-FF0000"}"#,
        )],
    });
    let mut content = identity(&base);
    content.paragraphs[3].paragraph_style = Some(callout);
    content.paragraphs[3].runs[0].character_style = Some(emph);
    let (saved, skips) = session
        .save_edited_full(
            &content,
            &[],
            &[],
            &BTreeMap::new(),
            &styles,
            docx_export::TableParagraphs::Joined,
        )
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/styles.xml");
    assert!(
        xml.contains(r#"<w:style w:type="paragraph" w:customStyle="1" w:styleId="MyCallout"><w:name w:val="My Callout"/><w:basedOn w:val="Quote"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:i w:val="false"/></w:rPr></w:style>"#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:style w:type="character" w:customStyle="1" w:styleId="StrongRed"><w:name w:val="Strong Red"/><w:basedOn w:val="Emph"/><w:qFormat/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style></w:styles>"#),
        "{xml}"
    );
    let doc = part(&saved, "word/document.xml");
    assert!(
        doc.contains(r#"<w:pStyle w:val="MyCallout"/>"#)
            && doc.contains(r#"<w:rStyle w:val="StrongRed"/>"#),
        "{doc}"
    );
    // The saved document opens with its new styles.
    let reopened = import_docx(&saved).unwrap();
    let mine = reopened
        .styles
        .styles
        .iter()
        .find(|s| s.style_id == "MyCallout")
        .unwrap();
    assert_eq!(mine.based_on.as_deref(), Some("Quote"));
    assert_eq!(mine.run.bold, Some(true));
}

#[test]
fn an_edited_run_keeps_a_note_reference_inside_its_text_in_place__feat__plugin_doc_save_back() {
    let original = completeness_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut content = identity(&base);
    let runs = &mut content.paragraphs[2].runs;
    let text: String = runs.iter().map(|r| r.text.as_str()).collect();
    // The reference reads as the engine's footnote marker (doc ADR 611).
    assert_eq!(text, "Before\u{E01C} after.");
    runs.truncate(1);
    runs[0].text = "Before, after!".into();
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = part(&saved, "word/document.xml");
    assert!(
        xml.contains(r#"<w:r><w:t xml:space="preserve">Before</w:t><w:footnoteReference w:id="1"/><w:t xml:space="preserve">, after!</w:t></w:r>"#),
        "{xml}"
    );
}

/// The bundle's headless tests open `theme-styles.docx`: it is this
/// builder's output (`WRITE_FIXTURES=1` writes it again).
#[test]
fn the_bundle_fixture_is_the_theme_builder__feat__plugin_doc_save_back() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/doc-bundle/test/fixtures/theme-styles.docx"
    );
    let built = theme_docx();
    if std::env::var("WRITE_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(path, &built).unwrap();
    }
    let committed = std::fs::read(path).unwrap();
    let a = OpcPackage::read(&built).unwrap();
    let b = OpcPackage::read(&committed).unwrap();
    for name in a.file_names() {
        assert_eq!(a.part(name), b.part(name), "{name}");
    }
}
