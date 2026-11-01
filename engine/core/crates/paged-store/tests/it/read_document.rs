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

//! `read_document` is the reverse of `wrap_document`: a document written into
//! the `.paged` container reads back to the same model, and a container that is
//! not one says why.

use paged_scene::Document;
use paged_store::package::{read_document, wrap_document};

#[test]
fn a_wrapped_document_reads_back_the_same() {
    let mut doc = Document::default();
    doc.people.push(paged_model::Person {
        id: "p-ann".into(),
        name: "Ann Author".into(),
        ..Default::default()
    });
    doc.comment_threads.push(paged_model::CommentThread {
        id: "t1".into(),
        anchor: Some(paged_model::CommentAnchor::Page {
            page: "p1".into(),
            at: [10.0, 20.0],
        }),
        comments: vec![paged_model::Comment {
            id: "t1".into(),
            text: "Check".into(),
            ..Default::default()
        }],
        ..Default::default()
    });
    let bytes = wrap_document(&doc, "doc", 612.0, 792.0).expect("wrap");
    let back = read_document(&bytes).expect("read");
    assert_eq!(back.canonical_hash(), doc.canonical_hash());
    assert_eq!(back.people.len(), 1);
    assert_eq!(back.comment_threads[0].comments[0].text, "Check");
}

/// Engine ADR 1056: the theme is part of the native encoding, source and all,
/// and a document without one writes none.
#[test]
fn a_documents_theme_survives_the_container() {
    let mut doc = Document::default();
    let plain = wrap_document(&doc, "doc", 612.0, 792.0).expect("wrap");
    assert!(read_document(&plain).expect("read").theme.is_none());
    doc.theme = Some(paged_model::Theme {
        name: "Probe".into(),
        colors: vec![paged_model::ThemeColor {
            slot: "accent1".into(),
            value: "FF0000".into(),
            system: None,
        }],
        major: paged_model::ThemeFonts {
            latin: Some("Georgia".into()),
            scripts: vec![("Jpan".into(), "Yu Gothic".into())],
            ..Default::default()
        },
        source: Some(paged_model::SourceBlob {
            format: paged_model::THEME_SOURCE_OOXML.into(),
            data: "<a:theme/>".into(),
        }),
        ..Default::default()
    });
    let bytes = wrap_document(&doc, "doc", 612.0, 792.0).expect("wrap");
    let back = read_document(&bytes).expect("read");
    assert_eq!(back.theme, doc.theme);
    assert_ne!(back.canonical_hash(), Document::default().canonical_hash());
}

#[test]
fn a_container_without_the_model_part_says_so() {
    // A zip with a mimetype and nothing else.
    let mut zip = zip::write::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    use std::io::Write;
    zip.start_file("mimetype", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"application/vnd.adobe.indesign-idml-package")
        .unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    assert_eq!(
        read_document(&bytes).unwrap_err(),
        "the document has no native model part"
    );
    assert!(read_document(b"not a zip").is_err());
}
