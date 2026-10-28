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

//! Illustrator files (gap D-61). An `.ai` file saved with "Create PDF
//! Compatible File" (Illustrator's default) IS a PDF: Illustrator writes
//! the artwork as ordinary PDF pages and keeps its own editing data beside
//! them, in `AIPrivateData` streams that the PDF's `/PieceInfo
//! /Illustrator` dictionary points at. The reader reads the PDF and never
//! parses that private data: what Illustrator alone understands (live
//! effects, appearance stacks, symbols, editable type on a path, artboard
//! settings) arrives as the PDF draws it.
//!
//! Without PDF compatibility there is nothing to read: Illustrator CS and
//! later still write a PDF, whose one page carries a stand-in sentence
//! ("This is an Adobe Illustrator file that was saved without PDF
//! content…"), and Illustrator 8 and earlier wrote PostScript. Both are
//! refused with the reason.

use hayro_interpret::hayro_syntax::page::Page;

/// What the first bytes of a file say it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    /// The file opens as a PDF.
    pub is_pdf: bool,
    /// The file is Illustrator's.
    pub ai: bool,
    /// It carries Illustrator's private data.
    pub has_private_data: bool,
}

/// Illustrator's stand-in when it saved no PDF content.
pub const STAND_IN: &str = "it was saved without \"Create PDF Compatible File\"; open it in Illustrator and save it again with that option on";
/// A PostScript-era Illustrator file.
pub const POSTSCRIPT: &str = "it is a PostScript Illustrator file (Illustrator 8 or earlier), which carries no PDF; save it again from a newer Illustrator";

impl Format {
    /// Why the file cannot be read as an Illustrator file, if it cannot.
    pub fn refusal(&self) -> Option<&'static str> {
        (self.ai && !self.is_pdf).then_some(POSTSCRIPT)
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Sniff `bytes`.
pub fn sniff(bytes: &[u8]) -> Format {
    let head = &bytes[..bytes.len().min(1024)];
    let is_pdf = contains(head, b"%PDF-");
    let has_private_data = contains(bytes, b"AIPrivateData");
    let head4k = &bytes[..bytes.len().min(4096)];
    let ai = has_private_data
        || contains(head4k, b"%%Creator: Adobe Illustrator")
        || contains(head4k, b"%AI")
        || (is_pdf && contains(bytes, b"/Illustrator"))
        || (bytes.starts_with(b"%!PS-Adobe") && contains(head4k, b"Illustrator"));
    Format {
        is_pdf,
        ai,
        has_private_data,
    }
}

/// True for the page Illustrator writes into a file it saved without PDF
/// content: a localized sentence ("This is an Adobe Illustrator file that
/// was saved without PDF content", "Dies ist eine Adobe Illustrator-Datei,
/// die ohne PDF-Inhalt gespeichert wurde", …), repeated down the page and
/// nothing else. `items` is the page as read; the page is the stand-in
/// when everything on it is text that names Illustrator and PDF. The
/// content stream is read too, for a stand-in whose font the reader
/// cannot draw.
pub fn is_stand_in(page: &Page<'_>, items: &[super::ir::Item]) -> bool {
    use super::ir::Item;
    fn texts(items: &[Item], out: &mut String) -> bool {
        for i in items {
            match i {
                Item::Text(t) => out.push_str(&t.text),
                Item::Group(g) => {
                    if !texts(&g.items, out) {
                        return false;
                    }
                }
                _ => return false,
            }
        }
        true
    }
    let mut text = String::new();
    if !items.is_empty() && texts(items, &mut text) {
        return text.contains("Illustrator") && text.contains("PDF");
    }
    let Some(content) = page.page_stream() else {
        return false;
    };
    // Every language's sentence names Illustrator and PDF; real artwork
    // whose own page stream says both, with nothing drawn the reader can
    // see, is the stand-in too.
    content.len() < 64 * 1024 && contains(content, b"Illustrator") && contains(content, b"PDF")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pdf_is_not_an_illustrator_file() {
        let f = sniff(b"%PDF-1.7\n%\xe2\xe3\n1 0 obj << >> endobj");
        assert!(f.is_pdf && !f.ai && f.refusal().is_none());
    }

    #[test]
    fn a_postscript_illustrator_file_is_refused() {
        let f = sniff(b"%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n%%For: x\n");
        assert!(f.ai && !f.is_pdf);
        assert_eq!(f.refusal(), Some(POSTSCRIPT));
    }

    #[test]
    fn private_data_marks_an_illustrator_pdf() {
        let f = sniff(b"%PDF-1.6\n%\xe2\xe3\n5 0 obj << /AIPrivateData1 6 0 R >> endobj");
        assert!(f.is_pdf && f.ai && f.has_private_data);
        assert_eq!(f.refusal(), None);
    }
}
