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

//! Engine ADR 1055 — the review comments of a document as PDF annotations,
//! the way Acrobat's Comment tool writes them: a Text annotation at a point
//! of the page with its author, date and text; a reply annotation in reply to
//! it (`/IRT`, `/RT /R`); a hidden state annotation for a resolved thread
//! (`/StateModel /Review`, `/State /Completed`).

use lopdf::{Dictionary, Document, Object, ObjectId};
use paged_export_pdf::{
    export_pdf, ExportInkSettings, ExportInput, ExportOptions, ExportProfiles, PdfComment, PdfReply,
};
use paged_renderer::pipeline::{self, FontTable, PipelineOptions};

fn export(comments: Vec<PdfComment>, page_range: Option<(usize, usize)>) -> Vec<u8> {
    let sample = paged_gen::samples::toc::build();
    let bytes = paged_gen::write_idml(&sample).unwrap();
    let document = idml_import::import_idml_doc(&bytes).unwrap();
    let font = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .unwrap();
    let mut opts = PipelineOptions {
        collect_glyph_runs: true,
        ..Default::default()
    };
    opts.font = Some(&font);
    let fonts = FontTable::build(&document, &opts);
    opts.pre_built_font_table = Some(&fonts);
    let doc = pipeline::build_document(&document, &opts).unwrap();
    let cmm = paged_color::IccCmm::new(None, paged_color::DisplaySetup::default());
    export_pdf(ExportInput {
        doc: &doc,
        palette: &document.palette,
        fonts: Some(&fonts),
        cmm: &cmm,
        profiles: ExportProfiles::default(),
        inks: ExportInkSettings::default(),
        options: ExportOptions {
            comments,
            page_range,
            ..Default::default()
        },
        doc_bleed: [0.0; 4],
        doc_slug: [0.0; 4],
    })
    .expect("export")
    .bytes
}

fn comment(id: &str, page_index: usize, text: &str) -> PdfComment {
    PdfComment {
        id: id.into(),
        page_index,
        at: [50.0, 70.0],
        author: "Ann Author".into(),
        date: Some("2026-11-01T10:30:00.250Z".into()),
        text: text.into(),
        resolved: false,
        review_state: None,
        replies: Vec::new(),
    }
}

fn text(o: &Object) -> String {
    match o {
        Object::String(bytes, _) if bytes.starts_with(&[0xFE, 0xFF]) => {
            let units: Vec<u16> = bytes[2..]
                .chunks(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16(&units).unwrap()
        }
        Object::String(bytes, _) => String::from_utf8_lossy(bytes).into_owned(),
        other => panic!("not a text string: {other:?}"),
    }
}

/// The Text annotations of page `index`, by object id.
fn text_annots(doc: &Document, index: usize) -> Vec<(ObjectId, Dictionary)> {
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let page = doc.get_dictionary(pages[index]).unwrap();
    let Ok(annots) = page.get(b"Annots").and_then(Object::as_array) else {
        return Vec::new();
    };
    annots
        .iter()
        .filter_map(|a| a.as_reference().ok())
        .map(|id| (id, doc.get_dictionary(id).unwrap().clone()))
        .filter(|(_, d)| d.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Text"))
        .collect()
}

#[test]
fn a_comment_is_a_text_annotation_with_author_date_and_text() {
    let pdf = export(vec![comment("c1", 0, "Why this word?")], None);
    let doc = Document::load_mem(&pdf).expect("re-parse");
    let annots = text_annots(&doc, 0);
    assert_eq!(annots.len(), 1);
    let (_, a) = &annots[0];
    assert_eq!(text(a.get(b"Contents").unwrap()), "Why this word?");
    assert_eq!(text(a.get(b"T").unwrap()), "Ann Author");
    assert_eq!(text(a.get(b"NM").unwrap()), "c1");
    // `D:YYYYMMDDHHmmSS` + the zone; the fraction is dropped.
    assert!(text(a.get(b"M").unwrap()).starts_with("D:20261101103000"));
    assert_eq!(a.get(b"Name").unwrap().as_name().unwrap(), b"Comment");
    // A 20-pt note at the point, measured from the page's top-left.
    let rect: Vec<f32> = a
        .get(b"Rect")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_float().unwrap())
        .collect();
    assert_eq!(rect[2] - rect[0], 20.0);
    assert_eq!(rect[3] - rect[1], 20.0);
    // No other page has any.
    assert!(text_annots(&doc, 1).is_empty());
}

#[test]
fn replies_and_a_resolved_state_are_annotations_in_reply() {
    let mut c = comment("c1", 1, "Check this");
    c.replies = vec![PdfReply {
        id: "c1.1".into(),
        author: "Bob".into(),
        date: None,
        text: "Done".into(),
    }];
    c.resolved = true;
    let pdf = export(vec![c], None);
    let doc = Document::load_mem(&pdf).expect("re-parse");
    let annots = text_annots(&doc, 1);
    assert_eq!(annots.len(), 3, "the note, its reply and its state");
    let root = annots
        .iter()
        .find(|(_, d)| d.get(b"IRT").is_err())
        .map(|(id, _)| *id)
        .expect("a root");
    let reply = annots
        .iter()
        .find(|(_, d)| d.get(b"NM").ok().map(text).as_deref() == Some("c1.1"))
        .map(|(_, d)| d)
        .expect("the reply");
    assert_eq!(reply.get(b"IRT").unwrap().as_reference().unwrap(), root);
    assert_eq!(reply.get(b"RT").unwrap().as_name().unwrap(), b"R");
    assert_eq!(text(reply.get(b"Contents").unwrap()), "Done");
    assert_eq!(text(reply.get(b"T").unwrap()), "Bob");
    let state = annots
        .iter()
        .map(|(_, d)| d)
        .find(|d| d.get(b"State").is_ok())
        .expect("a state annotation");
    assert_eq!(text(state.get(b"State").unwrap()), "Completed");
    assert_eq!(text(state.get(b"StateModel").unwrap()), "Review");
    assert_eq!(state.get(b"IRT").unwrap().as_reference().unwrap(), root);
}

#[test]
fn a_review_state_replaces_completed_and_pages_out_of_range_are_left_out() {
    let mut rejected = comment("c1", 2, "No");
    rejected.review_state = Some("Rejected".into());
    let on_skipped_page = comment("c2", 0, "Not exported");
    let pdf = export(vec![rejected, on_skipped_page], Some((1, 2)));
    let doc = Document::load_mem(&pdf).expect("re-parse");
    // Page index 2 of the document is the second written page.
    let annots = text_annots(&doc, 1);
    let states: Vec<String> = annots
        .iter()
        .filter_map(|(_, d)| d.get(b"State").ok().map(text))
        .collect();
    assert_eq!(states, vec!["Rejected".to_string()]);
    let all: usize = (0..doc.get_pages().len())
        .map(|i| text_annots(&doc, i).len())
        .sum();
    assert_eq!(
        all, 2,
        "the note and its state; the one on page 0 is not written"
    );
}

#[test]
fn no_comments_write_no_annotations() {
    let pdf = export(Vec::new(), None);
    let doc = Document::load_mem(&pdf).expect("re-parse");
    for i in 0..doc.get_pages().len() {
        assert!(text_annots(&doc, i).is_empty());
    }
}
