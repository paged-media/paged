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

//! A small namespace-aware element tree over quick-xml.
//!
//! DrawingML is deep and almost entirely optional: a shape may or may not have
//! a transform, a fill may be any of six choices, text properties inherit
//! field by field. Walking it as a tree of elements matched by (namespace,
//! local name) keeps the reader short and tolerant — an element it does not
//! know is skipped, never an error (ADR 702). Prefixes are resolved to
//! namespace URIs, so a file that binds `a:` to something unusual still reads.

use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;

/// The namespaces the reader distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ns {
    /// PresentationML main.
    P,
    /// DrawingML main.
    A,
    /// Office relationships (attribute namespace).
    R,
    /// PowerPoint 2010 extensions.
    P14,
    /// Markup compatibility (`mc:AlternateContent`).
    Mc,
    /// DrawingML chart.
    C,
    /// Anything else (or no namespace).
    Other,
}

fn ns_of(uri: &[u8]) -> Ns {
    match uri {
        b"http://schemas.openxmlformats.org/presentationml/2006/main"
        | b"http://purl.oclc.org/ooxml/presentationml/main" => Ns::P,
        // A SmartArt drawing (`dsp:`) repeats PresentationML's shape tree
        // element for element (spTree, sp, nvSpPr, spPr, style, txBody,
        // grpSp), so it reads as one.
        b"http://schemas.microsoft.com/office/drawing/2008/diagram" => Ns::P,
        b"http://schemas.openxmlformats.org/drawingml/2006/main"
        | b"http://purl.oclc.org/ooxml/drawingml/main" => Ns::A,
        b"http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        | b"http://purl.oclc.org/ooxml/officeDocument/relationships" => Ns::R,
        b"http://schemas.microsoft.com/office/powerpoint/2010/main" => Ns::P14,
        b"http://schemas.openxmlformats.org/markup-compatibility/2006" => Ns::Mc,
        b"http://schemas.openxmlformats.org/drawingml/2006/chart" => Ns::C,
        _ => Ns::Other,
    }
}

/// One attribute.
#[derive(Debug, Clone)]
pub struct Attr {
    pub ns: Ns,
    pub local: String,
    pub value: String,
}

/// One element with its attributes, children and direct text.
#[derive(Debug, Clone)]
pub struct El {
    pub ns: Ns,
    pub local: String,
    /// The name as written (prefix:local), for verbatim re-serialisation.
    pub qname: String,
    pub attrs: Vec<Attr>,
    /// The attributes as written, for verbatim re-serialisation.
    pub raw_attrs: Vec<(String, String)>,
    pub children: Vec<El>,
    pub text: String,
}

impl El {
    /// Is this `ns:local`?
    pub fn is(&self, ns: Ns, local: &str) -> bool {
        self.ns == ns && self.local == local
    }
    /// The first child `ns:local`.
    pub fn child(&self, ns: Ns, local: &str) -> Option<&El> {
        self.children.iter().find(|c| c.is(ns, local))
    }
    /// Every child `ns:local`.
    pub fn children_named<'a>(&'a self, ns: Ns, local: &'a str) -> impl Iterator<Item = &'a El> {
        self.children.iter().filter(move |c| c.is(ns, local))
    }
    /// Follow a path of `(ns, local)` steps through first children.
    pub fn path(&self, steps: &[(Ns, &str)]) -> Option<&El> {
        let mut cur = self;
        for (ns, local) in steps {
            cur = cur.child(*ns, local)?;
        }
        Some(cur)
    }
    /// An unqualified attribute.
    pub fn attr(&self, local: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|a| a.ns == Ns::Other && a.local == local)
            .map(|a| a.value.as_str())
    }
    /// An attribute in a namespace (`r:id`, `r:embed`).
    pub fn attr_ns(&self, ns: Ns, local: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|a| a.ns == ns && a.local == local)
            .map(|a| a.value.as_str())
    }
    pub fn attr_i64(&self, local: &str) -> Option<i64> {
        self.attr(local).and_then(|v| v.trim().parse().ok())
    }
    pub fn attr_i32(&self, local: &str) -> Option<i32> {
        self.attr(local).and_then(|v| v.trim().parse().ok())
    }
    pub fn attr_u32(&self, local: &str) -> Option<u32> {
        self.attr(local).and_then(|v| v.trim().parse().ok())
    }
    /// An `xsd:boolean` attribute (`1` / `true` / `0` / `false`).
    pub fn attr_bool(&self, local: &str) -> Option<bool> {
        self.attr(local).map(|v| matches!(v.trim(), "1" | "true"))
    }
    /// All descendant text, concatenated.
    pub fn deep_text(&self) -> String {
        let mut s = self.text.clone();
        for c in &self.children {
            s.push_str(&c.deep_text());
        }
        s
    }
    /// The element re-serialised as written (prefixes and attribute order kept).
    pub fn to_xml(&self) -> String {
        let mut out = String::new();
        self.write_xml(&mut out);
        out
    }
    fn write_xml(&self, out: &mut String) {
        out.push('<');
        out.push_str(&self.qname);
        for (k, v) in &self.raw_attrs {
            out.push(' ');
            out.push_str(k);
            out.push_str("=\"");
            out.push_str(&escape(v));
            out.push('"');
        }
        if self.children.is_empty() && self.text.is_empty() {
            out.push_str("/>");
            return;
        }
        out.push('>');
        out.push_str(&escape(&self.text));
        for c in &self.children {
            c.write_xml(out);
        }
        out.push_str("</");
        out.push_str(&self.qname);
        out.push('>');
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Parse a part into its root element.
pub fn parse(bytes: &[u8]) -> Result<El, String> {
    let mut reader = NsReader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<El> = Vec::new();
    let mut buf = Vec::new();
    loop {
        let event = match reader.read_event_into(&mut buf) {
            Ok(e) => e,
            Err(e) => return Err(format!("xml at byte {}: {e}", reader.buffer_position())),
        };
        match event {
            Event::Start(start) => {
                let el = element(&reader, &start)?;
                stack.push(el);
            }
            Event::Empty(start) => {
                let el = element(&reader, &start)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(el),
                    None => return Ok(el),
                }
            }
            Event::End(_) => {
                let done = stack.pop().ok_or("unbalanced end tag")?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(done),
                    None => return Ok(done),
                }
            }
            Event::Text(t) => {
                if let Some(top) = stack.last_mut() {
                    let s = t.decode().map_err(|e| e.to_string())?;
                    top.text.push_str(&s);
                }
            }
            // Entity and character references arrive as their own events.
            Event::GeneralRef(r) => {
                if let Some(top) = stack.last_mut() {
                    if let Ok(Some(ch)) = r.resolve_char_ref() {
                        top.text.push(ch);
                    } else {
                        let name = r.decode().map_err(|e| e.to_string())?;
                        match quick_xml::escape::resolve_predefined_entity(&name) {
                            Some(v) => top.text.push_str(v),
                            None => {
                                top.text.push('&');
                                top.text.push_str(&name);
                                top.text.push(';');
                            }
                        }
                    }
                }
            }
            Event::CData(t) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&String::from_utf8_lossy(&t));
                }
            }
            Event::Eof => return Err("no root element".into()),
            _ => {}
        }
        buf.clear();
    }
}

fn element(reader: &NsReader<&[u8]>, start: &BytesStart) -> Result<El, String> {
    let (res, _) = reader.resolver().resolve_element(start.name());
    let ns = match res {
        ResolveResult::Bound(n) => ns_of(n.as_ref()),
        _ => Ns::Other,
    };
    let local = String::from_utf8_lossy(start.local_name().as_ref()).into_owned();
    let qname = String::from_utf8_lossy(start.name().as_ref()).into_owned();
    let mut attrs = Vec::new();
    let mut raw_attrs = Vec::new();
    for a in start.attributes().with_checks(false) {
        let a = a.map_err(|e| e.to_string())?;
        let value = a
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| String::from_utf8_lossy(&a.value).into_owned());
        let key = String::from_utf8_lossy(a.key.as_ref()).into_owned();
        raw_attrs.push((key, value.clone()));
        if a.key.as_namespace_binding().is_some() {
            continue;
        }
        let (res, local) = reader.resolver().resolve_attribute(a.key);
        let ans = match res {
            ResolveResult::Bound(n) => ns_of(n.as_ref()),
            _ => Ns::Other,
        };
        attrs.push(Attr {
            ns: ans,
            local: String::from_utf8_lossy(local.as_ref()).into_owned(),
            value,
        });
    }
    Ok(El {
        ns,
        local,
        qname,
        attrs,
        raw_attrs,
        children: Vec::new(),
        text: String::new(),
    })
}

/// `mc:AlternateContent`: the first `mc:Choice` and the `mc:Fallback`.
pub fn alternate(el: &El) -> (Option<&El>, Option<&El>) {
    (el.child(Ns::Mc, "Choice"), el.child(Ns::Mc, "Fallback"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_namespaces_and_attributes() {
        let xml = br#"<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" show="0"><p:cSld><a:t>A &amp; B</a:t><p:x r:id="rId3"/></p:cSld></p:sld>"#;
        let root = parse(xml).unwrap();
        assert!(root.is(Ns::P, "sld"));
        assert_eq!(root.attr_bool("show"), Some(false));
        let csld = root.child(Ns::P, "cSld").unwrap();
        assert_eq!(csld.child(Ns::A, "t").unwrap().text, "A & B");
        assert_eq!(
            csld.child(Ns::P, "x").unwrap().attr_ns(Ns::R, "id"),
            Some("rId3")
        );
    }

    #[test]
    fn re_serialises_verbatim_enough() {
        let xml = br#"<p:transition xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" spd="slow"><p:fade/></p:transition>"#;
        let root = parse(xml).unwrap();
        let out = root.to_xml();
        assert!(out.starts_with("<p:transition"));
        assert!(out.contains("spd=\"slow\""));
        assert!(out.contains("<p:fade/>"));
        assert!(parse(out.as_bytes()).is_ok());
    }
}
