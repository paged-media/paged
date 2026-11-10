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

//! Equations in a Word body (engine ADR 1090): an inline `m:oMath` between
//! runs, a display `m:oMathPara`, one with two lines, and plain text after;
//! and equations in table cells (the ADR's amendment 2).

use crate::native::content_types;
use crate::zip_parts;

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math""#;
const ROOT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

fn t(text: &str) -> String {
    format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

fn mr(text: &str) -> String {
    format!(
        r#"<m:r><w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr><m:t>{text}</m:t></m:r>"#
    )
}

/// The text before the inline equation of the first paragraph.
pub const EQUATION_LEAD: &str = "Area ";

/// The fixture's `word/document.xml`.
pub fn equations_document_xml() -> String {
    let frac = format!(
        "<m:f><m:num>{}</m:num><m:den>{}</m:den></m:f>",
        mr("a"),
        mr("b")
    );
    let quadratic = format!(
        r#"<m:oMathPara><m:oMath>{}<m:f><m:num>{}<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e>{}</m:e><m:sup>{}</m:sup></m:sSup>{}</m:e></m:rad></m:num><m:den>{}</m:den></m:f></m:oMath></m:oMathPara>"#,
        mr("x="),
        mr("−b±"),
        mr("b"),
        mr("2"),
        mr("−4ac"),
        mr("2a")
    );
    // Two lines: Word breaks a display paragraph at a break run (without
    // one its `m:oMath` children share a line).
    let two_lines = format!(
        "<m:oMathPara><m:oMath>{}</m:oMath><m:r><w:br/></m:r><m:oMath>{}</m:oMath></m:oMathPara>",
        mr("y=1"),
        mr("z=2")
    );
    let body = format!(
        "<w:p>{}<m:oMath>{frac}</m:oMath>{}</w:p><w:p>{quadratic}</w:p><w:p>{two_lines}</w:p><w:p>{}</w:p>",
        t(EQUATION_LEAD),
        t(" in square units."),
        t("Plain paragraph.")
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    )
}

/// The fixture: four paragraphs, three of them holding equations.
pub fn equations_docx() -> Vec<u8> {
    let document = equations_document_xml();
    let types = content_types(&[]);
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#;
    zip_parts(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", ROOT.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
    ])
}

/// The text before the inline equation of the first cell.
pub const CELL_EQUATION_LEAD: &str = "x = ";

/// A table of two cells: the first holds text and an inline fraction, the
/// second only a display equation; a paragraph of text after the table.
pub fn equations_in_cells_docx() -> Vec<u8> {
    let frac = format!(
        "<m:f><m:num>{}</m:num><m:den>{}</m:den></m:f>",
        mr("a"),
        mr("b")
    );
    let display = format!(
        "<m:oMathPara><m:oMath>{}<m:sSup><m:e>{}</m:e><m:sup>{}</m:sup></m:sSup></m:oMath></m:oMathPara>",
        mr("y="),
        mr("x"),
        mr("2")
    );
    let cell = |content: &str| {
        format!(r#"<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>{content}</w:tc>"#)
    };
    let body = format!(
        r#"<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid><w:tr>{}{}</w:tr></w:tbl><w:p>{}</w:p>"#,
        cell(&format!(
            "<w:p>{}<m:oMath>{frac}</m:oMath></w:p>",
            t(CELL_EQUATION_LEAD)
        )),
        cell(&format!("<w:p>{display}</w:p>")),
        t("After the table.")
    );
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let types = content_types(&[]);
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>"#;
    zip_parts(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", ROOT.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
    ])
}
