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

//! The XML structure (engine ADR 1002): tags, the elements tagging items,
//! stories and ranges, and their attributes. Tagging marks a template's
//! fields, so these rows run as the template's author.

use super::*;

/// The tagged fixture, in an author's session.
fn tagged() -> CanvasModel {
    let bytes = paged_gen::fixtures::tagged_template_idml();
    let mut m = CanvasModel::load("xml", &bytes, CanvasOptions::default()).expect("load");
    m.set_session_policy(paged_template::SessionPolicy {
        role: paged_template::Role::Author,
        overrides: vec![],
    });
    m
}

#[test]
fn create_xml_tag() {
    covers!("script:paged.createXmlTag");
    let mut m = tagged();
    throws(&mut m, "paged.createXmlTag(Symbol('t'))", SYMBOL_TO_STRING);
    refuses(&mut m, "paged.createXmlTag('two words')", "false");
    refuses(&mut m, "paged.createXmlTag('Headline')", "false");
    writes(&mut m, "paged.createXmlTag('Caption', 'Red')", "true");
}

#[test]
fn delete_xml_tag() {
    covers!("script:paged.deleteXmlTag");
    let mut m = tagged();
    refuses(&mut m, "paged.deleteXmlTag('Headline')", "false");
    refuses(&mut m, "paged.deleteXmlTag('Nope')", "false");
    ok(&mut m, "paged.createXmlTag('Caption')");
    writes(&mut m, "paged.deleteXmlTag('Caption')", "true");
}

#[test]
fn tag_item() {
    covers!("script:paged.tagItem");
    let mut m = tagged();
    throws(
        &mut m,
        "paged.tagItem(Symbol('i'), 'Logo')",
        SYMBOL_TO_STRING,
    );
    refuses(&mut m, "paged.tagItem('nope', 'Logo')", "false");
    refuses(&mut m, "paged.tagItem('rPhoto', 'two words')", "false");
    writes(&mut m, "paged.tagItem('rLogo', 'Logo', 'dxLogo')", "true");
}

#[test]
fn untag_item() {
    covers!("script:paged.untagItem");
    let mut m = tagged();
    refuses(&mut m, "paged.untagItem('rLogo')", "false");
    writes(&mut m, "paged.untagItem('tfHead')", "true");
}

#[test]
fn tag_range() {
    covers!("script:paged.tagRange");
    let mut m = tagged();
    refuses(&mut m, "paged.tagRange('sHead', 7, 99, 'Season')", "false");
    refuses(&mut m, "paged.tagRange('nope', 0, 1, 'Season')", "false");
    writes(&mut m, "paged.tagRange('sHead', 7, 11, 'Season')", "true");
}

#[test]
fn untag_range() {
    covers!("script:paged.untagRange");
    let mut m = tagged();
    refuses(&mut m, "paged.untagRange('di2i3')", "false");
    writes(&mut m, "paged.untagRange('di2i5i1')", "true");
}

#[test]
fn set_xml_attribute() {
    covers!("script:paged.setXmlAttribute");
    let mut m = tagged();
    refuses(
        &mut m,
        "paged.setXmlAttribute('nope', 'label', 'x')",
        "false",
    );
    writes(
        &mut m,
        "paged.setXmlAttribute('di2i4', 'label', 'Hero')",
        "true",
    );
    writes(&mut m, "paged.setXmlAttribute('di2i4', 'label')", "true");
}
