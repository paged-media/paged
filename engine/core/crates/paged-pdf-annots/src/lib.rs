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

//! Engine ADR 1055 — a PDF's review annotations as engine comment threads.
//!
//! [`read_pdf_comments`] reads the `/Annots` of every page through
//! `hayro-syntax`, the object model the renderer (placed PDFs) and the publish
//! module's PDF import already use, and returns the threads Acrobat's Comment
//! tool made: sticky notes, free text, text markup, replies (`/IRT`), review
//! and marked states, with author (`/T`), dates and text. Pure: bytes in,
//! [`PdfCommentsReport`] out.
//!
//! It lives in its own small engine crate, depending only on `paged-model` and
//! `hayro-syntax`, because both consumers sit above it and neither may pull the
//! other's weight: the `paged` command line (through `paged-cli`) and the
//! PDF bundle of the publish module (`pdf-import`, which the editor loads).
//!
//! # Mapping
//!
//! | Annotation | Becomes |
//! |---|---|
//! | `/Text`, `/FreeText` | a thread at the top-left of `/Rect` (page space: points from the page's top-left) |
//! | `/Highlight`, `/Underline`, `/StrikeOut`, `/Squiggly` | a thread over the bounding box of `/QuadPoints` ([`ImportedAnchor::Region`]) |
//! | `/IRT` with `/RT /R` (or no `/RT`) | a reply in the parent's thread, in order of `/M` when all have one, else of position |
//! | `/State` with `/StateModel /Review` | the comment's review state; `Completed` on the root resolves the thread |
//! | `/Popup` | skipped: its parent carries the text |
//! | anything else | a [`Loss`], one aggregated line per type |
//!
//! The page space is the page as shown: the `/TrimBox` when there is one (the
//! engine's page, and what the PDF export writes around), else the crop box, with
//! `/Rotate` applied and the box's origin (never assumed to be zero) subtracted.

mod source;
mod text;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;

use hayro_syntax::object::{Array, Dict, Name, Number, ObjectIdentifier, Rect, Stream};
use hayro_syntax::page::{Page, Rotation};
use hayro_syntax::Pdf;
use paged_model::{Comment, ReviewState, SourceBlob, ThreadKind};
use serde::Serialize;

/// The `format` of the [`SourceBlob`] a thread keeps for each annotation.
pub const SOURCE_FORMAT: &str = "pdf-annot";

/// Which box of a page the annotation coordinates are measured in.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum PageBox {
    /// The `/TrimBox` when the page has one, else the crop box (the media box
    /// when there is none).
    #[default]
    TrimOrCrop,
    /// The crop box only.
    Crop,
}

/// Options of [`read_pdf_comments_with`].
#[derive(Debug, Default, Clone, Copy)]
pub struct ReadOptions {
    pub page_box: PageBox,
}

/// Why a PDF could not be read at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    /// Not a PDF, or damaged beyond repair.
    Invalid,
    /// Encrypted, and not with the empty password.
    Encrypted,
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadError::Invalid => f.write_str("not a readable PDF"),
            ReadError::Encrypted => f.write_str("the PDF is encrypted"),
        }
    }
}

impl std::error::Error for ReadError {}

/// Where a thread stands on its page, in points from the page's top-left.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportedAnchor {
    /// A sticky note or free-text box: its top-left corner.
    #[serde(rename_all = "camelCase")]
    Point { at: [f64; 2] },
    /// Text markup: `[x, y, width, height]` around the marked quads. The host
    /// gives it the item that shows the page.
    #[serde(rename_all = "camelCase")]
    Region { rect: [f64; 4] },
}

/// One thread read from a PDF: the root annotation and its replies.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedThread {
    /// The root comment's id (the thread's id).
    pub id: String,
    /// The 0-based page the annotation is on.
    pub page_index: usize,
    pub anchor: ImportedAnchor,
    pub kind: ThreadKind,
    /// The root's `/Subtype` (`Text`, `FreeText`, `Highlight`, …).
    pub subtype: String,
    /// Root first, then the replies; replies name the root as `parent`.
    pub comments: Vec<Comment>,
    /// The annotation dictionaries (format [`SOURCE_FORMAT`]) per comment id,
    /// as self-contained PDF syntax; a state annotation follows the comment it
    /// is a state of.
    pub source: Vec<(String, SourceBlob)>,
}

/// What a PDF carried that the comment model does not: one line per type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loss {
    /// The annotation type (`Link`, `Stamp`, …), or `state:Marked`.
    pub kind: String,
    pub count: usize,
    /// The 0-based pages they stand on.
    pub pages: Vec<usize>,
    pub reason: String,
}

impl fmt::Display for Loss {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let pages: Vec<String> = self.pages.iter().map(|p| (p + 1).to_string()).collect();
        write!(
            f,
            "{} x {} (page {}): {}",
            self.count,
            self.kind,
            pages.join(", "),
            self.reason
        )
    }
}

/// The threads of a PDF and what was left behind.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfCommentsReport {
    pub threads: Vec<ImportedThread>,
    pub losses: Vec<Loss>,
}

impl PdfCommentsReport {
    /// The distinct author names, in order of first appearance.
    pub fn authors(&self) -> Vec<String> {
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for c in self.threads.iter().flat_map(|t| &t.comments) {
            if let Some(a) = c.author.as_deref().filter(|a| !a.is_empty()) {
                if seen.insert(a.to_string()) {
                    out.push(a.to_string());
                }
            }
        }
        out
    }
}

/// Read the comments of the PDF in `bytes` with the default options.
pub fn read_pdf_comments(bytes: &[u8]) -> Result<PdfCommentsReport, ReadError> {
    read_pdf_comments_with(bytes, &ReadOptions::default())
}

/// Read the comments of the PDF in `bytes`.
pub fn read_pdf_comments_with(
    bytes: &[u8],
    options: &ReadOptions,
) -> Result<PdfCommentsReport, ReadError> {
    let pdf = Pdf::new(bytes.to_vec()).map_err(|e| match e {
        hayro_syntax::LoadPdfError::Decryption(_) => ReadError::Encrypted,
        _ => ReadError::Invalid,
    })?;
    let mut annots = Vec::new();
    for (page_index, page) in pdf.pages().iter().enumerate() {
        let Some(list) = page.raw().get::<Array<'_>>(b"Annots") else {
            continue;
        };
        let frame = Frame::of(page, options.page_box);
        for dict in list.iter::<Dict<'_>>() {
            annots.push(Annot::new(dict, page_index, frame));
        }
    }
    Ok(assemble(annots))
}

/// The box a page's annotations are measured in, and its rotation.
#[derive(Debug, Clone, Copy)]
struct Frame {
    x0: f64,
    y0: f64,
    w: f64,
    h: f64,
    /// Clockwise degrees: 0, 90, 180, 270.
    rotate: u32,
}

impl Frame {
    fn of(page: &Page<'_>, which: PageBox) -> Self {
        let media = page.media_box();
        let crop = page.intersected_crop_box();
        let trim = (which == PageBox::TrimOrCrop)
            .then(|| page.raw().get::<Rect>(b"TrimBox"))
            .flatten()
            .map(|t| normalised(t).intersect(media))
            .filter(|t| t.width() > 0.0 && t.height() > 0.0);
        let b = trim.unwrap_or(crop);
        Frame {
            x0: b.x0,
            y0: b.y0,
            w: b.width(),
            h: b.height(),
            rotate: match page.rotation() {
                Rotation::None => 0,
                Rotation::Horizontal => 90,
                Rotation::Flipped => 180,
                Rotation::FlippedHorizontal => 270,
            },
        }
    }

    /// A user-space point as a shown-page point (origin top-left, y down).
    fn map(&self, x: f64, y: f64) -> [f64; 2] {
        let (x, y) = (x - self.x0, y - self.y0);
        match self.rotate {
            90 => [y, x],
            180 => [self.w - x, y],
            270 => [self.h - y, self.w - x],
            _ => [x, self.h - y],
        }
    }
}

fn normalised(r: Rect) -> Rect {
    Rect::new(
        r.x0.min(r.x1),
        r.y0.min(r.y1),
        r.x0.max(r.x1),
        r.y0.max(r.y1),
    )
}

/// One annotation dictionary, with what the assembly needs of it.
struct Annot<'a> {
    dict: Dict<'a>,
    id: Option<ObjectIdentifier>,
    irt: Option<ObjectIdentifier>,
    subtype: String,
    page: usize,
    frame: Frame,
}

impl<'a> Annot<'a> {
    fn new(dict: Dict<'a>, page: usize, frame: Frame) -> Self {
        let subtype = dict
            .get::<Name<'_>>(b"Subtype")
            .map(|n| n.as_str().to_string())
            .unwrap_or_default();
        let irt = dict
            .get_raw::<Dict<'_>>(b"IRT")
            .and_then(|r| r.as_obj_ref())
            .map(ObjectIdentifier::from);
        Annot {
            id: dict.obj_id(),
            dict,
            irt,
            subtype,
            page,
            frame,
        }
    }

    fn string(&self, key: &[u8]) -> Option<String> {
        let s = self.dict.get::<hayro_syntax::object::String<'_>>(key)?;
        Some(text::decode_text(s.as_bytes()))
    }

    fn name(&self, key: &[u8]) -> Option<String> {
        self.dict
            .get::<Name<'_>>(key)
            .map(|n| n.as_str().to_string())
    }

    fn numbers(&self, key: &[u8]) -> Vec<f64> {
        self.dict
            .get::<Array<'_>>(key)
            .map(|a| a.iter::<Number>().map(|n| n.as_f64()).collect())
            .unwrap_or_default()
    }

    /// `/Contents`, else the plain text of `/RC`.
    fn text(&self) -> String {
        let contents = self.string(b"Contents").unwrap_or_default();
        if !contents.trim().is_empty() {
            return contents;
        }
        let rc = self
            .dict
            .get::<hayro_syntax::object::String<'_>>(b"RC")
            .map(|s| text::decode_text(s.as_bytes()))
            .or_else(|| {
                let stream = self.dict.get::<Stream<'_>>(b"RC")?;
                let data = stream.decoded().ok()?;
                Some(text::decode_text(&data))
            });
        rc.map(|rc| text::strip_rich_text(&rc)).unwrap_or_default()
    }

    /// `/Rect` as `[x0, y0, x1, y1]`, ordered.
    fn rect(&self) -> Option<[f64; 4]> {
        let n = self.numbers(b"Rect");
        (n.len() >= 4).then(|| {
            [
                n[0].min(n[2]),
                n[1].min(n[3]),
                n[0].max(n[2]),
                n[1].max(n[3]),
            ]
        })
    }

    /// The bounding box of a set of user-space points in page space.
    fn region(&self, pts: impl Iterator<Item = (f64, f64)>) -> Option<[f64; 4]> {
        let mut b: Option<[f64; 4]> = None;
        for (x, y) in pts {
            let [px, py] = self.frame.map(x, y);
            b = Some(match b {
                None => [px, py, px, py],
                Some([a, c, d, e]) => [a.min(px), c.min(py), d.max(px), e.max(py)],
            });
        }
        b.map(|[x0, y0, x1, y1]| [x0, y0, x1 - x0, y1 - y0])
    }

    fn anchor(&self) -> Option<ImportedAnchor> {
        let rect = self.rect();
        let corners = |r: [f64; 4]| [(r[0], r[1]), (r[2], r[1]), (r[0], r[3]), (r[2], r[3])];
        match self.subtype.as_str() {
            "Highlight" | "Underline" | "StrikeOut" | "Squiggly" => {
                let q = self.numbers(b"QuadPoints");
                let quads = self.region(q.as_chunks::<2>().0.iter().map(|p| (p[0], p[1])));
                quads
                    .or_else(|| self.region(rect.into_iter().flat_map(corners)))
                    .map(|rect| ImportedAnchor::Region { rect })
            }
            _ => {
                // The annotation's top-left as shown: the corner nearest the
                // page's top-left after rotation.
                let r = self.region(rect.into_iter().flat_map(corners))?;
                Some(ImportedAnchor::Point { at: [r[0], r[1]] })
            }
        }
    }

    fn comment(&self, id: String, parent: Option<String>) -> Comment {
        let created = self
            .string(b"CreationDate")
            .and_then(|d| text::iso_date(&d));
        let modified = self.string(b"M").and_then(|d| text::iso_date(&d));
        let (date, modified) = match created {
            Some(c) => (Some(c), modified),
            None => (modified, None),
        };
        Comment {
            id,
            parent,
            author: self.string(b"T").filter(|a| !a.is_empty()),
            date,
            text: self.text(),
            modified,
            ..Default::default()
        }
    }

    fn blob(&self) -> SourceBlob {
        SourceBlob {
            format: SOURCE_FORMAT.into(),
            data: source::dict_to_string(&self.dict),
        }
    }

    /// The sort instant of `/M`, for ordering replies and states.
    fn when(&self) -> Option<i64> {
        self.string(b"M")
            .and_then(|d| text::iso_date(&d))
            .and_then(|d| text::sort_key(&d))
    }
}

fn is_comment_type(subtype: &str) -> bool {
    matches!(
        subtype,
        "Text" | "FreeText" | "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
    )
}

#[derive(Default)]
struct Losses(BTreeMap<String, (usize, BTreeSet<usize>, String)>);

impl Losses {
    fn add(&mut self, kind: &str, page: usize, reason: &str) {
        let e = self
            .0
            .entry(kind.to_string())
            .or_insert_with(|| (0, BTreeSet::new(), reason.to_string()));
        e.0 += 1;
        e.1.insert(page);
    }

    fn finish(self) -> Vec<Loss> {
        self.0
            .into_iter()
            .map(|(kind, (count, pages, reason))| Loss {
                kind,
                count,
                pages: pages.into_iter().collect(),
                reason,
            })
            .collect()
    }
}

fn unsupported_reason(subtype: &str) -> &'static str {
    match subtype {
        "Link" => "a hyperlink or destination, not a review comment",
        "Widget" => "a form field, not a review comment",
        _ => "not an annotation type paged imports as a comment (Text, FreeText, Highlight, Underline, StrikeOut, Squiggly)",
    }
}

fn assemble(annots: Vec<Annot<'_>>) -> PdfCommentsReport {
    let mut losses = Losses::default();
    // Candidates (comment-bearing), and state annotations by their target.
    let mut cands: Vec<usize> = Vec::new();
    let mut states: Vec<usize> = Vec::new();
    for (i, a) in annots.iter().enumerate() {
        let is_state =
            a.irt.is_some() && a.dict.contains_key(b"State") && a.dict.contains_key(b"StateModel");
        if a.subtype == "Popup" {
            continue;
        } else if is_state {
            states.push(i);
        } else if is_comment_type(&a.subtype) {
            if a.irt.is_some() && a.name(b"RT").as_deref() == Some("Group") {
                losses.add(
                    "reply:Group",
                    a.page,
                    "an annotation grouped with another (/RT /Group) is not a reply; its text is not imported",
                );
            } else {
                cands.push(i);
            }
        } else {
            let kind = if a.subtype.is_empty() {
                "(no subtype)"
            } else {
                a.subtype.as_str()
            };
            losses.add(kind, a.page, unsupported_reason(&a.subtype));
        }
    }
    let by_id: HashMap<ObjectIdentifier, usize> = cands
        .iter()
        .enumerate()
        .filter_map(|(c, &i)| annots[i].id.map(|id| (id, c)))
        .collect();
    let parent_of = |c: usize| -> Option<usize> {
        annots[cands[c]]
            .irt
            .and_then(|r| by_id.get(&r).copied())
            .filter(|&p| p != c)
    };
    let root_of = |mut c: usize| -> usize {
        for _ in 0..64 {
            match parent_of(c) {
                Some(p) => c = p,
                None => return c,
            }
        }
        c
    };

    // Ids: the annotation's /NM when it has a usable one.
    let mut used: HashSet<String> = HashSet::new();
    let mut root_count = 0usize;
    let mut comment_ids: Vec<Option<String>> = vec![None; cands.len()];
    let mut threads: Vec<ImportedThread> = Vec::new();
    let mut thread_of_root: HashMap<usize, usize> = HashMap::new();

    for c in 0..cands.len() {
        if root_of(c) != c {
            continue;
        }
        let a = &annots[cands[c]];
        let Some(anchor) = a.anchor() else {
            // No /Rect and no quads: nowhere to put it.
            losses.add(
                &a.subtype,
                a.page,
                "has no /Rect or /QuadPoints, so it has no place on the page",
            );
            continue;
        };
        root_count += 1;
        let mut id = a
            .string(b"NM")
            .filter(|n| !n.is_empty() && !used.contains(n))
            .unwrap_or_else(|| format!("pdf-p{}-{root_count}", a.page + 1));
        while !used.insert(id.clone()) {
            id.push('_');
        }
        comment_ids[c] = Some(id.clone());
        thread_of_root.insert(c, threads.len());
        threads.push(ImportedThread {
            id: id.clone(),
            page_index: a.page,
            anchor,
            kind: ThreadKind::Comment,
            subtype: a.subtype.clone(),
            comments: vec![a.comment(id.clone(), None)],
            source: vec![(id, a.blob())],
        });
    }

    // Replies: grouped by root, in document order, then by /M when all have one.
    let mut replies: HashMap<usize, Vec<usize>> = HashMap::new();
    for c in 0..cands.len() {
        let root = root_of(c);
        if root != c {
            replies.entry(root).or_default().push(c);
        }
    }
    for (root, mut members) in replies {
        let Some(&t) = thread_of_root.get(&root) else {
            continue;
        };
        let keys: Vec<Option<i64>> = members.iter().map(|&c| annots[cands[c]].when()).collect();
        if keys.iter().all(Option::is_some) {
            let mut order: Vec<usize> = (0..members.len()).collect();
            order.sort_by_key(|&k| keys[k]);
            members = order.into_iter().map(|k| members[k]).collect();
        }
        let thread = &mut threads[t];
        let root_id = thread.id.clone();
        for c in members {
            let a = &annots[cands[c]];
            let mut id = a
                .string(b"NM")
                .filter(|n| !n.is_empty() && !used.contains(n))
                .unwrap_or_else(|| format!("{root_id}.{}", thread.comments.len()));
            while !used.insert(id.clone()) {
                id.push('_');
            }
            comment_ids[c] = Some(id.clone());
            thread
                .comments
                .push(a.comment(id.clone(), Some(root_id.clone())));
            thread.source.push((id, a.blob()));
        }
    }

    // States.
    let mut latest: HashMap<(usize, String), (Option<i64>, usize)> = HashMap::new();
    for &s in &states {
        let a = &annots[s];
        let Some(target) = a.irt.and_then(|r| by_id.get(&r).copied()) else {
            losses.add(
                "state",
                a.page,
                "a state annotation whose target is not an imported comment",
            );
            continue;
        };
        // The latest of each state model wins.
        let slot = (target, a.string(b"StateModel").unwrap_or_default());
        let key = (a.when(), s);
        let keep = latest.get(&slot).is_none_or(|prev| key >= *prev);
        if keep {
            latest.insert(slot, key);
        }
    }
    let thread_index_of = |c: usize| thread_of_root.get(&root_of(c)).copied();
    for (&(target, _), &(_, s)) in &latest {
        let a = &annots[s];
        let model = a.string(b"StateModel").unwrap_or_default();
        let state = a.string(b"State").unwrap_or_default();
        let (Some(t), Some(cid)) = (thread_index_of(target), comment_ids[target].clone()) else {
            continue;
        };
        let review = match (model.as_str(), state.as_str()) {
            ("Review", "Accepted") => Some(Some(ReviewState::Accepted)),
            ("Review", "Rejected") => Some(Some(ReviewState::Rejected)),
            ("Review", "Cancelled") => Some(Some(ReviewState::Cancelled)),
            ("Review", "Completed") => Some(Some(ReviewState::Completed)),
            ("Review", "None") => Some(None),
            _ => None,
        };
        let thread = &mut threads[t];
        thread.source.push((cid.clone(), a.blob()));
        match review {
            Some(state) => {
                let is_root = thread.id == cid;
                if let Some(comment) = thread.comments.iter_mut().find(|c| c.id == cid) {
                    comment.review_state = state;
                    if is_root {
                        comment.resolved = state == Some(ReviewState::Completed);
                    }
                }
            }
            None => losses.add(
                &format!("state:{model}"),
                a.page,
                "this state model has no field in the comment model (only /Review is carried); the annotation is kept in the thread's source",
            ),
        }
    }
    // A state annotation of an unsupported kind of target is already counted.
    PdfCommentsReport {
        threads,
        losses: losses.finish(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rotation_keeps_the_box_corners_inside_the_shown_page() {
        // A 300 x 400 box at (100, 200).
        for rotate in [0, 90, 180, 270] {
            let f = Frame {
                x0: 100.0,
                y0: 200.0,
                w: 300.0,
                h: 400.0,
                rotate,
            };
            let (sw, sh) = if rotate % 180 == 0 {
                (300.0, 400.0)
            } else {
                (400.0, 300.0)
            };
            // The user-space corners: bottom-left, bottom-right, top-left, top-right.
            let corners = [
                (100.0, 200.0),
                (400.0, 200.0),
                (100.0, 600.0),
                (400.0, 600.0),
            ];
            let mapped: Vec<[f64; 2]> = corners.iter().map(|&(x, y)| f.map(x, y)).collect();
            for p in &mapped {
                assert!(
                    (0.0..=sw).contains(&p[0]) && (0.0..=sh).contains(&p[1]),
                    "{rotate} {p:?}"
                );
            }
            // The unrotated bottom-left is at the shown page's: bottom-left (0),
            // top-left (90), top-right (180), bottom-right (270).
            let want = match rotate {
                0 => [0.0, sh],
                90 => [0.0, 0.0],
                180 => [sw, 0.0],
                _ => [sw, sh],
            };
            assert_eq!(mapped[0], want, "rotate {rotate}");
        }
    }
}
