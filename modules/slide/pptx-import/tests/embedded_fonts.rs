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

//! A deck's embedded fonts. PowerPoint stores each embedded face as an
//! Embedded OpenType part (`ppt/fonts/fontN.fntdata`); every one it wrote in
//! the decks examined (266 parts, PowerPoint for Windows and Mac) is
//! compressed with MicroType Express (EOT flags 0x4 or 0x5). The importer
//! cannot read such a face, and the host has no door for a document face, so
//! the deck's text in that font is drawn in a substitute. The import says so
//! instead of substituting silently.
//!
//! The deck here is a PowerPoint-authored fixture with one embedded font
//! added: the list entry, its relationship and a part holding an EOT header
//! as PowerPoint writes it (the payload is not a font; nothing reads it).

use std::io::{Read, Write};

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures")
        .join(format!("{name}.pptx"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// An EOT header (version 0x00020002) with `flags`, then `payload`.
fn eot(flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut b = vec![0u8; 82];
    let size = (b.len() + payload.len()) as u32;
    b[0..4].copy_from_slice(&size.to_le_bytes());
    b[4..8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    b[8..12].copy_from_slice(&0x0002_0002u32.to_le_bytes());
    b[12..16].copy_from_slice(&flags.to_le_bytes());
    b[34..36].copy_from_slice(&[0x4C, 0x50]); // MagicNumber 0x504C
    b.extend_from_slice(payload);
    b
}

/// `base` with one embedded font: `typeface`, its regular face in `face`.
fn with_embedded_font(base: &[u8], typeface: &str, face: &[u8]) -> Vec<u8> {
    let mut zin = zip::ZipArchive::new(std::io::Cursor::new(base)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for i in 0..zin.len() {
        let mut f = zin.by_index(i).unwrap();
        let name = f.name().to_string();
        let mut s = Vec::new();
        f.read_to_end(&mut s).unwrap();
        let s = match name.as_str() {
            "ppt/presentation.xml" => String::from_utf8(s)
                .unwrap()
                .replacen(
                    "<p:defaultTextStyle",
                    &format!(
                        r#"<p:embeddedFontLst><p:embeddedFont><p:font typeface="{typeface}"/><p:regular r:id="rIdEmbFont1"/></p:embeddedFont></p:embeddedFontLst><p:defaultTextStyle"#
                    ),
                    1,
                )
                .into_bytes(),
            "ppt/_rels/presentation.xml.rels" => String::from_utf8(s)
                .unwrap()
                .replacen(
                    "</Relationships>",
                    r#"<Relationship Id="rIdEmbFont1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/></Relationships>"#,
                    1,
                )
                .into_bytes(),
            "[Content_Types].xml" => String::from_utf8(s)
                .unwrap()
                .replacen(
                    "<Default ",
                    r#"<Default Extension="fntdata" ContentType="application/x-fontdata"/><Default "#,
                    1,
                )
                .into_bytes(),
            _ => s,
        };
        out.start_file(name, opts).unwrap();
        out.write_all(&s).unwrap();
    }
    out.start_file("ppt/fonts/font1.fntdata", opts).unwrap();
    out.write_all(face).unwrap();
    out.finish().unwrap().into_inner()
}

#[test]
fn an_embedded_font_compressed_as_powerpoint_writes_it_is_named_as_not_used() {
    let bytes = with_embedded_font(
        &fixture_bytes("geometry"),
        "Montserrat",
        &eot(0x5, &[0xA5; 64]),
    );
    let deck = pptx_import::import_pptx(&bytes).unwrap();
    assert_eq!(deck.embedded_fonts.len(), 1);
    assert_eq!(
        deck.embedded_fonts[0].regular.as_deref(),
        Some("ppt/fonts/font1.fntdata")
    );
    let line = deck
        .diagnostics
        .iter()
        .find(|d| d.contains("Montserrat"))
        .unwrap_or_else(|| {
            panic!(
                "no diagnostic names the embedded font: {:?}",
                deck.diagnostics
            )
        });
    assert!(line.contains("MicroType Express"), "{line}");
    assert!(line.contains("substitute"), "{line}");
}

#[test]
fn an_embedded_font_in_another_form_is_named_as_not_used_too() {
    // A face stored as a bare TrueType file: still not loaded by the host.
    let bytes = with_embedded_font(
        &fixture_bytes("geometry"),
        "Brand",
        &[0, 1, 0, 0, 0, 4, 0, 0],
    );
    let deck = pptx_import::import_pptx(&bytes).unwrap();
    let line = deck
        .diagnostics
        .iter()
        .find(|d| d.contains("Brand"))
        .unwrap_or_else(|| {
            panic!(
                "no diagnostic names the embedded font: {:?}",
                deck.diagnostics
            )
        });
    assert!(!line.contains("MicroType Express"), "{line}");
    assert!(line.contains("substitute"), "{line}");
}

#[test]
fn a_deck_without_embedded_fonts_says_nothing_about_them() {
    let deck = pptx_import::import_pptx(&fixture_bytes("geometry")).unwrap();
    assert!(deck.embedded_fonts.is_empty());
    assert!(
        !deck.diagnostics.iter().any(|d| d.contains("embedded font")),
        "{:?}",
        deck.diagnostics
    );
}
