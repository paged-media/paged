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

//! Doc ADR 627 — shapes without text, as Word writes them (`wps:wsp` in a
//! `w:drawing`). `dump-fixture <out> shapes` writes the document.

use crate::reach::package;

/// One drawing of [`shapes_docx`]: the preset it names, and whether the
/// lowering draws it.
pub const SHAPE_CASES: &[(&str, bool)] = &[
    ("rect", true),
    ("ellipse", true),
    ("triangle", true),
    ("straightConnector1", true),
    ("roundRect", true),
    ("custGeom", true),
    ("cloudCallout", false),
];

const WPS: &str =
    r#"xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape""#;

fn drawing(id: u32, anchored: Option<(i64, i64)>, cx: i64, cy: i64, shape: &str) -> String {
    let frame = match anchored {
        Some((x, y)) => format!(
            r#"<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>{x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>{y}</wp:posOffset></wp:positionV><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="{id}" name="Shape {id}"/><wp:cNvGraphicFramePr/>"#
        ),
        None => format!(
            r#"<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{id}" name="Shape {id}"/><wp:cNvGraphicFramePr/>"#
        ),
    };
    let close = if anchored.is_some() {
        "</wp:anchor>"
    } else {
        "</wp:inline>"
    };
    format!(
        r#"<w:r><w:drawing>{frame}<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp {WPS}><wps:cNvSpPr/>{shape}<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>{close}</w:drawing></w:r>"#
    )
}

/// `wps:spPr` with a geometry and the paint.
fn sp_pr(xfrm: &str, geom: &str, paint: &str) -> String {
    format!(
        r#"<wps:spPr><a:xfrm{xfrm}><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm>{geom}{paint}</wps:spPr>"#
    )
}

fn prst(name: &str, av: &str) -> String {
    format!(r#"<a:prstGeom prst="{name}"><a:avLst>{av}</a:avLst></a:prstGeom>"#)
}

const RED_FILL: &str = r#"<a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>"#;

/// A document with each of [`SHAPE_CASES`], in order: an inline rectangle
/// with a fill and an outline, an anchored ellipse whose fill and outline
/// are the theme's (`wps:style`), an anchored triangle, a line, a rounded
/// rectangle turned a quarter, a freeform, and a preset the lowering does not
/// draw; each after a line of text.
pub fn shapes_docx() -> Vec<u8> {
    let style = r#"<wps:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></wps:style>"#;
    let cust = r#"<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="100"/></a:moveTo><a:lnTo><a:pt x="50" y="0"/></a:lnTo><a:cubicBezTo><a:pt x="75" y="25"/><a:pt x="100" y="50"/><a:pt x="100" y="100"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom>"#;
    let cases: Vec<(&str, String)> = vec![
        (
            "rect",
            drawing(
                1,
                None,
                1_828_800,
                914_400,
                &sp_pr("", &prst("rect", ""), RED_FILL),
            ),
        ),
        (
            "ellipse",
            drawing(
                2,
                Some((2_743_200, 0)),
                1_371_600,
                914_400,
                &format!("{}{style}", sp_pr("", &prst("ellipse", ""), "")),
            ),
        ),
        (
            "triangle",
            drawing(
                3,
                Some((0, 0)),
                914_400,
                914_400,
                &sp_pr(
                    "",
                    &prst("triangle", r#"<a:gd name="adj" fmla="val 30000"/>"#),
                    r#"<a:solidFill><a:srgbClr val="2E74B5"/></a:solidFill><a:ln><a:noFill/></a:ln>"#,
                ),
            ),
        ),
        (
            "line",
            drawing(
                4,
                None,
                1_828_800,
                457_200,
                &sp_pr(
                    "",
                    &prst("straightConnector1", ""),
                    r#"<a:ln w="38100"><a:solidFill><a:srgbClr val="2E74B5"/></a:solidFill></a:ln>"#,
                ),
            ),
        ),
        (
            "roundRect",
            drawing(
                5,
                Some((2_743_200, 0)),
                1_371_600,
                685_800,
                &sp_pr(
                    r#" rot="5400000""#,
                    &prst("roundRect", r#"<a:gd name="adj" fmla="val 30000"/>"#),
                    r#"<a:solidFill><a:srgbClr val="70AD47"/></a:solidFill>"#,
                ),
            ),
        ),
        (
            "custGeom",
            drawing(
                6,
                None,
                914_400,
                914_400,
                &sp_pr(
                    "",
                    cust,
                    r#"<a:solidFill><a:srgbClr val="FFC000"/></a:solidFill>"#,
                ),
            ),
        ),
        (
            "cloudCallout",
            drawing(
                7,
                None,
                914_400,
                685_800,
                &sp_pr("", &prst("cloudCallout", ""), RED_FILL),
            ),
        ),
    ];
    let mut body = String::new();
    for (name, d) in cases {
        body.push_str(&format!(
            r#"<w:p><w:r><w:t>Shape {name}</w:t></w:r>{d}</w:p><w:p><w:r><w:t>after {name}</w:t></w:r></w:p><w:p/><w:p/>"#
        ));
    }
    package(&body, false)
}
