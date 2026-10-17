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

//! The ZIP metadata of everything the engine writes: an edited `.pptx` and
//! the IDML a deck opens as. It must be a function of the parts alone: no
//! wall-clock timestamp, no build-host `version made by`, no extra fields,
//! data descriptors or ZIP64 records. These are the values every written
//! file has carried so far; a `zip` upgrade that changes one fails here.
//! An unchanged deck is not re-zipped at all: export returns its bytes.

use std::path::PathBuf;

use paged_ooxml::OpcPackage;
use pptx_export::{export, ExportPlan, SlidePlan};

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// Check every entry's central and local header against the fixed values.
fn assert_fixed_metadata(zip: &[u8], what: &str) {
    assert!(
        !zip.windows(4)
            .any(|w| w == b"PK\x06\x06" || w == b"PK\x07\x08"),
        "{what}: no ZIP64 end record and no data descriptor"
    );
    let eocd = zip
        .windows(4)
        .rposition(|w| w == b"PK\x05\x06")
        .expect("end of central directory");
    assert_eq!(u16_at(zip, eocd + 20), 0, "{what}: archive comment");
    let mut at = u32_at(zip, eocd + 16) as usize;
    for _ in 0..u16_at(zip, eocd + 10) {
        assert_eq!(&zip[at..at + 4], b"PK\x01\x02");
        let name_len = u16_at(zip, at + 28) as usize;
        let name = String::from_utf8_lossy(&zip[at + 46..at + 46 + name_len]).into_owned();
        let method = u16_at(zip, at + 10);
        // Stored files need 1.0, deflated ones 2.0; made by Unix (3).
        let needed = if method == 0 { 10 } else { 20 };
        assert_eq!(
            u16_at(zip, at + 4),
            0x0300 | needed,
            "{what} {name}: made by"
        );
        assert_eq!(u16_at(zip, at + 6), needed, "{what} {name}: needed");
        assert_eq!(u16_at(zip, at + 8), 0, "{what} {name}: flags");
        // 1980-01-01 00:00 in MS-DOS time and date.
        assert_eq!(u16_at(zip, at + 12), 0, "{what} {name}: time");
        assert_eq!(u16_at(zip, at + 14), (1 << 5) | 1, "{what} {name}: date");
        assert_eq!(u16_at(zip, at + 30), 0, "{what} {name}: extra");
        assert_eq!(u16_at(zip, at + 32), 0, "{what} {name}: comment");
        assert_eq!(u32_at(zip, at + 38), 0o100644 << 16, "{what} {name}: mode");
        let local = u32_at(zip, at + 42) as usize;
        assert_eq!(&zip[local..local + 4], b"PK\x03\x04");
        assert_eq!(
            u16_at(zip, local + 4),
            needed,
            "{what} {name}: local needed"
        );
        assert_eq!(u16_at(zip, local + 6), 0, "{what} {name}: local flags");
        assert_eq!(u16_at(zip, local + 10), 0, "{what} {name}: local time");
        assert_eq!(
            u16_at(zip, local + 12),
            (1 << 5) | 1,
            "{what} {name}: local date"
        );
        assert_eq!(u16_at(zip, local + 28), 0, "{what} {name}: local extra");
        at += 46 + name_len;
    }
}

fn as_is(bytes: &[u8]) -> ExportPlan {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    ExportPlan {
        slides: ir
            .slides
            .iter()
            .map(|s| SlidePlan {
                source_part: s.part.clone(),
                hidden: s.hidden,
                notes: None,
                content_edited: false,
            })
            .collect(),
    }
}

#[test]
fn an_edited_deck_is_written_with_fixed_zip_metadata() {
    let bytes = fixture("placeholders");
    let mut plan = as_is(&bytes);
    plan.slides[0].hidden = !plan.slides[0].hidden;
    plan.slides.pop();
    let out = export(&bytes, &plan).unwrap();
    assert_ne!(out.bytes, bytes, "the edit re-wrote the package");
    assert_fixed_metadata(&out.bytes, "edited deck");

    // Every part the edit did not reach keeps its bytes.
    let (before, after) = (
        OpcPackage::read(&bytes).unwrap(),
        OpcPackage::read(&out.bytes).unwrap(),
    );
    let media: Vec<&str> = before
        .file_names()
        .filter(|n| n.starts_with("ppt/media/") || n.starts_with("ppt/theme/"))
        .collect();
    assert!(!media.is_empty(), "the fixture has untouched parts");
    for name in media {
        assert_eq!(before.part(name), after.part(name), "{name}");
    }
}

#[test]
fn the_idml_a_deck_opens_as_is_written_with_fixed_zip_metadata() {
    let (idml, _, _) = slide_js::import(&fixture("placeholders"), "deck").unwrap();
    assert_fixed_metadata(&idml, "idml");
    // The mimetype comes first and stored, as IDML requires.
    assert_eq!(&idml[30..38], b"mimetype");
    assert_eq!(u16_at(&idml, 8), 0, "mimetype is stored");
}
