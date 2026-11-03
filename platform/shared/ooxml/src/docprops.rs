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

//! The document properties of an OOXML package (`docProps/core.xml` and
//! `docProps/app.xml`): title, author, dates and the producing application,
//! read once for doc, slide and sheet. They are read only: a save keeps the
//! two parts as the package had them (byte-identical), and the importers hand
//! the values to the engine document as one document label
//! ([`LABEL_KEY`]).

use quick_xml::events::Event;

/// The engine document label the imported properties travel in.
pub const LABEL_KEY: &str = "x-paged:core.docprops";

/// The core properties that are read, by local name (`dc:title` -> `title`).
const CORE: &[&str] = &[
    "title",
    "subject",
    "creator",
    "keywords",
    "description",
    "lastModifiedBy",
    "category",
    "revision",
    "created",
    "modified",
];

/// The extended properties that are read.
const APP: &[&str] = &["Application", "Company", "Manager"];

/// The properties of a package, in file order, empty values dropped:
/// `(local name, text)`. App-part names are prefixed `app.`.
pub fn read(core_xml: Option<&[u8]>, app_xml: Option<&[u8]>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(x) = core_xml {
        out.extend(read_part(x, CORE, ""));
    }
    if let Some(x) = app_xml {
        out.extend(read_part(x, APP, "app."));
    }
    out
}

fn read_part(xml: &[u8], names: &[&str], prefix: &str) -> Vec<(String, String)> {
    let mut reader = quick_xml::Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut open: Option<(String, String)> = None;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                depth += 1;
                if depth == 2 {
                    let local = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                    if names.contains(&local.as_str()) {
                        open = Some((local, String::new()));
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if let (Some((_, v)), Ok(s)) = (open.as_mut(), t.xml10_content()) {
                    v.push_str(&s);
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if let (Some((_, v)), Ok(s)) = (
                    open.as_mut(),
                    crate::xml::general_ref_as::<crate::XmlError>(&r),
                ) {
                    v.push_str(&s);
                }
            }
            Ok(Event::End(_)) => {
                if depth == 2 {
                    if let Some((k, v)) = open.take() {
                        let v = v.trim();
                        if !v.is_empty() {
                            out.push((format!("{prefix}{k}"), v.to_string()));
                        }
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// The properties as the label value: a flat JSON object, keys in file order.
/// `None` when there are none.
pub fn label_value(props: &[(String, String)]) -> Option<String> {
    if props.is_empty() {
        return None;
    }
    let mut s = String::from("{");
    for (i, (k, v)) in props.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        json_str(&mut s, k);
        s.push(':');
        json_str(&mut s, v);
    }
    s.push('}');
    Some(s)
}

fn json_str(out: &mut String, v: &str) {
    out.push('"');
    for c in v.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    const CORE_XML: &[u8] = br#"<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Q&amp;A "plan"</dc:title><dc:creator>Ada</dc:creator><cp:keywords></cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">2026-01-02T03:04:05Z</dcterms:created></cp:coreProperties>"#;
    const APP_XML: &[u8] = br#"<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application><Pages>3</Pages></Properties>"#;

    #[test]
    fn core_and_app_properties_are_read_in_file_order() {
        let p = read(Some(CORE_XML), Some(APP_XML));
        let keys: Vec<&str> = p.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["title", "creator", "created", "app.Application"]);
        assert_eq!(p[0].1, "Q&A \"plan\"");
    }

    #[test]
    fn the_label_is_a_json_object() {
        let p = read(Some(CORE_XML), None);
        assert_eq!(
            label_value(&p).as_deref(),
            Some(r#"{"title":"Q&A \"plan\"","creator":"Ada","created":"2026-01-02T03:04:05Z"}"#)
        );
        assert_eq!(label_value(&[]), None);
    }
}
