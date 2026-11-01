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

//! Threaded comments: `xl/threadedComments/threadedCommentN.xml` and
//! `xl/persons/person.xml` (MS-XLSX §2.5.5, sheet ADR 528).
//!
//! A thread is a root `<threadedComment ref id personId dT>` plus replies that
//! name the root in `parentId`. Excel keeps a legacy note beside every
//! thread: a `<comment>` whose author is `tc={root id}` and whose text is a
//! placeholder older Excels show, plus the note's VML shape. A write here
//! keeps the three in step (thread part, note, shape), creating the parts,
//! relationships and content types a workbook lacks, and leaves every other
//! part byte for byte alone. The parts a write rewrites are re-serialized
//! through [`XNode`], which keeps unknown attributes and children (mentions of
//! other comments, `extLst`).
//!
//! Identifiers and times come from the caller: [`GuidGen`] is a seeded
//! generator (no clock, no OS randomness, so a test is deterministic and the
//! crate stays wasm-clean), and `dT` is stored as given.

use crate::error::XlsxError;
use crate::rels::{part_dir, resolve_target};
use crate::xtree::XNode;
use crate::XlsxDocument;
use sheet_core::SheetId;

/// A worksheet → threaded-comments relationship type.
pub const REL_THREADED_FULL: &str =
    "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment";
/// A workbook → persons relationship type.
pub const REL_PERSON_FULL: &str =
    "http://schemas.microsoft.com/office/2017/10/relationships/person";
const REL_PERSON: &str = "/person";
const REL_THREADED: &str = "/threadedComment";
pub const CT_THREADED: &str = "application/vnd.ms-excel.threadedcomments+xml";
pub const CT_PERSON: &str = "application/vnd.ms-excel.person+xml";
const NS_TC: &str = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments";
const NS_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DEFAULT_PERSONS: &str = "xl/persons/person.xml";
const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const PLACEHOLDER_HEAD: &str = "[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\nComment:\n    ";

/// A person of `xl/persons/person.xml`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    /// The `{GUID}` the comments name in `personId`.
    pub id: String,
    pub display_name: String,
    pub user_id: String,
    pub provider_id: String,
}

/// Who writes a comment; a [`Person`] is found or created for it.
#[derive(Clone, Copy, Debug)]
pub struct Author<'a> {
    pub display_name: &'a str,
    pub user_id: &'a str,
    /// Excel writes `None` for a person without an account provider.
    pub provider_id: &'a str,
}

/// One comment of a thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadComment {
    pub id: String,
    /// The root's id for a reply, `None` for the root.
    pub parent_id: Option<String>,
    pub person_id: String,
    /// The person, when `person.xml` lists `person_id`.
    pub person: Option<Person>,
    /// `dT` as written (`2026-11-01T10:00:00.00`).
    pub timestamp: String,
    pub text: String,
    /// The `done` flag of the element (Excel sets it on the root).
    pub done: bool,
}

/// The thread on one cell: the root first, then the replies in file order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellThread {
    pub row: u32,
    pub col: u32,
    pub comments: Vec<ThreadComment>,
}

impl CellThread {
    pub fn root(&self) -> Option<&ThreadComment> {
        self.comments.iter().find(|c| c.parent_id.is_none())
    }

    /// Whether the thread is resolved (`done` on its root).
    pub fn resolved(&self) -> bool {
        self.root().is_some_and(|r| r.done)
    }
}

/// A seeded GUID source (splitmix64): the same seed gives the same ids.
#[derive(Clone, Debug)]
pub struct GuidGen {
    state: u64,
}

impl GuidGen {
    pub fn new(seed: u64) -> GuidGen {
        GuidGen { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// The next version-4 GUID in Excel's form, `{8-4-4-4-12}` upper case.
    pub fn next_guid(&mut self) -> String {
        let hi = self.next_u64();
        let lo = self.next_u64();
        let a = (hi >> 32) as u32;
        let b = (hi >> 16) as u16;
        let c = ((hi as u16) & 0x0FFF) | 0x4000;
        let d = (((lo >> 48) as u16) & 0x3FFF) | 0x8000;
        let e = lo & 0xFFFF_FFFF_FFFF;
        format!("{{{a:08X}-{b:04X}-{c:04X}-{d:04X}-{e:012X}}}")
    }

    fn fresh(&mut self, used: &[String]) -> String {
        loop {
            let g = self.next_guid();
            if !used.contains(&g) {
                return g;
            }
        }
    }
}

fn a1(row: u32, col: u32) -> String {
    sheet_core::format_a1(row, col, false, false).to_string()
}

fn persons_of_node(root: &XNode) -> Vec<Person> {
    root.children_named("person")
        .map(|p| Person {
            id: p.attr("id").unwrap_or_default(),
            display_name: p.attr("displayName").unwrap_or_default(),
            user_id: p.attr("userId").unwrap_or_default(),
            provider_id: p.attr("providerId").unwrap_or_default(),
        })
        .collect()
}

/// The threads of a `<ThreadedComments>` root, cells in first-appearance order.
fn group(root: &XNode, persons: &[Person]) -> Vec<CellThread> {
    let mut out: Vec<CellThread> = Vec::new();
    for n in root.children_named("threadedComment") {
        let Some((row, col, _, _)) = n.attr("ref").and_then(|s| sheet_core::parse_a1(&s)) else {
            continue;
        };
        let person_id = n.attr("personId").unwrap_or_default();
        let c = ThreadComment {
            id: n.attr("id").unwrap_or_default(),
            parent_id: n.attr("parentId").filter(|s| !s.is_empty()),
            person: persons.iter().find(|p| p.id == person_id).cloned(),
            person_id,
            timestamp: n.attr("dT").unwrap_or_default(),
            text: n
                .child("text")
                .and_then(|t| t.text.clone())
                .unwrap_or_default(),
            done: n.flag("done", false),
        };
        match out.iter_mut().find(|t| (t.row, t.col) == (row, col)) {
            Some(t) => t.comments.push(c),
            None => out.push(CellThread {
                row,
                col,
                comments: vec![c],
            }),
        }
    }
    for t in &mut out {
        t.comments.sort_by_key(|c| c.parent_id.is_some());
    }
    out
}

/// The text of the legacy note that pairs with a thread.
fn placeholder(thread: &CellThread) -> String {
    let mut s = String::from(PLACEHOLDER_HEAD);
    let mut first = true;
    for c in &thread.comments {
        if first {
            s.push_str(&c.text);
            first = false;
        } else {
            s.push_str("\nReply:\n    ");
            s.push_str(&c.text);
        }
    }
    s
}

fn serialize(root: &XNode) -> Vec<u8> {
    format!("{XML_DECL}{}", root.to_xml()).into_bytes()
}

fn all_ids(root: &XNode) -> Vec<String> {
    root.children.iter().filter_map(|c| c.attr("id")).collect()
}

fn structure(msg: impl Into<String>) -> XlsxError {
    XlsxError::Structure(msg.into())
}

impl XlsxDocument {
    /// The threaded-comments part of a sheet, if it has one.
    fn threaded_part_of(&self, sheet: SheetId) -> Option<String> {
        let ws = self.part_name_of(sheet)?;
        let rels = self.rels_of_part(ws)?;
        let rel = rels.by_type_suffix(REL_THREADED)?;
        Some(resolve_target(part_dir(ws), &rel.target))
    }

    /// The persons part of the workbook, if it has a relationship to one.
    fn persons_part(&self) -> Option<String> {
        let rels = self.rels_of_part(&self.workbook_part)?;
        let rel = rels.by_type_suffix(REL_PERSON)?;
        Some(resolve_target(part_dir(&self.workbook_part), &rel.target))
    }

    /// The people of `xl/persons/person.xml` (empty when there is none).
    pub fn persons(&self) -> Vec<Person> {
        self.persons_part()
            .and_then(|p| self.part_bytes(&p))
            .and_then(|b| XNode::parse(&b).ok())
            .map(|r| persons_of_node(&r))
            .unwrap_or_default()
    }

    /// The threads of a sheet, one per cell, persons resolved. Empty for a
    /// sheet without a threaded-comments part.
    pub fn threads_of(&self, sheet: SheetId) -> Vec<CellThread> {
        let Some(root) = self
            .threaded_part_of(sheet)
            .and_then(|p| self.part_bytes(&p))
            .and_then(|b| XNode::parse(&b).ok())
        else {
            return Vec::new();
        };
        group(&root, &self.persons())
    }

    fn load_threads(&self, sheet: SheetId) -> Result<Option<(String, XNode)>, XlsxError> {
        let Some(part) = self.threaded_part_of(sheet) else {
            return Ok(None);
        };
        let raw = self
            .part_bytes(&part)
            .ok_or_else(|| structure(format!("{part} is missing")))?;
        Ok(Some((part, XNode::parse(&raw)?)))
    }

    /// Write the threads part back, or take it (with its relationship and
    /// content type) out when no comment is left.
    fn store_threads(&mut self, sheet: SheetId, part: &str, root: &XNode) -> Result<(), XlsxError> {
        if root.children_named("threadedComment").next().is_some() {
            self.set_part_bytes(part, serialize(root));
            return Ok(());
        }
        let ws = self.ws_part_of(sheet)?;
        self.container.parts.retain(|p| p.name() != part);
        self.remove_override(part)?;
        if let Some(rels) = self.rels_of_part(&ws) {
            let ids: Vec<String> = rels
                .items
                .iter()
                .filter(|r| {
                    r.is_type(REL_THREADED) && resolve_target(part_dir(&ws), &r.target) == part
                })
                .map(|r| r.id.clone())
                .collect();
            for id in ids {
                self.remove_rel(&crate::rels::rels_part_name(&ws), &id)?;
            }
        }
        self.container.dirty = true;
        Ok(())
    }

    /// Bring the legacy note of `(row, col)` in line with the thread there.
    fn sync_note(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        root: &XNode,
    ) -> Result<(), XlsxError> {
        let threads = group(root, &[]);
        // The note may add or take out the sheet's `<legacyDrawing>`, which
        // the sheet's save re-encodes only when the sheet is marked dirty.
        let had_drawing = self.ws_child(sheet, "legacyDrawing").is_some();
        match threads.iter().find(|t| (t.row, t.col) == (row, col)) {
            Some(t) => {
                let id = t
                    .root()
                    .map(|r| r.id.clone())
                    .ok_or_else(|| structure("a thread without a root comment"))?;
                self.put_note(sheet, row, col, &format!("tc={id}"), &placeholder(t))?;
            }
            None => {
                self.remove_note(sheet, row, col)?;
            }
        }
        if had_drawing != self.ws_child(sheet, "legacyDrawing").is_some() {
            self.mark_sheet_dirty(sheet);
        }
        Ok(())
    }

    /// The person for `author` (found by account, created when new).
    fn ensure_person(
        &mut self,
        author: &Author<'_>,
        gen: &mut GuidGen,
    ) -> Result<String, XlsxError> {
        let rel_part = self.persons_part();
        let part = rel_part
            .clone()
            .unwrap_or_else(|| DEFAULT_PERSONS.to_string());
        let mut root = match self.part_bytes(&part) {
            Some(raw) => XNode::parse(&raw)?,
            None => {
                let body = format!("<personList xmlns=\"{NS_TC}\" xmlns:x=\"{NS_MAIN}\"/>");
                XNode::parse(body.as_bytes())?
            }
        };
        let people = persons_of_node(&root);
        let same = |p: &Person| {
            if author.user_id.is_empty() {
                p.user_id.is_empty() && p.display_name == author.display_name
            } else {
                p.user_id == author.user_id && p.provider_id == author.provider_id
            }
        };
        if let Some(p) = people.iter().find(|p| same(p)) {
            return Ok(p.id.clone());
        }
        let used: Vec<String> = people.iter().map(|p| p.id.clone()).collect();
        let id = gen.fresh(&used);
        let pfx = root.prefix().to_string();
        root.children.push(
            XNode::new(format!("{pfx}person"))
                .with_attr("displayName", author.display_name)
                .with_attr("id", id.clone())
                .with_attr("userId", author.user_id)
                .with_attr("providerId", author.provider_id),
        );
        if self.container.part(&part).is_some() {
            self.set_part_bytes(&part, serialize(&root));
        } else {
            self.container.parts.push(crate::opc::PartEntry::Opaque {
                name: part.clone(),
                bytes: serialize(&root),
            });
            self.container.dirty = true;
        }
        self.add_override(&part, CT_PERSON)?;
        if rel_part.is_none() {
            let wb = self.workbook_part.clone();
            let target = match part.strip_prefix(&format!("{}/", part_dir(&wb))) {
                Some(rel) => rel.to_string(),
                None => format!("/{part}"),
            };
            self.add_part_rel(&wb, REL_PERSON_FULL, &target, false)?;
        }
        Ok(id)
    }

    /// The threads part of a sheet, created (part, content type, relationship)
    /// when the sheet has none.
    fn threads_for_write(&mut self, sheet: SheetId) -> Result<(String, XNode), XlsxError> {
        if let Some(found) = self.load_threads(sheet)? {
            return Ok(found);
        }
        let ws = self.ws_part_of(sheet)?;
        let mut n = 1;
        let part = loop {
            let cand = format!("xl/threadedComments/threadedComment{n}.xml");
            if self.container.part(&cand).is_none() {
                break cand;
            }
            n += 1;
        };
        let root = XNode::parse(
            format!("<ThreadedComments xmlns=\"{NS_TC}\" xmlns:x=\"{NS_MAIN}\"/>").as_bytes(),
        )?;
        self.container.parts.push(crate::opc::PartEntry::Opaque {
            name: part.clone(),
            bytes: serialize(&root),
        });
        self.add_override(&part, CT_THREADED)?;
        let target = if part_dir(&ws) == "xl/worksheets" {
            format!("../threadedComments/threadedComment{n}.xml")
        } else {
            format!("/{part}")
        };
        self.add_part_rel(&ws, REL_THREADED_FULL, &target, false)?;
        Ok((part, root))
    }

    /// Start a thread on `(row, col)`: the root comment, its person, the parts
    /// and the paired note. Returns the root's id. A cell with a thread or a
    /// plain note is refused.
    pub fn add_thread(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        author: &Author<'_>,
        timestamp: &str,
        text: &str,
        gen: &mut GuidGen,
    ) -> Result<String, XlsxError> {
        if text.is_empty() || timestamp.is_empty() {
            return Err(structure("a comment needs a text and a time"));
        }
        self.ws_part_of(sheet)?;
        if self
            .threads_of(sheet)
            .iter()
            .any(|t| (t.row, t.col) == (row, col))
        {
            return Err(structure(format!(
                "{} already carries a thread",
                a1(row, col)
            )));
        }
        if self
            .comments_of(sheet)
            .is_some_and(|c| c.at(row, col).is_some())
        {
            return Err(structure(format!(
                "{} carries a note; delete it before starting a thread",
                a1(row, col)
            )));
        }
        let person = self.ensure_person(author, gen)?;
        let (part, mut root) = self.threads_for_write(sheet)?;
        let id = gen.fresh(&all_ids(&root));
        let pfx = root.prefix().to_string();
        root.children.push(comment_node(
            &pfx, row, col, timestamp, &person, &id, None, text,
        ));
        self.store_threads(sheet, &part, &root)?;
        self.sync_note(sheet, row, col, &root)?;
        Ok(id)
    }

    /// Reply to the thread on `(row, col)` (the reply names the root as its
    /// parent, as Excel does). Returns the reply's id.
    pub fn reply_thread(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        author: &Author<'_>,
        timestamp: &str,
        text: &str,
        gen: &mut GuidGen,
    ) -> Result<String, XlsxError> {
        if text.is_empty() || timestamp.is_empty() {
            return Err(structure("a comment needs a text and a time"));
        }
        let (part, mut root) = self
            .load_threads(sheet)?
            .ok_or_else(|| structure(format!("{} has no thread", a1(row, col))))?;
        let root_id = group(&root, &[])
            .iter()
            .find(|t| (t.row, t.col) == (row, col))
            .and_then(|t| t.root().map(|r| r.id.clone()))
            .ok_or_else(|| structure(format!("{} has no thread", a1(row, col))))?;
        let person = self.ensure_person(author, gen)?;
        let id = gen.fresh(&all_ids(&root));
        let pfx = root.prefix().to_string();
        // After the thread's last comment, so the file stays grouped by thread.
        let at = root
            .children
            .iter()
            .rposition(|c| c.attr("ref").as_deref() == Some(a1(row, col).as_str()))
            .map_or(root.children.len(), |i| i + 1);
        root.children.insert(
            at,
            comment_node(
                &pfx,
                row,
                col,
                timestamp,
                &person,
                &id,
                Some(&root_id),
                text,
            ),
        );
        self.store_threads(sheet, &part, &root)?;
        self.sync_note(sheet, row, col, &root)?;
        Ok(id)
    }

    /// Replace the text of a comment (root or reply). Its mentions go, as
    /// their offsets would no longer fit. `false` when `id` is unknown.
    pub fn edit_thread_comment(
        &mut self,
        sheet: SheetId,
        id: &str,
        text: &str,
    ) -> Result<bool, XlsxError> {
        if text.is_empty() {
            return Err(structure("a comment needs a text"));
        }
        let Some((part, mut root)) = self.load_threads(sheet)? else {
            return Ok(false);
        };
        let Some(n) = root
            .children
            .iter_mut()
            .find(|c| c.local() == "threadedComment" && c.attr("id").as_deref() == Some(id))
        else {
            return Ok(false);
        };
        let pfx = n.prefix().to_string();
        let reference = n.attr("ref").unwrap_or_default();
        n.remove_children("text");
        n.remove_children("mentions");
        n.children
            .insert(0, XNode::new(format!("{pfx}text")).with_text(text));
        self.store_threads(sheet, &part, &root)?;
        if let Some((row, col, _, _)) = sheet_core::parse_a1(&reference) {
            self.sync_note(sheet, row, col, &root)?;
        }
        Ok(true)
    }

    /// Delete a comment. A root takes its replies and the thread's note with
    /// it. `false` when `id` is unknown.
    pub fn delete_thread_comment(&mut self, sheet: SheetId, id: &str) -> Result<bool, XlsxError> {
        let Some((part, mut root)) = self.load_threads(sheet)? else {
            return Ok(false);
        };
        let Some(target) = root
            .children
            .iter()
            .find(|c| c.local() == "threadedComment" && c.attr("id").as_deref() == Some(id))
        else {
            return Ok(false);
        };
        let reference = target.attr("ref").unwrap_or_default();
        let mut gone = vec![id.to_string()];
        loop {
            let more: Vec<String> = root
                .children
                .iter()
                .filter(|c| {
                    c.attr("parentId").is_some_and(|p| gone.contains(&p))
                        && c.attr("id").is_some_and(|i| !gone.contains(&i))
                })
                .filter_map(|c| c.attr("id"))
                .collect();
            if more.is_empty() {
                break;
            }
            gone.extend(more);
        }
        root.children
            .retain(|c| !c.attr("id").is_some_and(|i| gone.contains(&i)));
        self.store_threads(sheet, &part, &root)?;
        if let Some((row, col, _, _)) = sheet_core::parse_a1(&reference) {
            self.sync_note(sheet, row, col, &root)?;
        }
        Ok(true)
    }

    /// Resolve (`done`) or reopen the thread on `(row, col)`. `false` when
    /// the cell has no thread.
    pub fn set_thread_done(
        &mut self,
        sheet: SheetId,
        row: u32,
        col: u32,
        done: bool,
    ) -> Result<bool, XlsxError> {
        let Some((part, mut root)) = self.load_threads(sheet)? else {
            return Ok(false);
        };
        let reference = a1(row, col);
        let Some(n) = root.children.iter_mut().find(|c| {
            c.local() == "threadedComment"
                && c.attr("ref").as_deref() == Some(reference.as_str())
                && c.attr("parentId").is_none()
        }) else {
            return Ok(false);
        };
        n.set("done", done.then(|| "1".to_string()));
        self.set_part_bytes(&part, serialize(&root));
        Ok(true)
    }
}

fn comment_node(
    pfx: &str,
    row: u32,
    col: u32,
    timestamp: &str,
    person: &str,
    id: &str,
    parent: Option<&str>,
    text: &str,
) -> XNode {
    let mut n = XNode::new(format!("{pfx}threadedComment"))
        .with_attr("ref", a1(row, col))
        .with_attr("dT", timestamp)
        .with_attr("personId", person)
        .with_attr("id", id);
    if let Some(p) = parent {
        n = n.with_attr("parentId", p);
    }
    n.with_child(XNode::new(format!("{pfx}text")).with_text(text))
}

#[cfg(test)]
mod tests;
