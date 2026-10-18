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

//! ADR 171 — a document's bookmarks in its PDF, as InDesign's Include
//! Bookmarks writes them: `navigation` carries two bookmarks to text
//! destinations; with `bookmarks` on, they are the PDF's outline, each
//! going to the page its anchor was laid out on. Off (the default, as in
//! InDesign's print presets) the PDF has none.

use paged_canvas::channel::ExportPdfWireOptions;
use paged_canvas::export::CanvasExportSession;
use paged_canvas::{CanvasModel, CanvasOptions};

fn pdf(bookmarks: bool) -> Vec<u8> {
    let font = std::fs::read(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf"),
    )
    .expect("Inter");
    let idml = paged_gen::write_idml(&paged_gen::samples::navigation::build()).expect("navigation");
    let model = CanvasModel::load(
        "nav",
        &idml,
        CanvasOptions {
            fonts: vec![font],
            ..CanvasOptions::default()
        },
    )
    .expect("load");
    let wire = ExportPdfWireOptions {
        bookmarks,
        ..ExportPdfWireOptions::default()
    };
    let (mut session, pages) = CanvasExportSession::begin(&model, &wire).expect("begin");
    for _ in 0..pages {
        session.export_next_page().expect("page");
    }
    session.finish().expect("finish").pdf_bytes
}

/// Outline titles in order, from the raw bytes (the writer does not
/// compress its outline items).
fn titles(pdf: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(pdf);
    let mut out = Vec::new();
    let mut rest = text.as_ref();
    while let Some(at) = rest.find("/Title (") {
        let tail = &rest[at + 8..];
        let end = tail.find(')').unwrap();
        out.push(tail[..end].to_string());
        rest = &tail[end..];
    }
    out
}

#[test]
fn bookmarks_on_export_as_the_outline() {
    let bytes = pdf(true);
    assert!(
        String::from_utf8_lossy(&bytes).contains("/Outlines"),
        "an outline in the catalog"
    );
    assert_eq!(titles(&bytes), ["Introduction", "Further reading"]);
}

#[test]
fn bookmarks_off_export_none() {
    let bytes = pdf(false);
    assert!(!String::from_utf8_lossy(&bytes).contains("/Outlines"));
}
