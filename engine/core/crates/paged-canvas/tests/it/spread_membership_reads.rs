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

//! WP2.7 — the page and margin reads Align to Page / Margins / Spread
//! needs (the editor's "engine gap 7").
//!
//! - `SpreadSummary.page_ids` lists a spread's pages, and
//!   `SpreadSummary.members` its top-level items with the page each sits
//!   on, by `element_geometry`'s rule (the page holding the centre of the
//!   transformed box; `None` on the pasteboard). A group stands for its
//!   members.
//! - `PageSummary` carries its place in the spread (`index_in_spread`),
//!   the spine side (`binding_edge`: a verso binds on its right), and the
//!   inside / outside margins resolved from the physical left / right.

use std::io::Write;

use paged_canvas::channel::{
    BindingEdgeWire, CollectionName, Mutation, PageSummary, SpreadSummary,
};
use paged_canvas::element_selection::ElementId;
use paged_canvas::{CanvasModel, CanvasOptions};
use paged_mutate::{PropertyPath, Value};

/// A facing spread `s1` (verso `p1`, recto `p2`, origins `(-612, -396)`
/// and `(0, -396)`) with margins on both pages, and a single-page spread
/// `s2`.
///
/// - `r1` on the verso, `g1` (a group of two rectangles) on the recto,
///   `pb` on the pasteboard left of the verso;
/// - `r3` on `s2`'s page.
fn facing_idml() -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/vnd.adobe.indesign-idml-package")
            .unwrap();
        zip.start_file("META-INF/container.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="designmap.xml" media-type="text/xml"/></rootfiles></container>"#,
        )
        .unwrap();
        zip.start_file("designmap.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<Document DOMVersion="13.1" Self="d1">
<Layer Self="layer-body" Name="Body" Visible="true" Locked="false"/>
<idPkg:Spread src="Spreads/Spread_s1.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
<idPkg:Spread src="Spreads/Spread_s2.xml" xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"/>
</Document>"#,
        )
        .unwrap();
        zip.start_file("Spreads/Spread_s1.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s1" PageCount="2" BindingLocation="1">
<Page Self="p1" Name="2" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 -612 -396">
<MarginPreference ColumnCount="2" ColumnGutter="12" Top="36" Bottom="48" Left="54" Right="30"/>
</Page>
<Page Self="p2" Name="3" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 -396">
<MarginPreference ColumnCount="1" ColumnGutter="12" Top="36" Bottom="48" Left="30" Right="54"/>
</Page>
<Rectangle Self="r1" GeometricBounds="0 0 100 100" ItemTransform="1 0 0 1 -552 -296" FillColor="Color/Black"/>
<Group Self="g1">
  <Rectangle Self="a1" GeometricBounds="0 0 50 100" ItemTransform="1 0 0 1 100 -296" FillColor="Color/Black"/>
  <Rectangle Self="a2" GeometricBounds="0 0 40 40" ItemTransform="1 0 0 1 250 -246" FillColor="Color/Black"/>
</Group>
<Rectangle Self="pb" GeometricBounds="0 0 40 40" ItemTransform="1 0 0 1 -800 -100" FillColor="Color/Black"/>
</Spread></idPkg:Spread>"#,
        )
        .unwrap();
        zip.start_file("Spreads/Spread_s2.xml", opts).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="13.1">
<Spread Self="s2" PageCount="1" BindingLocation="0">
<Page Self="p3" Name="4" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 -396"/>
<Rectangle Self="r3" GeometricBounds="0 0 100 100" ItemTransform="1 0 0 1 50 -346" FillColor="Color/Black"/>
</Spread></idPkg:Spread>"#,
        )
        .unwrap();
        zip.finish().unwrap();
    }
    buf
}

fn load() -> CanvasModel {
    CanvasModel::load("facing-margins", &facing_idml(), CanvasOptions::default()).expect("load")
}

fn spreads(m: &CanvasModel) -> Vec<SpreadSummary> {
    serde_json::from_value(m.collection(CollectionName::Spreads)).expect("SpreadSummary[]")
}

fn pages(m: &CanvasModel) -> Vec<PageSummary> {
    serde_json::from_value(m.collection(CollectionName::Pages)).expect("PageSummary[]")
}

fn members(s: &SpreadSummary) -> Vec<(ElementId, Option<&str>)> {
    s.members
        .iter()
        .map(|m| (m.id.clone(), m.page_id.as_deref()))
        .collect()
}

#[test]
#[allow(non_snake_case)]
fn a_spread_lists_its_pages_and_where_each_item_sits__feat__layout_model_page_margin_reads() {
    let m = load();
    let s = spreads(&m);
    assert_eq!(s.len(), 2);
    assert_eq!(s[0].page_ids, ["p1", "p2"]);
    assert_eq!(s[1].page_ids, ["p3"]);
    assert_eq!(
        members(&s[0]),
        [
            (ElementId::Rectangle("r1".into()), Some("p1")),
            // A group stands for its members, on the page its box centres on.
            (ElementId::Group("g1".into()), Some("p2")),
            // The pasteboard is no page.
            (ElementId::Rectangle("pb".into()), None),
        ]
    );
    assert_eq!(
        members(&s[1]),
        [(ElementId::Rectangle("r3".into()), Some("p3"))]
    );
}

#[test]
fn membership_agrees_with_element_geometry() {
    let m = load();
    for s in spreads(&m) {
        for member in &s.members {
            let g = m.element_geometry(std::slice::from_ref(&member.id));
            let page = g
                .first()
                .and_then(|g| g.page_id.as_ref())
                .map(|p| p.as_str().to_string());
            assert_eq!(page, member.page_id, "{:?}", member.id);
        }
    }
}

#[test]
fn a_moved_item_changes_page() {
    let mut m = load();
    // r1 moves from the verso onto the recto (spread x 100).
    m.apply_mutation(&Mutation::SetElementProperty {
        element_id: ElementId::Rectangle("r1".into()),
        path: PropertyPath::FrameTransform,
        value: Value::Transform(Some([1.0, 0.0, 0.0, 1.0, 100.0, -296.0])),
    })
    .expect("move");
    let s = spreads(&m);
    assert_eq!(
        members(&s[0])[0],
        (ElementId::Rectangle("r1".into()), Some("p2"))
    );
}

#[test]
#[allow(non_snake_case)]
fn pages_carry_their_place_in_the_spread_and_the_spine_side__feat__layout_model_page_margin_reads()
{
    let m = load();
    let p = pages(&m);
    let placed: Vec<_> = p
        .iter()
        .map(|p| {
            (
                p.self_id.as_str(),
                p.spread_id.as_deref(),
                p.index_in_spread,
                p.binding_edge,
                p.page_origin,
            )
        })
        .collect();
    assert_eq!(
        placed,
        [
            (
                "p1",
                Some("s1"),
                Some(0),
                Some(BindingEdgeWire::Right),
                Some([-612.0, -396.0])
            ),
            (
                "p2",
                Some("s1"),
                Some(1),
                Some(BindingEdgeWire::Left),
                Some([0.0, -396.0])
            ),
            // A page alone in its spread binds on its left.
            (
                "p3",
                Some("s2"),
                Some(0),
                Some(BindingEdgeWire::Left),
                Some([0.0, -396.0])
            ),
        ]
    );
}

#[test]
fn inside_and_outside_margins_follow_the_spine() {
    let m = load();
    let p = pages(&m);
    let margins: Vec<_> = p
        .iter()
        .map(|p| {
            (
                p.margin_top_pt,
                p.margin_bottom_pt,
                p.margin_left_pt,
                p.margin_right_pt,
                p.margin_inside_pt,
                p.margin_outside_pt,
                p.column_count,
            )
        })
        .collect();
    assert_eq!(
        margins,
        [
            // The verso: its spine is on the right, so inside = right.
            (36.0, 48.0, 54.0, 30.0, 30.0, 54.0, 2),
            // The recto: inside = left.
            (36.0, 48.0, 30.0, 54.0, 30.0, 54.0, 1),
            // No margins declared: all zero, one column.
            (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1),
        ]
    );
}

#[test]
fn older_replies_without_the_fields_still_deserialize() {
    let s: SpreadSummary =
        serde_json::from_str(r#"{"selfId":"s","label":"1","pageCount":1}"#).expect("spread");
    assert!(s.page_ids.is_empty() && s.members.is_empty());
    let p: PageSummary =
        serde_json::from_str(r#"{"selfId":"p","index":1,"sizePt":[612,792]}"#).expect("page");
    assert_eq!(p.index_in_spread, None);
    assert_eq!(p.binding_edge, None);
    assert_eq!(p.margin_inside_pt, 0.0);
}
