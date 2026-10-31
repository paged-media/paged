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

//! [`structure_docx`]: a Word document's structure in one small file (doc
//! ADRs 611 / 612) — two sections with a different first page and their
//! own headers, footers with `PAGE` and `NUMPAGES`, footnotes and an
//! endnote, bookmarks, `REF` / `PAGEREF` / `SEQ` fields and a table of
//! contents whose entries carry live `PAGEREF`s.

use crate::zip_parts;

const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;

/// A run of text.
fn t(text: &str) -> String {
    format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

/// A complex field (`fldChar begin / instrText / separate / result / end`).
fn field(code: &str, result: &str) -> String {
    format!(
        r#"<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> {code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>{}<w:r><w:fldChar w:fldCharType="end"/></w:r>"#,
        t(result)
    )
}

fn para(style: Option<&str>, inner: &str) -> String {
    let ppr = style.map_or(String::new(), |s| {
        format!(r#"<w:pPr><w:pStyle w:val="{s}"/></w:pPr>"#)
    });
    format!("<w:p>{ppr}{inner}</w:p>")
}

/// A heading with its bookmark (what a TOC entry and a cross-reference
/// point at).
fn heading(level: u8, bookmark: &str, id: u32, text: &str) -> String {
    para(
        Some(&format!("Heading{level}")),
        &format!(
            r#"<w:bookmarkStart w:id="{id}" w:name="{bookmark}"/>{}<w:bookmarkEnd w:id="{id}"/>"#,
            t(text)
        ),
    )
}

fn note_ref(id: i64, endnote: bool) -> String {
    let (style, el) = if endnote {
        ("EndnoteReference", "endnoteReference")
    } else {
        ("FootnoteReference", "footnoteReference")
    };
    format!(r#"<w:r><w:rPr><w:rStyle w:val="{style}"/></w:rPr><w:{el} w:id="{id}"/></w:r>"#)
}

const STYLES: &str = r#"<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="5750"/></w:tabs><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="5750"/></w:tabs><w:spacing w:after="60"/><w:ind w:left="200"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>"#;

/// The header and footer parts: (rel id, part, footer?, paragraph XML).
fn header_parts() -> Vec<(&'static str, &'static str, bool, String)> {
    vec![
        (
            "rH1",
            "header1.xml",
            false,
            para(Some("Header"), &t("Report header")),
        ),
        (
            "rH2",
            "header2.xml",
            false,
            para(Some("Header"), &t("Title page header")),
        ),
        (
            "rH3",
            "header3.xml",
            false,
            para(Some("Header"), &t("Section two header")),
        ),
        (
            "rF1",
            "footer1.xml",
            true,
            para(
                Some("Footer"),
                &format!(
                    "{}{}{}{}",
                    t("Page "),
                    field("PAGE", "1"),
                    t(" of "),
                    field("NUMPAGES", "4")
                ),
            ),
        ),
    ]
}

/// The note texts: (endnote?, id, text).
pub const STRUCTURE_NOTES: &[(bool, i64, &str)] = &[
    (false, 1, "First note text."),
    (false, 2, "Second note text."),
    (true, 1, "An endnote."),
];

fn notes_part(endnote: bool) -> String {
    let (root, el, style, mark) = if endnote {
        ("endnotes", "endnote", "EndnoteText", "endnoteRef")
    } else {
        ("footnotes", "footnote", "FootnoteText", "footnoteRef")
    };
    let mut xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:{root} {W}><w:{el} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:{el}><w:{el} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:{el}>"#
    );
    for (e, id, text) in STRUCTURE_NOTES {
        if *e != endnote {
            continue;
        }
        let ref_style = if endnote {
            "EndnoteReference"
        } else {
            "FootnoteReference"
        };
        xml.push_str(&format!(
            r#"<w:{el} w:id="{id}"><w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:rPr><w:rStyle w:val="{ref_style}"/></w:rPr><w:{mark}/></w:r>{}{}</w:p></w:{el}>"#,
            t(" "),
            t(text)
        ));
    }
    xml.push_str(&format!("</w:{root}>"));
    xml
}

/// Two sections on 5 × 4 in pages:
///
/// - **S1** has a different first page (`Title page header`, no footer
///   there) and on its other pages `Report header` over the footer
///   `Page {PAGE} of {NUMPAGES}`. It holds a table of contents (`TOC \o
///   "1-2" \h \z \u`, entries `Introduction`, `Background`, `Results`
///   each with a `PAGEREF` to its heading's `_Toc` bookmark), a page
///   break, the headings `Introduction` and `Background`, a footnote, a
///   `REF` and a `PAGEREF` to `_Toc2` and an endnote.
/// - **S2** starts a new page, restarts its numbers at 1, has its own
///   default header `Section two header` and links its footer to S1's. It
///   holds the heading `Results`, a second footnote and `Figure {SEQ}`.
pub fn structure_docx() -> Vec<u8> {
    let parts = header_parts();
    let mut content_types = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
"#,
    );
    let mut rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rFn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rEn" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
"#,
    );
    let mut files: Vec<(String, String)> = Vec::new();
    for (id, part, footer, body) in &parts {
        let (kind, root) = if *footer {
            ("footer", "ftr")
        } else {
            ("header", "hdr")
        };
        content_types.push_str(&format!(
            r#"  <Override PartName="/word/{part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>
"#
        ));
        rels.push_str(&format!(
            r#"  <Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{part}"/>
"#
        ));
        files.push((
            format!("word/{part}"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:{root} {W}>{body}</w:{root}>"#
            ),
        ));
    }
    content_types.push_str("</Types>");
    rels.push_str("</Relationships>");

    let page = r#"<w:pgSz w:w="7200" w:h="5760"/><w:pgMar w:top="1080" w:right="720" w:bottom="1080" w:left="720" w:header="432" w:footer="432" w:gutter="0"/>"#;
    let s1 = format!(
        r#"<w:sectPr><w:headerReference w:type="default" r:id="rH1"/><w:headerReference w:type="first" r:id="rH2"/><w:footerReference w:type="default" r:id="rF1"/>{page}<w:titlePg/></w:sectPr>"#
    );
    let s2 = format!(
        r#"<w:sectPr><w:headerReference w:type="default" r:id="rH3"/><w:type w:val="nextPage"/>{page}<w:pgNumType w:start="1"/></w:sectPr>"#
    );
    let entry = |text: &str, bookmark: &str, page: &str| {
        format!(
            "{}<w:r><w:tab/></w:r>{}",
            t(text),
            field(&format!("PAGEREF {bookmark} \\h"), page)
        )
    };
    let mut body = String::new();
    body.push_str(&para(Some("TOCHeading"), &t("Contents")));
    // The TOC field opens in its first entry and closes in its last.
    body.push_str(&para(
        Some("TOC1"),
        &format!(
            r#"<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \o "1-2" \h \z \u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>{}"#,
            entry("Introduction", "_Toc1", "2")
        ),
    ));
    body.push_str(&para(Some("TOC2"), &entry("Background", "_Toc2", "2")));
    body.push_str(&para(
        Some("TOC1"),
        &format!(
            r#"{}<w:r><w:fldChar w:fldCharType="end"/></w:r>"#,
            entry("Results", "_Toc3", "1")
        ),
    ));
    body.push_str(r#"<w:p><w:r><w:br w:type="page"/></w:r></w:p>"#);
    body.push_str(&heading(1, "_Toc1", 1, "Introduction"));
    body.push_str(&para(
        None,
        &format!(
            "{}{}{}",
            t("Body text with a note"),
            note_ref(1, false),
            t(".")
        ),
    ));
    body.push_str(&heading(2, "_Toc2", 2, "Background"));
    body.push_str(&para(
        None,
        &format!(
            "{}{}{}{}{}",
            t("See "),
            field("REF _Toc2 \\h", "Background"),
            t(" on page "),
            field("PAGEREF _Toc2 \\h", "2"),
            t(".")
        ),
    ));
    body.push_str(&format!(
        r#"<w:p><w:pPr>{s1}</w:pPr>{}{}{}</w:p>"#,
        t("A closing remark"),
        note_ref(1, true),
        t(".")
    ));
    body.push_str(&heading(1, "_Toc3", 3, "Results"));
    body.push_str(&para(
        None,
        &format!("{}{}{}", t("Second section"), note_ref(2, false), t(".")),
    ));
    body.push_str(&para(
        None,
        &format!("{}{}", t("Figure "), field("SEQ Figure \\* ARABIC", "1")),
    ));
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {W}><w:body>{body}{s2}</w:body></w:document>"#
    );
    let styles = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {W}>{STYLES}</w:styles>"#
    );
    let footnotes = notes_part(false);
    let endnotes = notes_part(true);
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;
    let mut all: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/styles.xml", styles.as_bytes()),
        ("word/footnotes.xml", footnotes.as_bytes()),
        ("word/endnotes.xml", endnotes.as_bytes()),
    ];
    for (name, xml) in &files {
        all.push((name.as_str(), xml.as_bytes()));
    }
    zip_parts(&all)
}
