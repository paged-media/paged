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

//! What a template's doc fields address (editor plan G3a): a paragraph by
//! a bookmark that starts in it, a list by its `w:numId`, and the save-back
//! a list field's write takes — items emptied, removed, or added as copies
//! of an item's paragraph and run properties, so they stay items of the
//! same list.

#![allow(non_snake_case)] // `…__feat__<id>` test names link the cockpit feature

use docx_conformance::template_docx;
use docx_js::core::{CloneParagraphEdit, ObjectEdits, RunTextEdit};
use docx_js::DocSession;
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredListRef, LoweredParagraph};

fn paragraphs(ir: &LoweredDoc) -> Vec<&LoweredParagraph> {
    ir.story
        .blocks
        .iter()
        .map(|b| match b {
            LoweredBlock::Paragraph(p) => p,
            LoweredBlock::Table(_) => panic!("the template has no table"),
        })
        .collect()
}

fn text(p: &LoweredParagraph) -> String {
    p.runs.iter().map(|r| r.text.as_str()).collect()
}

#[test]
fn bookmarks_and_list_identity_reach_the_lowering__feat__plugin_doc_object_model() {
    let ir = DocSession::load(&template_docx()).unwrap().lowered();
    let ps = paragraphs(&ir);
    assert_eq!(ps.len(), 7);
    // `intro` starts inside block 2; `closing` between blocks 5 and 6.
    let marks: Vec<Vec<String>> = ps.iter().map(|p| p.bookmarks.clone()).collect();
    assert_eq!(marks[2], ["intro"]);
    assert_eq!(marks[6], ["closing"]);
    assert!(marks[..2].iter().all(Vec::is_empty));
    let list = Some(LoweredListRef {
        num_id: 1,
        level: 0,
    });
    let lists: Vec<_> = ps.iter().map(|p| p.list).collect();
    assert_eq!(lists, [None, None, None, list, list, list, None]);
    // The JSON the bundle reads.
    let json = serde_json::to_value(&ir).unwrap();
    assert_eq!(json["story"]["blocks"][2]["bookmarks"][0], "intro");
    assert_eq!(json["story"]["blocks"][4]["list"]["numId"], 1);
    assert!(json["story"]["blocks"][0].get("list").is_none());
}

#[test]
fn a_list_write_removes_and_adds_items_of_the_same_list__feat__plugin_doc_object_model() {
    let session = DocSession::load(&template_docx()).unwrap();
    // Fewer items: the first takes a new text, the other two go.
    let fewer = ObjectEdits {
        runs: vec![RunTextEdit {
            block: 3,
            run: 0,
            text: "Figs".into(),
            ..Default::default()
        }],
        delete_paragraphs: vec![4, 5],
        ..Default::default()
    };
    let (saved, skips) = session.save_object_edits(&fewer).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let ir = DocSession::load(&saved).unwrap().lowered();
    let ps = paragraphs(&ir);
    assert_eq!(
        ps.iter().map(|p| text(p)).collect::<Vec<_>>(),
        [
            "Quarterly letter",
            "Dear «Name»,",
            "Thank you for your order.",
            "Figs",
            "Kind regards"
        ]
    );
    assert_eq!(ps[3].list.map(|l| l.num_id), Some(1));

    // More items: two copies of the bold second item after the last.
    let more = ObjectEdits {
        clone_paragraphs: vec![
            CloneParagraphEdit {
                source: 4,
                after: 5,
                text: "Cherries & more".into(),
            },
            CloneParagraphEdit {
                source: 4,
                after: 5,
                text: "Dates".into(),
            },
        ],
        ..Default::default()
    };
    let (saved, skips) = session.save_object_edits(&more).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let again = DocSession::load(&saved).unwrap();
    let ir = again.lowered();
    let ps = paragraphs(&ir);
    let items: Vec<String> = ps
        .iter()
        .filter(|p| p.list.is_some_and(|l| l.num_id == 1))
        .map(|p| text(p))
        .collect();
    assert_eq!(
        items,
        ["Apples", "Pears", "Plums", "Cherries & more", "Dates"]
    );
    // The copies carry the source item's run look (bold) and its list.
    let look = |p: &LoweredParagraph| p.runs[0].char_style_id.clone();
    assert!(look(ps[4]).is_some());
    assert_eq!(look(ps[6]), look(ps[4]));
    assert_eq!(look(ps[7]), look(ps[4]));
    assert_eq!(text(ps[8]), "Kind regards");
    assert_eq!(ps[8].bookmarks, ["closing"]);
}

#[test]
fn a_paragraph_that_ends_a_section_is_not_copied__feat__plugin_doc_object_model() {
    let document = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>Ends one</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
  </w:body>
</w:document>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;
    let types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;
    let bytes = docx_conformance::zip_parts(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
    ]);
    let session = DocSession::load(&bytes).unwrap();
    let copy = |source| ObjectEdits {
        clone_paragraphs: vec![CloneParagraphEdit {
            source,
            after: 1,
            text: "copy".into(),
        }],
        ..Default::default()
    };
    let (_, skips) = session.save_object_edits(&copy(0)).unwrap();
    assert_eq!(skips.len(), 1);
    assert!(skips[0].contains("ends a section"), "{skips:?}");
    let (saved, skips) = session.save_object_edits(&copy(1)).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let again = DocSession::load(&saved).unwrap();
    assert_eq!(again.model().sections.len(), 2);
    let ir = again.lowered();
    assert_eq!(
        paragraphs(&ir).iter().map(|p| text(p)).collect::<Vec<_>>(),
        ["Ends one", "Second", "copy"]
    );
}
