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

//! Conditional-format AUTHORING (W2.5, sheet ADR 523): write a sheet's
//! [`SheetCf`] back into its worksheet.
//!
//! The worksheet keeps its `<conditionalFormatting>` blocks and its
//! `<extLst>` as captured bytes; a write replaces only what changed: a
//! block whose model equals one read from the file keeps that block's
//! bytes; a changed or new block is rendered. Rules that need the 2010
//! extension (every data bar — negative bars, axis, direction; icon sets
//! beyond 2006 and custom icons; extension-only blocks) get their
//! `x14:cfRule` in the worksheet's `x14:conditionalFormattings`, linked by
//! `x14:id`; that extension is rewritten only when its content changes, and
//! every other extension of the `extLst` stays as it was. A differential
//! format no `<dxf>` holds yet is appended to `styles.xml`'s `<dxfs>`
//! (existing indices keep their meaning).

use crate::error::XlsxError;
use crate::parts::cf_model;
use crate::splice::escape_attr;
use crate::write::captured_local;
use crate::XlsxDocument;
use sheet_core::condfmt::{
    AxisPosition, BarDirection, CfBlock, CfKind, CfRange, CfRule, CfTextOp, CfTimePeriod, Cfvo,
    CfvoKind, DataBarRule, IconSetRule, SheetCf,
};
use sheet_core::visual::{
    BorderStyle, CellFill, ColorRef, ConcreteColor, DifferentialFormat, PatternKind, UnderlineKind,
    VertAlign,
};
use sheet_core::SheetId;

/// The x14 rule-id extension of a 2006 rule.
const EXT_RULE_ID: &str = "{B025F937-C7B1-47D3-B67F-A62EFF666E3E}";
/// The worksheet extension holding `x14:conditionalFormattings`.
const EXT_X14_CF: &str = "{78C0D931-6437-407d-A8EE-F0AAD7539E65}";
const NS_X14: &str = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main";
const NS_XM: &str = "http://schemas.microsoft.com/office/excel/2006/main";

/// The icon sets the 2006 schema knows (the rest are x14 only).
const ICONS_2006: &[&str] = &[
    "3Arrows",
    "3ArrowsGray",
    "3Flags",
    "3TrafficLights1",
    "3TrafficLights2",
    "3Signs",
    "3Symbols",
    "3Symbols2",
    "4Arrows",
    "4ArrowsGray",
    "4RedToBlack",
    "4Rating",
    "4TrafficLights",
    "5Arrows",
    "5ArrowsGray",
    "5Rating",
    "5Quarters",
];

fn esc(s: &str) -> String {
    escape_attr(s)
}

fn esc_text(s: &str) -> String {
    paged_ooxml::xml::escape_text(s)
}

/// `(r0, c0, r1, c1)` → `A1:B9`.
pub fn range_a1(r: &CfRange) -> String {
    let a = sheet_core::format_a1(r.0, r.1, false, false);
    if (r.0, r.1) == (r.2, r.3) {
        a.to_string()
    } else {
        format!("{a}:{}", sheet_core::format_a1(r.2, r.3, false, false))
    }
}

fn sqref(ranges: &[CfRange]) -> String {
    ranges.iter().map(range_a1).collect::<Vec<_>>().join(" ")
}

/// A colour's attributes (`rgb=` / `theme=` + `tint=` / `indexed=` /
/// `auto=`); a document swatch writes its sRGB.
fn color_attrs(c: &ColorRef) -> String {
    if let Some(d) = &c.doc {
        let (r, g, b) = d.fallback_rgb;
        return format!(r#"rgb="FF{r:02X}{g:02X}{b:02X}""#);
    }
    match &c.concrete {
        ConcreteColor::Rgb { r, g, b } => format!(r#"rgb="FF{r:02X}{g:02X}{b:02X}""#),
        ConcreteColor::Theme { index, tint } if *tint != 0.0 => {
            format!(r#"theme="{index}" tint="{tint}""#)
        }
        ConcreteColor::Theme { index, .. } => format!(r#"theme="{index}""#),
        ConcreteColor::Indexed { index } => format!(r#"indexed="{index}""#),
        ConcreteColor::Auto => r#"auto="1""#.to_string(),
    }
}

fn color_el(prefix: &str, name: &str, c: &ColorRef) -> String {
    format!("<{prefix}{name} {}/>", color_attrs(c))
}

/// A `<dxf>` for a differential format.
pub fn render_dxf(d: &DifferentialFormat, p: &str) -> String {
    let mut out = format!("<{p}dxf>");
    if let Some(f) = &d.font {
        out.push_str(&format!("<{p}font>"));
        let flag = |out: &mut String, name: &str, v: Option<bool>| match v {
            Some(true) => out.push_str(&format!("<{p}{name}/>")),
            Some(false) => out.push_str(&format!(r#"<{p}{name} val="0"/>"#)),
            None => {}
        };
        flag(&mut out, "b", f.bold);
        flag(&mut out, "i", f.italic);
        flag(&mut out, "strike", f.strike);
        if let Some(u) = f.underline {
            match u {
                UnderlineKind::None => out.push_str(&format!(r#"<{p}u val="none"/>"#)),
                UnderlineKind::Single => out.push_str(&format!("<{p}u/>")),
                k => out.push_str(&format!(
                    r#"<{p}u val="{}"/>"#,
                    k.as_xlsx().unwrap_or("single")
                )),
            }
        }
        if let Some(v) = f.vert_align {
            if v != VertAlign::Baseline {
                out.push_str(&format!(r#"<{p}vertAlign val="{}"/>"#, v.as_xlsx()));
            }
        }
        if let Some(sz) = f.size {
            out.push_str(&format!(r#"<{p}sz val="{sz}"/>"#));
        }
        if let Some(c) = &f.color {
            out.push_str(&color_el(p, "color", c));
        }
        if let Some(n) = &f.name {
            out.push_str(&format!(r#"<{p}name val="{}"/>"#, esc(n)));
        }
        out.push_str(&format!("</{p}font>"));
    }
    if let Some(nf) = &d.num_fmt {
        // A differential number format takes an id the style sheet's
        // `numFmts` does not use; Excel reads the code from the dxf.
        out.push_str(&format!(
            r#"<{p}numFmt numFmtId="{}" formatCode="{}"/>"#,
            dxf_num_fmt_id(nf),
            esc(nf)
        ));
    }
    if let Some(fill) = &d.fill {
        match fill {
            CellFill::Pattern {
                pattern: PatternKind::Solid,
                fg,
                ..
            } => {
                out.push_str(&format!("<{p}fill><{p}patternFill>"));
                if let Some(c) = fg {
                    out.push_str(&color_el(p, "bgColor", c));
                }
                out.push_str(&format!("</{p}patternFill></{p}fill>"));
            }
            CellFill::Pattern { pattern, fg, bg } => {
                out.push_str(&format!(
                    r#"<{p}fill><{p}patternFill patternType="{}">"#,
                    pattern.as_xlsx()
                ));
                if let Some(c) = fg {
                    out.push_str(&color_el(p, "fgColor", c));
                }
                if let Some(c) = bg {
                    out.push_str(&color_el(p, "bgColor", c));
                }
                out.push_str(&format!("</{p}patternFill></{p}fill>"));
            }
            CellFill::Gradient { .. } | CellFill::None => {}
        }
    }
    if let Some(b) = &d.border {
        out.push_str(&format!("<{p}border>"));
        for (name, e) in [
            ("left", &b.left),
            ("right", &b.right),
            ("top", &b.top),
            ("bottom", &b.bottom),
        ] {
            if e.style == BorderStyle::None {
                continue;
            }
            out.push_str(&format!(r#"<{p}{name} style="{}">"#, e.style.as_xlsx()));
            if let Some(c) = &e.color {
                out.push_str(&color_el(p, "color", c));
            }
            out.push_str(&format!("</{p}{name}>"));
        }
        out.push_str(&format!("</{p}border>"));
    }
    out.push_str(&format!("</{p}dxf>"));
    out
}

/// A stable id (≥ 164 + 2000) for a differential number format code.
fn dxf_num_fmt_id(code: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in code.bytes() {
        h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
    }
    2164 + h % 20_000
}

/// A deterministic `{GUID}` for a rule's x14 link.
fn rule_guid(sheet: SheetId, b: usize, r: usize, rule: &CfRule) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let seed = format!("{sheet}/{b}/{r}/{}/{:?}", rule.priority, rule.kind);
    for byte in seed.bytes() {
        h = (h ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3);
    }
    let h2 = h.rotate_left(29) ^ 0x9e37_79b9_7f4a_7c15;
    format!(
        "{{{:08X}-{:04X}-4{:03X}-8{:03X}-{:012X}}}",
        (h >> 32) as u32,
        (h >> 16) as u16,
        (h & 0xfff) as u16,
        (h2 >> 52) as u16 & 0xfff,
        h2 & 0xffff_ffff_ffff
    )
}

/// The text rules' formulas, written from the block's anchor `a1`.
fn text_formula(op: CfTextOp, text: &str, a1: &str) -> String {
    let t = text.replace('"', "\"\"");
    match op {
        CfTextOp::Contains => format!(r#"NOT(ISERROR(SEARCH("{t}",{a1})))"#),
        CfTextOp::NotContains => format!(r#"ISERROR(SEARCH("{t}",{a1}))"#),
        CfTextOp::BeginsWith => format!(r#"LEFT({a1},LEN("{t}"))="{t}""#),
        CfTextOp::EndsWith => format!(r#"RIGHT({a1},LEN("{t}"))="{t}""#),
    }
}

/// Excel's own formula for a time period, from the anchor `a1`.
fn period_formula(p: CfTimePeriod, a1: &str) -> String {
    match p {
        CfTimePeriod::Today => format!("FLOOR({a1},1)=TODAY()"),
        CfTimePeriod::Yesterday => format!("FLOOR({a1},1)=TODAY()-1"),
        CfTimePeriod::Tomorrow => format!("FLOOR({a1},1)=TODAY()+1"),
        CfTimePeriod::Last7Days => {
            format!("AND(TODAY()-FLOOR({a1},1)<=6,FLOOR({a1},1)<=TODAY())")
        }
        CfTimePeriod::ThisWeek => format!(
            "AND(TODAY()-ROUNDDOWN({a1},0)<=WEEKDAY(TODAY())-1,ROUNDDOWN({a1},0)-TODAY()<=7-WEEKDAY(TODAY()))"
        ),
        CfTimePeriod::LastWeek => format!(
            "AND(TODAY()-ROUNDDOWN({a1},0)>=(WEEKDAY(TODAY())),TODAY()-ROUNDDOWN({a1},0)<(WEEKDAY(TODAY())+7))"
        ),
        CfTimePeriod::NextWeek => format!(
            "AND(ROUNDDOWN({a1},0)-TODAY()>(7-WEEKDAY(TODAY())),ROUNDDOWN({a1},0)-TODAY()<(15-WEEKDAY(TODAY())))"
        ),
        CfTimePeriod::ThisMonth => {
            format!("AND(MONTH({a1})=MONTH(TODAY()),YEAR({a1})=YEAR(TODAY()))")
        }
        CfTimePeriod::LastMonth => format!(
            "AND(MONTH({a1})=MONTH(EDATE(TODAY(),0-1)),YEAR({a1})=YEAR(EDATE(TODAY(),0-1)))"
        ),
        CfTimePeriod::NextMonth => format!(
            "AND(MONTH({a1})=MONTH(EDATE(TODAY(),0+1)),YEAR({a1})=YEAR(EDATE(TODAY(),0+1)))"
        ),
    }
}

/// A 2006 `cfvo` (autoMin/autoMax write as min/max there).
fn cfvo_2006(p: &str, c: &Cfvo) -> String {
    let kind = match c.kind {
        CfvoKind::AutoMin => CfvoKind::Min,
        CfvoKind::AutoMax => CfvoKind::Max,
        k => k,
    };
    let mut s = format!(r#"<{p}cfvo type="{}""#, kind.as_xlsx());
    if let Some(v) = &c.val {
        if !matches!(kind, CfvoKind::Min | CfvoKind::Max) {
            s.push_str(&format!(r#" val="{}""#, esc(v)));
        }
    }
    if !c.gte {
        s.push_str(r#" gte="0""#);
    }
    s.push_str("/>");
    s
}

/// An x14 `cfvo` (its value in an `xm:f` child).
fn cfvo_x14(c: &Cfvo) -> String {
    let mut s = format!(r#"<x14:cfvo type="{}""#, c.kind.as_xlsx());
    if !c.gte {
        s.push_str(r#" gte="0""#);
    }
    match &c.val {
        Some(v)
            if !matches!(
                c.kind,
                CfvoKind::Min | CfvoKind::Max | CfvoKind::AutoMin | CfvoKind::AutoMax
            ) =>
        {
            s.push_str(&format!("><xm:f>{}</xm:f></x14:cfvo>", esc_text(v)));
        }
        _ => s.push_str("/>"),
    }
    s
}

/// Does an icon set need the extension?
fn icons_need_x14(is: &IconSetRule) -> bool {
    !ICONS_2006.contains(&is.set.as_str()) || is.custom.iter().any(Option::is_some)
}

/// One rule's 2006 XML (`None`: the rule lives in the extension only).
fn rule_2006(
    p: &str,
    rule: &CfRule,
    dxf_id: Option<u32>,
    anchor: &str,
    guid: &str,
) -> Option<String> {
    let mut a = String::new();
    let mut body = String::new();
    let ty: String;
    match &rule.kind {
        CfKind::CellIs { op, formulas } => {
            ty = "cellIs".into();
            a.push_str(&format!(r#" operator="{}""#, op.as_xlsx()));
            for f in formulas {
                body.push_str(&format!("<{p}formula>{}</{p}formula>", esc_text(f)));
            }
        }
        CfKind::Expression { formula } => {
            ty = "expression".into();
            body.push_str(&format!("<{p}formula>{}</{p}formula>", esc_text(formula)));
        }
        CfKind::Top10 {
            rank,
            percent,
            bottom,
        } => {
            ty = "top10".into();
            if *percent {
                a.push_str(r#" percent="1""#);
            }
            if *bottom {
                a.push_str(r#" bottom="1""#);
            }
            a.push_str(&format!(r#" rank="{rank}""#));
        }
        CfKind::AboveAverage {
            above,
            equal,
            std_dev,
        } => {
            ty = "aboveAverage".into();
            if !above {
                a.push_str(r#" aboveAverage="0""#);
            }
            if *equal {
                a.push_str(r#" equalAverage="1""#);
            }
            if *std_dev > 0 {
                a.push_str(&format!(r#" stdDev="{std_dev}""#));
            }
        }
        CfKind::Duplicates { unique } => {
            ty = if *unique {
                "uniqueValues"
            } else {
                "duplicateValues"
            }
            .into();
        }
        CfKind::Text { op, text } => {
            ty = op.rule_type().into();
            a.push_str(&format!(
                r#" operator="{}" text="{}""#,
                op.operator(),
                esc(text)
            ));
            body.push_str(&format!(
                "<{p}formula>{}</{p}formula>",
                esc_text(&text_formula(*op, text, anchor))
            ));
        }
        CfKind::TimePeriod { period } => {
            ty = "timePeriod".into();
            a.push_str(&format!(r#" timePeriod="{}""#, period.as_xlsx()));
            body.push_str(&format!(
                "<{p}formula>{}</{p}formula>",
                esc_text(&period_formula(*period, anchor))
            ));
        }
        CfKind::Blanks { blank } => {
            ty = if *blank {
                "containsBlanks"
            } else {
                "notContainsBlanks"
            }
            .into();
            let f = if *blank {
                format!("LEN(TRIM({anchor}))=0")
            } else {
                format!("LEN(TRIM({anchor}))>0")
            };
            body.push_str(&format!("<{p}formula>{}</{p}formula>", esc_text(&f)));
        }
        CfKind::Errors { error } => {
            ty = if *error {
                "containsErrors"
            } else {
                "notContainsErrors"
            }
            .into();
            let f = if *error {
                format!("ISERROR({anchor})")
            } else {
                format!("NOT(ISERROR({anchor}))")
            };
            body.push_str(&format!("<{p}formula>{}</{p}formula>", esc_text(&f)));
        }
        CfKind::ColorScale { cfvos, colors } => {
            ty = "colorScale".into();
            body.push_str(&format!("<{p}colorScale>"));
            for c in cfvos {
                body.push_str(&cfvo_2006(p, c));
            }
            for c in colors {
                body.push_str(&color_el(p, "color", c));
            }
            body.push_str(&format!("</{p}colorScale>"));
        }
        CfKind::DataBar(bar) => {
            ty = "dataBar".into();
            let mut da = String::new();
            if !bar.show_value {
                da.push_str(r#" showValue="0""#);
            }
            body.push_str(&format!("<{p}dataBar{da}>"));
            body.push_str(&cfvo_2006(p, &bar.min));
            body.push_str(&cfvo_2006(p, &bar.max));
            body.push_str(&color_el(p, "color", &bar.color));
            body.push_str(&format!("</{p}dataBar>"));
            body.push_str(&format!(
                r#"<{p}extLst><{p}ext uri="{EXT_RULE_ID}" xmlns:x14="{NS_X14}"><x14:id>{guid}</x14:id></{p}ext></{p}extLst>"#
            ));
        }
        CfKind::IconSet(is) => {
            if icons_need_x14(is) {
                return None;
            }
            ty = "iconSet".into();
            let mut ia = format!(r#" iconSet="{}""#, esc(&is.set));
            if is.reverse {
                ia.push_str(r#" reverse="1""#);
            }
            if !is.show_value {
                ia.push_str(r#" showValue="0""#);
            }
            body.push_str(&format!("<{p}iconSet{ia}>"));
            for c in &is.cfvos {
                body.push_str(&cfvo_2006(p, c));
            }
            body.push_str(&format!("</{p}iconSet>"));
        }
        CfKind::Unknown { .. } => return None,
    }
    let mut attrs = format!(r#" type="{ty}""#);
    if let Some(d) = dxf_id {
        if rule.kind.paints_dxf() {
            attrs.push_str(&format!(r#" dxfId="{d}""#));
        }
    }
    attrs.push_str(&format!(r#" priority="{}""#, rule.priority));
    if rule.stop_if_true {
        attrs.push_str(r#" stopIfTrue="1""#);
    }
    attrs.push_str(&a);
    Some(if body.is_empty() {
        format!("<{p}cfRule{attrs}/>")
    } else {
        format!("<{p}cfRule{attrs}>{body}</{p}cfRule>")
    })
}

/// The x14 data bar of a rule.
fn bar_x14(bar: &DataBarRule) -> String {
    let mut a = format!(
        r#" minLength="{}" maxLength="{}""#,
        bar.min_length, bar.max_length
    );
    if !bar.gradient {
        a.push_str(r#" gradient="0""#);
    }
    if bar.border {
        a.push_str(r#" border="1""#);
    }
    match bar.direction {
        BarDirection::LeftToRight => a.push_str(r#" direction="leftToRight""#),
        BarDirection::RightToLeft => a.push_str(r#" direction="rightToLeft""#),
        BarDirection::Context => {}
    }
    if bar.negative_same_as_positive {
        a.push_str(r#" negativeBarColorSameAsPositive="1""#);
    }
    match bar.axis_position {
        AxisPosition::Middle => a.push_str(r#" axisPosition="middle""#),
        AxisPosition::None => a.push_str(r#" axisPosition="none""#),
        AxisPosition::Automatic => {}
    }
    let mut s = format!(
        "<x14:dataBar{a}>{}{}",
        cfvo_x14(&bar.min),
        cfvo_x14(&bar.max)
    );
    if let Some(c) = &bar.border_color {
        s.push_str(&color_el("x14:", "borderColor", c));
    }
    s.push_str(&color_el(
        "x14:",
        "negativeFillColor",
        bar.negative_color
            .as_ref()
            .unwrap_or(&ColorRef::rgb(255, 0, 0)),
    ));
    if let Some(c) = &bar.negative_border_color {
        s.push_str(&color_el("x14:", "negativeBorderColor", c));
    }
    s.push_str(&color_el(
        "x14:",
        "axisColor",
        bar.axis_color.as_ref().unwrap_or(&ColorRef::rgb(0, 0, 0)),
    ));
    s.push_str("</x14:dataBar>");
    s
}

/// The x14 icon set of a rule.
fn icons_x14(is: &IconSetRule) -> String {
    let mut a = format!(r#" iconSet="{}""#, esc(&is.set));
    if is.custom.iter().any(Option::is_some) {
        a.push_str(r#" custom="1""#);
    }
    if is.reverse {
        a.push_str(r#" reverse="1""#);
    }
    if !is.show_value {
        a.push_str(r#" showValue="0""#);
    }
    let mut s = format!("<x14:iconSet{a}>");
    for c in &is.cfvos {
        s.push_str(&cfvo_x14(c));
    }
    if is.custom.iter().any(Option::is_some) {
        for (i, c) in is.custom.iter().enumerate() {
            let (set, id) = c.clone().unwrap_or((is.set.clone(), i as u32));
            s.push_str(&format!(
                r#"<x14:cfIcon iconSet="{}" iconId="{id}"/>"#,
                esc(&set)
            ));
        }
    }
    s.push_str("</x14:iconSet>");
    s
}

/// The x14 rule for a rule that needs one (`None` otherwise).
fn rule_x14(rule: &CfRule, guid: &str, x14_only: bool) -> Option<String> {
    match &rule.kind {
        CfKind::DataBar(bar) => Some(format!(
            r#"<x14:cfRule type="dataBar" id="{guid}">{}</x14:cfRule>"#,
            bar_x14(bar)
        )),
        CfKind::IconSet(is) if x14_only || icons_need_x14(is) => Some(format!(
            r#"<x14:cfRule type="iconSet" priority="{}" id="{guid}">{}</x14:cfRule>"#,
            rule.priority,
            icons_x14(is)
        )),
        _ => None,
    }
}

impl XlsxDocument {
    /// The dxf id a rule's differential format is written with: the id it
    /// was read with while the format is unchanged, else an existing equal
    /// `<dxf>`, else a new one appended to `styles.xml`.
    fn dxf_id_for(&mut self, rule: &CfRule) -> Result<Option<u32>, XlsxError> {
        let Some(d) = &rule.dxf else {
            return Ok(None);
        };
        if let Some(id) = rule.dxf_id {
            if self.dxf_models.get(id as usize) == Some(d) {
                return Ok(Some(id));
            }
        }
        if let Some(i) = self.dxf_models.iter().position(|x| x == d) {
            return Ok(Some(i as u32));
        }
        self.append_dxf(d).map(Some)
    }

    /// Write `cf` as the conditional formats of `sheet` (see the module
    /// docs). The model the document reads afterwards is the written one.
    pub fn write_conditional_formats(
        &mut self,
        sheet: SheetId,
        cf: &SheetCf,
    ) -> Result<(), XlsxError> {
        let p = self.ws_prefix(sheet);
        let old_blocks: Vec<(Vec<u8>, CfBlock)> = self
            .ws_children(sheet, "conditionalFormatting")
            .into_iter()
            .filter_map(|b| cf_model::parse_block(&b, &self.dxf_models).map(|m| (b, m)))
            .collect();
        let mut used = vec![false; old_blocks.len()];
        let mut out_2006: Vec<Vec<u8>> = Vec::new();
        let mut x14_rules: Vec<String> = Vec::new();
        for (bi, block) in cf.blocks.iter().enumerate() {
            let anchor = block
                .ranges
                .first()
                .map(|r| sheet_core::format_a1(r.0, r.1, false, false).to_string())
                .unwrap_or_else(|| "A1".into());
            // An unchanged block keeps the bytes it was read with — with
            // its rules' priorities spliced in when only those moved.
            let keep = if block.x14_only {
                None
            } else {
                old_blocks
                    .iter()
                    .enumerate()
                    .find(|(i, (_, m))| !used[*i] && same_block(m, block))
                    .map(|(i, _)| i)
            };
            let mut rules_xml = String::new();
            let mut block_x14 = Vec::new();
            for (ri, rule) in block.rules.iter().enumerate() {
                let guid = rule
                    .ext_id
                    .clone()
                    .unwrap_or_else(|| rule_guid(sheet, bi, ri, rule));
                let dxf_id = self.dxf_id_for(rule)?;
                if !block.x14_only {
                    if let Some(x) = rule_2006(&p, rule, dxf_id, &anchor, &guid) {
                        rules_xml.push_str(&x);
                    }
                }
                // A kept 2006 rule links its extension only when it did.
                let linked = keep.is_none()
                    || rule.ext_id.is_some()
                    || rule_2006(&p, rule, dxf_id, &anchor, &guid).is_none();
                if linked {
                    if let Some(x) = rule_x14(rule, &guid, block.x14_only) {
                        block_x14.push(x);
                    }
                }
            }
            if !block_x14.is_empty() {
                x14_rules.push(format!(
                    r#"<x14:conditionalFormatting xmlns:xm="{NS_XM}">{}<xm:sqref>{}</xm:sqref></x14:conditionalFormatting>"#,
                    block_x14.join(""),
                    sqref(&block.ranges)
                ));
            }
            if block.x14_only || rules_xml.is_empty() {
                continue;
            }
            match keep {
                Some(i) => {
                    used[i] = true;
                    let priorities: Vec<i64> = block.rules.iter().map(|r| r.priority).collect();
                    out_2006.push(splice_priorities(&old_blocks[i].0, &priorities));
                }
                None => out_2006.push(
                    format!(
                        r#"<{p}conditionalFormatting sqref="{}">{rules_xml}</{p}conditionalFormatting>"#,
                        sqref(&block.ranges)
                    )
                    .into_bytes(),
                ),
            }
        }
        self.set_ws_children(sheet, "conditionalFormatting", out_2006)?;
        self.write_x14_cf(sheet, &p, &x14_rules)?;
        let full = cf_model::parse_sheet(
            self.ws_children_after(sheet).iter().map(Vec::as_slice),
            &self.dxf_models,
        );
        if full.is_empty() {
            self.cf_models.remove(&sheet);
        } else {
            self.cf_models.insert(sheet, full);
        }
        Ok(())
    }

    /// Replace the worksheet extension that holds `x14:conditionalFormattings`
    /// (dropping it when `rules` is empty), keeping every other extension.
    fn write_x14_cf(&mut self, sheet: SheetId, p: &str, rules: &[String]) -> Result<(), XlsxError> {
        let new_ext = (!rules.is_empty()).then(|| {
            format!(
                r#"<{p}ext uri="{EXT_X14_CF}" xmlns:x14="{NS_X14}"><x14:conditionalFormattings>{}</x14:conditionalFormattings></{p}ext>"#,
                rules.join("")
            )
        });
        let current = self.ws_child(sheet, "extLst").map(<[u8]>::to_vec);
        let mut exts: Vec<String> = Vec::new();
        let mut replaced = false;
        if let Some(cur) = &current {
            let text = String::from_utf8_lossy(cur);
            for (start, end) in ext_spans(&text) {
                let ext = &text[start..end];
                if ext.contains(EXT_X14_CF) {
                    // Unchanged content keeps its bytes.
                    if let Some(n) = &new_ext {
                        exts.push(if normalize(ext) == normalize(n) {
                            ext.to_string()
                        } else {
                            n.clone()
                        });
                    }
                    replaced = true;
                } else {
                    exts.push(ext.to_string());
                }
            }
        }
        if !replaced {
            if let Some(n) = new_ext {
                exts.push(n);
            }
        }
        let bytes = (!exts.is_empty())
            .then(|| format!("<{p}extLst>{}</{p}extLst>", exts.join("")).into_bytes());
        if bytes.as_deref() != current.as_deref() {
            self.set_ws_child(sheet, "extLst", bytes)?;
        }
        Ok(())
    }

    /// Append a `<dxf>` to `styles.xml` and return its index.
    fn append_dxf(&mut self, d: &DifferentialFormat) -> Result<u32, XlsxError> {
        // The re-parse in `append_style_record` refreshes `dxf_models`.
        self.append_style_record("dxfs", |p| render_dxf(d, p))
    }
}

/// Two blocks are the same when their ranges and rules are, ignoring the
/// ids a write fills in and the priorities (which [`splice_priorities`]
/// rewrites in place).
fn same_block(a: &CfBlock, b: &CfBlock) -> bool {
    a.ranges == b.ranges
        && a.rules.len() == b.rules.len()
        && a.rules
            .iter()
            .zip(&b.rules)
            .all(|(x, y)| x.kind == y.kind && x.stop_if_true == y.stop_if_true && x.dxf == y.dxf)
}

/// Rewrite the `priority="…"` of a block's `cfRule`s, in order.
fn splice_priorities(bytes: &[u8], priorities: &[i64]) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut rest: &str = &text;
    let mut next = priorities.iter();
    while let Some(at) = rest.find("cfRule") {
        // Only a start tag (`<cfRule` / `<x:cfRule`), not its end tag.
        let is_start =
            rest[..at].ends_with('<') || rest[..at].ends_with(':') && !rest[..at].ends_with("</");
        let tag_end = rest[at..].find('>').map(|j| at + j).unwrap_or(rest.len());
        let tag = &rest[..tag_end];
        if is_start && !rest[..at].ends_with('/') {
            if let (Some(p), Some(&prio)) = (tag[at..].find(" priority=\""), next.next()) {
                let vs = at + p + " priority=\"".len();
                let ve = vs + tag[vs..].find('"').unwrap_or(0);
                out.push_str(&rest[..vs]);
                out.push_str(&prio.to_string());
                out.push_str(&rest[ve..tag_end]);
                rest = &rest[tag_end..];
                continue;
            }
        }
        out.push_str(&rest[..tag_end]);
        rest = &rest[tag_end..];
    }
    out.push_str(rest);
    out.into_bytes()
}

/// The `<ext>` element spans of an `extLst` (top level).
fn ext_spans(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let Ok(lst) = crate::xtree::XNode::parse(text.as_bytes()) else {
        return out;
    };
    let _ = lst;
    // Walk by depth: an `<…ext ` start at depth 1 to its matching end.
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut i = 0usize;
    let mut start = None;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let close = text[i..]
                .find('>')
                .map(|j| i + j)
                .unwrap_or(bytes.len() - 1);
            let tag = &text[i + 1..close];
            let self_closing = tag.ends_with('/');
            if tag.starts_with('?') || tag.starts_with('!') {
                i = close + 1;
                continue;
            }
            if let Some(rest) = tag.strip_prefix('/') {
                depth -= 1;
                let local = rest.trim().rsplit(':').next().unwrap_or("");
                if depth == 1 && local == "ext" {
                    if let Some(s) = start.take() {
                        out.push((s, close + 1));
                    }
                }
            } else {
                let name = tag
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('/');
                let local = name.rsplit(':').next().unwrap_or("");
                if depth == 1 && local == "ext" {
                    if self_closing {
                        out.push((i, close + 1));
                    } else {
                        start = Some(i);
                    }
                }
                if !self_closing {
                    depth += 1;
                }
            }
            i = close + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// Whitespace-insensitive comparison form.
fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl XlsxDocument {
    /// The captured children named `local` of a sheet, in order.
    pub fn ws_children(&self, sheet: SheetId, local: &str) -> Vec<Vec<u8>> {
        self.bindings
            .iter()
            .find(|b| b.sheet_id == sheet)
            .map(|b| {
                b.captured
                    .items
                    .iter()
                    .filter(|c| captured_local(&c.bytes) == local)
                    .map(|c| c.bytes.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The captured children after `<sheetData>` of a sheet.
    fn ws_children_after(&self, sheet: SheetId) -> Vec<Vec<u8>> {
        self.bindings
            .iter()
            .find(|b| b.sheet_id == sheet)
            .map(|b| b.captured.after().map(|c| c.bytes.clone()).collect())
            .unwrap_or_default()
    }

    /// Replace every captured child named `local` of a sheet with `items`
    /// (in order, at the schema position of the first old one or of the
    /// name).
    pub fn set_ws_children(
        &mut self,
        sheet: SheetId,
        local: &str,
        items: Vec<Vec<u8>>,
    ) -> Result<(), XlsxError> {
        let binding = self
            .bindings
            .iter_mut()
            .find(|b| b.sheet_id == sheet)
            .ok_or_else(|| XlsxError::Structure(format!("sheet {sheet} has no part")))?;
        let list = &mut binding.captured.items;
        let unchanged = {
            let old: Vec<&Vec<u8>> = list
                .iter()
                .filter(|c| captured_local(&c.bytes) == local)
                .map(|c| &c.bytes)
                .collect();
            old.len() == items.len() && old.iter().zip(&items).all(|(a, b)| *a == b)
        };
        if unchanged {
            return Ok(());
        }
        let first = list.iter().position(|c| captured_local(&c.bytes) == local);
        list.retain(|c| captured_local(&c.bytes) != local);
        let rank = crate::ws_child::ws_rank(local);
        let at = first.unwrap_or_else(|| {
            list.iter()
                .position(|c| crate::ws_child::ws_rank(&captured_local(&c.bytes)) > rank)
                .unwrap_or(list.len())
        });
        let at = at.min(list.len());
        for (i, bytes) in items.into_iter().enumerate() {
            list.insert(
                at + i,
                crate::preserve::CapturedSubtree {
                    anchor: crate::preserve::Anchor::AfterSheetData,
                    bytes,
                    span: None,
                },
            );
        }
        self.container.dirty = true;
        Ok(())
    }
}

/// Test helper: the element tree of a dxf (the writer's output re-read).
#[cfg(test)]
pub(crate) fn dxf_round_trip(d: &DifferentialFormat) -> DifferentialFormat {
    let xml = render_dxf(d, "");
    let el = crate::style_edit::parse_elem(xml.as_bytes()).unwrap();
    crate::parts::style_model::dxf_of(&el)
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;
    use sheet_core::visual::FontDelta;

    #[test]
    fn a_dxf_writes_and_reads_back__feat__sheet_xlsx_condfmt() {
        let d = DifferentialFormat {
            font: Some(FontDelta {
                bold: Some(false),
                color: Some(ColorRef::rgb(0x9C, 0, 6)),
                ..Default::default()
            }),
            fill: Some(CellFill::Pattern {
                pattern: PatternKind::Solid,
                fg: Some(ColorRef::rgb(0xFF, 0xC7, 0xCE)),
                bg: None,
            }),
            num_fmt: Some("0.00".into()),
            ..Default::default()
        };
        assert_eq!(dxf_round_trip(&d), d);
    }

    #[test]
    fn ext_spans_find_the_top_level_extensions() {
        let t = r#"<extLst><ext uri="a"><x:y/></ext><ext uri="b"/></extLst>"#;
        let s = ext_spans(t);
        assert_eq!(s.len(), 2);
        assert_eq!(&t[s[0].0..s[0].1], r#"<ext uri="a"><x:y/></ext>"#);
        assert_eq!(&t[s[1].0..s[1].1], r#"<ext uri="b"/>"#);
    }
}
