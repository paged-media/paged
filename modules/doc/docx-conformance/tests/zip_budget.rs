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

// Test names end in `__feat__<cockpit id>` (the cockpit linking convention).
#![allow(non_snake_case)]

//! The package reader's memory budget, at every `.docx` entry point.
//!
//! paged.doc read packages unguarded until it shared paged.sheet's reader
//! (`paged_ooxml::read_zip`): every entry was pre-allocated at the size its
//! header CLAIMED, and nothing bounded the total. A small file could ask for
//! gigabytes, which in the editor kills the wasm module. Its own test binary,
//! because the peak-allocation counter is the process's global allocator.

use paged_ooxml::testing::{claim_size, declared_bomb, streamed, PeakAlloc};
use paged_ooxml::{OoxmlError, MAX_UNCOMPRESSED_BYTES};

#[global_allocator]
static A: PeakAlloc = PeakAlloc;

/// No single allocation for a bomb of about 1 MB may come near this.
const CEILING: usize = 64 << 20;

#[test]
fn a_zip_bomb_is_refused_within_the_budget_at_every_docx_entry_point__feat__plugin_doc_opc_foundation(
) {
    // 1,100 entries of 1 MiB of zeros: about 1.1 MB that inflates to
    // 1.07 GiB, past the 1 GiB budget.
    let bomb = declared_bomb(1100, 1 << 20);
    assert!(bomb.len() < 2 << 20, "the bomb is small: {}", bytes(&bomb));
    const { assert!(1100 << 20 > MAX_UNCOMPRESSED_BYTES) };

    PeakAlloc::reset();
    let err = docx_import::import_docx(&bomb).expect_err("import_docx must refuse a bomb");
    assert!(
        matches!(err, OoxmlError::Budget(_)),
        "typed budget error, got {err}"
    );
    let err = docx_import::import_docx_with_package(&bomb).expect_err("refused");
    assert!(
        matches!(err, OoxmlError::Budget(_)),
        "typed budget error, got {err}"
    );
    // The wasm session's door reports the same, as text.
    let msg = docx_js::core::DocSession::load(&bomb)
        .err()
        .expect("DocSession::load must refuse a bomb");
    assert!(msg.contains("budget"), "budget error, got {msg}");
    let peak = PeakAlloc::largest();
    assert!(
        peak < CEILING,
        "a refused bomb made a single {peak}-byte allocation"
    );
}

#[test]
fn an_entry_claiming_4_gib_is_not_allocated__feat__plugin_doc_opc_foundation() {
    // A streamed entry (its sizes in a data descriptor, so the archive
    // declares no total) whose central directory claims 4 GiB for 64 KiB.
    // The old reader pre-allocated the claim.
    let lying = claim_size(streamed(64 << 10), u32::MAX, true);
    PeakAlloc::reset();
    // Ok or a typed error (it is not a Word document); never the claim.
    let _ = docx_import::import_docx(&lying);
    let _ = docx_js::core::DocSession::load(&lying);
    let peak = PeakAlloc::largest();
    assert!(
        peak < CEILING,
        "{} made a single {peak}-byte allocation",
        bytes(&lying)
    );
}

fn bytes(b: &[u8]) -> String {
    format!("{} bytes", b.len())
}
