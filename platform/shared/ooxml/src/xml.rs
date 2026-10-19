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

//! The XML helpers every OOXML reader and writer here needs, once.
//!
//! Each one keeps the exact output of the copies it replaces: the escapes
//! write the same characters, and the attribute readers decode the same way
//! (`attr` normalises and unescapes, `attr_raw` hands back the bytes as
//! written).

use quick_xml::events::{BytesRef, BytesStart};

use crate::error::{FromXmlError, XmlError};

/// Strip an XML namespace prefix from a qualified name (`a:b` → `b`).
pub fn local_name(qname: &[u8]) -> &[u8] {
    match qname.iter().position(|&b| b == b':') {
        Some(i) => &qname[i + 1..],
        None => qname,
    }
}

/// The namespace prefix of a qualified name, with its colon (`"x:"`), or `""`.
pub fn prefix_of(qname: &str) -> &str {
    match qname.find(':') {
        Some(i) => &qname[..=i],
        None => "",
    }
}

/// An attribute's value by LOCAL name (the prefix ignored), unescaped and
/// normalised as XML requires (tab, CR and LF become spaces). `Ok(None)` when
/// the element has no such attribute.
pub fn attr(e: &BytesStart<'_>, key: &[u8]) -> Result<Option<String>, XmlError> {
    attr_as(e, key)
}

/// [`attr`] reporting in the caller's own error type, built where the
/// failure happens. A module that reads hundreds of attributes into its own
/// error (paged.sheet's `XlsxError`) wraps this once, so no call site carries
/// a conversion.
pub fn attr_as<E: FromXmlError>(e: &BytesStart<'_>, key: &[u8]) -> Result<Option<String>, E> {
    for a in e.attributes() {
        let a = a?;
        if a.key.local_name().as_ref() == key {
            // 0.37+: `unescape_value()` is deprecated; `normalized_value`
            // additionally applies XML attribute-value normalization
            // (tab/CR/LF → space), which the XML spec requires anyway.
            let v = a.normalized_value(quick_xml::XmlVersion::Implicit1_0)?;
            return Ok(Some(v.into_owned()));
        }
    }
    Ok(None)
}

/// An attribute's value by local name AS WRITTEN: no unescaping, invalid
/// UTF-8 replaced, a malformed attribute skipped. For a reader that matches
/// the source bytes rather than their meaning.
pub fn attr_raw(e: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    e.attributes()
        .flatten()
        .find(|a| local_name(a.key.as_ref()) == key)
        .map(|a| String::from_utf8_lossy(&a.value).into_owned())
}

/// Resolve a general/character reference event (`&amp;`, `&#10;`, `&#x0A;`,
/// …) to its replacement text.
///
/// quick-xml 0.38+ no longer resolves references inside `Event::Text`; the
/// reader emits a separate `Event::GeneralRef` for each `&…;` in element
/// content, so every text-accumulating parse loop routes those events here.
/// OOXML defines no DTD entities, so only character references and the five
/// predefined XML entities can appear; anything else is an escape error (the
/// same class 0.36's `unescape()` raised for it).
pub fn general_ref(r: &BytesRef<'_>) -> Result<String, XmlError> {
    general_ref_as(r)
}

/// [`general_ref`] reporting in the caller's own error type (see [`attr_as`]).
pub fn general_ref_as<E: FromXmlError>(r: &BytesRef<'_>) -> Result<String, E> {
    if let Some(ch) = r.resolve_char_ref()? {
        return Ok(ch.to_string());
    }
    let name = r.decode()?;
    match quick_xml::escape::resolve_predefined_entity(&name) {
        Some(s) => Ok(s.to_string()),
        // The 0..0 span is a placeholder: BytesRef carries no source offset.
        None => Err(E::from(quick_xml::escape::EscapeError::UnrecognizedEntity(
            0..0,
            name.into_owned(),
        ))),
    }
}

/// Escape element text: `&`, `<` and `>`.
pub fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Escape an attribute value (double-quoted): `&`, `<`, `>` and `"`.
pub fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Undo the five predefined entities of an attribute value as written
/// (`&amp;` last, so `&amp;lt;` reads as `&lt;`). Character references stay.
pub fn unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use quick_xml::events::Event;

    fn first_start(xml: &[u8]) -> BytesStart<'static> {
        let mut r = quick_xml::Reader::from_reader(xml);
        let mut buf = Vec::new();
        loop {
            match r.read_event_into(&mut buf).unwrap() {
                Event::Start(e) | Event::Empty(e) => return e.into_owned(),
                Event::Eof => panic!("no element"),
                _ => {}
            }
        }
    }

    #[test]
    fn names_split_at_the_first_colon() {
        assert_eq!(local_name(b"w:sym"), b"sym");
        assert_eq!(local_name(b"sym"), b"sym");
        assert_eq!(prefix_of("x:sheet"), "x:");
        assert_eq!(prefix_of("sheet"), "");
    }

    #[test]
    fn attributes_read_by_local_name_decoded_or_raw() {
        let e = first_start(
            br#"<w:sym w:font="A &amp; B" w:char="F0&#x41;" plain="a	b" kept="a&#9;b"/>"#,
        );
        assert_eq!(attr(&e, b"font").unwrap().as_deref(), Some("A & B"));
        // A literal tab is normalised to a space; a character reference is not.
        assert_eq!(attr(&e, b"plain").unwrap().as_deref(), Some("a b"));
        assert_eq!(attr(&e, b"kept").unwrap().as_deref(), Some("a\tb"));
        assert_eq!(attr(&e, b"missing").unwrap(), None);
        assert_eq!(attr_raw(&e, b"font").as_deref(), Some("A &amp; B"));
        assert_eq!(attr_raw(&e, b"char").as_deref(), Some("F0&#x41;"));
    }

    #[test]
    fn references_resolve_or_fail_as_escape_errors() {
        let mut r = quick_xml::Reader::from_reader(&b"<t>&amp;&#65;&#x42;&bogus;</t>"[..]);
        let mut buf = Vec::new();
        let mut text = String::new();
        let mut errors = 0;
        loop {
            match r.read_event_into(&mut buf).unwrap() {
                Event::GeneralRef(g) => match general_ref(&g) {
                    Ok(s) => text.push_str(&s),
                    Err(XmlError::Escape(_)) => errors += 1,
                    Err(e) => panic!("{e}"),
                },
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        assert_eq!(text, "&AB");
        assert_eq!(errors, 1);
    }

    #[test]
    fn escapes_write_what_the_copies_wrote() {
        let s = "a&b<c>d\"e'f\tg";
        assert_eq!(escape_text(s), "a&amp;b&lt;c&gt;d\"e'f\tg");
        assert_eq!(escape_attr(s), "a&amp;b&lt;c&gt;d&quot;e'f\tg");
        assert_eq!(unescape(&escape_attr(s)), s);
        assert_eq!(unescape("&amp;lt;&apos;"), "&lt;'");
    }
}
