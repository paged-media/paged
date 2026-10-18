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

//! Plan-2 §8.3 — load a real InDesign export that ships `<Guide>`
//! elements and confirm `CanvasModel::handle()` surfaces them on
//! `DocumentHandle.ruler_guides`. Resume-template-teacher carries 14
//! guides across its body pages.
//!
//! The pack is in the private corpus, so this is the `corpus: idml` lane:
//!
//! ```text
//! PAGED_CORPUS_DIR=<corpus root> cargo nextest run --profile corpus --run-ignored only
//! ```

use paged_canvas::{CanvasModel, CanvasOptions};

#[test]
#[ignore = "corpus: idml"]
fn document_handle_exposes_ruler_guides_from_real_idml() {
    let Some(idml) = paged_test_resources::corpus("idml", &[]) else {
        return;
    };
    // The corpus IS mounted, so a pack that is not there is a stale lane.
    let path = idml.join("packs/resume-template-teacher/template.idml");
    assert!(
        path.is_file(),
        "{} is missing: the pack moved or was renamed — fix the lane",
        path.display()
    );
    let bytes = std::fs::read(&path).expect("read fixture");
    let opts = CanvasOptions::default();
    let model = CanvasModel::load("doc-rg", &bytes, opts).expect("load + build");
    let handle = model.handle();
    assert!(
        handle.ruler_guides.len() >= 14,
        "expected >= 14 guides in resume-template-teacher; got {}",
        handle.ruler_guides.len(),
    );
    // Each guide should reference a real page id from the handle.
    let page_ids: std::collections::HashSet<&str> =
        handle.page_ids.iter().map(|p| p.as_str()).collect();
    for g in &handle.ruler_guides {
        assert!(
            page_ids.contains(g.page_id.as_str()),
            "guide page_id {:?} not in document's pages",
            g.page_id,
        );
    }
}
