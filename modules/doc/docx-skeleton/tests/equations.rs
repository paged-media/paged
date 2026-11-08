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

//! Engine ADR 1090 — the native builder sets a Word document's equations on
//! the model paragraphs: an inline one at its character, a display one in a
//! centred paragraph of its own.

use std::io::Read;

use docx_skeleton::body::{native_body, NativeBlock};
use paged_model::Justification;

fn story() -> paged_model::Story {
    let bytes = docx_conformance::equations_docx();
    let model = docx_import::import_docx(&bytes).expect("import");
    let ir = docx_lower::lower(&model);
    let deferred: Vec<_> = native_body(&ir)
        .blocks
        .iter()
        .filter_map(|b| match b {
            NativeBlock::Deferred { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect();
    assert!(deferred.is_empty(), "deferred: {deferred:?}");
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
    doc.stories
        .into_iter()
        .find(|s| s.self_id == docx_skeleton::section_story_id(0))
        .expect("story 0")
        .story
}

#[test]
fn the_skeleton_holds_each_equation_on_its_paragraph() {
    let story = story();
    let ps = &story.paragraphs;
    assert_eq!(ps.len(), 4);
    // Inline: at its character, the paragraph's text unchanged.
    let text: String = ps[0].runs.iter().map(|r| r.text.as_str()).collect();
    assert_eq!(text, "Area  in square units.");
    assert_eq!(ps[0].equations.len(), 1);
    assert_eq!(ps[0].equations[0].offset, 5);
    assert!(!ps[0].equations[0].math.display);
    assert_ne!(ps[0].justification, Some(Justification::CenterAlign));
    // Display: a paragraph of its own, centred.
    for p in &ps[1..3] {
        assert_eq!(p.equations.len(), 1);
        assert!(p.equations[0].math.display);
        assert_eq!(p.justification, Some(Justification::CenterAlign));
    }
    assert!(ps[3].equations.is_empty());
}
