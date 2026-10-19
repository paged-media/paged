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

//! Test kit (feature `testing`, for dev-dependencies only): the hostile
//! packages the readers must refuse, and an allocator that records the
//! largest single allocation, so a test can show a claimed size was never
//! trusted. doc, slide and sheet feed these to their importers; the
//! builders need a deflate backend (`deflate` or `deflate-flate2`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{Cursor, Write};
use std::sync::atomic::{AtomicUsize, Ordering};

fn deflated() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::DEFAULT.compression_method(zip::CompressionMethod::Deflated)
}

/// A package with a `[Content_Types].xml` and one `bomb.bin` of `size` zero
/// bytes, every size honestly declared.
pub fn zeros(size: usize) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut out);
        z.start_file("[Content_Types].xml", deflated()).unwrap();
        z.write_all(b"<Types/>").unwrap();
        z.start_file("bomb.bin", deflated()).unwrap();
        z.write_all(&vec![0u8; size]).unwrap();
        z.finish().unwrap();
    }
    out.into_inner()
}

/// A decompression bomb with honest headers: `copies` entries of `size` zero
/// bytes each, the one compressed stream copied rather than recompressed, so
/// building a 1 GiB+ bomb costs one compression of `size` bytes. 1,100 copies
/// of 1 MiB are about 1.1 MB on disk and declare 1.07 GiB.
pub fn declared_bomb(copies: usize, size: usize) -> Vec<u8> {
    let one = zeros(size);
    let mut source = zip::ZipArchive::new(Cursor::new(one)).unwrap();
    let mut out = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut out);
        z.raw_copy_file(source.by_name("[Content_Types].xml").unwrap())
            .unwrap();
        for i in 0..copies {
            let entry = source.by_name("bomb.bin").unwrap();
            z.raw_copy_file_rename(entry, format!("media/bomb{i}.bin"))
                .unwrap();
        }
        z.finish().unwrap();
    }
    out.into_inner()
}

/// One `bomb.bin` of `size` zero bytes written by a streaming writer: its
/// sizes follow the data in a data descriptor, so the archive declares no
/// total and only the read itself can stop it.
pub fn streamed(size: usize) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut z = zip::ZipWriter::new_stream(&mut out);
        z.start_file("bomb.bin", deflated()).unwrap();
        z.write_all(&vec![0u8; size]).unwrap();
        z.finish().unwrap();
    }
    out
}

/// Rewrite the uncompressed-size field of every local header and
/// central-directory record to `claim` (a header that lies about its entry).
/// With `central_only`, the local headers keep theirs (a streamed entry's are
/// zero, its sizes being in the data descriptor).
pub fn claim_size(mut zip: Vec<u8>, claim: u32, central_only: bool) -> Vec<u8> {
    let mut at = 0;
    while at + 4 <= zip.len() {
        let field = match &zip[at..at + 4] {
            b"PK\x03\x04" if !central_only => Some(at + 22),
            b"PK\x01\x02" => Some(at + 24),
            _ => None,
        };
        if let Some(f) = field {
            zip[f..f + 4].copy_from_slice(&claim.to_le_bytes());
        }
        at += 1;
    }
    zip
}

static LARGEST: AtomicUsize = AtomicUsize::new(0);

/// The system allocator, recording the largest single allocation or
/// reallocation since the last [`PeakAlloc::reset`]. A test binary installs
/// it with `#[global_allocator] static A: PeakAlloc = PeakAlloc;`.
pub struct PeakAlloc;

impl PeakAlloc {
    /// Forget the largest allocation so far.
    pub fn reset() {
        LARGEST.store(0, Ordering::Relaxed);
    }

    /// The largest single allocation since the last reset, in bytes.
    pub fn largest() -> usize {
        LARGEST.load(Ordering::Relaxed)
    }
}

// SAFETY: every call is forwarded to `System` with the caller's arguments;
// the only addition is an atomic maximum.
unsafe impl GlobalAlloc for PeakAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        LARGEST.fetch_max(l.size(), Ordering::Relaxed);
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract.
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: `p` was allocated by `System` with layout `l`.
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        LARGEST.fetch_max(n, Ordering::Relaxed);
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract.
        unsafe { System.realloc(p, l, n) }
    }
}
