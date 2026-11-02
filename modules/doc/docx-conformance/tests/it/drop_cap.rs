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

//! Doc ADR 624 — drop caps (`docx_conformance::reach` fixture). A drop cap is the engine's paragraph drop cap; its Word
//! storage (a framed paragraph ahead of the paragraph) is folded into one
//! block, whose edits are refused.

#![allow(non_snake_case)]

use docx_conformance::drop_cap_docx;
use docx_core::{Block, DocxDocument};
use docx_export::{build_bindings, DocxBindings, EditSet, RunEdit};
use docx_lower::ir::LoweredBlock;
use paged_ooxml::OpcPackage;

const MAIN: &str = "word/document.xml";

fn paragraphs(doc: &DocxDocument) -> Vec<&docx_core::Paragraph> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .collect()
}

#[test]
fn the_framed_cap_folds_into_the_paragraph_after_it__feat__plugin_doc_drop_caps() {
    let doc = docx_import::import_docx(&drop_cap_docx()).expect("import");
    let ps = paragraphs(&doc);
    // P0, then three folded drop caps with a plain paragraph between each, P6.
    assert_eq!(ps.len(), 7, "three cap paragraphs folded away");
    let caps: Vec<_> = ps.iter().filter_map(|p| p.drop_cap).collect();
    assert_eq!(caps.len(), 3);
    assert_eq!(
        (caps[0].lines, caps[0].chars, caps[0].in_margin),
        (3, 1, false)
    );
    assert_eq!(
        (caps[1].lines, caps[1].chars, caps[1].in_margin),
        (2, 2, false)
    );
    assert_eq!(
        (caps[2].lines, caps[2].chars, caps[2].in_margin),
        (3, 1, true)
    );
    let first = ps.iter().find(|p| p.drop_cap.is_some()).unwrap();
    let text: String = first.runs.iter().map(|r| r.text.as_str()).collect();
    assert!(text.starts_with("The quick brown fox"), "{text}");
    assert!(first.held.drop_cap);
    // The cap's run keeps no enlarged size or lowered baseline of Word's
    // frame; the engine sizes the cap.
    assert_eq!(first.runs[0].props.size_half_pts, None);
    assert_eq!(first.runs[0].props.baseline_half_pts, None);
}

#[test]
fn a_drop_cap_lowers_to_the_engines_paragraph_drop_cap__feat__plugin_doc_drop_caps() {
    let doc = docx_import::import_docx(&drop_cap_docx()).expect("import");
    let lowered = docx_lower::lower(&doc);
    // The drop cap is a paragraph's own property (the engine refuses the
    // paths on a style): the cap's lines and characters ride the paragraph.
    let seen: Vec<(u32, u32)> = lowered
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => p.drop_cap.map(|d| (d.lines, d.characters)),
            _ => None,
        })
        .collect();
    assert_eq!(seen, vec![(3, 1), (2, 2), (3, 1)]);
    assert!(
        lowered
            .diagnostics
            .iter()
            .any(|d| d.message.contains("3 drop cap(s)") && d.message.contains("margin")),
        "{:?}",
        lowered.diagnostics
    );
}

#[test]
fn an_edit_of_a_drop_cap_is_refused_and_leaves_the_package_alone__feat__plugin_doc_drop_caps() {
    let bytes = drop_cap_docx();
    let doc = docx_import::import_docx(&bytes).expect("import");
    let bindings: DocxBindings = build_bindings(&doc);
    // Block 1 is the first drop cap; its first run is the cap's.
    let mut pkg = OpcPackage::read(&bytes).unwrap();
    let before = pkg.part(MAIN).unwrap().to_vec();
    let edits = EditSet {
        runs: vec![RunEdit::text(1, 0, "X")],
        ..Default::default()
    };
    let skips = docx_export::apply_edits(&mut pkg, MAIN, &bindings, &edits).unwrap();
    assert_eq!(skips.len(), 1, "{skips:?}");
    assert!(skips[0].contains("drop cap"), "{skips:?}");
    assert_eq!(pkg.part(MAIN).unwrap(), &before[..]);
}

#[test]
fn a_zero_edit_save_keeps_the_drop_cap_xml__feat__plugin_doc_drop_caps() {
    let bytes = drop_cap_docx();
    let doc = docx_import::import_docx(&bytes).expect("import");
    let bindings = build_bindings(&doc);
    let mut pkg = OpcPackage::read(&bytes).unwrap();
    let skips = docx_export::apply_edits(&mut pkg, MAIN, &bindings, &EditSet::default()).unwrap();
    assert!(skips.is_empty());
    let xml = String::from_utf8(pkg.part(MAIN).unwrap().to_vec()).unwrap();
    assert_eq!(xml.matches("w:dropCap=").count(), 3);
}
