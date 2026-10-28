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

//! A new `.docx` package written from a [`DocxDocument`] (doc ADR 616).
//!
//! Save-back (the rest of this crate) splices edits into the file the user
//! opened. A document that did not come from Word has no such file: an RTF
//! or OpenDocument file read onto docx-core, or a native paged document saved
//! as `.docx`. This module writes one for it, the smallest package Word
//! opens without repair: `[Content_Types].xml`, the package and document
//! relationships, `word/document.xml`, `word/styles.xml`, `word/settings.xml`,
//! `word/numbering.xml` when the body has lists, and the pictures under
//! `word/media/`. Once written, the package is opened like any `.docx`, so
//! later saves splice into it as usual.
//!
//! What it writes: paragraphs (style, alignment, indents, spacing, line
//! spacing, keeps, page break before, tabs, list membership), runs (style,
//! bold, italic, underline, strike, caps, small caps, colour, size, font,
//! super/subscript, baseline shift, character spacing; tabs, line, page and
//! column breaks, soft and non-breaking hyphens), external and internal
//! hyperlinks, merge fields (as `w:fldSimple`), inline pictures, tables
//! (grid, row height, header rows, spans, vertical merges, cell margins and
//! alignment), the paragraph and character styles with `basedOn`, the
//! document defaults, and every section's page size, margins and columns.
//! Headers, footers and notes are not written ([`WriteReport::left_out`]
//! names them). The XML is written as text; the ooxmlsdk serializer is never
//! linked (the wasm budget, see `scripts/build-wasm.sh`).

use std::collections::BTreeMap;
use std::fmt::Write as _;

use docx_core::{
    Block, BreakKind, CellMargins, CellVAlign, DocxDocument, Image, Justification, LineRule,
    ListKind, ListMarker, ParaProps, Paragraph, Run, RunProps, Section, SectionKind, Style,
    StyleKind, Table, TableCell, VMerge, VertAlign, LINE_BREAK, SOFT_HYPHEN,
};
use paged_ooxml::opc::write_zip;
use quick_xml::escape::escape;

/// The main part's content type of a Word document (`.docx`).
pub const DOCUMENT_MAIN: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// What [`write_docx`] wrote, and what it could not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WriteReport {
    /// Content the package does not carry, one line each (headers and
    /// footers, notes), for the caller's diagnostics.
    pub left_out: Vec<String>,
}

/// Write `doc` as a new `.docx` package. The bytes open with
/// `docx_import::import_docx` to the same paragraphs, runs, styles, lists,
/// tables and sections (`docx-conformance/tests/it/files.rs`).
pub fn write_docx(doc: &DocxDocument) -> Result<(Vec<u8>, WriteReport), String> {
    let mut w = Writer::default();
    let document = w.document(doc);
    let styles = styles_xml(doc);
    let numbering = w.numbering_xml();
    let settings = settings_xml(doc);

    let mut report = WriteReport::default();
    if !doc.headers_footers.is_empty() {
        report.left_out.push(format!(
            "{} header/footer part(s) not written",
            doc.headers_footers.len()
        ));
    }
    if !doc.notes.is_empty() {
        report.left_out.push(format!(
            "{} footnote(s)/endnote(s) not written",
            doc.notes.len()
        ));
    }

    // Relationships of the main part: styles, settings, numbering, then the
    // pictures and hyperlinks in the order the body named them.
    let mut rels = String::new();
    rels.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    let _ = write!(
        rels,
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#
    );
    let _ = write!(
        rels,
        r#"<Relationship Id="rIdStyles" Type="{REL}/styles" Target="styles.xml"/>"#
    );
    let _ = write!(
        rels,
        r#"<Relationship Id="rIdSettings" Type="{REL}/settings" Target="settings.xml"/>"#
    );
    if numbering.is_some() {
        let _ = write!(
            rels,
            r#"<Relationship Id="rIdNumbering" Type="{REL}/numbering" Target="numbering.xml"/>"#
        );
    }
    for (id, target) in &w.media_rels {
        let _ = write!(
            rels,
            r#"<Relationship Id="{id}" Type="{REL}/image" Target="{}"/>"#,
            escape(target.as_str())
        );
    }
    for (id, url) in &w.link_rels {
        let _ = write!(
            rels,
            r#"<Relationship Id="{id}" Type="{REL}/hyperlink" Target="{}" TargetMode="External"/>"#,
            escape(url.as_str())
        );
    }
    rels.push_str("</Relationships>");

    let mut types = String::new();
    types.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    types.push_str(
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
    );
    types.push_str(r#"<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#);
    types.push_str(r#"<Default Extension="xml" ContentType="application/xml"/>"#);
    let mut exts: Vec<(&str, &str)> = w
        .media
        .iter()
        .map(|(name, _, mime)| (extension_of(name), mime.as_str()))
        .collect();
    exts.sort();
    exts.dedup_by(|a, b| a.0 == b.0);
    for (ext, mime) in exts {
        let _ = write!(
            types,
            r#"<Default Extension="{ext}" ContentType="{}"/>"#,
            escape(mime)
        );
    }
    let _ = write!(
        types,
        r#"<Override PartName="/word/document.xml" ContentType="{DOCUMENT_MAIN}"/>"#
    );
    types.push_str(r#"<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>"#);
    types.push_str(r#"<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>"#);
    if numbering.is_some() {
        types.push_str(r#"<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>"#);
    }
    types.push_str("</Types>");

    let root_rels = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{REL}/officeDocument" Target="word/document.xml"/></Relationships>"#
    );

    let opts = zip::write::SimpleFileOptions::DEFAULT
        .system(zip::System::Unix)
        .compression_method(zip::CompressionMethod::Deflated);
    let bytes = write_zip(opts, |zip| {
        zip.file("[Content_Types].xml", types.as_bytes())?;
        zip.file("_rels/.rels", root_rels.as_bytes())?;
        zip.file("word/_rels/document.xml.rels", rels.as_bytes())?;
        zip.file("word/document.xml", document.as_bytes())?;
        zip.file("word/styles.xml", styles.as_bytes())?;
        zip.file("word/settings.xml", settings.as_bytes())?;
        if let Some(n) = &numbering {
            zip.file("word/numbering.xml", n.as_bytes())?;
        }
        for (name, bytes, _) in &w.media {
            zip.file(&format!("word/{name}"), bytes)?;
        }
        Ok::<(), zip::result::ZipError>(())
    })
    .map_err(|e| e.to_string())?;
    Ok((bytes, report))
}

fn extension_of(name: &str) -> &str {
    name.rsplit('.').next().unwrap_or("bin")
}

/// The extension a picture of `mime` is stored with.
fn media_extension(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpeg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/x-emf" | "image/emf" => "emf",
        "image/x-wmf" | "image/wmf" => "wmf",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

/// The body writer: collects the relationships and list instances the body
/// names while it writes `word/document.xml`.
#[derive(Default)]
struct Writer {
    /// `(name under word/, bytes, mime)`.
    media: Vec<(String, Vec<u8>, String)>,
    /// `(rId, target)` of each picture.
    media_rels: Vec<(String, String)>,
    /// `(rId, url)` of each external hyperlink, one per distinct URL.
    link_rels: Vec<(String, String)>,
    /// Each list instance (`w:numId`) with the markers of its levels.
    lists: BTreeMap<i32, BTreeMap<u8, ListMarker>>,
    /// `wp:docPr/@id`, unique in the document.
    drawing_id: u32,
}

impl Writer {
    fn document(&mut self, doc: &DocxDocument) -> String {
        let mut s = String::with_capacity(4096);
        s.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
        let _ = write!(
            s,
            r#"<w:document xmlns:w="{NS_W}" xmlns:r="{NS_R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>"#
        );
        let sections: Vec<Section> = if doc.sections.is_empty() {
            vec![Section::default()]
        } else {
            doc.sections.clone()
        };
        for (k, section) in sections.iter().enumerate() {
            let start = section.first_block.min(doc.body.len());
            let end = sections
                .get(k + 1)
                .map_or(doc.body.len(), |n| n.first_block.min(doc.body.len()))
                .max(start);
            let blocks = &doc.body[start..end];
            let last = k + 1 == sections.len();
            for (i, block) in blocks.iter().enumerate() {
                // A section that is not the last ends with its `sectPr` in
                // its last paragraph's `pPr`.
                let ends_section = !last && i + 1 == blocks.len();
                match block {
                    Block::Paragraph(p) => {
                        let sect = ends_section.then(|| sect_pr(section));
                        self.paragraph(&mut s, p, sect.as_deref());
                    }
                    Block::Table(t) => {
                        self.table(&mut s, t);
                        if ends_section {
                            // Word needs a paragraph to carry the break.
                            let _ = write!(s, "<w:p><w:pPr>{}</w:pPr></w:p>", sect_pr(section));
                        }
                    }
                }
            }
            if !last && blocks.is_empty() {
                let _ = write!(s, "<w:p><w:pPr>{}</w:pPr></w:p>", sect_pr(section));
            }
            if last {
                // A body must not end with a table (Word repairs it).
                if matches!(blocks.last(), Some(Block::Table(_))) || doc.body.is_empty() {
                    s.push_str("<w:p/>");
                }
                s.push_str(&sect_pr(section));
            }
        }
        s.push_str("</w:body></w:document>");
        s
    }

    fn paragraph(&mut self, s: &mut String, p: &Paragraph, sect: Option<&str>) {
        if let Some(list) = &p.list {
            self.lists
                .entry(list.num_id)
                .or_default()
                .entry(list.level)
                .or_insert_with(|| list.clone());
        }
        s.push_str("<w:p>");
        let ppr = ppr_xml(
            &p.props,
            p.style_id.as_deref(),
            p.list.as_ref(),
            mark_rpr(p).as_deref(),
            sect,
        );
        s.push_str(&ppr);
        for name in &p.bookmarks {
            // A bookmark the paragraph starts (a cross-reference target).
            let id = self.drawing_id;
            self.drawing_id += 1;
            let _ = write!(
                s,
                r#"<w:bookmarkStart w:id="{id}" w:name="{}"/><w:bookmarkEnd w:id="{id}"/>"#,
                escape(name.as_str())
            );
        }
        let mut i = 0;
        while i < p.runs.len() {
            let run = &p.runs[i];
            if let Some(link) = &run.hyperlink {
                let mut j = i + 1;
                while j < p.runs.len() && p.runs[j].hyperlink.as_ref() == Some(link) {
                    j += 1;
                }
                if let Some(anchor) = link.strip_prefix('#') {
                    let _ = write!(s, r#"<w:hyperlink w:anchor="{}">"#, escape(anchor));
                } else {
                    let id = self.link_rel(link);
                    let _ = write!(s, r#"<w:hyperlink r:id="{id}">"#);
                }
                for r in &p.runs[i..j] {
                    self.run(s, r);
                }
                s.push_str("</w:hyperlink>");
                i = j;
                continue;
            }
            if let Some(field) = &run.merge_field {
                let mut j = i + 1;
                while j < p.runs.len()
                    && p.runs[j]
                        .merge_field
                        .as_ref()
                        .is_some_and(|m| m.occurrence == field.occurrence)
                {
                    j += 1;
                }
                let _ = write!(
                    s,
                    r#"<w:fldSimple w:instr="{}">"#,
                    escape(field.instruction.as_str())
                );
                for r in &p.runs[i..j] {
                    self.run(s, r);
                }
                s.push_str("</w:fldSimple>");
                i = j;
                continue;
            }
            self.run(s, run);
            i += 1;
        }
        s.push_str("</w:p>");
    }

    fn link_rel(&mut self, url: &str) -> String {
        if let Some((id, _)) = self.link_rels.iter().find(|(_, u)| u == url) {
            return id.clone();
        }
        let id = format!("rIdLink{}", self.link_rels.len() + 1);
        self.link_rels.push((id.clone(), url.to_string()));
        id
    }

    fn run(&mut self, s: &mut String, r: &Run) {
        let rpr = rpr_xml(&r.props, r.style_id.as_deref());
        // The text, cut at each page or column break.
        let chars: Vec<char> = r.text.chars().collect();
        let mut breaks = r.breaks.clone();
        breaks.sort_by_key(|b| b.at);
        let mut at = 0usize;
        let mut pieces: Vec<(String, Option<BreakKind>)> = Vec::new();
        for b in &breaks {
            let to = b.at.min(chars.len());
            pieces.push((chars[at.min(to)..to].iter().collect(), Some(b.kind)));
            at = to;
        }
        pieces.push((chars[at.min(chars.len())..].iter().collect(), None));
        let has_text = pieces.iter().any(|(t, b)| !t.is_empty() || b.is_some());
        if has_text || r.images.is_empty() {
            s.push_str("<w:r>");
            s.push_str(&rpr);
            for (text, brk) in &pieces {
                text_xml(s, text);
                match brk {
                    Some(BreakKind::Page) => s.push_str(r#"<w:br w:type="page"/>"#),
                    Some(BreakKind::Column) => s.push_str(r#"<w:br w:type="column"/>"#),
                    None => {}
                }
            }
            s.push_str("</w:r>");
        }
        for image in &r.images {
            s.push_str("<w:r>");
            s.push_str(&rpr);
            self.drawing(s, image);
            s.push_str("</w:r>");
        }
    }

    fn drawing(&mut self, s: &mut String, image: &Image) {
        let n = self.media.len() + 1;
        let name = format!("media/image{n}.{}", media_extension(&image.mime));
        let id = format!("rIdImage{n}");
        self.media
            .push((name.clone(), image.bytes.clone(), image.mime.clone()));
        self.media_rels.push((id.clone(), name));
        self.drawing_id += 1;
        let doc_pr = self.drawing_id;
        let (cx, cy) = (image.width_emu.max(1), image.height_emu.max(1));
        let _ = write!(
            s,
            r#"<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{doc_pr}" name="Picture {doc_pr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{doc_pr}" name="image{n}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>"#
        );
    }

    fn table(&mut self, s: &mut String, t: &Table) {
        s.push_str("<w:tbl><w:tblPr>");
        s.push_str(r#"<w:tblStyle w:val="TableGrid"/>"#);
        s.push_str(r#"<w:tblW w:w="0" w:type="auto"/>"#);
        cell_margins_xml(s, "tblCellMar", &t.cell_margins);
        s.push_str(r#"<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>"#);
        s.push_str("</w:tblPr><w:tblGrid>");
        let columns = t
            .rows
            .iter()
            .map(|r| r.cells.iter().map(|c| c.grid_span.max(1) as usize).sum())
            .max()
            .unwrap_or(0)
            .max(t.column_widths.len());
        for k in 0..columns {
            let w = t.column_widths.get(k).copied().unwrap_or(2000).max(1);
            let _ = write!(s, r#"<w:gridCol w:w="{w}"/>"#);
        }
        s.push_str("</w:tblGrid>");
        for row in &t.rows {
            s.push_str("<w:tr>");
            if row.is_header || row.height.is_some() {
                s.push_str("<w:trPr>");
                if let Some(h) = row.height {
                    let _ = write!(s, r#"<w:trHeight w:val="{h}"/>"#);
                }
                if row.is_header {
                    s.push_str("<w:tblHeader/>");
                }
                s.push_str("</w:trPr>");
            }
            let mut col = 0usize;
            for cell in &row.cells {
                let span = cell.grid_span.max(1) as usize;
                let width: i32 = (col..col + span)
                    .map(|k| t.column_widths.get(k).copied().unwrap_or(2000))
                    .sum();
                col += span;
                self.cell(s, cell, width);
            }
            s.push_str("</w:tr>");
        }
        s.push_str("</w:tbl>");
    }

    fn cell(&mut self, s: &mut String, cell: &TableCell, width: i32) {
        s.push_str("<w:tc><w:tcPr>");
        let _ = write!(s, r#"<w:tcW w:w="{}" w:type="dxa"/>"#, width.max(0));
        if cell.grid_span > 1 {
            let _ = write!(s, r#"<w:gridSpan w:val="{}"/>"#, cell.grid_span);
        }
        match cell.v_merge {
            VMerge::Restart => s.push_str(r#"<w:vMerge w:val="restart"/>"#),
            VMerge::Continue => s.push_str("<w:vMerge/>"),
            VMerge::None => {}
        }
        cell_margins_xml(s, "tcMar", &cell.margins);
        if let Some(v) = cell.v_align {
            let v = match v {
                CellVAlign::Top => "top",
                CellVAlign::Center => "center",
                CellVAlign::Bottom => "bottom",
            };
            let _ = write!(s, r#"<w:vAlign w:val="{v}"/>"#);
        }
        s.push_str("</w:tcPr>");
        if cell.paragraphs.is_empty() {
            // A cell holds at least one paragraph.
            s.push_str("<w:p/>");
        }
        for p in &cell.paragraphs {
            self.paragraph(s, p, None);
        }
        s.push_str("</w:tc>");
    }

    /// `word/numbering.xml`: an abstract numbering per list instance, its
    /// levels from the markers the body used, the other levels Word's
    /// defaults (so demoting an item in Word works).
    fn numbering_xml(&self) -> Option<String> {
        if self.lists.is_empty() {
            return None;
        }
        let mut s = String::new();
        s.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
        let _ = write!(s, r#"<w:numbering xmlns:w="{NS_W}">"#);
        for (k, (_, levels)) in self.lists.iter().enumerate() {
            let bullet = levels.values().next().map(|m| m.kind) == Some(ListKind::Bullet);
            let _ = write!(
                s,
                r#"<w:abstractNum w:abstractNumId="{k}"><w:multiLevelType w:val="hybridMultilevel"/>"#
            );
            for ilvl in 0u8..9 {
                let indent = 720 * (i32::from(ilvl) + 1);
                let _ = write!(s, r#"<w:lvl w:ilvl="{ilvl}"><w:start w:val="1"/>"#);
                let (fmt, text, font) = match levels.get(&ilvl) {
                    Some(m) => level_format(m, ilvl),
                    None if bullet => ("bullet", "\u{2022}".to_string(), None),
                    None => ("decimal", format!("%{}.", ilvl + 1), None),
                };
                let _ = write!(
                    s,
                    r#"<w:numFmt w:val="{fmt}"/><w:lvlText w:val="{}"/><w:lvlJc w:val="left"/>"#,
                    escape(text.as_str())
                );
                let m = levels.get(&ilvl);
                let left = m.and_then(|m| m.left_indent).unwrap_or(indent);
                let ind = match (
                    m.and_then(|m| m.hanging_indent),
                    m.and_then(|m| m.first_line_indent),
                ) {
                    (Some(h), _) => format!(r#"w:left="{left}" w:hanging="{h}""#),
                    (None, Some(f)) => format!(r#"w:left="{left}" w:firstLine="{f}""#),
                    (None, None) => format!(r#"w:left="{left}" w:hanging="360""#),
                };
                let _ = write!(s, "<w:pPr><w:ind {ind}/></w:pPr>");
                let size = m.and_then(|m| m.marker_half_pts);
                if font.is_some() || size.is_some() {
                    s.push_str("<w:rPr>");
                    if let Some(f) = font {
                        let f = escape(f.as_str());
                        let _ = write!(
                            s,
                            r#"<w:rFonts w:ascii="{f}" w:hAnsi="{f}" w:hint="default"/>"#
                        );
                    }
                    if let Some(sz) = size {
                        let _ = write!(s, r#"<w:sz w:val="{sz}"/>"#);
                    }
                    s.push_str("</w:rPr>");
                }
                s.push_str("</w:lvl>");
            }
            s.push_str("</w:abstractNum>");
        }
        for (k, (num_id, _)) in self.lists.iter().enumerate() {
            let _ = write!(
                s,
                r#"<w:num w:numId="{num_id}"><w:abstractNumId w:val="{k}"/></w:num>"#
            );
        }
        s.push_str("</w:numbering>");
        Some(s)
    }
}

/// A level's `w:numFmt`, `w:lvlText` and marker face.
fn level_format(m: &ListMarker, ilvl: u8) -> (&'static str, String, Option<String>) {
    match m.kind {
        ListKind::Bullet => {
            let glyph = m.bullet_char.clone().unwrap_or_else(|| "\u{2022}".into());
            // The import maps a symbol font's private-use bullet to Unicode:
            // that character is not in the symbol font, so it goes without it.
            let symbol_font = m.marker_font.as_deref().is_some_and(|f| {
                let f = f.to_ascii_lowercase();
                f == "symbol" || f.starts_with("wingdings") || f.starts_with("webdings")
            });
            let unicode = glyph.chars().next().is_some_and(|c| (c as u32) < 0xF000);
            let font = if symbol_font && unicode {
                None
            } else {
                m.marker_font.clone()
            };
            ("bullet", glyph, font)
        }
        ListKind::Numbered => {
            let head = m
                .number_format
                .as_deref()
                .and_then(|f| f.split(',').next())
                .unwrap_or("1")
                .trim();
            let fmt = match head {
                "I" => "upperRoman",
                "i" => "lowerRoman",
                "A" => "upperLetter",
                "a" => "lowerLetter",
                _ => "decimal",
            };
            (fmt, format!("%{}.", ilvl + 1), m.marker_font.clone())
        }
    }
}

fn cell_margins_xml(s: &mut String, tag: &str, m: &CellMargins) {
    if m.top.is_none() && m.left.is_none() && m.bottom.is_none() && m.right.is_none() {
        return;
    }
    let _ = write!(s, "<w:{tag}>");
    for (side, v) in [
        ("top", m.top),
        ("left", m.left),
        ("bottom", m.bottom),
        ("right", m.right),
    ] {
        if let Some(v) = v {
            let _ = write!(s, r#"<w:{side} w:w="{v}" w:type="dxa"/>"#);
        }
    }
    let _ = write!(s, "</w:{tag}>");
}

/// A run's text as `w:t` with Word's element for each tab, line break and
/// special hyphen.
fn text_xml(s: &mut String, text: &str) {
    let mut buf = String::new();
    let flush = |s: &mut String, buf: &mut String| {
        if !buf.is_empty() {
            let _ = write!(
                s,
                r#"<w:t xml:space="preserve">{}</w:t>"#,
                escape(buf.as_str())
            );
            buf.clear();
        }
    };
    for c in text.chars() {
        let element = match c {
            '\t' => Some("<w:tab/>"),
            LINE_BREAK | '\n' => Some("<w:br/>"),
            '\u{2011}' => Some("<w:noBreakHyphen/>"),
            SOFT_HYPHEN => Some("<w:softHyphen/>"),
            '\r' => Some(""),
            _ => None,
        };
        match element {
            Some(e) => {
                flush(s, &mut buf);
                s.push_str(e);
            }
            None if (c as u32) < 0x20 => {}
            None => buf.push(c),
        }
    }
    flush(s, &mut buf);
}

/// The paragraph mark's run properties (`w:pPr/w:rPr`).
fn mark_rpr(p: &Paragraph) -> Option<String> {
    if p.mark_font.is_none() && p.mark_half_pts.is_none() {
        return None;
    }
    let props = RunProps {
        font: p.mark_font.clone(),
        size_half_pts: p.mark_half_pts,
        ..RunProps::default()
    };
    Some(rpr_xml(&props, None))
}

/// `w:pPr` in `CT_PPr` order.
fn ppr_xml(
    props: &ParaProps,
    style: Option<&str>,
    list: Option<&ListMarker>,
    mark: Option<&str>,
    sect: Option<&str>,
) -> String {
    let mut s = String::new();
    if let Some(id) = style {
        let _ = write!(s, r#"<w:pStyle w:val="{}"/>"#, escape(id));
    }
    toggle(&mut s, "keepNext", props.keep_next);
    toggle(&mut s, "keepLines", props.keep_lines);
    toggle(&mut s, "pageBreakBefore", props.page_break_before);
    toggle(&mut s, "widowControl", props.widow_control);
    if let Some(l) = list {
        let _ = write!(
            s,
            r#"<w:numPr><w:ilvl w:val="{}"/><w:numId w:val="{}"/></w:numPr>"#,
            l.level, l.num_id
        );
    }
    if let Some(sh) = &props.shading {
        if let Some(fill) = &sh.fill {
            let _ = write!(
                s,
                r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#,
                escape(fill.as_str())
            );
        }
    }
    if !props.tabs.is_empty() {
        s.push_str("<w:tabs>");
        for t in &props.tabs {
            let val = t.alignment.as_deref().unwrap_or("clear");
            let _ = write!(s, r#"<w:tab w:val="{}""#, escape(val));
            if let Some(leader) = &t.leader {
                let l = match leader.as_str() {
                    "." => "dot",
                    "-" => "hyphen",
                    "_" => "underscore",
                    "\u{B7}" => "middleDot",
                    _ => "none",
                };
                let _ = write!(s, r#" w:leader="{l}""#);
            }
            let _ = write!(s, r#" w:pos="{}"/>"#, t.position);
        }
        s.push_str("</w:tabs>");
    }
    if props.space_before.is_some() || props.space_after.is_some() || props.line_spacing.is_some() {
        s.push_str("<w:spacing");
        if let Some(v) = props.space_before {
            let _ = write!(s, r#" w:before="{v}""#);
        }
        if let Some(v) = props.space_after {
            let _ = write!(s, r#" w:after="{v}""#);
        }
        if let Some(ls) = props.line_spacing {
            let rule = match ls.rule {
                LineRule::Auto => "auto",
                LineRule::Exact => "exact",
                LineRule::AtLeast => "atLeast",
            };
            let _ = write!(s, r#" w:line="{}" w:lineRule="{rule}""#, ls.value);
        }
        s.push_str("/>");
    }
    if props.left_indent.is_some()
        || props.right_indent.is_some()
        || props.first_line_indent.is_some()
        || props.hanging_indent.is_some()
    {
        s.push_str("<w:ind");
        if let Some(v) = props.left_indent {
            let _ = write!(s, r#" w:left="{v}""#);
        }
        if let Some(v) = props.right_indent {
            let _ = write!(s, r#" w:right="{v}""#);
        }
        if let Some(v) = props.hanging_indent {
            let _ = write!(s, r#" w:hanging="{v}""#);
        } else if let Some(v) = props.first_line_indent {
            let _ = write!(s, r#" w:firstLine="{v}""#);
        }
        s.push_str("/>");
    }
    toggle(&mut s, "contextualSpacing", props.contextual_spacing);
    if let Some(j) = props.justification {
        let v = match j {
            Justification::Left | Justification::Start => "left",
            Justification::Center => "center",
            Justification::Right | Justification::End => "right",
            Justification::Both => "both",
            Justification::Distribute => "distribute",
        };
        let _ = write!(s, r#"<w:jc w:val="{v}"/>"#);
    }
    if let Some(m) = mark {
        s.push_str(m);
    }
    if let Some(sp) = sect {
        s.push_str(sp);
    }
    if s.is_empty() {
        s
    } else {
        format!("<w:pPr>{s}</w:pPr>")
    }
}

/// `w:rPr` in `CT_RPr` order; empty when the run has no properties.
fn rpr_xml(props: &RunProps, style: Option<&str>) -> String {
    let mut s = String::new();
    if let Some(id) = style {
        let _ = write!(s, r#"<w:rStyle w:val="{}"/>"#, escape(id));
    }
    if props.font.is_some() || props.font_east_asia.is_some() || props.font_cs.is_some() {
        s.push_str("<w:rFonts");
        if let Some(f) = &props.font {
            let f = escape(f.as_str());
            let _ = write!(s, r#" w:ascii="{f}" w:hAnsi="{f}""#);
        }
        if let Some(f) = &props.font_east_asia {
            let _ = write!(s, r#" w:eastAsia="{}""#, escape(f.as_str()));
        }
        if let Some(f) = props.font_cs.as_ref().or(props.font.as_ref()) {
            let _ = write!(s, r#" w:cs="{}""#, escape(f.as_str()));
        }
        s.push_str("/>");
    }
    toggle(&mut s, "b", props.bold);
    toggle(&mut s, "i", props.italic);
    toggle(&mut s, "caps", props.caps);
    toggle(&mut s, "smallCaps", props.small_caps);
    toggle(&mut s, "strike", props.strike);
    if let Some(c) = &props.color {
        let _ = write!(s, r#"<w:color w:val="{}"/>"#, escape(c.as_str()));
    }
    if let Some(v) = props.spacing_twips {
        let _ = write!(s, r#"<w:spacing w:val="{v}"/>"#);
    }
    if let Some(v) = props.baseline_half_pts {
        let _ = write!(s, r#"<w:position w:val="{v}"/>"#);
    }
    if let Some(v) = props.size_half_pts {
        let _ = write!(s, r#"<w:sz w:val="{v}"/><w:szCs w:val="{v}"/>"#);
    }
    match props.underline {
        Some(true) => s.push_str(r#"<w:u w:val="single"/>"#),
        Some(false) => s.push_str(r#"<w:u w:val="none"/>"#),
        None => {}
    }
    if let Some(sh) = &props.shading {
        if let Some(fill) = &sh.fill {
            let _ = write!(
                s,
                r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#,
                escape(fill.as_str())
            );
        }
    }
    if let Some(v) = props.vert_align {
        let v = match v {
            VertAlign::Baseline => "baseline",
            VertAlign::Superscript => "superscript",
            VertAlign::Subscript => "subscript",
        };
        let _ = write!(s, r#"<w:vertAlign w:val="{v}"/>"#);
    }
    if s.is_empty() {
        s
    } else {
        format!("<w:rPr>{s}</w:rPr>")
    }
}

fn toggle(s: &mut String, name: &str, v: Option<bool>) {
    match v {
        Some(true) => {
            let _ = write!(s, "<w:{name}/>");
        }
        Some(false) => {
            let _ = write!(s, r#"<w:{name} w:val="0"/>"#);
        }
        None => {}
    }
}

/// A section's `w:sectPr`.
fn sect_pr(sec: &Section) -> String {
    let mut s = String::from("<w:sectPr>");
    let kind = match sec.kind {
        SectionKind::NextPage => None,
        SectionKind::Continuous => Some("continuous"),
        SectionKind::EvenPage => Some("evenPage"),
        SectionKind::OddPage => Some("oddPage"),
        SectionKind::NextColumn => Some("nextColumn"),
    };
    if let Some(k) = kind {
        let _ = write!(s, r#"<w:type w:val="{k}"/>"#);
    }
    let orient = if sec.page_width > sec.page_height {
        r#" w:orient="landscape""#
    } else {
        ""
    };
    let _ = write!(
        s,
        r#"<w:pgSz w:w="{}" w:h="{}"{orient}/>"#,
        sec.page_width, sec.page_height
    );
    let _ = write!(
        s,
        r#"<w:pgMar w:top="{}" w:right="{}" w:bottom="{}" w:left="{}" w:header="{}" w:footer="{}" w:gutter="0"/>"#,
        sec.margin_top,
        sec.margin_right,
        sec.margin_bottom,
        sec.margin_left,
        sec.header_distance.unwrap_or(720),
        sec.footer_distance.unwrap_or(720)
    );
    if sec.page_number_start.is_some() || sec.page_number_format.is_some() {
        s.push_str("<w:pgNumType");
        if let Some(f) = &sec.page_number_format {
            let _ = write!(s, r#" w:fmt="{}""#, escape(f.as_str()));
        }
        if let Some(n) = sec.page_number_start {
            let _ = write!(s, r#" w:start="{n}""#);
        }
        s.push_str("/>");
    }
    if sec.column_widths.is_empty() {
        let _ = write!(
            s,
            r#"<w:cols w:num="{}" w:space="{}"/>"#,
            sec.columns.max(1),
            sec.column_space
        );
    } else {
        let _ = write!(
            s,
            r#"<w:cols w:num="{}" w:equalWidth="0">"#,
            sec.column_widths.len()
        );
        for (w, space) in &sec.column_widths {
            let _ = write!(s, r#"<w:col w:w="{w}" w:space="{space}"/>"#);
        }
        s.push_str("</w:cols>");
    }
    if sec.title_page {
        s.push_str("<w:titlePg/>");
    }
    s.push_str("</w:sectPr>");
    s
}

/// `word/styles.xml`: the document defaults, the styles of `doc`, a default
/// paragraph style (Normal) when it has none, and Word's "Table Grid" for
/// the tables.
fn styles_xml(doc: &DocxDocument) -> String {
    let mut s = String::new();
    s.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    let _ = write!(s, r#"<w:styles xmlns:w="{NS_W}">"#);
    s.push_str("<w:docDefaults><w:rPrDefault>");
    let rpr = rpr_xml(&doc.styles.doc_defaults.run, None);
    s.push_str(if rpr.is_empty() { "<w:rPr/>" } else { &rpr });
    s.push_str("</w:rPrDefault><w:pPrDefault>");
    let ppr = ppr_xml(&doc.styles.doc_defaults.para, None, None, None, None);
    s.push_str(if ppr.is_empty() { "<w:pPr/>" } else { &ppr });
    s.push_str("</w:pPrDefault></w:docDefaults>");

    let has = |kind: StyleKind| {
        doc.styles
            .styles
            .iter()
            .any(|st| st.kind == kind && st.is_default)
    };
    let taken = |id: &str| doc.styles.styles.iter().any(|st| st.style_id == id);
    if !has(StyleKind::Paragraph) && !taken("Normal") {
        s.push_str(r#"<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>"#);
    }
    if !has(StyleKind::Character) && !taken("DefaultParagraphFont") {
        s.push_str(r#"<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>"#);
    }
    if !has(StyleKind::Table) && !taken("TableNormal") {
        s.push_str(r#"<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>"#);
    }
    if !taken("TableGrid") {
        s.push_str(r#"<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>"#);
    }
    for st in &doc.styles.styles {
        style_xml(&mut s, st);
    }
    s.push_str("</w:styles>");
    s
}

fn style_xml(s: &mut String, st: &Style) {
    let kind = match st.kind {
        StyleKind::Paragraph => "paragraph",
        StyleKind::Character => "character",
        StyleKind::Table => "table",
        StyleKind::Numbering => "numbering",
    };
    let default = if st.is_default {
        r#" w:default="1""#
    } else {
        ""
    };
    let _ = write!(
        s,
        r#"<w:style w:type="{kind}"{default} w:styleId="{}">"#,
        escape(st.style_id.as_str())
    );
    let name = st.name.as_deref().unwrap_or(&st.style_id);
    let _ = write!(s, r#"<w:name w:val="{}"/>"#, escape(name));
    if let Some(b) = &st.based_on {
        let _ = write!(s, r#"<w:basedOn w:val="{}"/>"#, escape(b.as_str()));
    }
    s.push_str("<w:qFormat/>");
    if st.kind == StyleKind::Paragraph {
        // A heading style carries its outline level (the navigation pane,
        // a table of contents, the PDF bookmarks Word exports).
        let level = heading_level(name);
        let mut ppr = ppr_xml(&st.para, None, None, None, None);
        if let Some(l) = level {
            let tag = format!(r#"<w:outlineLvl w:val="{}"/>"#, l - 1);
            if ppr.is_empty() {
                ppr = format!("<w:pPr>{tag}</w:pPr>");
            } else {
                ppr = ppr.replacen("</w:pPr>", &format!("{tag}</w:pPr>"), 1);
            }
        }
        s.push_str(&ppr);
    }
    if matches!(st.kind, StyleKind::Paragraph | StyleKind::Character) {
        s.push_str(&rpr_xml(&st.run, None));
    }
    s.push_str("</w:style>");
}

/// `Some(n)` for Word's built-in heading names (`heading 1`…`heading 9`,
/// any case).
pub fn heading_level(name: &str) -> Option<u8> {
    let rest = name.trim().to_ascii_lowercase();
    let n = rest.strip_prefix("heading")?.trim();
    let level: u8 = n.parse().ok()?;
    (1..=9).contains(&level).then_some(level)
}

/// `word/settings.xml`: Word 2013+ compatibility (so Word does not open the
/// file in compatibility mode) and the document's hyphenation.
fn settings_xml(doc: &DocxDocument) -> String {
    let mut s = String::new();
    s.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    let _ = write!(s, r#"<w:settings xmlns:w="{NS_W}">"#);
    s.push_str(r#"<w:defaultTabStop w:val="720"/>"#);
    if doc.auto_hyphenation {
        s.push_str("<w:autoHyphenation/>");
    }
    s.push_str(r#"<w:characterSpacingControl w:val="doNotCompress"/>"#);
    s.push_str(r#"<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>"#);
    s.push_str("</w:settings>");
    s
}
