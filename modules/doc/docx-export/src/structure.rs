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

//! Save-back of Word's document structure (doc ADRs 610, 611, 612): the
//! header and footer parts, the footnote and endnote parts, and what the
//! canvas puts INTO a body paragraph that is not text — a new note
//! reference, a new field, a new bookmark.
//!
//! The body is read back with the engine's note markers and field runs in
//! it. [`extract_structure`] takes them out of the overlaid story (so the
//! differ sees Word's text) and says what changed: the notes kept, added
//! and removed, the fields and bookmarks added. The headers, footers and
//! notes are spliced into their own parts with the body's machinery: the
//! patcher addresses their paragraphs as body paragraphs (`splice`), and
//! each part is diffed as a small story of its own.

use std::collections::{BTreeMap, BTreeSet};

use docx_core::{Block, DocxDocument, Run, StyleKind};
use docx_lower::ir::{LoweredBlock, LoweredDoc, LoweredParagraph, LoweredRun};
use paged_ooxml::{OoxmlError, OpcPackage};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

use crate::bindings::build_bindings;
use crate::edit::AtomInsert;
use crate::overlay::{overlay_story_content_with, StoryContentIn, TableParagraphs};
use crate::{apply_edits, diff, DocxBindings};

const W_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// What the bundle reads back beyond the body (doc ADR 611).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureIn {
    /// Every master header/footer story read back, with the part it shows
    /// (an index into `LoweredDoc::header_footer_parts`). Several stories
    /// can show one part; the first that differs from the part is its edit.
    #[serde(default)]
    pub headers: Vec<HeaderContentIn>,
    /// The engine's footnotes in document order (story order, then
    /// offset): each note's text without its number and separator.
    #[serde(default)]
    pub footnotes: Vec<NoteTextIn>,
    /// The engine's endnotes, likewise.
    #[serde(default)]
    pub endnotes: Vec<NoteTextIn>,
    /// The body stories' named text anchors (Word's bookmarks), in story
    /// order: `paragraph` counts the merged read-back's paragraphs.
    #[serde(default)]
    pub anchors: Vec<AnchorIn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderContentIn {
    pub part: usize,
    pub content: StoryContentIn,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTextIn {
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorIn {
    pub name: String,
    /// The paragraph of the merged body read-back it stands in.
    pub paragraph: usize,
    /// Its character offset in that read-back paragraph.
    pub offset: usize,
}

/// A note reference in the edited body (doc ADR 611).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteMark {
    /// A reference the document had: its note's id.
    Kept(i64),
    /// A reference the canvas added.
    New,
}

/// Something put into a body paragraph, at a char offset into the
/// paragraph's Word text (markers and new field results taken out).
#[derive(Debug, Clone)]
pub enum Atom {
    Note { endnote: bool, ordinal: usize },
    Field { code: String, run: Box<LoweredRun> },
    Bookmark { name: String },
}

/// What [`extract_structure`] found.
#[derive(Debug, Clone, Default)]
pub struct StructureChanges {
    /// Per kind (footnote, endnote): every reference in the edited body, in
    /// document order.
    pub footnotes: Vec<NoteMark>,
    pub endnotes: Vec<NoteMark>,
    /// Notes whose reference is gone: (endnote, id).
    pub removed: Vec<(bool, i64)>,
    /// (block, offset, atom), offsets into the block's Word text.
    pub atoms: Vec<(usize, usize, Atom)>,
    pub skips: Vec<String>,
}

fn marker_kind(c: char) -> Option<bool> {
    match c {
        Run::FOOTNOTE_MARKER => Some(false),
        Run::ENDNOTE_MARKER => Some(true),
        _ => None,
    }
}

/// One paragraph's text as Word text plus where its markers stand (in
/// Word-text chars), with the runs that are new fields left out.
struct Marked {
    text: Vec<char>,
    marks: Vec<(usize, bool)>,
    fields: Vec<(usize, LoweredRun)>,
}

fn marked(p: &LoweredParagraph, new_field: &dyn Fn(&LoweredRun) -> bool) -> Marked {
    let mut m = Marked {
        text: Vec::new(),
        marks: Vec::new(),
        fields: Vec::new(),
    };
    for r in &p.runs {
        if new_field(r) {
            m.fields.push((m.text.len(), r.clone()));
            continue;
        }
        for c in r.text.chars() {
            match marker_kind(c) {
                Some(end) => m.marks.push((m.text.len(), end)),
                None => m.text.push(c),
            }
        }
    }
    m
}

/// Take the note markers and the new fields out of `edited` (overlaid on
/// `baseline`, both lowered WITH markers) and say what changed (doc ADRs
/// 611/612). `edited` is left without new field runs; its markers stay for
/// [`crate::notes::strip_lowered`].
pub fn extract_structure(baseline: &LoweredDoc, edited: &mut LoweredDoc) -> StructureChanges {
    let mut out = StructureChanges::default();
    let mut ordinals = [0usize, 0usize];
    for (block, (b, e)) in baseline
        .story
        .blocks
        .iter()
        .zip(edited.story.blocks.iter_mut())
        .enumerate()
    {
        let (LoweredBlock::Paragraph(bp), LoweredBlock::Paragraph(ep)) = (b, e) else {
            continue;
        };
        let codes: BTreeSet<&str> = bp
            .runs
            .iter()
            .filter_map(|r| r.field.as_ref().map(|f| f.code.as_str()))
            .collect();
        let is_new = |r: &LoweredRun| {
            r.field
                .as_ref()
                .is_some_and(|f| !codes.contains(f.code.as_str()))
        };
        let base = marked(bp, &|_| false);
        let edit = marked(ep, &is_new);
        let base_refs: Vec<(usize, bool, i64)> = {
            let ids: Vec<(bool, i64)> = bp
                .runs
                .iter()
                .filter_map(|r| r.note.map(|n| (n.endnote, n.id)))
                .collect();
            base.marks
                .iter()
                .zip(ids)
                .map(|((at, end), (_, id))| (*at, *end, id))
                .collect()
        };
        // Match the references by place: the text around them unchanged,
        // a reference at the same Word-text offset is the same one.
        let same_text = base.text == edit.text;
        let mut used = vec![false; base_refs.len()];
        let mut marks: Vec<(usize, bool, NoteMark)> = Vec::new();
        for (k, (at, end)) in edit.marks.iter().enumerate() {
            let found = if same_text {
                base_refs
                    .iter()
                    .enumerate()
                    .position(|(i, (bat, bend, _))| !used[i] && bat == at && bend == end)
            } else if edit.marks.len() == base_refs.len() {
                (base_refs[k].1 == *end).then_some(k)
            } else {
                None
            };
            match found {
                Some(i) => {
                    used[i] = true;
                    marks.push((*at, *end, NoteMark::Kept(base_refs[i].2)));
                }
                None if same_text => marks.push((*at, *end, NoteMark::New)),
                None => {
                    out.skips.push(format!(
                        "a note reference in body block {block} was added or removed while \
                         its paragraph's text changed: save once after each"
                    ));
                    used.iter_mut().for_each(|u| *u = true);
                    break;
                }
            }
        }
        for (i, (_, end, id)) in base_refs.iter().enumerate() {
            if !used[i] {
                out.removed.push((*end, *id));
            }
        }
        for (at, end, mark) in marks {
            let list = if end {
                &mut out.endnotes
            } else {
                &mut out.footnotes
            };
            list.push(mark);
            let ordinal = ordinals[usize::from(end)];
            ordinals[usize::from(end)] += 1;
            if mark == NoteMark::New {
                out.atoms.push((
                    block,
                    at,
                    Atom::Note {
                        endnote: end,
                        ordinal,
                    },
                ));
            }
        }
        for (at, run) in edit.fields {
            let code = run
                .field
                .as_ref()
                .map(|f| f.code.clone())
                .unwrap_or_default();
            out.atoms.push((
                block,
                at,
                Atom::Field {
                    code,
                    run: Box::new(run),
                },
            ));
        }
        ep.runs.retain(|r| !is_new(r));
    }
    out
}

/// The run of `p` (Word text, markers out) an atom at char `at` goes into:
/// `(run, before, after)`; at a run's start it goes after the run before
/// (so the run is not split for nothing), at the paragraph's start nowhere.
fn place(p: &LoweredParagraph, at: usize) -> (Option<usize>, String, String) {
    if at == 0 {
        return (None, String::new(), String::new());
    }
    let mut start = 0usize;
    let mut last: Option<usize> = None;
    for (i, r) in p.runs.iter().enumerate() {
        let chars: Vec<char> = r.text.chars().collect();
        let end = start + chars.len();
        if !chars.is_empty() && at > start && at <= end {
            let k = at - start;
            return (
                Some(i),
                chars[..k].iter().collect(),
                chars[k..].iter().collect(),
            );
        }
        if !chars.is_empty() {
            last = Some(i);
        }
        start = end;
    }
    match last {
        Some(i) => (Some(i), p.runs[i].text.clone(), String::new()),
        None => (None, String::new(), String::new()),
    }
}

fn esc(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}

/// A Word style id by its name (`footnote reference`), when the document
/// has it.
fn style_named(model: &DocxDocument, name: &str, kind: StyleKind) -> Option<String> {
    model
        .styles
        .styles
        .iter()
        .find(|s| {
            s.kind == kind
                && s.name
                    .as_deref()
                    .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .map(|s| s.style_id.clone())
}

/// The reference run Word writes for a note.
fn reference_run(model: &DocxDocument, endnote: bool, id: i64) -> String {
    let (style, element) = if endnote {
        ("endnote reference", "endnoteReference")
    } else {
        ("footnote reference", "footnoteReference")
    };
    let rpr = match style_named(model, style, StyleKind::Character) {
        Some(s) => format!("<w:rPr><w:rStyle w:val=\"{}\"/></w:rPr>", esc(&s)),
        None => "<w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr>".into(),
    };
    format!("<w:r>{rpr}<w:{element} w:id=\"{id}\"/></w:r>")
}

/// A note as Word writes one made in its UI: its text paragraphs, the first
/// opening with the reference mark and a space.
fn note_xml(model: &DocxDocument, endnote: bool, id: i64, text: &str) -> String {
    let (tag, text_style, ref_style, mark) = if endnote {
        ("endnote", "endnote text", "endnote reference", "endnoteRef")
    } else {
        (
            "footnote",
            "footnote text",
            "footnote reference",
            "footnoteRef",
        )
    };
    let ppr = style_named(model, text_style, StyleKind::Paragraph)
        .map(|s| format!("<w:pPr><w:pStyle w:val=\"{}\"/></w:pPr>", esc(&s)))
        .unwrap_or_default();
    let rpr = match style_named(model, ref_style, StyleKind::Character) {
        Some(s) => format!("<w:rPr><w:rStyle w:val=\"{}\"/></w:rPr>", esc(&s)),
        None => "<w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr>".into(),
    };
    let mut out = format!("<w:{tag} w:id=\"{id}\">");
    for (i, line) in text.split('\n').enumerate() {
        out.push_str("<w:p>");
        out.push_str(&ppr);
        if i == 0 {
            out.push_str(&format!("<w:r>{rpr}<w:{mark}/></w:r>"));
            out.push_str("<w:r><w:t xml:space=\"preserve\"> </w:t></w:r>");
        }
        if !line.is_empty() {
            out.push_str(&format!(
                "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
                esc(line)
            ));
        }
        out.push_str("</w:p>");
    }
    out.push_str(&format!("</w:{tag}>"));
    out
}

/// A new field as Word writes a complex field: begin, its instruction,
/// separate, its result in the run's look, end.
fn field_xml(code: &str, result: &str, rpr: &str) -> String {
    let r = |inner: &str| format!("<w:r>{rpr}{inner}</w:r>");
    format!(
        "{}{}{}{}{}",
        r("<w:fldChar w:fldCharType=\"begin\"/>"),
        r(&format!(
            "<w:instrText xml:space=\"preserve\"> {} </w:instrText>",
            esc(code)
        )),
        r("<w:fldChar w:fldCharType=\"separate\"/>"),
        r(&format!(
            "<w:t xml:space=\"preserve\">{}</w:t>",
            esc(result)
        )),
        r("<w:fldChar w:fldCharType=\"end\"/>"),
    )
}

/// The part a relationship of the main part's points to (by type suffix).
pub fn related_part(pkg: &OpcPackage, main_part: &str, suffix: &str) -> Option<String> {
    let rels = paged_ooxml::rels::Relationships::parse(
        pkg.part(&paged_ooxml::rels::rels_part_name(main_part))?,
    );
    let r = rels.by_type_suffix(suffix)?;
    Some(paged_ooxml::rels::resolve_target(
        paged_ooxml::rels::part_dir(main_part),
        &r.target,
    ))
}

/// Every element of `name` (local) in `xml` with its `w:id` and the byte
/// range of the element, in order; `depth_children` counts its direct
/// `w:p` children.
fn notes_in(xml: &[u8], name: &[u8]) -> Vec<(i64, usize, usize, u32)> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut out = Vec::new();
    let mut open: Option<(i64, usize, u32)> = None;
    let mut depth = 0usize;
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                depth += 1;
                let ln = e.local_name().as_ref().to_vec();
                if ln == name && open.is_none() {
                    let id = e
                        .attributes()
                        .flatten()
                        .find(|a| a.key.local_name().as_ref() == b"id")
                        .and_then(|a| String::from_utf8_lossy(&a.value).parse::<i64>().ok())
                        .unwrap_or(i64::MIN);
                    open = Some((id, start, 0));
                } else if ln == b"p" && depth == 3 {
                    if let Some(o) = open.as_mut() {
                        o.2 += 1;
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == b"p" && depth == 2 {
                    if let Some(o) = open.as_mut() {
                        o.2 += 1;
                    }
                }
            }
            Ok(Event::End(e)) => {
                if e.local_name().as_ref() == name && depth == 2 {
                    if let Some((id, s, n)) = open.take() {
                        out.push((id, s, reader.buffer_position() as usize, n));
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// The highest `w:id` of `local` elements in `xml` (bookmarks, notes).
fn max_id(xml: &[u8], local: &[u8]) -> i64 {
    let mut reader = Reader::from_reader(xml);
    let mut best = 0i64;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == local => {
                if let Some(id) = e
                    .attributes()
                    .flatten()
                    .find(|a| a.key.local_name().as_ref() == b"id")
                    .and_then(|a| String::from_utf8_lossy(&a.value).parse::<i64>().ok())
                {
                    best = best.max(id);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    best
}

/// Diff `paragraphs` (a part's lowered paragraphs, `source` their
/// docx-core twins with part-wide ordinals) against `edited` and splice the
/// edits into `part`.
fn splice_part(
    pkg: &mut OpcPackage,
    part: &str,
    model: &DocxDocument,
    lowered: &LoweredDoc,
    base: Vec<LoweredParagraph>,
    edited: Vec<LoweredParagraph>,
    source: Vec<docx_core::Paragraph>,
) -> Result<Vec<String>, OoxmlError> {
    let mini = |ps: Vec<LoweredParagraph>| LoweredDoc {
        story: docx_lower::ir::LoweredStory {
            blocks: ps.into_iter().map(LoweredBlock::Paragraph).collect(),
        },
        ..lowered.clone()
    };
    let (base, edited) = (mini(base), mini(edited));
    let doc = DocxDocument {
        body: source.into_iter().map(Block::Paragraph).collect(),
        styles: model.styles.clone(),
        ..Default::default()
    };
    let bindings: DocxBindings = build_bindings(&doc);
    let edits = diff(&base, &edited, &bindings);
    apply_edits(pkg, part, &bindings, &edits)
}

/// The header and footer edits (doc ADR 611): per part, the first master
/// story showing it whose text or look differs from the part.
pub fn save_headers(
    pkg: &mut OpcPackage,
    model: &DocxDocument,
    lowered: &LoweredDoc,
    headers: &[HeaderContentIn],
) -> Result<Vec<String>, OoxmlError> {
    let mut skips = Vec::new();
    let mut done: BTreeSet<usize> = BTreeSet::new();
    for h in headers {
        if done.contains(&h.part) {
            continue;
        }
        let (Some(lp), Some(source)) = (
            lowered.header_footer_parts.get(h.part),
            model.headers_footers.get(h.part),
        ) else {
            continue;
        };
        let base = LoweredDoc {
            story: docx_lower::ir::LoweredStory {
                blocks: lp
                    .paragraphs
                    .iter()
                    .cloned()
                    .map(LoweredBlock::Paragraph)
                    .collect(),
            },
            ..lowered.clone()
        };
        let edited =
            overlay_story_content_with(&base, &h.content, TableParagraphs::Joined, &|_| false);
        let edited_paras: Vec<LoweredParagraph> = edited
            .story
            .blocks
            .into_iter()
            .filter_map(|b| match b {
                LoweredBlock::Paragraph(p) => Some(p),
                LoweredBlock::Table(_) => None,
            })
            .collect();
        let same = edited_paras.iter().zip(&lp.paragraphs).all(|(a, b)| {
            a.runs.len() == b.runs.len()
                && a.runs
                    .iter()
                    .zip(&b.runs)
                    .all(|(x, y)| x.text == y.text && x.char_style_id == y.char_style_id)
                && a.para_style_id == b.para_style_id
        });
        if same {
            continue;
        }
        done.insert(h.part);
        let mut part_skips = splice_part(
            pkg,
            &lp.part,
            model,
            &edited.styles.iter().fold(lowered.clone(), |mut l, s| {
                if !l.styles.iter().any(|x| x.id == s.id) {
                    l.styles.push(s.clone());
                }
                l
            }),
            lp.paragraphs.clone(),
            edited_paras,
            source.paragraphs.clone(),
        )?;
        for s in part_skips.iter_mut() {
            *s = format!("{}: {s}", lp.part);
        }
        skips.extend(part_skips);
    }
    Ok(skips)
}

/// The notes part of a kind, and its root and note element names.
fn note_names(endnote: bool) -> (&'static str, &'static str, &'static str, &'static str) {
    if endnote {
        ("/endnotes", "endnotes", "endnote", "endnotes.xml")
    } else {
        ("/footnotes", "footnotes", "footnote", "footnotes.xml")
    }
}

/// Make the notes part of a kind as Word does: its separator and
/// continuation separator, the relationship and the content type.
fn create_notes_part(pkg: &mut OpcPackage, main_part: &str, endnote: bool) -> String {
    let (suffix, root, note, file) = note_names(endnote);
    let dir = paged_ooxml::rels::part_dir(main_part);
    let name = if dir.is_empty() {
        file.to_string()
    } else {
        format!("{}/{file}", dir.trim_end_matches('/'))
    };
    let sep = |kind: &str, id: i64, inner: &str| {
        format!(
            "<w:{note} w:type=\"{kind}\" w:id=\"{id}\"><w:p><w:pPr><w:spacing w:after=\"0\" \
             w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:r><w:{inner}/></w:r></w:p></w:{note}>"
        )
    };
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<w:{root} xmlns:w=\"{W_NS}\">{}{}</w:{root}>",
        sep("separator", -1, "separator"),
        sep("continuationSeparator", 0, "continuationSeparator"),
    );
    pkg.set_part(&name, xml.into_bytes());
    // Its relationship from the main part.
    let rels_name = paged_ooxml::rels::rels_part_name(main_part);
    let rels = pkg
        .part(&rels_name)
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_else(|| {
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships \
             xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>"
                .into()
        });
    let mut n = 1;
    while rels.contains(&format!("Id=\"rId{n}\"")) {
        n += 1;
    }
    let target = name.rsplit('/').next().unwrap_or(file);
    let rel = format!("<Relationship Id=\"rId{n}\" Type=\"{REL}{suffix}\" Target=\"{target}\"/>");
    if let Some(i) = rels.rfind("</Relationships>") {
        let mut r = rels.clone();
        r.insert_str(i, &rel);
        pkg.set_part(&rels_name, r.into_bytes());
    }
    // Its content type.
    if let Some(types) = pkg.part("[Content_Types].xml") {
        let mut t = String::from_utf8_lossy(types).into_owned();
        let over = format!(
            "<Override PartName=\"/{name}\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.{root}+xml\"/>"
        );
        if !t.contains(&format!("PartName=\"/{name}\"")) {
            if let Some(i) = t.rfind("</Types>") {
                t.insert_str(i, &over);
                pkg.set_part("[Content_Types].xml", t.into_bytes());
            }
        }
    }
    name
}

/// A run being read: its start, whether it holds anything but its
/// `w:rPr` and the reference, and the reference's byte range.
type OpenRun = (usize, bool, Option<(usize, usize)>);

/// Remove the elements `local` with `w:id` = one of `ids` from `xml`; a run
/// left holding nothing but its `w:rPr` goes with it.
fn remove_references(xml: &[u8], local: &[u8], ids: &BTreeSet<i64>) -> Vec<u8> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);
    let mut cut: Vec<(usize, usize)> = Vec::new();
    // The open run: its start and whether it holds anything else.
    let mut run: Option<OpenRun> = None;
    loop {
        let start = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let ln = e.local_name().as_ref().to_vec();
                if ln == b"r" {
                    run = Some((start, false, None));
                } else if ln == b"rPr" {
                    let _ = reader.read_to_end(e.name());
                } else if let Some(r) = run.as_mut() {
                    r.1 = true;
                }
            }
            Ok(Event::Empty(e)) => {
                let ln = e.local_name().as_ref().to_vec();
                let end = reader.buffer_position() as usize;
                let id = e
                    .attributes()
                    .flatten()
                    .find(|a| a.key.local_name().as_ref() == b"id")
                    .and_then(|a| String::from_utf8_lossy(&a.value).parse::<i64>().ok());
                if ln == local && id.is_some_and(|i| ids.contains(&i)) {
                    match run.as_mut() {
                        Some(r) => r.2 = Some((start, end)),
                        None => cut.push((start, end)),
                    }
                } else if ln != b"rPr" {
                    if let Some(r) = run.as_mut() {
                        r.1 = true;
                    }
                }
            }
            Ok(Event::Text(_)) => {}
            Ok(Event::End(e)) => {
                if e.local_name().as_ref() == b"r" {
                    if let Some((s, other, Some(found))) = run.take() {
                        if other {
                            cut.push(found);
                        } else {
                            cut.push((s, reader.buffer_position() as usize));
                        }
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let mut out = Vec::with_capacity(xml.len());
    let mut at = 0usize;
    for (s, e) in cut {
        out.extend_from_slice(&xml[at..s]);
        at = e;
    }
    out.extend_from_slice(&xml[at..]);
    out
}

/// The note and reference work of one save (doc ADR 611), after the body
/// is patched: kept notes whose text changed are spliced, new notes are
/// appended (their parts made when missing), removed ones dropped with
/// their references. `atoms` gets the new references to put into the body.
pub struct NotePlan {
    /// (endnote, ordinal in the edited references) → the id the new note gets.
    pub new_ids: BTreeMap<(bool, usize), i64>,
    pub skips: Vec<String>,
}

/// The ids new notes get, per kind: past the highest in their part.
pub fn plan_new_notes(pkg: &OpcPackage, main_part: &str, changes: &StructureChanges) -> NotePlan {
    let mut plan = NotePlan {
        new_ids: BTreeMap::new(),
        skips: Vec::new(),
    };
    for endnote in [false, true] {
        let marks = if endnote {
            &changes.endnotes
        } else {
            &changes.footnotes
        };
        let (suffix, _, note, _) = note_names(endnote);
        let mut next = related_part(pkg, main_part, suffix)
            .and_then(|p| pkg.part(&p).map(|b| max_id(b, note.as_bytes())))
            .unwrap_or(0)
            .max(0)
            + 1;
        for (k, m) in marks.iter().enumerate() {
            if *m == NoteMark::New {
                plan.new_ids.insert((endnote, k), next);
                next += 1;
            }
        }
    }
    plan
}

/// The atoms as patcher inserts into the BASELINE (Word text) paragraphs,
/// their XML rendered: new note references, new fields, new bookmarks.
/// `baseline` is the stripped lowering ([`crate::notes::strip_lowered`]).
#[allow(clippy::too_many_arguments)]
pub fn render_atoms(
    model: &DocxDocument,
    baseline: &LoweredDoc,
    bindings: &DocxBindings,
    changes: &StructureChanges,
    plan: &NotePlan,
    bookmarks: &[(usize, usize, String)],
    main_xml: &[u8],
) -> Vec<AtomInsert> {
    let mut out = Vec::new();
    let mut next_bookmark = max_id(main_xml, b"bookmarkStart") + 1;
    let mut atoms: Vec<(usize, usize, Atom)> = changes.atoms.clone();
    atoms.extend(
        bookmarks
            .iter()
            .map(|(b, at, name)| (*b, *at, Atom::Bookmark { name: name.clone() })),
    );
    atoms.sort_by_key(|(b, at, _)| (*b, *at));
    for (block, at, atom) in atoms {
        let Some(LoweredBlock::Paragraph(p)) = baseline.story.blocks.get(block) else {
            continue;
        };
        let xml = match atom {
            Atom::Note { endnote, ordinal } => match plan.new_ids.get(&(endnote, ordinal)) {
                Some(id) => reference_run(model, endnote, *id),
                None => continue,
            },
            Atom::Field { code, run } => {
                let (props, rstyle) = crate::diff::effective_props(
                    run.char_style_id.as_deref(),
                    p.para_style_id.as_deref(),
                    baseline,
                    bindings,
                );
                let rpr = if props != docx_core::RunProps::default() || rstyle.is_some() {
                    String::from_utf8_lossy(&crate::rpr::render_rpr(&props, rstyle.as_deref()))
                        .into_owned()
                } else {
                    String::new()
                };
                field_xml(&code, &run.text, &rpr)
            }
            Atom::Bookmark { name } => {
                let id = next_bookmark;
                next_bookmark += 1;
                format!(
                    "<w:bookmarkStart w:id=\"{id}\" w:name=\"{}\"/><w:bookmarkEnd w:id=\"{id}\"/>",
                    esc(&name)
                )
            }
        };
        let (run, before, after) = place(p, at);
        out.push(AtomInsert {
            block,
            run,
            before,
            after,
            xml,
        });
    }
    out
}

/// The bookmarks the canvas added (doc ADR 612): read-back anchors whose
/// name no lowered paragraph has, as (block, Word-text offset, name).
/// `content` is the merged body read-back the overlay mapped; paragraphs
/// map to blocks as the overlay maps them (one per Word paragraph, plus
/// one per break segment, plus a native table's own).
pub fn new_bookmarks(
    baseline: &LoweredDoc,
    content: &StoryContentIn,
    anchors: &[AnchorIn],
    layout: TableParagraphs,
) -> Vec<(usize, usize, String)> {
    let known: BTreeSet<&str> = baseline
        .story
        .blocks
        .iter()
        .filter_map(|b| match b {
            LoweredBlock::Paragraph(p) => Some(p.bookmarks.iter().map(String::as_str)),
            LoweredBlock::Table(_) => None,
        })
        .flatten()
        .collect();
    // Read-back paragraph → (block, chars before it in the block).
    let mut map: Vec<Option<(usize, usize)>> = Vec::new();
    for (block, b) in baseline.story.blocks.iter().enumerate() {
        match b {
            LoweredBlock::Paragraph(p) => {
                let mut base = 0usize;
                for _ in 0..1 + p.segments.len() {
                    let i = map.len();
                    map.push(Some((block, base)));
                    base += content
                        .paragraphs
                        .get(i)
                        .map(|q| {
                            q.runs
                                .iter()
                                .flat_map(|r| r.text.chars())
                                .filter(|c| marker_kind(*c).is_none())
                                .count()
                        })
                        .unwrap_or(0);
                }
            }
            LoweredBlock::Table(t) => {
                let n = t.flow.iter().map(|p| 1 + p.segments.len()).sum::<usize>()
                    + usize::from(t.flow.is_empty() && layout == TableParagraphs::Own);
                map.extend(std::iter::repeat_n(None, n));
            }
        }
    }
    anchors
        .iter()
        .filter(|a| !known.contains(a.name.as_str()) && !a.name.is_empty())
        .filter_map(|a| {
            let (block, base) = (*map.get(a.paragraph)?)?;
            let q = content.paragraphs.get(a.paragraph)?;
            // Word text: no markers, no field the canvas added.
            let codes: BTreeSet<&str> = match baseline.story.blocks.get(block) {
                Some(LoweredBlock::Paragraph(p)) => p
                    .runs
                    .iter()
                    .filter_map(|r| r.field.as_ref().map(|f| f.code.as_str()))
                    .collect(),
                _ => BTreeSet::new(),
            };
            let before = q
                .runs
                .iter()
                .flat_map(|r| {
                    let new = r
                        .field_code
                        .as_deref()
                        .is_some_and(|c| !codes.contains(c.trim()));
                    r.text.chars().map(move |c| (c, new))
                })
                .take(a.offset)
                .filter(|(c, new)| !new && marker_kind(*c).is_none())
                .count();
            Some((block, base + before, a.name.clone()))
        })
        .collect()
}

/// Splice the notes (doc ADR 611): kept notes whose engine text changed,
/// new notes, removed notes. Runs after the body is patched.
pub fn save_notes(
    pkg: &mut OpcPackage,
    main_part: &str,
    model: &DocxDocument,
    lowered: &LoweredDoc,
    changes: &StructureChanges,
    plan: &NotePlan,
    structure: &StructureIn,
) -> Result<Vec<String>, OoxmlError> {
    let mut skips = Vec::new();
    for endnote in [false, true] {
        let (suffix, root, note, _) = note_names(endnote);
        let marks = if endnote {
            &changes.endnotes
        } else {
            &changes.footnotes
        };
        let texts = if endnote {
            &structure.endnotes
        } else {
            &structure.footnotes
        };
        let removed: BTreeSet<i64> = changes
            .removed
            .iter()
            .filter(|(e, _)| *e == endnote)
            .map(|(_, id)| *id)
            .collect();
        let has_new = marks.contains(&NoteMark::New);
        if marks.is_empty() && removed.is_empty() {
            continue;
        }
        let aligned = texts.len() == marks.len();
        if !aligned && (has_new || !texts.is_empty()) {
            skips.push(format!(
                "the {note}s read back ({}) do not match the references in the text ({}): \
                 their text is not saved",
                texts.len(),
                marks.len()
            ));
        }
        let mut part = related_part(pkg, main_part, suffix);
        // Text edits of kept notes.
        if aligned {
            if let Some(part_name) = part.clone() {
                let xml = pkg.require(&part_name)?.to_vec();
                let layout = notes_in(&xml, note.as_bytes());
                let mut base = Vec::new();
                let mut edited = Vec::new();
                let mut source = Vec::new();
                for (mark, read) in marks.iter().zip(texts) {
                    let NoteMark::Kept(id) = mark else { continue };
                    let Some(ln) = lowered
                        .notes
                        .iter()
                        .find(|n| n.endnote == endnote && n.id == *id)
                    else {
                        continue;
                    };
                    if ln.text == read.text {
                        continue;
                    }
                    let Some(src) = model
                        .notes
                        .iter()
                        .find(|n| n.endnote == endnote && n.id == *id)
                    else {
                        continue;
                    };
                    // The note's paragraphs, numbered part-wide.
                    let mut first = 0u32;
                    for (nid, _, _, n) in &layout {
                        if nid == id {
                            break;
                        }
                        first += n;
                    }
                    let lead = ln
                        .paragraphs
                        .first()
                        .map(|p| p.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                        .is_some_and(|t| t.starts_with(' '));
                    let full = format!("{}{}", if lead { " " } else { "" }, read.text);
                    let lines: Vec<&str> = full.split('\n').collect();
                    if lines.len() != ln.paragraphs.len() {
                        skips.push(format!(
                            "{note} {id}: a paragraph was added to or removed from the note; \
                             its text is not saved"
                        ));
                        continue;
                    }
                    for ((p, line), sp) in ln.paragraphs.iter().zip(&lines).zip(&src.paragraphs) {
                        let mut e = p.clone();
                        if let Err(why) = crate::overlay::patch_runs(&mut e.runs, line) {
                            skips.push(format!("{note} {id}: {why}"));
                            continue;
                        }
                        base.push(p.clone());
                        edited.push(e);
                        let mut s = sp.clone();
                        s.source_para_ord += first;
                        source.push(s);
                    }
                }
                if !base.is_empty() {
                    skips.extend(splice_part(
                        pkg, &part_name, model, lowered, base, edited, source,
                    )?);
                }
            }
        }
        // Removed notes leave their part.
        if let Some(part_name) = part.clone().filter(|_| !removed.is_empty()) {
            let xml = pkg.require(&part_name)?.to_vec();
            let mut out = Vec::with_capacity(xml.len());
            let mut at = 0usize;
            for (id, s, e, _) in notes_in(&xml, note.as_bytes()) {
                if removed.contains(&id) {
                    out.extend_from_slice(&xml[at..s]);
                    at = e;
                }
            }
            out.extend_from_slice(&xml[at..]);
            pkg.set_part(&part_name, out);
            let body = pkg.require(main_part)?.to_vec();
            let element = if endnote {
                b"endnoteReference".as_slice()
            } else {
                b"footnoteReference".as_slice()
            };
            pkg.set_part(main_part, remove_references(&body, element, &removed));
        }
        // New notes are appended.
        if aligned && has_new {
            let part_name = match part.take() {
                Some(p) => p,
                None => create_notes_part(pkg, main_part, endnote),
            };
            let mut xml = String::from_utf8_lossy(pkg.require(&part_name)?).into_owned();
            let mut add = String::new();
            for (k, (mark, read)) in marks.iter().zip(texts).enumerate() {
                if *mark != NoteMark::New {
                    continue;
                }
                if let Some(id) = plan.new_ids.get(&(endnote, k)) {
                    add.push_str(&note_xml(model, endnote, *id, &read.text));
                }
            }
            match xml.rfind(&format!("</w:{root}>")) {
                Some(i) => {
                    xml.insert_str(i, &add);
                    pkg.set_part(&part_name, xml.into_bytes());
                }
                None => skips.push(format!(
                    "{part_name} has no w:{root} root: new {note}s not saved"
                )),
            }
        }
    }
    Ok(skips)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_in_a_run_is_removed_and_an_emptied_run_with_it() {
        let xml = br#"<w:p><w:r><w:t>A</w:t><w:footnoteReference w:id="2"/><w:t>B</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FR"/></w:rPr><w:footnoteReference w:id="3"/></w:r></w:p>"#;
        let ids: BTreeSet<i64> = [2, 3].into_iter().collect();
        let out = String::from_utf8(remove_references(xml, b"footnoteReference", &ids)).unwrap();
        assert_eq!(out, "<w:p><w:r><w:t>A</w:t><w:t>B</w:t></w:r></w:p>");
    }

    #[test]
    fn notes_are_listed_with_their_paragraph_counts() {
        let xml = br#"<w:footnotes><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:id="1"><w:p></w:p><w:p></w:p></w:footnote></w:footnotes>"#;
        let notes: Vec<(i64, u32)> = notes_in(xml, b"footnote")
            .into_iter()
            .map(|(id, _, _, n)| (id, n))
            .collect();
        assert_eq!(notes, [(-1, 1), (1, 2)]);
    }
}
