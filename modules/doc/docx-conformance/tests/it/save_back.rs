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

//! M2 edited save-back vertical slice: a `.docx` imports, two run edits (a text
//! change and a property change) are applied, and the saved package is asserted
//! to (a) carry exactly those edits, (b) leave every other part AND every
//! untouched subtree of `word/document.xml` byte-identical, and (c) round-trip
//! through re-import. The `EditSet` is hand-authored here — the LIVE editor
//! wiring is the deferred DOC-03 seam.

use docx_conformance::memo_docx;
use docx_core::{Block, RunProps};
use docx_export::{EditSet, RunEdit};
use docx_import::import_docx;
use docx_js::DocSession;
use paged_ooxml::OpcPackage;

fn body_para(doc: &docx_core::DocxDocument, i: usize) -> &docx_core::Paragraph {
    match &doc.body[i] {
        Block::Paragraph(p) => p,
        _ => panic!("body[{i}] is not a paragraph"),
    }
}

#[test]
fn edited_save_back_patches_targets_and_preserves_everything_else() {
    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();

    // Edit 1: replace p0's only run text. Edit 2: toggle bold OFF the "bold red"
    // run (p2, run 1) — its synthesized bold+red style projects to a direct
    // `<w:rPr>` carrying only the color.
    let edits = EditSet {
        structural: vec![],
        cells: vec![],
        paragraphs: vec![],
        runs: vec![
            RunEdit::text(0, 0, "Edited body text."),
            RunEdit::props(
                2,
                1,
                RunProps {
                    color: Some("FF0000".into()),
                    ..Default::default()
                },
            ),
        ],
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    let saved_pkg = OpcPackage::read(&saved).unwrap();
    let doc_xml =
        std::str::from_utf8(saved_pkg.part("word/document.xml").expect("document.xml")).unwrap();

    // (a) the two targets changed.
    assert!(doc_xml.contains(">Edited body text.<"), "p0 text replaced");
    assert!(!doc_xml.contains(">Plain body text.<"), "old p0 text gone");
    assert!(
        doc_xml.contains(r#"<w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>bold red</w:t>"#),
        "bold dropped, color kept, text intact:\n{doc_xml}"
    );
    assert!(
        !doc_xml.contains("<w:b/>"),
        "no bold toggle remains anywhere"
    );

    // (b) preservation — every OTHER part decompressed-identical.
    let orig_pkg = OpcPackage::read(&original).unwrap();
    for name in orig_pkg.file_names() {
        if name == "word/document.xml" {
            continue;
        }
        assert_eq!(
            orig_pkg.part(name),
            saved_pkg.part(name),
            "part {name} must be byte-identical"
        );
    }
    // ...and within document.xml, every untouched subtree survives verbatim.
    assert!(doc_xml.contains(r#"<w:pStyle w:val="Heading1"/>"#));
    assert!(doc_xml.contains(">A Centered Heading<"));
    assert!(doc_xml.contains("<w:sectPr>"));
    assert!(
        doc_xml.contains(">Mix of normal and <"),
        "p2 run 0 untouched"
    );
    assert!(doc_xml.contains("> text.<"), "p2 run 2 untouched");

    // (c) round-trip: re-import reflects exactly the edits and nothing else.
    let re = import_docx(&saved).unwrap();
    assert_eq!(body_para(&re, 0).runs[0].text, "Edited body text.");
    assert_eq!(body_para(&re, 1).runs[0].text, "A Centered Heading");
    let p2 = body_para(&re, 2);
    assert_eq!(p2.runs[0].text, "Mix of normal and ");
    assert_eq!(p2.runs[1].text, "bold red");
    assert_eq!(p2.runs[1].props.bold, None, "bold toggled off");
    assert_eq!(
        p2.runs[1].props.color.as_deref(),
        Some("FF0000"),
        "color kept"
    );
    assert_eq!(p2.runs[2].text, " text.");
}

#[test]
fn zero_edit_save_back_still_byte_identical() {
    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    // An empty edit set patches nothing; verbatim carry-through holds.
    let (saved, _skips) = session.save_edited(&EditSet::default()).unwrap();
    let orig_pkg = OpcPackage::read(&original).unwrap();
    let saved_pkg = OpcPackage::read(&saved).unwrap();
    for name in orig_pkg.file_names() {
        assert_eq!(orig_pkg.part(name), saved_pkg.part(name), "part {name}");
    }
}

#[test]
fn bindings_run_counts_match_the_lowered_story() {
    // `build_bindings` replays lowering's `!text.is_empty()` filter; if it drifts,
    // `(block, run)` coordinates would silently mis-resolve. Assert alignment.
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&memo_docx()).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let lowered = docx_lower::lower(&model);
    assert_eq!(bindings.blocks.len(), lowered.story.blocks.len());
    for (i, block) in lowered.story.blocks.iter().enumerate() {
        if let docx_lower::ir::LoweredBlock::Paragraph(p) = block {
            match &bindings.blocks[i] {
                docx_export::BlockBinding::Paragraph { runs, .. } => {
                    assert_eq!(runs.len(), p.runs.len(), "run-count drift at block {i}");
                }
                _ => panic!("block {i} should bind as a paragraph"),
            }
        }
    }
}

#[test]
fn diff_of_identical_lowerings_produces_no_edits() {
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&memo_docx()).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);
    let edits = docx_export::diff(&base, &base, &bindings);
    assert!(edits.runs.is_empty(), "identical lowerings ⇒ no edits");
}

#[test]
fn diff_drives_save_back_end_to_end() {
    use docx_lower::ir::{LoweredBlock, LoweredStyle, PropValue, StyleCollection, StyleProp};

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);

    // Simulate an edit: change p0's text, and repoint the "bold red" run (block 2,
    // run 1) at a NEW color-only synthesized style (i.e. the user removed bold).
    let red_swatch = base
        .swatches
        .iter()
        .find(|s| s.value == vec![255.0, 0.0, 0.0])
        .expect("red swatch")
        .id
        .clone();
    let mut edited = base.clone();
    if let LoweredBlock::Paragraph(p) = &mut edited.story.blocks[0] {
        p.runs[0].text = "Edited via diff.".into();
    }
    edited.styles.push(LoweredStyle {
        id: "CharacterStyle/docx-auto-cNEW".into(),
        name: "color only".into(),
        collection: StyleCollection::Character,
        based_on: None,
        props: vec![StyleProp {
            path: "characterFillColor".into(),
            value: PropValue::ColorRef(red_swatch),
        }],
    });
    if let LoweredBlock::Paragraph(p) = &mut edited.story.blocks[2] {
        p.runs[1].char_style_id = Some("CharacterStyle/docx-auto-cNEW".into());
    }

    // Diff → EditSet → save-back → assert both edits landed.
    let edits = docx_export::diff(&base, &edited, &bindings);
    assert_eq!(edits.runs.len(), 2, "one text + one property edit");
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    let re = import_docx(&saved).unwrap();
    assert_eq!(body_para(&re, 0).runs[0].text, "Edited via diff.");
    let p2 = body_para(&re, 2);
    assert_eq!(p2.runs[1].text, "bold red", "text untouched");
    assert_eq!(p2.runs[1].props.bold, None, "bold removed by the diff");
    assert_eq!(
        p2.runs[1].props.color.as_deref(),
        Some("FF0000"),
        "color kept"
    );
}

#[test]
fn doc03_read_overlay_diff_save_round_trips() {
    // The LIVE DOC-03 path, with the host read mocked: build a `StoryContent`
    // mirroring the baseline (as `host.document.storyContent` would return),
    // apply two edits to it, and drive `save_edited_from_content`.
    use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn};
    use docx_lower::ir::LoweredBlock;

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let base = docx_lower::lower(&model);

    // The read-back reflects the plugin's own story: each run's characterStyle IS
    // the plugin's char_style_id token, so it mirrors the baseline exactly...
    let mut content = StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: p
                        .runs
                        .iter()
                        .map(|r| RunContentIn {
                            text: r.text.clone(),
                            character_style: r.char_style_id.clone(),
                            ..Default::default()
                        })
                        .collect(),
                }),
                _ => None,
            })
            .collect(),
    };
    // ...then the "user" edits: change p0's text, and clear the bold-red run's
    // style (bold + color removed).
    content.paragraphs[0].runs[0].text = "Edited via content.".into();
    content.paragraphs[2].runs[1].character_style = None;

    let (saved, _skips) = session.save_edited_from_content(&content).unwrap();

    let re = import_docx(&saved).unwrap();
    assert_eq!(body_para(&re, 0).runs[0].text, "Edited via content.");
    let p2 = body_para(&re, 2);
    assert_eq!(p2.runs[1].text, "bold red", "text untouched");
    assert_eq!(
        p2.runs[1].props.bold, None,
        "bold cleared via the read overlay"
    );
    assert_eq!(p2.runs[1].props.color, None, "color cleared");
    // Untouched runs stay put.
    assert_eq!(p2.runs[0].text, "Mix of normal and ");
    assert_eq!(body_para(&re, 1).runs[0].text, "A Centered Heading");
}

#[test]
fn doc03_identity_content_is_a_no_op() {
    // A read-back identical to the baseline ⇒ no edits ⇒ verbatim save.
    use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn};
    use docx_lower::ir::LoweredBlock;

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let base = docx_lower::lower(&model);
    let content = StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: p
                        .runs
                        .iter()
                        .map(|r| RunContentIn {
                            text: r.text.clone(),
                            character_style: r.char_style_id.clone(),
                            ..Default::default()
                        })
                        .collect(),
                }),
                _ => None,
            })
            .collect(),
    };
    let (saved, _skips) = session.save_edited_from_content(&content).unwrap();
    let orig_pkg = OpcPackage::read(&original).unwrap();
    let saved_pkg = OpcPackage::read(&saved).unwrap();
    for name in orig_pkg.file_names() {
        assert_eq!(orig_pkg.part(name), saved_pkg.part(name), "part {name}");
    }
}

#[test]
fn structural_edits_insert_and_delete_runs_and_paragraphs() {
    // Increment 2, driven through the DOC-03 overlay: delete a run, add a run,
    // and the untouched content stays byte-identical.
    use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn};
    use docx_lower::ir::LoweredBlock;

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let base = docx_lower::lower(&model);

    let mut content = StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: p
                        .runs
                        .iter()
                        .map(|r| RunContentIn {
                            text: r.text.clone(),
                            character_style: r.char_style_id.clone(),
                            ..Default::default()
                        })
                        .collect(),
                }),
                _ => None,
            })
            .collect(),
    };
    // p2 is "Mix of normal and " + "bold red" + " text." — drop the middle run
    // and append a new one at the end.
    content.paragraphs[2].runs.remove(1);
    content.paragraphs[2].runs.push(RunContentIn {
        text: " (appended)".into(),
        character_style: None,
        ..Default::default()
    });

    let (saved, _skips) = session.save_edited_from_content(&content).unwrap();
    let re = import_docx(&saved).unwrap();
    let p2 = body_para(&re, 2);
    let texts: Vec<&str> = p2.runs.iter().map(|r| r.text.as_str()).collect();
    // Text typed after a run in its look extends that run, as typing at
    // the end of a word does (the runs are mapped character by character).
    assert_eq!(
        texts,
        ["Mix of normal and ", " text. (appended)"],
        "middle run deleted, the text appended to the run it follows"
    );
    // Other paragraphs untouched; other parts byte-identical.
    assert_eq!(body_para(&re, 0).runs[0].text, "Plain body text.");
    assert_eq!(body_para(&re, 1).runs[0].text, "A Centered Heading");
    let orig_pkg = OpcPackage::read(&original).unwrap();
    let saved_pkg = OpcPackage::read(&saved).unwrap();
    for name in orig_pkg.file_names() {
        if name == "word/document.xml" {
            continue;
        }
        assert_eq!(orig_pkg.part(name), saved_pkg.part(name), "part {name}");
    }
}

#[test]
fn structural_paragraph_delete_and_append() {
    use docx_export::{EditSet, StructuralEdit};

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let edits = EditSet {
        runs: vec![],
        cells: vec![],
        paragraphs: vec![],
        structural: vec![
            StructuralEdit::DeleteParagraph { block: 1 }, // the heading
            StructuralEdit::InsertParagraph {
                block: 2,
                text: "A brand new paragraph.".into(),
                props: Default::default(),
                para_style: None,
                rstyle: None,
            },
        ],
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();
    let re = import_docx(&saved).unwrap();
    let texts: Vec<String> = re
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p.runs.iter().map(|r| r.text.as_str()).collect()),
            _ => None,
        })
        .collect();
    assert_eq!(
        texts,
        [
            "Plain body text.",
            "Mix of normal and bold red text.",
            "A brand new paragraph.",
        ],
        "heading deleted, new paragraph appended after the last one"
    );
}

#[test]
fn table_cell_text_round_trips() {
    use docx_conformance::table_docx;
    use docx_export::CellRunEdit;

    let original = table_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let base = docx_lower::lower(&model);

    // Find the table block + its first cell's first run.
    let (block, table) = base
        .story
        .blocks
        .iter()
        .enumerate()
        .find_map(|(i, b)| match b {
            docx_lower::ir::LoweredBlock::Table(t) => Some((i, t)),
            _ => None,
        })
        .expect("a table block");
    let before = table.cells[0].paragraphs[0].runs[0].text.clone();
    assert!(!before.is_empty(), "the first cell has text");

    let edits = docx_export::EditSet {
        cells: vec![CellRunEdit::text(block, 0, 0, 0, "PATCHED CELL")],
        ..Default::default()
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    // The cell text changed...
    let re_model = docx_import::import_docx(&saved).unwrap();
    let re = docx_lower::lower(&re_model);
    let re_table = re
        .story
        .blocks
        .iter()
        .find_map(|b| match b {
            docx_lower::ir::LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .expect("table survives");
    assert_eq!(re_table.cells[0].paragraphs[0].runs[0].text, "PATCHED CELL");
    // ...the OTHER cells are untouched, and the grid survives.
    assert_eq!(re_table.cells.len(), table.cells.len());
    assert_eq!(re_table.column_widths_pt, table.column_widths_pt);
    for (i, (a, b)) in table.cells.iter().zip(&re_table.cells).enumerate().skip(1) {
        let at: String = a
            .paragraphs
            .iter()
            .flat_map(|p| p.runs.iter())
            .map(|r| r.text.as_str())
            .collect();
        let bt: String = b
            .paragraphs
            .iter()
            .flat_map(|p| p.runs.iter())
            .map(|r| r.text.as_str())
            .collect();
        assert_eq!(at, bt, "cell {i} untouched");
        assert_eq!(a.row_span, b.row_span, "cell {i} rowSpan kept");
        assert_eq!(a.col_span, b.col_span, "cell {i} colSpan kept");
    }
    // Every other part stays byte-identical.
    let orig_pkg = OpcPackage::read(&original).unwrap();
    let saved_pkg = OpcPackage::read(&saved).unwrap();
    for name in orig_pkg.file_names() {
        if name == "word/document.xml" {
            continue;
        }
        assert_eq!(orig_pkg.part(name), saved_pkg.part(name), "part {name}");
    }
}

#[test]
fn table_cell_diff_drives_save_back() {
    use docx_conformance::table_docx;

    let original = table_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);

    // Edit a cell in a cloned lowering; the differ must produce a cell edit.
    let mut edited = base.clone();
    if let docx_lower::ir::LoweredBlock::Table(t) = &mut edited.story.blocks[1] {
        t.cells[1].paragraphs[0].runs[0].text = "via diff".into();
    }
    let edits = docx_export::diff(&base, &edited, &bindings);
    assert_eq!(edits.cells.len(), 1, "one cell edit: {:?}", edits.cells);

    let (saved, _skips) = session.save_edited(&edits).unwrap();
    let re = docx_lower::lower(&docx_import::import_docx(&saved).unwrap());
    if let docx_lower::ir::LoweredBlock::Table(t) = &re.story.blocks[1] {
        assert_eq!(t.cells[1].paragraphs[0].runs[0].text, "via diff");
    } else {
        panic!("expected a table at block 1");
    }
}

#[test]
fn paragraph_property_edits_rewrite_the_ppr() {
    use docx_export::ParaEdit;

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    // Centre p0 (it has NO <w:pPr> at all, so one must be INSERTED) and drop the
    // heading's pStyle from p1 (its <w:pPr> is REPLACED).
    let edits = EditSet {
        paragraphs: vec![
            ParaEdit {
                block: 0,
                new_props: docx_core::ParaProps {
                    justification: Some(docx_core::Justification::Center),
                    ..Default::default()
                },
                pstyle: Some(None),
            },
            ParaEdit {
                block: 1,
                new_props: docx_core::ParaProps::default(),
                pstyle: Some(None),
            },
        ],
        ..Default::default()
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    let re = import_docx(&saved).unwrap();
    let p0 = body_para(&re, 0);
    assert_eq!(
        p0.props.justification,
        Some(docx_core::Justification::Center),
        "pPr INSERTED on a paragraph that had none"
    );
    assert_eq!(p0.runs[0].text, "Plain body text.", "text untouched");
    let p1 = body_para(&re, 1);
    assert_eq!(p1.style_id, None, "the heading's pStyle was dropped");
    assert_eq!(p1.runs[0].text, "A Centered Heading", "text untouched");
    // Everything else survives.
    assert_eq!(body_para(&re, 2).runs[1].text, "bold red");
    let orig_pkg = OpcPackage::read(&original).unwrap();
    let saved_pkg = OpcPackage::read(&saved).unwrap();
    for name in orig_pkg.file_names() {
        if name == "word/document.xml" {
            continue;
        }
        assert_eq!(orig_pkg.part(name), saved_pkg.part(name), "part {name}");
    }
}

#[test]
fn diff_detects_a_paragraph_style_change() {
    use docx_lower::ir::LoweredBlock;

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);

    // Repoint p1 (the heading) at p0's paragraph style — a paragraph-level change
    // the differ used to miss entirely (it only compared runs).
    let mut edited = base.clone();
    let p0_style = match &base.story.blocks[0] {
        LoweredBlock::Paragraph(p) => p.para_style_id.clone(),
        _ => panic!("expected a paragraph"),
    };
    if let LoweredBlock::Paragraph(p) = &mut edited.story.blocks[1] {
        p.para_style_id = p0_style;
    }
    let edits = docx_export::diff(&base, &edited, &bindings);
    assert_eq!(
        edits.paragraphs.len(),
        1,
        "one paragraph edit: {:?}",
        edits.paragraphs
    );
    assert_eq!(edits.paragraphs[0].block, 1);

    let (saved, _skips) = session.save_edited(&edits).unwrap();
    let re = import_docx(&saved).unwrap();
    assert_ne!(
        body_para(&re, 1).style_id.as_deref(),
        Some("Heading1"),
        "the heading style no longer applies"
    );
    assert_eq!(body_para(&re, 1).runs[0].text, "A Centered Heading");
}

#[test]
fn hyperlink_display_text_is_editable_and_keeps_its_target() {
    // A `<w:hyperlink>`-wrapped run: the `r:id` lives on the WRAPPER, so editing
    // the run's text cannot desync the link. Previously these were marked
    // non-patchable outright.
    use docx_conformance::hyperlink_docx;

    let original = hyperlink_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let base = docx_lower::lower(&model);
    // The linked run is index 1 ("Paged Media").
    assert_eq!(base.story.paragraphs()[0].runs[1].text, "Paged Media");

    let edits = EditSet {
        runs: vec![RunEdit::text(0, 1, "the Paged site")],
        ..Default::default()
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    let re = import_docx(&saved).unwrap();
    let para = match &re.body[0] {
        Block::Paragraph(p) => p,
        _ => panic!("expected a paragraph"),
    };
    assert_eq!(para.runs[1].text, "the Paged site", "display text edited");
    assert_eq!(
        para.runs[1].hyperlink.as_deref(),
        Some("https://paged.media/"),
        "the link target survived the edit"
    );
    assert_eq!(para.runs[0].text, "Visit ", "sibling untouched");
    assert_eq!(para.runs[2].text, " today.", "sibling untouched");
}

#[test]
fn field_hyperlink_runs_are_editable_in_both_forms() {
    // fldSimple (a WRAPPER, addressed on its own path) and the complex fldChar
    // RESULT run (a DIRECT `<w:r>` child whose URL lives in a separate instrText
    // run) — both are safely patchable.
    use docx_conformance::field_hyperlink_docx;

    let original = field_hyperlink_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let base = docx_lower::lower(&model);
    let texts: Vec<&str> = base.story.paragraphs()[0]
        .runs
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(
        texts,
        ["Go ", "complex link", " and ", "simple link", " done."]
    );

    let edits = EditSet {
        runs: vec![
            RunEdit::text(0, 1, "COMPLEX"), // fldChar result run (direct child)
            RunEdit::text(0, 3, "SIMPLE"),  // fldSimple-wrapped run
        ],
        ..Default::default()
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    let re = import_docx(&saved).unwrap();
    let para = match &re.body[0] {
        Block::Paragraph(p) => p,
        _ => panic!("expected a paragraph"),
    };
    assert_eq!(para.runs[1].text, "COMPLEX");
    assert_eq!(
        para.runs[1].hyperlink.as_deref(),
        Some("https://example.com/complex"),
        "the complex field's URL (a separate instrText run) survived"
    );
    assert_eq!(para.runs[3].text, "SIMPLE");
    assert_eq!(
        para.runs[3].hyperlink.as_deref(),
        Some("https://example.com/simple"),
        "the fldSimple instruction attribute survived"
    );
}

#[test]
fn table_rows_can_be_deleted_and_inserted() {
    use docx_conformance::table_docx;
    use docx_export::StructuralEdit;
    use docx_lower::ir::LoweredBlock;

    let original = table_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let base = docx_lower::lower(&model);
    let (block, before) = base
        .story
        .blocks
        .iter()
        .enumerate()
        .find_map(|(i, b)| match b {
            LoweredBlock::Table(t) => Some((i, t)),
            _ => None,
        })
        .expect("a table block");
    assert_eq!(before.rows, 3, "fixture has 3 rows");

    // Drop the LAST row (the vMerge-continue one) and append a fresh 2-cell row
    // after row 1.
    let edits = EditSet {
        structural: vec![
            StructuralEdit::DeleteRow { block, row: 2 },
            StructuralEdit::InsertRow {
                block,
                after_row: 1,
                cells: vec!["new left".into(), "new right".into()],
                before: false,
            },
        ],
        ..Default::default()
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    let re = docx_lower::lower(&docx_import::import_docx(&saved).unwrap());
    let after = re
        .story
        .blocks
        .iter()
        .find_map(|b| match b {
            LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .expect("table survives");
    assert_eq!(after.rows, 3, "one row removed, one added");
    let texts: Vec<String> = after
        .cells
        .iter()
        .map(|c| {
            c.paragraphs
                .iter()
                .flat_map(|p| p.runs.iter())
                .map(|r| r.text.as_str())
                .collect()
        })
        .collect();
    assert!(
        texts.contains(&"new left".to_string()),
        "inserted cell: {texts:?}"
    );
    assert!(
        texts.contains(&"new right".to_string()),
        "inserted cell: {texts:?}"
    );
    assert!(texts.contains(&"Title spanning".to_string()), "row 0 kept");
    assert!(
        !texts.contains(&"Right bottom".to_string()),
        "row 2 deleted"
    );
    // The surrounding body paragraphs are untouched.
    let paras: Vec<&str> = re
        .story
        .paragraphs()
        .iter()
        .map(|p| p.runs.first().map(|r| r.text.as_str()).unwrap_or(""))
        .collect();
    assert_eq!(paras, ["Before the table.", "After the table."]);
    // Every other part stays byte-identical.
    let orig_pkg = OpcPackage::read(&original).unwrap();
    let saved_pkg = OpcPackage::read(&saved).unwrap();
    for name in orig_pkg.file_names() {
        if name == "word/document.xml" {
            continue;
        }
        assert_eq!(orig_pkg.part(name), saved_pkg.part(name), "part {name}");
    }
}

#[test]
fn diff_derives_a_row_deletion() {
    use docx_conformance::table_docx;
    use docx_lower::ir::LoweredBlock;

    let original = table_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);

    // Simulate the editor dropping the last row.
    let mut edited = base.clone();
    if let LoweredBlock::Table(t) = &mut edited.story.blocks[1] {
        t.rows -= 1;
        t.cells.retain(|c| c.row < t.rows);
    }
    let edits = docx_export::diff(&base, &edited, &bindings);
    assert_eq!(
        edits.structural.len(),
        1,
        "one row op: {:?}",
        edits.structural
    );

    let (saved, _skips) = session.save_edited(&edits).unwrap();
    let re = docx_lower::lower(&docx_import::import_docx(&saved).unwrap());
    if let LoweredBlock::Table(t) = &re.story.blocks[1] {
        assert_eq!(t.rows, 2, "the row was removed from the source");
    } else {
        panic!("expected a table at block 1");
    }
}

#[test]
fn deleting_a_middle_paragraph_preserves_the_survivors() {
    // memo = [Plain, Heading, Mix(3 runs)]. Dropping the MIDDLE one must delete
    // THAT paragraph's <w:p> and leave the third one's source node intact — not
    // rewrite the heading into the third's text and delete the third.
    use docx_lower::ir::LoweredBlock;

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);

    let mut edited = base.clone();
    edited.story.blocks.remove(1); // drop the heading

    let edits = docx_export::diff(&base, &edited, &bindings);
    let (saved, _skips) = session.save_edited(&edits).unwrap();
    let re = import_docx(&saved).unwrap();

    let paras: Vec<&docx_core::Paragraph> = re
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .collect();
    assert_eq!(paras.len(), 2, "one paragraph removed");
    assert_eq!(paras[0].runs[0].text, "Plain body text.");
    // The SURVIVING third paragraph must still be its own source node — three
    // separate runs, with the bold-red one intact.
    let texts: Vec<&str> = paras[1].runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(
        texts,
        ["Mix of normal and ", "bold red", " text."],
        "the survivor kept its own runs (not flattened from a rewritten heading)"
    );
    assert_eq!(
        paras[1].runs[1].props.bold,
        Some(true),
        "its formatting survived"
    );
    // THE SHARP ONE: the survivor must not have inherited the deleted heading's
    // paragraph style. If the differ deleted the TRAILING paragraph and rewrote
    // the heading in place, this is Some("Heading1") — the text is right but the
    // wrong source node survived.
    assert_eq!(
        paras[1].style_id, None,
        "the survivor is the third paragraph's own <w:p>, not the heading's"
    );
    let _ = LoweredBlock::Table; // keep the import used
}

#[test]
fn deleting_a_middle_row_preserves_the_surviving_rows() {
    // The row-level twin of the block-alignment fix: dropping the MIDDLE row must
    // delete THAT `<w:tr>` and leave rows 0 and 2 as their own source nodes — not
    // delete the trailing row and rewrite the middle one's cells.
    use docx_conformance::simple_table_docx;
    use docx_lower::ir::LoweredBlock;

    let original = simple_table_docx();
    let session = DocSession::load(&original).unwrap();
    let (model, _pkg, _main) = docx_import::import_docx_with_package(&original).unwrap();
    let bindings = docx_export::build_bindings(&model);
    let base = docx_lower::lower(&model);

    let mut edited = base.clone();
    if let LoweredBlock::Table(t) = &mut edited.story.blocks[0] {
        t.cells.retain(|c| c.row != 1); // drop the MIDDLE row
        for c in t.cells.iter_mut() {
            if c.row == 2 {
                c.row = 1; // rows above close up
            }
        }
        t.rows = 2;
    }

    let edits = docx_export::diff(&base, &edited, &bindings);
    let (saved, _skips) = session.save_edited(&edits).unwrap();
    let re = docx_lower::lower(&docx_import::import_docx(&saved).unwrap());
    let t = re
        .story
        .blocks
        .iter()
        .find_map(|b| match b {
            LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .expect("table survives");
    assert_eq!(t.rows, 2, "one row removed");
    let texts: Vec<String> = t
        .cells
        .iter()
        .map(|c| {
            c.paragraphs
                .iter()
                .flat_map(|p| p.runs.iter())
                .map(|r| r.text.as_str())
                .collect()
        })
        .collect();
    assert_eq!(
        texts,
        ["R0C0", "R0C1", "R2C0", "R2C1"],
        "rows 0 and 2 survived as themselves (the MIDDLE row went)"
    );

    // THE SHARP ONE: each row carries a distinct UNMODELLED `w:trHeight`. If the
    // differ deleted the TRAILING row and rewrote the middle one, the text above
    // still passes — but row 2's marker (102) is gone and row 1's (101) remains.
    let pkg = OpcPackage::read(&saved).unwrap();
    let xml = std::str::from_utf8(pkg.part("word/document.xml").unwrap()).unwrap();
    assert!(xml.contains(r#"w:val="100""#), "row 0's node survived");
    assert!(
        xml.contains(r#"w:val="102""#),
        "row 2's OWN node survived (its unmodelled trHeight is intact):\n{xml}"
    );
    assert!(
        !xml.contains(r#"w:val="101""#),
        "the MIDDLE row's node is the one that went"
    );
}

#[test]
fn columns_can_be_inserted_and_deleted_on_a_uniform_grid() {
    use docx_conformance::simple_table_docx;
    use docx_export::StructuralEdit;
    use docx_lower::ir::LoweredBlock;

    let original = simple_table_docx();
    let table_of = |bytes: &[u8]| {
        let ir = docx_lower::lower(&docx_import::import_docx(bytes).unwrap());
        match ir
            .story
            .blocks
            .iter()
            .find(|b| matches!(b, LoweredBlock::Table(_)))
        {
            Some(LoweredBlock::Table(t)) => t.clone(),
            _ => panic!("no table"),
        }
    };
    assert_eq!(table_of(&original).cols, 2, "fixture is 3x2");

    // Add a column after col 0 — the grid AND every row must grow together.
    let session = DocSession::load(&original).unwrap();
    let (grown, _skips) = session
        .save_edited(&EditSet {
            structural: vec![StructuralEdit::InsertColumn {
                block: 0,
                after_col: 0,
                text: "NEW".into(),
            }],
            ..Default::default()
        })
        .unwrap();
    let t = table_of(&grown);
    assert_eq!(t.cols, 3, "gridCol added");
    assert_eq!(t.rows, 3, "rows unchanged");
    assert_eq!(t.cells.len(), 9, "one new cell per row");
    let row0: Vec<String> = t
        .cells
        .iter()
        .filter(|c| c.row == 0)
        .map(|c| {
            c.paragraphs
                .iter()
                .flat_map(|p| p.runs.iter())
                .map(|r| r.text.as_str())
                .collect()
        })
        .collect();
    assert_eq!(row0, ["R0C0", "NEW", "R0C1"], "inserted after col 0");

    // Remove column 1 from the ORIGINAL — grid and rows shrink together.
    let (shrunk, _skips) = DocSession::load(&original)
        .unwrap()
        .save_edited(&EditSet {
            structural: vec![StructuralEdit::DeleteColumn { block: 0, col: 1 }],
            ..Default::default()
        })
        .unwrap();
    let t2 = table_of(&shrunk);
    assert_eq!(t2.cols, 1, "gridCol removed");
    assert_eq!(t2.cells.len(), 3, "one cell per row remains");
    let texts: Vec<String> = t2
        .cells
        .iter()
        .map(|c| {
            c.paragraphs
                .iter()
                .flat_map(|p| p.runs.iter())
                .map(|r| r.text.as_str())
                .collect()
        })
        .collect();
    assert_eq!(
        texts,
        ["R0C0", "R1C0", "R2C0"],
        "column 1 gone from every row"
    );
}

#[test]
fn column_ops_are_refused_on_a_gridspan_table() {
    // The gridSpan fixture: whether a new column widens the span or splits it is
    // ambiguous, so the op must be SKIPPED — never a corrupted grid.
    use docx_conformance::table_docx;
    use docx_export::StructuralEdit;

    let original = table_docx();
    let session = DocSession::load(&original).unwrap();
    let (saved, skips) = session
        .save_edited(&EditSet {
            structural: vec![StructuralEdit::DeleteColumn { block: 1, col: 0 }],
            ..Default::default()
        })
        .unwrap();
    // The refusal is TOLD, not silent (the diagnostics ledger).
    assert_eq!(skips.len(), 1, "one skip note for the refused column op");
    assert!(
        skips[0].contains("gridSpan"),
        "the note names the gridSpan ambiguity: {}",
        skips[0]
    );
    // Skipped ⇒ nothing was patched at all: every part byte-identical.
    let a = OpcPackage::read(&original).unwrap();
    let b = OpcPackage::read(&saved).unwrap();
    for name in a.file_names() {
        assert_eq!(a.part(name), b.part(name), "part {name} untouched");
    }
}

#[test]
fn a_nested_table_does_not_misdirect_outer_cell_edits() {
    // The locator counts `<w:tr>` by parent element. A NESTED table's rows sit
    // under their own `<w:tbl>`, so without depth-awareness they inflate the
    // OUTER table's row counter — and an edit aimed at an outer row lands inside
    // the nested table instead. That is silent cross-table corruption.
    use docx_conformance::nested_table_docx;
    use docx_export::CellRunEdit;

    let original = nested_table_docx();
    let session = DocSession::load(&original).unwrap();
    // Outer cells as lowered: [row0 ("outer r0"), row1 ("outer r1")] — the nested
    // table itself is not modelled.
    let edits = EditSet {
        cells: vec![CellRunEdit::text(0, 1, 0, 0, "PATCHED")],
        ..Default::default()
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();

    let pkg = OpcPackage::read(&saved).unwrap();
    let xml = std::str::from_utf8(pkg.part("word/document.xml").unwrap()).unwrap();
    assert!(
        xml.contains(">INNER<"),
        "the NESTED table's content must be untouched:\n{xml}"
    );
    assert!(
        xml.contains(">PATCHED<"),
        "the outer row-1 cell was edited:\n{xml}"
    );
    assert!(
        xml.contains(">outer r0<"),
        "the other outer row is untouched"
    );
}

#[test]
fn non_patchable_target_is_skipped_not_errored() {
    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    // Out-of-range block/run resolves to nothing → skipped, document unchanged.
    let edits = EditSet {
        structural: vec![],
        cells: vec![],
        paragraphs: vec![],
        runs: vec![RunEdit::text(99, 0, "nowhere")],
    };
    let (saved, _skips) = session.save_edited(&edits).unwrap();
    let saved_pkg = OpcPackage::read(&saved).unwrap();
    let doc_xml = std::str::from_utf8(saved_pkg.part("word/document.xml").unwrap()).unwrap();
    assert!(doc_xml.contains(">Plain body text.<"), "unchanged");
    assert!(!doc_xml.contains("nowhere"));
}

/// The cell patcher: a native table's cells read back (the engine's cell
/// `text`) next to the story, as the bundle forwards them, patch their edits
/// into the cells' `<w:t>`s; the runs, their properties and the merge field
/// stay. A paragraph added in a cell is added to the Word cell. The body reads back as the engine holds it: a paragraph's runs
/// of one style joined into one.
#[test]
#[allow(non_snake_case)] // `…__feat__<id>` links the cockpit feature
fn canvas_edits_in_table_cells_are_saved_back__feat__plugin_doc_object_model() {
    use docx_conformance::cell_fields_docx;
    use docx_export::{CellContentIn, ParagraphContentIn, RunContentIn, StoryContentIn};
    use docx_lower::ir::{LoweredBlock, LoweredDoc};

    let source = cell_fields_docx();
    let session = DocSession::load(&source).unwrap();
    let base = session.lowered();
    // The body as the engine reads it back: one run per paragraph (no run
    // carries a character style here).
    let story = StoryContentIn {
        self_id: "s".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: vec![RunContentIn {
                        text: p.runs.iter().map(|r| r.text.as_str()).collect(),
                        character_style: None,
                        ..Default::default()
                    }],
                }),
                LoweredBlock::Table(_) => None,
            })
            .collect(),
    };
    let cell = |cell: usize, text: &str| CellContentIn {
        block: 1,
        cell,
        text: text.into(),
        ..Default::default()
    };
    let cells_of = |d: &LoweredDoc| -> Vec<String> {
        let LoweredBlock::Table(t) = &d.story.blocks[1] else {
            panic!("block 1 is the table")
        };
        t.cells
            .iter()
            .map(|c| {
                c.paragraphs
                    .iter()
                    .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect()
    };
    let before = cells_of(&base);

    // Read back unchanged: the package is byte-identical.
    let same: Vec<CellContentIn> = before.iter().enumerate().map(|(k, t)| cell(k, t)).collect();
    let (saved, skips) = session
        .save_edited_from_content_and_cells(&story, &same)
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let doc_xml = |bytes: &[u8]| {
        let pkg = OpcPackage::read(bytes).unwrap();
        String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap()
    };
    assert_eq!(doc_xml(&saved), doc_xml(&source));

    // Typed on the canvas: before the bold "les", in a cell's second
    // paragraph, before a merge field; and a paragraph added in a cell.
    let edited = vec![
        cell(0, "Item\nSecond"),
        cell(2, "Green Apples"),
        cell(4, "Line one\nLine 2"),
        cell(5, "Für «Name»"),
    ];
    let (saved, skips) = session
        .save_edited_from_content_and_cells(&story, &edited)
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let after = DocSession::load(&saved).unwrap().lowered();
    let mut want = before.clone();
    want[0] = "Item\nSecond".into();
    want[2] = "Green Apples".into();
    want[4] = "Line one\nLine 2".into();
    want[5] = "Für «Name»".into();
    assert_eq!(cells_of(&after), want);
    let xml = doc_xml(&saved);
    // The bold run and the merge field are still there.
    assert!(xml.contains("<w:b/></w:rPr><w:t>les</w:t>"), "{xml}");
    assert_eq!(xml.matches("MERGEFIELD Name").count(), 2, "{xml}");
}

/// Structural cell save-back: paragraphs added on the canvas become new
/// `<w:p>`s cloned from their neighbour (its `<w:pPr>`, and the `<w:rPr>` of
/// the run they continue), removed ones are dropped — never the cell's last
/// `<w:p>`, which takes the last text instead — and text typed into a Word
/// paragraph without a run gets a run. Everything else stays byte-identical.
#[test]
#[allow(non_snake_case)] // `…__feat__<id>` links the cockpit feature
fn paragraphs_added_and_removed_in_cells_are_saved_back__feat__plugin_doc_object_model() {
    use docx_conformance::cell_paragraphs_docx;
    use docx_export::{CellContentIn, ParagraphContentIn, RunContentIn, StoryContentIn};
    use docx_lower::ir::LoweredBlock;

    let source = cell_paragraphs_docx();
    let session = DocSession::load(&source).unwrap();
    let base = session.lowered();
    let story = StoryContentIn {
        self_id: "s".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: vec![RunContentIn {
                        text: p.runs.iter().map(|r| r.text.as_str()).collect(),
                        character_style: None,
                        ..Default::default()
                    }],
                }),
                LoweredBlock::Table(_) => None,
            })
            .collect(),
    };
    let cell = |cell: usize, text: &str| CellContentIn {
        block: 1,
        cell,
        text: text.into(),
        ..Default::default()
    };
    let doc_xml = |bytes: &[u8]| {
        let pkg = OpcPackage::read(bytes).unwrap();
        String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap()
    };
    let src_xml = doc_xml(&source);
    let save = |cells: &[CellContentIn]| {
        let (saved, skips) = session
            .save_edited_from_content_and_cells(&story, cells)
            .unwrap();
        assert!(skips.is_empty(), "{skips:?}");
        (doc_xml(&saved), saved)
    };
    let cells_after = |saved: &[u8]| -> Vec<String> {
        let d = DocSession::load(saved).unwrap().lowered();
        let LoweredBlock::Table(t) = &d.story.blocks[1] else {
            panic!("block 1 is the table")
        };
        t.cells
            .iter()
            .map(|c| {
                c.paragraphs
                    .iter()
                    .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect()
    };

    // A paragraph added after the bold run's paragraph continues it: the
    // right-aligned `<w:pPr>` and the bold `<w:rPr>`; one added in the
    // middle is a copy of "One"'s (its italic run). The cells around stay.
    let (xml, saved) = save(&[cell(0, "One\nOne and a half\nTwo\nThree bold\nFour")]);
    assert_eq!(
        cells_after(&saved)[0],
        "One\nOne and a half\nTwo\nThree bold\nFour"
    );
    assert!(
        xml.contains(r#"<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Four</w:t></w:r></w:p>"#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">One and a half</w:t></w:r></w:p>"#),
        "{xml}"
    );
    // Only the two new paragraphs were added.
    let added = r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">One and a half</w:t></w:r></w:p>"#;
    let four = r#"<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Four</w:t></w:r></w:p>"#;
    assert_eq!(xml.replace(added, "").replace(four, ""), src_xml);

    // A paragraph added before the first continues the first run.
    let (_, saved) = save(&[cell(0, "Zero\nOne\nTwo\nThree bold")]);
    assert_eq!(cells_after(&saved)[0], "Zero\nOne\nTwo\nThree bold");

    // A middle paragraph removed: exactly its `<w:p>` goes.
    let (xml, saved) = save(&[cell(0, "One\nThree bold")]);
    assert_eq!(cells_after(&saved)[0], "One\nThree bold");
    assert_eq!(
        xml,
        src_xml.replace(
            r#"<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Two</w:t></w:r></w:p>"#,
            ""
        )
    );

    // The last paragraph removed: the cell keeps its last `<w:p>`, which
    // takes the last text read back; the paragraph that held it goes.
    let (xml, saved) = save(&[cell(0, "One\nTwo")]);
    assert_eq!(cells_after(&saved)[0], "One\nTwo");
    assert!(xml.contains(r#"<w:jc w:val="right"/>"#), "{xml}");
    assert!(xml.contains("</w:p></w:tc>"), "{xml}");

    // Two empty-ish cells: text typed into the empty `<w:p/>` and into the
    // run-less paragraph gets a run; a paragraph added after `<w:p/>`.
    let (xml, saved) = save(&[cell(1, "Top\nBelow\nMore"), cell(2, "Typed")]);
    assert_eq!(cells_after(&saved)[1..], ["Top\nBelow\nMore", "Typed"]);
    assert!(
        xml.contains(r#"<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:t xml:space="preserve">Typed</w:t></w:r></w:p>"#),
        "{xml}"
    );

    // Read back unchanged: byte-identical.
    let (xml, _) = save(&[
        cell(0, "One\nTwo\nThree bold"),
        cell(1, "Top\n"),
        cell(2, ""),
    ]);
    assert_eq!(xml, src_xml);
}

/// Formatting made on the canvas is saved back: a word made bold inside a
/// body run splits that run into three `<w:r>`s (the outer two keep the
/// run's `<w:rPr>` bytes, the bold one gets `<w:b/>` added), a run made
/// italic as a whole has `<w:i/>` added to its own `<w:rPr>`, and in a
/// table cell read with its styled paragraphs a split and an un-bolded run
/// are written the same way. Untouched runs and parts stay byte-identical.
#[test]
#[allow(non_snake_case)] // `…__feat__<id>` links the cockpit feature
fn canvas_formatting_in_runs_is_saved_back__feat__plugin_doc_object_model() {
    use docx_conformance::cell_fields_docx;
    use docx_export::{CellContentIn, ParagraphContentIn, RunContentIn, StoryContentIn};
    use docx_lower::ir::LoweredBlock;

    let run = |text: &str, style: Option<&String>| RunContentIn {
        text: text.into(),
        character_style: style.cloned(),
        ..Default::default()
    };
    let doc_xml = |bytes: &[u8]| {
        let pkg = OpcPackage::read(bytes).unwrap();
        String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap()
    };

    // The body: "Plain body text." with "body" made bold, and the bold red
    // run made italic too.
    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut paragraphs: Vec<ParagraphContentIn> = base
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                paragraph_style: p.para_style_id.clone(),
                runs: p
                    .runs
                    .iter()
                    .map(|r| run(&r.text, r.char_style_id.as_ref()))
                    .collect(),
            }),
            LoweredBlock::Table(_) => None,
        })
        .collect();
    let plain_style = paragraphs[0].runs[0].character_style.clone();
    paragraphs[0].runs = vec![
        run("Plain ", plain_style.as_ref()),
        RunContentIn {
            font_style: Some("Bold".into()),
            ..run("body", plain_style.as_ref())
        },
        run(" text.", plain_style.as_ref()),
    ];
    paragraphs[2].runs[1].font_style = Some("Bold Italic".into());
    let content = StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs,
    };
    let (saved, skips) = session.save_edited_from_content(&content).unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    assert!(
        xml.contains(
            r#"<w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">body</w:t></w:r><w:r><w:t xml:space="preserve"> text.</w:t></w:r>"#
        ),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:rPr><w:b/><w:i/><w:color w:val="FF0000"/></w:rPr>"#),
        "{xml}"
    );
    // The heading and the runs around the italic one are untouched.
    assert!(
        xml.contains("<w:r><w:t>A Centered Heading</w:t></w:r>"),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:r><w:t xml:space="preserve">Mix of normal and </w:t></w:r>"#),
        "{xml}"
    );
    let re = import_docx(&saved).unwrap();
    let p0 = body_para(&re, 0);
    let bolds: Vec<Option<bool>> = p0.runs.iter().map(|r| r.props.bold).collect();
    assert_eq!(bolds, [None, Some(true), None]);
    assert_eq!(body_para(&re, 2).runs[1].props.italic, Some(true));
    let (orig_pkg, saved_pkg) = (
        OpcPackage::read(&original).unwrap(),
        OpcPackage::read(&saved).unwrap(),
    );
    for name in orig_pkg.file_names() {
        if name != "word/document.xml" {
            assert_eq!(orig_pkg.part(name), saved_pkg.part(name), "part {name}");
        }
    }

    // A table cell: "1.20" with "20" made bold; "Apples" with its bold
    // "les" made regular.
    let source = cell_fields_docx();
    let session = DocSession::load(&source).unwrap();
    let base = session.lowered();
    let story = StoryContentIn {
        self_id: "s".into(),
        paragraphs: base
            .story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: vec![run(
                        &p.runs.iter().map(|r| r.text.as_str()).collect::<String>(),
                        None,
                    )],
                }),
                LoweredBlock::Table(_) => None,
            })
            .collect(),
    };
    let LoweredBlock::Table(t) = &base.story.blocks[1] else {
        panic!("block 1 is the table")
    };
    let token = |cell: usize, r: usize| t.cells[cell].paragraphs[0].runs[r].char_style_id.clone();
    let styled = |cell: usize, runs: Vec<RunContentIn>| CellContentIn {
        block: 1,
        cell,
        text: runs.iter().map(|r| r.text.as_str()).collect(),
        paragraphs: Some(vec![ParagraphContentIn {
            paragraph_style: None,
            runs,
        }]),
    };
    let cells = vec![
        styled(
            3,
            vec![
                run("1.", token(3, 0).as_ref()),
                RunContentIn {
                    font_style: Some("Bold".into()),
                    ..run("20", token(3, 0).as_ref())
                },
            ],
        ),
        styled(
            2,
            vec![
                run("App", token(2, 0).as_ref()),
                RunContentIn {
                    font_style: Some("Regular".into()),
                    ..run("les", token(2, 1).as_ref())
                },
            ],
        ),
    ];
    let (saved, skips) = session
        .save_edited_from_content_and_cells(&story, &cells)
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    assert!(
        xml.contains(
            r#"<w:tc><w:p><w:r><w:t xml:space="preserve">1.</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">20</w:t></w:r></w:p></w:tc>"#
        ),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:r><w:t>App</w:t></w:r><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>les</w:t></w:r>"#),
        "{xml}"
    );
    // The bookmark, the merge field and the other cells stay.
    assert!(xml.contains(r#"<w:bookmarkStart w:id="0" w:name="first-item"/>"#));
    assert_eq!(xml.matches("MERGEFIELD Name").count(), 2, "{xml}");
    assert!(xml.contains("<w:tc><w:p><w:r><w:t>Line one</w:t></w:r></w:p><w:p><w:r><w:t>Line two</w:t></w:r></w:p></w:tc>"));
}

/// Tracking and a colour made on the canvas are saved back: a run given
/// tracking gets Word's character spacing at its size (`w:spacing`, which
/// imports back to the same tracking), and a run filled with a swatch the
/// import did not make gets its `w:color` from the colour the host reports
/// for it. A paragraph added in a table cell keeps the words' own looks.
#[test]
#[allow(non_snake_case)] // `…__feat__<id>` links the cockpit feature
fn tracking_canvas_colours_and_added_cell_paragraph_looks_are_saved_back__feat__plugin_doc_object_model(
) {
    use docx_conformance::cell_paragraphs_docx;
    use docx_export::{CellContentIn, ParagraphContentIn, RunContentIn, StoryContentIn};
    use docx_lower::ir::{LoweredBlock, PropValue};

    let doc_xml = |bytes: &[u8]| {
        let pkg = OpcPackage::read(bytes).unwrap();
        String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap()
    };
    let identity = |base: &docx_lower::ir::LoweredDoc| -> Vec<ParagraphContentIn> {
        base.story
            .blocks
            .iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(ParagraphContentIn {
                    paragraph_style: p.para_style_id.clone(),
                    runs: p
                        .runs
                        .iter()
                        .map(|r| RunContentIn {
                            text: r.text.clone(),
                            character_style: r.char_style_id.clone(),
                            ..Default::default()
                        })
                        .collect(),
                }),
                LoweredBlock::Table(_) => None,
            })
            .collect()
    };

    let original = memo_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut paragraphs = identity(&base);
    // "Plain body text." tracked +100; " text." filled with a canvas swatch.
    paragraphs[0].runs[0].tracking = Some(100.0);
    paragraphs[2].runs[2].fill_color = Some("Color/Canvas green".into());
    let content = StoryContentIn {
        self_id: "Story/doc".into(),
        paragraphs,
    };
    let colors = [("Color/Canvas green".to_string(), "#12ab34".to_string())].into();
    let (saved, skips) = session
        .save_edited_from_content_cells_and_tables(&content, &[], &[], &colors)
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    // memo's text is Word's default 10 pt: 100/1000 em = 1 pt = 20 twips.
    assert!(
        xml.contains(r#"<w:r><w:rPr><w:spacing w:val="20"/></w:rPr><w:t xml:space="preserve">Plain body text.</w:t></w:r>"#),
        "{xml}"
    );
    assert!(
        xml.contains(r#"<w:r><w:rPr><w:color w:val="12AB34"/></w:rPr><w:t xml:space="preserve"> text.</w:t></w:r>"#),
        "{xml}"
    );
    // The spacing imports back as the same tracking.
    let re = DocSession::load(&saved).unwrap().lowered();
    let LoweredBlock::Paragraph(p0) = &re.story.blocks[0] else {
        panic!("block 0 is a paragraph")
    };
    let token = p0.runs[0].char_style_id.clone().expect("a run style");
    let tracking = re.styles.iter().find(|s| s.id == token).and_then(|s| {
        s.props.iter().find_map(|p| match (&*p.path, &p.value) {
            ("characterTracking", PropValue::Length(t)) => Some(*t),
            _ => None,
        })
    });
    assert_eq!(tracking, Some(100.0));
    // A swatch the host has no colour for is not written (and nothing else).
    let mut paragraphs = identity(&base);
    paragraphs[2].runs[2].fill_color = Some("Color/Unknown".into());
    let (saved, _) = session
        .save_edited_from_content(&StoryContentIn {
            self_id: "Story/doc".into(),
            paragraphs,
        })
        .unwrap();
    assert_eq!(doc_xml(&saved), doc_xml(&original));

    // A cell: a paragraph added after "Three bold" holds a plain word and a
    // bold one, read with the cell's styled paragraphs. The copy takes the
    // bold run's `<w:rPr>`; the plain word loses its `<w:b/>`.
    let source = cell_paragraphs_docx();
    let session = DocSession::load(&source).unwrap();
    let base = session.lowered();
    let LoweredBlock::Table(t) = &base.story.blocks[1] else {
        panic!("block 1 is the table")
    };
    let read = |p: &docx_lower::ir::LoweredParagraph| ParagraphContentIn {
        paragraph_style: p.para_style_id.clone(),
        runs: p
            .runs
            .iter()
            .map(|r| RunContentIn {
                text: r.text.clone(),
                character_style: r.char_style_id.clone(),
                ..Default::default()
            })
            .collect(),
    };
    let mut paras: Vec<ParagraphContentIn> = t.cells[0].paragraphs.iter().map(read).collect();
    let bold_style = paras[2].runs[1].character_style.clone();
    let plain_style = paras[1].runs[0].character_style.clone();
    paras.push(ParagraphContentIn {
        paragraph_style: paras[2].paragraph_style.clone(),
        runs: vec![
            RunContentIn {
                text: "Four ".into(),
                character_style: plain_style,
                ..Default::default()
            },
            RunContentIn {
                text: "strong".into(),
                character_style: bold_style,
                ..Default::default()
            },
        ],
    });
    let cell = CellContentIn {
        block: 1,
        cell: 0,
        text: "One\nTwo\nThree bold\nFour strong".into(),
        paragraphs: Some(paras),
    };
    let (saved, skips) = session
        .save_edited_from_content_and_cells(
            &StoryContentIn {
                self_id: "s".into(),
                paragraphs: identity(&base),
            },
            &[cell],
        )
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    let added = r#"<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">Four </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">strong</w:t></w:r></w:p>"#;
    assert!(xml.contains(added), "{xml}");
    assert_eq!(xml.replace(added, ""), doc_xml(&source));
}

/// Rows added or removed on the canvas are saved back: the live rows are
/// aligned with Word's by their text, a row added above the first gets a new
/// `<w:tr>` before it, a removed row's `<w:tr>` goes, and a kept row's
/// edited cell is patched in place (its unmodelled `w:trHeight` stays). A
/// table whose columns changed is reported and left as it was.
#[test]
#[allow(non_snake_case)] // `…__feat__<id>` links the cockpit feature
fn rows_added_and_removed_on_the_canvas_are_saved_back__feat__plugin_doc_object_model() {
    use docx_conformance::simple_table_docx;
    use docx_export::{StoryContentIn, TableContentIn};

    let source = simple_table_docx();
    let session = DocSession::load(&source).unwrap();
    let doc_xml = |bytes: &[u8]| {
        let pkg = OpcPackage::read(bytes).unwrap();
        String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap()
    };
    let story = StoryContentIn {
        self_id: "s".into(),
        paragraphs: vec![],
    };
    let row = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
    let save = |rows: Vec<Vec<String>>| {
        session
            .save_edited_from_content_cells_and_tables(
                &story,
                &[],
                &[TableContentIn { block: 0, rows }],
                &Default::default(),
            )
            .unwrap()
    };

    // A row above the first, and the last row's first cell edited.
    let (saved, skips) = save(vec![
        row("Head", "er"),
        row("R0C0", "R0C1"),
        row("R1C0", "R1C1"),
        row("R2C0 edited", "R2C1"),
    ]);
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    let src = doc_xml(&source);
    let added = r#"<w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">Head</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">er</w:t></w:r></w:p></w:tc></w:tr>"#;
    assert!(
        xml.contains(&format!(
            r#"</w:tblGrid>{added}<w:tr><w:trPr><w:trHeight w:val="100"/>"#
        )),
        "{xml}"
    );
    assert_eq!(
        xml.replace(added, "").replace(
            r#"<w:t xml:space="preserve">R2C0 edited</w:t>"#,
            "<w:t>R2C0</w:t>"
        ),
        src
    );

    // The middle row removed: exactly its `<w:tr>` goes.
    let (saved, skips) = save(vec![row("R0C0", "R0C1"), row("R2C0", "R2C1")]);
    assert!(skips.is_empty(), "{skips:?}");
    let xml = doc_xml(&saved);
    assert!(!xml.contains("R1C0"), "{xml}");
    assert!(xml.contains(r#"<w:trHeight w:val="102"/>"#), "{xml}");
    assert!(!xml.contains(r#"<w:trHeight w:val="101"/>"#), "{xml}");

    // A column added: reported, the table as it was.
    let (saved, skips) = save(vec![vec!["a".into(), "b".into(), "c".into()]]);
    assert_eq!(skips.len(), 1, "{skips:?}");
    assert!(skips[0].contains("columns"), "{skips:?}");
    assert_eq!(doc_xml(&saved), src);
}

/// A cell emptied on the canvas can read back with no paragraph at all
/// (its styled read is `[]`): the text read, one empty paragraph, is
/// followed and the cell's run removed, not left as it was.
#[test]
fn a_cell_emptied_with_no_styled_paragraph_is_saved_back() {
    use docx_conformance::cell_fields_docx;
    use docx_export::{CellContentIn, StoryContentIn};

    let source = cell_fields_docx();
    let session = DocSession::load(&source).unwrap();
    let (saved, skips) = session
        .save_edited_from_content_and_cells(
            &StoryContentIn {
                self_id: "s".into(),
                paragraphs: vec![],
            },
            &[CellContentIn {
                block: 1,
                cell: 3,
                text: String::new(),
                paragraphs: Some(vec![]),
            }],
        )
        .unwrap();
    assert!(skips.is_empty(), "{skips:?}");
    let pkg = OpcPackage::read(&saved).unwrap();
    let xml = String::from_utf8(pkg.part("word/document.xml").unwrap().to_vec()).unwrap();
    assert!(!xml.contains("1.20"), "{xml}");
}
