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

//! Conditional formatting read into the full model (`sheet_core::condfmt`,
//! W2.4, sheet ADR 523): every rule type of ECMA-376 §18.3.1.10 and the
//! `x14` extension (data bars with negative bars, axis, direction, border
//! and solid fill; icon sets beyond 2006 — `3Stars`, `3Triangles`,
//! `5Boxes`, `NoIcons` — and custom icons; extension-only rules). A 2006
//! rule that names an `x14:id` is merged with its extension.
//!
//! The worksheet keeps the `<conditionalFormatting>` blocks and its
//! `<extLst>` as captured bytes (preservation); this module only reads them.

use crate::xtree::XNode;
use sheet_core::condfmt::{
    AxisPosition, BarDirection, CfBlock, CfKind, CfOp, CfRange, CfRule, CfTextOp, CfTimePeriod,
    Cfvo, CfvoKind, DataBarRule, IconSetRule, SheetCf,
};
use sheet_core::visual::{ColorRef, DifferentialFormat};

/// A `CT_Color`-shaped node → a [`ColorRef`].
pub(crate) fn xcolor(n: &XNode) -> ColorRef {
    if n.flag("auto", false) {
        return ColorRef::auto();
    }
    let tint = n
        .attr("tint")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    if let Some(rgb) = n
        .attr("rgb")
        .and_then(|v| crate::parts::style_model::rgb_bytes(&v))
    {
        let rgb = sheet_format::resolve::tint_rgb(rgb, tint);
        return ColorRef::rgb(rgb.0, rgb.1, rgb.2);
    }
    if let Some(i) = n.attr("indexed").and_then(|v| v.trim().parse().ok()) {
        return ColorRef::indexed(i);
    }
    if let Some(t) = n.attr("theme").and_then(|v| v.trim().parse().ok()) {
        return ColorRef::theme(t, tint);
    }
    ColorRef::auto()
}

/// `A1:B9 D4` → ranges.
pub fn parse_sqref(sqref: &str) -> Vec<CfRange> {
    sqref
        .split_whitespace()
        .filter_map(|tok| {
            let tok = tok.replace('$', "");
            match tok.split_once(':') {
                Some((a, b)) => {
                    let (r0, c0, _, _) = sheet_core::parse_a1(a)?;
                    let (r1, c1, _, _) = sheet_core::parse_a1(b)?;
                    Some((r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1)))
                }
                None => {
                    let (r, c, _, _) = sheet_core::parse_a1(&tok)?;
                    Some((r, c, r, c))
                }
            }
        })
        .collect()
}

/// A `cfvo` node (2006: `val=`; x14: an `xm:f` child).
fn cfvo_of(n: &XNode) -> Cfvo {
    let kind = n
        .attr("type")
        .and_then(|t| CfvoKind::parse(&t))
        .unwrap_or(CfvoKind::Num);
    let val = n
        .attr("val")
        .or_else(|| n.child("f").and_then(|f| f.text.clone()))
        .map(|v| v.trim().to_string());
    Cfvo {
        kind,
        val,
        gte: n.flag("gte", true),
    }
}

/// The formulas (`<formula>` / `<xm:f>`) of a rule node.
fn formulas_of(n: &XNode) -> Vec<String> {
    n.children
        .iter()
        .filter(|c| c.local() == "formula" || c.local() == "f")
        .map(|c| c.text.clone().unwrap_or_default().trim().to_string())
        .collect()
}

/// The text a text rule tests, from its `text=` (or its formula when the
/// attribute is missing: `NOT(ISERROR(SEARCH("x",A1)))`).
fn text_of(n: &XNode) -> String {
    n.attr("text").unwrap_or_else(|| {
        formulas_of(n)
            .first()
            .and_then(|f| {
                let start = f.find('"')? + 1;
                let end = start + f[start..].find('"')?;
                Some(f[start..end].replace("\"\"", "\""))
            })
            .unwrap_or_default()
    })
}

/// One `cfRule` node → a rule (`dxfs` resolves its `dxfId`).
pub fn rule_of(n: &XNode, dxfs: &[DifferentialFormat]) -> CfRule {
    let ty = n.attr("type").unwrap_or_default();
    let formulas = formulas_of(n);
    let kind = match ty.as_str() {
        "cellIs" => match n.attr("operator").and_then(|o| CfOp::parse(&o)) {
            Some(op) => CfKind::CellIs { op, formulas },
            None => CfKind::Unknown { name: ty.clone() },
        },
        "expression" => CfKind::Expression {
            formula: formulas.first().cloned().unwrap_or_default(),
        },
        "top10" => CfKind::Top10 {
            rank: n.attr("rank").and_then(|v| v.parse().ok()).unwrap_or(10),
            percent: n.flag("percent", false),
            bottom: n.flag("bottom", false),
        },
        "aboveAverage" => CfKind::AboveAverage {
            above: n.flag("aboveAverage", true),
            equal: n.flag("equalAverage", false),
            std_dev: n.attr("stdDev").and_then(|v| v.parse().ok()).unwrap_or(0),
        },
        "duplicateValues" => CfKind::Duplicates { unique: false },
        "uniqueValues" => CfKind::Duplicates { unique: true },
        "containsText" => CfKind::Text {
            op: CfTextOp::Contains,
            text: text_of(n),
        },
        "notContainsText" => CfKind::Text {
            op: CfTextOp::NotContains,
            text: text_of(n),
        },
        "beginsWith" => CfKind::Text {
            op: CfTextOp::BeginsWith,
            text: text_of(n),
        },
        "endsWith" => CfKind::Text {
            op: CfTextOp::EndsWith,
            text: text_of(n),
        },
        "timePeriod" => match n.attr("timePeriod").and_then(|p| CfTimePeriod::parse(&p)) {
            Some(period) => CfKind::TimePeriod { period },
            None => CfKind::Unknown { name: ty.clone() },
        },
        "containsBlanks" => CfKind::Blanks { blank: true },
        "notContainsBlanks" => CfKind::Blanks { blank: false },
        "containsErrors" => CfKind::Errors { error: true },
        "notContainsErrors" => CfKind::Errors { error: false },
        "colorScale" => match n.child("colorScale") {
            Some(cs) => CfKind::ColorScale {
                cfvos: cs.children_named("cfvo").map(cfvo_of).collect(),
                colors: cs.children_named("color").map(xcolor).collect(),
            },
            None => CfKind::Unknown { name: ty.clone() },
        },
        "dataBar" => match n.child("dataBar") {
            Some(db) => CfKind::DataBar(data_bar_of(db)),
            None => CfKind::Unknown { name: ty.clone() },
        },
        "iconSet" => match n.child("iconSet") {
            Some(is) => CfKind::IconSet(icon_set_of(is)),
            None => CfKind::Unknown { name: ty.clone() },
        },
        _ => CfKind::Unknown { name: ty.clone() },
    };
    let dxf_id = n.attr("dxfId").and_then(|v| v.trim().parse::<u32>().ok());
    // An x14 rule carries its differential format inline (`x14:dxf`).
    let inline_dxf = n
        .child("dxf")
        .and_then(|d| XNode::parse(d.to_xml().as_bytes()).ok())
        .map(|d| dxf_of_xnode(&d));
    CfRule {
        kind,
        priority: n
            .attr("priority")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(i64::MAX),
        stop_if_true: n.flag("stopIfTrue", false),
        dxf: inline_dxf.or_else(|| dxf_id.and_then(|i| dxfs.get(i as usize).cloned())),
        dxf_id,
        ext_id: n
            .attr("id")
            .or_else(|| {
                n.child("extLst")
                    .and_then(|l| l.children_named("ext").find_map(|e| e.child("id")))
                    .and_then(|i| i.text.clone())
            })
            .map(|s| s.trim().to_string()),
    }
}

/// A `<dxf>` node read through the style reader (an x14 inline format).
fn dxf_of_xnode(n: &XNode) -> DifferentialFormat {
    crate::style_edit::parse_elem(n.to_xml().as_bytes())
        .map(|e| crate::parts::style_model::dxf_of(&e))
        .unwrap_or_default()
}

fn data_bar_of(db: &XNode) -> DataBarRule {
    let cfvos: Vec<Cfvo> = db.children_named("cfvo").map(cfvo_of).collect();
    let color = db
        .child("color")
        .or_else(|| db.child("fillColor"))
        .map(xcolor)
        .unwrap_or_else(|| ColorRef::rgb(0x63, 0x8E, 0xC6));
    let mut bar = DataBarRule::new(
        cfvos
            .first()
            .cloned()
            .unwrap_or(Cfvo::new(CfvoKind::Min, None)),
        cfvos
            .get(1)
            .cloned()
            .unwrap_or(Cfvo::new(CfvoKind::Max, None)),
        color,
    );
    bar.show_value = db.flag("showValue", true);
    if let Some(v) = db.attr("minLength").and_then(|v| v.parse().ok()) {
        bar.min_length = v;
    }
    if let Some(v) = db.attr("maxLength").and_then(|v| v.parse().ok()) {
        bar.max_length = v;
    }
    apply_x14_bar(&mut bar, db);
    bar
}

/// The x14 facets of a data bar node (also what merges into a 2006 bar).
fn apply_x14_bar(bar: &mut DataBarRule, db: &XNode) {
    if db.prefix().is_empty() || db.name.starts_with("dataBar") {
        // A 2006 node carries none of these.
        if db.attr("gradient").is_none() && db.attr("axisPosition").is_none() {
            return;
        }
    }
    bar.gradient = db.flag("gradient", true);
    bar.border = db.flag("border", false);
    bar.negative_same_as_positive = db.flag("negativeBarColorSameAsPositive", false);
    bar.axis_position = match db.attr("axisPosition").as_deref() {
        Some("middle") => AxisPosition::Middle,
        Some("none") => AxisPosition::None,
        _ => AxisPosition::Automatic,
    };
    bar.direction = match db.attr("direction").as_deref() {
        Some("leftToRight") => BarDirection::LeftToRight,
        Some("rightToLeft") => BarDirection::RightToLeft,
        _ => BarDirection::Context,
    };
    if let Some(v) = db.attr("minLength").and_then(|v| v.parse().ok()) {
        bar.min_length = v;
    }
    if let Some(v) = db.attr("maxLength").and_then(|v| v.parse().ok()) {
        bar.max_length = v;
    }
    bar.border_color = db.child("borderColor").map(xcolor);
    bar.negative_color = db.child("negativeFillColor").map(xcolor);
    bar.negative_border_color = db.child("negativeBorderColor").map(xcolor);
    bar.axis_color = db.child("axisColor").map(xcolor);
    if let Some(c) = db.child("fillColor") {
        bar.color = xcolor(c);
    }
    let cfvos: Vec<Cfvo> = db.children_named("cfvo").map(cfvo_of).collect();
    if let [min, max, ..] = cfvos.as_slice() {
        bar.min = min.clone();
        bar.max = max.clone();
    }
}

fn icon_set_of(is: &XNode) -> IconSetRule {
    IconSetRule {
        set: is
            .attr("iconSet")
            .unwrap_or_else(|| "3TrafficLights1".into()),
        cfvos: is.children_named("cfvo").map(cfvo_of).collect(),
        reverse: is.flag("reverse", false),
        show_value: is.flag("showValue", true),
        custom: is
            .children_named("cfIcon")
            .map(|c| {
                let set = c.attr("iconSet")?;
                let id = c.attr("iconId")?.parse().ok()?;
                (set != "NoIcons" || id == 0).then_some((set, id))
            })
            .collect(),
    }
}

/// One captured `<conditionalFormatting>` block (`None` for another node).
pub fn parse_block(xml: &[u8], dxfs: &[DifferentialFormat]) -> Option<CfBlock> {
    let n = XNode::parse(xml).ok()?;
    if n.local() != "conditionalFormatting" {
        return None;
    }
    Some(CfBlock {
        ranges: parse_sqref(&n.attr("sqref").unwrap_or_default()),
        rules: n
            .children_named("cfRule")
            .map(|r| rule_of(r, dxfs))
            .collect(),
        x14_only: false,
    })
}

/// The `x14:conditionalFormatting` blocks of a worksheet `<extLst>`.
pub fn parse_x14(xml: &[u8], dxfs: &[DifferentialFormat]) -> Vec<CfBlock> {
    let Ok(lst) = XNode::parse(xml) else {
        return Vec::new();
    };
    if lst.local() != "extLst" {
        return Vec::new();
    }
    let mut out = Vec::new();
    for ext in lst.children_named("ext") {
        for cfs in ext.children_named("conditionalFormattings") {
            for cf in cfs.children_named("conditionalFormatting") {
                let sqref = cf
                    .child("sqref")
                    .and_then(|s| s.text.clone())
                    .unwrap_or_default();
                out.push(CfBlock {
                    ranges: parse_sqref(&sqref),
                    rules: cf
                        .children_named("cfRule")
                        .map(|r| rule_of(r, dxfs))
                        .collect(),
                    x14_only: true,
                });
            }
        }
    }
    out
}

/// Read a worksheet's conditional formats from its captured children: the
/// 2006 blocks, their x14 extensions merged by rule id, and the
/// extension-only blocks.
pub fn parse_sheet<'a>(
    captured: impl Iterator<Item = &'a [u8]>,
    dxfs: &[DifferentialFormat],
) -> SheetCf {
    let mut blocks = Vec::new();
    let mut x14 = Vec::new();
    for bytes in captured {
        let head = &bytes[..bytes.len().min(64)];
        if head.windows(6).any(|w| w == b"extLst") {
            x14.extend(parse_x14(bytes, dxfs));
        } else if let Some(b) = parse_block(bytes, dxfs) {
            blocks.push(b);
        }
    }
    for xb in x14 {
        let mut rest = Vec::new();
        for xr in xb.rules {
            let target = xr.ext_id.as_ref().and_then(|id| {
                blocks
                    .iter_mut()
                    .flat_map(|b: &mut CfBlock| b.rules.iter_mut())
                    .find(|r| r.ext_id.as_deref() == Some(id.as_str()))
            });
            match target {
                Some(r) => merge_ext(r, xr),
                None => rest.push(xr),
            }
        }
        if !rest.is_empty() {
            blocks.push(CfBlock {
                ranges: xb.ranges,
                rules: rest,
                x14_only: true,
            });
        }
    }
    SheetCf { blocks }
}

/// Fold an x14 rule into its 2006 counterpart.
fn merge_ext(r: &mut CfRule, x: CfRule) {
    match (&mut r.kind, x.kind) {
        (CfKind::DataBar(bar), CfKind::DataBar(xbar)) => {
            // The 2006 bar's colour and thresholds stand unless the
            // extension restates them; its x14 facets come from the
            // extension.
            let color = bar.color.clone();
            let (min, max) = (bar.min.clone(), bar.max.clone());
            *bar = xbar;
            bar.color = color;
            if matches!(bar.min.kind, CfvoKind::Min | CfvoKind::AutoMin)
                && min.kind != CfvoKind::Min
            {
                bar.min = min;
            }
            if matches!(bar.max.kind, CfvoKind::Max | CfvoKind::AutoMax)
                && max.kind != CfvoKind::Max
            {
                bar.max = max;
            }
        }
        (k, xk) => {
            if matches!(k, CfKind::Unknown { .. }) {
                *k = xk;
            }
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    #[test]
    fn every_rule_type_reads__feat__sheet_xlsx_condfmt() {
        let xml = br#"<conditionalFormatting sqref="A1:A10 C1">
<cfRule type="cellIs" dxfId="0" priority="1" operator="between" stopIfTrue="1"><formula>$B$1</formula><formula>B1*2</formula></cfRule>
<cfRule type="expression" dxfId="0" priority="2"><formula>AND(A1&gt;0,ISEVEN(ROW()))</formula></cfRule>
<cfRule type="top10" dxfId="0" priority="3" percent="1" bottom="1" rank="15"/>
<cfRule type="aboveAverage" dxfId="0" priority="4" aboveAverage="0" equalAverage="1" stdDev="2"/>
<cfRule type="duplicateValues" dxfId="0" priority="5"/>
<cfRule type="uniqueValues" dxfId="0" priority="6"/>
<cfRule type="containsText" dxfId="0" priority="7" operator="containsText" text="ok"><formula>NOT(ISERROR(SEARCH("ok",A1)))</formula></cfRule>
<cfRule type="beginsWith" dxfId="0" priority="8" operator="beginsWith"><formula>LEFT(A1,2)="ab"</formula></cfRule>
<cfRule type="timePeriod" dxfId="0" priority="9" timePeriod="lastWeek"/>
<cfRule type="containsBlanks" dxfId="0" priority="10"/>
<cfRule type="notContainsErrors" dxfId="0" priority="11"/>
<cfRule type="iconSet" priority="12"><iconSet iconSet="5Arrows" reverse="1" showValue="0"><cfvo type="percent" val="0"/><cfvo type="percentile" val="20"/><cfvo type="num" val="5" gte="0"/><cfvo type="formula" val="$B$2"/><cfvo type="percent" val="80"/></iconSet></cfRule>
<cfRule type="dataBar" priority="13"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar><extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}"><x14:id>{1}</x14:id></ext></extLst></cfRule>
</conditionalFormatting>"#;
        let dxfs = vec![DifferentialFormat::default()];
        let b = parse_block(xml, &dxfs).unwrap();
        assert_eq!(b.ranges, vec![(0, 0, 9, 0), (0, 2, 0, 2)]);
        let k = |i: usize| &b.rules[i].kind;
        assert_eq!(
            *k(0),
            CfKind::CellIs {
                op: CfOp::Between,
                formulas: vec!["$B$1".into(), "B1*2".into()]
            }
        );
        assert!(b.rules[0].stop_if_true);
        assert!(b.rules[0].dxf.is_some());
        assert_eq!(
            *k(1),
            CfKind::Expression {
                formula: "AND(A1>0,ISEVEN(ROW()))".into()
            }
        );
        assert_eq!(
            *k(2),
            CfKind::Top10 {
                rank: 15,
                percent: true,
                bottom: true
            }
        );
        assert_eq!(
            *k(3),
            CfKind::AboveAverage {
                above: false,
                equal: true,
                std_dev: 2
            }
        );
        assert_eq!(*k(4), CfKind::Duplicates { unique: false });
        assert_eq!(*k(5), CfKind::Duplicates { unique: true });
        assert_eq!(
            *k(6),
            CfKind::Text {
                op: CfTextOp::Contains,
                text: "ok".into()
            }
        );
        assert_eq!(
            *k(7),
            CfKind::Text {
                op: CfTextOp::BeginsWith,
                text: "ab".into()
            }
        );
        assert_eq!(
            *k(8),
            CfKind::TimePeriod {
                period: CfTimePeriod::LastWeek
            }
        );
        assert_eq!(*k(9), CfKind::Blanks { blank: true });
        assert_eq!(*k(10), CfKind::Errors { error: false });
        match k(11) {
            CfKind::IconSet(is) => {
                assert_eq!(is.set, "5Arrows");
                assert!(is.reverse && !is.show_value);
                assert_eq!(is.cfvos.len(), 5);
                assert!(!is.cfvos[2].gte);
                assert_eq!(is.cfvos[3].val.as_deref(), Some("$B$2"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(b.rules[12].ext_id.as_deref(), Some("{1}"));
    }

    #[test]
    fn x14_extensions_merge_and_stand_alone__feat__sheet_xlsx_condfmt() {
        let cf = br#"<conditionalFormatting sqref="B1:B5"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar><extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:id>{AB}</x14:id></ext></extLst></cfRule></conditionalFormatting>"#;
        let ext = br#"<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:conditionalFormattings>
<x14:conditionalFormatting><x14:cfRule type="dataBar" id="{AB}"><x14:dataBar minLength="0" maxLength="100" gradient="0" border="1" axisPosition="middle" direction="rightToLeft"><x14:cfvo type="autoMin"/><x14:cfvo type="autoMax"/><x14:borderColor rgb="FF638EC6"/><x14:negativeFillColor rgb="FFFF0000"/><x14:axisColor rgb="FF000000"/></x14:dataBar></x14:cfRule><xm:sqref>B1:B5</xm:sqref></x14:conditionalFormatting>
<x14:conditionalFormatting><x14:cfRule type="iconSet" priority="2" id="{CD}"><x14:iconSet iconSet="3Stars" custom="1"><x14:cfvo type="percent"><xm:f>0</xm:f></x14:cfvo><x14:cfvo type="num"><xm:f>10</xm:f></x14:cfvo><x14:cfvo type="percent"><xm:f>67</xm:f></x14:cfvo><x14:cfIcon iconSet="3Signs" iconId="0"/><x14:cfIcon iconSet="NoIcons" iconId="0"/><x14:cfIcon iconSet="3Flags" iconId="2"/></x14:iconSet></x14:cfRule><xm:sqref>C1:C5</xm:sqref></x14:conditionalFormatting>
</x14:conditionalFormattings></ext></extLst>"#;
        let s = parse_sheet([cf.as_slice(), ext.as_slice()].into_iter(), &[]);
        assert_eq!(s.blocks.len(), 2);
        match &s.blocks[0].rules[0].kind {
            CfKind::DataBar(bar) => {
                assert!(!bar.gradient && bar.border);
                assert_eq!(bar.axis_position, AxisPosition::Middle);
                assert_eq!(bar.direction, BarDirection::RightToLeft);
                assert_eq!((bar.min_length, bar.max_length), (0, 100));
                assert_eq!(bar.negative_color, Some(ColorRef::rgb(255, 0, 0)));
                assert_eq!(bar.color, ColorRef::rgb(0x63, 0x8E, 0xC6));
            }
            other => panic!("{other:?}"),
        }
        assert!(s.blocks[1].x14_only);
        assert_eq!(s.blocks[1].ranges, vec![(0, 2, 4, 2)]);
        match &s.blocks[1].rules[0].kind {
            CfKind::IconSet(is) => {
                assert_eq!(is.set, "3Stars");
                assert_eq!(is.cfvos[1].val.as_deref(), Some("10"));
                assert_eq!(
                    is.custom,
                    vec![
                        Some(("3Signs".into(), 0)),
                        Some(("NoIcons".into(), 0)),
                        Some(("3Flags".into(), 2))
                    ]
                );
            }
            other => panic!("{other:?}"),
        }
    }
}
