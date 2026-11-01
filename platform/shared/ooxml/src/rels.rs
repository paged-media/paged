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

//! The `_rels` relationship graph (ECMA-376 Part 2 §9.3): a `.rels` part maps
//! relationship ids (`rId1`, …) to target parts, and the helpers that turn a
//! target into a part name.
//!
//! Two parses, for two kinds of reader:
//!
//! - [`Relationships::parse`] is a tolerant scan (paged.doc, paged.slide): it
//!   never fails, a row missing an attribute keeps it empty, and malformed
//!   XML ends the scan with the rows read so far.
//! - [`Relationships::try_parse`] is strict (paged.sheet): malformed XML is an
//!   error, and a row without an `Id`, `Type` or `Target` is skipped.
//!
//! The `.rels` part itself stays opaque and re-emits verbatim; this is a
//! read-only view over its bytes.

use quick_xml::events::Event;
use quick_xml::Reader;

use crate::error::{FromXmlError, XmlError};
use crate::xml::{attr_as, escape_attr};

/// One `<Relationship>` from a `.rels` part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relationship {
    /// `Id` attribute.
    pub id: String,
    /// `Type` attribute (a relationship-type URI).
    pub rel_type: String,
    /// `Target` attribute (usually relative to the part's base).
    pub target: String,
    /// `TargetMode` attribute if present (`External` for external targets).
    pub target_mode: Option<String>,
}

impl Relationship {
    /// True if the relationship type ends with `suffix` (e.g. `/worksheet`),
    /// so the strict and transitional namespace prefixes both match.
    pub fn is_type(&self, suffix: &str) -> bool {
        self.rel_type.ends_with(suffix)
    }
}

/// The parsed relationships of one `.rels` part.
#[derive(Debug, Clone, Default)]
pub struct Relationships {
    /// Relationships in document order.
    pub items: Vec<Relationship>,
}

impl Relationships {
    /// Parse a `.rels` part's bytes tolerantly. Never panics or fails; returns
    /// whatever it could scan.
    pub fn parse(bytes: &[u8]) -> Self {
        Relationships {
            // The tolerant scan reports no error.
            items: scan::<false, XmlError>(bytes).unwrap_or_default(),
        }
    }

    /// Parse a `.rels` part strictly: malformed XML is an error, and a row
    /// without an `Id`, `Type` or `Target` is left out.
    pub fn try_parse(bytes: &[u8]) -> Result<Self, XmlError> {
        Self::try_parse_as(bytes)
    }

    /// [`try_parse`](Self::try_parse) reporting in the caller's own error
    /// type (see [`crate::xml::attr_as`]).
    pub fn try_parse_as<E: FromXmlError>(bytes: &[u8]) -> Result<Self, E> {
        Ok(Relationships {
            items: scan::<true, E>(bytes)?,
        })
    }

    /// The relationship with the given `Id` (e.g. an `r:embed` image ref).
    pub fn by_id(&self, id: &str) -> Option<&Relationship> {
        self.items.iter().find(|r| r.id == id)
    }

    /// The target of the relationship with the given `Id`.
    pub fn target_of(&self, id: &str) -> Option<&str> {
        self.by_id(id).map(|r| r.target.as_str())
    }

    /// The first relationship whose `Type` ends with `suffix`
    /// (e.g. `"/officeDocument"`, `"/styles"`, `"/numbering"`).
    pub fn by_type_suffix(&self, suffix: &str) -> Option<&Relationship> {
        self.items.iter().find(|r| r.is_type(suffix))
    }

    /// Every relationship whose `Type` ends with `suffix`, in document order
    /// (a worksheet may carry many `/table` relationships).
    pub fn all_of_type<'a>(&'a self, suffix: &'a str) -> impl Iterator<Item = &'a Relationship> {
        self.items.iter().filter(move |r| r.is_type(suffix))
    }
}

impl Relationships {
    /// An empty graph (fill it with [`add`](Self::add) and write it with [`to_xml`](Self::to_xml)).
    pub fn new() -> Relationships {
        Relationships::default()
    }

    /// The first `rIdN` no relationship uses.
    pub fn next_id(&self) -> String {
        next_id(self.items.iter().map(|r| r.id.as_str()))
    }

    /// Add a relationship under `id` (replacing one with that id).
    pub fn add(&mut self, id: &str, rel_type: &str, target: &str, external: bool) {
        self.items.retain(|r| r.id != id);
        self.items.push(Relationship {
            id: id.to_string(),
            rel_type: rel_type.to_string(),
            target: target.to_string(),
            target_mode: external.then(|| "External".to_string()),
        });
    }

    /// Add a relationship under the next free id and return the id.
    pub fn add_next(&mut self, rel_type: &str, target: &str, external: bool) -> String {
        let id = self.next_id();
        self.add(&id, rel_type, target, external);
        id
    }

    /// Drop the relationship with `id`.
    pub fn remove(&mut self, id: &str) {
        self.items.retain(|r| r.id != id);
    }

    /// The whole `.rels` part, in order.
    pub fn to_xml(&self) -> String {
        let mut out = String::from(XML_DECL);
        out.push_str(&format!(r#"<Relationships xmlns="{NS}">"#));
        for r in &self.items {
            out.push_str(&relationship_tag(
                &r.id,
                &r.rel_type,
                &r.target,
                r.target_mode.as_deref(),
            ));
        }
        out.push_str("</Relationships>");
        out
    }
}

/// The first `rIdN` that is not among `ids` (N from 1; ids that are not `rId<number>` are ignored).
pub fn next_id<'a>(ids: impl Iterator<Item = &'a str>) -> String {
    let max = ids
        .filter_map(|id| id.strip_prefix("rId")?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("rId{}", max + 1)
}

const XML_DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
const NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

fn relationship_tag(id: &str, rel_type: &str, target: &str, mode: Option<&str>) -> String {
    let mode = mode
        .map(|m| format!(r#" TargetMode="{}""#, escape_attr(m)))
        .unwrap_or_default();
    format!(
        r#"<Relationship Id="{}" Type="{}" Target="{}"{mode}/>"#,
        escape_attr(id),
        escape_attr(rel_type),
        escape_attr(target),
    )
}

/// One relationship to add with [`patch`].
#[derive(Debug, Clone)]
pub struct NewRelationship<'a> {
    /// The id; `None` takes the next free `rIdN`.
    pub id: Option<&'a str>,
    pub rel_type: &'a str,
    pub target: &'a str,
    pub external: bool,
}

/// Edit an existing `.rels` part as text: the tags named by `remove` (by id) go,
/// the `add`ed ones are appended before `</Relationships>`, and every other byte
/// stays. Returns the new text and the ids of the added relationships, in order.
pub fn patch(xml: &str, remove: &[&str], add: &[NewRelationship<'_>]) -> (String, Vec<String>) {
    let mut out = xml.to_string();
    for id in remove {
        while let Some((start, end)) = crate::content_types::find_tag(&out, "Relationship", |t| {
            crate::content_types::tag_attr(t, "Id").as_deref() == Some(*id)
        }) {
            out.replace_range(start..end, "");
        }
    }
    let mut taken: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some((start, end)) =
        crate::content_types::find_tag(&out[from..], "Relationship", |_| true)
            .map(|(a, b)| (a + from, b + from))
    {
        if let Some(id) = crate::content_types::tag_attr(&out[start..end], "Id") {
            taken.push(id);
        }
        from = end;
    }
    let mut ids = Vec::new();
    let mut tags = String::new();
    for r in add {
        let id =
            r.id.map(str::to_string)
                .unwrap_or_else(|| next_id(taken.iter().map(String::as_str)));
        taken.push(id.clone());
        tags.push_str(&relationship_tag(
            &id,
            r.rel_type,
            r.target,
            r.external.then_some("External"),
        ));
        ids.push(id);
    }
    if !tags.is_empty() {
        if let Some(close) = out.rfind("</Relationships>") {
            out.insert_str(close, &tags);
        } else if let Some(i) = out.rfind("/>") {
            // `<Relationships …/>`: no children yet; open it.
            let open = out[..i].trim_end().to_string();
            out = format!("{open}>{tags}</Relationships>");
        }
    }
    (out, ids)
}

/// The one scanner behind both parses. `STRICT` turns every XML and
/// attribute failure into an error and drops incomplete rows; otherwise a
/// malformed part ends the scan and a malformed attribute is skipped.
fn scan<const STRICT: bool, E: FromXmlError>(bytes: &[u8]) -> Result<Vec<Relationship>, E> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(false);
    let mut items = Vec::new();
    let mut buf = Vec::new();
    loop {
        let event = match reader.read_event_into(&mut buf) {
            Ok(event) => event,
            Err(e) if STRICT => return Err(e.into()),
            Err(_) => break,
        };
        match event {
            Event::Empty(e) | Event::Start(e) if e.local_name().as_ref() == b"Relationship" => {
                if STRICT {
                    let (id, rel_type, target) = (
                        attr_as::<E>(&e, b"Id")?,
                        attr_as::<E>(&e, b"Type")?,
                        attr_as::<E>(&e, b"Target")?,
                    );
                    if let (Some(id), Some(rel_type), Some(target)) = (id, rel_type, target) {
                        items.push(Relationship {
                            id,
                            rel_type,
                            target,
                            target_mode: attr_as::<E>(&e, b"TargetMode").ok().flatten(),
                        });
                    }
                } else {
                    let mut row = Relationship {
                        id: String::new(),
                        rel_type: String::new(),
                        target: String::new(),
                        target_mode: None,
                    };
                    for a in e.attributes().flatten() {
                        let val = a
                            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .map(|c| c.into_owned())
                            .unwrap_or_default();
                        match a.key.as_ref() {
                            b"Id" => row.id = val,
                            b"Type" => row.rel_type = val,
                            b"Target" => row.target = val,
                            b"TargetMode" => row.target_mode = Some(val),
                            _ => {}
                        }
                    }
                    items.push(row);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Ok(items)
}

/// Join an OPC `Target` (relative to `base_dir`) into a package part name.
///
/// `base_dir` is the directory of the source part (e.g. `word` for
/// `word/document.xml`; empty for the package root; a trailing `/` is
/// ignored). Handles `../` and a leading `/` (absolute-from-root). Returns a
/// normalized `a/b/c.xml` part name (no leading slash, as zip entries are
/// stored).
pub fn resolve_target(base_dir: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_owned();
    }
    let mut segments: Vec<&str> = Vec::new();
    for seg in base_dir.split('/').filter(|s| !s.is_empty()) {
        segments.push(seg);
    }
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    let mut out = String::with_capacity(base_dir.len() + target.len());
    for (i, seg) in segments.iter().enumerate() {
        if i > 0 {
            out.push('/');
        }
        out.push_str(seg);
    }
    out
}

/// The `.rels` part name for a given part (`word/document.xml` ->
/// `word/_rels/document.xml.rels`; `` -> `_rels/.rels`).
pub fn rels_part_name(part: &str) -> String {
    let (dir, file) = match part.rfind('/') {
        Some(i) => (&part[..=i], &part[i + 1..]),
        None => ("", part),
    };
    format!("{dir}_rels/{file}.rels")
}

/// The directory of a part name (`word/document.xml` -> `word`; `x.xml` -> ``).
pub fn part_dir(part: &str) -> &str {
    match part.rfind('/') {
        Some(i) => &part[..i],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &[u8] = br#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>
  <Relationship Id="rId4" Type="http://example.com/no-target"/>
</Relationships>"#;

    #[test]
    fn both_parses_find_the_office_document() {
        let tolerant = Relationships::parse(ROOT);
        let strict = Relationships::try_parse(ROOT).unwrap();
        for r in [&tolerant, &strict] {
            let od = r.by_type_suffix("/officeDocument").unwrap();
            assert_eq!(od.target, "xl/workbook.xml");
            assert_eq!(r.target_of("rId2"), Some("docProps/core.xml"));
            let link = r.by_id("rId3").unwrap();
            assert_eq!(link.target, "https://example.com/?a=1&b=2");
            assert_eq!(link.target_mode.as_deref(), Some("External"));
        }
        // A row without a Target: kept (empty) by the tolerant scan, left out
        // by the strict one.
        assert_eq!(tolerant.items.len(), 4);
        assert_eq!(tolerant.by_id("rId4").unwrap().target, "");
        assert_eq!(strict.items.len(), 3);
    }

    #[test]
    fn malformed_xml_ends_the_tolerant_scan_and_fails_the_strict_one() {
        let broken = br#"<Relationships><Relationship Id="rId1" Type="t/styles" Target="s.xml"/><Relationship Id="rId2" Type="t/theme" Target="t.xml"/></Wrong>"#;
        let tolerant = Relationships::parse(broken);
        assert_eq!(tolerant.items.len(), 2);
        assert!(Relationships::try_parse(broken).is_err());
        assert!(Relationships::parse(b"<<<").items.is_empty());
    }

    #[test]
    fn every_relationship_of_a_type_in_order() {
        let xml = br#"<Relationships><Relationship Id="a" Type="x/table" Target="t1.xml"/><Relationship Id="b" Type="x/drawing" Target="d.xml"/><Relationship Id="c" Type="x/table" Target="t2.xml"/></Relationships>"#;
        let r = Relationships::try_parse(xml).unwrap();
        let ids: Vec<&str> = r.all_of_type("/table").map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["a", "c"]);
        assert!(r.items[1].is_type("/drawing"));
    }

    #[test]
    fn resolve_relative_and_absolute_targets() {
        // A trailing slash on the base directory changes nothing.
        for base in ["xl", "xl/"] {
            assert_eq!(
                resolve_target(base, "worksheets/sheet1.xml"),
                "xl/worksheets/sheet1.xml"
            );
            assert_eq!(
                resolve_target(base, "../docProps/app.xml"),
                "docProps/app.xml"
            );
            assert_eq!(resolve_target(base, "/xl/styles.xml"), "xl/styles.xml");
        }
        assert_eq!(resolve_target("", "word/document.xml"), "word/document.xml");
    }

    #[test]
    fn part_dir_and_rels_part() {
        assert_eq!(part_dir("xl/workbook.xml"), "xl");
        assert_eq!(part_dir("[Content_Types].xml"), "");
        assert_eq!(
            rels_part_name("xl/workbook.xml"),
            "xl/_rels/workbook.xml.rels"
        );
        assert_eq!(rels_part_name("x.xml"), "_rels/x.xml.rels");
        assert_eq!(rels_part_name(""), "_rels/.rels");
    }

    const RELS: &str = r#"<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t/a" Target="a.xml"/><Relationship Id="rId7" Type="t/b" Target="b.xml"></Relationship></Relationships>"#;

    #[test]
    fn a_graph_writes_and_reads_back() {
        let mut r = Relationships::new();
        assert_eq!(r.add_next("t/styles", "styles.xml", false), "rId1");
        assert_eq!(r.add_next("t/hyperlink", "http://x/?a=1&b=2", true), "rId2");
        r.add("rIdStyles", "t/s", "s.xml", false);
        let back = Relationships::try_parse(r.to_xml().as_bytes()).unwrap();
        assert_eq!(back.items, r.items);
        assert_eq!(back.items[1].target_mode.as_deref(), Some("External"));
        assert_eq!(back.target_of("rId2"), Some("http://x/?a=1&b=2"));
        r.remove("rId1");
        assert_eq!(r.next_id(), "rId3"); // rId2 stays the highest numbered id
    }

    #[test]
    fn a_patch_removes_by_id_and_appends_under_free_ids() {
        let (out, ids) = patch(
            RELS,
            &["rId1"],
            &[
                NewRelationship {
                    id: None,
                    rel_type: "t/c",
                    target: "c.xml",
                    external: false,
                },
                NewRelationship {
                    id: Some("rIdX"),
                    rel_type: "t/d",
                    target: "u?a&b",
                    external: true,
                },
                NewRelationship {
                    id: None,
                    rel_type: "t/e",
                    target: "e.xml",
                    external: false,
                },
            ],
        );
        assert_eq!(ids, vec!["rId8", "rIdX", "rId9"]);
        let r = Relationships::try_parse(out.as_bytes()).unwrap();
        assert!(r.by_id("rId1").is_none());
        assert_eq!(r.by_id("rId7").unwrap().target, "b.xml"); // untouched
        assert_eq!(r.target_of("rIdX"), Some("u?a&b"));
        assert!(out.contains(r#"<Relationship Id="rId7" Type="t/b" Target="b.xml"></Relationship><Relationship Id="rId8""#));
        assert_eq!(patch(RELS, &[], &[]).0, RELS);
        let bare = r#"<Relationships xmlns="x"/>"#;
        let (out, ids) = patch(
            bare,
            &[],
            &[NewRelationship {
                id: None,
                rel_type: "t",
                target: "z",
                external: false,
            }],
        );
        assert_eq!(ids, vec!["rId1"]);
        assert_eq!(
            out,
            r#"<Relationships xmlns="x"><Relationship Id="rId1" Type="t" Target="z"/></Relationships>"#
        );
    }
}
