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

//! A document's embedded fonts (doc ADR 626).
//!
//! Word embeds a face as an obfuscated OpenType part (`word/fonts/fontN.odttf`)
//! that `word/fontTable.xml` lists per typeface: `w:embedRegular`,
//! `w:embedBold`, `w:embedItalic`, `w:embedBoldItalic`, each with the
//! relationship of the part and the `w:fontKey` that unlocks it
//! ([`paged_ooxml::fonts::deobfuscate`]). [`embedded_faces`] reads every slot
//! and decides from the face's own OS/2 `fsType` whether an editable document
//! may use it, as slide does for a deck. Reading never changes the package:
//! the font parts and the font table stay byte-identical on save.

use paged_ooxml::fonts::{deobfuscate, is_sfnt, sfnt_fs_type, use_for_fs_type, FaceUse};
use paged_ooxml::ooxmlsdk::schemas::schemas_openxmlformats_org_wordprocessingml_2006_main as wml;
use paged_ooxml::ooxmlsdk::simple_type::OnOffValue;
use paged_ooxml::{parse_root, part_dir, rels, resolve_target, OpcPackage};

/// The largest face a document may hold; a larger part is not decoded.
const MAX_FACE_BYTES: usize = 32 << 20;

/// One embedded face: a style slot of an embedded typeface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocFace {
    /// The typeface the document's text names (`w:font w:name`).
    pub typeface: String,
    /// The slot, spelled as a run's `FontStyle`: `Regular`, `Bold`,
    /// `Italic` or `Bold Italic`.
    pub style: &'static str,
    /// The face's part (`word/fonts/font1.odttf`).
    pub part: String,
    pub use_: FaceUse,
    /// OS/2 `fsType`, when the part could be read.
    pub fs_type: Option<u16>,
    /// The face holds only the glyphs the document uses (`w:subsetted`).
    pub subset: bool,
    /// The OpenType file, for a face the document may use.
    pub sfnt: Option<Vec<u8>>,
    /// Why the part could not be read ([`FaceUse::Unreadable`]).
    pub error: Option<String>,
}

/// A document's embedded faces and what the open says about them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EmbeddedFaces {
    pub faces: Vec<DocFace>,
    /// One line per face that is not used, naming it and why.
    pub diagnostics: Vec<String>,
}

/// The font table part name (via the main document's `.rels`).
fn font_table_part(pkg: &OpcPackage, main_part: &str) -> Option<String> {
    let rels_bytes = pkg.part(&rels::rels_part_name(main_part))?;
    let rels = rels::Relationships::parse(rels_bytes);
    let r = rels.by_type_suffix("/fontTable")?;
    Some(resolve_target(part_dir(main_part), &r.target))
}

/// Decode the embedded faces `word/fontTable.xml` lists.
pub fn embedded_faces(pkg: &OpcPackage, main_part: &str) -> EmbeddedFaces {
    let mut out = EmbeddedFaces::default();
    let Some(table_part) = font_table_part(pkg, main_part) else {
        return out;
    };
    let Some(table) = pkg
        .part(&table_part)
        .and_then(|b| parse_root::<wml::Fonts>(&table_part, b).ok())
    else {
        return out;
    };
    let rels = pkg
        .part(&rels::rels_part_name(&table_part))
        .map(rels::Relationships::parse)
        .unwrap_or_default();
    let dir = part_dir(&table_part).to_string();
    for choice in &table.xml_children {
        let wml::FontsChoice::Font(font) = choice else {
            continue;
        };
        let slots: [(&'static str, Option<(&str, Option<&str>, bool)>); 4] = [
            (
                "Regular",
                font.embed_regular_font
                    .as_ref()
                    .map(|e| slot(&e.id, &e.font_key, &e.subsetted)),
            ),
            (
                "Bold",
                font.embed_bold_font
                    .as_ref()
                    .map(|e| slot(&e.id, &e.font_key, &e.subsetted)),
            ),
            (
                "Italic",
                font.embed_italic_font
                    .as_ref()
                    .map(|e| slot(&e.id, &e.font_key, &e.subsetted)),
            ),
            (
                "Bold Italic",
                font.embed_bold_italic_font
                    .as_ref()
                    .map(|e| slot(&e.id, &e.font_key, &e.subsetted)),
            ),
        ];
        for (style, entry) in slots {
            let Some((id, key, subset)) = entry else {
                continue;
            };
            let part = rels
                .target_of(id)
                .map(|t| resolve_target(&dir, t))
                .unwrap_or_default();
            // A table may list a typeface twice (Word does after a merge):
            // one face per typeface, style and part.
            if out
                .faces
                .iter()
                .any(|f| f.typeface == font.name && f.style == style && f.part == part)
            {
                continue;
            }
            let face = face(pkg, &font.name, style, &part, key, subset);
            if let Some(why) = why_not_used(&face) {
                out.diagnostics.push(format!(
                    "{}: embedded font \u{201c}{}\u{201d} ({style}) {why}; text set in it is drawn in a substitute",
                    if part.is_empty() { &table_part } else { &part },
                    font.name
                ));
            }
            out.faces.push(face);
        }
    }
    out
}

fn slot<'a>(
    id: &'a str,
    key: &'a Option<String>,
    subsetted: &Option<OnOffValue>,
) -> (&'a str, Option<&'a str>, bool) {
    let subset = matches!(
        subsetted,
        Some(OnOffValue::True | OnOffValue::On | OnOffValue::One | OnOffValue::Empty)
    );
    (id, key.as_deref(), subset)
}

fn face(
    pkg: &OpcPackage,
    typeface: &str,
    style: &'static str,
    part: &str,
    key: Option<&str>,
    subset: bool,
) -> DocFace {
    let mut face = DocFace {
        typeface: typeface.to_string(),
        style,
        part: part.to_string(),
        use_: FaceUse::Missing,
        fs_type: None,
        subset,
        sfnt: None,
        error: None,
    };
    let Some(bytes) = pkg.part(part) else {
        return face;
    };
    if bytes.len() > MAX_FACE_BYTES {
        face.use_ = FaceUse::Unreadable;
        face.error = Some(format!("larger than {MAX_FACE_BYTES} bytes"));
        return face;
    }
    // A part Word wrote is obfuscated; a bare OpenType file (some producers
    // skip the key) is taken as it is.
    let font = match key {
        Some(key) => match deobfuscate(bytes, key) {
            Some(f) => f,
            None => {
                face.use_ = FaceUse::Unreadable;
                face.error = Some("the font key is not a GUID".into());
                return face;
            }
        },
        None => bytes.to_vec(),
    };
    let Some(fs_type) = sfnt_fs_type(&font) else {
        face.use_ = FaceUse::Unreadable;
        face.error = Some("not an OpenType font".into());
        return face;
    };
    debug_assert!(is_sfnt(&font));
    face.fs_type = Some(fs_type);
    face.use_ = use_for_fs_type(fs_type);
    if face.use_ == FaceUse::Editable {
        face.sfnt = Some(font);
    }
    face
}

/// Why a face is not used, or `None` when it is.
fn why_not_used(face: &DocFace) -> Option<String> {
    Some(match face.use_ {
        FaceUse::Editable => return None,
        FaceUse::PreviewAndPrint => {
            "is licensed for preview and print only, which needs a read-only document, and a document opens for editing".into()
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
