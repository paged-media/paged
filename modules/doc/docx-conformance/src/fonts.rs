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

//! Doc ADR 626 — documents that embed fonts the way Word saves them: an
//! obfuscated OpenType part per face (`word/fonts/fontN.odttf`), listed per
//! typeface in `word/fontTable.xml`, whose own relationships name the parts.

use paged_ooxml::fonts::obfuscate;

use super::{zip_parts, CONTENT_TYPES, DOC_RELS, ROOT_RELS, STYLES};

/// One embedded face of [`embedded_fonts_docx`].
pub struct EmbedFace<'a> {
    pub typeface: &'a str,
    /// `embedRegular`, `embedBold`, `embedItalic` or `embedBoldItalic`.
    pub slot: &'a str,
    /// The GUID that unlocks the part, `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`.
    pub key: &'a str,
    /// The OpenType file as it is; the builder obfuscates it.
    pub font: &'a [u8],
    pub subsetted: bool,
}

/// The GUID the fixtures use for their `n`th face.
pub fn font_key(n: usize) -> String {
    format!("{{0A1B2C3D-4E5F-4A6B-8C7D-{n:012X}}}")
}

/// A document with one paragraph set in the first face's typeface and
/// `faces` embedded.
pub fn embedded_fonts_docx(faces: &[EmbedFace]) -> Vec<u8> {
    let first = faces.first().map(|f| f.typeface).unwrap_or("Calibri");
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="{first}" w:hAnsi="{first}" w:cs="{first}"/><w:sz w:val="48"/></w:rPr><w:t>Embedded fonts travel with the document</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let mut table = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
    );
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
    let mut typefaces: Vec<&str> = Vec::new();
    for f in faces {
        if !typefaces.contains(&f.typeface) {
            typefaces.push(f.typeface);
        }
    }
    for tf in typefaces {
        table.push_str(&format!(r#"<w:font w:name="{tf}"><w:charset w:val="00"/>"#));
        for (n, f) in faces.iter().enumerate().filter(|(_, f)| f.typeface == tf) {
            let id = format!("rId{}", n + 1);
            let name = format!("fonts/font{}.odttf", n + 1);
            table.push_str(&format!(
                r#"<w:{} r:id="{id}" w:fontKey="{}"{}/>"#,
                f.slot,
                f.key,
                if f.subsetted {
                    r#" w:subsetted="1""#
                } else {
                    ""
                }
            ));
            rels.push_str(&format!(
                r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="{name}"/>"#
            ));
            parts.push((
                format!("word/{name}"),
                obfuscate(f.font, f.key).expect("a GUID key"),
            ));
        }
        table.push_str("</w:font>");
    }
    table.push_str("</w:fonts>");
    rels.push_str("</Relationships>");
    let content_types = CONTENT_TYPES
        .replace(
            r#"<Default Extension="txt""#,
            r#"<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>
  <Default Extension="txt""#,
        )
        .replace(
            "</Types>",
            r#"  <Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>
</Types>"#,
        );
    let doc_rels = DOC_RELS.replace(
        "</Relationships>",
        r#"  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>
</Relationships>"#,
    );
    let mut all: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", doc_rels.as_bytes()),
        ("word/styles.xml", STYLES.as_bytes()),
        ("word/fontTable.xml", table.as_bytes()),
        ("word/_rels/fontTable.xml.rels", rels.as_bytes()),
    ];
    for (name, bytes) in &parts {
        all.push((name.as_str(), bytes.as_slice()));
    }
    zip_parts(&all)
}
