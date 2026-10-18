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
//! owns the **format-mechanical** layer so `paged.doc` (now), `paged.slide`
//! (later), and eventually `paged.sheet` share it, while each plugin keeps its
//! own *semantic* model.
//!
//! Two responsibilities, deliberately separated:
//!
//! 1. **The OPC container + preservation** ([`opc`], [`content_types`], [`rels`])
//!    over `zip` + `quick-xml`. We do NOT delegate the container to `ooxmlsdk`'s
//!    `parts` feature, because `ooxmlsdk` does not document byte-exact fidelity
//!    and the preservation invariant ("Paged never destroys a document") requires
//!    **verbatim carry-through** of untouched + unknown parts. An [`opc::OpcPackage`]
//!    keeps parts in on-disk order and re-emits untouched ones byte-for-byte
//!    (per-part decompressed identity).
//!
//! 2. **The typed part DOM** ([`dom`]) via the vendored [`ooxmlsdk`] crate — used
//!    only for the *semantic* read/write of the parts we actually understand
//!    (`word/document.xml`, `word/styles.xml`, …). DOC-02 (the `ooxmlsdk` →
//!    `wasm32` feasibility spike) is GREEN, so this is the committed foundation.
//!    `ooxmlsdk`'s `mce` feature is enabled at the workspace level, so
//!    `mc:AlternateContent` is representable in the typed DOM. (Full fallback
//!    *selection* is a later-tier concern; Tier-0 documents rarely carry it.)
//!
//! Nothing here is DOCX-specific — that lives in the `docx-*` crates.

pub mod content_types;
pub mod dom;
pub mod error;
pub mod opc;
pub mod rels;

pub use content_types::{ContentTypes, CONTENT_TYPES_PART};
pub use dom::{parse_root, serialize_root};
pub use error::{OoxmlError, Result};
pub use opc::{OpcPackage, PartEntry};
pub use rels::{part_dir, rels_part_name, resolve_target, Relationship, Relationships};

/// Re-export the vendored typed part DOM so downstream `docx-*` crates import the
/// OOXML schemas from ONE place (`paged_ooxml::ooxmlsdk::…`) and never pin the
/// `ooxmlsdk` version directly.
pub use ooxmlsdk;
