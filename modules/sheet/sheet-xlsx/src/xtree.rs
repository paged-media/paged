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

//! A small owned XML tree with text content, for the worksheet children and
//! table parts the W2.6–W2.8 authoring rewrites (`<dataValidations>`,
//! `<autoFilter>`, `<sortState>`, `<sheetProtection>`, `tableN.xml`). Unlike
//! the style records' `Elem`, an element keeps its text (`<formula1>`), and
//! whitespace-only text between elements is dropped. Namespace declarations
//! are ordinary attributes, so a parsed element renders with them.

use crate::error::XlsxError;
use crate::splice::{attr_local, escape_attr, set_attr};

/// One element: qualified name as written, attributes in order, children,
/// and the text it holds (elements here never mix text and children).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct XNode {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<XNode>,
    pub text: Option<String>,
}

impl XNode {
    pub fn new(name: impl Into<String>) -> XNode {
        XNode {
            name: name.into(),
            ..XNode::default()
        }
    }

    pub fn with_attr(mut self, k: &str, v: impl Into<String>) -> XNode {
        self.attrs.push((k.to_string(), v.into()));
        self
    }

    pub fn with_text(mut self, t: impl Into<String>) -> XNode {
        self.text = Some(t.into());
        self
    }

    pub fn with_child(mut self, c: XNode) -> XNode {
        self.children.push(c);
        self
    }

    pub fn local(&self) -> &str {
        self.name.rsplit(':').next().unwrap_or(&self.name)
    }

    pub fn prefix(&self) -> &str {
        match self.name.rfind(':') {
            Some(i) => &self.name[..=i],
            None => "",
        }
    }

    pub fn attr(&self, local: &str) -> Option<String> {
        attr_local(&self.attrs, local)
    }

    pub fn flag(&self, local: &str, default: bool) -> bool {
        match self.attr(local).as_deref() {
            Some("1") | Some("true") => true,
            Some("0") | Some("false") => false,
            _ => default,
        }
    }

    pub fn set(&mut self, local: &str, v: Option<String>) {
        set_attr(&mut self.attrs, local, v);
    }

    pub fn child(&self, local: &str) -> Option<&XNode> {
        self.children.iter().find(|c| c.local() == local)
    }

    pub fn child_mut(&mut self, local: &str) -> Option<&mut XNode> {
        self.children.iter_mut().find(|c| c.local() == local)
    }

    pub fn children_named<'a>(&'a self, local: &'a str) -> impl Iterator<Item = &'a XNode> + 'a {
        self.children.iter().filter(move |c| c.local() == local)
    }

    pub fn remove_children(&mut self, local: &str) {
        self.children.retain(|c| c.local() != local);
    }

    fn render(&self, out: &mut String) {
        out.push('<');
        out.push_str(&self.name);
        for (k, v) in &self.attrs {
            out.push(' ');
            out.push_str(k);
            out.push_str("=\"");
            out.push_str(&escape_attr(v));
            out.push('"');
        }
        let text = self.text.as_deref().unwrap_or("");
        if self.children.is_empty() && text.is_empty() {
            out.push_str("/>");
            return;
        }
        out.push('>');
        out.push_str(&paged_ooxml::xml::escape_text(text));
        for c in &self.children {
            c.render(out);
        }
        out.push_str("</");
        out.push_str(&self.name);
        out.push('>');
    }

    pub fn to_xml(&self) -> String {
        let mut s = String::new();
        self.render(&mut s);
        s
    }

    /// Parse the first element of `xml` (a fragment or a whole part; an XML
    /// declaration before it is skipped).
    pub fn parse(xml: &[u8]) -> Result<XNode, XlsxError> {
        use quick_xml::events::Event;
        let mut reader = quick_xml::Reader::from_reader(xml);
        reader.config_mut().trim_text(false);
        reader.config_mut().expand_empty_elements = false;
        let mut buf = Vec::new();
        let mut stack: Vec<XNode> = Vec::new();
        let to_node = |e: &quick_xml::events::BytesStart<'_>| -> Result<XNode, XlsxError> {
            let mut n = XNode::new(String::from_utf8_lossy(e.name().as_ref()).into_owned());
            for a in e.attributes() {
                let a = a?;
                let k = String::from_utf8_lossy(a.key.as_ref()).into_owned();
                let v = a
                    .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    .map_err(XlsxError::Xml)?
                    .into_owned();
                n.attrs.push((k, v));
            }
            Ok(n)
        };
        let push_text = |stack: &mut Vec<XNode>, s: &str| {
            if let Some(top) = stack.last_mut() {
                top.text.get_or_insert_with(String::new).push_str(s);
            }
        };
        loop {
            match reader.read_event_into(&mut buf)? {
                Event::Start(e) => stack.push(to_node(&e)?),
                Event::Empty(e) => {
                    let n = to_node(&e)?;
                    match stack.last_mut() {
                        Some(p) => p.children.push(n),
                        None => return Ok(n),
                    }
                }
                Event::Text(t) => {
                    let s = t.xml10_content()?;
                    push_text(&mut stack, &s);
                }
                Event::CData(t) => {
                    let s = String::from_utf8_lossy(&t).into_owned();
                    push_text(&mut stack, &s);
                }
                Event::GeneralRef(r) => {
                    let s = crate::opc::general_ref(&r)?;
                    push_text(&mut stack, &s);
                }
                Event::End(_) => {
                    let mut n = stack
                        .pop()
                        .ok_or_else(|| XlsxError::Structure("unbalanced element".into()))?;
                    // Whitespace between elements is layout, not content; a
                    // text-only element keeps even a blank value.
                    if !n.children.is_empty()
                        && n.text.as_deref().is_some_and(|t| t.trim().is_empty())
                    {
                        n.text = None;
                    }
                    match stack.last_mut() {
                        Some(p) => p.children.push(n),
                        None => return Ok(n),
                    }
                }
                Event::Eof => return Err(XlsxError::Structure("no element".into())),
                _ => {}
            }
            buf.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_text_and_attrs() {
        let x = br#"<dataValidations count="1"><dataValidation type="list" sqref="A1:A3"><formula1>"a,b&amp;c"</formula1></dataValidation></dataValidations>"#;
        let n = XNode::parse(x).unwrap();
        let dv = n.child("dataValidation").unwrap();
        assert_eq!(
            dv.child("formula1").unwrap().text.as_deref(),
            Some("\"a,b&c\"")
        );
        assert_eq!(n.to_xml().as_bytes(), &x[..]);
    }

    #[test]
    fn layout_whitespace_dropped() {
        let n = XNode::parse(b"<a>\n  <b x=\"1\"/>\n</a>").unwrap();
        assert_eq!(n.to_xml(), "<a><b x=\"1\"/></a>");
    }
}
