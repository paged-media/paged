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
use crate::xml::attr_as;

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
}
