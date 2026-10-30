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

//! Wave W4a (doc ADR 614) on its conformance documents: floats placed as
//! page items or anchored objects, text boxes read, placed and saved back,
//! a nested table shown and kept, the table look lowered, and `w:lang`
//! lowered to the applied language. Where Word's answer is committed
//! (`fixtures/objects-*.word.json`, `scripts/word-objects-probe.sh`) the
//! planned geometry is held against it.

#![allow(non_snake_case)] // `…__feat__<id>` test names link the cockpit feature

use docx_conformance::{
    float_cases, objects_floats_docx, objects_languages_docx, objects_nested_tables_docx,
    objects_table_look_docx, objects_text_boxes_docx, FLOAT_SIZE_PT, TEXT_BOX_LINES,
};
use docx_core::{Block, HeightRule};
use docx_export::structure::StructureIn;
use docx_export::textbox::TextBoxIn;
use docx_export::{ParagraphContentIn, RunContentIn, StoryContentIn, TableParagraphs};
use docx_import::import_docx;
use docx_js::DocSession;
use docx_lower::ir::{
    LoweredBlock, LoweredDoc, LoweredItemHost, LoweredItemKind, LoweredPageItem, LoweredParagraph,
    PropValue,
};
use paged_ooxml::OpcPackage;

fn lowered(bytes: &[u8]) -> LoweredDoc {
    docx_lower::lower(&import_docx(bytes).unwrap())
}

fn part(bytes: &[u8], name: &str) -> String {
    String::from_utf8_lossy(OpcPackage::read(bytes).unwrap().part(name).unwrap()).into_owned()
}

fn word(name: &str) -> Option<serde_json::Value> {
    let path = format!("{}/fixtures/{name}.word.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(path)
        .ok()
        .map(|s| serde_json::from_str(&s).unwrap())
}

fn paragraphs(ir: &LoweredDoc) -> Vec<&LoweredParagraph> {
    ir.story.paragraphs()
}

// ---------------------------------------------------------------------------
// Floats

#[test]
fn floats_on_a_known_page_are_page_items_with_words_wrap__feat__plugin_doc_read_path() {
    let ir = lowered(&objects_floats_docx());
    // FA and FB stand in their section's first paragraph: page items on
    // their section's page.
    let items: Vec<&LoweredPageItem> = ir.page_items.iter().collect();
    assert_eq!(items.len(), 2, "{items:#?}");
    let (w, h) = FLOAT_SIZE_PT;
    assert_eq!(
        items[0].host,
        LoweredItemHost::Page {
            page_id: "docx_p0".into()
        }
    );
    assert_eq!(items[0].bounds, [144.0, 288.0, 144.0 + h, 288.0 + w]);
    assert_eq!(items[0].wrap.as_ref().unwrap().mode, "BoundingBoxTextWrap");
    assert_eq!(
        items[1].host,
        LoweredItemHost::Page {
            page_id: "docx_p1".into()
        }
    );
    // Right-aligned on the margin, 36 pt below the margin's top.
    assert_eq!(items[1].bounds, [108.0, 540.0 - w, 108.0 + h, 540.0]);
    let wrap = items[1].wrap.as_ref().unwrap();
    assert_eq!(wrap.mode, "ContourTextWrap");
    assert_eq!(wrap.polygon_pt.len(), 5);
    // Not in the text as well.
    let p = paragraphs(&ir);
    assert!(p[0].images.is_empty() && p[6].images.is_empty());
}

#[test]
fn floats_elsewhere_are_anchored_objects_by_wrap__feat__plugin_doc_read_path() {
    let ir = lowered(&objects_floats_docx());
    let p = paragraphs(&ir);
    let cases = float_cases();
    let anchor = |case: usize| {
        let (_, at, ..) = cases[case];
        p[case * 6 + at].images[0].anchor.clone().expect("anchored")
    };
    // FC top and bottom: a band above its line, centred.
    let fc = anchor(2);
    assert_eq!(
        (fc.position.as_str(), fc.horizontal_alignment.as_str()),
        ("AbovePosition", "CenterAlign")
    );
    // FD square: custom, the column's left at the paragraph's top.
    let fd = anchor(3);
    assert_eq!(
        (
            fd.position.as_str(),
            fd.horizontal_reference.as_str(),
            fd.vertical_reference.as_str(),
            fd.anchor_point.as_str()
        ),
        ("Anchored", "ColumnEdge", "TopOfLeading", "TopLeftAnchor")
    );
    // FE behind the text: custom against the page.
    let fe = anchor(4);
    assert_eq!(
        (
            fe.horizontal_reference.as_str(),
            fe.x_offset_pt,
            fe.vertical_reference.as_str(),
            fe.y_offset_pt
        ),
        ("PageEdge", 144.0, "PageEdge", 360.0)
    );
    // FF page-relative top and bottom: a band of its own too.
    assert_eq!(anchor(5).position, "AbovePosition");
}

/// Word's picture boxes, per page (`objects-floats.word.json`).
#[test]
fn page_item_floats_stand_where_word_draws_them__feat__plugin_doc_read_path() {
    let Some(answer) = word("objects-floats") else {
        return;
    };
    let ir = lowered(&objects_floats_docx());
    let pages = answer["pages"].as_array().unwrap();
    for item in &ir.page_items {
        let LoweredItemHost::Page { page_id } = &item.host else {
            continue;
        };
        let k: usize = page_id.trim_start_matches("docx_p").parse().unwrap();
        let images = pages[k]["images"].as_array().unwrap();
        let found = images.iter().any(|i| {
            let f = |n: &str| i[n].as_f64().unwrap() as f32;
            (f("top") - item.bounds[0]).abs() < 1.5
                && (f("left") - item.bounds[1]).abs() < 1.5
                && (f("width") - (item.bounds[3] - item.bounds[1])).abs() < 1.5
        });
        assert!(found, "{} at {:?}, Word: {images:?}", item.id, item.bounds);
    }
}

// ---------------------------------------------------------------------------
// Text boxes

#[test]
fn text_boxes_are_read_once_with_their_ordinals__feat__plugin_doc_read_path() {
    let doc = import_docx(&objects_text_boxes_docx()).unwrap();
    let boxes: Vec<(u32, bool, String)> = doc
        .body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            Block::Table(_) => None,
        })
        .flat_map(|p| p.runs.iter())
        .flat_map(|r| r.text_boxes.iter())
        .map(|t| {
            (
                t.ordinal,
                t.vml,
                t.paragraphs[0]
                    .runs
                    .iter()
                    .map(|r| r.text.as_str())
                    .collect(),
            )
        })
        .collect();
    // The DrawingML choice is read, its VML fallback is not; the legacy box
    // is VML. Ordinals count the boxes the import reads.
    assert_eq!(
        boxes,
        vec![
            (0, false, TEXT_BOX_LINES[0].to_string()),
            (1, false, TEXT_BOX_LINES[1].to_string()),
            (2, true, TEXT_BOX_LINES[3].to_string()),
        ]
    );
    let first = &doc.body.iter().find_map(|b| match b {
        Block::Paragraph(p) => Some(p),
        _ => None,
    });
    let tb = &first.unwrap().runs[0].text_boxes[0];
    assert!(tb.look.is_some(), "the box's fill and outline");
    assert_eq!(tb.insets_emu, [45720, 91440, 45720, 91440]);
    let header = &doc.headers_footers[0].paragraphs[0].runs[0].text_boxes[0];
    assert_eq!(header.ordinal, 0);
    assert_eq!(doc.unplaced_vml, 0);
}

#[test]
fn text_boxes_with_a_known_page_are_text_frames__feat__plugin_doc_read_path() {
    let ir = lowered(&objects_text_boxes_docx());
    let boxes: Vec<(&LoweredItemHost, String, &[f32; 4])> = ir
        .page_items
        .iter()
        .filter_map(|i| match &i.item {
            LoweredItemKind::TextBox { paragraphs, .. } => Some((
                &i.host,
                paragraphs[0].runs.iter().map(|r| r.text.as_str()).collect(),
                &i.bounds,
            )),
            LoweredItemKind::Picture { .. } => None,
        })
        .collect();
    assert_eq!(boxes.len(), 3, "{boxes:#?}");
    assert_eq!(boxes[0].1, TEXT_BOX_LINES[0]);
    assert_eq!(*boxes[0].2, [108.0, 324.0, 180.0, 504.0]);
    assert_eq!(boxes[1].1, TEXT_BOX_LINES[3]);
    assert_eq!(
        boxes[1].0,
        &LoweredItemHost::Page {
            page_id: "docx_p1".into()
        }
    );
    assert!(matches!(boxes[2].0, LoweredItemHost::Master { .. }));
    assert_eq!(boxes[2].1, TEXT_BOX_LINES[2]);
    // The JSON the bundle reads names the story and the page in camelCase.
    let json = serde_json::to_value(&ir.page_items[0]).unwrap();
    assert_eq!(json["item"]["storyId"], "docx_o0_s");
    assert_eq!(json["host"]["pageId"], "docx_p0");
    assert!((json["item"]["insetsPt"][1].as_f64().unwrap() - 7.2).abs() < 1e-4);
    let fx = ir.page_items[0].fx.as_ref().expect("the box's look");
    assert_eq!(fx.fill.as_deref(), Some("#FFFFFF"));
    assert!(fx.stroke.is_some());
    // The paragraph-relative box mid-page has no page: said, not dropped.
    assert!(ir
        .diagnostics
        .iter()
        .any(|d| d.message.starts_with("1 text box(es) are NOT shown")));
}

/// Word draws the boxes' text where the page items stand.
#[test]
fn text_boxes_stand_where_word_draws_them__feat__plugin_doc_read_path() {
    let Some(answer) = word("objects-text-boxes") else {
        return;
    };
    let ir = lowered(&objects_text_boxes_docx());
    let pages = answer["pages"].as_array().unwrap();
    for item in &ir.page_items {
        let LoweredItemKind::TextBox { paragraphs, .. } = &item.item else {
            continue;
        };
        let first: String = paragraphs[0].runs.iter().map(|r| r.text.as_str()).collect();
        let page = match &item.host {
            LoweredItemHost::Page { page_id } => page_id
                .trim_start_matches("docx_p")
                .parse::<usize>()
                .unwrap(),
            LoweredItemHost::Master { .. } => 0,
        };
        let line = pages[page]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["text"].as_str().unwrap().contains(first.as_str()))
            .unwrap_or_else(|| panic!("Word shows {first:?} on page {page}"));
        let (top, left) = (
            line["top"].as_f64().unwrap() as f32,
            line["left"].as_f64().unwrap() as f32,
        );
        // Inside the box, past its insets.
        assert!(
            top >= item.bounds[0] && top < item.bounds[0] + 20.0,
            "{first}: {top} vs {:?}",
            item.bounds
        );
        assert!(
            (left - (item.bounds[1] + 7.2)).abs() < 2.0,
            "{first}: {left} vs {:?}",
            item.bounds
        );
    }
}

fn content(paragraphs: &[LoweredParagraph], id: &str) -> StoryContentIn {
    StoryContentIn {
        self_id: id.into(),
        paragraphs: paragraphs
            .iter()
            .map(|p| ParagraphContentIn {
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
                mark_change: None,
                props_change: None,
            })
            .collect(),
        comments: Vec::new(),
    }
}

fn body(base: &LoweredDoc) -> StoryContentIn {
    let ps: Vec<LoweredParagraph> = base
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p.clone()),
            LoweredBlock::Table(_) => None,
        })
        .collect();
    content(&ps, "docx_s0")
}

fn boxes_read(base: &LoweredDoc) -> Vec<TextBoxIn> {
    base.page_items
        .iter()
        .filter_map(|i| match &i.item {
            LoweredItemKind::TextBox {
                story_id,
                paragraphs,
                ..
            } => Some(TextBoxIn {
                item: i.id.clone(),
                content: content(paragraphs, story_id),
            }),
            LoweredItemKind::Picture { .. } => None,
        })
        .collect()
}

fn save(session: &DocSession, base: &LoweredDoc, boxes: Vec<TextBoxIn>) -> (Vec<u8>, Vec<String>) {
    session
        .save_edited_structure(
            &body(base),
            &[],
            &[],
            &Default::default(),
            &[],
            TableParagraphs::Joined,
            &StructureIn {
                text_boxes: boxes,
                ..Default::default()
            },
        )
        .unwrap()
}

fn identical_except(original: &[u8], saved: &[u8], changed: &[&str]) {
    let a = OpcPackage::read(original).unwrap();
    let b = OpcPackage::read(saved).unwrap();
    for name in a.file_names() {
        if !changed.contains(&name) {
            assert_eq!(a.part(name), b.part(name), "{name} changed");
        }
    }
}

#[test]
fn an_unedited_text_box_saves_byte_identical__feat__plugin_doc_save_back() {
    for (name, original) in [
        ("objects-text-boxes", objects_text_boxes_docx()),
        ("objects-floats", objects_floats_docx()),
        ("objects-nested-tables", objects_nested_tables_docx()),
        ("objects-table-look", objects_table_look_docx()),
        ("objects-languages", objects_languages_docx()),
    ] {
        let session = DocSession::load(&original).unwrap();
        let base = session.lowered();
        let (saved, skips) = save(&session, &base, boxes_read(&base));
        assert!(skips.is_empty(), "{skips:?}");
        identical_except(&original, &saved, &[]);
        if let Ok(dir) = std::env::var("DOC_SAVE_OUT") {
            std::fs::write(format!("{dir}/{name}.saved.docx"), &saved).unwrap();
        }
    }
}

#[test]
fn a_text_box_edit_is_spliced_into_the_box_and_its_fallback__feat__plugin_doc_save_back() {
    let original = objects_text_boxes_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut boxes = boxes_read(&base);
    boxes[0].content.paragraphs[1].runs[0].text = "TB1 edited & saved".into();
    let (saved, skips) = save(&session, &base, boxes);
    assert!(skips.is_empty(), "{skips:?}");
    identical_except(&original, &saved, &["word/document.xml"]);
    // `DOC_SAVE_OUT=<dir>`: keep the saved file, for Word to open.
    if let Ok(dir) = std::env::var("DOC_SAVE_OUT") {
        std::fs::write(format!("{dir}/objects-text-boxes.edited.docx"), &saved).unwrap();
    }
    let xml = part(&saved, "word/document.xml");
    // Both copies, the DrawingML box and its VML fallback.
    assert_eq!(xml.matches("TB1 edited &amp; saved").count(), 2, "{xml}");
    assert!(!xml.contains("TB1 line two"));
    // Everything outside the boxes is as it was.
    let before = part(&original, "word/document.xml");
    let cut = |s: &str| s.split("<w:txbxContent>").next().unwrap().to_string();
    assert_eq!(cut(&xml), cut(&before));
    // Word's reader takes the edit.
    let doc = import_docx(&saved).unwrap();
    let Block::Paragraph(p) = &doc.body[0] else {
        panic!()
    };
    assert_eq!(
        p.runs[0].text_boxes[0].paragraphs[1].runs[0].text,
        "TB1 edited & saved"
    );
}

#[test]
fn a_header_text_box_edit_lands_in_the_header__feat__plugin_doc_save_back() {
    let original = objects_text_boxes_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut boxes = boxes_read(&base);
    let k = base
        .page_items
        .iter()
        .position(|i| matches!(i.host, LoweredItemHost::Master { .. }))
        .unwrap();
    let at = boxes
        .iter()
        .position(|b| b.item == base.page_items[k].id)
        .unwrap();
    boxes[at].content.paragraphs[0].runs[0].text = "TBH changed".into();
    let (saved, skips) = save(&session, &base, boxes);
    assert!(skips.is_empty(), "{skips:?}");
    identical_except(&original, &saved, &["word/header1.xml"]);
    assert_eq!(
        part(&saved, "word/header1.xml")
            .matches("TBH changed")
            .count(),
        2
    );
}

// ---------------------------------------------------------------------------
// Nested tables

#[test]
fn a_nested_tables_text_is_shown_in_its_cell_and_held__feat__plugin_doc_read_path() {
    let doc = import_docx(&objects_nested_tables_docx()).unwrap();
    let Block::Table(t) = &doc.body[1] else {
        panic!("the outer table")
    };
    let cell = &t.rows[0].cells[1];
    assert_eq!(cell.nested_tables.len(), 1);
    let texts: Vec<String> = cell
        .paragraphs
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect();
    assert_eq!(texts, ["N1", "N11", "N12", "N21", "N22", "N2"]);
    let held: Vec<bool> = cell
        .paragraphs
        .iter()
        .map(|p| p.held.in_content_control)
        .collect();
    assert_eq!(held, [false, true, true, true, true, false]);
    // `N2` is the cell's second `<w:p>`: the patcher's ordinal.
    assert_eq!(cell.paragraphs[5].source_cell.unwrap().para, 1);
    let ir = lowered(&objects_nested_tables_docx());
    let LoweredBlock::Table(lt) = &ir.story.blocks[1] else {
        panic!()
    };
    assert_eq!(lt.cells[1].paragraphs.len(), 6);
    assert!(ir
        .diagnostics
        .iter()
        .any(|d| d.message.starts_with("1 table(s) nested")));
}

#[test]
fn a_cell_edit_beside_a_nested_table_keeps_it__feat__plugin_doc_save_back() {
    let original = objects_nested_tables_docx();
    let session = DocSession::load(&original).unwrap();
    let base = session.lowered();
    let mut edited = base.clone();
    let LoweredBlock::Table(t) = &mut edited.story.blocks[1] else {
        panic!()
    };
    t.cells[1].paragraphs[5].runs[0].text = "N2 edited".into();
    t.cells[1].paragraphs[2].runs[0].text = "N12 edited".into();
    let bindings = docx_export::build_bindings(&import_docx(&original).unwrap());
    let edits = docx_export::diff(&base, &edited, &bindings);
    let (saved, skips) = session.save_edited(&edits).unwrap();
    let xml = part(&saved, "word/document.xml");
    assert!(xml.contains(">N2 edited<"), "{xml}");
    // The nested table's text is not addressed: refused, kept.
    assert!(
        !xml.contains("N12 edited") && xml.contains(">N12<"),
        "{xml}"
    );
    assert!(!skips.is_empty(), "the nested edit is named");
}

// ---------------------------------------------------------------------------
// Table look

#[test]
fn table_borders_shading_and_alignment_are_lowered__feat__plugin_doc_read_path() {
    let ir = lowered(&objects_table_look_docx());
    let tables: Vec<&docx_lower::ir::LoweredTable> = ir
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Table(t) => Some(t),
            _ => None,
        })
        .collect();
    let look = |t: usize, c: usize| tables[t].cells[c].look.clone().unwrap();
    // TA: Table Grid, every edge 0.5 pt black.
    let a = look(0, 0);
    assert_eq!(
        (a.top.weight_pt, a.right.weight_pt, a.top.color.as_str()),
        (0.5, 0.5, "Color/docx-000000")
    );
    // TB: its own top and bottom, inside rows, no sides; the first cell's
    // own left and fill.
    let b0 = look(1, 0);
    assert_eq!(
        (b0.top.weight_pt, b0.top.color.as_str()),
        (1.5, "Color/docx-C00000")
    );
    assert_eq!(
        (b0.bottom.weight_pt, b0.bottom.color.as_str()),
        (0.5, "Color/docx-0070C0")
    );
    assert_eq!(
        (b0.left.weight_pt, b0.left.color.as_str()),
        (0.75, "Color/docx-00B050")
    );
    assert_eq!(b0.right.weight_pt, 0.0);
    assert_eq!(b0.fill.as_deref(), Some("Color/docx-FFFF00"));
    assert_eq!(look(1, 3).bottom.weight_pt, 1.5, "the table's bottom");
    // TC: centred through its paragraph's style.
    let style = tables[2]
        .para_style_id
        .as_deref()
        .expect("a centring style");
    let s = ir.styles.iter().find(|s| s.id == style).unwrap();
    assert!(s
        .props
        .iter()
        .any(|p| p.path == "paragraphJustification"
            && p.value == PropValue::Text("CenterAlign".into())));
    assert!(tables[0].para_style_id.is_none());
    // TD: the indent is carried; TE: exact rows, fixed layout, cantSplit.
    assert_eq!(tables[3].layout.as_ref().unwrap().indent_pt, Some(72.0));
    let te = tables[4].layout.as_ref().unwrap();
    assert!(te.fixed);
    assert_eq!(te.exact_rows, vec![true, true]);
    assert_eq!(te.cant_split, vec![true, true]);
    assert_eq!(te.width_pt, None);
    assert_eq!(tables[2].layout.as_ref().unwrap().width_pt, Some(216.0));
    // TF: `hRule="auto"` ignores the height.
    assert!(
        tables[5].row_heights_pt.is_empty(),
        "{:?}",
        tables[5].row_heights_pt
    );
    let doc = import_docx(&objects_table_look_docx()).unwrap();
    let Block::Table(t) = &doc.body[9] else {
        panic!("TE")
    };
    assert_eq!(t.rows[0].height_rule, HeightRule::Exact);
}

/// Word's cell text positions: the centred table's and the indented one's
/// first cell (`objects-table-look.word.json`).
#[test]
fn table_alignment_is_words__feat__plugin_doc_read_path() {
    let Some(answer) = word("objects-table-look") else {
        return;
    };
    let lines: Vec<&serde_json::Value> = answer["pages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|p| p["lines"].as_array().unwrap())
        .collect();
    let left = |label: &str| {
        lines
            .iter()
            .find(|l| l["text"].as_str().unwrap().starts_with(label))
            .map(|l| l["left"].as_f64().unwrap())
            .unwrap_or_else(|| panic!("{label}"))
    };
    // TC: a 216 pt table centred in 468 pt: its first cell's text at
    // 72 + 126 + 5.4.
    assert!((left("TC r0c0") - 203.4).abs() < 1.5, "{}", left("TC r0c0"));
    // TA: at the margin plus the cell margin.
    assert!((left("TA r0c0") - 77.4).abs() < 1.5, "{}", left("TA r0c0"));
}

// ---------------------------------------------------------------------------
// Language

#[test]
fn w_lang_becomes_the_applied_language__feat__plugin_doc_read_path() {
    let ir = lowered(&objects_languages_docx());
    let lang = |style: &str| {
        ir.styles
            .iter()
            .find(|s| s.id == style)
            .and_then(|s| s.props.iter().find(|p| p.path == "characterLanguage"))
            .map(|p| p.value.clone())
    };
    // The document's default, on the base style.
    assert_eq!(
        lang("ParagraphStyle/docx-Default"),
        Some(PropValue::Text("$ID/English: USA".into()))
    );
    let p = paragraphs(&ir);
    let run_lang = |i: usize, r: usize| lang(p[i].runs[r].char_style_id.as_deref().unwrap());
    assert_eq!(
        run_lang(1, 0),
        Some(PropValue::Text("$ID/de_DE_2006".into()))
    );
    assert_eq!(run_lang(2, 0), Some(PropValue::Text("$ID/French".into())));
    // A German run inside an English paragraph.
    assert_eq!(
        run_lang(3, 1),
        Some(PropValue::Text("$ID/de_DE_2006".into()))
    );
    let doc = import_docx(&objects_languages_docx()).unwrap();
    assert_eq!(
        doc.styles.doc_defaults.run.lang.east_asia.as_deref(),
        Some("en-US")
    );
    assert_eq!(
        doc.styles.doc_defaults.run.lang.bidi.as_deref(),
        Some("ar-SA")
    );
}

#[test]
fn the_applied_language_names_what_the_engine_hyphenates__feat__plugin_doc_read_path() {
    use docx_lower::objects::applied_language;
    for (tag, name) in [
        ("en-US", "$ID/English: USA"),
        ("en-GB", "$ID/English: UK"),
        ("de-AT", "$ID/de_DE_2006"),
        ("de-CH", "$ID/de_CH_2006"),
        ("fr-CA", "$ID/French: Canadian"),
        ("es-MX", "$ID/Spanish: Castilian"),
        ("it-IT", "$ID/Italian"),
        ("nl-BE", "$ID/nl_NL_2005"),
        ("pt-BR", "$ID/Portuguese: Brazilian"),
        ("pl-PL", "$ID/Polish"),
        ("x-none", "$ID/[No Language]"),
    ] {
        assert_eq!(applied_language(tag), name, "{tag}");
    }
}

// ---------------------------------------------------------------------------
// The skeleton

#[test]
fn the_skeleton_writes_the_page_items__feat__plugin_doc_standalone_open() {
    let doc = import_docx(&objects_text_boxes_docx()).unwrap();
    let pages = docx_skeleton::skeleton_pages(&doc);
    let (masters, _) = docx_skeleton::masters_with(&doc, Default::default());
    let mut d = docx_skeleton::native::skeleton_document_with(&pages, &masters, "t");
    let items: Vec<LoweredPageItem> =
        docx_lower::objects::plan_page_items(&doc, Default::default())
            .into_iter()
            .map(|(_, i)| i)
            .collect();
    docx_skeleton::items::add_page_items(&mut d, &items);
    let p0 = &d.spreads[0].spread;
    assert_eq!(p0.text_frames.len(), 2, "the body frame and TB1");
    let tb1 = &p0.text_frames[1];
    assert_eq!(tb1.parent_story.as_deref(), Some("docx_o0_s"));
    assert_eq!(tb1.fill_color.as_deref(), Some("Color/docx-o-FFFFFF"));
    assert!(tb1.text_wrap.is_some());
    assert!(d.stories.iter().any(|s| s.self_id == "docx_o0_s"));
    let master = d.master_spreads.values().next().unwrap();
    assert_eq!(
        master.spread.text_frames.len(),
        2,
        "the header frame and TBH"
    );

    let floats = import_docx(&objects_floats_docx()).unwrap();
    let pages = docx_skeleton::skeleton_pages(&floats);
    let mut d = docx_skeleton::native::skeleton_document(&pages, "f");
    let items: Vec<LoweredPageItem> =
        docx_lower::objects::plan_page_items(&floats, Default::default())
            .into_iter()
            .map(|(_, i)| i)
            .collect();
    docx_skeleton::items::add_page_items(&mut d, &items);
    let r = &d.spreads[0].spread.rectangles[0];
    assert!(r
        .image_link
        .as_deref()
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert!(r.text_wrap.is_some());
}
