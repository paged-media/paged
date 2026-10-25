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

//! Engine ADR 1018 — Word's character additions and list levels, drawn:
//! highlight as a rect behind the glyphs, the underline kinds and double
//! strikethrough as their strokes, hidden text taking no room unless the
//! document shows it, and list levels numbering `1.` / `1.1.` with a
//! multi-level restart.
// Test names carry their feature row (`…__feat__…`).
#![allow(non_snake_case)]

use std::io::Write;
use std::path::PathBuf;

use paged_compose::{DisplayCommand, PathSegment};
use paged_model::{NumberingLevelDef, NumberingListDef, UnderlineKind};
use paged_renderer::{pipeline, BytesResolver, PipelineOptions};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn font() -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(p).expect("Inter.ttf fixture")
}

fn put(zip: &mut ZipWriter<std::io::Cursor<Vec<u8>>>, path: &str, body: &[u8]) {
    zip.start_file(path, SimpleFileOptions::default()).unwrap();
    zip.write_all(body).unwrap();
}

/// One frame, one story whose paragraphs are `paras` (each one run in
/// Inter 24 pt carrying `attrs`).
fn idml(paras: &[(&str, &str)]) -> Vec<u8> {
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    zip.start_file("mimetype", stored).unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    put(
        &mut zip,
        "designmap.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_u10.xml"/>
</Document>"#,
    );
    put(
        &mut zip,
        "Resources/Graphic.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Graphic xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Color Self="Color/Yellow" Model="Process" Space="RGB" ColorValue="255 255 0" Name="Yellow"/>
  <Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/>
</idPkg:Graphic>"#,
    );
    put(
        &mut zip,
        "Spreads/Spread_sp1.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging">
  <Spread Self="sp1">
    <Page Self="p1" GeometricBounds="0 0 600 612"/>
    <TextFrame Self="frameA" ParentStory="u10" GeometricBounds="40 40 560 572" StrokeWeight="0"/>
  </Spread>
</idPkg:Spread>"#,
    );
    let body: String = paras
        .iter()
        .enumerate()
        .map(|(i, (attrs, text))| {
            let br = if i + 1 < paras.len() { "<Br/>" } else { "" };
            format!(
                r#"<ParagraphStyleRange><CharacterStyleRange AppliedFont="Inter" PointSize="24"{attrs}><Content>{text}</Content>{br}</CharacterStyleRange></ParagraphStyleRange>"#
            )
        })
        .collect();
    let story = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u10">{body}</Story></idPkg:Story>"#
    );
    put(&mut zip, "Stories/Story_u10.xml", story.as_bytes());
    zip.finish().unwrap().into_inner()
}

fn open(paras: &[(&str, &str)]) -> paged_scene::Document {
    idml_import::import_idml_doc(&idml(paras)).unwrap()
}

fn build(doc: &paged_scene::Document) -> paged_renderer::BuiltDocument {
    let mut resolver = BytesResolver::new();
    resolver.add_font("Inter", None, font());
    let opts = PipelineOptions {
        assets: Some(&resolver),
        ..PipelineOptions::default()
    };
    pipeline::build_document(doc, &opts).unwrap()
}

/// Horizontal two-point stroke paths: `(y, width, dashed)`.
fn strokes(page: &paged_renderer::BuiltPage) -> Vec<(f32, f32, bool)> {
    page.list
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::StrokePath {
                path_id, stroke, ..
            } => {
                let path = page.list.paths.get(*path_id)?;
                match path.segments.as_slice() {
                    [PathSegment::MoveTo { y, .. }, PathSegment::LineTo { y: y2, .. }] => {
                        Some((*y, (*y2 - *y).abs(), stroke.dash.len > 0))
                    }
                    _ => None,
                }
            }
            _ => None,
        })
        .collect()
}

/// Glyph fills (uniform scale with a y flip) and other fills, in order.
fn fills(page: &paged_renderer::BuiltPage) -> Vec<bool> {
    page.list
        .commands
        .iter()
        .filter_map(|c| match c {
            DisplayCommand::FillPath { transform, .. } => {
                let [a, b, c2, d, _, _] = transform.0;
                Some(
                    b.abs() < 1e-5 && c2.abs() < 1e-5 && a > 0.0 && d < 0.0 && (a + d).abs() < 1e-4,
                )
            }
            _ => None,
        })
        .collect()
}

#[test]
fn highlight_paints_a_rect_behind_the_glyphs__feat__doc_word_character_model() {
    let plain = open(&[("", "Highlight")]);
    let mut lit = plain.clone();
    lit.stories[0].story.paragraphs[0].runs[0]
        .decorations
        .highlight_color = Some("Color/Yellow".into());
    let before = fills(&build(&plain).pages[0]);
    let after = fills(&build(&lit).pages[0]);
    let rects = |f: &[bool]| f.iter().filter(|g| !**g).count();
    assert_eq!(rects(&after), rects(&before) + 1, "one highlight band");
    let first_glyph = after.iter().position(|g| *g).unwrap();
    assert!(
        after[..first_glyph].iter().filter(|g| !**g).count()
            > before[..before.iter().position(|g| *g).unwrap()]
                .iter()
                .filter(|g| !**g)
                .count(),
        "the band comes before the glyphs"
    );
    // "No highlight" over nothing draws nothing.
    let mut none = plain.clone();
    none.stories[0].story.paragraphs[0].runs[0]
        .decorations
        .highlight_color = Some(paged_model::NO_HIGHLIGHT.into());
    assert_eq!(rects(&fills(&build(&none).pages[0])), rects(&before));
}

#[test]
fn underline_kinds_draw_their_strokes__feat__doc_word_character_model() {
    let count = |attrs: &str| strokes(&build(&open(&[(attrs, "Under lined")])).pages[0]);
    let single = count(r#" Underline="true""#);
    assert_eq!(single.len(), 1);
    let double = count(r#" Underline="true" UnderlineType="StrokeStyle/$ID/ThinThin""#);
    assert_eq!(double.len(), 2, "double: two lines");
    let dotted = count(r#" Underline="true" UnderlineType="StrokeStyle/$ID/Canned Dotted""#);
    assert!(
        dotted.len() == 1 && dotted[0].2,
        "dotted: one dashed stroke"
    );
    let wave = count(r#" Underline="true" UnderlineType="StrokeStyle/$ID/Wavy""#);
    assert!(wave.len() > 4, "wave: many short steps, got {}", wave.len());

    // Words: the space stays bare — two pieces.
    let mut words = open(&[(r#" Underline="true""#, "Under lined")]);
    words.stories[0].story.paragraphs[0].runs[0]
        .decorations
        .underline_kind = Some(UnderlineKind::Words);
    assert_eq!(strokes(&build(&words).pages[0]).len(), 2);

    // Thick is wider than single.
    let mut thick = open(&[(r#" Underline="true""#, "Thick")]);
    thick.stories[0].story.paragraphs[0].runs[0]
        .decorations
        .underline_kind = Some(UnderlineKind::Thick);
    let built = build(&thick);
    let w_thick = built.pages[0]
        .list
        .commands
        .iter()
        .find_map(|c| match c {
            DisplayCommand::StrokePath { stroke, .. } => Some(stroke.width),
            _ => None,
        })
        .unwrap();
    let plain = build(&open(&[(r#" Underline="true""#, "Thick")]));
    let w_single = plain.pages[0]
        .list
        .commands
        .iter()
        .find_map(|c| match c {
            DisplayCommand::StrokePath { stroke, .. } => Some(stroke.width),
            _ => None,
        })
        .unwrap();
    assert!(w_thick > w_single * 1.5);

    // A kind with the switch explicitly off draws nothing.
    let mut off = open(&[(r#" Underline="false""#, "Off")]);
    off.stories[0].story.paragraphs[0].runs[0]
        .decorations
        .underline_kind = Some(UnderlineKind::Double);
    assert!(strokes(&build(&off).pages[0]).is_empty());
}

#[test]
fn double_strikethrough_draws_two_lines__feat__doc_word_character_model() {
    let mut doc = open(&[("", "Struck")]);
    doc.stories[0].story.paragraphs[0].runs[0]
        .decorations
        .double_strikethrough = Some(true);
    assert_eq!(strokes(&build(&doc).pages[0]).len(), 2);
    let single = build(&open(&[(r#" StrikeThru="true""#, "Struck")]));
    assert_eq!(strokes(&single.pages[0]).len(), 1);
}

#[test]
fn hidden_text_takes_no_room_unless_shown__feat__doc_word_character_model() {
    let plain = open(&[("", "Visible"), ("", "Secret"), ("", "After")]);
    let glyphs =
        |d: &paged_scene::Document| fills(&build(d).pages[0]).iter().filter(|g| **g).count();
    let all = glyphs(&plain);
    let mut hidden = plain.clone();
    hidden.stories[0].story.paragraphs[1].runs[0]
        .decorations
        .hidden = Some(true);
    assert_eq!(
        glyphs(&hidden),
        all - "Secret".len(),
        "the hidden run draws nothing"
    );
    hidden.designmap.document_preference.show_hidden_text = Some(true);
    assert_eq!(glyphs(&hidden), all, "shown, it draws again");

    // Hidden through a character style.
    let mut styled = plain.clone();
    styled.styles.character_styles.insert(
        "CharacterStyle/Hidden".into(),
        paged_model::CharacterStyleDef {
            self_id: "CharacterStyle/Hidden".into(),
            decorations: paged_model::CharacterDecorations {
                hidden: Some(true),
                ..Default::default()
            },
            ..Default::default()
        },
    );
    styled.stories[0].story.paragraphs[1].runs[0].character_style =
        Some("CharacterStyle/Hidden".into());
    assert_eq!(glyphs(&styled), all - "Secret".len());
}

/// A Word list: level 1 `%1.`, level 2 `%1.%2.` restarting after level 1.
fn word_list() -> NumberingListDef {
    NumberingListDef {
        self_id: "NumberingList/w1".into(),
        name: Some("Word 1".into()),
        levels: vec![
            NumberingLevelDef {
                level: 1,
                list_type: Some("NumberedList".into()),
                format: Some("decimal".into()),
                expression: Some("%1.".into()),
                suffix: Some(paged_model::ListSuffix::Tab),
                start_at: Some(1),
                left_indent: Some(18.0),
                first_line_indent: Some(-18.0),
                ..Default::default()
            },
            NumberingLevelDef {
                level: 2,
                list_type: Some("NumberedList".into()),
                format: Some("decimal".into()),
                expression: Some("%1.%2.".into()),
                suffix: Some(paged_model::ListSuffix::Tab),
                start_at: Some(1),
                restart_after: Some(1),
                left_indent: Some(36.0),
                first_line_indent: Some(-18.0),
                ..Default::default()
            },
            NumberingLevelDef {
                level: 3,
                list_type: Some("BulletList".into()),
                bullet_character: Some(0x25AA),
                suffix: Some(paged_model::ListSuffix::Tab),
                expression: Some("".into()),
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}

fn listed(levels: &[u32]) -> paged_scene::Document {
    let paras: Vec<(&str, &str)> = levels.iter().map(|_| ("", "Item")).collect();
    let mut doc = open(&paras);
    doc.styles
        .numbering_lists
        .insert("NumberingList/w1".into(), word_list());
    for (p, level) in doc.stories[0].story.paragraphs.iter_mut().zip(levels) {
        p.applied_numbering_list = Some("NumberingList/w1".into());
        p.list_level.level = Some(*level);
    }
    doc
}

fn labels(doc: &paged_scene::Document) -> Vec<String> {
    pipeline::story_list_labels(doc, &doc.stories[0].story)
        .into_iter()
        .map(|l| l.unwrap_or_default())
        .collect()
}

#[test]
fn word_list_levels_number_with_multi_level_restart__feat__doc_word_list_levels() {
    let doc = listed(&[1, 2, 2, 1, 2, 3]);
    assert_eq!(
        labels(&doc),
        ["1.\t", "1.1.\t", "1.2.\t", "2.\t", "2.1.\t", "\u{25AA}\t"]
    );
    // The level's indents reach the resolved paragraph.
    let attrs = doc.resolved_paragraph_attrs(&doc.stories[0].story.paragraphs[1]);
    assert_eq!(attrs.left_indent, Some(36.0));
    assert_eq!(attrs.first_line_indent, Some(-18.0));
    // A paragraph's own indent wins over the level's.
    let mut own = listed(&[1]);
    own.stories[0].story.paragraphs[0].left_indent = Some(5.0);
    let a = own.resolved_paragraph_attrs(&own.stories[0].story.paragraphs[0]);
    assert_eq!(a.left_indent, Some(5.0));
}

#[test]
fn word_lists_continue_past_other_paragraphs_and_restart_on_request__feat__doc_word_list_levels() {
    let mut doc = listed(&[1, 1, 1, 2]);
    // An unlisted paragraph between does not restart a Word list.
    doc.stories[0].story.paragraphs[1].applied_numbering_list = None;
    doc.stories[0].story.paragraphs[1].list_level.level = None;
    assert_eq!(labels(&doc), ["1.\t", "", "2.\t", "2.1.\t"]);
    // Restart Numbering (`NumberingContinue` false) on the third.
    doc.stories[0].story.paragraphs[2].numbering_continue = Some(false);
    doc.stories[0].story.paragraphs[2].numbering_start_at = Some(5);
    assert_eq!(labels(&doc), ["1.\t", "", "5.\t", "5.1.\t"]);
    // A level-2 paragraph restarted on its own.
    let mut two = listed(&[1, 2, 2]);
    two.stories[0].story.paragraphs[2].numbering_continue = Some(false);
    assert_eq!(labels(&two), ["1.\t", "1.1.\t", "1.1.\t"]);
}
