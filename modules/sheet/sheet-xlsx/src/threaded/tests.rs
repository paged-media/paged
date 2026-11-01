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

//! Threaded comments: read, every write, round trips.

use super::*;
use std::io::{Read, Write};

const P1: &str = "{11111111-2222-3333-4444-555555555555}";
const P2: &str = "{66666666-7777-8888-9999-000000000000}";
const T1: &str = "{AAAAAAAA-0000-0000-0000-000000000001}";
const T2: &str = "{AAAAAAAA-0000-0000-0000-000000000002}";

const CT_HEAD: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>"#;
const CT_BASE: &str = r#"<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#;
const RELS_HEAD: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#;

fn zip_of(parts: &[(String, String)]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        for (name, body) in parts {
            zip.start_file(name.as_str(), crate::write::part_options())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buf
}

fn common(ct_extra: &str, wb_rels_extra: &str) -> Vec<(String, String)> {
    let s = |a: &str, b: String| (a.to_string(), b);
    vec![
        s(
            "[Content_Types].xml",
            format!("{CT_HEAD}{CT_BASE}{ct_extra}</Types>"),
        ),
        s(
            "_rels/.rels",
            format!(
                "{RELS_HEAD}<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"
            ),
        ),
        s(
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#
                .into(),
        ),
        s(
            "xl/_rels/workbook.xml.rels",
            format!(
                "{RELS_HEAD}<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>{wb_rels_extra}</Relationships>"
            ),
        ),
    ]
}

/// A workbook with no comments at all.
fn plain() -> Vec<u8> {
    let mut p = common("", "");
    p.push((
        "xl/worksheets/sheet1.xml".into(),
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row><row r="3"><c r="B3"><v>42</v></c></row></sheetData></worksheet>"#
            .into(),
    ));
    zip_of(&p)
}

/// The shape of a package Excel 16 opened and re-saved: one thread on B3 with
/// a reply, two persons, the paired note and its VML shape.
fn threaded() -> Vec<u8> {
    let mut p = common(
        "<Default Extension=\"vml\" ContentType=\"application/vnd.openxmlformats-officedocument.vmlDrawing\"/><Override PartName=\"/xl/comments1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml\"/><Override PartName=\"/xl/threadedComments/threadedComment1.xml\" ContentType=\"application/vnd.ms-excel.threadedcomments+xml\"/><Override PartName=\"/xl/persons/person.xml\" ContentType=\"application/vnd.ms-excel.person+xml\"/>",
        "<Relationship Id=\"rId2\" Type=\"http://schemas.microsoft.com/office/2017/10/relationships/person\" Target=\"persons/person.xml\"/>",
    );
    let s = |a: &str, b: String| (a.to_string(), b);
    p.push(s(
        "xl/worksheets/sheet1.xml",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row><row r="3"><c r="B3"><v>42</v></c></row></sheetData><legacyDrawing r:id="rId2"/></worksheet>"#
            .into(),
    ));
    p.push(s(
        "xl/worksheets/_rels/sheet1.xml.rels",
        format!("{RELS_HEAD}<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments\" Target=\"../comments1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing\" Target=\"../drawings/vmlDrawing1.vml\"/><Relationship Id=\"rId3\" Type=\"http://schemas.microsoft.com/office/2017/10/relationships/threadedComment\" Target=\"../threadedComments/threadedComment1.xml\"/></Relationships>"),
    ));
    p.push(s(
        "xl/comments1.xml",
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<comments xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><authors><author>tc={T1}</author></authors><commentList><comment ref=\"B3\" authorId=\"0\" shapeId=\"0\"><text><t>{PLACEHOLDER_HEAD}Check this number\nReply:\n    It is right, see the invoice</t></text></comment></commentList></comments>"),
    ));
    p.push(s(
        "xl/drawings/vmlDrawing1.vml",
        "<xml xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:x=\"urn:schemas-microsoft-com:office:excel\"><o:shapelayout v:ext=\"edit\"><o:idmap v:ext=\"edit\" data=\"1\"/></o:shapelayout><v:shapetype id=\"_x0000_t202\" coordsize=\"21600,21600\" o:spt=\"202\" path=\"m,l,21600r21600,l21600,xe\"><v:stroke joinstyle=\"miter\"/><v:path gradientshapeok=\"t\" o:connecttype=\"rect\"/></v:shapetype><v:shape id=\"_x0000_s1025\" type=\"#_x0000_t202\" style=\"position:absolute;visibility:hidden\" fillcolor=\"#ffffe1\" o:insetmode=\"auto\"><x:ClientData ObjectType=\"Note\"><x:Anchor>1, 15, 2, 10, 3, 15, 6, 4</x:Anchor><x:Row>2</x:Row><x:Column>1</x:Column></x:ClientData></v:shape></xml>".into(),
    ));
    p.push(s(
        "xl/threadedComments/threadedComment1.xml",
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<ThreadedComments xmlns=\"{NS_TC}\" xmlns:x=\"{NS_MAIN}\"><threadedComment ref=\"B3\" dT=\"2026-11-01T10:00:00.00\" personId=\"{P1}\" id=\"{T1}\"><text>Check this number</text></threadedComment><threadedComment ref=\"B3\" dT=\"2026-11-01T10:05:00.00\" personId=\"{P2}\" id=\"{T2}\" parentId=\"{T1}\"><text>It is right, see the invoice</text></threadedComment></ThreadedComments>"),
    ));
    p.push(s(
        "xl/persons/person.xml",
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<personList xmlns=\"{NS_TC}\" xmlns:x=\"{NS_MAIN}\"><person displayName=\"Ann Author\" id=\"{P1}\" userId=\"ann@example.test\" providerId=\"None\"/><person displayName=\"Bob Reviewer\" id=\"{P2}\" userId=\"bob@example.test\" providerId=\"None\"/></personList>"),
    ));
    zip_of(&p)
}

fn part(bytes: &[u8], name: &str) -> Option<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut f = z.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn names(bytes: &[u8]) -> Vec<String> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    (0..z.len())
        .map(|i| z.by_index(i).unwrap().name().unwrap().to_string())
        .collect()
}

const ANN: Author<'static> = Author {
    display_name: "Ann Author",
    user_id: "ann@example.test",
    provider_id: "None",
};
const CY: Author<'static> = Author {
    display_name: "Cy Newcomer",
    user_id: "cy@example.test",
    provider_id: "None",
};
const TS: &str = "2026-11-02T09:30:00.00";

fn reopen(doc: &XlsxDocument) -> XlsxDocument {
    XlsxDocument::open(&doc.save().unwrap()).unwrap()
}

#[test]
fn reads_the_thread_with_its_persons() {
    let doc = XlsxDocument::open(&threaded()).unwrap();
    let threads = doc.threads_of(0);
    assert_eq!(threads.len(), 1);
    let t = &threads[0];
    assert_eq!((t.row, t.col), (2, 1));
    assert_eq!(t.comments.len(), 2);
    let root = t.root().unwrap();
    assert_eq!(root.id, T1);
    assert_eq!(root.parent_id, None);
    assert_eq!(root.timestamp, "2026-11-01T10:00:00.00");
    assert_eq!(root.text, "Check this number");
    assert!(!root.done && !t.resolved());
    let p = root.person.as_ref().unwrap();
    assert_eq!(
        (
            p.display_name.as_str(),
            p.user_id.as_str(),
            p.provider_id.as_str()
        ),
        ("Ann Author", "ann@example.test", "None")
    );
    let reply = &t.comments[1];
    assert_eq!(reply.id, T2);
    assert_eq!(reply.parent_id.as_deref(), Some(T1));
    assert_eq!(reply.person.as_ref().unwrap().display_name, "Bob Reviewer");
    assert_eq!(doc.persons().len(), 2);
    assert!(XlsxDocument::open(&plain())
        .unwrap()
        .threads_of(0)
        .is_empty());
}

#[test]
fn zero_edit_round_trip_is_byte_identical() {
    let raw = threaded();
    let out = XlsxDocument::open(&raw).unwrap().save().unwrap();
    for n in names(&raw) {
        assert_eq!(part(&raw, &n), part(&out, &n), "{n}");
    }
}

#[test]
fn add_thread_creates_parts_note_and_shape() {
    let raw = plain();
    let mut doc = XlsxDocument::open(&raw).unwrap();
    let mut gen = GuidGen::new(7);
    let id = doc
        .add_thread(0, 2, 1, &ANN, TS, "Why 42 & <not> 41?", &mut gen)
        .unwrap();
    let out = doc.save().unwrap();
    let doc = XlsxDocument::open(&out).unwrap();
    let t = &doc.threads_of(0)[0];
    assert_eq!(t.root().unwrap().id, id);
    assert_eq!(t.root().unwrap().text, "Why 42 & <not> 41?");
    assert_eq!(t.root().unwrap().timestamp, TS);
    assert_eq!(
        t.root().unwrap().person.as_ref().unwrap().user_id,
        "ann@example.test"
    );
    // The parts, content types and relationships.
    let ct = part(&out, "[Content_Types].xml").unwrap();
    assert!(ct.contains("/xl/threadedComments/threadedComment1.xml"));
    assert!(ct.contains(CT_THREADED) && ct.contains(CT_PERSON));
    assert!(part(&out, "xl/_rels/workbook.xml.rels")
        .unwrap()
        .contains("persons/person.xml"));
    let rels = part(&out, "xl/worksheets/_rels/sheet1.xml.rels").unwrap();
    assert!(rels.contains("../threadedComments/threadedComment1.xml"));
    assert!(rels.contains("comments1.xml") && rels.contains("vmlDrawing1.vml"));
    // The paired note: author tc={root}, the placeholder, the shape.
    let note = doc.comments_of(0).unwrap().at(2, 1).unwrap();
    assert_eq!(note.author, format!("tc={id}"));
    assert!(note
        .text
        .starts_with("[Threaded comment]\n\nYour version of Excel"));
    assert!(note.text.ends_with("Comment:\n    Why 42 & <not> 41?"));
    assert!(part(&out, "xl/drawings/vmlDrawing1.vml")
        .unwrap()
        .contains("<x:Row>2</x:Row>"));
    // Everything else keeps its bytes.
    assert_eq!(part(&raw, "xl/workbook.xml"), part(&out, "xl/workbook.xml"));
    let ws = part(&out, "xl/worksheets/sheet1.xml").unwrap();
    assert!(ws.contains("<sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>hello</t></is></c></row><row r=\"3\"><c r=\"B3\"><v>42</v></c></row></sheetData>"));
    assert!(ws.contains("<legacyDrawing"));
}

#[test]
fn add_thread_is_refused_over_a_thread_or_a_note() {
    let mut doc = XlsxDocument::open(&threaded()).unwrap();
    let mut gen = GuidGen::new(1);
    assert!(doc.add_thread(0, 2, 1, &ANN, TS, "x", &mut gen).is_err());
    let mut doc = XlsxDocument::open(&plain()).unwrap();
    doc.set_note(0, 0, 0, "Ann", "a note").unwrap();
    assert!(doc.add_thread(0, 0, 0, &ANN, TS, "x", &mut gen).is_err());
    assert!(doc.add_thread(0, 5, 5, &ANN, TS, "", &mut gen).is_err());
}

#[test]
fn reply_edit_resolve_delete_round_trip() {
    let mut doc = XlsxDocument::open(&threaded()).unwrap();
    let mut gen = GuidGen::new(42);
    // Reply by a new person: a person entry is created.
    let r = doc
        .reply_thread(0, 2, 1, &CY, TS, "Agreed", &mut gen)
        .unwrap();
    let mut doc = reopen(&doc);
    assert_eq!(doc.persons().len(), 3);
    let t = doc.threads_of(0).remove(0);
    assert_eq!(t.comments.len(), 3);
    assert_eq!(t.comments[2].id, r);
    assert_eq!(t.comments[2].parent_id.as_deref(), Some(T1));
    assert_eq!(
        t.comments[2].person.as_ref().unwrap().display_name,
        "Cy Newcomer"
    );
    assert!(doc
        .comments_of(0)
        .unwrap()
        .at(2, 1)
        .unwrap()
        .text
        .ends_with("Reply:\n    Agreed"));
    // Replying again as an existing person adds no person.
    doc.reply_thread(0, 2, 1, &CY, TS, "Again", &mut gen)
        .unwrap();
    assert_eq!(doc.persons().len(), 3);

    // Edit the root and a reply: the note follows.
    assert!(doc
        .edit_thread_comment(0, T1, "Check <this> & that")
        .unwrap());
    assert!(doc.edit_thread_comment(0, &r, "Agreed, fully").unwrap());
    assert!(!doc.edit_thread_comment(0, "{nope}", "x").unwrap());
    let doc = reopen(&doc);
    let t = doc.threads_of(0).remove(0);
    assert_eq!(t.root().unwrap().text, "Check <this> & that");
    assert_eq!(t.comments[2].text, "Agreed, fully");
    let note = doc.comments_of(0).unwrap().at(2, 1).unwrap();
    assert!(note
        .text
        .contains("Comment:\n    Check <this> & that\nReply:"));
    assert!(note.text.contains("Reply:\n    Agreed, fully"));

    // Resolve and reopen: `done` on the root only.
    let mut doc = doc;
    assert!(doc.set_thread_done(0, 2, 1, true).unwrap());
    let doc2 = reopen(&doc);
    assert!(doc2.threads_of(0)[0].resolved());
    assert!(doc2.threads_of(0)[0].comments[1..].iter().all(|c| !c.done));
    assert!(part(
        &doc.save().unwrap(),
        "xl/threadedComments/threadedComment1.xml"
    )
    .unwrap()
    .contains("done=\"1\""));
    assert!(doc.set_thread_done(0, 2, 1, false).unwrap());
    assert!(!reopen(&doc).threads_of(0)[0].resolved());
    assert!(!doc.set_thread_done(0, 9, 9, true).unwrap());

    // Delete a reply: the rest stays.
    assert!(doc.delete_thread_comment(0, T2).unwrap());
    let mut doc = reopen(&doc);
    assert_eq!(doc.threads_of(0)[0].comments.len(), 3);
    assert!(!doc
        .comments_of(0)
        .unwrap()
        .at(2, 1)
        .unwrap()
        .text
        .contains("see the invoice"));

    // Delete the root: the thread, its note, shape and parts go.
    assert!(doc.delete_thread_comment(0, T1).unwrap());
    let out = doc.save().unwrap();
    let doc = XlsxDocument::open(&out).unwrap();
    assert!(doc.threads_of(0).is_empty());
    assert!(doc.comments_of(0).is_none());
    let n = names(&out);
    assert!(
        !n.iter().any(|f| f.contains("threadedComment")
            || f.contains("comments1")
            || f.contains("vmlDrawing")),
        "{n:?}"
    );
    assert!(!part(&out, "[Content_Types].xml")
        .unwrap()
        .contains("threadedcomments"));
    assert!(!part(&out, "xl/worksheets/_rels/sheet1.xml.rels")
        .unwrap()
        .contains("threadedComment"));
    assert!(!part(&out, "xl/worksheets/sheet1.xml")
        .unwrap()
        .contains("legacyDrawing"));
}

#[test]
fn the_note_api_refuses_a_threaded_cell() {
    let mut doc = XlsxDocument::open(&threaded()).unwrap();
    let e = doc.set_note(0, 2, 1, "Ann", "x").unwrap_err().to_string();
    assert!(e.contains("thread API"), "{e}");
    assert!(doc.delete_note(0, 2, 1).is_err());
}

#[test]
fn mentions_go_when_the_text_changes_and_unknown_attributes_stay() {
    let raw = threaded();
    let mut parts: Vec<(String, String)> = names(&raw)
        .into_iter()
        .map(|n| {
            let b = part(&raw, &n).unwrap();
            (n, b)
        })
        .collect();
    for (n, b) in &mut parts {
        if n.ends_with("threadedComment1.xml") {
            *b = b.replace(
                "<text>Check this number</text>",
                "<text>Check this number</text><mentions><mention mentionpersonId=\"x\" mentionId=\"y\" startIndex=\"0\" length=\"5\"/></mentions>",
            )
            .replace("id=\"{AAAAAAAA-0000-0000-0000-000000000001}\">", "id=\"{AAAAAAAA-0000-0000-0000-000000000001}\" xmlns:z=\"urn:z\" z:keep=\"1\">");
        }
    }
    let mut doc = XlsxDocument::open(&zip_of(&parts)).unwrap();
    assert!(doc.edit_thread_comment(0, T1, "Changed").unwrap());
    let out = doc.save().unwrap();
    let tc = part(&out, "xl/threadedComments/threadedComment1.xml").unwrap();
    assert!(!tc.contains("mention"));
    assert!(tc.contains("z:keep=\"1\""));
}

#[test]
fn guids_are_seeded_and_well_formed() {
    let (mut a, mut b) = (GuidGen::new(5), GuidGen::new(5));
    let g = a.next_guid();
    assert_eq!(g, b.next_guid());
    assert_ne!(g, a.next_guid());
    assert_eq!(g.len(), 38);
    assert!(g.starts_with('{') && g.ends_with('}'));
    assert_eq!(&g[15..16], "4");
}

#[test]
fn same_seed_same_package() {
    let run = || {
        let mut doc = XlsxDocument::open(&plain()).unwrap();
        let mut gen = GuidGen::new(99);
        doc.add_thread(0, 2, 1, &ANN, TS, "one", &mut gen).unwrap();
        doc.reply_thread(0, 2, 1, &CY, TS, "two", &mut gen).unwrap();
        doc.save().unwrap()
    };
    assert_eq!(run(), run());
}

/// Writes the packages the Excel oracle opens (sheet ADR 528) into
/// `PAGED_TC_ORACLE_DIR`: `cargo test -p sheet-xlsx -- --ignored write_oracle`.
#[test]
#[ignore = "writes the open-check packages for a manual Excel run"]
fn write_oracle_packages() {
    let Ok(dir) = std::env::var("PAGED_TC_ORACLE_DIR") else {
        return;
    };
    let mut gen = GuidGen::new(2026);
    let mut doc = XlsxDocument::open(&plain()).unwrap();
    doc.add_thread(
        0,
        2,
        1,
        &ANN,
        "2026-11-01T10:00:00.00",
        "Check this number",
        &mut gen,
    )
    .unwrap();
    let save = |d: &XlsxDocument, n: &str| {
        std::fs::write(format!("{dir}/{n}.xlsx"), d.save().unwrap()).unwrap()
    };
    save(&doc, "tc-add");
    doc.reply_thread(
        0,
        2,
        1,
        &CY,
        "2026-11-01T10:05:00.00",
        "It is right",
        &mut gen,
    )
    .unwrap();
    save(&doc, "tc-reply");
    let mut edited = reopen(&doc);
    let root = edited.threads_of(0)[0].root().unwrap().id.clone();
    edited
        .edit_thread_comment(0, &root, "Check this & that")
        .unwrap();
    save(&edited, "tc-edit");
    doc.set_thread_done(0, 2, 1, true).unwrap();
    save(&doc, "tc-resolve");
    doc.set_thread_done(0, 2, 1, false).unwrap();
    doc.add_thread(
        0,
        0,
        0,
        &ANN,
        "2026-11-01T11:00:00.00",
        "Second thread",
        &mut gen,
    )
    .unwrap();
    let reply = doc.threads_of(0)[0].comments[1].id.clone();
    doc.delete_thread_comment(0, &reply).unwrap();
    save(&doc, "tc-delete-reply");
    doc.delete_thread_comment(0, &root).unwrap();
    save(&doc, "tc-delete-root");
}
