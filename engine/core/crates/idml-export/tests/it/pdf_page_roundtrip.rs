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

//! A placed PDF's `<PDFAttribute>` survives an export (engine ADR 1003):
//! unedited, byte for byte; its page set through `FramePdfPage`, written
//! where InDesign writes it and read back as the same page; undone, the
//! source again.

use crate::pkg;

use idml_export::write_idml;
use paged_mutate::{apply, NodeId, Operation, PropertyPath, Value};

const FRAME: &str = r#"<Rectangle Self="r1" ContentType="GraphicType" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray><PathPointType Anchor="0 0" LeftDirection="0 0" RightDirection="0 0" /><PathPointType Anchor="0 120" LeftDirection="0 120" RightDirection="0 120" /><PathPointType Anchor="200 120" LeftDirection="200 120" RightDirection="200 120" /><PathPointType Anchor="200 0" LeftDirection="200 0" RightDirection="200 0" /></PathPointArray></GeometryPathType></PathGeometry></Properties><PDF Self="pdf1" ItemTransform="1 0 0 1 0 0"><Properties><GraphicBounds Left="0" Top="0" Right="200" Bottom="120" /></Properties><PDFAttribute PageNumber="1" PDFCrop="CropMedia" TransparentBackground="true" /><Link Self="l1" LinkResourceURI="file:/Links/art.pdf" StoredState="Normal" /></PDF></Rectangle>"#;

fn source() -> Vec<u8> {
    let spread = pkg::SPREAD.replace("</Spread>", &format!("{FRAME}\n</Spread>"));
    pkg::package(&[
        ("designmap.xml", &pkg::designmap("")),
        ("Resources/Styles.xml", pkg::STYLES),
        ("Spreads/Spread_s1.xml", &spread),
        ("Stories/Story_st1.xml", &pkg::story(pkg::STORY_BODY)),
    ])
}

fn page_of(doc: &paged_scene::Document) -> Option<u32> {
    doc.spreads[0]
        .spread
        .rectangles
        .iter()
        .find(|r| r.self_id.as_deref() == Some("r1"))
        .and_then(|r| r.placed_pdf.as_ref())
        .and_then(|p| p.page_number)
}

fn set_page(n: Option<f32>) -> Operation {
    Operation::SetProperty {
        node: NodeId::Rectangle("r1".into()),
        path: PropertyPath::FramePdfPage,
        value: Value::Length(n),
    }
}

#[test]
fn an_unedited_pdf_attribute_saves_back_byte_identical() {
    let src = source();
    let doc = pkg::open(&src);
    assert_eq!(page_of(&doc), Some(1));
    pkg::assert_same_package(&src, &write_idml(&doc, &src).expect("write"));
}

#[test]
fn a_page_set_is_written_and_read_back_and_its_undo_restores_the_source() {
    let src = source();
    let mut doc = pkg::open(&src);
    let inverse = apply(&mut doc, &set_page(Some(2.0))).expect("set");
    let out = write_idml(&doc, &src).expect("write");
    let spread = pkg::entry(&out, "Spreads/Spread_s1.xml").expect("spread");
    assert!(
        spread.contains(
            r#"<PDFAttribute PageNumber="2" PDFCrop="CropMedia" TransparentBackground="true"/>"#
        ),
        "{spread}"
    );
    let back = pkg::open(&out);
    assert_eq!(page_of(&back), Some(2));
    apply(&mut doc, &inverse.inverse).expect("undo");
    assert_eq!(page_of(&doc), Some(1));
    pkg::assert_same_package(&src, &write_idml(&doc, &src).expect("write"));
}

#[test]
fn a_page_on_a_pdf_without_the_attribute_gains_one() {
    let without = FRAME.replace(
        r#"<PDFAttribute PageNumber="1" PDFCrop="CropMedia" TransparentBackground="true" />"#,
        "",
    );
    let spread = pkg::SPREAD.replace("</Spread>", &format!("{without}\n</Spread>"));
    let src = pkg::package(&[
        ("designmap.xml", &pkg::designmap("")),
        ("Resources/Styles.xml", pkg::STYLES),
        ("Spreads/Spread_s1.xml", &spread),
        ("Stories/Story_st1.xml", &pkg::story(pkg::STORY_BODY)),
    ]);
    let mut doc = pkg::open(&src);
    assert_eq!(page_of(&doc), None);
    apply(&mut doc, &set_page(Some(3.0))).expect("set");
    let out = write_idml(&doc, &src).expect("write");
    let spread = pkg::entry(&out, "Spreads/Spread_s1.xml").expect("spread");
    assert!(
        spread.contains(r#"<PDFAttribute PageNumber="3"/><Link Self="l1""#),
        "{spread}"
    );
    assert_eq!(page_of(&pkg::open(&out)), Some(3));
}
