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

//! ADR 029 — the DOCX standalone-open path, engine side. A plugin
//! produces a native SKELETON (a page per Word section, its margin-box frame,
//! a story with a grow rule) packaged by `paged_store::package::wrap_document`
//! and opened like any `.paged`. The grow rule rides inside the native model,
//! so the opened document grows by itself: Word's 5 pages for the
//! `docx-pagination` shape (paged-renderer's docx_pagination_pipeline.rs
//! pins the per-page content against Word).

use paged_canvas::{CanvasModel, CanvasOptions};
use paged_gen::samples::docx_pagination::{section_story_id, sections};

fn inter() -> Vec<u8> {
    let p =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/fonts/Inter.ttf");
    std::fs::read(&p).expect("read Inter.ttf")
}

#[test]
fn a_native_skeleton_with_grow_rules_opens_and_grows() {
    let idml = paged_gen::write_idml(&paged_gen::samples::docx_pagination::build()).expect("idml");
    let mut doc = idml_import::import_idml_doc(&idml).expect("import");
    let ids: Vec<String> = (0..sections().len() as u32).map(section_story_id).collect();
    for s in doc.stories.iter_mut() {
        if ids.contains(&s.self_id) {
            s.story.grow = Some(paged_model::FlowGrowRule {
                copy_frame_options: true,
                ..Default::default()
            });
        }
    }
    let paged =
        paged_store::package::wrap_document(&doc, "Imported.docx", 612.0, 792.0).expect("wrap");

    let opts = CanvasOptions {
        fonts: vec![inter()],
        ..CanvasOptions::default()
    };
    let model = CanvasModel::load("doc1", &paged, opts).expect("load .paged");
    assert_eq!(
        model.scene().growing_stories().len(),
        2,
        "the grow rules survive the native round trip"
    );
    assert_eq!(
        model.built().pages.len(),
        5,
        "Word paginates this document to 5 pages"
    );

    // Generated pages report their section's margins, like the authored
    // page they copy (the editor's page list and margin guides read these).
    let pages = model.pages();
    let margins: Vec<f32> = pages.iter().map(|p| p.margin_top_pt).collect();
    assert_eq!(margins, vec![72.0, 72.0, 72.0, 36.0, 36.0]);
}
