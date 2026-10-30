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

//! Wave W4a's conformance documents (doc ADR 614): floating pictures in
//! every wrap and against the page or the paragraph, text boxes (DrawingML
//! with its VML fallback, legacy VML, in a header), a nested table, table
//! borders, shading, alignment, indent and row rules, and paragraphs in
//! three languages with hyphenation on. Word's answers come from
//! `scripts/word-objects-probe.sh` (`fixtures/*.word.json`).

use crate::{zip_parts, ROOT_RELS, TINY_PNG};

/// Every namespace the W4a documents use, on the root element.
const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" mc:Ignorable="wp14""#;

/// A Letter page with 1 in margins, a new page per section.
const SECT: &str = r#"<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>"#;

/// A filler sentence, long enough that a paragraph of it wraps several
/// lines (and around a float).
const FILLER: &str = "The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly and a wizard's job is to vex chumps quickly in fog.";

fn para(text: &str) -> String {
    format!(r#"<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#)
}

/// A paragraph ending its section (the next one starts a new page).
fn section_end(text: &str, extra: &str) -> String {
    format!(
        r#"<w:p><w:pPr><w:sectPr>{extra}{SECT}</w:sectPr></w:pPr><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#
    )
}

/// A floating picture of `cx` x `cy` EMU: `attrs` on `wp:anchor`, `pos`
/// its position children, `wrap` its wrap element, `id` its `wp:docPr`.
fn float_picture(id: u32, attrs: &str, pos: &str, wrap: &str, cx: i64, cy: i64) -> String {
    format!(
        r#"<w:drawing><wp:anchor {attrs}>{pos}<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>{wrap}<wp:docPr id="{id}" name="Picture {id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{id}" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>"#
    )
}

/// `wp:anchor`'s attributes, with the wrap distances and z-order.
fn anchor_attrs(dist: (i64, i64, i64, i64), z: u32, behind: bool) -> String {
    format!(
        r#"distT="{}" distB="{}" distL="{}" distR="{}" simplePos="0" relativeHeight="{z}" behindDoc="{}" locked="0" layoutInCell="1" allowOverlap="1""#,
        dist.0,
        dist.1,
        dist.2,
        dist.3,
        u8::from(behind)
    )
}

fn pos(h_rel: &str, h: &str, v_rel: &str, v: &str) -> String {
    format!(
        r#"<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="{h_rel}">{h}</wp:positionH><wp:positionV relativeFrom="{v_rel}">{v}</wp:positionV>"#
    )
}

fn offset(emu: i64) -> String {
    format!("<wp:posOffset>{emu}</wp:posOffset>")
}

fn align(a: &str) -> String {
    format!("<wp:align>{a}</wp:align>")
}

const SQUARE: &str = r#"<wp:wrapSquare wrapText="bothSides"/>"#;
const TOP_BOTTOM: &str = r#"<wp:wrapTopAndBottom/>"#;
const NONE: &str = r#"<wp:wrapNone/>"#;
const TIGHT: &str = r#"<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>"#;

/// The float cases of [`objects_floats_docx`], a page (section) each:
/// (label, the paragraph (0-based) the float is anchored in, the float's
/// `wp:anchor` attributes, position and wrap).
pub fn float_cases() -> Vec<(&'static str, usize, String, String, &'static str)> {
    let emu = |pt: i64| pt * 12700;
    vec![
        (
            "FA square, page-relative, first paragraph",
            0,
            anchor_attrs((0, 0, 114300, 114300), 251659264, false),
            pos("page", &offset(emu(288)), "page", &offset(emu(144))),
            SQUARE,
        ),
        (
            "FB tight, margin-relative, first paragraph",
            0,
            anchor_attrs((0, 0, 114300, 114300), 251660288, false),
            pos("margin", &align("right"), "margin", &offset(emu(36))),
            TIGHT,
        ),
        (
            "FC top and bottom, paragraph-relative, third paragraph",
            2,
            anchor_attrs((0, 0, 0, 0), 251661312, false),
            pos("margin", &align("center"), "paragraph", &offset(0)),
            TOP_BOTTOM,
        ),
        (
            "FD square, paragraph-relative, third paragraph",
            2,
            anchor_attrs((0, 0, 114300, 114300), 251662336, false),
            pos("column", &offset(0), "paragraph", &offset(0)),
            SQUARE,
        ),
        (
            "FE behind the text, page-relative, third paragraph",
            2,
            anchor_attrs((0, 0, 0, 0), 251663360, true),
            pos("page", &offset(emu(144)), "page", &offset(emu(360))),
            NONE,
        ),
        (
            "FF top and bottom, page-relative, third paragraph",
            2,
            anchor_attrs((0, 0, 0, 0), 251664384, false),
            pos("page", &offset(emu(216)), "page", &offset(emu(432))),
            TOP_BOTTOM,
        ),
    ]
}

/// The paragraphs on each float case's page.
pub const FLOAT_PAGE_PARAGRAPHS: usize = 6;

/// The picture's size on every float page: 1.5 in x 1 in.
pub const FLOAT_SIZE_PT: (f32, f32) = (108.0, 72.0);

/// The content types and relationships every W4a document shares.
fn package(
    document: &str,
    extra_parts: &[(&str, &str)],
    extra_rels: &str,
    extra_types: &str,
) -> Vec<u8> {
    let content_types = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>{extra_types}</Types>"#
    );
    let rels = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rSet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>{extra_rels}</Relationships>"#
    );
    let mut parts: Vec<(&str, &[u8])> = vec![
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/media/image1.png", TINY_PNG),
    ];
    let mut has_styles = false;
    let mut has_settings = false;
    for (name, xml) in extra_parts {
        has_styles |= *name == "word/styles.xml";
        has_settings |= *name == "word/settings.xml";
        parts.push((name, xml.as_bytes()));
    }
    let styles = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {NS}>{STYLE_DEFAULTS}</w:styles>"#
    );
    let settings = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings {NS}><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>"#
    );
    if !has_styles {
        parts.push(("word/styles.xml", styles.as_bytes()));
    }
    if !has_settings {
        parts.push(("word/settings.xml", settings.as_bytes()));
    }
    zip_parts(&parts)
}

/// Word's defaults spelled out (Times New Roman 12 pt, single spacing, no
/// space after), so the probe's lines do not depend on a template.
const STYLE_DEFAULTS: &str = r#"<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>"#;

/// Doc ADR 614 — floating pictures, one page (section) per
/// [`float_cases`] entry: [`FLOAT_PAGE_PARAGRAPHS`] filler paragraphs,
/// each labelled `<case> P<n>`, the float (1.5 x 1 in) the first run of
/// its anchor paragraph.
pub fn objects_floats_docx() -> Vec<u8> {
    let cases = float_cases();
    let mut body = String::new();
    let (cx, cy) = (1371600, 914400);
    for (k, (label, anchor, attrs, position, wrap)) in cases.iter().enumerate() {
        let tag = &label[..2];
        for p in 0..FLOAT_PAGE_PARAGRAPHS {
            let text = format!("{tag} P{p}. {FILLER} {FILLER}");
            let float = if p == *anchor {
                format!(
                    "<w:r>{}</w:r>",
                    float_picture(10 + k as u32, attrs, position, wrap, cx, cy)
                )
            } else {
                String::new()
            };
            if p + 1 == FLOAT_PAGE_PARAGRAPHS && k + 1 < cases.len() {
                body.push_str(&format!(
                    r#"<w:p><w:pPr><w:sectPr>{SECT}</w:sectPr></w:pPr>{float}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#
                ));
            } else {
                body.push_str(&format!(
                    r#"<w:p>{float}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#
                ));
            }
        }
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr>{SECT}</w:sectPr></w:body></w:document>"#
    );
    package(&document, &[], "", "")
}

/// A DrawingML text box (`wps:wsp` / `wps:txbx`) of `w` x `h` pt with its
/// VML fallback, as Word writes one: `pos` its position, `wrap` its wrap,
/// `lines` its paragraphs, a white fill and a black 0.75 pt outline.
fn text_box(id: u32, pos: &str, wrap: &str, w: i64, h: i64, lines: &[&str], css: &str) -> String {
    let (cx, cy) = (w * 12700, h * 12700);
    let content: String = lines.iter().map(|l| para(l)).collect();
    format!(
        r#"<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="45720" distB="45720" distL="114300" distR="114300" simplePos="0" relativeHeight="{z}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">{pos}<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>{wrap}<wp:docPr id="{id}" name="Text Box {id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr><wps:txbx><w:txbxContent>{content}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape id="Text Box {id}" o:spid="_x0000_s{spid}" style="position:absolute;{css};width:{w}pt;height:{h}pt;z-index:{z}" fillcolor="white" strokeweight=".75pt"><v:textbox><w:txbxContent>{content}</w:txbxContent></v:textbox><w10:wrap type="square"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent>"#,
        z = 251670000 + id,
        spid = 1024 + id,
    )
}

/// A legacy VML text box (no DrawingML choice), as Word 2003 wrote one.
fn vml_text_box(id: u32, css: &str, lines: &[&str]) -> String {
    let content: String = lines.iter().map(|l| para(l)).collect();
    format!(
        r##"<w:pict><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype><v:shape id="Legacy {id}" o:spid="_x0000_s{spid}" type="#_x0000_t202" style="position:absolute;{css}" fillcolor="white" strokeweight=".75pt"><v:textbox><w:txbxContent>{content}</w:txbxContent></v:textbox><w10:wrap type="square"/></v:shape></w:pict>"##,
        spid = 2048 + id,
    )
}

/// The text boxes' first lines, which Word's PDF shows where it puts them.
pub const TEXT_BOX_LINES: &[&str] = &[
    "TB1 page box line one",
    "TB2 unplaced box",
    "TBH header box",
    "TBV legacy box",
];

/// Doc ADR 614 — text boxes: page 1 has a page-relative DrawingML box
/// (with its VML fallback) in its first paragraph, square-wrapped, and a
/// paragraph-relative one in its fourth paragraph; its header holds a
/// page-relative box; page 2 has a legacy VML box in its first paragraph.
pub fn objects_text_boxes_docx() -> Vec<u8> {
    let emu = |pt: i64| offset(pt * 12700);
    let tb1 = text_box(
        20,
        &pos("page", &emu(324), "page", &emu(108)),
        SQUARE,
        180,
        72,
        &[TEXT_BOX_LINES[0], "TB1 line two"],
        "margin-left:324pt;margin-top:108pt;mso-position-horizontal-relative:page;mso-position-vertical-relative:page",
    );
    let tb2 = text_box(
        21,
        &pos("column", &emu(0), "paragraph", &emu(0)),
        SQUARE,
        144,
        54,
        &[TEXT_BOX_LINES[1]],
        "margin-left:0;margin-top:0;mso-position-horizontal-relative:text;mso-position-vertical-relative:text",
    );
    let tbh = text_box(
        22,
        &pos("page", &emu(396), "page", &emu(18)),
        NONE,
        144,
        36,
        &[TEXT_BOX_LINES[2]],
        "margin-left:396pt;margin-top:18pt;mso-position-horizontal-relative:page;mso-position-vertical-relative:page",
    );
    let tbv = vml_text_box(
        23,
        "margin-left:288pt;margin-top:216pt;width:180pt;height:54pt;z-index:251680000;mso-position-horizontal-relative:page;mso-position-vertical-relative:page",
        &[TEXT_BOX_LINES[3]],
    );
    let mut body = String::new();
    for p in 0..6 {
        let obj = match p {
            0 => format!("<w:r>{tb1}</w:r>"),
            3 => format!("<w:r>{tb2}</w:r>"),
            _ => String::new(),
        };
        body.push_str(&format!(
            r#"<w:p>{obj}<w:r><w:t xml:space="preserve">T1 P{p}. {FILLER} {FILLER}</w:t></w:r></w:p>"#
        ));
    }
    body.push_str(&section_end(
        "T1 end.",
        r#"<w:headerReference w:type="default" r:id="rHdr"/>"#,
    ));
    for p in 0..3 {
        let obj = if p == 0 {
            format!("<w:r>{tbv}</w:r>")
        } else {
            String::new()
        };
        body.push_str(&format!(
            r#"<w:p>{obj}<w:r><w:t xml:space="preserve">T2 P{p}. {FILLER} {FILLER}</w:t></w:r></w:p>"#
        ));
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr><w:headerReference w:type="default" r:id="rHdr"/>{SECT}</w:sectPr></w:body></w:document>"#
    );
    let header = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr {NS}><w:p><w:r>{tbh}</w:r><w:r><w:t xml:space="preserve">Header text</w:t></w:r></w:p></w:hdr>"#
    );
    package(
        &document,
        &[("word/header1.xml", &header)],
        r#"<Relationship Id="rHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>"#,
        r#"<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>"#,
    )
}

/// Doc ADR 614 — a table with a table nested in a cell: the outer 2 x 2
/// table's top-right cell holds `N1` before and `N2` after a nested 2 x 2
/// table of `N11` `N12` / `N21` `N22`.
pub fn objects_nested_tables_docx() -> Vec<u8> {
    let cell = |w: u32, content: &str| {
        format!(r#"<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/></w:tcPr>{content}</w:tc>"#)
    };
    let nested = format!(
        r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>{}{}</w:tr><w:tr>{}{}</w:tr></w:tbl>"#,
        cell(2000, &para("N11")),
        cell(2000, &para("N12")),
        cell(2000, &para("N21")),
        cell(2000, &para("N22"))
    );
    let outer = format!(
        r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid><w:tr>{}{}</w:tr><w:tr>{}{}</w:tr></w:tbl>"#,
        cell(4680, &para("O11")),
        cell(4680, &format!("{}{nested}{}", para("N1"), para("N2"))),
        cell(4680, &para("O21")),
        cell(4680, &para("O22"))
    );
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{}{outer}{}<w:sectPr>{SECT}</w:sectPr></w:body></w:document>"#,
        para("Before the table."),
        para("After the table.")
    );
    package(&document, &[], "", "")
}

/// The tables of [`objects_table_look_docx`], one each: (label, `w:tblPr`
/// children, the rows' `w:trPr`, the first cell's `w:tcPr` extras).
pub const TABLE_LOOK_CASES: &[(&str, &str, &str, &str)] = &[
    (
        "TA grid style",
        r#"<w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>"#,
        "",
        "",
    ),
    (
        "TB own borders and shading",
        r#"<w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="12" w:space="0" w:color="C00000"/><w:bottom w:val="single" w:sz="12" w:space="0" w:color="C00000"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="0070C0"/></w:tblBorders>"#,
        "",
        r#"<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/><w:tcBorders><w:left w:val="double" w:sz="6" w:space="0" w:color="00B050"/></w:tcBorders>"#,
    ),
    (
        "TC centred",
        r#"<w:tblStyle w:val="TableGrid"/><w:tblW w:w="4320" w:type="dxa"/><w:jc w:val="center"/>"#,
        "",
        "",
    ),
    (
        "TD indented",
        r#"<w:tblStyle w:val="TableGrid"/><w:tblW w:w="4320" w:type="dxa"/><w:tblInd w:w="1440" w:type="dxa"/>"#,
        "",
        "",
    ),
    (
        "TE exact rows",
        r#"<w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>"#,
        r#"<w:trPr><w:cantSplit/><w:trHeight w:val="720" w:hRule="exact"/></w:trPr>"#,
        "",
    ),
    (
        "TF at-least and auto rows",
        r#"<w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>"#,
        r#"<w:trPr><w:trHeight w:val="1440" w:hRule="auto"/></w:trPr>"#,
        "",
    ),
];

/// Doc ADR 614 — table borders, shading, alignment, indent and row rules:
/// one 2 x 2 table per [`TABLE_LOOK_CASES`] entry (each cell labelled
/// `<case> r<row>c<col>`), a paragraph between them.
pub fn objects_table_look_docx() -> Vec<u8> {
    let mut body = String::new();
    for (label, tbl_pr, tr_pr, tc_extra) in TABLE_LOOK_CASES {
        let tag = &label[..2];
        let mut rows = String::new();
        for r in 0..2 {
            let mut cells = String::new();
            for c in 0..2 {
                let extra = if r == 0 && c == 0 { *tc_extra } else { "" };
                cells.push_str(&format!(
                    r#"<w:tc><w:tcPr><w:tcW w:w="2160" w:type="dxa"/>{extra}</w:tcPr>{}</w:tc>"#,
                    para(&format!("{tag} r{r}c{c}"))
                ));
            }
            rows.push_str(&format!("<w:tr>{tr_pr}{cells}</w:tr>"));
        }
        body.push_str(&para(&format!("{label}:")));
        body.push_str(&format!(
            r#"<w:tbl><w:tblPr>{tbl_pr}</w:tblPr><w:tblGrid><w:gridCol w:w="2160"/><w:gridCol w:w="2160"/></w:tblGrid>{rows}</w:tbl>"#
        ));
    }
    body.push_str(&para("The end."));
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr>{SECT}</w:sectPr></w:body></w:document>"#
    );
    package(&document, &[], "", "")
}

/// The paragraphs of [`objects_languages_docx`]: (label, `w:lang`, text).
pub const LANGUAGE_CASES: &[(&str, &str, &str)] = &[
    (
        "LE",
        "en-US",
        "LE Internationalization considerations notwithstanding, the administration's representatives characterized the extraordinarily comprehensive documentation as indispensable.",
    ),
    (
        "LD",
        "de-DE",
        "LD Die Donaudampfschifffahrtsgesellschaft veröffentlichte Verkehrsinfrastrukturfinanzierungsgesellschaften und Rechtsschutzversicherungsgesellschaften gemeinsam.",
    ),
    (
        "LF",
        "fr-FR",
        "LF Anticonstitutionnellement, les établissements internationaux recommandent particulièrement l'interdisciplinarité et la responsabilisation environnementale.",
    ),
];

/// Doc ADR 614 — mixed-language hyphenation: automatic hyphenation on, a
/// 2 in wide column (a 4.5 in page, 1.25 in margins), justified paragraphs
/// in English, German and French (`w:lang` on their runs), and one German
/// run inside an English paragraph.
pub fn objects_languages_docx() -> Vec<u8> {
    let mut body = String::new();
    for (_, lang, text) in LANGUAGE_CASES {
        body.push_str(&format!(
            r#"<w:p><w:pPr><w:jc w:val="both"/><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:lang w:val="{lang}"/></w:rPr><w:t xml:space="preserve">{text}</w:t></w:r></w:p>"#
        ));
    }
    body.push_str(r#"<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t xml:space="preserve">LM English text with a </w:t></w:r><w:r><w:rPr><w:lang w:val="de-DE"/></w:rPr><w:t xml:space="preserve">Kraftfahrzeughaftpflichtversicherung </w:t></w:r><w:r><w:t xml:space="preserve">inside it.</w:t></w:r></w:p>"#);
    let sect = r#"<w:pgSz w:w="6480" w:h="15840"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/>"#;
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr>{sect}</w:sectPr></w:body></w:document>"#
    );
    let settings = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings {NS}><w:autoHyphenation/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>"#
    );
    package(&document, &[("word/settings.xml", &settings)], "", "")
}
