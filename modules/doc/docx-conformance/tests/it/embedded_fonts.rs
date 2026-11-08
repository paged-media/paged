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

//! Doc ADR 626 — a document's embedded fonts. Word's obfuscated `.odttf`
//! parts are unlocked with their GUID, each face is held to its own licence
//! (OS/2 `fsType`), and the font parts stay byte-identical on save.

#![allow(non_snake_case)]

use docx_conformance::{embedded_fonts_docx, font_key, EmbedFace};
use docx_export::{EditSet, RunEdit};
use docx_js::DocSession;
use paged_ooxml::OpcPackage;

/// The smallest OpenType file the reader accepts: a table directory with an
/// OS/2 table whose `fsType` is `fs_type`, and a marker so faces differ.
fn font(fs_type: u16, marker: u8) -> Vec<u8> {
    let mut f = vec![0, 1, 0, 0, 0, 1, 0, 16, 0, 0, 0, 0];
    f.extend_from_slice(b"OS/2");
    f.extend_from_slice(&[0, 0, 0, 0]); // checksum
    f.extend_from_slice(&28u32.to_be_bytes()); // offset
    f.extend_from_slice(&40u32.to_be_bytes()); // length
    let mut os2 = vec![0u8; 40];
    os2[8..10].copy_from_slice(&fs_type.to_be_bytes());
    os2[39] = marker;
    f.extend_from_slice(&os2);
    f
}

fn faces<'a>(fonts: &'a [Vec<u8>], keys: &'a [String]) -> Vec<EmbedFace<'a>> {
    let slots = [
        "embedRegular",
        "embedBold",
        "embedItalic",
        "embedBoldItalic",
    ];
    fonts
        .iter()
        .enumerate()
        .map(|(n, f)| EmbedFace {
            typeface: "Fixture Sans",
            slot: slots[n],
            key: &keys[n],
            font: f,
            subsetted: n == 1,
        })
        .collect()
}

#[test]
fn every_slot_is_unlocked_and_held_to_its_licence__feat__doc_embedded_fonts() {
    // Installable, editable, preview and print, restricted.
    let fonts = [
        font(0, 1),
        font(0x0008, 2),
        font(0x0004, 3),
        font(0x0002, 4),
    ];
    let keys: Vec<String> = (1..=4).map(font_key).collect();
    let bytes = embedded_fonts_docx(&faces(&fonts, &keys));
    let session = DocSession::load(&bytes).expect("load");
    let out = session.embedded_fonts();
    assert_eq!(out.faces.len(), 4);
    let uses: Vec<_> = out.faces.iter().map(|f| f.use_).collect();
    assert_eq!(
        uses,
        ["editable", "editable", "previewAndPrint", "restricted"]
    );
    let styles: Vec<_> = out.faces.iter().map(|f| f.style.as_str()).collect();
    assert_eq!(styles, ["Regular", "Bold", "Italic", "Bold Italic"]);
    assert_eq!(
        out.faces.iter().map(|f| f.fs_type).collect::<Vec<_>>(),
        [Some(0), Some(8), Some(4), Some(2)]
    );
    assert_eq!(
        out.faces.iter().map(|f| f.subset).collect::<Vec<_>>(),
        [false, true, false, false]
    );
    // The usable faces' bytes are the original files, back to back; a face
    // that may not be used has none.
    assert_eq!(out.faces[0].offset, 0);
    assert_eq!(out.faces[0].length, fonts[0].len());
    assert_eq!(out.faces[1].offset, fonts[0].len());
    assert_eq!(out.faces[1].length, fonts[1].len());
    assert_eq!(out.faces[2].length, 0);
    assert_eq!(out.faces[3].length, 0);
    assert_eq!(out.data, [fonts[0].clone(), fonts[1].clone()].concat());
    assert_eq!(out.diagnostics.len(), 2);
    assert!(out.diagnostics[0].contains("preview and print"));
    assert!(out.diagnostics[1].contains("not licensed for embedding"));
}

#[test]
fn a_wrong_key_or_a_missing_part_is_told_never_used__feat__doc_embedded_fonts() {
    let fonts = [font(0, 1), font(0, 2)];
    // The second face is locked with a different key than the table names.
    let keys = [font_key(1), font_key(2)];
    let bytes = embedded_fonts_docx(&faces(&fonts, &keys));
    let mut pkg = OpcPackage::read(&bytes).unwrap();
    let table = String::from_utf8(pkg.part("word/fontTable.xml").unwrap().to_vec())
        .unwrap()
        .replace(&font_key(2), &font_key(9));
    pkg.set_part("word/fontTable.xml", table.into_bytes());
    let session = DocSession::load(&pkg.write().unwrap()).expect("load");
    let out = session.embedded_fonts();
    assert_eq!(out.faces[0].use_, "editable");
    assert_eq!(out.faces[1].use_, "unreadable");
    assert_eq!(out.faces[1].length, 0);

    // A relationship whose part is gone.
    let mut pkg = OpcPackage::read(&bytes).unwrap();
    let rels = String::from_utf8(pkg.part("word/_rels/fontTable.xml.rels").unwrap().to_vec())
        .unwrap()
        .replace("fonts/font2.odttf", "fonts/gone.odttf");
    pkg.set_part("word/_rels/fontTable.xml.rels", rels.into_bytes());
    let session = DocSession::load(&pkg.write().unwrap()).expect("load");
    let out = session.embedded_fonts();
    assert_eq!(out.faces[1].use_, "missing");
    assert!(out.diagnostics[0].contains("does not hold"));
}

#[test]
fn a_document_without_embedded_fonts_has_none__feat__doc_embedded_fonts() {
    let session = DocSession::load(&docx_conformance::memo_docx()).expect("load");
    let out = session.embedded_fonts();
    assert!(out.faces.is_empty() && out.diagnostics.is_empty() && out.data.is_empty());
}

#[test]
fn the_font_parts_are_byte_identical_after_an_edit__feat__doc_embedded_fonts() {
    let fonts = [font(0, 1), font(0, 2)];
    let keys = [font_key(1), font_key(2)];
    let bytes = embedded_fonts_docx(&faces(&fonts, &keys));
    let session = DocSession::load(&bytes).expect("load");
    // The zero-edit save is the file; an edited save changes the body only.
    assert_eq!(session.save_verbatim(), bytes);
    let edits = EditSet {
        runs: vec![RunEdit::text(0, 0, "Edited line")],
        ..Default::default()
    };
    let (edited, skips) = session.save_edited(&edits).expect("save");
    assert!(skips.is_empty(), "{skips:?}");
    let before = OpcPackage::read(&bytes).unwrap();
    let after = OpcPackage::read(&edited).unwrap();
    for part in [
        "word/fontTable.xml",
        "word/_rels/fontTable.xml.rels",
        "word/fonts/font1.odttf",
        "word/fonts/font2.odttf",
    ] {
        assert_eq!(after.part(part), before.part(part), "{part}");
    }
    assert_ne!(
        after.part("word/document.xml"),
        before.part("word/document.xml")
    );
    // And the saved file still carries the same faces.
    let again = DocSession::load(&edited).unwrap().embedded_fonts();
    assert_eq!(again.data, session.embedded_fonts().data);
}
