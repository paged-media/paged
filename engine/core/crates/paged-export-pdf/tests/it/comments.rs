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
use paged_model::ReviewState;
use paged_pdf_annots::ImportedAnchor;
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
        kept: None,
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
        kept: None,
    }];
    c.resolved = true;
    let pdf = export(vec![c], None);
    // Kept for a PDF reader's open-check when PAGED_PDF_COMMENTS_DIR names
    // a folder (engine ADR 1055 amendment: the reader oracle).
    if let Ok(dir) = std::env::var("PAGED_PDF_COMMENTS_DIR") {
        std::fs::write(std::path::Path::new(&dir).join("comments-thread.pdf"), &pdf)
            .expect("keep the PDF");
    }
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

/// Engine ADR 1055 — what `paged-export-pdf` writes, `paged-pdf-annots` reads
/// back: the same threads with authors, dates to the second, replies, the
/// resolved state and the point within half a point.
#[test]
fn exported_comments_read_back_as_the_same_threads() {
    let mut resolved = comment(
        "c1",
        0,
        "Why this word?\nSecond paragraph, with \u{00e4}\u{00f6}\u{00fc} and \u{2014}",
    );
    resolved.at = [50.0, 70.0];
    resolved.resolved = true;
    resolved.replies = vec![
        PdfReply {
            id: "c1.1".into(),
            author: "Bob Builder".into(),
            date: Some("2026-11-01T11:00:00+01:00".into()),
            text: "Because".into(),
            kept: None,
        },
        PdfReply {
            id: "c1.2".into(),
            author: "Ann Author".into(),
            date: Some("2026-11-01T12:15:30Z".into()),
            text: "OK".into(),
            kept: None,
        },
    ];
    let mut rejected = comment("c2", 1, "No");
    rejected.at = [120.5, 33.25];
    rejected.author = "Cy".into();
    rejected.date = None;
    rejected.review_state = Some("Rejected".into());
    let open = comment("c3", 1, "Still open");

    let pdf = export(vec![resolved, rejected, open], None);
    let report = paged_pdf_annots::read_pdf_comments(&pdf).expect("reads");
    assert!(report.losses.is_empty(), "{:?}", report.losses);
    let ids: Vec<&str> = report.threads.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["c1", "c2", "c3"]);

    let c1 = &report.threads[0];
    assert_eq!(c1.page_index, 0);
    let ImportedAnchor::Point { at } = c1.anchor else {
        panic!("a point")
    };
    assert!(
        (at[0] - 50.0).abs() < 0.5 && (at[1] - 70.0).abs() < 0.5,
        "{at:?}"
    );
    let texts: Vec<(&str, &str, Option<&str>)> = c1
        .comments
        .iter()
        .map(|c| (c.id.as_str(), c.text.as_str(), c.author.as_deref()))
        .collect();
    assert_eq!(
        texts,
        [
            (
                "c1",
                "Why this word?\nSecond paragraph, with \u{00e4}\u{00f6}\u{00fc} and \u{2014}",
                Some("Ann Author")
            ),
            ("c1.1", "Because", Some("Bob Builder")),
            ("c1.2", "OK", Some("Ann Author")),
        ]
    );
    assert_eq!(c1.comments[0].date.as_deref(), Some("2026-11-01T10:30:00Z"));
    assert_eq!(
        c1.comments[1].date.as_deref(),
        Some("2026-11-01T11:00:00+01:00")
    );
    assert_eq!(c1.comments[2].date.as_deref(), Some("2026-11-01T12:15:30Z"));
    assert!(c1.comments[0].resolved);
    assert_eq!(c1.comments[0].review_state, Some(ReviewState::Completed));
    assert_eq!(c1.comments[1].parent.as_deref(), Some("c1"));
    assert!(c1.source.iter().all(|(_, b)| b.format == "pdf-annot"));

    let c2 = &report.threads[1];
    assert_eq!(c2.page_index, 1);
    let ImportedAnchor::Point { at } = c2.anchor else {
        panic!("a point")
    };
    assert!(
        (at[0] - 120.5).abs() < 0.5 && (at[1] - 33.25).abs() < 0.5,
        "{at:?}"
    );
    assert_eq!(c2.comments[0].review_state, Some(ReviewState::Rejected));
    assert!(!c2.comments[0].resolved && c2.comments[0].date.is_none());
    assert!(!report.threads[2].comments[0].resolved);
}

/// A PDF of the given objects (object `n` is `objects[n - 1]`), with an xref.
fn hand_pdf(objects: &[&str]) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        out.extend(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// The comments of a read report as the canvas hands them to the export: each
/// thread at its point (a region's top-left), each comment with its kept
/// annotation.
fn as_exported(report: &paged_pdf_annots::PdfCommentsReport) -> Vec<PdfComment> {
    report
        .threads
        .iter()
        .map(|t| {
            let kept = |id: &str| {
                let lines: Vec<&str> = t
                    .source
                    .iter()
                    .filter(|(k, _)| k == id)
                    .map(|(_, b)| b.data.as_str())
                    .collect();
                (!lines.is_empty()).then(|| lines.join("\n"))
            };
            let at = match t.anchor {
                ImportedAnchor::Point { at } => at,
                ImportedAnchor::Region { rect } => [rect[0], rect[1]],
            };
            let root = &t.comments[0];
            let when = |c: &paged_model::Comment| c.modified.clone().or(c.date.clone());
            PdfComment {
                id: root.id.clone(),
                page_index: t.page_index,
                at: [at[0] as f32, at[1] as f32],
                author: root.author.clone().unwrap_or_default(),
                date: when(root),
                text: root.text.clone(),
                resolved: root.resolved,
                review_state: None,
                replies: t.comments[1..]
                    .iter()
                    .map(|r| PdfReply {
                        id: r.id.clone(),
                        author: r.author.clone().unwrap_or_default(),
                        date: when(r),
                        text: r.text.clone(),
                        kept: kept(&r.id),
                    })
                    .collect(),
                kept: kept(&root.id),
            }
        })
        .collect()
}

/// Engine ADR 1055, amendment "Re-emitting a kept annotation": an imported
/// annotation nobody edited is written back from the dictionary it kept, on
/// the page and at the point its thread has now, with `/P`, `/IRT` and
/// `/Popup` rebuilt; an edited one is written from the model.
#[test]
fn an_unedited_imported_annotation_is_written_back_and_an_edited_one_regenerated() {
    let source = hand_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
            /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Rotate 90 /Annots [11 0 R] >>",
        // 5: a sticky note with Acrobat's extras and a pop-up (6)
        "<< /Type /Annot /Subtype /Text /NM (n1) /Rect [100 700 120 720] /T (Ann Author) \
            /CreationDate (D:20261101100000Z) /M (D:20261101103000Z) /Contents (Why this word?) \
            /C [1 1 0] /Subj (Comment) /Name /Note /F 28 /Popup 6 0 R /P 3 0 R >>",
        "<< /Type /Annot /Subtype /Popup /Rect [612 600 792 720] /Parent 5 0 R >>",
        // 7: a reply; 8: Acrobat's Accepted state of the root
        "<< /Subtype /Text /NM (n1.1) /Rect [100 700 120 720] /T (Bob) /M (D:20261101110000Z) \
            /Contents (Because) /IRT 5 0 R /RT /R /C [0 0 1] >>",
        "<< /Subtype /Text /Rect [100 700 120 720] /T (Ann Author) /M (D:20261101120000Z) \
            /IRT 5 0 R /RT /R /StateModel (Review) /State (Accepted) /F 30 >>",
        // 9: a highlight over one word; 10: a note the test edits
        "<< /Subtype /Highlight /NM (h1) /Rect [200 600 260 612] /T (Cy) /Contents (Too loose) \
            /C [0.5 1 0.5] /CA 0.6 /QuadPoints [200 612 260 612 200 600 260 600] >>",
        "<< /Subtype /Text /NM (n2) /Rect [300 500 320 520] /T (Dee) /Contents (Old) /C [1 0 0] >>",
        // 11: a sticky note on the turned page
        "<< /Subtype /Text /NM (r1) /Rect [10 20 30 40] /T (Eve) /Contents (Turned) /C [0 1 0] >>",
    ]);
    let report = paged_pdf_annots::read_pdf_comments(&source).expect("reads");
    let mut comments = as_exported(&report);
    let ids: Vec<&str> = comments.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["n1", "h1", "n2", "r1"]);
    // The highlight moves to another point; the second note is edited.
    comments[1].at = [100.0, 200.0];
    comments[2].text = "New".into();
    comments[2].date = Some("2026-11-08T09:00:00Z".into());

    let pdf = export(comments, None);
    let back = paged_pdf_annots::read_pdf_comments(&pdf).expect("reads back");
    assert!(back.losses.is_empty(), "{:?}", back.losses);
    let ids: Vec<&str> = back.threads.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["n1", "h1", "n2", "r1"]);
    let root_source = |i: usize| back.threads[i].source[0].1.data.clone();

    // The note: Acrobat's keys survive, the reply too, and the Accepted state
    // the model has no field for.
    let near = |a: f64, b: f64| (a - b).abs() < 0.01;
    let n1 = &back.threads[0];
    let ImportedAnchor::Point { at } = n1.anchor else {
        panic!("a point")
    };
    assert!(near(at[0], 100.0) && near(at[1], 72.0), "{at:?}");
    assert_eq!(n1.comments[0].text, "Why this word?");
    assert_eq!(n1.comments[0].date.as_deref(), Some("2026-11-01T10:00:00Z"));
    assert_eq!(n1.comments[0].review_state, Some(ReviewState::Accepted));
    assert!(!n1.comments[0].resolved);
    assert_eq!(n1.comments[1].text, "Because");
    assert_eq!(n1.comments[1].parent.as_deref(), Some("n1"));
    let src = root_source(0);
    assert!(
        src.contains("/Subj <436F6D6D656E74>") && src.contains("/C [ 1 1 0 ]"),
        "{src}"
    );
    assert!(
        src.contains("/Name /Note") && src.contains("/F 28"),
        "{src}"
    );
    assert!(back.threads[0].source[1].1.data.contains("/C [ 0 0 1 ]"));

    // The highlight: still a highlight, its quads moved with the point.
    let h1 = &back.threads[1];
    assert_eq!(h1.subtype, "Highlight");
    let ImportedAnchor::Region { rect } = h1.anchor else {
        panic!("a region: {:?}", h1.anchor)
    };
    assert!(
        near(rect[0], 100.0) && near(rect[1], 200.0) && near(rect[2], 60.0) && near(rect[3], 12.0),
        "{rect:?}"
    );
    assert!(root_source(1).contains("/CA 0.6"), "{}", root_source(1));

    // The edited note is the model's: new text, none of the old keys.
    let n2 = &back.threads[2];
    assert_eq!(n2.comments[0].text, "New");
    assert!(!root_source(2).contains("/C ["), "{}", root_source(2));

    // The turned page's note, on an upright page at the point it had.
    let r1 = &back.threads[3];
    assert_eq!(r1.page_index, 1);
    let ImportedAnchor::Point { at } = r1.anchor else {
        panic!("a point")
    };
    assert!(near(at[0], 20.0) && near(at[1], 10.0), "{at:?}");
    assert!(root_source(3).contains("/C [ 0 1 0 ]"));

    // Every reference points into this file: the page, the reply's root and
    // a pop-up whose parent is the note.
    let doc = Document::load_mem(&pdf).expect("re-parse");
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let annots = text_annots(&doc, 0);
    let (root_id, root) = annots
        .iter()
        .find(|(_, d)| d.get(b"NM").map(text).ok().as_deref() == Some("n1"))
        .expect("n1");
    assert_eq!(root.get(b"P").unwrap().as_reference().unwrap(), pages[0]);
    let popup = doc
        .get_dictionary(root.get(b"Popup").unwrap().as_reference().unwrap())
        .unwrap();
    assert_eq!(popup.get(b"Subtype").unwrap().as_name().unwrap(), b"Popup");
    assert_eq!(
        popup.get(b"Parent").unwrap().as_reference().unwrap(),
        *root_id
    );
    let reply = annots
        .iter()
        .find(|(_, d)| d.get(b"NM").map(text).ok().as_deref() == Some("n1.1"))
        .expect("n1.1");
    assert_eq!(
        reply.1.get(b"IRT").unwrap().as_reference().unwrap(),
        *root_id
    );
    assert!(!String::from_utf8_lossy(&pdf).contains("PagedSourceRotate"));
}
