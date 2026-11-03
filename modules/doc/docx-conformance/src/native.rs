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

//! Fixtures of the native open's fallbacks (doc ADR 625): endnotes, and
//! breaks in paragraphs that keep their invented style.

use crate::zip_parts;

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main""#;
const ROOT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

/// `[Content_Types].xml` for the main document and the given parts, written
/// by the owner (`paged_ooxml::content_types`).
fn content_types(parts: &[(&str, &str)]) -> String {
    let mut c = paged_ooxml::content_types::ContentTypes::new();
    c.add_default(
        "rels",
        "application/vnd.openxmlformats-package.relationships+xml",
    );
    c.add_default("xml", "application/xml");
    c.add_override(
        "/word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    );
    for (part, kind) in parts {
        c.add_override(
            part,
            &format!("application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"),
        );
    }
    c.render()
}

fn t(text: &str) -> String {
    format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

/// Two paragraphs with two endnotes and a footnote between them, so the
/// endnotes' order and the mix with a footnote are both seen.
pub fn endnote_body_docx() -> Vec<u8> {
    let body = format!(
        r#"<w:p>{}<w:r><w:endnoteReference w:id="1"/></w:r>{}</w:p><w:p>{}<w:r><w:footnoteReference w:id="1"/></w:r>{}<w:r><w:endnoteReference w:id="2"/></w:r>{}</w:p><w:p>{}</w:p>"#,
        t("First paragraph with an endnote"),
        t(" and text after."),
        t("Second paragraph with a footnote"),
        t(" and an endnote"),
        t("."),
        t("Closing line.")
    );
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {W}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let notes = |root: &str, el: &str, a: &str, b: &str| {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:{root} {W}><w:{el} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:{el}><w:{el} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:{el}>{a}{b}</w:{root}>"#
        )
    };
    let note = |el: &str, id: u32, text: &str| {
        format!(r#"<w:{el} w:id="{id}"><w:p>{}</w:p></w:{el}>"#, t(text))
    };
    let endnotes = notes(
        "endnotes",
        "endnote",
        &note("endnote", 1, "First endnote."),
        &note("endnote", 2, "Second endnote."),
    );
    let footnotes = notes(
        "footnotes",
        "footnote",
        &note("footnote", 1, "A footnote."),
        "",
    );
    let types = content_types(&[
        ("/word/footnotes.xml", "footnotes"),
        ("/word/endnotes.xml", "endnotes"),
    ]);
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/></Relationships>"#;
    zip_parts(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", ROOT.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/footnotes.xml", footnotes.as_bytes()),
        ("word/endnotes.xml", endnotes.as_bytes()),
    ])
}

/// A paragraph style with a size, a character style that sets the size too
/// (so the paragraph keeps its invented style), a break inside such a
/// paragraph, and a paragraph of only a page break ending a section.
pub fn break_kept_body_docx() -> Vec<u8> {
    let br = r#"<w:r><w:br w:type="page"/></w:r>"#;
    let body = format!(
        r#"<w:p><w:pPr><w:pStyle w:val="Big"/><w:spacing w:line="480" w:lineRule="atLeast"/></w:pPr>{}<w:r><w:rPr><w:rStyle w:val="Small"/></w:rPr><w:t xml:space="preserve">small </w:t></w:r>{br}{}</w:p><w:p>{}</w:p><w:p><w:pPr><w:pStyle w:val="Big"/></w:pPr>{br}</w:p><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>{}</w:p></w:tc></w:tr></w:tbl><w:p>{}</w:p>"#,
        t("Before the break "),
        t("after the break"),
        t("Plain paragraph."),
        t("In a table."),
        t("Last paragraph.")
    );
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {W}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let styles = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Big"><w:name w:val="Big"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="character" w:styleId="Small"><w:name w:val="Small"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style></w:styles>"#
    );
    let types = content_types(&[("/word/styles.xml", "styles")]);
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;
    zip_parts(&[
        ("[Content_Types].xml", types.as_bytes()),
        ("_rels/.rels", ROOT.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/styles.xml", styles.as_bytes()),
    ])
}
