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

//! Doc ADR 616 — the files paged.doc opens and writes: templates as new
//! documents, macros carried, RTF and OpenDocument read onto docx-core and
//! written as a new `.docx`, `.doc` refused, and "Save as .docx" for a
//! native document. Every fixture is built here.

#![allow(non_snake_case)] // `…__feat__<id>` test names link the cockpit feature

use std::io::Write;

use docx_conformance::{
    hyperlink_docx, image_docx, list_docx, table_docx, template_docx, zip_parts,
};
use docx_core::{Block, DocxDocument, ListKind, Paragraph, StyleKind, VMerge};
use docx_js::core::{ObjectEdits, RunTextEdit};
use docx_js::files::{to_docx, LEGACY_DOC, MACROS_KEPT, ODT_OFF};
use docx_js::{DocSession, FileFormat, FileOptions};
use paged_ooxml::OpcPackage;

const ODT_ON: FileOptions = FileOptions { odt: true };

fn paragraphs(doc: &DocxDocument) -> Vec<&Paragraph> {
    doc.body
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            Block::Table(_) => None,
        })
        .collect()
}

fn texts(doc: &DocxDocument) -> Vec<String> {
    paragraphs(doc)
        .iter()
        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect())
        .collect()
}

fn roundtrip(bytes: &[u8]) -> (DocxDocument, DocxDocument) {
    let before = docx_import::import_docx(bytes).unwrap();
    let (written, _) = docx_export::write_docx(&before).unwrap();
    let after = docx_import::import_docx(&written).unwrap();
    (before, after)
}

fn content_types(docx: &[u8]) -> String {
    let pkg = OpcPackage::read(docx).unwrap();
    String::from_utf8(pkg.part("[Content_Types].xml").unwrap().to_vec()).unwrap()
}

#[test]
fn a_written_package_reads_back_to_the_same_paragraphs_styles_and_lists__feat__plugin_doc_file_entry(
) {
    let (before, after) = roundtrip(&template_docx());
    assert_eq!(texts(&before), texts(&after));
    let pb = paragraphs(&before);
    let pa = paragraphs(&after);
    for (b, a) in pb.iter().zip(&pa) {
        assert_eq!(b.style_id, a.style_id);
        assert_eq!(
            b.list.as_ref().map(|l| l.kind),
            a.list.as_ref().map(|l| l.kind)
        );
        assert_eq!(b.bookmarks, a.bookmarks);
        for (rb, ra) in b.runs.iter().zip(&a.runs) {
            assert_eq!(rb.props.bold, ra.props.bold);
            assert_eq!(rb.props.italic, ra.props.italic);
            assert_eq!(
                rb.merge_field.as_ref().map(|m| &m.name),
                ra.merge_field.as_ref().map(|m| &m.name)
            );
        }
    }
    let h1 = after
        .styles
        .styles
        .iter()
        .find(|s| s.style_id == "Heading1")
        .unwrap();
    assert_eq!(h1.based_on.as_deref(), Some("Normal"));
    assert_eq!(h1.run.bold, Some(true));
    assert_eq!(after.sections[0].page_width, before.sections[0].page_width);

    let (lb, la) = roundtrip(&list_docx());
    let kinds = |d: &DocxDocument| -> Vec<Option<ListKind>> {
        paragraphs(d)
            .iter()
            .map(|p| p.list.as_ref().map(|l| l.kind))
            .collect()
    };
    assert_eq!(kinds(&lb), kinds(&la));
}

#[test]
fn a_written_package_keeps_tables_pictures_and_links__feat__plugin_doc_file_entry() {
    let (before, after) = roundtrip(&table_docx());
    let table = |d: &DocxDocument| {
        d.body
            .iter()
            .find_map(|b| match b {
                Block::Table(t) => Some(t.clone()),
                Block::Paragraph(_) => None,
            })
            .unwrap()
    };
    let (tb, ta) = (table(&before), table(&after));
    assert_eq!(tb.column_widths, ta.column_widths);
    assert_eq!(tb.rows.len(), ta.rows.len());
    assert_eq!(ta.rows[0].cells[0].grid_span, 2);
    assert_eq!(ta.rows[1].cells[0].v_merge, VMerge::Restart);
    assert_eq!(ta.rows[2].cells[0].v_merge, VMerge::Continue);
    assert_eq!(texts(&before), texts(&after));

    let (ib, ia) = roundtrip(&image_docx());
    let image = |d: &DocxDocument| {
        paragraphs(d)
            .iter()
            .flat_map(|p| p.runs.iter())
            .flat_map(|r| r.images.iter())
            .next()
            .cloned()
            .unwrap()
    };
    assert_eq!(image(&ib).bytes, image(&ia).bytes);
    assert_eq!(image(&ib).width_emu, image(&ia).width_emu);

    let (_, ha) = roundtrip(&hyperlink_docx());
    let link = paragraphs(&ha)[0]
        .runs
        .iter()
        .find(|r| r.text == "Paged Media")
        .unwrap();
    assert_eq!(link.hyperlink.as_deref(), Some("https://paged.media/"));
}

/// `template_docx` with its main part typed `main_type`, plus `extra` parts.
fn retyped(main_type: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let pkg = OpcPackage::read(&template_docx()).unwrap();
    let mut parts: Vec<(String, Vec<u8>)> = pkg
        .file_names()
        .map(|n| (n.to_string(), pkg.part(n).unwrap().to_vec()))
        .collect();
    for (name, bytes) in &mut parts {
        if name == "[Content_Types].xml" {
            let s = String::from_utf8(bytes.clone()).unwrap().replace(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                main_type,
            );
            *bytes = s.into_bytes();
        }
    }
    for (name, bytes) in extra {
        parts.push((name.to_string(), bytes.to_vec()));
    }
    let refs: Vec<(&str, &[u8])> = parts
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .collect();
    zip_parts(&refs)
}

#[test]
fn a_dotx_opens_as_a_new_untitled_document_that_saves_as_a_docx__feat__plugin_doc_file_entry() {
    let dotx = retyped(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
        &[],
    );
    let (session, report) =
        DocSession::open_file(&dotx, "Letterhead.dotx", FileOptions::default()).unwrap();
    assert_eq!(report.format, FileFormat::Dotx);
    assert!(report.untitled);
    assert_eq!(report.save_name, "Untitled.docx");
    assert!(report.diagnostics[0].contains("Letterhead.dotx"));
    let types = content_types(session.source());
    assert!(types.contains("wordprocessingml.document.main+xml"));
    assert!(!types.contains("template.main+xml"));
    assert_eq!(
        texts(session.model()),
        texts(&docx_import::import_docx(&template_docx()).unwrap())
    );
    // Every other part keeps its bytes.
    let a = OpcPackage::read(&dotx).unwrap();
    let b = OpcPackage::read(session.source()).unwrap();
    for name in a.file_names().filter(|n| *n != "[Content_Types].xml") {
        assert_eq!(a.part(name), b.part(name), "{name}");
    }
}

#[test]
fn a_docm_keeps_its_macros_through_save_back_and_says_so__feat__plugin_doc_file_entry() {
    let vba: &[u8] = b"\xD0\xCF\x11\xE0 not run, only carried";
    let rels: &[u8] = br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/wordVbaData" Target="vbaData.xml"/></Relationships>"#;
    let docm = retyped(
        "application/vnd.ms-word.document.macroEnabled.main+xml",
        &[
            ("word/vbaProject.bin", vba),
            ("word/_rels/vbaProject.bin.rels", rels),
        ],
    );
    let (session, report) =
        DocSession::open_file(&docm, "Budget.docm", FileOptions::default()).unwrap();
    assert_eq!(report.format, FileFormat::Docm);
    assert!(report.macros);
    assert!(!report.untitled);
    assert_eq!(report.save_name, "Budget.docm");
    assert_eq!(report.diagnostics, vec![MACROS_KEPT.to_string()]);
    // An edit saved back: the VBA project and its relationships are the
    // same bytes, the content type still a macro-enabled document.
    let (saved, _) = session
        .save_object_edits(&ObjectEdits {
            runs: vec![RunTextEdit {
                block: 0,
                cell: None,
                para: None,
                run: 0,
                text: "Annual letter".into(),
            }],
            ..ObjectEdits::default()
        })
        .unwrap();
    let pkg = OpcPackage::read(&saved).unwrap();
    assert_eq!(pkg.part("word/vbaProject.bin"), Some(vba));
    assert_eq!(pkg.part("word/_rels/vbaProject.bin.rels"), Some(rels));
    assert!(content_types(&saved).contains("macroEnabled.main+xml"));
    assert_eq!(
        texts(&docx_import::import_docx(&saved).unwrap())[0],
        "Annual letter"
    );

    // A macro-enabled template: a new .docm.
    let dotm = retyped(
        "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
        &[("word/vbaProject.bin", vba)],
    );
    let (session, report) =
        DocSession::open_file(&dotm, "Form.dotm", FileOptions::default()).unwrap();
    assert_eq!(report.format, FileFormat::Dotm);
    assert!(report.untitled && report.macros);
    assert_eq!(report.save_name, "Untitled.docm");
    assert!(content_types(session.source()).contains("document.macroEnabled.main+xml"));
}

#[test]
fn an_rtf_opens_as_a_word_document__feat__plugin_doc_file_entry() {
    let rtf = br"{\rtf1\ansi\deff0{\fonttbl{\f0 Calibri;}}{\stylesheet{\s0 Normal;}{\s1\sbasedon0\b\fs32 heading 1;}}
\pard\s1\b\fs32 Report\par
\pard\s0 Plain and {\i italic} text.\par
\trowd\cellx3000\cellx6000\pard\intbl A1\cell B1\cell\row
\pard After the table.\par}";
    for name in ["report.rtf", "report.doc"] {
        let (session, report) = DocSession::open_file(rtf, name, FileOptions::default()).unwrap();
        assert_eq!(report.format, FileFormat::Rtf);
        assert_eq!(report.save_name, "report.docx");
        let doc = session.model();
        assert_eq!(
            texts(doc),
            vec!["Report", "Plain and italic text.", "After the table."]
        );
        assert_eq!(paragraphs(doc)[0].style_id.as_deref(), Some("Heading1"));
        let h1 = doc
            .styles
            .styles
            .iter()
            .find(|s| s.style_id == "Heading1")
            .unwrap();
        assert_eq!(h1.name.as_deref(), Some("heading 1"));
        assert_eq!(h1.kind, StyleKind::Paragraph);
        assert!(doc
            .body
            .iter()
            .any(|b| matches!(b, Block::Table(t) if t.rows[0].cells.len() == 2)));
        // The session's source is a .docx it can save back into.
        assert_eq!(&session.source()[..2], b"PK");
        assert!(!session.lowered().story.blocks.is_empty());
    }
}

#[test]
fn a_binary_doc_is_refused_with_what_to_do__feat__plugin_doc_file_entry() {
    let cfb = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1rest of an old Word file";
    let err = to_docx(cfb, "old.doc", ODT_ON).unwrap_err();
    assert_eq!(err, LEGACY_DOC);
    assert!(err.contains("save it as a Word Document (.docx)"));
}

fn odt_bytes() -> Vec<u8> {
    const NS: &str = r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0""#;
    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-content {NS}><office:body><office:text><text:h text:outline-level="1">Minutes</text:h><text:p>First point.</text:p><text:list text:style-name="L1"><text:list-item><text:p>Item</text:p></text:list-item></text:list></office:text></office:body></office:document-content>"#
    );
    let styles = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-styles {NS}><office:styles><text:list-style style:name="L1"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style></office:styles></office:document-styles>"#
    );
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/vnd.oasis.opendocument.text")
            .unwrap();
        zip.start_file("content.xml", stored).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
        zip.start_file("styles.xml", stored).unwrap();
        zip.write_all(styles.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    cursor.into_inner()
}

#[test]
fn an_odt_opens_behind_its_flag__feat__plugin_doc_file_entry() {
    let odt = odt_bytes();
    assert_eq!(
        DocSession::open_file(&odt, "minutes.odt", FileOptions::default())
            .err()
            .as_deref(),
        Some(ODT_OFF)
    );
    let (session, report) = DocSession::open_file(&odt, "minutes.odt", ODT_ON).unwrap();
    assert_eq!(report.format, FileFormat::Odt);
    assert_eq!(report.save_name, "minutes.docx");
    let doc = session.model();
    assert_eq!(texts(doc), vec!["Minutes", "First point.", "Item"]);
    assert_eq!(paragraphs(doc)[0].style_id.as_deref(), Some("Heading1"));
    assert_eq!(
        paragraphs(doc)[2].list.as_ref().map(|l| l.kind),
        Some(ListKind::Bullet)
    );
}

#[test]
fn a_native_document_saves_as_a_docx_that_reads_back_equal__feat__plugin_doc_file_entry() {
    let input: docx_export::NativeDocIn = serde_json::from_value(serde_json::json!({
        "stories": [{
            "selfId": "Story/u1",
            "paragraphs": [
                { "paragraphStyle": "ParagraphStyle/Heading 1", "runs": [{ "text": "Plan" }] },
                { "paragraphStyle": "ParagraphStyle/$ID/NormalParagraphStyle", "runs": [
                    { "text": "Ship it " },
                    { "text": "now", "fontStyle": "Bold", "fillColor": "Color/Red" }
                ] },
                { "paragraphStyle": "ParagraphStyle/Bullet", "runs": [{ "text": "One" }] }
            ]
        }],
        "styles": [
            { "collection": "paragraph", "styleId": "ParagraphStyle/Heading 1", "name": "Heading 1",
              "basedOn": "ParagraphStyle/$ID/NormalParagraphStyle",
              "entries": [
                { "path": "characterFontSize", "value": { "type": "length", "value": 20 } },
                { "path": "characterFontStyle", "value": { "type": "text", "value": "Bold" } },
                { "path": "paragraphSpaceAfter", "value": { "type": "length", "value": 6 } }
              ] },
            { "collection": "paragraph", "styleId": "ParagraphStyle/Bullet", "name": "Bullet",
              "entries": [ { "path": "paragraphListType", "value": { "type": "enum", "value": "BulletList" } } ] }
        ],
        "colors": { "Color/Red": "FF0000" },
        "page": { "widthPt": 595.0, "heightPt": 842.0, "marginTopPt": 72.0, "marginLeftPt": 54.0 }
    }))
    .unwrap();
    let (bytes, _) = docx_js::files::native_docx(&input).unwrap();
    let doc = docx_import::import_docx(&bytes).unwrap();
    assert_eq!(texts(&doc), vec!["Plan", "Ship it now", "One"]);
    let ps = paragraphs(&doc);
    assert_eq!(ps[0].style_id.as_deref(), Some("Heading1"));
    let h1 = doc
        .styles
        .styles
        .iter()
        .find(|s| s.style_id == "Heading1")
        .unwrap();
    assert_eq!(h1.name.as_deref(), Some("heading 1"));
    assert_eq!(h1.based_on.as_deref(), Some("Normal"));
    assert_eq!(h1.run.size_half_pts, Some(40));
    assert_eq!(h1.run.bold, Some(true));
    assert_eq!(h1.para.space_after, Some(120));
    let now = ps[1].runs.iter().find(|r| r.text == "now").unwrap();
    assert_eq!(now.props.bold, Some(true));
    assert_eq!(now.props.color.as_deref(), Some("FF0000"));
    assert_eq!(ps[2].list.as_ref().map(|l| l.kind), Some(ListKind::Bullet));
    let s = &doc.sections[0];
    assert_eq!((s.page_width, s.page_height), (11900, 16840));
    assert_eq!((s.margin_top, s.margin_left), (1440, 1080));
    // And it opens as a session (the round trip the bundle makes).
    let (session, report) =
        DocSession::open_file(&bytes, "Plan.docx", FileOptions::default()).unwrap();
    assert_eq!(report.format, FileFormat::Docx);
    assert_eq!(texts(session.model()), texts(&doc));
}
