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

//! The file formats paged.doc opens (doc ADR 616), decided by the bytes,
//! not by the name: each one becomes the `.docx` package a [`DocSession`]
//! works on, so the lowering, the pour and save-back are the same for all.
//!
//! - `.docx` as it is.
//! - `.dotx` / `.dotm` (a Word template): a NEW document from the template.
//!   The main part's content type becomes a document's, so the package that
//!   is saved is a `.docx` (or `.docm`), never the template.
//! - `.docm` (macros): opened as a `.docx`; `word/vbaProject.bin` and its
//!   relationships ride through save-back untouched and are never run.
//! - `.rtf` (also an RTF file named `.doc`): read onto docx-core
//!   (`docx-rtf`) and written as a new `.docx` (`docx_export::write_docx`).
//! - `.odt` / `.ott`: read onto docx-core (`docx-odt`) and written the
//!   same way, when the caller turns it on (`FileOptions::odt`).
//! - `.doc` (Word 97–2003 binary): refused with what to do instead.
//!
//! [`DocSession`]: crate::DocSession

use paged_ooxml::{sniff_legacy, ContentTypes, LegacyContainer, OpcPackage};
use serde::Serialize;

/// What the caller allows.
#[derive(Debug, Clone, Copy, Default)]
pub struct FileOptions {
    /// Read OpenDocument text (behind a flag while it is new).
    pub odt: bool,
}

/// The format a file was opened as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Docx,
    Docm,
    Dotx,
    Dotm,
    Rtf,
    Odt,
}

/// What opening a file did, for the bundle: the format, whether it opened
/// as a new untitled document, the name to save under, and the notes to
/// show (diagnostics).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenReport {
    pub format: FileFormat,
    /// A template (or a file in another format) opened as a new document:
    /// saving it writes a new `.docx`, never the file it came from.
    pub untitled: bool,
    /// The package carries a VBA project (kept, never run).
    pub macros: bool,
    /// The name the document saves under.
    pub save_name: String,
    /// What the reader left out or the user should know.
    pub diagnostics: Vec<String>,
}

/// The `.doc` refusal.
pub const LEGACY_DOC: &str = "This is a Word 97–2003 document (.doc), which paged.doc does not open. Open it in Word and save it as a Word Document (.docx) (File ▸ Save As ▸ Word Document), then open the .docx.";

const DOCUMENT_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const TEMPLATE_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";
const MACRO_DOCUMENT_MAIN: &str = "application/vnd.ms-word.document.macroEnabled.main+xml";
const MACRO_TEMPLATE_MAIN: &str = "application/vnd.ms-word.template.macroEnabledTemplate.main+xml";

/// The macros note.
pub const MACROS_KEPT: &str =
    "This document contains macros. They are kept in the file and saved with it, but paged.doc never runs them.";

/// The name of a file without its extension.
fn stem(name: &str) -> &str {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 => &base[..i],
        _ => base,
    }
}

/// Turn `bytes` (named `name`) into the `.docx` package to open.
pub fn to_docx(
    bytes: &[u8],
    name: &str,
    options: FileOptions,
) -> Result<(Vec<u8>, OpenReport), String> {
    match sniff_legacy(bytes) {
        Some(LegacyContainer::Cfb | LegacyContainer::WinWord2) => return Err(LEGACY_DOC.into()),
        Some(LegacyContainer::Rtf) => return from_rtf(bytes, name),
        None => {}
    }
    if docx_rtf::is_rtf(bytes) {
        return from_rtf(bytes, name);
    }
    if is_opendocument(bytes) {
        return from_odt(bytes, name, options);
    }
    from_opc(bytes, name)
}

fn is_opendocument(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        && bytes.get(30..38) == Some(b"mimetype")
        && bytes
            .get(38..80)
            .is_some_and(|m| m.starts_with(b"application/vnd.oasis.opendocument"))
}

fn written(doc: &docx_core::DocxDocument) -> Result<(Vec<u8>, Vec<String>), String> {
    let (bytes, report) = docx_export::write_docx(doc)?;
    Ok((bytes, report.left_out))
}

fn from_rtf(bytes: &[u8], name: &str) -> Result<(Vec<u8>, OpenReport), String> {
    let read = docx_rtf::read_rtf(bytes)?;
    let (docx, left_out) = written(&read.doc)?;
    let mut diagnostics = read.diagnostics;
    diagnostics.extend(left_out);
    Ok((
        docx,
        OpenReport {
            format: FileFormat::Rtf,
            untitled: false,
            macros: false,
            save_name: format!("{}.docx", stem(name)),
            diagnostics,
        },
    ))
}

#[cfg(feature = "odt")]
fn from_odt(
    bytes: &[u8],
    name: &str,
    options: FileOptions,
) -> Result<(Vec<u8>, OpenReport), String> {
    if !options.odt {
        return Err(ODT_OFF.into());
    }
    let read = docx_odt::read_odt(bytes)?;
    let (docx, left_out) = written(&read.doc)?;
    let mut diagnostics = read.diagnostics;
    diagnostics.extend(left_out);
    diagnostics.push("Opened from OpenDocument: it saves as a Word document (.docx).".into());
    Ok((
        docx,
        OpenReport {
            format: FileFormat::Odt,
            untitled: read.template,
            macros: false,
            save_name: if read.template {
                "Untitled.docx".into()
            } else {
                format!("{}.docx", stem(name))
            },
            diagnostics,
        },
    ))
}

#[cfg(not(feature = "odt"))]
fn from_odt(_: &[u8], _: &str, _: FileOptions) -> Result<(Vec<u8>, OpenReport), String> {
    Err(ODT_OFF.into())
}

/// The OpenDocument refusal while the reader is off.
pub const ODT_OFF: &str =
    "OpenDocument text (.odt) is not turned on in this paged.doc. Save it as .docx and open that.";

fn from_opc(bytes: &[u8], name: &str) -> Result<(Vec<u8>, OpenReport), String> {
    let mut package = OpcPackage::read(bytes).map_err(|e| e.to_string())?;
    let types_xml = package
        .part(paged_ooxml::CONTENT_TYPES_PART)
        .map(<[u8]>::to_vec)
        .unwrap_or_default();
    let types = ContentTypes::parse(&types_xml).ok();
    let main =
        docx_import::main_document_part(&package).unwrap_or_else(|| "word/document.xml".into());
    let main_type = types
        .as_ref()
        .and_then(|t| t.content_type_of(&format!("/{main}")))
        .unwrap_or(DOCUMENT_MAIN)
        .to_string();
    let vba = package.file_names().any(|n| {
        n.rsplit('/')
            .next()
            .is_some_and(|f| f.eq_ignore_ascii_case("vbaProject.bin"))
    });
    let (format, new_type) = match main_type.as_str() {
        TEMPLATE_MAIN => (FileFormat::Dotx, Some(DOCUMENT_MAIN)),
        MACRO_TEMPLATE_MAIN => (FileFormat::Dotm, Some(MACRO_DOCUMENT_MAIN)),
        MACRO_DOCUMENT_MAIN => (FileFormat::Docm, None),
        _ if vba => (FileFormat::Docm, None),
        _ => (FileFormat::Docx, None),
    };
    let macros = vba || matches!(format, FileFormat::Docm | FileFormat::Dotm);
    let mut diagnostics = Vec::new();
    if macros {
        diagnostics.push(MACROS_KEPT.to_string());
    }
    let untitled = matches!(format, FileFormat::Dotx | FileFormat::Dotm);
    let ext = if macros { "docm" } else { "docx" };
    let save_name = if untitled {
        format!("Untitled.{ext}")
    } else {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".docx") || lower.ends_with(".docm") {
            name.rsplit(['/', '\\']).next().unwrap_or(name).to_string()
        } else {
            format!("{}.{ext}", stem(name))
        }
    };
    let Some(new_type) = new_type else {
        return Ok((
            bytes.to_vec(),
            OpenReport {
                format,
                untitled,
                macros,
                save_name,
                diagnostics,
            },
        ));
    };
    // A template: its main part becomes a document's. Only the content
    // types part changes; every other part keeps its bytes.
    let text = String::from_utf8_lossy(&types_xml).into_owned();
    let template = if format == FileFormat::Dotx {
        TEMPLATE_MAIN
    } else {
        MACRO_TEMPLATE_MAIN
    };
    let replaced = text.replace(template, new_type);
    package.set_part(paged_ooxml::CONTENT_TYPES_PART, replaced.into_bytes());
    let docx = package.write().map_err(|e| e.to_string())?;
    diagnostics.insert(
        0,
        format!(
            "A new document from the template {}: saving writes a new .{ext}, the template stays as it is.",
            name.rsplit(['/', '\\']).next().unwrap_or(name)
        ),
    );
    Ok((
        docx,
        OpenReport {
            format,
            untitled,
            macros,
            save_name,
            diagnostics,
        },
    ))
}

/// "Save as .docx" for a native document: the `.docx` bytes and what the
/// package does not carry.
pub fn native_docx(input: &docx_export::NativeDocIn) -> Result<(Vec<u8>, Vec<String>), String> {
    let doc = docx_export::native_document(input);
    written(&doc)
}
