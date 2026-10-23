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

//! Engine ADR 1002 — the XML structure through export and import: an
//! unchanged import keeps its parts byte for byte; a structure changed in
//! paged is written from the model (tags, the back story, the elements in
//! the stories with their attributes and ranges) and reads back the same;
//! and the fields a document's tags describe are a fixed point of writing.

use std::io::Read;

use paged_mutate::{apply, Operation};
use paged_scene::Document;
use paged_template::{derive_fields, DeriveOptions};

fn source() -> Vec<u8> {
    paged_gen::fixtures::tagged_template_idml()
}

fn open(bytes: &[u8]) -> Document {
    idml_import::import_idml_doc(bytes).expect("opens")
}

fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    (0..z.len())
        .map(|i| {
            let mut f = z.by_index(i).unwrap();
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            (f.name().unwrap().to_string(), b)
        })
        .collect()
}

fn entry(bytes: &[u8], name: &str) -> String {
    let e = entries(bytes);
    String::from_utf8(e.into_iter().find(|(n, _)| n == name).unwrap().1).unwrap()
}

fn range_texts(doc: &Document, story_id: &str) -> Vec<(String, String)> {
    let s = &doc
        .stories
        .iter()
        .find(|s| s.self_id == story_id)
        .unwrap()
        .story;
    let text: Vec<char> = s.flat_text().chars().collect();
    s.xml_elements
        .iter()
        .flat_map(|e| e.walk())
        .filter_map(|e| {
            let r = e.range?;
            Some((
                e.tag_name().to_string(),
                text[r.start as usize..r.end as usize].iter().collect(),
            ))
        })
        .collect()
}

#[test]
fn an_unchanged_import_keeps_every_part() {
    let src = source();
    let out = idml_export::write_idml(&open(&src), &src).unwrap();
    assert_eq!(entries(&out), entries(&src));
}

#[test]
fn a_structure_changed_in_paged_is_written_and_reads_back() {
    let src = source();
    let mut doc = open(&src);
    let ops = [
        Operation::CreateXmlTag {
            name: "Caption".into(),
            color: Some("Magenta".into()),
        },
        Operation::TagItem {
            item: "rLogo".into(),
            tag: "Logo".into(),
            self_id: "dxLogo".into(),
        },
        Operation::SetXmlAttribute {
            element: "dxLogo".into(),
            name: "label".into(),
            value: Some("Brand mark".into()),
        },
        Operation::TagRange {
            story_id: "sHead".into(),
            start: 7,
            end: 11,
            tag: "Season".into(),
            self_id: "dxSeason".into(),
        },
        Operation::SetXmlAttribute {
            element: "di2i3".into(),
            name: "maxLength".into(),
            value: Some("24".into()),
        },
        Operation::UntagRange {
            element: "di2i5i1".into(),
        },
    ];
    for op in &ops {
        apply(&mut doc, op).unwrap();
    }
    let out = idml_export::write_idml(&doc, &src).unwrap();
    let back = open(&out);

    let names: Vec<&str> = back
        .designmap
        .xml_tags
        .iter()
        .map(|t| t.name.as_str())
        .collect();
    assert!(names.contains(&"Caption") && names.contains(&"Logo") && names.contains(&"Season"));
    let caption = back
        .designmap
        .xml_tags
        .iter()
        .find(|t| t.name == "Caption")
        .unwrap();
    assert_eq!(caption.color.as_deref(), Some("Magenta"));

    let root = back.designmap.xml_root.as_ref().unwrap();
    let logo = root.find("dxLogo").unwrap();
    assert_eq!(logo.content.as_deref(), Some("rLogo"));
    assert_eq!(logo.attribute("label"), Some("Brand mark"));
    let photo = root.find("di2i4").unwrap();
    assert_eq!(photo.attribute("label"), Some("Product photo"));

    // The headline's story: its element, its new attribute, its new range.
    let head = &back
        .stories
        .iter()
        .find(|s| s.self_id == "sHead")
        .unwrap()
        .story;
    assert_eq!(head.xml_elements[0].attribute("maxLength"), Some("24"));
    assert_eq!(head.xml_elements[0].attribute("required"), Some("true"));
    assert_eq!(
        range_texts(&back, "sHead"),
        vec![("Season".into(), "Sale".into())]
    );
    // The letter: Name untagged, its text kept; Price still there, once.
    assert_eq!(
        range_texts(&back, "sBody"),
        vec![("Price".into(), "9.99".into())]
    );
    let body = entry(&out, "Stories/Story_sBody.xml");
    assert_eq!(
        body.matches("MarkupTag=\"XMLTag/Price\"").count(),
        1,
        "{body}"
    );
    assert!(!body.contains("XMLTag/Name"), "{body}");
    assert_eq!(
        back.stories
            .iter()
            .find(|s| s.self_id == "sBody")
            .unwrap()
            .story
            .flat_text(),
        "Dear Ada, your price is 9.99 today."
    );
    // Writing what was read changes nothing more.
    let mut again = open(&out);
    again.designmap.xml_structure_edited = true;
    let out2 = idml_export::write_idml(&again, &out).unwrap();
    assert_eq!(
        range_texts(&open(&out2), "sHead"),
        range_texts(&back, "sHead")
    );
}

#[test]
fn a_package_without_a_structure_gains_its_parts() {
    // The fixture, its XML parts and references taken out.
    let src = source();
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries(&src) {
        if name.starts_with("XML/") {
            continue;
        }
        let mut body = String::from_utf8(bytes).unwrap();
        if name == "designmap.xml" {
            body = body
                .replace("<idPkg:Tags src=\"XML/Tags.xml\"/>\n", "")
                .replace("<idPkg:BackingStory src=\"XML/BackingStory.xml\"/>\n", "");
        }
        if name.starts_with("Stories/") {
            let doc = idml_export::xml_structure::strip_story_elements(body.as_bytes()).unwrap();
            body = String::from_utf8(doc).unwrap();
        }
        let opts = zip::write::SimpleFileOptions::default();
        z.start_file(name, opts).unwrap();
        std::io::Write::write_all(&mut z, body.as_bytes()).unwrap();
    }
    let bare = z.finish().unwrap().into_inner();
    let mut doc = open(&bare);
    assert!(doc.designmap.xml_root.is_none());
    apply(
        &mut doc,
        &Operation::TagItem {
            item: "rPhoto".into(),
            tag: "Photo".into(),
            self_id: "dxPhoto".into(),
        },
    )
    .unwrap();
    let out = idml_export::write_idml(&doc, &bare).unwrap();
    let dm = entry(&out, "designmap.xml");
    assert!(dm.contains("<idPkg:Tags src=\"XML/Tags.xml\"/>"), "{dm}");
    assert!(
        dm.contains("<idPkg:BackingStory src=\"XML/BackingStory.xml\"/>"),
        "{dm}"
    );
    let back = open(&out);
    let root = back.designmap.xml_root.as_ref().unwrap();
    assert_eq!(root.tag, "XMLTag/Root");
    assert_eq!(root.children[0].content.as_deref(), Some("rPhoto"));
}

#[test]
fn derive_write_derive_is_a_fixed_point() {
    let src = source();
    let mut doc = open(&src);
    let first = derive_fields(&doc, DeriveOptions::default());
    // Written from the model, not copied.
    doc.designmap.xml_structure_edited = true;
    let out = idml_export::write_idml(&doc, &src).unwrap();
    assert_ne!(
        entry(&out, "XML/BackingStory.xml"),
        entry(&src, "XML/BackingStory.xml")
    );
    let second = derive_fields(&open(&out), DeriveOptions::default());
    assert_eq!(first, second);
}
