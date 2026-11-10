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

//! Doc ADR 629 — SmartArt as Word writes it: a `w:drawing` whose graphic is
//! a `dgm:relIds` naming the diagram's data, layout, style and colour parts,
//! and the drawing Word saves of its last layout (`word/diagrams/drawing1.xml`,
//! named by the data part's `dsp:dataModelExt`). `dump-fixture <out> smartart`
//! writes the document.

use crate::{zip_parts, ROOT_RELS, THEME_CONTENT_TYPES, THEME_STYLES, THEME_XML};

const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram""#;

/// The text of the diagram's shapes, in z-order.
pub const SMARTART_TEXTS: [&str; 3] = ["Plan", "Do", "Check"];

/// The diagram's parts, which every save keeps.
pub const SMARTART_PARTS: [&str; 6] = [
    "word/diagrams/data1.xml",
    "word/diagrams/layout1.xml",
    "word/diagrams/quickStyle1.xml",
    "word/diagrams/colors1.xml",
    "word/diagrams/drawing1.xml",
    "word/diagrams/data2.xml",
];

fn graphic(id: u32, rels: [&str; 4], cx: i64, cy: i64) -> String {
    let [dm, lo, qs, cs] = rels;
    format!(
        r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{id}" name="Diagram {id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="{dm}" r:lo="{lo}" r:qs="{qs}" r:cs="{cs}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
    )
}

/// `dsp:style` as Word writes it for a diagram node: the theme's second line
/// style, the fill reference, white text.
const STYLE: &str = r#"<dsp:style><a:lnRef idx="2"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="1"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef><a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>"#;

fn sp(xfrm: &str, geom: &str, fill: &str, text: Option<(&str, &str)>) -> String {
    let body = match text {
        Some((t, tx)) => format!(
            r#"<dsp:txBody><a:bodyPr spcFirstLastPara="0" vert="horz" wrap="square" lIns="76200" tIns="76200" rIns="76200" bIns="76200" numCol="1" spcCol="1270" anchor="ctr" anchorCtr="0"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr marL="0" lvl="0" indent="0" algn="ctr" defTabSz="1066800"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc></a:pPr><a:r><a:rPr lang="en-US" sz="2400" kern="1200"/><a:t>{t}</a:t></a:r></a:p></dsp:txBody>{tx}"#
        ),
        None => "<dsp:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></dsp:txBody>".into(),
    };
    format!(
        r#"<dsp:sp modelId="{{00000000-0000-0000-0000-000000000000}}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr>{xfrm}<a:prstGeom prst="{geom}"><a:avLst/></a:prstGeom>{fill}<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:effectLst/></dsp:spPr>{STYLE}{body}</dsp:sp>"#
    )
}

fn off_ext(x: i64, y: i64, cx: i64, cy: i64) -> String {
    format!(r#"<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>"#)
}

fn solid(scheme: &str) -> String {
    format!(r#"<a:solidFill><a:schemeClr val="{scheme}"/></a:solidFill>"#)
}

/// The drawing: a rounded rectangle "Plan", an arrow, a chevron "Do" in a
/// group that halves its children (the chevron turned a quarter, its text
/// turned back upright), an ellipse "Check" turned a quarter with its text.
pub fn smartart_drawing_xml() -> String {
    let plan = sp(
        &off_ext(0, 0, 1_371_600, 914_400),
        "roundRect",
        &solid("accent1"),
        Some((
            SMARTART_TEXTS[0],
            r#"<dsp:txXfrm><a:off x="44637" y="44637"/><a:ext cx="1282326" cy="825126"/></dsp:txXfrm>"#,
        )),
    );
    let arrow = sp(
        &off_ext(1_508_760, 320_040, 289_560, 274_320),
        "rightArrow",
        &solid("accent1"),
        None,
    );
    // Turned a quarter, its text turned back upright by its text box, as
    // the vertical chevron list lays its chevrons out.
    let chevron = sp(
        r#"<a:xfrm rot="5400000"><a:off x="457200" y="-457200"/><a:ext cx="1828800" cy="2743200"/></a:xfrm>"#,
        "chevron",
        &solid("accent2"),
        Some((
            SMARTART_TEXTS[1],
            r#"<dsp:txXfrm rot="-5400000"><a:off x="914400" y="0"/><a:ext cx="914400" cy="1828800"/></dsp:txXfrm>"#,
        )),
    );
    // Turned a quarter with no text box: its text turns with it.
    let check = sp(
        r#"<a:xfrm rot="5400000"><a:off x="3444240" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>"#,
        "ellipse",
        &solid("accent3"),
        Some((SMARTART_TEXTS[2], "")),
    );
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dsp:drawing xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>{plan}{arrow}<dsp:grpSp><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr><a:xfrm><a:off x="1935480" y="0"/><a:ext cx="1371600" cy="914400"/><a:chOff x="0" y="0"/><a:chExt cx="2743200" cy="1828800"/></a:xfrm></dsp:grpSpPr>{chevron}</dsp:grpSp>{check}</dsp:spTree></dsp:drawing>"#
    )
}

/// A diagram data part; `drawing` names the drawing's relationship.
fn data_xml(drawing: Option<&str>) -> String {
    let ext = drawing
        .map(|rid| {
            format!(
                r#"<dgm:extLst><a:ext uri="http://schemas.microsoft.com/office/drawing/2008/diagram"><dsp:dataModelExt xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" relId="{rid}" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst>"#
            )
        })
        .unwrap_or_default();
    let pts: String = SMARTART_TEXTS
        .iter()
        .enumerate()
        .map(|(i, t)| {
            format!(
                r#"<dgm:pt modelId="{{1000000{i}-0000-0000-0000-000000000000}}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>{t}</a:t></a:r></a:p></dgm:t></dgm:pt>"#
            )
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst><dgm:pt modelId="{{00000001-0000-0000-0000-000000000000}}" type="doc"><dgm:prSet loTypeId="urn:microsoft.com/office/officeart/2005/8/layout/process1" qsTypeId="urn:microsoft.com/office/officeart/2005/8/quickstyle/simple1" csTypeId="urn:microsoft.com/office/officeart/2005/8/colors/accent1_2"/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt>{pts}</dgm:ptLst><dgm:cxnLst/><dgm:bg/><dgm:whole/>{ext}</dgm:dataModel>"#
    )
}

/// A document with a three-step process diagram (its drawing saved), and a
/// diagram whose drawing Word did not save (only its data), which is not
/// drawn.
pub fn smartart_docx() -> Vec<u8> {
    let diagram = graphic(1, ["rDm", "rLo", "rQs", "rCs"], 4_389_120, 914_400);
    let bare = graphic(2, ["rDm2", "rLo", "rQs", "rCs"], 4_389_120, 914_400);
    let body = format!(
        r#"<w:p><w:r><w:t>SmartArt process</w:t></w:r></w:p><w:p>{diagram}</w:p><w:p><w:r><w:t>Without its drawing</w:t></w:r></w:p><w:p>{bare}</w:p><w:p><w:r><w:t>the end</w:t></w:r></w:p>"#
    );
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    );
    let mut types =
        paged_ooxml::ContentTypes::parse(THEME_CONTENT_TYPES.as_bytes()).expect("types");
    for (part, ty) in [
        ("data1.xml", "diagramData"),
        ("data2.xml", "diagramData"),
        ("layout1.xml", "diagramLayout"),
        ("quickStyle1.xml", "diagramStyle"),
        ("colors1.xml", "diagramColors"),
    ] {
        types.add_override(
            &format!("/word/diagrams/{part}"),
            &format!("application/vnd.openxmlformats-officedocument.drawingml.{ty}+xml"),
        );
    }
    types.add_override(
        "/word/diagrams/drawing1.xml",
        "application/vnd.ms-office.drawingml.diagramDrawing+xml",
    );
    let content_types = types.render();
    let rel = |id: &str, ty: &str, target: &str| {
        format!(r#"<Relationship Id="{id}" Type="{ty}" Target="{target}"/>"#)
    };
    const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    let rels = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#,
        [
            rel("rId1", &format!("{R}/styles"), "styles.xml"),
            rel("rId2", &format!("{R}/settings"), "settings.xml"),
            rel("rId3", &format!("{R}/theme"), "theme/theme1.xml"),
            rel("rDm", &format!("{R}/diagramData"), "diagrams/data1.xml"),
            rel("rDm2", &format!("{R}/diagramData"), "diagrams/data2.xml"),
            rel("rLo", &format!("{R}/diagramLayout"), "diagrams/layout1.xml"),
            rel(
                "rQs",
                &format!("{R}/diagramQuickStyle"),
                "diagrams/quickStyle1.xml"
            ),
            rel("rCs", &format!("{R}/diagramColors"), "diagrams/colors1.xml"),
            rel(
                "rDr",
                "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
                "diagrams/drawing1.xml"
            ),
        ]
        .concat()
    );
    let settings = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:clrSchemeMapping w:bg1="light1" w:t1="dark1" w:bg2="light2" w:t2="dark2" w:accent1="accent1" w:accent2="accent2" w:accent3="accent3" w:accent4="accent4" w:accent5="accent5" w:accent6="accent6" w:hyperlink="hyperlink" w:followedHyperlink="followedHyperlink"/></w:settings>"#;
    let stub = |root: &str| {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:{root} xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" uniqueId="urn:microsoft.com/office/officeart/2005/8/{root}"/>"#
        )
    };
    let (data1, data2, drawing) = (
        data_xml(Some("rDr")),
        data_xml(None),
        smartart_drawing_xml(),
    );
    let (layout, style, colors) = (stub("layoutDef"), stub("styleDef"), stub("colorsDef"));
    zip_parts(&[
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/styles.xml", THEME_STYLES.as_bytes()),
        ("word/settings.xml", settings.as_bytes()),
        ("word/theme/theme1.xml", THEME_XML.as_bytes()),
        ("word/diagrams/data1.xml", data1.as_bytes()),
        ("word/diagrams/data2.xml", data2.as_bytes()),
        ("word/diagrams/layout1.xml", layout.as_bytes()),
        ("word/diagrams/quickStyle1.xml", style.as_bytes()),
        ("word/diagrams/colors1.xml", colors.as_bytes()),
        ("word/diagrams/drawing1.xml", drawing.as_bytes()),
    ])
}
