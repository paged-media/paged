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

//! ADR 029, amended by engine ADR 1025 — a table row taller than its page.
//! Word splits such a row across pages. The lowering used to pour such a
//! table as plain paragraphs, a native row never splitting; a native Word
//! table now splits its rows as Word does, so the table is built natively.
//! Found on a real document (`docs/reference/acceptance-real-docx.md`, round
//! 14): a web page saved as Word keeps its article, 46,409 characters, in
//! one cell of a layout table.

// `__feat__<id>` names link these tests to the Cockpit feature row.
#![allow(non_snake_case)]

use docx_conformance::{tall_row_docx, TALL_ROW_PARAGRAPHS};
use docx_export::{overlay_story_content, ParagraphContentIn, RunContentIn, StoryContentIn};
use docx_lower::ir::{LoweredBlock, LoweredDoc};

fn lowered() -> LoweredDoc {
    let doc = docx_import::import_docx(&tall_row_docx()).expect("import");
    docx_lower::lower(&doc)
}

#[test]
fn a_row_taller_than_the_page_is_a_native_row_that_splits__feat__plugin_doc_word_pagination() {
    let lowered = lowered();
    // before, the tall table, after, the small table, end: blocks stay 1:1
    // with Word's body blocks.
    assert_eq!(lowered.story.blocks.len(), 5);
    let LoweredBlock::Table(tall) = &lowered.story.blocks[1] else {
        panic!("block 1 is the tall table");
    };
    assert!(tall.flow.is_empty(), "no table pours as text any more");
    assert_eq!((tall.rows, tall.cols), (1, 1));
    assert_eq!(tall.cells[0].paragraphs.len(), TALL_ROW_PARAGRAPHS);
    assert_eq!(tall.cells[0].paragraphs[0].runs[0].text, "Row text 001");
    // The host model lays it out by Word's rules (engine ADR 1025): the row
    // may split.
    let layout = tall.layout.as_ref().expect("Word's layout is carried");
    assert!(!layout.cant_split.iter().any(|c| *c));
    let LoweredBlock::Table(small) = &lowered.story.blocks[3] else {
        panic!("block 3 is the small table");
    };
    assert_eq!((small.rows, small.cols), (1, 1));
    assert!(
        !lowered
            .diagnostics
            .iter()
            .any(|d| d.message.contains("flow as text")),
        "nothing is flowed"
    );
}

#[test]
fn save_back_steps_over_a_tall_native_table__feat__plugin_doc_word_pagination() {
    let baseline = lowered();
    let para = |text: &str| ParagraphContentIn {
        paragraph_style: None,
        runs: vec![RunContentIn {
            text: text.to_string(),
            character_style: None,
            ..Default::default()
        }],
    };
    // What the editor reads back: before, after (edited), end. Neither
    // table is among the paragraphs.
    let mut paragraphs = vec![para("before")];
    paragraphs.push(para("after, edited"));
    paragraphs.push(para("end"));
    let edited = overlay_story_content(
        &baseline,
        &StoryContentIn {
            self_id: "s".into(),
            paragraphs,
        },
    );
    let text = |i: usize| match &edited.story.blocks[i] {
        LoweredBlock::Paragraph(p) => p.runs.iter().map(|r| r.text.as_str()).collect::<String>(),
        LoweredBlock::Table(_) => panic!("block {i} is a table"),
    };
    assert_eq!(text(0), "before");
    assert_eq!(
        text(2),
        "after, edited",
        "the edit lands on its own paragraph"
    );
    assert_eq!(text(4), "end");
}
