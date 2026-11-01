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

//! Fragment emitters: `RunProps -> <w:rPr>…</w:rPr>` and text `-> <w:t>…</w:t>`.
//! The exact inverse of `docx-import`'s `apply_run_property_choice`, in WML
//! `CT_RPr` child order. `w:`-prefixed element names resolve against the
//! `xmlns:w` decl on the root element (copied verbatim in the surrounding bytes).

use docx_core::{Justification, ParaProps, RunProps, VertAlign, LINE_BREAK, SOFT_HYPHEN};

use crate::edit::RunFormat;
use quick_xml::escape::escape;

/// Word's element for a NEW character of the kinds the import reads from a
/// run child rather than a `<w:t>`: its line break (`<w:br/>`, also
/// `<w:cr/>` → [`LINE_BREAK`], U+2028), its tab (`<w:tab/>`, also
/// `<w:ptab>` → `\t`), its non-breaking hyphen (`<w:noBreakHyphen/>` →
/// U+2011) and its optional hyphen (`<w:softHyphen/>` → [`SOFT_HYPHEN`]).
/// A `<w:sym>`'s character has no element of its own: a new one is text.
pub fn word_element(c: char) -> Option<&'static [u8]> {
    match c {
        LINE_BREAK => Some(b"<w:br/>"),
        '\t' => Some(b"<w:tab/>"),
        '\u{2011}' => Some(b"<w:noBreakHyphen/>"),
        SOFT_HYPHEN => Some(b"<w:softHyphen/>"),
        _ => None,
    }
}

/// How the source run wrote the k-th occurrence of a special character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecialSource<'a> {
    /// As an element (`<w:tab/>`, `<w:br w:clear="all"/>`, `<w:ptab …/>`,
    /// `<w:sym …/>`, …): these bytes.
    Element(&'a [u8]),
    /// As the character itself inside a `<w:t>` (a literal tab, U+2011, …).
    Literal,
}

/// A run's original special characters, per character, in text order: every
/// character [`word_element`] knows, plus the character of each `<w:sym>`
/// the run holds (and that character's literal occurrences, so the k-th one
/// of the edited text takes the k-th one's form).
#[derive(Debug, Default, Clone)]
pub struct RunSpecials<'a> {
    by_char: Vec<(char, Vec<SpecialSource<'a>>)>,
}

impl<'a> RunSpecials<'a> {
    pub fn push(&mut self, c: char, source: SpecialSource<'a>) {
        match self.by_char.iter_mut().find(|(k, _)| *k == c) {
            Some((_, v)) => v.push(source),
            None => self.by_char.push((c, vec![source])),
        }
    }

    fn sources(&self, c: char) -> Option<&[SpecialSource<'a>]> {
        self.by_char
            .iter()
            .find(|(k, _)| *k == c)
            .map(|(_, v)| v.as_slice())
    }
}

/// A run's text content: `<w:t>` elements, always `xml:space="preserve"` so
/// leading/trailing spaces survive, with Word's element ([`word_element`])
/// for every line break ([`LINE_BREAK`], U+2028), tab, U+2011 and
/// [`SOFT_HYPHEN`] in `text`.
pub fn render_wt(text: &str) -> Vec<u8> {
    render_text(text, &RunSpecials::default())
}

/// [`render_wt`], writing the k-th occurrence of each special character the
/// way the source run wrote ITS k-th one ([`RunSpecials`]): the original
/// element bytes verbatim (a `w:clear`, a `w:cr`, a `w:ptab`, a `w:sym`), or
/// the literal character inside the `<w:t>` when the source had it there.
/// Occurrences past the source's count get Word's element ([`word_element`];
/// a symbol's character is plain text). So an edit that keeps a run's tabs,
/// breaks, hyphens and symbols keeps their exact bytes, in order.
pub fn render_text(text: &str, originals: &RunSpecials<'_>) -> Vec<u8> {
    render_text_from(text, originals, &mut Vec::new(), true)
}

/// [`render_text`] for one piece of a run's text, counting each special
/// character's occurrences on from `seen` (the pieces before it), so the
/// k-th one of the whole text still takes the source's k-th form. With
/// `empty_t`, no text at all writes one empty `<w:t>`.
pub fn render_text_from(
    text: &str,
    originals: &RunSpecials<'_>,
    seen: &mut Vec<(char, usize)>,
    empty_t: bool,
) -> Vec<u8> {
    let mut out = Vec::new();
    let mut part = String::new();
    let flush = |out: &mut Vec<u8>, part: &mut String| {
        if !part.is_empty() {
            out.extend_from_slice(
                format!(
                    "<w:t xml:space=\"preserve\">{}</w:t>",
                    escape(part.as_str())
                )
                .as_bytes(),
            );
            part.clear();
        }
    };
    for c in text.chars() {
        let element = word_element(c);
        let sources = originals.sources(c);
        if element.is_none() && sources.is_none() {
            part.push(c);
            continue;
        }
        let i = match seen.iter().position(|(s, _)| *s == c) {
            Some(i) => i,
            None => {
                seen.push((c, 0));
                seen.len() - 1
            }
        };
        let source = sources.and_then(|v| v.get(seen[i].1)).copied();
        seen[i].1 += 1;
        match (source, element) {
            (Some(SpecialSource::Element(bytes)), _) => {
                flush(&mut out, &mut part);
                out.extend_from_slice(bytes);
            }
            (None, Some(bytes)) => {
                flush(&mut out, &mut part);
                out.extend_from_slice(bytes);
            }
            (Some(SpecialSource::Literal), _) | (None, None) => part.push(c),
        }
    }
    flush(&mut out, &mut part);
    // A run with no text at all still gets its one (empty) `<w:t>`.
    if out.is_empty() && empty_t {
        out.extend_from_slice(b"<w:t xml:space=\"preserve\"></w:t>");
    }
    out
}

/// A `<w:rPr>` element for the run's effective direct properties. `rstyle` is a
/// REAL Word style id (`<w:rStyle>`), emitted first per the schema; synthesized
/// styles must already have been projected into `props`, never passed here.
pub fn render_rpr(props: &RunProps, rstyle: Option<&str>) -> Vec<u8> {
    let mut s = String::from("<w:rPr>");
    if let Some(id) = rstyle {
        s.push_str(&format!("<w:rStyle w:val=\"{}\"/>", escape(id)));
    }
    if props.font.is_some()
        || props.font_east_asia.is_some()
        || props.font_cs.is_some()
        || props.font_hint.is_some()
    {
        s.push_str("<w:rFonts");
        if let Some(font) = &props.font {
            match &props.font_theme {
                // The theme font, by reference and by name (doc ADR 609).
                Some(slot) => s.push_str(&format!(
                    " w:ascii=\"{0}\" w:hAnsi=\"{0}\" w:asciiTheme=\"{1}\" w:hAnsiTheme=\"{1}\"",
                    escape(font),
                    escape(slot)
                )),
                None => s.push_str(&format!(" w:ascii=\"{}\"", escape(font))),
            }
        }
        // Doc ADR 620 — the East Asian and complex-script faces, the hint.
        if let Some(f) = &props.font_east_asia {
            s.push_str(&format!(" w:eastAsia=\"{}\"", escape(f)));
        }
        if let Some(f) = &props.font_cs {
            s.push_str(&format!(" w:cs=\"{}\"", escape(f)));
        }
        if let Some(h) = &props.font_hint {
            s.push_str(&format!(" w:hint=\"{}\"", escape(h)));
        }
        s.push_str("/>");
    }
    toggle(&mut s, "b", props.bold);
    toggle(&mut s, "bCs", props.bold_cs);
    toggle(&mut s, "i", props.italic);
    toggle(&mut s, "iCs", props.italic_cs);
    toggle(&mut s, "caps", props.caps);
    toggle(&mut s, "smallCaps", props.small_caps);
    toggle(&mut s, "strike", props.strike);
    if let Some(color) = &props.color {
        s.push_str(&format!("<w:color w:val=\"{}\"", escape(color)));
        // A theme colour: the reference Word reads, the hex its cache.
        if let Some(t) = &props.theme_color {
            s.push_str(&format!(" w:themeColor=\"{}\"", escape(&t.slot)));
            if let Some(v) = t.tint {
                s.push_str(&format!(" w:themeTint=\"{v:02X}\""));
            }
            if let Some(v) = t.shade {
                s.push_str(&format!(" w:themeShade=\"{v:02X}\""));
            }
        }
        s.push_str("/>");
    }
    if let Some(tw) = props.spacing_twips {
        s.push_str(&format!("<w:spacing w:val=\"{tw}\"/>"));
    }
    if let Some(pos) = props.baseline_half_pts {
        s.push_str(&format!("<w:position w:val=\"{pos}\"/>"));
    }
    if let Some(sz) = props.size_half_pts {
        s.push_str(&format!("<w:sz w:val=\"{sz}\"/>"));
    }
    if let Some(sz) = props.size_cs_half_pts {
        s.push_str(&format!("<w:szCs w:val=\"{sz}\"/>"));
    }
    match props.underline {
        Some(true) => s.push_str("<w:u w:val=\"single\"/>"),
        Some(false) => s.push_str("<w:u w:val=\"none\"/>"),
        None => {}
    }
    if let Some(va) = &props.vert_align {
        let v = match va {
            VertAlign::Baseline => "baseline",
            VertAlign::Superscript => "superscript",
            VertAlign::Subscript => "subscript",
        };
        s.push_str(&format!("<w:vertAlign w:val=\"{v}\"/>"));
    }
    toggle(&mut s, "rtl", props.rtl);
    toggle(&mut s, "cs", props.complex_script);
    s.push_str("</w:rPr>");
    s.into_bytes()
}

/// A `<w:pPr>` element for a paragraph's applied style + direct formatting —
/// the paragraph twin of [`render_rpr`], in WML `CT_PPr` child order. `pstyle` is
/// a REAL Word style id; synthesized paragraph styles must already have been
/// projected into `props`.
pub fn render_ppr(props: &ParaProps, pstyle: Option<&str>) -> Vec<u8> {
    let mut s = String::from("<w:pPr>");
    if let Some(id) = pstyle {
        s.push_str(&format!("<w:pStyle w:val=\"{}\"/>", escape(id)));
    }
    if props.keep_next == Some(true) {
        s.push_str("<w:keepNext/>");
    }
    if props.keep_lines == Some(true) {
        s.push_str("<w:keepLines/>");
    }
    match props.page_break_before {
        Some(true) => s.push_str("<w:pageBreakBefore/>"),
        Some(false) => s.push_str("<w:pageBreakBefore w:val=\"0\"/>"),
        None => {}
    }
    // Doc ADR 620 — a right-to-left paragraph.
    match props.bidi {
        Some(true) => s.push_str("<w:bidi/>"),
        Some(false) => s.push_str("<w:bidi w:val=\"0\"/>"),
        None => {}
    }
    // <w:spacing> carries before/after together.
    if props.space_before.is_some() || props.space_after.is_some() {
        s.push_str("<w:spacing");
        if let Some(v) = props.space_before {
            s.push_str(&format!(" w:before=\"{v}\""));
        }
        if let Some(v) = props.space_after {
            s.push_str(&format!(" w:after=\"{v}\""));
        }
        s.push_str("/>");
    }
    // <w:ind> carries the indents together; a hanging indent is emitted as
    // `w:hanging` (a positive twip value), never as a negative firstLine.
    if props.left_indent.is_some()
        || props.right_indent.is_some()
        || props.first_line_indent.is_some()
        || props.hanging_indent.is_some()
    {
        s.push_str("<w:ind");
        if let Some(v) = props.left_indent {
            s.push_str(&format!(" w:left=\"{v}\""));
        }
        if let Some(v) = props.right_indent {
            s.push_str(&format!(" w:right=\"{v}\""));
        }
        if let Some(v) = props.hanging_indent {
            s.push_str(&format!(" w:hanging=\"{v}\""));
        } else if let Some(v) = props.first_line_indent {
            s.push_str(&format!(" w:firstLine=\"{v}\""));
        }
        s.push_str("/>");
    }
    if !props.tabs.is_empty() {
        s.push_str("<w:tabs>");
        for t in &props.tabs {
            let val = t.alignment.as_deref().unwrap_or("left");
            s.push_str(&format!(
                "<w:tab w:val=\"{}\" w:pos=\"{}\"/>",
                escape(val),
                t.position
            ));
        }
        s.push_str("</w:tabs>");
    }
    if let Some(j) = props.justification {
        let v = match j {
            Justification::Left | Justification::Start => "left",
            Justification::Center => "center",
            Justification::Right | Justification::End => "right",
            Justification::Both => "both",
            Justification::Distribute => "distribute",
        };
        s.push_str(&format!("<w:jc w:val=\"{v}\"/>"));
    }
    s.push_str("</w:pPr>");
    s.into_bytes()
}

/// `CT_PPr` child order (ECMA-376 §17.3.1.26): the merged `<w:pPr>` writes its
/// children in this order. A name not listed sorts after the known ones.
const PPR_ORDER: &[&str] = &[
    "pStyle",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "framePr",
    "widowControl",
    "numPr",
    "suppressLineNumbers",
    "pBdr",
    "shd",
    "tabs",
    "suppressAutoHyphens",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "autoSpaceDE",
    "autoSpaceDN",
    "bidi",
    "adjustRightInd",
    "snapToGrid",
    "spacing",
    "ind",
    "contextualSpacing",
    "mirrorIndents",
    "suppressOverlap",
    "jc",
    "textDirection",
    "textAlignment",
    "textboxTightWrap",
    "outlineLvl",
    "divId",
    "cnfStyle",
    "rPr",
    "sectPr",
    "pPrChange",
];

/// The `<w:pPr>` children [`render_ppr`] decides on. Every other child of the
/// original — numbering, borders, shading, the paragraph mark's run
/// properties, a `sectPr` that ends a section, a recorded change — is kept.
const PPR_OWNED: &[&str] = &[
    "pStyle",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "spacing",
    "ind",
    "tabs",
    "jc",
];

/// Attributes of `w:spacing` / `w:ind` that [`render_ppr`] decides on; the rest
/// (line spacing, auto spacing, character-unit indents …) are kept.
fn owned_attr(elem: &str, attr: &str) -> bool {
    match elem {
        "spacing" => matches!(attr, "before" | "after"),
        "ind" => matches!(
            attr,
            "left" | "right" | "start" | "end" | "hanging" | "firstLine"
        ),
        _ => false,
    }
}

fn local(name: &[u8]) -> &str {
    let n = std::str::from_utf8(name).unwrap_or("");
    n.rsplit(':').next().unwrap_or(n)
}

/// The top-level children of a `<w:pPr>…</w:pPr>` fragment: (local name,
/// the child's exact bytes, its attributes as (qualified name, raw value)).
type PprChild = (String, Vec<u8>, Vec<(String, String)>);

fn ppr_children(frag: &[u8]) -> Option<Vec<PprChild>> {
    use quick_xml::events::Event;
    let mut r = quick_xml::Reader::from_reader(frag);
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut cur: Option<(String, Vec<(String, String)>)> = None;
    loop {
        let before = r.buffer_position() as usize;
        match r.read_event().ok()? {
            Event::Start(e) => {
                depth += 1;
                if depth == 2 {
                    start = before;
                    cur = Some((local(e.name().as_ref()).to_string(), attrs(&e)));
                }
            }
            Event::Empty(e) => {
                if depth == 1 {
                    let end = r.buffer_position() as usize;
                    out.push((
                        local(e.name().as_ref()).to_string(),
                        frag[before..end].to_vec(),
                        attrs(&e),
                    ));
                }
            }
            Event::End(_) => {
                if depth == 2 {
                    let end = r.buffer_position() as usize;
                    let (n, a) = cur.take()?;
                    out.push((n, frag[start..end].to_vec(), a));
                }
                depth = depth.checked_sub(1)?;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Some(out)
}

fn attrs(e: &quick_xml::events::BytesStart<'_>) -> Vec<(String, String)> {
    e.attributes()
        .flatten()
        .map(|a| {
            (
                String::from_utf8_lossy(a.key.as_ref()).into_owned(),
                String::from_utf8_lossy(&a.value).into_owned(),
            )
        })
        .collect()
}

/// Merge a freshly rendered `<w:pPr>` (from [`render_ppr`]) into the
/// paragraph's ORIGINAL `<w:pPr>` bytes: the owned children come from `new`;
/// every other original child is kept byte for byte; `w:spacing` / `w:ind`
/// keep the original attributes `render_ppr` does not decide on. Children are
/// written in `CT_PPr` order. With no original, `new` is returned as is.
///
/// Without this, a paragraph-format edit dropped the paragraph's numbering,
/// borders, shading, line spacing and — on a section's last paragraph — the
/// `w:sectPr`, which deletes the section.
pub fn merge_ppr(original: Option<&[u8]>, new: &[u8]) -> Vec<u8> {
    merge_ppr_keeping(original, new, &[])
}

/// [`merge_ppr`], keeping the original's `keep` children too although
/// [`render_ppr`] owns them (a style edit that changes its indents keeps
/// its tab stops, leaders and all).
pub fn merge_ppr_keeping(original: Option<&[u8]>, new: &[u8], keep: &[&str]) -> Vec<u8> {
    let owned = |n: &str| PPR_OWNED.contains(&n) && !keep.contains(&n);
    let Some(orig) = original else {
        return new.to_vec();
    };
    let (Some(old_kids), Some(new_kids)) = (ppr_children(orig), ppr_children(new)) else {
        return new.to_vec();
    };
    let mut kids: Vec<(String, Vec<u8>)> = Vec::new();
    for (name, bytes, _) in &old_kids {
        if !owned(name.as_str()) {
            kids.push((name.clone(), bytes.clone()));
        }
    }
    for (name, bytes, new_attrs) in new_kids.iter().filter(|(n, _, _)| owned(n.as_str())) {
        let merges_attrs = matches!(name.as_str(), "spacing" | "ind");
        let kept: Vec<(String, String)> = old_kids
            .iter()
            .find(|(n, _, _)| merges_attrs && n == name)
            .map(|(_, _, a)| {
                a.iter()
                    .filter(|(k, _)| !owned_attr(name, local(k.as_bytes())))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if kept.is_empty() {
            kids.push((name.clone(), bytes.clone()));
        } else {
            let mut s = format!("<w:{name}");
            for (k, v) in new_attrs.iter().chain(kept.iter()) {
                s.push_str(&format!(" {k}=\"{v}\""));
            }
            s.push_str("/>");
            kids.push((name.clone(), s.into_bytes()));
        }
    }
    // Spacing / indent attributes the original had but the edit no longer
    // sets an owned value for still need their element.
    for (name, _, a) in &old_kids {
        if matches!(name.as_str(), "spacing" | "ind") && !new_kids.iter().any(|(n, _, _)| n == name)
        {
            let kept: Vec<&(String, String)> = a
                .iter()
                .filter(|(k, _)| !owned_attr(name, local(k.as_bytes())))
                .collect();
            if !kept.is_empty() {
                let mut s = format!("<w:{name}");
                for (k, v) in kept {
                    s.push_str(&format!(" {k}=\"{v}\""));
                }
                s.push_str("/>");
                kids.push((name.clone(), s.into_bytes()));
            }
        }
    }
    let rank = |n: &str| {
        PPR_ORDER
            .iter()
            .position(|o| *o == n)
            .unwrap_or(PPR_ORDER.len())
    };
    kids.sort_by_key(|(n, _)| rank(n));
    let mut out = b"<w:pPr>".to_vec();
    for (_, b) in kids {
        out.extend_from_slice(&b);
    }
    out.extend_from_slice(b"</w:pPr>");
    out
}

/// A whole `<w:r>` element: optional `<w:rPr>` + the text. Used by the
/// structural inserts (Increment 2).
pub fn render_run(text: &str, props: &RunProps, rstyle: Option<&str>) -> Vec<u8> {
    let mut out = b"<w:r>".to_vec();
    if props != &RunProps::default() || rstyle.is_some() {
        out.extend_from_slice(&render_rpr(props, rstyle));
    }
    out.extend_from_slice(&render_wt(text));
    out.extend_from_slice(b"</w:r>");
    out
}

/// A whole `<w:p>` element carrying one run, with an optional `<w:pStyle>`.
pub fn render_paragraph(
    text: &str,
    props: &RunProps,
    rstyle: Option<&str>,
    para_style: Option<&str>,
) -> Vec<u8> {
    let mut out = b"<w:p>".to_vec();
    if let Some(ps) = para_style {
        out.extend_from_slice(
            format!("<w:pPr><w:pStyle w:val=\"{}\"/></w:pPr>", escape(ps)).as_bytes(),
        );
    }
    out.extend_from_slice(&render_run(text, props, rstyle));
    out.extend_from_slice(b"</w:p>");
    out
}

/// A whole `<w:tr>` element with one `<w:tc>` per `cells` entry. Each cell holds
/// a single paragraph + run (a `<w:tc>` MUST contain at least one block-level
/// child, so an empty cell still gets a `<w:p>`).
pub fn render_table_row(cells: &[String]) -> Vec<u8> {
    let mut out = b"<w:tr>".to_vec();
    for text in cells {
        out.extend_from_slice(b"<w:tc><w:p>");
        if !text.is_empty() {
            out.extend_from_slice(&render_run(text, &RunProps::default(), None));
        }
        out.extend_from_slice(b"</w:p></w:tc>");
    }
    out.extend_from_slice(b"</w:tr>");
    out
}

/// Emit a boolean toggle property: `Some(true)` ⇒ `<w:NAME/>`, `Some(false)` ⇒
/// `<w:NAME w:val="false"/>`, `None` ⇒ omitted (inherit). Matches the `on()`
/// reading in `docx-import` (absent `w:val` ⇒ true).
/// `CT_RPr`'s children in schema order (the place a new one goes).
const RPR_ORDER: &[&str] = &[
    "rStyle",
    "rFonts",
    "b",
    "bCs",
    "i",
    "iCs",
    "caps",
    "smallCaps",
    "strike",
    "dstrike",
    "outline",
    "shadow",
    "emboss",
    "imprint",
    "noProof",
    "snapToGrid",
    "vanish",
    "webHidden",
    "color",
    "spacing",
    "w",
    "kern",
    "position",
    "sz",
    "szCs",
    "highlight",
    "u",
    "effect",
    "bdr",
    "shd",
    "fitText",
    "vertAlign",
    "rtl",
    "cs",
    "em",
    "lang",
    "eastAsianLayout",
    "specVanish",
    "oMath",
    "rPrChange",
];

/// The `<w:rPr>` children of what differs between two looks: per changed
/// property, its element name and its new element (`None`: the new look
/// does not set it, so the element goes).
fn changed_elements(from: &RunFormat, to: &RunFormat) -> Vec<(&'static str, Option<String>)> {
    let mut out: Vec<(&'static str, Option<String>)> = Vec::new();
    let one = |props: &RunProps, rstyle: Option<&str>| -> Option<String> {
        let bytes = render_rpr(props, rstyle);
        let s = String::from_utf8(bytes).unwrap_or_default();
        let inner = s
            .strip_prefix("<w:rPr>")
            .and_then(|r| r.strip_suffix("</w:rPr>"))
            .unwrap_or("");
        (!inner.is_empty()).then(|| inner.to_string())
    };
    let (a, b) = (&from.props, &to.props);
    if from.rstyle != to.rstyle {
        out.push(("rStyle", one(&RunProps::default(), to.rstyle.as_deref())));
    }
    macro_rules! field {
        ($f:ident, $name:literal) => {
            if a.$f != b.$f {
                let props = RunProps {
                    $f: b.$f.clone(),
                    ..RunProps::default()
                };
                out.push(($name, one(&props, None)));
            }
        };
    }
    if (
        &a.font,
        &a.font_theme,
        &a.font_east_asia,
        &a.font_cs,
        &a.font_hint,
    ) != (
        &b.font,
        &b.font_theme,
        &b.font_east_asia,
        &b.font_cs,
        &b.font_hint,
    ) {
        let props = RunProps {
            font: b.font.clone(),
            font_theme: b.font_theme.clone(),
            font_east_asia: b.font_east_asia.clone(),
            font_cs: b.font_cs.clone(),
            font_hint: b.font_hint.clone(),
            ..RunProps::default()
        };
        out.push(("rFonts", one(&props, None)));
    }
    field!(bold, "b");
    field!(bold_cs, "bCs");
    field!(italic, "i");
    field!(italic_cs, "iCs");
    field!(size_cs_half_pts, "szCs");
    field!(rtl, "rtl");
    field!(complex_script, "cs");
    field!(caps, "caps");
    field!(small_caps, "smallCaps");
    field!(strike, "strike");
    if (&a.color, &a.theme_color) != (&b.color, &b.theme_color) {
        let props = RunProps {
            color: b.color.clone(),
            theme_color: b.theme_color.clone(),
            ..RunProps::default()
        };
        out.push(("color", one(&props, None)));
    }
    field!(spacing_twips, "spacing");
    field!(baseline_half_pts, "position");
    field!(size_half_pts, "sz");
    field!(underline, "u");
    field!(vert_align, "vertAlign");
    out
}

/// A run's `<w:rPr>` with only what differs between its look `from` and
/// the look `to` rewritten: each changed property's element replaced (or
/// added at its schema place, or removed when `to` does not set it), every
/// other child — and the element's own tag — byte for byte. `original` is
/// the run's `<w:rPr>` element (`None`: it has none). `None` when nothing
/// differs, so the run keeps what it has.
pub fn merge_rpr(original: Option<&[u8]>, from: &RunFormat, to: &RunFormat) -> Option<Vec<u8>> {
    use quick_xml::events::Event;
    use quick_xml::Reader;
    let changed = changed_elements(from, to);
    if changed.is_empty() {
        return None;
    }
    let rank = |n: &[u8]| RPR_ORDER.iter().position(|o| o.as_bytes() == n);
    // The original's open and close tags and its children, as bytes.
    let (mut open, mut close) = (b"<w:rPr>".to_vec(), b"</w:rPr>".to_vec());
    let mut kids: Vec<(Vec<u8>, &[u8])> = Vec::new();
    if let Some(src) = original {
        let mut r = Reader::from_reader(src);
        r.config_mut().trim_text(false);
        let mut depth = 0usize;
        loop {
            let start = r.buffer_position() as usize;
            match r.read_event() {
                Ok(Event::Start(e)) if depth == 0 => {
                    open = src[start..r.buffer_position() as usize].to_vec();
                    close =
                        format!("</{}>", String::from_utf8_lossy(e.name().as_ref())).into_bytes();
                    depth = 1;
                }
                Ok(Event::Empty(e)) if depth == 0 => {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    let tag = &src[start..r.buffer_position() as usize];
                    let tag = tag.strip_suffix(b"/>").unwrap_or(tag);
                    let mut o = tag.strip_suffix(b" ").unwrap_or(tag).to_vec();
                    o.push(b'>');
                    open = o;
                    close = format!("</{name}>").into_bytes();
                    break;
                }
                Ok(Event::Start(e)) => {
                    let name = e.name().as_ref().to_vec();
                    let _ = r.read_to_end(quick_xml::name::QName(&name));
                    let ln = paged_ooxml::xml::local_name(&name).to_vec();
                    kids.push((ln, &src[start..r.buffer_position() as usize]));
                }
                Ok(Event::Empty(e)) => {
                    let ln = paged_ooxml::xml::local_name(e.name().as_ref()).to_vec();
                    kids.push((ln, &src[start..r.buffer_position() as usize]));
                }
                Ok(Event::End(_)) | Ok(Event::Eof) | Err(_) => break,
                Ok(_) => {}
            }
        }
    }
    let gone = |n: &[u8]| changed.iter().any(|(c, _)| c.as_bytes() == n);
    let mut fresh: Vec<(usize, String)> = changed
        .iter()
        .filter_map(|(name, el)| Some((rank(name.as_bytes())?, el.clone()?)))
        .collect();
    fresh.sort_by_key(|(r, _)| *r);
    let mut fresh = fresh.into_iter().peekable();
    let mut out = open;
    for (ln, bytes) in kids.iter().filter(|(ln, _)| !gone(ln)) {
        if let Some(r) = rank(ln) {
            while let Some((_, el)) = fresh.next_if(|(fr, _)| *fr < r) {
                out.extend_from_slice(el.as_bytes());
            }
        }
        out.extend_from_slice(bytes);
    }
    for (_, el) in fresh {
        out.extend_from_slice(el.as_bytes());
    }
    out.extend_from_slice(&close);
    Some(out)
}

fn toggle(s: &mut String, name: &str, v: Option<bool>) {
    match v {
        Some(true) => s.push_str(&format!("<w:{name}/>")),
        Some(false) => s.push_str(&format!("<w:{name} w:val=\"false\"/>")),
        None => {}
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn merge_ppr_keeps_what_the_edit_does_not_own() {
        let orig = br#"<w:pPr><w:pStyle w:val="Body"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr><w:spacing w:before="120" w:line="360" w:lineRule="auto"/><w:jc w:val="left"/><w:rPr><w:b/></w:rPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>"#;
        let props = ParaProps {
            space_before: Some(240),
            justification: Some(Justification::Center),
            ..Default::default()
        };
        let new = render_ppr(&props, Some("Body"));
        let merged = String::from_utf8(merge_ppr(Some(orig), &new)).unwrap();
        assert_eq!(
            merged,
            r#"<w:pPr><w:pStyle w:val="Body"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr><w:spacing w:before="240" w:line="360" w:lineRule="auto"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>"#
        );
    }

    #[test]
    fn merge_ppr_drops_an_owned_child_the_edit_removed_but_keeps_line_spacing() {
        let orig = br#"<w:pPr><w:keepNext/><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr>"#;
        let new = render_ppr(&ParaProps::default(), None);
        let merged = String::from_utf8(merge_ppr(Some(orig), &new)).unwrap();
        assert_eq!(
            merged,
            r#"<w:pPr><w:spacing w:line="276" w:lineRule="auto"/></w:pPr>"#
        );
    }

    #[test]
    fn merge_ppr_without_an_original_is_the_rendered_ppr() {
        let new = render_ppr(&ParaProps::default(), Some("Heading1"));
        assert_eq!(merge_ppr(None, &new), new);
    }

    use super::*;

    fn look(f: impl FnOnce(&mut RunProps)) -> RunFormat {
        let mut props = RunProps::default();
        f(&mut props);
        RunFormat {
            props,
            rstyle: None,
        }
    }

    #[test]
    fn merge_rewrites_only_what_changed_and_keeps_the_rest() {
        let src = br#"<w:rPr w:rsidR="1"><w:rFonts w:ascii="A" w:eastAsia="B"/><w:sz w:val="20"/><w:lang w:val="de-AT"/></w:rPr>"#;
        let from = look(|p| {
            p.font = Some("A".into());
            p.size_half_pts = Some(20);
        });
        // Bold added: placed after rFonts, everything else verbatim.
        let mut to = from.clone();
        to.props.bold = Some(true);
        let out = String::from_utf8(merge_rpr(Some(src), &from, &to).unwrap()).unwrap();
        assert_eq!(
            out,
            r#"<w:rPr w:rsidR="1"><w:rFonts w:ascii="A" w:eastAsia="B"/><w:b/><w:sz w:val="20"/><w:lang w:val="de-AT"/></w:rPr>"#
        );
        // Size changed, a style set: replaced in place, rStyle first.
        let mut to = from.clone();
        to.props.size_half_pts = Some(28);
        to.rstyle = Some("Strong".into());
        let out = String::from_utf8(merge_rpr(Some(src), &from, &to).unwrap()).unwrap();
        assert_eq!(
            out,
            r#"<w:rPr w:rsidR="1"><w:rStyle w:val="Strong"/><w:rFonts w:ascii="A" w:eastAsia="B"/><w:sz w:val="28"/><w:lang w:val="de-AT"/></w:rPr>"#
        );
        // A property the new look does not set goes; nothing else does.
        let mut to = from.clone();
        to.props.size_half_pts = None;
        let out = String::from_utf8(merge_rpr(Some(src), &from, &to).unwrap()).unwrap();
        assert!(!out.contains("w:sz"), "{out}");
        assert!(out.contains("w:lang"), "{out}");
        // No change: nothing to write.
        assert!(merge_rpr(Some(src), &from, &from).is_none());
        // A run with no rPr gets one with just the change.
        let out = merge_rpr(
            None,
            &RunFormat::default(),
            &look(|p| p.italic = Some(true)),
        )
        .unwrap();
        assert_eq!(out, b"<w:rPr><w:i/></w:rPr>");
        // An empty `<w:rPr/>` opens under its own name.
        let out = merge_rpr(
            Some(b"<w:rPr/>"),
            &RunFormat::default(),
            &look(|p| p.bold = Some(true)),
        )
        .unwrap();
        assert_eq!(out, b"<w:rPr><w:b/></w:rPr>");
    }

    #[test]
    fn wt_line_breaks_become_w_br() {
        assert_eq!(
            String::from_utf8(render_wt("a\u{2028}b")).unwrap(),
            "<w:t xml:space=\"preserve\">a</w:t><w:br/><w:t xml:space=\"preserve\">b</w:t>"
        );
        assert_eq!(
            String::from_utf8(render_wt("a\u{2028}\u{2028}")).unwrap(),
            "<w:t xml:space=\"preserve\">a</w:t><w:br/><w:br/>"
        );
        assert_eq!(String::from_utf8(render_wt("\u{2028}")).unwrap(), "<w:br/>");
        let mut cr = RunSpecials::default();
        cr.push(LINE_BREAK, SpecialSource::Element(b"<w:cr/>"));
        assert_eq!(
            String::from_utf8(render_text("x\u{2028}y\u{2028}z", &cr)).unwrap(),
            "<w:t xml:space=\"preserve\">x</w:t><w:cr/><w:t xml:space=\"preserve\">y</w:t><w:br/><w:t xml:space=\"preserve\">z</w:t>"
        );
    }

    #[test]
    #[allow(non_snake_case)] // `…__feat__<id>` links the cockpit feature
    fn soft_hyphens_and_symbols_take_their_source_form__feat__plugin_doc_save_back() {
        // A new soft hyphen is Word's element; a new symbol character is text.
        assert_eq!(
            String::from_utf8(render_wt("a\u{00AD}b\u{2022}")).unwrap(),
            "<w:t xml:space=\"preserve\">a</w:t><w:softHyphen/>\
             <w:t xml:space=\"preserve\">b\u{2022}</w:t>"
        );
        // The source wrote a literal bullet, then a <w:sym> bullet: the k-th
        // bullet of the edit takes the k-th one's form, a third is text.
        let sym: &[u8] = b"<w:sym w:font=\"Symbol\" w:char=\"F0B7\"/>";
        let mut o = RunSpecials::default();
        o.push('\u{2022}', SpecialSource::Literal);
        o.push('\u{2022}', SpecialSource::Element(sym));
        assert_eq!(
            String::from_utf8(render_text("\u{2022}x\u{2022}y\u{2022}", &o)).unwrap(),
            "<w:t xml:space=\"preserve\">\u{2022}x</w:t><w:sym w:font=\"Symbol\" w:char=\"F0B7\"/>\
             <w:t xml:space=\"preserve\">y\u{2022}</w:t>"
        );
    }

    #[test]
    fn wt_tabs_and_no_break_hyphens_become_elements() {
        assert_eq!(
            String::from_utf8(render_wt("a\tb\u{2011}c")).unwrap(),
            "<w:t xml:space=\"preserve\">a</w:t><w:tab/><w:t xml:space=\"preserve\">b</w:t>\
             <w:noBreakHyphen/><w:t xml:space=\"preserve\">c</w:t>"
        );
        assert_eq!(String::from_utf8(render_wt("\t")).unwrap(), "<w:tab/>");
        assert_eq!(
            String::from_utf8(render_wt("")).unwrap(),
            "<w:t xml:space=\"preserve\"></w:t>"
        );
        // Per kind, in order: the first tab was literal in the source, the
        // second an element; a third is new.
        let mut o = RunSpecials::default();
        o.push('\t', SpecialSource::Literal);
        o.push('\t', SpecialSource::Element(b"<w:tab/>"));
        o.push(
            LINE_BREAK,
            SpecialSource::Element(b"<w:br w:clear=\"all\"/>"),
        );
        assert_eq!(
            String::from_utf8(render_text("a\tb\u{2028}c\td\te", &o)).unwrap(),
            "<w:t xml:space=\"preserve\">a\tb</w:t><w:br w:clear=\"all\"/>\
             <w:t xml:space=\"preserve\">c</w:t><w:tab/><w:t xml:space=\"preserve\">d</w:t>\
             <w:tab/><w:t xml:space=\"preserve\">e</w:t>"
        );
    }

    #[test]
    fn wt_preserves_space_and_escapes() {
        assert_eq!(
            render_wt(" a & b "),
            b"<w:t xml:space=\"preserve\"> a &amp; b </w:t>"
        );
    }

    #[test]
    fn rpr_bold_off_keeps_only_color() {
        // The slice's edit: bold toggled off, color kept.
        let props = RunProps {
            color: Some("FF0000".into()),
            ..Default::default()
        };
        assert_eq!(
            render_rpr(&props, None),
            b"<w:rPr><w:color w:val=\"FF0000\"/></w:rPr>".to_vec()
        );
    }

    #[test]
    fn rpr_child_order_and_toggles() {
        let props = RunProps {
            bold: Some(true),
            italic: Some(false),
            size_half_pts: Some(24),
            underline: Some(true),
            ..Default::default()
        };
        assert_eq!(
            String::from_utf8(render_rpr(&props, Some("Emphasis"))).unwrap(),
            "<w:rPr><w:rStyle w:val=\"Emphasis\"/><w:b/><w:i w:val=\"false\"/>\
             <w:sz w:val=\"24\"/><w:u w:val=\"single\"/></w:rPr>"
        );
    }
}
