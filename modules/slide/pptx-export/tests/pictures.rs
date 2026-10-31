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

//! Pictures in every format the engine reads (slide W4): a picture placed
//! in the editor is written as PowerPoint holds it. PNG, JPEG, GIF, BMP and
//! TIFF go as they are, with their content types; an SVG goes as an
//! `asvg:svgBlip` beside a PNG fallback and reads back as the SVG; any
//! other format goes as the PNG of the frame the host renders. Pictures
//! are header-only files: export and import read no pixel.

use std::collections::BTreeMap;
use std::path::PathBuf;

use paged_model::{Bounds, FrameRef, Rectangle};
use paged_scene::Document;
use pptx_export::{export_with, native, ExportPlan, Exported, SlidePlan};

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

fn imported(bytes: &[u8]) -> Document {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    let deck = slide_resolve::resolve(&ir);
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    let images = |p: &str| pkg.part(p).map(|b| b.to_vec());
    slide_native::build(&deck, &images, "deck").document
}

fn plan_of(doc: &Document) -> ExportPlan {
    ExportPlan {
        slides: doc
            .spreads
            .iter()
            .filter_map(|s| {
                let page = s.spread.pages.first()?;
                let id = page.self_id.clone()?;
                let st = native::page_state(&s.spread, &id);
                Some(SlidePlan {
                    source_part: st["part"].as_str().unwrap_or("").to_string(),
                    page_id: Some(id),
                    ..SlidePlan::default()
                })
            })
            .collect(),
        ..ExportPlan::default()
    }
}

fn export(bytes: &[u8], doc: &Document, rasters: &BTreeMap<String, Vec<u8>>) -> Exported {
    use base64::Engine;
    let paged = paged_store::package::wrap_document(doc, "deck", 960.0, 540.0).unwrap();
    let mut plan = plan_of(doc);
    plan.rasters = rasters
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                base64::engine::general_purpose::STANDARD.encode(v),
            )
        })
        .collect();
    export_with(bytes, &plan, Some(&paged)).unwrap()
}

fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(format!("{name}.pptx")), bytes).unwrap();
    }
}

fn part(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    pkg.part(name).map(<[u8]>::to_vec)
}

fn text(bytes: &[u8], name: &str) -> String {
    String::from_utf8(part(bytes, name).unwrap()).unwrap()
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    b.extend(w.to_be_bytes());
    b.extend(h.to_be_bytes());
    b.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    b
}

fn bmp(w: i32, h: i32) -> Vec<u8> {
    let mut b = vec![0u8; 58];
    b[..2].copy_from_slice(b"BM");
    b[14..18].copy_from_slice(&40u32.to_le_bytes());
    b[18..22].copy_from_slice(&w.to_le_bytes());
    b[22..26].copy_from_slice(&h.to_le_bytes());
    b
}

fn tiff(w: u16, h: u16) -> Vec<u8> {
    let mut b = b"II*\0\x08\0\0\0\x02\0".to_vec();
    b.extend([0, 1, 3, 0, 1, 0, 0, 0]);
    b.extend(w.to_le_bytes());
    b.extend([0, 0]);
    b.extend([1, 1, 3, 0, 1, 0, 0, 0]);
    b.extend(h.to_le_bytes());
    b.extend([0, 0, 0, 0, 0, 0]);
    b
}

const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 96 48"><rect width="96" height="48" fill="#4472c4"/></svg>"##;

/// Place `bytes` on page 1 as a new picture frame at (100, 80), 120 × 60.
fn place(doc: &mut Document, id: &str, bytes: Vec<u8>) {
    let sp = &mut doc.spreads[0].spread;
    let r = Rectangle {
        item_transform: Some([1.0, 0.0, 0.0, 1.0, 100.0, 80.0]),
        image_bytes: Some(bytes),
        ..Rectangle::new(
            id,
            Bounds {
                top: 0.0,
                left: 0.0,
                bottom: 60.0,
                right: 120.0,
            },
        )
    };
    sp.rectangles.push(r);
    sp.frames_in_order
        .push(FrameRef::Rectangle(sp.rectangles.len() - 1));
}

/// The image parts of slide 1's last picture: the blip's target, and the
/// SVG's when it has one.
fn last_picture(out: &[u8]) -> (String, String, Option<String>) {
    let slide = text(out, "ppt/slides/slide1.xml");
    let pic = &slide[slide.rfind("<p:pic>").expect("a picture")..];
    let pic = &pic[..pic.find("</p:pic>").unwrap()];
    let rels = paged_ooxml::rels::Relationships::parse(
        &part(out, "ppt/slides/_rels/slide1.xml.rels").unwrap(),
    );
    let target = |rid: &str| {
        let r = rels.by_id(rid).expect("the relationship");
        paged_ooxml::rels::resolve_target("ppt/slides", &r.target)
    };
    let attr = |s: &str, at: &str| {
        let i = s.find(at).unwrap() + at.len();
        s[i..i + s[i..].find('"').unwrap()].to_string()
    };
    let blip = target(&attr(pic, "<a:blip r:embed=\""));
    let svg = pic
        .find("<asvg:svgBlip")
        .map(|i| target(&attr(&pic[i..], "r:embed=\"")));
    (pic.to_string(), blip, svg)
}

#[test]
fn deck_formats_are_written_as_they_are_with_their_content_types() {
    let bytes = fixture("geometry");
    for (name, pic, ext, ct) in [
        ("png", png(40, 20), "png", "image/png"),
        (
            "jpeg",
            b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x14\x00\x28\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01\xff\xd9".to_vec(),
            "jpeg",
            "image/jpeg",
        ),
        ("gif", b"GIF89a\x28\0\x14\0\x80\0\0".to_vec(), "gif", "image/gif"),
        ("bmp", bmp(40, -20), "bmp", "image/bmp"),
        ("tiff", tiff(40, 20), "tiff", "image/tiff"),
    ] {
        let mut doc = imported(&bytes);
        place(&mut doc, "newpic", pic.clone());
        let out = export(&bytes, &doc, &BTreeMap::new());
        keep(&out.bytes, &format!("picture-{name}"));
        assert!(out.not_exported.is_empty(), "{name}: {:?}", out.not_exported);
        assert!(out.rasters_needed.is_empty(), "{name}");
        let (_, blip, svg) = last_picture(&out.bytes);
        assert!(blip.ends_with(&format!(".{ext}")), "{name}: {blip}");
        assert_eq!(part(&out.bytes, &blip).unwrap(), pic, "{name}");
        assert!(svg.is_none());
        let ct_xml = text(&out.bytes, "[Content_Types].xml").to_ascii_lowercase();
        assert!(
            ct_xml.contains(&format!(r#"extension="{ext}" contenttype="{ct}""#)),
            "{name}: {ct_xml}"
        );
        // It reads back as a picture of the same box.
        let deck = slide_resolve::resolve(&pptx_import::import_pptx(&out.bytes).unwrap());
        let it = deck.slides[0].items.last().unwrap();
        assert!(
            matches!(&it.kind, slide_resolve::model::ItemKind::Picture { image_part, .. } if *image_part == blip),
            "{name}"
        );
        assert!((it.w - 120.0).abs() < 0.05 && (it.h - 60.0).abs() < 0.05);
    }
}

#[test]
fn an_svg_is_written_with_a_png_fallback_and_reads_back_as_the_svg() {
    let bytes = fixture("geometry");
    let mut doc = imported(&bytes);
    place(&mut doc, "newsvg", SVG.as_bytes().to_vec());
    // Before the host rendered the fallback: the SVG is written, and its
    // PNG asked for.
    let first = export(&bytes, &doc, &BTreeMap::new());
    assert_eq!(first.rasters_needed.len(), 1);
    assert_eq!(first.rasters_needed[0].0, "newsvg");
    assert!((first.rasters_needed[0].1 - 192.0).abs() < 1e-6);
    // With it.
    let fallback = png(240, 120);
    let rasters = BTreeMap::from([("newsvg".to_string(), fallback.clone())]);
    let out = export(&bytes, &doc, &rasters);
    keep(&out.bytes, "picture-svg");
    assert!(out.rasters_needed.is_empty());
    assert!(out.not_exported.is_empty(), "{:?}", out.not_exported);
    let (pic, blip, svg) = last_picture(&out.bytes);
    assert!(pic.contains(r#"<a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main""#), "{pic}");
    assert!(blip.ends_with(".png"));
    assert_eq!(part(&out.bytes, &blip).unwrap(), fallback);
    let svg = svg.expect("an svgBlip");
    assert!(svg.ends_with(".svg"));
    assert_eq!(part(&out.bytes, &svg).unwrap(), SVG.as_bytes());
    let ct = text(&out.bytes, "[Content_Types].xml");
    assert!(
        ct.contains(r#"Extension="svg" ContentType="image/svg+xml""#),
        "{ct}"
    );
    // Import draws the SVG, not the fallback.
    let deck = slide_resolve::resolve(&pptx_import::import_pptx(&out.bytes).unwrap());
    let it = deck.slides[0].items.last().unwrap();
    match &it.kind {
        slide_resolve::model::ItemKind::Picture { image_part, .. } => assert_eq!(*image_part, svg),
        k => panic!("{k:?}"),
    }
    // And a document built from it places the SVG and exports its own bytes.
    let again = imported(&out.bytes);
    let paged = paged_store::package::wrap_document(&again, "deck", 960.0, 540.0).unwrap();
    let same = export_with(&out.bytes, &plan_of(&again), Some(&paged)).unwrap();
    assert_eq!(same.bytes, out.bytes);
}

#[test]
fn another_format_is_written_as_the_png_the_host_renders() {
    let bytes = fixture("geometry");
    let webp = b"RIFF\x1a\0\0\0WEBPVP8L\x0d\0\0\0\x2f\0\0\0\x10\x07\x10\x11\x11\x88\x88\xfe\x07\0"
        .to_vec();
    let mut psd = b"8BPS\0\x01\0\0\0\0\0\0\0\x03".to_vec();
    psd.extend(20u32.to_be_bytes());
    psd.extend(40u32.to_be_bytes());
    psd.extend([0, 8, 0, 3]);
    for (name, pic) in [("webp", webp), ("psd", psd)] {
        let mut doc = imported(&bytes);
        place(&mut doc, "newpic", pic);
        let first = export(&bytes, &doc, &BTreeMap::new());
        assert_eq!(first.rasters_needed.len(), 1, "{name}");
        assert!(
            first
                .not_exported
                .iter()
                .any(|n| n.contains("no PNG of it was rendered")),
            "{name}: {:?}",
            first.not_exported
        );
        let rendered = png(120, 60);
        let rasters = BTreeMap::from([("newpic".to_string(), rendered.clone())]);
        let out = export(&bytes, &doc, &rasters);
        keep(&out.bytes, &format!("picture-{name}"));
        assert!(
            out.not_exported.is_empty(),
            "{name}: {:?}",
            out.not_exported
        );
        let (pic, blip, svg) = last_picture(&out.bytes);
        assert!(svg.is_none() && !pic.contains("a:srcRect"), "{name}: {pic}");
        assert_eq!(part(&out.bytes, &blip).unwrap(), rendered);
        // No part of the original format is written.
        let pkg = paged_ooxml::opc::OpcPackage::read(&out.bytes).unwrap();
        assert!(!pkg.file_names().any(|n| n.ends_with(&format!(".{name}"))));
    }
}

#[test]
fn a_raster_is_rendered_at_its_own_pixel_density() {
    let bytes = fixture("geometry");
    let mut doc = imported(&bytes);
    // 480 px shown over 120 pt: 4 px a point, 288 dpi.
    let mut q = b"qoif".to_vec();
    q.extend(480u32.to_be_bytes());
    q.extend(240u32.to_be_bytes());
    q.extend([4, 0]);
    place(&mut doc, "q", q);
    let out = export(&bytes, &doc, &BTreeMap::new());
    assert_eq!(out.rasters_needed.len(), 1);
    assert!(
        (out.rasters_needed[0].1 - 288.0).abs() < 1e-6,
        "{:?}",
        out.rasters_needed
    );
}
