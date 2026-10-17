/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

//! A30 — a master item's transparency is saved as a page item's: the
//! master spreads run the same transparency pass as the body spreads.

#[path = "support/pkg.rs"]
mod pkg;

use idml_export::write_idml;

const MASTER: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<idPkg:MasterSpread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="20.0">
<MasterSpread Self="m1" Name="A-Master" NamePrefix="A" BaseName="Master" PageCount="1">
<Page Self="mp1" Name="A" GeometricBounds="0 0 792 612" ItemTransform="1 0 0 1 0 0"/>
<Rectangle Self="mr1" ItemTransform="1 0 0 1 0 0" FillColor="Color/Black"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray><PathPointType Anchor="50 50" LeftDirection="50 50" RightDirection="50 50"/><PathPointType Anchor="50 150" LeftDirection="50 150" RightDirection="50 150"/><PathPointType Anchor="150 150" LeftDirection="150 150" RightDirection="150 150"/><PathPointType Anchor="150 50" LeftDirection="150 50" RightDirection="150 50"/></PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle>
</MasterSpread></idPkg:MasterSpread>"#;

fn source() -> Vec<u8> {
    pkg::package(&[
        (
            "designmap.xml",
            &pkg::designmap(
                r#"<idPkg:MasterSpread src="MasterSpreads/MasterSpread_m1.xml"/>
"#,
            ),
        ),
        ("Resources/Styles.xml", pkg::STYLES),
        ("MasterSpreads/MasterSpread_m1.xml", MASTER),
        ("Spreads/Spread_s1.xml", pkg::SPREAD),
        ("Stories/Story_st1.xml", &pkg::story(pkg::STORY_BODY)),
    ])
}

fn master_opacity(doc: &paged_scene::Document) -> Option<f32> {
    doc.master_spreads
        .values()
        .flat_map(|m| m.spread.rectangles.iter())
        .find(|r| r.self_id.as_deref() == Some("mr1"))
        .expect("master rectangle")
        .opacity
}

#[test]
fn a_master_items_opacity_is_saved() {
    let source = source();
    let mut doc = pkg::open(&source);
    assert_eq!(master_opacity(&doc), None);
    for m in doc.master_spreads.values_mut() {
        for r in &mut m.spread.rectangles {
            r.opacity = Some(40.0);
        }
    }
    let out = write_idml(&doc, &source).expect("write");
    assert_eq!(master_opacity(&pkg::open(&out)), Some(40.0));
}

#[test]
fn an_unedited_master_saves_byte_identically() {
    let source = source();
    let doc = pkg::open(&source);
    let out = write_idml(&doc, &source).expect("write");
    pkg::assert_same_package(&source, &out);
}
