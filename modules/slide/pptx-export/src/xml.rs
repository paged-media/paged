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

//! Raw XML, located rather than parsed: where each element of a part sits,
//! so an unchanged shape, paragraph or cell is written back as the bytes it
//! was (ADR 711), and only what changed is replaced.

use paged_ooxml::xml::{escape_attr, unescape};
use quick_xml::events::Event;
use quick_xml::Reader;

/// An element of an XML text: its qualified name, its whole extent and the
/// extent of its content (empty for `<a/>`), as byte offsets.
#[derive(Debug, Clone, PartialEq)]
pub struct El {
    pub name: String,
    pub start: usize,
    pub end: usize,
    pub inner: (usize, usize),
}

impl El {
    /// The element's text, tags included.
    pub fn text<'a>(&self, xml: &'a str) -> &'a str {
        &xml[self.start..self.end]
    }

    /// The opening tag (the whole element when it is empty).
    pub fn open<'a>(&self, xml: &'a str) -> &'a str {
        if self.inner.0 == self.inner.1 && self.inner.1 == self.end {
            &xml[self.start..self.end]
        } else {
            &xml[self.start..self.inner.0]
        }
    }

    /// Its content's extent.
    pub fn range(&self) -> (usize, usize) {
        self.inner
    }

    /// An attribute of its opening tag.
    pub fn attr(&self, xml: &str, name: &str) -> Option<String> {
        attr(self.open(xml), name)
    }

    /// Its direct child elements.
    pub fn children(&self, xml: &str) -> Vec<El> {
        children(xml, self.inner)
    }

    /// Its first direct child named `name`.
    pub fn child(&self, xml: &str, name: &str) -> Option<El> {
        self.children(xml).into_iter().find(|c| c.name == name)
    }

    /// The first element down the path of child names.
    pub fn path(&self, xml: &str, names: &[&str]) -> Option<El> {
        let mut at = self.clone();
        for n in names {
            at = at.child(xml, n)?;
        }
        Some(at)
    }
}

/// The direct child elements of `xml[range]`. Malformed text yields the
/// elements read before the fault.
pub fn children(xml: &str, range: (usize, usize)) -> Vec<El> {
    let (a, b) = range;
    let mut out = Vec::new();
    if a >= b {
        return out;
    }
    let mut r = Reader::from_str(&xml[a..b]);
    let mut depth = 0usize;
    let mut open: Option<(String, usize, usize)> = None;
    loop {
        let before = r.buffer_position() as usize;
        match r.read_event() {
            Ok(Event::Start(e)) => {
                if depth == 0 {
                    let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                    open = Some((name, a + before, a + r.buffer_position() as usize));
                }
                depth += 1;
            }
            Ok(Event::End(_)) => {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                if depth == 0 {
                    if let Some((name, start, inner)) = open.take() {
                        out.push(El {
                            name,
                            start,
                            end: a + r.buffer_position() as usize,
                            inner: (inner, a + before),
                        });
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                if depth == 0 {
                    let end = a + r.buffer_position() as usize;
                    out.push(El {
                        name: String::from_utf8_lossy(e.name().as_ref()).into_owned(),
                        start: a + before,
                        end,
                        inner: (end, end),
                    });
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
    }
    out
}

/// The root element of a part (after the XML declaration).
pub fn root(xml: &str) -> Option<El> {
    children(xml, (0, xml.len())).into_iter().next()
}

/// An attribute's value in one tag.
pub fn attr(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let key = format!(" {name}={quote}");
        let mut from = 0;
        while let Some(i) = tag[from..].find(&key) {
            let i = from + i + key.len();
            if let Some(j) = tag[i..].find(quote) {
                return Some(unescape(&tag[i..i + j]));
            }
            from = i;
        }
        // Attributes may also follow a line break or a tab.
        for ws in ['\n', '\t', '\r'] {
            let key = format!("{ws}{name}={quote}");
            if let Some(i) = tag.find(&key) {
                let i = i + key.len();
                if let Some(j) = tag[i..].find(quote) {
                    return Some(unescape(&tag[i..i + j]));
                }
            }
        }
    }
    None
}

/// `tag` with attribute `name` set to `value` (added before the tag's end
/// when absent), or removed when `value` is `None`.
pub fn set_attr(tag: &str, name: &str, value: Option<&str>) -> String {
    let key = format!(" {name}=\"");
    let mut out = tag.to_string();
    if let Some(i) = out.find(&key) {
        let vstart = i + key.len();
        if let Some(j) = out[vstart..].find('"') {
            let vend = vstart + j + 1;
            match value {
                Some(v) => out.replace_range(i..vend, &format!(" {name}=\"{}\"", escape_attr(v))),
                None => out.replace_range(i..vend, ""),
            }
            return out;
        }
    }
    if let Some(v) = value {
        let at = if out.ends_with("/>") {
            out.len() - 2
        } else {
            out.len() - 1
        };
        out.insert_str(at, &format!(" {name}=\"{}\"", escape_attr(v)));
    }
    out
}

/// Replace `xml[a..b]` with `with`.
pub fn splice(xml: &str, a: usize, b: usize, with: &str) -> String {
    let mut s = String::with_capacity(xml.len() + with.len());
    s.push_str(&xml[..a]);
    s.push_str(with);
    s.push_str(&xml[b..]);
    s
}

/// Text content escaped for an element body.
pub fn text(s: &str) -> String {
    paged_ooxml::xml::escape_text(s)
}

/// An attribute value escaped.
pub fn esc(s: &str) -> String {
    escape_attr(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn children_are_located_with_their_content() {
        let x = r#"<r><a x="1"><b/></a> <c/><d>t</d></r>"#;
        let root = root(x).unwrap();
        let kids = root.children(x);
        assert_eq!(
            kids.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(),
            ["a", "c", "d"]
        );
        assert_eq!(kids[0].text(x), r#"<a x="1"><b/></a>"#);
        assert_eq!(kids[0].open(x), r#"<a x="1">"#);
        assert_eq!(kids[1].text(x), "<c/>");
        assert_eq!(kids[1].open(x), "<c/>");
        assert_eq!(&x[kids[2].inner.0..kids[2].inner.1], "t");
        assert_eq!(kids[0].attr(x, "x").as_deref(), Some("1"));
    }

    #[test]
    fn attributes_are_set_added_and_removed() {
        assert_eq!(set_attr(r#"<a x="1"/>"#, "x", Some("2")), r#"<a x="2"/>"#);
        assert_eq!(set_attr(r#"<a>"#, "y", Some("<")), r#"<a y="&lt;">"#);
        assert_eq!(set_attr(r#"<a x="1" y="2">"#, "x", None), r#"<a y="2">"#);
    }
}
