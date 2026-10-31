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

//! # paged-ooxml — the shared ECMA-376 (OOXML) foundation
//!
//! `.docx`, `.xlsx`, and `.pptx` are the same ECMA-376 / ISO-IEC 29500 family:
//! one OPC (Open Packaging Conventions) ZIP container, one `[Content_Types].xml`
//! and `_rels` relationship graph, one DrawingML/theme primitive set. This crate
//! owns the **format-mechanical** layer that `paged.doc`, `paged.slide` and
//! `paged.sheet` share, while each module keeps its own *semantic* model. It
//! lives in `platform/shared/ooxml` (internal to the built-ins, PM-0002) and
//! is a path dependency of the three modules' Cargo workspaces.
//!
//! - **The OPC container** ([`opc`], [`content_types`], [`rels`]) over `zip` +
//!   `quick-xml`, with the uncompressed-size budget every package read goes
//!   through ([`read_zip`]). We do NOT delegate the container to `ooxmlsdk`'s
//!   `parts` feature, because `ooxmlsdk` does not document byte-exact
//!   fidelity and the preservation invariant ("Paged never destroys a
//!   document") requires **verbatim carry-through** of untouched + unknown
//!   parts. An [`opc::OpcPackage`] keeps parts in on-disk order and re-emits
//!   untouched ones byte-for-byte (per-part decompressed identity).
//! - **Byte-splice editing** ([`splice`]): change one element of a part and
//!   keep every other byte.
//! - **The XML helpers** ([`xml`]): attribute readers, reference resolution,
//!   the escapes; and the namespace-aware element tree ([`tree`]) paged.slide
//!   reads PresentationML and DrawingML through, and the shared chart reader
//!   (`platform/shared/dml-chart`) every chart.
//! - **DrawingML colour** ([`colour`]): the HSL arithmetic, SpreadsheetML's
//!   `tint` (in HSL) and DrawingML's `tint`/`shade` (in linear RGB), kept
//!   apart because they are different operations.
//! - **DrawingML paint and effects** ([`drawingml`]): colours with their
//!   transform chains, fills (solid, gradient, pattern, picture with its
//!   effects), lines and effect lists, read once for the three formats,
//!   resolved into a neutral IR (points, degrees, fractions) and written
//!   back. The engine mapping is `platform/shared/dml-native`'s.
//! - **Units** ([`units`]): EMU, twips, half-points, DrawingML angles and
//!   percentages.
//! - **The typed part DOM** (`dom`, feature `dom`) via the [`ooxmlsdk`]
//!   crate — used only for the *semantic* read of the parts paged.doc
//!   understands (`word/document.xml`, `word/styles.xml`, …). `ooxmlsdk`'s
//!   `mce` feature is enabled, so `mc:AlternateContent` is representable in
//!   the typed DOM. slide and sheet never compile it.
//!
//! Nothing here is specific to one format — that lives in the modules.
//!
//! The consuming workspace picks zip's deflate backend (feature `deflate` or
//! `deflate-flate2`), because the backend changes the bytes a save writes.

// A package is written deflated; zip has no deflate without a backend, and
// which backend changes the bytes written, so the consuming workspace says.
#[cfg(not(any(feature = "deflate", feature = "deflate-flate2")))]
compile_error!(
    "paged-ooxml needs a zip deflate backend: enable its `deflate` or `deflate-flate2` feature"
);

pub mod colour;
pub mod content_types;
#[cfg(feature = "dom")]
pub mod dom;
pub mod drawingml;
pub mod error;
pub mod opc;
pub mod rels;
pub mod splice;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
pub mod tree;
pub mod units;
pub mod xml;

pub use content_types::{ContentTypes, CONTENT_TYPES_PART};
#[cfg(feature = "dom")]
pub use dom::{parse_root, serialize_root};
pub use error::{FromXmlError, OoxmlError, Result, XmlError, ZipReadError};
pub use opc::{
    read_zip, read_zip_each, sniff_legacy, write_zip, LegacyContainer, OpcPackage, PartEntry,
    ZipEntry, ZipSink, MAX_UNCOMPRESSED_BYTES,
};
pub use rels::{part_dir, rels_part_name, resolve_target, Relationship, Relationships};

/// Re-export the typed part DOM so downstream `docx-*` crates import the
/// OOXML schemas from ONE place (`paged_ooxml::ooxmlsdk::…`) and never pin the
/// `ooxmlsdk` version directly.
#[cfg(feature = "dom")]
pub use ooxmlsdk;
