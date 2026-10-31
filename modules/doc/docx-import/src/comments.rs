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

//! Doc ADR 613 — the comment parts: `comments.xml` (the comments and their
//! text), `commentsExtended.xml` (Word 2013's threads: a reply names its
//! parent's last paragraph, `w15:done` resolves a thread) and
//! `commentsIds.xml` (Word 2016's durable ids). Read with the shared element
//! tree; every part is optional.

use docx_core::Comment;
use paged_ooxml::tree::{self, El};
use paged_ooxml::{part_dir, rels, resolve_target, OpcPackage};

/// The comment parts a document has, by part name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommentParts {
    pub comments: Option<String>,
    pub extended: Option<String>,
    pub ids: Option<String>,
}

/// The comment parts of the main part's relationships.
pub fn comments_parts(pkg: &OpcPackage, main_part: &str) -> CommentParts {
    let Some(rels_bytes) = pkg.part(&rels::rels_part_name(main_part)) else {
        return CommentParts::default();
    };
    let rels = rels::Relationships::parse(rels_bytes);
    let part = |suffix: &str| {
        rels.by_type_suffix(suffix)
            .map(|r| resolve_target(part_dir(main_part), &r.target))
            .filter(|name| pkg.part(name).is_some())
    };
    CommentParts {
        comments: part("/comments"),
        extended: part("/commentsExtended"),
        ids: part("/commentsIds"),
    }
}

fn parsed(pkg: &OpcPackage, name: &Option<String>) -> Option<El> {
    name.as_ref()
        .and_then(|n| pkg.part(n))
        .and_then(|b| tree::parse(b).ok())
}

/// A comment paragraph's text: its runs' `w:t`, tabs and breaks.
fn paragraph_text(p: &El, out: &mut String) {
    for c in &p.children {
        match c.local.as_str() {
            "t" => out.push_str(&c.text),
            "tab" => out.push('\t'),
            "br" | "cr" => out.push('\u{2028}'),
            // A run, a hyperlink, a tracked insertion: their text.
            "r" | "hyperlink" | "ins" | "smartTag" | "fldSimple" => paragraph_text(c, out),
            _ => {}
        }
    }
}

/// Every comment of the document, threaded, in `comments.xml` order.
pub fn read_comments(pkg: &OpcPackage, main_part: &str) -> Vec<Comment> {
    let parts = comments_parts(pkg, main_part);
    let Some(root) = parsed(pkg, &parts.comments) else {
        return Vec::new();
    };
    let mut out: Vec<Comment> = Vec::new();
    for c in root.children.iter().filter(|c| c.local == "comment") {
        let Some(id) = c.attr_i64("id") else {
            continue;
        };
        let mut text = String::new();
        let mut para_id = None;
        for (k, p) in c.children.iter().filter(|p| p.local == "p").enumerate() {
            if k > 0 {
                text.push('\n');
            }
            paragraph_text(p, &mut text);
            para_id = p.attr("paraId").map(str::to_string).or(para_id);
        }
        out.push(Comment {
            id,
            author: c.attr("author").map(str::to_string),
            initials: c.attr("initials").map(str::to_string),
            date: c.attr("date").map(str::to_string),
            text,
            para_id,
            ..Comment::default()
        });
    }
    // Threads and their state.
    if let Some(ext) = parsed(pkg, &parts.extended) {
        for e in ext.children.iter().filter(|e| e.local == "commentEx") {
            let Some(pid) = e.attr("paraId") else {
                continue;
            };
            let parent = e.attr("paraIdParent").and_then(|pp| {
                out.iter()
                    .find(|c| c.para_id.as_deref() == Some(pp))
                    .map(|c| c.id)
            });
            let done = e.attr_bool("done").unwrap_or(false);
            if let Some(c) = out.iter_mut().find(|c| c.para_id.as_deref() == Some(pid)) {
                c.parent = parent.filter(|p| *p != c.id);
                c.done = done;
            }
        }
    }
    if let Some(ids) = parsed(pkg, &parts.ids) {
        for e in ids.children.iter().filter(|e| e.local == "commentId") {
            if let (Some(pid), Some(durable)) = (e.attr("paraId"), e.attr("durableId")) {
                if let Some(c) = out.iter_mut().find(|c| c.para_id.as_deref() == Some(pid)) {
                    c.durable_id = Some(durable.to_string());
                }
            }
        }
    }
    // A reply's reply belongs to the same thread: point it at the root.
    let parents: Vec<(i64, Option<i64>)> = out.iter().map(|c| (c.id, c.parent)).collect();
    for c in out.iter_mut() {
        let mut at = c.parent;
        for _ in 0..32 {
            match at.and_then(|p| parents.iter().find(|(id, _)| *id == p)) {
                Some((id, Some(up))) if *up != *id => at = Some(*up),
                _ => break,
            }
        }
        c.parent = at;
    }
    out
}
