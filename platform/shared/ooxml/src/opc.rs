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

//! The OPC (Open Packaging Conventions) container.
//!
//! We own the container layer over `zip` + `quick-xml` rather than delegating it
//! to `ooxmlsdk`'s `parts` feature, because `ooxmlsdk` does not document
//! byte-exact fidelity and the **preservation invariant** (§10 of the spec —
//! "Paged never destroys a document") requires verbatim carry-through of parts we
//! do not touch. `ooxmlsdk` is used only for the *typed DOM of the parts we
//! actually read/write* (see `crate::dom`, feature `dom`).
//!
//! ## Reading: the memory budget
//!
//! Every package is read through [`read_zip`], which holds the whole read to
//! a total-uncompressed budget ([`MAX_UNCOMPRESSED_BYTES`] unless the caller
//! names one). An entry's header may CLAIM any uncompressed size, so the
//! claim is never trusted for allocation (fuzzing paged.sheet found 2.6 KB
//! inputs asking for 3.4 GB); entries whose declared sizes already exceed the
//! budget are refused before anything is inflated; and each entry is read
//! through a limit of the budget still unspent, so a decompression bomb whose
//! headers understate it stops at the budget with [`OoxmlError::Budget`]
//! instead of exhausting memory. paged.sheet's reader had this since its
//! fuzzing; paged.doc and paged.slide read packages unguarded until they
//! shared it.
//!
//! ## Preservation model (paged.doc, paged.slide)
//!
//! An [`OpcPackage`] holds an **ordered** `Vec<PartEntry>` preserving on-disk
//! entry order. Every part is read as opaque bytes (stored *decompressed*). A
//! part is only re-serialized from a model when the caller explicitly
//! [`OpcPackage::set_part`]s it (marking it dirty). On write, an untouched part
//! re-emits its stored original bytes verbatim, so unknown parts and unknown
//! subtrees survive a round-trip. Per-part **decompressed** byte identity is
//! guaranteed; whole-file / zip-metadata identity is not (the deflate stream
//! is re-encoded). paged.sheet keeps its own container over [`read_zip`]
//! (`sheet-xlsx`'s `OpcContainer`, whose parts carry the SpreadsheetML part
//! kinds it models).

use std::io::{Cursor, Read, Write};

use crate::error::{OoxmlError, Result, ZipReadError};

/// The total number of uncompressed bytes one package read will hold
/// (1 GiB). Past it the read fails with [`OoxmlError::Budget`]; a wasm32 host
/// could not hold more anyway.
pub const MAX_UNCOMPRESSED_BYTES: u64 = 1 << 30;

/// Largest pre-allocation made from an entry's DECLARED size; growth past
/// it follows the bytes actually inflated.
const PREALLOC_CAP: u64 = 8 << 20;

/// A container that is not a zip at all, named by its first bytes.
///
/// Sniffed BEFORE the zip reader, because the zip crate locates a package
/// by scanning backwards for the end-of-central-directory record: a CFB file
/// carrying anything zip-shaped further in opens as if it were OOXML (four
/// real `.doc` files embed a complete OPC package after their CFB payload;
/// POI's `drawings.xls` did the same). Each reader names its own format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyContainer {
    /// CFB/OLE: the pre-2007 `.doc`, `.xls` and `.ppt`.
    Cfb,
    /// Rich Text Format, which users routinely save with a `.doc` extension.
    Rtf,
    /// WinWord 2.0, older than CFB/OLE (POI's `word2.doc`).
    WinWord2,
}

/// What `bytes` are when they are one of the [`LegacyContainer`]s.
pub fn sniff_legacy(bytes: &[u8]) -> Option<LegacyContainer> {
    const CFB_MAGIC: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    const WINWORD2_MAGIC: &[u8] = &[0xDB, 0xA5, 0x2D, 0x00];
    if bytes.starts_with(CFB_MAGIC) {
        Some(LegacyContainer::Cfb)
    } else if bytes.starts_with(b"{\\rtf") {
        Some(LegacyContainer::Rtf)
    } else if bytes.starts_with(WINWORD2_MAGIC) {
        Some(LegacyContainer::WinWord2)
    } else {
        None
    }
}

/// One zip entry as [`read_zip`] read it, in archive order.
#[derive(Debug, Clone)]
pub enum ZipEntry {
    /// A file, decompressed.
    File {
        /// The entry name: valid UTF-8 bytes are read as UTF-8, anything
        /// else as CP437 (zip 9; 2.x went by the entry's UTF-8 flag alone).
        name: String,
        /// The decompressed bytes.
        bytes: Vec<u8>,
    },
    /// An explicit directory entry (`name` ends in `/`).
    Dir {
        /// The entry name.
        name: String,
    },
}

/// Read every entry of a zip archive, in order, holding the whole read to
/// `budget` uncompressed bytes (see the module documentation). Never panics
/// on malformed input: a non-zip payload is [`ZipReadError::Zip`], a package
/// past the budget [`ZipReadError::Budget`].
pub fn read_zip(bytes: &[u8], budget: u64) -> std::result::Result<Vec<ZipEntry>, ZipReadError> {
    let mut entries = Vec::new();
    read_zip_each(bytes, budget, |entry| {
        entries.push(entry);
        Ok::<(), ZipReadError>(())
    })?;
    Ok(entries)
}

/// [`read_zip`], handing each entry to `each` as it is read instead of
/// collecting them (a reader that keeps its own part list builds it
/// directly). `each` may stop the read with its own error.
pub fn read_zip_each<E: From<ZipReadError>>(
    bytes: &[u8],
    budget: u64,
    mut each: impl FnMut(ZipEntry) -> std::result::Result<(), E>,
) -> std::result::Result<(), E> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(ZipReadError::from)?;
    // The declared sizes, when every entry declares one: a package that
    // says it is larger than the budget is refused before any inflation.
    if let Some(declared) = zip.decompressed_size() {
        if declared > u128::from(budget) {
            let declared = u64::try_from(declared).unwrap_or(u64::MAX);
            return Err(ZipReadError::Budget(format!(
                "its entries declare {declared} uncompressed bytes, past the {budget}-byte uncompressed budget"
            ))
            .into());
        }
    }
    let mut remaining = budget;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(ZipReadError::from)?;
        let name = file.name().map_err(ZipReadError::from)?.into_owned();
        if file.is_dir() {
            each(ZipEntry::Dir { name })?;
            continue;
        }
        // The declared size is only a HINT, bounded by what the
        // compressed bytes could plausibly hold and by a fixed cap.
        let hint = file
            .size()
            .min(remaining)
            .min(PREALLOC_CAP)
            .min(bytes.len() as u64 * 1032);
        let mut data = Vec::with_capacity(hint as usize);
        // Read at most one byte past the budget: reaching it means the
        // entry (or the package) is larger than we will hold.
        (&mut file)
            .take(remaining + 1)
            .read_to_end(&mut data)
            .map_err(ZipReadError::from)?;
        if data.len() as u64 > remaining {
            return Err(ZipReadError::Budget(format!(
                "part {name} exceeds the {budget}-byte uncompressed budget"
            ))
            .into());
        }
        remaining -= data.len() as u64;
        each(ZipEntry::File { name, bytes: data })?;
    }
    Ok(())
}

/// One entry of the package, in on-disk order.
#[derive(Debug, Clone)]
pub enum PartEntry {
    /// A file part, stored decompressed. `dirty` is set when [`OpcPackage::set_part`]
    /// replaces the bytes, so the writer knows this part changed.
    File {
        /// OPC part name, e.g. `word/document.xml` (no leading slash).
        name: String,
        /// Decompressed bytes.
        bytes: Vec<u8>,
        /// True once the caller replaced these bytes.
        dirty: bool,
    },
    /// An explicit directory entry (rare in `.docx`, but preserved when present).
    Dir {
        /// Directory name, ending in `/`.
        name: String,
    },
}

impl PartEntry {
    /// The entry's name.
    pub fn name(&self) -> &str {
        match self {
            PartEntry::File { name, .. } => name,
            PartEntry::Dir { name } => name,
        }
    }
}

/// An OPC package read from `.docx`/`.dotx`/`.pptx` bytes, preserving part order.
#[derive(Debug, Clone, Default)]
pub struct OpcPackage {
    parts: Vec<PartEntry>,
}

impl OpcPackage {
    /// Read a package from `.docx`/`.pptx` bytes within
    /// [`MAX_UNCOMPRESSED_BYTES`]. Never panics on malformed input — a non-ZIP
    /// payload returns [`OoxmlError::Zip`], a decompression bomb
    /// [`OoxmlError::Budget`].
    pub fn read(bytes: &[u8]) -> Result<Self> {
        Self::read_with_budget(bytes, MAX_UNCOMPRESSED_BYTES)
    }

    /// [`read`](Self::read) with an explicit total-uncompressed budget.
    pub fn read_with_budget(bytes: &[u8], budget: u64) -> Result<Self> {
        // Container sniff BEFORE the zip reader (see `LegacyContainer`):
        // without it an old Word file that embeds a package half-imports and
        // dies later with a misleading XML error (OoxmlError::LegacyBinaryDoc),
        // and RTF or WinWord 2.0 reach the zip reader, which reports "Could
        // not find EOCD", telling the user nothing.
        match sniff_legacy(bytes) {
            Some(LegacyContainer::Cfb | LegacyContainer::WinWord2) => {
                return Err(OoxmlError::LegacyBinaryDoc)
            }
            Some(LegacyContainer::Rtf) => return Err(OoxmlError::RichTextFormat),
            None => {}
        }
        let parts = read_zip(bytes, budget)?
            .into_iter()
            .map(|e| match e {
                ZipEntry::Dir { name } => PartEntry::Dir { name },
                ZipEntry::File { name, bytes } => PartEntry::File {
                    name,
                    bytes,
                    dirty: false,
                },
            })
            .collect();
        Ok(OpcPackage { parts })
    }

    /// All part names in on-disk order (files and dirs).
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.parts.iter().map(PartEntry::name)
    }

    /// All *file* part names in on-disk order.
    pub fn file_names(&self) -> impl Iterator<Item = &str> {
        self.parts.iter().filter_map(|p| match p {
            PartEntry::File { name, .. } => Some(name.as_str()),
            PartEntry::Dir { .. } => None,
        })
    }

    /// Borrow the decompressed bytes of a file part by name.
    pub fn part(&self, name: &str) -> Option<&[u8]> {
        self.parts.iter().find_map(|p| match p {
            PartEntry::File { name: n, bytes, .. } if n == name => Some(bytes.as_slice()),
            _ => None,
        })
    }

    /// Borrow required part bytes, or [`OoxmlError::MissingPart`].
    pub fn require(&self, name: &str) -> Result<&[u8]> {
        self.part(name)
            .ok_or_else(|| OoxmlError::MissingPart(name.to_string()))
    }

    /// Replace a part's bytes, marking it dirty. If the part does not exist it is
    /// appended (a new part). Directory entries are ignored as targets.
    pub fn set_part(&mut self, name: &str, new_bytes: Vec<u8>) {
        for p in &mut self.parts {
            if let PartEntry::File {
                name: n,
                bytes,
                dirty,
            } = p
            {
                if n == name {
                    *bytes = new_bytes;
                    *dirty = true;
                    return;
                }
            }
        }
        self.parts.push(PartEntry::File {
            name: name.to_string(),
            bytes: new_bytes,
            dirty: true,
        });
    }

    /// True if any part was modified since read.
    pub fn is_dirty(&self) -> bool {
        self.parts
            .iter()
            .any(|p| matches!(p, PartEntry::File { dirty: true, .. }))
    }

    /// Re-serialize the package to `.docx` bytes. Untouched parts re-emit their
    /// stored bytes verbatim (the carry-through guarantee); modified parts emit
    /// their new bytes. Entry order is preserved.
    pub fn write(&self) -> Result<Vec<u8>> {
        // Fixed entry metadata, so the container bytes depend on the parts
        // alone: the 1980-01-01 DOS time (`default()` reads the clock when
        // zip's `time` feature is on) and a Unix `version made by` (zip
        // otherwise takes the build host's system).
        let opts = zip::write::SimpleFileOptions::DEFAULT
            .system(zip::System::Unix)
            .compression_method(zip::CompressionMethod::Deflated);
        write_zip(opts, |zip| {
            for entry in &self.parts {
                match entry {
                    PartEntry::Dir { name } => zip.dir(name.trim_end_matches('/'))?,
                    PartEntry::File { name, bytes, .. } => zip.file(name, bytes)?,
                }
            }
            Ok::<(), OoxmlError>(())
        })
    }
}

/// A zip archive being written by [`write_zip`]: every entry takes the
/// options the write was started with.
pub struct ZipSink<'a> {
    // `&mut Cursor`: the writer type doc's and slide's IDML packagers use
    // too, so a module compiles the zip writer once.
    zip: zip::ZipWriter<&'a mut Cursor<Vec<u8>>>,
    options: zip::write::SimpleFileOptions,
}

impl ZipSink<'_> {
    /// Add a file entry holding `bytes`.
    pub fn file(
        &mut self,
        name: &str,
        bytes: &[u8],
    ) -> std::result::Result<(), zip::result::ZipError> {
        self.zip.start_file(name, self.options)?;
        self.zip.write_all(bytes).map_err(zip::result::ZipError::Io)
    }

    /// Add a directory entry (`name` without its trailing `/`).
    pub fn dir(&mut self, name: &str) -> std::result::Result<(), zip::result::ZipError> {
        self.zip.add_directory(name, self.options)
    }
}

/// Write a zip archive in memory: `fill` adds the entries, in order, each
/// with `options`. The one package writer of the modules: each keeps its own
/// options, because they decide the container bytes (doc and slide through
/// [`OpcPackage::write`]; sheet's `part_options`), and all of them share this
/// code.
pub fn write_zip<E: From<zip::result::ZipError>>(
    options: zip::write::SimpleFileOptions,
    fill: impl FnOnce(&mut ZipSink<'_>) -> std::result::Result<(), E>,
) -> std::result::Result<Vec<u8>, E> {
    let mut out = Cursor::new(Vec::new());
    {
        let mut sink = ZipSink {
            zip: zip::ZipWriter::new(&mut out),
            options,
        };
        fill(&mut sink)?;
        sink.zip.finish()?;
    }
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::OoxmlError;

    /// A minimal CFB/OLE header followed by a complete OPC package — the
    /// shape four real corpus `.doc` files have. Without the magic sniff
    /// the zip reader finds the embedded package by scanning backwards
    /// for the EOCD, enumerates it, and the failure surfaces much later
    /// as a nonsense XML error about `themeManager.xml`.
    #[test]
    fn a_legacy_doc_that_embeds_an_opc_package_is_rejected_at_the_door() {
        let mut package = OpcPackage::default();
        package.set_part("[Content_Types].xml", b"<Types/>".to_vec());
        let inner = package.write().expect("write inner package");

        let mut bytes = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        bytes.resize(512, 0);
        bytes.extend_from_slice(&inner);

        // The trap: the payload IS a readable zip if you look far enough in.
        assert!(
            zip::ZipArchive::new(Cursor::new(&bytes[..])).is_ok(),
            "test premise broken — the embedded package must be zip-readable, \
             otherwise this test would pass without the sniff"
        );
        assert!(
            matches!(OpcPackage::read(&bytes), Err(OoxmlError::LegacyBinaryDoc)),
            "a CFB container must be named as a legacy .doc, not half-opened"
        );
    }

    #[test]
    fn an_rtf_saved_as_doc_is_named_rather_than_reported_as_a_broken_zip() {
        let bytes = br"{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\f0 hello}".to_vec();
        assert!(
            matches!(OpcPackage::read(&bytes), Err(OoxmlError::RichTextFormat)),
            "RTF must be identified; the bare zip reader calls it \
             \"Could not find EOCD\", which names nothing"
        );
    }

    #[test]
    fn genuinely_malformed_input_still_reports_as_a_container_failure() {
        // The sniffs must not swallow everything — random bytes are still
        // a zip error, not a format we claim to recognise.
        assert!(matches!(
            OpcPackage::read(b"not a container at all"),
            Err(OoxmlError::Zip(_))
        ));
    }

    use crate::testing::{claim_size, declared_bomb, streamed, zeros};

    #[test]
    fn a_package_within_the_budget_reads_whole() {
        let bytes = zeros(64 << 10);
        let pkg = OpcPackage::read_with_budget(&bytes, 1 << 20).unwrap();
        assert_eq!(pkg.part("bomb.bin").map(<[u8]>::len), Some(64 << 10));
    }

    #[test]
    fn many_honest_entries_past_the_budget_are_refused_before_inflating() {
        let bytes = declared_bomb(40, 64 << 10);
        assert!(bytes.len() < 64 << 10, "the bomb is small: {}", bytes.len());
        let err = OpcPackage::read_with_budget(&bytes, 1 << 20).unwrap_err();
        assert!(
            matches!(&err, OoxmlError::Budget(m) if m.contains("declare")),
            "{err}"
        );
        assert!(OpcPackage::read_with_budget(&bytes, 4 << 20).is_ok());
    }

    #[test]
    fn declared_sizes_past_the_budget_are_refused_before_inflating() {
        let bytes = zeros(2 << 20);
        assert!(bytes.len() < 64 << 10, "the bomb is small: {}", bytes.len());
        let err = OpcPackage::read_with_budget(&bytes, 1 << 20).unwrap_err();
        assert!(
            matches!(&err, OoxmlError::Budget(m) if m.contains("declare")),
            "refused on the declared sizes, got {err}"
        );
    }

    #[test]
    fn an_entry_without_a_declared_size_stops_at_the_budget() {
        let bytes = streamed(2 << 20);
        let err = read_zip(&bytes, 1 << 20).unwrap_err();
        assert!(
            matches!(&err, ZipReadError::Budget(m) if m.contains("part bomb.bin")),
            "stopped while inflating, got {err}"
        );
        assert!(read_zip(&streamed(64 << 10), 1 << 20).is_ok());
    }

    #[test]
    fn an_entry_that_inflates_past_what_it_declares_is_refused() {
        // The headers claim 16 bytes; the deflate stream holds 2 MiB. zip
        // stops at the claim, and the budget would stop it at 1 MiB.
        let bytes = claim_size(zeros(2 << 20), 16, false);
        assert!(matches!(
            read_zip(&bytes, 1 << 20),
            Err(ZipReadError::Io(_) | ZipReadError::Budget(_))
        ));
    }

    #[test]
    fn a_claimed_size_is_not_preallocated() {
        // The headers claim 4 GiB - 1 for a 64 KiB entry: refused on the
        // declared total, and a larger budget reads it at its real size.
        let bytes = claim_size(zeros(64 << 10), u32::MAX, false);
        assert!(matches!(
            OpcPackage::read(&bytes),
            Err(OoxmlError::Budget(_))
        ));
        let entries = read_zip(&bytes, u64::MAX - 1).unwrap_or_default();
        for e in entries {
            if let ZipEntry::File { name, bytes } = e {
                assert!(bytes.capacity() <= PREALLOC_CAP as usize, "{name}");
            }
        }
    }
}
