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
            | "paragraphAutoLeading"
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
            | "characterEastAsianFont"
            | "characterComplexFont"
            | "characterComplexFontSize"
            | "characterComplexBold"
            | "characterComplexItalic"
            | "characterComplexScript"
            | "characterDirection"
            | "characterFontHint"
    )
}

fn overlay(
    mut base: BTreeMap<String, PropValue>,
    top: BTreeMap<String, PropValue>,
) -> BTreeMap<String, PropValue> {
    base.extend(top);
    base
}

/// One built paragraph against its IR paragraph; true when the IR names a
/// synthesized paragraph style.
fn compare_paragraph(
    doc: &LoweredDoc,
    p: &docx_lower::ir::LoweredParagraph,
    np: &paged_model::Paragraph,
    at: &str,
) -> bool {
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
    // Paragraph properties.
    let old_p = only(old_para.clone(), is_para_path);
    let new_p = only(
        overlay(named_para.clone(), read_paragraph_props(np)),
        is_para_path,
    );
    assert_eq!(old_p, new_p, "{at}: paragraph properties");
    // Text and runs.
    // A field's runs are one native run, in the first run's look.
    let mut old_runs: Vec<(String, &docx_lower::ir::LoweredRun)> = Vec::new();
    let mut open: Option<u32> = None;
    for r in p.runs.iter().filter(|r| !r.text.is_empty()) {
        match (&r.field, open) {
            (Some(f), Some(seq)) if f.seq == seq => {
                old_runs.last_mut().unwrap().0.push_str(&r.text);
            }
            _ => old_runs.push((r.text.clone(), r)),
        }
        open = r.field.as_ref().map(|f| f.seq);
    }
    assert_eq!(old_runs.len(), np.runs.len(), "{at}: run count");
    for (j, ((text, or), nr)) in old_runs.iter().zip(&np.runs).enumerate() {
        let at = format!("{at} run {j}");
        assert_eq!(*text, nr.text, "{at}: text");
        assert_eq!(
            or.field.as_ref().map(|f| f.code.trim().to_string()),
            nr.field.as_ref().map(|f| f.code.clone()),
            "{at}: field"
        );
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
    // Inline pictures: anchored frames at their offsets, crop as placement.
    assert_eq!(p.images.len(), np.anchored_frames.len(), "{at}: pictures");
    for (k, (img, f)) in p.images.iter().zip(&np.anchored_frames).enumerate() {
        let b = f.bounds.expect("a picture frame has bounds");
        assert_eq!(
            (b.right - b.left, b.bottom - b.top),
            (img.width_pt, img.height_pt),
            "{at}: picture {k} size"
        );
        assert_eq!(
            f.image_link.as_deref(),
            Some(img.uri.as_str()),
            "{at}: picture {k} image"
        );
        assert_eq!(
            f.image_item_transform,
            img.crop.and_then(|c| c.placement),
            "{at}: picture {k} crop"
        );
        let chars: u32 = np.runs.iter().map(|r| r.text.chars().count() as u32).sum();
        assert_eq!(
            np.anchored_frame_offsets[k],
            img.at.min(chars),
            "{at}: picture {k} offset"
        );
    }
    p.para_style_id.as_deref().is_some_and(is_synthesized)
}

/// One built table against its IR table: the grid, the spans, each cell's
/// geometry and its paragraphs.
fn compare_table(
    doc: &LoweredDoc,
    t: &docx_lower::ir::LoweredTable,
    host: &paged_model::Paragraph,
    at: &str,
) -> usize {
    let table = host.table.as_ref().expect("a table block holds its table");
    assert!(
        host.runs.is_empty(),
        "{at}: the table's paragraph holds only the table"
    );
    assert_eq!(table.column_count, t.cols, "{at}: columns");
    assert_eq!(table.rows.len() as u32, t.rows, "{at}: rows");
    assert_eq!(
        table.header_row_count,
        t.header_rows.min(t.rows),
        "{at}: header rows"
    );
    assert_eq!(
        table.cells.len() as u32,
        t.rows * t.cols,
        "{at}: the whole grid"
    );
    let mut direct = 0;
    for lc in &t.cells {
        let cell = &table.cells[(lc.col * t.rows + lc.row) as usize];
        let at = format!("{at} cell {}:{}", lc.col, lc.row);
        assert_eq!(
            cell.name.as_deref(),
            Some(format!("{}:{}", lc.col, lc.row).as_str())
        );
        assert_eq!(
            (cell.row_span, cell.column_span),
            (lc.row_span.max(1), lc.col_span.max(1)),
            "{at}: spans"
        );
        if let Some([top, left, bottom, right]) = lc.insets_pt {
            assert_eq!(
                [
                    cell.text_top_inset,
                    cell.text_left_inset,
                    cell.text_bottom_inset,
                    cell.text_right_inset
                ],
                [top, left, bottom, right],
                "{at}: insets"
            );
        }
        assert_eq!(
            cell.vertical_justification, lc.v_align,
            "{at}: vertical alignment"
        );
        if cell.paragraphs.is_empty() {
            assert!(
                lc.paragraphs
                    .iter()
                    .all(|p| p.runs.iter().all(|r| r.text.is_empty())),
                "{at}: a cell with text has its paragraphs"
            );
            continue;
        }
        assert_eq!(
            cell.paragraphs.len(),
            lc.paragraphs.len(),
            "{at}: paragraphs"
        );
        for (k, (p, np)) in lc.paragraphs.iter().zip(&cell.paragraphs).enumerate() {
            if compare_paragraph(doc, p, np, &format!("{at} paragraph {k}")) {
                direct += 1;
            }
        }
    }
    direct
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
        let at = format!("{label} block {i}");
        match (old, new) {
            (LoweredBlock::Paragraph(p), NativeBlock::Paragraph(np)) => {
                built += 1;
                if compare_paragraph(doc, p, np, &at) {
                    direct += 1;
                }
            }
            (LoweredBlock::Table(t), NativeBlock::Table(host)) => {
                built += 1;
                direct += compare_table(doc, t, host, &at);
            }
            _ => {}
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
        ("table", docx_conformance::table_docx()),
        ("cell fields", docx_conformance::cell_fields_docx()),
        ("image", docx_conformance::image_docx()),
        ("picture crop", docx_conformance::picture_crop_docx()),
        ("table look", docx_conformance::objects_table_look_docx()),
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
    let deferred = |bytes: &[u8], why: &str| {
        native_body(&lowered(bytes))
            .blocks
            .iter()
            .any(|b| matches!(b, NativeBlock::Deferred { reason } if reason == why))
    };
    assert!(deferred(
        &docx_conformance::objects_floats_docx(),
        "floating picture or picture look"
    ));
    assert!(deferred(
        &docx_conformance::objects_nested_tables_docx(),
        "nested table"
    ));
    let body = native_body(&lowered(&docx_conformance::hyperlink_docx()));
    assert!(body
        .blocks
        .iter()
        .any(|b| matches!(b, NativeBlock::Deferred { reason } if reason == "hyperlink")));
}

// Slice 2 — the skeleton with the body built in its stories.

#[test]
fn a_prefilled_skeleton_holds_the_body_as_model_paragraphs() {
    use std::io::Read;
    let bytes = docx_conformance::mixed_sizes_docx();
    let model = docx_import::import_docx(&bytes).expect("import");
    let ir = docx_lower::lower(&model);
    let why: Vec<_> = native_body(&ir)
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Deferred { reason } => Some(reason.clone()),
            NativeBlock::Paragraph(_) | NativeBlock::Table(_) => None,
        })
        .collect();
    assert!(why.is_empty(), "deferred: {why:?}");
    let sk = docx_skeleton::skeleton_prefilled(&model, &ir, "m.docx", Default::default())
        .expect("builds")
        .expect("the whole body is native");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&sk.paged)).expect("zip");
    let mut pgm = Vec::new();
    zip.by_name(paged_store::DOCUMENT_PGM_PATH)
        .expect("model part")
        .read_to_end(&mut pgm)
        .unwrap();
    let doc: paged_scene::Document = paged_store::from_bytes(&pgm).expect("decodes");
    let story = doc
        .stories
        .iter()
        .find(|s| s.self_id == docx_skeleton::section_story_id(0))
        .expect("story 0");
    let texts: Vec<String> = story
        .story
        .paragraphs
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect();
    let want: Vec<String> = ir
        .story
        .paragraphs()
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect();
    assert_eq!(texts, want);
    assert!(story
        .story
        .paragraphs
        .iter()
        .flat_map(|p| &p.runs)
        .any(|r| r.point_size.is_some()));
}

#[test]
fn a_body_with_a_nested_table_is_not_prefilled() {
    let model =
        docx_import::import_docx(&docx_conformance::objects_nested_tables_docx()).expect("import");
    let ir = docx_lower::lower(&model);
    assert!(
        docx_skeleton::skeleton_prefilled(&model, &ir, "t.docx", Default::default())
            .expect("builds")
            .is_none()
    );
}

#[test]
fn a_plain_table_is_prefilled_in_a_paragraph_of_its_own() {
    let model = docx_import::import_docx(&docx_conformance::table_docx()).expect("import");
    let ir = docx_lower::lower(&model);
    let why: Vec<_> = native_body(&ir)
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Deferred { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect();
    let stories = docx_skeleton::body::native_stories(&ir)
        .unwrap_or_else(|| panic!("the whole body is native; deferred: {why:?}"));
    let tables = stories[0].iter().filter(|p| p.table.is_some()).count();
    assert_eq!(tables, 1);
    // The paragraphs before and after stand beside it.
    assert_eq!(stories[0].len(), 3);
}

#[test]
fn the_bundles_direct_format_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/direct-format.docx");
    let ir = lowered(bytes);
    let reasons: Vec<String> = native_body(&ir)
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            NativeBlock::Deferred { reason } => Some(format!("block {i}: {reason}")),
            NativeBlock::Paragraph(_) | NativeBlock::Table(_) => None,
        })
        .collect();
    assert!(reasons.is_empty(), "deferred: {reasons:?}");
    assert!(docx_skeleton::body::native_stories(&ir).is_some());
}

#[test]
fn the_bundles_table_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/table-body.docx");
    let ir = lowered(bytes);
    let reasons: Vec<String> = native_body(&ir)
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            NativeBlock::Deferred { reason } => Some(format!("block {i}: {reason}")),
            _ => None,
        })
        .collect();
    assert!(reasons.is_empty(), "deferred: {reasons:?}");
    assert!(docx_skeleton::body::native_stories(&ir).is_some());
    compare("table-body", &ir);
}

#[test]
fn the_bundles_picture_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/picture-body.docx");
    let ir = lowered(bytes);
    let reasons: Vec<String> = native_body(&ir)
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            NativeBlock::Deferred { reason } => Some(format!("block {i}: {reason}")),
            _ => None,
        })
        .collect();
    assert!(reasons.is_empty(), "deferred: {reasons:?}");
    let (built, _) = compare("picture-body", &ir);
    assert!(built >= 3);
    assert!(docx_skeleton::body::native_stories(&ir).is_some());
}

#[test]
fn the_bundles_field_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/field-body.docx");
    let ir = lowered(bytes);
    let reasons: Vec<String> = native_body(&ir)
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            NativeBlock::Deferred { reason } => Some(format!("block {i}: {reason}")),
            _ => None,
        })
        .collect();
    assert!(reasons.is_empty(), "deferred: {reasons:?}");
    compare("field-body", &ir);
    let fields = native_body(&ir)
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Paragraph(p) => Some(p.runs.iter().filter(|r| r.field.is_some()).count()),
            _ => None,
        })
        .sum::<usize>();
    assert_eq!(fields, 2);
}
