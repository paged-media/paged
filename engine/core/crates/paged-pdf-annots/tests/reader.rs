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

//! Hand-built PDFs (a few hundred bytes each): every supported annotation type,
//! the unsupported ones as aggregated losses, replies, review states, and the
//! coordinate mapping with a non-zero MediaBox origin and `/Rotate`.

use paged_model::{ReviewState, ThreadKind};
use paged_pdf_annots::{
    read_pdf_comments, read_pdf_comments_with, ImportedAnchor, PageBox, ReadError, ReadOptions,
    SOURCE_FORMAT,
};

/// A PDF of the given objects (object `n` is `objects[n - 1]`), with an xref.
fn pdf(objects: &[&str]) -> Vec<u8> {
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

/// Two pages: page 1 has a MediaBox at (100, 200) of 300 x 400 and the
/// annotations 5.., page 2 is 300 x 400 at the origin turned 90 degrees.
fn review_pdf() -> Vec<u8> {
    pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [100 200 400 600] \
            /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R 12 0 R 13 0 R 14 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Rotate 90 /Annots [15 0 R] >>",
        // 5: a sticky note, with a Popup
        "<< /Type /Annot /Subtype /Text /NM (n1) /Rect [150 500 170 520] /T (Ann Author) \
            /M (D:20261101103000+01'00') /Contents (Why this word?\\rSecond line) /Popup 6 0 R >>",
        "<< /Type /Annot /Subtype /Popup /Rect [0 0 10 10] /Parent 5 0 R >>",
        // 7: a reply, dated before the next one; 8: a later reply
        "<< /Subtype /Text /NM (n1.2) /Rect [150 500 170 520] /T (Bob) /M (D:20261101120000Z) \
            /Contents (Second) /IRT 5 0 R /RT /R >>",
        "<< /Subtype /Text /NM (n1.1) /Rect [150 500 170 520] /T (Cy) /M (D:20261101110000Z) \
            /Contents (First) /IRT 5 0 R >>",
        // 9: Acrobat's Completed state of the root
        "<< /Subtype /Text /Rect [150 500 170 520] /T (Ann Author) /M (D:20261101130000Z) \
            /IRT 5 0 R /RT /R /StateModel (Review) /State (Completed) /F 2 >>",
        // 10: a highlight with a note, over two words (QuadPoints are TL TR BL BR)
        "<< /Subtype /Highlight /Rect [160 470 260 480] /T (Ann Author) /Contents (Too loose) \
            /QuadPoints [160 480 200 480 160 470 200 470 220 480 260 480 220 470 260 470] >>",
        // 11: free text in rich text only
        "<< /Subtype /FreeText /Rect [120 300 220 330] /T (Dee) \
            /RC (<body><p>Rich &amp; plain</p></body>) /DA (0 g) >>",
        // 12, 13: two links, 14: a stamp
        "<< /Subtype /Link /Rect [0 0 10 10] /Border [0 0 0] >>",
        "<< /Subtype /Link /Rect [20 20 30 30] >>",
        "<< /Subtype /Stamp /Rect [0 0 50 50] /Name /Approved >>",
        // 15: a sticky note on the rotated page, rejected by a state in the same page
        "<< /Subtype /Text /NM (r1) /Rect [10 20 30 40] /T (Eve) /Contents (Turned) >>",
    ])
}

#[test]
fn threads_map_replies_states_and_the_page_origin() {
    let report = read_pdf_comments(&review_pdf()).expect("reads");
    let ids: Vec<&str> = report.threads.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["n1", "pdf-p1-2", "pdf-p1-3", "r1"]);

    let note = &report.threads[0];
    assert_eq!((note.page_index, note.subtype.as_str()), (0, "Text"));
    assert_eq!(note.kind, ThreadKind::Comment);
    // Top-left of /Rect, from the MediaBox origin (100, 200): x 50, and
    // y = 400 - (520 - 200) = 80.
    assert_eq!(note.anchor, ImportedAnchor::Point { at: [50.0, 80.0] });
    let root = &note.comments[0];
    assert_eq!(root.author.as_deref(), Some("Ann Author"));
    assert_eq!(root.date.as_deref(), Some("2026-11-01T10:30:00+01:00"));
    assert_eq!(root.text, "Why this word?\nSecond line");
    assert!(root.resolved && root.review_state == Some(ReviewState::Completed));
    // Replies in order of /M although the file lists the later one first.
    let replies: Vec<(&str, &str, Option<&str>)> = note.comments[1..]
        .iter()
        .map(|c| (c.id.as_str(), c.text.as_str(), c.parent.as_deref()))
        .collect();
    assert_eq!(
        replies,
        [
            ("n1.1", "First", Some("n1")),
            ("n1.2", "Second", Some("n1"))
        ]
    );
    assert!(!note.comments[1].resolved);

    // The highlight: bounding box of both quads, y down.
    let hl = &report.threads[1];
    assert_eq!(hl.subtype, "Highlight");
    assert_eq!(
        hl.anchor,
        ImportedAnchor::Region {
            rect: [60.0, 120.0, 100.0, 10.0]
        }
    );
    assert_eq!(hl.comments[0].text, "Too loose");

    // Free text with only a rich-text body.
    let free = &report.threads[2];
    assert_eq!(free.comments[0].text, "Rich & plain");
    assert_eq!(free.anchor, ImportedAnchor::Point { at: [20.0, 270.0] });

    // The rotated page: user (10..30, 20..40) turned 90 degrees clockwise puts
    // its top-left at (20, 10).
    let turned = &report.threads[3];
    assert_eq!(turned.page_index, 1);
    assert_eq!(turned.anchor, ImportedAnchor::Point { at: [20.0, 10.0] });

    assert_eq!(report.authors(), ["Ann Author", "Cy", "Bob", "Dee", "Eve"]);
}

#[test]
fn unsupported_types_are_one_loss_line_each_and_popups_are_skipped() {
    let report = read_pdf_comments(&review_pdf()).unwrap();
    let losses: Vec<(&str, usize, Vec<usize>)> = report
        .losses
        .iter()
        .map(|l| (l.kind.as_str(), l.count, l.pages.clone()))
        .collect();
    assert_eq!(losses, [("Link", 2, vec![0]), ("Stamp", 1, vec![0])]);
    assert!(report.losses[0]
        .to_string()
        .starts_with("2 x Link (page 1):"));
    assert!(!report.losses.iter().any(|l| l.kind == "Popup"));
}

#[test]
fn every_thread_keeps_its_annotations_as_self_contained_source() {
    let report = read_pdf_comments(&review_pdf()).unwrap();
    let note = &report.threads[0];
    // The root, both replies and the state annotation.
    let keys: Vec<&str> = note.source.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["n1", "n1.1", "n1.2", "n1"]);
    assert!(note.source.iter().all(|(_, b)| b.format == SOURCE_FORMAT));
    let root = &note.source[0].1.data;
    assert!(root.starts_with("<< /Contents <"), "{root}");
    assert!(root.contains("/Subtype /Text") && root.contains("/NM <6E31>"));
    // Nothing points into the file it came from.
    assert!(!root.contains(" R") && !root.contains("/Popup") && !root.contains("/IRT"));
    assert!(note.source[3]
        .1
        .data
        .contains("/State <436F6D706C65746564>"));
}

#[test]
fn review_states_and_unknown_state_models() {
    let pdf = pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R 5 0 R 6 0 R 7 0 R] >>",
        "<< /Subtype /Text /Rect [10 100 30 120] /Contents (a) >>",
        // Two states: the later one wins.
        "<< /Subtype /Text /Rect [10 100 30 120] /IRT 4 0 R /StateModel (Review) /State (Accepted) \
            /M (D:20260101000000Z) >>",
        "<< /Subtype /Text /Rect [10 100 30 120] /IRT 4 0 R /StateModel (Review) /State (Rejected) \
            /M (D:20260102000000Z) >>",
        "<< /Subtype /Text /Rect [10 100 30 120] /IRT 4 0 R /StateModel (Marked) /State (Marked) >>",
    ]);
    let report = read_pdf_comments(&pdf).unwrap();
    let c = &report.threads[0].comments[0];
    assert_eq!(c.review_state, Some(ReviewState::Rejected));
    assert!(!c.resolved);
    let marked = report
        .losses
        .iter()
        .find(|l| l.kind == "state:Marked")
        .unwrap();
    assert_eq!(marked.count, 1);
}

#[test]
fn the_trim_box_is_the_page_unless_told_otherwise() {
    // A 10-pt bleed around a 200 x 200 trim box.
    let pdf = pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 220] /TrimBox [10 10 210 210] \
            /Annots [4 0 R] >>",
        "<< /Subtype /Text /Rect [20 190 40 210] /Contents (a) >>",
    ]);
    let at =
        |opts: &ReadOptions| match &read_pdf_comments_with(&pdf, opts).unwrap().threads[0].anchor {
            ImportedAnchor::Point { at } => *at,
            other => panic!("{other:?}"),
        };
    assert_eq!(at(&ReadOptions::default()), [10.0, 0.0]);
    assert_eq!(
        at(&ReadOptions {
            page_box: PageBox::Crop
        }),
        [20.0, 10.0]
    );
}

#[test]
fn a_pdf_without_annotations_and_a_non_pdf() {
    let plain = pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    ]);
    let report = read_pdf_comments(&plain).unwrap();
    assert!(report.threads.is_empty() && report.losses.is_empty());
    assert_eq!(
        read_pdf_comments(b"not a pdf at all").unwrap_err(),
        ReadError::Invalid
    );
}
