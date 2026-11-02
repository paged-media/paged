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

// Doc ADR 625, slice 1 — the same fixtures lowered two ways: the old IR,
// whose direct formatting is a synthesized `docx-auto-*` style, and the
// native body (`docx_skeleton::body`), whose direct formatting is the
// paragraph's and the run's own properties. For every block the native
// body builds, what the paragraph and each run resolve to must be equal,
// the text must be equal, and no synthesized style may be named.

use std::collections::BTreeMap;

use docx_lower::ir::{LoweredBlock, LoweredDoc, PropValue};
use docx_skeleton::body::{
    is_synthesized, native_body, read_paragraph_props, read_run_props, resolve_style, NativeBlock,
};

fn lowered(docx: &[u8]) -> LoweredDoc {
    docx_lower::lower(&docx_import::import_docx(docx).expect("import"))
}

fn only(
    m: BTreeMap<String, PropValue>,
    keep: impl Fn(&str) -> bool,
) -> BTreeMap<String, PropValue> {
    m.into_iter().filter(|(k, _)| keep(k)).collect()
}

/// The paths the native body builds, found by what it reads back.
fn is_para_path(k: &str) -> bool {
    matches!(
        k,
        "paragraphJustification"
            | "paragraphLeftIndent"
            | "paragraphRightIndent"
            | "paragraphFirstLineIndent"
            | "paragraphSpaceBefore"
            | "paragraphSpaceAfter"
            | "paragraphKeepWithNext"
            | "paragraphKeepFirstLines"
            | "paragraphKeepLastLines"
            | "paragraphKeepLinesTogether"
            | "paragraphKeepAllLinesTogether"
    )
}

fn is_char_path(k: &str) -> bool {
    matches!(
        k,
        "characterFontFamily"
            | "characterFontStyle"
            | "characterCase"
            | "characterPosition"
            | "characterFontSize"
            | "characterLeading"
            | "characterTracking"
            | "characterBaselineShift"
            | "characterUnderline"
            | "characterStrikethru"
            | "characterFillColor"
    )
}

fn overlay(
    mut base: BTreeMap<String, PropValue>,
    top: BTreeMap<String, PropValue>,
) -> BTreeMap<String, PropValue> {
    base.extend(top);
    base
}

/// Compare every built block of `doc`; returns (built, with direct formatting).
fn compare(label: &str, doc: &LoweredDoc) -> (usize, usize) {
    let body = native_body(doc);
    assert_eq!(
        body.blocks.len(),
        doc.story.blocks.len(),
        "{label}: one per block"
    );
    let (mut built, mut direct) = (0, 0);
    for (i, (old, new)) in doc.story.blocks.iter().zip(&body.blocks).enumerate() {
        let (LoweredBlock::Paragraph(p), NativeBlock::Paragraph(np)) = (old, new) else {
            continue;
        };
        built += 1;
        let at = format!("{label} block {i}");
        assert!(
            !np.paragraph_style.as_deref().is_some_and(is_synthesized),
            "{at}: names a synthesized paragraph style"
        );
        let old_para = p
            .para_style_id
            .as_deref()
            .map(|id| resolve_style(doc, id))
            .unwrap_or_default();
        let named_para = np
            .paragraph_style
            .as_deref()
            .map(|id| resolve_style(doc, id))
            .unwrap_or_default();
        if p.para_style_id.as_deref().is_some_and(is_synthesized) {
            direct += 1;
        }
        // Paragraph properties.
        let old_p = only(old_para.clone(), is_para_path);
        let new_p = only(
            overlay(named_para.clone(), read_paragraph_props(np)),
            is_para_path,
        );
        assert_eq!(old_p, new_p, "{at}: paragraph properties");
        // Text and runs.
        let old_runs: Vec<_> = p.runs.iter().filter(|r| !r.text.is_empty()).collect();
        assert_eq!(old_runs.len(), np.runs.len(), "{at}: run count");
        for (j, (or, nr)) in old_runs.iter().zip(&np.runs).enumerate() {
            let at = format!("{at} run {j}");
            assert_eq!(or.text, nr.text, "{at}: text");
            assert!(
                !nr.character_style.as_deref().is_some_and(is_synthesized),
                "{at}: names a synthesized character style"
            );
            let old_run = overlay(
                only(old_para.clone(), is_char_path),
                only(
                    or.char_style_id
                        .as_deref()
                        .map(|id| resolve_style(doc, id))
                        .unwrap_or_default(),
                    is_char_path,
                ),
            );
            let new_run = overlay(
                only(named_para.clone(), is_char_path),
                overlay(
                    only(
                        nr.character_style
                            .as_deref()
                            .map(|id| resolve_style(doc, id))
                            .unwrap_or_default(),
                        is_char_path,
                    ),
                    read_run_props(nr),
                ),
            );
            assert_eq!(old_run, new_run, "{at}: character properties");
        }
    }
    (built, direct)
}

#[test]
fn direct_formatting_resolves_the_same_without_synthesized_styles() {
    let fixtures: Vec<(&str, Vec<u8>)> = vec![
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
        ("breaks", docx_conformance::breaks_docx()),
        ("pagination", docx_conformance::pagination_docx()),
    ];
    let (mut built, mut direct) = (0, 0);
    for (label, bytes) in &fixtures {
        let (b, d) = compare(label, &lowered(bytes));
        built += b;
        direct += d;
    }
    assert!(built > 0, "slice 1 builds some paragraphs");
    assert!(
        direct > 0,
        "the fixtures carry direct formatting that slice 1 builds"
    );
}

#[test]
fn what_slice_1_does_not_build_is_deferred_not_dropped() {
    let body = native_body(&lowered(&docx_conformance::table_docx()));
    assert!(body
        .blocks
        .iter()
        .any(|b| matches!(b, NativeBlock::Deferred { reason } if reason == "table")));
    let body = native_body(&lowered(&docx_conformance::hyperlink_docx()));
    assert!(body
        .blocks
        .iter()
        .any(|b| matches!(b, NativeBlock::Deferred { reason } if reason == "hyperlink")));
}
