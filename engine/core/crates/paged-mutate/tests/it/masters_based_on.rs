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

//! Engine ADR 1026 — masters based on masters, override lists, Override,
//! and page items as hyperlink sources: each forward op and its undo.

use paged_model::{Bounds, FrameRef, Page, Rectangle, Spread};
use paged_mutate::{Operation, Project};
use paged_scene::{Document, ParsedMasterSpread, ParsedSpread};

const B: Bounds = Bounds {
    top: 0.0,
    left: 0.0,
    bottom: 100.0,
    right: 100.0,
};

fn master(id: &str, based_on: Option<&str>, rect: &str) -> ParsedMasterSpread {
    let mut page = Page::new(format!("{id}pg"), B);
    page.applied_master = based_on.map(str::to_string);
    let mut spread = Spread {
        self_id: Some(id.to_string()),
        pages: vec![page],
        ..Spread::default()
    };
    spread.rectangles.push(Rectangle::new(rect, B));
    spread.frames_in_order.push(FrameRef::Rectangle(0));
    ParsedMasterSpread {
        src: format!("MasterSpreads/MasterSpread_{id}.xml"),
        self_id: id.to_string(),
        spread,
        name: Some(id.to_string()),
    }
}

/// Master `A`, layouts `B` (based on `A`) and `C`; one page on `B`.
fn doc() -> Document {
    let mut doc = Document::default();
    for m in [
        master("A", None, "ra"),
        master("B", Some("A"), "rb"),
        master("C", None, "rc"),
    ] {
        doc.master_spreads.insert(m.self_id.clone(), m);
    }
    let mut page = Page::new("p1", B);
    page.applied_master = Some("B".into());
    doc.spreads.push(ParsedSpread {
        src: "Spreads/Spread_s1.xml".into(),
        spread: Spread {
            self_id: Some("s1".into()),
            pages: vec![page],
            ..Spread::default()
        },
    });
    doc.rebuild_indexes();
    doc
}

#[test]
fn a_master_is_based_on_another_and_a_cycle_is_refused() {
    let mut p = Project::new(doc());
    assert_eq!(
        p.document()
            .master_chain("B")
            .iter()
            .map(|m| m.self_id.as_str())
            .collect::<Vec<_>>(),
        ["B", "A"]
    );
    // A on B would close a cycle.
    assert!(p
        .apply(Operation::ApplyMasterToPage {
            page: "Apg".into(),
            master: Some("B".into()),
        })
        .is_err());
    // C on B is fine, and undoes.
    p.apply(Operation::ApplyMasterToPage {
        page: "Cpg".into(),
        master: Some("MasterSpread/B".into()),
    })
    .unwrap();
    assert_eq!(p.document().master_chain("C").len(), 3);
    p.undo().unwrap();
    assert_eq!(p.document().master_chain("C").len(), 1);
}

#[test]
fn override_list_and_override_undo_exactly() {
    let mut p = Project::new(doc());
    p.apply(Operation::SetPageOverrides {
        page: "Bpg".into(),
        overrides: vec!["ra".into(), "ra".into()],
    })
    .unwrap();
    assert_eq!(
        p.document().master_spreads["B"].spread.pages[0].override_list,
        ["ra"]
    );
    p.undo().unwrap();
    assert!(p.document().master_spreads["B"].spread.pages[0]
        .override_list
        .is_empty());

    // Override A's rectangle (two levels down) on the body page.
    let applied = p
        .apply(Operation::OverrideMasterItems {
            page: "p1".into(),
            items: vec!["ra".into()],
            ids: Vec::new(),
            story_ids: Vec::new(),
            empty_text: false,
        })
        .unwrap();
    let Operation::OverrideMasterItems { ids, .. } = &applied.op else {
        panic!("echo");
    };
    assert_eq!(ids.len(), 1);
    let body = &p.document().spreads[0].spread;
    assert_eq!(body.rectangles.len(), 1);
    assert_eq!(body.rectangles[0].self_id.as_deref(), Some(ids[0].as_str()));
    assert_eq!(body.pages[0].override_list, ["ra"]);
    p.undo().unwrap();
    let body = &p.document().spreads[0].spread;
    assert!(body.rectangles.is_empty());
    assert!(body.pages[0].override_list.is_empty());
    // An item of a master the page does not show is refused.
    assert!(p
        .apply(Operation::OverrideMasterItems {
            page: "p1".into(),
            items: vec!["rc".into()],
            ids: Vec::new(),
            story_ids: Vec::new(),
            empty_text: false,
        })
        .is_err());
}

#[test]
fn an_item_link_is_made_deleted_and_restored() {
    let mut p = Project::new(doc());
    p.apply(Operation::InsertItemHyperlink {
        item_id: "rb".into(),
        url: String::new(),
        page: Some("p1".into()),
        name: None,
        source_id: "HyperlinkPageItemSource/h1".into(),
        dest_id: "HyperlinkPageDestination/h1".into(),
        hyperlink_id: "Hyperlink/h1".into(),
    })
    .unwrap();
    let dm = &p.document().designmap;
    assert_eq!(dm.hyperlink_page_item_sources[0].source_page_item, "rb");
    p.apply(Operation::DeleteHyperlink {
        hyperlink_id: "Hyperlink/h1".into(),
    })
    .unwrap();
    let dm = &p.document().designmap;
    assert!(dm.hyperlinks.is_empty() && dm.hyperlink_page_item_sources.is_empty());
    p.undo().unwrap();
    let dm = &p.document().designmap;
    assert_eq!(dm.hyperlinks.len(), 1);
    assert_eq!(dm.hyperlink_page_item_sources.len(), 1);
    p.undo().unwrap();
    assert!(p
        .document()
        .designmap
        .hyperlink_page_item_sources
        .is_empty());
    // An item that does not exist is refused.
    assert!(p
        .apply(Operation::InsertItemHyperlink {
            item_id: "nothing".into(),
            url: "https://paged.media".into(),
            page: None,
            name: None,
            source_id: "HyperlinkPageItemSource/h2".into(),
            dest_id: "HyperlinkURLDestination/h2".into(),
            hyperlink_id: "Hyperlink/h2".into(),
        })
        .is_err());
}
