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

//! A deck's embedded faces, decoded, with what their licences allow.
//!
//! PowerPoint embeds each face of a font the deck uses as a part
//! (`ppt/fonts/fontN.fntdata`, Embedded OpenType, usually MicroType Express
//! compressed) and lists them per typeface in `p:embeddedFontLst`, one slot
//! per style. [`faces`] decodes every slot whose licence lets an editable
//! document use it (`pptx-fonts`) and says, for every other slot, why its
//! text is drawn in a substitute.
//!
//! The embedding permissions (OS/2 `fsType`, EOT §4.1) decide:
//!
//! - installable and editable faces are used: a deck opens for editing,
//!   which both allow;
//! - preview-and-print faces are not: their licence requires the document
//!   to be read-only while it uses them, and a deck opens for editing;
//! - restricted faces, faces whose outlines may not be embedded (bitmap
//!   only) and faces tied to named web addresses are not used.

use paged_ooxml::OpcPackage;
use pptx_core::EmbeddedFont;
use pptx_fonts::Embedding;

/// What may be done with an embedded face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaceUse {
    /// The document may use it and be edited: installable or editable
    /// embedding.
    Editable,
    /// Licensed for preview and print only (the document must be
    /// read-only): not used.
    PreviewAndPrint,
    /// Not licensed for embedding: not used.
    Restricted,
    /// Only the face's bitmaps may be embedded: not used.
    BitmapOnly,
    /// Tied to named web addresses: not used.
    SitesOnly,
    /// The part could not be read: not used.
    Unreadable,
    /// The relationship names a part the package does not hold.
    Missing,
}

impl FaceUse {
    /// The camelCase name the import report uses.
    pub fn name(self) -> &'static str {
        match self {
            FaceUse::Editable => "editable",
            FaceUse::PreviewAndPrint => "previewAndPrint",
            FaceUse::Restricted => "restricted",
            FaceUse::BitmapOnly => "bitmapOnly",
            FaceUse::SitesOnly => "sitesOnly",
            FaceUse::Unreadable => "unreadable",
            FaceUse::Missing => "missing",
        }
    }
}

/// One embedded face: a style slot of an embedded typeface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeckFace {
    /// The typeface the deck's text names (`p:font typeface`).
    pub typeface: String,
    /// The slot, spelled as a run's `FontStyle`: `Regular`, `Bold`,
    /// `Italic` or `Bold Italic`.
    pub style: &'static str,
    /// The face's part.
    pub part: String,
    pub use_: FaceUse,
    /// OS/2 `fsType`, when the part could be read.
    pub fs_type: Option<u16>,
    /// The face holds only the glyphs the deck uses.
    pub subset: bool,
    /// The decoded OpenType file, for a face the document may use.
    pub sfnt: Option<Vec<u8>>,
    /// Why the part could not be read ([`FaceUse::Unreadable`]).
    pub error: Option<String>,
}

/// A deck's embedded faces and what the import says about them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EmbeddedFaces {
    pub faces: Vec<DeckFace>,
    /// One line per face that is not used, naming it and why.
    pub diagnostics: Vec<String>,
}

/// Decode the embedded faces `fonts` lists (the deck's
/// [`pptx_core::Presentation::embedded_fonts`]).
pub fn faces(pkg: &OpcPackage, fonts: &[EmbeddedFont]) -> EmbeddedFaces {
    let mut out = EmbeddedFaces::default();
    for font in fonts {
        let slots = [
            ("Regular", &font.regular),
            ("Bold", &font.bold),
            ("Italic", &font.italic),
            ("Bold Italic", &font.bold_italic),
        ];
        for (style, part) in slots {
            let Some(part) = part.as_deref() else {
                continue;
            };
            let face = face(pkg, &font.typeface, style, part);
            if let Some(why) = why_not_used(&face) {
                out.diagnostics.push(format!(
                    "{part}: embedded font \u{201c}{}\u{201d} ({style}) {why}; text set in it is drawn in a substitute",
                    font.typeface
                ));
            }
            out.faces.push(face);
        }
    }
    out
}

fn face(pkg: &OpcPackage, typeface: &str, style: &'static str, part: &str) -> DeckFace {
    let mut face = DeckFace {
        typeface: typeface.to_string(),
        style,
        part: part.to_string(),
        use_: FaceUse::Missing,
        fs_type: None,
        subset: false,
        sfnt: None,
        error: None,
    };
    let Some(bytes) = pkg.part(part) else {
        return face;
    };
    // The licence first: a face that may not be used is never decompressed.
    let permissions = match pptx_fonts::permissions(bytes) {
        Ok(p) => p,
        Err(e) => {
            face.use_ = FaceUse::Unreadable;
            face.error = Some(e.to_string());
            return face;
        }
    };
    face.fs_type = Some(permissions.fs_type);
    face.subset = permissions.subset;
    face.use_ = if permissions.restricted_to_sites {
        FaceUse::SitesOnly
    } else if permissions.bitmap_only() {
        FaceUse::BitmapOnly
    } else {
        match permissions.embedding() {
            Embedding::Installable | Embedding::Editable => FaceUse::Editable,
            Embedding::PreviewAndPrint => FaceUse::PreviewAndPrint,
            Embedding::Restricted => FaceUse::Restricted,
        }
    };
    if face.use_ == FaceUse::Editable {
        match pptx_fonts::decode(bytes) {
            Ok(decoded) => face.sfnt = Some(decoded.sfnt),
            Err(e) => {
                face.use_ = FaceUse::Unreadable;
                face.error = Some(e.to_string());
            }
        }
    }
    face
}

/// Why a face is not used, or `None` when it is.
fn why_not_used(face: &DeckFace) -> Option<String> {
    Some(match face.use_ {
        FaceUse::Editable => return None,
        FaceUse::PreviewAndPrint => {
            "is licensed for preview and print only, which needs a read-only document, and a deck opens for editing".into()
        }
        FaceUse::Restricted => "is not licensed for embedding".into(),
        FaceUse::BitmapOnly => "may embed only its bitmaps, not its outlines".into(),
        FaceUse::SitesOnly => "may be used only from the web addresses it names".into(),
        FaceUse::Unreadable => format!(
            "could not be read ({})",
            face.error.as_deref().unwrap_or("unknown error")
        ),
        FaceUse::Missing => "names a part the package does not hold".into(),
    })
}
