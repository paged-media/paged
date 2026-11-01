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

//! `styles.xml` save-back (doc ADR 610): a Word style modified in paged is
//! spliced in place, a style created in paged is appended with its
//! `w:basedOn`.
//!
//! The host reads each style's OWN properties (`document.styleProperties`:
//! `""` / `null` where the style inherits). A Word style's own properties
//! are compared with what the lowering gave it; only properties the import
//! maps are compared (the character and paragraph paths `docx-lower`
//! writes), so what the lowering cannot say is never rewritten. A changed
//! property rewrites only its element (`merge_rpr`, `merge_ppr`); every
//! other byte of the part stays.

use std::collections::BTreeMap;

use docx_core::{DocxDocument, ParaProps, RunProps, StyleKind};
use docx_lower::ir::{LoweredDoc, PropValue, StyleProp};
use paged_ooxml::splice::{attr_local, attrs_of, children_of, root_children, Span};
use serde::Deserialize;

use crate::bindings::DocxBindings;
use crate::diff::{invert_para_props, invert_props};
use crate::edit::RunFormat;
use crate::rpr::{merge_ppr_keeping, merge_rpr, render_ppr, render_rpr};

/// One document style as the host reads it (`document.styleProperties`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleIn {
    /// `paragraph` or `character`.
    pub collection: String,
    pub style_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub based_on: Option<String>,
    #[serde(default)]
    pub entries: Vec<StyleEntryIn>,
}

/// One property of a style: its path and its own value (the wire `Value`,
/// `{ type, value }`), absent or empty where the style inherits it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct StyleEntryIn {
    pub path: String,
    #[serde(default)]
    pub value: Option<WireValue>,
}

/// The wire `Value` shape, read loosely: what save-back needs of it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WireValue {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub value: Option<Scalar>,
}

/// A wire value's payload, when it is a plain one.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Scalar {
    Bool(bool),
    Number(f64),
    Text(String),
    Other(serde::de::IgnoredAny),
}

impl Default for Scalar {
    fn default() -> Self {
        Scalar::Bool(false)
    }
}

/// The character paths the import maps (`docx-lower`'s `run_props`).
const CHAR_PATHS: &[&str] = &[
    "characterFontFamily",
    "characterFontStyle",
    "characterFontSize",
    "characterFillColor",
    "characterUnderline",
    "characterStrikethru",
    "characterPosition",
    "characterCase",
    "characterBaselineShift",
    "characterTracking",
];

/// The paragraph paths the import maps that save-back can write back.
const PARA_PATHS: &[&str] = &[
    "paragraphJustification",
    "paragraphLeftIndent",
    "paragraphRightIndent",
    "paragraphFirstLineIndent",
    "paragraphSpaceBefore",
    "paragraphSpaceAfter",
    "paragraphKeepLinesTogether",
];

/// A wire value as a lowering property value, `None` where it says "not
/// set here" (an empty text, a null length or colour, a bool off: the
/// engine reads an unset bool as off).
pub(crate) fn own_value(v: &WireValue) -> Option<PropValue> {
    match (v.kind.as_str(), v.value.as_ref()?) {
        ("text" | "enum" | "ref", Scalar::Text(s)) if !s.is_empty() => {
            Some(PropValue::Text(s.clone()))
        }
        ("length" | "number", Scalar::Number(n)) => Some(PropValue::Length(*n as f32)),
        ("bool", Scalar::Bool(b)) => b.then_some(PropValue::Bool(true)),
        ("colorRef", Scalar::Text(s)) if !s.is_empty() => Some(PropValue::ColorRef(s.clone())),
        _ => None,
    }
}

/// A lowering's own value as save-back compares it (a bool off is unset).
fn lowered_value(v: &PropValue) -> Option<PropValue> {
    match v {
        PropValue::Bool(false) => None,
        PropValue::Text(s) if s.is_empty() => None,
        other => Some(other.clone()),
    }
}

fn same(a: &Option<PropValue>, b: &Option<PropValue>) -> bool {
    match (a, b) {
        (Some(PropValue::Length(x)), Some(PropValue::Length(y))) => (x - y).abs() < 0.01,
        _ => a == b,
    }
}

/// What a save writes into `styles.xml`.
#[derive(Debug, Clone, Default)]
pub struct StylePlan {
    /// Word styles modified in paged: `(styleId, kind, rPr from → to, new
    /// paragraph properties)`.
    pub modified: Vec<ModifiedStyle>,
    /// Styles created in paged, in order, each with its new Word id.
    pub created: Vec<CreatedStyle>,
}

/// A Word style modified in paged.
#[derive(Debug, Clone)]
pub struct ModifiedStyle {
    pub style_id: String,
    /// Its run properties before and after (`None`: unchanged).
    pub run: Option<(RunFormat, RunFormat)>,
    /// Its paragraph properties after (`None`: unchanged).
    pub para: Option<ParaProps>,
}

/// A style created in paged, as it is written into `styles.xml`.
#[derive(Debug, Clone)]
pub struct CreatedStyle {
    /// Its token in paged.
    pub token: String,
    pub style_id: String,
    pub name: String,
    pub kind: StyleKind,
    /// The Word id of its parent, when that is a Word style or another
    /// created one.
    pub based_on: Option<String>,
    pub run: RunProps,
    pub para: ParaProps,
}

impl StylePlan {
    pub fn is_empty(&self) -> bool {
        self.modified.is_empty() && self.created.is_empty()
    }

    /// Created paragraph (`para`) or character style tokens with their new
    /// Word ids.
    pub fn created_ids(&self, para: bool) -> impl Iterator<Item = (&str, &str)> {
        self.created
            .iter()
            .filter(move |c| (c.kind == StyleKind::Paragraph) == para)
            .map(|c| (c.token.as_str(), c.style_id.as_str()))
    }
}

/// Whether a style id is one of the engine's own (`[No paragraph style]`,
/// `[Basic Paragraph]`, `NormalParagraphStyle`): never written to Word.
fn engine_builtin(token: &str) -> bool {
    let name = token.rsplit('/').next().unwrap_or(token);
    name.starts_with('[') || name.starts_with("Normal") && token.contains("$ID/")
}

/// The changed own properties of one style: `(path, new own value)`.
fn changes(own: &[StyleProp], live: &StyleIn, paths: &[&str]) -> Vec<(String, Option<PropValue>)> {
    let mut out = Vec::new();
    for e in &live.entries {
        if !paths.contains(&e.path.as_str()) {
            continue;
        }
        let Some(v) = &e.value else { continue };
        let now = own_value(v);
        let was = own
            .iter()
            .find(|p| p.path == e.path)
            .and_then(|p| lowered_value(&p.value));
        if !same(&now, &was) {
            out.push((e.path.clone(), now));
        }
    }
    out
}

/// The size a style's text is set in, for its character spacing.
fn size_of(live: &StyleIn) -> f32 {
    live.entries
        .iter()
        .find(|e| e.path == "characterFontSize")
        .and_then(|e| e.value.as_ref())
        .and_then(own_value)
        .and_then(|v| match v {
            PropValue::Length(pt) => Some(pt),
            _ => None,
        })
        .unwrap_or(10.0)
}

/// `to` with the run fields of the changed paths set to what `changed`
/// says (cleared where it says nothing).
fn apply_run_changes(
    to: &mut RunProps,
    changed: &[(String, Option<PropValue>)],
    size_pt: f32,
    doc: &LoweredDoc,
) {
    let props: Vec<StyleProp> = changed
        .iter()
        .filter_map(|(path, v)| {
            v.clone().map(|value| StyleProp {
                path: path.clone(),
                value,
            })
        })
        .collect();
    let new = invert_props(&props, size_pt, doc);
    for (path, _) in changed {
        match path.as_str() {
            "characterFontFamily" => {
                to.font = new.font.clone();
                to.font_theme = new.font_theme.clone();
            }
            "characterFontStyle" => {
                to.bold = new.bold;
                to.italic = new.italic;
            }
            "characterFontSize" => to.size_half_pts = new.size_half_pts,
            "characterFillColor" => {
                to.color = new.color.clone();
                to.theme_color = new.theme_color.clone();
            }
            "characterUnderline" => to.underline = new.underline.or(Some(false)),
            "characterStrikethru" => to.strike = new.strike.or(Some(false)),
            "characterPosition" => to.vert_align = new.vert_align,
            "characterCase" => {
                to.caps = new.caps;
                to.small_caps = new.small_caps;
            }
            "characterBaselineShift" => to.baseline_half_pts = new.baseline_half_pts,
            "characterTracking" => to.spacing_twips = new.spacing_twips,
            // Doc ADR 620 — script slots and direction.
            "characterEastAsianFont" => to.font_east_asia = new.font_east_asia.clone(),
            "characterComplexFont" => to.font_cs = new.font_cs.clone(),
            "characterComplexFontSize" => to.size_cs_half_pts = new.size_cs_half_pts,
            "characterComplexBold" => to.bold_cs = new.bold_cs,
            "characterComplexItalic" => to.italic_cs = new.italic_cs,
            "characterComplexScript" => to.complex_script = new.complex_script,
            "characterDirection" => to.rtl = new.rtl,
            "characterFontHint" => to.font_hint = new.font_hint.clone(),
            _ => {}
        }
    }
}

/// `to` with the paragraph fields of the changed paths set.
fn apply_para_changes(to: &mut ParaProps, changed: &[(String, Option<PropValue>)]) {
    let props: Vec<StyleProp> = changed
        .iter()
        .filter_map(|(path, v)| {
            v.clone().map(|value| StyleProp {
                path: path.clone(),
                value,
            })
        })
        .collect();
    let new = invert_para_props(&props);
    for (path, _) in changed {
        match path.as_str() {
            "paragraphJustification" => to.justification = new.justification,
            "paragraphLeftIndent" => to.left_indent = new.left_indent,
            "paragraphRightIndent" => to.right_indent = new.right_indent,
            "paragraphFirstLineIndent" => {
                to.first_line_indent = new.first_line_indent;
                to.hanging_indent = new.hanging_indent;
            }
            "paragraphSpaceBefore" => to.space_before = new.space_before,
            "paragraphSpaceAfter" => to.space_after = new.space_after,
            "paragraphKeepLinesTogether" => to.keep_lines = new.keep_lines.or(Some(false)),
            "paragraphDirection" => to.bidi = new.bidi,
            _ => {}
        }
    }
}

/// A Word style id for a created style's name: its letters and digits
/// (Word drops the spaces), made unique among `taken`.
fn new_style_id(name: &str, taken: &mut Vec<String>) -> String {
    let mut base: String = name.chars().filter(|c| c.is_alphanumeric()).collect();
    if base.is_empty() {
        base = "PagedStyle".into();
    }
    let mut id = base.clone();
    let mut n = 1;
    while taken.iter().any(|t| t.eq_ignore_ascii_case(&id)) {
        n += 1;
        id = format!("{base}{n}");
    }
    taken.push(id.clone());
    id
}

/// What a save writes into `styles.xml`, from the styles the host read
/// (`live`), the lowering they were made from (`baseline`; its swatches and
/// the canvas's colours in `edited`), the model and the token maps.
pub fn plan_styles(
    model: &DocxDocument,
    baseline: &LoweredDoc,
    edited: &LoweredDoc,
    bindings: &DocxBindings,
    live: &[StyleIn],
) -> StylePlan {
    let mut plan = StylePlan::default();
    // Word styles modified in paged.
    let word_id = |s: &StyleIn| {
        let map = if s.collection == "character" {
            &bindings.char_token_to_style_id
        } else {
            &bindings.para_token_to_style_id
        };
        map.get(&s.style_id).cloned()
    };
    for s in live {
        let Some(id) = word_id(s) else { continue };
        let Some(word) = model.styles.styles.iter().find(|w| w.style_id == id) else {
            continue;
        };
        let own: &[StyleProp] = baseline
            .styles
            .iter()
            .find(|l| l.id == s.style_id)
            .map_or(&[], |l| l.props.as_slice());
        let run_changes = changes(own, s, CHAR_PATHS);
        let para_changes = if s.collection == "paragraph" {
            changes(own, s, PARA_PATHS)
        } else {
            Vec::new()
        };
        if run_changes.is_empty() && para_changes.is_empty() {
            continue;
        }
        let run = (!run_changes.is_empty()).then(|| {
            let from = RunFormat {
                props: word.run.clone(),
                rstyle: None,
            };
            let mut to = from.clone();
            apply_run_changes(&mut to.props, &run_changes, size_of(s), edited);
            (from, to)
        });
        let para = (!para_changes.is_empty()).then(|| {
            let mut p = word.para.clone();
            apply_para_changes(&mut p, &para_changes);
            p
        });
        plan.modified.push(ModifiedStyle {
            style_id: id,
            run,
            para,
        });
    }
    // Styles created in paged: every style the lowering did not make.
    let mut taken: Vec<String> = model
        .styles
        .styles
        .iter()
        .map(|s| s.style_id.clone())
        .collect();
    let lowered = |t: &str| baseline.styles.iter().any(|l| l.id == t);
    let mut ids: BTreeMap<String, String> = BTreeMap::new();
    let fresh: Vec<&StyleIn> = live
        .iter()
        .filter(|s| {
            matches!(s.collection.as_str(), "paragraph" | "character")
                && !lowered(&s.style_id)
                && !s.style_id.contains("/docx-")
                && !engine_builtin(&s.style_id)
        })
        .collect();
    for s in &fresh {
        let name = s
            .name
            .clone()
            .unwrap_or_else(|| s.style_id.rsplit('/').next().unwrap_or("").to_string());
        ids.insert(s.style_id.clone(), new_style_id(&name, &mut taken));
    }
    for s in fresh {
        let para = s.collection == "paragraph";
        let based_on = s.based_on.as_ref().and_then(|b| {
            let map = if para {
                &bindings.para_token_to_style_id
            } else {
                &bindings.char_token_to_style_id
            };
            map.get(b).or_else(|| ids.get(b)).cloned()
        });
        let mut run = RunProps::default();
        let run_changes = changes(&[], s, CHAR_PATHS);
        apply_run_changes(&mut run, &run_changes, size_of(s), edited);
        // An unset toggle stays unset in a new style.
        if !run_changes
            .iter()
            .any(|(p, v)| p == "characterUnderline" && v.is_some())
        {
            run.underline = None;
        }
        if !run_changes
            .iter()
            .any(|(p, v)| p == "characterStrikethru" && v.is_some())
        {
            run.strike = None;
        }
        let mut props = ParaProps::default();
        if para {
            let para_changes = changes(&[], s, PARA_PATHS);
            apply_para_changes(&mut props, &para_changes);
            if !para_changes
                .iter()
                .any(|(p, v)| p == "paragraphKeepLinesTogether" && v.is_some())
            {
                props.keep_lines = None;
            }
        }
        plan.created.push(CreatedStyle {
            token: s.style_id.clone(),
            style_id: ids[&s.style_id].clone(),
            name: s.name.clone().unwrap_or_else(|| ids[&s.style_id].clone()),
            kind: if para {
                StyleKind::Paragraph
            } else {
                StyleKind::Character
            },
            based_on,
            run,
            para: props,
        });
    }
    plan
}

/// `CT_Style`'s children that come after `pPr` / `rPr` (where a new one
/// goes before).
const AFTER_PPR: &[&str] = &["rPr", "tblPr", "trPr", "tcPr", "tblStylePr"];
const AFTER_RPR: &[&str] = &["tblPr", "trPr", "tcPr", "tblStylePr"];

/// Splice `plan` into the styles part `xml`. Answers the new part and what
/// could not be written (a style not found).
pub fn splice_styles(xml: &[u8], plan: &StylePlan) -> (Vec<u8>, Vec<String>) {
    let mut skips = Vec::new();
    let Ok((kids, root_end)) = root_children(xml) else {
        skips.push("styles.xml cannot be read: its styles are kept as they were".into());
        return (xml.to_vec(), skips);
    };
    // Edits as (start, end, bytes), applied back to front.
    let mut edits: Vec<(usize, usize, Vec<u8>)> = Vec::new();
    for m in &plan.modified {
        let found = kids.iter().find(|k| {
            k.local == "style"
                && attrs_of(xml, k)
                    .ok()
                    .and_then(|a| attr_local(&a, "styleId"))
                    .as_deref()
                    == Some(m.style_id.as_str())
        });
        let Some(style) = found else {
            skips.push(format!(
                "style {} was not found in styles.xml: its change is not saved",
                m.style_id
            ));
            continue;
        };
        if style.empty {
            skips.push(format!(
                "style {} is empty in styles.xml: its change is not saved",
                m.style_id
            ));
            continue;
        }
        let children: Vec<Span> = children_of(xml, style).map(|c| c.0).unwrap_or_default();
        let child = |name: &str| children.iter().find(|c| c.local == name);
        let insert_at = |after: &[&str]| {
            children
                .iter()
                .find(|c| after.contains(&c.local.as_str()))
                .map_or(style.end - closing_len(xml, style), |c| c.start)
        };
        if let Some(p) = &m.para {
            let new = render_ppr(p, None);
            match child("pPr") {
                Some(c) => {
                    // Only what a style edit can change is rewritten.
                    let merged = merge_ppr_keeping(
                        Some(&xml[c.start..c.end]),
                        &new,
                        &["pStyle", "keepNext", "pageBreakBefore", "tabs"],
                    );
                    edits.push((c.start, c.end, merged));
                }
                None => edits.push((insert_at(AFTER_PPR), insert_at(AFTER_PPR), new)),
            }
        }
        if let Some((from, to)) = &m.run {
            match child("rPr") {
                Some(c) => {
                    if let Some(merged) = merge_rpr(Some(&xml[c.start..c.end]), from, to) {
                        edits.push((c.start, c.end, merged));
                    }
                }
                None => {
                    if let Some(merged) = merge_rpr(None, from, to) {
                        let at = insert_at(AFTER_RPR);
                        edits.push((at, at, merged));
                    }
                }
            }
        }
    }
    if !plan.created.is_empty() {
        let mut add = Vec::new();
        for c in &plan.created {
            add.extend_from_slice(&render_style(c));
        }
        edits.push((root_end, root_end, add));
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = xml.to_vec();
    for (s, e, bytes) in edits {
        out.splice(s..e, bytes);
    }
    (out, skips)
}

/// The length of a non-empty element's end tag (`</w:style>`).
fn closing_len(xml: &[u8], span: &Span) -> usize {
    xml[span.start..span.end]
        .iter()
        .rposition(|&b| b == b'<')
        .map_or(0, |p| span.end - span.start - p)
}

/// A created style's `<w:style>`.
fn render_style(c: &CreatedStyle) -> Vec<u8> {
    use quick_xml::escape::escape;
    let kind = match c.kind {
        StyleKind::Character => "character",
        _ => "paragraph",
    };
    let mut s = format!(
        "<w:style w:type=\"{kind}\" w:customStyle=\"1\" w:styleId=\"{}\"><w:name w:val=\"{}\"/>",
        escape(c.style_id.as_str()),
        escape(c.name.as_str())
    );
    if let Some(b) = &c.based_on {
        s.push_str(&format!("<w:basedOn w:val=\"{}\"/>", escape(b.as_str())));
    }
    s.push_str("<w:qFormat/>");
    let mut out = s.into_bytes();
    if c.kind == StyleKind::Paragraph {
        let ppr = render_ppr(&c.para, None);
        if ppr != b"<w:pPr></w:pPr>" {
            out.extend_from_slice(&ppr);
        }
    }
    let rpr = render_rpr(&c.run, None);
    if rpr != b"<w:rPr></w:rPr>" {
        out.extend_from_slice(&rpr);
    }
    out.extend_from_slice(b"</w:style>");
    out
}
