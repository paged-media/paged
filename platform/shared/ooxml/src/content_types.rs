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

//! `[Content_Types].xml` — the OPC content-type table.
//!
//! Extension defaults + per-part overrides, in document order, so a writer
//! can re-serialize the table identically when nothing changed and minimally
//! when one override goes (paged.sheet drops `calcChain.xml`'s). Untouched,
//! the part re-emits verbatim.

use crate::error::{FromXmlError, XmlError};
use crate::xml::{attr_as, escape_attr};

/// The reserved OPC part name of the content-type table.
pub const CONTENT_TYPES_PART: &str = "[Content_Types].xml";

/// Parsed `[Content_Types].xml`: extension defaults + per-part overrides.
#[derive(Debug, Clone, Default)]
pub struct ContentTypes {
    /// `<Default Extension=".." ContentType="..">` in document order.
    pub defaults: Vec<(String, String)>,
    /// `<Override PartName="/.." ContentType="..">` in document order.
    pub overrides: Vec<(String, String)>,
}

impl ContentTypes {
    /// Parse the content-type table. Only `Default`/`Override` elements matter;
    /// anything else is ignored. Malformed XML is an error, never a panic.
    pub fn parse(xml: &[u8]) -> Result<ContentTypes, XmlError> {
        Self::parse_as(xml)
    }

    /// [`parse`](Self::parse) reporting in the caller's own error type (see
    /// [`crate::xml::attr_as`]).
    pub fn parse_as<E: FromXmlError>(xml: &[u8]) -> Result<ContentTypes, E> {
        use quick_xml::events::Event;
        let mut reader = quick_xml::Reader::from_reader(xml);
        reader.config_mut().trim_text(false);
        let mut ct = ContentTypes::default();
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf)? {
                Event::Empty(e) | Event::Start(e) => match e.local_name().as_ref() {
                    b"Default" => {
                        if let (Some(ext), Some(ty)) = (
                            attr_as::<E>(&e, b"Extension")?,
                            attr_as::<E>(&e, b"ContentType")?,
                        ) {
                            ct.defaults.push((ext, ty));
                        }
                    }
                    b"Override" => {
                        if let (Some(pn), Some(ty)) = (
                            attr_as::<E>(&e, b"PartName")?,
                            attr_as::<E>(&e, b"ContentType")?,
                        ) {
                            ct.overrides.push((pn, ty));
                        }
                    }
                    _ => {}
                },
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        Ok(ct)
    }

    /// Resolve the content type of a part (leading-slash absolute name, e.g.
    /// `/word/document.xml`): an explicit override wins, else the extension
    /// default, else `None`.
    pub fn content_type_of(&self, absolute_part_name: &str) -> Option<&str> {
        if let Some((_, ty)) = self
            .overrides
            .iter()
            .find(|(pn, _)| pn == absolute_part_name)
        {
            return Some(ty);
        }
        let ext = absolute_part_name.rsplit('.').next()?;
        self.defaults
            .iter()
            .find(|(e, _)| e.eq_ignore_ascii_case(ext))
            .map(|(_, ty)| ty.as_str())
    }

    /// True if an explicit `<Override>` exists for `absolute_part_name`.
    pub fn has_override(&self, absolute_part_name: &str) -> bool {
        self.overrides
            .iter()
            .any(|(pn, _)| pn == absolute_part_name)
    }

    /// A table with no entries (write one with the `add_*` methods and [`render`](Self::render)).
    pub fn new() -> ContentTypes {
        ContentTypes::default()
    }

    /// Add an extension default unless the extension (any case) has one.
    pub fn add_default(&mut self, extension: &str, content_type: &str) {
        let ext = extension.trim_start_matches('.');
        if !self
            .defaults
            .iter()
            .any(|(e, _)| e.eq_ignore_ascii_case(ext))
        {
            self.defaults
                .push((ext.to_string(), content_type.to_string()));
        }
    }

    /// Add a per-part override (absolute name, `/word/document.xml`) unless
    /// the part has one. The first content type given for a part stays.
    pub fn add_override(&mut self, absolute_part_name: &str, content_type: &str) {
        if !self.has_override(absolute_part_name) {
            self.overrides
                .push((absolute_part_name.to_string(), content_type.to_string()));
        }
    }

    /// Drop the override of a part.
    pub fn remove_override(&mut self, absolute_part_name: &str) {
        self.overrides.retain(|(p, _)| p != absolute_part_name);
    }

    /// The whole `[Content_Types].xml`: defaults, then overrides, in order.
    pub fn render(&self) -> String {
        self.render_with_eol("")
    }

    /// [`render`](Self::render) with a line break after the XML declaration, the
    /// layout of packages written before this writer existed (their pinned bytes keep it).
    pub fn render_with_decl_newline(&self) -> String {
        self.render_with_eol("\n")
    }

    fn render_with_eol(&self, eol: &str) -> String {
        let mut out = String::from(XML_DECL);
        out.push_str(eol);
        out.push_str(&format!(r#"<Types xmlns="{NS}">"#));
        for (ext, ct) in &self.defaults {
            out.push_str(&format!(
                r#"<Default Extension="{}" ContentType="{}"/>"#,
                escape_attr(ext),
                escape_attr(ct)
            ));
        }
        for (part, ct) in &self.overrides {
            out.push_str(&format!(
                r#"<Override PartName="{}" ContentType="{}"/>"#,
                escape_attr(part),
                escape_attr(ct)
            ));
        }
        out.push_str("</Types>");
        out
    }
}

/// The XML declaration every part this crate writes starts with.
const XML_DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
/// The content-types namespace.
const NS: &str = "http://schemas.openxmlformats.org/package/2006/content-types";

/// One edit to an existing `[Content_Types].xml`, applied by [`patch`].
#[derive(Debug, Clone, Default)]
pub struct Patch<'a> {
    /// Parts (absolute names) whose `<Override>` goes.
    pub remove_overrides: Vec<&'a str>,
    /// `(absolute part name, content type)` overrides to add (skipped when the part has one).
    pub add_overrides: Vec<(&'a str, &'a str)>,
    /// `(extension, content type)` defaults to add (skipped when the extension has one).
    pub add_defaults: Vec<(&'a str, &'a str)>,
    /// `(absolute part name, content type)` overrides to set: the content type of an
    /// existing override changes in place (its position stays), a missing one is added at the end.
    pub set_overrides: Vec<(&'a str, &'a str)>,
}

/// Edit an existing `[Content_Types].xml` as text: every byte the edit does not
/// touch stays, so a table nobody changed is unchanged and a changed one differs
/// by exactly the tags added or removed. New overrides go before `</Types>`; a
/// new default goes before the first `<Default`, else right after `<Types …>`.
/// Part names compare ignoring case, as OPC part names do.
pub fn patch(xml: &str, edit: &Patch<'_>) -> String {
    let mut out = xml.to_string();
    for part in &edit.remove_overrides {
        while let Some((start, end)) = find_tag(&out, "Override", |t| {
            tag_attr(t, "PartName").is_some_and(|v| v.eq_ignore_ascii_case(part))
        }) {
            out.replace_range(start..end, "");
        }
    }
    for (part, ct) in &edit.set_overrides {
        let tag = format!(
            r#"<Override PartName="{}" ContentType="{}"/>"#,
            escape_attr(part),
            escape_attr(ct)
        );
        let found = find_tag(&out, "Override", |t| {
            tag_attr(t, "PartName").is_some_and(|v| v.eq_ignore_ascii_case(part))
        });
        match found {
            Some((start, end)) => out.replace_range(start..end, &tag),
            None => insert_child(&mut out, &tag, Where::AtEnd),
        }
    }
    for (ext, ct) in &edit.add_defaults {
        let ext = ext.trim_start_matches('.');
        if find_tag(&out, "Default", |t| {
            tag_attr(t, "Extension").is_some_and(|v| v.eq_ignore_ascii_case(ext))
        })
        .is_some()
        {
            continue;
        }
        let tag = format!(
            r#"<Default Extension="{}" ContentType="{}"/>"#,
            escape_attr(ext),
            escape_attr(ct)
        );
        insert_child(&mut out, &tag, Where::BeforeFirst("Default"));
    }
    let mut adds = String::new();
    for (part, ct) in &edit.add_overrides {
        let has = find_tag(&out, "Override", |t| {
            tag_attr(t, "PartName").is_some_and(|v| v.eq_ignore_ascii_case(part))
        })
        .is_some();
        if !has && !adds.contains(&format!(r#"PartName="{}""#, escape_attr(part))) {
            adds.push_str(&format!(
                r#"<Override PartName="{}" ContentType="{}"/>"#,
                escape_attr(part),
                escape_attr(ct)
            ));
        }
    }
    if !adds.is_empty() {
        insert_child(&mut out, &adds, Where::AtEnd);
    }
    out
}

enum Where {
    BeforeFirst(&'static str),
    AtEnd,
}

/// Insert `tags` among the children of the root `<Types>`.
fn insert_child(xml: &mut String, tags: &str, at: Where) {
    if let Where::BeforeFirst(name) = at {
        if let Some((start, _)) = find_tag(xml, name, |_| true) {
            xml.insert_str(start, tags);
            return;
        }
    }
    if let Some(close) = xml.rfind("</Types>") {
        // `AtEnd`, or a table with no default yet: a default still belongs first.
        match at {
            Where::AtEnd => xml.insert_str(close, tags),
            Where::BeforeFirst(_) => {
                if let Some(open_end) = xml
                    .find("<Types")
                    .and_then(|i| xml[i..].find('>').map(|j| i + j + 1))
                {
                    xml.insert_str(open_end, tags);
                } else {
                    xml.insert_str(close, tags);
                }
            }
        }
    } else if let Some(i) = xml.rfind("/>") {
        // `<Types …/>`: no children yet; open it.
        let open = xml[..i].trim_end().to_string();
        *xml = format!("{open}>{tags}</Types>");
    }
}

/// The `[start, end)` span of the first `<name …>` tag (self-closed, or with its
/// closing `</name>`) that `keep` accepts; `keep` sees the opening tag's text.
pub(crate) fn find_tag(
    xml: &str,
    name: &str,
    keep: impl Fn(&str) -> bool,
) -> Option<(usize, usize)> {
    let open = format!("<{name}");
    let mut from = 0;
    while let Some(i) = xml[from..].find(&open).map(|i| i + from) {
        let after = i + open.len();
        // `<Default` must not match `<DefaultFoo`.
        if !xml[after..].starts_with(|c: char| c.is_ascii_whitespace() || c == '/' || c == '>') {
            from = after;
            continue;
        }
        let gt = xml[after..].find('>').map(|j| j + after)?;
        let tag = &xml[i..=gt];
        if keep(tag) {
            if tag.ends_with("/>") {
                return Some((i, gt + 1));
            }
            let close = format!("</{name}>");
            let end = xml[gt..]
                .find(&close)
                .map(|j| gt + j + close.len())
                .unwrap_or(gt + 1);
            return Some((i, end));
        }
        from = gt + 1;
    }
    None
}

/// An attribute of an opening tag's text, either quote style, unescaped.
pub(crate) fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut from = 0;
    while let Some(i) = tag[from..].find(name).map(|i| i + from) {
        let after = i + name.len();
        let before_ok = i > 0 && bytes[i - 1].is_ascii_whitespace();
        let rest = tag[after..].trim_start();
        if before_ok && rest.starts_with('=') {
            let v = rest[1..].trim_start();
            let quote = v.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            let body = &v[1..];
            let end = body.find(quote)?;
            return Some(crate::xml::unescape(&body[..end]));
        }
        from = after;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_defaults_and_overrides_and_resolves() {
        let xml = br#"<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;
        let ct = ContentTypes::parse(xml).unwrap();
        assert_eq!(ct.defaults.len(), 2);
        assert_eq!(ct.overrides.len(), 1);
        assert!(ct.has_override("/word/document.xml"));
        assert!(ct
            .content_type_of("/word/document.xml")
            .unwrap()
            .contains("wordprocessingml.document.main"));
        // resolves by extension default when no override
        assert!(ct
            .content_type_of("/word/_rels/document.xml.rels")
            .is_some());
    }

    #[test]
    fn keeps_document_order_for_a_minimal_rewrite() {
        let xml = br#"<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>
</Types>"#;
        let ct = ContentTypes::parse(xml).unwrap();
        assert_eq!(ct.defaults.len(), 2);
        assert_eq!(ct.defaults[0].0, "rels");
        assert_eq!(ct.overrides.len(), 2);
        assert!(ct.has_override("/xl/calcChain.xml"));
        assert!(!ct.has_override("/xl/sharedStrings.xml"));
    }

    #[test]
    fn tolerates_garbage_without_panicking() {
        assert!(
            ContentTypes::parse(b"not xml at all <<<").is_ok()
                || ContentTypes::parse(b"<<<").is_err()
        );
    }

    const TABLE: &str = r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="r"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/a.xml" ContentType="A"/><Override ContentType='B' PartName='/B.xml'></Override></Types>"#;

    #[test]
    fn a_model_writes_and_reads_back() {
        let mut t = ContentTypes::new();
        t.add_default(".png", "image/png");
        t.add_default("PNG", "image/other"); // the extension has one, any case
        t.add_override("/word/document.xml", "main");
        t.add_override("/word/document.xml", "other"); // first stays
        let back = ContentTypes::parse(t.render().as_bytes()).unwrap();
        assert_eq!(back.defaults, vec![("png".into(), "image/png".into())]);
        assert_eq!(
            back.overrides,
            vec![("/word/document.xml".into(), "main".into())]
        );
        t.remove_override("/word/document.xml");
        assert!(!t.has_override("/word/document.xml"));
    }

    #[test]
    fn render_with_decl_newline_only_adds_the_line_break() {
        let mut t = ContentTypes::new();
        t.add_default("xml", "application/xml");
        t.add_override("/a.xml", "A");
        let plain = t.render();
        assert_eq!(
            t.render_with_decl_newline(),
            plain.replacen("?>", "?>\n", 1)
        );
    }

    #[test]
    fn a_patch_changes_only_the_tags_it_names() {
        let out = patch(
            TABLE,
            &Patch {
                remove_overrides: vec!["/b.xml"], // case-insensitive, single quotes, paired close
                add_overrides: vec![("/a.xml", "dup"), ("/c.xml", "C&D")],
                add_defaults: vec![("png", "image/png"), ("XML", "dup")],
                ..Patch::default()
            },
        );
        let t = ContentTypes::parse(out.as_bytes()).unwrap();
        assert!(!t.has_override("/B.xml"));
        assert_eq!(t.content_type_of("/a.xml"), Some("A")); // not duplicated
        assert_eq!(t.content_type_of("/c.xml"), Some("C&D")); // escaped and read back
        assert_eq!(t.defaults.iter().filter(|(e, _)| e == "png").count(), 1);
        assert_eq!(
            t.defaults
                .iter()
                .filter(|(e, _)| e.eq_ignore_ascii_case("xml"))
                .count(),
            1
        );
        // New default before the first `<Default`; everything else in place.
        assert!(out.contains(
            r#"<Default Extension="png" ContentType="image/png"/><Default Extension="rels""#
        ));
        assert!(out.starts_with(r#"<?xml version="1.0"?><Types"#));
        assert!(out.ends_with(r#"<Override PartName="/c.xml" ContentType="C&amp;D"/></Types>"#));
    }

    #[test]
    fn set_overrides_replace_in_place_or_append() {
        let out = patch(
            TABLE,
            &Patch {
                set_overrides: vec![("/a.xml", "A2"), ("/new.xml", "N")],
                ..Patch::default()
            },
        );
        let t = ContentTypes::parse(out.as_bytes()).unwrap();
        assert_eq!(t.content_type_of("/a.xml"), Some("A2"));
        assert_eq!(t.content_type_of("/new.xml"), Some("N"));
        assert_eq!(t.overrides.len(), TABLE.matches("<Override").count() + 1);
        assert!(out.ends_with(r#"<Override PartName="/new.xml" ContentType="N"/></Types>"#));
        // Setting what is there leaves the order alone.
        let again = patch(
            &out,
            &Patch {
                set_overrides: vec![("/a.xml", "A2")],
                ..Patch::default()
            },
        );
        assert_eq!(
            ContentTypes::parse(again.as_bytes()).unwrap().overrides,
            t.overrides
        );
    }

    #[test]
    fn an_empty_patch_is_the_identity_and_a_bare_root_opens() {
        assert_eq!(patch(TABLE, &Patch::default()), TABLE);
        let bare = r#"<Types xmlns="x"/>"#;
        let out = patch(
            bare,
            &Patch {
                add_overrides: vec![("/p.xml", "P")],
                ..Patch::default()
            },
        );
        assert_eq!(
            out,
            r#"<Types xmlns="x"><Override PartName="/p.xml" ContentType="P"/></Types>"#
        );
        let out = patch(
            r#"<Types xmlns="x"></Types>"#,
            &Patch {
                add_defaults: vec![("png", "i")],
                ..Patch::default()
            },
        );
        assert_eq!(
            out,
            r#"<Types xmlns="x"><Default Extension="png" ContentType="i"/></Types>"#
        );
    }
}
