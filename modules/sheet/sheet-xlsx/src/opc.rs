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

//! The OPC (Open Packaging Conventions, ECMA-376 Part 2) container layer.
//!
//! Reads the workbook zip into an *ordered* [`OpcContainer`] of
//! [`PartEntry`] — the on-disk entry order is preserved so an unmodeled
//! re-write keeps parts in their original sequence. Directory entries are
//! dropped (zip-only artifacts; OPC parts are flat names). Part bytes are
//! stored decompressed; the writer recompresses with deflate, which yields
//! decompressed-byte identity (the spec's per-part zero-edit assertion —
//! whole-file/zip-metadata identity is explicitly *not* claimed, §10.2).
//!
//! The zip read itself, with its uncompressed-size budget, the legacy
//! container sniff, the `[Content_Types].xml` model and the XML helpers are
//! `paged-ooxml`'s, shared with paged.doc and paged.slide; what stays here is
//! the SpreadsheetML part kinds this crate models.

use crate::error::XlsxError;
use std::collections::HashMap;

/// `paged_ooxml::xml::attr`, reporting as [`XlsxError`] (one wrapper, so the
/// many call sites carry no conversion).
pub(crate) fn attr(
    e: &quick_xml::events::BytesStart<'_>,
    key: &[u8],
) -> Result<Option<String>, XlsxError> {
    paged_ooxml::xml::attr_as(e, key)
}

/// `paged_ooxml::xml::general_ref`, reporting as [`XlsxError`].
pub(crate) fn general_ref(r: &quick_xml::events::BytesRef<'_>) -> Result<String, XlsxError> {
    paged_ooxml::xml::general_ref_as(r)
}
pub use paged_ooxml::{ContentTypes, CONTENT_TYPES_PART};

/// One part of the package. `Opaque` parts are preserved byte-identical
/// (the preservation invariant, §10.2); `Modeled` parts are understood and
/// may be re-encoded from the model when dirty, else re-emitted verbatim
/// (lazy-verbatim).
#[derive(Debug, Clone)]
pub enum PartEntry {
    /// Preserved byte-identical — themes, docProps, pivot caches,
    /// `vbaProject.bin`, customXml, calcChain, anything we don't model.
    Opaque { name: String, bytes: Vec<u8> },
    /// An understood part. `raw` is the original decompressed bytes;
    /// `dirty` flips when the model owning it is mutated, triggering a
    /// re-encode on save (otherwise `raw` is re-emitted verbatim).
    Modeled {
        name: String,
        kind: ModeledKind,
        raw: Vec<u8>,
        dirty: bool,
    },
}

/// Which understood part a [`PartEntry::Modeled`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeledKind {
    Workbook,
    WorkbookRels,
    Worksheet,
    SharedStrings,
    Styles,
    ContentTypes,
}

impl PartEntry {
    /// The part name (zip entry name) regardless of variant.
    pub fn name(&self) -> &str {
        match self {
            PartEntry::Opaque { name, .. } => name,
            PartEntry::Modeled { name, .. } => name,
        }
    }

    /// The decompressed bytes regardless of variant.
    pub fn bytes(&self) -> &[u8] {
        match self {
            PartEntry::Opaque { bytes, .. } => bytes,
            PartEntry::Modeled { raw, .. } => raw,
        }
    }
}

/// The whole package: an ordered list of parts plus the parsed content-type
/// table. This is what `sheet-core`'s opaque `PreservedParts` slot holds.
#[derive(Debug, Clone)]
pub struct OpcContainer {
    /// Parts in original zip entry order (dirs already dropped).
    pub parts: Vec<PartEntry>,
    /// Parsed `[Content_Types].xml` (kept for writer re-serialization).
    pub content_types: ContentTypes,
    /// True once a structural change (calcChain drop, sheet re-encode) made
    /// the container diverge from the byte-for-byte original.
    pub dirty: bool,
    /// Part name → index into `parts`, built on read (lookups were a linear
    /// scan per call). `parts` is public, so every lookup verifies the hit
    /// and falls back to the scan if the vector was reshaped behind it.
    index: HashMap<String, usize>,
}

impl OpcContainer {
    /// Read a zip archive into ordered parts. Every part starts `Opaque`;
    /// the parse layer promotes the understood ones to `Modeled` afterwards.
    pub fn read(bytes: &[u8]) -> Result<OpcContainer, XlsxError> {
        Self::read_with_budget(bytes, crate::MAX_UNCOMPRESSED_BYTES)
    }

    /// [`read`](Self::read) with an explicit total-uncompressed budget.
    ///
    /// An entry's header may CLAIM any uncompressed size; the claim is
    /// never trusted for allocation (fuzzing found 2.6 KB inputs asking
    /// for 3.4 GB). A package whose declared sizes exceed the budget is
    /// refused before anything is inflated, and each entry is read through
    /// a limit of the budget still unspent, so a decompression bomb stops
    /// at the budget with a typed [`XlsxError::Budget`] instead of
    /// exhausting memory (`paged_ooxml::read_zip`).
    pub fn read_with_budget(bytes: &[u8], budget: u64) -> Result<OpcContainer, XlsxError> {
        // Container sniff BEFORE the zip reader. A legacy .xls is
        // CFB/OLE, and the zip crate locates a package by scanning
        // backwards for the EOCD — so a CFB file carrying anything
        // zip-shaped can be opened as if it were OOXML. POI's
        // `drawings.xls` (magic D0CF11E0, "Name of Creating
        // Application: Microsoft Excel") did precisely that.
        if paged_ooxml::sniff_legacy(bytes) == Some(paged_ooxml::LegacyContainer::Cfb) {
            return Err(XlsxError::LegacyBinaryXls);
        }
        let mut parts = Vec::new();
        let mut content_types: Option<ContentTypes> = None;
        paged_ooxml::read_zip_each(bytes, budget, |entry| {
            // OPC parts are flat names; directory entries are zip-only noise.
            let paged_ooxml::ZipEntry::File { name, bytes: data } = entry else {
                return Ok(());
            };
            if name == CONTENT_TYPES_PART {
                content_types = Some(ContentTypes::parse_as::<XlsxError>(&data)?);
                parts.push(PartEntry::Modeled {
                    name,
                    kind: ModeledKind::ContentTypes,
                    raw: data,
                    dirty: false,
                });
            } else {
                parts.push(PartEntry::Opaque { name, bytes: data });
            }
            Ok::<(), XlsxError>(())
        })?;

        let content_types = content_types
            .ok_or_else(|| XlsxError::Structure(format!("missing {CONTENT_TYPES_PART}")))?;

        // First occurrence wins, matching the scan it replaces.
        let mut index = HashMap::with_capacity(parts.len());
        for (i, p) in parts.iter().enumerate() {
            index.entry(p.name().to_owned()).or_insert(i);
        }
        Ok(OpcContainer {
            parts,
            content_types,
            dirty: false,
            index,
        })
    }

    /// The index of the part named `name`: the map's answer when it still
    /// names that part, else a scan.
    fn position(&self, name: &str) -> Option<usize> {
        match self.index.get(name) {
            Some(&i) if self.parts.get(i).is_some_and(|p| p.name() == name) => Some(i),
            _ => self.parts.iter().position(|p| p.name() == name),
        }
    }

    /// Find a part by exact name.
    pub fn part(&self, name: &str) -> Option<&PartEntry> {
        self.position(name).map(|i| &self.parts[i])
    }

    /// Find a part by exact name, mutably.
    pub fn part_mut(&mut self, name: &str) -> Option<&mut PartEntry> {
        self.position(name).map(|i| &mut self.parts[i])
    }

    /// Promote the part `name` (if present and still `Opaque`) to a
    /// `Modeled` part of `kind`. No-op if absent or already modeled. Moves the
    /// bytes (no copy).
    pub fn promote(&mut self, name: &str, kind: ModeledKind) {
        if let Some(idx) = self.position(name) {
            if let PartEntry::Opaque { name, bytes } = &mut self.parts[idx] {
                let (name, bytes) = (std::mem::take(name), std::mem::take(bytes));
                self.parts[idx] = PartEntry::Modeled {
                    name,
                    kind,
                    raw: bytes,
                    dirty: false,
                };
            }
        }
    }
}
