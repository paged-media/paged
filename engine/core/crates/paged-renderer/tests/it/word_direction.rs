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

//! Engine ADR 1051 — a paragraph's stated direction, drawn: a right-to-left
//! paragraph is set from the right edge of its column, its start indent on
//! the right, a Latin word inside it keeps its letters' order, and a
//! paragraph that states nothing draws as before.
#![allow(non_snake_case)]

use std::io::Write;
use std::path::PathBuf;

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

/// One frame 40..572 pt wide, one paragraph with `para_attrs` holding
/// `runs` (`(attrs, text)`, Inter 24 pt).
fn idml(para_attrs: &str, runs: &[(&str, &str)]) -> Vec<u8> {
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
  <idPkg:Spread src="Spreads/Spread_sp1.xml"/>
  <idPkg:Story src="Stories/Story_u10.xml"/>
</Document>"#,
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
    let body: String = runs
        .iter()
        .map(|(attrs, text)| {
            format!(
                r#"<CharacterStyleRange AppliedFont="Inter" PointSize="24"{attrs}><Content>{text}</Content></CharacterStyleRange>"#
            )
        })
        .collect();
    let story = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"><Story Self="u10"><ParagraphStyleRange{para_attrs}>{body}</ParagraphStyleRange></Story></idPkg:Story>"#
    );
    put(&mut zip, "Stories/Story_u10.xml", story.as_bytes());
    zip.finish().unwrap().into_inner()
}

/// Each drawn glyph's character and x (pt), left to right.
fn glyph_xs(para_attrs: &str, runs: &[(&str, &str)]) -> Vec<(char, f32)> {
    let doc = idml_import::import_idml_doc(&idml(para_attrs, runs)).unwrap();
    let mut resolver = BytesResolver::new();
    resolver.add_font("Inter", None, font());
    let opts = PipelineOptions {
        assets: Some(&resolver),
        collect_glyph_runs: true,
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&doc, &opts).unwrap();
    let table = built.pages[0].list.glyph_runs.as_ref().unwrap();
    let mut out: Vec<(char, f32)> = table
        .entries
        .iter()
        .filter(|e| !e.is_stroke)
        .filter_map(|e| Some((e.unicode?, e.transform.0[4])))
        .collect();
    out.sort_by(|a, b| a.1.total_cmp(&b.1));
    out
}

#[test]
fn a_right_to_left_paragraph_is_set_from_the_right_edge__feat__doc_bidi_paragraph() {
    let ltr = glyph_xs("", &[("", "abc.")]);
    let rtl = glyph_xs(
        r#" ParagraphDirection="RightToLeftDirection""#,
        &[("", "abc.")],
    );
    // Left to right: `a` at the frame's left edge, in text order.
    assert_eq!(ltr.iter().map(|(c, _)| *c).collect::<String>(), "abc.");
    assert!((ltr[0].1 - 40.0).abs() < 0.5, "{ltr:?}");
    // Right to left: the word keeps its letters' order, its full stop
    // goes to its left, and the line ends at the right edge.
    assert_eq!(rtl.iter().map(|(c, _)| *c).collect::<String>(), ".abc");
    let width = ltr[3].1 - ltr[0].1;
    assert!(
        rtl.last().unwrap().1 > 572.0 - width - 30.0 && rtl[0].1 > 400.0,
        "set from the right edge: {rtl:?}"
    );
}

#[test]
fn a_right_to_left_paragraphs_start_indent_is_on_the_right__feat__doc_bidi_paragraph() {
    let flush = glyph_xs(
        r#" ParagraphDirection="RightToLeftDirection""#,
        &[("", "abc")],
    );
    let indented = glyph_xs(
        r#" ParagraphDirection="RightToLeftDirection" LeftIndent="20""#,
        &[("", "abc")],
    );
    // The start (left) indent moves the line 20 pt in from the right.
    for (f, i) in flush.iter().zip(&indented) {
        assert!((f.1 - i.1 - 20.0).abs() < 0.5, "{flush:?} vs {indented:?}");
    }
    // A logical right-align sets it at the left edge.
    let end = glyph_xs(
        r#" ParagraphDirection="RightToLeftDirection" Justification="RightAlign""#,
        &[("", "abc")],
    );
    assert!((end[0].1 - 40.0).abs() < 0.5, "{end:?}");
}

#[test]
fn a_paragraph_that_states_nothing_draws_as_before__feat__doc_bidi_paragraph() {
    let plain = glyph_xs("", &[("", "ab 12 cd")]);
    let ltr = glyph_xs(
        r#" ParagraphDirection="LeftToRightDirection""#,
        &[("", "ab 12 cd")],
    );
    assert_eq!(plain, ltr);
    // A right-to-left run embeds its neutrals: its trailing space moves
    // before its digits, so the digits stand one space further right.
    let embedded = glyph_xs(
        "",
        &[
            ("", "ab "),
            (r#" CharacterDirection="RightToLeftDirection""#, "12 "),
            ("", "cd"),
        ],
    );
    let x_of = |v: &[(char, f32)], c: char| v.iter().find(|(g, _)| *g == c).unwrap().1;
    assert!(
        x_of(&embedded, '1') > x_of(&plain, '1') + 1.0,
        "{plain:?} / {embedded:?}"
    );
    assert!((x_of(&embedded, 'c') - x_of(&plain, 'c')).abs() < 0.01);
}

fn read(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../corpus/fonts")
        .join(name);
    std::fs::read(p).unwrap()
}

/// Each drawn glyph's character, glyph id, size and face, after `edit`
/// sets the first run's script properties.
fn slot_glyphs(
    text: &str,
    script: paged_model::ScriptProperties,
) -> Vec<(char, u32, f32, Option<u32>)> {
    let mut doc = idml_import::import_idml_doc(&idml("", &[("", text)])).unwrap();
    doc.stories[0].story.paragraphs[0].runs[0].script = script;
    let mut resolver = BytesResolver::new();
    resolver.add_font("Inter", None, font());
    resolver.add_font("Noto Sans JP", None, read("NotoSansJP-VF.ttf"));
    resolver.add_font("Noto Sans Arabic", None, read("NotoSansArabic-VF.ttf"));
    let opts = PipelineOptions {
        assets: Some(&resolver),
        collect_glyph_runs: true,
        ..PipelineOptions::default()
    };
    let built = pipeline::build_document(&doc, &opts).unwrap();
    let table = built.pages[0].list.glyph_runs.as_ref().unwrap();
    let mut entries: Vec<_> = table.entries.iter().filter(|e| !e.is_stroke).collect();
    entries.sort_by_key(|e| e.command_index);
    entries
        .iter()
        .filter_map(|e| Some((e.unicode?, e.glyph_id, e.font_size, e.face_id)))
        .collect()
}

#[test]
fn east_asian_characters_take_the_east_asian_face__feat__doc_script_font_slots() {
    let none = slot_glyphs("ab日本", paged_model::ScriptProperties::default());
    let slotted = slot_glyphs(
        "ab日本",
        paged_model::ScriptProperties {
            east_asian_font: Some("Noto Sans JP".into()),
            ..Default::default()
        },
    );
    let of = |v: &[(char, u32, f32, Option<u32>)], c: char| *v.iter().find(|g| g.0 == c).unwrap();
    // Unset: the run's own face has no glyph for 日.
    assert_eq!(of(&none, '日').1, 0, "{none:?}");
    // The slot draws it, in a face other than the Latin letters'.
    assert_ne!(of(&slotted, '日').1, 0, "{slotted:?}");
    assert_ne!(of(&slotted, '日').3, of(&slotted, 'a').3);
    // The Latin letters keep their face.
    assert_eq!(of(&slotted, 'a').3, of(&none, 'a').3);
}

#[test]
fn complex_script_takes_its_face_and_size__feat__doc_script_font_slots() {
    let slotted = slot_glyphs(
        "ab مرحبا",
        paged_model::ScriptProperties {
            complex_font: Some("Noto Sans Arabic".into()),
            complex_point_size: Some(30.0),
            ..Default::default()
        },
    );
    let arabic: Vec<_> = slotted
        .iter()
        .filter(|g| ('\u{600}'..'\u{700}').contains(&g.0))
        .collect();
    assert!(!arabic.is_empty(), "{slotted:?}");
    assert!(
        arabic.iter().all(|g| g.1 != 0 && (g.2 - 30.0).abs() < 0.01),
        "{slotted:?}"
    );
    let a = slotted.iter().find(|g| g.0 == 'a').unwrap();
    assert!((a.2 - 24.0).abs() < 0.01);
    // A right-to-left run is complex script throughout: its Latin letters
    // take the complex-script size too.
    let rtl = slot_glyphs(
        "ab",
        paged_model::ScriptProperties {
            direction: Some(paged_model::CharacterDirection::RightToLeft),
            complex_point_size: Some(30.0),
            ..Default::default()
        },
    );
    assert!(rtl.iter().all(|g| (g.2 - 30.0).abs() < 0.01), "{rtl:?}");
}
