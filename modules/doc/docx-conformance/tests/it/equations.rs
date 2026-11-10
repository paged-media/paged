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

//! Engine ADR 1090 — equations in a Word body (`docx_conformance::math`
//! fixture): read by the shared OMML reader into the run list, lowered to
//! the paragraph's equations, and left in the part as written.

use docx_conformance::{equations_docx, EQUATION_LEAD};
use docx_core::Block;
use docx_export::{build_bindings, EditSet, RunEdit};
use docx_lower::ir::LoweredBlock;
use paged_math::Node;
use paged_ooxml::OpcPackage;

const MAIN: &str = "word/document.xml";

fn lowered_paragraphs() -> Vec<docx_lower::ir::LoweredParagraph> {
    let doc = docx_import::import_docx(&equations_docx()).expect("import");
    docx_lower::lower(&doc)
        .story
        .blocks
        .into_iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p),
            _ => None,
        })
        .collect()
}

#[test]
fn an_equation_is_a_run_of_its_paragraph_in_document_order() {
    let doc = docx_import::import_docx(&equations_docx()).expect("import");
    let paragraphs: Vec<_> = doc
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(paragraphs.len(), 4);
    // Text, the equation, text: the equation's run has no text of its own.
    let first: Vec<(&str, bool)> = paragraphs[0]
        .runs
        .iter()
        .map(|r| (r.text.as_str(), r.math.is_some()))
        .collect();
    assert_eq!(
        first,
        [
            (EQUATION_LEAD, false),
            ("", true),
            (" in square units.", false)
        ]
    );
    let inline = paragraphs[0].runs[1].math.as_ref().unwrap();
    assert!(!inline.display);
    assert!(matches!(inline.body[..], [Node::Frac { .. }]));
    let display = paragraphs[1].runs[0].math.as_ref().expect("quadratic");
    assert!(display.display);
    assert!(paragraphs[3].runs.iter().all(|r| r.math.is_none()));
}

#[test]
fn equations_lower_to_the_paragraphs_equations_at_their_offsets() {
    let ps = lowered_paragraphs();
    assert_eq!(ps[0].equations.len(), 1);
    assert_eq!(ps[0].equations[0].at, EQUATION_LEAD.chars().count() as u32);
    assert!(!ps[0].equations[0].math.display);
    // The equation's run is not a run of the lowering (it has no text).
    assert_eq!(ps[0].runs.len(), 2);
    // A display paragraph: the equation at offset 0 of an empty paragraph.
    assert_eq!(ps[1].equations.len(), 1);
    assert_eq!(ps[1].equations[0].at, 0);
    assert!(ps[1].equations[0].math.display);
    // Two lines of one m:oMathPara are one display equation, an array.
    match &ps[2].equations[0].math.body[..] {
        [Node::EqArr { rows }] => assert_eq!(rows.len(), 2),
        other => panic!("an equation array: {other:?}"),
    }
    assert!(ps[3].equations.is_empty());
}

/// Word grows a line to the equation it holds (measured: a display
/// fraction's line is about twice the text's), so an equation's paragraph
/// takes auto leading as a picture's does; a fixed leading would let the
/// formula overlap the lines around it.
#[test]
fn an_equation_paragraph_takes_auto_leading() {
    let doc = docx_import::import_docx(&equations_docx()).expect("import");
    let lowered = docx_lower::lower(&doc);
    let leading = |style_id: Option<&str>| {
        let mut next = style_id.map(str::to_string);
        for _ in 0..32 {
            let style = lowered
                .styles
                .iter()
                .find(|s| Some(&s.id) == next.as_ref())?;
            if let Some(docx_lower::ir::PropValue::Length(pt)) = style
                .props
                .iter()
                .find(|p| p.path == "characterLeading")
                .map(|p| &p.value)
            {
                return Some(*pt);
            }
            next = style.based_on.clone();
        }
        None
    };
    let paragraphs = lowered.story.blocks.iter().filter_map(|b| match b {
        LoweredBlock::Paragraph(p) => Some(p),
        _ => None,
    });
    let mut with_equation = 0;
    for p in paragraphs.filter(|p| !p.equations.is_empty()) {
        with_equation += 1;
        assert_eq!(
            leading(p.para_style_id.as_deref()),
            Some(0.0),
            "auto leading"
        );
    }
    assert_eq!(
        with_equation, 3,
        "the inline, the display and the two-line paragraph"
    );
}

#[test]
fn editing_the_text_beside_an_equation_keeps_its_markup() {
    let bytes = equations_docx();
    let doc = docx_import::import_docx(&bytes).expect("import");
    let bindings = build_bindings(&doc);
    let mut pkg = OpcPackage::read(&bytes).unwrap();
    let before = String::from_utf8(pkg.part(MAIN).unwrap().to_vec()).unwrap();
    // A zero-edit save changes nothing.
    let skips = docx_export::apply_edits(&mut pkg, MAIN, &bindings, &EditSet::default()).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    assert_eq!(pkg.part(MAIN).unwrap(), before.as_bytes());
    // The run before the inline equation is rewritten; the equation and
    // every other paragraph keep their bytes.
    let edits = EditSet {
        runs: vec![RunEdit::text(0, 0, "Region ")],
        ..Default::default()
    };
    let skips = docx_export::apply_edits(&mut pkg, MAIN, &bindings, &edits).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let after = String::from_utf8(pkg.part(MAIN).unwrap().to_vec()).unwrap();
    assert!(after.contains("Region "), "the edit is in");
    let math = |xml: &str| -> Vec<String> {
        xml.split("<m:oMath")
            .skip(1)
            .map(|s| s.split("</m:oMath").next().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        math(&after),
        math(&before),
        "the equations' markup is unchanged"
    );
    let tail = |xml: &str| xml[xml.find("</w:p>").unwrap()..].to_string();
    assert_eq!(tail(&after), tail(&before), "the paragraphs after it too");
}

#[test]
fn a_cells_equations_lower_to_its_paragraphs_equations() {
    // Engine ADR 1090 amendment 2: a cell paragraph's equations are read
    // and lowered as a body paragraph's.
    let doc =
        docx_import::import_docx(&docx_conformance::equations_in_cells_docx()).expect("import");
    let ir = docx_lower::lower(&doc);
    let table = ir
        .story
        .blocks
        .iter()
        .find_map(|b| match b {
            LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .expect("the table");
    assert_eq!(table.cells.len(), 2);
    let first = &table.cells[0].paragraphs[0];
    assert_eq!(first.equations.len(), 1);
    assert_eq!(
        first.equations[0].at,
        docx_conformance::CELL_EQUATION_LEAD.chars().count() as u32
    );
    assert!(matches!(
        first.equations[0].math.body[..],
        [Node::Frac { .. }]
    ));
    let second = &table.cells[1].paragraphs[0];
    assert_eq!(second.equations.len(), 1);
    assert!(second.equations[0].math.display);
    assert!(second.runs.iter().all(|r| r.text.is_empty()));
}
