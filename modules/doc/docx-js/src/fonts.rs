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

//! The embedded faces of a document, as the bundle reads them (doc ADR 626):
//! the report as JSON and the usable faces' bytes one after the other. The
//! same shape as paged.slide's `DeckFonts`, so both bundles hand them to the
//! host's document-font door alike.

use docx_import::fonts::EmbeddedFaces;
use serde::Serialize;

/// One embedded face: a style of a typeface the document embeds.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FaceReport {
    /// The typeface the document's text names.
    pub family: String,
    /// `Regular`, `Bold`, `Italic` or `Bold Italic` (a run's `FontStyle`).
    pub style: String,
    pub part: String,
    /// `editable` (the document uses it), or why it is not used:
    /// `previewAndPrint`, `restricted`, `bitmapOnly`, `sitesOnly`,
    /// `unreadable`, `missing`.
    #[serde(rename = "use")]
    pub use_: &'static str,
    /// OS/2 `fsType` (the embedding permissions), when the part was read.
    pub fs_type: Option<u16>,
    /// The face holds only the glyphs the document uses.
    pub subset: bool,
    /// Where the face sits in the data (`length` 0 when it is not used).
    pub offset: usize,
    pub length: usize,
}

/// What the bundle receives: the faces, one line per face not used, and the
/// bytes the faces' offsets point into.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FontsOut {
    pub faces: Vec<FaceReport>,
    pub diagnostics: Vec<String>,
    #[serde(skip)]
    pub data: Vec<u8>,
}

/// The faces as the bundle's report lists them, with their bytes.
pub fn face_reports(faces: EmbeddedFaces) -> FontsOut {
    let mut data = Vec::new();
    let reports = faces
        .faces
        .into_iter()
        .map(|f| {
            let offset = data.len();
            if let Some(sfnt) = &f.sfnt {
                data.extend_from_slice(sfnt);
            }
            FaceReport {
                family: f.typeface,
                style: f.style.to_string(),
                part: f.part,
                use_: f.use_.name(),
                fs_type: f.fs_type,
                subset: f.subset,
                offset,
                length: data.len() - offset,
            }
        })
        .collect();
    FontsOut {
        faces: reports,
        diagnostics: faces.diagnostics,
        data,
    }
}
