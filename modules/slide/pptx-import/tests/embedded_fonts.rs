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
//! Embedded OpenType part (`ppt/fonts/fontN.fntdata`), compressed with
//! MicroType Express. The importer decodes every face whose licence lets an
//! editable document use it, and names every other one with the reason its
//! text is drawn in a substitute.
//!
//! The `fonts` and `fonts-full` fixtures are decks PowerPoint wrote with
//! their fonts embedded (OFL faces: Lato in four styles, Gloria Hallelujah,
//! Caveat), as subsets and whole. The licence cases change the `fsType` a
//! face's EOT header carries.

use std::io::{Read, Write};

use pptx_import::fonts::FaceUse;

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../slide-conformance/fixtures")
        .join(format!("{name}.pptx"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn read_faces(bytes: &[u8]) -> (pptx_core::Presentation, pptx_import::fonts::EmbeddedFaces) {
    let deck = pptx_import::import_pptx(bytes).unwrap();
    let pkg = paged_ooxml::OpcPackage::read(bytes).unwrap();
    let faces = pptx_import::fonts::faces(&pkg, &deck.embedded_fonts);
    (deck, faces)
}

/// `base` with its parts rewritten by `edit` (name, bytes) and `extra` added.
fn rewrite(
    base: &[u8],
    edit: impl Fn(&str, Vec<u8>) -> Vec<u8>,
    extra: &[(&str, Vec<u8>)],
) -> Vec<u8> {
    let mut zin = zip::ZipArchive::new(std::io::Cursor::new(base)).unwrap();
    let mut out = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for i in 0..zin.len() {
        let mut f = zin.by_index(i).unwrap();
        let name = f.name().to_string();
        let mut s = Vec::new();
        f.read_to_end(&mut s).unwrap();
        out.start_file(name.as_str(), opts).unwrap();
        out.write_all(&edit(&name, s)).unwrap();
    }
    for (name, bytes) in extra {
        out.start_file(*name, opts).unwrap();
        out.write_all(bytes).unwrap();
    }
    out.finish().unwrap().into_inner()
}

/// `base` with one embedded font: `typeface`, its regular face in `face`.
fn with_embedded_font(base: &[u8], typeface: &str, face: &[u8]) -> Vec<u8> {
    let list = format!(
        r#"<p:embeddedFontLst><p:embeddedFont><p:font typeface="{typeface}"/><p:regular r:id="rIdEmbFont1"/></p:embeddedFont></p:embeddedFontLst><p:defaultTextStyle"#
    );
    let rel = r#"<Relationship Id="rIdEmbFont1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/></Relationships>"#;
    let content_type =
        r#"<Default Extension="fntdata" ContentType="application/x-fontdata"/><Default "#;
    let xml = |s: Vec<u8>, from: &str, to: &str| {
        String::from_utf8(s)
            .unwrap()
            .replacen(from, to, 1)
            .into_bytes()
    };
    rewrite(
        base,
        |name, s| match name {
            "ppt/presentation.xml" => xml(s, "<p:defaultTextStyle", &list),
            "ppt/_rels/presentation.xml.rels" => xml(s, "</Relationships>", rel),
            "[Content_Types].xml" => xml(s, "<Default ", content_type),
            _ => s,
        },
        &[("ppt/fonts/font1.fntdata", face.to_vec())],
    )
}

/// The `fonts-full` deck with every face's EOT `fsType` set to `fs_type`.
fn with_fs_type(fs_type: u16) -> Vec<u8> {
    rewrite(
        &fixture_bytes("fonts-full"),
        |name, mut b| {
            if name.ends_with(".fntdata") {
                b[32..34].copy_from_slice(&fs_type.to_le_bytes());
            }
            b
        },
        &[],
    )
}

#[test]
fn every_face_powerpoint_embedded_is_decoded_for_the_document() {
    for (name, count) in [("fonts", 7), ("fonts-full", 5)] {
        let (deck, faces) = read_faces(&fixture_bytes(name));
        assert_eq!(faces.faces.len(), count, "{name}");
        assert!(
            faces.diagnostics.is_empty(),
            "{name}: {:?}",
            faces.diagnostics
        );
        assert!(
            !deck.diagnostics.iter().any(|d| d.contains("embedded font")),
            "{name}: {:?}",
            deck.diagnostics
        );
        for f in &faces.faces {
            assert_eq!(
                f.use_,
                FaceUse::Editable,
                "{name} {} {}",
                f.typeface,
                f.style
            );
            assert_eq!(f.fs_type, Some(0), "OFL faces are installable");
            assert_eq!(
                f.subset,
                name == "fonts",
                "{name} {} {}",
                f.typeface,
                f.style
            );
            let sfnt = f.sfnt.as_deref().unwrap();
            assert_eq!(&sfnt[0..4], &[0, 1, 0, 0], "a TrueType file");
        }
        let lato: Vec<&str> = faces
            .faces
            .iter()
            .filter(|f| f.typeface == "Lato")
            .map(|f| f.style)
            .collect();
        assert_eq!(lato, ["Regular", "Bold", "Italic", "Bold Italic"]);
    }
}

#[test]
fn a_face_licensed_for_preview_and_print_is_not_used_in_an_editable_deck() {
    let (_, faces) = read_faces(&with_fs_type(0x0004));
    assert_eq!(faces.faces.len(), 5);
    for f in &faces.faces {
        assert_eq!(f.use_, FaceUse::PreviewAndPrint);
        assert!(f.sfnt.is_none(), "never decompressed");
    }
    assert_eq!(faces.diagnostics.len(), 5);
    let line = faces
        .diagnostics
        .iter()
        .find(|d| d.contains("\u{201c}Lato\u{201d} (Bold Italic)"))
        .unwrap();
    assert!(line.contains("preview and print only"), "{line}");
    assert!(line.contains("substitute"), "{line}");
}

#[test]
fn restricted_and_bitmap_only_faces_are_not_used() {
    let (_, faces_r) = read_faces(&with_fs_type(0x0002));
    assert!(faces_r
        .faces
        .iter()
        .all(|f| f.use_ == FaceUse::Restricted && f.sfnt.is_none()));
    assert!(faces_r.diagnostics[0].contains("not licensed for embedding"));
    // Editable, but only its bitmaps may be embedded.
    let (_, faces_b) = read_faces(&with_fs_type(0x0208));
    assert!(faces_b
        .faces
        .iter()
        .all(|f| f.use_ == FaceUse::BitmapOnly && f.sfnt.is_none()));
    assert!(faces_b.diagnostics[0].contains("only its bitmaps"));
}

#[test]
fn the_least_restrictive_licence_bit_wins_and_editable_faces_are_used() {
    for fs_type in [0x0008, 0x000C, 0x000E, 0x0108] {
        let (_, faces) = read_faces(&with_fs_type(fs_type));
        assert!(
            faces.diagnostics.is_empty(),
            "{fs_type:#x}: {:?}",
            faces.diagnostics
        );
        assert!(faces
            .faces
            .iter()
            .all(|f| f.use_ == FaceUse::Editable && f.sfnt.is_some()));
    }
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

#[test]
fn a_face_that_cannot_be_read_is_named_with_the_reason() {
    // An EOT header as PowerPoint writes it over data that is not
    // MicroType Express.
    let bytes = with_embedded_font(
        &fixture_bytes("geometry"),
        "Montserrat",
        &eot(0x5, &[0xA5; 64]),
    );
    let (deck, faces) = read_faces(&bytes);
    assert_eq!(deck.embedded_fonts.len(), 1);
    assert_eq!(faces.faces[0].use_, FaceUse::Unreadable);
    let line = &faces.diagnostics[0];
    assert!(line.starts_with("ppt/fonts/font1.fntdata: "), "{line}");
    assert!(
        line.contains("\u{201c}Montserrat\u{201d} (Regular) could not be read"),
        "{line}"
    );
    assert!(line.contains("substitute"), "{line}");
    // Not a font at all.
    let bytes = with_embedded_font(&fixture_bytes("geometry"), "Brand", b"not a font");
    let (_, faces) = read_faces(&bytes);
    assert_eq!(faces.faces[0].use_, FaceUse::Unreadable);
    assert!(faces.diagnostics[0].contains("not an Embedded OpenType file"));
}

#[test]
fn a_bare_truetype_part_is_used_as_it_is() {
    // Some producers embed the font file itself instead of EOT.
    let (_, full) = read_faces(&fixture_bytes("fonts-full"));
    let ttf = full.faces[0].sfnt.clone().unwrap();
    let (_, faces) = read_faces(&with_embedded_font(
        &fixture_bytes("geometry"),
        "Brand",
        &ttf,
    ));
    assert!(faces.diagnostics.is_empty(), "{:?}", faces.diagnostics);
    assert_eq!(faces.faces[0].use_, FaceUse::Editable);
    assert_eq!(faces.faces[0].sfnt.as_deref(), Some(ttf.as_slice()));
}

#[test]
fn a_deck_without_embedded_fonts_says_nothing_about_them() {
    let (deck, faces) = read_faces(&fixture_bytes("geometry"));
    assert!(deck.embedded_fonts.is_empty());
    assert_eq!(faces, Default::default());
}
