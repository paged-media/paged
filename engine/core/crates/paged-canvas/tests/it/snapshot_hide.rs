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

//! v70 — `RequestSnapshot.hideItems`: a snapshot of a page without some
//! of its items (a slideshow's build steps), leaving the document alone.

use paged_canvas::{render_snapshot_png_hiding, CanvasModel, CanvasOptions, ElementId};
use paged_wire::PageId;

fn model() -> CanvasModel {
    let sample = paged_gen::samples::build("geometry").expect("geometry sample");
    let bytes = paged_gen::write_idml(&sample).expect("write");
    CanvasModel::load("hide", &bytes, CanvasOptions::default()).expect("load")
}

fn png(m: &CanvasModel, page: &PageId, hide: &[ElementId]) -> Vec<u8> {
    render_snapshot_png_hiding(m, page, 200, None, hide)
        .expect("snapshot")
        .png_bytes
}

#[test]
fn a_snapshot_can_leave_items_out_without_touching_the_document() {
    let m = model();
    let page = PageId(m.pages()[0].self_id.clone());
    let rect = m
        .scene()
        .spreads
        .iter()
        .flat_map(|s| s.spread.rectangles.iter())
        .find_map(|r| r.self_id.clone())
        .expect("the geometry sample has a rectangle");

    let plain = png(&m, &page, &[]);
    let hidden = png(&m, &page, &[ElementId::Rectangle(rect.clone())]);
    assert_ne!(plain, hidden, "hiding the rectangle changes the page");

    // The document still has it: a plain snapshot after is the plain one.
    assert_eq!(png(&m, &page, &[]), plain);
}
