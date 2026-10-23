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

//! `sharedStrings.xml` — the shared-string table (ECMA-376 §18.4).
//!
//! Each `<si>` is either a plain `<t>` or a rich-text sequence of `<r>` runs
//! each with its own `<t>`. For the *model* we concatenate run text into a
//! single string (the calc/format layers never need run formatting). The
//! *original bytes* are preserved by the lazy-verbatim mechanism — an
//! un-dirty sharedStrings part re-emits verbatim, so rich-text runs survive
//! a round-trip losslessly even though the model holds only their text.
//!
//! The parsed strings are returned as a positional `Vec`; the worksheet
//! parser indexes into it for `t="s"` cells, and they are interned into
//! `SheetModel::strings` so the rest of the engine deals only in ids.

use crate::error::XlsxError;
use compact_str::CompactString;

/// Parse `sharedStrings.xml` into the positional list of (concatenated)
/// string values. Index N corresponds to `<si>` number N (the value a
/// `t="s"` cell's `<v>` refers to).
pub fn parse(xml: &[u8]) -> Result<Vec<CompactString>, XlsxError> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut out: Vec<CompactString> = Vec::new();
    let mut buf = Vec::new();

    // State while inside an <si>: we accumulate every <t>'s text. <t> may
    // appear directly (plain) or nested in <r> runs (rich text); either way
    // we concatenate. `<rPh>` (phonetic) text is skipped — it is not part of
    // the displayed string.
    let mut in_si = false;
    let mut in_t = false;
    let mut in_rph = false;
    let mut cur = String::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => match e.local_name().as_ref() {
                b"si" => {
                    in_si = true;
                    cur.clear();
                }
                b"rPh" => in_rph = true,
                b"t" if in_si && !in_rph => in_t = true,
                _ => {}
            },
            Event::End(e) => match e.local_name().as_ref() {
                b"si" => {
                    in_si = false;
                    out.push(CompactString::new(&cur));
                }
                b"rPh" => in_rph = false,
                b"t" => in_t = false,
                _ => {}
            },
            Event::Text(t) if in_t => {
                let s = t.xml10_content()?;
                cur.push_str(&s);
            }
            // 0.38+: `&…;` in element content arrives as its own event.
            Event::GeneralRef(r) if in_t => {
                cur.push_str(&crate::opc::general_ref(&r)?);
            }
            Event::CData(c) if in_t => {
                cur.push_str(&String::from_utf8_lossy(&c.into_inner()));
            }
            // An empty <si/> or empty <t/> contributes the empty string.
            Event::Empty(e) if e.local_name().as_ref() == b"si" => {
                out.push(CompactString::default());
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// One run of a rich-text string: its text and its run properties, kept as
/// the `<rPr>` element's bytes (Paged does not interpret them).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct RichRun {
    pub text: String,
    /// The raw `<rPr>…</rPr>`, or `None` for a run without properties.
    pub rpr: Option<String>,
}

/// A shared string as the workbook stores it: plain text is one run without
/// properties (W1.4 rich-text model).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct RichText {
    pub runs: Vec<RichRun>,
}

impl RichText {
    /// Plain text: one run, no properties.
    pub fn plain(text: &str) -> RichText {
        RichText {
            runs: vec![RichRun {
                text: text.to_string(),
                rpr: None,
            }],
        }
    }

    /// The displayed text (the runs concatenated).
    pub fn text(&self) -> String {
        self.runs.iter().map(|r| r.text.as_str()).collect()
    }

    /// True when every run is plain (no run properties).
    pub fn is_plain(&self) -> bool {
        self.runs.iter().all(|r| r.rpr.is_none())
    }

    /// The `<si>` element for this string (`prefix` is the part's namespace
    /// prefix, usually empty).
    pub fn to_si(&self, prefix: &str) -> String {
        use paged_ooxml::xml::escape_text;
        let t = |text: &str| {
            let space =
                if text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace) {
                    r#" xml:space="preserve""#
                } else {
                    ""
                };
            format!("<{prefix}t{space}>{}</{prefix}t>", escape_text(text))
        };
        let mut s = format!("<{prefix}si>");
        if self.is_plain() {
            s.push_str(&t(&self.text()));
        } else {
            for r in &self.runs {
                s.push_str(&format!("<{prefix}r>"));
                if let Some(rpr) = &r.rpr {
                    s.push_str(rpr);
                }
                s.push_str(&t(&r.text));
                s.push_str(&format!("</{prefix}r>"));
            }
        }
        s.push_str(&format!("</{prefix}si>"));
        s
    }
}

/// The `<si>` number `index` of a sharedStrings part as a [`RichText`]
/// (phonetic runs left out). `None` when there is no such entry.
pub fn rich_text_at(xml: &[u8], index: usize) -> Result<Option<RichText>, XlsxError> {
    use crate::splice::root_children;
    let (kids, _) = root_children(xml)?;
    let Some(si) = kids.iter().filter(|k| k.local == "si").nth(index) else {
        return Ok(None);
    };
    rich_text_of(xml, si).map(Some)
}

/// The runs of one `<si>` span.
fn rich_text_of(xml: &[u8], si: &crate::splice::Span) -> Result<RichText, XlsxError> {
    use crate::splice::children_of;
    let text_of = |span: &crate::splice::Span| -> String {
        let all = parse(
            &[
                b"<sst><si>".as_slice(),
                &xml[span.start..span.end],
                b"</si></sst>",
            ]
            .concat(),
        )
        .ok()
        .and_then(|v| v.into_iter().next())
        .unwrap_or_default();
        all.to_string()
    };
    let (parts, _) = children_of(xml, si)?;
    let mut out = RichText::default();
    for p in &parts {
        match p.local.as_str() {
            "t" => out.runs.push(RichRun {
                text: text_of(p),
                rpr: None,
            }),
            "r" => {
                let (rk, _) = children_of(xml, p)?;
                let rpr = rk
                    .iter()
                    .find(|k| k.local == "rPr")
                    .map(|k| String::from_utf8_lossy(&xml[k.start..k.end]).into_owned());
                let text = rk
                    .iter()
                    .filter(|k| k.local == "t")
                    .map(&text_of)
                    .collect::<String>();
                out.runs.push(RichRun { text, rpr });
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Every shared string with formatted runs (a run carrying `<rPr>`), by
/// index — one pass over the part (W2.2: what a rich-text cell renders).
pub fn rich_strings(xml: &[u8]) -> Result<std::collections::BTreeMap<u32, RichText>, XlsxError> {
    use crate::splice::root_children;
    let (kids, _) = root_children(xml)?;
    let mut out = std::collections::BTreeMap::new();
    for (i, si) in kids.iter().filter(|k| k.local == "si").enumerate() {
        let bytes = &xml[si.start..si.end];
        if !bytes.windows(3).any(|w| w == b"rPr") {
            continue;
        }
        let rich = rich_text_of(xml, si)?;
        if rich.runs.iter().any(|r| r.rpr.is_some()) {
            out.insert(i as u32, rich);
        }
    }
    Ok(out)
}

/// `xml` with `si` appended as the last `<si>` and the root's `count` /
/// `uniqueCount` raised by one. Existing indexes keep their meaning.
pub fn append_si(xml: &[u8], si: &RichText) -> Result<(Vec<u8>, usize), XlsxError> {
    use crate::splice::{attr_local, attrs_of, render_tag, root_children, set_attr, splice, Span};
    let (kids, close) = root_children(xml)?;
    let index = kids.iter().filter(|k| k.local == "si").count();
    // The root element's span: from its start tag to the end.
    let root_start = {
        let mut i = 0;
        loop {
            let at = xml[i..]
                .iter()
                .position(|&b| b == b'<')
                .map(|p| p + i)
                .ok_or_else(|| XlsxError::Structure("sharedStrings has no root".into()))?;
            if !matches!(xml.get(at + 1), Some(b'?' | b'!')) {
                break at;
            }
            i = at + 1;
        }
    };
    let tag_end = xml[root_start..]
        .iter()
        .position(|&b| b == b'>')
        .map(|p| root_start + p + 1)
        .ok_or_else(|| XlsxError::Structure("sharedStrings root tag".into()))?;
    let qname: String = String::from_utf8_lossy(&xml[root_start + 1..tag_end])
        .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .next()
        .unwrap_or("sst")
        .to_string();
    let prefix = crate::splice::prefix_of(&qname).to_string();
    let root = Span {
        local: "sst".into(),
        qname: qname.clone(),
        start: root_start,
        tag_end,
        end: xml.len(),
        empty: xml[tag_end - 2] == b'/',
    };
    if root.empty {
        return Err(XlsxError::Structure(
            "empty <sst/> cannot take an entry".into(),
        ));
    }
    let out = splice(xml, close, close, si.to_si(&prefix).as_bytes());
    let mut a = attrs_of(&out, &root)?;
    for key in ["count", "uniqueCount"] {
        if let Some(n) = attr_local(&a, key).and_then(|v| v.parse::<u64>().ok()) {
            set_attr(&mut a, key, Some((n + 1).to_string()));
        }
    }
    let out = splice(
        &out,
        root.start,
        root.tag_end,
        render_tag(&qname, &a, false).as_bytes(),
    );
    Ok((out, index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(non_snake_case)]
    fn rich_runs_read_and_append_without_renumbering__feat__sheet_xlsx_roundtrip() {
        let xml = br#"<?xml version="1.0"?>
<sst xmlns="urn:m" count="2" uniqueCount="2"><si><t>a</t></si><si><r><rPr><b/></rPr><t xml:space="preserve">Bold </t></r><r><t>x</t></r></si></sst>"#;
        let rich = rich_text_at(xml, 1).unwrap().unwrap();
        assert_eq!(rich.text(), "Bold x");
        assert_eq!(rich.runs[0].rpr.as_deref(), Some("<rPr><b/></rPr>"));
        assert!(rich_text_at(xml, 2).unwrap().is_none());
        let (out, i) = append_si(xml, &rich).unwrap();
        assert_eq!(i, 2);
        let s = String::from_utf8(out.clone()).unwrap();
        assert!(s.contains(r#"count="3" uniqueCount="3""#), "{s}");
        assert!(s.ends_with(
            r#"<si><r><rPr><b/></rPr><t xml:space="preserve">Bold </t></r><r><t>x</t></r></si></sst>"#
        ));
        let all = parse(&out).unwrap();
        assert_eq!((all[0].as_str(), all[2].as_str()), ("a", "Bold x"));
        assert_eq!(rich_text_at(&out, 2).unwrap().unwrap(), rich);
    }

    #[test]
    fn plain_and_rich_text() {
        let xml = br#"<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Hello</t></si>
  <si><r><t>Rich </t></r><r><t>Text</t></r></si>
  <si><t xml:space="preserve"> spaced </t></si>
</sst>"#;
        let s = parse(xml).unwrap();
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].as_str(), "Hello");
        assert_eq!(s[1].as_str(), "Rich Text");
        assert_eq!(s[2].as_str(), " spaced ");
    }

    #[test]
    fn entities_and_phonetic_skipped() {
        let xml = br#"<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>a &amp; b</t></si>
  <si><t>kanji</t><rPh sb="0" eb="1"><t> romaji</t></rPh></si>
</sst>"#;
        let s = parse(xml).unwrap();
        assert_eq!(s[0].as_str(), "a & b");
        // phonetic run text is NOT part of the displayed string
        assert_eq!(s[1].as_str(), "kanji");
    }
}
