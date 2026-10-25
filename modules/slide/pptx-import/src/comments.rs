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

//! Review comments (slide ADR 711): PowerPoint's modern threaded comments
//! (`ppt/comments/modernComment_*.xml`, authors in `ppt/authors.xml`, the
//! `p188` namespace) and the legacy ones (`ppt/comments/comment*.xml`,
//! authors in `ppt/commentAuthors.xml`).
//!
//! Positions: a modern `p188:pos` is in EMU, a legacy `p:pos` in eighths of
//! a point (PowerPoint's 576-dpi "master units"); both become pt.

use std::collections::BTreeMap;

use paged_ooxml::opc::OpcPackage;
use pptx_core::{Comment, CommentReply};

use crate::xml::El;
use crate::Ctx;

/// Modern comments, by slide relationship type.
pub const REL_MODERN: &str = "http://schemas.microsoft.com/office/2018/10/relationships/comments";
/// Legacy comments.
pub const REL_LEGACY: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
/// The modern authors list (a presentation relationship).
pub const REL_AUTHORS: &str = "http://schemas.microsoft.com/office/2018/10/relationships/authors";
/// The legacy authors list.
pub const REL_LEGACY_AUTHORS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors";

const EMU_PER_PT: f64 = 12_700.0;
const LEGACY_PER_PT: f64 = 8.0;

/// The deck's comment authors: name and initials by author id (modern
/// `{GUID}`s, legacy ids as `legacy-<id>`).
#[derive(Debug, Default)]
pub struct Authors {
    pub by_id: BTreeMap<String, (String, String)>,
}

impl Authors {
    fn get(&self, id: &str) -> (String, String) {
        self.by_id.get(id).cloned().unwrap_or_default()
    }
}

fn parse(pkg: &OpcPackage, part: &str) -> Option<El> {
    crate::xml::parse(pkg.part(part)?).ok()
}

/// Read both authors lists, through the presentation's relationships.
pub fn authors(pkg: &OpcPackage, pres: &Ctx) -> Authors {
    let mut out = Authors::default();
    for r in &pres.rels.items {
        let legacy = r.rel_type == REL_LEGACY_AUTHORS;
        if r.rel_type != REL_AUTHORS && !legacy {
            continue;
        }
        let Some(el) = parse(pkg, &pres.resolve(&r.target)) else {
            pres.note(format!("comment authors {} could not be read", r.target));
            continue;
        };
        for a in &el.children {
            if a.local != "author" && a.local != "cmAuthor" {
                continue;
            }
            let Some(id) = a.attr("id") else { continue };
            let id = if legacy {
                format!("legacy-{id}")
            } else {
                id.to_string()
            };
            out.by_id.insert(
                id,
                (
                    a.attr("name").unwrap_or_default().to_string(),
                    a.attr("initials").unwrap_or_default().to_string(),
                ),
            );
        }
    }
    out
}

/// The text of a `txBody`: one line per paragraph.
fn body_text(body: &El) -> String {
    fn runs(el: &El, out: &mut String) {
        for c in &el.children {
            match c.local.as_str() {
                "t" => out.push_str(&c.deep_text()),
                "br" => out.push('\n'),
                _ => runs(c, out),
            }
        }
    }
    body.children
        .iter()
        .filter(|p| p.local == "p")
        .map(|p| {
            let mut s = String::new();
            runs(p, &mut s);
            s
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The shape a marker list anchors to: the `id` of its drawing-element
/// marker (`ac:spMk`, `ac:picMk`, `ac:grpSpMk`, …).
fn anchored_shape(markers: &El) -> Option<u32> {
    fn find(el: &El) -> Option<u32> {
        for c in &el.children {
            let mk = c.local.ends_with("Mk") && !matches!(c.local.as_str(), "docMk" | "sldMk");
            if mk {
                if let Some(id) = c.attr_u32("id") {
                    return Some(id);
                }
            }
            if let Some(id) = find(c) {
                return Some(id);
            }
        }
        None
    }
    find(markers)
}

fn modern(el: &El, authors: &Authors) -> Vec<Comment> {
    let mut out = Vec::new();
    for cm in el.children.iter().filter(|c| c.local == "cm") {
        let author_id = cm.attr("authorId").unwrap_or_default().to_string();
        let (author, initials) = authors.get(&author_id);
        let markers = cm
            .children
            .iter()
            .find(|c| matches!(c.local.as_str(), "sldMkLst" | "deMkLst" | "txMkLst"));
        let pos = cm.children.iter().find(|c| c.local == "pos");
        let text = cm
            .children
            .iter()
            .find(|c| c.local == "txBody")
            .map(body_text)
            .unwrap_or_default();
        let replies = cm
            .children
            .iter()
            .filter(|c| c.local == "replyLst")
            .flat_map(|l| l.children.iter().filter(|r| r.local == "reply"))
            .map(|r| {
                let author_id = r.attr("authorId").unwrap_or_default().to_string();
                let (author, initials) = authors.get(&author_id);
                CommentReply {
                    id: r.attr("id").unwrap_or_default().to_string(),
                    author_id,
                    author,
                    initials,
                    created: r.attr("created").map(str::to_string),
                    text: r
                        .children
                        .iter()
                        .find(|c| c.local == "txBody")
                        .map(body_text)
                        .unwrap_or_default(),
                }
            })
            .collect();
        out.push(Comment {
            id: cm.attr("id").unwrap_or_default().to_string(),
            author_id,
            author,
            initials,
            created: cm.attr("created").map(str::to_string),
            text,
            x: pos
                .and_then(|p| p.attr_i64("x"))
                .map(|v| v as f64 / EMU_PER_PT),
            y: pos
                .and_then(|p| p.attr_i64("y"))
                .map(|v| v as f64 / EMU_PER_PT),
            shape_id: markers.and_then(anchored_shape),
            status: cm.attr("status").map(str::to_string),
            replies,
            legacy: false,
            raw: Some(cm.to_xml()),
            marker_xml: markers.map(El::to_xml),
        });
    }
    out
}

fn legacy(el: &El, authors: &Authors) -> Vec<Comment> {
    let mut out = Vec::new();
    for cm in el.children.iter().filter(|c| c.local == "cm") {
        let aid = cm.attr("authorId").unwrap_or("0");
        let author_id = format!("legacy-{aid}");
        let (author, initials) = authors.get(&author_id);
        let pos = cm.children.iter().find(|c| c.local == "pos");
        out.push(Comment {
            id: format!("legacy-{aid}-{}", cm.attr("idx").unwrap_or("0")),
            author_id,
            author,
            initials,
            created: cm.attr("dt").map(str::to_string),
            text: cm
                .children
                .iter()
                .find(|c| c.local == "text")
                .map(El::deep_text)
                .unwrap_or_default(),
            x: pos
                .and_then(|p| p.attr_i64("x"))
                .map(|v| v as f64 / LEGACY_PER_PT),
            y: pos
                .and_then(|p| p.attr_i64("y"))
                .map(|v| v as f64 / LEGACY_PER_PT),
            legacy: true,
            ..Comment::default()
        });
    }
    out
}

/// A slide's comments: its modern comment parts, then its legacy ones.
pub fn of_slide(pkg: &OpcPackage, slide: &Ctx, authors: &Authors) -> Vec<Comment> {
    let mut out = Vec::new();
    for kind in [REL_MODERN, REL_LEGACY] {
        for r in slide.rels.items.iter().filter(|r| r.rel_type == kind) {
            let part = slide.resolve(&r.target);
            let Some(el) = parse(pkg, &part) else {
                slide.note(format!("its comments ({part}) could not be read"));
                continue;
            };
            if kind == REL_MODERN {
                out.extend(modern(&el, authors));
            } else {
                out.extend(legacy(&el, authors));
            }
        }
    }
    out
}
