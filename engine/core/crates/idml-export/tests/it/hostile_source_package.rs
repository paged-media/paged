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

//! The writer re-reads the source package it is handed, so it meets the
//! same hostile input the reader does: bytes that are no zip, a truncated
//! archive, an entry that claims gigabytes. Each is a `WriteError`, never
//! a panic and never an allocation taken on the header's word.

use crate::pkg;

use idml_export::{idml_parts_hash, write_idml, write_paged, WriteError};
use idml_import::zip_budget::BudgetError;

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Rewrite the uncompressed size the headers of entry `name` DECLARE
/// (local header and central directory), leaving the data alone.
fn declare_size(package: &mut [u8], name: &str, size: u32) {
    let mut patched = 0;
    let mut i = 0;
    while i + 46 <= package.len() {
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

fn sound() -> Vec<u8> {
    pkg::simple("", pkg::STORY_BODY, pkg::STYLES)
}

#[test]
fn a_source_that_claims_gigabytes_is_refused() {
    let src = sound();
    let doc = pkg::open(&src);
    let mut bomb = src.clone();
    declare_size(&mut bomb, "Stories/Story_st1.xml", 0xFFFF_FF00);
    for result in [
        write_idml(&doc, &bomb),
        write_paged(&doc, &bomb, &Default::default(), 1),
    ] {
        let err = result.expect_err("refused");
        assert!(
            matches!(
                err,
                WriteError::Budget(BudgetError::DeclaredTooLarge { .. })
            ),
            "{err}"
        );
    }
    let err = idml_parts_hash(&bomb).expect_err("refused");
    assert!(
        matches!(
            err,
            WriteError::Budget(BudgetError::DeclaredTooLarge { .. })
        ),
        "{err}"
    );
}

#[test]
fn a_source_that_understates_an_entry_is_an_error_or_harmless() {
    let src = sound();
    let doc = pkg::open(&src);
    let mut lying = src.clone();
    declare_size(&mut lying, "Stories/Story_st1.xml", 3);
    // The zip reader may notice the lie or not; either way nothing panics.
    let _ = write_idml(&doc, &lying);
    let _ = idml_parts_hash(&lying);
}

#[test]
fn a_source_that_is_no_zip_or_is_cut_short_is_an_error() {
    let src = sound();
    let doc = pkg::open(&src);
    for bytes in [
        &b""[..],
        b"not a zip at all",
        &src[..src.len() / 2],
        &src[..src.len() - 1],
    ] {
        assert!(write_idml(&doc, bytes).is_err());
        assert!(write_paged(&doc, bytes, &Default::default(), 1).is_err());
        assert!(idml_parts_hash(bytes).is_err());
    }
}
