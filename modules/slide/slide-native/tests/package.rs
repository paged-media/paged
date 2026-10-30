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

// ADR 708 — what a deck opens as: a `.paged` package whose native model part
// is the deck, read back the way the engine reads it (the model part, its
// image blobs), with a page per slide, a master spread per used layout, a
// story per text frame and every picture's bytes.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

fn fixture(name: &str) -> Vec<u8> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

struct Opened {
    names: Vec<String>,
    document: paged_scene::Document,
    blobs: usize,
}

fn open(paged: &[u8]) -> Opened {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(paged)).unwrap();
    let mut names = Vec::new();
    let mut pgm = Vec::new();
    let mut blobs = HashMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).unwrap();
        if name == paged_store::DOCUMENT_PGM_PATH {
            pgm = bytes;
        } else if let Some(b) = paged_store::blob_name_of(&name) {
            blobs.insert(b.to_string(), bytes);
        }
        names.push(name);
    }
    let count = blobs.len();
    Opened {
        names,
        document: paged_store::from_parts(&pgm, blobs).expect("the model part decodes"),
        blobs: count,
    }
}

fn build(name: &str) -> (slide_resolve::model::Deck, slide_native::Written) {
    let bytes = fixture(name);
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&bytes).unwrap());
    let pkg = paged_ooxml::OpcPackage::read(&bytes).unwrap();
    let images = |part: &str| pkg.part(part).map(|b| b.to_vec());
    let written = slide_native::write(&deck, &images, name).unwrap();
    (deck, written)
}

#[test]
fn a_deck_opens_as_a_native_document() {
    let (deck, written) = build("placeholders");
    let opened = open(&written.paged);
    assert_eq!(
        opened.names[0], "mimetype",
        "the container's mimetype first"
    );
    let doc = &opened.document;

    // A single-page spread per slide, at the slide size, on its layout's
    // master spread; a master spread per used layout.
    assert_eq!(doc.spreads.len(), deck.slides.len());
    for (s, slide) in doc.spreads.iter().zip(&deck.slides) {
        let page = &s.spread.pages[0];
        assert_eq!(page.self_id.as_deref(), Some(slide.id.as_str()));
        assert_eq!(
            page.applied_master,
            slide.master.clone().or(Some("n".into()))
        );
        assert_eq!(page.bounds.right as f64, deck.width);
        assert_eq!(page.bounds.bottom as f64, deck.height);
        // The slide's own state rides its page.
        let label = s.spread.labels.get(&slide.id).map(|l| l[0].1.clone());
        assert_eq!(label, slide_native::slide_label(slide));
    }
    assert_eq!(doc.master_spreads.len(), deck.masters.len());
    for m in &deck.masters {
        let ms = &doc.master_spreads[&m.id];
        // Names keep no line breaks (a layout named over two lines).
        assert_eq!(
            ms.name.clone(),
            Some(m.name.replace(['\t', '\n', '\r'], " "))
        );
    }

    // A story per text frame, each threaded by its frame.
    assert!(!written.stories.is_empty());
    for story in written.stories.values() {
        assert!(doc.stories.iter().any(|s| &s.self_id == story), "{story}");
        let framed = doc
            .spreads
            .iter()
            .map(|s| &s.spread)
            .chain(doc.master_spreads.values().map(|m| &m.spread))
            .flat_map(|s| &s.text_frames)
            .any(|f| f.parent_story.as_deref() == Some(story.as_str()));
        assert!(framed, "{story} has a frame");
    }
    // Every element the report names is in the document.
    for (kind, id) in written.elements.values() {
        let found = doc
            .spreads
            .iter()
            .map(|s| &s.spread)
            .chain(doc.master_spreads.values().map(|m| &m.spread))
            .any(|s| match *kind {
                "polygon" => s.polygons.iter().any(|p| p.self_id.as_deref() == Some(id)),
                "textFrame" => s
                    .text_frames
                    .iter()
                    .any(|f| f.self_id.as_deref() == Some(id)),
                "rectangle" => s
                    .rectangles
                    .iter()
                    .any(|r| r.self_id.as_deref() == Some(id)),
                _ => s.groups.iter().any(|g| g.self_id.as_deref() == Some(id)),
            });
        assert!(found, "{kind} {id}");
    }
}

/// A 2 × 1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x7b, 0x40, 0xe8,
    0xdd, 0x00, 0x00, 0x00, 0x0f, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
    0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x56, 0xc7, 0x2f, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

#[test]
fn a_picture_travels_as_a_blob_stretched_over_its_crop() {
    use slide_resolve::model::*;
    let corner = |x: f64, y: f64| slide_geom::PathPoint {
        anchor: (x, y),
        left: (x, y),
        right: (x, y),
    };
    let picture = Item {
        id: "u2".into(),
        name: "Picture 1".into(),
        transform: [1.0, 0.0, 0.0, 1.0, 100.0, 50.0],
        w: 200.0,
        h: 100.0,
        kind: ItemKind::Picture {
            outline: vec![slide_geom::SubPath {
                points: vec![
                    corner(0.0, 0.0),
                    corner(0.0, 100.0),
                    corner(200.0, 100.0),
                    corner(200.0, 0.0),
                ],
                closed: true,
                filled: true,
                stroked: true,
                fill_mode: None,
                path: 0,
            }],
            stroke: None,
            image_part: "ppt/media/image1.png".into(),
            // The left half of the image shows.
            crop: (0.0, 0.0, 0.5, 0.0),
            image_effects: Vec::new(),
        },
        opacity: 1.0,
        effects: Default::default(),
        meta: ItemMeta::default(),
    };
    let deck = Deck {
        width: 960.0,
        height: 540.0,
        slides: vec![SlidePage {
            id: "p1".into(),
            part: "ppt/slides/slide1.xml".into(),
            show_master_items: true,
            items: vec![picture],
            ..SlidePage::default()
        }],
        ..Deck::default()
    };
    let images = |part: &str| (part == "ppt/media/image1.png").then(|| PNG.to_vec());
    let written = slide_native::write(&deck, &images, "picture").unwrap();
    assert!(written.diagnostics.is_empty(), "{:?}", written.diagnostics);
    let opened = open(&written.paged);
    assert_eq!(opened.blobs, 1, "the image is one blob part");
    let r = &opened.document.spreads[0].spread.rectangles[0];
    assert_eq!(r.self_id.as_deref(), Some("u2"));
    assert!(r.has_image_element);
    assert_eq!(r.image_bytes.as_deref(), Some(PNG));
    assert_eq!(r.image_link.as_deref(), Some("file:image1.png"));
    // 2 px shown 400 pt wide (twice the frame, half of it cropped away),
    // 1 px 100 pt tall.
    assert_eq!(
        r.image_item_transform,
        Some([200.0, 0.0, 0.0, 100.0, 0.0, 0.0])
    );
    // A plain box: the bounds say it, no path is kept.
    assert!(r.anchors.is_empty());
    assert_eq!(
        (r.bounds.left, r.bounds.top, r.bounds.right, r.bounds.bottom),
        (0.0, 0.0, 200.0, 100.0)
    );
    assert_eq!(
        written.elements.get("u2"),
        Some(&("rectangle", "u2".to_string()))
    );

    // Bytes that are no picture are reported, not placed.
    let broken = |_: &str| Some(b"not an image".to_vec());
    let written = slide_native::write(&deck, &broken, "picture").unwrap();
    assert_eq!(written.diagnostics.len(), 1);
    assert!(open(&written.paged).document.spreads[0]
        .spread
        .rectangles
        .is_empty());
}

/// The model part as JSON with its maps in key order (the part writes a
/// map in the order the map holds it).
fn model_json(doc: &paged_scene::Document) -> serde_json::Value {
    serde_json::from_slice(&paged_store::to_bytes(doc).unwrap()).unwrap()
}

#[test]
fn the_document_is_deterministic() {
    let (_, a) = build("tables");
    let (_, b) = build("tables");
    assert_eq!(
        model_json(&open(&a.paged).document),
        model_json(&open(&b.paged).document)
    );
}

#[test]
fn a_slides_timing_rides_its_page_with_the_elements_its_shapes_became() {
    // Slide ADR 714: the timing in the page label names, for each shape
    // target, the page element the shape became and its shape key.
    let (deck, written) = build("motion");
    let doc = open(&written.paged).document;
    let elements: std::collections::BTreeSet<String> = written
        .elements
        .values()
        .map(|(_, id)| id.clone())
        .collect();
    let mut targets = 0;
    for (s, slide) in doc.spreads.iter().zip(&deck.slides) {
        let Some(label) = s.spread.labels.get(&slide.id).map(|l| l[0].1.clone()) else {
            continue;
        };
        let env: serde_json::Value = serde_json::from_str(&label).unwrap();
        let Some(t) = env["data"].get("timing") else {
            assert!(slide.timing.is_none(), "{}", slide.part);
            continue;
        };
        let mut t: pptx_core::anim::Timing = serde_json::from_value(t.clone()).unwrap();
        // Without the document's names it is the deck's timing.
        assert_eq!(&t.without_document_names(), slide.timing.as_ref().unwrap());
        t.for_each_sp_target(&mut |spid, item, key| {
            targets += 1;
            assert_eq!(
                key.as_deref(),
                Some(format!("{}#{spid}", slide.part).as_str())
            );
            let item = item.as_deref().expect("a top-level shape's element");
            assert!(elements.contains(item), "{item}");
        });
    }
    // Four builds on slide 5: three effects' behaviours and four bldP.
    assert!(targets >= 8, "{targets}");
}
