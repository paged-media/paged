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

//! Review comments (slide ADR 711): modern threaded comments and legacy
//! ones read; an unchanged deck keeps its bytes; added, replied, resolved and
//! deleted comments are written as modern comment parts and read back the
//! same; a duplicate gets its own part; legacy comments convert.
//!
//! The decks are `text.pptx` with comment parts added in the form PowerPoint
//! 16 writes them (checked by opening and re-saving them in PowerPoint,
//! which kept every part as given).

use std::collections::BTreeMap;
use std::path::PathBuf;

use pptx_core::{Comment, CommentReply};
use pptx_export::{export, ExportPlan, SlidePlan};

const P188: &str = "http://schemas.microsoft.com/office/powerpoint/2018/8/main";
const ADA: &str = "{11111111-2222-3333-4444-555555555555}";
const GRACE: &str = "{66666666-7777-8888-9999-AAAAAAAAAAAA}";

fn fixture(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../slide-conformance/fixtures/{name}.pptx"));
    std::fs::read(p).unwrap()
}

/// Keep a written deck for PowerPoint's open-check (ADR 705) when
/// `PAGED_SLIDE_EXPORT_DIR` names a folder.
fn keep(bytes: &[u8], name: &str) {
    if let Ok(dir) = std::env::var("PAGED_SLIDE_EXPORT_DIR") {
        std::fs::write(PathBuf::from(dir).join(format!("{name}.pptx")), bytes).unwrap();
    }
}

fn get(pkg: &paged_ooxml::opc::OpcPackage, part: &str) -> String {
    String::from_utf8(pkg.part(part).unwrap().to_vec()).unwrap()
}

fn add_rel(pkg: &mut paged_ooxml::opc::OpcPackage, rels: &str, id: &str, ty: &str, target: &str) {
    let r = get(pkg, rels).replace(
        "</Relationships>",
        &format!(r#"<Relationship Id="{id}" Type="{ty}" Target="{target}"/></Relationships>"#),
    );
    pkg.set_part(rels, r.into_bytes());
}

fn add_type(pkg: &mut paged_ooxml::opc::OpcPackage, part: &str, ct: &str) {
    let t = get(pkg, "[Content_Types].xml").replace(
        "</Types>",
        &format!(r#"<Override PartName="/{part}" ContentType="{ct}"/></Types>"#),
    );
    pkg.set_part("[Content_Types].xml", t.into_bytes());
}

fn body(text: &str) -> String {
    format!(
        r#"<p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>{text}</a:t></a:r></a:p></p188:txBody>"#
    )
}

/// `text.pptx` with modern comments: on slide 1 one positioned comment
/// with a reply; on slide 2 one resolved comment anchored to shape 3.
fn modern_deck() -> Vec<u8> {
    let mut pkg = paged_ooxml::opc::OpcPackage::read(&fixture("text")).unwrap();
    pkg.set_part(
        "ppt/authors.xml",
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p188:authorLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p188="{P188}"><p188:author id="{ADA}" name="Ada Lovelace" initials="AL" userId="Ada Lovelace" providerId="None"/><p188:author id="{GRACE}" name="Grace Hopper" initials="GH" userId="Grace Hopper" providerId="None"/></p188:authorLst>"#
        )
        .into_bytes(),
    );
    let head = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p188:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p188="{P188}">"#
    );
    let one = format!(
        r#"{head}<p188:cm id="{{AAAAAAAA-0000-0000-0000-000000000001}}" authorId="{ADA}" created="2026-10-20T10:00:00.000"><pc:sldMkLst xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"><pc:docMk/><pc:sldMk cId="3952087630" sldId="256"/></pc:sldMkLst><p188:pos x="1270000" y="635000"/><p188:replyLst><p188:reply id="{{AAAAAAAA-0000-0000-0000-000000000002}}" authorId="{GRACE}" created="2026-10-20T11:00:00.000">{}</p188:reply></p188:replyLst>{}</p188:cm></p188:cmLst>"#,
        body("A reply"),
        body("Hello comment")
    );
    let two = format!(
        r#"{head}<p188:cm id="{{BBBBBBBB-0000-0000-0000-000000000001}}" authorId="{GRACE}" status="resolved" created="2026-10-21T09:30:00.000"><ac:deMkLst xmlns:ac="http://schemas.microsoft.com/office/drawing/2013/main/command"><pc:docMk xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"/><pc:sldMk xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command" cId="0" sldId="257"/><ac:spMk id="3" creationId="{{7BCA0EFE-82A1-57ED-4E79-D97BC846DFFF}}"/></ac:deMkLst>{}</p188:cm></p188:cmLst>"#,
        body("Centre this &amp; that")
    );
    for (n, slide, xml) in [(1, 256, one), (2, 257, two)] {
        let part = format!("ppt/comments/modernComment_{slide:X}_{n}.xml");
        pkg.set_part(&part, xml.into_bytes());
        add_type(
            &mut pkg,
            &part,
            "application/vnd.ms-powerpoint.comments+xml",
        );
        add_rel(
            &mut pkg,
            &format!("ppt/slides/_rels/slide{n}.xml.rels"),
            "rId77",
            "http://schemas.microsoft.com/office/2018/10/relationships/comments",
            &format!("../comments/modernComment_{slide:X}_{n}.xml"),
        );
        let sp = format!("ppt/slides/slide{n}.xml");
        let s = get(&pkg, &sp).replace(
            "</p:sld>",
            &format!(r#"<p:extLst><p:ext uri="{{6950BFC3-D8DA-4A85-94F7-54DA5524770B}}"><p188:commentRel xmlns:p188="{P188}" r:id="rId77"/></p:ext></p:extLst></p:sld>"#),
        );
        pkg.set_part(&sp, s.into_bytes());
    }
    add_rel(
        &mut pkg,
        "ppt/_rels/presentation.xml.rels",
        "rId77",
        "http://schemas.microsoft.com/office/2018/10/relationships/authors",
        "authors.xml",
    );
    add_type(
        &mut pkg,
        "ppt/authors.xml",
        "application/vnd.ms-powerpoint.authors+xml",
    );
    pkg.write().unwrap()
}

/// `text.pptx` with one legacy comment on slide 1.
fn legacy_deck() -> Vec<u8> {
    let mut pkg = paged_ooxml::opc::OpcPackage::read(&fixture("text")).unwrap();
    pkg.set_part(
        "ppt/commentAuthors.xml",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmAuthorLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="0" name="Bob Legacy" initials="BL" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>"#
            .to_vec(),
    );
    pkg.set_part(
        "ppt/comments/comment1.xml",
        br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cm authorId="0" dt="2026-10-19T09:00:00.000" idx="1"><p:pos x="800" y="400"/><p:text>Legacy note</p:text></p:cm></p:cmLst>"#
            .to_vec(),
    );
    add_rel(
        &mut pkg,
        "ppt/slides/_rels/slide1.xml.rels",
        "rId77",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
        "../comments/comment1.xml",
    );
    add_rel(
        &mut pkg,
        "ppt/_rels/presentation.xml.rels",
        "rId77",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors",
        "commentAuthors.xml",
    );
    add_type(
        &mut pkg,
        "ppt/commentAuthors.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml",
    );
    add_type(
        &mut pkg,
        "ppt/comments/comment1.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.comments+xml",
    );
    pkg.write().unwrap()
}

/// The plan of the deck as it is, comments included.
fn as_is(bytes: &[u8]) -> ExportPlan {
    let ir = pptx_import::import_pptx(bytes).unwrap();
    ExportPlan {
        slides: ir
            .slides
            .iter()
            .map(|s| SlidePlan {
                source_part: s.part.clone(),
                hidden: s.hidden,
                notes: s
                    .notes
                    .as_ref()
                    .map(slide_resolve::text::plain)
                    .filter(|n| !n.trim().is_empty()),
                comments: Some(s.comments.clone()),
                ..SlidePlan::default()
            })
            .collect(),
    }
}

/// Comments the way the bundle hands them back: through JSON, so the
/// verbatim XML kept beside them is gone.
fn through_json(c: &[Comment]) -> Vec<Comment> {
    serde_json::from_str(&serde_json::to_string(c).unwrap()).unwrap()
}

fn comments_of(bytes: &[u8]) -> Vec<Vec<Comment>> {
    pptx_import::import_pptx(bytes)
        .unwrap()
        .slides
        .into_iter()
        .map(|s| through_json(&s.comments))
        .collect()
}

fn parts(bytes: &[u8]) -> BTreeMap<String, Vec<u8>> {
    let pkg = paged_ooxml::opc::OpcPackage::read(bytes).unwrap();
    pkg.file_names()
        .map(|n| (n.to_string(), pkg.part(n).unwrap().to_vec()))
        .collect()
}

fn changed_parts(a: &[u8], b: &[u8]) -> Vec<String> {
    let (a, b) = (parts(a), parts(b));
    let mut names: Vec<&String> = a.keys().chain(b.keys()).collect();
    names.sort();
    names.dedup();
    names
        .into_iter()
        .filter(|n| a.get(*n) != b.get(*n))
        .cloned()
        .collect()
}

#[test]
fn modern_comments_are_read_with_replies_status_position_and_anchor() {
    let ir = pptx_import::import_pptx(&modern_deck()).unwrap();
    let one = &ir.slides[0].comments;
    assert_eq!(one.len(), 1);
    let c = &one[0];
    assert_eq!(c.id, "{AAAAAAAA-0000-0000-0000-000000000001}");
    assert_eq!(c.author, "Ada Lovelace");
    assert_eq!(c.initials, "AL");
    assert_eq!(c.author_id, ADA);
    assert_eq!(c.created.as_deref(), Some("2026-10-20T10:00:00.000"));
    assert_eq!(c.text, "Hello comment");
    assert_eq!((c.x, c.y), (Some(100.0), Some(50.0)));
    assert_eq!(c.shape_id, None);
    assert_eq!(c.status, None);
    assert!(!c.legacy);
    assert_eq!(
        c.replies,
        vec![CommentReply {
            id: "{AAAAAAAA-0000-0000-0000-000000000002}".into(),
            author_id: GRACE.into(),
            author: "Grace Hopper".into(),
            initials: "GH".into(),
            created: Some("2026-10-20T11:00:00.000".into()),
            text: "A reply".into(),
        }]
    );
    let two = &ir.slides[1].comments;
    assert_eq!(two.len(), 1);
    assert_eq!(two[0].status.as_deref(), Some("resolved"));
    assert_eq!(two[0].shape_id, Some(3));
    assert_eq!(two[0].text, "Centre this & that");
    assert_eq!((two[0].x, two[0].y), (None, None));
    assert!(ir.slides[2].comments.is_empty());
}

#[test]
fn the_comment_json_is_camel_case_and_has_every_field() {
    let ir = pptx_import::import_pptx(&modern_deck()).unwrap();
    let v: serde_json::Value = serde_json::to_value(&ir.slides[0].comments[0]).unwrap();
    for key in [
        "id", "authorId", "author", "initials", "created", "text", "x", "y", "shapeId", "status",
        "replies", "legacy",
    ] {
        assert!(v.get(key).is_some(), "{key} missing in {v}");
    }
    assert!(v.get("raw").is_none() && v.get("markerXml").is_none());
    // The bundle may leave fields out.
    let c: Comment = serde_json::from_str(r#"{"id":"x","text":"t"}"#).unwrap();
    assert_eq!(c.text, "t");
}

#[test]
fn legacy_comments_are_read() {
    let ir = pptx_import::import_pptx(&legacy_deck()).unwrap();
    let c = &ir.slides[0].comments;
    assert_eq!(c.len(), 1);
    assert_eq!(c[0].id, "legacy-0-1");
    assert_eq!(c[0].author_id, "legacy-0");
    assert_eq!(c[0].author, "Bob Legacy");
    assert_eq!(c[0].initials, "BL");
    assert_eq!(c[0].text, "Legacy note");
    assert_eq!(c[0].created.as_deref(), Some("2026-10-19T09:00:00.000"));
    assert_eq!((c[0].x, c[0].y), (Some(100.0), Some(50.0)));
    assert!(c[0].legacy);
}

#[test]
fn an_unchanged_deck_with_comments_is_its_original_bytes() {
    for bytes in [modern_deck(), legacy_deck()] {
        // The comments as the bundle hands them back (through JSON).
        let mut plan = as_is(&bytes);
        for s in &mut plan.slides {
            s.comments = s.comments.as_deref().map(through_json);
        }
        let out = export(&bytes, &plan).unwrap();
        assert!(
            out.bytes == bytes,
            "not byte-identical: {:?}",
            out.diagnostics
        );
        // And without any comments in the plan (an older bundle).
        for s in &mut plan.slides {
            s.comments = None;
        }
        assert!(export(&bytes, &plan).unwrap().bytes == bytes);
    }
}

#[test]
fn added_replied_resolved_and_deleted_comments_read_back() {
    let bytes = modern_deck();
    let mut plan = as_is(&bytes);
    let mut want = comments_of(&bytes);
    // Slide 1: a reply to its comment, and a new comment by a new author.
    want[0][0].replies.push(CommentReply {
        id: "{CCCCCCCC-0000-0000-0000-000000000001}".into(),
        author_id: "{DDDDDDDD-0000-0000-0000-000000000001}".into(),
        author: "Katherine Johnson".into(),
        initials: "KJ".into(),
        created: Some("2026-10-25T08:00:00.000".into()),
        text: "Agreed <3".into(),
    });
    want[0].push(Comment {
        id: "{CCCCCCCC-0000-0000-0000-000000000002}".into(),
        author_id: "{DDDDDDDD-0000-0000-0000-000000000001}".into(),
        author: "Katherine Johnson".into(),
        initials: "KJ".into(),
        created: Some("2026-10-25T08:01:00.000".into()),
        text: "Two lines\nof text".into(),
        x: Some(200.0),
        y: Some(120.5),
        ..Comment::default()
    });
    // Slide 2: resolved → active again, anchored to shape 4 now.
    want[1][0].status = None;
    want[1][0].shape_id = Some(4);
    // Slide 3: a comment; slide 4 untouched.
    want[2].push(Comment {
        id: "{CCCCCCCC-0000-0000-0000-000000000003}".into(),
        author_id: ADA.into(),
        author: "Ada Lovelace".into(),
        initials: "AL".into(),
        created: Some("2026-10-25T09:00:00.000".into()),
        text: "Resolved later".into(),
        status: Some("resolved".into()),
        ..Comment::default()
    });
    for (s, w) in plan.slides.iter_mut().zip(&want) {
        s.comments = Some(w.clone());
    }
    let out = export(&bytes, &plan).unwrap();
    assert!(out.diagnostics.is_empty(), "{:?}", out.diagnostics);
    keep(&out.bytes, "comments-edited");
    assert_eq!(comments_of(&out.bytes), want);
    // Slide 4 and everything not about comments kept their bytes.
    let changed = changed_parts(&bytes, &out.bytes);
    assert!(
        changed.iter().all(|p| p.contains("comment")
            || p.contains("authors")
            || p == "[Content_Types].xml"
            || p.starts_with("ppt/slides/slide1")
            || p.starts_with("ppt/slides/slide2")
            || p.starts_with("ppt/slides/slide3")
            || p.starts_with("ppt/slides/_rels/slide1")
            || p.starts_with("ppt/slides/_rels/slide2")
            || p.starts_with("ppt/slides/_rels/slide3")),
        "{changed:?}"
    );
    let pkg = paged_ooxml::opc::OpcPackage::read(&out.bytes).unwrap();
    // The replaced parts are gone, with their content types.
    assert!(pkg.part("ppt/comments/modernComment_100_1.xml").is_none());
    let ct = get(&pkg, "[Content_Types].xml");
    assert!(!ct.contains("modernComment_100_1.xml"), "{ct}");
    // The new author joined the deck's authors; the old entries kept.
    let authors = get(&pkg, "ppt/authors.xml");
    assert!(
        authors.contains(r#"name="Katherine Johnson" initials="KJ""#),
        "{authors}"
    );
    assert!(authors.contains(&format!(r#"<p188:author id="{ADA}" name="Ada Lovelace""#)));
    // Each written part parses, and an anchored comment names its shape.
    for (n, p) in pkg
        .file_names()
        .filter(|n| n.contains("modernComment"))
        .enumerate()
    {
        paged_ooxml::tree::parse(pkg.part(p).unwrap()).unwrap_or_else(|e| panic!("{n} {p}: {e}"));
    }
    let slide2_rels = get(&pkg, "ppt/slides/_rels/slide2.xml.rels");
    let target = slide2_rels
        .split("Target=\"../comments/")
        .nth(1)
        .and_then(|t| t.split('"').next())
        .unwrap();
    let two = get(&pkg, &format!("ppt/comments/{target}"));
    assert!(
        two.contains(r#"<ac:spMk id="4" creationId="{5D199FF2-CF35-5C77-8FAD-2C4733040876}"/>"#),
        "{two}"
    );
    assert!(two.contains(r#"sldId="257""#), "{two}");
    // Slide 1's unchanged-anchor comment kept its markers; its slide
    // names the part once.
    let s1 = get(&pkg, "ppt/slides/slide1.xml");
    assert_eq!(s1.matches("p188:commentRel").count(), 1, "{s1}");
}

#[test]
fn deleting_every_comment_removes_the_parts_and_the_extension() {
    let bytes = modern_deck();
    let mut plan = as_is(&bytes);
    for s in &mut plan.slides {
        s.comments = Some(Vec::new());
    }
    let out = export(&bytes, &plan).unwrap();
    keep(&out.bytes, "comments-deleted");
    assert!(comments_of(&out.bytes).iter().all(Vec::is_empty));
    let pkg = paged_ooxml::opc::OpcPackage::read(&out.bytes).unwrap();
    assert!(!pkg.file_names().any(|n| n.contains("modernComment")));
    let s1 = get(&pkg, "ppt/slides/slide1.xml");
    assert!(!s1.contains("commentRel"), "{s1}");
    // The slide without comments is its original slide again.
    assert_eq!(
        s1,
        get(
            &paged_ooxml::opc::OpcPackage::read(&fixture("text")).unwrap(),
            "ppt/slides/slide1.xml"
        )
    );
    assert!(!get(&pkg, "[Content_Types].xml").contains("modernComment"));
}

#[test]
fn a_duplicated_slide_gets_its_own_comment_part() {
    let bytes = modern_deck();
    let mut plan = as_is(&bytes);
    // Slide 1 twice: the copy without comments in the plan keeps the
    // deck's (as an older bundle would), written as its own part.
    let mut copy = plan.slides[0].clone();
    copy.comments = None;
    plan.slides.insert(1, copy);
    let out = export(&bytes, &plan).unwrap();
    keep(&out.bytes, "comments-duplicate");
    let back = comments_of(&out.bytes);
    assert_eq!(back.len(), 5);
    assert_eq!(back[0], back[1]);
    let pkg = paged_ooxml::opc::OpcPackage::read(&out.bytes).unwrap();
    let targets: Vec<String> = pkg
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/_rels/"))
        .flat_map(|n| {
            get(&pkg, n)
                .split("Target=\"../comments/")
                .skip(1)
                .filter_map(|t| t.split('"').next().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .collect();
    let mut unique = targets.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        targets.len(),
        unique.len(),
        "a comment part is shared: {targets:?}"
    );
    assert_eq!(targets.len(), 3, "{targets:?}");

    // The copy with an empty list has none.
    let mut plan = as_is(&bytes);
    let mut copy = plan.slides[0].clone();
    copy.comments = Some(Vec::new());
    plan.slides.insert(1, copy);
    let back = comments_of(&export(&bytes, &plan).unwrap().bytes);
    assert_eq!(back[0].len(), 1);
    assert!(back[1].is_empty());
}

#[test]
fn legacy_comments_become_modern_ones_when_their_slide_changes() {
    let bytes = legacy_deck();
    let mut plan = as_is(&bytes);
    let mut list = through_json(plan.slides[0].comments.as_ref().unwrap());
    list[0].replies.push(CommentReply {
        id: "r1".into(),
        author_id: "legacy-0".into(),
        author: "Bob Legacy".into(),
        initials: "BL".into(),
        created: Some("2026-10-25T10:00:00.000".into()),
        text: "Answered".into(),
    });
    plan.slides[0].comments = Some(list);
    let out = export(&bytes, &plan).unwrap();
    keep(&out.bytes, "comments-legacy");
    let pkg = paged_ooxml::opc::OpcPackage::read(&out.bytes).unwrap();
    assert!(pkg.part("ppt/comments/comment1.xml").is_none());
    assert!(!get(&pkg, "ppt/slides/_rels/slide1.xml.rels").contains("2006/relationships/comments"));
    let back = &comments_of(&out.bytes)[0];
    assert_eq!(back.len(), 1);
    let c = &back[0];
    assert!(!c.legacy);
    assert!(pptx_export::comments::is_guid(&c.id), "{}", c.id);
    assert_eq!(c.author, "Bob Legacy");
    assert_eq!(c.text, "Legacy note");
    assert_eq!((c.x, c.y), (Some(100.0), Some(50.0)));
    assert_eq!(c.replies.len(), 1);
    assert_eq!(c.replies[0].text, "Answered");
    assert_eq!(c.replies[0].author_id, c.author_id);
    // The deck had no modern authors list: one is made and named.
    assert!(get(&pkg, "ppt/authors.xml").contains(r#"name="Bob Legacy""#));
    assert!(get(&pkg, "ppt/_rels/presentation.xml.rels").contains("2018/10/relationships/authors"));
    assert!(get(&pkg, "[Content_Types].xml").contains("application/vnd.ms-powerpoint.authors+xml"));
}

#[test]
fn a_comment_on_a_deck_without_any_is_written() {
    let bytes = fixture("text");
    let mut plan = as_is(&bytes);
    plan.slides[3].comments = Some(vec![Comment {
        id: "new-1".into(),
        author_id: "".into(),
        author: "Editor".into(),
        initials: "E".into(),
        created: Some("2026-10-25T12:00:00.000".into()),
        text: "First".into(),
        x: Some(10.0),
        y: Some(20.0),
        ..Comment::default()
    }]);
    let out = export(&bytes, &plan).unwrap();
    keep(&out.bytes, "comments-new");
    let back = comments_of(&out.bytes);
    assert_eq!(back[3].len(), 1);
    assert_eq!(back[3][0].author, "Editor");
    assert_eq!(back[3][0].text, "First");
    assert_eq!((back[3][0].x, back[3][0].y), (Some(10.0), Some(20.0)));
    // Only slide 4, its rels, the new parts and the package lists changed.
    let changed = changed_parts(&bytes, &out.bytes);
    assert!(
        changed.iter().all(|p| p.starts_with("ppt/slides/slide4")
            || p.starts_with("ppt/slides/_rels/slide4")
            || p.starts_with("ppt/comments/")
            || p == "ppt/authors.xml"
            || p == "ppt/_rels/presentation.xml.rels"
            || p == "[Content_Types].xml"),
        "{changed:?}"
    );
}

/// The `comments` fixture: the seeded deck as PowerPoint re-saved it.
/// PowerPoint converted slide 3's legacy comment into a modern one, at the
/// same place: legacy `p:pos` (800, 400) became `p188:pos` (1270000,
/// 635000), so legacy positions are eighths of a point and modern ones EMU.
#[test]
fn the_powerpoint_saved_comments_fixture_reads_and_exports_unchanged() {
    let bytes = fixture("comments");
    let c = comments_of(&bytes);
    assert_eq!(c.len(), 10);
    assert_eq!(c[0].len(), 1);
    assert_eq!(c[0][0].id, "{C0C0C0C0-0000-4000-8000-000000000001}");
    assert_eq!(c[0][0].author, "Ada Lovelace");
    assert_eq!(c[0][0].text, "Check the title");
    assert_eq!((c[0][0].x, c[0][0].y), (Some(100.0), Some(50.0)));
    assert_eq!(c[0][0].replies.len(), 1);
    assert_eq!(c[0][0].replies[0].author, "Grace Hopper");
    assert_eq!(c[0][0].replies[0].text, "Done");
    assert_eq!(c[1][0].text, "Shorter title?");
    assert_eq!(c[1][0].status.as_deref(), Some("resolved"));
    assert_eq!(c[1][0].shape_id, Some(4));
    assert_eq!(c[2][0].author, "Bob Legacy");
    assert_eq!(c[2][0].text, "Legacy note");
    assert_eq!((c[2][0].x, c[2][0].y), (Some(100.0), Some(50.0)));
    assert!(!c[2][0].legacy);
    assert!(c[3..].iter().all(Vec::is_empty));
    let mut plan = as_is(&bytes);
    for s in &mut plan.slides {
        s.comments = s.comments.as_deref().map(through_json);
    }
    assert!(export(&bytes, &plan).unwrap().bytes == bytes);
}
