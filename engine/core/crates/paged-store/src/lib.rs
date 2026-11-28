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

//! The native **Paged document codec** — (de)serialize a
//! [`paged_scene::Document`] to/from native `.paged` bytes with **no IDML**.
//!
//! This is the counterpart to the IDML import/export adapter: the adapter
//! converts `.idml` ↔ model, this codec persists the model itself. The raw-IDML
//! carry-through (`SourceArchive`'s byte blobs) is `#[serde(skip)]`, and the model's
//! derived caches are rebuilt via [`Document::rebuild_indexes`] after
//! deserialize — so a document reconstructs from native bytes with **no
//! `open_source_archive` / IDML parse** (N1, Approach A: the "self-owning model"
//! first slice).
//!
//! Format is JSON via `serde_json` for now (inspectable, wasm-clean, matching
//! the `document.pgd` precedent); a binary codec is a deferred optimization.
//! The on-disk shape mirrors today's IDML-derived model structure and **will
//! churn** as the model is reclaimed/renamed — treat pre-stabilization `.pgm`
//! parts as throwaway (version-gate before shipping to real documents).

use paged_scene::Document;

/// Canonical container path of the native model part inside a `.paged`
/// document. `paged/core/` is a core-owned namespace.
pub const DOCUMENT_PGM_PATH: &str = "paged/core/model/document.pgm";

pub mod package;

/// The native `.paged` model format version. **Bump on any change to the
/// model's serde shape** (e.g. the type renames during the `paged-model`
/// extraction) so an incompatible part is REJECTED — [`from_bytes`] returns
/// a [`PgmError`] naming the version — rather than mis-deserialized. A golden
/// part and a shape snapshot (`tests/it/golden.rs`) fail when the shape moves
/// without a bump. The format is pre-stabilization and churns; this gate is
/// what keeps a stale `.pgm` from silently corrupting a reload (ADR-022 Q2).
///
/// - v1: initial native shape.
/// - v2 (N7.1): the structured `designmap` moved off `container` up to a
///   top-level `Document.designmap` field, and `SourceArchive` lost its
///   `designmap` field — a serde-shape change, so a v1 part is rejected.
/// - v3 (N7.2): `Document.container: SourceArchive` became
///   `Document.source: Option<SourceArchive>`, now fully `#[serde(skip)]` (the
///   mimetype no longer rides in the `.pgm`) — a v2 part is rejected.
/// - v4: a page item's `image_bytes` are no longer a JSON array of integers
///   (one number per byte: 29 photos made a 211 MB part). They are a blob
///   reference into [`BLOB_PREFIX`] parts when written by [`to_parts`], a
///   base64 string when written by [`to_bytes`]. A v3 part is still READ
///   (the adapter accepts the old array), so existing documents keep their
///   images; an older engine rejects a v4 part, as with every version step.
pub const PGM_FORMAT_VERSION: u32 = 4;

/// The oldest part this build still reads.
pub const OLDEST_READABLE_PGM: u32 = 3;

/// Container namespace of the model's image blobs: one part per distinct
/// image, named by a content hash, so an unchanged image keeps its name
/// (and its bytes need not be rewritten) across saves.
pub const BLOB_PREFIX: &str = "paged/core/model/blobs/";

/// Image blobs by container path, as [`to_parts`] returns them.
pub type BlobParts = std::collections::BTreeMap<String, Vec<u8>>;

/// The blob name inside a container path under [`BLOB_PREFIX`].
pub fn blob_name_of(path: &str) -> Option<&str> {
    path.strip_prefix(BLOB_PREFIX).filter(|n| !n.is_empty())
}

/// A blob's name: the first 128 bits of its BLAKE3 hash, in hex. Content
/// addressed, so a writer may skip a blob the container already holds.
fn blob_name(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex()[..32].to_string()
}

/// Engine ADR 1027 — the container path a medium's bytes are kept at:
/// `paged/core/media/<name>.<ext>`, named by its content (the blobs' hash),
/// so the same medium is one part however often it is placed.
pub fn media_part_path(bytes: &[u8], ext: &str) -> String {
    let ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    let ext = if ext.is_empty() {
        "bin".to_string()
    } else {
        ext
    };
    format!(
        "{}{}.{ext}",
        paged_model::media::MEDIA_PART_PREFIX,
        blob_name(bytes)
    )
}

/// The on-disk envelope: a version tag around the model. Serialized borrowed
/// (no clone) and deserialized owned.
#[derive(serde::Serialize)]
struct PgmRef<'a> {
    format_version: u32,
    model: &'a Document,
}

#[derive(serde::Deserialize)]
struct Pgm {
    format_version: u32,
    model: Document,
}

/// Serialize a [`Document`] to native `.paged` model bytes (no IDML), stamped
/// with [`PGM_FORMAT_VERSION`]. SELF-CONTAINED: image bytes ride inline as
/// base64. A container writer uses [`to_parts`] instead.
pub fn to_bytes(doc: &Document) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec(&PgmRef {
        format_version: PGM_FORMAT_VERSION,
        model: doc,
    })
}

/// Serialize a [`Document`] for a CONTAINER: the model part, plus one part
/// per distinct image keyed by its container path under [`BLOB_PREFIX`].
/// The model part holds only the blob names.
pub fn to_parts(doc: &Document) -> Result<(Vec<u8>, BlobParts), serde_json::Error> {
    let (pgm, blobs) = paged_model::image_bytes::collect(blob_name, || to_bytes(doc));
    Ok((
        pgm?,
        blobs
            .into_iter()
            .map(|(name, bytes)| (format!("{BLOB_PREFIX}{name}"), bytes))
            .collect(),
    ))
}

/// Why a native model part did not reconstruct. The three cases call for
/// different handling, so they are told apart: a part from a NEWER engine
/// holds edits this build cannot see and must not be replaced by an older
/// reading of the document; a damaged or incomplete part can only be
/// replaced, and the caller says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PgmError {
    /// Written by a newer engine than this one (`found` >
    /// [`PGM_FORMAT_VERSION`]).
    NewerVersion { found: u32, supported: u32 },
    /// Older than the oldest part this build still reads.
    StaleVersion { found: u32, oldest: u32 },
    /// The part names an image blob the container does not hold.
    MissingBlob { name: String },
    /// Not a model part: unparseable, or not the model's shape.
    Corrupt(String),
}

impl PgmError {
    /// Whether the part was written by a newer engine: the one case a
    /// loader must refuse rather than fall back from.
    pub fn is_newer_version(&self) -> bool {
        matches!(self, Self::NewerVersion { .. })
    }
}

impl std::fmt::Display for PgmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NewerVersion { found, supported } => write!(
                f,
                "the document's native model is format version {found}, newer than this \
                 version reads (up to {supported}); open it with a newer version"
            ),
            Self::StaleVersion { found, oldest } => write!(
                f,
                "the document's native model is format version {found}, older than this \
                 version reads (from {oldest})"
            ),
            Self::MissingBlob { name } => write!(
                f,
                "the document's native model names an image part the document does not \
                 hold ({name})"
            ),
            Self::Corrupt(why) => write!(f, "the document's native model does not read: {why}"),
        }
    }
}

impl std::error::Error for PgmError {}

/// Reconstruct a [`Document`] from native `.paged` model bytes, with **no
/// `open_source_archive` / IDML parse**.
///
/// `Err` says why the part does not reconstruct ([`PgmError`]): a part is
/// never mis-deserialized (ADR-022 Q2), and the caller decides what each
/// reason means. On success, rebuilds the `#[serde(skip)]` derived caches.
pub fn from_bytes(bytes: &[u8]) -> Result<Document, PgmError> {
    from_parts(bytes, std::collections::HashMap::new())
}

/// [`from_bytes`] for a model part written by [`to_parts`]: `blobs` are the
/// container's image blobs by NAME (see [`blob_name_of`]). A part that
/// references a blob the container does not hold is
/// [`PgmError::MissingBlob`].
pub fn from_parts(
    bytes: &[u8],
    blobs: std::collections::HashMap<String, Vec<u8>>,
) -> Result<Document, PgmError> {
    let held: std::collections::HashSet<String> = blobs.keys().cloned().collect();
    let pgm: Pgm = match paged_model::image_bytes::resolve(blobs, || serde_json::from_slice(bytes))
    {
        Ok(pgm) => pgm,
        Err(e) => return Err(diagnose(bytes, &held, e)),
    };
    check_version(pgm.format_version)?;
    let mut doc = pgm.model;
    doc.rebuild_indexes();
    Ok(doc)
}

fn check_version(found: u32) -> Result<(), PgmError> {
    if found > PGM_FORMAT_VERSION {
        return Err(PgmError::NewerVersion {
            found,
            supported: PGM_FORMAT_VERSION,
        });
    }
    if found < OLDEST_READABLE_PGM {
        return Err(PgmError::StaleVersion {
            found,
            oldest: OLDEST_READABLE_PGM,
        });
    }
    Ok(())
}

/// Why a part that failed to deserialize as the model did. Runs only on that
/// failure, so the second parse costs a good load nothing. The version comes
/// first: a part of another version need not have this model's shape, and
/// its shape error would hide the real reason.
fn diagnose(
    bytes: &[u8],
    held: &std::collections::HashSet<String>,
    error: serde_json::Error,
) -> PgmError {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return PgmError::Corrupt(error.to_string());
    };
    let version = value
        .get("format_version")
        .and_then(serde_json::Value::as_u64)
        .and_then(|v| u32::try_from(v).ok());
    if let Some(Err(e)) = version.map(check_version) {
        return e;
    }
    match value.get("model").and_then(|m| missing_blob(m, held)) {
        Some(name) => PgmError::MissingBlob { name },
        None => PgmError::Corrupt(error.to_string()),
    }
}

/// The first blob reference (`{"blob": "<name>"}`, the shape
/// `paged_model::image_bytes` writes) under `value` that `held` lacks.
fn missing_blob(
    value: &serde_json::Value,
    held: &std::collections::HashSet<String>,
) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if map.len() == 1 {
                if let Some(serde_json::Value::String(name)) = map.get("blob") {
                    return (!held.contains(name)).then(|| name.clone());
                }
            }
            map.values().find_map(|v| missing_blob(v, held))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|v| missing_blob(v, held)),
        _ => None,
    }
}
