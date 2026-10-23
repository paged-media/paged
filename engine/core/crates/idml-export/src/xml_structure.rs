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

//! Engine ADR 1002 — the XML structure written from the model.
//!
//! An imported document whose structure nothing changed keeps its source
//! `XML/` parts and story elements byte for byte. Once an operation changed
//! the structure (`DesignMap::xml_structure_edited`), this module writes it
//! as InDesign 20.0.1 does (core `xml-structure-probe`):
//!
//! - `XML/Tags.xml`: each `<XMLTag Self Name>` with its `TagColor`;
//! - `XML/BackingStory.xml`: the root element and its tree in the back
//!   story, an element tagging a story or a page item as an empty element
//!   naming it in `XMLContent`;
//! - in each story part, the element tagging the story around its
//!   paragraphs, and each element tagging a range around its text inside
//!   the character range.
//!
//! The ranges are placed by the story writer itself: before a story is
//! written, a private-use character marks each range's start and end in a
//! copy of its text ([`mark_ranges`]), the writer puts them in `<Content>`
//! where the text goes, and [`place_elements`] turns them into element
//! markup. A range that would cut across a character range is closed where
//! that character range ends.

use std::io::Cursor;

use paged_model::{Story, XmlElement, XmlTag};
use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer};

const NS: &str = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging";

/// The first marker: range `i` starts at `MARK + 2i` and ends at
/// `MARK + 2i + 1` (Supplementary Private Use Area-A, never text).
const MARK: u32 = 0xF_0000;

fn mark_of(i: usize, end: bool) -> char {
    char::from_u32(MARK + 2 * i as u32 + u32::from(end)).expect("a private-use character")
}

fn marked(c: char) -> Option<(usize, bool)> {
    let n = c as u32;
    (MARK..MARK + 0xFFFE)
        .contains(&n)
        .then(|| (((n - MARK) / 2) as usize, (n - MARK) % 2 == 1))
}

fn writer() -> Writer<Cursor<Vec<u8>>> {
    Writer::new(Cursor::new(Vec::new()))
}

fn decl(w: &mut Writer<Cursor<Vec<u8>>>) -> Result<(), quick_xml::Error> {
    w.write_event(Event::Decl(quick_xml::events::BytesDecl::new(
        "1.0",
        Some("UTF-8"),
        Some("yes"),
    )))?;
    w.write_event(Event::Text(BytesText::from_escaped("\n")))?;
    Ok(())
}

fn pkg(name: &str, dom: &str) -> BytesStart<'static> {
    let mut s = BytesStart::new(name.to_string());
    s.push_attribute(("xmlns:idPkg", NS));
    s.push_attribute(("DOMVersion", dom));
    s
}

/// `XML/Tags.xml`.
pub fn tags_part(tags: &[XmlTag], dom: &str) -> Result<Vec<u8>, quick_xml::Error> {
    let mut w = writer();
    decl(&mut w)?;
    w.write_event(Event::Start(pkg("idPkg:Tags", dom)))?;
    for tag in tags {
        let mut s = BytesStart::new("XMLTag");
        s.push_attribute(("Self", tag.self_id.as_str()));
        s.push_attribute(("Name", tag.name.as_str()));
        match &tag.color {
            Some(color) => {
                w.write_event(Event::Start(s))?;
                w.write_event(Event::Start(BytesStart::new("Properties")))?;
                let mut c = BytesStart::new("TagColor");
                let triple = color.split_whitespace().count() == 3;
                c.push_attribute(("type", if triple { "list" } else { "enumeration" }));
                w.write_event(Event::Start(c))?;
                w.write_event(Event::Text(BytesText::new(color)))?;
                w.write_event(Event::End(BytesEnd::new("TagColor")))?;
                w.write_event(Event::End(BytesEnd::new("Properties")))?;
                w.write_event(Event::End(BytesEnd::new("XMLTag")))?;
            }
            None => w.write_event(Event::Empty(s))?,
        }
    }
    w.write_event(Event::End(BytesEnd::new("idPkg:Tags")))?;
    Ok(w.into_inner().into_inner())
}

fn element_start(el: &XmlElement, content: Option<&str>) -> BytesStart<'static> {
    let mut s = BytesStart::new("XMLElement");
    s.push_attribute(("Self", el.self_id.as_str()));
    s.push_attribute(("MarkupTag", el.tag.as_str()));
    if let Some(c) = content {
        s.push_attribute(("XMLContent", c));
    }
    s.into_owned()
}

fn write_attributes(
    w: &mut Writer<Cursor<Vec<u8>>>,
    el: &XmlElement,
) -> Result<(), quick_xml::Error> {
    for (name, value) in &el.attributes {
        let mut a = BytesStart::new("XMLAttribute");
        a.push_attribute((
            "Self",
            format!("{}XMLAttributen{name}", el.self_id).as_str(),
        ));
        a.push_attribute(("Name", name.as_str()));
        a.push_attribute(("Value", value.as_str()));
        w.write_event(Event::Empty(a))?;
    }
    Ok(())
}

/// `XML/BackingStory.xml`: the root's tree. `is_story` says whether an
/// element's `XMLContent` names a story (it is written sanitized, as the
/// story's own part names it); `story_attributes` whether that story keeps
/// the element's attributes in its own part.
pub fn backing_story_part(
    root: Option<&XmlElement>,
    dom: &str,
    story_keeps_attributes: &dyn Fn(&str) -> bool,
) -> Result<Vec<u8>, quick_xml::Error> {
    fn write(
        w: &mut Writer<Cursor<Vec<u8>>>,
        el: &XmlElement,
        keeps: &dyn Fn(&str) -> bool,
    ) -> Result<(), quick_xml::Error> {
        let content = el.content.as_deref().map(crate::emit::sanitize_id);
        let in_story = el.content.as_deref().is_some_and(keeps);
        let attributes = !in_story && !el.attributes.is_empty();
        let children: Vec<&XmlElement> = el.children.iter().filter(|c| c.range.is_none()).collect();
        let s = element_start(el, content.as_deref());
        if !attributes && children.is_empty() {
            w.write_event(Event::Empty(s))?;
            return Ok(());
        }
        w.write_event(Event::Start(s))?;
        if attributes {
            write_attributes(w, el)?;
        }
        for child in children {
            write(w, child, keeps)?;
        }
        w.write_event(Event::End(BytesEnd::new("XMLElement")))?;
        Ok(())
    }
    let mut w = writer();
    decl(&mut w)?;
    w.write_event(Event::Start(pkg("idPkg:BackingStory", dom)))?;
    let mut story = BytesStart::new("XmlStory");
    story.push_attribute(("Self", "ubackingstory"));
    story.push_attribute(("UserText", "true"));
    w.write_event(Event::Start(story))?;
    let mut psr = BytesStart::new("ParagraphStyleRange");
    psr.push_attribute((
        "AppliedParagraphStyle",
        "ParagraphStyle/$ID/NormalParagraphStyle",
    ));
    w.write_event(Event::Start(psr))?;
    let mut csr = BytesStart::new("CharacterStyleRange");
    csr.push_attribute((
        "AppliedCharacterStyle",
        "CharacterStyle/$ID/[No character style]",
    ));
    w.write_event(Event::Start(csr))?;
    if let Some(root) = root {
        write(&mut w, root, story_keeps_attributes)?;
    }
    w.write_event(Event::Start(BytesStart::new("Content")))?;
    w.write_event(Event::Text(BytesText::from_escaped("&#xFEFF;")))?;
    w.write_event(Event::End(BytesEnd::new("Content")))?;
    w.write_event(Event::End(BytesEnd::new("CharacterStyleRange")))?;
    w.write_event(Event::End(BytesEnd::new("ParagraphStyleRange")))?;
    w.write_event(Event::End(BytesEnd::new("XmlStory")))?;
    w.write_event(Event::End(BytesEnd::new("idPkg:BackingStory")))?;
    Ok(w.into_inner().into_inner())
}

/// A story part without its XML elements and their attributes, the text
/// they wrapped kept in place: what the story writer patches when the model
/// writes the structure.
pub fn strip_story_elements(part: &[u8]) -> Result<Vec<u8>, quick_xml::Error> {
    let mut reader = Reader::from_reader(part);
    reader.config_mut().trim_text(false);
    let mut w = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();
    loop {
        let event = reader.read_event_into(&mut buf)?;
        match &event {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e)
                if matches!(e.name().as_ref(), b"XMLElement" | b"XMLAttribute") => {}
            Event::End(e) if matches!(e.name().as_ref(), b"XMLElement" | b"XMLAttribute") => {}
            _ => w.write_event(event.borrow())?,
        }
        buf.clear();
    }
    Ok(w.into_inner().into_inner())
}

/// The elements of a story that tag ranges, depth first: the order of
/// their markers.
fn range_elements(story: &Story) -> Vec<&XmlElement> {
    story
        .xml_elements
        .iter()
        .filter(|e| e.content.is_some())
        .flat_map(|e| e.walk().into_iter().skip(1))
        .filter(|e| e.range.is_some())
        .collect()
}

/// A copy of `story` with each tagged range's start and end marked in its
/// text, for the story writer; `None` when it has no tagged range.
pub fn mark_ranges(story: &Story) -> Option<Story> {
    let elements = range_elements(story);
    if elements.is_empty() {
        return None;
    }
    let len = story.flat_text().chars().count() as u32;
    // (position, phase, order, marker): at one position the ranges that end
    // close first, inner first; then the ranges that start open, outer
    // first; an empty range opens and closes last.
    let mut marks: Vec<(u32, u8, i64, char)> = Vec::new();
    for (i, el) in elements.iter().enumerate() {
        let r = el.range.expect("a range");
        let (start, end) = (r.start.min(len), r.end.min(len));
        if start == end {
            marks.push((start, 1, -(end as i64) * 1000 + i as i64, mark_of(i, false)));
            marks.push((start, 2, i as i64, mark_of(i, true)));
        } else {
            marks.push((start, 1, -(end as i64) * 1000 + i as i64, mark_of(i, false)));
            marks.push((end, 0, -(start as i64) * 1000 - i as i64, mark_of(i, true)));
        }
    }
    marks.sort_by_key(|m| (m.0, m.1, m.2));
    let mut out = story.clone();
    // Inserted from the last so earlier positions stay true; at one
    // position in reverse, so they read in order.
    for (pos, phase, _, c) in marks.into_iter().rev() {
        insert_mark(&mut out, pos, c, phase == 1 || phase == 2);
    }
    Some(out)
}

/// Inserts `c` at story character `pos`: at a run boundary into the run
/// that starts there when `opening`, the run that ends there otherwise,
/// never into a text variable's run.
fn insert_mark(story: &mut Story, pos: u32, c: char, opening: bool) {
    let mut at = 0u32;
    let mut slots: Vec<(usize, usize, u32)> = Vec::new();
    for (pi, para) in story.paragraphs.iter().enumerate() {
        for (ri, run) in para.runs.iter().enumerate() {
            let n = run.text.chars().count() as u32;
            if pos >= at && pos <= at + n {
                slots.push((pi, ri, pos - at));
            }
            at += n;
        }
    }
    let usable = |story: &Story, (pi, ri, _): &(usize, usize, u32)| {
        story.paragraphs[*pi].runs[*ri].text_variable.is_none()
    };
    let pick = if opening {
        slots.iter().rev().find(|s| usable(story, s))
    } else {
        slots.iter().find(|s| usable(story, s))
    }
    .copied();
    match pick {
        Some((pi, ri, local)) => {
            let text = &mut story.paragraphs[pi].runs[ri].text;
            let byte = text
                .char_indices()
                .nth(local as usize)
                .map_or(text.len(), |(b, _)| b);
            text.insert(byte, c);
        }
        None => {
            // Only a text variable stands there (or the story is empty): a
            // run of its own beside it.
            let (pi, ri) = slots
                .first()
                .map(|(p, r, l)| (*p, if *l == 0 { *r } else { r + 1 }))
                .unwrap_or((0, 0));
            if story.paragraphs.is_empty() {
                story.paragraphs.push(Default::default());
            }
            let mut run = story.paragraphs[pi]
                .runs
                .get(ri.saturating_sub(1))
                .cloned()
                .unwrap_or_default();
            run.text_variable = None;
            run.placeholder = None;
            run.text = c.to_string();
            let at = ri.min(story.paragraphs[pi].runs.len());
            story.paragraphs[pi].runs.insert(at, run);
        }
    }
}

/// The written story part with its elements in place: the element tagging
/// the story around its paragraphs, and the markers [`mark_ranges`] left
/// in its text turned into the elements tagging its ranges. A story the
/// model tags nothing in comes back without elements.
pub fn place_elements(part: &[u8], story: &Story) -> Result<Vec<u8>, quick_xml::Error> {
    let top = story.xml_elements.iter().find(|e| e.content.is_some());
    let ranges = range_elements(story);
    let mut reader = Reader::from_reader(part);
    reader.config_mut().trim_text(false);
    let mut w = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();
    let mut story_depth: Option<usize> = None;
    let mut depth = 0usize;
    let mut top_open = false;
    let mut in_content = false;
    // Open range elements: (index, the character-range depth it opened in).
    let mut open: Vec<(usize, usize)> = Vec::new();
    let mut csr_depth = 0usize;
    let mut closed_early: Vec<usize> = Vec::new();
    let open_top = |w: &mut Writer<Cursor<Vec<u8>>>, top_open: &mut bool| {
        if let (Some(el), false) = (top, *top_open) {
            *top_open = true;
            let content = el.content.as_deref().map(crate::emit::sanitize_id);
            w.write_event(Event::Start(element_start(el, content.as_deref())))?;
            write_attributes(w, el)?;
        }
        Ok::<(), quick_xml::Error>(())
    };
    loop {
        let event = reader.read_event_into(&mut buf)?;
        match &event {
            Event::Eof => break,
            Event::Start(e) => {
                let name = e.name();
                if name.as_ref() == b"Story" && story_depth.is_none() {
                    story_depth = Some(depth + 1);
                } else if story_depth == Some(depth) && name.as_ref() == b"ParagraphStyleRange" {
                    open_top(&mut w, &mut top_open)?;
                }
                if name.as_ref() == b"CharacterStyleRange" {
                    csr_depth += 1;
                }
                if name.as_ref() == b"Content" {
                    in_content = true;
                }
                depth += 1;
                w.write_event(event.borrow())?;
            }
            Event::End(e) => {
                let name = e.name();
                depth = depth.saturating_sub(1);
                if name.as_ref() == b"Content" {
                    in_content = false;
                }
                if name.as_ref() == b"CharacterStyleRange" {
                    // A range cannot cut across a character range: close
                    // what opened in this one.
                    while open.last().is_some_and(|(_, d)| *d == csr_depth) {
                        let (i, _) = open.pop().expect("checked");
                        closed_early.push(i);
                        w.write_event(Event::End(BytesEnd::new("XMLElement")))?;
                    }
                    csr_depth = csr_depth.saturating_sub(1);
                }
                if name.as_ref() == b"Story" && story_depth == Some(depth + 1) {
                    if top.is_some() && !top_open {
                        open_top(&mut w, &mut top_open)?;
                    }
                    if top_open {
                        w.write_event(Event::End(BytesEnd::new("XMLElement")))?;
                    }
                }
                w.write_event(event.borrow())?;
            }
            Event::Text(t) if in_content => {
                let text = t.decode().map_err(quick_xml::Error::from)?;
                let text = quick_xml::escape::unescape(&text)
                    .map_err(quick_xml::Error::from)?
                    .into_owned();
                if !text.chars().any(|c| marked(c).is_some()) {
                    w.write_event(event.borrow())?;
                } else {
                    let mut run = String::new();
                    for c in text.chars() {
                        let Some((i, end)) = marked(c) else {
                            run.push(c);
                            continue;
                        };
                        if !run.is_empty() {
                            w.write_event(Event::Text(BytesText::new(&run)))?;
                            run.clear();
                        }
                        w.write_event(Event::End(BytesEnd::new("Content")))?;
                        if end {
                            if open.last().is_some_and(|(o, _)| *o == i) {
                                open.pop();
                                w.write_event(Event::End(BytesEnd::new("XMLElement")))?;
                            }
                        } else if let Some(el) = ranges.get(i) {
                            w.write_event(Event::Start(element_start(el, None)))?;
                            write_attributes(&mut w, el)?;
                            open.push((i, csr_depth));
                        }
                        w.write_event(Event::Start(BytesStart::new("Content")))?;
                    }
                    if !run.is_empty() {
                        w.write_event(Event::Text(BytesText::new(&run)))?;
                    }
                }
            }
            _ => w.write_event(event.borrow())?,
        }
        buf.clear();
    }
    let _ = closed_early;
    let out = w.into_inner().into_inner();
    Ok(drop_empty_content(out))
}

/// `<Content></Content>` pairs the splitting left are no text at all.
fn drop_empty_content(mut bytes: Vec<u8>) -> Vec<u8> {
    const EMPTY: &[u8] = b"<Content></Content>";
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(EMPTY) {
            i += EMPTY.len();
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    std::mem::swap(&mut bytes, &mut out);
    bytes
}

/// The design map with `<idPkg:Tags>` and `<idPkg:BackingStory>` references
/// when it lacks them: the tags after the preferences (or the styles), the
/// back story before the first story.
pub fn ensure_xml_refs(designmap: &[u8]) -> Result<Vec<u8>, quick_xml::Error> {
    let mut reader = Reader::from_reader(designmap);
    reader.config_mut().trim_text(false);
    let mut has_tags = false;
    let mut has_backing = false;
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) => match e.name().as_ref() {
                b"idPkg:Tags" => has_tags = true,
                b"idPkg:BackingStory" => has_backing = true,
                _ => {}
            },
            _ => {}
        }
        buf.clear();
    }
    if has_tags && has_backing {
        return Ok(designmap.to_vec());
    }
    let mut reader = Reader::from_reader(designmap);
    reader.config_mut().trim_text(false);
    let mut w = Writer::new(Cursor::new(Vec::new()));
    let mut tags_done = has_tags;
    let mut backing_done = has_backing;
    let tags_ref = || {
        let mut s = BytesStart::new("idPkg:Tags");
        s.push_attribute(("src", "XML/Tags.xml"));
        s
    };
    let backing_ref = || {
        let mut s = BytesStart::new("idPkg:BackingStory");
        s.push_attribute(("src", "XML/BackingStory.xml"));
        s
    };
    let mut after_resources = false;
    loop {
        let event = reader.read_event_into(&mut buf)?;
        match &event {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) => {
                let name = e.name();
                let name = name.as_ref();
                let resource = matches!(
                    name,
                    b"idPkg:Graphic" | b"idPkg:Fonts" | b"idPkg:Styles" | b"idPkg:Preferences"
                );
                if !resource && after_resources && !tags_done {
                    w.write_event(Event::Empty(tags_ref()))?;
                    w.write_event(Event::Text(BytesText::from_escaped("\n")))?;
                    tags_done = true;
                }
                if name == b"idPkg:Story" && !backing_done {
                    w.write_event(Event::Empty(backing_ref()))?;
                    w.write_event(Event::Text(BytesText::from_escaped("\n")))?;
                    backing_done = true;
                }
                after_resources |= resource;
                w.write_event(event.borrow())?;
            }
            Event::End(e) if e.name().as_ref() == b"Document" => {
                if !tags_done {
                    w.write_event(Event::Empty(tags_ref()))?;
                    tags_done = true;
                }
                if !backing_done {
                    w.write_event(Event::Empty(backing_ref()))?;
                    backing_done = true;
                }
                w.write_event(event.borrow())?;
            }
            _ => w.write_event(event.borrow())?,
        }
        buf.clear();
    }
    Ok(w.into_inner().into_inner())
}
