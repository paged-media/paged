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
            | "paragraphStartParagraph"
            | "paragraphListType"
            | "paragraphBulletCharacter"
            | "paragraphNumberingFormat"
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
    // A paragraph that cannot carry its character properties keeps the
    // style the lowering made for it, and says so (it is then the same
    // token the IR names).
    if np.paragraph_style.as_deref().is_some_and(is_synthesized) {
        assert_eq!(
            np.paragraph_style, p.para_style_id,
            "{at}: a kept style is the IR's own"
        );
    }
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
            or.hyperlink_url.is_some(),
            nr.hyperlink_source.is_some(),
            "{at}: hyperlink"
        );
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
    assert_eq!(
        p.drop_cap
            .map(|d| (d.characters, d.lines))
            .unwrap_or((0, 0)),
        (np.drop_cap_characters, np.drop_cap_lines),
        "{at}: drop cap"
    );
    // Inline pictures: anchored frames at their offsets, crop as placement.
    assert_eq!(
        p.images.len() + p.text_boxes.len(),
        np.anchored_frames.len(),
        "{at}: pictures and text boxes"
    );
    for (k, tb) in p.text_boxes.iter().enumerate() {
        let f = &np.anchored_frames[p.images.len() + k];
        assert_eq!(f.frame_kind, paged_model::AnchoredFrameKind::TextFrame);
        assert!(f.parent_story.is_some(), "{at}: a text box has its story");
        assert_eq!(
            f.layout.inset_spacing,
            Some(tb.insets_pt),
            "{at}: box insets"
        );
    }
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
            (LoweredBlock::Paragraph(p), NativeBlock::Split(parts)) => {
                built += 1;
                // The parts together say what the paragraph says, and a
                // break makes one new paragraph each.
                let said: String = parts
                    .iter()
                    .flat_map(|q| q.runs.iter().map(|r| r.text.as_str()))
                    .collect();
                let want: String = p.runs.iter().map(|r| r.text.as_str()).collect();
                assert_eq!(said, want, "{at}: the parts' text");
                let cuts: std::collections::BTreeSet<u32> = p
                    .segments
                    .iter()
                    .map(|s| s.at)
                    .filter(|a| *a > 0 || want.is_empty())
                    .map(|a| a.min(want.chars().count() as u32))
                    .collect();
                assert_eq!(parts.len(), 1 + cuts.len(), "{at}: one paragraph per break");
                // The break's own rule starts the part.
                assert!(
                    parts[1..].iter().all(|q| q.start_paragraph.is_some()),
                    "{at}: a part after a break carries its break rule"
                );
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
        ("text boxes", docx_conformance::objects_text_boxes_docx()),
        (
            "nested tables",
            docx_conformance::objects_nested_tables_docx(),
        ),
        ("floats", docx_conformance::objects_floats_docx()),
        ("drop cap", docx_conformance::drop_cap_docx()),
        ("hyperlink", docx_conformance::hyperlink_docx()),
        ("field hyperlink", docx_conformance::field_hyperlink_docx()),
        ("list", docx_conformance::list_docx()),
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
fn a_hyperlink_run_makes_a_link() {
    let body = native_body(&lowered(&docx_conformance::hyperlink_docx()));
    assert!(!body.links.is_empty(), "the hyperlink run makes a link");
    assert!(body.built() > 0);
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
            NativeBlock::Paragraph(_) | NativeBlock::Table(_) | NativeBlock::Split(_) => None,
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
fn a_nested_table_stands_in_its_cells_paragraph() {
    let model =
        docx_import::import_docx(&docx_conformance::objects_nested_tables_docx()).expect("import");
    let ir = docx_lower::lower(&model);
    let stories = docx_skeleton::body::native_stories(&ir).expect("the whole body is native");
    let nested: usize = stories.stories[0]
        .iter()
        .filter_map(|p| p.table.as_ref())
        .flat_map(|t| &t.cells)
        .flat_map(|c| &c.paragraphs)
        .filter(|p| p.table.is_some())
        .count();
    assert!(nested >= 1, "a cell holds a table");
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
        .unwrap_or_else(|| panic!("the whole body is native; deferred: {why:?}"))
        .stories;
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
            NativeBlock::Paragraph(_) | NativeBlock::Table(_) | NativeBlock::Split(_) => None,
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

#[test]
fn the_bundles_list_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/list-body.docx");
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
    compare("list-body", &ir);
    let items = native_body(&ir)
        .blocks
        .iter()
        .filter(|b| matches!(b, NativeBlock::Paragraph(p) if p.bullets_list_type.is_some()))
        .count();
    assert_eq!(items, 4);
}

#[test]
fn the_bundles_hyperlink_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/hyperlink-body.docx");
    let ir = lowered(bytes);
    let body = native_body(&ir);
    let reasons: Vec<String> = body
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            NativeBlock::Deferred { reason } => Some(format!("block {i}: {reason}")),
            _ => None,
        })
        .collect();
    assert!(reasons.is_empty(), "deferred: {reasons:?}");
    assert_eq!(body.links.len(), 2);
    compare("hyperlink-body", &ir);
}

#[test]
fn a_prefilled_skeleton_holds_the_styles_without_the_invented_ones() {
    use std::io::Read;
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/direct-format.docx");
    let model = docx_import::import_docx(bytes).expect("import");
    let ir = docx_lower::lower(&model);
    assert!(
        ir.styles.iter().any(|s| is_synthesized(&s.id)),
        "the lowering invents styles for the fixture"
    );
    let sk = docx_skeleton::skeleton_prefilled(&model, &ir, "d.docx", Default::default())
        .expect("builds")
        .expect("the whole body is native and the catalogue applies");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&sk.paged)).expect("zip");
    let mut pgm = Vec::new();
    zip.by_name(paged_store::DOCUMENT_PGM_PATH)
        .expect("model part")
        .read_to_end(&mut pgm)
        .unwrap();
    let doc: paged_scene::Document = paged_store::from_bytes(&pgm).expect("decodes");
    for s in ir.styles.iter().filter(|s| !is_synthesized(&s.id)) {
        let known = match s.collection {
            docx_lower::ir::StyleCollection::Paragraph => {
                doc.styles.paragraph_styles.contains_key(&s.id)
            }
            docx_lower::ir::StyleCollection::Character => {
                doc.styles.character_styles.contains_key(&s.id)
            }
        };
        assert!(known, "{} is in the document", s.id);
    }
    assert!(
        !doc.styles
            .paragraph_styles
            .keys()
            .chain(doc.styles.character_styles.keys())
            .any(|k| is_synthesized(k)),
        "no invented style in the document"
    );
    // A swatch the lowering mints is in the palette.
    for sw in &ir.swatches {
        assert!(doc.palette.colors.contains_key(&sw.id), "{}", sw.id);
    }
}

#[test]
fn a_footnote_reference_is_a_marker_run_and_a_note_on_the_paragraph() {
    let ir = lowered(&docx_conformance::structure_docx());
    let body = native_body(&ir);
    let mut notes = 0;
    let mut want = 0;
    for (b, old) in body.blocks.iter().zip(&ir.story.blocks) {
        let (NativeBlock::Paragraph(np), LoweredBlock::Paragraph(p)) = (b, old) else {
            continue;
        };
        want += p
            .runs
            .iter()
            .filter(|r| r.note.as_ref().is_some_and(|n| !n.endnote))
            .count();
        notes += np.footnotes.len();
        for f in &np.footnotes {
            let at = f.anchor.expect("anchored") as usize;
            let text: Vec<char> = np.runs.iter().flat_map(|r| r.text.chars()).collect();
            assert_eq!(text[at], paged_model::FOOTNOTE_REFERENCE_MARKER);
            assert!(f.paragraphs[0].runs[0]
                .text
                .starts_with(paged_model::FOOTNOTE_REFERENCE_MARKER));
        }
    }
    assert_eq!(
        notes, want,
        "one note per footnote reference of a built paragraph"
    );
}

#[test]
fn tracked_changes_and_comments_are_the_runs_own_and_the_stories() {
    for (label, bytes) in [
        ("tracked", docx_conformance::tracked_changes_docx()),
        ("review", docx_conformance::review_docx()),
    ] {
        let ir = lowered(&bytes);
        let body = native_body(&ir);
        let why: Vec<_> = body
            .blocks
            .iter()
            .filter_map(|b| match b {
                NativeBlock::Deferred { reason } => Some(reason.clone()),
                _ => None,
            })
            .collect();
        assert!(why.is_empty(), "{label}: deferred {why:?}");
        let (mut want_changes, mut got_changes) = (0, 0);
        let (mut want_marks, mut got_marks) = (0, 0);
        for (b, old) in body.blocks.iter().zip(&ir.story.blocks) {
            let (NativeBlock::Paragraph(np), LoweredBlock::Paragraph(p)) = (b, old) else {
                continue;
            };
            want_changes += p
                .runs
                .iter()
                .filter(|r| !r.text.is_empty() && (r.change.is_some() || r.format_change.is_some()))
                .count();
            got_changes += np
                .runs
                .iter()
                .filter(|r| r.revision.is_some() || r.format_change.is_some())
                .count();
            want_marks +=
                usize::from(p.mark_change.is_some()) + usize::from(p.props_change.is_some());
            got_marks +=
                usize::from(np.mark_revision.is_some()) + usize::from(np.props_change.is_some());
        }
        assert_eq!(want_changes, got_changes, "{label}: run changes");
        assert_eq!(want_marks, got_marks, "{label}: paragraph changes");
        let stories = docx_skeleton::body::native_stories(&ir).expect("whole");
        let threads: usize = stories.comments.iter().map(Vec::len).sum();
        assert!(threads <= ir.comments.len());
        if label == "review" {
            assert!(
                !ir.comments.is_empty() && threads > 0,
                "review has comments"
            );
        }
    }
}

#[test]
fn the_bundles_review_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/review-body.docx");
    let ir = lowered(bytes);
    let body = native_body(&ir);
    let why: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Deferred { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect();
    assert!(why.is_empty(), "deferred: {why:?}");
    let stories = docx_skeleton::body::native_stories(&ir).expect("whole");
    assert_eq!(stories.comments.iter().map(Vec::len).sum::<usize>(), 1);
    let runs: Vec<_> = stories.stories[0].iter().flat_map(|p| &p.runs).collect();
    assert!(runs.iter().any(|r| r.revision.is_some()));
    assert!(runs.iter().any(|r| r.format_change.is_some()));
    assert!(runs.iter().any(|r| !r.comments.is_empty()));
}

#[test]
fn bookmarks_and_a_table_of_contents_are_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/toc-body.docx");
    let ir = lowered(bytes);
    let body = native_body(&ir);
    let why: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Deferred { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect();
    assert!(why.is_empty(), "deferred: {why:?}");
    let stories = docx_skeleton::body::native_stories(&ir).expect("whole");
    let names: Vec<_> = stories.destinations[0]
        .iter()
        .filter_map(|d| d.name.as_deref())
        .collect();
    assert!(
        names.contains(&"_Toc1") && names.contains(&"_Toc2"),
        "{names:?}"
    );
    // Each anchor stands in a paragraph of the story.
    for d in &stories.destinations[0] {
        assert!((d.paragraph as usize) < stories.stories[0].len());
    }
}

#[test]
fn the_bundles_breaks_fixture_is_built_whole() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/breaks-body.docx");
    let ir = lowered(bytes);
    let body = native_body(&ir);
    let why: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Deferred { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect();
    assert!(why.is_empty(), "deferred: {why:?}");
    let splits = body
        .blocks
        .iter()
        .filter(|b| matches!(b, NativeBlock::Split(_)))
        .count();
    assert_eq!(splits, 2);
    assert!(docx_skeleton::body::native_stories(&ir).is_some(), "whole");
}

#[test]
fn headers_and_footers_fill_the_masters_stories() {
    let ir = lowered(&docx_conformance::structure_docx());
    let body = native_body(&ir);
    assert!(body.part_errors.is_empty(), "{:?}", body.part_errors);
    let frames: Vec<_> = ir
        .masters
        .iter()
        .flat_map(|m| [m.header.as_ref(), m.footer.as_ref()])
        .flatten()
        .collect();
    assert!(!frames.is_empty(), "the fixture has headers or footers");
    assert_eq!(body.parts.len(), frames.len());
    for (f, (story, paras)) in frames.iter().zip(&body.parts) {
        assert_eq!(&f.story_id, story);
        let said: String = paras
            .iter()
            .flat_map(|p| p.runs.iter().map(|r| r.text.as_str()))
            .collect();
        let want: String = ir.header_footer_parts[f.part]
            .paragraphs
            .iter()
            .flat_map(|p| p.runs.iter().map(|r| r.text.as_str()))
            .collect();
        assert_eq!(said, want);
    }
}

#[test]
fn text_boxes_get_their_stories() {
    let ir = lowered(&docx_conformance::objects_text_boxes_docx());
    let body = native_body(&ir);
    assert!(body.part_errors.is_empty(), "{:?}", body.part_errors);
    let page_boxes = ir
        .page_items
        .iter()
        .filter(|i| matches!(i.item, docx_lower::ir::LoweredItemKind::TextBox { .. }))
        .count();
    // The inline boxes of the paragraphs that were built (one with a look
    // is left to the old pour).
    let inline_boxes: usize = ir
        .story
        .blocks
        .iter()
        .zip(&body.blocks)
        .map(|(b, n)| match (b, n) {
            (LoweredBlock::Paragraph(p), NativeBlock::Paragraph(_) | NativeBlock::Split(_)) => {
                p.text_boxes.len()
            }
            _ => 0,
        })
        .sum();
    assert!(page_boxes + inline_boxes > 0, "the fixture has text boxes");
    assert_eq!(body.extra.len(), inline_boxes);
    // A page item's box story is among the parts, by its id.
    for i in &ir.page_items {
        if let docx_lower::ir::LoweredItemKind::TextBox { story_id, .. } = &i.item {
            assert!(body.parts.iter().any(|(s, _)| s == story_id));
        }
    }
}

#[test]
fn a_comment_on_a_table_cell_text_belongs_to_the_story() {
    let ir = lowered(include_bytes!(
        "../../packages/doc-bundle/test/fixtures/cell-comment.docx"
    ));
    let stories = docx_skeleton::body::native_stories(&ir).expect("the whole body is native");
    assert_eq!(stories.comments.iter().map(Vec::len).sum::<usize>(), 1);
    let cell_runs: Vec<_> = stories.stories[0]
        .iter()
        .filter_map(|p| p.table.as_ref())
        .flat_map(|t| &t.cells)
        .flat_map(|c| &c.paragraphs)
        .flat_map(|p| &p.runs)
        .filter(|r| !r.comments.is_empty())
        .collect();
    assert_eq!(cell_runs.len(), 1, "a run in a cell carries the comment");
}

#[test]
fn the_bundles_endnote_fixture_builds_the_endnote_story() {
    let bytes = include_bytes!("../../packages/doc-bundle/test/fixtures/endnote-body.docx");
    let model = docx_import::import_docx(bytes).expect("import");
    let ir = docx_lower::lower(&model);
    let body = native_body(&ir);
    let why: Vec<_> = body
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Deferred { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect();
    assert!(why.is_empty(), "deferred: {why:?}");
    assert_eq!(body.endnotes.len(), 2);
    let sk = docx_skeleton::skeleton_prefilled(&model, &ir, "e.docx", Default::default())
        .expect("builds")
        .expect("native");
    let doc = open_paged(&sk.paged);
    let story = doc
        .stories
        .iter()
        .find(|s| s.story.is_endnote_story)
        .expect("an endnote story");
    let para = &story.story.paragraphs[0];
    assert_eq!(para.endnote_ranges.len(), 2);
    let text: String = para.runs.iter().map(|r| r.text.as_str()).collect();
    assert!(text.starts_with("Endnotes\n"), "{text:?}");
    assert!(text.contains("First endnote.") && text.contains("Second endnote."));
    assert!(text.find("First").unwrap() < text.find("Second").unwrap());
    let refs: usize = doc
        .stories
        .iter()
        .filter(|s| !s.story.is_endnote_story)
        .flat_map(|s| &s.story.paragraphs)
        .map(|p| p.endnote_references.len())
        .sum();
    assert_eq!(refs, 2);
    assert!(doc
        .spreads
        .last()
        .is_some_and(|s| s.spread.endnote_frames.len() == 1));
}

fn open_paged(paged: &[u8]) -> paged_scene::Document {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(paged)).expect("zip");
    let mut pgm = Vec::new();
    zip.by_name(paged_store::DOCUMENT_PGM_PATH)
        .expect("model part")
        .read_to_end(&mut pgm)
        .unwrap();
    paged_store::from_bytes(&pgm).expect("decodes")
}

#[test]
fn picture_and_text_box_looks_are_painted_on_their_frames() {
    for (label, bytes) in [
        ("picture-effects", docx_conformance::picture_effects_docx()),
        ("text-boxes", docx_conformance::objects_text_boxes_docx()),
    ] {
        let model = docx_import::import_docx(&bytes).expect("import");
        let ir = docx_lower::lower(&model);
        let body = native_body(&ir);
        let why: Vec<_> = body
            .blocks
            .iter()
            .filter_map(|b| match b {
                NativeBlock::Deferred { reason } => Some(reason.clone()),
                _ => None,
            })
            .collect();
        assert!(why.is_empty(), "{label}: deferred {why:?}");
        let frames: Vec<_> = body
            .blocks
            .iter()
            .filter_map(|b| match b {
                NativeBlock::Paragraph(p) => Some(p.anchored_frames.iter()),
                _ => None,
            })
            .flatten()
            .collect();
        let looked = frames
            .iter()
            .filter(|f| {
                f.drop_shadow.is_some()
                    || f.effects.is_some()
                    || f.opacity.is_some()
                    || f.stroke_color.is_some()
                    || f.fill_color.is_some()
            })
            .count();
        let want = ir
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(p),
                _ => None,
            })
            .map(|p| {
                p.images.iter().filter(|i| i.fx.is_some()).count()
                    + p.text_boxes.iter().filter(|t| t.fx.is_some()).count()
            })
            .sum::<usize>();
        assert!(
            looked >= want && want > 0 || label != "picture-effects",
            "{label}"
        );
        // The swatches the looks name exist once the skeleton is built.
        let sk = docx_skeleton::skeleton_prefilled(&model, &ir, "l.docx", Default::default())
            .expect("builds")
            .expect("native");
        let doc = open_paged(&sk.paged);
        for f in frames {
            for c in [&f.fill_color, &f.stroke_color].into_iter().flatten() {
                if c.starts_with("Color/docx-") {
                    assert!(doc.palette.colors.contains_key(c), "{label}: {c}");
                }
                if c.starts_with("Gradient/docx-") {
                    assert!(doc.palette.gradients.contains_key(c), "{label}: {c}");
                }
            }
        }
    }
}

#[test]
fn a_language_does_not_refuse_the_catalogue() {
    let model = docx_import::import_docx(&docx_conformance::objects_languages_docx()).unwrap();
    let ir = docx_lower::lower(&model);
    let sk = docx_skeleton::skeleton_prefilled(&model, &ir, "g.docx", Default::default())
        .expect("builds")
        .expect("native despite characterLanguage");
    assert!(sk.notes.iter().any(|n| n.starts_with("characterLanguage")));
}

/// Doc ADR 627 — a shape without text is an anchored Rectangle frame whose
/// path is the shape's outline, with the shape's look; the whole body stays
/// native.
#[test]
fn shapes_are_anchored_frames_along_their_outline() {
    let ir = lowered(&docx_conformance::shapes_docx());
    let drawn: usize = ir
        .story
        .blocks
        .iter()
        .map(|b| match b {
            LoweredBlock::Paragraph(p) => p.shapes.len(),
            _ => 0,
        })
        .sum();
    assert_eq!(drawn, 8);
    let stories = docx_skeleton::body::native_stories(&ir).expect("the whole body is native");
    let frames: Vec<_> = stories.stories[0]
        .iter()
        .flat_map(|p| p.anchored_frames.iter())
        .filter(|f| {
            f.self_id
                .as_deref()
                .is_some_and(|i| i.starts_with("docx_shape"))
        })
        .collect();
    assert_eq!(frames.len(), 8);
    for f in &frames[..7] {
        assert!(!f.anchors.is_empty(), "{:?}", f.self_id);
        assert_eq!(f.subpath_starts.len(), f.subpath_open.len());
    }
    // Doc ADR 629 — the line with arrow heads is a Group of the line and its
    // two heads, placed as the shape.
    let arrow = frames[7];
    assert!(matches!(
        arrow.frame_kind,
        paged_model::AnchoredFrameKind::Group
    ));
    assert_eq!(arrow.children.len(), 3);
    assert_eq!(arrow.children[0].subpath_open, vec![true]);
    assert!(arrow.children[1..]
        .iter()
        .all(|h| h.fill_color.is_some() && h.subpath_open == vec![false]));
    // The triangle's three anchors, closed, filled blue.
    assert_eq!(frames[2].anchors.len(), 3);
    assert_eq!(frames[2].subpath_open, vec![false]);
    assert!(frames[2].fill_color.is_some());
    // The line is open and strokes.
    assert_eq!(frames[3].subpath_open, vec![true]);
    assert!(frames[3].stroke_color.is_some() && frames[3].stroke_weight == Some(3.0));
    // The ellipse floats beside its text with a wrap.
    assert!(frames[1].setting.is_some());
    assert!(frames[1].layout.text_wrap.is_some());
}

/// Doc ADR 628 — a chart is an anchored Group of its pieces: outlined
/// Rectangles (bars, gridlines) and text frames whose stories hold the
/// labels; the whole body stays native.
#[test]
fn charts_are_anchored_groups_of_their_pieces() {
    use paged_model::AnchoredFrameKind;
    let ir = lowered(&docx_conformance::charts_docx());
    let stories = docx_skeleton::body::native_stories(&ir).expect("the whole body is native");
    let groups: Vec<_> = stories.stories[0]
        .iter()
        .flat_map(|p| p.anchored_frames.iter())
        .filter(|f| {
            f.self_id
                .as_deref()
                .is_some_and(|i| i.starts_with("docx_chart"))
        })
        .collect();
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].self_id.as_deref(), Some("docx_chart0"));
    let bar = groups[0];
    assert!(matches!(bar.frame_kind, AnchoredFrameKind::Group));
    assert_eq!(
        bar.bounds.map(|b| (b.width(), b.height())),
        Some((360.0, 216.0))
    );
    assert!(bar.setting.is_none(), "inline: a character of its line");
    let shapes: Vec<_> = bar
        .children
        .iter()
        .filter(|c| matches!(c.frame_kind, AnchoredFrameKind::Rectangle))
        .collect();
    let labels: Vec<_> = bar
        .children
        .iter()
        .filter(|c| matches!(c.frame_kind, AnchoredFrameKind::TextFrame))
        .collect();
    assert!(
        shapes.len() >= 6 && labels.len() >= 6,
        "{} {}",
        shapes.len(),
        labels.len()
    );
    for s in &shapes {
        assert!(!s.anchors.is_empty());
        assert!(s.fill_color.is_some() || s.stroke_color.is_some());
    }
    // Every label's story is one of the stories made beside the body's.
    for l in &labels {
        let story = l.parent_story.as_deref().expect("a story");
        assert!(stories
            .extra
            .iter()
            .any(|(id, ps)| id == story && ps.len() == 1));
    }
    // The pie floats with its wrap.
    assert!(groups[1].setting.is_some() && groups[1].layout.text_wrap.is_some());
}

/// Doc ADR 629 — a SmartArt diagram is an anchored Group of the shapes Word
/// saved of its layout: outlined Rectangles (every preset through Annex D's
/// definitions) and TextFrames over the boxes Word sets the text in.
#[test]
fn smartart_is_an_anchored_group_of_its_drawing() {
    use paged_model::AnchoredFrameKind;
    let ir = lowered(&docx_conformance::smartart_docx());
    let stories = docx_skeleton::body::native_stories(&ir).expect("the whole body is native");
    let groups: Vec<_> = stories.stories[0]
        .iter()
        .flat_map(|p| p.anchored_frames.iter())
        .filter(|f| {
            f.self_id
                .as_deref()
                .is_some_and(|i| i.starts_with("docx_diagram"))
        })
        .collect();
    assert_eq!(
        groups.len(),
        1,
        "the diagram without a drawing is not drawn"
    );
    let g = groups[0];
    assert!(matches!(g.frame_kind, AnchoredFrameKind::Group));
    let shapes: Vec<_> = g
        .children
        .iter()
        .filter(|c| matches!(c.frame_kind, AnchoredFrameKind::Rectangle))
        .collect();
    let texts: Vec<_> = g
        .children
        .iter()
        .filter(|c| matches!(c.frame_kind, AnchoredFrameKind::TextFrame))
        .collect();
    assert_eq!((shapes.len(), texts.len()), (4, 3));
    // The chevron, halved by its group, sits after the arrow.
    let chevron = shapes[2];
    assert_eq!(chevron.anchors.len(), 6);
    let b = chevron.bounds.unwrap();
    assert!(
        (b.left - 152.4).abs() < 0.01 && (b.width() - 108.0).abs() < 0.01,
        "{b:?}"
    );
    // Text is centred in its box, as Word anchors it.
    for t in &texts {
        assert_eq!(
            t.layout.vertical_justification.as_deref(),
            Some("CenterAlign")
        );
        assert_eq!(t.layout.inset_spacing, Some([6.0; 4]));
    }
}
