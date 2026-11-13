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

// Doc ADR 600, amendment 2026-11-12b — the pour's looks are the native
// body's: `docx_skeleton::direct::annotate` writes into the IR the look each
// paragraph, run, break part, table paragraph and tracked change's "before"
// takes (the Word style plus direct properties), and the TypeScript pour
// applies them as they are. Over the conformance fixtures, a paragraph built
// from its annotations equals the native body's, and the synthesized styles
// left to mint are only those a look still applies.

use docx_lower::ir::{
    LoweredBlock, LoweredDirect, LoweredDoc, LoweredFormatChange, LoweredParagraph,
    LoweredPropsChange, LoweredRun, LoweredSegment, LoweredStyle, LoweredTable, PropValue,
    StyleCollection, StyleProp,
};
use docx_skeleton::body::{
    is_synthesized, native_body, read_paragraph_props, read_run_props, set_paragraph_prop,
    set_run_prop, NativeBlock,
};
use docx_skeleton::direct::annotate;
use paged_model::{CharacterRun, Paragraph};

fn lowered(docx: &[u8]) -> LoweredDoc {
    docx_lower::lower(&docx_import::import_docx(docx).expect("import"))
}

/// A paragraph as the pour makes it from its annotations.
fn poured(p: &LoweredParagraph) -> Paragraph {
    let d = p.direct.as_ref().expect("every paragraph has a look");
    let mut para = Paragraph {
        paragraph_style: d.style.clone(),
        ..Paragraph::default()
    };
    for x in &d.props {
        assert!(
            set_paragraph_prop(&mut para, x),
            "{} is a paragraph field",
            x.path
        );
    }
    for r in p.runs.iter().filter(|r| !r.text.is_empty()) {
        let d = r.direct.as_ref().expect("a run's look");
        let mut run = CharacterRun {
            character_style: d.style.clone(),
            text: r.text.clone(),
            ..CharacterRun::default()
        };
        for x in &d.props {
            assert!(set_run_prop(&mut run, x), "{} is a run field", x.path);
        }
        para.runs.push(run);
    }
    para
}

/// A paragraph whose runs the native body takes one for one (no field it
/// joins, no note marker it splits off).
fn plain(p: &LoweredParagraph) -> bool {
    p.segments.is_empty()
        && p.runs
            .iter()
            .all(|r| r.field.is_none() && r.note.is_none() && r.hyperlink_url.is_none())
}

fn same(label: &str, i: usize, p: &LoweredParagraph, native: &Paragraph) -> bool {
    let ours = poured(p);
    assert_eq!(
        ours.paragraph_style, native.paragraph_style,
        "{label} block {i}: paragraph style"
    );
    assert_eq!(
        read_paragraph_props(&ours),
        read_paragraph_props(native),
        "{label} block {i}: paragraph properties"
    );
    let theirs: Vec<&CharacterRun> = native.runs.iter().filter(|r| !r.text.is_empty()).collect();
    assert_eq!(ours.runs.len(), theirs.len(), "{label} block {i}: runs");
    for (k, (a, b)) in ours.runs.iter().zip(theirs).enumerate() {
        assert_eq!(a.text, b.text, "{label} block {i} run {k}: text");
        assert_eq!(
            a.character_style, b.character_style,
            "{label} block {i} run {k}: character style"
        );
        assert_eq!(
            read_run_props(a),
            read_run_props(b),
            "{label} block {i} run {k}: properties"
        );
    }
    true
}

#[test]
#[allow(non_snake_case)]
fn the_pours_looks_are_the_native_bodys__feat__plugin_doc_read_path() {
    let fixtures = [
        ("mixed sizes", docx_conformance::mixed_sizes_docx()),
        (
            "paragraph spacing",
            docx_conformance::paragraph_spacing_docx(None),
        ),
        ("line spacing", docx_conformance::line_spacing_docx()),
        ("run specials", docx_conformance::run_specials_docx()),
        ("symbols", docx_conformance::symbols_docx()),
        ("memo", docx_conformance::memo_docx()),
        ("tier 1", docx_conformance::tier1_docx()),
        ("pagination", docx_conformance::pagination_docx()),
        ("table", docx_conformance::table_docx()),
        ("text boxes", docx_conformance::objects_text_boxes_docx()),
        ("drop cap", docx_conformance::drop_cap_docx()),
        ("list", docx_conformance::list_docx()),
        ("table look", docx_conformance::objects_table_look_docx()),
        ("tracked", docx_conformance::tracked_changes_docx()),
        ("review", docx_conformance::review_docx()),
    ];
    let mut compared = 0;
    for (label, bytes) in fixtures {
        let doc = lowered(&bytes);
        let body = native_body(&doc);
        let mut ours = doc.clone();
        annotate(&mut ours);
        for (i, (block, built)) in ours.story.blocks.iter().zip(&body.blocks).enumerate() {
            match (block, built) {
                (LoweredBlock::Paragraph(p), NativeBlock::Paragraph(native)) if plain(p) => {
                    if same(label, i, p, native) {
                        compared += 1;
                    }
                }
                (LoweredBlock::Table(t), NativeBlock::Table(native)) => {
                    // The table's own paragraph.
                    let d = t.direct.as_ref().expect("a table's look");
                    assert_eq!(d.style, native.paragraph_style, "{label} block {i}");
                    let table_id = native
                        .table
                        .as_ref()
                        .expect("a table")
                        .self_id
                        .clone()
                        .unwrap_or_default();
                    let host = std::slice::from_ref(native.as_ref());
                    for c in &t.cells {
                        let ncs = paged_model::cell_paragraphs_in(host, &table_id, c.col, c.row)
                            .expect("the cell");
                        for (p, np) in c.paragraphs.iter().zip(ncs) {
                            if plain(p) && same(label, i, p, np) {
                                compared += 1;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        // Every synthesized style left to mint is one a look still applies
        // (or one that stands under it).
        for id in ours.minted_styles.as_deref().unwrap_or_default() {
            assert!(is_synthesized(id), "{label}: {id} is minted");
        }
    }
    assert!(compared > 60, "compared {compared} paragraphs");
}

fn prop(path: &str, value: PropValue) -> StyleProp {
    StyleProp {
        path: path.into(),
        value,
    }
}

fn style(id: &str, para: bool, based_on: Option<&str>, props: Vec<StyleProp>) -> LoweredStyle {
    LoweredStyle {
        id: id.into(),
        name: id.into(),
        collection: if para {
            StyleCollection::Paragraph
        } else {
            StyleCollection::Character
        },
        based_on: based_on.map(str::to_owned),
        props,
    }
}

fn run(text: &str, s: Option<&str>) -> LoweredRun {
    LoweredRun {
        text: text.into(),
        char_style_id: s.map(str::to_owned),
        ..Default::default()
    }
}

#[test]
#[allow(non_snake_case)]
fn blank_lines_breaks_tables_and_tracked_looks__feat__plugin_doc_read_path() {
    let center = prop(
        "paragraphJustification",
        PropValue::Text("CenterAlign".into()),
    );
    let after = prop("paragraphSpaceAfter", PropValue::Length(0.0));
    let size9 = prop("characterFontSize", PropValue::Length(9.0));
    let size14 = prop("characterFontSize", PropValue::Length(14.0));
    let normal = "ParagraphStyle/docx-Normal";
    let mut doc = LoweredDoc {
        styles: vec![
            style(normal, true, None, vec![]),
            style(
                "ParagraphStyle/docx-auto-p1",
                true,
                Some(normal),
                vec![center.clone()],
            ),
            style(
                "ParagraphStyle/docx-auto-p2",
                true,
                Some(normal),
                vec![size9.clone()],
            ),
            style(
                "ParagraphStyle/docx-auto-p3",
                true,
                Some(normal),
                vec![after.clone()],
            ),
            style(
                "ParagraphStyle/docx-auto-p4",
                true,
                Some(normal),
                vec![size14.clone()],
            ),
            style(
                "CharacterStyle/docx-auto-c1",
                false,
                None,
                vec![size14.clone()],
            ),
            style(
                "CharacterStyle/docx-auto-c2",
                false,
                None,
                vec![size9.clone()],
            ),
        ],
        ..Default::default()
    };
    // 0: direct paragraph and run formatting; a format change.
    let mut tracked = run("Tracked", Some("CharacterStyle/docx-auto-c1"));
    tracked.format_change = Some(LoweredFormatChange {
        before_char_style_id: Some("CharacterStyle/docx-auto-c2".into()),
        ..Default::default()
    });
    let p0 = LoweredParagraph {
        para_style_id: Some("ParagraphStyle/docx-auto-p1".into()),
        runs: vec![tracked],
        props_change: Some(LoweredPropsChange {
            before_para_style_id: Some("ParagraphStyle/docx-auto-p3".into()),
            ..Default::default()
        }),
        ..Default::default()
    };
    // 1: a blank line with paragraph properties only: not kept.
    let p1 = LoweredParagraph {
        para_style_id: Some("ParagraphStyle/docx-auto-p3".into()),
        ..Default::default()
    };
    // 2: a blank line with character properties: kept.
    let p2 = LoweredParagraph {
        para_style_id: Some("ParagraphStyle/docx-auto-p2".into()),
        ..Default::default()
    };
    // 3: a break whose part has other character properties: kept, parts too.
    let p3 = LoweredParagraph {
        para_style_id: Some("ParagraphStyle/docx-auto-p2".into()),
        runs: vec![run("Before after", None)],
        segments: vec![LoweredSegment {
            at: 7,
            para_style_id: Some("ParagraphStyle/docx-auto-p4".into()),
            direct: None,
        }],
        ..Default::default()
    };
    let table = LoweredTable {
        para_style_id: Some("ParagraphStyle/docx-auto-p1".into()),
        ..Default::default()
    };
    doc.story.blocks = vec![
        LoweredBlock::Paragraph(p0),
        LoweredBlock::Paragraph(p1),
        LoweredBlock::Paragraph(p2),
        LoweredBlock::Paragraph(p3),
        LoweredBlock::Table(table),
    ];
    annotate(&mut doc);
    let para = |i: usize| match &doc.story.blocks[i] {
        LoweredBlock::Paragraph(p) => p.clone(),
        _ => unreachable!(),
    };
    let look = |s: Option<&str>, props: Vec<StyleProp>| {
        Some(LoweredDirect {
            style: s.map(str::to_owned),
            props,
        })
    };
    let p0 = para(0);
    assert_eq!(p0.direct, look(Some(normal), vec![center.clone()]));
    assert_eq!(p0.runs[0].direct, look(None, vec![size14.clone()]));
    assert_eq!(p0.runs[0].before_direct, look(None, vec![size9.clone()]));
    assert_eq!(p0.before_direct, look(Some(normal), vec![after.clone()]));
    assert_eq!(para(1).direct, look(Some(normal), vec![after.clone()]));
    assert_eq!(
        para(2).direct,
        look(Some("ParagraphStyle/docx-auto-p2"), vec![])
    );
    let p3 = para(3);
    assert_eq!(p3.direct, look(Some("ParagraphStyle/docx-auto-p2"), vec![]));
    assert_eq!(p3.runs[0].direct, look(None, vec![]));
    assert_eq!(
        p3.segments[0].direct,
        look(Some("ParagraphStyle/docx-auto-p4"), vec![])
    );
    let LoweredBlock::Table(t) = &doc.story.blocks[4] else {
        unreachable!()
    };
    assert_eq!(t.direct, look(Some(normal), vec![center]));
    assert_eq!(
        doc.minted_styles,
        Some(vec![
            "ParagraphStyle/docx-auto-p2".to_string(),
            "ParagraphStyle/docx-auto-p4".to_string(),
        ])
    );
}
