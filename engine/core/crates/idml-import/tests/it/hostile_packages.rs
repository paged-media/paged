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

//! Packages built to hurt the reader: a decompression bomb (honest about
//! its size, lying small, lying huge), a truncated or corrupted archive,
//! bytes that are no zip at all, an archive with too many entries. Each
//! is an error the caller can show, never a panic and never an
//! allocation the limits do not allow.

use std::io::{Cursor, Write};

use idml_import::zip_budget::{BudgetError, ReadLimits};
use idml_import::{open_source_archive, open_source_archive_with, ParseError};

const MIMETYPE: &[u8] = b"application/vnd.adobe.indesign-idml-package";

/// A package of `mimetype`, a designmap and the given `(name, body)`
/// entries, deflated.
fn package(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(MIMETYPE).unwrap();
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("designmap.xml", deflated).unwrap();
        zip.write_all(b"<Document/>").unwrap();
        for (name, body) in entries {
            zip.start_file(*name, deflated).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Rewrite the uncompressed size the headers of entry `name` DECLARE
/// (local header and central directory), leaving the data alone.
fn declare_size(package: &mut [u8], name: &str, size: u32) {
    let mut patched = 0;
    let mut i = 0;
    while i + 46 <= package.len() {
        // Local file header: size at +22, name length at +26, name at +30.
        // Central directory header: size at +24, name length at +28, name at +46.
        let (size_at, len_at, name_at) = match u32_at(package, i) {
            0x0403_4b50 => (i + 22, i + 26, i + 30),
            0x0201_4b50 => (i + 24, i + 28, i + 46),
            _ => {
                i += 1;
                continue;
            }
        };
        let len = u16::from_le_bytes([package[len_at], package[len_at + 1]]) as usize;
        if package.get(name_at..name_at + len) == Some(name.as_bytes()) {
            package[size_at..size_at + 4].copy_from_slice(&size.to_le_bytes());
            patched += 1;
        }
        i += 4;
    }
    assert_eq!(patched, 2, "local and central header of {name}");
}

fn limits(entry_bytes: u64, total_bytes: u64) -> ReadLimits {
    ReadLimits {
        entry_bytes,
        total_bytes,
        ..ReadLimits::default()
    }
}

const MIB: usize = 1 << 20;

#[test]
fn a_sound_package_opens_under_the_default_limits() {
    let archive = open_source_archive(&package(&[("Stories/a.xml", b"<Story/>")])).expect("opens");
    assert_eq!(archive.entries.len(), 3);
}

#[test]
fn an_entry_past_the_entry_limit_is_refused() {
    // 8 MiB of zeros deflate to a few kilobytes.
    let bomb = package(&[("Stories/bomb.xml", &vec![0u8; 8 * MIB])]);
    assert!(bomb.len() < 64 * 1024, "{} bytes", bomb.len());
    let err = open_source_archive_with(&bomb, limits(MIB as u64, 64 * MIB as u64)).unwrap_err();
    match err {
        ParseError::Budget(BudgetError::EntryTooLarge { name, limit }) => {
            assert_eq!(name, "Stories/bomb.xml");
            assert_eq!(limit, MIB as u64);
        }
        other => panic!("{other}"),
    }
}

#[test]
fn entries_past_the_total_are_refused_before_or_while_reading() {
    let part = vec![0u8; MIB];
    let bomb = package(&[
        ("Stories/a.xml", &part),
        ("Stories/b.xml", &part),
        ("Stories/c.xml", &part),
    ]);
    // Honest headers: the declared sizes alone say it is too much.
    let err = open_source_archive_with(&bomb, limits(2 * MIB as u64, 2 * MIB as u64)).unwrap_err();
    assert!(
        matches!(
            err,
            ParseError::Budget(BudgetError::DeclaredTooLarge { limit, .. }) if limit == 2 * MIB as u64
        ),
        "{err}"
    );
    // Headers that understate it: the read itself stops at the total.
    let mut lying = bomb.clone();
    for name in ["Stories/a.xml", "Stories/b.xml", "Stories/c.xml"] {
        declare_size(&mut lying, name, 16);
    }
    let result = open_source_archive_with(&lying, limits(2 * MIB as u64, 2 * MIB as u64));
    match result {
        // Stopped by the budget, or by the zip reader noticing the lie.
        Err(_) => {}
        Ok(archive) => {
            let held: usize = archive.entries.values().map(|b| b.len()).sum();
            assert!(held <= 2 * MIB, "held {held} bytes past the total");
        }
    }
}

#[test]
fn a_bomb_declared_small_never_reads_past_the_limit() {
    let mut bomb = package(&[("Stories/bomb.xml", &vec![0u8; 8 * MIB])]);
    declare_size(&mut bomb, "Stories/bomb.xml", 10);
    match open_source_archive_with(&bomb, limits(MIB as u64, 64 * MIB as u64)) {
        Err(_) => {}
        Ok(archive) => {
            let held = archive.entries["Stories/bomb.xml"].len();
            assert!(held <= MIB, "held {held} bytes past the entry limit");
        }
    }
}

#[test]
fn a_bomb_declared_huge_is_refused_before_it_is_read() {
    let mut bomb = package(&[("Stories/bomb.xml", b"<Story/>")]);
    // Just under 4 GiB, past the default total of 1 GiB.
    declare_size(&mut bomb, "Stories/bomb.xml", 0xFFFF_FF00);
    let err = open_source_archive(&bomb).unwrap_err();
    assert!(
        matches!(
            err,
            ParseError::Budget(BudgetError::DeclaredTooLarge {
                declared,
                ..
            }) if declared >= 0xFFFF_FF00
        ),
        "{err}"
    );
    // Under limits that let the claim through, the claim still buys no
    // allocation: the entry reads as the few bytes it holds, or fails.
    let roomy = limits(u64::MAX, u64::MAX);
    if let Ok(archive) = open_source_archive_with(&bomb, roomy) {
        assert_eq!(&archive.entries["Stories/bomb.xml"][..], b"<Story/>");
    }
}

#[test]
fn too_many_entries_are_refused() {
    let sound = package(&[
        ("Stories/a.xml", b"<Story/>"),
        ("Stories/b.xml", b"<Story/>"),
        ("Stories/c.xml", b"<Story/>"),
    ]);
    let few = ReadLimits {
        entries: 4,
        ..ReadLimits::default()
    };
    let err = open_source_archive_with(&sound, few).unwrap_err();
    assert!(
        matches!(
            err,
            ParseError::Budget(BudgetError::TooManyEntries { count: 5, limit: 4 })
        ),
        "{err}"
    );
    let enough = ReadLimits {
        entries: 5,
        ..ReadLimits::default()
    };
    assert!(open_source_archive_with(&sound, enough).is_ok());
}

#[test]
fn bytes_that_are_no_zip_are_an_error() {
    for bytes in [
        &b""[..],
        b"PK",
        b"not a zip at all",
        b"<?xml version=\"1.0\"?><Document/>",
        &[0u8; 4096],
    ] {
        assert!(open_source_archive(bytes).is_err());
        assert!(idml_import::import_idml_doc(bytes).is_err());
    }
}

#[test]
fn a_truncated_archive_is_an_error_at_every_cut() {
    let sound = package(&[("Stories/a.xml", &b"<Story>some text</Story>".repeat(64))]);
    // Every prefix: the central directory is cut off, or cut into.
    for cut in 0..sound.len() {
        assert!(
            open_source_archive(&sound[..cut]).is_err(),
            "a package cut at {cut} of {} opened",
            sound.len()
        );
    }
}

#[test]
fn corrupted_entry_data_is_an_error_or_harmless() {
    let sound = package(&[("Stories/a.xml", &b"<Story>some text</Story>".repeat(64))]);
    // Flip each byte in turn: a damaged header, name, deflate stream or
    // checksum must surface as an error (or leave the read sound), and
    // must never panic.
    for at in 0..sound.len() {
        let mut bad = sound.clone();
        bad[at] ^= 0xFF;
        let _ = open_source_archive(&bad);
    }
}
